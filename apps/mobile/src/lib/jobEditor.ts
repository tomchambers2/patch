// Pure form logic for the mobile job editor (spec/15 § Job editor).
// Mirrors packages/web/src/routes/JobEditorRoute.tsx so the two surfaces
// shape identical job bodies. Kept RN-free so the validation + payload shaping
// is unit-testable in plain Node (vitest).
//
// NO FALLBACK: validation returns a specific, field-naming message rather than
// letting a malformed body hit the server and 400 with a generic reason.

import type { Job, JobAction, JobCreateBody, JobTrigger, WebhookScheme } from '@patch/wire/jobs';
import type { PermissionMode } from '@patch/wire';
import { isValidTimeZone, type RecurrenceFields } from '@patch/wire';

/**
 * This device's IANA zone, the default for a NEW cron job. `UTC` only when the
 * runtime reports no zone at all — a missing capability, and also exactly what
 * the server does with a trigger carrying no zone.
 */
export function deviceTimeZone(): string {
  const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return resolved && resolved.length > 0 ? resolved : 'UTC';
}

/**
 * The Group picker's options (spec/08 § Groups, spec/15 § Job editor): every
 * distinct group already in use across the user's jobs, alphabetical.
 */
export function buildGroupOptions(jobs: readonly { group?: string }[]): string[] {
  const distinct = new Set(jobs.map((j) => j.group).filter((g): g is string => !!g));
  return [...distinct].sort((a, b) => a.localeCompare(b));
}

/**
 * Where the Edit link beside the Skill picker should point, or why there is
 * none (spec/15 § Job editor). Mobile addresses a skill's file through the
 * host files API — daemonId + absolute path, no chat in between (spec/03 §
 * Host files) — so unlike web's chat-scoped file browser it reaches a skill
 * anywhere on the host, including a machine-wide one under `~/.claude/skills`
 * that sits outside every project folder. NO FALLBACK: a path is never
 * guessed, and a link that would fail is never rendered — the caller shows
 * `reason` instead.
 */
export type SkillEditTarget = { daemonId: string; path: string } | { reason: string } | null;

export function resolveSkillEditTarget(input: {
  /** The selected skill's name — empty when none is chosen. */
  skill: string;
  /** Absolute host-side file per skill name, as reported by GET /api/skills. */
  paths: Record<string, string> | undefined;
  /** The action's host — empty when no folder/host is chosen yet. */
  daemonId: string;
}): SkillEditTarget {
  // No skill chosen — there is nothing to link to and nothing to explain.
  if (input.skill === '') return null;
  if (input.daemonId.trim() === '') return { reason: 'pick a host first' };
  // An older host answers without paths at all (the field is optional
  // precisely so it can) — say so rather than construct a path from the name.
  // That is a DIFFERENT case from `paths` being present but missing just this
  // skill's key, which is the normal result for a machine-level skill asked
  // about from a host that genuinely doesn't have it.
  if (input.paths === undefined) return { reason: 'host does not report skill files' };
  const path = input.paths[input.skill];
  if (path === undefined) return { reason: 'skill not found on this host' };
  return { daemonId: input.daemonId, path };
}

