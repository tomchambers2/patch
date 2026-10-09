// G2-d1: internal [[…]] control markers must never survive into rendered text.

import { describe, it, expect } from 'vitest';
import { stripControlTokens } from '../lib/controlTokens.js';

describe('stripControlTokens (G2-d1)', () => {
  it('removes a [[permission]] marker and tidies whitespace', () => {
    expect(stripControlTokens('now [[permission]] please')).toBe('now please');
  });

  it('removes a [[edit]] marker mid-sentence', () => {
    expect(stripControlTokens('please [[edit]] the file')).toBe('please the file');
  });

  it('removes the [[edit]] / [[permission]] / [[tool]] / [[bash-permission]] markers', () => {
    for (const t of ['[[edit]]', '[[permission]]', '[[tool]]', '[[bash-permission]]']) {
      expect(stripControlTokens(t)).toBe('');
    }
  });

  it('strips an unknown future [[marker]] too (no regression surface)', () => {
    expect(stripControlTokens('a [[somethingnew]] b')).toBe('a b');
  });

  it('leaves ordinary text (and ordinary brackets) untouched', () => {
    expect(stripControlTokens('see arr[0] and obj[key]')).toBe('see arr[0] and obj[key]');
    expect(stripControlTokens('just a normal message')).toBe('just a normal message');
  });

  it('tidies punctuation adjacency after a removal', () => {
    expect(stripControlTokens('do it [[edit]], now')).toBe('do it, now');
  });
});
