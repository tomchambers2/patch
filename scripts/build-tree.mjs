#!/usr/bin/env node
// The tree a deploy BUILDS from: a worktree pinned to the shipped commit, never
// somebody's working checkout.
//
//   node scripts/build-tree.mjs <sha> [treeDir]     # prepares it, prints its path
//
// The box already worked this way and says why: building in a shared checkout
// bundles whatever uncommitted work is sitting there into the artifact, while
// the build claims a commit that contains only the committed part.
//
// The Mac did not, and that was worse. The desktop step ssh'd in and ran
// `git checkout --quiet <sha>` inside `~/projects/patch` — which is a SYMLINK to
// the working checkout. Every deploy left it on a detached HEAD, and any
// uncommitted edit sitting there either blocked the deploy or was signed into
// the shipped Electron shell under a commit that does not contain it. The Mac is
// the one machine a human is actually typing in, so it is the last place that
// should have been treated as scratch space.
//
// Extracted here so both callers run the SAME preparation rather than two
// descriptions of it that drift.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isMain } from './lib/is-main.mjs';
import { inUseChecker, scanProcesses } from './lib/in-use.mjs';

/**
 * The git commands that pin `tree` to `sha`, in order.
 *
 * Split out from running them so the sequence is testable: getting it wrong
 * means building the wrong commit and reporting the right one.
 *
 * A tree that already exists is REUSED — a cold install of this monorepo costs
 * minutes and buys nothing — but it is force-checked-out and cleaned first, so
 * nothing survives from the previous deploy's commit except `node_modules`.
 */
export function worktreeSteps({ tree, sha, exists }) {
  if (!exists) {
    return [
      // A worktree whose directory was deleted stays registered and blocks the
      // add with "already exists"; pruning first makes this idempotent.
      ['git', ['worktree', 'prune']],
      ['git', ['worktree', 'add', '--detach', tree, sha]],
    ];
  }
  return [
    ['git', ['-C', tree, 'checkout', '--detach', '--force', '--quiet', sha]],
    ['git', ['-C', tree, 'clean', '-xdfq', '-e', 'node_modules']],
  ];
}

/**
 * Pin `tree` to `sha` and prove it landed there.
 *
 * `run` is injectable for tests. Returns the tree path so callers can `cd` to it
 * rather than reconstructing it.
 */
export function prepareWorktree({ tree, sha, run = defaultRun, exists = existsSync }) {
  mkdirSync(dirname(tree), { recursive: true });
  for (const [cmd, args] of worktreeSteps({ tree, sha, exists: exists(`${tree}/.git`) })) {
    run(cmd, args);
  }
  // NO FALLBACK: a tree at the wrong commit builds the wrong software and
  // reports the right sha, which is the failure this whole file exists to stop.
  const at = run('git', ['-C', tree, 'rev-parse', 'HEAD']).trim();
  if (!at.startsWith(sha) && !sha.startsWith(at)) {
    throw new Error(`build tree is at ${at}, expected ${sha}`);
  }
  return tree;
}

/**
 * Build trees to delete, given everything currently sitting in the build dir.
 *
 * Every deploy adds a worktree named `tree-<ms>-<pid>` and, until this existed,
 * removed nothing: 17 of them had piled up at ~1.9 GB each — 8.4 GB, on a disk
 * that was 97% full. At roughly twenty deploys a day that is ~38 GB a day, so
 * the box was always going to run out; it was a question of when. `git worktree
 * prune` does NOT help, because it only forgets worktrees whose directories are
 * already gone, and these directories were all still there.
 *
 * The unique name per run is deliberate (df15a598) and stays: a stable path
 * cannot survive two deploys at once. So the fix is to sweep — and it has to
 * happen at the END of every run (scripts/deploy-cleanup.mjs, success or
 * failure) as well as the start. Until then only the Mac swept (this file's
 * CLI, at the start of each run); ship.mjs on the box called prepareWorktree
 * directly and never swept at all, and ~36 trees piled up on a 97%-full disk. The
 * start-of-run sweep stays too: a deploy that is killed outright (the host
 * restart can take its process tree with it) still gets its tree collected by
 * the next one.
 *
 * Two guards keep the sweep away from anything live, since a deploy running
 * beside this one is holding its own tree open:
 *   - `keep` most recent trees survive regardless, and
 *   - nothing younger than `minAgeMs` is touched at all.
 * A deploy takes ~20 minutes, so an hours-old tree is finished by definition,
 * and `current` (this run's own tree) is never a candidate.
 *
 * Age is a proxy, and two things outlive it: a detached APK follower runs
 * `<tree>/scripts/ship.mjs` from its tree for as long as the EAS queue takes
 * (hours), and a concurrent deploy holds the deploy lock on its tree. `inUse`
 * (scripts/lib/in-use.mjs — any live process standing in, running from or
 * holding a file open under the tree) and `protect` (the lock holder's tree)
 * are the checked versions of that, and nothing they name is ever a candidate.
 *
 * `tree` (no suffix) is the stable path used before df15a598 and nothing has
 * built in it since; it is swept by the same rules rather than kept for ever.
 *
 * THE policy. Every sweep — the start-of-run one in build-tree.mjs and the
 * end-of-run one in deploy-cleanup.mjs, on the box and on the Mac — is this
 * function; there is no second description of it to drift.
 */
