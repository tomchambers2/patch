// Snooze primitives (spec/04 § Snooze): the wake-time preset ladder, the
// "is this chat snoozed" derivation, and the wake-time formatter.
//
// Most presets are DELTAS, two ("5pm", "Tomorrow 8am") are wall-clock targets;
// all resolve against the clock at the moment of choosing — the host only
// ever stores the resulting absolute timestamp, so these tests pin the
// resolution happening here rather than a delta going over the wire.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  SNOOZE_PRESETS,
  formatWakeTime,
  formatWakeTimeCompact,
  resolvePreset,
} from '../src/lib/snooze';
import { isSnoozed } from '../src/stores/types';

afterEach(() => {
  vi.useRealTimers();
});

describe('SNOOZE_PRESETS', () => {
  it('is the spec/04 ladder, in order, with no custom entry (the phone has no date/time field)', () => {
    expect(SNOOZE_PRESETS.map((p) => p.label)).toEqual([
      '2 minutes',
      '5 minutes',
      '30 minutes',
      '1 hour',
      '5pm',
      'Tomorrow 8am',
      '1 day',
      'Next week',
    ]);
  });

  it('carries the deltas those labels name', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T10:00:00Z'));
    const now = Date.now();
    const byLabel = Object.fromEntries(SNOOZE_PRESETS.map((p) => [p.label, p.resolve() - now]));
    expect(byLabel['2 minutes']).toBe(2 * 60_000);
    expect(byLabel['5 minutes']).toBe(5 * 60_000);
    expect(byLabel['30 minutes']).toBe(30 * 60_000);
    expect(byLabel['1 hour']).toBe(60 * 60_000);
    expect(byLabel['1 day']).toBe(24 * 60 * 60_000);
    expect(byLabel['Next week']).toBe(7 * 24 * 60 * 60_000);
  });
});

describe('resolvePreset', () => {
  it('resolves a delta preset to an ABSOLUTE ms-epoch timestamp against the current clock', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T10:00:00Z'));
    const thirty = SNOOZE_PRESETS.find((p) => p.label === '30 minutes')!;
    expect(resolvePreset(thirty)).toBe(Date.parse('2026-08-25T10:30:00Z'));
  });

  it('"5pm" resolves to today 17:00 when it is currently before 5pm', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 25, 9, 0, 0));
    const fivePm = SNOOZE_PRESETS.find((p) => p.id === '5pm')!;
    expect(resolvePreset(fivePm)).toBe(new Date(2026, 7, 25, 17, 0, 0, 0).getTime());
  });

  it('"5pm" resolves to tomorrow 17:00 when it is currently after 5pm', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 25, 18, 30, 0));
    const fivePm = SNOOZE_PRESETS.find((p) => p.id === '5pm')!;
    expect(resolvePreset(fivePm)).toBe(new Date(2026, 7, 26, 17, 0, 0, 0).getTime());
  });

  it('"tomorrow-8am" always resolves to tomorrow 08:00, regardless of current time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 25, 3, 0, 0));
    const tomorrow8am = SNOOZE_PRESETS.find((p) => p.id === 'tomorrow-8am')!;
    expect(resolvePreset(tomorrow8am)).toBe(new Date(2026, 7, 26, 8, 0, 0, 0).getTime());

    vi.setSystemTime(new Date(2026, 7, 25, 23, 59, 0));
    expect(resolvePreset(tomorrow8am)).toBe(new Date(2026, 7, 26, 8, 0, 0, 0).getTime());
  });
});

describe('isSnoozed', () => {
  it('is false when snoozedUntil is null', () => {
    expect(isSnoozed({ snoozedUntil: null }, 1_000)).toBe(false);
  });

  it('is true only while the wake time is still in the future', () => {
    expect(isSnoozed({ snoozedUntil: 2_000 }, 1_000)).toBe(true);
    expect(isSnoozed({ snoozedUntil: 1_000 }, 1_000)).toBe(false);
    expect(isSnoozed({ snoozedUntil: 500 }, 1_000)).toBe(false);
  });

  it('derives from the clock rather than a stored flag, so a lapsed snooze needs no event', () => {
    const row = { snoozedUntil: 5_000 };
    expect(isSnoozed(row, 4_999)).toBe(true);
    // Same row object, later clock — no mutation, no host round-trip.
    expect(isSnoozed(row, 5_001)).toBe(false);
  });
});

describe('formatWakeTime', () => {
  it('shows a bare time for a wake later the same day', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 25, 9, 0, 0));
    const out = formatWakeTime(new Date(2026, 7, 25, 17, 30, 0).getTime());
    expect(out).toMatch(/\d{1,2}[:.]\d{2}/);
    expect(out).not.toMatch(/Mon|Tue|Wed|Thu|Fri|Sat|Sun/);
  });

  it('prefixes the weekday once the wake falls on another day', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 25, 9, 0, 0));
    const out = formatWakeTime(new Date(2026, 7, 27, 9, 30, 0).getTime());
    expect(out).toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/);
  });
});

describe('formatWakeTimeCompact — sized for the row timestamp slot', () => {
  it('a bare time for a wake later today', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 25, 9, 0, 0));
    const out = formatWakeTimeCompact(new Date(2026, 7, 25, 17, 30, 0).getTime());
    expect(out).toMatch(/^\d{1,2}[:.]\d{2}/);
  });

  it('a bare weekday within the coming week', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 25, 9, 0, 0));
    const out = formatWakeTimeCompact(new Date(2026, 7, 27, 9, 30, 0).getTime());
    expect(out).toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/);
  });

  it('a day and month a week or more out, where a weekday alone would be ambiguous', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 25, 9, 0, 0));
    const out = formatWakeTimeCompact(new Date(2026, 8, 1, 9, 0, 0).getTime());
    expect(out).not.toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/);
    expect(out).toMatch(/1/);
    expect(out).toMatch(/Sep/);
  });
});
