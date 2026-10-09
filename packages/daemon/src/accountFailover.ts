// Falling over to the next Claude account when one runs out of credit
// (spec/10-auth.md § Backend credentials — multiple accounts).
//
// A host can hold several accounts. Until now they were only a manual choice:
// a chat pinned one at spawn and stayed on it, so an account hitting its spend
// limit stopped every chat on it dead — 20 job chats erroring in a loop with
// `You've hit your monthly spend limit`, while a second account with credit sat
// unused. The point of holding two accounts is that the second one gets used.
//
// The rules this encodes:
//
//   THE STRATEGY DECIDES THE ORDER; CREDIT DECIDES THE KEY. The host's strategy
//   (and a chat's preferred account, if it has one) puts the keys in an order
//   for this turn, and the turn runs on the first in that order that is
//   connected and not known-exhausted. `priority` is the stored order, first to
//   last. A spent key is skipped whatever the strategy said — a strategy is a
//   preference about which credit to spend, never a reason to fail a turn.
//
//   EXHAUSTION IS TEMPORARY AND DATED. A spend limit clears at a stated time.
//   Exhaustion is recorded with that time where the message gives one, so the
//   account becomes eligible again on its own rather than staying blacklisted
//   until someone notices.
//
//   EXHAUSTED IS NOT REFUSED. An account out of credit is a live account with a
//   valid credential; it is not a bad token, and it must not be disconnected or
//   reported as unauthenticated. Conflating the two is how a working account
//   gets thrown away.
//
// Held in memory, not persisted: a restart re-probes and re-learns within one
// turn, and a stale "exhausted" record surviving a top-up would be worse than
// the extra probe.

/**
 * Why a requested account order cannot be applied, or undefined when it can.
 *
 * Since PRIORITY IS ORDER, a reorder is the whole of "rank the accounts", and
 * it must name exactly the accounts held, each once. Anything else — an id the
 * host does not hold, one left out, one named twice — is refused whole rather
 * than half-applied, because a half-applied order is a priority nobody chose.
 */
export function accountOrderMismatch(
  held: readonly string[],
  requested: readonly string[],
): string | undefined {
  const problems: string[] = [];
  const unknown = requested.filter((id) => !held.includes(id));
  const missing = held.filter((id) => !requested.includes(id));
  const repeated = [...new Set(requested.filter((id, i) => requested.indexOf(id) !== i))];
  if (unknown.length) problems.push(`not held on this host: ${unknown.join(', ')}`);
  if (missing.length) problems.push(`left out: ${missing.join(', ')}`);
  if (repeated.length) problems.push(`named more than once: ${repeated.join(', ')}`);
  if (problems.length === 0) return undefined;
  return `the order must name each held account exactly once (holds: ${held.join(', ') || 'none'}) — ${problems.join('; ')}`;
}

/**
 * Does this error mean THIS ACCOUNT has no credit left — as opposed to the API
 * being briefly busy?
 *
 * Matched on message text because the SDK exposes no typed class. The
 * distinction from `isRateLimitError` matters: a 529 overload or a 429 burst
 * clears in seconds on the SAME account and switching would be pointless churn,
 * whereas a spend/usage limit is a property of the account and clears only when
 * it resets. Only the latter is worth another account.
 */
/**
 * Is THIS account blocked right now, from what the provider actually said?
 *
 * Structure first. Claude Code states the limit on the failing message —
 * `quotaLimits.status: 'rejected'` means blocked now, and `error: 'rate_limit'`
 * / `'billing_error'` name the kind — so the decision to try another account
 * does not have to be taken by substring. It matters which way round these are:
 * an account limit is a property of the ACCOUNT and clears only on its reset,
 * so another account helps; a 529 overload or a 429 burst clears in seconds on
 * the same account, and switching is pointless churn. A 529 carries no
 * `quotaLimits` at all, which is exactly the distinction being drawn.
 *
 * `message` stays as the fallback — for a provider that sends no structured
 * block, and for the two callers that only ever have a stored error string.
 */
export function isAccountExhausted(
  limit: { kind?: string; status?: string } | undefined,
  message: string,
): boolean {
  if (limit !== undefined) {
    if (limit.kind === 'billing_error') return true;
    if (limit.status === 'rejected') return true;
    // A structured block that says the account is fine is an answer, not a
    // gap — do not go fishing in the prose behind it.
    if (limit.status !== undefined) return false;
  }
  return isAccountExhaustedError(message);
}

