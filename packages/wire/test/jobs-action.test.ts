// Job action schema invariant: every action carries AT LEAST ONE of skill|prompt.
//
// Neither → no first user-turn to deliver (the job would fire as a no-op).
// BOTH is allowed: the skill runs with the prompt as its body (spec/08 ## Action).
// This is the canonical schema-level gate shared by every CRUD surface (REST
// /api/jobs, host UDS, cross-chat RPC), so it can never diverge per surface.

import { describe, test, expect } from 'vitest';
import { z } from 'zod';
import {
  JobAction,
  JobCreateBody,
  JobPatchBody,
  ensureChatId,
  ensureChatKeySlug,
} from '../src/jobs.js';
import { PermissionMode } from '../src/events.js';

/**
 * `ContinueAction` EXACTLY as it stood before `startHidden` was added to it — i.e. what
 * a host still running the previous host build parses job payloads with.
 * Hosts OTA their host separately from the server, so that host is live for
 * as long as it takes Tom's machine to update, and it is `.strict()`: an unknown
 * key is a 400, not a warning. Frozen here on purpose — do NOT re-derive it from
 * the current schema, which would make the test assert nothing.
 */
const ContinueActionBeforeHidden = z
  .object({
    type: z.literal('continue'),
    daemonId: z.string().min(1),
    folder: z.string().min(1),
    prompt: z.string().optional(),
    skill: z.string().optional(),
    model: z.string().min(1).optional(),
    key: z.string().min(1).optional(),
  })
  .strict();

describe('JobAction skill/prompt invariant (at least one)', () => {
  test('spawn with skill only → valid', () => {
    expect(
      JobAction.safeParse({ type: 'spawn', daemonId: 'host-a', folder: '/tmp', skill: 'foo' })
        .success,
    ).toBe(true);
  });

  test('spawn with prompt only → valid', () => {
    expect(
      JobAction.safeParse({ type: 'spawn', daemonId: 'host-a', folder: '/tmp', prompt: 'x' })
        .success,
    ).toBe(true);
  });

  test('message with skill only → valid', () => {
    expect(JobAction.safeParse({ type: 'message', chatId: 'c1', skill: 'foo' }).success).toBe(true);
  });

  test('message with prompt only → valid', () => {
    expect(JobAction.safeParse({ type: 'message', chatId: 'c1', prompt: 'x' }).success).toBe(true);
  });

  test('spawn with NEITHER skill nor prompt → rejected (no-op job)', () => {
    const res = JobAction.safeParse({ type: 'spawn', daemonId: 'host-a', folder: '/tmp' });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => /a skill, a prompt, or both/.test(i.message))).toBe(true);
    }
  });

  test('message with NEITHER skill nor prompt → rejected (no-op job)', () => {
    const res = JobAction.safeParse({ type: 'message', chatId: 'c1' });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => /a skill, a prompt, or both/.test(i.message))).toBe(true);
    }
  });

  test('spawn with BOTH skill and prompt → valid (skill runs with the prompt)', () => {
    const res = JobAction.safeParse({
      type: 'spawn',
      daemonId: 'host-a',
      folder: '/tmp',
      skill: 'foo',
      prompt: 'x',
    });
    expect(res.success).toBe(true);
  });

  test('message with BOTH skill and prompt → valid', () => {
    const res = JobAction.safeParse({ type: 'message', chatId: 'c1', skill: 'foo', prompt: 'x' });
    expect(res.success).toBe(true);
  });

  test('ensure with BOTH skill and prompt → valid', () => {
    const res = JobAction.safeParse({
      type: 'continue',
      daemonId: 'host-a',
      folder: '/tmp',
      skill: 'foo',
      prompt: 'x',
    });
    expect(res.success).toBe(true);
  });

  test('empty-string skill/prompt counts as absent → rejected', () => {
    const res = JobAction.safeParse({
      type: 'spawn',
      daemonId: 'host-a',
      folder: '/tmp',
      skill: '',
      prompt: '',
    });
    expect(res.success).toBe(false);
  });

  test('JobCreateBody enforces the invariant through the action field', () => {
    const neither = JobCreateBody.safeParse({
      name: 't',
      trigger: { type: 'cron', expression: '0 8 * * *' },
      action: { type: 'spawn', daemonId: 'host-a', folder: '/tmp' },
    });
    expect(neither.success).toBe(false);

    const valid = JobCreateBody.safeParse({
      name: 't',
      trigger: { type: 'cron', expression: '0 8 * * *' },
      action: { type: 'spawn', daemonId: 'host-a', folder: '/tmp', skill: 'foo' },
    });
    expect(valid.success).toBe(true);
  });
});

