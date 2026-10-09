// Falling over to the next Claude account when one runs out (accountFailover.ts).
//
// The behaviour under test is what happened for real: 20 job chats erroring in a
// loop on `You've hit your monthly spend limit` while a second account sat unused.

import { describe, expect, it } from 'vitest';
import {
  accountOrderMismatch,
  AccountRotation,
  isAccountExhausted,
  isAccountExhaustedError,
  parseLimitResetsAt,
} from '../src/accountFailover.js';

// The exact string Claude Code returned on the box.
const REAL =
  "Claude Code returned an error result: You've hit your monthly spend limit · " +
  'raise it at claude.ai/settings/usage?from=cc_cli_limit_message · ' +
  'your weekly limit resets 8pm (UTC)';

// The same string as the Mac actually logged on 6 Oct 2026 — same shape, but
// the reset stated in the account holder's own zone, which is what Claude Code
// does now and what nothing could read.
const LONDON_REAL =
  "Claude Code returned an error result: You've hit your monthly spend limit · " +
  'raise it at claude.ai/settings/usage?from=cc_cli_limit_message · ' +
  'your weekly limit resets 9pm (Europe/London)';

// The same decision, taken from what the provider actually sent rather than
// from its wording. `quotaLimits.status: 'rejected'` says the account is blocked
// now; a 529 overload carries no quota block at all, which is the distinction
// that decides whether another account would help.
describe('isAccountExhausted (structured)', () => {
  it('believes a rejected quota over anything in the text', () => {
    expect(isAccountExhausted({ kind: 'rate_limit', status: 'rejected' }, 'anything')).toBe(true);
  });

  it('treats a billing error as the account being done', () => {
    expect(isAccountExhausted({ kind: 'billing_error' }, '')).toBe(true);
  });

  it('takes "allowed" as an answer and does not go fishing in the prose', () => {
    // The text can say "rate limit" while the structured block says this
    // account is fine — a transient burst. Switching accounts there is churn.
    expect(isAccountExhausted({ status: 'allowed' }, 'rate limit: spend limit')).toBe(false);
    expect(isAccountExhausted({ status: 'allowed_warning' }, 'usage limit')).toBe(false);
  });

  it('falls back to the text when nothing structured came through', () => {
    // A 529 overload sends no quota block; so does any provider that has not
    // been taught to.
    expect(isAccountExhausted(undefined, "You've hit your monthly spend limit")).toBe(true);
    expect(isAccountExhausted(undefined, 'overloaded_error: server busy')).toBe(false);
    expect(isAccountExhausted({ kind: 'rate_limit' }, "You've hit your monthly spend limit")).toBe(
      true,
    );
  });
});

describe('isAccountExhaustedError', () => {
  it('matches the message that actually stopped every chat', () => {
    expect(isAccountExhaustedError(REAL)).toBe(true);
  });

  it('matches the other ways a limit is worded', () => {
    for (const m of [
      "You've hit your limit · resets 5pm (UTC)",
      'usage_limit_exceeded',
      'Weekly limit reached',
      'account is out of credit',
    ]) {
      expect(isAccountExhaustedError(m), m).toBe(true);
    }
  });

  it('does NOT match a transient overload or burst — same account, just wait', () => {
    // Switching account on a 529 would be pointless churn: it clears in seconds
    // on the account you are already on.
    for (const m of [
      'API Error: 529 overloaded_error',
      'rate_limit_error: too many requests',
      'Error: socket hang up',
      'authentication_error: OAuth access token is invalid',
    ]) {
      expect(isAccountExhaustedError(m), m).toBe(false);
    }
  });
});