export function isAccountExhaustedError(message: string): boolean {
  const msg = message.toLowerCase();
  return (
    msg.includes('spend limit') ||
    msg.includes('usage_limit_exceeded') ||
    msg.includes('usage limit') ||
    msg.includes('hit your limit') ||
    msg.includes('weekly limit') ||
    msg.includes('monthly limit') ||
    msg.includes('out of credit') ||
    msg.includes('insufficient credit')
  );
}

/**
 * The wall-clock fields an instant has in a named zone, or undefined for a zone
 * this runtime cannot resolve.
 *
 * `hourCycle: 'h23'` rather than `hour12: false`, which renders midnight as
 * hour 24 on some ICU builds and would put a reset a whole day out.
 */
function wallClockIn(
  zone: string,
  at: number,
):
  | { year: number; month: number; day: number; hour: number; minute: number; second: number }
  | undefined {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(at));
  } catch {
    // `Intl` throws on a zone it does not know. That is the "we cannot resolve
    // this" answer, and it is an answer, not a failure to handle.
    return undefined;
  }
  const field = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  const wall = {
    year: field('year'),
    month: field('month'),
    day: field('day'),
    hour: field('hour'),
    minute: field('minute'),
    second: field('second'),
  };
  return Object.values(wall).some((v) => !Number.isFinite(v)) ? undefined : wall;
}

/** `zone`'s offset from UTC at `at`, in ms — positive east of Greenwich. */
function zoneOffsetMs(zone: string, at: number): number | undefined {
  const wall = wallClockIn(zone, at);
  if (wall === undefined) return undefined;
  // The zone's wall clock READ AS IF IT WERE UTC is the instant shifted by
  // exactly the offset, so the difference between them IS the offset. Measured
  // against the instant floored to the second, because a formatted wall clock
  // carries no milliseconds.
  return (
    Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) -
    Math.floor(at / 1000) * 1000
  );
}

/**
 * The zone a limit message's parenthetical names, or undefined when it is not
 * a name worth trusting.
 *
 * Only an IANA `Area/Location` name, or a bare `UTC`/`GMT`. An ABBREVIATION is
 * refused even though `Intl` will happily take some of them: ICU carries legacy
 * aliases, so `PST` resolves (to America/Los_Angeles) while the equally common
 * `IST` names three different zones and `CST` two, and nothing in the string
 * says which. The point of this whole path is that a wrong instant is worse
 * than no instant — it either retries while still blocked or sits out a reset
 * that already happened — and an abbreviation we resolve by luck is exactly
 * that risk taken silently.
 *
 * Claude Code states the holder's own zone, which comes from
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` and is therefore always a
 * canonical `Area/Location` (or `UTC`). So this costs nothing real.
 */
function resolvableZone(raw: string): string | undefined {
  if (/^(utc|gmt)$/i.test(raw)) return raw.toUpperCase();
  return raw.includes('/') ? raw : undefined;
}

/**
 * The instant at which `zone`'s wall clock reads `hour:minute` on the day `now`
 * falls on there, plus `dayOffset` days.
 */
function zonedHourToEpoch(
  zone: string,
  now: number,
  hour: number,
  minute: number,
  dayOffset: number,
): number | undefined {
  const wall = wallClockIn(zone, now);
  const offsetNow = zoneOffsetMs(zone, now);
  if (wall === undefined || offsetNow === undefined) return undefined;
  const asIfUtc = Date.UTC(wall.year, wall.month - 1, wall.day + dayOffset, hour, minute, 0, 0);
  // Converted with the offset in force at the TARGET instant, not at `now`:
  // the two differ across a DST change, and an hour out is the difference
  // between retrying while still blocked and sitting out a reset that has
  // already happened. One correction pass is enough — the offset at the first
  // estimate is the offset within an hour of the answer.
  const offsetThen = zoneOffsetMs(zone, asIfUtc - offsetNow);
  return offsetThen === undefined ? undefined : asIfUtc - offsetThen;
}

