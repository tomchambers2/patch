// Human-readable renderers for a Job's trigger and action, matching
// design/web-lo-fi-schedules.html (trigger as natural language —
// "weekdays at 8:57am", "Todoist task tagged @claude" — and action as a
// two-axis verb "spawn · skill" / "message · prompt" plus its target).
//
// A cron expression is stored EXACTLY as authored and evaluated in its own
// `trigger.timezone` (spec/08 § Cron); an absent zone means UTC. We render the
// field shape directly — a best-effort label for scannability, not a scheduler
// — and name the zone whenever it is not the reader's own, because "9am" on a
// row for a job that fires at 10:00 local is worse than no label at all.

import type { Job, JobAction, JobTrigger } from '@patch/wire/jobs';
import { ensureChatId } from '@patch/wire/jobs';
import {
  cronZoneLabel,
  describeCron as cronPhrase,
  describeRecurrence as recurrencePhrase,
  runtimeTimeZone,
} from '@patch/wire';
import { parseDateRangeFromFilter } from './jobDateRangeFilter.js';

/**
 * The chat a job links to. An unkeyed `ensure` owns one stable chat; `message`
 * targets a fixed chat; `spawn` makes a fresh chat each fire, so it falls back
 * to the most-recent run's chatId. null → nothing to link yet (a spawn never
 * fired). Shared by the Jobs list row and the job editor's runs summary.
 *
 * A KEYED `ensure` owns one chat per subject, so the job has no single chat to
 * link to — it reads like `spawn` here and links to the latest run's chat.
 */
export function jobChatId(job: Job, latestRunChatId: string | undefined): string | null {
  if (job.action.type === 'continue' && job.action.key === undefined) return ensureChatId(job.id);
  if (job.action.type === 'message') return job.action.chatId;
  return latestRunChatId ?? null;
}

// Natural-language label for a cron expression's fields, zone-agnostic.
//
// The phrasing itself lives in `@patch/wire`'s `describeCron` — ONE describer,
// shared with the web job editor and both mobile surfaces. There used to be
// three of them and they had drifted: this one only understood a fixed minute
// and hour, so 5 of the 16 distinct crons in Tom's live fleet (the 5-minute
// tick, the every-4-hours deploy sweep, the 9am-10pm coach tick, the 7am-10pm
// half-hourly watcher, the four-times-a-day catchup) rendered as raw cron.
//
// The list's own contribution is the FALLBACK: wire returns '' rather than
// guess at a shape it cannot phrase, and a list cell wants a clearly-tagged
// raw expression there, not a blank.
export function describeCron(expression: string): string {
  return cronPhrase(expression) || `cron · ${expression}`;
}

// Same FALLBACK contract as `describeCron` above, for a recurrence trigger's
// RRULE: wire's `describeRecurrence` returns '' rather than guess at a shape
// it cannot phrase exactly, and a list cell wants a clearly-tagged raw RRULE
// there, not a blank.
export function describeRecurrenceRule(rrule: string): string {
  return recurrencePhrase(rrule) || `recurrence · ${rrule}`;
}

/**
 * Natural-language label for any trigger.
 *
 * `viewerTimeZone` is the zone the reader is in; it defaults to this runtime's
 * and is injectable so tests don't depend on the box's `$TZ`. A cron label
 * gains a ` · <zone>` suffix only when the job's effective zone differs
 * from it — see `cronZoneLabel`. No suffix is the common case, so an ordinary
 * list stays as terse as it was.
 */
export function describeTrigger(trigger: JobTrigger, viewerTimeZone?: string): string {
  switch (trigger.type) {
    case 'cron': {
      const zone = cronZoneLabel(trigger.timezone, viewerTimeZone ?? runtimeTimeZone());
      const label = describeCron(trigger.expression);
      return zone === null ? label : `${label} · ${zone}`;
    }
    case 'webhook': {
      const scheme = trigger.scheme === 'none' ? 'unsigned' : trigger.scheme;
      return `${scheme} webhook`;
    }
    case 'todoist':
      return trigger.filter ? `Todoist task ${trigger.filter}` : 'Todoist task tagged @claude';
    case 'recurrence': {
      const zone = cronZoneLabel(trigger.timezone, viewerTimeZone ?? runtimeTimeZone());
      const label = describeRecurrenceRule(trigger.rrule);
      return zone === null ? label : `${label} · ${zone}`;
    }
  }
}