describe('parseLimitResetsAt', () => {
  const noon = Date.UTC(2026, 8, 1, 12, 0, 0);

  it('reads `resets 8pm (UTC)` as 20:00 the same day', () => {
    expect(parseLimitResetsAt(REAL, noon)).toBe(Date.UTC(2026, 8, 1, 20, 0, 0));
  });

  it('reads a 24-hour time', () => {
    expect(parseLimitResetsAt('· resets 17:44', noon)).toBe(Date.UTC(2026, 8, 1, 17, 44, 0));
  });

  it('rolls to tomorrow when the stated hour has already passed, for a SESSION message', () => {
    // A 5-hour window genuinely does have a same-time-tomorrow occurrence, so
    // "resets 8pm" read at 9pm safely means next-day 8pm, not an hour ago.
    const ninePm = Date.UTC(2026, 8, 1, 21, 0, 0);
    expect(parseLimitResetsAt("You've hit your limit · resets 8pm (UTC)", ninePm)).toBe(
      Date.UTC(2026, 8, 2, 20, 0, 0),
    );
  });

  it('does NOT roll a WEEKLY message to tomorrow — it does not know which of the next 6 days is meant', () => {
    // Reported as "the usage is wrong. says wed 18:25 but real claud eapp says
    // tuesday 9pm": a weekly limit's bare-hour prose carries no date, so a
    // stated hour already past today could mean tomorrow, or five days from
    // now — "tomorrow" is not a safer guess than any other day, and patch was
    // stating it as fact. NO FALLBACK: undefined, not an invented day.
    const ninePm = Date.UTC(2026, 8, 1, 21, 0, 0);
    expect(parseLimitResetsAt(REAL, ninePm)).toBeUndefined();
  });

  it('reads a WEEKLY message fine when the stated hour is still ahead today', () => {
    expect(parseLimitResetsAt(REAL, noon)).toBe(Date.UTC(2026, 8, 1, 20, 0, 0));
  });

  it('handles 12am and 12pm without flipping them', () => {
    expect(parseLimitResetsAt('resets 12am (UTC)', noon)).toBe(Date.UTC(2026, 8, 2, 0, 0, 0));
    expect(parseLimitResetsAt('resets 12pm (UTC)', Date.UTC(2026, 8, 1, 6, 0, 0))).toBe(
      Date.UTC(2026, 8, 1, 12, 0, 0),
    );
  });

  it('reads an exact instant, which needs no interpreting at all', () => {
    // Patch's own account of a stated limit writes one, and that sentence is
    // what a chat's stored lastError holds.
    expect(
      parseLimitResetsAt('Usage limit reached. It resets at 2026-09-15T04:00:00Z.', noon),
    ).toBe(Date.UTC(2026, 8, 15, 4, 0, 0));
    // Past instants are returned as stated: unlike a bare hour, an instant
    // cannot mean "tomorrow", and pretending otherwise invents a reset.
    expect(parseLimitResetsAt('resets at 2026-08-01T04:00:00Z', noon)).toBe(
      Date.UTC(2026, 7, 1, 4, 0, 0),
    );
  });

  it('returns undefined rather than guessing when it states no time, or a zone we cannot read', () => {
    expect(parseLimitResetsAt("You've hit your monthly spend limit", noon)).toBeUndefined();
    // An ABBREVIATION, refused on purpose. ICU resolves this one by legacy
    // alias, but `IST` names three zones and `CST` two, and the string does not
    // say which — so none of them is read. See `resolvableZone`.
    expect(parseLimitResetsAt('resets 8pm (PST)', noon)).toBeUndefined();
    expect(parseLimitResetsAt('resets 25:00', noon)).toBeUndefined();
    // A bare hour with no zone at all is not read as UTC by the am/pm wording:
    // guessing the zone has a whole-day blast radius.
    expect(parseLimitResetsAt('resets 8pm', noon)).toBeUndefined();
  });

  // THE WORDING THAT COST THIRTEEN HOURS (chat 01M3Y2GYHVQB6N1N3MV6WH6P32,
  // 6 Oct 2026). Claude Code states the reset in the ACCOUNT HOLDER'S zone, not
  // in UTC. Unread, the account was sidelined with no reset instant, so
  // `creditResume.arm()` had nothing to arm for and the turn fell through to a
  // 60-second guess that re-ran it 48 times against a host with no credit.
  describe('a reset stated in a named IANA zone', () => {
    it('reads `resets 9pm (Europe/London)` as 21:00 London time', () => {
      // 1 Sep is BST, so London 21:00 is 20:00Z — the hour UTC-only parsing
      // would have put an hour late had it read it at all.
      expect(parseLimitResetsAt(LONDON_REAL, noon)).toBe(Date.UTC(2026, 8, 1, 20, 0, 0));
    });

    it('reads a zone that is BEHIND UTC, where the reset lands on the next UTC day', () => {
      expect(parseLimitResetsAt('resets 8pm (America/New_York)', noon)).toBe(
        Date.UTC(2026, 8, 2, 0, 0, 0),
      );
    });

    it('reads a 24-hour time with a named zone', () => {
      expect(parseLimitResetsAt('resets 21:30 (Europe/London)', noon)).toBe(
        Date.UTC(2026, 8, 1, 20, 30, 0),
      );
    });

    it('uses the offset in force at the RESET, not at `now`, across a DST change', () => {
      // 25 Oct 2026 02:00 BST is when London goes back to GMT. Asked at
      // 00:30 BST (23:30Z the day before) for a 23:00 reset, the answer is
      // 23:00 GMT = 23:00Z — an hour later than `now`'s offset would give.
      const justAfterMidnightBst = Date.UTC(2026, 9, 24, 23, 30, 0);
      expect(parseLimitResetsAt('resets 23:00 (Europe/London)', justAfterMidnightBst)).toBe(
        Date.UTC(2026, 9, 25, 23, 0, 0),
      );
    });

    it('rolls a SESSION limit to the same wall clock tomorrow, not to +24h', () => {
      // Read an hour after the stated hour, the day London loses an hour: the
      // next 2am on the holder's clock is 25 hours away, not 24.
      const threeAmBst = Date.UTC(2026, 9, 24, 2, 0, 0);
      expect(parseLimitResetsAt('session limit resets 2am (Europe/London)', threeAmBst)).toBe(
        Date.UTC(2026, 9, 25, 2, 0, 0),
      );
    });

    it('still refuses to invent a day for a WEEKLY limit whose stated hour has passed', () => {
      const tenPmLondon = Date.UTC(2026, 8, 1, 21, 0, 0);
      expect(parseLimitResetsAt(LONDON_REAL, tenPmLondon)).toBeUndefined();
    });
  });
});

