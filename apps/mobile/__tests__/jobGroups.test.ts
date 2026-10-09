// Jobs tab's four status sections (spec/15 § Jobs screen, spec/08 §§
// One-off jobs, Archived jobs). Mirrors packages/web/src/lib/jobGroups.ts's
// own test coverage.

import { describe, it, expect } from 'vitest';
import { groupJobs, isArchivedJob, isExpiredJob, type GroupableJob } from '../src/lib/jobGroups';

describe('groupJobs', () => {
  it('splits into recurring / one-off / expired / archived, preserving order', () => {
    const jobs: GroupableJob[] = [
      { oneOff: false },
      { oneOff: true },
      { expiredAt: 100 },
      { archived: true },
      { oneOff: false },
    ];
    const groups = groupJobs(jobs);
    expect(groups.recurring).toEqual([jobs[0], jobs[4]]);
    expect(groups.oneOff).toEqual([jobs[1]]);
    expect(groups.expired).toEqual([jobs[2]]);
    expect(groups.archived).toEqual([jobs[3]]);
  });

  it('archived outranks expired for a job that is both', () => {
    const job: GroupableJob = { archived: true, expiredAt: 100 };
    const groups = groupJobs([job]);
    expect(groups.archived).toEqual([job]);
    expect(groups.expired).toEqual([]);
  });

  it('a job with an expiredAt reads as expired even with oneOff cleared', () => {
    const job: GroupableJob = { oneOff: false, expiredAt: 5 };
    expect(isExpiredJob(job)).toBe(true);
  });

  it('isArchivedJob is false for an absent flag', () => {
    expect(isArchivedJob({})).toBe(false);
  });

  it('an empty list produces four empty sections', () => {
    const groups = groupJobs([]);
    expect(groups).toEqual({ recurring: [], oneOff: [], expired: [], archived: [] });
  });
});
