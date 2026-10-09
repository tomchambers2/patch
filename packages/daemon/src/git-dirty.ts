// G3-d3 (spec/14-design-web.md § File browser): the authoritative source for
// the file browser's green ● pending-change marker. A file is dirty iff its
// working-tree content genuinely differs from its committed git baseline — NOT
// merely because the agent referenced/edited it earlier in the chat timeline.
//
// Lives in its own module (not index.ts) so it can be unit-tested without
// importing index.ts, whose top-level `main()` self-executes on import.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Perf: `handleFilesRequest` (packages/daemon/src/index.ts) calls
// `gitDirtyPaths` on EVERY non-recursive directory listing — i.e. every click
// into a folder in the web file tree. `git status` has to walk the whole
// index regardless of any pathspec (there is no cheaper "just this
// directory" mode), and the caller already wants the full root-relative dirty
// set so it can intersect it against whichever directory was listed — so
// there is nothing to gain from scoping the git invocation to a subpath; it
// would only fragment the cache below across directories that all want the
// same answer. The actual fix is (a) not blocking the host's single
// event loop while the shell-out runs, and (b) not re-running it for every
// listing fired within the same short window (regular browse + ⌘P firing
// near-simultaneously, or a rapid re-render).
const CACHE_TTL_MS = 1000;

const cache = new Map<string, { expires: number; result: Promise<Set<string>> }>();

/**
 * The set of work-tree-relative paths that genuinely differ from the git
 * baseline (modified, staged, or untracked) under `root`.
 *
 * `git status --porcelain -z` lists every changed/untracked path relative to
 * the work-tree root, NUL-separated. A non-git folder (or git absent) yields an
 * empty set — there is no baseline to diff against, so nothing is git-dirty
 * (pending permissions still mark a file dirty separately). NO FALLBACK: any
 * failure simply means "no git baseline", never a fabricated dirty flag.
 *
 * Runs the `git status` shell-out asynchronously (never blocks the host's
 * event loop) and caches the result per `root` for `CACHE_TTL_MS` — call
 * `invalidateGitDirtyCache(root)` immediately after any write that could
 * change the answer (see call sites in chatRunner.ts).
 */
export function gitDirtyPaths(root: string): Promise<Set<string>> {
  const now = Date.now();
  const cached = cache.get(root);
  if (cached && cached.expires > now) return cached.result;
  const result = computeGitDirtyPaths(root);
  cache.set(root, { expires: now + CACHE_TTL_MS, result });
  return result;
}

/**
 * Drop any cached dirty-set for `root` so the next `gitDirtyPaths(root)` call
 * shells out fresh. Called right after a write the host knows about — an
 * editor save (`Daemon.writeFile`), a file-browser create/rename/delete
 * (`runFileOp`), or an agent tool call that edits a file (`Edit`/`Write`/
 * `NotebookEdit` landing in `chat.tool_result`) — so the green ● never serves
 * a stale answer for the couple of seconds the cache would otherwise hold.
 */
export function invalidateGitDirtyCache(root: string): void {
  cache.delete(root);
}

async function computeGitDirtyPaths(root: string): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const { stdout: raw } = await execFileAsync('git', ['status', '--porcelain', '-z'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    // Records are NUL-terminated. Each is `XY <path>`; the 2-char status is
    // followed by a space, then the path (renames carry a second NUL-separated
    // old-path token, which we skip).
    const records = raw.split('\0');
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      if (!rec || rec.length < 4) continue;
      const status = rec.slice(0, 2);
      const path = rec.slice(3);
      if (path) out.add(path);
      // A rename ("R ") / copy ("C ") consumes the next NUL token as the old
      // path — skip it so it isn't mistaken for a separate dirty entry.
      if (status.startsWith('R') || status.startsWith('C')) i++;
    }
  } catch {
    // Not a git work-tree (or git unavailable) → no baseline, empty set.
  }
  return out;
}
