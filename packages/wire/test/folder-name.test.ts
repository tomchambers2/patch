// Folder display NAME (spec/14 § Sidebar, spec/15 § New chat flow): the picker
// shows a folder's basename as the primary label, with the full path kept as
// muted secondary text. `folderName` is the single shared rule. These pin the
// basename extraction, trailing-slash tolerance, and the `/`-root / empty edge
// cases (where there is no basename so the original string is returned).

import { describe, it, expect } from 'vitest';
import { folderName } from '../src/index.js';

describe('folderName', () => {
  it('returns the final path segment (the basename)', () => {
    expect(folderName('/home/tom/projects/portfolio')).toBe('portfolio');
    expect(folderName('/Users/tom/code/thing')).toBe('thing');
    expect(folderName('/a')).toBe('a');
  });

  it('ignores trailing slashes so a path reads the same with or without one', () => {
    expect(folderName('/home/tom/projects/portfolio/')).toBe('portfolio');
    expect(folderName('/home/tom/projects/portfolio//')).toBe('portfolio');
    expect(folderName('/home/tom/projects/portfolio/')).toBe(
      folderName('/home/tom/projects/portfolio'),
    );
  });

  it('returns the original string for a root or empty path (no basename to show)', () => {
    // A root path has no basename, so we keep the original rather than an empty
    // label (which would render as a blank picker row).
    expect(folderName('/')).toBe('/');
    expect(folderName('')).toBe('');
  });

  it('handles a relative single-segment path', () => {
    expect(folderName('portfolio')).toBe('portfolio');
  });
});