describe('AccountRotation — the sequence, in order', () => {
  const accounts = [
    { id: 'a1', connected: true },
    { id: 'a2', connected: true },
    { id: 'a3', connected: true },
  ];

  it('takes the first key in the list while it has credit', () => {
    expect(new AccountRotation().usableAccount(accounts)).toBe('a1');
  });

  it('moves to the NEXT key down the list when the first runs out', () => {
    const r = new AccountRotation();
    r.markExhausted('a1', 'spend limit');
    expect(r.usableAccount(accounts)).toBe('a2');
  });

  it('keeps going down the list as each one runs out', () => {
    const r = new AccountRotation();
    r.markExhausted('a1', 'spend limit');
    r.markExhausted('a2', 'spend limit');
    expect(r.usableAccount(accounts)).toBe('a3');
  });

  it('returns undefined when everything is spent — wait, do not churn', () => {
    const r = new AccountRotation();
    for (const a of accounts) r.markExhausted(a.id, 'spend limit');
    expect(r.usableAccount(accounts)).toBeUndefined();
  });

  it('lists EVERY key with credit, in order, for a call that walks them itself', () => {
    // `usableAccount` answers "where does this call start". A one-shot AI call
    // — a title, a status summary, the model catalogue — has no next turn to be
    // re-routed on, so it needs the whole remaining sequence up front and walks
    // it when the provider refuses one mid-call.
    const r = new AccountRotation();
    expect(r.usableAccounts(accounts)).toEqual(['a1', 'a2', 'a3']);
    r.markExhausted('a2', 'spend limit');
    expect(r.usableAccounts(accounts)).toEqual(['a1', 'a3']);
  });

  it('lists nothing when every key is spent, so a caller can stop rather than churn', () => {
    const r = new AccountRotation();
    for (const a of accounts) r.markExhausted(a.id, 'spend limit');
    expect(r.usableAccounts(accounts)).toEqual([]);
  });

  it('omits a disconnected slot from the walk, same as it does from the start', () => {
    const r = new AccountRotation();
    expect(
      r.usableAccounts([
        { id: 'a1', connected: false },
        { id: 'a2', connected: true },
        { id: 'a3', connected: true },
      ]),
    ).toEqual(['a2', 'a3']);
  });

  it('re-includes a spent key once its stated reset has passed', () => {
    let now = 1_000;
    const r = new AccountRotation(() => now);
    r.markExhausted('a1', 'spend limit', 5_000);
    expect(r.usableAccounts(accounts)).toEqual(['a2', 'a3']);
    now = 5_000;
    expect(r.usableAccounts(accounts)).toEqual(['a1', 'a2', 'a3']);
  });

  it('skips a DISCONNECTED key — a listed slot with no credential', () => {
    const r = new AccountRotation();
    expect(
      r.usableAccount([
        { id: 'a1', connected: false },
        { id: 'a2', connected: true },
      ]),
    ).toBe('a2');
  });

  it('goes back to the top on its own the moment a spent key resets', () => {
    // Nothing has to remember to move anything back: the answer is recomputed
    // from the order every time, so a1 is simply first again.
    let now = 1_000;
    const r = new AccountRotation(() => now);
    r.markExhausted('a1', 'spend limit', 5_000);
    expect(r.usableAccount(accounts)).toBe('a2');
    now = 5_000;
    expect(r.usableAccount(accounts)).toBe('a1');
  });
});

