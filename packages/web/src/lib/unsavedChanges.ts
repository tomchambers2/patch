// unsavedChanges — the two decisions a form route makes about work in progress
// (spec/14 § Jobs view — Unsaved changes).
//
// Both are pure and live here rather than inside the route so they can be
// tested without mounting a form: "is what is on screen different from what was
// last loaded or saved?" and "given that, does leaving need confirming?".

/**
 * The confirmation shown when leaving a form with unsaved edits. One object so
 * the modal, the spec and the tests all quote the same words.
 *
 * `Discard changes` is the destructive choice, so it is the one the button says
 * — never a bare "OK", which does not name what is about to be thrown away.
 */
export const UNSAVED_CONFIRM = {
  title: 'Unsaved changes',
  message: 'This job has edits you have not saved. Leaving this page discards them.',
  confirmLabel: 'Discard changes',
  cancelLabel: 'Keep editing',
} as const;

/** The badge drawn in the route header while the form differs from what is saved. */
export const UNSAVED_BADGE_LABEL = 'Unsaved changes';

/**
 * Whether `current` differs from `baseline`, comparing field by field.
 *
 * The baseline is what the server last gave us (or what a save last wrote), so
 * a freshly loaded form is clean and only the user's own typing makes it dirty.
 *
 * NO FALLBACK: a non-primitive, non-array field would be compared by
 * identity, which reports "dirty" for every re-render that rebuilt the
 * object — a form that prompts on the way out of an untouched page. Rather
 * than guess at a deep compare, this throws, so adding nested form state is
 * a loud failure at the first test that renders it instead of a modal nobody
 * can explain.
 *
 * The ONE deep compare this DOES do — a primitive array (e.g. the recurrence
 * builder's `recurrenceWeekdays`/`recurrenceMonths`, spec/08 § Recurrence) —
 * is order-independent: both are a SET the user is picking chips from, not a
 * sequence, so `[SU, MO]` and `[MO, SU]` are the same edit, not two different
 * ones. Extend THIS, deliberately, rather than the generic object fallback
 * the comment above refuses.
 */
export function isDirty<T extends object>(current: T, baseline: T): boolean {
  if (current === baseline) return false;
  const keys = new Set([...Object.keys(current), ...Object.keys(baseline)]);
  let differs = false;
  for (const key of keys) {
    const a = (current as Record<string, unknown>)[key];
    const b = (baseline as Record<string, unknown>)[key];
    if (isComparablePrimitiveArray(a) && isComparablePrimitiveArray(b)) {
      if (!primitiveArraysEqual(a, b)) differs = true;
      continue;
    }
    assertComparable(key, a);
    assertComparable(key, b);
    if (a !== b) differs = true;
  }
  return differs;
}

function isComparablePrimitiveArray(value: unknown): value is Array<string | number | boolean> {
  return (
    Array.isArray(value) &&
    value.every((v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
  );
}

function primitiveArraysEqual(
  a: ReadonlyArray<string | number | boolean>,
  b: ReadonlyArray<string | number | boolean>,
): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((v, i) => v === sortedB[i]);
}

function assertComparable(key: string, value: unknown): void {
  if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
    throw new Error(
      `isDirty: field "${key}" is not a primitive (and not a primitive array), so it ` +
        'cannot be compared by value. Extend isDirty with a deep compare before adding ' +
        'nested form state.',
    );
  }
}

/**
 * Whether navigating away right now must ask first.
 *
 * `dirty` alone is not the answer. While a create/patch is in flight the ONLY
 * navigation that happens is the mutation's own redirect on success, and the
 * form is still dirty against its baseline at that moment — prompting there
 * would ask the user to confirm discarding the edits they just saved.
 */
export function shouldPromptOnLeave(input: { dirty: boolean; saving: boolean }): boolean {
  return input.dirty && !input.saving;
}
