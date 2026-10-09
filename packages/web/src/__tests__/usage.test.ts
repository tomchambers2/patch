// How an account's limits read on screen.
//
// The bug these protect against is not a crash — it is a screen that is
// confidently wrong. Settings showed "Session: blocked, — · resets Wed 17:58"
// on a Friday, next to a transcript saying "your session limit resets 9:40am
// (UTC)". Same account, same moment, two times, neither labelled, one of them
// days stale.

import { describe, it, expect } from 'vitest';
import {
  EXTRA_USAGE_OFF_SENTENCE,
  EXTRA_USAGE_OFF_TEXT,
  LIMIT_NAME,
  blockingScope,
  hostOutage,
  listLabels,
  formatDurationWords,
  formatReadAt,
  formatReset,
  formatResetDetail,
  formatUntil,
  formatUtilization,
  formatTokens,
  summariseContext,
  summariseUsage,
} from '../lib/usage.js';

const AT = Date.UTC(2026, 8, 11, 9, 40); // Fri 11 Sep 2026, 09:40 UTC

describe('formatUtilization', () => {
  it('renders a fraction as a percentage', () => {
    expect(formatUtilization({ status: 'rejected', utilization: 1 })).toBe('100%');
    expect(formatUtilization({ status: 'allowed', utilization: 0.62 })).toBe('62%');
  });

  it('says — when there is no figure, rather than 0%', () => {
    expect(formatUtilization({ status: 'rejected' })).toBe('—');
    expect(formatUtilization(undefined)).toBe('—');
  });
});

describe('formatReset', () => {
  it('gives just the time when the reset is today', () => {
    expect(formatReset(AT, AT - 60_000)).not.toMatch(/Mon|Tue|Wed|Thu|Fri|Sat|Sun/);
  });

  it('names the weekday when it is not today, so a stale reading cannot pass for now', () => {
    expect(formatReset(AT + 3 * 86_400_000, AT)).toMatch(/Mon|Tue|Wed|Thu|Fri|Sat|Sun/);
  });
});

describe('formatResetDetail', () => {
  it('carries the UTC alongside the local time, both labelled', () => {
    const detail = formatResetDetail(AT);
    expect(detail).toContain('09:40 UTC');
    // And a named local zone — the half that was missing when two unlabelled
    // clocks were on screen together.
    expect(detail).toMatch(/[A-Z]{2,4}/);
  });
});

describe('formatUntil', () => {
  it('counts minutes, then hours, then days', () => {
    expect(formatUntil(AT + 28 * 60_000, AT)).toBe('in 28 min');
    expect(formatUntil(AT + 3 * 3_600_000, AT)).toBe('in 3 h');
    expect(formatUntil(AT + 5 * 86_400_000, AT)).toBe('in 5 d');
  });

  it('says now for an instant already past', () => {
    expect(formatUntil(AT - 1, AT)).toBe('now');
  });
});

describe('formatDurationWords', () => {
  // The whole reason this exists beside formatUntil: "1 h" is a unit symbol,
  // not something a person says, and it was being read by someone stuck
  // waiting. Minutes stay alongside hours because "1 hour" for anything
  // between one and two is a worse answer than the truth.
  it('spells the wait out, keeping the minutes', () => {
    expect(formatDurationWords(63 * 60_000)).toBe('1 hour 3 minutes');
    expect(formatDurationWords(125 * 60_000)).toBe('2 hours 5 minutes');
  });

  it('drops the minutes only when there are none', () => {
    expect(formatDurationWords(60 * 60_000)).toBe('1 hour');
    expect(formatDurationWords(180 * 60_000)).toBe('3 hours');
  });

  it('singular and plural are both right', () => {
    expect(formatDurationWords(2 * 60_000)).toBe('2 minutes');
    expect(formatDurationWords(61 * 60_000)).toBe('1 hour 1 minute');
  });

  it('under a minute is a wait, not "0 minutes"', () => {
    expect(formatDurationWords(30_000)).toBe('less than a minute');
  });

  it('a reset already past says so rather than counting backwards', () => {
    expect(formatDurationWords(0)).toBe('any moment now');
    expect(formatDurationWords(-5_000)).toBe('any moment now');
  });

  it('a weekly window reads in days', () => {
    expect(formatDurationWords(50 * 3_600_000)).toBe('2 days 2 hours');
    expect(formatDurationWords(48 * 3_600_000)).toBe('2 days');
  });
});

describe('LIMIT_NAME', () => {
  // The headline names a pool a person SPENDS. Overage is the overflow that
  // covers for one of these, so it is not in this map at all — naming it as
  // the limit reached produced "Extra usage limit on Default".
  it('names each pool the way someone would say it', () => {
    expect(LIMIT_NAME.session).toBe('session limit');
    expect(LIMIT_NAME.week).toBe('weekly limit');
    expect(LIMIT_NAME.unknown).toBe('usage limit');
    expect(Object.keys(LIMIT_NAME)).not.toContain('overage');
  });
});