// spec/08 ## Action — a spawned chat opens in the active inbox by default so a
// run that stops on a question is visible; `startHidden` is the per-job opt-in
// that keeps the run out of the inbox, Hidden.
describe('JobAction.startHidden', () => {
  const base = { type: 'spawn', daemonId: 'host-a', folder: '/tmp', skill: 'foo' };

  test('omitted → undefined, i.e. NOT started archived (the default is a visible chat)', () => {
    const res = JobAction.safeParse(base);
    expect(res.success).toBe(true);
    if (res.success && res.data.type === 'spawn') expect(res.data.startHidden).toBeUndefined();
  });

  test('accepted on spawn and round-trips', () => {
    const res = JobAction.safeParse({ ...base, startHidden: true });
    expect(res.success).toBe(true);
    if (res.success && res.data.type === 'spawn') expect(res.data.startHidden).toBe(true);
  });

  // Both folder-carrying actions CREATE the chat they place, so both can place
  // it out of the inbox. A keyed `ensure` is the case this was added for: one
  // durable chat per subject is one inbox row per subject.
  test('accepted on ensure and round-trips', () => {
    const res = JobAction.safeParse({ ...base, type: 'continue', startHidden: true });
    expect(res.success).toBe(true);
    if (res.success && res.data.type === 'continue') expect(res.data.startHidden).toBe(true);
  });

  test('omitted on continue → undefined, i.e. NOT started archived', () => {
    const res = JobAction.safeParse({ ...base, type: 'continue' });
    expect(res.success).toBe(true);
    if (res.success && res.data.type === 'continue') expect(res.data.startHidden).toBeUndefined();
  });

  test('rejected on message — it places no chat of its own', () => {
    expect(
      JobAction.safeParse({ type: 'message', chatId: 'c1', skill: 'foo', startHidden: true })
        .success,
    ).toBe(false);
  });

  // THE RENAME IS ONLY SAFE IF THE OLD NAME STILL LOADS. Every job already on
  // disk stores `hidden`, and the actions are `.strict()` — so an unmigrated
  // field does not get ignored, it fails the whole action and takes the job
  // with it. Accepted on read for ever, never written back out.
  test('a job stored under the old name `hidden` still loads, as startHidden', () => {
    const res = JobAction.safeParse({ ...base, hidden: true });
    expect(res.success).toBe(true);
    if (res.success && res.data.type === 'spawn') {
      expect(res.data.startHidden).toBe(true);
      expect('hidden' in res.data).toBe(false);
    }
  });

  test('a job stored under the later name `startArchived` still loads, as startHidden', () => {
    const res = JobAction.safeParse({ ...base, startArchived: true });
    expect(res.success).toBe(true);
    if (res.success && res.data.type === 'spawn') {
      expect(res.data.startHidden).toBe(true);
      expect('startArchived' in res.data).toBe(false);
    }
  });

  test('the old name migrates on continue too, and alongside the old `ensure` type', () => {
    const res = JobAction.safeParse({ ...base, type: 'ensure', hidden: true });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.type).toBe('continue');
      if (res.data.type === 'continue') expect(res.data.startHidden).toBe(true);
    }
  });

  test('a non-boolean is refused on both, never coerced', () => {
    expect(JobAction.safeParse({ ...base, startHidden: 'yes' }).success).toBe(false);
    expect(JobAction.safeParse({ ...base, type: 'continue', startHidden: 1 }).success).toBe(false);
  });

  // WIRE COMPATIBILITY. Both actions are `.strict()`, and a host OTAs its
  // host separately from the server it talks to — so for a while Tom's host
  // parses job payloads with an `ContinueAction` that has never heard of
  // `hidden`, and a strict schema 400s on an unknown key. An untouched job must
  // therefore serialise EXACTLY as it did before this field existed: the field
  // absent, not `startHidden: false` and not `hidden: undefined`.
  test('parsing an action that never set it adds NO key to the payload', () => {
    for (const type of ['spawn', 'continue'] as const) {
      const stored = { ...base, type };
      const res = JobAction.safeParse(stored);
      expect(res.success).toBe(true);
      if (!res.success) continue;
      expect(Object.keys(res.data).sort()).toEqual(Object.keys(stored).sort());
      expect('hidden' in res.data).toBe(false);
      // Byte-identical round-trip: what an older host receives is unchanged.
      expect(JSON.stringify(res.data)).toBe(JSON.stringify(stored));
    }
  });

  test('an untouched ensure action still parses on a host that predates the field', () => {
    const stored = { type: 'continue', daemonId: 'host-a', folder: '/tmp', skill: 'foo' };
    const res = JobAction.safeParse(stored);
    expect(res.success).toBe(true);
    if (res.success) expect(ContinueActionBeforeHidden.safeParse(res.data).success).toBe(true);
  });

  test('and writing `startHidden: false` instead of omitting it would break that host', () => {
    // Why the editor writes the key ONLY when set. The current schema accepts
    // `false` (it is a boolean), so nothing downstream would complain — the
    // damage lands on the older host, out of sight. Pinned so the omission is
    // not later "tidied" into an explicit false.
    expect(
      JobAction.safeParse({
        type: 'continue',
        daemonId: 'h',
        folder: '/t',
        skill: 'f',
        startHidden: false,
      }).success,
    ).toBe(true);
    expect(
      ContinueActionBeforeHidden.safeParse({
        type: 'continue',
        daemonId: 'h',
        folder: '/t',
        skill: 'f',
        startHidden: false,
      }).success,
    ).toBe(false);
  });
});

