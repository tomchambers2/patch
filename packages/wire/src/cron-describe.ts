// The ONE natural-language renderer for a cron expression (spec/08 § Cron).
//
// Every surface that shows a cron schedule reads it through here: the web Jobs
// list and job-created card (`packages/web/src/lib/jobDescribe.ts`), the web
// job editor's live preview (`packages/web/src/lib/naturalCron.ts`) and the
// mobile job list + editor (`apps/mobile/src/lib/naturalCron.ts`,
// `apps/mobile/src/lib/jobRow.ts`). There used to be three separate
// implementations of this, which drifted: the list only understood a fixed
// minute + hour and rendered nearly half of Tom's real jobs as raw cron, and
// the two editors disagreed with it on how to say a clock time.
//
// NO FALLBACK, and no guessing: a shape this cannot phrase EXACTLY returns ''
// and the caller shows the raw expression instead. A schedule label that is
// nearly right is worse than one that admits it doesn't know — "every 4 hours"
// on a job that only runs four times between 07:00 and 20:00 is a lie about
// when it fires.
//
// Pure TS, zero deps (the wire package's rule) — it reads the cron FIELDS, it
// does not evaluate them. `cron-tz.ts` next door owns zone handling; a label
// here is deliberately zone-agnostic and gets its ` · <zone>` suffix from
// `cronZoneLabel`.

const DOW_LABEL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// --- clock formatting ------------------------------------------------------
//
// One convention everywhere: on the hour reads "9am", with minutes reads
// "8:57am". (The two old describers disagreed — "9am" vs "9:00am".) Midnight
// and noon keep their 12-hour clock form here and are only named as words
// inside a window phrase, where "between midnight and noon" reads far better
// than "between 12am and 12pm".

function hour12(h: number): number {
  return ((h + 11) % 12) + 1;
}

function meridiem(h: number): string {
  return h < 12 ? 'am' : 'pm';
}

/** A clock time from numeric hour + minute: "9am", "8:57am", "12pm". */
function clock(h: number, m: number): string {
  if (m === 0) return `${hour12(h)}${meridiem(h)}`;
  return `${hour12(h)}:${String(m).padStart(2, '0')}${meridiem(h)}`;
}

/** A window boundary hour: "9am", "5pm", "midnight", "noon". */
function windowHour(h: number): string {
  if (h === 0) return 'midnight';
  if (h === 12) return 'noon';
  return `${hour12(h)}${meridiem(h)}`;
}

/** "the 1st", "the 22nd" — the day-of-month ordinal suffix. */
function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return s[(v - 20) % 10] ?? s[v] ?? s[0]!;
}