export interface FormState {
  name: string;
  /**
   * Free-text organisational label (spec/08 § Groups), same round-tripping
   * rule as web's editor: always sent, never omitted — an empty string
   * clears a job's group rather than leaving it alone, since the editor
   * always submits the whole form.
   */
  group: string;
  enabled: boolean;
  triggerType: JobTrigger['type'];
  /** Natural-language schedule text the user typed (cron triggers only). */
  scheduleText: string;
  cronExpression: string;
  /**
   * IANA zone the cron expression is evaluated in (spec/08 § Cron). `'UTC'` is
   * the meaning of a trigger with no `timezone`, so an existing pre-timezone
   * job loads as `'UTC'` and round-trips as an ABSENT field — editing an old
   * job on mobile can never move when it fires. A NEW job defaults to this
   * device's zone.
   */
  cronTimezone: string;
  /**
   * Bare RRULE value string (spec/08 § Recurrence) — no `RRULE:` label, no
   * `DTSTART`. Mobile edits this as raw text only; the structured
   * frequency/weekday/month builder lives on web (`JobEditorRoute.tsx`).
   */
  recurrenceRule: string;
  /** IANA zone the RRULE is evaluated in — required, unlike cron's optional one. */
  recurrenceTimezone: string;
  webhookScheme: WebhookScheme;
  webhookSecret: string;
  filter: string;
  actionType: JobAction['type'];
  /** The host the spawned/ensured chat runs on (spec/08 § Action). */
  spawnDaemonId: string;
  spawnFolder: string;
  spawnPrompt: string;
  spawnSkill: string;
  /**
   * The model the chat runs on, from the chosen host's catalogue (spec/08 §
   * Action). Empty string is `Host default` — a real, persistent choice, not a
   * missing one: storing no model leaves each fire to take that host's
   * last-used model, so it must round-trip as an ABSENT field.
   *
   * Spawn/ensure only. A `message` action inherits host, folder and model from
   * the chat it delivers into, so this is never read for one.
   */
  spawnModel: string;
  /** The shared account the job's chat starts on; '' leaves it to the strategy (spec/08 § Action). */
  spawnAccount: string;
  /**
   * Keep this job's chat out of the sidebar (spec/08 ## Action). Carried by
   * `spawn` and `ensure` — both create the chat they place.
   *
   * There is no control for it on this surface yet, and that is precisely why
   * it is in the form state: without it a save from the phone silently UNhid a
   * job the user had hidden from the web editor, with nothing to tell them.
   */
  spawnHidden: boolean;
  /**
   * Ring the completion doorbell when a chat this job created settles (spec/08
   * ## Action). Same round-tripped-not-edited reason as `spawnHidden`, but the
   * INVERSE encoding: the flag defaults ON, so it is `false` that is stored and
   * `true`/absent that must be written as nothing at all.
   */
  spawnNotifyOnComplete: boolean;
  /** Append the trigger event JSON after the prompt; default ON, so only `false` is written. */
  includePayload: boolean;
  /**
   * `spawn` only (spec/15 § Job editor). `'auto'` is what an absent field
   * already means (spec/08 § Action) and is also this form's default, so it
   * is the one value `formToBody` omits — every other choice is a deliberate
   * pin and is written.
   */
  spawnPermissionMode: PermissionMode;
  /** `continue` only — the per-fire dedup key (Mustache template). */
  ensureKey: string;
  messageChatId: string;
  /**
   * `script` only — the command each fire runs on `spawnDaemonId` in
   * `spawnFolder` (spec/08 § Action). A script job has no chat, so no skill,
   * prompt, model or permission mode.
   */
  /**
   * The job's GATE (spec/08 § Gate) — a command asked before each fire, which
   * decides whether the action runs at all. `gateOn` is the editor's own state,
   * not a stored field: unticked persists as an absent `gate`, and the command is
   * KEPT while unticked so the script is not thrown away by a comparison.
   */
  gateOn: boolean;
  gateDaemonId: string;
  gateFolder: string;
  gateCommand: string;
  /** Empty means the 60s default. */
  gateTimeoutMs: string;
  scriptCommand: string;
  /** `script` only — empty means the 60s default. */
  scriptTimeoutMs: string;
  messagePrompt: string;
  messageSkill: string;
}

