// spec/02 § Context compression — the compaction boundary, end to end through
// the host: the SDK stream message, the wire event, and the replay of a
// persisted boundary.
//
// The two representations here are NOT interchangeable and are both taken from
// the real thing rather than guessed:
//   - the SDK STREAM message is snake_case (`compact_metadata`, `pre_tokens`),
//     matching the zod schema the `claude` binary validates it against.
//   - the on-disk JSONL Claude Code writes is camelCase (`compactMetadata`,
//     `preTokens`) and carries a `content` string.
// Sample on-disk line, copied from a real transcript:
//   {"type":"system","subtype":"compact_boundary","content":"Conversation
//    compacted","compactMetadata":{"trigger":"auto","preTokens":168165},...}
// Real boundaries carry no post-count and no duration, so the "pre-count only"
// case below is the COMMON one, not an edge case.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';
import { translateSdkMessage } from '../src/sdkBackend.js';
import { jsonlLineToWire, encodeFolder } from '../src/history.js';

const silent = pino({ level: 'silent' });

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'patch-compact-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-folder-')));
  mkdirSync(folder, { recursive: true });
  const metaStore = createMetaStore(home);
  const events: WireEvent[] = [];
  const sdk = createMockSdkBackend();
  let id = 0;
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore,
    sdkBackend: sdk,
    oauthAccessToken: 'fake-token',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${++id}`,
  });
  return { daemon, sdk, events, folder, metaStore };
}

describe('translateSdkMessage — compaction boundary', () => {
  it('carries the figures and a one-line record when the SDK reports both counts', () => {
    const [env] = translateSdkMessage({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: {
        trigger: 'auto',
        pre_tokens: 168165,
        post_tokens: 42118,
        duration_ms: 3200,
      },
      uuid: 'u1',
      session_id: 's1',
    });
    expect(env).toMatchObject({
      type: 'system',
      content: 'Context compressed · 168k → 42k',
      compaction: {
        trigger: 'auto',
        preTokens: 168165,
        postTokens: 42118,
        durationMs: 3200,
      },
    });
  });

  it('reports what it was given when the SDK sends only the pre-count', () => {
    // The shape every real boundary observed on disk actually has.
    const [env] = translateSdkMessage({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'auto', pre_tokens: 168165 },
      uuid: 'u1',
      session_id: 's1',
    });
    expect(env).toMatchObject({
      type: 'system',
      content: 'Context compressed · from 168k',
      compaction: { trigger: 'auto', preTokens: 168165 },
    });
    // Absent, not zero — a surface must be able to tell "not reported" from "0".
    expect(env?.compaction).not.toHaveProperty('postTokens');
    expect(env?.compaction).not.toHaveProperty('durationMs');
  });

  it('keeps a manual compaction distinguishable from an automatic one', () => {
    const [env] = translateSdkMessage({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'manual', pre_tokens: 90000 },
    });
    expect(env?.compaction).toMatchObject({ trigger: 'manual', preTokens: 90000 });
  });

  it('renders a sub-1k count as the exact number rather than 0k', () => {
    const [env] = translateSdkMessage({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'manual', pre_tokens: 940, post_tokens: 120 },
    });
    expect(env?.content).toBe('Context compressed · 940 → 120');
  });

  it.each([
    ['no compact_metadata at all', { type: 'system', subtype: 'compact_boundary' }],
    [
      'a metadata block that is not an object',
      { type: 'system', subtype: 'compact_boundary', compact_metadata: 'nope' },
    ],
    [
      'a missing pre-count',
      { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto' } },
    ],
    [
      'a non-numeric pre-count',
      {
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { trigger: 'auto', pre_tokens: 'lots' },
      },
    ],
    [
      'an unrecognised trigger',
      {
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { trigger: 'sideways', pre_tokens: 10 },
      },
    ],
  ])('throws on a boundary with %s rather than inventing figures', (_label, msg) => {
    expect(() => translateSdkMessage(msg)).toThrow(/compact_boundary/);
  });

  it('leaves every other system message alone', () => {
    expect(translateSdkMessage({ type: 'system', subtype: 'init', tools: [] })[0]).toMatchObject({
      type: 'system',
    });
    expect(translateSdkMessage({ type: 'system', subtype: 'init' })[0]).not.toHaveProperty(
      'compaction',
    );
  });
});

describe('Host — compaction boundary on the wire', () => {
  it('emits the boundary as a system chat.message carrying the figures', async () => {
    const { daemon, sdk, events, folder, metaStore } = setup();
    sdk.enqueue([
      { type: 'assistant', content: 'before' },
      {
        type: 'system',
        content: 'Context compressed · from 168k',
        compaction: { trigger: 'auto', preTokens: 168165 },
      },
      { type: 'assistant', content: 'after', sessionId: 'sess-C' },
    ]);
    const chatId = await daemon.spawnChat({ folder, prompt: 'go' });
    await new Promise((r) => setTimeout(r, 30));

    const messages = events.filter(
      (e) => e.type === 'chat.message' && (e as { chatId: string }).chatId === chatId,
    ) as unknown as Array<{ role: string; content: string; seq: number; compaction?: unknown }>;
    // seq 0 user turn, 1 'before', 2 the boundary, 3 'after'.
    expect(messages).toHaveLength(4);
    expect(messages[2]).toMatchObject({
      role: 'system',
      content: 'Context compressed · from 168k',
      seq: 2,
      compaction: { trigger: 'auto', preTokens: 168165 },
    });
    // It takes a real seq like any other transcript entry, so it replays in place.
    expect(messages[3]?.seq).toBe(3);
    expect(metaStore.read(chatId)?.nextSeq).toBe(4);
    // And it is part of the chat's own state, not just a live fan-out.
    const snapshots = daemon.chatState.get(chatId)?.lastMessages ?? [];
    expect(snapshots.some((m) => m.role === 'system' && m.content.includes('168k'))).toBe(true);
  });

  it('still drops a content-less system envelope', async () => {
    // Every other system envelope (init, stream_event leftovers) carries no
    // chat-visible content and must stay invisible.
    const { daemon, sdk, events, folder } = setup();
    sdk.enqueue([{ type: 'system' }, { type: 'assistant', content: 'hi' }]);
    const chatId = await daemon.spawnChat({ folder, prompt: 'go' });
    await new Promise((r) => setTimeout(r, 30));
    const messages = events.filter(
      (e) => e.type === 'chat.message' && (e as { chatId: string }).chatId === chatId,
    ) as unknown as Array<{ role: string }>;
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });
});

describe('history replay — a persisted compaction boundary', () => {
  it('reconstructs the boundary from the JSONL Claude Code writes', () => {
    // Verbatim shape from a real ~/.claude/projects transcript.
    const line = JSON.stringify({
      parentUuid: null,
      type: 'system',
      subtype: 'compact_boundary',
      content: 'Conversation compacted',
      isMeta: false,
      uuid: 'c0310345-2569-4b3e-933a-c90850f4bf19',
      compactMetadata: { trigger: 'auto', preTokens: 168165 },
      sessionId: '7a0bc341',
    });
    expect(jsonlLineToWire(line, 'chat-1', 7)).toEqual([
      {
        type: 'chat.message',
        chatId: 'chat-1',
        role: 'system',
        content: 'Context compressed · from 168k',
        seq: 7,
        compaction: { trigger: 'auto', preTokens: 168165 },
      },
    ]);
  });

  it('reconstructs both counts and the duration when the transcript has them', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'compact_boundary',
      content: 'Conversation compacted',
      compactMetadata: {
        trigger: 'manual',
        preTokens: 168165,
        postTokens: 42118,
        durationMs: 3200,
      },
      uuid: 'u2',
    });
    expect(jsonlLineToWire(line, 'chat-1', 3)).toEqual([
      {
        type: 'chat.message',
        chatId: 'chat-1',
        role: 'system',
        content: 'Context compressed · 168k → 42k',
        seq: 3,
        compaction: { trigger: 'manual', preTokens: 168165, postTokens: 42118, durationMs: 3200 },
      },
    ]);
  });

  it('throws on a boundary line whose figures are unusable', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'compact_boundary',
      compactMetadata: { trigger: 'auto' },
      uuid: 'u3',
    });
    expect(() => jsonlLineToWire(line, 'chat-1', 1)).toThrow(/compact_boundary/);
  });

  it('still ignores every other system line in the transcript', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'init', uuid: 'u4' });
    expect(jsonlLineToWire(line, 'chat-1', 1)).toEqual([]);
  });

  it('survives a round trip through the transcript the mock backend writes', async () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), 'patch-projects-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-folder-')));
    const sdk = createMockSdkBackend({ claudeProjectsRoot: projectsRoot });
    sdk.enqueue([
      {
        type: 'system',
        content: 'Context compressed · from 168k',
        compaction: { trigger: 'auto', preTokens: 168165 },
      },
      { type: 'result', sessionId: 'sess-R' },
    ]);
    const ac = new AbortController();
    for await (const emitted of sdk.run({
      prompt: 'go',
      cwd: folder,
      abortController: ac,
      resumeSessionId: 'sess-R',
    })) {
      void emitted; // drain the stream so the transcript is written
    }

    const transcript = join(projectsRoot, encodeFolder(folder), 'sess-R.jsonl');
    const lines = readFileSync(transcript, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0);
    const boundary = lines.find((l) => l.includes('compact_boundary'));
    expect(boundary).toBeDefined();
    // Written in Claude Code's on-disk camelCase shape, so the reader that
    // parses real transcripts parses this one identically.
    expect(jsonlLineToWire(boundary!, 'chat-1', 5)).toEqual([
      {
        type: 'chat.message',
        chatId: 'chat-1',
        role: 'system',
        content: 'Context compressed · from 168k',
        seq: 5,
        compaction: { trigger: 'auto', preTokens: 168165 },
      },
    ]);
  });
});