/** "a, b and c" — used for an explicit list of fire times. */
function listPhrase(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]!}`;
}

// --- field parsing ---------------------------------------------------------

type Dow =
  | { kind: 'any' }
  | { kind: 'weekdays' }
  | { kind: 'weekends' }
  | { kind: 'days'; days: number[] };

/**
 * Day-of-week field → a describable shape, or null when it is out of range or
 * a form we refuse to phrase (an arbitrary range like `2-4`).
 *
 * Cron accepts 7 as well as 0 for Sunday, so 7 normalises; 8 is out of range
 * and must NOT be silently dropped from the phrase — an earlier describer did
 * exactly that and rendered `*​/5 * * * 8` as a confident "every 5 minutes".
 */
function parseDow(field: string): Dow | null {
  if (field === '*') return { kind: 'any' };
  if (field === '1-5') return { kind: 'weekdays' };
  if (field === '0,6' || field === '6,0') return { kind: 'weekends' };
  if (!/^\d+(?:,\d+)*$/.test(field)) return null;
  const days: number[] = [];
  for (const part of field.split(',')) {
    const n = Number(part);
    if (n > 7) return null;
    const norm = n === 7 ? 0 : n;
    if (!days.includes(norm)) days.push(norm);
  }
  return { kind: 'days', days };
}

/** "Mondays" for one day, "Monday, Wednesday, Friday" for several. */
function dayNames(days: readonly number[]): string {
  if (days.length === 1) return `${DOW_LABEL[days[0]!]!}s`;
  return days.map((d) => DOW_LABEL[d]!).join(', ');
}

/** Leading day phrase for a fixed time of day: "weekdays at 8am". */
function dayPrefix(dow: Dow): string {
  switch (dow.kind) {
    case 'any':
      return 'every day';
    case 'weekdays':
      return 'weekdays';
    case 'weekends':
      return 'weekends';
    case 'days':
      return dayNames(dow.days);
  }
}

/** Trailing day phrase for a repeating shape: "every 5 minutes on weekdays". */
function daySuffix(dow: Dow): string {
  switch (dow.kind) {
    case 'any':
      return '';
    case 'weekdays':
      return 'on weekdays';
    case 'weekends':
      return 'on weekends';
    case 'days':
      return `on ${dayNames(dow.days)}`;
  }
}

type Minute = { kind: 'every' } | { kind: 'step'; n: number } | { kind: 'fixed'; m: number };

/**
 * Minute field → a describable shape, or null.
 *
 * An evenly-spaced list anchored at 0 that covers the whole hour IS a step:
 * `0,30` and `*​/30` fire at exactly the same instants, so they must read the
 * same. A list that doesn't (e.g. `0,10,45`) has no honest short phrase.
 */
function parseMinute(field: string): Minute | null {
  if (field === '*') return { kind: 'every' };
  const step = field.match(/^\*\/(\d+)$/);
  if (step) {
    const n = Number(step[1]);
    return n >= 1 && n <= 59 ? { kind: 'step', n } : null;
  }
  if (/^\d+$/.test(field)) {
    const m = Number(field);
    return m <= 59 ? { kind: 'fixed', m } : null;
  }
  if (/^\d+(?:,\d+)+$/.test(field)) {
    const values = field.split(',').map(Number);
    if (values.some((v) => v > 59)) return null;
    if (values[0] !== 0) return null;
    const gap = values[1]! - values[0]!;
    if (gap <= 0) return null;
    for (let i = 1; i < values.length; i++) {
      if (values[i]! - values[i - 1]! !== gap) return null;
    }
    if (gap * values.length !== 60) return null;
    return { kind: 'step', n: gap };
  }
  return null;
}

type Hour =
  | { kind: 'all' }
  | { kind: 'step'; n: number }
  | { kind: 'window'; from: number; to: number; step: number | null }
  | { kind: 'fixed'; h: number }
  | { kind: 'list'; hours: number[] };

/** Hour field → a describable shape, or null. */
function parseHour(field: string): Hour | null {
  if (field === '*') return { kind: 'all' };
  const step = field.match(/^\*\/(\d+)$/);
  if (step) {
    const n = Number(step[1]);
    return n >= 1 && n <= 23 ? { kind: 'step', n } : null;
  }
  const window = field.match(/^(\d+)-(\d+)(?:\/(\d+))?$/);
  if (window) {
    const from = Number(window[1]);
    const to = Number(window[2]);
    const s = window[3] === undefined ? null : Number(window[3]);
    if (from > 23 || to > 23 || from >= to) return null;
    if (s !== null && (s < 1 || s > 23)) return null;
    return { kind: 'window', from, to, step: s };
  }
  if (/^\d+$/.test(field)) {
    const h = Number(field);
    return h <= 23 ? { kind: 'fixed', h } : null;
  }
  if (/^\d+(?:,\d+)+$/.test(field)) {
    const hours = field.split(',').map(Number);
    if (hours.some((h) => h > 23)) return null;
    return { kind: 'list', hours };
  }
  return null;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// --- the describer ---------------------------------------------------------

/**
 * Render a standard 5-field cron expression (`min hour dom mon dow`) as a
 * natural-language phrase, or '' when its shape cannot be phrased exactly.
 *
 * Callers decide what '' means for them — the Jobs list shows
 * `cron · <expression>`, the editors show the bare expression — but nobody
 * gets a guess.
 */
export function describeCron(expression: string): string {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return '';
  const [minField, hourField, domField, monthField, dowField] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];

  // A month restriction ("only in June") has no short phrase and is vanishingly
  // rare; refuse rather than drop it from the label.
  if (monthField !== '*') return '';

  const dow = parseDow(dowField);
  if (dow === null) return '';
  const minute = parseMinute(minField);
  if (minute === null) return '';
  const hour = parseHour(hourField);
  if (hour === null) return '';

  // Day-of-month. Cron ORs dom and dow when both are restricted, which no short
  // phrase expresses, so only one of the two may be set.
  let dom: number | null = null;
  if (domField !== '*') {
    if (!/^\d+$/.test(domField)) return '';
    const d = Number(domField);
    if (d < 1 || d > 31) return '';
    if (dow.kind !== 'any') return '';
    dom = d;
  }

  // A fixed time of day — the most common shape by far.
  if (minute.kind === 'fixed' && hour.kind === 'fixed') {
    const time = clock(hour.h, minute.m);
    if (dom !== null) return `the ${dom}${ordinal(dom)} at ${time}`;
    return `${dayPrefix(dow)} at ${time}`;
  }

  // Everything below repeats within a day, which a specific day-of-month
  // cannot be folded into without inventing a rule.
  if (dom !== null) return '';

  const suffix = daySuffix(dow);
  const join = (base: string): string => (suffix === '' ? base : `${base} ${suffix}`);

  // A fixed minute at a list of hours. NAME the times: `17 7,11,15,19 * * *`
  // repeats every 4 hours but only across part of the day, so "every 4 hours"
  // would misreport when it fires.
  if (minute.kind === 'fixed' && hour.kind === 'list') {
    return join(`at ${listPhrase(hour.hours.map((h) => clock(h, minute.m)))}`);
  }

  // Once an hour, on the hour.
  if (minute.kind === 'fixed' && minute.m === 0) {
    if (hour.kind === 'all') return join('every hour');
    if (hour.kind === 'step') return join(`every ${plural(hour.n, 'hour')}`);
    if (hour.kind === 'window') {
      const freq = hour.step === null ? 'every hour' : `every ${plural(hour.step, 'hour')}`;
      return join(`${freq} between ${windowHour(hour.from)} and ${windowHour(hour.to)}`);
    }
    return '';
  }

  // Sub-hour intervals, optionally confined to an hour window.
  if (minute.kind === 'every' || minute.kind === 'step') {
    const freq = minute.kind === 'every' ? 'every minute' : `every ${plural(minute.n, 'minute')}`;
    if (hour.kind === 'all') return join(freq);
    if (hour.kind === 'window' && hour.step === null) {
      return join(`${freq} between ${windowHour(hour.from)} and ${windowHour(hour.to)}`);
    }
    // A sub-hour interval crossed with a stepped, listed/single hour (e.g.
    // `*/5 9-17/2`) fires in bursts; there is no one-line phrase for it.
    return '';
  }

  return '';
}