describe('AccountRotation — exhaustion expires on its own', () => {
  it('becomes eligible again once the stated reset passes', () => {
    let now = 1_000;
    const r = new AccountRotation(() => now);
    r.markExhausted('a1', 'spend limit', 5_000);
    expect(r.isExhausted('a1')).toBe(true);
    now = 5_000;
    expect(r.isExhausted('a1')).toBe(false);
  });

  it('stays exhausted indefinitely when no reset time was stated', () => {
    // Nothing to expire on, so it waits for a clear() — a top-up or a new key.
    let now = 1_000;
    const r = new AccountRotation(() => now);
    r.markExhausted('a1', 'spend limit');
    now = 10 ** 12;
    expect(r.isExhausted('a1')).toBe(true);
  });

  it('reports the soonest reset, for a caller deciding when to retry', () => {
    const r = new AccountRotation(() => 0);
    r.markExhausted('a1', 'x', 9_000);
    r.markExhausted('a2', 'x', 3_000);
    r.markExhausted('a3', 'x');
    expect(r.earliestReset()).toBe(3_000);
  });

  it('clearAll makes everything eligible — a new key changes every answer', () => {
    const r = new AccountRotation();
    r.markExhausted('a1', 'x');
    r.markExhausted('a2', 'x');
    r.clearAll();
    expect(r.isExhausted('a1')).toBe(false);
    expect(r.usableAccount([{ id: 'a1', connected: true }])).toBe('a1');
  });

  it('snapshot lists only what is still sidelined', () => {
    let now = 0;
    const r = new AccountRotation(() => now);
    r.markExhausted('a1', 'spend limit', 100);
    r.markExhausted('a2', 'spend limit', 10_000);
    now = 200;
    expect(r.snapshot().map((s) => s.accountId)).toEqual(['a2']);
  });
});

// The retry is EVENT-DRIVEN: armed at the instant the limit resets.
//
// A polling sweep was the wrong shape — the limit message states exactly when it
// resets, so that is a known instant and deserves a timer armed for it, not a
// clock waking every few minutes to ask whether anything changed. These pin the
// arithmetic the arming depends on.
describe('the reset instant is known, so it can be armed for', () => {
  it('gives a delay from now to the stated reset, not a poll interval', () => {
    const now = Date.UTC(2026, 8, 1, 12, 0, 0);
    const at = parseLimitResetsAt(
      "You've hit your monthly spend limit · your weekly limit resets 8pm (UTC)",
      now,
    );
    expect(at).toBeDefined();
    // Eight hours away — a timer, not 96 wake-ups.
    expect(at! - now).toBe(8 * 60 * 60 * 1000);
  });

  it('an exhausted account with no stated reset arms nothing', () => {
    // Nothing to wait FOR. It waits for a person adding a key instead of a poll
    // that would only be guessing.
    const r = new AccountRotation(() => 0);
    r.markExhausted('a1', 'out of credit');
    expect(r.earliestReset()).toBeUndefined();
  });

  it('earliestReset drives which reset to arm for when several are out', () => {
    const r = new AccountRotation(() => 0);
    r.markExhausted('a1', 'x', 20_000);
    r.markExhausted('a2', 'x', 8_000);
    expect(r.earliestReset()).toBe(8_000);
  });

  it('ignores a reset already in the past when choosing what to arm for', () => {
    // A past reset is not something to wait for — the account is eligible now.
    const r = new AccountRotation(() => 10_000);
    r.markExhausted('a1', 'x', 5_000);
    expect(r.earliestReset()).toBeUndefined();
    expect(r.isExhausted('a1')).toBe(false);
  });
});

