// Jobs-list search filter (spec/15 § Jobs screen). Pure, instant, local.

import { describe, it, expect } from 'vitest';
import { filterJobs, type SearchableJob } from '../src/lib/jobsFilter';

const JOBS: SearchableJob[] = [
  {
    id: 'job_morning',
    name: 'Morning brief',
    triggerType: 'cron',
    cron: '0 7 * * *',
    subtitle: 'Every day at 07:00',
  },
  {
    id: 'job_deploy',
    name: 'Deploy pending',
    triggerType: 'cron',
    cron: '*/5 * * * *',
    subtitle: 'Every 5 minutes',
  },
  { id: 'job_hook', name: 'Todoist inbox', triggerType: 'webhook', subtitle: 'webhook' },
  { id: 'job_unnamed', triggerType: 'webhook', subtitle: 'webhook' },
];

describe('filterJobs', () => {
  it('returns every job for an empty query', () => {
    expect(filterJobs(JOBS, '')).toEqual(JOBS);
    expect(filterJobs(JOBS, '   ')).toEqual(JOBS);
  });

  it('returns a COPY, never the caller’s array', () => {
    const out = filterJobs(JOBS, '');
    expect(out).not.toBe(JOBS);
  });

  it('matches on name, case-insensitively', () => {
    expect(filterJobs(JOBS, 'morning').map((j) => j.id)).toEqual(['job_morning']);
    expect(filterJobs(JOBS, 'MORNING').map((j) => j.id)).toEqual(['job_morning']);
  });

  it('matches on a substring of the name', () => {
    expect(filterJobs(JOBS, 'depl').map((j) => j.id)).toEqual(['job_deploy']);
  });

  it('matches on the job id, so an unnamed job is still findable', () => {
    expect(filterJobs(JOBS, 'unnamed').map((j) => j.id)).toEqual(['job_unnamed']);
  });

  it('matches on the trigger type', () => {
    expect(filterJobs(JOBS, 'webhook').map((j) => j.id)).toEqual(['job_hook', 'job_unnamed']);
  });

  it('matches on the cron expression', () => {
    expect(filterJobs(JOBS, '*/5').map((j) => j.id)).toEqual(['job_deploy']);
  });

  it('matches on the human trigger summary shown on the row', () => {
    expect(filterJobs(JOBS, '07:00').map((j) => j.id)).toEqual(['job_morning']);
  });

  it('matches on the action label (verb + target), so a skill name finds its job', () => {
    const withAction: SearchableJob[] = [
      ...JOBS,
      {
        id: 'job_life_coach',
        name: 'Weekly check-in',
        triggerType: 'cron',
        actionLabel: 'spawn · skill life-coach · /home/tom/p',
      },
    ];
    expect(filterJobs(withAction, 'life-coach').map((j) => j.id)).toEqual(['job_life_coach']);
  });

  it('trims the query before matching', () => {
    expect(filterJobs(JOBS, '  morning  ').map((j) => j.id)).toEqual(['job_morning']);
  });

  it('returns nothing when no job matches', () => {
    expect(filterJobs(JOBS, 'zzzz')).toEqual([]);
  });

  it('keeps the incoming order — no ranking', () => {
    expect(filterJobs(JOBS, 'o').map((j) => j.id)).toEqual([
      'job_morning',
      'job_deploy',
      'job_hook',
      'job_unnamed',
    ]);
  });
});