/** The action's two-axis verb, e.g. "spawn · skill" or "message · prompt". */
export function actionVerb(action: JobAction): string {
  // A `script` action has neither skill nor prompt — it runs a command, so the
  // second axis is the command itself, named here as `command`.
  if (action.type === 'script') return 'script · command';
  const what = action.skill ? 'skill' : 'prompt';
  return `${action.type} · ${what}`;
}

/**
 * The action's target: skill name, quoted prompt, folder, or chat id.
 *
 * `spawn`/`continue` are folder-addressed — the fire is dispatched to that
 * folder regardless of whether it runs a skill or a prompt — so the folder
 * rides alongside the skill/prompt rather than being replaced by it (spec/14
 * § Jobs view: "a folder-addressed target reads as its host name and folder
 * together"). Without this, a job's folder was never on the row at all once
 * it had a skill, and — since the Jobs search matches only what the row shows
 * (by design, so a result is always visibly a result) — searching for the
 * folder a skill runs in found nothing (`actionTarget`).
 *
 * `hostName` is the caller's job: this function only sees the action, not the
 * live host list, so the caller resolves `action.daemonId` against presence
 * state (the `JobEditorRoute` `hostNames` pattern) and passes the label in.
 * Omitted, the target reads exactly as before — folder alone, no host — so a
 * caller with no host list yet degrades gracefully rather than showing a raw
 * daemonId.
 */
export function actionTarget(action: JobAction, hostName?: string): string {
  if (action.type === 'script') {
    // `command` is the script itself, not a path to one (@patch/wire
    // `ScriptAction`), so a real gate is dozens of lines beginning with a
    // shebang and a paragraph of comment. Clipping THAT to 48 characters
    // labelled every gate in the list `"#!/usr/bin/env bash # The 15-minute g…"`
    // — identical across jobs and saying nothing. Name the first line that is
    // actually code instead, and say how long the thing is.
    const lines = action.command.split('\n');
    const first = lines.find((l) => {
      const t = l.trim();
      return t.length > 0 && !t.startsWith('#');
    });
    const head = (first ?? lines[0] ?? '').trim();
    const clipped = head.length > 48 ? `${head.slice(0, 47)}…` : head;
    // A one-liner needs no line count; it is already all of it on screen.
    return lines.length > 1 ? `"${clipped}" · ${lines.length} lines` : `"${clipped}"`;
  }
  const folderAddressed = action.type === 'spawn' || action.type === 'continue';
  if (action.skill) {
    if (!folderAddressed) return action.skill;
    const folder = hostName ? `${hostName} · ${action.folder}` : action.folder;
    return `${action.skill} · ${folder}`;
  }
  if (action.prompt) {
    const p = action.prompt.trim();
    const clipped = p.length > 48 ? `${p.slice(0, 47)}…` : p;
    const quoted = `"${clipped}"`;
    if (!folderAddressed) return quoted;
    const folder = hostName ? `${hostName} · ${action.folder}` : action.folder;
    return `${quoted} · ${folder}`;
  }
  // spawn + ensure carry a folder; message carries a chatId.
  if (action.type === 'message') return action.chatId;
  return hostName ? `${hostName} · ${action.folder}` : action.folder;
}

/** Combined action label for compact rows. */
export function describeAction(action: JobAction): string {
  return `${actionVerb(action)} ${actionTarget(action)}`;
}

/**
 * The date range a job's `filter` carries, phrased for the list (spec/08 §
 * Filter, spec/14 § Jobs view) — "from 1 May 2027", "until 1 Sep 2027", or
 * "1 May 2027 – 1 Sep 2027" for both. Null when the filter sets no `now`
 * bound, or isn't SHAPED as one (see `parseDateRangeFromFilter`) — a job with
 * an ordinary payload filter, or one that predates this feature, reads
 * exactly as it always did.
 */
function describeDateRange(filter: string | null): string | null {
  const { start, stop } = parseDateRangeFromFilter(filter);
  if (!start && !stop) return null;
  const fmt = (iso: string): string =>
    new Date(iso).toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  if (start && stop) return `${fmt(start)} – ${fmt(stop)}`;
  return start ? `from ${fmt(start)}` : `until ${fmt(stop as string)}`;
}

export function jobTriggerLabel(job: Job, viewerTimeZone?: string): string {
  const base = describeTrigger(job.trigger, viewerTimeZone);
  const range = describeDateRange(job.filter);
  return range ? `${base} · ${range}` : base;
}
