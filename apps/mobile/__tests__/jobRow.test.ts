// The schedule subtitle a job row shows (spec/15 § Settings tab — Jobs).
//
// A cron job's label is ambiguous unless the reader can tell which zone it is
// in: Tom's pre-timezone jobs read "9am" on the row and fired at 10:00 BST.

import { describe, it, expect } from 'vitest';
import { cronRowSubtitle } from '../src/lib/jobRow';

describe('cronRowSubtitle', () => {
  it('reads as plain English when the job runs in the viewer’s own zone', () => {
    expect(cronRowSubtitle('0 9 * * *', 'Europe/London', 'Europe/London')).toBe('every day at 9am');
  });

  it('names the zone when the job runs somewhere else', () => {
    expect(cronRowSubtitle('0 9 * * *', 'Europe/London', 'America/New_York')).toBe(
      'every day at 9am · Europe/London',
    );
  });

  it('names UTC for a job carrying no zone, read from somewhere that is not UTC', () => {
    expect(cronRowSubtitle('0 9 * * *', undefined, 'Europe/London')).toBe('every day at 9am · UTC');
  });

  it('stays quiet about UTC for a viewer already in UTC', () => {
    expect(cronRowSubtitle('0 9 * * *', undefined, 'UTC')).toBe('every day at 9am');
  });

  it('qualifies the raw-expression fallback too, rather than dropping the zone with it', () => {
    expect(cronRowSubtitle('not a cron', 'Europe/London', 'UTC')).toBe(
      'not a cron · Europe/London',
    );
  });

  it('defaults the viewer zone to this runtime when none is passed', () => {
    // The box running this suite is UTC.
    expect(cronRowSubtitle('0 9 * * *', undefined)).toBe('every day at 9am');
    expect(cronRowSubtitle('0 9 * * *', 'Europe/London')).toBe('every day at 9am · Europe/London');
  });
});
