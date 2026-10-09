// spec/15 § Job editor — the cron trigger's Timezone field.
//
// The mobile editor rebuilds the trigger from form state on every save, so
// without carrying the zone, opening an existing job on the phone and pressing
// Save would strip its `timezone` and move when it fires. These tests pin the
// round-trip, the UTC-omission, and the loud refusal of a zone this device
// cannot resolve (NO FALLBACK — never quietly demoted to UTC).

import { describe, it, expect } from 'vitest';
import type { Job } from '@patch/wire/jobs';
import { JobCreateBody } from '@patch/wire/jobs';
import {
  DEFAULT_FORM,
  deviceTimeZone,
  type FormState,
  formToBody,
  jobToForm,
  validateForm,
} from '../src/lib/jobEditor';

const HOST = 'd1';

function form(overrides: Partial<FormState>): FormState {
  return {
    ...DEFAULT_FORM,
    name: 'daily email update',
    spawnDaemonId: HOST,
    spawnFolder: '/work',
    spawnPrompt: 'go',
    ...overrides,
  };
}

function storedJob(trigger: Job['trigger']): Job {
  return {
    id: 'j1',
    name: 'daily email update',
    enabled: true,
    trigger,
    filter: null,
    action: { type: 'spawn', daemonId: HOST, folder: '/work', prompt: 'go' },
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('deviceTimeZone / DEFAULT_FORM', () => {
  it('reports a zone this runtime can actually resolve', () => {
    const tz = deviceTimeZone();
    expect(tz.length).toBeGreaterThan(0);
    expect(() => new Intl.DateTimeFormat('en-US', { timeZone: tz })).not.toThrow();
  });

  it('a NEW job starts on the device zone — typing 9am should mean local 9am', () => {
    expect(DEFAULT_FORM.cronTimezone).toBe(deviceTimeZone());
  });
});

describe('formToBody', () => {
  it('sends the zone alongside the UNCHANGED expression', () => {
    const body = formToBody(form({ cronExpression: '0 9 * * *', cronTimezone: 'Europe/London' }));
    expect(body.trigger).toEqual({
      type: 'cron',
      expression: '0 9 * * *',
      timezone: 'Europe/London',
    });
    expect(() => JobCreateBody.parse(body)).not.toThrow();
  });

  it('OMITS the field for UTC, so the body matches a pre-timezone job byte for byte', () => {
    const body = formToBody(form({ cronExpression: '0 9 * * *', cronTimezone: 'UTC' }));
    expect(body.trigger).toEqual({ type: 'cron', expression: '0 9 * * *' });
    expect(body.trigger).not.toHaveProperty('timezone');
  });

  it('trims surrounding whitespace off a typed zone', () => {
    const body = formToBody(form({ cronTimezone: '  Europe/London  ' }));
    expect(body.trigger).toHaveProperty('timezone', 'Europe/London');
  });

  it('carries no zone on a non-cron trigger', () => {
    const body = formToBody(
      form({ triggerType: 'webhook', webhookScheme: 'none', cronTimezone: 'Europe/London' }),
    );
    expect(body.trigger).not.toHaveProperty('timezone');
  });
});

describe('jobToForm', () => {
  it('loads a stored zone verbatim', () => {
    const f = jobToForm(
      storedJob({ type: 'cron', expression: '0 9 * * *', timezone: 'Europe/London' }),
    );
    expect(f.cronTimezone).toBe('Europe/London');
  });

  it('reads a pre-timezone job as UTC — NOT the device zone', () => {
    const f = jobToForm(storedJob({ type: 'cron', expression: '0 9 * * *' }));
    expect(f.cronTimezone).toBe('UTC');
  });

  // The strip regression: any unrelated edit used to be able to move a job.
  it('round-trips an untouched job without gaining or losing a zone', () => {
    const zoned = storedJob({ type: 'cron', expression: '0 9 * * *', timezone: 'Europe/London' });
    expect(formToBody(jobToForm(zoned)).trigger).toEqual(zoned.trigger);
    const bare = storedJob({ type: 'cron', expression: '0 9 * * *' });
    expect(formToBody(jobToForm(bare)).trigger).toEqual(bare.trigger);
  });
});

describe('validateForm', () => {
  it('refuses a zone this device cannot resolve, naming it and suggesting a real one', () => {
    const msg = validateForm(form({ cronTimezone: 'Europe/Landon' }));
    expect(msg).toMatch(/Europe\/Landon/);
    expect(msg).toMatch(/IANA timezone/i);
  });

  it('refuses a bare UTC offset — frozen, so it cannot track DST', () => {
    expect(validateForm(form({ cronTimezone: '+01:00' }))).toMatch(/IANA timezone/i);
  });

  it('refuses an empty zone rather than assuming UTC', () => {
    expect(validateForm(form({ cronTimezone: '' }))).toMatch(/IANA timezone/i);
  });

  it('accepts a real zone and UTC', () => {
    expect(validateForm(form({ cronTimezone: 'Europe/London' }))).toBeNull();
    expect(validateForm(form({ cronTimezone: 'UTC' }))).toBeNull();
  });

  it('ignores the zone entirely for a non-cron trigger', () => {
    expect(
      validateForm(
        form({ triggerType: 'webhook', webhookScheme: 'none', cronTimezone: 'not a zone' }),
      ),
    ).toBeNull();
  });
});
