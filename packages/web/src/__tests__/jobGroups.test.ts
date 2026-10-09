// The Jobs list's three sections (spec/14 § Jobs view, spec/08 § One-off jobs):
// recurring, one-off not yet fired, then expired.
import { describe, it, expect } from 'vitest';
import { groupJobs, isArchivedJob, isExpiredJob, type GroupableJob } from '../lib/jobGroups';

// `GroupableJob`'s fields are all optional, so a bare `{ id }` trips TS's
// weak-type check — the grouping is meant to be used on whole job rows, which
// is what this stand-in models.
type TestJob = GroupableJob & { id: string };

const recurring: TestJob = { id: 'r' };
const pending: TestJob = { id: 'p', oneOff: true };
const expired: TestJob = { id: 'e', oneOff: true, expiredAt: 1717 };

describe('isExpiredJob', () => {
  it('is exactly "carries an expiredAt"', () => {
    expect(isExpiredJob({})).toBe(false);
    expect(isExpiredJob({ oneOff: true })).toBe(false);
    expect(isExpiredJob({ oneOff: true, expiredAt: 1 })).toBe(true);
    // A zero stamp is still a stamp — presence, not truthiness.
    expect(isExpiredJob({ oneOff: true, expiredAt: 0 })).toBe(true);
  });

  it('a job that expired and was then made recurring still reads as expired', () => {
    expect(isExpiredJob({ oneOff: false, expiredAt: 5 })).toBe(true);
  });
});

describe('groupJobs', () => {
  it('splits the three kinds', () => {
    const g = groupJobs([recurring, pending, expired]);
    expect(g.recurring).toEqual([recurring]);
    expect(g.oneOff).toEqual([pending]);
    expect(g.expired).toEqual([expired]);
  });

  it('an all-recurring list leaves both one-off groups empty', () => {
    const all: TestJob[] = [{ id: 'a' }, { id: 'b' }, { id: 'c', oneOff: false }];
    const g = groupJobs(all);
    expect(g.recurring).toHaveLength(3);
    expect(g.oneOff).toEqual([]);
    expect(g.expired).toEqual([]);
  });

  it('an empty list gives four empty groups, never undefined', () => {
    const g = groupJobs([] as TestJob[]);
    expect(g).toEqual({ recurring: [], oneOff: [], expired: [], archived: [] });
  });

  it('preserves the incoming order within each group', () => {
    const a: TestJob = { id: 'a', oneOff: true, expiredAt: 3 };
    const b: TestJob = { id: 'b', oneOff: true, expiredAt: 1 };
    const c: TestJob = { id: 'c', oneOff: true, expiredAt: 2 };
    // Sorting is the caller's business — the list arrives already ordered.
    expect(groupJobs([a, b, c]).expired.map((j) => j.id)).toEqual(['a', 'b', 'c']);
  });

  it('an expired job never also appears in the one-off group', () => {
    const g = groupJobs([expired]);
    expect(g.oneOff).toEqual([]);
    expect(g.expired).toEqual([expired]);
  });
});

// --- archived (spec/08 § Archived jobs, spec/14 § Jobs view) ----------------

const archived: TestJob = { id: 'a', archived: true };

describe('isArchivedJob', () => {
  it('is exactly "archived === true"', () => {
    expect(isArchivedJob({})).toBe(false);
    expect(isArchivedJob({ archived: false })).toBe(false);
    expect(isArchivedJob({ archived: true })).toBe(true);
  });
});

describe('groupJobs with archived jobs', () => {
  it('archived jobs get their own group, after the other three', () => {
    const g = groupJobs([recurring, pending, expired, archived]);
    expect(g.recurring).toEqual([recurring]);
    expect(g.oneOff).toEqual([pending]);
    expect(g.expired).toEqual([expired]);
    expect(g.archived).toEqual([archived]);
  });

  it('an archived recurring job leaves the recurring group', () => {
    const g = groupJobs([{ id: 'r2', archived: true }]);
    expect(g.recurring).toEqual([]);
    expect(g.archived).toHaveLength(1);
  });

  // Archived is the deliberate act; expired is a job having run its course.
  it('a job that is both archived and expired reads as archived only', () => {
    const both: TestJob = { id: 'b', oneOff: true, expiredAt: 9, archived: true };
    const g = groupJobs([both]);
    expect(g.archived).toEqual([both]);
    expect(g.expired).toEqual([]);
  });
});
