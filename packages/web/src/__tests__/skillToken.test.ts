// spec/14 § Skill autocomplete — `/` opens anywhere a word starts, and a
// completed token becomes a chip (Patch Updates: "patch skill becomes a chip
// anywhere in the composer, with preview").

import { describe, it, expect } from 'vitest';
import {
  activeSlashToken,
  chipEndingAt,
  findChipTokens,
  spliceCompletion,
} from '../lib/skillToken.js';

describe('activeSlashToken', () => {
  it('is active at the very start of the message', () => {
    expect(activeSlashToken('/pl', 3)).toEqual({ start: 0, query: 'pl' });
  });

  it('opens mid-message, right after a space', () => {
    const text = 'please run /pl';
    expect(activeSlashToken(text, text.length)).toEqual({ start: 11, query: 'pl' });
  });

  it('opens right after a newline', () => {
    const text = 'first line\n/pl';
    expect(activeSlashToken(text, text.length)).toEqual({ start: 11, query: 'pl' });
  });

  it('is not active when the slash does not begin a word', () => {
    // No whitespace before the `/` — e.g. a URL fragment or a typo.
    expect(activeSlashToken('foo/bar', 7)).toBeNull();
  });

  it('is not active once the token has been closed with a space', () => {
    expect(activeSlashToken('/plant and then some', 8)).toBeNull();
  });

  it('reflects the query at the CURSOR, not at the end of the text', () => {
    // Cursor sits inside the token, with more text typed after it.
    expect(activeSlashToken('/plant more text', 3)).toEqual({ start: 0, query: 'pl' });
  });

  it('is not active with no slash at all', () => {
    expect(activeSlashToken('hello', 5)).toBeNull();
  });

  it('is active with an empty query right after the slash', () => {
    expect(activeSlashToken('hi /', 4)).toEqual({ start: 3, query: '' });
  });
});

describe('findChipTokens', () => {
  const known = new Set(['plant', 'clear']);

  it('finds a chip at the start of the message', () => {
    expect(findChipTokens('/plant is nice', known)).toEqual([{ start: 0, end: 6, name: 'plant' }]);
  });

  it('finds a chip mid-message', () => {
    expect(findChipTokens('please run /plant now', known)).toEqual([
      { start: 11, end: 17, name: 'plant' },
    ]);
  });

  it('finds two adjacent chips separated by one space', () => {
    expect(findChipTokens('/plant /clear done', known)).toEqual([
      { start: 0, end: 6, name: 'plant' },
      { start: 7, end: 13, name: 'clear' },
    ]);
  });

  it('does not chip a name that is not in the known set', () => {
    expect(findChipTokens('/nope here', known)).toEqual([]);
  });

  it('does not chip a token with nothing after it yet (still being typed)', () => {
    expect(findChipTokens('/plant', known)).toEqual([]);
  });

  it('does not chip a slash that does not begin a word', () => {
    expect(findChipTokens('a/plant b', known)).toEqual([]);
  });

  it('recognises a newline as closing the token too', () => {
    expect(findChipTokens('/plant\nmore', known)).toEqual([{ start: 0, end: 6, name: 'plant' }]);
  });
});

describe('chipEndingAt', () => {
  const known = new Set(['plant']);

  it('finds the chip immediately before the cursor', () => {
    expect(chipEndingAt('/plant ', 7, known)).toEqual({ start: 0 });
  });

  it('finds it mid-message', () => {
    expect(chipEndingAt('run /plant ', 11, known)).toEqual({ start: 4 });
  });

  it('is null when the cursor is not right after a closed chip', () => {
    expect(chipEndingAt('/plant', 6, known)).toBeNull(); // no trailing space yet
    expect(chipEndingAt('/plant more', 11, known)).toBeNull(); // cursor past the chip
  });

  it('is null for an unrecognised name', () => {
    expect(chipEndingAt('/nope ', 6, known)).toBeNull();
  });
});

describe('spliceCompletion', () => {
  it('replaces the active token at the start of the message', () => {
    expect(spliceCompletion('/pl', 0, 3, 'plant')).toEqual({ text: '/plant ', cursor: 7 });
  });

  it('replaces a mid-message token, keeping the text before and after it', () => {
    expect(spliceCompletion('please /pl now', 7, 10, 'plant')).toEqual({
      text: 'please /plant  now',
      cursor: 14,
    });
  });
});
