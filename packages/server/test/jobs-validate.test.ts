// Unit coverage for jobs/validate.ts — the single semantic gate shared by
// every CRUD surface (REST, RPC bridge, file load). Exercises every branch:
// cron field-count / node-cron validity, and job `filter` JSONata, both valid
// and invalid, plus the "nothing to validate" pass-through paths.

import { describe, it, expect } from 'vitest';
import { assertValidJobBody, JobValidationError } from '../src/jobs/validate.js';
import type { JobCreateBody } from '../src/jobs/types.js';

function baseBody(overrides: Partial<JobCreateBody> = {}): JobCreateBody {
  return {
    name: 'test',
    trigger: { type: 'cron', expression: '0 9 * * *' },
    action: { type: 'spawn', daemonId: 'd1', folder: '/work', prompt: 'go' },
    ...overrides,
  };
}

describe('assertValidJobBody', () => {
  it('accepts a valid 5-field cron expression', () => {
    expect(() => assertValidJobBody(baseBody())).not.toThrow();
  });

  it('rejects a cron expression that is not exactly 5 fields', () => {
    expect(() =>
      assertValidJobBody(baseBody({ trigger: { type: 'cron', expression: '0 0 9 * * *' } })),
    ).toThrow(JobValidationError);
    try {
      assertValidJobBody(baseBody({ trigger: { type: 'cron', expression: '* * * * * *' } }));
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(JobValidationError);
      expect((err as JobValidationError).field).toBe('trigger.expression');
      expect((err as JobValidationError).message).toContain('expected 5 fields');
    }
  });

  it('rejects a 5-field cron expression that node-cron considers invalid', () => {
    try {
      assertValidJobBody(baseBody({ trigger: { type: 'cron', expression: '99 99 99 99 99' } }));
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(JobValidationError);
      expect((err as JobValidationError).field).toBe('trigger.expression');
      expect((err as JobValidationError).message).toContain('invalid cron expression');
      expect((err as JobValidationError).message).not.toContain('expected 5 fields');
    }
  });

  it('accepts a valid recurrence trigger', () => {
    expect(() =>
      assertValidJobBody(
        baseBody({
          trigger: {
            type: 'recurrence',
            rrule: 'FREQ=MONTHLY;BYDAY=SU;BYSETPOS=3;BYMONTH=5,6,7,8;BYHOUR=9;BYMINUTE=0',
            timezone: 'Europe/London',
          },
        }),
      ),
    ).not.toThrow();
  });

  it('rejects a recurrence trigger whose rrule does not parse', () => {
    try {
      assertValidJobBody(
        baseBody({
          trigger: { type: 'recurrence', rrule: 'FREQ=BOGUS', timezone: 'Europe/London' },
        }),
      );
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(JobValidationError);
      expect((err as JobValidationError).field).toBe('trigger.rrule');
      expect((err as JobValidationError).message).toContain('invalid RRULE');
    }
  });

  it('rejects a recurrence trigger whose rrule is unparseable garbage', () => {
    try {
      assertValidJobBody(
        baseBody({
          trigger: {
            type: 'recurrence',
            rrule: 'this is not an rrule at all',
            timezone: 'Europe/London',
          },
        }),
      );
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(JobValidationError);
      expect((err as JobValidationError).field).toBe('trigger.rrule');
    }
  });

  it('accepts a valid job-level filter', () => {
    expect(() =>
      assertValidJobBody(baseBody({ filter: 'payload.action = "closed"' })),
    ).not.toThrow();
  });

  it('accepts a null/empty/absent filter without validating it', () => {
    expect(() => assertValidJobBody(baseBody({ filter: null }))).not.toThrow();
    expect(() => assertValidJobBody(baseBody({ filter: '' }))).not.toThrow();
    expect(() => assertValidJobBody(baseBody())).not.toThrow();
  });

  it('rejects an invalid job-level JSONata filter', () => {
    try {
      assertValidJobBody(baseBody({ filter: '$.broken(' }));
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(JobValidationError);
      expect((err as JobValidationError).field).toBe('filter');
      expect((err as JobValidationError).message).toContain('invalid JSONata (filter)');
    }
  });

  it('a JobValidationError carries name "JobValidationError"', () => {
    try {
      assertValidJobBody(baseBody({ filter: '$.broken(' }));
      throw new Error('expected throw');
    } catch (err) {
      expect((err as Error).name).toBe('JobValidationError');
    }
  });

  it('webhook and todoist triggers (no cron semantics) pass through untouched', () => {
    expect(() =>
      assertValidJobBody(baseBody({ trigger: { type: 'webhook', scheme: 'none' } })),
    ).not.toThrow();
    expect(() => assertValidJobBody(baseBody({ trigger: { type: 'todoist' } }))).not.toThrow();
  });

  it('a patch body with no trigger at all skips trigger validation entirely', () => {
    expect(() => assertValidJobBody({ name: 'renamed' })).not.toThrow();
  });
});
