// The ONE natural-language renderer for a `RecurrenceTrigger`'s RRULE
// (spec/08 § Recurrence), mirroring `cron-describe.ts` next door: every
// surface that shows a recurrence schedule — the web job editor's live
// preview, the web Jobs list, the mobile equivalents once they exist — reads
// it through here, so the phrasing has exactly one owner.
//
// NO FALLBACK, and no guessing: a rule this cannot phrase EXACTLY returns ''
// and the caller shows the raw RRULE instead. RRULE can express a great many
// shapes this describer does not attempt to cover (BYMONTHDAY, BYWEEKNO,
// BYYEARDAY, an INTERVAL other than 1, a COUNT/UNTIL bound, more than one
// weekday alongside BYSETPOS, …) — every one of those returns '' rather than
// a phrase that is nearly right. "every 4 weeks" for a rule that actually
// stops after 6 occurrences is a lie about when it fires, the same failure
// mode `describeCron` refuses.
//
// Pure TS, zero deps (the wire package's rule) — this reads the RRULE FIELDS,
// it does not evaluate them. Actually computing occurrences (the `rrule` npm
// package) is a server-only concern (`packages/server/src/jobs/recurrence.ts`).

const MONTH_LABEL = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;
const WEEKDAY_LABEL: Record<string, string> = {
  SU: 'Sunday',
  MO: 'Monday',
  TU: 'Tuesday',
  WE: 'Wednesday',
  TH: 'Thursday',
  FR: 'Friday',
  SA: 'Saturday',
};

const SETPOS_LABEL: Record<string, string> = {
  '1': '1st',
  '2': '2nd',
  '3': '3rd',
  '4': '4th',
  '-1': 'last',
};

// --- clock formatting (mirrors cron-describe.ts's convention exactly: on
// the hour reads "9am", with minutes reads "8:57am") -----------------------

function hour12(h: number): number {
  return ((h + 11) % 12) + 1;
}

function meridiem(h: number): string {
  return h < 12 ? 'am' : 'pm';
}

function clock(h: number, m: number): string {
  if (m === 0) return `${hour12(h)}${meridiem(h)}`;
  return `${hour12(h)}:${String(m).padStart(2, '0')}${meridiem(h)}`;
}

