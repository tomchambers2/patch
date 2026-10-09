// Starts/Stops widget support (spec/08 § Filter). Real react-querybuilder
// parsing throughout — no mocking of the library, since the whole point is
// trusting its parse tree over a hand-rolled regex.

import { describe, it, expect } from 'vitest';
import {
  parseDateRangeFromFilter,
  buildFilterFromDateRange,
  isoToLocalInputValue,
  localInputValueToIso,
} from '../lib/jobDateRangeFilter';

const START = '2027-05-01T00:00:00.000Z';
const STOP = '2027-09-01T00:00:00.000Z';

describe('parseDateRangeFromFilter', () => {
  it('null/empty filter → nothing at all', () => {
    expect(parseDateRangeFromFilter(null)).toEqual({ start: null, stop: null, remainder: null });
    expect(parseDateRangeFromFilter('')).toEqual({ start: null, stop: null, remainder: null });
    expect(parseDateRangeFromFilter('   ')).toEqual({ start: null, stop: null, remainder: null });
  });

  it('start only', () => {
    expect(parseDateRangeFromFilter(`now >= "${START}"`)).toEqual({
      start: START,
      stop: null,
      remainder: null,
    });
  });

  it('stop only', () => {
    expect(parseDateRangeFromFilter(`now <= "${STOP}"`)).toEqual({
      start: null,
      stop: STOP,
      remainder: null,
    });
  });

  it('start and stop as two separate clauses', () => {
    expect(parseDateRangeFromFilter(`now >= "${START}" and now <= "${STOP}"`)).toEqual({
      start: START,
      stop: STOP,
      remainder: null,
    });
  });

  it('start and stop collapsed by the library into a single "between" rule', () => {
    // react-querybuilder's own parser auto-combines two adjacent same-field
    // comparisons into one `between` rule when nothing else is ANDed in —
    // this is the library's behaviour, not this module's; both shapes must
    // read the same way.
    expect(parseDateRangeFromFilter(`now >= "${START}" and now <= "${STOP}"`).start).toBe(START);
  });

  it('a date range combined with a custom condition keeps the remainder as JSONata', () => {
    const result = parseDateRangeFromFilter(`now >= "${START}" and payload.foo = "bar"`);
    expect(result.start).toBe(START);
    expect(result.stop).toBeNull();
    expect(result.remainder).toBe('payload.foo = "bar"');
  });

  it('all three: start, stop, and a custom condition', () => {
    const result = parseDateRangeFromFilter(
      `now >= "${START}" and now <= "${STOP}" and payload.foo = "bar"`,
    );
    expect(result.start).toBe(START);
    expect(result.stop).toBe(STOP);
    expect(result.remainder).toBe('payload.foo = "bar"');
  });

  it('a filter with no `now` clause at all is entirely remainder', () => {
    const result = parseDateRangeFromFilter('payload.foo = "bar"');
    expect(result).toEqual({ start: null, stop: null, remainder: 'payload.foo = "bar"' });
  });

  it('an OR at the top level is not decomposed — ANDing a date range into it would change its meaning', () => {
    const filter = `now >= "${START}" or payload.foo = "bar"`;
    expect(parseDateRangeFromFilter(filter)).toEqual({
      start: null,
      stop: null,
      remainder: filter,
    });
  });

  it('a nested group is not decomposed', () => {
    const filter = `now >= "${START}" and (payload.a = 1 or payload.b = 2)`;
    expect(parseDateRangeFromFilter(filter)).toEqual({
      start: null,
      stop: null,
      remainder: filter,
    });
  });

  it('a `now` comparison with an operator this widget does not understand is left as opaque text', () => {
    const filter = `now = "${START}"`;
    expect(parseDateRangeFromFilter(filter)).toEqual({
      start: null,
      stop: null,
      remainder: filter,
    });
  });

  it('invalid JSONata is left as opaque text rather than throwing', () => {
    const filter = 'this is }} not jsonata';
    expect(parseDateRangeFromFilter(filter)).toEqual({
      start: null,
      stop: null,
      remainder: filter,
    });
  });
});

describe('buildFilterFromDateRange', () => {
  it('all null → no filter', () => {
    expect(buildFilterFromDateRange(null, null, null)).toBeNull();
  });

  it('start only', () => {
    expect(buildFilterFromDateRange(START, null, null)).toBe(`now >= "${START}"`);
  });

  it('stop only', () => {
    expect(buildFilterFromDateRange(null, STOP, null)).toBe(`now <= "${STOP}"`);
  });

  it('start and stop', () => {
    expect(buildFilterFromDateRange(START, STOP, null)).toBe(
      `now >= "${START}" and now <= "${STOP}"`,
    );
  });

  it('remainder only (no date range set)', () => {
    expect(buildFilterFromDateRange(null, null, 'payload.foo = "bar"')).toBe('payload.foo = "bar"');
  });

  it('date range plus a remainder, ANDed together', () => {
    expect(buildFilterFromDateRange(START, STOP, 'payload.foo = "bar"')).toBe(
      `now >= "${START}" and now <= "${STOP}" and payload.foo = "bar"`,
    );
  });

  it('an empty-string remainder is treated as none', () => {
    expect(buildFilterFromDateRange(START, null, '   ')).toBe(`now >= "${START}"`);
  });
});

describe('isoToLocalInputValue / localInputValueToIso', () => {
  it('empty/null round-trips to empty', () => {
    expect(isoToLocalInputValue(null)).toBe('');
    expect(localInputValueToIso('')).toBeNull();
  });

  it('unparseable input is treated as empty, not thrown', () => {
    expect(isoToLocalInputValue('not a date')).toBe('');
    expect(localInputValueToIso('not a date')).toBeNull();
  });

  it('an ISO instant round-trips through the local input value to the same instant', () => {
    // Zone-independent: whatever TZ the test runner is in, converting to a
    // local wall-clock string and back must land on the same instant — that
    // is the entire point of the pair.
    const original = new Date('2027-05-01T16:00:00.000Z').getTime();
    const local = isoToLocalInputValue(new Date(original).toISOString());
    expect(localInputValueToIso(local)).toBe(new Date(original).toISOString());
  });

  it('the local value has no trailing seconds/zone — the shape <input type="datetime-local"> expects', () => {
    const local = isoToLocalInputValue('2027-05-01T16:00:00.000Z');
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });
});

describe('round trip', () => {
  it('build then parse recovers the same start/stop/remainder', () => {
    const built = buildFilterFromDateRange(START, STOP, 'payload.foo = "bar"');
    expect(built).not.toBeNull();
    const parsed = parseDateRangeFromFilter(built);
    expect(parsed.start).toBe(START);
    expect(parsed.stop).toBe(STOP);
    expect(parsed.remainder).toBe('payload.foo = "bar"');
  });

  it('what the widget writes, the live evaluator (server-side JSONata) can actually run', async () => {
    const jsonata = (await import('jsonata')).default;
    const built = buildFilterFromDateRange(START, STOP, null)!;
    const expr = jsonata(built);
    const inRange = await expr.evaluate({ now: '2027-06-01T00:00:00.000Z' });
    const outOfRange = await expr.evaluate({ now: '2020-01-01T00:00:00.000Z' });
    expect(inRange).toBe(true);
    expect(outOfRange).toBe(false);
  });
});