describe('blockingScope', () => {
  it('blames the pool that ran out, never the overflow that failed to cover it', () => {
    expect(
      blockingScope({
        session: { status: 'rejected', utilization: 1 },
        overage: { status: 'rejected', disabledReason: 'org_level_disabled_until' },
      }),
    ).toBe('session');
  });

  it('a rejected overage ON ITS OWN blocks nothing — there is just no overflow', () => {
    expect(
      blockingScope({
        session: { status: 'allowed', utilization: 0.3 },
        overage: { status: 'rejected', disabledReason: 'org_level_disabled_until' },
      }),
    ).toBeUndefined();
  });

  it('is undefined when nothing is refusing', () => {
    expect(blockingScope({ session: { status: 'allowed', utilization: 0.2 } })).toBeUndefined();
  });
});

// Tom's Default account is a personal subscription. "Extra usage is switched
// off for this organisation" was both untrue of it and read as an accusation
// about an account that was perfectly healthy, so the wording is pinned: one
// sentence, no organisation, and it says outright that nothing was spent.
describe('the extra-usage-off wording', () => {
  it('never blames an organisation', () => {
    expect(EXTRA_USAGE_OFF_TEXT).not.toMatch(/organisation/i);
    expect(EXTRA_USAGE_OFF_SENTENCE).not.toMatch(/organisation/i);
  });

  it('says it is off and that nothing was overspent', () => {
    expect(EXTRA_USAGE_OFF_TEXT).toMatch(/not enabled/i);
    expect(EXTRA_USAGE_OFF_TEXT).toMatch(/nothing has been overspent/i);
  });

  it('is ONE wording — the sentence form is the same words', () => {
    expect(EXTRA_USAGE_OFF_SENTENCE.toLowerCase()).toBe(`${EXTRA_USAGE_OFF_TEXT.toLowerCase()}.`);
  });
});

describe('summariseUsage', () => {
  it('renders nothing at all when no reading exists — an empty gauge reads as zero usage', () => {
    expect(summariseUsage(undefined)).toBeNull();
    expect(summariseUsage({})).toBeNull();
  });

  it('leads with the refusal, and says when it clears', () => {
    const out = summariseUsage(
      { session: { status: 'rejected', utilization: 1, resetsAt: AT } },
      AT - 28 * 60_000,
    );
    expect(out?.level).toBe('blocked');
    expect(out?.text).toContain('5-hour limit reached');
  });

  it('says so plainly when a refusing window named no reset', () => {
    const out = summariseUsage({ week: { status: 'rejected' } }, AT);
    expect(out?.text).toContain('no reset given');
  });

  // A rejected overflow is not a stopped account. It only means that when the
  // session or the week does empty, there is nothing to spill into — which is
  // a fact for the bubble's button, not a red line in the header.
  it('a rejected overage alone does not read as blocked', () => {
    const out = summariseUsage(
      {
        session: { status: 'allowed', utilization: 0.3 },
        overage: { status: 'rejected', disabledReason: 'org_level_disabled_until' },
      },
      AT,
    );
    expect(out?.level).not.toBe('blocked');
  });

  it('otherwise reports the fullest pool — the one that will stop work first', () => {
    const out = summariseUsage(
      {
        session: { status: 'allowed', utilization: 0.2 },
        week: { status: 'allowed', utilization: 0.62 },
      },
      AT,
    );
    expect(out?.text).toBe('Weekly 62%');
    expect(out?.level).toBe('ok');
  });

  it('warns before it blocks', () => {
    expect(
      summariseUsage({ session: { status: 'allowed_warning', utilization: 0.9 } }, AT)?.level,
    ).toBe('warn');
  });

  it('puts every window in the tooltip, so the one line is never the whole story', () => {
    const out = summariseUsage(
      {
        session: { status: 'rejected', utilization: 1, resetsAt: AT },
        week: { status: 'allowed', utilization: 0.62 },
        overage: { status: 'rejected', disabledReason: 'org_level_disabled_until' },
      },
      AT,
    );
    expect(out?.title).toContain('5-hour');
    expect(out?.title).toContain('Weekly');
    expect(out?.title).toContain('Extra usage');
  });
});

describe('formatReadAt', () => {
  it('says how old the reading is — a stale figure must not pass for a live one', () => {
    expect(formatReadAt(AT - 5 * 60_000, AT)).toBe('read 5 min ago');
    expect(formatReadAt(AT - 3 * 3_600_000, AT)).toBe('read 3 h ago');
  });

  it('renders nothing when the reading has no timestamp', () => {
    expect(formatReadAt(undefined, AT)).toBeNull();
  });
});

