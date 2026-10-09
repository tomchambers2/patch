// Jobs editor logic (spec/15 § Jobs editor). Validation, payload
// shaping, and load-existing round-trip — parity with the web editor.

import { describe, it, expect } from 'vitest';
import type { Job } from '@patch/wire/jobs';
import { JobAction, JobCreateBody } from '@patch/wire/jobs';
import {
  buildGroupOptions,
  DEFAULT_FORM,
  type FormState,
  formToBody,
  jobToForm,
  resolveSkillEditTarget,
  validateForm,
} from '../src/lib/jobEditor';
import { parseNaturalSchedule, describeCron } from '../src/lib/naturalCron';

// A spawn/ensure action names the machine the chat runs on (spec/08 § Action):
// a job fires unattended, so a body without a host would dispatch nowhere. The
// base form therefore carries one, and the cases that assert the missing-host
// refusal clear it explicitly.
const HOST = 'd1';

// `DEFAULT_FORM.cronTimezone` is the DEVICE's zone, so leaving it alone would
// make every body assertion below depend on where the test machine happens to
// be. Pin it to UTC (which `formToBody` omits) so the shapes are stable; the
// zone's own behaviour is covered in jobEditor.timezone.test.ts.
function form(overrides: Partial<FormState>): FormState {
  return { ...DEFAULT_FORM, cronTimezone: 'UTC', spawnDaemonId: HOST, ...overrides };
}

describe('buildGroupOptions', () => {
  it('returns every distinct non-empty group, alphabetical, deduped', () => {
    expect(
      buildGroupOptions([
        { group: 'Home' },
        { group: 'Finance' },
        { group: '' },
        { group: undefined },
        { group: 'Home' },
      ]),
    ).toEqual(['Finance', 'Home']);
  });

  it('is empty when no job carries a group', () => {
    expect(buildGroupOptions([{ group: '' }, {}])).toEqual([]);
  });
});

describe('validateForm', () => {
  it('requires a name', () => {
    expect(validateForm(form({ name: '', spawnFolder: '/p', spawnPrompt: 'go' }))).toMatch(
      /name is required/i,
    );
  });

  it('requires a cron expression for a cron trigger', () => {
    expect(
      validateForm(form({ name: 'j', cronExpression: '', spawnFolder: '/p', spawnPrompt: 'go' })),
    ).toMatch(/cron expression is empty/i);
  });

  it('requires a host for a spawn action, before anything else about it', () => {
    expect(
      validateForm(
        form({
          name: 'j',
          actionType: 'spawn',
          spawnDaemonId: '',
          spawnFolder: '/p',
          spawnPrompt: 'go',
        }),
      ),
    ).toMatch(/which host/i);
  });

  it('requires a host for an ensure action', () => {
    expect(
      validateForm(
        form({
          name: 'j',
          actionType: 'continue',
          spawnDaemonId: '',
          spawnFolder: '/p',
          spawnPrompt: 'go',
        }),
      ),
    ).toMatch(/which host/i);
  });

  it('requires a folder for a spawn action', () => {
    expect(
      validateForm(form({ name: 'j', actionType: 'spawn', spawnFolder: '', spawnPrompt: 'go' })),
    ).toMatch(/choose a folder/i);
  });

  it('requires a folder for an ensure action', () => {
    expect(
      validateForm(form({ name: 'j', actionType: 'continue', spawnFolder: '', spawnPrompt: 'go' })),
    ).toMatch(/choose a folder/i);
  });

  it('requires a recipient chat for a message action', () => {
    expect(
      validateForm(
        form({ name: 'j', actionType: 'message', messageChatId: '', messagePrompt: 'hi' }),
      ),
    ).toMatch(/pick a chat/i);
  });

  it('requires a skill or a prompt on the action', () => {
    expect(
      validateForm(form({ name: 'j', spawnFolder: '/p', spawnPrompt: '', spawnSkill: '' })),
    ).toMatch(/skill or a prompt/i);
  });

  it('passes a fully-specified spawn form', () => {
    expect(
      validateForm(form({ name: 'Morning brief', spawnFolder: '/p', spawnPrompt: 'go' })),
    ).toBeNull();
  });

  it('passes a message form with a skill and no prompt', () => {
    expect(
      validateForm(
        form({
          name: 'j',
          actionType: 'message',
          messageChatId: 'c1',
          messageSkill: 'life-coach',
          messagePrompt: '',
        }),
      ),
    ).toBeNull();
  });
});

