// Jobs tab sort control (spec/15 § Jobs screen). Mirrors
// packages/web/src/lib/jobSort.ts's own test coverage.

import { describe, it, expect } from 'vitest';
import { sortJobs, type SortableJob } from '../src/lib/jobSort';

const JOBS: SortableJob[] = [
  { name: 'Beta', createdAt: 10, latestRun: { ts: 100 } },
  { name: 'alpha', createdAt: 30, latestRun: null },
  { name: 'Gamma', createdAt: 20, latestRun: { ts: 200 } },
];

describe('sortJobs', () => {
  it('last-fired: newest fire first, never-fired last', () => {
    expect(sortJobs(JOBS, 'last-fired').map((j) => j.name)).toEqual(['Gamma', 'Beta', 'alpha']);
  });

  it('name: case-insensitive locale order', () => {
    expect(sortJobs(JOBS, 'name').map((j) => j.name)).toEqual(['alpha', 'Beta', 'Gamma']);
  });

  it('created: newest first', () => {
    expect(sortJobs(JOBS, 'created').map((j) => j.name)).toEqual(['alpha', 'Gamma', 'Beta']);
  });

  it('returns a copy, never the caller’s array', () => {
    const out = sortJobs(JOBS, 'name');
    expect(out).not.toBe(JOBS);
  });

  it('two never-fired jobs keep arrival order under last-fired (no NaN ordering)', () => {
    const both: SortableJob[] = [
      { name: 'A', createdAt: 1, latestRun: null },
      { name: 'B', createdAt: 2, latestRun: undefined },
    ];
    expect(sortJobs(both, 'last-fired').map((j) => j.name)).toEqual(['A', 'B']);
  });
});
