// What a job row's schedule subtitle says (spec/15 § Settings tab — Jobs).
//
// Split out of the two job-list screens (`app/(tabs)/jobs.tsx` and
// `src/components/JobList.tsx`, which are duplicates of one another) so the
// rule lives in one place, and kept OUT of `naturalCron.ts` — that file is a
// verbatim port of the web copy and must stay diffable against it.
//
// A cron expression is evaluated in its trigger's own IANA zone, and an absent
// zone means UTC (spec/08 § Cron). A row that renders only the cron fields
// therefore reads "9am" for a job that fires at 10:00 local — the zone has to
// be named whenever it is not the reader's own. `cronZoneLabel` decides that;
// when it says nothing, the subtitle is exactly what it always was.

import { cronZoneLabel, describeRecurrence, runtimeTimeZone } from '@patch/wire';
import { describeCron } from './naturalCron';

/**
 * The subtitle for a cron job row: the natural-language schedule (falling back
 * to the raw expression when `describeCron` can't phrase it), qualified with
 * the zone it runs in when that differs from `viewerTimeZone` (this runtime's
 * by default — injectable so tests don't depend on the device's zone).
 */
export function cronRowSubtitle(
  expression: string,
  timezone: string | undefined,
  viewerTimeZone?: string,
): string {
  const base = describeCron(expression) || expression;
  const zone = cronZoneLabel(timezone, viewerTimeZone ?? runtimeTimeZone());
  return zone === null ? base : `${base} · ${zone}`;
}

/**
 * The subtitle for a recurrence job row — same contract as `cronRowSubtitle`,
 * for an RRULE instead of a cron expression. `timezone` is required on a
 * `RecurrenceTrigger` (spec/08 § Recurrence), unlike cron's optional one, but
 * `cronZoneLabel` takes a plain string either way.
 */
export function recurrenceRowSubtitle(
  rrule: string,
  timezone: string,
  viewerTimeZone?: string,
): string {
  const base = describeRecurrence(rrule) || rrule;
  const zone = cronZoneLabel(timezone, viewerTimeZone ?? runtimeTimeZone());
  return zone === null ? base : `${base} · ${zone}`;
}
