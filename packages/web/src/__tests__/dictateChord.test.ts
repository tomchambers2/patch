import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_DICTATE_CHORD,
  chordFromEvent,
  chordGlyphs,
  loadDictateChord,
  matchesChord,
  saveDictateChord,
} from '../lib/dictateChord.js';

const key = (init: KeyboardEventInit): KeyboardEvent => new KeyboardEvent('keydown', init);

describe('dictateChord', () => {
  beforeEach(() => localStorage.clear());

  it('is ⌘⇧D until one is saved, then the saved one', () => {
    expect(loadDictateChord()).toEqual(DEFAULT_DICTATE_CHORD);
    expect(chordGlyphs(DEFAULT_DICTATE_CHORD)).toBe('⌘⇧D');
    saveDictateChord({ alt: true, shift: false, code: 'Semicolon' });
    expect(loadDictateChord()).toEqual({ alt: true, shift: false, code: 'Semicolon' });
  });

  it('a stored value that is not a chord is an error, not a quiet default', () => {
    localStorage.setItem('patch.voice.dictateChord', '{"code":1}');
    expect(() => loadDictateChord()).toThrow(/not a chord/);
  });

  it('names keys the way they are printed', () => {
    expect(chordGlyphs({ alt: false, shift: false, code: 'Digit5' })).toBe('⌘5');
    expect(chordGlyphs({ alt: true, shift: true, code: 'Semicolon' })).toBe('⌘⌥⇧;');
    expect(chordGlyphs({ alt: false, shift: false, code: 'F5' })).toBe('⌘F5');
  });

  it('reads a chord off a keydown only when ⌘ or Ctrl is held with a real key', () => {
    expect(chordFromEvent(key({ key: 'd', code: 'KeyD' }))).toBeNull();
    expect(chordFromEvent(key({ key: 'Shift', code: 'ShiftLeft', metaKey: true }))).toBeNull();
    expect(chordFromEvent(key({ key: 'D', code: 'KeyD', ctrlKey: true, shiftKey: true }))).toEqual(
      DEFAULT_DICTATE_CHORD,
    );
  });

  it('matches on the physical key and the exact modifiers', () => {
    const c = DEFAULT_DICTATE_CHORD;
    expect(matchesChord(key({ key: 'D', code: 'KeyD', metaKey: true, shiftKey: true }), c)).toBe(
      true,
    );
    expect(matchesChord(key({ key: 'D', code: 'KeyD', ctrlKey: true, shiftKey: true }), c)).toBe(
      true,
    );
    expect(matchesChord(key({ key: 'd', code: 'KeyD', metaKey: true }), c)).toBe(false);
    expect(
      matchesChord(key({ key: 'Î', code: 'KeyD', metaKey: true, shiftKey: true, altKey: true }), c),
    ).toBe(false);
    expect(matchesChord(key({ key: 'D', code: 'KeyD', shiftKey: true }), c)).toBe(false);
  });
});
