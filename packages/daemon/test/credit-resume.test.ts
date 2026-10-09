// Work stalled on credit starts again the moment ANY account has some.
//
// The bug these were written against: three different events can reveal that
// this host can work again — a limit reaching its reset, a person putting a key
// in, a usage reading coming back spendable — and each of them restarted a
// DIFFERENT subset of the stalled work. The reset path resumed only the chats
// that had ERRORED, so a chat parked against a 7-day window sat there while the
// other account's 5-hour window reset an hour later and the host ran everything
// else quite happily. The probe path resumed nothing at all: it moved a number
// on a settings screen.

import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { AccountRotation } from '../src/accountFailover.js';
import { CreditResume } from '../src/creditResume.js';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { TurnFailedError, type SdkBackend, type SdkEnvelope } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });
const HOUR = 3_600_000;

function harness(opts: { now?: () => number; observationGapMs?: number } = {}) {
  const clock = { t: 1_700_000_000_000 };
  const now = opts.now ?? ((): number => clock.t);
  const rotation = new AccountRotation(now);
  const resumeParked = vi.fn(() => 1);
  const resumeErrored = vi.fn(() => 2);
  const refreshUsage = vi.fn();
  const report = vi.fn();
  const readings: { accountId: string; blocked: boolean; at: number }[] = [];
  const warnings: string[] = [];
  const credit = new CreditResume({
    rotation,
    resumeParked,
    resumeErrored,
    refreshUsage,
    report,
    readings: () => readings,
    now,
    ...(opts.observationGapMs !== undefined ? { observationGapMs: opts.observationGapMs } : {}),
    logger: {
      info: () => undefined,
      debug: () => undefined,
      warn: (obj: unknown, msg?: string) => warnings.push(msg ?? String(obj)),
    } as unknown as pino.Logger,
  });
  return {
    clock,
    rotation,
    credit,
    resumeParked,
    resumeErrored,
    refreshUsage,
    report,
    readings,
    warnings,
  };
}

describe('a limit resetting resumes BOTH the parked chats and the errored ones', () => {
  it('resumes the parked work too — not only the chats that errored', () => {
    // THE bug. `retryOnCreditReturn` called `resumeErroredOnExhaustedAccount()`
    // and nothing else, so a chat the runner had PARKED waited for its own
    // per-chat timer — which may be armed for a weekly reset days out, or for
    // the 60s fallback of a limit that named no reset at all.
    const h = harness();
    h.rotation.markExhausted('a1', 'spend limit', h.clock.t + HOUR);
    h.credit.arm();
    h.clock.t += HOUR + 10_000;

    const counts = h.credit.limitReset();

    expect(h.resumeParked).toHaveBeenCalledTimes(1);
    expect(h.resumeErrored).toHaveBeenCalledTimes(1);
    expect(counts).toEqual({ parked: 1, errored: 2 });
    // Surfaces are told: the host's credit situation just changed.
    expect(h.report).toHaveBeenCalled();
  });

  it('resumes even while ANOTHER account is still out, and re-arms for that one', () => {
    // The timer is armed for the EARLIEST reset, so when it fires that account
    // has come back — there is credit on this host. A second account still
    // being out is a reason to re-arm, never a reason to leave a runnable turn
    // parked. It used to return early and resume nothing.
    const h = harness();
    h.rotation.markExhausted('a1', 'spend limit', h.clock.t + HOUR);
    h.rotation.markExhausted('a2', 'spend limit', h.clock.t + 8 * HOUR);
    h.credit.arm();
    h.clock.t += HOUR + 10_000;

    h.credit.limitReset();

    expect(h.resumeParked).toHaveBeenCalledTimes(1);
    expect(h.resumeErrored).toHaveBeenCalledTimes(1);
    // a1's record is gone (its reset passed), a2's stands and is waited for.
    expect(h.rotation.isExhausted('a1')).toBe(false);
    expect(h.rotation.isExhausted('a2')).toBe(true);
    expect(h.credit.armed()).toBe(true);
  });

  it('arms nothing for a limit that stated no reset — there is no instant to wait for', () => {
    const h = harness();
    h.rotation.markExhausted('a1', 'spend limit', undefined);
    h.credit.arm();
    expect(h.credit.armed()).toBe(false);
  });
});

