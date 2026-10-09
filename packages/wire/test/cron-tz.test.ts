// spec/08 § Cron: an expression is stored exactly as authored and evaluated in
// the trigger's own IANA zone. These tests pin the zone-name check every write
// surface uses, and the zero-dep cron grammar check the CLI rejects with.

import { describe, test, expect } from 'vitest';
import {
  assertValidCron,
  assertValidTimeZone,
  cronZoneLabel,
  isValidTimeZone,
  runtimeTimeZone,
  tzOffsetMinutes,
} from '../src/cron-tz.js';

// A fixed winter instant (no UK DST): 2026-01-15T12:00:00Z. Europe/London is
// UTC+0 here; New York is UTC-5. A fixed summer instant for the DST case:
// 2026-07-15T12:00:00Z — Europe/London is UTC+1 (BST).
const WINTER = Date.parse('2026-01-15T12:00:00Z');
const SUMMER = Date.parse('2026-07-15T12:00:00Z');

describe('tzOffsetMinutes', () => {
  test('Europe/London is +0 in winter, +60 in summer', () => {
    expect(tzOffsetMinutes('Europe/London', WINTER)).toBe(0);
    expect(tzOffsetMinutes('Europe/London', SUMMER)).toBe(60);
  });
  test('America/New_York is -300 in winter', () => {
    expect(tzOffsetMinutes('America/New_York', WINTER)).toBe(-300);
  });
  test('UTC is 0', () => {
    expect(tzOffsetMinutes('UTC', WINTER)).toBe(0);
  });

  test('throws if Intl.DateTimeFormat omits an expected part (defensive check)', () => {
    // Simulates a broken/nonstandard ICU that drops a requested field — the
    // `get()` helper must fail loudly (NO FALLBACK) rather than silently
    // computing a wrong offset from missing data.
    const proto = Intl.DateTimeFormat.prototype;
    const original = proto.formatToParts;
    proto.formatToParts = function (...args: unknown[]) {
      return (original.apply(this, args as never) as Intl.DateTimeFormatPart[]).filter(
        (p) => p.type !== 'second',
      );
    };
    try {
      expect(() => tzOffsetMinutes('UTC', WINTER)).toThrowError(/missing second for UTC/);
    } finally {
      proto.formatToParts = original;
    }
  });

  test('normalizes an ICU hour of "24" (midnight) back to 0 before computing the offset', () => {
    // Some ICU builds render midnight as hour "24" instead of "00" under
    // hour12:false — simulate that quirk and confirm the offset still comes
    // out correct (identical to what a "00"-rendering ICU would produce).
    const midnightUtc = Date.parse('2026-01-15T00:00:00Z');
    const proto = Intl.DateTimeFormat.prototype;
    const original = proto.formatToParts;
    proto.formatToParts = function (...args: unknown[]) {
      const parts = original.apply(this, args as never) as Intl.DateTimeFormatPart[];
      return parts.map((p) => (p.type === 'hour' && p.value === '00' ? { ...p, value: '24' } : p));
    };
    try {
      expect(tzOffsetMinutes('UTC', midnightUtc)).toBe(0);
    } finally {
      proto.formatToParts = original;
    }
  });
});

// The zone on a cron trigger decides when the job fires, so a name the runtime
// cannot resolve has to be refused at write time — never demoted to UTC.
describe('isValidTimeZone / assertValidTimeZone', () => {
  test('accepts real IANA zones, including UTC', () => {
    expect(isValidTimeZone('Europe/London')).toBe(true);
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('Australia/Eucla')).toBe(true); // +08:45, a half/quarter zone
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Etc/UTC')).toBe(true);
  });

  test('rejects typos, empties and non-zones', () => {
    expect(isValidTimeZone('Europe/Landon')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone('not a zone')).toBe(false);
    expect(isValidTimeZone('GMT+1')).toBe(false);
  });

  test('rejects a bare UTC offset — an offset is frozen and cannot track DST', () => {
    expect(isValidTimeZone('+01:00')).toBe(false);
    expect(isValidTimeZone('-05:00')).toBe(false);
  });

  test('an abbreviation ICU aliases is accepted as the zone it aliases, not refused', () => {
    // ICU resolves 'BST' to Asia/Dhaka (Bangladesh, not British Summer Time).
    // Documenting it here so nobody reads a passing 'BST' as UK-correct.
    expect(isValidTimeZone('BST')).toBe(true);
  });

  test('assertValidTimeZone throws naming the zone, and is silent on a good one', () => {
    expect(() => assertValidTimeZone('Europe/Landon')).toThrowError(
      /invalid IANA timezone: "Europe\/Landon"/,
    );
    expect(() => assertValidTimeZone('Europe/London')).not.toThrow();
  });
});

