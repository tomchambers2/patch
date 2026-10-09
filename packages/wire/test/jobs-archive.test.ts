// Archived jobs (spec/08 ## Archived jobs).
//
// `archived` is an ordinary client-settable boolean, absent meaning "not
// archived" — the shape `CronTrigger.timezone` set, and the only shape a new
// top-level job field may take: `Job` is `.strict()` and stored jobs written
// before the field existed must keep parsing.
//
// `jobFires` / `jobInertReason` are the SINGLE definition of "does this job
// fire", shared by every trigger ingress, so archived cannot be honoured by
// cron and forgotten by the webhook route.

import { describe, test, expect } from 'vitest';
import { Job, JobCreateBody, JobPatchBody, jobFires, jobInertReason } from '../src/jobs.js';

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

describe('Job.archived', () => {
  test('a job with no archived key parses — absent is not archived', () => {
    const res = Job.safeParse(STORED_JOB);
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.archived).toBeUndefined();
  });

  test('archived: true parses and survives onto the parsed job', () => {
    const res = Job.safeParse({ ...STORED_JOB, archived: true });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.archived).toBe(true);
  });

  test('archived must be a boolean', () => {
    expect(Job.safeParse({ ...STORED_JOB, archived: 'yes' }).success).toBe(false);
    expect(Job.safeParse({ ...STORED_JOB, archived: 1 }).success).toBe(false);
  });

  test('a job may be archived AND expired at once', () => {
    const res = Job.safeParse({
      ...STORED_JOB,
      enabled: false,
      oneOff: true,
      expiredAt: 1717,
      archived: true,
    });
    expect(res.success).toBe(true);
  });
});

describe('JobPatchBody.archived', () => {
  test('accepts archived both ways — archiving and un-archiving are client writes', () => {
    expect(JobPatchBody.safeParse({ archived: true }).success).toBe(true);
    expect(JobPatchBody.safeParse({ archived: false }).success).toBe(true);
  });

  test('rejects a non-boolean', () => {
    expect(JobPatchBody.safeParse({ archived: 'true' }).success).toBe(false);
  });
});

describe('JobCreateBody', () => {
  // Creating a job already put away is meaningless, and `.strict()` says so
  // loudly rather than dropping the key and leaving the caller believing it.
  test('REFUSES archived — a job is archived after it exists, not at birth', () => {
    const res = JobCreateBody.safeParse({
      name: 'parcel watch',
      trigger: TRIGGER,
      action: ACTION,
      archived: true,
    });
    expect(res.success).toBe(false);
  });
});

describe('jobInertReason / jobFires', () => {
  test('an enabled, unarchived job fires', () => {
    expect(jobInertReason({ enabled: true })).toBeNull();
    expect(jobInertReason({ enabled: true, archived: false })).toBeNull();
    expect(jobFires({ enabled: true })).toBe(true);
  });

  test('a disabled job is inert, and says which', () => {
    expect(jobInertReason({ enabled: false })).toBe('disabled');
    expect(jobFires({ enabled: false })).toBe(false);
  });

  test('an archived job is inert whatever its enabled flag says', () => {
    expect(jobInertReason({ enabled: true, archived: true })).toBe('archived');
    expect(jobFires({ enabled: true, archived: true })).toBe(false);
    expect(jobFires({ enabled: false, archived: true })).toBe(false);
  });

  test('archived is the reason reported when both apply — it is the stronger statement', () => {
    expect(jobInertReason({ enabled: false, archived: true })).toBe('archived');
  });
});
