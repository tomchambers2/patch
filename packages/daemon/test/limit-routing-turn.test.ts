// A failure that states when it lifts parks until then, whatever its wording,
// and a blocked chat says which routing strategy is in force.
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
import type { ChatStateEvent, WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { TurnFailedError } from '../src/sdkBackend.js';
import type { SdkBackend, SdkEnvelope } from '../src/sdkBackend.js';

const NOW = 1_700_000_000_000;
const RESETS_AT = NOW + 3 * 3_600_000;

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
    accountRouting: () => ({
      strategy: 'round-robin' as const,
      accounts: 3,
      exhausted: 3,
      nextResetsAt: RESETS_AT,
      nextLabel: 'personal',
    }),
  });
  if (opts.autoResume === true) daemon.setAutoResumeRateLimit(true);
  return { daemon, events, logs, folder, metaStore, runs };
}

const statesIn = (events: WireEvent[]): ChatStateEvent[] =>
  events.filter((e): e is ChatStateEvent => e.type === 'chat.state');

describe('a failure that states its reset in wording patch does not list', () => {
  it('parks on a structured resetsAt alone, off the retry ladder', async () => {
    const { daemon, events, folder, logs, runs } = setup({
      err: () => new TurnFailedError('Something unrecognised went wrong', { resetsAt: RESETS_AT }),
      autoResume: true,
    });
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'go' });
    expect(statesIn(events).at(-1)?.rateLimitResumingAt).toBe(RESETS_AT);
    expect(logs.join('\n')).not.toContain('scheduling retry');
    expect(runs.n).toBe(1);
    daemon.shutdown();
  });

  it('parks on a reset the prose states, with no structured block', async () => {
    const iso = new Date(RESETS_AT).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const { daemon, events, folder, logs } = setup({
      err: () => new Error(`Claude Code process exited. It resets at ${iso}.`),
      autoResume: true,
    });
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'go' });
    expect(statesIn(events).at(-1)?.rateLimitResumingAt).toBe(RESETS_AT);
    expect(logs.join('\n')).not.toContain('scheduling retry');
    daemon.shutdown();
  });

  it('is not laddered even with auto-resume off', async () => {
    const { daemon, folder, logs, runs } = setup({
      err: () => new TurnFailedError('Something unrecognised went wrong', { resetsAt: RESETS_AT }),
    });
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'go' });
    expect(logs.join('\n')).not.toContain('scheduling retry');
    expect(runs.n).toBe(1);
    daemon.shutdown();
  });
});

describe('a failure that falls through to the retry ladder', () => {
  it('logs the raw error and limit shape loudly', async () => {
    const { daemon, folder, logs } = setup({ err: () => new Error('socket hang up') });
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'go' });
    const line = logs.map((l) => JSON.parse(l)).find((l) => /retry ladder/.test(l.msg));
    expect(line).toBeDefined();
    expect(line.level).toBe(40);
    expect(line.errMsg).toContain('socket hang up');
    expect('limit' in line).toBe(true);
    daemon.shutdown();
  });
});

describe('the block says how the host routes', () => {
  it('carries the strategy and how many accounts are out', async () => {
    const { daemon, events, folder } = setup({
      err: () => new TurnFailedError('limit', { status: 'rejected', resetsAt: RESETS_AT }),
      autoResume: true,
    });
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'go' });
    expect(statesIn(events).at(-1)?.limitBlock?.routing).toEqual({
      strategy: 'round-robin',
      accounts: 3,
      exhausted: 3,
      nextResetsAt: RESETS_AT,
      nextLabel: 'personal',
    });
    daemon.shutdown();
  });
});