// Routing, not limping (accountFailover.effectiveAccount).
//
// The first design made every chat discover a spent account by FAILING on it,
// then re-pinned that chat to the second account. Two things wrong with it:
// every chat paid a failed turn, and the re-pin stranded them on the second
// account's credit even after the first one came back.
//
// Exhaustion is a property of the ACCOUNT. So one turn teaches us, and every
// turn after that resolves straight to an account with credit — and back again,
// on its own, the moment the reset passes.
describe('effectiveAccount — one failure teaches, nothing else limps', () => {
  const accounts = [
    { id: 'a1', connected: true },
    { id: 'a2', connected: true },
  ];

  it('runs on the first key while it has credit', () => {
    expect(new AccountRotation().effectiveAccount(accounts)).toBe('a1');
  });

  it('routes every later turn to the second key once the first is known spent', () => {
    const r = new AccountRotation();
    r.markExhausted('a1', 'spend limit');
    // No chat asks for anything and none can: the sequence is the host's, so
    // ONE turn's failure is enough for every other turn to route around it.
    expect(r.effectiveAccount(accounts)).toBe('a2');
    expect(r.effectiveAccount(accounts)).toBe('a2');
  });

  it('goes BACK to the first key by itself when its reset passes', () => {
    let now = 1_000;
    const r = new AccountRotation(() => now);
    r.markExhausted('a1', 'spend limit', 5_000);
    expect(r.effectiveAccount(accounts)).toBe('a2');
    now = 5_000;
    expect(r.effectiveAccount(accounts)).toBe('a1');
  });

  it('skips a disconnected key entirely', () => {
    const r = new AccountRotation();
    r.markExhausted('a1', 'spend limit');
    expect(r.effectiveAccount([accounts[0]!, { id: 'a2', connected: false }])).toBe('a1');
  });

  it('names a key even when NOTHING has credit, so the turn fails honestly', () => {
    // Not undefined: the turn must be attempted and fail with the provider's own
    // message. Silently running on no account, or pretending one is fine, is how
    // a spend limit became a fake success in the first place. Asking whether any
    // key HAS credit is `usableAccount`, and that one does answer no.
    const r = new AccountRotation();
    r.markExhausted('a1', 'x');
    r.markExhausted('a2', 'x');
    expect(r.effectiveAccount(accounts)).toBe('a1');
    expect(r.usableAccount(accounts)).toBeUndefined();
  });
});

describe('what a resume needs to know about a sidelined account', () => {
  it('clear() says whether anything was actually waiting on that account', () => {
    // A caller that resumes work on the strength of a clear has to be able to
    // tell "this account has come back" from "nobody was waiting on it" — the
    // usage probe reads every account every ten minutes, and announcing a
    // credit return for each healthy one would re-send every parked turn on a
    // perfectly happy host.
    const r = new AccountRotation();
    r.markExhausted('a1', 'spend limit');
    expect(r.clear('a1')).toBe(true);
    expect(r.clear('a1')).toBe(false);
    expect(r.clear('never-seen')).toBe(false);
  });

  it('remembers WHEN an account was recorded as spent, without expiring it', () => {
    // A probe and a refused turn can disagree — an account with extra usage
    // switched off reads as spendable while Claude Code refuses it — and the
    // turn wins. How old the refusal is is what lets a later, independent
    // reading be believed without the probe fired by the failure itself
    // un-parking the turn that just failed.
    let now = 1_000;
    const r = new AccountRotation(() => now);
    expect(r.markedAt('a1')).toBeUndefined();
    r.markExhausted('a1', 'spend limit', 5_000);
    expect(r.markedAt('a1')).toBe(1_000);
    // Still readable once the stated reset has passed: that is exactly the
    // moment a caller is deciding whether to resume.
    now = 9_000;
    expect(r.markedAt('a1')).toBe(1_000);
  });
});

describe('accountOrderMismatch — a reorder must name each held account exactly once', () => {
  const held = ['a', 'b', 'c'];

  it('accepts any permutation of exactly the held accounts', () => {
    expect(accountOrderMismatch(held, ['c', 'a', 'b'])).toBeUndefined();
    expect(accountOrderMismatch(held, held)).toBeUndefined();
  });

  it('names what is wrong: unknown, left out, repeated', () => {
    expect(accountOrderMismatch(held, ['a', 'b', 'c', 'x'])).toContain('not held on this host: x');
    expect(accountOrderMismatch(held, ['a', 'b'])).toContain('left out: c');
    const repeated = accountOrderMismatch(held, ['a', 'a', 'b', 'c']);
    expect(repeated).toContain('named more than once: a');
    expect(repeated).toContain('holds: a, b, c');
    expect(accountOrderMismatch([], ['a'])).toContain('holds: none');
  });

  it('the order a reorder writes is the order failover walks', () => {
    const rotation = new AccountRotation(() => 0);
    const accounts = (ids: string[]) => ids.map((id) => ({ id, connected: true }));
    expect(rotation.effectiveAccount(accounts(['a', 'b']))).toBe('a');
    expect(rotation.effectiveAccount(accounts(['b', 'a']))).toBe('b');
    rotation.markExhausted('b', 'spent');
    expect(rotation.effectiveAccount(accounts(['b', 'a']))).toBe('a');
  });
});

