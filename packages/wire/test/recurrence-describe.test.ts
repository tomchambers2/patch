// spec/08 § Recurrence — the ONE natural-language renderer for a
// RecurrenceTrigger's RRULE. Mirrors cron-describe.test.ts's structure:
// spot-check the shapes the structured editor produces render as clean
// English, and confirm shapes outside that narrow contract fall back to ''
// (raw RRULE) rather than a guessed phrase.

import { describe, test, expect } from 'vitest';
import { describeRecurrence, parseRecurrenceFields } from '../src/recurrence-describe.js';

describe('describeRecurrence — confidently-phrased shapes', () => {
  test.each([
    [
      'every 3rd Sunday, May through August at 9am',
      'FREQ=MONTHLY;BYDAY=SU;BYSETPOS=3;BYMONTH=5,6,7,8;BYHOUR=9;BYMINUTE=0',
      'every 3rd Sunday, May through August at 9am',
    ],
    [
      'every Sunday at 9am (plain weekly)',
      'FREQ=WEEKLY;BYDAY=SU;BYHOUR=9;BYMINUTE=0',
      'Sundays at 9am',
    ],
    [
      'Monday and Wednesday at 8:15am (multi-day weekly)',
      'FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=8;BYMINUTE=15',
      'Monday and Wednesday at 8:15am',
    ],
    [
      'last Friday of every month at 5pm',
      'FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1;BYHOUR=17;BYMINUTE=0',
      'every last Friday, every month at 5pm',
    ],
    [
      '1st Monday of January and March at 9am (non-contiguous months → list, not a range)',
      'FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1;BYMONTH=1,3;BYHOUR=9;BYMINUTE=0',
      'every 1st Monday, January and March at 9am',
    ],
    [
      'yearly 2nd Tuesday of June at noon',
      'FREQ=YEARLY;BYDAY=TU;BYSETPOS=2;BYMONTH=6;BYHOUR=12;BYMINUTE=0',
      'every year on the 2nd Tuesday of June at 12pm',
    ],
  ])('%s', (_label, rrule, expected) => {
    expect(describeRecurrence(rrule)).toBe(expected);
  });
});

describe('describeRecurrence — refuses rather than guesses', () => {
  test.each([
    [
      'a COUNT-bounded rule (stops firing — no clause for that)',
      'FREQ=WEEKLY;BYDAY=SU;BYHOUR=9;BYMINUTE=0;COUNT=5',
    ],
    ['an UNTIL-bounded rule', 'FREQ=WEEKLY;BYDAY=SU;BYHOUR=9;BYMINUTE=0;UNTIL=20300101T000000Z'],
    [
      'INTERVAL other than 1 ("every other Sunday")',
      'FREQ=WEEKLY;BYDAY=SU;BYHOUR=9;BYMINUTE=0;INTERVAL=2',
    ],
    ['a BYMONTHDAY rule (not attempted)', 'FREQ=MONTHLY;BYMONTHDAY=15;BYHOUR=9;BYMINUTE=0'],
    [
      'a weekly rule restricted to some months (no clean short phrase)',
      'FREQ=WEEKLY;BYDAY=SU;BYMONTH=5,6;BYHOUR=9;BYMINUTE=0',
    ],
    [
      'a monthly nth-weekday rule with TWO weekdays ("3rd Sunday or Monday" has no single reading)',
      'FREQ=MONTHLY;BYDAY=SU,MO;BYSETPOS=3;BYHOUR=9;BYMINUTE=0',
    ],
    [
      'a yearly rule with no BYMONTH ("3rd Sunday of the year")',
      'FREQ=YEARLY;BYDAY=SU;BYSETPOS=3;BYHOUR=9;BYMINUTE=0',
    ],
    ['a FREQ this describer does not cover', 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0'],
    ['malformed key=value syntax', 'not a valid rrule string'],
    ['a repeated key (no single meaning)', 'FREQ=WEEKLY;BYDAY=SU;BYDAY=MO;BYHOUR=9;BYMINUTE=0'],
    ['no BYHOUR/BYMINUTE at all', 'FREQ=WEEKLY;BYDAY=SU'],
  ])('%s', (_label, rrule) => {
    expect(describeRecurrence(rrule)).toBe('');
  });
});

describe('parseRecurrenceFields — the structured editor’s own contract', () => {
  test('every rrule describeRecurrence phrases has a non-null parse', () => {
    const rrule = 'FREQ=MONTHLY;BYDAY=SU;BYSETPOS=3;BYMONTH=5,6,7,8;BYHOUR=9;BYMINUTE=0';
    const parsed = parseRecurrenceFields(rrule);
    expect(parsed).toEqual({
      freq: 'MONTHLY',
      days: ['SU'],
      setPos: 3,
      months: [5, 6, 7, 8],
      hour: 9,
      minute: 0,
    });
  });

  test('a plain weekly rule parses with setPos/months null', () => {
    const parsed = parseRecurrenceFields('FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=8;BYMINUTE=15');
    expect(parsed).toEqual({
      freq: 'WEEKLY',
      days: ['MO', 'WE'],
      setPos: null,
      months: null,
      hour: 8,
      minute: 15,
    });
  });

  test('every rrule describeRecurrence refuses also fails to parse', () => {
    for (const rrule of [
      'FREQ=WEEKLY;BYDAY=SU;BYHOUR=9;BYMINUTE=0;COUNT=5',
      'FREQ=YEARLY;BYDAY=SU;BYSETPOS=3;BYHOUR=9;BYMINUTE=0',
      'not a valid rrule string',
    ]) {
      expect(parseRecurrenceFields(rrule)).toBeNull();
    }
  });
});
