// Unsaved-edit tracking for the job editor (spec/14 § Jobs view — Unsaved
// changes). The two decisions the route delegates to `lib/unsavedChanges.ts`:
// what counts as dirty, and whether leaving has to ask.

import { describe, it, expect } from 'vitest';
import { UNSAVED_CONFIRM, isDirty, shouldPromptOnLeave } from '../lib/unsavedChanges.js';

/** A stand-in for the editor's FormState: flat, primitives only. */
const FORM = {
  name: 'Nightly sweep',
  enabled: true,
  cronExpression: '0 9 * * *',
  spawnPrompt: '',
};

describe('isDirty', () => {
  it('a form identical to its baseline is clean', () => {
    expect(isDirty({ ...FORM }, { ...FORM })).toBe(false);
  });

  it('the very same object is clean without comparing anything', () => {
    expect(isDirty(FORM, FORM)).toBe(false);
  });

  it('one changed field makes it dirty', () => {
    expect(isDirty({ ...FORM, name: 'Nightly sweep!' }, FORM)).toBe(true);
  });

  it('a changed BOOLEAN makes it dirty — a toggle is an edit like any other', () => {
    expect(isDirty({ ...FORM, enabled: false }, FORM)).toBe(true);
  });

  it('typing then undoing back to the saved value is clean again', () => {
    const edited = { ...FORM, name: 'something else' };
    expect(isDirty(edited, FORM)).toBe(true);
    expect(isDirty({ ...edited, name: FORM.name }, FORM)).toBe(false);
  });

  // An absent key and an empty string are different values, so a form that
  // dropped a field IS dirty against a baseline that still carries it. Asserted
  // because the comparison walks the union of both key sets: a one-sided walk
  // would miss a removal entirely.
  it('a field present on one side only counts as a difference', () => {
    const without: Record<string, unknown> = { ...FORM };
    delete without['spawnPrompt'];
    expect(isDirty(without as typeof FORM, FORM)).toBe(true);
    expect(isDirty(FORM, without as typeof FORM)).toBe(true);
  });

  // NO FALLBACK: a nested OBJECT (or function) field compares by identity,
  // which would report a form nobody has touched as dirty on every
  // re-render. It must fail loudly. A primitive ARRAY is the one deliberate
  // exception — see the next block.
  it('throws on a non-primitive, non-array field rather than silently comparing identity', () => {
    const nested = { ...FORM, gate: { command: 'true' } };
    expect(() => isDirty(nested, { ...nested })).toThrow(/not a primitive/);
    const fn = { ...FORM, onSave: () => undefined };
    expect(() => isDirty(fn, { ...fn })).toThrow(/not a primitive/);
    // An array of objects is still outside what the deliberate array
    // exception covers — only arrays of primitives get a deep compare.
    const nestedArray = { ...FORM, gates: [{ command: 'true' }] };
    expect(() => isDirty(nestedArray, { ...nestedArray })).toThrow(/not a primitive/);
  });

  // The recurrence builder's chip-picker fields (recurrenceWeekdays,
  // recurrenceMonths — spec/08 § Recurrence) are arrays of primitives: a SET
  // the user is picking from, not a sequence. These get a real, deliberate
  // deep compare rather than the generic throw above, and it is ORDER-
  // INDEPENDENT — unchecking then rechecking chips in a different order is
  // not a new edit.
  it('compares a primitive array by value, order-independently, instead of throwing', () => {
    const a = { ...FORM, weekdays: ['SU', 'MO'] };
    expect(isDirty(a, { ...a })).toBe(false);
    expect(isDirty({ ...a, weekdays: ['MO', 'SU'] }, a)).toBe(false);
    expect(isDirty({ ...a, weekdays: ['MO'] }, a)).toBe(true);
    expect(isDirty({ ...a, weekdays: ['SU', 'MO', 'TU'] }, a)).toBe(true);
    expect(isDirty({ ...a, weekdays: [] }, { ...a, weekdays: [] })).toBe(false);
  });

  // `null` is a value a field can legitimately hold and compares fine.
  it('treats null as an ordinary value, not as an object', () => {
    const a = { ...FORM, spawnModel: null as string | null };
    expect(isDirty(a, { ...a })).toBe(false);
    expect(isDirty(a, { ...a, spawnModel: 'opus' })).toBe(true);
  });
});

describe('shouldPromptOnLeave', () => {
  it('does not prompt when nothing has been edited', () => {
    expect(shouldPromptOnLeave({ dirty: false, saving: false })).toBe(false);
  });

  it('prompts when there are unsaved edits', () => {
    expect(shouldPromptOnLeave({ dirty: true, saving: false })).toBe(true);
  });

  // The save's own success redirect fires while the form still differs from the
  // baseline it loaded with. Prompting there asks the user to confirm
  // discarding the edits they have just saved.
  it('does not prompt while a save is in flight', () => {
    expect(shouldPromptOnLeave({ dirty: true, saving: true })).toBe(false);
  });
});

describe('the confirmation copy', () => {
  it('names what is discarded rather than saying OK', () => {
    expect(UNSAVED_CONFIRM.confirmLabel).toBe('Discard changes');
    expect(UNSAVED_CONFIRM.cancelLabel).toBe('Keep editing');
  });
});
