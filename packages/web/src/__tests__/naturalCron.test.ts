import { describe, it, expect } from 'vitest';
import { describeCron as wireDescribeCron } from '@patch/wire';
import { parseNaturalSchedule, describeCron } from '../lib/naturalCron.js';

describe('parseNaturalSchedule', () => {
  it.each([
    ['every day at 9am', '0 9 * * *'],
    ['8am every day', '0 8 * * *'],
    ['8:30am every weekday', '30 8 * * 1-5'],
    ['5pm mondays', '0 17 * * 1'],
    ['17:30 daily', '30 17 * * *'],
    ['noon every day', '0 12 * * *'],
    ['daily at 09:00', '0 9 * * *'],
    ['at 9am', '0 9 * * *'],
    ['every day at 5:30pm', '30 17 * * *'],
    ['every weekday at 9am', '0 9 * * 1-5'],
    ['weekdays at 8:30', '30 8 * * 1-5'],
    ['every weekend at 10am', '0 10 * * 0,6'],
    ['every monday at 8:30', '30 8 * * 1'],
    ['mondays at 8', '0 8 * * 1'],
    ['monday and thursday at 9am', '0 9 * * 1,4'],
    // Several exact times sharing a minute → comma-separated hour field.
    ['every day at 9am and 10pm', '0 9,22 * * *'],
    ['at 9am, 1pm and 10pm', '0 9,13,22 * * *'],
    ['every day at 10pm and 9am', '0 9,22 * * *'],
    ['every weekday at 8:30am and 5:30pm', '30 8,17 * * 1-5'],
    ['at 9am and 9am', '0 9 * * *'],
    ['at noon and midnight', '0 0,12 * * *'],
    ['every 15 minutes', '*/15 * * * *'],
    ['every minute', '* * * * *'],
    ['every 2 hours', '0 */2 * * *'],
    ['hourly', '0 * * * *'],
    ['at noon', '0 12 * * *'],
    ['every day at midnight', '0 0 * * *'],
    // Time-range windows (hour range is inclusive of the end hour).
    ['every 5 minutes between 9am and 5pm', '*/5 9-17 * * *'],
    ['every 15 minutes from 8am to 6pm', '*/15 8-18 * * *'],
    ['every minute between 9am and 5pm', '* 9-17 * * *'],
    ['every hour between 9am and 5pm', '0 9-17 * * *'],
    ['every 2 hours between 9am and 5pm', '0 9-17/2 * * *'],
    // Window + day-of-week combined.
    ['every 5 minutes between 9am and 5pm on weekdays', '*/5 9-17 * * 1-5'],
    // Interval + day-of-week without a window.
    ['every 10 minutes on weekdays', '*/10 * * * 1-5'],
  ])('parses %j → %j', (input, cron) => {
    expect(parseNaturalSchedule(input)).toBe(cron);
  });

  it('returns null for things it cannot parse confidently', () => {
    expect(parseNaturalSchedule('')).toBeNull();
    expect(parseNaturalSchedule('whenever I feel like it')).toBeNull();
    expect(parseNaturalSchedule('every 90 minutes')).toBeNull(); // out of 1-59 range
    expect(parseNaturalSchedule('at 25:00')).toBeNull();
  });

  it('returns null when a day phrase comes with an ambiguous bare-number time, not midnight', () => {
    expect(parseNaturalSchedule('9 every day')).toBeNull();
    expect(parseNaturalSchedule('17 every day')).toBeNull();
  });

  it('returns null when listed times do not share a minute (not expressible in one cron)', () => {
    expect(parseNaturalSchedule('every day at 9am and 10:30pm')).toBeNull();
    expect(parseNaturalSchedule('at 8:15am, 1pm')).toBeNull();
  });

  it('renders a multi-time schedule in the live preview', () => {
    expect(describeCron(parseNaturalSchedule('every day at 9am and 10pm')!)).toBe(
      'at 9am and 10pm',
    );
  });

  it('returns null when the "at" time has an unparseable extra colon segment', () => {
    // atMatch's character class [0-9: ] permits a second colon, but parseTime's
    // own regex only allows one optional :MM group — parseTime returns null,
    // and there's no trailing am/pm time either, so parsing fails overall.
    expect(parseNaturalSchedule('at 12:34:56')).toBeNull();
  });

  it('treats 12am as midnight and 12pm as noon via the numeric time parser', () => {
    expect(parseNaturalSchedule('at 12am')).toBe('0 0 * * *');
    expect(parseNaturalSchedule('at 12pm')).toBe('0 12 * * *');
  });

  it('defaults to midnight when a day phrase has no explicit time', () => {
    expect(parseNaturalSchedule('every monday')).toBe('0 0 * * 1');
  });

  it('parses a trailing time with no "at" when a daily phrase is present', () => {
    expect(parseNaturalSchedule('every day 5:30pm')).toBe('30 17 * * *');
  });

  it('rejects a time window that would wrap past midnight (start hour after end hour)', () => {
    // No other recognisable shape (no "every N", no day phrase, no "at ") so
    // the invalid window causes the whole phrase to fail.
    expect(parseNaturalSchedule('between 5pm and 9am')).toBeNull();
  });

  it('rejects a time window whose start or end time cannot be parsed', () => {
    // 25:00 fails parseTime's h>23 guard, so the window itself parses to null.
    expect(parseNaturalSchedule('between 25:00 and 5pm')).toBeNull();
  });
});

