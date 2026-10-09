// JobEditorRoute — /jobs/new and /jobs/:id form.
//
// One-form view per spec/14 ## Jobs view. Trigger picker (cron/recurrence/
// webhook/todoist) + JSONata filter textarea + two-axis action picker.

import { DateTimeField } from '../components/DateTimeField.js';
import type { JSX, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import type { Job, JobAction, JobCreateBody, JobTrigger, WebhookScheme } from '@patch/wire/jobs';
import { scriptVerdictLine } from '@patch/wire/jobs';
import type { PermissionMode } from '@patch/wire';
import { isJunkFolder, isReservedSpecialThread, permissionModesFor } from '@patch/wire';
import { describeRecurrence, parseRecurrenceFields } from '@patch/wire';
import { api, ApiError } from '../api/rest.js';
import { Toggle } from '../components/Toggle.js';
import { PERMISSION_MODES } from '../components/Composer.js';
import { permissionModeLabel } from '../lib/permissionModeLabel.js';
import { useUiStore } from '../stores/uiStore.js';
import { usePresenceStore, defaultDaemonId, hostDefaultModel } from '../stores/presenceStore.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import { useChatStore } from '../stores/chatStore.js';
import { jobChatId } from '../lib/jobDescribe.js';
import { openChatBesideJob, openChatInNewTab } from '../lib/openBeside.js';
import {
  parseDateRangeFromFilter,
  buildFilterFromDateRange,
  isoToLocalInputValue,
  localInputValueToIso,
} from '../lib/jobDateRangeFilter.js';
import { loadModels, useModelCatalog } from '../lib/models.js';
import { parseNaturalSchedule, describeCron } from '../lib/naturalCron.js';
import { MONACO_THEME } from '../lib/monacoTheme.js';
import { shortcutLabel } from '../lib/shortcuts.js';
import { isSubmitChord } from '../lib/submitChord.js';
import {
  UNSAVED_BADGE_LABEL,
  UNSAVED_CONFIRM,
  isDirty,
  shouldPromptOnLeave,
} from '../lib/unsavedChanges.js';
import { useNavigationGuard } from '../lib/useNavigationGuard.js';
import { useGoBack } from '../lib/useGoBack.js';
import { NavHistoryControls } from '../components/NavHistoryControls.js';
import { failed } from '../lib/errorCopy.js';

/**
 * Monaco, behind the same self-hosted bootstrap the editor rail uses — the
 * bundled module is handed to `@monaco-editor/loader` before
 * `@monaco-editor/react` can reach for the CSP-blocked CDN, and it is lazy so a
 * job form that is mostly text inputs does not drag the editor into the entry
 * chunk.
 */
const ScriptMonaco = lazy(async () => {
  await import('../lib/monaco-loader.js');
  const m = await import('@monaco-editor/react');
  return { default: m.Editor };
});

/** Collapsed and expanded heights for the command editor, in px. */
const SCRIPT_EDITOR_HEIGHT = 200;
const SCRIPT_EDITOR_HEIGHT_EXPANDED = 640;

/**
 * The `script` action's command, as a code editor.
 *
 * `command` is not a one-liner: it is handed to `bash -lc` whole, so the RIGHT
 * place for a gate's logic is here, in the job, where the app that runs it can
 * show it (see `ScriptAction`). A gate kept in a file on the host instead is
 * invisible from every surface — which is how Tom ended up unable to see when
 * photo-triage and foreman decide to spend money, or to change the hours they
 * keep, without going and reading bash over ssh.
 *
 * Which makes a 4-row `<textarea>` the wrong control, so this is Monaco with
 * shell highlighting, and `Edit` grows it to something you can actually work a
 * script in. Collapsed is still a real editor, not a preview — the button
 * changes the room, never the writability.
 */
function ScriptCommandEditor({
  value,
  onChange,
  name,
  heading = 'Command · run by `bash -lc` in the folder above',
  hint,
  reloadKey = 0,
}: {
  value: string;
  onChange: (next: string) => void;
  /**
   * Which command this is — `script` for the action's, `gate` for the gate's. One
   * job can carry BOTH, so each needs its own ids AND its own Monaco model path:
   * two editors left on the default path share one model, and typing in either
   * would write to both.
   */
  name: 'script' | 'gate';
  heading?: string;
  /** What this particular command is for. A gate's contract is not an action's. */
  hint?: JSX.Element;
  /**
   * Bump to reload the buffer from `value`. Monaco owns the TEXT once mounted —
   * the form owns only what gets SAVED — so this is the one thing that replaces
   * what is on screen, and the parent bumps it exactly when a DIFFERENT document
   * arrives (the job loaded from the API).
   *
   * It is an explicit key rather than "did `value` change?" because that question
   * cannot be answered here without losing keystrokes. The form's value arrives
   * back a render or two after the keystroke that caused it, so an effect
   * watching it sees a string that is already stale and re-applies it to a live
   * model, swallowing everything typed since. Comparing against the last value
   * emitted narrows the window but does not close it — the effect still runs for
   * intermediate renders. Typing `TYPED_OK=1` gave `TY_OK=1` before, and
   * `TYPED_O` after. Only the parent knows which changes are a new document.
   */
  reloadKey?: number;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="job-script-editor" data-testid={`job-${name}-editor`}>
      <div className="job-script-editor-head">
        <span>{heading}</span>
        <button
          type="button"
          className="job-script-expand"
          data-testid={`job-${name}-expand`}
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? 'Collapse' : 'Edit'}
        </button>
      </div>
      <div
        className="job-script-editor-body"
        style={{ height: expanded ? SCRIPT_EDITOR_HEIGHT_EXPANDED : SCRIPT_EDITOR_HEIGHT }}
      >
        <Suspense fallback={<div className="editor-loading">Loading editor…</div>}>
          <ScriptMonaco
            key={reloadKey}
            defaultValue={value}
            path={`job-${name}-command`}
            language="shell"
            theme={MONACO_THEME}
            options={{
              minimap: { enabled: false },
              // Monaco measures its container once at mount; without this the
              // editor keeps that height through the Edit toggle and ends up
              // drawn at 200px inside a 640px box.
              automaticLayout: true,
              scrollBeyondLastLine: false,
              lineNumbers: 'on',
              tabSize: 2,
              wordWrap: 'on',
            }}
            onChange={(next) => onChange(next ?? '')}
            loading={<div className="editor-loading">Loading editor…</div>}
          />
        </Suspense>
      </div>
      {/* What this command is expected to do, stated where it gets written. */}
      <p className="job-script-hint">
        {hint ?? (
          <>
            Print what you did on every fire, last line — it becomes the run’s headline. Announce a
            chat you start with <code>patch:chat &lt;chatId&gt;</code> so the run links to it. Exit
            non-zero only for a fault.
          </>
        )}
      </p>
    </div>
  );
}

// Pull the server's real reason out of a 400 body so a generic
// "invalid body" never hides which field failed (e.g. the action's
// skill|prompt rule). Falls back to the error message.
function describeApiError(e: unknown): string {
  if (e instanceof ApiError) {
    const body = e.body as {
      error?: string;
      message?: string;
      issues?: Array<{ message?: string }>;
    } | null;
    const issue = body?.issues?.find((i) => i.message)?.message;
    if (issue) return body?.error ? `${body.error}: ${issue}` : issue;
    // `{ error, message }` — the server's own human-readable reason (e.g.
    // POST /api/jobs/recurrence/translate's `translation_failed`), preferred
    // over the bare machine code so the toast says WHY, not just a slug.
    if (body?.message) return body.message;
    if (body?.error) return body.error;
  }
  return (e as Error).message;
}

/** Sentinel folder for the per-host "Custom path…" option. */
const CUSTOM_FOLDER = '__custom__';

/** Sentinel group value for the Group picker's "New group…" option. */
const NEW_GROUP = '__new_group__';

/**
 * The Group picker's options (spec/14 § Jobs view): every distinct group
 * already in use across the user's jobs, alphabetical.
 */
export function buildGroupOptions(jobs: readonly { group?: string }[]): string[] {
  const distinct = new Set(jobs.map((j) => j.group).filter((g): g is string => !!g));
  return [...distinct].sort((a, b) => a.localeCompare(b));
}

/** One machine's folders in the picker. */
interface FolderGroup {
  daemonId: string;
  /** What the user reads: the host's name, disambiguated by its id. */
  label: string;
  folders: string[];
}

/**
 * Encode a (host, folder) choice into one `<option value>`. The pair is the
 * unit the action stores (spec/08 § Action), so the option has to carry both —
 * a bare path cannot say which machine it is on.
 */
export function folderChoiceValue(daemonId: string, folder: string): string {
  return JSON.stringify([daemonId, folder]);
}

export function parseFolderChoice(value: string): { daemonId: string; folder: string } | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [daemonId, folder] = parsed as [unknown, unknown];
    if (typeof daemonId !== 'string' || typeof folder !== 'string') return null;
    if (daemonId === '' || folder === '') return null;
    return { daemonId, folder };
  } catch {
    // The only non-encoded option is the disabled "Select…" placeholder.
    return null;
  }
}

/**
 * The picker's host-grouped options: per machine, that machine's own published
 * folder registry (its configured roots first, then folders it has recently
 * been used in), then folders seen in existing chats ON THAT MACHINE
 * (spec/14 § Jobs view). Nothing is merged across machines — the same
 * path on two hosts is two different directories.
 *
 * Everything except a host's configured ROOTS goes through the recent-folder
 * selection rule (spec/04 § Folders): reserved special threads by chatId where
 * a chat is in hand, then `isJunkFolder` on the path. Without it the editor
 * offered patch's own `threads/{manager,speakers}` working dirs as
 * projects to aim a job at. Roots are user designations and are never filtered,
 * so a root deliberately placed in scratch still shows.
 *
 * A host whose every folder is filtered out KEEPS its (now empty) group — the
 * group's `Custom path…` option is the only way to aim a job at a machine patch
 * has no project history on.
 */
export function buildFolderGroups(input: {
  registry: Array<{ daemonId: string; roots: string[]; recent: string[] }>;
  chats: Array<{ chatId: string; folder: string; daemonId: string }>;
  hostNames: Record<string, string>;
  includeDaemonId?: string;
}): FolderGroup[] {
  const byHost = new Map<string, string[]>();
  const add = (daemonId: string, folder?: string): void => {
    if (!daemonId) return;
    const list = byHost.get(daemonId) ?? [];
    if (folder && !list.includes(folder)) list.push(folder);
    byHost.set(daemonId, list);
  };
  for (const host of input.registry) {
    add(host.daemonId);
    for (const f of host.roots) add(host.daemonId, f);
    for (const f of host.recent) if (!isJunkFolder(f)) add(host.daemonId, f);
  }
  for (const c of input.chats) {
    // The host is registered either way — a machine you only ever ran a
    // special thread on is still a machine you can aim a job at, via its
    // Custom path… option. Only the FOLDER is withheld.
    const offerable = !isReservedSpecialThread(c.chatId) && !isJunkFolder(c.folder);
    add(c.daemonId, offerable ? c.folder : undefined);
  }
  if (input.includeDaemonId) add(input.includeDaemonId);
  return Array.from(byHost.entries()).map(([daemonId, folders]) => {
    const name = input.hostNames[daemonId];
    return {
      daemonId,
      label: name && name !== daemonId ? `${name} (${daemonId})` : daemonId,
      folders,
    };
  });
}

/**
 * The most-recently-used (host, folder) pair across existing chats — the seed
 * a new job starts from (spec/14 § Jobs view). Returned as a PAIR because
 * either half alone is meaningless.
 *
 * Drawn from the same filtered set the picker offers (spec/04 § Folders), so
 * the editor can never preselect a folder it would refuse to list. This is the
 * half that actually mattered: a special thread is usually the most recently
 * updated chat on the account — it is where automation lands — so an unfiltered
 * MRU silently SAVED `threads/manager` onto every new job.
 *
 * NO FALLBACK: with nothing but thread/junk folders to learn from there is no
 * pair, and null leaves the picker on "Select a host and folder…" with save
 * refusing (spec/08 § Action). An empty field the user must fill beats a
 * plausible-looking wrong one.
 */
export function mostRecentPair(
  chats: Array<{ chatId: string; folder: string; daemonId: string; lastUpdated: number }>,
): { folder: string; daemonId: string } | null {
  let best: { folder: string; daemonId: string; at: number } | null = null;
  for (const c of chats) {
    if (!c.folder || !c.daemonId) continue;
    if (isReservedSpecialThread(c.chatId) || isJunkFolder(c.folder)) continue;
    if (!best || c.lastUpdated > best.at) {
      best = { folder: c.folder, daemonId: c.daemonId, at: c.lastUpdated };
    }
  }
  return best ? { folder: best.folder, daemonId: best.daemonId } : null;
}

/**
 * Where the Edit link beside the Skill dropdown should point, or why there is
 * no link to offer (spec/14 § Jobs view).
 *
 * The file browser is rooted at a CHAT's folder — `patch.files.request` is
 * keyed on chatId and the host rejects anything escaping that chat's root.
 * So a skill is reachable only through a chat sitting on the same (host,
 * folder) as the action, and only when the skill's file lives under it. Both
 * conditions genuinely fail sometimes: a job that has never run has no chat,
 * and a machine-wide skill in `~/.claude/skills` is outside every project
 * folder. NO FALLBACK — a path is never guessed and a link that would 404 is
 * never rendered; the caller shows `reason` instead.
 */