describe('hostOutage — is there any credit left on this machine at all', () => {
  const spent = (resetsAt?: number) => ({
    session: { status: 'rejected' as const, utilization: 1, ...(resetsAt ? { resetsAt } : {}) },
  });
  const fine = { session: { status: 'allowed' as const, utilization: 0.3 } };

  it('reports every account when they are ALL spent, and names the first one back', () => {
    const out = hostOutage([
      { id: 'a', label: 'Default', connected: true, usage: spent(AT + 3 * 3_600_000) },
      { id: 'b', label: 'work', connected: true, usage: spent(AT + 49 * 60_000) },
    ]);
    expect(out?.accounts.map((a) => a.label)).toEqual(['Default', 'work']);
    // The soonest is what a person actually wants: when can I start again.
    expect(out?.soonest?.label).toBe('work');
  });

  // The three ways to be uncertain. All of them must say nothing, because a
  // banner that cries wolf is a banner nobody reads on the day it is right.
  it('says nothing while ONE account still has credit', () => {
    expect(
      hostOutage([
        { id: 'a', label: 'Default', connected: true, usage: spent(AT) },
        { id: 'b', label: 'work', connected: true, usage: fine },
      ]),
    ).toBeNull();
  });

  it('says nothing when an account has no reading yet — unknown is not spent', () => {
    expect(
      hostOutage([
        { id: 'a', label: 'Default', connected: true, usage: spent(AT) },
        { id: 'b', label: 'work', connected: true },
      ]),
    ).toBeNull();
  });

  it('says nothing when no account is connected — that is the sign-in banner', () => {
    expect(hostOutage([{ id: 'a', label: 'Default', connected: false }])).toBeNull();
    expect(hostOutage([])).toBeNull();
  });

  it('ignores a disconnected account when judging the connected ones', () => {
    const out = hostOutage([
      { id: 'a', label: 'Default', connected: true, usage: spent(AT) },
      { id: 'gone', label: 'old', connected: false },
    ]);
    expect(out?.accounts.map((a) => a.label)).toEqual(['Default']);
  });

  it('has no soonest when nothing stated a reset, rather than inventing one', () => {
    const out = hostOutage([{ id: 'a', label: 'Default', connected: true, usage: spent() }]);
    expect(out?.accounts).toHaveLength(1);
    expect(out?.soonest).toBeUndefined();
  });

  it('picks the soonest from the accounts that DID state one', () => {
    const out = hostOutage([
      { id: 'a', label: 'Default', connected: true, usage: spent() },
      { id: 'b', label: 'work', connected: true, usage: spent(AT + 60_000) },
    ]);
    expect(out?.soonest?.label).toBe('work');
  });
});

describe('listLabels', () => {
  it('reads as a list a person would say', () => {
    expect(listLabels(['work'])).toBe('work');
    expect(listLabels(['work', 'Default'])).toBe('work and Default');
    expect(listLabels(['work', 'Default', 'personal'])).toBe('work, Default and personal');
  });

  it('an empty list is empty, not "and"', () => {
    expect(listLabels([])).toBe('');
  });
});

describe('formatTokens', () => {
  it('reads at a glance', () => {
    expect(formatTokens(850)).toBe('850');
    expect(formatTokens(46_400)).toBe('46k');
    expect(formatTokens(1_000_000)).toBe('1M');
    expect(formatTokens(1_250_000)).toBe('1.3M');
  });
});

describe('summariseContext', () => {
  it('draws nothing until the tokens are measured', () => {
    expect(summariseContext(null)).toBeNull();
    expect(summariseContext(undefined)).toBeNull();
  });

  it('still shows the tokens, unfilled, while the window is unknown', () => {
    expect(summariseContext({ usedTokens: 40_000, at: AT })).toEqual({
      fraction: 0,
      percent: '?',
      tokens: '40k / ?',
      level: 'unknown',
    });
  });

  it('gives the fraction, percent and figures', () => {
    expect(summariseContext({ usedTokens: 50_000, windowTokens: 200_000, at: AT })).toEqual({
      fraction: 0.25,
      percent: '25%',
      tokens: '50k / 200k',
      level: 'ok',
    });
  });

  it('warns as the window fills', () => {
    expect(summariseContext({ usedTokens: 150_000, windowTokens: 200_000, at: AT })?.level).toBe(
      'warn',
    );
    expect(summariseContext({ usedTokens: 190_000, windowTokens: 200_000, at: AT })?.level).toBe(
      'blocked',
    );
  });
});

describe('summariseUsage fraction', () => {
  it('is the fullest pool, or full when blocked', () => {
    expect(summariseUsage({ session: { status: 'allowed', utilization: 0.3 } }, AT)?.fraction).toBe(
      0.3,
    );
    expect(summariseUsage({ week: { status: 'rejected' } }, AT)?.fraction).toBe(1);
  });
});

describe('presentFailure', () => {
  it('drops the replay prefix and restates a limit reset in the local zone', async () => {
    const { presentFailure, formatReset } = await import('../lib/usage.js');
    const at = Date.parse('2026-10-12T04:00:00Z');
    const out = presentFailure(
      'This turn failed: Usage limit reached on Work — the weekly window. It resets at 2026-10-12T04:00:00Z.',
      Date.parse('2026-10-08T12:00:00Z'),
    );
    expect(out).toBe(
      `Usage limit reached on Work — the weekly window. It resets at ${formatReset(at, Date.parse('2026-10-08T12:00:00Z'))}.`,
    );
    expect(out).not.toContain('T04:00:00Z');
  });
  it('leaves other failures in full', async () => {
    const { presentFailure } = await import('../lib/usage.js');
    expect(presentFailure('This turn failed: Codex process exited (0)')).toBe(
      'Codex process exited (0)',
    );
  });
});
