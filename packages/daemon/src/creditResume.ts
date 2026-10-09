// Picking the stalled work back up the moment ANY account has credit again.
//
// Two different things stop when a host runs out of credit, and for a long time
// only one of them ever started again:
//
//   PARKED — a turn that hit the limit, was held in `rateLimitPendingTurns`
//   and had a per-chat timer armed for its own stated reset.
//   ERRORED — a turn that failed on a spent account before parking existed, or
//   after its retries ran out, and sits in `errored` with the turn on disk.
//
// `host.backend_connect` and `host.backend_add_account` resumed both. The limit
// RESET path resumed only the errored ones, so a chat parked against a 7-day
// weekly window stayed parked when the OTHER account's 5-hour window reset an
// hour later — there was credit on the host and a turn waiting for it, and
// nothing joined the two up. And a usage probe watching an account come back
// resumed neither: it updated a number on a settings screen.
//
// So the sequence lives HERE, once, named, and every event that can reveal
// credit calls it. The next event added cannot half-implement it by resuming
// one list and forgetting the other, which is precisely how this drifted.
//
// STILL EVENT-DRIVEN. Nothing in this file polls. The events are:
//
//   1. a limit reaching its stated reset        → `limitReset`, off one timer
//      armed for exactly that instant;
//   2. a key added or reconnected by a person   → `credentialChanged`;
//   3. a usage reading showing an account that  → `observedUsable`, off the
//      was spent is spendable again               readings the tracker already
//                                                 takes (its own 10-minute
//                                                 refresh, or a person pressing
//                                                 Refresh).
//
// (3) is what covers the case (1) cannot: a limit stated with NO reset time
// arms no timer, because there is no instant to arm for. Before it, such an
// account stayed marked spent until someone touched a credential.

import type { Logger } from 'pino';
import type { AccountRotation } from './accountFailover.js';
import { USAGE_POLL_INTERVAL_MS } from './accountUsage.js';

/** One account's latest usage reading, as this module needs to read it. */
export interface AccountReading {
  accountId: string;
  /** True when a pool a person actually spends is refusing work right now. */
  blocked: boolean;
  /** When the reading was taken, ms-epoch. */
  at: number;
}

export interface CreditResumeOpts {
  rotation: AccountRotation;
  /** Un-park every chat waiting out a limit and re-send its turn. Returns how many. */
  resumeParked: () => number;
  /** Re-send the turns of chats that ERRORED on a spent account. Returns how many. */
  resumeErrored: () => number;
  /** Re-read every account's real usage, past the per-account floor. */
  refreshUsage: () => void;
  /** Publish the host's account report to every surface. */
  report: () => void;
  logger: Pick<Logger, 'info' | 'warn' | 'debug'>;
  /** Every account's latest reading, for the frames that look at all of them. */
  readings?: () => readonly AccountReading[];
  now?: () => number;
  /**
   * How long after a refusal an "it has credit" reading is believed.
   *
   * A probe is NOT a source of truth about whether a turn will succeed — a
   * turn's own failure is that (see `accountUsage.ts`). The two really do
   * disagree: an account without the extra-usage add-on reports its overage
   * window `rejected` for ever while its session window sits `allowed`, so the
   * reading says "spendable" about an account Claude Code has just refused with
   * `You've hit your monthly spend limit`. Believing that reading immediately
   * would un-park the turn that just failed, which fails again, which probes
   * again — a loop, one real turn per go.
   *
   * So an observed credit return is believed only when the reading is a LATER,
   * INDEPENDENT look: taken at least one refresh cycle after the refusal, not
   * the diagnostic probe the refusal itself fired. A person pressing Refresh
   * (or adding a key) is an explicit assertion that the situation changed and
   * bypasses this — that is what `force` is for.
   */
  observationGapMs?: number;
}

/** What one resume did, so a caller can log a number rather than an intention. */
export interface ResumeCounts {
  parked: number;
  errored: number;
}

export class CreditResume {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly observationGapMs: number;

  constructor(private readonly opts: CreditResumeOpts) {
    this.observationGapMs = opts.observationGapMs ?? USAGE_POLL_INTERVAL_MS;
  }

  private get now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /**
   * THE sequence. Run the work that was waiting on credit — BOTH lists — and
   * say how much of each there was.
   *
   * Both, always. They are the same situation seen at two different moments of
   * this codebase's life, and a caller that knows about only one of them is a
   * caller that half-fixes the host.
   */
  resumeWaitingWork(
    reason: string,
    extra: { accountId?: string; refreshUsage?: boolean } = {},
  ): ResumeCounts {
    // A new situation deserves a fresh reading: the figures a surface shows
    // next are about the account that is now running the work, not the one that
    // ran out. Skipped by the caller that IS a reading.
    if (extra.refreshUsage !== false) this.opts.refreshUsage();
    const parked = this.opts.resumeParked();
    const errored = this.opts.resumeErrored();
    const line = {
      reason,
      ...(extra.accountId !== undefined ? { accountId: extra.accountId } : {}),
      parked,
      errored,
    };
    // Both counts, always — "resumed the parked ones" with the errored ones
    // silently left behind is the shape of the bug this replaced. A resume that
    // found nothing waiting is not news, so it goes to debug rather than
    // announcing itself on every routine probe.
    if (parked > 0 || errored > 0) {
      this.opts.logger.info(line, 'credit returned — resumed the work that was waiting on it');
    } else {
      this.opts.logger.debug(line, 'credit returned — nothing was waiting on it');
    }
    this.opts.report();
    return { parked, errored };
  }

