// Cron expression + IANA timezone helpers (spec/08 § Cron).
//
// A cron expression is stored EXACTLY AS AUTHORED and evaluated in the zone
// named by `CronTrigger.timezone` (spec/08 § Cron). Absent → UTC. Nothing
// rewrites the expression: node-cron is given the zone and handles DST, so
// `0 9 * * *` in `Europe/London` is 09:00 local all year round.
//
// There USED to be a `cronLocalToUtc()` here that rewrote a local expression
// into UTC at the input boundary (CLI `jobs create`). It was removed: an
// offset baked in at creation time is only right until the next DST
// transition, after which a 9am job silently fires at 8am or 10am. That is
// exactly the bug this module's replacement fixes, so do not reintroduce a
// conversion — carry the zone instead.
//
// Pure TS — uses the built-in Intl API (no runtime dep, per the wire
// package's zero-dep rule).

/** Minutes east of UTC for `tz` at instant `atMs` (e.g. Europe/London BST → 60). */
export function tzOffsetMinutes(tz: string, atMs: number): number {
  // Intl gives us the wall-clock the zone shows for this instant; the delta
  // between that wall-clock (read back as if UTC) and the real instant is the
  // offset. Throws (caught by caller) if `tz` is not a valid IANA zone.
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(new Date(atMs));
  const get = (t: string): number => {
    const p = parts.find((x) => x.type === t);
    if (!p) throw new Error(`tzOffsetMinutes: missing ${t} for ${tz}`);
    return Number(p.value);
  };
  let hour = get('hour');
  if (hour === 24) hour = 0; // some ICU builds emit 24 for midnight
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    hour,
    get('minute'),
    get('second'),
  );
  return Math.round((asUtc - atMs) / 60000);
}

/**
 * True iff `tz` is a NAMED IANA zone this runtime's ICU knows (`UTC` and
 * `Etc/UTC` included). `Intl.DateTimeFormat` throwing `RangeError` is the only
 * reliable cross-runtime check — there is no list to compare against on a
 * runtime without `Intl.supportedValuesOf`.
 *
 * A bare offset (`+01:00`) is refused even though ECMA-402 accepts it as a
 * time zone: an offset is frozen, so it cannot track DST, and storing one
 * would silently reintroduce the very bug this field exists to fix. The
 * resolved name is what's tested, so an offset spelled any other way is caught
 * too.
 */
export function isValidTimeZone(tz: string): boolean {
  if (tz.length === 0) return false;
  try {
    const resolved = new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone;
    return !/^[+-]/.test(resolved);
  } catch {
    return false;
  }
}

/**
 * Throw unless `tz` is a valid IANA zone. NO FALLBACK: a job whose zone this
 * machine cannot resolve must be refused at write time, never quietly demoted
 * to UTC — the whole point of the field is that the user's 9am is their 9am.
 */
export function assertValidTimeZone(tz: string): void {
  if (!isValidTimeZone(tz)) {
    throw new Error(`invalid IANA timezone: "${tz}"`);
  }
}

/** Per-field numeric bounds for a standard 5-field cron `min hour dom mon dow`. */
const CRON_FIELD_BOUNDS: ReadonlyArray<{ min: number; max: number }> = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day-of-month
  { min: 1, max: 12 }, // month
  { min: 0, max: 7 }, // day-of-week (0 and 7 = Sunday)
];

/** Validate a single integer is within [min,max]. */
function inBounds(n: number, b: { min: number; max: number }): boolean {
  return Number.isInteger(n) && n >= b.min && n <= b.max;
}

/**
 * Validate one cron field against its bounds. Supports `*`, single values,
 * ranges (`a-b`), lists (`a,b,c`), and steps (`*​/n`, `a-b/n`, `a/n`) — the
 * standard 5-field crontab grammar. Returns true iff well-formed and in range.
 */