/**
 * The reset time a limit message states, as epoch ms — or undefined when it
 * states none.
 *
 * Claude Code writes these as a wall-clock hour in a named zone:
 *   "· your weekly limit resets 8pm (UTC)"
 *   "· your weekly limit resets 9pm (Europe/London)"
 *   "· resets 17:44"
 * ANY zone this runtime can resolve is interpreted, which means every IANA name
 * — Claude Code states the hour in the ACCOUNT HOLDER'S zone, not in UTC, and
 * for a long time only the `(UTC)` wording was read. The cost of that was not a
 * missing countdown: with no reset instant the account was sidelined with
 * nothing to arm for, and the turn fell through to a 60-second guess that
 * re-ran it against a spent host 48 times in an hour (chat
 * 01M3Y2GYHVQB6N1N3MV6WH6P32, 6 Oct 2026, "resets 9pm (Europe/London)").
 *
 * A zone we cannot resolve — `(PST)`, a typo, a parenthetical that is not a
 * zone at all — still returns undefined rather than a guess: being wrong here
 * means either retrying while still blocked, or sitting out a reset that
 * already happened.
 *
 * An exact instant is also read, because patch's own account of a stated limit
 * writes one ("It resets at 2026-09-15T04:00:00Z") and that sentence is what a
 * chat's stored `lastError` holds — the thing this is asked to parse after a
 * restart. An instant needs no interpretation at all, so it is tried first.
 *
 * A bare hour with no date is read as "today, or tomorrow if that has passed"
 * — safe for the 5-hour SESSION window, which genuinely has a same-time-
 * tomorrow occurrence. It is NOT safe for the 7-day WEEK window: a stated hour
 * that has already passed today could be tomorrow, or five days from now, and
 * "tomorrow" is not a better guess than any other day in between. Reported as
 * "the usage is wrong: says Wed 18:25 but the real app says Tuesday 9pm" —
 * patch had rolled a weekly reset forward by one invented day. So a WEEKLY
 * message (the word appears in every wording Claude Code uses for this
 * window) returns undefined once the stated hour is behind `now`, rather than
 * naming a day nothing said.
 */
export function parseLimitResetsAt(message: string, now: number): number | undefined {
  const isWeekly = /weekly/i.test(message);
  const iso = /resets\s+(?:at\s+)?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z)/i.exec(
    message,
  );
  if (iso) {
    const ts = Date.parse(iso[1]!);
    return Number.isNaN(ts) ? undefined : ts;
  }
  // `resets 8pm (UTC)` / `resets 8:30pm (Europe/London)`. The parenthetical is
  // REQUIRED here: a bare `resets 8pm` names no zone, and reading it as UTC
  // would be a guess with a whole-day blast radius.
  const ampm = /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(\s*([A-Za-z][\w+/-]*)\s*\)/i.exec(
    message,
  );
  // `resets 17:44 (Europe/London)` or a bare `resets 17:44`, which stays UTC —
  // the reading it has always had, and the one patch's own stored wording uses.
  const h24 = /resets\s+(\d{1,2}):(\d{2})(?:\s*\(\s*([A-Za-z][\w+/-]*)\s*\))?/i.exec(message);

  let hour: number;
  let minute: number;
  let zone: string | undefined;
  if (ampm) {
    const raw = Number(ampm[1]);
    if (raw < 1 || raw > 12) return undefined;
    minute = ampm[2] === undefined ? 0 : Number(ampm[2]);
    const pm = ampm[3]!.toLowerCase() === 'pm';
    hour = raw === 12 ? (pm ? 12 : 0) : pm ? raw + 12 : raw;
    zone = resolvableZone(ampm[4]!);
  } else if (h24) {
    hour = Number(h24[1]);
    minute = Number(h24[2]);
    if (hour > 23) return undefined;
    zone = h24[3] === undefined ? 'UTC' : resolvableZone(h24[3]);
  } else {
    return undefined;
  }
  if (minute > 59 || zone === undefined) return undefined;

  const ts = zonedHourToEpoch(zone, now, hour, minute, 0);
  // A zone nothing can resolve. Undefined, so the caller sidelines the account
  // with no reset rather than with a wrong one — and `creditResume.ts`'s
  // observation path, not a clock, is what brings it back.
  if (ts === undefined) return undefined;
  if (ts > now) return ts;
  // The stated hour has already passed today. For a session window that
  // safely means tomorrow — "resets 8pm" read at 9pm is next-day 8pm, not an
  // instant sixty minutes ago. For a weekly window there is no safe "next
  // occurrence" to name: the message gave no date, and the true reset is
  // anywhere in the next six days, so inventing tomorrow is not a guess worth
  // making (NO FALLBACK: wrong is worse than absent).
  //
  // Tomorrow is the next CALENDAR day at the same wall clock, not `ts` plus 24
  // hours: across a DST change in the stated zone those are different instants,
  // and the one the account holder's clock agrees with is this one.
  return isWeekly ? undefined : zonedHourToEpoch(zone, now, hour, minute, 1);
}

