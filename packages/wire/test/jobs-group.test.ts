// Groups (spec/08 ## Groups).
//
// `group` is an ordinary client-settable free-text string, absent meaning
// "ungrouped" — the shape `archived` and `CronTrigger.timezone` take, and the
// only shape a new top-level job field may take: `Job` is `.strict()` and
// stored jobs written before the field existed must keep parsing.
//
// Unlike `archived`, `group` is settable at birth (`JobCreateBody`) — there is
// no reason a job can only be organised after it exists.

import { describe, test, expect } from 'vitest';
import { Job, JobCreateBody, JobPatchBody } from '../src/jobs.js';

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

describe('Job.group', () => {
  test('a job with no group key parses — absent is ungrouped', () => {
    const res = Job.safeParse(STORED_JOB);
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.group).toBeUndefined();
  });

  test('group: string parses and survives onto the parsed job', () => {
    const res = Job.safeParse({ ...STORED_JOB, group: 'Home' });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.group).toBe('Home');
  });

  test('an empty string is a valid group value', () => {
    const res = Job.safeParse({ ...STORED_JOB, group: '' });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.group).toBe('');
  });

  test('group must be a string', () => {
    expect(Job.safeParse({ ...STORED_JOB, group: 1 }).success).toBe(false);
    expect(Job.safeParse({ ...STORED_JOB, group: true }).success).toBe(false);
    expect(Job.safeParse({ ...STORED_JOB, group: null }).success).toBe(false);
  });

  test('a job may be archived AND grouped at once', () => {
    const res = Job.safeParse({ ...STORED_JOB, archived: true, group: 'Watchers' });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.archived).toBe(true);
      expect(res.data.group).toBe('Watchers');
    }
  });
});

describe('JobCreateBody.group', () => {
  test('accepts a group at creation — unlike archived, a job may be organised at birth', () => {
    const res = JobCreateBody.safeParse({
      name: 'parcel watch',
      trigger: TRIGGER,
      action: ACTION,
      group: 'Home',
    });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.group).toBe('Home');
  });

  test('omitting group is fine — a new job is ungrouped by default', () => {
    const res = JobCreateBody.safeParse({ name: 'parcel watch', trigger: TRIGGER, action: ACTION });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.group).toBeUndefined();
  });

  test('rejects a non-string', () => {
    expect(
      JobCreateBody.safeParse({ name: 'x', trigger: TRIGGER, action: ACTION, group: 5 }).success,
    ).toBe(false);
  });
});

describe('JobPatchBody.group', () => {
  test('accepts changing the group', () => {
    expect(JobPatchBody.safeParse({ group: 'Finance' }).success).toBe(true);
  });

  test('accepts clearing the group with an empty string', () => {
    expect(JobPatchBody.safeParse({ group: '' }).success).toBe(true);
  });

  test('rejects a non-string', () => {
    expect(JobPatchBody.safeParse({ group: 42 }).success).toBe(false);
  });
});
