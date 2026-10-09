// Is a path in use by a running process?
//
// Deploy cleanup (scripts/deploy-cleanup.mjs) deletes build trees, logs, host
// versions and temp files. The one thing it must never do is delete something a
// live process is standing in: a concurrent deploy's tree, the tree a detached
// APK follower runs `ship.mjs` from for hours, a log a running deploy is still
// writing, the host version the service execs. Ages and "keep the newest N"
// make that unlikely; this makes it checked.
//
// A process "uses" a path when its working directory, its executable, any word
// of its argv, or (Linux) any file it holds open is that path or lies under it.
// Anything else a process could depend on without any of those is out of reach,
// which is why the age guards stay as well.

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';

/**
 * Does `ref` mention `path` as a whole path — itself or something beneath it?
 *
 * `/b/tree-1-1` must not match `/b/tree-1-10`, and must match inside a shell
 * command line (`cd /b/tree-1-1 && …`) as well as a bare path.
 */
export function referencesPath(ref, path) {
  if (!ref || !path) return false;
  let at = ref.indexOf(path);
  while (at !== -1) {
    const next = ref[at + path.length];
    if (next === undefined || next === '/' || !/[\w.@+-]/.test(next)) return true;
    at = ref.indexOf(path, at + 1);
  }
  return false;
}

/** A path and, when it resolves, its realpath — /proc reports the latter. */
function spellings(path) {
  try {
    const real = realpathSync(path);
    return real === path ? [path] : [path, real];
  } catch {
    return [path];
  }
}

/** `inUse(path)` over a set of references gathered once. */
export function inUseChecker(refs) {
  return (path) => spellings(path).some((p) => refs.some((r) => referencesPath(r, p)));
}

/**
 * Every running process: its pid, argv, and the paths it references.
 *
 * Throws when the process table cannot be read at all — "I could not look" must
 * never read as "nothing is in use". A single process that vanishes or belongs
 * to someone else mid-scan is skipped.
 */
export function scanProcesses({ platform = process.platform } = {}) {
  return platform === 'linux' ? scanProc() : scanPs();
}

function scanProc() {
  const procs = [];
  const pids = readdirSync('/proc').filter((n) => /^\d+$/.test(n)); // throws if /proc is gone
  for (const pid of pids) {
    const base = `/proc/${pid}`;
    const refs = [];
    let args = [];
    try {
      args = readFileSync(`${base}/cmdline`, 'utf8').split('\0').filter(Boolean);
    } catch {
      continue; // exited mid-scan
    }
    refs.push(...args);
    for (const link of ['cwd', 'exe']) {
      try {
        refs.push(readlinkSync(`${base}/${link}`));
      } catch {
        /* not ours, or gone */
      }
    }
    try {
      for (const fd of readdirSync(`${base}/fd`)) {
        try {
          refs.push(readlinkSync(`${base}/fd/${fd}`));
        } catch {
          /* closed mid-scan */
        }
      }
    } catch {
      /* not ours */
    }
    procs.push({ pid: Number(pid), args, refs });
  }
  return procs;
}

/** macOS: argv from ps, working directories from lsof. */
function scanPs() {
  const procs = new Map();
  const ps = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  for (const line of ps.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) continue;
    const args = m[2].split(/\s+/);
    procs.set(Number(m[1]), { pid: Number(m[1]), args, refs: [m[2], ...args] });
  }
  // lsof exits 1 when some process could not be inspected; its output is still
  // the answer for every one it could.
  let cwd = '';
  try {
    cwd = execFileSync('lsof', ['-nP', '-a', '-d', 'cwd', '-F', 'pn'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    cwd = err.stdout ?? '';
    if (!cwd) throw new Error(`lsof could not list working directories: ${err.message}`);
  }
  let pid = null;
  for (const line of cwd.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && procs.has(pid)) procs.get(pid).refs.push(line.slice(1));
  }
  return [...procs.values()];
}
