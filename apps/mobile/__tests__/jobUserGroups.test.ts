// The Jobs tab's user-defined group sub-headings within a status section
// (spec/08 § Groups, spec/15 § Jobs screen). Mirrors
// packages/web/src/lib/jobUserGroups.ts's own test coverage.

import { describe, it, expect } from 'vitest';
import { groupByUserGroup, type UserGroupableJob } from '../src/lib/jobUserGroups';

describe('groupByUserGroup', () => {
  it('buckets by group, ordered by first appearance, ungrouped last', () => {
    const jobs: UserGroupableJob[] = [
      { group: 'Home' },
      { group: undefined },
      { group: 'Finance' },
      { group: 'Home' },
      { group: '' },
    ];
    const buckets = groupByUserGroup(jobs);
    expect(buckets.map((b) => b.group)).toEqual(['Home', 'Finance', null]);
    expect(buckets[0]!.jobs).toHaveLength(2);
    expect(buckets[2]!.jobs).toHaveLength(2); // undefined AND '' both fall into null
  });

  it('an entirely ungrouped list is one bucket', () => {
    const jobs: UserGroupableJob[] = [{}, {}];
    const buckets = groupByUserGroup(jobs);
    expect(buckets).toEqual([{ group: null, jobs }]);
  });

  it('an entirely one-group list is one bucket, not split from ungrouped', () => {
    const jobs: UserGroupableJob[] = [{ group: 'Watchers' }, { group: 'Watchers' }];
    const buckets = groupByUserGroup(jobs);
    expect(buckets).toEqual([{ group: 'Watchers', jobs }]);
  });
});
