// Disambiguating folder LABELS for a list (spec/14 § Sidebar → Recent folders,
// spec/15 § New chat flow: "recent should just show the folder NAME, with extra
// path only when it's needed to tell two apart"). `folderLabels` is the shared
// rule the Recent-folders list and the new-chat picker both use so the same
// folder reads identically everywhere. These pin: plain basename when unique,
// minimal leftward growth (with a `…/` trim marker) on a basename collision,
// order/length preservation, and the root/empty edge cases.

import { describe, it, expect } from 'vitest';
import { folderLabels } from '../src/index.js';

describe('folderLabels', () => {
  it('shows just the basename when every basename is unique', () => {
    expect(
      folderLabels(['/home/tom/projects/portfolio', '/home/tom/code/thing', '/srv/app']),
    ).toEqual(['portfolio', 'thing', 'app']);
  });

  it('preserves input order and length', () => {
    const input = ['/a/one', '/b/two', '/c/three'];
    const out = folderLabels(input);
    expect(out).toHaveLength(input.length);
    expect(out).toEqual(['one', 'two', 'three']);
  });

  it('grows leftward by one parent segment when two basenames collide', () => {
    expect(folderLabels(['/home/tom/projects/portfolio', '/home/tom/work/portfolio'])).toEqual([
      '…/projects/portfolio',
      '…/work/portfolio',
    ]);
  });

  it('only disambiguates the colliding group, leaving unique names plain', () => {
    expect(
      folderLabels([
        '/home/tom/projects/portfolio',
        '/home/tom/work/portfolio',
        '/home/tom/code/thing',
      ]),
    ).toEqual(['…/projects/portfolio', '…/work/portfolio', 'thing']);
  });

  it('grows further when one parent segment is not enough to disambiguate', () => {
    expect(folderLabels(['/a/x/p', '/b/x/p', '/a/y/p'])).toEqual(['a/x/p', 'b/x/p', 'a/y/p']);
  });

  it('adds no trim marker when the disambiguating suffix is the whole path', () => {
    // Both paths are only two segments deep, so `parent/name` IS the full path —
    // no `…/` should be prefixed since nothing was trimmed.
    expect(folderLabels(['/projects/portfolio', '/work/portfolio'])).toEqual([
      'projects/portfolio',
      'work/portfolio',
    ]);
  });

  it('handles trailing slashes the same as folderName', () => {
    expect(folderLabels(['/home/tom/projects/portfolio/'])).toEqual(['portfolio']);
  });

  it('keeps root and empty paths intact', () => {
    expect(folderLabels(['/', ''])).toEqual(['/', '']);
  });

  it('returns an empty array for empty input', () => {
    expect(folderLabels([])).toEqual([]);
  });
});