describe('a usage reading showing credit is back', () => {
  it('clears the account and resumes the stalled work', () => {
    // The event that covers what the timer cannot: an account sidelined with no
    // stated reset arms nothing, so before this it stayed sidelined until a
    // human touched a credential.
    const h = harness({ observationGapMs: 10 * 60_000 });
    h.rotation.markExhausted('a1', 'spend limit', undefined);
    h.clock.t += 20 * 60_000;

    const believed = h.credit.observedUsable('a1', h.clock.t);

    expect(believed).toBe(true);
    expect(h.rotation.isExhausted('a1')).toBe(false);
    expect(h.resumeParked).toHaveBeenCalledTimes(1);
    expect(h.resumeErrored).toHaveBeenCalledTimes(1);
  });

  it('believes the TURN, not the reading, when the refusal is seconds old', () => {
    // An account without the extra-usage add-on reports its overage window
    // `rejected` for ever while its session window sits `allowed`, so the
    // reading says "spendable" about an account Claude Code has just refused
    // with `You've hit your monthly spend limit`. The failover fires a probe of
    // the spent account the instant it marks it, so that contradicting reading
    // arrives milliseconds later — believing it would un-park the turn that has
    // just failed, which fails again, which probes again, for ever.
    const h = harness({ observationGapMs: 10 * 60_000 });
    h.rotation.markExhausted('a1', 'monthly spend limit', undefined);
    h.clock.t += 900;

    expect(h.credit.observedUsable('a1', h.clock.t)).toBe(false);
    expect(h.rotation.isExhausted('a1')).toBe(true);
    expect(h.resumeParked).not.toHaveBeenCalled();
    // And it is SAID: the two sources of truth disagree, which is exactly the
    // thing that must never be swallowed silently.
    expect(h.warnings.join(' ')).toContain('believing the turn');
  });

  it('resumes nothing for an account nobody was waiting on', () => {
    // Otherwise the tracker's own ten-minute refresh of a perfectly healthy
    // host would re-send every parked turn, ten minutes apart, for ever — a
    // poll wearing an event's clothes.
    const h = harness();
    expect(h.credit.observedUsable('a1', h.clock.t)).toBe(false);
    expect(h.resumeParked).not.toHaveBeenCalled();
  });
});

describe('a person pressing Refresh', () => {
  it('resumes on a reading that finds credit, however fresh the refusal', () => {
    // `host.backend_usage_refresh` is pressed by someone who has just topped
    // up. Making them wait out the probe gap would make the button look broken
    // in the one moment it matters.
    const h = harness({ observationGapMs: 10 * 60_000 });
    h.rotation.markExhausted('a1', 'spend limit', undefined);
    h.readings.push({ accountId: 'a1', blocked: false, at: h.clock.t + 500 });

    const counts = h.credit.resumeIfCreditReturned({ force: true });

    expect(counts).toEqual({ parked: 1, errored: 2 });
    expect(h.rotation.isExhausted('a1')).toBe(false);
    expect(h.resumeParked).toHaveBeenCalledTimes(1);
    expect(h.resumeErrored).toHaveBeenCalledTimes(1);
  });

  it('resumes nothing when every reading still says blocked', () => {
    // No fallback, no optimism: a refresh that finds the account still spent
    // must not spend a turn proving it.
    const h = harness();
    h.rotation.markExhausted('a1', 'spend limit', undefined);
    h.readings.push({ accountId: 'a1', blocked: true, at: h.clock.t + 500 });

    expect(h.credit.resumeIfCreditReturned({ force: true })).toEqual({ parked: 0, errored: 0 });
    expect(h.rotation.isExhausted('a1')).toBe(true);
    expect(h.resumeParked).not.toHaveBeenCalled();
  });
});

describe('a key added or reconnected', () => {
  it('resumes both lists, like every other credit event', () => {
    const h = harness();
    h.rotation.markExhausted('a1', 'spend limit', h.clock.t + HOUR);
    h.rotation.clearAll();

    expect(h.credit.credentialChanged('account added')).toEqual({ parked: 1, errored: 2 });
    expect(h.resumeParked).toHaveBeenCalledTimes(1);
    expect(h.resumeErrored).toHaveBeenCalledTimes(1);
  });
});