export type SkillLinkTarget =
  | { chatId: string; path: string; name: string }
  | { reason: string }
  | null;

export function resolveSkillLink(input: {
  /** The selected skill's name — empty when none is chosen. */
  skill: string;
  /** Absolute host-side file per skill name, as reported by GET /api/skills. */
  paths: Record<string, string> | undefined;
  /** The action's host + folder. */
  daemonId: string;
  folder: string;
  /** Every chat the client knows about. */
  chats: Array<{ chatId: string; folder: string; daemonId: string }>;
}): SkillLinkTarget {
  // No skill chosen — there is nothing to link to and nothing to explain.
  if (input.skill === '') return null;
  // An older host answers without paths at all (the field is optional
  // precisely so it can) — say so rather than construct a path from the name.
  // That is a DIFFERENT case from `paths` being present but missing just this
  // skill's key, which is the normal result for a machine-level skill (e.g.
  // chrome-cdp lives only in `~/.claude/skills` on the host with Chrome) asked
  // about from a folder/host that genuinely doesn't have it — conflating the
  // two made a real "not on this host" read as "this host can't tell me".
  if (input.paths === undefined) return { reason: 'host does not report skill files' };
  const file = input.paths[input.skill];
  if (file === undefined) return { reason: 'skill not found on this host' };
  const chat = input.chats.find((c) => c.daemonId === input.daemonId && c.folder === input.folder);
  if (!chat) return { reason: 'no chat in this folder to open it through' };
  // The separator is part of the test: `/project-other/x` starts with
  // `/project` as a string but is a different directory.
  const root = `${chat.folder}/`;
  if (!file.startsWith(root)) return { reason: 'skill lives outside this folder' };
  const path = file.slice(root.length);
  return { chatId: chat.chatId, path, name: path.slice(path.lastIndexOf('/') + 1) };
}

/**
 * This browser's IANA zone, used as the default for a NEW cron job. Falls back
 * to `UTC` only when the runtime reports no zone at all (a jsdom/ICU-less
 * environment) — that is a missing capability, not a hidden error, and UTC is
 * also what the server does with a trigger carrying no zone.
 */
export function browserTimeZone(): string {
  const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return resolved && resolved.length > 0 ? resolved : 'UTC';
}

/**
 * Every zone this runtime knows, with `UTC` pinned first (it is the meaning of
 * a trigger with no `timezone`, so it must always be selectable). Read once at
 * module load — the list cannot change while the page is open.
 */
export function timeZoneOptions(): string[] {
  const supported =
    typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  const rest = supported.filter((z) => z !== 'UTC');
  // A zone the list somehow lacks (an older ICU, or the browser's own zone
  // reported under an alias) still has to be selectable, or opening an
  // existing job would silently rewrite its zone on save.
  const here = browserTimeZone();
  if (here !== 'UTC' && !rest.includes(here)) rest.push(here);
  return ['UTC', ...rest.sort()];
}

const TIMEZONE_OPTIONS = timeZoneOptions();

/** Weekday codes in display order, per spec/08 § Recurrence's RRULE fields. */
const RECURRENCE_WEEKDAYS: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'MO', label: 'Mon' },
  { code: 'TU', label: 'Tue' },
  { code: 'WE', label: 'Wed' },
  { code: 'TH', label: 'Thu' },
  { code: 'FR', label: 'Fri' },
  { code: 'SA', label: 'Sat' },
  { code: 'SU', label: 'Sun' },
];

const RECURRENCE_NTH_OPTIONS: ReadonlyArray<{ value: FormState['recurrenceNth']; label: string }> =
  [
    { value: '1', label: '1st' },
    { value: '2', label: '2nd' },
    { value: '3', label: '3rd' },
    { value: '4', label: '4th' },
    { value: '-1', label: 'Last' },
  ];

const RECURRENCE_MONTHS: ReadonlyArray<{ n: number; label: string }> = [
  { n: 1, label: 'Jan' },
  { n: 2, label: 'Feb' },
  { n: 3, label: 'Mar' },
  { n: 4, label: 'Apr' },
  { n: 5, label: 'May' },
  { n: 6, label: 'Jun' },
  { n: 7, label: 'Jul' },
  { n: 8, label: 'Aug' },
  { n: 9, label: 'Sep' },
  { n: 10, label: 'Oct' },
  { n: 11, label: 'Nov' },
  { n: 12, label: 'Dec' },
];

/** `"09:05"` -> `{ hour: 9, minute: 5 }`. Malformed input reads as midnight. */
function parseHHMM(hhmm: string): { hour: number; minute: number } {
  const [h, m] = hhmm.split(':').map((n) => Number(n));
  return {
    hour: Number.isFinite(h) && h !== undefined ? h : 0,
    minute: Number.isFinite(m) && m !== undefined ? m : 0,
  };
}

/**
 * Build the bare RRULE value string the structured builder's fields
 * describe. Always produces exactly the shape `parseRecurrenceFields`
 * (`@patch/wire`) accepts and `describeRecurrence` confidently phrases —
 * WEEKLY carries no BYSETPOS/BYMONTH (a weekly rule restricted to some
 * months has no clean short phrase, spec/08 § Recurrence); MONTHLY/YEARLY
 * carry exactly one weekday plus BYSETPOS. An empty weekday selection
 * produces a deliberately unparseable `BYDAY=` — the caller's own save-time
 * validation refuses that rather than the RRULE silently mis-describing.
 */
function buildRecurrenceRule(form: FormState): string {
  const { hour, minute } = parseHHMM(form.recurrenceTimeHHMM);
  const parts = [`FREQ=${form.recurrenceFrequency}`];
  if (form.recurrenceFrequency === 'WEEKLY') {
    parts.push(`BYDAY=${form.recurrenceWeekdays.join(',')}`);
  } else {
    parts.push(`BYDAY=${form.recurrenceWeekdays[0] ?? ''}`);
    parts.push(`BYSETPOS=${form.recurrenceNth}`);
    if (form.recurrenceMonths.length > 0) {
      parts.push(`BYMONTH=${[...form.recurrenceMonths].sort((a, b) => a - b).join(',')}`);
    }
  }
  parts.push(`BYHOUR=${hour}`);
  parts.push(`BYMINUTE=${minute}`);
  return parts.join(';');
}

/**
 * Apply a structured-control change and recompute `recurrenceRule` from it —
 * the one function every structured builder control's `onChange` goes
 * through, so `recurrenceRule` (the field that's actually submitted) can
 * never drift from what the controls show.
 */
function withRecurrenceRule(form: FormState, patch: Partial<FormState>): FormState {
  const merged = { ...form, ...patch };
  return { ...merged, recurrenceRule: buildRecurrenceRule(merged) };
}

/**
 * Frequency change resets what the OTHER structured fields can validly hold:
 * MONTHLY/YEARLY need exactly one weekday (WEEKLY's multi-select collapses
 * to its first choice), and WEEKLY can carry no month restriction at all
 * (`parseRecurrenceFields` refuses one — spec/08 § Recurrence).
 */
function setRecurrenceFrequency(
  form: FormState,
  freq: FormState['recurrenceFrequency'],
): FormState {
  const days = freq === 'WEEKLY' ? form.recurrenceWeekdays : form.recurrenceWeekdays.slice(0, 1);
  return withRecurrenceRule(form, {
    recurrenceFrequency: freq,
    recurrenceWeekdays: days.length > 0 ? days : ['SU'],
    recurrenceMonths: freq === 'WEEKLY' ? [] : form.recurrenceMonths,
  });
}

/** WEEKLY toggles membership; MONTHLY/YEARLY replace the single selection (nth-weekday needs exactly one day). */
function toggleRecurrenceWeekday(form: FormState, code: string): FormState {
  if (form.recurrenceFrequency !== 'WEEKLY') {
    return withRecurrenceRule(form, { recurrenceWeekdays: [code] });
  }
  const has = form.recurrenceWeekdays.includes(code);
  const next = has
    ? form.recurrenceWeekdays.filter((d) => d !== code)
    : [...form.recurrenceWeekdays, code];
  return withRecurrenceRule(form, { recurrenceWeekdays: next });
}

function toggleRecurrenceMonth(form: FormState, month: number): FormState {
  const has = form.recurrenceMonths.includes(month);
  const next = has
    ? form.recurrenceMonths.filter((m) => m !== month)
    : [...form.recurrenceMonths, month].sort((a, b) => a - b);
  return withRecurrenceRule(form, { recurrenceMonths: next });
}

interface FormState {
  name: string;
  /**
   * Free-text organisational label (spec/08 § Groups). Always sent, same as
   * `name` — an empty string clears a job's group, it is never omitted.
   */
  group: string;
  /**
   * The editor's own toggle state for the autonomy prompt (spec/08 §
   * Autonomy prompt) — unticked is "account prompt", ticked is "override". Not a
   * stored field itself, the same relationship `gateOn` has to `gate`: an
   * unticked box persists as an ABSENT `autonomyPrompt` (actually written as
   * `null` — § Autonomy prompt's clear-to-default — since omitting the key
   * would leave a previously-customised job's override untouched), and the
   * text is KEPT in `autonomyPromptText` while unticked so toggling back on
   * does not lose what was typed.
   */
  autonomyPromptCustom: boolean;
  /**
   * The box's own text — empty to start, or the
   * job's stored override once loaded. Submitted only while
   * `autonomyPromptCustom` is ticked; otherwise the job is saved with no
   * override (reads back as the account-wide prompt).
   */
  autonomyPromptText: string;
  enabled: boolean;
  triggerType: JobTrigger['type'];
  /** Natural-language schedule text the user typed (cron triggers only). */
  scheduleText: string;
  cronExpression: string;
  /**
   * IANA zone the cron expression is evaluated in (spec/14 § Jobs view). A NEW
   * job defaults to this browser's zone — typing "9am" and getting 9am local is
   * the whole point. An EXISTING job whose trigger carries no `timezone` reads
   * back as `'UTC'`, which is exactly how the server evaluates it, so opening
   * an old job and re-saving it cannot move when it fires.
   */
  cronTimezone: string;
  /**
   * Bare RRULE value string (spec/08 § Recurrence — no `RRULE:` label, no
   * `DTSTART`). This is the ONE field that is actually submitted — the same
   * relationship cron's `cronExpression` has to `scheduleText`: the
   * structured builder controls below (frequency/weekdays/nth/months/time)
   * WRITE into this whenever changed, and the raw-RRULE textarea (behind the
   * "edit RRULE directly" toggle) edits it directly. Editing the raw field
   * does not reverse-populate the structured controls — same asymmetry
   * cron's raw-cron field already has with `scheduleText`.
   */
  recurrenceRule: string;
  recurrenceFrequency: 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  /** Weekday codes (SU..SA). Multiple for WEEKLY; exactly one for MONTHLY/YEARLY. */
  recurrenceWeekdays: string[];
  /** `BYSETPOS` for the MONTHLY/YEARLY nth-weekday pattern. */
  recurrenceNth: '1' | '2' | '3' | '4' | '-1';
  /** `BYMONTH` (1-12). Optional restriction for MONTHLY; required for YEARLY. */
  recurrenceMonths: number[];
  /** `BYHOUR`/`BYMINUTE`, as a single `HH:MM` control value. */
  recurrenceTimeHHMM: string;
  /** IANA zone the RRULE is evaluated in — REQUIRED, unlike cron's optional one. */
  recurrenceTimezone: string;
  /** The free-text schedule phrase for the natural-language translate path. */
  recurrenceNlText: string;
  webhookScheme: WebhookScheme;
  webhookSecret: string;
  filter: string;
  /**
   * The Starts/Stops widget's own state (spec/08 § Filter) — a `datetime-local`
   * value (browser-local wall clock, empty means unset), kept separate from
   * `filter` itself: `filter` holds only the custom-JSONata REMAINDER once the
   * date range is parsed out of it, so the raw textarea never shows the
   * `now >= "..."` clause the widget is already presenting as real dates.
   */
  dateStart: string;
  dateStop: string;
  actionType: JobAction['type'];
  /**
   * The host the spawned/ensured chat runs on. A job action is dispatched to
   * the host it names (spec/08 § Action), and a folder without a host is
   * ambiguous once there is more than one machine.
   */
  spawnDaemonId: string;
  spawnFolder: string;
  spawnPrompt: string;
  spawnSkill: string;
  /**
   * The model each fire's chat runs on, from `spawnDaemonId`'s catalogue.
   * Empty string is the `Account default` row (spec/14 § Jobs view): a
   * deliberate choice to store NO model, so every fire takes the account's
   * `defaultModel` rather than a pinned id that will be retired.
   */
  spawnModel: string;
  /** The shared account the job's chat starts on; '' leaves it to the strategy. */
  spawnAccount: string;
  /**
   * `spawn` and `ensure` — create this job's chat into Hidden rather than the
   * active list (spec/04 § Hidden, spec/08 ## Action). Both actions create the chat
   * they place; `message` does not, and has no such flag.
   */
  spawnHidden: boolean;
  /**
   * `spawn` and `ensure` — ring the completion doorbell when a chat this job
   * created settles (spec/08 ## Action). The one boolean on this form that
   * starts ON: ticked is the absent-field state, so it is `false` that gets
   * written and an untouched job stays byte-identical.
   */
  spawnNotifyOnComplete: boolean;
  /**
   * Append the trigger's event JSON after the prompt (spec/08 ## Action). All
   * three chat-delivering actions carry it, and it starts ON like
   * `spawnNotifyOnComplete`: only unticking writes `includePayload: false`.
   */
  includePayload: boolean;
  /** `continue` only — the per-fire dedup key (Mustache template). */
  ensureKey: string;
  /**
   * `spawn` only — the permission mode each fire's chat runs under. Always a
   * real mode: a job has no "host default" row, because a job that followed
   * the host would change behaviour when someone at that machine changed
   * theirs (spec/08 § Action).
   */
  spawnPermissionMode: PermissionMode;
  messageChatId: string;
  messagePrompt: string;
  messageSkill: string;
  /**
   * The job's GATE (spec/08 § Gate) — a command asked before each fire, which
   * decides whether the action runs at all. `gateOn` is the editor's own state
   * rather than a stored field: an unticked gate persists as an ABSENT `gate`,
   * and the command is KEPT in the form while unticked so unticking to compare
   * behaviour does not throw the script away.
   */
  gateOn: boolean;
  gateDaemonId: string;
  gateFolder: string;
  gateCommand: string;
  /** Empty string means the 60s default. */
  gateTimeoutMs: string;
  /** The run window (spec/08 § Run window). `windowOn` is editor state: unticked saves `window: null`. */
  windowOn: boolean;
  windowStart: string;
  windowEnd: string;
  windowTimezone: string;
  /**
   * `script` only — the command each fire runs on `spawnDaemonId`, in
   * `spawnFolder` (spec/08 § Action). A script job has no chat, so it has no
   * skill, prompt, model or permission mode to set.
   */
  scriptCommand: string;
  /** `script` only — kill after this long. Empty string means the 60s default. */
  scriptTimeoutMs: string;
}