describe('formToBody', () => {
  it('shapes a cron + spawn body and never carries a filter for cron', () => {
    const body = formToBody(
      form({
        name: 'Morning brief',
        cronExpression: '0 9 * * 1-5',
        filter: 'payload.x', // should be dropped for cron
        actionType: 'spawn',
        spawnFolder: '/home/tom/p',
        spawnPrompt: 'brief me',
        spawnSkill: 'life-coach',
      }),
    );
    expect(body).toEqual({
      name: 'Morning brief',
      group: '',
      enabled: true,
      trigger: { type: 'cron', expression: '0 9 * * 1-5' },
      filter: null,
      // Explicitly null, exactly as `filter` is and for the same reason: on a
      // PATCH an omitted key LEAVES the stored value alone, so "no gate" has to
      // be said rather than left out or unticking one could never save
      // (spec/08 § Gate).
      gate: null,
      action: {
        type: 'spawn',
        daemonId: 'd1',
        folder: '/home/tom/p',
        prompt: 'brief me',
        skill: 'life-coach',
      },
    });
    // Round-trips through the canonical wire schema.
    expect(() => JobCreateBody.parse(body)).not.toThrow();
  });

  it('shapes a message action targeting a chat', () => {
    const body = formToBody(
      form({
        name: 'Nudge',
        actionType: 'message',
        messageChatId: 'chat-42',
        messagePrompt: 'remind me',
      }),
    );
    expect(body.action).toEqual({ type: 'message', chatId: 'chat-42', prompt: 'remind me' });
    expect(() => JobCreateBody.parse(body)).not.toThrow();
  });

  it('keeps a JSONata filter for a payload-bearing trigger', () => {
    const body = formToBody(
      form({
        name: 'Hook',
        triggerType: 'webhook',
        webhookScheme: 'none',
        filter: '$minutesToStart < 15',
        actionType: 'message',
        messageChatId: 'c1',
        messagePrompt: 'go',
      }),
    );
    expect(body.filter).toBe('$minutesToStart < 15');
    expect(body.trigger).toEqual({ type: 'webhook', scheme: 'none' });
    expect(() => JobCreateBody.parse(body)).not.toThrow();
  });

  it('omits an empty webhook secret', () => {
    const body = formToBody(
      form({
        name: 'Hook',
        triggerType: 'webhook',
        webhookScheme: 'none',
        webhookSecret: '',
        actionType: 'spawn',
        spawnFolder: '/p',
        spawnPrompt: 'go',
      }),
    );
    expect(body.trigger).toEqual({ type: 'webhook', scheme: 'none' });
  });

  it('includes a non-empty webhook secret', () => {
    const body = formToBody(
      form({
        name: 'Hook',
        triggerType: 'webhook',
        webhookScheme: 'hmac-sha256',
        webhookSecret: 's3cret',
        actionType: 'spawn',
        spawnFolder: '/p',
        spawnPrompt: 'go',
      }),
    );
    expect(body.trigger).toEqual({ type: 'webhook', scheme: 'hmac-sha256', secret: 's3cret' });
    expect(() => JobCreateBody.parse(body)).not.toThrow();
  });

  it('omits an empty message prompt/skill', () => {
    const body = formToBody(
      form({
        name: 'Msg',
        actionType: 'message',
        messageChatId: 'c1',
        messagePrompt: '',
        messageSkill: 'a-skill', // at least one of skill|prompt required by validateForm, not formToBody itself
      }),
    );
    expect(body.action).toEqual({ type: 'message', chatId: 'c1', skill: 'a-skill' });
  });

  it('includes a non-empty message prompt and skill together', () => {
    const body = formToBody(
      form({
        name: 'Msg',
        actionType: 'message',
        messageChatId: 'c1',
        messagePrompt: 'remind me',
        messageSkill: 'a-skill',
      }),
    );
    expect(body.action).toEqual({
      type: 'message',
      chatId: 'c1',
      prompt: 'remind me',
      skill: 'a-skill',
    });
  });

  it('omits an empty spawn prompt/skill', () => {
    const body = formToBody(
      form({
        name: 'Spawn',
        actionType: 'spawn',
        spawnFolder: '/p',
        spawnPrompt: '',
        spawnSkill: '',
      }),
    );
    expect(body.action).toEqual({ type: 'spawn', daemonId: 'd1', folder: '/p' });
  });

  it('always sends group, trimmed, even when empty', () => {
    const body = formToBody(
      form({ name: 'Grouped', group: '  Home  ', spawnFolder: '/p', spawnPrompt: 'go' }),
    );
    expect(body.group).toBe('Home');
    const ungrouped = formToBody(form({ name: 'Bare', spawnFolder: '/p', spawnPrompt: 'go' }));
    expect(ungrouped.group).toBe('');
  });

  it('a spawn action pinned to a non-default permission mode is written', () => {
    const body = formToBody(
      form({
        name: 'Careful',
        actionType: 'spawn',
        spawnFolder: '/p',
        spawnPrompt: 'go',
        spawnPermissionMode: 'plan',
      }),
    );
    expect(body.action).toEqual({
      type: 'spawn',
      daemonId: 'd1',
      folder: '/p',
      prompt: 'go',
      permissionMode: 'plan',
    });
  });

  it('the default Auto permission mode is omitted, not written', () => {
    const body = formToBody(form({ name: 'Default', spawnFolder: '/p', spawnPrompt: 'go' }));
    expect(body.action).not.toHaveProperty('permissionMode');
  });

  it('shapes a todoist trigger (no payload fields of its own)', () => {
    const body = formToBody(
      form({
        name: 'Todoist job',
        triggerType: 'todoist',
        actionType: 'spawn',
        spawnFolder: '/p',
        spawnPrompt: 'go',
      }),
    );
    expect(body.trigger).toEqual({ type: 'todoist' });
    expect(() => JobCreateBody.parse(body)).not.toThrow();
  });
});

