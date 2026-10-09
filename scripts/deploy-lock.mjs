// Which build tree a live deploy is using, so cleanup does not sweep it.
//
// THIS NO LONGER REFUSES A SECOND DEPLOY. It used to: one deploy at a time, per
// box, because every deploy pinned the SAME worktree
// (`~/.patch-deploy-build/tree`) and two of them cleaned and checked out each
// other's tree mid-build, producing an artifact that was a mix of two commits
// with nothing downstream to notice.
//
// That stopped being true when trees became per-run — `tree-<ms>-<pid>`, see
// BUILD_TREE in ship.mjs. Two deploys no longer share anything to corrupt, so
// the refusal was guarding a failure that cannot happen in this shape any more,
// and all it still did was block.
//
// What it blocked, on 7 Oct 2026: `apply` waits up to half an hour for the
// host to find a moment with no turn running, and a deploy run BY an agent is
// itself one of those turns, so the wait could not finish and the claim sat held
// for the better part of an hour. The agents behind it did not give up — one
// spin-waited 45 minutes on the holder's pid and shipped the instant it
// cleared, others collided and retried — and the box took a burst of
// back-to-back deploys, each of which restarts the host and kills every live
// chat on it. The refusal did not prevent that pile-up; it caused it.
//
// So what is left is a MARKER, not a lock: the running deploy records its pid
// and its tree, and `deploy-cleanup.mjs` reads it (`lockedTree`) to avoid
// deleting a tree that is still being built in. Cleanup has a second,
// independent guard for the same thing — the process table, via
// `scripts/lib/in-use.mjs` — plus a 2h age floor on trees, so the marker is the
// cheap first answer rather than the only one.
//
// A pidfile rather than `flock`: the holder has to be identifiable across a
// crash, and liveness comes from signal 0, so a stale file left by a killed
// deploy names a dead pid and protects nothing.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Is this pid a live process we may not disturb? */
export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists and belongs to someone else — still alive.
    return err?.code === 'EPERM';
  }
}

export function readHolder(path) {
  try {
    const held = JSON.parse(readFileSync(path, 'utf8'));
    return typeof held?.pid === 'number' ? held : null;
  } catch {
    // Unreadable or truncated (a deploy killed mid-write) carries no claim.
    return null;
  }
}

/**
 * Take the deploy lock, or throw naming who holds it.
 *
 * Returns a release function; it is also wired to process exit so a deploy that
 * throws does not leave the box locked. Releasing is idempotent and never
 * removes a file another deploy has since taken.
 *
 * `tree` is the build tree this deploy is building in. It is recorded so the
 * cleanup at the end of any OTHER run (scripts/deploy-cleanup.mjs) knows which
 * tree a concurrent deploy is standing in, rather than inferring it from ages.
 */
/**
 * Record that THIS deploy is building in `tree`, and return a function that
 * removes the record.
 *
 * Never refuses, never waits — see this file's header. A second deploy starting
 * while one is in flight simply overwrites the marker with its own claim, which
 * is correct: the newer tree is the one most worth protecting from cleanup, and
 * the older deploy's tree is still covered by the process-table check and the
 * age floor.
 */
export function recordDeployTree({ path, sha, tree, pid = process.pid, now = () => Date.now() } = {}) {
  if (!path) throw new Error('recordDeployTree: path required');
  mkdirSync(dirname(path), { recursive: true });

  writeFileSync(path, JSON.stringify({ pid, sha, startedAt: now(), ...(tree ? { tree } : {}) }), 'utf8');

  let cleared = false;
  const clear = () => {
    if (cleared) return;
    cleared = true;
    // Only ever remove OUR claim: a later deploy's marker must outlive this
    // one's exit, or cleanup loses the tree it should be protecting.
    const current = readHolder(path);
    if (current?.pid === pid) {
      try {
        unlinkSync(path);
      } catch {
        // Already gone — nothing to undo.
      }
    }
  };
  process.on('exit', clear);
  return clear;
}

/**
 * The tree a LIVE deploy other than `self` is building in.
 *
 * `{ held: false }` when nobody (else) holds it. `{ held: true, tree: null }`
 * when a live holder did not record its tree (a lock written before trees were
 * recorded) — the caller must then treat every tree as possibly its, not guess.
 */
export function lockedTree(path, { self = process.pid, isAlive = alive } = {}) {
  const held = existsSync(path) ? readHolder(path) : null;
  if (!held || held.pid === self || !isAlive(held.pid)) return { held: false, tree: null };
  return { held: true, pid: held.pid, tree: typeof held.tree === 'string' ? held.tree : null };
}
