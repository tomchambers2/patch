// A message Claude Code wrote is not a message the model wrote.
//
// On 2026-09-11 a Foreman turn died on a usage limit. Claude Code, resuming the
// session, injected its own `Continue from where you left off.` and answered it
// with `No response requested.` — `model: "<synthetic>"`, zero input tokens,
// `isApiErrorMessage: false`. Patch rendered that as the assistant's reply, so
// a turn that had produced nothing at all read, on screen, as a turn that had
// answered. A silent success is the one failure mode this app is not allowed.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { ChatMessageEvent, WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';
import {
  createHistoryReader,
  encodeFolder,
  jsonlLineToWire,
  type CanonicalSeqIndex,
} from '../src/history.js';

const silent = pino({ level: 'silent' });

/** The exact shape Claude Code emitted, as captured from the live transcript. */
const SYNTHETIC_RAW = {
  type: 'assistant',
  message: {
    role: 'assistant',
    model: '<synthetic>',
    content: [{ type: 'text', text: 'No response requested.' }],
    usage: { input_tokens: 0, output_tokens: 4 },
  },
};

const REAL_RAW = {
  type: 'assistant',
  message: {
    role: 'assistant',
    model: 'claude-sonnet-5',
    content: [{ type: 'text', text: 'here you go' }],
    usage: { input_tokens: 1_234, output_tokens: 9 },
  },
};

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'patch-synth-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-synth-folder-')));
  mkdirSync(folder, { recursive: true });
  const events: WireEvent[] = [];
  const sdk = createMockSdkBackend();
  let id = 0;
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: sdk,
    oauthAccessToken: 'fake-token',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${++id}`,
  });
  return { daemon, sdk, events, folder };
}

const assistantTexts = (events: WireEvent[]): string[] =>
  events
    .filter((e): e is ChatMessageEvent => e.type === 'chat.message')
    .filter((e) => e.role === 'assistant')
    .map((e) => e.content);

describe('synthetic assistant messages', () => {
  it('does not render a CLI-generated reply as the assistant speaking', async () => {
    const { daemon, sdk, events, folder } = setup();
    sdk.enqueue([
      { type: 'result', sessionId: 'sess' },
      {
        type: 'assistant',
        content: 'No response requested.',
        sessionId: 'sess',
        raw: SYNTHETIC_RAW,
      },
    ]);
    await daemon.spawnChat({ folder, prompt: 'go' });
    await new Promise((r) => setTimeout(r, 20));

    expect(assistantTexts(events)).not.toContain('No response requested.');
  });

  // Hidden from the agent's voice, not from Tom: the gap is shown as a muted
  // Claude Code line, so a turn that produced nothing is still visible.
  it('shows the CLI-generated reply as a system line flagged synthetic', async () => {
    const { daemon, sdk, events, folder } = setup();
    sdk.enqueue([
      { type: 'result', sessionId: 'sess' },
      {
        type: 'assistant',
        content: 'No response requested.',
        sessionId: 'sess',
        raw: SYNTHETIC_RAW,
      },
    ]);
    await daemon.spawnChat({ folder, prompt: 'go' });
    await new Promise((r) => setTimeout(r, 20));

    const notices = events.filter(
      (e): e is ChatMessageEvent => e.type === 'chat.message' && e.synthetic === true,
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ role: 'system', content: 'No response requested.' });
    // A real reply never carries the flag.
    expect(
      events.some(
        (e) => e.type === 'chat.message' && e.role === 'assistant' && e.synthetic === true,
      ),
    ).toBe(false);
  });

  it('still renders a real model reply', async () => {
    const { daemon, sdk, events, folder } = setup();
    sdk.enqueue([
      { type: 'result', sessionId: 'sess' },
      { type: 'assistant', content: 'here you go', sessionId: 'sess', raw: REAL_RAW },
    ]);
    await daemon.spawnChat({ folder, prompt: 'go' });
    await new Promise((r) => setTimeout(r, 20));

    expect(assistantTexts(events)).toContain('here you go');
  });

  // The resume placeholder never crosses the SDK stream: Claude Code writes it
  // straight into the session, so the daemon sees it only as a mirrored entry.
  // It must still show — once, however many ways it arrives.
  it('shows a placeholder written only to the session mirror, once', async () => {
    const { daemon, sdk, events, folder } = setup();
    sdk.enqueue([{ type: 'result', sessionId: 'sess' }]);
    const chatId = await daemon.spawnChat({ folder, prompt: 'go' });
    await new Promise((r) => setTimeout(r, 20));
    const note = (
      daemon as unknown as {
        noteMirroredEntries(chatId: string, entries: readonly Record<string, unknown>[]): void;
      }
    ).noteMirroredEntries.bind(daemon);
    const placeholder = { ...SYNTHETIC_RAW, uuid: 'p1' };
    const limit = {
      type: 'assistant',
      uuid: 'e1',
      isApiErrorMessage: true,
      message: {
        model: '<synthetic>',
        content: [{ type: 'text', text: "You've hit your monthly spend limit" }],
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    };
    note(chatId, [{ type: 'user', uuid: 'u1' }, placeholder, limit, { ...REAL_RAW, uuid: 'r1' }]);
    note(chatId, [placeholder]);

    const notices = events.filter(
      (e): e is ChatMessageEvent => e.type === 'chat.message' && e.synthetic === true,
    );
    expect(notices.map((n) => n.content)).toEqual(['No response requested.']);
  });

  // The guard keys on a marker that is PRESENT. A backend that carries no raw
  // SDK message — the mock one, and every test built on it — must not have its
  // replies silently deleted, which is a far worse failure than the one being
  // fixed.
  it('an envelope with no raw SDK message is not treated as synthetic', async () => {
    const { daemon, sdk, events, folder } = setup();
    sdk.enqueue([
      { type: 'result', sessionId: 'sess' },
      { type: 'assistant', content: 'plain reply', sessionId: 'sess' },
    ]);
    await daemon.spawnChat({ folder, prompt: 'go' });
    await new Promise((r) => setTimeout(r, 20));

    expect(assistantTexts(events)).toContain('plain reply');
  });
});

/**
 * The exact on-disk entry Claude Code wrote, copied from a real transcript:
 * `model: "<synthetic>"`, a fully zeroed `usage`, and none of the error markers
 * set — `isMeta` null, `isApiErrorMessage` false, `error` null. The ONLY thing
 * that says this is not the model talking is the structure.
 */
const SYNTHETIC_LINE = JSON.stringify({
  parentUuid: '04d7a50d-62b9-406a-8795-e6432a571fd4',
  isSidechain: false,
  type: 'assistant',
  uuid: 'bfe08f0a-41bb-4a9a-93e3-c8cc3f30862c',
  timestamp: '2026-09-09T21:48:03.684Z',
  message: {
    id: 'f34c198b-abec-4351-894a-e4d1178d3f41',
    model: '<synthetic>',
    role: 'assistant',
    stop_reason: 'stop_sequence',
    type: 'message',
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      service_tier: null,
    },
    content: [{ type: 'text', text: 'No response requested.' }],
  },
  isMeta: null,
  isApiErrorMessage: false,
  error: null,
  userType: 'external',
  sessionId: 'sess-1',
});

const realAssistantLine = (text: string): string =>
  JSON.stringify({
    type: 'assistant',
    uuid: `u-${text.slice(0, 8)}`,
    message: {
      role: 'assistant',
      model: 'claude-opus-5',
      usage: { input_tokens: 4_312, output_tokens: 11 },
      content: [{ type: 'text', text }],
    },
  });

describe('synthetic assistant messages — replayed from the transcript', () => {
  it('drops the CLI-generated entry when the transcript is translated', () => {
    expect(jsonlLineToWire(SYNTHETIC_LINE, 'c1', 0)).toEqual([]);
  });

  it('still replays a real model reply', () => {
    expect(jsonlLineToWire(realAssistantLine('here you go'), 'c1', 3)).toEqual([
      { type: 'chat.message', chatId: 'c1', role: 'assistant', content: 'here you go', seq: 3 },
    ]);
  });

  // Structural, never prose. An agent that writes the sentence out loud — in a
  // chat about this very bug, say — is the model talking and must still render.
  it('still replays a real reply that quotes the synthetic wording', () => {
    expect(jsonlLineToWire(realAssistantLine('No response requested.'), 'c1', 3)).toEqual([
      {
        type: 'chat.message',
        chatId: 'c1',
        role: 'assistant',
        content: 'No response requested.',
        seq: 3,
      },
    ]);
  });

  // An older CLI may report no usage at all. Absent is not zero: calling a
  // genuine turn fake and deleting it is the worse failure.
  it('still replays an assistant entry that carries no usage', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        content: [{ type: 'text', text: 'ok' }],
      },
    });
    expect(jsonlLineToWire(line, 'c1', 1)).toEqual([
      { type: 'chat.message', chatId: 'c1', role: 'assistant', content: 'ok', seq: 1 },
    ]);
  });

  // The compaction notice is a `system` / `compact_boundary` entry, read before
  // the assistant gate — the guard must not reach it.
  it('still replays a compaction boundary', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'compact_boundary',
      content: 'Conversation compacted',
      compactMetadata: { trigger: 'auto', preTokens: 168165 },
      uuid: 'boundary-1',
    });
    expect(jsonlLineToWire(line, 'c1', 7)).toEqual([
      {
        type: 'chat.message',
        chatId: 'c1',
        role: 'system',
        content: 'Context compressed · from 168k',
        seq: 7,
        compaction: { trigger: 'auto', preTokens: 168165 },
      },
    ]);
  });

  it('a whole transcript replays without the CLI notice, and without spending a seq on it', () => {
    const root = mkdtempSync(join(tmpdir(), 'patch-synth-history-'));
    const folder = '/work/proj';
    const dir = join(root, encodeFolder(folder));
    mkdirSync(dir, { recursive: true });
    const sessionId = 'sess-1';
    writeFileSync(
      join(dir, `${sessionId}.jsonl`),
      [
        JSON.stringify({ type: 'user', message: { content: 'go' } }),
        SYNTHETIC_LINE,
        SYNTHETIC_LINE,
        realAssistantLine('done'),
      ].join('\n') + '\n',
      'utf8',
    );

    let next = 0;
    const seqIndex: CanonicalSeqIndex = { resolve: (keys) => keys.map(() => next++) };
    const events = createHistoryReader({ claudeProjectsRoot: root }).read({
      chatId: 'c1',
      folder,
      sessionId,
      fromSeq: -1,
      seqIndex,
    });

    expect(assistantTexts(events)).not.toContain('No response requested.');
    // Two turns, numbered 0 and 1: the dropped entries never reach the index,
    // so replayed seqs match what the live stream stamped.
    expect(events).toEqual([
      { type: 'chat.message', chatId: 'c1', role: 'user', content: 'go', seq: 0 },
      { type: 'chat.message', chatId: 'c1', role: 'assistant', content: 'done', seq: 1 },
    ]);
  });
});
