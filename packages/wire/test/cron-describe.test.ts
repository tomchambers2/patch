// spec/08 § Cron — the ONE natural-language renderer for a cron expression.
//
// Tom's Jobs list rendered nearly half his real jobs as raw cron ("0,30 7-22
// * * *"), because the list's own describer only understood a fixed minute +
// hour. These tests pin the unified describer every surface now reads through:
// the phrasing table, and — first, because they are what the change is for —
// every expression in his live job fleet.

import { describe, test, expect } from 'vitest';
import { describeCron } from '../src/cron-describe.js';

describe('describeCron — every cron in Tom’s live job fleet', () => {
  // Every distinct cron expression `patch jobs list --json` reports, checked
  // 15 Sep 2026. Seven of these used to render as raw `cron · <expr>` in the
  // Jobs list, which is the bug this change exists to fix — so the list is
  // pinned wholesale rather than sampled, and re-checked when the fleet moves.
  test.each([
    ['New photos: 5-min tick', '*/5 * * * *', 'every 5 minutes'],
    ['Deploy pending apps', '0 */4 * * *', 'every 4 hours'],
    ['Solar handover docs', '0 10 * * *', 'every day at 10am'],
    ['Update home assistant', '0 2 * * *', 'every day at 2am'],
    ['Culture week (Mon 07:00)', '0 7 * * 1', 'Mondays at 7am'],
    ['Autotick', '0 8 * * *', 'every day at 8am'],
    ['Weekly spend', '0 8 * * 1', 'Mondays at 8am'],
    ['Daily email update', '0 9 * * *', 'every day at 9am'],
    ['Weekly timesheet (Fri 9am)', '0 9 * * 5', 'Fridays at 9am'],
    ['Foreman: coach tick', '0 9-22 * * *', 'every hour between 9am and 10pm'],
    ['Dygol watch', '0,30 7-22 * * *', 'every 30 minutes between 7am and 10pm'],
    ['Meal plan (Mon 08:15)', '15 8 * * 1', 'Mondays at 8:15am'],
    ['App updates catchup', '17 7,11,15,19 * * *', 'at 7:17am, 11:17am, 3:17pm and 7:17pm'],
    ['Basket watch', '30 8 * * *', 'every day at 8:30am'],
    ['Patch jobs snapshot', '40 7 * * *', 'every day at 7:40am'],
    ['Do It Now: daily Todoist pull', '45 6 * * *', 'every day at 6:45am'],
  ])('%s (%s)', (_name, expression, expected) => {
    expect(describeCron(expression)).toBe(expected);
  });

  test('not one of them falls through to no label', () => {
    const fleet = [
      '*/5 * * * *',
      '0 */4 * * *',
      '0 10 * * *',
      '0 2 * * *',
      '0 7 * * 1',
      '0 8 * * *',
      '0 8 * * 1',
      '0 9 * * *',
      '0 9 * * 5',
      '0 9-22 * * *',
      '0,30 7-22 * * *',
      '15 8 * * 1',
      '17 7,11,15,19 * * *',
      '30 8 * * *',
      '40 7 * * *',
      '45 6 * * *',
    ];
    expect(fleet.filter((e) => describeCron(e) === '')).toEqual([]);
  });
});

describe('describeCron — minute intervals', () => {
  test.each([
    ['*/5 * * * *', 'every 5 minutes'],
    ['*/1 * * * *', 'every 1 minute'],
    ['*/15 * * * *', 'every 15 minutes'],
    ['* * * * *', 'every minute'],
  ])('%s → %s', (expr, expected) => {
    expect(describeCron(expr)).toBe(expected);
  });
});

describe('describeCron — hour intervals', () => {
  test.each([
    ['0 */4 * * *', 'every 4 hours'],
    ['0 */1 * * *', 'every 1 hour'],
    ['0 * * * *', 'every hour'],
  ])('%s → %s', (expr, expected) => {
    expect(describeCron(expr)).toBe(expected);
  });
});