export const DEFAULT_FORM: FormState = {
  name: '',
  group: '',
  enabled: true,
  triggerType: 'cron',
  scheduleText: '',
  cronExpression: '0 9 * * *',
  cronTimezone: deviceTimeZone(),
  recurrenceRule: 'FREQ=WEEKLY;BYDAY=SU;BYHOUR=9;BYMINUTE=0',
  recurrenceTimezone: deviceTimeZone(),
  webhookScheme: 'none',
  webhookSecret: '',
  filter: '',
  gateOn: false,
  gateDaemonId: '',
  gateFolder: '',
  gateCommand: '',
  gateTimeoutMs: '',
  actionType: 'spawn',
  // Empty until settings/chat folders load; the picker shows a "Select…" prompt
  // rather than a literal path that matches no option.
  spawnDaemonId: '',
  spawnFolder: '',
  spawnPrompt: '',
  spawnSkill: '',
  // Host default — a new job pins nothing, so it tracks the machine rather
  // than freezing a model id that will eventually be retired.
  spawnModel: '',
  spawnAccount: '',
  spawnHidden: false,
  // Default ON — a job notifies unless its action says otherwise.
  spawnNotifyOnComplete: true,
  includePayload: true,
  spawnPermissionMode: 'auto',
  ensureKey: '',
  messageChatId: '',
  scriptCommand: '',
  scriptTimeoutMs: '',
  messagePrompt: '',
  messageSkill: '',
};

/** Load an existing Job into editable form state. */
export function jobToForm(job: Job): FormState {
  const f: FormState = { ...DEFAULT_FORM };
  f.name = job.name;
  f.group = job.group ?? '';
  f.enabled = job.enabled;
  f.filter = job.filter ?? '';
  if (job.gate) {
    f.gateOn = true;
    f.gateDaemonId = job.gate.daemonId;
    f.gateFolder = job.gate.folder;
    f.gateCommand = job.gate.command;
    f.gateTimeoutMs = job.gate.timeoutMs === undefined ? '' : String(job.gate.timeoutMs);
  }
  f.triggerType = job.trigger.type;
  if (job.trigger.type === 'cron') {
    f.cronExpression = job.trigger.expression;
    // No stored zone means the server evaluates it in UTC — show that, not the
    // device's zone, or saving an untouched old job would move its fire time.
    f.cronTimezone = job.trigger.timezone ?? 'UTC';
    // Prefilled below by the screen via describeCron so an edited job shows a
    // readable phrase; we leave scheduleText blank here to keep this RN-free
    // (describeCron lives in naturalCron and the screen wires it in).
    f.scheduleText = '';
  }
  if (job.trigger.type === 'recurrence') {
    f.recurrenceRule = job.trigger.rrule;
    f.recurrenceTimezone = job.trigger.timezone;
  }
  if (job.trigger.type === 'webhook') {
    f.webhookScheme = job.trigger.scheme;
    f.webhookSecret = job.trigger.secret ?? '';
  }
  f.actionType = job.action.type;
  if (job.action.type === 'spawn' || job.action.type === 'continue') {
    f.spawnDaemonId = job.action.daemonId;
    f.spawnFolder = job.action.folder;
    f.spawnPrompt = job.action.prompt ?? '';
    f.spawnSkill = job.action.skill ?? '';
    // No stored model means Host default, which the picker shows as ''.
    f.spawnModel = job.action.model ?? '';
    f.spawnAccount = job.action.preferredAccountId ?? '';
    f.spawnHidden = job.action.startHidden === true;
    // Only an explicit `false` unticks it; absent — and a redundant `true` —
    // both mean notify.
    f.spawnNotifyOnComplete = job.action.notifyOnComplete !== false;
    f.includePayload = job.action.includePayload !== false;
    if (job.action.type === 'spawn') f.spawnPermissionMode = job.action.permissionMode ?? 'auto';
    else f.ensureKey = job.action.key ?? '';
  } else if (job.action.type === 'script') {
    f.spawnDaemonId = job.action.daemonId;
    f.spawnFolder = job.action.folder;
    f.scriptCommand = job.action.command;
    f.scriptTimeoutMs = job.action.timeoutMs === undefined ? '' : String(job.action.timeoutMs);
  } else {
    f.messageChatId = job.action.chatId;
    f.includePayload = job.action.includePayload !== false;
    f.messagePrompt = job.action.prompt ?? '';
    f.messageSkill = job.action.skill ?? '';
  }
  return f;
}

