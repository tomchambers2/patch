// JSONata filter evaluation. NULL/empty filter → always pass. Bad
// expression → fail-closed (FilterError thrown to caller, which logs +
// skips the run; per spec/08 NO FALLBACKS — never silently treat a bad
// filter as "pass").

import jsonata from 'jsonata';

export class FilterError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'FilterError';
  }
}

/**
 * The root object every trigger type's filter is evaluated against (spec/08
 * § Filter): `payload` for the trigger-specific data, plus a plain `now`
 * field (ISO 8601, this fire's instant) so a filter can express a date-bounded
 * condition — "every Friday, starting 1 May 2027" — as an ordinary field
 * comparison (`now >= "2027-05-01T00:00:00.000Z"`) rather than reaching for a
 * function call like `$now()`.
 *
 * That distinction matters beyond style: `now` as a real field round-trips
 * through a structured filter EDITOR (the web Jobs UI's Starts/Stops widget,
 * built on `react-querybuilder`'s `parseJSONata`/`formatQuery`) because that
 * library's grammar understands `field op value`, not an arbitrary expression
 * on the left — `$now() >= "..."` parses back to an EMPTY rule set (silently
 * unrecognised), and quoting it as a field name (`` `$now()` ``) parses but
 * evaluates to `undefined` (a literal, nonexistent field lookup, not a
 * function call) — both dead ends. A plain `now` field has neither problem.
 *
 * One helper, called from every trigger's ingress (cron, recurrence, webhook,
 * Todoist) so `now` means the same thing — and is spelled the same
 * way — everywhere a filter can see it.
 */
export function filterContext(nowMs: number, data: unknown): { payload: unknown; now: string } {
  return { payload: data, now: new Date(nowMs).toISOString() };
}

export async function evaluateFilter(
  expr: string | null | undefined,
  payload: unknown,
): Promise<boolean> {
  if (expr === null || expr === undefined || expr.trim() === '') return true;
  let compiled;
  try {
    compiled = jsonata(expr);
  } catch (err) {
    throw new FilterError(`failed to parse JSONata: ${(err as Error).message}`, err);
  }
  let result: unknown;
  try {
    result = await compiled.evaluate(payload);
  } catch (err) {
    throw new FilterError(`failed to evaluate JSONata: ${(err as Error).message}`, err);
  }
  return Boolean(result);
}