describe('AccountRotation — strategies (spec/10 § Backend credentials — account strategy)', () => {
  const A = { id: 'a', connected: true };
  const B = { id: 'b', connected: true };
  const C = { id: 'c', connected: true };
  const ids = (xs: { id: string }[]): string[] => xs.map((x) => x.id);

  it('priority keeps the stored order and runs on the first key with credit', () => {
    const r = new AccountRotation();
    expect(ids(r.order([A, B, C], { strategy: 'priority' }))).toEqual(['a', 'b', 'c']);
    r.markExhausted('a', 'spent');
    expect(r.startTurn([A, B, C], { strategy: 'priority' })).toBe('b');
    expect(r.startTurn([A, B, C], { strategy: 'priority' })).toBe('b');
  });

  it('round-robin starts each turn on the key after the last one', () => {
    const r = new AccountRotation();
    const route = { strategy: 'round-robin' as const };
    expect([1, 2, 3, 4].map(() => r.startTurn([A, B, C], route))).toEqual(['a', 'b', 'c', 'a']);
  });

  it('round-robin steps over a spent key rather than stalling', () => {
    const r = new AccountRotation();
    const route = { strategy: 'round-robin' as const };
    r.markExhausted('b', 'spent');
    expect([1, 2, 3].map(() => r.startTurn([A, B, C], route))).toEqual(['a', 'c', 'a']);
  });

  it('asking where a turn would start does not move the rotation', () => {
    const r = new AccountRotation();
    const route = { strategy: 'round-robin' as const };
    r.startTurn([A, B, C], route);
    expect(r.usableAccount([A, B, C], route)).toBe('b');
    expect(r.effectiveAccount([A, B, C], route)).toBe('b');
    expect(r.startTurn([A, B, C], route)).toBe('b');
  });

  it('soonest-reset prefers the key whose weekly window resets first; unread keys last', () => {
    const resets: Record<string, number | undefined> = { a: 3_000, b: 1_000, c: undefined };
    const r = new AccountRotation();
    expect(
      ids(r.order([A, B, C], { strategy: 'soonest-reset', weekResetsAt: (id) => resets[id] })),
    ).toEqual(['b', 'a', 'c']);
  });

  it('least-used prefers the key with the lowest usage; unread keys last', () => {
    const used: Record<string, number | undefined> = { a: 0.9, b: undefined, c: 0.2 };
    const r = new AccountRotation();
    expect(
      ids(r.order([A, B, C], { strategy: 'least-used', utilization: (id) => used[id] })),
    ).toEqual(['c', 'a', 'b']);
  });

  it('a preferred account goes first, the rest keep the strategy’s order, and it is walked past when spent', () => {
    const r = new AccountRotation();
    expect(ids(r.order([A, B, C], { strategy: 'priority', preferred: 'c' }))).toEqual([
      'c',
      'a',
      'b',
    ]);
    r.markExhausted('c', 'spent');
    expect(r.startTurn([A, B, C], { strategy: 'priority', preferred: 'c' })).toBe('a');
  });

  it('a chat with a preferred account does not move the round-robin', () => {
    const r = new AccountRotation();
    r.startTurn([A, B, C], { strategy: 'round-robin', preferred: 'c' });
    expect(r.startTurn([A, B, C], { strategy: 'round-robin' })).toBe('a');
  });

  it('a preference for a key the store no longer holds is ignored rather than running on nothing', () => {
    const r = new AccountRotation();
    expect(r.startTurn([A, B], { strategy: 'priority', preferred: 'gone' })).toBe('a');
  });

  it('says when a spent key comes back, if the limit said', () => {
    const now = 1_000;
    const r = new AccountRotation(() => now);
    r.markExhausted('a', 'spent', 5_000);
    r.markExhausted('b', 'spent');
    expect(r.exhaustedUntil('a')).toBe(5_000);
    expect(r.exhaustedUntil('b')).toBeUndefined();
    expect(r.exhaustedUntil('c')).toBeUndefined();
  });
});