import type { AccountStrategy } from '@patch/wire';

/** One account as failover sees it: its id, and whether it has a credential at all. */
export interface FailoverAccount {
  id: string;
  connected: boolean;
  /**
   * Which Anthropic organisation the account's token authenticates as.
   *
   * TWO ACCOUNTS SHARING AN ORGANISATION SHARE A POOL. They have one 5-hour
   * window, one weekly window and one overage pool between them, so the second
   * is not somewhere to fail over to — it is the same account under a second
   * label. This host held exactly that, as "Default" and "work", and the
   * rotation dutifully walked from one to the other, asked the same spent
   * account again, and logged "every account is out of credit" having tried
   * one. Undefined means not established, which is treated as "cannot rule out
   * a difference" — the account stays eligible.
   */
  organizationId?: string;
}

interface Exhaustion {
  /** When it becomes eligible again. Undefined = until something clears it. */
  until: number | undefined;
  reason: string;
  /**
   * When this was recorded.
   *
   * Kept because a usage probe and a refused turn can disagree, and the turn
   * wins: an account whose overage window is rejected for ever reads as
   * "has credit" to the probe while Claude Code refuses it as a spend limit.
   * Knowing HOW OLD the refusal is is what lets a later, independent reading
   * be believed as credit returning without the reading taken seconds after
   * the failure un-parking the very turn that just failed.
   */
  at: number;
}

/**
 * What orders the keys for one question (spec/10 § Backend credentials —
 * account strategy). Everything absent is `priority` with no preference, which
 * is what the host did before strategies existed.
 */
export interface RouteOptions {
  strategy?: AccountStrategy;
  /**
   * The key the chat asked to start on. Put first; the rest follow in the
   * strategy's order. A preference, not a pin — a spent preferred key is walked
   * past exactly like any other. An id the store no longer holds is ignored
   * here: the chat keeps running on the host's keys rather than on nothing.
   */
  preferred?: string;
  /**
   * When each key's WEEKLY window resets, for `soonest-reset`. The week is the
   * window whose leftover allowance is actually lost at the reset — the 5-hour
   * session comes round again before anyone would notice. Undefined for a key
   * with no reading, which sorts after every key that has one.
   */
  weekResetsAt?: (accountId: string) => number | undefined;
  /**
   * How much of each key is used, 0–1, for `least-used`: the higher of its
   * session and weekly utilisation, so a key close to either limit is avoided.
   * Undefined for a key with no reading, which sorts after every key that has one.
   */
  utilization?: (accountId: string) => number | undefined;
}

/**
 * Which accounts are currently out of credit, and which key a turn runs on.
 */
export class AccountRotation {
  private readonly exhausted = new Map<string, Exhaustion>();
  /**
   * The key the last round-robin turn STARTED on. The next one starts on the
   * key after it. In memory like everything else here: after a restart the
   * rotation simply begins again at the top, which costs nothing.
   */
  private lastRoundRobinStart: string | undefined;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Record that an account has no credit, and when it comes back if known. */
  markExhausted(accountId: string, reason: string, until?: number): void {
    this.exhausted.set(accountId, { until, reason, at: this.now() });
  }

  /**
   * Record that an account has no credit, AND that every account sharing its
   * organisation has none either.
   *
   * Not an optimisation — a correction. The siblings do not have their own
   * credit to try; they are the same account. Marking them here is what turns
   * "walk forward and fail again on the same pool" into "there is nowhere to
   * go, wait for the reset", which is a different and honest outcome.
   *
   * Returns the ids marked, so the caller can say in the log that a failure on
   * one account sidelined another.
   */
  markExhaustedWithSiblings(
    accounts: readonly FailoverAccount[],
    accountId: string,
    reason: string,
    until?: number,
  ): string[] {
    this.markExhausted(accountId, reason, until);
    const org = accounts.find((a) => a.id === accountId)?.organizationId;
    const marked = [accountId];
    if (org === undefined) return marked;
    for (const sibling of accounts) {
      if (sibling.id === accountId || sibling.organizationId !== org) continue;
      this.markExhausted(
        sibling.id,
        `shares a Claude account with the key that ran out: ${reason}`,
        until,
      );
      marked.push(sibling.id);
    }
    return marked;
  }