/** "a, b and c" — an explicit list. */
function listPhrase(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]!}`;
}

/**
 * Month numbers (1-12) → a phrase: a contiguous ascending run of 2+ reads as
 * "May through August"; anything else (a gap, a single month, an
 * out-of-order or repeated value) reads as a plain list. Both are exact —
 * neither collapses "May, July" into a range that would silently include
 * June.
 */
function monthPhrase(months: readonly number[]): string {
  const names = months.map((m) => MONTH_LABEL[m - 1]!);
  if (months.length < 2) return listPhrase(names);
  const ascending = months.every((m, i) => i === 0 || m === months[i - 1]! + 1);
  if (ascending) return `${names[0]!} through ${names[names.length - 1]!}`;
  return listPhrase(names);
}

/** Split a bare RRULE value string into its `KEY=value` parts, uppercased keys. */
function parseFields(rrule: string): Map<string, string> | null {
  const out = new Map<string, string>();
  for (const part of rrule.split(';')) {
    if (part.trim() === '') continue;
    const eq = part.indexOf('=');
    if (eq <= 0) return null;
    const key = part.slice(0, eq).trim().toUpperCase();
    const value = part.slice(eq + 1).trim();
    if (value === '') return null;
    if (out.has(key)) return null; // a repeated key has no single meaning
    out.set(key, value);
  }
  return out;
}

/** A comma list of small non-negative integers, or null if any term isn't one. */
function intList(value: string, min: number, max: number): number[] | null {
  const out: number[] = [];
  for (const term of value.split(',')) {
    if (!/^-?\d+$/.test(term)) return null;
    const n = Number(term);
    if (n < min || n > max) return null;
    out.push(n);
  }
  return out;
}

/** A comma list of plain (unprefixed) BYDAY weekday codes, or null. */
function byDayList(value: string): string[] | null {
  const out: string[] = [];
  for (const term of value.split(',')) {
    const code = term.toUpperCase();
    if (!(WEEKDAY_CODES as readonly string[]).includes(code)) return null;
    out.push(code);
  }
  return out;
}

/** The exact narrow shape both `describeRecurrence` and the structured editor UI understand. */
export interface RecurrenceFields {
  freq: 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  /** Weekday codes (`SU`..`SA`). One or more for WEEKLY; exactly one for MONTHLY/YEARLY. */
  days: string[];
  /** `BYSETPOS` — set only for the MONTHLY/YEARLY nth-weekday shape. */
  setPos: number | null;
  /** `BYMONTH` (1-12), or null when unrestricted. Always set for YEARLY. */
  months: number[] | null;
  hour: number;
  minute: number;
}

/**
 * Parse a bare RRULE value string (no `RRULE:` label, no `DTSTART`) into the
 * exact narrow shape this module understands, or null for everything else —
 * a `COUNT`/`UNTIL` bound, an `INTERVAL` other than 1, a non-default `WKST`,
 * `BYMONTHDAY`/`BYWEEKNO`/`BYYEARDAY`, more than one weekday alongside
 * `BYSETPOS`, a bare YEARLY with no `BYMONTH`, malformed or repeated-key
 * RRULE text, and so on.
 *
 * This is the ONE place that decides "is this rule one of the shapes the
 * structured editor UI can represent" — `describeRecurrence` is built
 * directly on top of it (a phrase is just this shape formatted), and the web
 * job editor uses it the same way to decide whether an existing job's RRULE
 * can populate the structured builder or must fall back to the raw-text
 * field. Two callers computing this independently is exactly how the three
 * old cron describers drifted (see `cron-describe.ts`'s header) — this way
 * they cannot.
 */
export function parseRecurrenceFields(rrule: string): RecurrenceFields | null {
  const fields = parseFields(rrule);
  if (fields === null) return null;

  // Bounding a rule (COUNT/UNTIL) changes what "every ..." means — it stops —
  // and this module has no clause for that, so it refuses rather than omit
  // the bound silently.
  if (fields.has('COUNT') || fields.has('UNTIL')) return null;
  // INTERVAL other than 1 ("every OTHER Sunday") needs its own clause too.
  if (fields.has('INTERVAL') && fields.get('INTERVAL') !== '1') return null;
  // A non-default week-start changes which occurrence BYSETPOS picks in edge
  // cases; refuse rather than risk a mis-described boundary.
  if (fields.has('WKST')) return null;
  // Shapes this module does not attempt.
  if (fields.has('BYMONTHDAY') || fields.has('BYWEEKNO') || fields.has('BYYEARDAY')) return null;

  const freq = fields.get('FREQ');
  if (freq !== 'WEEKLY' && freq !== 'MONTHLY' && freq !== 'YEARLY') return null;

  const hourRaw = fields.get('BYHOUR');
  const minuteRaw = fields.get('BYMINUTE');
  if (hourRaw === undefined || minuteRaw === undefined) return null;
  if (fields.has('BYSECOND') && fields.get('BYSECOND') !== '0') return null;
  const hours = intList(hourRaw, 0, 23);
  const minutes = intList(minuteRaw, 0, 59);
  if (hours === null || hours.length !== 1 || minutes === null || minutes.length !== 1) return null;
  const hour = hours[0]!;
  const minute = minutes[0]!;

  const byDayRaw = fields.get('BYDAY');
  if (byDayRaw === undefined) return null;
  const setPosRaw = fields.get('BYSETPOS');
  const byMonthRaw = fields.get('BYMONTH');
  const months = byMonthRaw === undefined ? null : intList(byMonthRaw, 1, 12);
  if (byMonthRaw !== undefined && months === null) return null;

  if (freq === 'WEEKLY') {
    // A plain day-of-week set — no nth-occurrence, no month restriction (a
    // weekly rule that only fires in some months has no clean short phrase).
    if (setPosRaw !== undefined || months !== null) return null;
    const days = byDayList(byDayRaw);
    if (days === null || days.length === 0) return null;
    return { freq, days, setPos: null, months: null, hour, minute };
  }

  // MONTHLY / YEARLY — the nth-weekday pattern (spec/08 § Recurrence's
  // motivating case): needs exactly one weekday and one BYSETPOS — "3rd
  // Sunday or Monday" has no single reading, so more than one day refuses.
  if (setPosRaw === undefined) return null;
  const days = byDayList(byDayRaw);
  if (days === null || days.length !== 1) return null;
  const setPosList = intList(setPosRaw, -1, 4);
  if (setPosList === null || setPosList.length !== 1) return null;
  const setPos = setPosList[0]!;
  if (SETPOS_LABEL[String(setPos)] === undefined) return null;

  if (freq === 'YEARLY') {
    // YEARLY with no BYMONTH ("the 3rd Sunday of the year") has no clean
    // short phrase — refuse rather than guess.
    if (months === null || months.length === 0) return null;
  }
  return { freq, days, setPos, months, hour, minute };
}

/**
 * Render a bare RRULE value string as a natural-language phrase, or '' when
 * its shape cannot be phrased exactly (`parseRecurrenceFields` returns null).
 *
 * Deliberately narrow: it confidently phrases exactly the shapes the
 * structured recurrence-editor UI produces —
 *   - `FREQ=WEEKLY;BYDAY=<days>;BYHOUR=<h>;BYMINUTE=<m>`
 *   - `FREQ=MONTHLY;BYDAY=<day>;BYSETPOS=<pos>;BYHOUR=<h>;BYMINUTE=<m>[;BYMONTH=<months>]`
 *   - `FREQ=YEARLY;BYDAY=<day>;BYSETPOS=<pos>;BYMONTH=<months>;BYHOUR=<h>;BYMINUTE=<m>`
 * — and refuses (returns '') everything the advanced free-text RRULE field
 * can express beyond that, so a caller never shows a confident-sounding
 * sentence for a shape it didn't actually check.
 */
export function describeRecurrence(rrule: string): string {
  const parsed = parseRecurrenceFields(rrule);
  if (parsed === null) return '';
  const time = clock(parsed.hour, parsed.minute);

  if (parsed.freq === 'WEEKLY') {
    const dayNames = parsed.days.map((d) => WEEKDAY_LABEL[d]!);
    const dayPhrase = dayNames.length === 1 ? `${dayNames[0]!}s` : listPhrase(dayNames);
    return `${dayPhrase} at ${time}`;
  }

  // MONTHLY / YEARLY nth-weekday — parseRecurrenceFields guarantees exactly
  // one day and a recognised setPos for both.
  const nth = SETPOS_LABEL[String(parsed.setPos)]!;
  const dayName = WEEKDAY_LABEL[parsed.days[0]!]!;

  if (parsed.freq === 'MONTHLY') {
    const monthClause = parsed.months === null ? 'every month' : monthPhrase(parsed.months);
    return `every ${nth} ${dayName}, ${monthClause} at ${time}`;
  }
  // YEARLY — parseRecurrenceFields guarantees a non-empty `months`.
  return `every year on the ${nth} ${dayName} of ${monthPhrase(parsed.months!)} at ${time}`;
}