  /**
   * A person put a credential in (added or reconnected a key).
   *
   * The caller clears the rotation itself — an ADD clears every account, a
   * reconnect clears one — because which of those it is is the caller's fact,
   * not this module's.
   */
  credentialChanged(reason: string, accountId?: string): ResumeCounts {
    return this.resumeWaitingWork(reason, {
      ...(accountId !== undefined ? { accountId } : {}),
      // The frames that call this already force their own refresh, against the
      // specific account whose token just changed.
      refreshUsage: false,
    });
  }

  /**
   * A usage reading says an account that was recorded as spent is spendable.
   *
   * Returns whether it was believed, so a caller can tell "resumed" from
   * "nothing was waiting on that account".
   */
  observedUsable(accountId: string, readingAt: number, opts: { force?: boolean } = {}): boolean {
    const markedAt = this.opts.rotation.markedAt(accountId);
    // Nothing was waiting on this account. Resuming here would fire on every
    // routine probe of a healthy host and re-run turns parked for reasons this
    // account has nothing to do with.
    if (markedAt === undefined) return false;
    if (opts.force !== true && readingAt - markedAt < this.observationGapMs) {
      // Said out loud, because it is a genuine contradiction and the one that
      // hides a real bug if it is ever silently swallowed: the account's own
      // figures say it can spend, and a turn on it has just been refused.
      this.opts.logger.warn(
        { accountId, refusedAt: markedAt, readingAt },
        'usage says this account has credit but a turn on it was just refused — believing the turn, not the reading',
      );
      return false;
    }
    if (!this.opts.rotation.clear(accountId)) return false;
    this.resumeWaitingWork('an account has credit again', { accountId, refreshUsage: false });
    return true;
  }

  /**
   * Look at every account's latest reading and resume if any of them has come
   * back. For the frames that speak about the whole host rather than one
   * account — `host.backend_usage_refresh` above all, which is the button a
   * person presses having just topped up.
   */
  resumeIfCreditReturned(opts: { force?: boolean } = {}): ResumeCounts {
    const readings = this.opts.readings?.() ?? [];
    let parked = 0;
    let errored = 0;
    for (const reading of readings) {
      if (reading.blocked) continue;
      const markedAt = this.opts.rotation.markedAt(reading.accountId);
      if (markedAt === undefined) continue;
      if (opts.force !== true && reading.at - markedAt < this.observationGapMs) continue;
      if (!this.opts.rotation.clear(reading.accountId)) continue;
      const counts = this.resumeWaitingWork('an account has credit again', {
        accountId: reading.accountId,
        refreshUsage: false,
      });
      parked += counts.parked;
      errored += counts.errored;
    }
    return { parked, errored };
  }

  /**
   * A stated reset has arrived — the timer this module armed has fired.
   *
   * Resumes unconditionally, because the timer is armed for the EARLIEST reset
   * of anything sidelined: by the time it fires that account's window has
   * passed and `isExhausted` has let it go, so there is credit on this host.
   * Another account still being out is a reason to re-arm for ITS reset, not a
   * reason to leave a runnable turn parked — which is what it used to be.
   */
  limitReset(): ResumeCounts {
    this.timer = undefined;
    // Reading the snapshot first is what expires the records whose reset has
    // passed; it is not just for the log line.
    const stillBlocked = this.opts.rotation.snapshot();
    const counts = this.resumeWaitingWork('a limit reset');
    if (stillBlocked.length > 0) {
      this.opts.logger.debug(
        { blocked: stillBlocked.map((b) => b.accountId) },
        'credit retry: another account is still out — re-arming for its reset',
      );
      this.arm();
    }
    return counts;
  }

  /**
   * Arm for the soonest reset anything sidelined has stated.
   *
   * An account sidelined with NO stated reset arms nothing, deliberately: there
   * is no instant to wait for. It waits for a credential change or for a usage
   * reading to show it spendable — events (2) and (3) — rather than for a clock
   * that would be guessing.
   */
  arm(): void {
    const at = this.opts.rotation.earliestReset();
    if (at === undefined) return;
    if (this.timer) clearTimeout(this.timer);
    // +5s past the stated reset: firing exactly on the boundary races the
    // provider's own clock, and being refused again would re-mark the account
    // and push the retry out by another whole window.
    const delay = Math.max(1_000, at - this.now + 5_000);
    this.opts.logger.info(
      { at, delayMs: delay },
      'credit retry: armed for the moment the limit resets',
    );
    this.timer = setTimeout(() => this.limitReset(), delay);
    this.timer.unref?.();
  }

  /** Is a reset currently being waited for? For tests and diagnostics. */
  armed(): boolean {
    return this.timer !== undefined;
  }

  stop(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
