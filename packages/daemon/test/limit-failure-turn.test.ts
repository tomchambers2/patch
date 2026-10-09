// The error boundary, for a failure patch states itself (spec/12 § A turn only
// dies for a reason someone chose).
//
// The park path (auto-resume on) already emitted no `chat.error` at all. With it
// OFF the same failure fell through to the generic tail, which put the
// provider's whole sentence into `chat.error`, into `chat_state.lastError` and
// into `meta.json` — from where it reached the transcript, `patch_peek` and the
// run log of every job whose chat died on it. Reported twice, once in patch's
// words and once in Anthropic's.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { ChatErrorEvent, ChatStateEvent, WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { TurnFailedError } from '../src/sdkBackend.js';
import type { SdkBackend, SdkEnvelope } from '../src/sdkBackend.js';

const NOW = 1_700_000_000_000;
const RESETS_AT = NOW + 3 * 3_600_000;

const PROVIDER_SENTENCE =
  "Claude Code returned an error result: You've hit your monthly spend limit · " +
  'raise it at claude.ai/settings/usage?from=cc_cli_limit_message · your weekly ' +
  'limit resets Sep 15, 4am (UTC)';

/** Throws on the first run; succeeds after that, so a re-send is observable. */
function failingBackend(runs: { n: number }, err: () => Error): SdkBackend {
  return {
    run: (): AsyncGenerator<SdkEnvelope> => {
      runs.n += 1;
      const first = runs.n === 1;
      async function* gen(): AsyncGenerator<SdkEnvelope> {
        if (first) throw err();
        yield { type: 'assistant', content: 'done', raw: {} };
        yield { type: 'result', sessionId: 'sess-1', content: 'done', raw: {} };
      }
      return gen();
    },
  };
}

function setup(opts: { err: () => Error; autoResume?: boolean }) {
  const home = mkdtempSync(join(tmpdir(), 'patch-limitprose-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-limitprose-f-')));
  const metaStore = createMetaStore(home);
  const events: WireEvent[] = [];
  const logs: string[] = [];
  const runs = { n: 0 };
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore,
    sdkBackend: failingBackend(runs, opts.err),
    resolveOAuth: () => ({ ok: true as const, accessToken: 'tok', accountId: 'a1' }),
    emit: (e) => events.push(e),
    logger: pino({ level: 'trace' }, { write: (s: string) => logs.push(s) }),
    now: () => NOW,
    generateChatId: () => 'chat-1',
    accountLimitInfo: () => ({ label: 'Default', scope: 'week' as const, resetsAt: RESETS_AT }),
  });
  if (opts.autoResume === true) daemon.setAutoResumeRateLimit(true);
  return { daemon, events, logs, folder, metaStore, runs };
}

const statedLimit = (): TurnFailedError =>
  new TurnFailedError(PROVIDER_SENTENCE, {
    kind: 'rate_limit',
    status: 'rejected',
    rateLimitType: 'seven_day',
    resetsAt: RESETS_AT,
  });

const errorsIn = (events: WireEvent[]): ChatErrorEvent[] =>
  events.filter((e): e is ChatErrorEvent => e.type === 'chat.error');
const statesIn = (events: WireEvent[]): ChatStateEvent[] =>
  events.filter((e): e is ChatStateEvent => e.type === 'chat.state');