// spec/08 ## Action — `notifyOnComplete`. The mirror image of `startHidden`
// above: a job's fire is a `user` turn, so a job's chat rings the completion
// doorbell already, and this field is the per-job opt-OUT. Default-ON, which
// inverts the encoding — ABSENT MEANS NOTIFY and only an explicit `false`
// suppresses, so a job written before the field existed needs no migration.
describe('JobAction.notifyOnComplete', () => {
  const base = { type: 'spawn', daemonId: 'host-a', folder: '/tmp', skill: 'foo' };

  test('omitted → undefined, which MEANS notify (the default is on)', () => {
    for (const type of ['spawn', 'continue'] as const) {
      const res = JobAction.safeParse({ ...base, type });
      expect(res.success).toBe(true);
      if (!res.success) continue;
      if (res.data.type === 'spawn' || res.data.type === 'continue') {
        expect(res.data.notifyOnComplete).toBeUndefined();
        // The reading every consumer does: only `false` is silence.
        expect(res.data.notifyOnComplete === false).toBe(false);
      }
    }
  });

  test('`false` is accepted and round-trips on both actions that create a chat', () => {
    for (const type of ['spawn', 'continue'] as const) {
      const res = JobAction.safeParse({ ...base, type, notifyOnComplete: false });
      expect(res.success).toBe(true);
      if (!res.success) continue;
      if (res.data.type === 'spawn' || res.data.type === 'continue') {
        expect(res.data.notifyOnComplete).toBe(false);
      }
    }
  });

  // An agent calling patch_job_create will reasonably spell the default out.
  // Refusing the whole job over a key that says what the default already says
  // would be hostile, so `true` is accepted — and means the same as absent.
  test('an explicit `true` is accepted and means the same as absent', () => {
    const res = JobAction.safeParse({ ...base, notifyOnComplete: true });
    expect(res.success).toBe(true);
    if (res.success && res.data.type === 'spawn') {
      expect(res.data.notifyOnComplete).toBe(true);
      expect(res.data.notifyOnComplete === false).toBe(false);
    }
  });

  test('rejected on message — it delivers into a chat the user already hears from', () => {
    expect(
      JobAction.safeParse({ type: 'message', chatId: 'c1', skill: 'foo', notifyOnComplete: false })
        .success,
    ).toBe(false);
  });

  test('rejected on script — a script action settles no chat', () => {
    expect(
      JobAction.safeParse({
        type: 'script',
        daemonId: 'host-a',
        folder: '/tmp',
        command: 'true',
        notifyOnComplete: false,
      }).success,
    ).toBe(false);
  });

  test('a non-boolean is refused on both, never coerced', () => {
    expect(JobAction.safeParse({ ...base, notifyOnComplete: 'no' }).success).toBe(false);
    expect(JobAction.safeParse({ ...base, type: 'continue', notifyOnComplete: 0 }).success).toBe(
      false,
    );
  });

  // WIRE COMPATIBILITY, same rule as `startHidden` and the opposite encoding.
  // A job nobody has touched the option on must serialise EXACTLY as it did
  // before the field existed — which for a DEFAULT-ON field means the key is
  // absent, NOT `notifyOnComplete: true`.
  test('parsing an action that never set it adds NO key to the payload', () => {
    for (const type of ['spawn', 'continue'] as const) {
      const stored = { ...base, type };
      const res = JobAction.safeParse(stored);
      expect(res.success).toBe(true);
      if (!res.success) continue;
      expect('notifyOnComplete' in res.data).toBe(false);
      expect(JSON.stringify(res.data)).toBe(JSON.stringify(stored));
      // And that payload is still what the older host parses with.
      if (type === 'continue') {
        expect(ContinueActionBeforeHidden.safeParse(res.data).success).toBe(true);
      }
    }
  });

  test('writing `notifyOnComplete: true` instead of omitting it would break an older host', () => {
    // Why every writer omits the field rather than stating the default. The
    // current schema accepts `true` (it is a boolean), so nothing near the
    // writer complains — the damage lands on the not-yet-OTA'd host.
    const stated = {
      type: 'continue',
      daemonId: 'h',
      folder: '/t',
      skill: 'f',
      notifyOnComplete: true,
    };
    expect(JobAction.safeParse(stated).success).toBe(true);
    expect(ContinueActionBeforeHidden.safeParse(stated).success).toBe(false);
  });

  test('it composes with startHidden — the two flags are independent', () => {
    const res = JobAction.safeParse({ ...base, startHidden: true, notifyOnComplete: false });
    expect(res.success).toBe(true);
    if (res.success && res.data.type === 'spawn') {
      expect(res.data.startHidden).toBe(true);
      expect(res.data.notifyOnComplete).toBe(false);
    }
  });
});

