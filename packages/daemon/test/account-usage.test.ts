// Keeping a reading current on an account too spent to produce one.
//
// The whole reason this exists: the old reading was a by-product of a turn, so
// a blocked account's last reading was the one that blocked it, and it stood
// until the host restarted. Settings showed a Wednesday figure on a Friday
// and there was nothing on screen to say so.

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { AccountUsageTracker, USAGE_MIN_INTERVAL_MS } from '../src/accountUsage.js';
import type { ClaudeStoredAccount, ClaudeUsageResult } from '@patch/auth';

const silent = pino({ level: 'silent' });

const accounts: ClaudeStoredAccount[] = [
  { id: 'a', label: 'Default', credential: { accessToken: 'tok-a' } },
  { id: 'b', label: 'work', credential: { accessToken: 'tok-b' } },
  { id: 'gone', label: 'disconnected', credential: null },
];

function ok(
  overrides: Partial<{ organizationId: string; blocked: boolean }> = {},
): ClaudeUsageResult {
  return {
    kind: 'ok',
    reading: {
      organizationId: overrides.organizationId ?? 'org-1',
      windows: {
        session: { status: overrides.blocked ? 'rejected' : 'allowed', utilization: 0.5 },
        overage: { status: 'rejected', disabledReason: 'org_level_disabled_until' },
      },
      blocked: overrides.blocked ?? false,
      at: 1,
    },
  };
}

function make(opts: {
  probe: (token: string) => Promise<ClaudeUsageResult>;
  now?: () => number;
  rememberOrganization?: (accountId: string, organizationId: string) => void;
}) {
  const changes: number[] = [];
  const readings: { accountId: string; blocked: boolean }[] = [];
  const tracker = new AccountUsageTracker({
    accounts: () => accounts,
    tokenFor: async (id) => accounts.find((a) => a.id === id)?.credential?.accessToken,
    onChange: () => changes.push(1),
    onReading: (accountId, reading) => readings.push({ accountId, blocked: reading.blocked }),
    probe: opts.probe,
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.rememberOrganization ? { rememberOrganization: opts.rememberOrganization } : {}),
    logger: silent,
  });
  return { tracker, changes, readings };
}

