// A job as the SERVER hands it out (spec/08 ## Concurrency).
//
// `GET /api/jobs` and `GET /api/jobs/:id` attach the concurrency gate's live
// `inFlight`/`queued` counts to each job on the way out. Those are runtime
// state, never part of the stored definition, so `Job` itself must stay
// `.strict()` without them — a client that parses a response parses
// `JobWithCounts` instead. It is still strict: a genuinely unknown key is a
// server/client disagreement and must fail loudly, not be waved through.

import { describe, test, expect } from 'vitest';
import type { ZodIssue } from 'zod';
import { Job, JobWithCounts, JobListEntry, JobLatestRun, JobRunStatus } from '../src/jobs.js';

function refusedKeys(issues: ZodIssue[]): string[] {
  return issues.flatMap((i) => (i.code === 'unrecognized_keys' ? i.keys : []));
}

const STORED_JOB = {
  id: 'j_1',
  name: 'nightly digest',
  enabled: true,
  trigger: { type: 'cron', expression: '0 21 * * *' },
  filter: null,
  action: { type: 'spawn', daemonId: 'host-a', folder: '/tmp', prompt: 'go' },
  createdAt: 1,
  updatedAt: 2,
};

describe('JobWithCounts', () => {
  test('accepts a job carrying the server-attached counts', () => {
    const parsed = JobWithCounts.parse({ ...STORED_JOB, inFlight: 2, queued: 5 });
    expect(parsed.inFlight).toBe(2);
    expect(parsed.queued).toBe(5);
  });

  test('accepts a job with no counts — the server may have no dispatcher', () => {
    const parsed = JobWithCounts.parse(STORED_JOB);
    expect(parsed.inFlight).toBeUndefined();
    expect(parsed.queued).toBeUndefined();
  });

  test('still refuses a genuinely unknown key', () => {
    const r = JobWithCounts.safeParse({ ...STORED_JOB, inFlight: 0, nonsense: true });
    expect(r.success).toBe(false);
    expect(refusedKeys(r.error!.issues)).toContain('nonsense');
  });

  test('counts must be non-negative integers', () => {
    expect(JobWithCounts.safeParse({ ...STORED_JOB, queued: -1 }).success).toBe(false);
    expect(JobWithCounts.safeParse({ ...STORED_JOB, inFlight: 1.5 }).success).toBe(false);
  });

  test('the stored Job schema does NOT gain the counts', () => {
    const r = Job.safeParse({ ...STORED_JOB, inFlight: 1, queued: 0 });
    expect(r.success).toBe(false);
    expect(refusedKeys(r.error!.issues)).toEqual(expect.arrayContaining(['inFlight', 'queued']));
  });
});

// The LIST response carries one more piece of runtime state per job: its most
// recent fire, so the Jobs page draws a last-fired per row from the one
// request. It rides on the list schema alone — the single-job response stays
// exactly `JobWithCounts`, the strict shape it is spec'd as.
describe('JobListEntry', () => {
  test('accepts a job carrying its latest run, with the chat the fire landed in', () => {
    const parsed = JobListEntry.parse({
      ...STORED_JOB,
      queued: 1,
      latestRun: { ts: 1700, status: 'ok', chatId: 'c_1' },
    });
    expect(parsed.latestRun).toEqual({ ts: 1700, status: 'ok', chatId: 'c_1' });
  });

  test('accepts a fire that never landed in a chat', () => {
    const parsed = JobListEntry.parse({
      ...STORED_JOB,
      latestRun: { ts: 1700, status: 'dispatch-error' },
    });
    expect(parsed.latestRun?.chatId).toBeUndefined();
  });

  test('accepts null for a job that has never fired, and absent when unreported', () => {
    expect(JobListEntry.parse({ ...STORED_JOB, latestRun: null }).latestRun).toBeNull();
    expect(JobListEntry.parse(STORED_JOB).latestRun).toBeUndefined();
  });

  test('refuses an unknown key on the run and an outcome that is not a status', () => {
    const extra = JobListEntry.safeParse({
      ...STORED_JOB,
      latestRun: { ts: 1, status: 'ok', nonsense: true },
    });
    expect(extra.success).toBe(false);
    expect(refusedKeys(extra.error!.issues)).toContain('nonsense');
    expect(
      JobListEntry.safeParse({ ...STORED_JOB, latestRun: { ts: 1, status: 'exploded' } }).success,
    ).toBe(false);
  });

  test('JobWithCounts does NOT gain latestRun — the single-job response is unchanged', () => {
    const r = JobWithCounts.safeParse({ ...STORED_JOB, latestRun: { ts: 1, status: 'ok' } });
    expect(r.success).toBe(false);
    expect(refusedKeys(r.error!.issues)).toContain('latestRun');
  });

  test('JobLatestRun and JobRunStatus are the shared shapes the run log records', () => {
    expect(JobLatestRun.safeParse({ ts: 1, status: 'gate-held' }).success).toBe(true);
    expect(JobRunStatus.options).toEqual([
      'ok',
      'filter-rejected',
      'filter-error',
      'dispatch-error',
      'buffered',
      'queued',
      'slot-timeout',
      'chat-error',
      'gate-held',
      'gate-error',
    ]);
  });
});
