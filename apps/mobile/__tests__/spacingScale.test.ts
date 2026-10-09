// Item 13 — one 8px-based spacing scale (spec/15 § spacing):
// 4 · 8 · 12 · 16 · 24 · 32 · 48. Guards the scale's existence so screens
// can hold to it.

import { describe, it, expect } from 'vitest';
import { space } from '../src/lib/theme';

describe('spacing scale', () => {
  it('exposes the full 8px-based scale', () => {
    expect(Object.values(space).sort((a, b) => a - b)).toEqual([4, 8, 12, 16, 24, 32, 48]);
  });
});