describe('describeCron — hour windows', () => {
  test.each([
    ['*/30 8-20 * * *', 'every 30 minutes between 8am and 8pm'],
    ['*/30 7-22 * * *', 'every 30 minutes between 7am and 10pm'],
    ['*/5 9-17 * * *', 'every 5 minutes between 9am and 5pm'],
    ['* 9-17 * * *', 'every minute between 9am and 5pm'],
    ['0 9-17 * * *', 'every hour between 9am and 5pm'],
    ['0 9-17/2 * * *', 'every 2 hours between 9am and 5pm'],
    ['0 9-17/1 * * *', 'every 1 hour between 9am and 5pm'],
  ])('%s → %s', (expr, expected) => {
    expect(describeCron(expr)).toBe(expected);
  });

  test('names midnight and noon as words inside a window', () => {
    expect(describeCron('*/5 0-12 * * *')).toBe('every 5 minutes between midnight and noon');
    expect(describeCron('*/5 0-17 * * *')).toBe('every 5 minutes between midnight and 5pm');
    expect(describeCron('*/5 9-12 * * *')).toBe('every 5 minutes between 9am and noon');
  });

  test('a degenerate window whose bounds do not ascend is refused', () => {
    expect(describeCron('*/5 9-9 * * *')).toBe('');
    expect(describeCron('*/5 17-9 * * *')).toBe('');
  });
});

// An evenly-spaced minute list fires at exactly the same instants as the
// equivalent step, so it must read the same — this is where Dygol watch's
// `0,30 7-22 * * *` came from.
describe('describeCron — an evenly-spaced minute list is a step', () => {
  test.each([
    ['0,30 * * * *', 'every 30 minutes'],
    ['0,15,30,45 * * * *', 'every 15 minutes'],
    ['0,20,40 * * * *', 'every 20 minutes'],
    ['0,30 7-22 * * *', 'every 30 minutes between 7am and 10pm'],
    ['0,15,30,45 9-17 * * *', 'every 15 minutes between 9am and 5pm'],
  ])('%s → %s', (expr, expected) => {
    expect(describeCron(expr)).toBe(expected);
  });

  test('a minute list that is not an even step has no honest short phrase', () => {
    expect(describeCron('0,10,45 * * * *')).toBe('');
    // Evenly spaced but not anchored at 0, so it is not the `*/30` shape.
    expect(describeCron('10,40 * * * *')).toBe('');
    // Evenly spaced but does not cover the hour: 0,20 leaves a 40-minute gap.
    expect(describeCron('0,20 * * * *')).toBe('');
  });
});

// An hour LIST at a fixed minute only covers part of the day. Rounding it to
// "every 4 hours" would claim the job also fires at 23:17 and 03:17.
describe('describeCron — an hour list names every time it fires', () => {
  test('names all four daytime fires rather than calling it every 4 hours', () => {
    expect(describeCron('17 7,11,15,19 * * *')).toBe('at 7:17am, 11:17am, 3:17pm and 7:17pm');
    expect(describeCron('17 7,11,15,19 * * *')).not.toContain('every 4 hours');
  });
  test('joins a two-entry list with "and"', () => {
    expect(describeCron('0 8,20 * * *')).toBe('at 8am and 8pm');
  });
  test('carries a day-of-week qualifier', () => {
    expect(describeCron('0 9,17 * * 1-5')).toBe('at 9am and 5pm on weekdays');
  });
});

describe('describeCron — a fixed time of day', () => {
  test.each([
    ['45 6 * * *', 'every day at 6:45am'],
    ['0 2 * * *', 'every day at 2am'],
    ['0 8 * * *', 'every day at 8am'],
    ['57 8 * * 1-5', 'weekdays at 8:57am'],
    ['30 17 * * *', 'every day at 5:30pm'],
    ['0 0 * * *', 'every day at 12am'],
    ['0 12 * * *', 'every day at 12pm'],
  ])('%s → %s', (expr, expected) => {
    expect(describeCron(expr)).toBe(expected);
  });
});

describe('describeCron — day-of-week', () => {
  test.each([
    ['0 9 * * 5', 'Fridays at 9am'],
    ['0 9 * * 0', 'Sundays at 9am'],
    ['0 19 * * 1', 'Mondays at 7pm'],
    ['0 8 * * 1-5', 'weekdays at 8am'],
    ['0 8 * * 0,6', 'weekends at 8am'],
    ['0 8 * * 6,0', 'weekends at 8am'],
    ['0 8 * * 1,3,5', 'Monday, Wednesday, Friday at 8am'],
    ['30 8 * * 1,4', 'Monday, Thursday at 8:30am'],
  ])('%s → %s', (expr, expected) => {
    expect(describeCron(expr)).toBe(expected);
  });

  test('cron’s 7 means Sunday, same as 0', () => {
    expect(describeCron('0 9 * * 7')).toBe('Sundays at 9am');
  });

  test('a day-of-week qualifier combines with an interval', () => {
    expect(describeCron('*/5 * * * 1-5')).toBe('every 5 minutes on weekdays');
    expect(describeCron('*/5 * * * 0,6')).toBe('every 5 minutes on weekends');
    expect(describeCron('*/5 * * * 6,0')).toBe('every 5 minutes on weekends');
    expect(describeCron('*/5 * * * 1,4')).toBe('every 5 minutes on Monday, Thursday');
    expect(describeCron('*/5 * * * 3')).toBe('every 5 minutes on Wednesdays');
    expect(describeCron('*/10 * * * 1-5')).toBe('every 10 minutes on weekdays');
    expect(describeCron('0 */4 * * 1-5')).toBe('every 4 hours on weekdays');
    expect(describeCron('*/5 9-17 * * 1-5')).toBe(
      'every 5 minutes between 9am and 5pm on weekdays',
    );
    expect(describeCron('*/5 9-17 * * 1,3,5')).toBe(
      'every 5 minutes between 9am and 5pm on Monday, Wednesday, Friday',
    );
  });
});

