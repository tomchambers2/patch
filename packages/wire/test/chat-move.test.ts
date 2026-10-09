import { describe, it, expect } from 'vitest';
import { defaultMoveFolder, suggestMoveFolder } from '../src/index.js';

describe('suggestMoveFolder (spec/04 § Moving a chat to another host)', () => {
  it('offers the target folder with the same name', () => {
    expect(
      suggestMoveFolder('/Users/tom/wpp/Unite', [
        '/home/tom/projects/portfolio',
        '/home/tom/Unite',
      ]),
    ).toBe('/home/tom/Unite');
  });
  it('prefers the project itself over a copy nested deeper', () => {
    expect(
      suggestMoveFolder('/Users/tom/Unite/', ['/home/tom/worktrees/x/Unite', '/home/tom/Unite']),
    ).toBe('/home/tom/Unite');
  });
  it('offers nothing when the target has no folder of that name', () => {
    expect(suggestMoveFolder('/Users/tom/Unite', ['/home/tom/portfolio'])).toBeNull();
    expect(suggestMoveFolder('/', ['/home'])).toBeNull();
  });
});

describe('defaultMoveFolder (spec/04 § Moving a chat to another host)', () => {
  it('prefers the same-named folder', () => {
    expect(defaultMoveFolder('/Users/tom/Unite', ['/home/tom/a', '/home/tom/Unite'])).toBe(
      '/home/tom/Unite',
    );
  });
  it('otherwise takes the first folder the machine offers', () => {
    expect(defaultMoveFolder('/Users/tom/Unite', ['/home/tom/portfolio', '/home/tom/b'])).toBe(
      '/home/tom/portfolio',
    );
  });
  it('is null only when the machine offers no folder at all', () => {
    expect(defaultMoveFolder('/Users/tom/Unite', [])).toBeNull();
  });
});
