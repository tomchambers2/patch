// One-off job schema (spec/08 ## One-off jobs).
//
// `oneOff` is an ordinary client-settable field; `expiredAt` is
// server-established and must be REFUSED on the client-write bodies rather
// than stripped, so a
// surface that sends one is told rather than left believing it took. The
// refusal comes from the bodies' own `.strict()`, which reports it as an
// `unrecognized_keys` issue naming the key (a whole-object issue, so it has
// no path — assert on the named key, not on `issue.path`).

import { describe, test, expect } from 'vitest';
import type { ZodIssue } from 'zod';
import { Job, JobCreateBody, JobPatchBody } from '../src/jobs.js';

function refusedKeys(issues: ZodIssue[]): string[] {
  return issues.flatMap((i) => (i.code === 'unrecognized_keys' ? i.keys : []));
}

const ACTION = { type: 'spawn', daemonId: 'host-a', folder: '/tmp', prompt: 'go' } as const;
const TRIGGER = { type: 'cron', expression: '0 9 * * *' } as const;

const STORED_JOB = {
  id: 'j_1',
  name: 'parcel watch',
  enabled: true,
  trigger: TRIGGER,
  filter: null,
  action: ACTION,
  createdAt: 1,
  updatedAt: 1,
};

describe('Job.oneOff', () => {
  test('a job with no oneOff at all still parses — recurring is the default shape', () => {
    const res = Job.safeParse(STORED_JOB);
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.oneOff).toBeUndefined();
  });

  test('oneOff: true parses and survives onto the parsed job', () => {
    const res = Job.safeParse({ ...STORED_JOB, oneOff: true });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.oneOff).toBe(true);
  });

  test('oneOff must be a boolean', () => {
    expect(Job.safeParse({ ...STORED_JOB, oneOff: 'yes' }).success).toBe(false);
  });
});

describe('Job.expiredAt', () => {
  test('a stored job may carry expiredAt — the server stamps it', () => {
    const res = Job.safeParse({ ...STORED_JOB, oneOff: true, enabled: false, expiredAt: 1717 });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.expiredAt).toBe(1717);
  });

  test('expiredAt must be an integer epoch-ms, not a date string', () => {
    expect(Job.safeParse({ ...STORED_JOB, expiredAt: '2026-08-28' }).success).toBe(false);
    expect(Job.safeParse({ ...STORED_JOB, expiredAt: 1.5 }).success).toBe(false);
  });
});

describe('JobCreateBody', () => {
  test('accepts oneOff', () => {
    const res = JobCreateBody.safeParse({
      name: 'parcel watch',
      trigger: TRIGGER,
      action: ACTION,
      oneOff: true,
    });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.oneOff).toBe(true);
  });

  test('REFUSES expiredAt — it is server-established, never client-supplied', () => {
    const res = JobCreateBody.safeParse({
      name: 'parcel watch',
      trigger: TRIGGER,
      action: ACTION,
      oneOff: true,
      expiredAt: 1717,
    });
    expect(res.success).toBe(false);
    if (!res.success) expect(refusedKeys(res.error.issues)).toContain('expiredAt');
  });
});

describe('JobPatchBody', () => {
  test('accepts oneOff — a job can be made one-off, or made recurring again', () => {
    expect(JobPatchBody.safeParse({ oneOff: true }).success).toBe(true);
    expect(JobPatchBody.safeParse({ oneOff: false }).success).toBe(true);
  });

  test('REFUSES expiredAt', () => {
    const res = JobPatchBody.safeParse({ expiredAt: 1717 });
    expect(res.success).toBe(false);
    if (!res.success) expect(refusedKeys(res.error.issues)).toContain('expiredAt');
  });
});
