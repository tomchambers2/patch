// User-defined grouping within a Jobs list section (spec/08 § Groups,
// spec/14 § Jobs view) — a different axis from jobGroups.test.ts's
// recurring/one-off/expired/archived status split.
import { describe, it, expect } from 'vitest';
import { groupByUserGroup, type UserGroupableJob } from '../lib/jobUserGroups';

type TestJob = UserGroupableJob & { id: string };

describe('groupByUserGroup', () => {
  it('an all-ungrouped list is one bucket keyed null', () => {
    const jobs: TestJob[] = [{ id: 'a' }, { id: 'b' }];
    const buckets = groupByUserGroup(jobs);
    expect(buckets).toEqual([{ group: null, jobs }]);
  });

  it('an empty group string reads the same as no group at all', () => {
    const jobs: TestJob[] = [{ id: 'a', group: '' }];
    expect(groupByUserGroup(jobs)).toEqual([{ group: null, jobs }]);
  });

  it('splits jobs into buckets by their group', () => {
    const home: TestJob = { id: 'h', group: 'Home' };
    const finance: TestJob = { id: 'f', group: 'Finance' };
    const buckets = groupByUserGroup([home, finance]);
    expect(buckets).toEqual([
      { group: 'Home', jobs: [home] },
      { group: 'Finance', jobs: [finance] },
    ]);
  });

  it('buckets are ordered by first appearance in the incoming (already-sorted) list', () => {
    const a1: TestJob = { id: 'a1', group: 'B' };
    const a2: TestJob = { id: 'a2', group: 'A' };
    const a3: TestJob = { id: 'a3', group: 'B' };
    const buckets = groupByUserGroup([a1, a2, a3]);
    expect(buckets.map((b) => b.group)).toEqual(['B', 'A']);
    expect(buckets[0]?.jobs.map((j) => j.id)).toEqual(['a1', 'a3']);
  });

  it('the ungrouped bucket is always drawn last, regardless of where it first appears', () => {
    const ungrouped: TestJob = { id: 'u' };
    const home: TestJob = { id: 'h', group: 'Home' };
    const buckets = groupByUserGroup([ungrouped, home]);
    expect(buckets.map((b) => b.group)).toEqual(['Home', null]);
  });

  it("preserves each job's order within its own bucket", () => {
    const h1: TestJob = { id: 'h1', group: 'Home' };
    const f1: TestJob = { id: 'f1', group: 'Finance' };
    const h2: TestJob = { id: 'h2', group: 'Home' };
    const buckets = groupByUserGroup([h1, f1, h2]);
    const home = buckets.find((b) => b.group === 'Home');
    expect(home?.jobs.map((j) => j.id)).toEqual(['h1', 'h2']);
  });

  it('an empty list gives an empty bucket list, never undefined', () => {
    expect(groupByUserGroup([] as TestJob[])).toEqual([]);
  });
});