export const TREE_POLICY = { keep: 2, minAgeMs: 2 * 60 * 60 * 1000 };

export function treesToPrune({
  entries,
  current,
  now,
  keep = TREE_POLICY.keep,
  minAgeMs = TREE_POLICY.minAgeMs,
  inUse = () => false,
  protect = [],
}) {
  keep ??= TREE_POLICY.keep;
  minAgeMs ??= TREE_POLICY.minAgeMs;
  const candidates = entries
    .filter((e) => /^tree(-\d+-\d+)?$/.test(e.name))
    .filter((e) => e.path !== current)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  // The newest `keep` are spared before age is considered: on a quiet box they
  // are the only ones there, and keeping a warm node_modules around is worth
  // more than the last gigabyte.
  return candidates
    .slice(keep)
    .filter((e) => now - e.mtimeMs >= minAgeMs)
    .filter((e) => !protect.includes(e.path))
    .filter((e) => !inUse(e.path));
}

/** Read the build dir into the shape `treesToPrune` wants. Missing dir → none. */
export function readTreeEntries(dir, { readdir = readdirSync, stat = statSync } = {}) {
  let names;
  try {
    names = readdir(dir);
  } catch {
    return []; // nothing built here yet — not an error
  }
  const out = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      out.push({ name, path, mtimeMs: stat(path).mtimeMs });
    } catch {
      // Vanished between readdir and stat — another deploy's sweep got there
      // first, which is the correct outcome, not a failure.
    }
  }
  return out;
}

/**
 * Sweep stale build trees. Best-effort by design: this is housekeeping, and a
 * deploy that cannot delete a leftover directory must still ship. Failures are
 * reported on stderr and otherwise ignored.
 */
export function pruneBuildTrees({
  dir,
  current,
  now = Date.now(),
  run = defaultRun,
  log,
  read = readTreeEntries,
  keep,
  minAgeMs,
  inUse,
  protect,
  onError,
}) {
  // Forwarded rather than swallowed: a caller that asks for a different policy
  // and silently gets the default is the kind of quiet lie this codebase keeps
  // out of its seams.
  const doomed = treesToPrune({
    entries: read(dir),
    current,
    now,
    keep,
    minAgeMs,
    inUse,
    protect,
  });
  for (const t of doomed) {
    try {
      // `worktree remove` keeps git's registry honest; the rm is for a tree git
      // has already forgotten (or never knew), which would otherwise be immortal.
      try {
        run('git', ['worktree', 'remove', '--force', t.path]);
      } catch {
        run('rm', ['-rf', t.path]);
      }
      log?.(`build-tree: removed stale ${t.name}`);
    } catch (err) {
      log?.(`build-tree: could not remove ${t.name} (${err.message}) — continuing`);
      onError?.(t, err);
    }
  }
  if (doomed.length > 0) {
    try {
      run('git', ['worktree', 'prune']);
    } catch {
      /* housekeeping only */
    }
  }
  return doomed.map((t) => t.path);
}

function defaultRun(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

if (isMain(import.meta.url)) {
  const [sha, treeArg] = process.argv.slice(2);
  const tree =
    treeArg ?? `${process.env['HOME']}/.patch-deploy-build/tree-${Date.now()}-${process.pid}`;
  if (!sha) {
    process.stderr.write('usage: build-tree.mjs <sha> [treeDir]\n');
    process.exit(2);
  }
  // stdout is the tree path and NOTHING else — the caller does `cd "$(…)"`, so
  // every word of housekeeping below goes to stderr.
  process.stderr.write(`build-tree: pinning ${tree} to ${sha}\n`);
  // The same guards as the end-of-run sweep: several Mac lanes start at once,
  // and each must leave the others' trees alone. A process table that cannot be
  // read means no sweep this time, never a sweep that cannot see who is inside.
  let inUse = null;
  try {
    inUse = inUseChecker(scanProcesses().flatMap((p) => p.refs));
  } catch (err) {
    process.stderr.write(
      `build-tree: not sweeping — cannot see running processes (${err.message})\n`,
    );
  }
  if (inUse) {
    pruneBuildTrees({
      dir: dirname(tree),
      current: tree,
      inUse,
      log: (m) => process.stderr.write(`${m}\n`),
    });
  }
  process.stdout.write(`${prepareWorktree({ tree, sha })}\n`);
}