describe('the real turn path', () => {
  it('a resumed chat may try EVERY account again, including the ones it already tried', async () => {
    // A chat parks having tried every key it could. The set of keys it tried is
    // a record of the situation that has just ENDED: resuming it because credit
    // came back and then refusing to try the key that came back is how a chat
    // stays stuck through the very event that was supposed to free it. It
    // parked again on its first refusal, having attempted nothing.
    const home = mkdtempSync(join(tmpdir(), 'patch-credit-tried-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-credit-triedf-')));
    mkdirSync(folder, { recursive: true });
    const runs = { n: 0 };
    const rotation = new AccountRotation(() => Date.now());
    const daemon = new Daemon({
      daemonId: 'd-tried',
      metaStore: createMetaStore(home),
      sdkBackend: {
        run: (): AsyncGenerator<SdkEnvelope> => {
          runs.n += 1;
          async function* gen(): AsyncGenerator<SdkEnvelope> {
            throw new Error(
              "Claude Code returned an error result: You've hit your monthly spend limit",
            );
            yield { type: 'result', raw: {} };
          }
          return gen();
        },
      },
      resolveOAuth: () => ({ ok: true as const, accessToken: 'tok', accountId: 'a1' }),
      emit: () => undefined,
      logger: silent,
      now: () => Date.now(),
      generateChatId: () => 'chat-tried',
      nextAccountAfterExhausted: (_chatId, spent, message) => {
        if (spent !== undefined) rotation.markExhausted(spent, message.slice(0, 200), undefined);
        return rotation.usableAccount([
          { id: 'a1', connected: true },
          { id: 'a2', connected: true },
        ]);
      },
    });
    daemon.setAutoResumeRateLimit(true);

    const chatId = await daemon.spawnChat({ folder, prompt: 'go' });
    const settle = async (): Promise<void> => {
      let last = -1;
      for (let i = 0; i < 20 && last !== runs.n; i++) {
        last = runs.n;
        await new Promise((r) => setTimeout(r, 40));
      }
    };
    await settle();
    // One go on each key, then parked — the existing rule.
    expect(runs.n).toBe(2);

    // Credit comes back and the parked turn is resumed.
    rotation.clearAll();
    expect(daemon.resumeAllRateLimited()).toBe(1);
    await settle();
    // It tried BOTH keys again. Without clearing the tried set it ran once and
    // parked straight back.
    expect(runs.n).toBe(4);
    expect(daemon.chatState.get(chatId)?.status).not.toBe('errored');
    daemon.shutdown();
  });

  it("re-runs a PARKED chat's turn when an unrelated account's limit resets", async () => {
    // End to end through the runner, not the stubs: a chat whose turn hit a
    // spend limit with every account spent is parked with a timer armed for its
    // OWN reset (~22 hours away here) — stated as an exact epoch on
    // `quotaLimits.resetsAt`, the way Claude Code actually sends it, since a
    // bare "resets 8pm (UTC)" sentence with no date is not enough to place a
    // weekly reset on a particular day (accountFailover.ts § parseLimitResetsAt).
    // A second account's limit resets an hour later, and the parked turn has to
    // run then — not a day later.
    const NOW = 1_700_000_000_000;
    const clock = { t: NOW };
    const home = mkdtempSync(join(tmpdir(), 'patch-credit-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-credit-f-')));
    mkdirSync(folder, { recursive: true });
    const events: WireEvent[] = [];
    const runs = { n: 0 };
    const backend: SdkBackend = {
      run: (): AsyncGenerator<SdkEnvelope> => {
        runs.n += 1;
        const first = runs.n === 1;
        async function* gen(): AsyncGenerator<SdkEnvelope> {
          if (first) {
            throw new TurnFailedError(
              "Claude Code returned an error result: You've hit your monthly spend limit · " +
                'your weekly limit resets 8pm (UTC)',
              {
                kind: 'rate_limit',
                status: 'rejected',
                rateLimitType: 'seven_day',
                resetsAt: NOW + 22 * HOUR,
              },
            );
          }
          yield { type: 'assistant', content: 'done', raw: {} };
          yield { type: 'result', sessionId: 'sess-1', content: 'done', raw: {} };
        }
        return gen();
      },
    };

    const rotation = new AccountRotation(() => clock.t);
    // The other account is already out, with a reset an hour away — so the
    // failing turn has nowhere to go and parks.
    rotation.markExhausted('a2', 'spend limit', NOW + HOUR);

    let daemon!: Daemon;
    const credit = new CreditResume({
      rotation,
      resumeParked: () => daemon.resumeAllRateLimited(),
      resumeErrored: () => daemon.resumeErroredOnExhaustedAccount(),
      refreshUsage: () => undefined,
      report: () => undefined,
      now: () => clock.t,
      logger: silent,
    });

    daemon = new Daemon({
      daemonId: 'd-credit',
      metaStore: createMetaStore(home),
      sdkBackend: backend,
      resolveOAuth: () => ({ ok: true as const, accessToken: 'tok', accountId: 'a1' }),
      emit: (e) => events.push(e),
      logger: silent,
      now: () => clock.t,
      generateChatId: () => 'chat-credit',
      nextAccountAfterExhausted: (_chatId, spent, message) => {
        if (spent !== undefined) {
          rotation.markExhausted(spent, message.slice(0, 200), undefined);
          credit.arm();
        }
        return rotation.usableAccount([
          { id: 'a1', connected: true },
          { id: 'a2', connected: true },
        ]);
      },
    });
    daemon.setAutoResumeRateLimit(true);

    const chatId = await daemon.spawnChat({ folder, prompt: 'go' });
    await new Promise((r) => setTimeout(r, 60));

    // Parked, not errored, and waiting on ITS OWN reset — tomorrow's 8pm UTC.
    const parkedState = daemon.chatState.get(chatId);
    expect(parkedState?.status).not.toBe('errored');
    expect(runs.n).toBe(1);
    const paused = [...events]
      .reverse()
      .find(
        (e) =>
          e.type === 'chat.state' &&
          (e as { rateLimitResumingAt?: number | null }).rateLimitResumingAt != null,
      ) as { rateLimitResumingAt: number } | undefined;
    expect(paused?.rateLimitResumingAt).toBeGreaterThan(NOW + 12 * HOUR);

    // An hour on, the OTHER account's limit resets and its timer fires.
    clock.t = NOW + HOUR + 10_000;
    credit.limitReset();
    await new Promise((r) => setTimeout(r, 60));

    // The parked turn ran, on the account that came back.
    expect(runs.n).toBe(2);
    const after = daemon.chatState.get(chatId);
    expect(after?.status).not.toBe('errored');
    const latest = [...events].reverse().find((e) => e.type === 'chat.state') as
      | { rateLimitResumingAt?: number | null }
      | undefined;
    expect(latest?.rateLimitResumingAt ?? null).toBeNull();

    daemon.shutdown();
  });
});