  /**
   * An account is usable again — its limit reset, or it was topped up.
   *
   * Returns whether it HAD been recorded as spent, so a caller resuming work on
   * the strength of it can say a thing changed rather than announce a resume
   * for an account nobody was waiting on.
   */
  clear(accountId: string): boolean {
    return this.exhausted.delete(accountId);
  }

  /**
   * Everything is eligible again. Called when an account is ADDED: a new
   * credential is the one event that can change the answer for every OTHER
   * account too (the user has just told us the situation changed), and the cost
   * of being wrong is one refused turn that re-marks it.
   */
  clearAll(): void {
    this.exhausted.clear();
  }

  /**
   * When this account was recorded as spent, or undefined when it is not
   * recorded at all.
   *
   * Deliberately does NOT expire the record the way `isExhausted` does: the
   * caller asking this is asking "is anything waiting on this account, and
   * since when", and an entry whose stated reset has just passed is exactly
   * the one it needs to see.
   */
  markedAt(accountId: string): number | undefined {
    return this.exhausted.get(accountId)?.at;
  }

  /** When a spent account comes back, if the limit said. */
  exhaustedUntil(accountId: string): number | undefined {
    return this.isExhausted(accountId) ? this.exhausted.get(accountId)?.until : undefined;
  }

  /** Is this account known to be out of credit right now? */
  isExhausted(accountId: string): boolean {
    const e = this.exhausted.get(accountId);
    if (!e) return false;
    if (e.until !== undefined && this.now() >= e.until) {
      // Its stated reset has passed; let it prove itself rather than staying
      // blacklisted on an old reading.
      this.exhausted.delete(accountId);
      return false;
    }
    return true;
  }

  /** The soonest moment any exhausted account becomes eligible, if any says. */
  earliestReset(): number | undefined {
    const times = [...this.exhausted.values()]
      .map((e) => e.until)
      .filter((t): t is number => t !== undefined && t > this.now());
    return times.length > 0 ? Math.min(...times) : undefined;
  }

  /**
   * The account a turn should run on: the FIRST key in the route's order that
   * is connected and not known-exhausted.
   *
   * Not an "active account", which is an account-management idea and has never
   * been about turns. The sequence is the host's, and the same question
   * is asked for every turn, so a key running out is not something each chat
   * discovers by failing on it: one turn learns key 1 is spent and every turn
   * after that lands on key 2 without failing at all.
   *
   * Nothing has to move anything back, either. When key 1's limit resets it is
   * simply first again, because the answer is recomputed from the order every
   * time. A design that had MOVED the chats onto key 2 would have left them
   * there, spending the wrong key indefinitely.
   *
   * Everything exhausted hands back the first connected key rather than
   * undefined, so the turn is attempted and fails with the provider's own
   * message. Running on no account would be worse, and pretending a key is fine
   * is how a spend limit became a fake success in the first place. Asking
   * whether any key actually HAS credit is a different question, and has its
   * own method — see `usableAccount`.
   */
  effectiveAccount(
    accounts: readonly FailoverAccount[],
    route: RouteOptions = {},
  ): string | undefined {
    return (
      this.usableAccount(accounts, route) ??
      this.order(accounts, route).find((a) => a.connected)?.id
    );
  }

  /**
   * `effectiveAccount` for a turn that is actually STARTING — the one call that
   * moves the round-robin on. Everything else (failover asking where the re-run
   * will land, a one-shot, a report) peeks, so asking does not skip a key.
   *
   * A chat with a preferred account does not move it: its turn was never the
   * rotation's to hand out.
   */
  startTurn(accounts: readonly FailoverAccount[], route: RouteOptions = {}): string | undefined {
    const chosen = this.effectiveAccount(accounts, route);
    if (route.strategy === 'round-robin' && route.preferred === undefined && chosen !== undefined) {
      this.lastRoundRobinStart = chosen;
    }
    return chosen;
  }