describe('jobToForm', () => {
  const base = { id: 'j1', enabled: true, createdAt: 0, updatedAt: 0 } as const;

  it('loads a cron + spawn job', () => {
    const job: Job = {
      ...base,
      name: 'Brief',
      trigger: { type: 'cron', expression: '30 8 * * 1' },
      filter: null,
      action: { type: 'spawn', daemonId: 'd1', folder: '/p', prompt: 'go', skill: 'x' },
    };
    const f = jobToForm(job);
    expect(f.name).toBe('Brief');
    expect(f.triggerType).toBe('cron');
    expect(f.cronExpression).toBe('30 8 * * 1');
    expect(f.actionType).toBe('spawn');
    expect(f.spawnFolder).toBe('/p');
    expect(f.spawnPrompt).toBe('go');
    expect(f.spawnSkill).toBe('x');
    expect(f.group).toBe('');
  });

  it('loads a job carrying a group', () => {
    const job: Job = {
      ...base,
      name: 'Brief',
      group: 'Home',
      trigger: { type: 'cron', expression: '30 8 * * 1' },
      filter: null,
      action: { type: 'spawn', daemonId: 'd1', folder: '/p', prompt: 'go' },
    };
    expect(jobToForm(job).group).toBe('Home');
  });

  it('a job with no stored permission mode loads as Auto', () => {
    const job: Job = {
      ...base,
      name: 'Brief',
      trigger: { type: 'cron', expression: '30 8 * * 1' },
      filter: null,
      action: { type: 'spawn', daemonId: 'd1', folder: '/p', prompt: 'go' },
    };
    expect(jobToForm(job).spawnPermissionMode).toBe('auto');
  });

  it('loads a webhook-trigger job into the webhook fields', () => {
    const job: Job = {
      ...base,
      name: 'Hook job',
      trigger: { type: 'webhook', scheme: 'hmac-sha256', secret: 's3cret' },
      filter: null,
      action: { type: 'spawn', daemonId: 'd1', folder: '/p', prompt: 'go' },
    };
    const f = jobToForm(job);
    expect(f.triggerType).toBe('webhook');
    expect(f.webhookScheme).toBe('hmac-sha256');
    expect(f.webhookSecret).toBe('s3cret');
  });

  it('loads a webhook-trigger job with no secret (default kept)', () => {
    const job: Job = {
      ...base,
      name: 'Hook job 2',
      trigger: { type: 'webhook', scheme: 'none' },
      filter: null,
      action: { type: 'spawn', daemonId: 'd1', folder: '/p', prompt: 'go' },
    };
    const f = jobToForm(job);
    expect(f.webhookSecret).toBe('');
  });

  it('loads a message job into the message fields', () => {
    const job: Job = {
      ...base,
      name: 'Msg',
      trigger: { type: 'todoist' },
      filter: 'x',
      action: { type: 'message', chatId: 'c9', prompt: 'p' },
    };
    const f = jobToForm(job);
    expect(f.actionType).toBe('message');
    expect(f.messageChatId).toBe('c9');
    expect(f.messagePrompt).toBe('p');
    expect(f.filter).toBe('x');
  });

  it('loads a message job with no prompt/skill (defaults kept)', () => {
    const job: Job = {
      ...base,
      name: 'Msg2',
      trigger: { type: 'todoist' },
      filter: null,
      action: { type: 'message', chatId: 'c9', skill: 's1' },
    };
    const f = jobToForm(job);
    expect(f.messagePrompt).toBe('');
    expect(f.messageSkill).toBe('s1');
  });

  it('edit round-trip: load then reshape reproduces the trigger + action', () => {
    const job: Job = {
      ...base,
      name: 'RT',
      trigger: { type: 'cron', expression: '0 12 * * *' },
      filter: null,
      action: { type: 'continue', daemonId: 'd1', folder: '/p', skill: 's' },
    };
    const body = formToBody(jobToForm(job));
    expect(body.trigger).toEqual({ type: 'cron', expression: '0 12 * * *' });
    expect(body.action).toEqual({ type: 'continue', daemonId: 'd1', folder: '/p', skill: 's' });
  });

  // spec/15 § Job editor — Model, matching web. The absence of a model is a
  // real setting (each fire takes the host's last-used one, spec/08 § Action),
  // so it has to survive a round-trip as an ABSENT field, not an empty string.
  describe('action model', () => {
    it('a job with no model loads as Host default and posts no model', () => {
      const job: Job = {
        ...base,
        name: 'No model',
        trigger: { type: 'cron', expression: '0 9 * * *' },
        filter: null,
        action: { type: 'spawn', daemonId: 'd1', folder: '/p', prompt: 'go' },
      };
      const f = jobToForm(job);
      expect(f.spawnModel).toBe('');
      expect(formToBody(f).action).not.toHaveProperty('model');
    });

    it('round-trips a spawn model', () => {
      const job: Job = {
        ...base,
        name: 'Pinned',
        trigger: { type: 'cron', expression: '0 9 * * *' },
        filter: null,
        action: {
          type: 'spawn',
          daemonId: 'd1',
          folder: '/p',
          prompt: 'go',
          model: 'claude-opus-5',
        },
      };
      const f = jobToForm(job);
      expect(f.spawnModel).toBe('claude-opus-5');
      expect(formToBody(f).action).toEqual({
        type: 'spawn',
        daemonId: 'd1',
        folder: '/p',
        prompt: 'go',
        model: 'claude-opus-5',
      });
    });

    it('round-trips an ensure model', () => {
      const job: Job = {
        ...base,
        name: 'Ensure pinned',
        trigger: { type: 'cron', expression: '0 9 * * *' },
        filter: null,
        action: {
          type: 'continue',
          daemonId: 'd1',
          folder: '/p',
          skill: 's',
          model: 'claude-haiku-4-5',
        },
      };
      expect(formToBody(jobToForm(job)).action).toEqual({
        type: 'continue',
        daemonId: 'd1',
        folder: '/p',
        skill: 's',
        model: 'claude-haiku-4-5',
      });
    });

    it('clearing back to Host default drops the field entirely', () => {
      const job: Job = {
        ...base,
        name: 'Unpin',
        trigger: { type: 'cron', expression: '0 9 * * *' },
        filter: null,
        action: {
          type: 'spawn',
          daemonId: 'd1',
          folder: '/p',
          prompt: 'go',
          model: 'claude-opus-5',
        },
      };
      const body = formToBody({ ...jobToForm(job), spawnModel: '' });
      expect(body.action).not.toHaveProperty('model');
    });

    it('a message action never carries a model, even with one in form state', () => {
      const body = formToBody({
        ...DEFAULT_FORM,
        name: 'Msg',
        actionType: 'message',
        messageChatId: 'c1',
        messagePrompt: 'hi',
        // A model here is meaningless: `message` inherits host, folder and model
        // from the chat it delivers into, and @patch/wire's .strict() refuses it.
        spawnModel: 'claude-opus-5',
      });
      expect(body.action).not.toHaveProperty('model');
    });
  });
});

