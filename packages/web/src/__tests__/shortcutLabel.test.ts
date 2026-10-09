// spec/14 § Discoverability — a chord is written once, in macOS glyphs, and
// rendered for the keyboard in front of the user. One renderer, so a tooltip, a
// button tag and the cheat-sheet can never disagree about what a key is called.

import { describe, it, expect } from 'vitest';
import { shortcutLabel, shortcutTitle, SHORTCUT_TABLE } from '../lib/shortcuts.js';
import type { KeyboardPlatformProbe } from '../lib/sendChord.js';

const MAC: KeyboardPlatformProbe = { userAgentData: { platform: 'macOS' } };
const PC: KeyboardPlatformProbe = { userAgentData: { platform: 'Windows' } };

describe('shortcutLabel', () => {
  it('gives a Mac the glyphs printed on its keys, untouched', () => {
    for (const chord of ['⌘↵', '⌘S', '⌘⌥A', '⌘⇧E', '⌥E', '⌃`', "⌘⇧'", 'Esc', '↵']) {
      expect(shortcutLabel(chord, MAC)).toBe(chord);
    }
  });

  it('names the keys a PC keyboard actually has', () => {
    expect(shortcutLabel('⌘↵', PC)).toBe('Ctrl+Enter');
    expect(shortcutLabel('⌘S', PC)).toBe('Ctrl+S');
    expect(shortcutLabel('⌘⌥A', PC)).toBe('Ctrl+Alt+A');
    expect(shortcutLabel('⌘⇧E', PC)).toBe('Ctrl+Shift+E');
    expect(shortcutLabel('⌥E', PC)).toBe('Alt+E');
    expect(shortcutLabel("⌘⇧'", PC)).toBe("Ctrl+Shift+'");
    expect(shortcutLabel('⌃`', PC)).toBe('Ctrl+`');
    expect(shortcutLabel('⌘;', PC)).toBe('Ctrl+;');
    expect(shortcutLabel('⌘2', PC)).toBe('Ctrl+2');
  });

  it('leaves a chord with no modifier alone on either keyboard', () => {
    expect(shortcutLabel('Esc', PC)).toBe('Esc');
    expect(shortcutLabel('↵', PC)).toBe('Enter');
    expect(shortcutLabel('⇧↵', PC)).toBe('Shift+Enter');
  });

  it('says Ctrl once for ⌃ and ⌘ together rather than twice', () => {
    // Off a Mac the two glyphs name the same key, and "Ctrl+Ctrl+Space" names
    // nothing.
    expect(shortcutLabel('⌃ Space', PC)).toBe('Ctrl+Space');
    expect(shortcutLabel('⌘ ⌃ K', PC)).toBe('Ctrl+K');
  });

  it('ignores the spacing the cheat-sheet table writes its chords with', () => {
    expect(shortcutLabel('⌘ ⇧ A', PC)).toBe('Ctrl+Shift+A');
    expect(shortcutLabel('⌘ ?', PC)).toBe('Ctrl+?');
  });

  it('renders every row of the cheat-sheet table to something readable', () => {
    // A chord the renderer could not parse would show up as an empty cell or a
    // stray glyph, and the cheat-sheet is the surface nobody checks by hand.
    for (const row of SHORTCUT_TABLE) {
      const pc = shortcutLabel(row.keys, PC);
      expect(pc.length).toBeGreaterThan(0);
      expect(pc).not.toMatch(/[⌘⌥⇧⌃]/);
      expect(shortcutLabel(row.keys, MAC)).toBe(row.keys);
    }
  });

  it('falls to the PC naming when the platform cannot be read at all', () => {
    // Deterministic, not hedged: the label always names a real key.
    expect(shortcutLabel('⌘↵', null)).toBe('Ctrl+Enter');
    expect(shortcutLabel('⌘↵', {})).toBe('Ctrl+Enter');
  });
});

describe('shortcutTitle', () => {
  it('is the control name, then its chord in brackets', () => {
    expect(shortcutTitle('Save', '⌘↵', MAC)).toBe('Save (⌘↵)');
    expect(shortcutTitle('Save', '⌘↵', PC)).toBe('Save (Ctrl+Enter)');
    expect(shortcutTitle('New chat', '⌘N', MAC)).toBe('New chat (⌘N)');
  });

  it('keeps the tooltip a NAME plus a chord (spec/14 § Copy — no helper text)', () => {
    // The bracketed chord is the one thing allowed after the name, and the name
    // stays short enough that the tooltip never reads as a sentence.
    const title = shortcutTitle('Collapse sidebar', '⌘/', PC);
    expect(title.replace(/\s*\([^)]*\)$/, '').split(/\s+/).length).toBeLessThanOrEqual(3);
    expect(title).not.toMatch(/[.;—]/);
  });
});
