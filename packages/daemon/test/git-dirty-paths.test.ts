// G3-d3 (spec/14-design-web.md § File browser): the file browser's green ●
// pending-change marker must reflect a GENUINE on-disk change, not merely that
// the agent referenced/edited a file earlier in the chat timeline. The host
// derives the dirty set from the git work-tree via `gitDirtyPaths`: a file is
// dirty iff its working-tree content differs from its committed baseline
// (modified, staged, or untracked). A non-git folder has no baseline → empty.
//
// Perf: `gitDirtyPaths` runs the `git status` shell-out asynchronously (never
// blocks the host's single event loop) and caches its answer per work-tree
// root for a short TTL — `invalidateGitDirtyCache` drops that cache so a
// write is reflected immediately rather than up to a TTL late.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { gitDirtyPaths, invalidateGitDirtyCache } from '../src/git-dirty.js';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'ignore'] });
}

function freshRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'patch-gitdirty-'));
  git(root, 'init');
  git(root, 'config', 'user.email', 't@e.com');
  git(root, 'config', 'user.name', 't');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'note.txt'), 'hello world\n');
  writeFileSync(join(root, 'README.md'), '# Project\n');
  writeFileSync(join(root, 'src', 'layout.ts'), 'const a = 1;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'init');
  return root;
}

describe('gitDirtyPaths (G3-d3)', () => {
  it('returns an empty set when the work-tree matches HEAD', async () => {
    const root = freshRepo();
    expect([...(await gitDirtyPaths(root))]).toEqual([]);
  });

  it('marks only the file whose on-disk content actually differs from HEAD', async () => {
    const root = freshRepo();
    writeFileSync(join(root, 'note.txt'), 'hello patch\n');
    const dirty = await gitDirtyPaths(root);
    expect(dirty.has('note.txt')).toBe(true);
    expect(dirty.has('README.md')).toBe(false);
    expect(dirty.has('src/layout.ts')).toBe(false);
  });

  it('does NOT mark a file the agent "edited" if its content was reverted to HEAD', async () => {
    const root = freshRepo();
    // Simulate an agent edit then a revert back to the committed baseline.
    writeFileSync(join(root, 'note.txt'), 'hello patch\n');
    writeFileSync(join(root, 'note.txt'), 'hello world\n'); // back to HEAD
    expect((await gitDirtyPaths(root)).has('note.txt')).toBe(false);
  });

  it('marks an untracked (new) file as dirty', async () => {
    const root = freshRepo();
    writeFileSync(join(root, 'fresh.ts'), 'export const x = 1;\n');
    expect((await gitDirtyPaths(root)).has('fresh.ts')).toBe(true);
  });

  it('returns an empty set for a non-git folder (no baseline, never fabricated)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'patch-nogit-'));
    writeFileSync(join(root, 'note.txt'), 'hello\n');
    expect([...(await gitDirtyPaths(root))]).toEqual([]);
  });

  it('marks a renamed file as dirty and does not mistake the old-path token for a separate entry', async () => {
    const root = freshRepo();
    git(root, 'mv', 'note.txt', 'renamed.txt');
    const dirty = await gitDirtyPaths(root);
    // The rename status ("R ") carries the old path as a second NUL token,
    // which must be skipped rather than surfaced as its own dirty path.
    expect(dirty.has('renamed.txt')).toBe(true);
    expect(dirty.has('note.txt')).toBe(false);
  });

  it('caches a listing for the TTL — a write after the first call is NOT reflected until invalidated', async () => {
    const root = freshRepo();
    // Prime the cache with a clean work-tree.
    expect((await gitDirtyPaths(root)).has('note.txt')).toBe(false);
    writeFileSync(join(root, 'note.txt'), 'hello patch\n');
    // Same root, well within the TTL: still the cached (stale) clean answer.
    expect((await gitDirtyPaths(root)).has('note.txt')).toBe(false);
  });

  it('invalidateGitDirtyCache drops the cache so the very next call reflects a fresh write', async () => {
    const root = freshRepo();
    expect((await gitDirtyPaths(root)).has('note.txt')).toBe(false);
    writeFileSync(join(root, 'note.txt'), 'hello patch\n');
    invalidateGitDirtyCache(root);
    expect((await gitDirtyPaths(root)).has('note.txt')).toBe(true);
  });

  it('does not block on a slow shell-out — two calls against different roots resolve concurrently', async () => {
    const rootA = freshRepo();
    const rootB = freshRepo();
    const [a, b] = await Promise.all([gitDirtyPaths(rootA), gitDirtyPaths(rootB)]);
    expect([...a]).toEqual([]);
    expect([...b]).toEqual([]);
  });
});