describe('AccountUsageTracker', () => {
  it('probes every account that has a credential, and skips the ones that do not', async () => {
    const probe = vi.fn(async () => ok());
    const { tracker } = make({ probe });
    await tracker.refreshAll();

    expect(probe).toHaveBeenCalledTimes(2);
    expect(tracker.get('a')?.source).toBe('probe');
    expect(tracker.get('gone')).toBeUndefined();
  });

  it('reads a blocked account — the case an in-turn reading can never cover', async () => {
    const { tracker } = make({ probe: async () => ok({ blocked: true }) });
    await tracker.refresh('a');
    expect(tracker.get('a')?.reading.blocked).toBe(true);
    expect(tracker.get('a')?.reading.windows.overage?.disabledReason).toBe(
      'org_level_disabled_until',
    );
  });

  it('records which Claude account a key turned out to belong to', async () => {
    const remembered: Array<[string, string]> = [];
    const { tracker } = make({
      probe: async () => ok({ organizationId: 'org-same' }),
      rememberOrganization: (id, org) => remembered.push([id, org]),
    });
    await tracker.refreshAll();
    expect(remembered).toEqual([
      ['a', 'org-same'],
      ['b', 'org-same'],
    ]);
  });

  it('does not re-probe the same account inside the floor', async () => {
    let now = 0;
    const probe = vi.fn(async () => ok());
    const { tracker } = make({ probe, now: () => now });
    await tracker.refresh('a');
    await tracker.refresh('a');
    expect(probe).toHaveBeenCalledTimes(1);

    now = USAGE_MIN_INTERVAL_MS + 1;
    await tracker.refresh('a');
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('force overrides the floor — someone is watching the number for a change', async () => {
    const probe = vi.fn(async () => ok());
    const { tracker } = make({ probe, now: () => 0 });
    await tracker.refresh('a');
    await tracker.refresh('a', true);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  // NO FALLBACK: an unanswered question stays unanswered. Blanking a reading on
  // a network blip would draw an account with no limits, which is the opposite
  // of the truth it would be hiding.
  it('keeps the last reading when a probe cannot be completed', async () => {
    let result: ClaudeUsageResult = ok({ blocked: true });
    const { tracker } = make({ probe: async () => result, now: () => 0 });
    await tracker.refresh('a', true);

    result = { kind: 'unreachable', message: 'ECONNRESET' };
    await tracker.refresh('a', true);

    expect(tracker.get('a')?.reading.blocked).toBe(true);
  });

  it('a turn-observed window is folded in WITHOUT dropping the overage the probe saw', async () => {
    const { tracker } = make({ probe: async () => ok(), now: () => 5 });
    await tracker.refresh('a', true);
    tracker.observeFromTurn('a', 'week', { status: 'allowed', utilization: 0.62 });

    const windows = tracker.get('a')!.reading.windows;
    expect(windows.week?.utilization).toBe(0.62);
    // The window only a direct probe ever reports is still there.
    expect(windows.overage).toBeDefined();
  });

  it('stamps every reading with when it was taken, so a stale figure cannot pass for live', async () => {
    const { tracker } = make({ probe: async () => ok(), now: () => 1_234 });
    tracker.observeFromTurn('a', 'session', { status: 'allowed', utilization: 0.1 });
    expect(tracker.get('a')?.reading.at).toBe(1_234);
  });

  // The probe's fixture carries a rejected overage, because that is the steady
  // state of every account without the extra-usage add-on. Folding a healthy
  // turn on top of it used to flip the account to blocked: the recomputation
  // counted "any window rejected", and the overflow pool is always one of them.
  it('a healthy turn folded onto a rejected overage does not report blocked', async () => {
    const { tracker } = make({ probe: async () => ok(), now: () => 5 });
    await tracker.refresh('a', true);
    tracker.observeFromTurn('a', 'session', { status: 'allowed', utilization: 0.05 });

    const entry = tracker.get('a')!;
    expect(entry.reading.windows.overage?.status).toBe('rejected');
    expect(entry.reading.blocked).toBe(false);
  });

  it('a turn reporting a refused session DOES report blocked', async () => {
    const { tracker } = make({ probe: async () => ok(), now: () => 5 });
    await tracker.refresh('a', true);
    tracker.observeFromTurn('a', 'session', { status: 'rejected', utilization: 1 });
    expect(tracker.get('a')!.reading.blocked).toBe(true);
  });

  // A probe seeing an account come back is one of only three events that can
  // restart work parked for credit (`creditResume.ts`) — and the only one that
  // covers an account sidelined by a limit that named no reset, which arms no
  // timer at all. Before this the reading moved a number on a settings screen
  // and nothing else.
  it('hands every probed reading to the host, blocked or not', async () => {
    const { tracker, readings } = make({ probe: async () => ok() });
    await tracker.refresh('a', true);
    expect(readings).toEqual([{ accountId: 'a', blocked: false }]);

    const spent = make({ probe: async () => ok({ blocked: true }) });
    await spent.tracker.refresh('a', true);
    expect(spent.readings).toEqual([{ accountId: 'a', blocked: true }]);
  });

  it('does NOT fire it for a window observed on a turn', async () => {
    // A turn speaks only about the account it ran on, and a spent account
    // cannot produce one, so a turn-observed window can never be the news that
    // credit came back.
    const { tracker, readings } = make({ probe: async () => ok(), now: () => 5 });
    tracker.observeFromTurn('a', 'session', { status: 'allowed', utilization: 0.1 });
    expect(readings).toEqual([]);
  });

  it('says nothing when the probe could not get a reading', async () => {
    // NO FALLBACK: an unreachable probe is an unanswered question, not an
    // account with credit. Reporting it as a reading would un-park every chat
    // on a network blip.
    const { tracker, readings } = make({
      probe: async () => ({ kind: 'unreachable' as const, message: 'ECONNRESET' }),
    });
    await tracker.refresh('a', true);
    expect(readings).toEqual([]);
  });
});
