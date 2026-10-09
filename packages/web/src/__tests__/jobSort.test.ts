// sortJobs — how the Jobs list is ordered within a section (spec/14 § Jobs
// view). A ranker: criteria in, list out.

import { describe, it, expect } from 'vitest';
import { sortJobs, JOB_SORTS, DEFAULT_JOB_SORT, type SortableJob } from '../lib/jobSort.js';

function job(
  name: string,
  createdAt: number,
  firedAt: number | null,
): SortableJob & { id: string } {
  return {
    id: name,
    name,
    createdAt,
    latestRun: firedAt === null ? null : { ts: firedAt },
  };
}

const names = (jobs: Array<{ name: string }>): string[] => jobs.map((j) => j.name);

describe('sortJobs', () => {
  it('last-fired puts the most recent fire first', () => {
    const jobs = [job('old', 1, 100), job('new', 2, 300), job('mid', 3, 200)];
    expect(names(sortJobs(jobs, 'last-fired'))).toEqual(['new', 'mid', 'old']);
  });

  it('last-fired sorts never-fired jobs last, however recently they were created', () => {
    const jobs = [job('never', 999, null), job('fired', 1, 100)];
    expect(names(sortJobs(jobs, 'last-fired'))).toEqual(['fired', 'never']);
  });

  it('last-fired ranks never below a fire at timestamp 0, not alongside it', () => {
    const jobs = [job('never', 1, null), job('epoch', 2, 0)];
    expect(names(sortJobs(jobs, 'last-fired'))).toEqual(['epoch', 'never']);
  });

  it('last-fired keeps two never-fired jobs in the order they arrived', () => {
    // Two absent timestamps must not subtract to NaN and scramble the list.
    const jobs = [job('a', 1, null), job('b', 2, null), job('c', 3, null)];
    expect(names(sortJobs(jobs, 'last-fired'))).toEqual(['a', 'b', 'c']);
  });

  it('last-fired treats an absent latestRun the same as an explicit null', () => {
    const jobs: SortableJob[] = [{ name: 'absent', createdAt: 1 }, job('fired', 2, 50)];
    expect(names(sortJobs(jobs, 'last-fired'))).toEqual(['fired', 'absent']);
  });

  it('name sorts A-Z, case-insensitively', () => {
    const jobs = [job('zebra', 1, null), job('Apple', 2, null), job('mango', 3, null)];
    expect(names(sortJobs(jobs, 'name'))).toEqual(['Apple', 'mango', 'zebra']);
  });

  it('name uses a locale compare, not a codepoint compare', () => {
    // 'é' sorts between 'e' and 'f' by locale; by codepoint it lands after 'z'.
    const jobs = [job('zulu', 1, null), job('éclair', 2, null), job('foxtrot', 3, null)];
    expect(names(sortJobs(jobs, 'name'))).toEqual(['éclair', 'foxtrot', 'zulu']);
  });

  it('created puts the newest job first', () => {
    const jobs = [job('first', 100, null), job('third', 300, null), job('second', 200, null)];
    expect(names(sortJobs(jobs, 'created'))).toEqual(['third', 'second', 'first']);
  });

  it('does not mutate the list it was given', () => {
    const jobs = [job('b', 2, 1), job('a', 1, 2)];
    const before = names(jobs);
    sortJobs(jobs, 'name');
    expect(names(jobs)).toEqual(before);
  });

  it('handles an empty list on every sort', () => {
    for (const { value } of JOB_SORTS) expect(sortJobs([], value)).toEqual([]);
  });

  it('offers exactly the three orders, and defaults to last fired', () => {
    expect(JOB_SORTS.map((o) => o.value)).toEqual(['last-fired', 'name', 'created']);
    expect(JOB_SORTS.map((o) => o.label)).toEqual(['Last fired', 'Name', 'Created']);
    expect(DEFAULT_JOB_SORT).toBe('last-fired');
  });
});
