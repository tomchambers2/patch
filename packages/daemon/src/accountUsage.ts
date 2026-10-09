// Keeping every stored account's usage current, including the spent ones.
//
// The reading patch had before this file could only be produced BY A TURN: the
// SDK's `rate_limit_event` rides on a query, so an account with no credit — the
// one you most want to look at — could not produce one. Its last reading was
// the one that blocked it, and Settings went on showing that reading for as
// long as the host stayed up. On 2026-09-11 that was a Wednesday figure
// displayed on a Friday, with no way for a reader to tell.
//
// So the reading is taken directly, on a schedule, per account, whether or not
// the account can run anything. `fetchClaudeUsage` gets its numbers from the
// response headers of a `max_tokens: 1` Haiku call — which on a spent account
// is a 429 that costs nothing and still carries the full set.
//
// WHAT THIS IS NOT. It is not a source of truth about whether a turn will
// succeed; a turn's own failure is that. It is what lets a human look at the
// host and see the situation without running anything, and what lets the
// failover know that two accounts are one account.

import type { Logger } from 'pino';
import { rateLimitWindowsBlocked } from '@patch/wire';
import {
  fetchClaudeUsage,
  type ClaudeUsageReading,
  type ClaudeUsageResult,
  type ClaudeStoredAccount,
} from '@patch/auth';

/** How often the timer refreshes every account, unprompted. */
export const USAGE_POLL_INTERVAL_MS = 10 * 60_000;

/**
 * The floor between two probes of the SAME account.
 *
 * Every event that can change an account's situation asks for a refresh —
 * a turn failing, a token being pasted, a surface pressing the button — and on
 * a busy host those arrive in bursts. Without a floor, twenty chats failing
 * within a second would fire twenty probes at one account for one fact.
 */
export const USAGE_MIN_INTERVAL_MS = 30_000;

/** One account's last reading, plus how it was obtained. */
export interface AccountUsageEntry {
  reading: ClaudeUsageReading;
  /**
   * `probe` — asked directly, so true of the account as a whole.
   * `turn` — observed on a turn's own `rate_limit_event`, which covers only the
   * session and week windows and only for the account that turn ran on.
   *
   * Kept because they are not equally complete, and a reader deciding whether
   * to trust an absent `overage` needs to know which kind of reading they are
   * looking at.
   */
  source: 'probe' | 'turn';
}

type TokenFor = (accountId: string) => Promise<string | undefined>;

/**
 * A ms-epoch as something a person reading the log can sanity-check at a
 * glance, or undefined unchanged.
 *
 * Added after a report that a window's `resetsAt` was showing a day that
 * could not have been right — this file's own probe log recorded the
 * utilization at the moment in question but not the reset instant that came
 * with it, so there was no way to tell whether Anthropic had actually stated
 * that instant or patch had produced it some other way. Next time, this
 * answers that in one line instead of a re-run of the whole investigation.
 */
function isoOrUndefined(at: number | undefined): string | undefined {
  return at === undefined ? undefined : new Date(at).toISOString();
}

/**
 * Every stored account's current usage, refreshed on a timer and on demand.
 *
 * In memory, like the exhaustion record it sits beside: a usage figure is a
 * statement about right now, and a stale one restored from disk at boot would
 * be worse than an honest blank while the first probe runs.
 */