/**
 * Client-side validation mirroring the web editor + @patch/wire refinements.
 * Returns a specific error message, or null when the form is submittable.
 */
export function validateForm(form: FormState): string | null {
  // Name is server-required (min 1 char).
  if (!form.name.trim()) {
    return 'Name is required. Give this job a name.';
  }
  // A cron trigger needs a non-empty expression.
  if (form.triggerType === 'cron' && !form.cronExpression.trim()) {
    return 'Set a schedule. The cron expression is empty.';
  }
  // …and a zone this device can actually resolve. Typed by hand here, so a
  // typo is caught where there is someone to tell rather than 400ing.
  if (form.triggerType === 'cron' && !isValidTimeZone(form.cronTimezone.trim())) {
    return `“${form.cronTimezone.trim()}” is not an IANA timezone. Try e.g. Europe/London.`;
  }
  // A recurrence trigger needs a non-empty RRULE and a zone. RRULE parseability
  // itself is checked server-side (validate.ts's RRule.fromString gate) —
  // mirrors the shallow client-side cron check above rather than duplicating
  // the rrule parser here.
  if (form.triggerType === 'recurrence' && !form.recurrenceRule.trim()) {
    return 'Set a schedule. The RRULE is empty.';
  }
  if (form.triggerType === 'recurrence' && !isValidTimeZone(form.recurrenceTimezone.trim())) {
    return `“${form.recurrenceTimezone.trim()}” is not an IANA timezone. Try e.g. Europe/London.`;
  }
  // A gate with no host or folder would be asked nowhere, and the server's own
  // `JobGate` refuses it — say so here, where there is someone to tell.
  if (form.gateOn && form.gateCommand.trim().length > 0) {
    if (!form.gateDaemonId.trim()) return 'Choose which host the gate command runs on.';
    if (!form.gateFolder.trim()) return 'Choose a folder for the gate command to run in.';
  }
  const usesSpawnFields = form.actionType === 'spawn' || form.actionType === 'continue';
  // A `script` action is validated on its own terms: a host, a folder and a
  // command, and NO first turn (spec/08 § Action — `script`).
  if (form.actionType === 'script') {
    if (!form.spawnDaemonId.trim()) return 'Choose which host the command runs on.';
    if (!form.spawnFolder.trim()) return 'Choose a folder for the command to run in.';
    if (!form.scriptCommand.trim()) return 'Enter the command to run.';
    return null;
  }
  // spawn + ensure need a folder.
  // A job fires unattended, so one that cannot name a host would dispatch
  // nowhere. Refuse at save time, where there is someone to tell.
  if (usesSpawnFields && !form.spawnDaemonId.trim()) {
    return 'Choose which host the chat runs on.';
  }
  if (usesSpawnFields && !form.spawnFolder.trim()) {
    return 'Choose a folder for the chat.';
  }
  // message needs a recipient chat.
  if (form.actionType === 'message' && !form.messageChatId.trim()) {
    return 'Pick a chat to message.';
  }
  // An action needs AT LEAST ONE of skill|prompt (server-enforced).
  const skill = (usesSpawnFields ? form.spawnSkill : form.messageSkill).trim();
  const prompt = (usesSpawnFields ? form.spawnPrompt : form.messagePrompt).trim();
  if (!skill && !prompt) {
    return 'Add a Skill or a Prompt (or both). The action needs something to run.';
  }
  return null;
}

