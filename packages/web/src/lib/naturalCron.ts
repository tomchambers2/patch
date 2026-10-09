// English → cron for the New-job schedule field. People shouldn't have to know
// cron syntax to say "every weekday at 9am", so `parseNaturalSchedule` turns
// common English phrases into a 5-field cron expression.
//
// The OTHER direction — cron → English, for the live preview — is
// `describeCron`, re-exported here from `@patch/wire`. It used to be a second
// local implementation, and a third lived in `jobDescribe.ts`; they drifted
// (this one said "9:00am" where the Jobs list said "9am", and neither
// understood every shape the other did), so the phrasing now has exactly one
// owner, and every caller's `from './naturalCron.js'` import still works.
//
// NO FALLBACK to a wrong guess: `parseNaturalSchedule` returns null when it
// can't confidently parse, and the form keeps the raw cron field authoritative.

export { describeCron } from '@patch/wire';

const DOW_NAME: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

/** Parse a clock time like `9am`, `9:30am`, `17:00`, `noon`, `midnight`, `9`. */
function parseTime(raw: string): { h: number; m: number } | null {
  const t = raw.trim().toLowerCase();
  if (t === 'noon') return { h: 12, m: 0 };
  if (t === 'midnight') return { h: 0, m: 0 };
  const m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let h = parseInt(m[1]!, 10);
  const min = m[2] ? parseInt(m[2]!, 10) : 0;
  const ap = m[3];
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return { h, m: min };
}

/**
 * A time-of-day window: "between 9am and 5pm", "from 9 to 17", "9am-5pm".
 * Returns the start/end HOURS (cron hour ranges are hour-granular) or null.
 * The end hour is inclusive — "between 9am and 5pm" → hours 9-17.
 */
const TIME_TOKEN = '(\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)?|noon|midnight)';
function parseTimeWindow(text: string): { startH: number; endH: number } | null {
  const re = new RegExp(
    `\\b(?:between|from)\\s+${TIME_TOKEN}\\s+(?:and|to|until|–|—|-)\\s+${TIME_TOKEN}`,
  );
  const m = text.match(re);
  if (!m) return null;
  const start = parseTime(m[1]!);
  const end = parseTime(m[2]!);
  if (!start || !end) return null;
  if (start.h > end.h) return null; // a window that wraps midnight isn't a simple cron range
  return { startH: start.h, endH: end.h };
}

/** Day-of-week field from a phrase fragment, or '*' for every day. */
function parseDow(text: string): string | null {
  if (/\bweekdays?\b/.test(text) || /\bevery weekday\b/.test(text)) return '1-5';
  if (/\bweekends?\b/.test(text)) return '0,6';
  if (/\b(every ?day|daily|day)\b/.test(text)) return '*';
  // Explicit day names, possibly a list ("monday and thursday", "mon, wed").
  const found: number[] = [];
  for (const [name, n] of Object.entries(DOW_NAME)) {
    if (new RegExp(`\\b${name}s?\\b`).test(text) && !found.includes(n)) found.push(n);
  }
  if (found.length > 0) return found.sort((a, b) => a - b).join(',');
  return null;
}

/**
 * Best-effort English → 5-field cron. Returns null when it can't parse with
 * confidence. Supported shapes:
 *   - "every 15 minutes" / "every minute"
 *   - "every 2 hours" / "hourly" / "every hour"
 *   - "every day at 9am" / "daily at 09:00" / "at 9am" / "8am every day"
 *   - "every day at 9am and 10pm" / "at 9am, 1pm and 10pm" (shared minute only)
 *   - "every weekday at 9am" / "weekdays at 8:30"
 *   - "every weekend at 10am"
 *   - "every monday at 8:30" / "mondays at 8" / "monday and thursday at 9am"
 */