export class AccountUsageTracker {
  private readonly entries = new Map<string, AccountUsageEntry>();
  private readonly lastProbeAt = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly opts: {
      /** Resolve an account's access token, refreshing it if need be. */
      tokenFor: TokenFor;
      /** The accounts to keep readings for, read fresh each pass. */
      accounts: () => readonly ClaudeStoredAccount[];
      /** Called whenever a reading changes, so the host report can be re-sent. */
      onChange: () => void;
      /**
       * Called with every reading a PROBE lands, whatever it says.
       *
       * Separate from `onChange` because the two answer different questions.
       * `onChange` means "a number a surface shows has moved"; this one carries
       * the reading itself, so the host can act on what it says — above all on
       * an account it had recorded as spent turning out to be spendable again,
       * which is one of only three events that can restart work parked for
       * credit (`creditResume.ts`). Turn-observed windows do NOT fire it: they
       * cover only the account a turn just ran on, and a spent account cannot
       * produce one, so they can never carry this news.
       */
      onReading?: (accountId: string, reading: ClaudeUsageReading) => void;
      /**
       * Record which organisation an account's token turned out to belong to.
       *
       * The probe learns this for free, and it is the only way accounts stored
       * before identity existed ever get one — including the two on this host
       * that were the same account under different labels. Without the
       * backfill, the duplicate guard and the shared-pool failover stay blind
       * on exactly the machine that needed them.
       */
      rememberOrganization?: (accountId: string, organizationId: string) => void;
      /** Probe override (tests). */
      probe?: (accessToken: string) => Promise<ClaudeUsageResult>;
      now?: () => number;
      logger?: Pick<Logger, 'info' | 'warn' | 'debug'>;
    },
  ) {}

  private get now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** The last reading for an account, or undefined when none has been taken. */
  get(accountId: string): AccountUsageEntry | undefined {
    return this.entries.get(accountId);
  }

  /**
   * Fold in a window observed on a turn.
   *
   * Merged into whatever the probe last saw rather than replacing it, because a
   * turn only ever speaks about session and week: overwriting would silently
   * drop the overage window, which is the one that explains "monthly spend
   * limit".
   */
  observeFromTurn(
    accountId: string,
    scope: 'session' | 'week',
    window: ClaudeUsageReading['windows']['session'],
  ): void {
    if (!window) return;
    const prior = this.entries.get(accountId);
    const windows = { ...(prior?.reading.windows ?? {}), [scope]: window };
    this.entries.set(accountId, {
      source: prior?.source === 'probe' ? 'probe' : 'turn',
      reading: {
        ...(prior?.reading ?? { blocked: false, at: 0, windows: {} }),
        windows,
        // Spendable pools only. The overage window a probe left behind is
        // rejected for the whole life of an account without the extra-usage
        // add-on, so counting it here would mark every such account blocked
        // the moment a perfectly healthy turn reported in.
        blocked: rateLimitWindowsBlocked(windows),
        at: this.now,
      },
    });
    this.opts.onChange();
  }

  /**
   * Probe one account now, unless it was probed within `USAGE_MIN_INTERVAL_MS`.
   *
   * `force` overrides the floor — for the one case where a human has just
   * pressed refresh and is watching for it to change.
   */
  async refresh(accountId: string, force = false): Promise<void> {
    const existing = this.inFlight.get(accountId);
    if (existing) return existing;
    const last = this.lastProbeAt.get(accountId);
    if (!force && last !== undefined && this.now - last < USAGE_MIN_INTERVAL_MS) return;

    const run = this.probeOnce(accountId).finally(() => this.inFlight.delete(accountId));
    this.inFlight.set(accountId, run);
    return run;
  }

  /** Probe every stored account that has a credential. */
  async refreshAll(force = false): Promise<void> {
    await Promise.all(
      this.opts
        .accounts()
        .filter((a) => a.credential !== null)
        .map((a) => this.refresh(a.id, force)),
    );
  }

  private async probeOnce(accountId: string): Promise<void> {
    this.lastProbeAt.set(accountId, this.now);
    let token: string | undefined;
    try {
      token = await this.opts.tokenFor(accountId);
    } catch (err) {
      this.opts.logger?.debug(
        { accountId, err: (err as Error).message },
        'usage probe: could not resolve a token',
      );
      return;
    }
    if (token === undefined) return;

    const result = await (this.opts.probe ?? fetchClaudeUsage)(token);
    if (result.kind !== 'ok') {
      // An unreachable probe changes NOTHING. Blanking the reading on a network
      // blip would read as "this account has no limits", and a rejected
      // credential is the credential check's business, not usage's.
      this.opts.logger?.debug(
        { accountId, kind: result.kind, reason: result.message },
        'usage probe: no reading',
      );
      return;
    }
    this.entries.set(accountId, { reading: result.reading, source: 'probe' });
    if (result.reading.organizationId !== undefined) {
      this.opts.rememberOrganization?.(accountId, result.reading.organizationId);
    }
    this.opts.logger?.info(
      {
        accountId,
        organizationId: result.reading.organizationId,
        blocked: result.reading.blocked,
        session: result.reading.windows.session?.utilization,
        // Logged as an ISO string, not the bare ms-epoch number: the whole
        // point is to be able to eyeball "is this instant even plausible"
        // straight out of the log, which a 13-digit number defeats.
        sessionResetsAt: isoOrUndefined(result.reading.windows.session?.resetsAt),
        week: result.reading.windows.week?.utilization,
        weekResetsAt: isoOrUndefined(result.reading.windows.week?.resetsAt),
        overage: result.reading.windows.overage?.status,
      },
      'usage probe',
    );
    this.opts.onChange();
    // LAST: acting on a reading can start turns, and a turn resolves the
    // account store — which the organisation backfill above may have just
    // corrected. Telling the host what the reading said before that lands would
    // fail a turn over to an account already known to share the spent pool.
    this.opts.onReading?.(accountId, result.reading);
  }

  /** Begin the unprompted refresh loop. Unref'd — it must not hold the process open. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.refreshAll(), USAGE_POLL_INTERVAL_MS);
    this.timer.unref?.();
    void this.refreshAll();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