/** Shape the form into a JobCreateBody / JobPatchBody the REST endpoints accept. */
export function formToBody(form: FormState): JobCreateBody {
  let trigger: JobTrigger;
  switch (form.triggerType) {
    case 'cron':
      trigger = {
        type: 'cron',
        expression: form.cronExpression.trim(),
        // `UTC` IS the absent field. Omitting it keeps a pre-timezone job
        // byte-identical on save and keeps the body acceptable to an older
        // strict `CronTrigger` on a not-yet-OTA'd host.
        ...(form.cronTimezone.trim() !== 'UTC' ? { timezone: form.cronTimezone.trim() } : {}),
      };
      break;
    case 'webhook':
      trigger = {
        type: 'webhook',
        scheme: form.webhookScheme,
        ...(form.webhookSecret ? { secret: form.webhookSecret } : {}),
      };
      break;
    case 'todoist':
      trigger = { type: 'todoist' };
      break;
    case 'recurrence':
      trigger = {
        type: 'recurrence',
        rrule: form.recurrenceRule.trim(),
        timezone: form.recurrenceTimezone.trim(),
      };
      break;
  }

  let action: JobAction;
  if (form.actionType === 'spawn' || form.actionType === 'continue') {
    // spawn (fresh chat each fire) and ensure (one durable chat) share shape.
    action = {
      type: form.actionType,
      daemonId: form.spawnDaemonId.trim(),
      folder: form.spawnFolder.trim(),
      ...(form.spawnPrompt ? { prompt: form.spawnPrompt } : {}),
      ...(form.spawnSkill ? { skill: form.spawnSkill } : {}),
      // Spread conditionally: OMITTING model is what selects the host's
      // last-used one, so Host default must send no field at all.
      ...(form.spawnModel ? { model: form.spawnModel } : {}),
      ...(form.spawnAccount ? { preferredAccountId: form.spawnAccount } : {}),
      // Preserved, never defaulted. Each is written ONLY when set: the actions
      // are `.strict()` and a host OTAs its host separately from the server,
      // so a job that carries none of these must serialise byte-identically to
      // how it did before they existed.
      ...(form.spawnHidden ? { startHidden: true } : {}),
      // Inverted for the same byte-identity reason: absent IS the default here,
      // so only the off state writes a key.
      ...(form.spawnNotifyOnComplete ? {} : { notifyOnComplete: false }),
      ...(form.includePayload ? {} : { includePayload: false }),
      // `auto` is what an absent field already means (spec/08 § Action), so it
      // persists as absent — a job untouched on this control serialises
      // byte-identically to how it did before the field existed.
      ...(form.actionType === 'spawn' && form.spawnPermissionMode !== 'auto'
        ? { permissionMode: form.spawnPermissionMode }
        : {}),
      ...(form.actionType === 'continue' && form.ensureKey ? { key: form.ensureKey } : {}),
    };
  } else if (form.actionType === 'script') {
    action = {
      type: 'script',
      daemonId: form.spawnDaemonId.trim(),
      folder: form.spawnFolder.trim(),
      command: form.scriptCommand,
      // Empty means the default, and must persist as an ABSENT field — the
      // same rule `model` follows above.
      ...(form.scriptTimeoutMs ? { timeoutMs: Number(form.scriptTimeoutMs) } : {}),
    };
  } else {
    action = {
      type: 'message',
      chatId: form.messageChatId,
      ...(form.messagePrompt ? { prompt: form.messagePrompt } : {}),
      ...(form.messageSkill ? { skill: form.messageSkill } : {}),
      ...(form.includePayload ? {} : { includePayload: false }),
    };
  }

  return {
    name: form.name.trim(),
    // Always sent, never omitted — same as `name` and same as web (spec/08 §
    // Groups): an empty string clears a job's group rather than leaving it be.
    group: form.group.trim(),
    enabled: form.enabled,
    // Cron/recurrence triggers have no payload to filter — never persist one.
    filter:
      form.triggerType !== 'cron' && form.triggerType !== 'recurrence' && form.filter.length > 0
        ? form.filter
        : null,
    // `null`, not omitted, when off: a PATCH that omits the field LEAVES a stored
    // gate in place, so unticking has to say so or it would not save (spec/08
    // § Gate — `JobPatchBody.gate`).
    gate:
      form.gateOn && form.gateCommand.trim().length > 0
        ? {
            daemonId: form.gateDaemonId,
            folder: form.gateFolder,
            command: form.gateCommand,
            // Empty means the default, which persists as an ABSENT field.
            ...(form.gateTimeoutMs ? { timeoutMs: Number(form.gateTimeoutMs) } : {}),
          }
        : null,
    action,
    trigger,
  };
}

