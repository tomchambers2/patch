// spec/08 § Cron: a cron trigger carries the IANA zone its expression is
// evaluated in. The field is OPTIONAL and absent means UTC, which is what
// every job stored before the field existed relies on — and what keeps the
// body acceptable to an older, strict `CronTrigger` on a host that has not
// OTA'd yet.

import { describe, test, expect } from 'vitest';
import { CronTrigger, Job, JobCreateBody, JobPatchBody, JobTrigger } from '../src/jobs.js';

const ACTION = { type: 'spawn', daemonId: 'host-a', folder: '/tmp', prompt: 'go' } as const;

describe('CronTrigger.timezone', () => {
  test('is optional — a trigger with no zone still parses, and stays absent', () => {
    const parsed = CronTrigger.parse({ type: 'cron', expression: '0 9 * * *' });
    expect(parsed).toEqual({ type: 'cron', expression: '0 9 * * *' });
    expect('timezone' in parsed).toBe(false);
  });

  test('accepts an IANA zone and round-trips it verbatim', () => {
    const parsed = CronTrigger.parse({
      type: 'cron',
      expression: '0 9 * * *',
      timezone: 'Europe/London',
    });
    expect(parsed.timezone).toBe('Europe/London');
  });

  test('accepts an explicit UTC — the same meaning as omitting it', () => {
    expect(
      CronTrigger.safeParse({ type: 'cron', expression: '0 9 * * *', timezone: 'UTC' }).success,
    ).toBe(true);
  });

  test('REJECTS an unknown zone loudly rather than falling back to UTC', () => {
    const res = CronTrigger.safeParse({
      type: 'cron',
      expression: '0 9 * * *',
      timezone: 'Europe/Landon',
    });
    expect(res.success).toBe(false);
    expect(JSON.stringify(res.error?.issues)).toContain('invalid IANA timezone');
    expect(JSON.stringify(res.error?.issues)).toContain('timezone');
  });

  test('rejects an empty zone', () => {
    expect(
      CronTrigger.safeParse({ type: 'cron', expression: '0 9 * * *', timezone: '' }).success,
    ).toBe(false);
  });

  test('still strict — an unknown sibling key is refused', () => {
    expect(
      CronTrigger.safeParse({ type: 'cron', expression: '0 9 * * *', tz: 'Europe/London' }).success,
    ).toBe(false);
  });

  test('the discriminated union resolves a zoned cron trigger', () => {
    const parsed = JobTrigger.parse({
      type: 'cron',
      expression: '0 9 * * *',
      timezone: 'Europe/London',
    });
    expect(parsed.type).toBe('cron');
  });
});

describe('timezone flows through every client-write body', () => {
  test('JobCreateBody accepts it', () => {
    const res = JobCreateBody.safeParse({
      name: 'daily',
      trigger: { type: 'cron', expression: '0 9 * * *', timezone: 'Europe/London' },
      action: ACTION,
    });
    expect(res.success).toBe(true);
  });

  test('JobCreateBody rejects a bad zone', () => {
    const res = JobCreateBody.safeParse({
      name: 'daily',
      trigger: { type: 'cron', expression: '0 9 * * *', timezone: 'Mars/Olympus' },
      action: ACTION,
    });
    expect(res.success).toBe(false);
  });

  test('JobPatchBody accepts it', () => {
    const res = JobPatchBody.safeParse({
      trigger: { type: 'cron', expression: '0 9 * * *', timezone: 'America/New_York' },
    });
    expect(res.success).toBe(true);
  });

  test('a stored Job parses with and without it', () => {
    const base = {
      id: 'j1',
      name: 'daily',
      enabled: true,
      filter: null,
      action: ACTION,
      createdAt: 1,
      updatedAt: 1,
    };
    expect(
      Job.safeParse({ ...base, trigger: { type: 'cron', expression: '0 9 * * *' } }).success,
    ).toBe(true);
    expect(
      Job.safeParse({
        ...base,
        trigger: { type: 'cron', expression: '0 9 * * *', timezone: 'Europe/London' },
      }).success,
    ).toBe(true);
  });
});
