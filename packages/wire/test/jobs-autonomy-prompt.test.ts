// Autonomy prompt (spec/08 § Autonomy prompt).
//
// Text prepended to a job's first user-turn. There is no "off" state — the
// editor's toggle is "default" vs "customise" — so `autonomyPrompt` absent
// means "use DEFAULT_JOB_AUTONOMY_PROMPT", not "use nothing". `null` on the
// write path (JobPatchBody) is the explicit "back to default" instruction,
// the same shape `gate`/`concurrency` use, because an omitted key there means
// "leave it as it is" and the editor needs a way to say "default" again.

import { describe, test, expect } from 'vitest';
import {
  DEFAULT_JOB_AUTONOMY_PROMPT,
  Job,
  JobCreateBody,
  JobPatchBody,
  jobAutonomyPrompt,
} from '../src/jobs.js';

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

describe('Job.autonomyPrompt', () => {
  test('a job with no key parses — absent means the default', () => {
    const res = Job.safeParse(STORED_JOB);
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.autonomyPrompt).toBeUndefined();
  });

  test('a custom string parses and survives onto the parsed job', () => {
    const res = Job.safeParse({ ...STORED_JOB, autonomyPrompt: 'Stay quiet and just do it.' });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.autonomyPrompt).toBe('Stay quiet and just do it.');
  });

  test('rejects an empty string — there is no "no prompt" state, only default vs custom', () => {
    expect(Job.safeParse({ ...STORED_JOB, autonomyPrompt: '' }).success).toBe(false);
  });

  test('must be a string', () => {
    expect(Job.safeParse({ ...STORED_JOB, autonomyPrompt: 1 }).success).toBe(false);
    expect(Job.safeParse({ ...STORED_JOB, autonomyPrompt: null }).success).toBe(false);
  });
});

describe('jobAutonomyPrompt', () => {
  test('uses the account prompt passed in when the job has no override', () => {
    expect(jobAutonomyPrompt({ autonomyPrompt: undefined }, 'House rule.')).toBe('House rule.');
    expect(jobAutonomyPrompt({ autonomyPrompt: undefined }, DEFAULT_JOB_AUTONOMY_PROMPT)).toBe(
      DEFAULT_JOB_AUTONOMY_PROMPT,
    );
  });

  test('reads the stored override when present', () => {
    expect(jobAutonomyPrompt({ autonomyPrompt: 'Be quick.' }, 'House rule.')).toBe('Be quick.');
  });
});

describe('JobCreateBody.autonomyPrompt', () => {
  test('accepts a custom prompt at creation', () => {
    const res = JobCreateBody.safeParse({
      name: 'parcel watch',
      trigger: TRIGGER,
      action: ACTION,
      autonomyPrompt: 'Be quick.',
    });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.autonomyPrompt).toBe('Be quick.');
  });

  test('omitting it is fine — a new job defaults', () => {
    const res = JobCreateBody.safeParse({ name: 'parcel watch', trigger: TRIGGER, action: ACTION });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.autonomyPrompt).toBeUndefined();
  });

  test('accepts null — nothing to clear at birth, but the body shape is shared with patch', () => {
    expect(
      JobCreateBody.safeParse({
        name: 'x',
        trigger: TRIGGER,
        action: ACTION,
        autonomyPrompt: null,
      }).success,
    ).toBe(true);
  });

  test('rejects an empty string and a non-string', () => {
    expect(
      JobCreateBody.safeParse({ name: 'x', trigger: TRIGGER, action: ACTION, autonomyPrompt: '' })
        .success,
    ).toBe(false);
    expect(
      JobCreateBody.safeParse({ name: 'x', trigger: TRIGGER, action: ACTION, autonomyPrompt: 5 })
        .success,
    ).toBe(false);
  });
});

describe('JobPatchBody.autonomyPrompt', () => {
  test('accepts setting a custom prompt', () => {
    expect(JobPatchBody.safeParse({ autonomyPrompt: 'Be quick.' }).success).toBe(true);
  });

  test('accepts null — the explicit "back to default" instruction', () => {
    expect(JobPatchBody.safeParse({ autonomyPrompt: null }).success).toBe(true);
  });

  test('rejects an empty string and a non-string', () => {
    expect(JobPatchBody.safeParse({ autonomyPrompt: '' }).success).toBe(false);
    expect(JobPatchBody.safeParse({ autonomyPrompt: 42 }).success).toBe(false);
  });
});