  /**
   * Record where a round-robin turn started, for a backend that picks its key
   * itself (Codex judges credit from its own readings) but shares this order.
   */
  noteStart(accountId: string, route: RouteOptions): void {
    if (route.strategy === 'round-robin' && route.preferred === undefined) {
      this.lastRoundRobinStart = accountId;
    }
  }

  /**
   * Every stored key in the order this question should try them.
   *
   * Round-robin rotates the stored order to begin just after the key the last
   * round-robin turn started on, so consecutive turns land on consecutive keys
   * and a spent key is stepped over rather than stalling the rotation.
   * Soonest-reset sorts by weekly reset, earliest first; least-used by
   * utilisation, lowest first. Ties and unread keys keep their stored order.
   */
  order(accounts: readonly FailoverAccount[], route: RouteOptions = {}): FailoverAccount[] {
    let ordered: FailoverAccount[];
    switch (route.strategy ?? 'priority') {
      case 'priority':
        ordered = [...accounts];
        break;
      case 'round-robin': {
        const last = accounts.findIndex((a) => a.id === this.lastRoundRobinStart);
        ordered =
          last === -1
            ? [...accounts]
            : [...accounts.slice(last + 1), ...accounts.slice(0, last + 1)];
        break;
      }
      case 'soonest-reset': {
        const at = (a: FailoverAccount) => route.weekResetsAt?.(a.id) ?? Number.POSITIVE_INFINITY;
        // Array.prototype.sort is stable, so equal resets keep the stored order.
        ordered = [...accounts].sort((a, b) => at(a) - at(b));
        break;
      }
      case 'least-used': {
        const used = (a: FailoverAccount) => route.utilization?.(a.id) ?? Number.POSITIVE_INFINITY;
        ordered = [...accounts].sort((a, b) => used(a) - used(b));
        break;
      }
    }
    const preferred = ordered.find((a) => a.id === route.preferred);
    return preferred ? [preferred, ...ordered.filter((a) => a !== preferred)] : ordered;
  }

  /**
   * The first key that is connected and has credit, or undefined when NONE
   * does.
   *
   * The distinction from `effectiveAccount` is the whole of the loop that ran
   * for hours on 2026-09-07: "which key do I run on" always has an answer, and
   * "is there a key worth retrying on" must be allowed to answer no. Answering
   * the second with the first is what made a host with every key spent retry
   * for ever instead of waiting for a reset.
   */
  usableAccount(
    accounts: readonly FailoverAccount[],
    route: RouteOptions = {},
  ): string | undefined {
    return this.order(accounts, route).find((a) => a.connected && !this.isExhausted(a.id))?.id;
  }

  /**
   * EVERY key that is connected and has credit, in priority order.
   *
   * `usableAccount` answers "where does this call start"; this answers "and
   * where does it go next when the provider refuses that one mid-call". A
   * one-shot AI call has no turn machinery behind it to learn from a failure
   * and re-resolve on the next tick — it either walks the list itself or it
   * gives up on the first spent key, which is how title and status generation
   * came to be silently dead for a night while every chat around them ran fine
   * on the second account.
   */
  usableAccounts(accounts: readonly FailoverAccount[], route: RouteOptions = {}): string[] {
    return this.order(accounts, route)
      .filter((a) => a.connected && !this.isExhausted(a.id))
      .map((a) => a.id);
  }

  /** For logs and the host report: what is currently sidelined and why. */
  snapshot(): { accountId: string; until: number | undefined; reason: string }[] {
    return [...this.exhausted.entries()]
      .filter(([id]) => this.isExhausted(id))
      .map(([accountId, e]) => ({ accountId, until: e.until, reason: e.reason }));
  }
}

/**
 * Run one AI call on whichever stored account still has credit.
 *
 * Every AI call in the host goes through this — turns, titles, status
 * summaries, the model catalogue. `run` is invoked with an access token; it
 * throws to report failure, and the runner reads the provider's own message to
 * decide whether that means THIS ACCOUNT is spent (walk to the next one) or
 * something else went wrong (give up, the next account would fail identically).
 *
 * Resolves to `null` when no account could complete the call, so the caller's
 * existing "no result, leave things unchanged" path handles an exhausted host
 * without a second failure mode to write.
 */
export type RunOnAccountWithCredit = <T>(
  label: string,
  run: (accessToken: string) => Promise<T>,
) => Promise<T | null>;