// spec/08 § Action — a spawn action may pin the permission mode its chat runs
// under. Storing nothing is the ordinary case and means `auto`; the dispatcher
// is what supplies that floor, so the schema keeps the field genuinely optional
// rather than defaulting it here.
describe('SpawnAction.permissionMode (spec/08 § Action)', () => {
  const base = { type: 'spawn', daemonId: 'host-a', folder: '/tmp', skill: 'foo' };

  test('omitted → undefined (the fire runs under auto)', () => {
    const res = JobAction.safeParse(base);
    expect(res.success).toBe(true);
    if (res.success && res.data.type === 'spawn') expect(res.data.permissionMode).toBeUndefined();
  });

  test('accepts every mode the protocol offers', () => {
    for (const mode of PermissionMode.options) {
      const res = JobAction.safeParse({ ...base, permissionMode: mode });
      expect(res.success).toBe(true);
      if (res.success && res.data.type === 'spawn') expect(res.data.permissionMode).toBe(mode);
    }
  });

  test('a mode outside the enum is refused, never coerced to a default', () => {
    expect(JobAction.safeParse({ ...base, permissionMode: 'dontAsk' }).success).toBe(false);
    expect(JobAction.safeParse({ ...base, permissionMode: '' }).success).toBe(false);
    expect(JobAction.safeParse({ ...base, permissionMode: true }).success).toBe(false);
  });

  test('rejected on ensure and message — spawn-only, same reasoning as `hidden`', () => {
    expect(JobAction.safeParse({ ...base, type: 'continue', permissionMode: 'plan' }).success).toBe(
      false,
    );
    expect(
      JobAction.safeParse({ type: 'message', chatId: 'c1', skill: 'foo', permissionMode: 'plan' })
        .success,
    ).toBe(false);
  });

  test('rides the client write bodies, so every CRUD surface can set it', () => {
    expect(
      JobCreateBody.safeParse({
        name: 't',
        trigger: { type: 'cron', expression: '0 8 * * *' },
        action: { ...base, permissionMode: 'bypassPermissions' },
      }).success,
    ).toBe(true);
    expect(
      JobPatchBody.safeParse({ action: { ...base, permissionMode: 'acceptEdits' } }).success,
    ).toBe(true);
  });
});

