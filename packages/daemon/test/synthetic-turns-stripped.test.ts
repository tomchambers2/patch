// spec/02 § Per-turn process / warm sessions — what the model is handed back on
// resume is the conversation, never a turn the harness wrote itself.
// `stripSyntheticTurns` is the rule; `claudeSessionStore.load()` applies it to
// every Claude resume.

import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import type { SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createHistoryReader, encodeFolder } from '../src/history.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';
import { createClaudeSessionStore } from '../src/claudeSessionStore.js';
import { stripSyntheticTurns } from '../src/syntheticTurns.js';

type E = SessionStoreEntry & { uuid?: string; parentUuid?: string | null };

const user = (uuid: string, parentUuid: string | null, text: string, extra = {}): E => ({
  type: 'user',
  uuid,
  parentUuid,
  message: { role: 'user', content: text },
  ...extra,
});

const toolResult = (uuid: string, parentUuid: string): E => ({
  type: 'user',
  uuid,
  parentUuid,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
});

const reply = (uuid: string, parentUuid: string, text: string): E => ({
  type: 'assistant',
  uuid,
  parentUuid,
  message: {
    role: 'assistant',
    model: 'claude-opus-5-5',
    usage: { input_tokens: 3, output_tokens: 5 },
    content: [{ type: 'text', text }],
  },
});

/** The exact shape Claude Code persists: `<synthetic>`, zeroed usage. */
const synthetic = (uuid: string, parentUuid: string, text = 'No response requested.'): E => ({
  type: 'assistant',
  uuid,
  parentUuid,
  isApiErrorMessage: false,
  message: {
    role: 'assistant',
    model: '<synthetic>',
    usage: { input_tokens: 0, output_tokens: 0 },
    content: [{ type: 'text', text }],
  },
});

const attachment = (uuid: string, parentUuid: string): E => ({
  type: 'attachment',
  uuid,
  parentUuid,
});

const texts = (entries: readonly SessionStoreEntry[]): string[] =>
  (entries as E[])
    .filter((e) => e.type === 'user' || e.type === 'assistant')
    .map((e) => {
      const c = (e as { message: { content: unknown } }).message.content;
      return typeof c === 'string' ? c : JSON.stringify(c);
    });

describe('stripSyntheticTurns', () => {
  it('leaves a clean conversation exactly as it was', () => {
    const input = [user('u1', null, 'hi'), reply('a1', 'u1', 'hello')];
    const out = stripSyntheticTurns(input);
    expect(out.entries).toEqual(input);
    expect(out).toMatchObject({ synthetic: 0, injectedPrompts: 0, unansweredPrompts: 0 });
  });

  it('removes a synthetic reply and the harness-injected turn it answered', () => {
    const out = stripSyntheticTurns([
      user('u1', null, 'hi'),
      reply('a1', 'u1', 'hello'),
      user('m1', 'a1', 'Continue from where you left off.', { isMeta: true }),
      synthetic('s1', 'm1'),
      user('u2', 's1', 'next'),
      reply('a2', 'u2', 'done'),
    ]);
    expect(texts(out.entries)).toEqual([
      'hi',
      expect.stringContaining('hello'),
      'next',
      expect.stringContaining('done'),
    ]);
    expect(out).toMatchObject({ synthetic: 1, injectedPrompts: 1, unansweredPrompts: 0 });
    // The survivor after the gap points at the nearest surviving ancestor.
    expect((out.entries as E[]).find((e) => e.uuid === 'u2')?.parentUuid).toBe('a1');
  });

  it('removes API-error text Claude Code wrote, not just placeholders', () => {
    const out = stripSyntheticTurns([
      user('u1', null, 'hi'),
      synthetic('s1', 'u1', "You've hit your monthly spend limit"),
      user('u2', 's1', 'again'),
      reply('a2', 'u2', 'ok'),
    ]);
    expect(texts(out.entries).join('\n')).not.toContain('spend limit');
    expect(out.synthetic).toBe(1);
  });

  // Claude Code answers a trailing unanswered prompt itself on load, and
  // persists it — verified against 2.1.288 — so the prompt cannot stay either.
  // Found by resuming a real session through the real store: dropping only the
  // last prompt left the one before it at the tail, and Claude Code answered
  // THAT with a placeholder instead. A run of unanswered prompts goes as a run.
  it('removes every trailing prompt nothing answered, with their attachments', () => {
    const out = stripSyntheticTurns([
      user('u1', null, 'hi'),
      reply('a1', 'u1', 'hello'),
      user('u2', 'a1', 'wake'),
      synthetic('s1', 'u2'),
      user('u3', 's1', 'wake again'),
      attachment('t3', 'u3'),
      { type: 'queue-operation' } as E,
    ]);
    expect(texts(out.entries)).toEqual(['hi', expect.stringContaining('hello')]);
    expect(out).toMatchObject({ synthetic: 1, unansweredPrompts: 2 });
    expect((out.entries as E[]).some((e) => e.uuid === 't3')).toBe(false);
    // Entries without a uuid (bookkeeping) are not the conversation's to judge.
    expect((out.entries as E[]).some((e) => e.type === 'queue-operation')).toBe(true);
  });

  it('removes a tail left unanswered once its synthetic reply is gone', () => {
    const out = stripSyntheticTurns([
      user('u1', null, 'hi'),
      reply('a1', 'u1', 'hello'),
      user('u2', 'a1', 'wake'),
      synthetic('s1', 'u2'),
    ]);
    expect(texts(out.entries)).toEqual(['hi', expect.stringContaining('hello')]);
    expect(out).toMatchObject({ synthetic: 1, unansweredPrompts: 1 });
  });

  it('keeps an unanswered prompt that a real reply follows later', () => {
    const out = stripSyntheticTurns([
      user('u1', null, 'hi'),
      synthetic('s1', 'u1'),
      user('u2', 's1', 'go'),
      reply('a2', 'u2', 'ok'),
    ]);
    expect(texts(out.entries)).toEqual(['hi', 'go', expect.stringContaining('ok')]);
    expect(out.unansweredPrompts).toBe(0);
  });

  it('keeps a trailing tool result — that is a tool call mid-flight, not a prompt', () => {
    const input = [
      user('u1', null, 'run it'),
      reply('a1', 'u1', 'running'),
      toolResult('r1', 'a1'),
    ];
    const out = stripSyntheticTurns(input);
    expect(out.entries).toEqual(input);
    expect(out.unansweredPrompts).toBe(0);
  });

  // Structural, never prose: the model quoting the sentence is the model talking.
  it('keeps a real reply that happens to say the same words', () => {
    const input = [user('u1', null, 'q'), reply('a1', 'u1', 'No response requested.')];
    expect(stripSyntheticTurns(input).entries).toEqual(input);
  });
});