describe('a limit failure nobody parked', () => {
  it('reports it in patch’s words, not the provider’s', async () => {
    const { daemon, events, folder } = setup({ err: statedLimit });
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'go' });
    const errs = errorsIn(events);
    expect(errs).toHaveLength(1);
    expect(errs[0]?.error.code).toBe('sdk_error');
    expect(errs[0]?.error.message).not.toMatch(/spend limit/i);
    expect(errs[0]?.error.message).not.toMatch(/claude\.ai/i);
    expect(errs[0]?.error.message).toMatch(/usage limit reached/i);
    expect(errs[0]?.error.message).toMatch(/weekly window/i);
    daemon.shutdown();
  });

  it('publishes the structured block, so there IS something in its place', async () => {
    // Removing the sentence and replacing it with nothing would be the worse
    // bug: the bubble is the whole reason the sentence is not needed, and it
    // used to be gated on a resume time that this path never sets.
    const { daemon, events, folder } = setup({ err: statedLimit });
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'go' });
    const last = statesIn(events).at(-1);
    expect(last?.rateLimitResumingAt ?? null).toBeNull();
    expect(last?.limitBlock?.scope).toBe('week');
    expect(last?.limitBlock?.accountLabel).toBe('Default');
    expect(last?.limitBlock?.resetsAt).toBe(RESETS_AT);
    // The provider's sentence, kept where a diagnosis needs it.
    expect(last?.limitBlock?.raw).toContain('spend limit');
    daemon.shutdown();
  });

  it('keeps the provider’s sentence out of what a restart reads back', async () => {
    const { daemon, folder, metaStore, logs } = setup({ err: statedLimit });
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'go' });
    const stored = metaStore.read(chatId)?.lastError;
    expect(stored?.message).not.toMatch(/spend limit/i);
    expect(stored?.message).toMatch(/usage limit reached/i);
    expect(daemon.chatState.get(chatId)?.lastError?.message).toBe(stored?.message);
    // …while the log — the one place a diagnosis is done — still has it in full.
    expect(logs.join('\n')).toContain('cc_cli_limit_message');
    daemon.shutdown();
  });

  it('leaves the turn owed, and off the generic retry ladder', async () => {
    // Three attempts a minute apart at a window that resets in hours only fail
    // three more times, each one reporting itself everywhere again.
    const { daemon, folder, metaStore, logs, runs } = setup({ err: statedLimit });
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'go' });
    expect(logs.join('\n')).not.toContain('scheduling retry');
    expect(runs.n).toBe(1);
    expect(metaStore.read(chatId)?.pendingTurns?.[0]?.message).toBe('go');
    daemon.shutdown();
  });

  it('runs the owed turn when the reader presses Try now', async () => {
    const { daemon, folder, runs } = setup({ err: statedLimit });
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'go' });
    expect(daemon.resumeRateLimitedNow(chatId)).toBe(true);
    for (let i = 0; i < 20 && runs.n < 2; i++) await new Promise((r) => setTimeout(r, 20));
    expect(runs.n).toBe(2);
    daemon.shutdown();
  });

  it('says nothing structured about a chat that never hit a limit', () => {
    const { daemon } = setup({ err: statedLimit });
    expect(daemon.resumeRateLimitedNow('chat-nope')).toBe(false);
    daemon.shutdown();
  });
});

describe('a failure patch has no structured account of', () => {
  it('keeps its real message, in full', async () => {
    const { daemon, events, folder } = setup({
      err: () => new Error('Error: socket hang up reading the SDK stream'),
    });
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'go' });
    const errs = errorsIn(events);
    expect(errs).toHaveLength(1);
    expect(errs[0]?.error.message).toContain('socket hang up');
    expect(statesIn(events).at(-1)?.limitBlock ?? null).toBeNull();
    daemon.shutdown();
  });
});

describe('a limit failure that IS parked', () => {
  it('still emits no error at all — the pause is the report', async () => {
    const { daemon, events, folder } = setup({ err: statedLimit, autoResume: true });
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'go' });
    expect(errorsIn(events)).toHaveLength(0);
    const last = statesIn(events).at(-1);
    expect(last?.rateLimitResumingAt).toBe(RESETS_AT);
    expect(last?.limitBlock?.scope).toBe('week');
    daemon.shutdown();
  });
});

describe('a limit failure that WAS parked for auto-resume', () => {
  it('shows as errored, not idle, so the badge is a triangle and the notification a failure', async () => {
    const { daemon, events, folder } = setup({ err: statedLimit, autoResume: true });
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'go' });
    const last = statesIn(events).at(-1);
    expect(last?.rateLimitResumingAt).toBe(RESETS_AT);
    expect(last?.activity).toBe('errored');
    expect(last?.turnRetrying).not.toBe(true);
    expect(last?.lastError?.message).toMatch(/usage limit reached/i);
    expect(last?.lastError?.message).not.toMatch(/spend limit/i);
    // The bubble already says it; a second chat.error row would be the same news twice.
    expect(errorsIn(events)).toHaveLength(0);
    daemon.shutdown();
  });
});