// describeCron is no longer implemented here — `naturalCron.ts` re-exports the
// single describer from @patch/wire (the exhaustive phrasing table lives in
// packages/wire/test/cron-describe.test.ts). These cases stay because they are
// the editor's own round-trip contract: what parseNaturalSchedule emits above
// must come back out as the phrase the preview shows.
describe('describeCron', () => {
  it('is the shared describer from @patch/wire, not a local copy', () => {
    expect(describeCron).toBe(wireDescribeCron);
  });

  it.each([
    ['0 9 * * *', 'every day at 9am'],
    ['30 17 * * *', 'every day at 5:30pm'],
    ['0 9 * * 1-5', 'weekdays at 9am'],
    ['0 10 * * 0,6', 'weekends at 10am'],
    ['30 8 * * 1', 'Mondays at 8:30am'],
    ['*/15 * * * *', 'every 15 minutes'],
    ['0 * * * *', 'every hour'],
    ['0 */2 * * *', 'every 2 hours'],
    // Windowed shapes round-trip back to readable phrases.
    ['*/5 9-17 * * *', 'every 5 minutes between 9am and 5pm'],
    ['* 9-17 * * *', 'every minute between 9am and 5pm'],
    ['0 9-17 * * *', 'every hour between 9am and 5pm'],
    ['0 9-17/2 * * *', 'every 2 hours between 9am and 5pm'],
    ['*/5 9-17 * * 1-5', 'every 5 minutes between 9am and 5pm on weekdays'],
    ['*/10 * * * 1-5', 'every 10 minutes on weekdays'],
  ])('describes %j \u2192 %j', (cron, text) => {
    expect(describeCron(cron)).toBe(text);
  });

  it('returns empty string for unfamiliar shapes', () => {
    expect(describeCron('5 4 1 1 *')).toBe('');
    expect(describeCron('not a cron')).toBe('');
  });

  it('refuses an out-of-range day-of-week rather than dropping it from the phrase', () => {
    // dow=9 does not exist. The old describer silently omitted the "on ..."
    // suffix and returned a confident phrase for a schedule it had not read.
    expect(describeCron('*/5 9-17 * * 9')).toBe('');
    expect(describeCron('*/5 * * * 8')).toBe('');
  });

  it('formats midnight/noon window bounds', () => {
    expect(describeCron('*/5 0-17 * * *')).toBe('every 5 minutes between midnight and 5pm');
    expect(describeCron('*/5 9-12 * * *')).toBe('every 5 minutes between 9am and noon');
  });

  it('recognises the "6,0" ordering of the weekend day-of-week pair in a window', () => {
    expect(describeCron('*/5 9-17 * * 6,0')).toBe(
      'every 5 minutes between 9am and 5pm on weekends',
    );
  });

  it('joins a custom multi-day list in a windowed/interval phrase', () => {
    expect(describeCron('*/5 9-17 * * 1,3,5')).toBe(
      'every 5 minutes between 9am and 5pm on Monday, Wednesday, Friday',
    );
  });

  it('uses singular "hour" for a windowed hourly step of exactly 1', () => {
    expect(describeCron('0 9-17/1 * * *')).toBe('every 1 hour between 9am and 5pm');
  });

  it('uses singular "minute" for a non-windowed */1 interval', () => {
    expect(describeCron('*/1 * * * *')).toBe('every 1 minute');
  });

  it('describes the bare "every minute" shape (no window, all fields wildcard)', () => {
    expect(describeCron('* * * * *')).toBe('every minute');
  });

  it('uses singular "hour" for a non-windowed */1 hourly interval', () => {
    expect(describeCron('0 */1 * * *')).toBe('every 1 hour');
  });

  it('joins a custom multi-day list in the fixed time-of-day shape', () => {
    expect(describeCron('30 8 * * 1,4')).toBe('Monday, Thursday at 8:30am');
  });

  it('falls back to "" for an out-of-range day-of-week in the fixed time-of-day shape', () => {
    expect(describeCron('30 8 * * 9')).toBe('');
  });
});
