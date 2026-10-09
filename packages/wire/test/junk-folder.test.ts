// Recent-folder junk filter (spec/04 § Folders). `isJunkFolder` is the single
// shared rule that decides whether a folder seen in recent chats is a real
// user project folder or daemon/system noise. Used by the host registry and
// the surface pickers so "Recent" shows only real folders.

import { describe, it, expect } from 'vitest';
import { isJunkFolder, isSpecialThreadFolder } from '../src/index.js';

describe('isSpecialThreadFolder', () => {
  it('matches each special thread working dir under the default patch home', () => {
    expect(isSpecialThreadFolder('/home/tom/.patch/threads/manager')).toBe(true);
    expect(isSpecialThreadFolder('/home/tom/.patch/threads/speakers')).toBe(true);
  });

  // The reason this predicate exists at all: PATCH_HOME is relocatable
  // (spec/02 § Stack, and the integration rig sets it to `/daemon-home`), so
  // the dot-directory rule alone cannot see these.
  it('matches thread dirs under a relocated, non-dotted patch home', () => {
    expect(isSpecialThreadFolder('/daemon-home/threads/manager')).toBe(true);
    expect(isSpecialThreadFolder('/data/daemon-home/threads/speakers')).toBe(true);
  });

  it('ignores a trailing slash', () => {
    expect(isSpecialThreadFolder('/daemon-home/threads/manager/')).toBe(true);
  });

  it('needs BOTH segments — a bare thread name or a bare threads dir is not one', () => {
    expect(isSpecialThreadFolder('/home/tom/projects/manager')).toBe(false);
    expect(isSpecialThreadFolder('/daemon-home/threads')).toBe(false);
    expect(isSpecialThreadFolder('/daemon-home/threads/manager/sub')).toBe(false);
    expect(isSpecialThreadFolder('')).toBe(false);
  });

  it('is not fooled by a name that merely contains a thread name', () => {
    expect(isSpecialThreadFolder('/daemon-home/threads/manager-notes')).toBe(false);
    expect(isSpecialThreadFolder('/x/other-threads/manager')).toBe(false);
  });
});

describe('isJunkFolder', () => {
  it('keeps real user project folders', () => {
    expect(isJunkFolder('/home/tom/projects/patch')).toBe(false);
    expect(isJunkFolder('/app/projects/notes')).toBe(false);
    expect(isJunkFolder('/Users/tom/code/thing')).toBe(false);
  });

  it("drops the host's internal .patch/threads/* thread dirs", () => {
    expect(isJunkFolder('/app/.patch/threads/manager')).toBe(true);
    expect(isJunkFolder('/home/tom/.patch/threads/speakers')).toBe(true);
  });

  it('drops a thread dir under a relocated patch home, where there is no dot segment', () => {
    expect(isJunkFolder('/daemon-home/threads/manager')).toBe(true);
    expect(isJunkFolder('/data/daemon-home/threads/speakers')).toBe(true);
    // …while the parent that holds them is an ordinary path.
    expect(isJunkFolder('/data/daemon-home/projects/thing')).toBe(false);
  });

  it('drops any path containing a dot-directory segment', () => {
    expect(isJunkFolder('/home/tom/.config/foo')).toBe(true);
    expect(isJunkFolder('/repo/.git')).toBe(true);
    expect(isJunkFolder('/repo/.claude/skills')).toBe(true);
  });

  it('drops system scratch dirs', () => {
    expect(isJunkFolder('/tmp')).toBe(true);
    expect(isJunkFolder('/tmp/scratch')).toBe(true);
    expect(isJunkFolder('/var/tmp/x')).toBe(true);
    expect(isJunkFolder('/private/tmp/y')).toBe(true);
    expect(isJunkFolder('/var/folders/ab/cd/T/z')).toBe(true);
  });

  it('drops the empty path', () => {
    expect(isJunkFolder('')).toBe(true);
  });

  it('does not confuse a hidden basename with a legit "tmp"-prefixed name', () => {
    // A real project whose name merely starts with "tmp" is NOT scratch.
    expect(isJunkFolder('/home/tom/tmpl-project')).toBe(false);
    expect(isJunkFolder('/home/tom/temporary')).toBe(false);
  });
});