describe('naturalCron', () => {
  it('parses common phrases', () => {
    expect(parseNaturalSchedule('every weekday at 9am')).toBe('0 9 * * 1-5');
    expect(parseNaturalSchedule('every 15 minutes')).toBe('*/15 * * * *');
    expect(parseNaturalSchedule('every 5 minutes between 9am and 5pm')).toBe('*/5 9-17 * * *');
  });

  it('returns null for an unparseable phrase', () => {
    expect(parseNaturalSchedule('whenever I feel like it')).toBeNull();
  });

  it('describes a cron expression readably', () => {
    expect(describeCron('0 9 * * 1-5')).toBe('weekdays at 9am');
  });
});

// The mobile editor draws no control for `hidden`, `permissionMode` or an
// ensure `key`. It used to DROP all three on save, so opening a job on the
// phone and changing its name silently un-hid it (and would un-key a per-task
// `ensure`, collapsing one chat per subject onto one shared chat) with nothing
// anywhere to say so. They are carried through the form state instead.
describe('fields with no mobile control still survive a save', () => {
  const base = {
    id: 'j1',
    name: 'Patch Updates',
    enabled: true,
    trigger: { type: 'todoist' } as const,
    filter: null,
    createdAt: 1,
    updatedAt: 1,
  };

  it('round-trips a hidden + keyed ensure action untouched', () => {
    const job: Job = {
      ...base,
      action: {
        type: 'continue',
        daemonId: 'd1',
        folder: '/p',
        skill: 'app-update',
        key: '{{payload.event_data.id}}',
        startHidden: true,
      },
    };
    const body = formToBody({ ...jobToForm(job), name: 'renamed' });
    expect(body.action).toEqual(job.action);
    // And it is still a body the server accepts.
    expect(JobCreateBody.safeParse(body).success).toBe(true);
  });

  it('round-trips a hidden spawn action with a pinned permission mode', () => {
    const job: Job = {
      ...base,
      action: {
        type: 'spawn',
        daemonId: 'd1',
        folder: '/p',
        prompt: 'go',
        startHidden: true,
        permissionMode: 'acceptEdits',
      },
    };
    const body = formToBody({ ...jobToForm(job), name: 'renamed' });
    expect(body.action).toEqual(job.action);
  });

  // spec/08 ## Action — `startArchived` was renamed `startHidden` on
  // 2026-09-28. A job stored under the old name reaches the phone translated,
  // and saving it from here writes only the new name back.
  it('a job stored with the legacy startArchived saves as startHidden', () => {
    const job: Job = {
      ...base,
      action: JobAction.parse({
        type: 'spawn',
        daemonId: 'd1',
        folder: '/p',
        prompt: 'go',
        startArchived: true,
      }),
    };
    const form = jobToForm(job);
    expect(form.spawnHidden).toBe(true);
    const body = formToBody({ ...form, name: 'renamed' });
    expect(body.action).toEqual({
      type: 'spawn',
      daemonId: 'd1',
      folder: '/p',
      prompt: 'go',
      startHidden: true,
    });
    expect(body.action).not.toHaveProperty('startArchived');
  });

  // spec/08 ## Action — `notifyOnComplete` has no mobile control either, and it
  // is the DEFAULT-ON one, so the trap is the opposite way round: dropping it
  // on save would silently turn a silenced job's doorbell back ON.
  it('round-trips a silenced spawn action untouched', () => {
    const job: Job = {
      ...base,
      action: {
        type: 'spawn',
        daemonId: 'd1',
        folder: '/p',
        prompt: 'go',
        notifyOnComplete: false,
      },
    };
    const body = formToBody({ ...jobToForm(job), name: 'renamed' });
    expect(body.action).toEqual(job.action);
    expect(JobCreateBody.safeParse(body).success).toBe(true);
  });

  it('round-trips a hidden + silenced keyed ensure action untouched', () => {
    const job: Job = {
      ...base,
      action: {
        type: 'continue',
        daemonId: 'd1',
        folder: '/p',
        skill: 'app-update',
        key: '{{payload.event_data.id}}',
        startHidden: true,
        notifyOnComplete: false,
      },
    };
    const body = formToBody({ ...jobToForm(job), name: 'renamed' });
    expect(body.action).toEqual(job.action);
    expect(JobCreateBody.safeParse(body).success).toBe(true);
  });

  it('round-trips includePayload: false on spawn and message, and drops a redundant true', () => {
    for (const action of [
      { type: 'spawn', daemonId: 'd1', folder: '/p', prompt: 'go', includePayload: false },
      { type: 'message', chatId: 'c1', prompt: 'go', includePayload: false },
    ] as const) {
      const body = formToBody({ ...jobToForm({ ...base, action }), name: 'renamed' });
      expect(body.action).toEqual(action);
      expect(JobCreateBody.safeParse(body).success).toBe(true);
    }
    const redundant = formToBody(
      jobToForm({
        ...base,
        action: { type: 'message', chatId: 'c1', prompt: 'go', includePayload: true },
      }),
    );
    expect(redundant.action).not.toHaveProperty('includePayload');
  });

  // A redundant stored `true` means the same as absent, and the form's
  // encoding is the absent one — so it normalises away rather than persisting
  // a no-op key an older host would reject.
  it('a redundant stored notifyOnComplete: true normalises to no key', () => {
    const job: Job = {
      ...base,
      action: { type: 'spawn', daemonId: 'd1', folder: '/p', prompt: 'go', notifyOnComplete: true },
    };
    const body = formToBody(jobToForm(job));
    expect(body.action).not.toHaveProperty('notifyOnComplete');
    expect(Object.keys(body.action).sort()).toEqual(['daemonId', 'folder', 'prompt', 'type']);
  });

  // WIRE COMPATIBILITY: the actions are `.strict()` and a host OTAs its host
  // separately from the server, so a job carrying none of these must serialise
  // to EXACTLY the keys it had before they existed — no `startHidden: false`
  // and no `notifyOnComplete: true`.
  it('adds no key at all to an action that carries none of them', () => {
    const job: Job = {
      ...base,
      action: { type: 'continue', daemonId: 'd1', folder: '/p', skill: 'app-update' },
    };
    const body = formToBody(jobToForm(job));
    expect(Object.keys(body.action).sort()).toEqual(['daemonId', 'folder', 'skill', 'type']);
    expect(JSON.stringify(body.action)).toBe(JSON.stringify(job.action));
  });
});