// spec/08 § Action: an action may store the model its chat runs on. Only the
// folder-addressed actions can — they name the host whose catalogue the id
// comes from. A `message` action has no host of its own; it inherits host,
// folder and model from the chat it delivers into.
describe('action model (spec/08 § Action)', () => {
  const base = { type: 'spawn' as const, daemonId: 'host-a', folder: '/tmp', skill: 'foo' };

  test('omitted → undefined, i.e. the host last-used model wins', () => {
    const res = JobAction.safeParse(base);
    expect(res.success).toBe(true);
    if (res.success && res.data.type === 'spawn') expect(res.data.model).toBeUndefined();
  });

  test('accepted on spawn and round-trips', () => {
    const res = JobAction.safeParse({ ...base, model: 'claude-opus-5' });
    expect(res.success).toBe(true);
    if (res.success && res.data.type === 'spawn') expect(res.data.model).toBe('claude-opus-5');
  });

  test('accepted on ensure and round-trips', () => {
    const res = JobAction.safeParse({ ...base, type: 'continue', model: 'claude-haiku-4-5' });
    expect(res.success).toBe(true);
    if (res.success && res.data.type === 'continue')
      expect(res.data.model).toBe('claude-haiku-4-5');
  });

  test('rejected on message — that action takes its model from the target chat', () => {
    expect(
      JobAction.safeParse({ type: 'message', chatId: 'c1', skill: 'foo', model: 'claude-opus-5' })
        .success,
    ).toBe(false);
  });

  test('empty string rejected — a stored model must name one', () => {
    expect(JobAction.safeParse({ ...base, model: '' }).success).toBe(false);
    expect(JobAction.safeParse({ ...base, type: 'continue', model: '' }).success).toBe(false);
  });

  test('survives a full JobCreateBody parse', () => {
    const res = JobCreateBody.safeParse({
      name: 'nightly',
      trigger: { type: 'cron', expression: '0 9 * * *' },
      action: { ...base, model: 'claude-sonnet-4-6' },
    });
    expect(res.success).toBe(true);
    if (res.success && res.data.action.type === 'spawn')
      expect(res.data.action.model).toBe('claude-sonnet-4-6');
  });
});

describe('ensureChatId', () => {
  test('derives a deterministic jobchat-<id> from the job id', () => {
    expect(ensureChatId('j1')).toBe('jobchat-j1');
    expect(ensureChatId('abc-123')).toBe('jobchat-abc-123');
  });

  test('is stable across repeated calls (same job → same chat)', () => {
    expect(ensureChatId('recurring-job')).toBe(ensureChatId('recurring-job'));
  });

  test('a key scopes the chat to one subject within the job', () => {
    expect(ensureChatId('j1', 'taskA')).toBe('jobchat-j1-taskA');
    // Different subjects must not collide — the whole point of keying.
    expect(ensureChatId('j1', 'taskA')).not.toBe(ensureChatId('j1', 'taskB'));
    // ...and a keyed chat is distinct from the job-wide one.
    expect(ensureChatId('j1', 'taskA')).not.toBe(ensureChatId('j1'));
  });
});

describe('ContinueAction.key', () => {
  const ensure = { type: 'continue', daemonId: 'host-a', folder: '/tmp', skill: 'app-update' };

  test('accepted as a mustache template', () => {
    const res = JobAction.safeParse({ ...ensure, key: '{{payload.event_data.id}}' });
    expect(res.success).toBe(true);
  });

  test('optional — an unkeyed ensure is still valid (existing jobs unchanged)', () => {
    expect(JobAction.safeParse(ensure).success).toBe(true);
  });

  test('empty string rejected — a stored key must name something', () => {
    expect(JobAction.safeParse({ ...ensure, key: '' }).success).toBe(false);
  });

  test('not a spawn field — spawn has no subject chat to key', () => {
    expect(
      JobAction.safeParse({
        type: 'spawn',
        daemonId: 'host-a',
        folder: '/tmp',
        skill: 'x',
        key: 'k',
      }).success,
    ).toBe(false);
  });
});

describe('script action (spec/08 § Action — `script`)', () => {
  const base = {
    type: 'script' as const,
    daemonId: 'd1',
    folder: '/home/tom/projects/portfolio',
    command: 'scripts/tick.sh',
  };

  test('needs neither skill nor prompt — it delivers no user turn', () => {
    expect(JobAction.safeParse(base).success).toBe(true);
  });

  test('rejects a first turn: a script has no chat to say it to', () => {
    expect(JobAction.safeParse({ ...base, prompt: 'go' }).success).toBe(false);
    expect(JobAction.safeParse({ ...base, skill: 'photo-triage' }).success).toBe(false);
  });

  test('requires the host, the folder and the command', () => {
    expect(JobAction.safeParse({ ...base, command: '' }).success).toBe(false);
    expect(JobAction.safeParse({ ...base, folder: '' }).success).toBe(false);
    expect(JobAction.safeParse({ ...base, daemonId: '' }).success).toBe(false);
  });

  test('bounds the timeout — a tick may not run for an hour', () => {
    expect(JobAction.safeParse({ ...base, timeoutMs: 5000 }).success).toBe(true);
    expect(JobAction.safeParse({ ...base, timeoutMs: 100 }).success).toBe(false);
    expect(JobAction.safeParse({ ...base, timeoutMs: 3_600_000 }).success).toBe(false);
  });

  test('the other actions still require a first turn', () => {
    expect(JobAction.safeParse({ type: 'spawn', daemonId: 'd1', folder: '/tmp' }).success).toBe(
      false,
    );
  });
});