function validCronField(field: string, b: { min: number; max: number }): boolean {
  // Unreachable: the only caller (assertValidCron) builds `field` from
  // `expr.trim().split(/\s+/)`, which can never produce an empty string for
  // one of exactly 5 fields (a run of whitespace always collapses to a
  // single separator, never a zero-length token). Defensive guard only,
  // since validCronField's own contract doesn't otherwise forbid "".
  /* v8 ignore next */
  if (field.length === 0) return false;
  // A list is comma-separated terms, each independently valid.
  return field.split(',').every((term) => {
    if (term.length === 0) return false;
    // Optional step suffix `/n`.
    const [rangePart, stepPart, ...rest] = term.split('/');
    if (rest.length > 0) return false; // more than one '/'
    // Unreachable: String.prototype.split always returns at least one
    // element for a non-empty input, so `rangePart` (term.split('/')[0]) is
    // never undefined here (term.length===0 already returned above).
    /* v8 ignore next */
    if (rangePart === undefined) return false;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart) || Number(stepPart) <= 0) return false;
    }
    if (rangePart === '*') return true;
    // Range `a-b` or single value.
    const bounds = rangePart.split('-');
    if (bounds.length === 1) {
      if (!/^\d+$/.test(rangePart)) return false;
      return inBounds(Number(rangePart), b);
    }
    if (bounds.length === 2) {
      const [lo, hi] = bounds;
      // Unreachable: bounds.length === 2 (checked above) guarantees the
      // destructure yields two defined strings.
      /* v8 ignore next */
      if (lo === undefined || hi === undefined) return false;
      if (!/^\d+$/.test(lo) || !/^\d+$/.test(hi)) return false;
      const loN = Number(lo);
      const hiN = Number(hi);
      return inBounds(loN, b) && inBounds(hiN, b) && loN <= hiN;
    }
    return false;
  });
}

/**
 * Validate a standard 5-field cron expression `min hour dom mon dow` purely in
 * TypeScript (the wire package stays zero-dep — it cannot import node-cron).
 * Throws with a message that NAMES the cron field as the problem so callers
 * (e.g. the CLI's `jobs create`) can reject a malformed cron client-side,
 * regardless of $TZ, instead of forwarding it to the server for an opaque
 * `invalid body`. Mirrors the server-side node-cron check in
 * packages/server/src/jobs/validate.ts (5 fields + per-field grammar).
 * NO FALLBACK: a malformed cron is a caller error, surfaced immediately.
 */
export function assertValidCron(expr: string): void {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`invalid cron expression (expected 5 fields, got ${fields.length}): "${expr}"`);
  }
  for (let i = 0; i < 5; i++) {
    if (!validCronField(fields[i]!, CRON_FIELD_BOUNDS[i]!)) {
      throw new Error(`invalid cron expression: bad field ${i + 1} ("${fields[i]}") in "${expr}"`);
    }
  }
}

/**
 * The IANA zone this runtime is in. `UTC` only when the runtime reports no
 * zone at all (an ICU-less environment) — a missing capability, and also
 * exactly what the server does with a trigger carrying no zone.
 */
export function runtimeTimeZone(): string {
  const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return resolved && resolved.length > 0 ? resolved : 'UTC';
}

/**
 * The zone label to append to a cron schedule shown to a viewer, or `null`
 * when there is nothing worth saying.
 *
 * A schedule label like "weekdays at 9am" is a lie the moment the job's zone
 * and the reader's zone disagree — Tom's pre-timezone jobs read "9am" and
 * fired at 10:00 BST. So the effective zone (`jobTimezone ?? 'UTC'`, the
 * server's own default per spec/08 § Cron) is named whenever it differs from
 * the viewer's, and omitted when it matches: a Europe/London job read from
 * London needs no label, and adding one to every row would be noise.
 *
 * Zones are compared by their RESOLVED names so aliases (`Etc/UTC` vs `UTC`)
 * don't produce a label that says nothing. A zone this runtime cannot resolve
 * is labelled rather than swallowed — an unresolvable zone is precisely the
 * case where the reader must not assume it is their own.
 */
export function cronZoneLabel(
  jobTimezone: string | undefined,
  viewerTimeZone: string,
): string | null {
  const jobZone = jobTimezone ?? 'UTC';
  if (jobZone === viewerTimeZone) return null;
  const canonical = (tz: string): string | null => {
    try {
      return new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone;
    } catch {
      return null;
    }
  };
  const a = canonical(jobZone);
  const b = canonical(viewerTimeZone);
  if (a !== null && a === b) return null;
  return jobZone;
}
