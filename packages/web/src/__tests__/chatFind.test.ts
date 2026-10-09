import { describe, expect, it } from 'vitest';
import { findRanges, stepIndex } from '../lib/chatFind.js';

describe('chatFind', () => {
  it('finds case-insensitive matches across text nodes, skipping data-find-skip', () => {
    const root = document.createElement('div');
    root.innerHTML =
      '<p>Hello world, hello</p><p>HELLO <b>hello</b></p><i data-find-skip>hello</i>';
    expect(findRanges(root, 'hello')).toHaveLength(4);
    expect(findRanges(root, '  ')).toHaveLength(0);
  });
  it('wraps stepping', () => {
    expect(stepIndex(2, 1, 3)).toBe(0);
    expect(stepIndex(0, -1, 3)).toBe(2);
    expect(stepIndex(0, 1, 0)).toBe(-1);
  });
});
