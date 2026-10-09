// Lifting a usage-limit pause has to reach the surface, or the reader is left
// pressing a control the host retired hours ago.
//
// Reported as "try now on usage out does nothing": nine presses of Try now on
// one chat, every one of them logged `manual resume from a usage-limit pause
// {"resumed": false}`. The host had nothing parked for that chat — the pause
// had already been lifted, silently, on a path that emits no `chat.state`. The
// bubble (and its live button) is drawn from `chat.state` alone, so it stayed on
// screen for a pause that no longer existed, and the button stayed dead.

import { describe, expect, it, vi, afterEach } from 'vitest';
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
const DELAY_MS = RESETS_AT - NOW;

const PROVIDER_SENTENCE =
  "Claude Code returned an error result: You've hit your monthly spend limit · " +
  'your weekly limit resets Sep 15, 4am (UTC)';

const statedLimit = (): TurnFailedError =>
  new TurnFailedError(PROVIDER_SENTENCE, {
    kind: 'rate_limit',
    status: 'rejected',
    rateLimitType: 'seven_day',
    resetsAt: RESETS_AT,
  });

/** Throws on the first run; succeeds after that, so a re-send is observable. */
function failingBackend(runs: { n: number }): SdkBackend {
  return {
    run: (): AsyncGenerator<SdkEnvelope> => {
      runs.n += 1;
      const first = runs.n === 1;
      async function* gen(): AsyncGenerator<SdkEnvelope> {
        if (first) throw statedLimit();
        yield { type: 'assistant', content: 'done', raw: {} };
        yield { type: 'result', sessionId: 'sess-1', content: 'done', raw: {} };
      }
      return gen();
    },
  };
}

function setup(opts: { autoResume?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'patch-rlpause-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-rlpause-f-')));
  const metaStore = createMetaStore(home);
  const events: WireEvent[] = [];
  const logs: string[] = [];
  const runs = { n: 0 };
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore,
    sdkBackend: failingBackend(runs),
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

const statesIn = (events: WireEvent[]): ChatStateEvent[] =>
  events.filter((e): e is ChatStateEvent => e.type === 'chat.state');

// These three maps are the pause, and none of them has a public setter or
// deleter — they are only ever written by the limit path itself. The states
// below are reached in production by a race (a parked turn taken out from under
// a live timer; a resume id the redelivery guard has already seen; a surface
// holding a pause the host has dropped), which cannot be staged through the
// public API without also staging the race. Reach in and set the state, then
// exercise the real code path over it.
type LimitBlock = NonNullable<ChatStateEvent['limitBlock']>;
type Internals = {
  rateLimitPendingTurns: Map<string, { message: string; localId?: string }>;
  limitBlocks: Map<string, LimitBlock>;
  seenLocalIds: Map<string, Set<string | undefined>>;
};
const internals = (daemon: Daemon): Internals => daemon as unknown as Internals;

afterEach(() => {
  vi.useRealTimers();
});

describe('the auto-resume timer firing', () => {
  it('clears the pause on the surface even when there is no turn left to run', async () => {
    vi.useFakeTimers();
    const { daemon, events, folder } = setup({ autoResume: true });
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'go' });
    expect(statesIn(events).at(-1)?.rateLimitResumingAt).toBe(RESETS_AT);

    // The owed turn goes missing between arming and firing.
    internals(daemon).rateLimitPendingTurns.delete(chatId);
    events.length = 0;
    await vi.advanceTimersByTimeAsync(DELAY_MS + 10);

    const last = statesIn(events).at(-1);
    expect(last, 'the timer emitted no state at all').toBeDefined();
    expect(last?.rateLimitResumingAt ?? null).toBeNull();
    expect(last?.limitBlock ?? null).toBeNull();
    daemon.shutdown();
  });

  it('clears the pause on the surface even when the re-send is deduped', async () => {
    vi.useFakeTimers();
    const { daemon, events, logs, folder, runs } = setup({ autoResume: true });
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'go' });
    expect(statesIn(events).at(-1)?.limitBlock?.scope).toBe('week');

    // `sendInput` has already seen the id this resume will mint, so it will
    // re-ack it and run nothing — emitting no state of its own.
    internals(daemon).seenLocalIds.get(chatId)?.add(`rl-resume-${chatId}-${NOW}`);
    events.length = 0;
    await vi.advanceTimersByTimeAsync(DELAY_MS + 10);

    expect(logs.join('\n')).toContain('duplicate localId, re-acked without re-running');
    expect(runs.n, 'the turn should NOT have re-run — that is the premise').toBe(1);
    const last = statesIn(events).at(-1);
    expect(last, 'the deduped resume emitted no state at all').toBeDefined();
    expect(last?.rateLimitResumingAt ?? null).toBeNull();
    expect(last?.limitBlock ?? null).toBeNull();
    daemon.shutdown();
  });
});

describe('Try now on a chat with nothing parked', () => {
  it('clears the stale pause instead of doing nothing', async () => {
    const { daemon, events, logs, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'go' });

    // First press runs the owed turn.
    expect(daemon.resumeRateLimitedNow(chatId)).toBe(true);
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 20));

    // Second press: the turn is long gone, but the reader is still looking at
    // the bubble. This is the press that used to do nothing at all.
    events.length = 0;
    expect(daemon.resumeRateLimitedNow(chatId)).toBe(false);
    const last = statesIn(events).at(-1);
    expect(last, 'a press with nothing parked emitted no state at all').toBeDefined();
    expect(last?.rateLimitResumingAt ?? null).toBeNull();
    expect(last?.limitBlock ?? null).toBeNull();
    // …and the log still says which of the two things happened.
    expect(logs.join('\n')).toContain('cleared a stale usage-limit pause');
    daemon.shutdown();
  });

  it('drops a limit block the host is still holding for it', async () => {
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    internals(daemon).limitBlocks.set(chatId, { scope: 'week', resetsAt: RESETS_AT, raw: 'x' });
    events.length = 0;

    expect(daemon.resumeRateLimitedNow(chatId)).toBe(false);
    expect(internals(daemon).limitBlocks.has(chatId)).toBe(false);
    expect(statesIn(events).at(-1)?.limitBlock ?? null).toBeNull();
    daemon.shutdown();
  });

  it('still says nothing about a chat it has never heard of', () => {
    const { daemon, events } = setup();
    expect(daemon.resumeRateLimitedNow('chat-nope')).toBe(false);
    expect(statesIn(events)).toHaveLength(0);
    daemon.shutdown();
  });
});
