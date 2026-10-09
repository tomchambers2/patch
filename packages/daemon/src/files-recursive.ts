// Group 20 fix #5 (spec/14-design-web.md § File browser): the flat recursive
// file+dir index behind both the web SPA's ⌘P quick-open AND (editor
// overhaul) the hierarchical file tree itself — the tree's ONLY data source.
//
// Lives in its own module (not index.ts) for the same reason git-dirty.ts
// does — unit-testable without importing index.ts, whose top-level `main()`
// self-executes on import — and so chatRunner.ts's write-tracking code can
// invalidate its cache without importing index.ts at all.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const execFileAsync = promisify(execFile);

export interface RecursiveFileEntry {
  name: string;
  type: 'file' | 'dir';
}

// Editor overhaul (hierarchical tree): the client's `buildFileTree` already
// synthesizes an ancestor directory node from any FILE's path, so a NON-empty
// directory needs no entry of its own here — only a genuinely empty one
// (nothing tracked, nothing untracked-and-visible inside it) has no file to
// imply it, and would otherwise be invisible right after "New folder" creates
// one. Dotfiles/dot-directories are no longer excluded (unlike the old ⌘P-only
// walk): this is now the tree's only data source, and the browser is for
// poking around the whole repo — `.env.local` / `.claude/skills/...` are
// exactly the kind of thing someone opens it to find. `.git` itself is still
// always hidden (structural, not a normal browsable directory).
const HARD_SKIP = new Set(['node_modules', '.git', 'dist', 'release', '.cadence']);

/**
 * Fallback walk for a folder that is genuinely not a git work-tree (NO
 * FALLBACK: this only runs when git itself says there is no repo here, never
 * as a silent swallow of some other git failure — see listFilesViaGit below).
 * Pushes BOTH files and directories (including empty ones) as it walks —
 * there is no `.gitignore` to respect here, so there is no perf reason to
 * avoid descending into anything except the hardcoded skip set.
 */
function listFilesManual(root: string, cap: number): RecursiveFileEntry[] {
  const flat: RecursiveFileEntry[] = [];
  function walk(dir: string): void {
    if (flat.length >= cap) return;
    let dirents;
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      if (flat.length >= cap) return;
      if (HARD_SKIP.has(d.name)) continue;
      const abs = join(dir, d.name);
      const relPath = relative(root, abs);
      if (d.isDirectory()) {
        flat.push({ name: relPath, type: 'dir' });
        walk(abs);
      } else if (d.isFile()) {
        flat.push({ name: relPath, type: 'file' });
      }
    }
  }
  walk(root);
  return flat;
}

/**
 * `git ls-files -z --cached --others --exclude-standard` in one shell-out:
 * tracked files plus untracked-but-not-ignored files, i.e. everything
 * `.gitignore` (+ `.git/info/exclude`, + the global excludes file) does NOT
 * hide. Paths land relative to `cwd` (root), because git resolves output
 * relative to the invoking directory rather than the repo root, so this
 * works whether `root` is the repo root or a nested chat folder inside a
 * bigger repo.
 *
 * Returns `null` when `root` is not a git work-tree (git exits non-zero) —
 * the ONLY case the caller falls back to the manual walk for. Any other
 * failure mode of git itself is not swallowed here.
 */
async function listFilesViaGit(root: string, cap: number): Promise<RecursiveFileEntry[] | null> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    ));
  } catch {
    return null;
  }
  const names = stdout.split('\0').filter((n) => n.length > 0);
  names.sort();
  const out: RecursiveFileEntry[] = [];
  for (const name of names) {
    if (out.length >= cap) break;
    out.push({ name, type: 'file' });
  }
  return out;
}

/**
 * Empty directories, gitignore-aware, WITHOUT a manual fs walk: git cannot
 * represent an empty directory in its object model at all — tracked or not —
 * so every empty directory is by definition untracked. `git ls-files --others
 * --exclude-standard --directory` (no `--no-empty-directory`) asks git itself
 * to report those, doing the gitignore-aware pruning internally in the same
 * single process as `listFilesViaGit` — critically, this means a huge
 * gitignored directory (`build/`, `node_modules/`) is never descended into by
 * OUR code, only by git's own walk, which is exactly what the host
 * performance fix (`gitDirtyPaths` no longer blocking the event loop) was
 * about preserving. A NON-empty whole-untracked directory is also reported
 * this way (git's `--directory` collapses it to one entry) — harmless
 * duplication with a directory node the client already synthesized from one
 * of its files; `buildFileTree` treats a repeat entry as a no-op fill-in.
 */
async function listEmptyDirsViaGit(root: string): Promise<RecursiveFileEntry[] | null> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      'git',
      ['ls-files', '-z', '--others', '--exclude-standard', '--directory'],
      { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    ));
  } catch {
    return null;
  }
  const names = stdout.split('\0').filter((n) => n.length > 0);
  // `--directory` marks a collapsed directory entry with a trailing slash —
  // a loose untracked FILE that isn't inside a collapsible directory is
  // listed here too, unchanged (no trailing slash), and is already covered
  // by `listFilesViaGit`; keep only the real directory entries, or every
  // top-level untracked file would appear twice.
  return names
    .filter((n) => n.endsWith('/'))
    .map((n) => ({ name: n.slice(0, -1), type: 'dir' as const }));
}

async function computeListFilesRecursive(root: string, cap: number): Promise<RecursiveFileEntry[]> {
  const viaGit = await listFilesViaGit(root, cap);
  if (viaGit === null) return listFilesManual(root, cap);
  const dirs = (await listEmptyDirsViaGit(root)) ?? [];
  return [...viaGit, ...dirs];
}

// Perf: ⌘P re-walks on every open (`['files-recursive', chatId]` has no
// staleTime on the web side) over a 5s-timeout WS round trip, and (editor
// overhaul) every tree render now depends on the SAME call. A short TTL cache
// means repeatedly opening the picker, or the tree simply re-rendering,
// during one editing session only pays for the walk once every few seconds,
// not on every call.
const CACHE_TTL_MS = 7000;
const cache = new Map<string, { expires: number; result: Promise<RecursiveFileEntry[]> }>();

function cacheKey(root: string, cap: number): string {
  return `${root} ${cap}`;
}

export function listFilesRecursive(root: string, cap: number): Promise<RecursiveFileEntry[]> {
  const key = cacheKey(root, cap);
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expires > now) return cached.result;
  const result = computeListFilesRecursive(root, cap);
  cache.set(key, { expires: now + CACHE_TTL_MS, result });
  return result;
}

/**
 * Drop every cached recursive listing for `root` (across all `cap` values),
 * so the next tree render / ⌘P open re-walks fresh. Call this from the same
 * write-tracking spots that call `invalidateGitDirtyCache` — see
 * chatRunner.ts.
 */
export function invalidateFilesRecursiveCache(root: string): void {
  const prefix = `${root} `;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}
