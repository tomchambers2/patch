// filterJobs — structured narrowing on the Jobs list (spec/14 § Jobs view).
// A filter: criteria in, list out.

import { describe, it, expect } from 'vitest';
import {
  filterJobs,
  isJobFilterActive,
  JOB_STATUS_FILTERS,
  JOB_TRIGGER_FILTERS,
  NO_JOB_FILTER,
  type FilterableJob,
  type JobFilter,
} from '../lib/jobFilter.js';

function job(name: string, enabled: boolean, trigger: string): FilterableJob & { name: string } {
  return { name, enabled, trigger: { type: trigger } };
}

const ALL = [
  job('cron-on', true, 'cron'),
  job('cron-off', false, 'cron'),
  job('hook-on', true, 'webhook'),
  job('todoist-off', false, 'todoist'),
];

const names = (jobs: Array<{ name: string }>): string[] => jobs.map((j) => j.name);

function filter(partial: Partial<JobFilter>): JobFilter {
  return { ...NO_JOB_FILTER, ...partial };
}

describe('filterJobs', () => {
  it('narrows nothing when both axes are "all"', () => {
    expect(names(filterJobs(ALL, NO_JOB_FILTER))).toEqual(names(ALL));
  });

  it('narrows to enabled jobs', () => {
    expect(names(filterJobs(ALL, filter({ status: 'enabled' })))).toEqual(['cron-on', 'hook-on']);
  });

  it('narrows to disabled jobs', () => {
    expect(names(filterJobs(ALL, filter({ status: 'disabled' })))).toEqual([
      'cron-off',
      'todoist-off',
    ]);
  });

  it('narrows to each trigger type', () => {
    expect(names(filterJobs(ALL, filter({ trigger: 'cron' })))).toEqual(['cron-on', 'cron-off']);
    expect(names(filterJobs(ALL, filter({ trigger: 'webhook' })))).toEqual(['hook-on']);
    expect(names(filterJobs(ALL, filter({ trigger: 'todoist' })))).toEqual(['todoist-off']);
  });

  it('composes the two axes by AND', () => {
    expect(names(filterJobs(ALL, { status: 'disabled', trigger: 'cron' }))).toEqual(['cron-off']);
    expect(filterJobs(ALL, { status: 'enabled', trigger: 'todoist' })).toEqual([]);
  });

  it('composes with a search that has already been applied (AND over both)', () => {
    // The route searches first and filters the survivors; the composition is
    // the intersection either way round.
    const searched = ALL.filter((j) => j.name.includes('cron'));
    expect(names(filterJobs(searched, filter({ status: 'enabled' })))).toEqual(['cron-on']);
    const filtered = filterJobs(ALL, filter({ status: 'enabled' }));
    expect(names(filtered.filter((j) => j.name.includes('cron')))).toEqual(['cron-on']);
  });

  it('preserves the incoming order', () => {
    expect(names(filterJobs(ALL, filter({ status: 'enabled' })))).toEqual(
      names(ALL.filter((j) => j.enabled)),
    );
  });

  it('does not mutate the list it was given', () => {
    const before = names(ALL);
    filterJobs(ALL, filter({ status: 'enabled' }));
    expect(names(ALL)).toEqual(before);
  });
});

describe('isJobFilterActive', () => {
  it('is false only when neither axis narrows', () => {
    expect(isJobFilterActive(NO_JOB_FILTER)).toBe(false);
    expect(isJobFilterActive(filter({ status: 'enabled' }))).toBe(true);
    expect(isJobFilterActive(filter({ trigger: 'cron' }))).toBe(true);
    expect(isJobFilterActive({ status: 'disabled', trigger: 'webhook' })).toBe(true);
  });
});

describe('filter options', () => {
  it('offers every status and every trigger type, each leading with its "any" row', () => {
    expect(JOB_STATUS_FILTERS.map((o) => o.value)).toEqual(['all', 'enabled', 'disabled']);
    expect(JOB_STATUS_FILTERS[0]?.label).toBe('Any status');
    expect(JOB_TRIGGER_FILTERS.map((o) => o.value)).toEqual([
      'all',
      'cron',
      'recurrence',
      'webhook',
      'todoist',
    ]);
    expect(JOB_TRIGGER_FILTERS[0]?.label).toBe('Any trigger');
  });
});
