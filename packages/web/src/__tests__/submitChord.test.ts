// spec/14 § Keyboard shortcuts — `⌘↵` is the app's commit key, so what counts as
// the commit chord is decided in exactly one place (lib/submitChord.ts). Every
// field that saves goes through this predicate; if it drifts, every surface
// drifts with it, which is the whole reason it exists.

import { describe, it, expect } from 'vitest';
import { isSubmitChord, type SubmitChordEvent } from '../lib/submitChord.js';

function key(over: Partial<SubmitChordEvent> = {}): SubmitChordEvent {
  return {
    key: 'Enter',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...over,
  };
}

describe('isSubmitChord', () => {
  it('is ⌘↵ and Ctrl↵ — both keyboards commit', () => {
    expect(isSubmitChord(key({ metaKey: true }))).toBe(true);
    expect(isSubmitChord(key({ ctrlKey: true }))).toBe(true);
  });

  it('is not bare ↵ — a field that took it could not hold a newline', () => {
    expect(isSubmitChord(key())).toBe(false);
  });

  it('is not ⇧↵, which is the newline key', () => {
    expect(isSubmitChord(key({ metaKey: true, shiftKey: true }))).toBe(false);
    expect(isSubmitChord(key({ ctrlKey: true, shiftKey: true }))).toBe(false);
  });

  it('is not ⌥↵ — ⌥ belongs to other chords, so it is checked not ignored', () => {
    expect(isSubmitChord(key({ metaKey: true, altKey: true }))).toBe(false);
    expect(isSubmitChord(key({ altKey: true }))).toBe(false);
  });

  it('is no other key, however it is modified', () => {
    for (const k of ['s', 'Escape', 'Tab', 'a', 'NumpadEnter']) {
      expect(isSubmitChord(key({ key: k, metaKey: true }))).toBe(false);
    }
  });

  it('never fires mid-IME-composition, in either event shape', () => {
    // React hangs the flag off `nativeEvent`; a DOM listener reads it directly.
    // A predicate that only knew one shape would silently hijack the other.
    expect(isSubmitChord(key({ metaKey: true, nativeEvent: { isComposing: true } }))).toBe(false);
    expect(isSubmitChord(key({ metaKey: true, isComposing: true }))).toBe(false);
    expect(isSubmitChord(key({ metaKey: true, nativeEvent: { isComposing: false } }))).toBe(true);
    expect(isSubmitChord(key({ metaKey: true, isComposing: false }))).toBe(true);
  });
});
