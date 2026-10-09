// The host terminal's key bar (spec/15 § Host files and terminal): exactly the
// bytes a real terminal's keys send, a sticky Ctrl, and arrows that follow the
// terminal's cursor-key mode.

import { describe, it, expect } from 'vitest';
import { KEY_BAR, applyCtrl, keySequence } from '../src/lib/terminalKeys';

describe('KEY_BAR', () => {
  it('offers Esc, Tab, Ctrl, the four arrows, pipe, tilde and slash, in that order', () => {
    expect(KEY_BAR.map((k) => k.label)).toEqual([
      'Esc',
      'Tab',
      'Ctrl',
      '↑',
      '↓',
      '←',
      '→',
      '|',
      '~',
      '/',
    ]);
  });

  it('names every key for a screen reader', () => {
    for (const k of KEY_BAR) expect(k.accessibilityLabel.length).toBeGreaterThan(1);
  });
});

describe('keySequence', () => {
  const plain = { appCursor: false, ctrl: false };

  it('sends the terminal bytes for Esc and Tab, and the character for the rest', () => {
    expect(keySequence('esc', plain)).toBe('\x1b');
    expect(keySequence('tab', plain)).toBe('\t');
    expect(keySequence('pipe', plain)).toBe('|');
    expect(keySequence('tilde', plain)).toBe('~');
    expect(keySequence('slash', plain)).toBe('/');
  });

  it('sends normal-mode arrows at a shell prompt', () => {
    expect(keySequence('up', plain)).toBe('\x1b[A');
    expect(keySequence('down', plain)).toBe('\x1b[B');
    expect(keySequence('right', plain)).toBe('\x1b[C');
    expect(keySequence('left', plain)).toBe('\x1b[D');
  });

  it('sends application-mode arrows when a full-screen program asked for them', () => {
    const app = { appCursor: true, ctrl: false };
    expect(keySequence('up', app)).toBe('\x1bOA');
    expect(keySequence('left', app)).toBe('\x1bOD');
  });

  it('Ctrl on an arrow is the modified-key form, whatever the mode', () => {
    expect(keySequence('left', { appCursor: false, ctrl: true })).toBe('\x1b[1;5D');
    expect(keySequence('right', { appCursor: true, ctrl: true })).toBe('\x1b[1;5C');
  });

  it('Ctrl on a bar character sends its control character', () => {
    expect(keySequence('pipe', { appCursor: false, ctrl: true })).toBe('\x1c');
    expect(keySequence('slash', { appCursor: false, ctrl: true })).toBe('\x1f');
    expect(keySequence('tilde', { appCursor: false, ctrl: true })).toBe('\x1e');
    // Esc and Tab have no control form of their own; they go as themselves.
    expect(keySequence('esc', { appCursor: false, ctrl: true })).toBe('\x1b');
    expect(keySequence('tab', { appCursor: false, ctrl: true })).toBe('\t');
  });
});

describe('applyCtrl', () => {
  it('turns a letter into its control character, either case', () => {
    expect(applyCtrl('c')).toBe('\x03');
    expect(applyCtrl('C')).toBe('\x03');
    expect(applyCtrl('d')).toBe('\x04');
    expect(applyCtrl('a')).toBe('\x01');
    expect(applyCtrl('z')).toBe('\x1a');
  });

  it('covers the punctuation a terminal gives control forms', () => {
    expect(applyCtrl('[')).toBe('\x1b');
    expect(applyCtrl('\\')).toBe('\x1c');
    expect(applyCtrl(']')).toBe('\x1d');
    expect(applyCtrl('@')).toBe('\x00');
    expect(applyCtrl(' ')).toBe('\x00');
    expect(applyCtrl('?')).toBe('\x7f');
    expect(applyCtrl('_')).toBe('\x1f');
  });

  it('applies to the first character only — a keyboard can commit a whole word at once', () => {
    expect(applyCtrl('rls')).toBe('\x12ls');
  });

  it('leaves a character with no control form alone rather than guessing', () => {
    expect(applyCtrl('5')).toBe('5');
    expect(applyCtrl('é')).toBe('é');
    expect(applyCtrl('')).toBe('');
  });
});