// The Skill picker's Edit link (spec/15 § Job editor) — where it should point,
// or why there is none. Mirrors web's `resolveSkillLink`, but mobile addresses
// a skill's file by host + absolute path (spec/03 § Host files) rather than
// through a chat, so there is no "no chat in this folder" / "outside the
// folder" case to cover — those are exactly what the host files API exists to
// avoid.
describe('resolveSkillEditTarget', () => {
  it('is null when no skill is chosen — nothing to link to or explain', () => {
    expect(resolveSkillEditTarget({ skill: '', paths: { a: '/p/a' }, daemonId: 'd1' })).toBeNull();
  });

  it('gives a reason when no host is known yet', () => {
    expect(resolveSkillEditTarget({ skill: 'life-coach', paths: undefined, daemonId: '' })).toEqual(
      { reason: 'pick a host first' },
    );
  });

  it('gives a reason when the host answers with no paths at all (an older host)', () => {
    expect(
      resolveSkillEditTarget({ skill: 'life-coach', paths: undefined, daemonId: 'd1' }),
    ).toEqual({ reason: 'host does not report skill files' });
  });

  // Todoist 6hfrrmrhG6GM3V36 — distinct from "no paths at all" above: the host
  // DID answer (plant resolves), this one skill (e.g. a machine-level one
  // like chrome-cdp) just isn't on it. Conflating the two read as the host
  // being incapable even when it answered fine for every other skill.
  it('gives a DIFFERENT reason when the host answered but this skill is missing from it', () => {
    expect(
      resolveSkillEditTarget({ skill: 'life-coach', paths: { plant: '/p/plant' }, daemonId: 'd1' }),
    ).toEqual({ reason: 'skill not found on this host' });
  });

  it('resolves the host + absolute path for a skill the host reports', () => {
    expect(
      resolveSkillEditTarget({
        skill: 'life-coach',
        paths: { 'life-coach': '/home/tom/.claude/skills/life-coach/SKILL.md' },
        daemonId: 'd1',
      }),
    ).toEqual({ daemonId: 'd1', path: '/home/tom/.claude/skills/life-coach/SKILL.md' });
  });
});

