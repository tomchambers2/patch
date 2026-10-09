// Group 20 fix #5 (spec/14-design-web.md § File browser): the flat recursive
// file+dir index behind both ⌘P quick-open and (editor overhaul) the
// hierarchical file tree itself. A git work-tree resolves this via two
// `git ls-files` shell-outs (files, then empty/collapsed directories — both
// respect `.gitignore`); a genuinely non-git folder falls back to the old
// manual `readdirSync` walk (which does not — it only skips a small
// hardcoded set).

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { listFilesRecursive, invalidateFilesRecursiveCache } from '../src/files-recursive.js';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'ignore'] });
}

function names(entries: Array<{ name: string; type: 'file' }>): string[] {
  return entries.map((e) => e.name).sort();
}

describe('listFilesRecursive — git-repo path (.gitignore-respecting)', () => {
  it('excludes a directory named in .gitignore, the way a manual walk with a hardcoded skip-set cannot', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'patch-rec-git-')));
    git(root, 'init');
    git(root, 'config', 'user.email', 't@e.com');
    git(root, 'config', 'user.name', 't');
    writeFileSync(join(root, '.gitignore'), 'build/\ncoverage/\n');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'index.ts'), 'export {};\n');
    mkdirSync(join(root, 'build'), { recursive: true });
    writeFileSync(join(root, 'build', 'bundle.js'), '// generated\n');
    mkdirSync(join(root, 'coverage'), { recursive: true });
    writeFileSync(join(root, 'coverage', 'lcov.info'), 'TN:\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-m', 'init');

    const entries = await listFilesRecursive(root, 5000);
    const list = names(entries);
    expect(list).toContain('src/index.ts');
    // `.gitignore` itself is a dotfile — excluded by the same search-noise
    // rule covered separately below, not asserted here.
    expect(list.some((n) => n.startsWith('build/'))).toBe(false);
    expect(list.some((n) => n.startsWith('coverage/'))).toBe(false);
  });

  it('includes an untracked file that is not gitignored', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'patch-rec-git-')));
    git(root, 'init');
    git(root, 'config', 'user.email', 't@e.com');
    git(root, 'config', 'user.name', 't');
    writeFileSync(join(root, 'tracked.ts'), 'export {};\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-m', 'init');
    writeFileSync(join(root, 'scratch.ts'), '// not yet added\n');

    const list = names(await listFilesRecursive(root, 5000));
    expect(list).toContain('tracked.ts');
    expect(list).toContain('scratch.ts');
  });

  it("includes dotfiles at any depth — this is now the tree's only data source, not just ⌘P search noise reduction", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'patch-rec-git-')));
    git(root, 'init');
    git(root, 'config', 'user.email', 't@e.com');
    git(root, 'config', 'user.name', 't');
    writeFileSync(join(root, 'note.txt'), 'hi\n');
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'name: ci\n');
    writeFileSync(join(root, '.env.local'), 'SECRET=1\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-m', 'init');

    const list = names(await listFilesRecursive(root, 5000));
    expect(list).toContain('note.txt');
    expect(list).toContain('.github/workflows/ci.yml');
    expect(list).toContain('.env.local');
  });

  it('still always hides .git itself — structural, not a normal browsable directory', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'patch-rec-git-')));
    git(root, 'init');
    git(root, 'config', 'user.email', 't@e.com');
    git(root, 'config', 'user.name', 't');
    writeFileSync(join(root, 'note.txt'), 'hi\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-m', 'init');

    const list = names(await listFilesRecursive(root, 5000));
    expect(list.some((n) => n.startsWith('.git/'))).toBe(false);
  });

  it('includes a truly empty directory (e.g. right after "New folder") without descending into a large gitignored one', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'patch-rec-git-')));
    git(root, 'init');
    git(root, 'config', 'user.email', 't@e.com');
    git(root, 'config', 'user.name', 't');
    writeFileSync(join(root, '.gitignore'), 'build/\n');
    writeFileSync(join(root, 'note.txt'), 'hi\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-m', 'init');
    mkdirSync(join(root, 'untitled'));
    mkdirSync(join(root, 'build'), { recursive: true });
    writeFileSync(join(root, 'build', 'bundle.js'), '// generated\n');

    const entries = await listFilesRecursive(root, 5000);
    const dirNames = entries
      .filter((e) => e.type === 'dir')
      .map((e) => e.name)
      .sort();
    expect(dirNames).toContain('untitled');
    // The gitignored directory is not reported at all — not as a file (it
    // never was), and not as a directory either, so nothing descended into it.
    expect(dirNames).not.toContain('build');
    expect(names(entries).some((n) => n.startsWith('build/'))).toBe(false);
  });

  it('respects the entry cap', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'patch-rec-git-')));
    git(root, 'init');
    git(root, 'config', 'user.email', 't@e.com');
    git(root, 'config', 'user.name', 't');
    for (let i = 0; i < 10; i++) writeFileSync(join(root, `f${i}.txt`), 'x');
    git(root, 'add', '-A');
    git(root, 'commit', '-m', 'init');

    const entries = await listFilesRecursive(root, 3);
    expect(entries.length).toBe(3);
  });
});

describe('listFilesRecursive — non-git fallback (manual walk)', () => {
  it('walks a plain folder and skips the hardcoded noise dirs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'patch-rec-plain-'));
    writeFileSync(join(root, 'note.txt'), 'hi\n');
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), '// vendor\n');
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist', 'out.js'), '// built\n');

    const list = names(await listFilesRecursive(root, 5000));
    expect(list).toContain('note.txt');
    expect(list.some((n) => n.startsWith('node_modules'))).toBe(false);
    expect(list.some((n) => n.startsWith('dist'))).toBe(false);
  });

  it('does NOT respect an arbitrary directory literally named .gitignore-target without git (no git baseline to honor)', async () => {
    // Sanity check that the fallback really is the old dumb walk, not a
    // reimplementation of gitignore parsing: a folder called `build` with no
    // .gitignore anywhere is NOT skipped, because the manual walk only knows
    // the hardcoded SKIP set (which does not include `build`).
    const root = mkdtempSync(join(tmpdir(), 'patch-rec-plain-'));
    mkdirSync(join(root, 'build'), { recursive: true });
    writeFileSync(join(root, 'build', 'bundle.js'), '// generated\n');

    const list = names(await listFilesRecursive(root, 5000));
    expect(list).toContain('build/bundle.js');
  });
});

describe('listFilesRecursive — caching', () => {
  it('caches per root: a file added after the first call is not seen until the cache is invalidated', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'patch-rec-cache-')));
    git(root, 'init');
    git(root, 'config', 'user.email', 't@e.com');
    git(root, 'config', 'user.name', 't');
    writeFileSync(join(root, 'a.txt'), 'a\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-m', 'init');

    expect(names(await listFilesRecursive(root, 5000))).toEqual(['a.txt']);

    writeFileSync(join(root, 'b.txt'), 'b\n');
    // Still within the TTL: cache serves the first snapshot.
    expect(names(await listFilesRecursive(root, 5000))).toEqual(['a.txt']);

    invalidateFilesRecursiveCache(root);
    expect(names(await listFilesRecursive(root, 5000))).toEqual(['a.txt', 'b.txt']);
  });
});