describe('claudeSessionStore.load() hands back only the conversation', () => {
  const silent = pino({ level: 'silent' });

  it('strips synthetic turns from the native mirror on resume', async () => {
    const nativeDir = mkdtempSync(join(tmpdir(), 'patch-native-'));
    mkdirSync(nativeDir, { recursive: true });
    const lines = [
      user('u1', null, 'hi'),
      reply('a1', 'u1', 'hello'),
      user('u2', 'a1', 'wake'),
      synthetic('s1', 'u2'),
    ];
    writeFileSync(
      join(nativeDir, 'sess.jsonl'),
      lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    );
    const store = createClaudeSessionStore({
      chatId: 'c1',
      folder: '/work',
      nativeDir,
      claudeProjectsRoot: mkdtempSync(join(tmpdir(), 'patch-cc-')),
      logger: silent,
    });
    const loaded = await store.load({ projectKey: 'p', sessionId: 'sess' });
    expect(texts(loaded ?? [])).toEqual(['hi', expect.stringContaining('hello')]);
  });

  it('strips them from the harness transcript when there is no mirror yet', async () => {
    const root = mkdtempSync(join(tmpdir(), 'patch-cc-'));
    const dir = join(root, '-work');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'sess.jsonl'),
      [
        user('u1', null, 'hi'),
        synthetic('s1', 'u1'),
        user('u2', 's1', 'go'),
        reply('a2', 'u2', 'ok'),
      ]
        .map((l) => JSON.stringify(l))
        .join('\n') + '\n',
    );
    const store = createClaudeSessionStore({
      chatId: 'c1',
      folder: '/work',
      nativeDir: mkdtempSync(join(tmpdir(), 'patch-native-')),
      claudeProjectsRoot: root,
      logger: silent,
    });
    const loaded = await store.load({ projectKey: 'p', sessionId: 'sess' });
    expect(texts(loaded ?? [])).toEqual(['hi', 'go', expect.stringContaining('ok')]);
  });
});

describe('a session with no conversation left is not resumed', () => {
  const silent = pino({ level: 'silent' });

  async function sendAfterWriting(lines: readonly E[]) {
    const home = mkdtempSync(join(tmpdir(), 'patch-synth-daemon-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-synth-folder-')));
    const projectsRoot = mkdtempSync(join(tmpdir(), 'patch-synth-projects-'));
    mkdirSync(join(projectsRoot, encodeFolder(folder)), { recursive: true });
    writeFileSync(
      join(projectsRoot, encodeFolder(folder), 'old-sess.jsonl'),
      lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    );
    const metaStore = createMetaStore(home);
    const events: WireEvent[] = [];
    const sdk = createMockSdkBackend();
    const daemon = new Daemon({
      daemonId: 'd1',
      metaStore,
      sdkBackend: sdk,
      sdkBackendKind: 'real',
      claudeProjectsRoot: projectsRoot,
      historyReader: createHistoryReader({ claudeProjectsRoot: projectsRoot }),
      oauthAccessToken: 'fake-token',
      emit: (e) => events.push(e),
      logger: silent,
      now: () => 1_700_000_000_000,
    });
    sdk.enqueue([{ type: 'result', sessionId: 'fresh-sess' }]);
    metaStore.write({
      chatId: 'c-dead',
      folder,
      name: 'dead first turn',
      nextSeq: 2,
      claudeSessionId: 'old-sess',
      createdAt: 1,
      updatedAt: 2,
    });
    daemon.hydrate();
    await daemon.sendInput({ chatId: 'c-dead', message: 'try again', localId: 'L1' });
    await new Promise((r) => setTimeout(r, 20));
    return { daemon, sdk, events, metaStore };
  }

  // Resuming it hands Claude Code an empty session ("No conversation found",
  // verified against 2.1.288); keeping the prompt makes it answer the prompt
  // itself. So the turn starts fresh, the way a first turn does.
  it('starts fresh when the only turn died and was answered by a placeholder', async () => {
    const { sdk, events, metaStore } = await sendAfterWriting([
      user('u1', null, 'first ask'),
      synthetic('s1', 'u1'),
    ]);
    expect(sdk.lastOptions()?.resumeSessionId).toBeUndefined();
    expect(events.find((e) => e.type === 'chat.error')).toBeUndefined();
    expect(metaStore.read('c-dead')?.claudeSessionId).toBe('fresh-sess');
  });

  it('still resumes a session that holds a real conversation', async () => {
    const { sdk } = await sendAfterWriting([
      user('u1', null, 'first ask'),
      reply('a1', 'u1', 'answered'),
    ]);
    expect(sdk.lastOptions()?.resumeSessionId).toBe('old-sess');
  });
});