// ── structured recurrence builder ───────────────────────────────────────────
// The form keeps ONE source of truth, `recurrenceRule`. The builder controls
// read it through `parseRecurrenceFields` and write it back through
// `recurrenceFieldsToRule`, so they can never drift from what is submitted.
// A rule outside that narrow shape has no builder view; the screen then shows
// the raw RRULE field instead.

export const RECURRENCE_WEEKDAYS: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'MO', label: 'Mon' },
  { code: 'TU', label: 'Tue' },
  { code: 'WE', label: 'Wed' },
  { code: 'TH', label: 'Thu' },
  { code: 'FR', label: 'Fri' },
  { code: 'SA', label: 'Sat' },
  { code: 'SU', label: 'Sun' },
];

export const RECURRENCE_NTH: ReadonlyArray<{ value: string; label: string }> = [
  { value: '1', label: '1st' },
  { value: '2', label: '2nd' },
  { value: '3', label: '3rd' },
  { value: '4', label: '4th' },
  { value: '-1', label: 'Last' },
];

export const RECURRENCE_MONTHS: ReadonlyArray<{ n: number; label: string }> = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
].map((label, i) => ({ n: i + 1, label }));

/** Build the bare RRULE value for the builder's fields (the shape `parseRecurrenceFields` accepts). */
export function recurrenceFieldsToRule(f: RecurrenceFields): string {
  const parts = [`FREQ=${f.freq}`];
  if (f.freq === 'WEEKLY') {
    parts.push(`BYDAY=${f.days.join(',')}`);
  } else {
    parts.push(`BYDAY=${f.days[0] ?? ''}`, `BYSETPOS=${f.setPos ?? 1}`);
    if (f.months !== null && f.months.length > 0) {
      parts.push(`BYMONTH=${[...f.months].sort((a, b) => a - b).join(',')}`);
    }
  }
  parts.push(`BYHOUR=${f.hour}`, `BYMINUTE=${f.minute}`);
  return parts.join(';');
}

/** Frequency change: MONTHLY/YEARLY take exactly one weekday; WEEKLY takes no months. */
export function withRecurrenceFrequency(
  f: RecurrenceFields,
  freq: RecurrenceFields['freq'],
): RecurrenceFields {
  if (freq === 'WEEKLY') {
    return { ...f, freq, setPos: null, months: null };
  }
  return {
    ...f,
    freq,
    days: f.days.slice(0, 1).length > 0 ? f.days.slice(0, 1) : ['SU'],
    setPos: f.setPos ?? 1,
    // A YEARLY rule needs at least one month.
    months: f.months && f.months.length > 0 ? f.months : freq === 'YEARLY' ? [1] : null,
  };
}

/** WEEKLY toggles membership (never empties); MONTHLY/YEARLY replace the single day. */
export function toggleRecurrenceDay(f: RecurrenceFields, code: string): RecurrenceFields {
  if (f.freq !== 'WEEKLY') return { ...f, days: [code] };
  if (!f.days.includes(code)) return { ...f, days: [...f.days, code] };
  if (f.days.length === 1) return f;
  return { ...f, days: f.days.filter((d) => d !== code) };
}

/** Toggle a month; YEARLY keeps at least one. */
export function toggleRecurrenceMonth(f: RecurrenceFields, month: number): RecurrenceFields {
  const cur = f.months ?? [];
  if (!cur.includes(month)) return { ...f, months: [...cur, month].sort((a, b) => a - b) };
  if (f.freq === 'YEARLY' && cur.length === 1) return f;
  const next = cur.filter((m) => m !== month);
  return { ...f, months: next.length > 0 ? next : null };
}

/** `"09:05"` -> hour/minute, or null when not a valid 24h time. */
export function parseTimeHHMM(text: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}

export function formatTimeHHMM(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}