describe('structured recurrence builder helpers', () => {
  it('round-trips a rule through parse → build', async () => {
    const { parseRecurrenceFields } = await import('@patch/wire');
    const { recurrenceFieldsToRule } = await import('../src/lib/jobEditor');
    for (const rule of [
      'FREQ=WEEKLY;BYDAY=MO,FR;BYHOUR=8;BYMINUTE=30',
      'FREQ=MONTHLY;BYDAY=SU;BYSETPOS=3;BYHOUR=9;BYMINUTE=0',
      'FREQ=YEARLY;BYDAY=SA;BYSETPOS=-1;BYMONTH=3,10;BYHOUR=1;BYMINUTE=0',
    ]) {
      expect(recurrenceFieldsToRule(parseRecurrenceFields(rule)!)).toBe(rule);
    }
  });

  it('frequency changes keep the rule parseable', async () => {
    const { parseRecurrenceFields } = await import('@patch/wire');
    const j = await import('../src/lib/jobEditor');
    const weekly = parseRecurrenceFields('FREQ=WEEKLY;BYDAY=MO,FR;BYHOUR=8;BYMINUTE=30')!;
    const yearly = j.withRecurrenceFrequency(weekly, 'YEARLY');
    expect(parseRecurrenceFields(j.recurrenceFieldsToRule(yearly))).not.toBeNull();
    expect(yearly.days).toEqual(['MO']);
    expect(j.withRecurrenceFrequency(yearly, 'WEEKLY').months).toBeNull();
  });

  it('weekday toggle never empties a weekly rule; monthly replaces', async () => {
    const { parseRecurrenceFields } = await import('@patch/wire');
    const j = await import('../src/lib/jobEditor');
    const w = parseRecurrenceFields('FREQ=WEEKLY;BYDAY=MO;BYHOUR=8;BYMINUTE=0')!;
    expect(j.toggleRecurrenceDay(w, 'MO').days).toEqual(['MO']);
    expect(j.toggleRecurrenceDay(w, 'TU').days).toEqual(['MO', 'TU']);
    const m = parseRecurrenceFields('FREQ=MONTHLY;BYDAY=SU;BYSETPOS=1;BYHOUR=8;BYMINUTE=0')!;
    expect(j.toggleRecurrenceDay(m, 'TU').days).toEqual(['TU']);
  });

  it('parses 24h times strictly', async () => {
    const j = await import('../src/lib/jobEditor');
    expect(j.parseTimeHHMM('9:05')).toEqual({ hour: 9, minute: 5 });
    expect(j.parseTimeHHMM('24:00')).toBeNull();
    expect(j.parseTimeHHMM('9')).toBeNull();
  });
});