// H1-d5: the CLI must reject a malformed cron CLIENT-SIDE, naming the cron
// field, regardless of $TZ. assertValidCron is that TZ-independent, zero-dep
// check.
describe('assertValidCron', () => {
  test('accepts standard 5-field expressions', () => {
    expect(() => assertValidCron('57 8 * * 1-5')).not.toThrow();
    expect(() => assertValidCron('*/15 0-23 1,15 * 0,6')).not.toThrow();
    expect(() => assertValidCron('0 9 * * *')).not.toThrow();
    expect(() => assertValidCron('0 0 1-28/7 1,6,12 0-6')).not.toThrow();
  });

  test('rejects a non-cron string by field count, naming the cron', () => {
    expect(() => assertValidCron('not a cron')).toThrowError(/cron expression/);
    expect(() => assertValidCron('not a cron')).toThrowError(/got 3/);
  });

  test('rejects wrong field count', () => {
    expect(() => assertValidCron('0 9 * *')).toThrowError(/expected 5 fields, got 4/);
    expect(() => assertValidCron('0 9 * * * *')).toThrowError(/expected 5 fields, got 6/);
  });

  test('rejects out-of-range and malformed fields, naming the bad field', () => {
    expect(() => assertValidCron('99 8 * * *')).toThrowError(/bad field 1/); // minute > 59
    expect(() => assertValidCron('0 25 * * *')).toThrowError(/bad field 2/); // hour > 23
    expect(() => assertValidCron('0 8 0 * *')).toThrowError(/bad field 3/); // dom < 1
    expect(() => assertValidCron('0 8 * 13 *')).toThrowError(/bad field 4/); // month > 12
    expect(() => assertValidCron('0 8 * * 9')).toThrowError(/bad field 5/); // dow > 7
    expect(() => assertValidCron('0 8 * * abc')).toThrowError(/bad field 5/);
    expect(() => assertValidCron('5-2 8 * * *')).toThrowError(/bad field 1/); // inverted range
    expect(() => assertValidCron('1-2-3 8 * * *')).toThrowError(/bad field 1/); // >1 hyphen
    expect(() => assertValidCron('1,,3 8 * * *')).toThrowError(/bad field 1/); // empty list term
    expect(() => assertValidCron('1/2/3 8 * * *')).toThrowError(/bad field 1/); // >1 slash
    expect(() => assertValidCron('1/x 8 * * *')).toThrowError(/bad field 1/); // non-digit step
    expect(() => assertValidCron('1/0 8 * * *')).toThrowError(/bad field 1/); // step <= 0
    expect(() => assertValidCron('a-5 8 * * *')).toThrowError(/bad field 1/); // non-digit range bound
  });
});

// The display half of the same rule: a schedule label is ambiguous unless the
// reader can tell which zone it is in. Tom's pre-timezone jobs read "9am" and
// fired at 10:00 BST, which is the complaint this exists to answer.
describe('cronZoneLabel', () => {
  test('says nothing when the job runs in the viewer\u2019s own zone', () => {
    expect(cronZoneLabel('Europe/London', 'Europe/London')).toBeNull();
  });

  test('names the zone when it differs from the viewer\u2019s', () => {
    expect(cronZoneLabel('Europe/London', 'America/New_York')).toBe('Europe/London');
  });

  test('an absent zone is UTC, and is named when the viewer is not in UTC', () => {
    expect(cronZoneLabel(undefined, 'Europe/London')).toBe('UTC');
  });

  test('an absent zone says nothing to a viewer already in UTC', () => {
    expect(cronZoneLabel(undefined, 'UTC')).toBeNull();
  });

  test('an alias of the viewer\u2019s own zone is not worth a label', () => {
    expect(cronZoneLabel('Etc/UTC', 'UTC')).toBeNull();
    expect(cronZoneLabel(undefined, 'Etc/UTC')).toBeNull();
  });

  test('a zone this runtime cannot resolve is labelled, never assumed to be the viewer\u2019s', () => {
    expect(cronZoneLabel('Mars/Olympus', 'Europe/London')).toBe('Mars/Olympus');
  });
});

describe('runtimeTimeZone', () => {
  test('reports a zone this runtime can resolve', () => {
    expect(isValidTimeZone(runtimeTimeZone())).toBe(true);
  });
});