const DEFAULT_FORM: FormState = {
  name: '',
  group: '',
  autonomyPromptCustom: false,
  autonomyPromptText: '',
  enabled: true,
  triggerType: 'cron',
  scheduleText: '',
  cronExpression: '0 9 * * *',
  cronTimezone: browserTimeZone(),
  recurrenceRule: 'FREQ=WEEKLY;BYDAY=SU;BYHOUR=9;BYMINUTE=0',
  recurrenceFrequency: 'WEEKLY',
  recurrenceWeekdays: ['SU'],
  recurrenceNth: '1',
  recurrenceMonths: [],
  recurrenceTimeHHMM: '09:00',
  recurrenceTimezone: browserTimeZone(),
  recurrenceNlText: '',
  webhookScheme: 'none',
  webhookSecret: '',
  filter: '',
  dateStart: '',
  dateStop: '',
  actionType: 'spawn',
  spawnDaemonId: '',
  // Seeded together with the host, from the most-recently-used (host, folder)
  // pair (see the effect below). Empty until then so the picker shows a
  // "Select a host and folder…" prompt rather than a path with no machine.
  spawnFolder: '',
  spawnPrompt: '',
  spawnSkill: '',
  // A new job starts on the account default (spec/14 § Jobs view) — it tracks
  // one setting instead of freezing a model id at the moment the job was
  // written.
  spawnModel: '',
  spawnAccount: '',
  spawnHidden: false,
  // Default ON (spec/08 ## Action) — a job notifies unless its action says not to.
  spawnNotifyOnComplete: true,
  includePayload: true,
  ensureKey: '',
  spawnPermissionMode: 'auto',
  messageChatId: '',
  messagePrompt: '',
  messageSkill: '',
  gateOn: false,
  gateDaemonId: '',
  gateFolder: '',
  gateCommand: '',
  gateTimeoutMs: '',
  windowOn: false,
  windowStart: '07:00',
  windowEnd: '22:00',
  windowTimezone: 'Europe/London',
  scriptCommand: '',
  scriptTimeoutMs: '',
};

