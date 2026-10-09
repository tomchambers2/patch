// Jobs tab status/trigger filters (spec/15 § Jobs screen). Mirrors
// packages/web/src/lib/jobFilter.ts's own test coverage.

import { describe, it, expect } from 'vitest';
import {
  filterJobsByStatus,
  isJobFilterActive,
  NO_JOB_FILTER,
  type FilterableJob,
} from '../src/lib/jobStatusFilter';

const JOBS: FilterableJob[] = [
  { enabled: true, triggerType: 'cron' },
  { enabled: false, triggerType: 'webhook' },
  { enabled: true, triggerType: 'todoist' },
];

describe('filterJobsByStatus', () => {
  it('the no-op filter keeps everything', () => {
    expect(filterJobsByStatus(JOBS, NO_JOB_FILTER)).toEqual(JOBS);
    expect(isJobFilterActive(NO_JOB_FILTER)).toBe(false);
  });

  it('narrows by status', () => {
    expect(filterJobsByStatus(JOBS, { status: 'enabled', trigger: 'all' })).toHaveLength(2);
    expect(filterJobsByStatus(JOBS, { status: 'disabled', trigger: 'all' })).toHaveLength(1);
  });

  it('narrows by trigger type', () => {
    expect(filterJobsByStatus(JOBS, { status: 'all', trigger: 'webhook' })).toEqual([JOBS[1]]);
  });

  it('composes both axes by AND', () => {
    expect(filterJobsByStatus(JOBS, { status: 'enabled', trigger: 'todoist' })).toEqual([JOBS[2]]);
  });

  it('isJobFilterActive is true when either axis narrows', () => {
    expect(isJobFilterActive({ status: 'enabled', trigger: 'all' })).toBe(true);
    expect(isJobFilterActive({ status: 'all', trigger: 'cron' })).toBe(true);
  });
});