describe('ensureChatKeySlug', () => {
  test('passes through what is already id-safe', () => {
    expect(ensureChatKeySlug('6hMf9PQP6qrfHH3c')).toBe('6hMf9PQP6qrfHH3c');
    expect(ensureChatKeySlug('task_12-34')).toBe('task_12-34');
  });

  test('collapses runs of unsafe characters and trims the edges', () => {
    expect(ensureChatKeySlug('  hello world!!  ')).toBe('hello-world');
    expect(ensureChatKeySlug('a/b/c')).toBe('a-b-c');
  });

  test('caps length so a long key cannot make an unwieldy chat id', () => {
    expect(ensureChatKeySlug('x'.repeat(200))).toHaveLength(64);
  });

  test('returns null when nothing usable survives — the caller must refuse', () => {
    // The case that matters: a mustache key that resolved to nothing at all.
    expect(ensureChatKeySlug('')).toBeNull();
    expect(ensureChatKeySlug('   ')).toBeNull();
    expect(ensureChatKeySlug('!!!')).toBeNull();
  });
});

// `ensure` was the original name for this action, borrowed from
// infra-as-code: it described the mechanism (upsert) rather than what the fire
// does, which is carry on the subject's existing chat. Jobs written before the
// rename still carry it on disk, and a job that stops parsing is a job that
// silently stops running.
describe('the `ensure` → `continue` rename', () => {
  const base = { daemonId: 'd1', folder: '/work', skill: 'app-update' };

  test('a job stored as `ensure` still parses, and reads as `continue`', () => {
    const parsed = JobAction.parse({ type: 'ensure', ...base });
    expect(parsed.type).toBe('continue');
  });

  test('the legacy name keeps every other field intact', () => {
    const parsed = JobAction.parse({
      type: 'ensure',
      ...base,
      key: '{{payload.event_data.id}}',
      startArchived: true,
    });
    expect(parsed).toMatchObject({
      type: 'continue',
      key: '{{payload.event_data.id}}',
      startHidden: true,
      folder: '/work',
    });
  });

  test('the new name parses directly', () => {
    expect(JobAction.parse({ type: 'continue', ...base }).type).toBe('continue');
  });

  test('the rename does not smuggle past the skill-or-prompt rule', () => {
    expect(() => JobAction.parse({ type: 'ensure', daemonId: 'd1', folder: '/work' })).toThrow();
  });
});

// spec/08 ## Action — `includePayload`. Default-ON like `notifyOnComplete`:
// absent and `true` both mean the trigger event is appended, only `false`
// opts out. Carried by every action that delivers a user turn, never `script`.
describe('JobAction.includePayload', () => {
  const shapes = [
    { type: 'spawn', daemonId: 'h', folder: '/t', prompt: 'go' },
    { type: 'continue', daemonId: 'h', folder: '/t', prompt: 'go' },
    { type: 'message', chatId: 'c1', prompt: 'go' },
  ];

  test('accepted as true/false on spawn, continue and message; absent stays undefined', () => {
    for (const shape of shapes) {
      for (const v of [true, false]) {
        const res = JobAction.safeParse({ ...shape, includePayload: v });
        expect(res.success).toBe(true);
        if (res.success) expect((res.data as { includePayload?: boolean }).includePayload).toBe(v);
      }
      const bare = JobAction.safeParse(shape);
      expect(bare.success).toBe(true);
      if (bare.success)
        expect((bare.data as { includePayload?: boolean }).includePayload).toBeUndefined();
    }
  });

  test('rejected on a script action, which has no prompt', () => {
    expect(
      JobAction.safeParse({
        type: 'script',
        daemonId: 'h',
        folder: '/t',
        command: 'true',
        includePayload: false,
      }).success,
    ).toBe(false);
  });

  test('a non-boolean is rejected', () => {
    expect(JobAction.safeParse({ ...shapes[0], includePayload: 'no' }).success).toBe(false);
  });
});