export function JobEditorRoute({ jobId }: { jobId?: string } = {}): JSX.Element {
  // `jobId` (from the pane tab's own descriptor, via `JobPaneRoute`) wins
  // over the URL param: this component stays mounted as a tab's content
  // after the user navigates elsewhere (another pane, a chat), at which
  // point the address bar no longer matches `/jobs/:id` at all and
  // `useParams` alone would lose track of which job this tab is.
  const { id: paramId } = useParams<{ id?: string }>();
  const id = jobId ?? paramId;
  const isNew = !id || id === 'new';
  // Back — and saving or deleting, the other ways off the page — returns to
  // wherever the editor was opened from: the jobs list, a chat's "Open job"
  // link. The list only when there is nothing earlier to go back to (spec/14
  // § Layout (desktop), § Jobs view).
  const goBack = useGoBack('/jobs');
  const pushError = useUiStore((s) => s.pushError);
  const openFileInBrowser = useUiStore((s) => s.openFileInBrowser);
  const qc = useQueryClient();
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [autonomyOpen, setAutonomyOpen] = useState(false);
  const accountAutonomyPrompt = usePreferencesStore((s) => s.preferences.jobAutonomyPrompt);
  // What the form looked like when it was last LOADED from the server or last
  // SAVED — the thing `form` is dirty against (spec/14 § Jobs view — Unsaved
  // changes). Held separately from `form` so the non-interactive writes that
  // set up the page (the server load, the most-recently-used host/folder seed)
  // can move both together and leave an untouched page clean.
  const [baseline, setBaseline] = useState<FormState>(DEFAULT_FORM);
  // Raw-cron input is hidden by default — the natural-language Schedule field is
  // primary. Toggled on for advanced edits / unparseable phrases.
  const [showRawCron, setShowRawCron] = useState(false);
  // Raw-RRULE input is hidden by default — the structured builder is primary.
  // Toggled on for advanced edits, and auto-revealed when an existing job's
  // rule falls outside the structured shape (see jobToForm's parse attempt).
  const [showRawRecurrence, setShowRawRecurrence] = useState(false);
  // Natural-language recurrence translate (spec/08 § Recurrence — the third,
  // additive way to set the schedule). Local UI state, not form data: it
  // drives ONE explicit action (the Translate button / Enter), never a
  // keystroke-triggered API call.
  const [recurrenceNlTranslating, setRecurrenceNlTranslating] = useState(false);
  const [recurrenceNlError, setRecurrenceNlError] = useState<string | null>(null);
  const [recurrenceNlConfirmed, setRecurrenceNlConfirmed] = useState<string | null>(null);
  // Recipient chat picker + folder picker source: the live sidebar chats.
  const chats = useChatStore((s) => s.chats);
  const chatList = Object.values(chats);
  const setActiveChat = useChatStore((s) => s.setActiveChat);
  const hosts = usePresenceStore((s) => s.hosts);
  const sharedAccounts = usePreferencesStore((s) => s.shared?.secrets);
  // Folder picker source: EVERY host's own published registry, grouped by host
  // (spec/14 § Jobs view — "the same host-grouped picker the new-chat flow
  // uses: under each host name, that host's configured project folders first,
  // then folders seen in existing chats on it"). A flat union of bare paths is
  // what let the editor save a host-a folder against host-b: the pair is the
  // unit, so the option the user picks carries its host and the save stores
  // that host (spec/08 § Action — "a folder path means nothing without the
  // machine it is on").
  const { data: folderData } = useQuery({ queryKey: ['folders'], queryFn: () => api.folders() });
  const folderGroups = buildFolderGroups({
    registry: folderData?.hosts ?? [],
    chats: chatList.map((c) => ({
      chatId: c.chatId,
      folder: c.folder,
      daemonId: c.daemonId,
    })),
    hostNames: Object.fromEntries(
      Object.entries(hosts).map(([id, h]) => [id, h.host?.hostName ?? id]),
    ),
    // Always keep the job's own host as a group, even if it is offline and
    // publishes nothing right now — an edited job must still show its machine.
    includeDaemonId: form.spawnDaemonId,
  });
  // Folders offered for the CHOSEN host — the ad-hoc test is per host, since
  // the same path can be a listed folder on one machine and ad-hoc on another.
  const foldersOnChosenHost =
    folderGroups.find((g) => g.daemonId === form.spawnDaemonId)?.folders ?? [];
  // When the spawn folder isn't one of the chosen host's options it's an ad-hoc
  // path: the picker drops into a free-text "Custom path…" mode (the latch also
  // lets the user choose Custom explicitly before typing anything).
  const [folderCustom, setFolderCustom] = useState(false);
  const folderIsAdHoc =
    folderCustom || (form.spawnFolder !== '' && !foldersOnChosenHost.includes(form.spawnFolder));

  // Group picker source: the same live jobs list the Jobs view itself reads
  // (spec/14 § Jobs view — "every distinct group already in use"), so a group
  // typed on one job shows up as a pickable option on the next.
  const { data: jobsData } = useQuery({
    queryKey: ['jobs'],
    queryFn: () => api.listJobs() as Promise<{ jobs: Job[] }>,
  });
  const existingGroups = buildGroupOptions(jobsData?.jobs ?? []);
  // When the stored group isn't one of the known options it's ad-hoc: the
  // picker drops into "New group…" free-text mode, same rule as the folder
  // picker above.
  const [groupCustom, setGroupCustom] = useState(false);
  const groupIsAdHoc = groupCustom || (form.group !== '' && !existingGroups.includes(form.group));

  // Skill picker source: the skills in the action's target folder's
  // `.claude/skills` (spawn/ensure use the chosen folder; message uses the
  // recipient chat's folder). Fetched on demand and cached per folder.
  const messageChat = chatList.find((c) => c.chatId === form.messageChatId);
  const messageChatFolder = messageChat?.folder ?? '';
  const skillFolder = form.actionType === 'message' ? messageChatFolder : form.spawnFolder;
  // The host that folder is on — a path alone can't say which machine, and the
  // Edit link has to open the file through a chat on the SAME machine.
  const skillDaemonId =
    form.actionType === 'message' ? (messageChat?.daemonId ?? '') : form.spawnDaemonId;
  const { data: skillsData } = useQuery({
    queryKey: ['skills', skillFolder, skillDaemonId],
    queryFn: () => api.skills(skillFolder, skillDaemonId),
    enabled: skillFolder.trim().length > 0 && skillDaemonId.trim().length > 0,
  });
  const availableSkills = skillsData?.skills ?? [];

  // Model picker source (spec/14 § Jobs view). The catalogue is per MACHINE and
  // live, so it loads once a host is chosen and RELOADS when the folder picker
  // moves the job to a different one — offering host-a's models for a job that
  // will fire on host-b is how an unrunnable model id gets stored. Only
  // spawn/ensure name a host; a `message` action has none, so nothing loads.
  const modelCatalog = useModelCatalog();
  const usesSpawnFields = form.actionType === 'spawn' || form.actionType === 'continue';
  const modelDaemonId = usesSpawnFields && form.spawnDaemonId !== '' ? form.spawnDaemonId : null;
  useEffect(() => {
    if (modelDaemonId === null) return;
    void loadModels(modelDaemonId);
  }, [modelDaemonId]);

  // Seed from the list-route cache so navigation from /jobs never shows
  // a "Loading…" spinner — the job was just visible in the list so its data
  // is already in the cache. React Query still background-refetches to pick
  // up any changes, but `isLoading` is false immediately when `initialData`
  // is present, so the form renders at once instead of showing "Loading…"
  // for the full round-trip of GET /api/jobs/:id.
  const listCache = qc.getQueryData<{ jobs: Job[] }>(['jobs']);
  const cachedJob = listCache?.jobs?.find((j) => j.id === id);

  const { data, isLoading } = useQuery({
    queryKey: ['job', id],
    /* v8 ignore next -- defensive only: `enabled: !isNew` gates this queryFn, and `isNew = !id || id === 'new'`, so whenever this can actually run, `id` is already a defined, non-'new' string — the `?? ''` fallback can never fire. */
    queryFn: () => api.getJob(id ?? ''),
    enabled: !isNew,
    // Seed from the list cache: when present, RQ v5 sets isLoading=false
    // immediately and background-refetches, so the form never shows "Loading…"
    // when the user clicked through from the jobs list.
    initialData: cachedJob as Job | undefined,
  });

  // Bumped whenever the whole form is REPLACED by a job from the server, which
  // is the only moment a code editor on this page should reload what it is
  // showing (see `ScriptCommandEditor.reloadKey`).
  const [loadedRevision, setLoadedRevision] = useState(0);
  useEffect(() => {
    if (data && !isNew) {
      const loaded = jobToForm(data as Job);
      setForm(loaded);
      // A job that carries an override shows it, rather than hiding it under
      // a collapsed "Advanced".
      if (loaded.autonomyPromptCustom) setAutonomyOpen(true);
      // The server's copy is the new clean state: a background refetch that
      // re-seeds the form must not leave it looking edited.
      setBaseline(loaded);
      setLoadedRevision((r) => r + 1);
      // Auto-reveal the raw RRULE editor for a job whose rule falls outside
      // the structured builder's narrow shape — same "auto-reveal on what the
      // structured path can't show" rule the cron field's showRawCron follows
      // for an unparseable schedule phrase.
      if (
        loaded.triggerType === 'recurrence' &&
        parseRecurrenceFields(loaded.recurrenceRule) === null
      ) {
        setShowRawRecurrence(true);
      }
    }
  }, [data, isNew]);

  // Seed a new job to the most-recently-used (host, folder) PAIR — the same
  // seed the new-chat picker uses (spec/14 § Jobs view / §8). The pair is
  // seeded together or not at all: seeding a folder from one machine next to a
  // host defaulted from another is precisely how a job ends up dispatched to
  // the wrong machine. With no chat to learn a pair from, both stay empty and
  // save refuses (spec/08 § Action), which is better than a silent wrong host.
  const mruPair = mostRecentPair(chatList);
  useEffect(() => {
    if (!isNew || form.spawnFolder !== '' || form.spawnDaemonId !== '' || folderCustom) return;
    if (!mruPair) return;
    const seed = (f: FormState): FormState =>
      f.spawnFolder === '' && f.spawnDaemonId === ''
        ? { ...f, spawnFolder: mruPair.folder, spawnDaemonId: mruPair.daemonId }
        : f;
    setForm(seed);
    // The seed is the app's own doing, not the user's, so it moves the baseline
    // with it — otherwise a new-job page nobody has touched is already dirty
    // and prompts on the way out.
    setBaseline(seed);
  }, [
    isNew,
    mruPair?.folder,
    mruPair?.daemonId,
    form.spawnFolder,
    form.spawnDaemonId,
    folderCustom,
  ]);

  // Unsaved-edit tracking (spec/14 § Jobs view — Unsaved changes). The guard
  // below runs from a history call rather than from a render, so it reads a
  // REF: a `setBaseline` has not landed yet when a mutation's `onSuccess`
  // navigates in the same tick, and the user would then be asked to confirm
  // discarding the edits they had just saved.
  const dirty = isDirty(form, baseline);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const createMut = useMutation({
    mutationFn: (body: JobCreateBody) => api.createJob(body),
    onSuccess: () => {
      // Saved: this form IS what the server holds now, so nothing is unsaved.
      // Cleared through the ref as well as the state because the navigate on
      // the next line runs before React has re-rendered with the new baseline.
      dirtyRef.current = false;
      setBaseline(form);
      qc.invalidateQueries({ queryKey: ['jobs'] });
      goBack();
    },
    onError: (e) => pushError(failed('create'), undefined, describeApiError(e)),
  });

  const patchMut = useMutation({
    /* v8 ignore next -- defensive only: patchMut is only ever `.mutate()`d from the `!isNew` branch of `handleSubmit`, and `isNew = !id || id === 'new'`, so `id` is always defined here — the `?? ''` fallback can never fire. */
    mutationFn: (body: unknown) => api.patchJob(id ?? '', body),
    onSuccess: () => {
      // Saved — see createMut above.
      dirtyRef.current = false;
      setBaseline(form);
      qc.invalidateQueries({ queryKey: ['jobs'] });
      qc.invalidateQueries({ queryKey: ['job', id] });
      goBack();
    },
    onError: (e) => pushError(failed('patch'), undefined, describeApiError(e)),
  });

  const deleteMut = useMutation({
    /* v8 ignore next -- defensive only: the Delete button (which is the only caller of `deleteMut.mutate`) is rendered solely inside `{!isNew ? (...) : null}`, and `isNew = !id || id === 'new'`, so `id` is always defined whenever this can run — the `?? ''` fallback can never fire. */
    mutationFn: () => api.deleteJob(id ?? ''),
    onSuccess: () => {
      // The job is gone, so there is nothing left to save and nothing to warn
      // about — the user already confirmed the destructive thing.
      dirtyRef.current = false;
      qc.invalidateQueries({ queryKey: ['jobs'] });
      goBack();
    },
    onError: (e) => pushError(failed('delete'), undefined, (e as Error).message),
  });

  // Run now (spec/08 ## Manual run): fires the action once, immediately, for
  // trying it out without waiting for the real trigger or enabling the job
  // first. No success toast — the Recent runs panel refetching on its own
  // interval is the confirmation, same as any other fire (14-design-web.md §
  // Jobs view).
  const runMut = useMutation({
    /* v8 ignore next -- defensive only: the Run now button (the only caller of `runMut.mutate`) is rendered solely inside `{!isNew ? (...) : null}`, and `isNew = !id || id === 'new'`, so `id` is always defined whenever this can run — the `?? ''` fallback can never fire. */
    // Unsaved edits on screen run as the draft; a clean form runs the saved job.
    mutationFn: (draft?: unknown) => api.runJob(id ?? '', draft),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['job-runs', id] });
    },
    onError: (e) => pushError(failed('run now'), undefined, describeApiError(e)),
  });

  /** A create/patch is in flight — the Save button is dead for its duration. */
  const saving = createMut.isPending || patchMut.isPending;
  const savingRef = useRef(saving);
  savingRef.current = saving;

  // Every in-app way off this page goes through the router's navigator, so one
  // guard there covers the Back button, the sidebar, the app's Back/Forward
  // controls and the desktop shell's navigate IPC alike.
  useNavigationGuard({
    shouldBlock: () => shouldPromptOnLeave({ dirty: dirtyRef.current, saving: savingRef.current }),
    confirm: () => useUiStore.getState().confirm({ ...UNSAVED_CONFIRM, danger: true }),
  });

  /**
   * The natural-language recurrence path (spec/08 § Recurrence — additive to
   * the structured builder and the raw RRULE field, never a replacement).
   * Fires ONLY on explicit user action (the Translate button / Enter in the
   * field) — never per keystroke, to keep this personal tool's API spend to
   * what the user actually asked for.
   *
   * The server has already re-validated the rrule (`RRule.fromString`) and
   * re-described it (`describeRecurrence`) before this ever resolves — a
   * translation that failed either check comes back as a thrown `ApiError`,
   * never a 200 with something unconfirmed. On success this writes the
   * result straight into `recurrenceRule` (the one field that's actually
   * submitted) and reveals the raw editor, since a model-produced rule may
   * fall outside the structured builder's own narrower shape.
   */
  async function handleTranslateRecurrence(): Promise<void> {
    const phrase = form.recurrenceNlText.trim();
    if (!phrase) return;
    const daemonId = form.spawnDaemonId || defaultDaemonId(hosts);
    if (!daemonId) {
      setRecurrenceNlError('No host is available to run the translation on yet.');
      return;
    }
    setRecurrenceNlTranslating(true);
    setRecurrenceNlError(null);
    setRecurrenceNlConfirmed(null);
    try {
      const result = await api.translateRecurrenceRule(daemonId, phrase);
      setForm({ ...form, recurrenceRule: result.rrule });
      setRecurrenceNlConfirmed(result.description);
      setShowRawRecurrence(true);
    } catch (err) {
      setRecurrenceNlError(describeApiError(err));
    } finally {
      setRecurrenceNlTranslating(false);
    }
  }

  // The natural-language phrase the user typed didn't parse → reveal the raw
  // cron input so they can still set it directly. Computed here (rather than
  // just above the JSX return) so `handleSubmit` below can gate on it: a
  // schedule phrase that never parsed left `cronExpression` at its old/default
  // value, and until this existed Save shipped that stale cron with no error —
  // the server has no way to tell "unparsed" from "deliberately set" cron.
  const scheduleUnparsed =
    form.scheduleText.trim() !== '' && parseNaturalSchedule(form.scheduleText) === null;
  // Only a cron trigger ever sends `cronExpression` (see `formToBody`'s
  // `case 'cron'` below) — switching the trigger type away from cron doesn't
  // clear `scheduleText`, so a stale unparsed phrase must not block saving a
  // webhook/todoist job that never reads it.
  const scheduleBlocksSave = form.triggerType === 'cron' && scheduleUnparsed;
  // A recurrence trigger with no RRULE text has nothing to save — the
  // structured builder always writes SOMETHING into `recurrenceRule` (even
  // an unparseable `BYDAY=` when no weekday is picked), so an empty field
  // only happens via the raw-RRULE textarea being cleared by hand.
  const recurrenceBlocksSave =
    form.triggerType === 'recurrence' && form.recurrenceRule.trim() === '';

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault();
    // `⌘↵` reaches this function without going through the button, so it
    // re-checks what the button's `disabled` encodes. Otherwise the chord can
    // force a second submit the control itself is refusing.
    if (saving) return;
    // A schedule phrase that didn't parse means `cronExpression` is stale (the
    // old/default value, not what was typed) — the raw cron field is already
    // revealed for the user to fix it directly (see `scheduleUnparsed` above).
    // Refuse the save rather than silently shipping that stale cron, which the
    // server would accept without complaint since it's valid cron.
    if (scheduleBlocksSave) {
      pushError('Couldn’t read that schedule. Set the cron directly, or fix the phrase.');
      return;
    }
    if (recurrenceBlocksSave) {
      pushError('Set a schedule. The RRULE is empty.');
      return;
    }
    // Name is server-required (min 1 char). On the wizard the Name field lives
    // on step 1 (trigger), so when Create is clicked from the Action step the
    // input is not in the DOM and native `required` can't fire — the POST would
    // 400 with a generic "invalid body" the user never sees. Validate it here,
    // surface a clear message, and jump the user back to the step that holds
    // the field so they can fix it.
    if (!form.name.trim()) {
      pushError('Name is required. Give this job a name.');
      return;
    }
    // An action needs AT LEAST ONE of skill|prompt (server-enforced in
    // @patch/wire JobAction). BOTH is allowed — the skill runs with the prompt
    // as its input (server `renderPrompt`). Validate client-side so the empty
    // case names the field instead of a generic "invalid body" 400.
    //
    // `script` is exempt — it has no chat, so no skill/prompt (@patch/wire
    // JobAction's refinement returns early for it too). Command is its
    // required payload, enforced by the field's own `required` attribute.
    // Checking skill/prompt against it anyway (both always empty, since
    // neither field is ever rendered for `script`) refused every script
    // save with "Add a Skill or a Prompt" regardless of Command (reported
    // 11 Sep 2026, screenshot on a Foreman gate job with Command filled in).
    if (form.actionType !== 'script') {
      const skill = (usesSpawnFields ? form.spawnSkill : form.messageSkill).trim();
      const prompt = (usesSpawnFields ? form.spawnPrompt : form.messagePrompt).trim();
      if (!skill && !prompt) {
        pushError('Add a Skill or a Prompt (or both). The action needs something to run.');
        return;
      }
    }
    // spawn + ensure need a folder (the picker no longer carries a native
    // `required`, since it's a select with a Custom-path escape hatch).
    if (usesSpawnFields && !form.spawnFolder.trim()) {
      pushError('Choose a folder for the chat.');
      return;
    }
    // A job fires while nobody is watching, so a host it cannot name is a job
    // that would dispatch nowhere. Refuse at save time, where there is someone
    // to tell (spec/08 § Action).
    if (usesSpawnFields && !form.spawnDaemonId.trim()) {
      pushError('Choose which host the chat runs on.');
      return;
    }
    // A gate with no host or folder would dispatch nowhere, and the server's own
    // `JobGate` refuses it — say so here, where there is someone to tell, rather
    // than as a 400 about a field name (spec/08 § Gate).
    if (form.gateOn && form.gateCommand.trim().length > 0) {
      if (!form.gateDaemonId.trim()) {
        pushError('Choose which host the gate command runs on.');
        return;
      }
      if (!form.gateFolder.trim()) {
        pushError('Choose a folder for the gate command to run in.');
        return;
      }
    }
    const body = formToBody(form);
    if (isNew) createMut.mutate(body);
    else patchMut.mutate(body);
  }

  // Skill is a dropdown of the folder's available skills (`.claude/skills`).
  // The current value is always kept as an option (edit mode, or the list
  // hasn't loaded) so a saved skill is never silently dropped.
  function skillField(value: string, onChange: (v: string) => void, testid: string): JSX.Element {
    const opts =
      value && !availableSkills.includes(value) ? [value, ...availableSkills] : availableSkills;
    const placeholder =
      skillFolder.trim() === ''
        ? form.actionType === 'message'
          ? '— pick a recipient chat first —'
          : '— pick a folder first —'
        : availableSkills.length === 0
          ? '— no skills in this folder —'
          : '— none —';
    return (
      <label>
        Skill
        <select value={value} onChange={(e) => onChange(e.target.value)} data-testid={testid}>
          <option value="">{placeholder}</option>
          {opts.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        {skillLink(value, `${testid}-edit`)}
      </label>
    );
  }

  // Model is a dropdown of the CHOSEN HOST's live catalogue (spec/14 § Jobs
  // view). Unlike the new-chat picker it leads with `Account default`, because a
  // job is stored configuration that fires for months: storing no model — so
  // each fire takes the account's `defaultModel`, changeable in one place for
  // every job at once — is a real, persistent choice the user has to be able to
  // make and come back to.
  //
  // It used to read `Host default`, and meant the host's `lastUsedModel`: the
  // model the last chat on that machine happened to run on. That made every
  // job's model a side effect of the last human choice at that keyboard, and it
  // drifted — silently putting deploys and purchases on whatever cheap model
  // someone had picked for one throwaway chat.
  //
  // The current value is always kept as an option, as with Skill: the catalogue
  // may be empty, still loading, or the host offline, and an edit to an
  // unrelated field must never silently unpin a saved model.
  /**
   * The account the job's chat starts on (spec/08 § Action, spec/10 § Backend
   * credentials — preferred account). A preference, not a pin: a spent account
   * is walked past. Fixed when the chat is created, like the model.
   */
  function accountField(): JSX.Element | null {
    const codex = form.spawnModel.startsWith('openai/');
    const accounts = (codex ? sharedAccounts?.codex : sharedAccounts?.claude) ?? [];
    const value = form.spawnAccount;
    const extra =
      value && !accounts.some((a) => a.id === value)
        ? [{ id: value, label: `${value} (not held)` }]
        : [];
    if (accounts.length < 2 && extra.length === 0) return null;
    return (
      <label>
        Start on account
        <select
          value={value}
          onChange={(e) => setForm({ ...form, spawnAccount: e.target.value })}
          data-testid="job-spawn-account"
        >
          <option value="">By strategy</option>
          {[...extra, ...accounts].map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
      </label>
    );
  }

  function modelField(): JSX.Element {
    const ids = modelCatalog.models.map((m) => m.id);
    const value = form.spawnModel;
    const extra = value && !ids.includes(value) ? [{ id: value, label: value }] : [];
    const opts = [...extra, ...modelCatalog.models];
    // Which model "Account default" actually is, so choosing it isn't a
    // leap of faith — unknown until a host is chosen, since the default is
    // mirrored per host (spec/04 § Spawn).
    const defaultModelId = modelDaemonId === null ? null : hostDefaultModel(hosts, modelDaemonId);
    const defaultModelLabel =
      defaultModelId === null
        ? null
        : (modelCatalog.models.find((m) => m.id === defaultModelId)?.label ?? defaultModelId);
    const defaultOptionLabel =
      defaultModelLabel === null ? 'Account default' : `Account default (${defaultModelLabel})`;
    return (
      <label>
        Model
        <select
          value={value}
          onChange={(e) => {
            const model = e.target.value;
            // A mode the new model cannot run is reset to `default` in view,
            // not left to be degraded silently when the job fires.
            const keep =
              model === '' || permissionModesFor(model).includes(form.spawnPermissionMode);
            setForm({
              ...form,
              spawnModel: model,
              spawnPermissionMode: keep ? form.spawnPermissionMode : 'default',
            });
          }}
          data-testid="job-spawn-model"
        >
          <option value="">{defaultOptionLabel}</option>
          {opts.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        {modelDaemonId === null ? (
          <p className="field-hint">Pick a folder first. Models are per host.</p>
        ) : modelCatalog.status === 'error' ? (
          <p className="field-hint" data-testid="job-spawn-model-error">
            Couldn’t load this host’s models: {modelCatalog.error ?? 'unknown error'}
          </p>
        ) : null}
      </label>
    );
  }

  // The Edit link beside a chosen skill — what the job DOES, one click from the
  // job that does it (spec/14 § Jobs view). The rail renders whichever chat is
  // active, so opening the file means making the host chat active first.
  function skillLink(value: string, testid: string): JSX.Element | null {
    const target = resolveSkillLink({
      skill: value,
      paths: skillsData?.paths,
      daemonId: skillDaemonId,
      folder: skillFolder,
      chats: chatList,
    });
    if (target === null) return null;
    if ('reason' in target) {
      return (
        <span className="skill-edit-reason" data-testid={`${testid}-unavailable`}>
          {target.reason}
        </span>
      );
    }
    return (
      <button
        type="button"
        className="link-btn skill-edit"
        data-testid={testid}
        onClick={() => {
          setActiveChat(target.chatId);
          openFileInBrowser(target);
        }}
      >
        Edit
      </button>
    );
  }

  if (!isNew && isLoading) return <p>Loading…</p>;

  // Single-page form (spec/14 ## Jobs view: "one form view — no JSON tab,
  // no wizard"). All groups are always visible; the previous three-step wizard
  // contradicted the spec and hid the Name field on submit.
  const cronPreview = describeCron(form.cronExpression);
  const recurrencePreview = describeRecurrence(form.recurrenceRule);

  return (
    <main className="job-editor" data-testid="job-editor">
      <header className="route-head">
        <NavHistoryControls />
        <button type="button" className="back-btn" data-testid="job-editor-back" onClick={goBack}>
          ← Back
        </button>
        <h1 className="display">{isNew ? 'New job' : `Edit · ${form.name || id}`}</h1>
        {/* The job's END CONDITION (spec/08 § One-off jobs) — invisible
            everywhere on this page until now, even though the list groups a
            one-off job into its own section and the row disables its Toggle
            once expired. A `oneOff` job retires itself after its first fire
            settles `ok`; `expiredAt`'s presence IS "already has" (there is no
            separate flag to fall out of step with it — see `isExpiredJob`).
            Read-only here, the same as the Queue panel's concurrency limit:
            both are real stored fields with no editable control on this page,
            set instead through the agent tools (`patch_job_create`/`update`). */}
        {!isNew && (data as Job | undefined)?.oneOff ? (
          <span
            className="job-lifecycle-chip job-lifecycle-chip-oneoff"
            data-testid="job-editor-oneoff"
            title="Disables after one successful fire"
          >
            One-off
          </span>
        ) : null}
        {!isNew && (data as Job | undefined)?.expiredAt !== undefined ? (
          <span
            className="job-lifecycle-chip job-lifecycle-chip-expired"
            data-testid="job-editor-expired"
            title={`Expired ${new Date((data as Job).expiredAt as number).toLocaleString()} — enable to fire once more`}
          >
            Expired
          </span>
        ) : null}
        {/* Unsaved indicator (spec/14 § Jobs view — Unsaved changes), in the
            app's existing small-chip language: the same shape, mono case and
            waiting tint as a question card's header chip, which is already how
            this app says "there is something outstanding here". `role="status"`
            so its appearance is announced, not only drawn. */}
        {dirty ? (
          <span className="unsaved-chip" data-testid="job-editor-unsaved" role="status">
            {UNSAVED_BADGE_LABEL}
          </span>
        ) : null}
      </header>
      {/* spec/14 § Keyboard shortcuts — `⌘↵` commits the field you are typing in.
          Bound on the FORM rather than on each field: every box in here saves the
          same job, and a `<textarea>` (Prompt, Filter, the gate script) takes no
          part in a form's own Enter-to-submit, which is why the long prompt
          fields were the ones with no way out but the mouse. */}
      <form
        onSubmit={handleSubmit}
        onKeyDown={(e) => {
          if (!isSubmitChord(e)) return;
          handleSubmit(e);
        }}
      >
        {/* The autonomy prompt (spec/08 § Autonomy prompt). The account-wide
            prompt is edited once in Settings → Jobs; a job only shows it here
            under a collapsed "Advanced", where it can be overridden for this
            job alone. Opens by itself when the job already carries an
            override, so a customised job never hides its own text. The toggle
            switches the box between read-only (showing the account prompt) and
            editable; there is no "off" state. */}
        <details
          className="form-group"
          data-testid="group-autonomy-prompt"
          open={autonomyOpen}
          onToggle={(e) => setAutonomyOpen(e.currentTarget.open)}
        >
          <summary className="form-group-title" data-testid="job-advanced-toggle">
            Advanced
          </summary>
          <Toggle
            checked={form.autonomyPromptCustom}
            onChange={(on) =>
              setForm({
                ...form,
                autonomyPromptCustom: on,
                // Starting an override from the account prompt (rather than
                // blank) makes this an EDIT of it — ticking back off and on
                // keeps whatever was typed, same as `gateCommand`.
                ...(on && form.autonomyPromptText === ''
                  ? { autonomyPromptText: accountAutonomyPrompt }
                  : {}),
              })
            }
            label="Override autonomy prompt for this job"
            testid="job-autonomy-prompt-custom"
          />
          <textarea
            value={form.autonomyPromptCustom ? form.autonomyPromptText : accountAutonomyPrompt}
            onChange={(e) => setForm({ ...form, autonomyPromptText: e.target.value })}
            disabled={!form.autonomyPromptCustom}
            data-testid="job-autonomy-prompt-text"
            rows={2}
          />
        </details>

        <section className="form-group" data-testid="group-trigger">
          <h2 className="form-group-title">Trigger</h2>
          <label>
            Name
            {/* No native `required`: we validate in handleSubmit so a blank
                name surfaces the same toast error path as the other fields,
                rather than a browser tooltip that bypasses our handler. */}
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              data-testid="job-name"
            />
          </label>
          <label>
            Group <span className="form-group-opt">· optional</span>
            <select
              value={groupIsAdHoc ? NEW_GROUP : form.group}
              onChange={(e) => {
                const v = e.target.value;
                if (v === NEW_GROUP) {
                  setGroupCustom(true);
                  setForm({ ...form, group: '' });
                } else {
                  setGroupCustom(false);
                  setForm({ ...form, group: v });
                }
              }}
              data-testid="job-group"
            >
              <option value="">Ungrouped</option>
              {existingGroups.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
              <option value={NEW_GROUP}>New group…</option>
            </select>
            {groupIsAdHoc ? (
              <input
                value={form.group}
                onChange={(e) => setForm({ ...form, group: e.target.value })}
                placeholder="e.g. Home, Finance, Watchers"
                data-testid="job-group-custom"
                aria-label="new group name"
              />
            ) : null}
          </label>
          <label>
            Trigger type
            <select
              value={form.triggerType}
              onChange={(e) =>
                setForm({ ...form, triggerType: e.target.value as JobTrigger['type'] })
              }
              data-testid="job-trigger-type"
            >
              <option value="cron">cron</option>
              <option value="recurrence">recurrence</option>
              <option value="webhook">webhook</option>
              {form.triggerType === 'todoist' ? (
                <option value="todoist">todoist (legacy)</option>
              ) : null}
            </select>
          </label>

          {form.triggerType === 'cron' ? (
            <>
              <label>
                Schedule
                <input
                  value={form.scheduleText}
                  placeholder="e.g. every weekday at 9am"
                  data-testid="job-schedule-nl"
                  onChange={(e) => {
                    const scheduleText = e.target.value;
                    const cron = parseNaturalSchedule(scheduleText);
                    setForm({
                      ...form,
                      scheduleText,
                      ...(cron ? { cronExpression: cron } : {}),
                    });
                  }}
                />
              </label>
              {/* The zone the expression is evaluated in. The expression is
                  stored exactly as typed — nothing is rewritten into UTC — so
                  a DST change moves the fire time with the user, not past it. */}
              <label>
                Timezone
                <select
                  value={form.cronTimezone}
                  data-testid="job-cron-timezone"
                  onChange={(e) => setForm({ ...form, cronTimezone: e.target.value })}
                >
                  {TIMEZONE_OPTIONS.map((zone) => (
                    <option key={zone} value={zone}>
                      {zone}
                    </option>
                  ))}
                </select>
              </label>
              {/* One schedule field. The computed cron is shown read-only
                  beneath (not a second editable input). Raw cron is available
                  behind an "edit directly" toggle for phrases the parser can't
                  express, and is auto-revealed when the phrase doesn't parse. */}
              <div className="cron-computed" data-testid="job-cron-computed">
                {scheduleUnparsed ? (
                  <span className="cron-warn">
                    Couldn’t read “{form.scheduleText.trim()}”. Set the cron directly below.
                  </span>
                ) : (
                  <span>
                    Runs <strong>{cronPreview || form.cronExpression}</strong> ·{' '}
                    <code data-testid="job-cron-value">{form.cronExpression}</code> ·{' '}
                    <span data-testid="job-cron-timezone-value">{form.cronTimezone}</span>
                  </span>
                )}
                <button
                  type="button"
                  className="link-btn"
                  data-testid="job-cron-edit-toggle"
                  onClick={() => setShowRawCron((v) => !v)}
                >
                  {showRawCron ? 'hide cron' : 'edit cron directly'}
                </button>
              </div>
              {showRawCron || scheduleUnparsed ? (
                <label>
                  Cron expression
                  <input
                    value={form.cronExpression}
                    onChange={(e) => setForm({ ...form, cronExpression: e.target.value })}
                    data-testid="job-cron"
                  />
                </label>
              ) : null}
            </>
          ) : null}
          {form.triggerType === 'recurrence' ? (
            <>
              <label>
                Frequency
                <select
                  value={form.recurrenceFrequency}
                  data-testid="job-recurrence-frequency"
                  onChange={(e) =>
                    setForm(
                      setRecurrenceFrequency(
                        form,
                        e.target.value as FormState['recurrenceFrequency'],
                      ),
                    )
                  }
                >
                  <option value="WEEKLY">Weekly</option>
                  <option value="MONTHLY">Monthly</option>
                  <option value="YEARLY">Yearly</option>
                </select>
              </label>
              {/* A plain <div>, not <label> — wrapping a <label> around several
                  buttons makes the browser implicitly associate its whole text
                  with the FIRST one (real HTML label semantics: one label,
                  one control), which corrupts every chip's accessible name. */}
              <div className="field-group">
                <span>{form.recurrenceFrequency === 'WEEKLY' ? 'Days' : 'Day'}</span>
                <div className="chip-row" data-testid="job-recurrence-weekdays">
                  {RECURRENCE_WEEKDAYS.map((d) => (
                    <button
                      key={d.code}
                      type="button"
                      aria-pressed={form.recurrenceWeekdays.includes(d.code)}
                      onClick={() => setForm(toggleRecurrenceWeekday(form, d.code))}
                    >
                      {d.label}
                    </button>
                  ))}
                </div>
              </div>
              {form.recurrenceFrequency !== 'WEEKLY' ? (
                <label>
                  Occurrence
                  <select
                    value={form.recurrenceNth}
                    data-testid="job-recurrence-nth"
                    onChange={(e) =>
                      setForm(
                        withRecurrenceRule(form, {
                          recurrenceNth: e.target.value as FormState['recurrenceNth'],
                        }),
                      )
                    }
                  >
                    {RECURRENCE_NTH_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {form.recurrenceFrequency !== 'WEEKLY' ? (
                <div className="field-group">
                  <span>
                    Months{' '}
                    <span className="form-group-opt">
                      ·{' '}
                      {form.recurrenceFrequency === 'YEARLY'
                        ? 'required'
                        : 'optional — every month if none picked'}
                    </span>
                  </span>
                  <div className="chip-row" data-testid="job-recurrence-months">
                    {RECURRENCE_MONTHS.map((m) => (
                      <button
                        key={m.n}
                        type="button"
                        aria-pressed={form.recurrenceMonths.includes(m.n)}
                        onClick={() => setForm(toggleRecurrenceMonth(form, m.n))}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              <label>
                Time
                <input
                  type="time"
                  value={form.recurrenceTimeHHMM}
                  data-testid="job-recurrence-time"
                  onChange={(e) =>
                    setForm(withRecurrenceRule(form, { recurrenceTimeHHMM: e.target.value }))
                  }
                />
              </label>
              {/* The zone the RRULE is evaluated in — required, unlike cron's
                  optional one (spec/08 § Recurrence). Reuses cron's own
                  timezone list. */}
              <label>
                Timezone
                <select
                  value={form.recurrenceTimezone}
                  data-testid="job-recurrence-timezone"
                  onChange={(e) => setForm({ ...form, recurrenceTimezone: e.target.value })}
                >
                  {TIMEZONE_OPTIONS.map((zone) => (
                    <option key={zone} value={zone}>
                      {zone}
                    </option>
                  ))}
                </select>
              </label>
              <div className="recurrence-computed" data-testid="job-recurrence-computed">
                {recurrencePreview ? (
                  <span>
                    Runs <strong>{recurrencePreview}</strong> ·{' '}
                    <code data-testid="job-recurrence-value">{form.recurrenceRule}</code>
                  </span>
                ) : (
                  <span className="cron-warn">
                    Raw RRULE — couldn’t phrase this one in English:{' '}
                    <code data-testid="job-recurrence-value">{form.recurrenceRule}</code>
                  </span>
                )}
                <button
                  type="button"
                  className="link-btn"
                  data-testid="job-recurrence-edit-toggle"
                  onClick={() => setShowRawRecurrence((v) => !v)}
                >
                  {showRawRecurrence ? 'hide RRULE' : 'edit RRULE directly'}
                </button>
              </div>
              {showRawRecurrence ? (
                <label>
                  RRULE
                  <input
                    value={form.recurrenceRule}
                    onChange={(e) => setForm({ ...form, recurrenceRule: e.target.value })}
                    data-testid="job-recurrence-rule"
                  />
                </label>
              ) : null}
              {/* Third, additive way to set the schedule (spec/08 § Recurrence):
                  translate free text via the host's one-shot Claude call.
                  Fires only on explicit action (button / Enter), never on
                  keystroke. The result always drives the SAME live preview
                  above via recurrenceRule, so what Tom confirms is exactly
                  what gets saved. */}
              <label>
                Or describe it in words
                <div className="recurrence-nl-row">
                  <input
                    value={form.recurrenceNlText}
                    placeholder="e.g. every 3rd Sunday between May and August"
                    data-testid="job-recurrence-nl"
                    onChange={(e) => setForm({ ...form, recurrenceNlText: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void handleTranslateRecurrence();
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="link-btn"
                    data-testid="job-recurrence-translate"
                    disabled={recurrenceNlTranslating || form.recurrenceNlText.trim() === ''}
                    onClick={() => void handleTranslateRecurrence()}
                  >
                    {recurrenceNlTranslating ? 'Translating…' : 'Translate'}
                  </button>
                </div>
              </label>
              {recurrenceNlError ? (
                <div className="recurrence-nl-error" data-testid="job-recurrence-nl-error">
                  {recurrenceNlError}
                </div>
              ) : null}
              {recurrenceNlConfirmed && !recurrenceNlError ? (
                <div className="recurrence-nl-confirm" data-testid="job-recurrence-nl-confirm">
                  → {recurrenceNlConfirmed}
                </div>
              ) : null}
            </>
          ) : null}

          {form.triggerType === 'webhook' ? (
            <>
              <label>
                Scheme
                <select
                  data-testid="job-webhook-scheme"
                  value={form.webhookScheme}
                  onChange={(e) =>
                    setForm({ ...form, webhookScheme: e.target.value as WebhookScheme })
                  }
                >
                  <option value="none">none</option>
                  <option value="hmac-sha256">hmac-sha256</option>
                  <option value="github">github</option>
                  <option value="stripe">stripe</option>
                  <option value="todoist">todoist</option>
                </select>
              </label>
              <label>
                Secret
                <input
                  data-testid="job-webhook-secret"
                  value={form.webhookSecret}
                  onChange={(e) => setForm({ ...form, webhookSecret: e.target.value })}
                />
              </label>
            </>
          ) : null}
        </section>

        {/* Starts/Stops (spec/08 § Filter) — a date bound is meaningful on
            every trigger type, cron and recurrence included, unlike the raw
            payload filter below. Backed by the SAME `filter` field under the
            hood (a `now >= "..."`/`now <= "..."` clause), just presented as
            real dates instead of JSONata. */}
        <section className="form-group" data-testid="group-date-range">
          <h2 className="form-group-title">
            Starts / stops <span className="form-group-opt">· optional</span>
          </h2>
          <DateTimeField
            label="Starts"
            value={form.dateStart}
            onChange={(v) => setForm({ ...form, dateStart: v })}
            testId="job-date-start"
          />
          <DateTimeField
            label="Stops"
            value={form.dateStop}
            onChange={(v) => setForm({ ...form, dateStop: v })}
            testId="job-date-stop"
          />
        </section>

        {/* Filter only applies to payload-bearing triggers (webhook /
            todoist) — cron and recurrence triggers have no event to filter,
            they just fire on schedule. */}
        {form.triggerType !== 'cron' && form.triggerType !== 'recurrence' ? (
          <section className="form-group" data-testid="group-filter">
            <h2 className="form-group-title">
              Filter <span className="form-group-opt">· optional</span>
            </h2>
            <label>
              JSONata filter on the trigger payload
              <textarea
                value={form.filter}
                onChange={(e) => setForm({ ...form, filter: e.target.value })}
                rows={3}
                data-testid="job-filter"
              />
            </label>
          </section>
        ) : null}

        {/* The GATE (spec/08 § Gate) — a shell command that decides whether each
            fire proceeds. Beside Filter because it is the same kind of thing: a
            precondition on the fire. Filter asks about the trigger's payload,
            which is why it is cron-only-hidden; a gate asks about the WORLD, so
            it applies to every trigger including cron, where it is most useful. */}
        <section className="form-group" data-testid="group-gate">
          <h2 className="form-group-title">
            Gate <span className="form-group-opt">· optional</span>
          </h2>
          <Toggle
            checked={form.gateOn}
            onChange={(on) =>
              setForm({
                ...form,
                gateOn: on,
                // Seed the host and folder from the action, which is where the
                // work happens and so almost always where the question belongs.
                ...(on && form.gateDaemonId === '' ? { gateDaemonId: form.spawnDaemonId } : {}),
                ...(on && form.gateFolder === '' ? { gateFolder: form.spawnFolder } : {}),
              })
            }
            label="Ask a command first, and only run the action if it says to"
            testid="job-gate-on"
          />
          {form.gateOn ? (
            <>
              <label>
                Host
                <input
                  value={form.gateDaemonId}
                  onChange={(e) => setForm({ ...form, gateDaemonId: e.target.value })}
                  data-testid="job-gate-daemon"
                />
              </label>
              <label>
                Folder
                <input
                  value={form.gateFolder}
                  onChange={(e) => setForm({ ...form, gateFolder: e.target.value })}
                  data-testid="job-gate-folder"
                />
              </label>
              <ScriptCommandEditor
                value={form.gateCommand}
                onChange={(next) => setForm({ ...form, gateCommand: next })}
                reloadKey={loadedRevision}
                name="gate"
                heading="Gate command · run by `bash -lc` in the folder above"
                hint={
                  <>
                    <strong>exit 0</strong> runs the action. <strong>exit 1</strong> holds it — and
                    must print why on stdout, which becomes the run’s headline. Any other exit, no
                    reason, or a timeout is a fault, and says so loudly in Recent runs. What a
                    passing gate printed reaches the action’s prompt as{' '}
                    <code>{'{{gate.stdout}}'}</code> (its last line alone as{' '}
                    <code>{'{{gate.verdict}}'}</code>), so what the gate found is not looked up
                    twice.
                  </>
                }
              />
              <label>
                Timeout (ms)
                <input
                  value={form.gateTimeoutMs}
                  placeholder="60000"
                  onChange={(e) => setForm({ ...form, gateTimeoutMs: e.target.value })}
                  data-testid="job-gate-timeout"
                />
              </label>
            </>
          ) : null}
        </section>

        <section className="form-group" data-testid="group-window">
          <h2 className="form-group-title">
            Run window <span className="form-group-opt">· optional</span>
          </h2>
          <Toggle
            checked={form.windowOn}
            onChange={(on) => setForm({ ...form, windowOn: on })}
            label="Only start fires between these hours; hold the rest until it opens"
            testid="job-window-on"
          />
          {form.windowOn ? (
            <>
              <label>
                From
                <input
                  type="time"
                  value={form.windowStart}
                  onChange={(e) => setForm({ ...form, windowStart: e.target.value })}
                  data-testid="job-window-start"
                />
              </label>
              <label>
                Until
                <input
                  type="time"
                  value={form.windowEnd}
                  onChange={(e) => setForm({ ...form, windowEnd: e.target.value })}
                  data-testid="job-window-end"
                />
              </label>
              <label>
                Timezone
                <select
                  value={form.windowTimezone}
                  data-testid="job-window-timezone"
                  onChange={(e) => setForm({ ...form, windowTimezone: e.target.value })}
                >
                  {TIMEZONE_OPTIONS.map((zone) => (
                    <option key={zone} value={zone}>
                      {zone}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : null}
        </section>

        <section className="form-group" data-testid="group-action">
          <h2 className="form-group-title">Action</h2>
          <>
            <label>
              Action type
              <select
                value={form.actionType}
                data-testid="job-action-type"
                onChange={(e) =>
                  setForm({ ...form, actionType: e.target.value as JobAction['type'] })
                }
              >
                <option value="spawn">spawn new chat (fresh each fire)</option>
                <option value="continue">message a persistent chat (created once)</option>
                <option value="message">message an existing chat</option>
                <option value="script">run a command (no chat, no model)</option>
              </select>
            </label>
            {form.actionType === 'script' ? (
              <>
                <label>
                  Host
                  <input
                    value={form.spawnDaemonId}
                    onChange={(e) => setForm({ ...form, spawnDaemonId: e.target.value })}
                    data-testid="job-script-daemon"
                    required
                  />
                </label>
                <label>
                  Folder
                  <input
                    value={form.spawnFolder}
                    onChange={(e) => setForm({ ...form, spawnFolder: e.target.value })}
                    data-testid="job-script-folder"
                    required
                  />
                </label>
                <ScriptCommandEditor
                  value={form.scriptCommand}
                  onChange={(next) => setForm({ ...form, scriptCommand: next })}
                  reloadKey={loadedRevision}
                  name="script"
                />
                <label>
                  Timeout (ms)
                  <input
                    value={form.scriptTimeoutMs}
                    placeholder="60000"
                    onChange={(e) => setForm({ ...form, scriptTimeoutMs: e.target.value })}
                    data-testid="job-script-timeout"
                  />
                </label>
              </>
            ) : form.actionType === 'spawn' || form.actionType === 'continue' ? (
              <>
                <label>
                  Folder
                  <select
                    value={
                      form.spawnDaemonId === '' && form.spawnFolder === '' && !folderCustom
                        ? ''
                        : folderChoiceValue(
                            form.spawnDaemonId,
                            folderIsAdHoc ? CUSTOM_FOLDER : form.spawnFolder,
                          )
                    }
                    onChange={(e) => {
                      const picked = parseFolderChoice(e.target.value);
                      if (!picked) return;
                      // The option carries its host: picking a folder picks the
                      // machine, and BOTH are what the action stores
                      // (spec/14 § Jobs view, spec/08 § Action).
                      if (picked.folder === CUSTOM_FOLDER) {
                        setFolderCustom(true);
                        setForm({ ...form, spawnDaemonId: picked.daemonId, spawnFolder: '' });
                      } else {
                        setFolderCustom(false);
                        setForm({
                          ...form,
                          spawnDaemonId: picked.daemonId,
                          spawnFolder: picked.folder,
                        });
                      }
                    }}
                    data-testid="job-spawn-folder"
                  >
                    {form.spawnDaemonId === '' && form.spawnFolder === '' && !folderCustom ? (
                      <option value="" disabled>
                        {folderGroups.length === 0
                          ? 'No hosts connected'
                          : 'Select a host and folder…'}
                      </option>
                    ) : null}
                    {folderGroups.map((g) => (
                      <optgroup key={g.daemonId} label={g.label}>
                        {g.folders.map((f) => (
                          <option key={f} value={folderChoiceValue(g.daemonId, f)}>
                            {f}
                          </option>
                        ))}
                        <option value={folderChoiceValue(g.daemonId, CUSTOM_FOLDER)}>
                          Custom path on {g.label}…
                        </option>
                      </optgroup>
                    ))}
                  </select>
                  <p className="field-hint" data-testid="job-spawn-host">
                    {form.spawnDaemonId
                      ? `Runs on ${folderGroups.find((g) => g.daemonId === form.spawnDaemonId)?.label ?? form.spawnDaemonId}`
                      : 'No host chosen. Pick a folder under the machine it lives on.'}
                  </p>
                  {folderIsAdHoc ? (
                    <input
                      value={form.spawnFolder}
                      onChange={(e) => setForm({ ...form, spawnFolder: e.target.value })}
                      data-testid="job-spawn-folder-custom"
                      placeholder="/home/tom/projects/example"
                      aria-label="custom folder path"
                    />
                  ) : null}
                </label>
                {modelField()}
                {accountField()}
                <p className="field-hint" data-testid="action-payload-hint">
                  Provide a Skill, a Prompt, or both (the Skill runs with the Prompt as its input).
                </p>
                {skillField(
                  form.spawnSkill,
                  (v) => setForm({ ...form, spawnSkill: v }),
                  'job-spawn-skill',
                )}
                <label>
                  Prompt
                  <textarea
                    className="job-prompt"
                    rows={12}
                    value={form.spawnPrompt}
                    onChange={(e) => setForm({ ...form, spawnPrompt: e.target.value })}
                    data-testid="job-spawn-prompt"
                  />
                </label>
                {form.actionType === 'continue' ? (
                  <label>
                    Deduplication key
                    <input
                      value={form.ensureKey}
                      onChange={(e) => setForm({ ...form, ensureKey: e.target.value })}
                      data-testid="job-ensure-key"
                      placeholder="{{payload.event_data.id}}"
                    />
                    <p className="field-hint" data-testid="job-ensure-key-hint">
                      Mustache template evaluated against each fire's payload. Fires that render the
                      same key resume one chat instead of starting a new one — leave empty for a
                      single chat shared by every fire of this job.
                    </p>
                  </label>
                ) : null}
                {form.actionType === 'spawn' ? (
                  <label>
                    Permission mode
                    <select
                      value={form.spawnPermissionMode}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          spawnPermissionMode: e.target.value as PermissionMode,
                        })
                      }
                      data-testid="job-spawn-permission-mode"
                    >
                      {/* The SDK's own mode names (spec/02 § Permission
                            mode), read out in sentence case — this value is
                            stamped onto the chat the job spawns and passed
                            through verbatim. */}
                      {PERMISSION_MODES.filter(
                        (m) =>
                          form.spawnModel === '' || permissionModesFor(form.spawnModel).includes(m),
                      ).map((m) => (
                        <option key={m} value={m}>
                          {permissionModeLabel(m)}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <Toggle
                  checked={form.spawnHidden}
                  onChange={(next) => setForm({ ...form, spawnHidden: next })}
                  label="Hide chat from sidebar"
                  testid="job-spawn-hidden"
                />
                <Toggle
                  checked={form.spawnNotifyOnComplete}
                  onChange={(next) => setForm({ ...form, spawnNotifyOnComplete: next })}
                  label="Notify when job complete"
                  testid="job-spawn-notify-on-complete"
                />
                <Toggle
                  checked={form.includePayload}
                  onChange={(next) => setForm({ ...form, includePayload: next })}
                  label="Include trigger event"
                  testid="job-include-payload"
                />
              </>
            ) : (
              <>
                <label>
                  Recipient chat
                  <select
                    value={form.messageChatId}
                    onChange={(e) => setForm({ ...form, messageChatId: e.target.value })}
                    data-testid="job-message-chat"
                    required
                  >
                    <option value="">— pick a chat —</option>
                    {chatList.map((c) => (
                      <option key={c.chatId} value={c.chatId}>
                        {(c.name ?? c.chatId) + ' · ' + c.folder}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="field-hint" data-testid="action-payload-hint">
                  Provide a Skill, a Prompt, or both (the Skill runs with the Prompt as its input).
                </p>
                {skillField(
                  form.messageSkill,
                  (v) => setForm({ ...form, messageSkill: v }),
                  'job-message-skill',
                )}
                <label>
                  Prompt
                  <textarea
                    className="job-prompt"
                    rows={12}
                    value={form.messagePrompt}
                    onChange={(e) => setForm({ ...form, messagePrompt: e.target.value })}
                    data-testid="job-message-prompt"
                  />
                </label>
                <Toggle
                  checked={form.includePayload}
                  onChange={(next) => setForm({ ...form, includePayload: next })}
                  label="Include trigger event"
                  testid="job-include-payload"
                />
              </>
            )}
            {/* No Enabled checkbox: a job is created enabled. Enable/disable an
                existing job from the per-row toggle on the Jobs list. */}
          </>
        </section>

        <div className="form-actions">
          {/* Dead while its own request is in flight, like Run now beside it.
              Both the click and `⌘↵` reach `handleSubmit`, and without this a
              second press before the POST returns creates the job twice — the
              navigate() that ends the first one only happens on success. */}
          <button
            type="submit"
            className="primary-btn"
            data-testid="job-save"
            disabled={saving || scheduleBlocksSave || recurrenceBlocksSave}
            title={
              scheduleBlocksSave
                ? 'Fix the schedule first — the typed phrase didn’t parse'
                : recurrenceBlocksSave
                  ? 'Set a schedule first — the RRULE is empty'
                  : shortcutLabel('⌘↵')
            }
          >
            {isNew ? 'Create' : 'Save'}
          </button>
          {!isNew ? (
            <button
              type="button"
              className="secondary-btn"
              data-testid="job-run-now"
              disabled={runMut.isPending}
              onClick={() => runMut.mutate(dirty ? formToBody(form) : undefined)}
            >
              {dirty ? 'Test run' : 'Run saved job'}
            </button>
          ) : null}
          {!isNew ? (
            <button
              type="button"
              className="danger-btn"
              onClick={() => {
                void useUiStore
                  .getState()
                  .confirm({
                    title: 'Delete job',
                    message: 'Delete this job?',
                    confirmLabel: 'Delete',
                    danger: true,
                  })
                  .then((ok) => {
                    if (ok) deleteMut.mutate();
                  });
              }}
            >
              Delete
            </button>
          ) : null}
        </div>
      </form>
      {/* The gate's queue (spec/08 § Concurrency). Only a job WITH a limit
          has one: without a limit every fire goes out the moment it arrives,
          so the panel would be permanently empty and say nothing. */}
      {!isNew && data && (data as Job).concurrency !== undefined ? (
        <JobQueuePanel job={data as Job} />
      ) : null}
      {!isNew && data ? <RecentRunsPanel job={data as Job} /> : null}
    </main>
  );
}

/**
 * What the job is running right now and what is waiting behind its limit
 * (spec/08 § Concurrency). The runs panel below is history; this is the live
 * backlog, so it polls faster — a queue read half a minute late is a queue you
 * cannot watch drain.
 */
function JobQueuePanel({ job }: { job: Job }): JSX.Element {
  const { data, error } = useQuery({
    queryKey: ['job-queue', job.id],
    queryFn: () => api.jobQueue(job.id),
    refetchInterval: 5_000,
  });
  const limit = data?.concurrency ?? job.concurrency ?? null;
  return (
    <section className="recent-runs job-queue route-card" data-testid="job-queue">
      <div className="recent-runs-head">
        <h3>Queue</h3>
        {limit !== null ? (
          <span className="job-queue-limit" data-testid="job-queue-limit">
            {limit} at a time
          </span>
        ) : null}
      </div>
      {error ? (
        <p className="error">failed to load queue: {(error as Error).message}</p>
      ) : !data || (data.inFlight.length === 0 && data.queued.length === 0) ? (
        <p className="empty">Nothing running or queued.</p>
      ) : (
        <ul onKeyDown={(e) => runListKeyDown(e, job.id)}>
          {data.inFlight.map((e) => (
            <li key={`f-${e.chatId}-${e.localId}`} data-testid="job-queue-running">
              <span>{new Date(e.startedAt).toLocaleString()}</span>
              <span className="status status-running">running</span>
              <RunChatLink jobId={job.id} chatId={e.chatId} />
            </li>
          ))}
          {data.queued.map((e) => (
            <li key={`q-${e.fireId}`} data-testid="job-queue-waiting">
              <span>{new Date(e.queuedAt).toLocaleString()}</span>
              <span className="status status-queued">waiting</span>
              {/* No chat link: a queued fire has not been sent, so the chat it
                  names does not exist yet and the link would dead-end. */}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** How many runs the panel asks for first, and how many each "Show more" adds. */
const RUNS_PAGE = 25;
/** The server's own ceiling (`/api/jobs/:id/runs` clamps to 200). */
const RUNS_MAX = 200;

/**
 * A fire the job's own filter turned away. On a Todoist-triggered job these are
 * almost all of them — every unrelated task edit in the account is a fire — so
 * five rows of `filter-rejected` was the whole panel, and the run you came to
 * look at was never on screen (Tom, Patch Updates — "recent runs should filter
 * out rejected by default (add toggle). it should show everything (paginated if
 * necessary)").
 *
 * `filter-error` is deliberately NOT one of these: the filter THREW, which is a
 * fault to see, not a decision to hide.
 */
function isRejectedRun(status: string): boolean {
  // `gate-held` belongs here for exactly the same reason (spec/08 § Gate): on a
  // watcher that fires every five minutes, nearly every row is a hold, and a
  // panel that is 280 holds deep is a panel in which the launch you came to find
  // is not on screen. Hidden is not buried — the toggle is COUNTED, so the count
  // itself says the gate is alive and deciding, and one click shows every hold
  // with the reason it gave.
  //
  // `gate-error` is deliberately NOT one of these, for the same reason
  // `filter-error` is not: the gate BROKE. That is the one thing about a watcher
  // that must never need a click to notice.
  return status === 'filter-rejected' || status === 'gate-held';
}

function RecentRunsPanel({ job }: { job: Job }): JSX.Element {
  const [limit, setLimit] = useState(RUNS_PAGE);
  const [showRejected, setShowRejected] = useState(false);
  const { data, error } = useQuery({
    queryKey: ['job-runs', job.id, limit],
    queryFn: () => api.jobRuns(job.id, limit),
    refetchInterval: 30_000,
    // Growing the page re-runs the query; without this the list empties back to
    // "No runs yet." for the round trip, which reads as the history vanishing.
    placeholderData: keepPreviousData,
  });
  const runs = data?.runs ?? [];
  const rejected = runs.filter((r) => isRejectedRun(r.status)).length;
  // A gate's holds and a filter's rejections are both fires turned away, but a
  // reader wants different words for them: "held" is what a watcher DOES all day
  // and is the count that proves it is alive, where "rejected" is the noise of a
  // busy Todoist account. Whichever kind this job actually has, name it.
  const heldWord = runs.some((r) => r.status === 'gate-held') ? 'held' : 'rejected';
  const visible = showRejected ? runs : runs.filter((r) => !isRejectedRun(r.status));
  // A full page back means the log probably has more behind it. At the server's
  // ceiling there is nothing left to ask for.
  const more = runs.length >= limit && limit < RUNS_MAX;
  const chatId = jobChatId(job, data?.runs?.[0]?.action?.chatId);
  return (
    <section className="recent-runs route-card" data-testid="recent-runs">
      <div className="recent-runs-head">
        <h3>Recent runs</h3>
        {rejected > 0 ? (
          <button
            type="button"
            className="recent-runs-toggle"
            data-testid="recent-runs-rejected-toggle"
            aria-pressed={showRejected}
            onClick={() => setShowRejected((v) => !v)}
          >
            {showRejected ? `Hide ${heldWord}` : `Show ${rejected} ${heldWord}`}
          </button>
        ) : null}
        {chatId ? (
          <Link to={`/chats/${chatId}`} className="job-chat-link" data-testid="recent-runs-chat">
            open chat
          </Link>
        ) : null}
      </div>
      {error ? (
        <p className="error">failed to load runs: {(error as Error).message}</p>
      ) : runs.length === 0 ? (
        <p className="empty">No runs yet.</p>
      ) : visible.length === 0 ? (
        // Not the same as "no runs": every one of them was turned away by the
        // filter, and saying so is the answer to "why is nothing happening?".
        <p className="empty" data-testid="recent-runs-all-rejected">
          {heldWord === 'held'
            ? 'Every fire was held by the gate — which is a gate doing its job. Show them to see why.'
            : 'Every run was rejected by the filter.'}
        </p>
      ) : (
        <ul onKeyDown={(e) => runListKeyDown(e, job.id)}>
          {visible.map((r, i) => (
            <RunRow key={`${r.ts}-${i}`} run={r} jobId={job.id} />
          ))}
        </ul>
      )}
      {more ? (
        <button
          type="button"
          className="recent-runs-more"
          data-testid="recent-runs-more"
          onClick={() => setLimit((n) => Math.min(RUNS_MAX, n + RUNS_PAGE))}
        >
          Show more
        </button>
      ) : null}
    </section>
  );
}

/** One row of `api.jobRuns`. */
type JobRun = Awaited<ReturnType<typeof api.jobRuns>>['runs'][number];

/**
 * A run's "open chat" link (spec/14 § Panes and tabs § Opening things — runs
 * open beside the job). A plain click opens the run's chat in the pane to the
 * right of the job instead of navigating away, so the list stays in view;
 * a middle click is a new tab, and a modified click or the browser's own
 * context menu keep the anchor's href (new window / new tab).
 */
function RunChatLink({ jobId, chatId }: { jobId: string; chatId: string }): JSX.Element {
  return (
    <Link
      className="run-chat-link"
      to={`/chats/${chatId}`}
      data-chat-id={chatId}
      onClick={(e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        openChatBesideJob(jobId, chatId);
      }}
      onAuxClick={(e) => {
        if (e.button !== 1) return;
        e.preventDefault();
        openChatInNewTab(chatId);
      }}
    >
      open chat
    </Link>
  );
}

/**
 * ↑/↓ in a runs list steps to the previous/next run that has a chat, moving
 * focus and updating the chat pane beside the job to it.
 */
function runListKeyDown(e: ReactKeyboardEvent<HTMLElement>, jobId: string): void {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const links = Array.from(e.currentTarget.querySelectorAll<HTMLAnchorElement>('a.run-chat-link'));
  const row = (e.target as HTMLElement).closest('li');
  const at = links.findIndex((a) => a.closest('li') === row);
  if (at === -1) return;
  const next = links[at + (e.key === 'ArrowDown' ? 1 : -1)];
  if (!next) return;
  e.preventDefault();
  next.focus();
  openChatBesideJob(jobId, next.dataset['chatId'] ?? '');
}

/**
 * One fire in the Recent runs list.
 *
 * A `script` fire needs more than a status word, and is the reason this is a
 * component rather than a `<li>` inline. Those jobs are GATES: they fire on a
 * tight cron, decide whether there is work, and mostly decide there is not —
 * so an honest run of held fires and a gate that broke three days ago produce
 * the same row, `ok` after `ok` after `ok`, and "why has nothing happened?"
 * has no answer anywhere in the app (Tom — "i cant actually dig into when the
 * job gets launched because its in code"). The exit code and output tail were
 * already being recorded; they were simply never rendered.
 *
 * So a script row shows the gate's VERDICT — its last printed line, per the
 * stdout contract on `ScriptAction` — with the rest of the output behind an
 * expander, and links the chat the fire announced. Which makes the two
 * outcomes tell themselves apart at a glance: a launch has a chat link.
 */
function RunRow({ run, jobId }: { run: JobRun; jobId: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const output = run.action?.output ?? '';
  const verdict = scriptVerdictLine(output);
  // Only a script fire has an exit code, and only a non-zero one is worth the
  // space: `exit 0` on every held fire is the noise this row exists to cut.
  // `null` is a real value — the command was killed before it could report one.
  const code = run.action?.exitCode;
  const badCode = code !== undefined && code !== 0;
  // Worth expanding only when there is more than the headline already on screen.
  const hasMore = output.length > 0 && output.trim() !== verdict;
  return (
    <li className="run-row">
      <div className="run-row-head">
        <span>{new Date(run.ts).toLocaleString()}</span>
        <span className={`status status-${run.status}`}>{run.status}</span>
        {badCode ? (
          <span className="run-exit" data-testid="run-exit">
            {code === null ? 'killed' : `exit ${code}`}
          </span>
        ) : null}
        {run.action?.chatId ? <RunChatLink jobId={jobId} chatId={run.action.chatId} /> : null}
        {run.error ? <span className="run-error">{run.error}</span> : null}
        {hasMore ? (
          <button
            type="button"
            className="run-output-toggle"
            data-testid="run-output-toggle"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? 'less' : 'output'}
          </button>
        ) : null}
      </div>
      {verdict !== null ? (
        <p className="run-verdict" data-testid="run-verdict">
          {verdict}
        </p>
      ) : null}
      {open ? (
        <pre className="run-output" data-testid="run-output">
          {output}
        </pre>
      ) : null}
    </li>
  );
}

function jobToForm(job: Job): FormState {
  const f: FormState = { ...DEFAULT_FORM };
  f.name = job.name;
  f.group = job.group ?? '';
  // spec/08 § Autonomy prompt: presence of a stored override is what
  // "customised" means — absent reads back as the untouched default.
  f.autonomyPromptCustom = job.autonomyPrompt !== undefined;
  f.autonomyPromptText = job.autonomyPrompt ?? '';
  f.enabled = job.enabled;
  const { start, stop, remainder } = parseDateRangeFromFilter(job.filter);
  f.filter = remainder ?? '';
  f.dateStart = isoToLocalInputValue(start);
  f.dateStop = isoToLocalInputValue(stop);
  f.triggerType = job.trigger.type;
  if (job.trigger.type === 'cron') {
    f.cronExpression = job.trigger.expression;
    // No stored zone means the server evaluates it in UTC, so that is what the
    // picker must show and what re-saving must write back. Defaulting to the
    // browser's zone here would silently move an existing job's fire time.
    f.cronTimezone = job.trigger.timezone ?? 'UTC';
    // Prefill the natural-language field with a readable rendering of the cron
    // so an edited job shows e.g. "weekdays at 9am" rather than blank.
    f.scheduleText = describeCron(job.trigger.expression);
  }
  if (job.trigger.type === 'recurrence') {
    f.recurrenceRule = job.trigger.rrule;
    f.recurrenceTimezone = job.trigger.timezone;
    // Best-effort backfill of the structured controls, for editing
    // convenience — using the SAME parser the describer is built on
    // (`parseRecurrenceFields`), so "can this job's rule populate the
    // builder" can never disagree with "can it be phrased in English". A
    // rule outside that narrow shape leaves the structured controls at their
    // defaults; the raw RRULE field (always populated above) stays the
    // source of truth regardless.
    const parsed = parseRecurrenceFields(job.trigger.rrule);
    if (parsed !== null) {
      f.recurrenceFrequency = parsed.freq;
      f.recurrenceWeekdays = parsed.days;
      if (parsed.setPos !== null)
        f.recurrenceNth = String(parsed.setPos) as FormState['recurrenceNth'];
      f.recurrenceMonths = parsed.months ?? [];
      f.recurrenceTimeHHMM = `${String(parsed.hour).padStart(2, '0')}:${String(parsed.minute).padStart(2, '0')}`;
    }
  }
  if (job.trigger.type === 'webhook') {
    f.webhookScheme = job.trigger.scheme;
    f.webhookSecret = job.trigger.secret ?? '';
  }
  if (job.gate) {
    f.gateOn = true;
    f.gateDaemonId = job.gate.daemonId;
    f.gateFolder = job.gate.folder;
    f.gateCommand = job.gate.command;
    f.gateTimeoutMs = job.gate.timeoutMs === undefined ? '' : String(job.gate.timeoutMs);
  }
  if (job.window) {
    f.windowOn = true;
    f.windowStart = job.window.start;
    f.windowEnd = job.window.end;
    f.windowTimezone = job.window.timezone;
  }
  f.actionType = job.action.type;
  if (job.action.type === 'spawn' || job.action.type === 'continue') {
    // spawn + ensure share the folder + skill/prompt fields.
    f.spawnDaemonId = job.action.daemonId;
    f.spawnFolder = job.action.folder;
    f.spawnPrompt = job.action.prompt ?? '';
    f.spawnSkill = job.action.skill ?? '';
    // No stored model → the `Account default` row, which is what re-saving must
    // write back (i.e. still no model), not the host's current last-used id.
    f.spawnModel = job.action.model ?? '';
    f.spawnAccount = job.action.preferredAccountId ?? '';
    // Both folder-carrying actions place the chat they create (spec/08 ##
    // Action), so both carry `startHidden`.
    f.spawnHidden = job.action.startHidden === true;
    // Default-ON, so ONLY an explicit `false` unticks it: absent means notify,
    // and a redundant stored `true` means the same thing (spec/08 ## Action).
    f.spawnNotifyOnComplete = job.action.notifyOnComplete !== false;
    f.includePayload = job.action.includePayload !== false;
    if (job.action.type === 'spawn') {
      // No stored mode means the fire runs under `auto` (spec/08 § Action), so
      // that is what the form shows — there is nothing else it could be.
      f.spawnPermissionMode = job.action.permissionMode ?? 'auto';
    } else {
      f.ensureKey = job.action.key ?? '';
    }
  } else if (job.action.type === 'script') {
    f.spawnDaemonId = job.action.daemonId;
    f.spawnFolder = job.action.folder;
    f.scriptCommand = job.action.command;
    f.scriptTimeoutMs = job.action.timeoutMs === undefined ? '' : String(job.action.timeoutMs);
  } else {
    f.messageChatId = job.action.chatId;
    f.messagePrompt = job.action.prompt ?? '';
    f.messageSkill = job.action.skill ?? '';
    f.includePayload = job.action.includePayload !== false;
  }
  return f;
}

function formToBody(form: FormState): JobCreateBody {
  let trigger: JobTrigger;
  switch (form.triggerType) {
    case 'cron':
      trigger = {
        type: 'cron',
        expression: form.cronExpression,
        // `UTC` is the meaning of an absent zone, so it is written as an
        // omission — that keeps a round-tripped pre-timezone job byte-identical
        // and keeps the body accepted by an older strict `CronTrigger`.
        ...(form.cronTimezone !== 'UTC' ? { timezone: form.cronTimezone } : {}),
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
        timezone: form.recurrenceTimezone,
      };
      break;
  }

  let action: JobAction;
  if (form.actionType === 'spawn' || form.actionType === 'continue') {
    // spawn (fresh chat each fire) and ensure (one durable chat) share shape.
    action = {
      type: form.actionType,
      daemonId: form.spawnDaemonId,
      folder: form.spawnFolder,
      ...(form.spawnPrompt ? { prompt: form.spawnPrompt } : {}),
      ...(form.spawnSkill ? { skill: form.spawnSkill } : {}),
      // `Account default` is the empty string, and it must persist as an ABSENT
      // field: omitting `model` is what makes each fire take the host's
      // last-used one (spec/08 § Action).
      ...(form.spawnModel ? { model: form.spawnModel } : {}),
      // spec/08 § Action — absent leaves the account to the strategy.
      ...(form.spawnAccount ? { preferredAccountId: form.spawnAccount } : {}),
      // Written for `spawn` AND `ensure` — both place the chat they create.
      // Only ever written when SET: both actions are `.strict()`, so a job
      // nobody has ticked the box on must serialise byte-identically to how it
      // did before the field existed (`startHidden: false` is a different payload).
      ...(form.spawnHidden ? { startHidden: true } : {}),
      // The inverse encoding of `startHidden` above, for the same reason:
      // this flag defaults ON, so the ABSENT field is the ticked state and only
      // unticking writes anything. Writing `notifyOnComplete: true` would add a
      // no-op key to every job that never touched the toggle (spec/08 ## Action).
      ...(form.spawnNotifyOnComplete ? {} : { notifyOnComplete: false }),
      // Same inverted encoding: absent is the ticked, default state.
      ...(form.includePayload ? {} : { includePayload: false }),
      ...(form.actionType === 'continue' && form.ensureKey ? { key: form.ensureKey } : {}),
      // Spawn-only for the same reason as `startHidden`. `auto` is what an absent
      // field already means (spec/08 § Action), so it persists as absent —
      // that keeps a job written before this field existed byte-identical
      // after an unrelated edit, instead of gaining a no-op key.
      ...(form.actionType === 'spawn' && form.spawnPermissionMode !== 'auto'
        ? { permissionMode: form.spawnPermissionMode }
        : {}),
    };
  } else if (form.actionType === 'script') {
    action = {
      type: 'script',
      daemonId: form.spawnDaemonId,
      folder: form.spawnFolder,
      command: form.scriptCommand,
      // Empty means "the default" and must persist as an ABSENT field, the
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
    name: form.name,
    // Always sent, never omitted — same as `name`. An empty string clears a
    // job's group (spec/08 § Groups); there is no separate "leave alone"
    // state at this layer, since the editor always submits the whole form.
    group: form.group.trim(),
    // `null` when left as default — the explicit "clear back to the
    // account-wide prompt" instruction (spec/08 § Autonomy prompt) —
    // rather than omitted: the same reason `gate` writes `null` rather than
    // leaving the key off, since an omitted key on PATCH leaves a previously
    // customised job's override untouched instead of clearing it.
    autonomyPrompt:
      form.autonomyPromptCustom && form.autonomyPromptText.trim().length > 0
        ? form.autonomyPromptText
        : null,
    enabled: form.enabled,
    trigger,
    // The date range applies to every trigger type; the custom-JSONata
    // remainder does not — cron/recurrence triggers have no payload beyond
    // `{ firedAt }` to filter on, hence the raw Filter group being hidden for
    // them above (spec/08 § Filter), so their remainder is never persisted
    // even if the form still carries leftover text from a different trigger
    // type picked earlier in this same edit.
    filter: buildFilterFromDateRange(
      localInputValueToIso(form.dateStart),
      localInputValueToIso(form.dateStop),
      form.triggerType !== 'cron' && form.triggerType !== 'recurrence' && form.filter.length > 0
        ? form.filter
        : null,
    ),
    // An unticked gate, or one with nothing written in it, is written as `null`
    // rather than omitted: a PATCH that omits the field LEAVES the stored gate
    // alone, so unticking the box has to say so explicitly or it would not save
    // (spec/08 § Gate — `JobPatchBody.gate`).
    gate:
      form.gateOn && form.gateCommand.trim().length > 0
        ? {
            daemonId: form.gateDaemonId,
            folder: form.gateFolder,
            command: form.gateCommand,
            // Empty means the default, which must persist as an ABSENT field —
            // the same rule `model` and `timeoutMs` follow above.
            ...(form.gateTimeoutMs ? { timeoutMs: Number(form.gateTimeoutMs) } : {}),
          }
        : null,
    // Unticked is `null`, not omitted: a PATCH that omits the field leaves the
    // stored window alone (spec/08 § Run window).
    window: form.windowOn
      ? { start: form.windowStart, end: form.windowEnd, timezone: form.windowTimezone }
      : null,
    action,
  };
}