describe('the idempotency guard must not eat the resume', () => {
  it("re-runs a parked turn that was sent with a surface's localId", async () => {
    // The narrowest statement of the defect that made every other resume in
    // this file a no-op in production.
    //
    // `sendInput` remembers every localId a chat has ever been sent and
    // silently re-acks a repeat without running it — the guard against a
    // surface blindly redelivering a message it never saw acked. A parked
    // turn's localId is ALWAYS already in that set: the turn was accepted under
    // it and then failed. So re-sending the parked turn under its own id took
    // the duplicate branch and dropped it, and the chat sat there through the
    // very event meant to free it.
    //
    // A real surface turn carries a real localId, so that is what this sends.
    const home = mkdtempSync(join(tmpdir(), 'patch-credit-dedupe-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-credit-dedupef-')));
    mkdirSync(folder, { recursive: true });
    const runs = { n: 0 };
    const daemon = new Daemon({
      daemonId: 'd-dedupe',
      metaStore: createMetaStore(home),
      sdkBackend: {
        run: (): AsyncGenerator<SdkEnvelope> => {
          runs.n += 1;
          const first = runs.n === 1;
          async function* gen(): AsyncGenerator<SdkEnvelope> {
            if (first) {
              throw new Error(
                "Claude Code returned an error result: You've hit your monthly spend limit",
              );
            }
            yield { type: 'assistant', content: 'done', raw: {} };
            yield { type: 'result', sessionId: 'sess-1', content: 'done', raw: {} };
          }
          return gen();
        },
      },
      resolveOAuth: () => ({ ok: true as const, accessToken: 'tok', accountId: 'a1' }),
      emit: () => undefined,
      logger: silent,
      now: () => Date.now(),
      generateChatId: () => 'chat-dedupe',
      // Nowhere to fail over to, so the turn parks rather than moving on.
      nextAccountAfterExhausted: () => undefined,
    });
    daemon.setAutoResumeRateLimit(true);

    const chatId = await daemon.spawnChat({ folder });
    // The id a surface would have generated for this message.
    await daemon.sendInput({ chatId, message: 'go', localId: 'surface-local-id-1' });
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    await settle();
    expect(runs.n).toBe(1);

    // Credit is back somewhere: every parked chat is re-sent.
    expect(daemon.resumeAllRateLimited()).toBe(1);
    await settle();
    // It actually RAN. Under the old id this stayed at 1 for ever.
    expect(runs.n).toBe(2);
    expect(daemon.chatState.get(chatId)?.status).not.toBe('errored');
    daemon.shutdown();
  });
});