export function parseNaturalSchedule(input: string): string | null {
  const text = input.trim().toLowerCase().replace(/\s+/g, ' ');
  if (text === '') return null;

  // An optional time-of-day window ("between 9am and 5pm") and day-of-week
  // ("on weekdays") constrain the interval forms below. The hour field is the
  // window range (or `*`); the day field is the parsed days (or `*`).
  const window = parseTimeWindow(text);
  const hourField = window ? `${window.startH}-${window.endH}` : '*';
  const dowField = parseDow(text) ?? '*';

  // Interval: every N minutes (optionally within a window / on given days).
  const everyMin = text.match(/^every (\d+) ?(?:minutes?|mins?|m)\b/);
  if (everyMin) {
    const n = parseInt(everyMin[1]!, 10);
    if (n >= 1 && n <= 59) return `*/${n} ${hourField} * * ${dowField}`;
  }
  if (/^every minute\b/.test(text)) return `* ${hourField} * * ${dowField}`;

  // Interval: every N hours / hourly (optionally within a window). A windowed
  // hourly step uses cron's range-step form, e.g. `9-17/2`.
  const everyHour = text.match(/^every (\d+) ?(?:hours?|hrs?|h)\b/);
  if (everyHour) {
    const n = parseInt(everyHour[1]!, 10);
    if (n >= 1 && n <= 23) {
      const hf = window ? `${hourField}/${n}` : `*/${n}`;
      return `0 ${hf} * * ${dowField}`;
    }
  }
  if (/^(?:hourly|every hour)\b/.test(text)) return `0 ${hourField} * * ${dowField}`;

  // Time-of-day forms. Pull an explicit "at <time>" (or a list of them —
  // "at 9am and 10pm", "at 9am, 1pm and 10pm") first; else a trailing time.
  // Cron's minute and hour fields are independent, so a list can only be
  // expressed when every time shares one minute; otherwise → null, never a guess.
  let times: { h: number; m: number }[] = [];
  const atMatch = text.match(
    new RegExp(`\\bat (${TIME_TOKEN}(?:\\s*(?:,|&|\\band\\b)\\s*${TIME_TOKEN})*)(?![0-9:])`),
  );
  if (atMatch) {
    const parts = atMatch[1]!.split(/\s*(?:,|&|\band\b)\s*/).filter((p) => p !== '');
    const parsed = parts.map(parseTime);
    if (parsed.some((t) => t === null)) return null;
    times = parsed as { h: number; m: number }[];
    if (times.some((t) => t.m !== times[0]!.m)) return null;
  }
  if (times.length === 0) {
    // A leading time ("8am every day", "17:30 weekdays"): a bare number is
    // too ambiguous here, so it needs am/pm, a colon, or noon/midnight.
    const lead = text.match(
      /^(\d{1,2}:\d{2}\s*(?:am|pm)?|\d{1,2}\s*(?:am|pm)|noon|midnight)(?=\s|$)/,
    );
    const t = lead ? parseTime(lead[1]!) : null;
    if (t) times = [t];
  }
  if (times.length === 0) {
    const tail = text.match(/(\d{1,2}(?::\d{2})?\s*(?:am|pm)|noon|midnight)\s*$/);
    const t = tail ? parseTime(tail[1]!) : null;
    if (t) times = [t];
  }
  const time =
    times.length > 0
      ? { m: times[0]!.m, h: [...new Set(times.map((t) => t.h))].sort((a, b) => a - b).join(',') }
      : null;

  const dow = parseDow(text);

  // A day-of-week phrase (weekday/weekend/named day/daily) → run at the given
  // time, defaulting to midnight only when no time-like text was supplied at
  // all. Digits that failed to parse as a time ("9 every day") → null, never
  // a silent midnight.
  if (dow !== null) {
    if (!time && /\d/.test(text)) return null;
    const t = time ?? { h: '0', m: 0 };
    return `${t.m} ${t.h} * * ${dow}`;
  }
  // Just a time, no day phrase → every day at that time.
  if (time && (atMatch || /\b(every day|daily)\b/.test(text) || /^at /.test(text))) {
    return `${time.m} ${time.h} * * *`;
  }
  return null;
}