describe('describeCron — day-of-month ordinals', () => {
  test.each([
    ['0 8 1 * *', 'the 1st at 8am'],
    ['0 8 2 * *', 'the 2nd at 8am'],
    ['0 8 3 * *', 'the 3rd at 8am'],
    ['0 8 11 * *', 'the 11th at 8am'],
    ['0 8 12 * *', 'the 12th at 8am'],
    ['0 8 13 * *', 'the 13th at 8am'],
    ['0 8 21 * *', 'the 21st at 8am'],
    ['0 8 22 * *', 'the 22nd at 8am'],
    ['0 8 23 * *', 'the 23rd at 8am'],
    ['30 8 4 * *', 'the 4th at 8:30am'],
  ])('%s → %s', (expr, expected) => {
    expect(describeCron(expr)).toBe(expected);
  });

  test('out of range, or crossed with a repeating shape, is refused', () => {
    expect(describeCron('0 8 0 * *')).toBe('');
    expect(describeCron('0 8 32 * *')).toBe('');
    // Cron ORs dom and dow when both are restricted; no short phrase says that.
    expect(describeCron('0 8 1 * 1')).toBe('');
    expect(describeCron('*/5 * 1 * *')).toBe('');
    expect(describeCron('0 9-17 1 * *')).toBe('');
  });
});

// NO FALLBACK: a shape this cannot phrase exactly returns '' and the caller
// shows the raw expression. Never a confident wrong answer.
describe('describeCron — shapes it refuses to phrase', () => {
  test('a month restriction', () => {
    expect(describeCron('0 8 * 6 *')).toBe('');
  });
  test('a non-numeric field', () => {
    expect(describeCron('x 8 * * 2')).toBe('');
    expect(describeCron('not a cron')).toBe('');
  });
  test('out-of-range values', () => {
    expect(describeCron('60 8 * * *')).toBe('');
    expect(describeCron('0 24 * * *')).toBe('');
    expect(describeCron('0 9 * * 8')).toBe('');
    expect(describeCron('*/5 * * * 8')).toBe('');
    expect(describeCron('*/5 9-17 * * 9')).toBe('');
    expect(describeCron('*/0 * * * *')).toBe('');
    expect(describeCron('0 */0 * * *')).toBe('');
    expect(describeCron('0 9-17/0 * * *')).toBe('');
    expect(describeCron('0 9-24 * * *')).toBe('');
  });
  test('a field count other than 5', () => {
    expect(describeCron('* * * *')).toBe('');
    expect(describeCron('* * *')).toBe('');
    expect(describeCron('0 9 * * * *')).toBe('');
    expect(describeCron('')).toBe('');
  });
  test('an arbitrary day-of-week range', () => {
    expect(describeCron('0 9 * * 2-4')).toBe('');
  });
  test('a sub-hour interval crossed with a stepped, listed or single hour', () => {
    expect(describeCron('*/5 9-17/2 * * *')).toBe('');
    expect(describeCron('*/5 */2 * * *')).toBe('');
    expect(describeCron('*/5 7,11 * * *')).toBe('');
    expect(describeCron('*/5 8 * * *')).toBe('');
  });
  test('a fixed off-the-hour minute with a repeating hour', () => {
    // `17 * * * *` fires at 17 past every hour; the list would need a phrase
    // for "past the hour" that no surface has agreed on yet, so it stays raw.
    expect(describeCron('17 * * * *')).toBe('');
    expect(describeCron('17 9-17 * * *')).toBe('');
    expect(describeCron('5 5 5 5 5')).toBe('');
  });
  test('tolerates surrounding and repeated whitespace', () => {
    expect(describeCron('  0   9  *  *  * ')).toBe('every day at 9am');
  });
});
