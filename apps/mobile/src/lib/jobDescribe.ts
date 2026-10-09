// Human-readable renderers for a job's trigger and action on the Jobs tab
// (spec/15 § Jobs screen), matching packages/web/src/lib/jobDescribe.ts.
//
// Deliberately loosely-typed (structural, not the strict `@patch/wire/jobs`
// union) — the Jobs tab has always parsed job JSON tolerantly (see
// `normalise()` in `app/(tabs)/jobs.tsx`) rather than rejecting a shape a
// server or an older/newer host sends, and these renderers are called on
// exactly that loosely-parsed data.
//
// One thing NOT ported from web's jobDescribe.ts: the date-range annotation
// on a trigger label (`describeDateRange`, spec/08 § Filter's `now` bounds).
// That reads the filter with `react-querybuilder`'s JSONata parser, a
// web-only dependency — pulling it into the mobile bundle for one label
// suffix isn't worth the weight. A job with a date-bounded filter still shows
// its ordinary trigger label here; the range itself is only visible from the
// web Jobs page.

import { ensureChatId } from '@patch/wire/jobs';
import { runtimeTimeZone } from '@patch/wire';
import { cronRowSubtitle, recurrenceRowSubtitle } from './jobRow';

export interface DescribableTrigger {
  type?: string;
  expression?: string;
  timezone?: string;
  rrule?: string;
  scheme?: string;
  filter?: string;
}

/**
 * Natural-language label for any trigger shape the Jobs tab might see. Falls
 * back to the raw trigger type (or the literal `'trigger'`) for a shape this
 * can't phrase — a job with no trigger at all, or one of a kind this build
 * doesn't know — same tolerant fallback the Jobs tab has always used.
 */
export function triggerLabel(
  trigger: DescribableTrigger | undefined,
  viewerTimeZone?: string,
): string {
  const zone = viewerTimeZone ?? runtimeTimeZone();
  switch (trigger?.type) {
    case 'cron':
      return trigger.expression
        ? cronRowSubtitle(trigger.expression, trigger.timezone, zone)
        : 'cron';
    case 'recurrence':
      return trigger.rrule
        ? recurrenceRowSubtitle(trigger.rrule, trigger.timezone ?? 'UTC', zone)
        : 'recurrence';
    case 'webhook': {
      const scheme = trigger.scheme === 'none' || !trigger.scheme ? 'unsigned' : trigger.scheme;
      return `${scheme} webhook`;
    }
    case 'todoist':
      return trigger.filter ? `Todoist task ${trigger.filter}` : 'Todoist task tagged @claude';
    default:
      return trigger?.type ?? 'trigger';
  }
}

export interface DescribableAction {
  type?: string;
  skill?: string;
  prompt?: string;
  folder?: string;
  chatId?: string;
  command?: string;
}

/** The action's two-axis verb, e.g. "spawn · skill" or "message · prompt". */
export function actionVerb(action: DescribableAction): string {
  // A `script` action has neither skill nor prompt — it runs a command, so the
  // second axis is the command itself, named here as `command`.
  if (action.type === 'script') return 'script · command';
  const what = action.skill ? 'skill' : 'prompt';
  return `${action.type ?? 'action'} · ${what}`;
}

/**
 * The action's target: skill name, quoted prompt, folder, or chat id.
 * `hostName` is resolved by the caller against live presence state (the
 * mobile Jobs tab's own `hostNames` map, mirroring `JobsRoute.tsx`'s).
 */
export function actionTarget(action: DescribableAction, hostName?: string): string {
  if (action.type === 'script') {
    const lines = (action.command ?? '').split('\n');
    const first = lines.find((l) => {
      const t = l.trim();
      return t.length > 0 && !t.startsWith('#');
    });
    const head = (first ?? lines[0] ?? '').trim();
    const clipped = head.length > 48 ? `${head.slice(0, 47)}…` : head;
    return lines.length > 1 ? `"${clipped}" · ${lines.length} lines` : `"${clipped}"`;
  }
  const folderAddressed = action.type === 'spawn' || action.type === 'continue';
  if (action.skill) {
    if (!folderAddressed) return action.skill;
    const folder = hostName ? `${hostName} · ${action.folder ?? ''}` : (action.folder ?? '');
    return `${action.skill} · ${folder}`;
  }
  if (action.prompt) {
    const p = action.prompt.trim();
    const clipped = p.length > 48 ? `${p.slice(0, 47)}…` : p;
    const quoted = `"${clipped}"`;
    if (!folderAddressed) return quoted;
    const folder = hostName ? `${hostName} · ${action.folder ?? ''}` : (action.folder ?? '');
    return `${quoted} · ${folder}`;
  }
  if (action.type === 'message') return action.chatId ?? '';
  return hostName ? `${hostName} · ${action.folder ?? ''}` : (action.folder ?? '');
}

/**
 * The chat a job links to (spec/14 § Jobs view). An unkeyed `ensure` owns one
 * stable chat; `message` targets a fixed chat; `spawn` makes a fresh chat
 * each fire, so it falls back to the most-recent run's chatId. null →
 * nothing to link yet (a spawn never fired).
 */
export function jobChatId(
  job: { id: string; actionType?: string; ensureKey?: string; messageChatId?: string },
  latestRunChatId: string | undefined,
): string | null {
  if (job.actionType === 'continue' && job.ensureKey === undefined) return ensureChatId(job.id);
  if (job.actionType === 'message') return job.messageChatId ?? null;
  return latestRunChatId ?? null;
}

/** "N queued" — nothing when there's no backlog (spec/08 § Concurrency). */
export function queuedLabel(queued: number | undefined): string | null {
  return queued && queued > 0 ? `${queued} queued` : null;
}
