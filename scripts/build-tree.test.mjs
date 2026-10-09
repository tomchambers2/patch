// How a deploy pins the tree it builds from (scripts/build-tree.mjs).
//
// The failure being guarded is quiet: a build tree left at the wrong commit
// produces artifacts for one commit and labels them with another, and every
// version panel downstream repeats the label. So the assertions here are about
// order and about the refusal, not about happy-path plumbing.
//
// Run: node scripts/build-tree.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  worktreeSteps,
  prepareWorktree,
  treesToPrune,
  readTreeEntries,
  pruneBuildTrees,
} from './build-tree.mjs';

const TREE = '/tmp/tree';
const SHA = 'abc1234';

test('a missing tree is pruned before being added — a deleted dir stays registered', () => {
  const steps = worktreeSteps({ tree: TREE, sha: SHA, exists: false });
  assert.deepEqual(steps[0], ['git', ['worktree', 'prune']]);
  assert.deepEqual(steps[1], ['git', ['worktree', 'add', '--detach', TREE, SHA]]);
});

test('an existing tree is reused, but force-checked-out and cleaned first', () => {
  const steps = worktreeSteps({ tree: TREE, sha: SHA, exists: true });
  assert.deepEqual(steps, [
    ['git', ['-C', TREE, 'checkout', '--detach', '--force', '--quiet', SHA]],
    ['git', ['-C', TREE, 'clean', '-xdfq', '-e', 'node_modules']],
  ]);
});

test('the clean keeps node_modules — a cold install costs minutes and buys nothing', () => {
  const [, clean] = worktreeSteps({ tree: TREE, sha: SHA, exists: true });
  assert.ok(clean[1].includes('-e') && clean[1].includes('node_modules'));
});

test('the clean removes everything else, including the last commit’s build output', () => {
  const [, clean] = worktreeSteps({ tree: TREE, sha: SHA, exists: true });
  assert.ok(clean[1].includes('-xdfq'), 'must clean ignored + untracked files');
});

/** A `run` double that answers rev-parse with `head` and records the rest. */
function runner(head) {
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, args]);
    return args.includes('rev-parse') ? `${head}\n` : '';
  };
  run.calls = calls;
  return run;
}

test('returns the tree path once it is verifiably at the commit', () => {
  const run = runner(SHA);
  assert.equal(prepareWorktree({ tree: TREE, sha: SHA, run, exists: () => true }), TREE);
});

test('accepts a full sha for an abbreviated one, and the reverse', () => {
  const full = 'abc1234def5678';
  assert.equal(
    prepareWorktree({ tree: TREE, sha: SHA, run: runner(full), exists: () => true }),
    TREE,
  );
  assert.equal(
    prepareWorktree({ tree: TREE, sha: full, run: runner(SHA), exists: () => true }),
    TREE,
  );
});

test('REFUSES a tree that landed on a different commit', () => {
  const run = runner('9999999');
  assert.throws(
    () => prepareWorktree({ tree: TREE, sha: SHA, run, exists: () => true }),
    /9999999/,
  );
});

test('never touches the checkout it was invoked from — every command targets the tree', () => {
  const run = runner(SHA);
  prepareWorktree({ tree: TREE, sha: SHA, run, exists: () => true });
  for (const [, args] of run.calls) {
    assert.ok(
      args.includes('-C') && args[args.indexOf('-C') + 1] === TREE,
      `${args.join(' ')} would run against the invoking checkout`,
    );
  }
});

// --- sweeping stale build trees -------------------------------------------
//
// The leak these guard: every deploy adds a ~1.9 GB worktree and nothing ever
// removed one. Seventeen had accumulated (8.4 GB) on a disk at 97%. The danger
// in the fix is the opposite one — deleting a tree a concurrent deploy is
// building in — so most of these are about what must SURVIVE.

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-09-17T12:00:00Z');

/** `n` hours old, named the way the deploy names them. */
function tree(name, hoursOld) {
  return { name, path: `/b/${name}`, mtimeMs: NOW - hoursOld * HOUR };
}

test('sweeps the old ones and keeps the two newest', () => {
  const entries = [
    tree('tree-1-1', 30),
    tree('tree-2-2', 20),
    tree('tree-3-3', 10),
    tree('tree-4-4', 5),
  ];
  const doomed = treesToPrune({ entries, current: '/b/tree-5-5', now: NOW }).map((t) => t.name);
  assert.deepEqual(doomed, ['tree-2-2', 'tree-1-1']);
});

test('never touches the tree THIS deploy is building in', () => {
  const entries = [tree('tree-1-1', 40), tree('tree-2-2', 30), tree('tree-3-3', 20)];
  const doomed = treesToPrune({
    entries,
    current: '/b/tree-1-1',
    now: NOW,
    keep: 0,
  }).map((t) => t.name);
  assert.ok(!doomed.includes('tree-1-1'), 'the current tree must never be a candidate');
});

test('never touches a young tree — a deploy may be running in it right now', () => {
  // The real hazard. A second deploy on the box holds its own tree open, and a
  // deploy takes ~20 minutes; anything under the age floor is presumed live.
  const entries = [
    tree('tree-1-1', 40),
    tree('tree-2-2', 30),
    tree('tree-3-3', 0.25),
    tree('tree-4-4', 0.5),
  ];
  const doomed = treesToPrune({ entries, current: '/b/tree-9-9', now: NOW, keep: 0 }).map(
    (t) => t.name,
  );
  assert.deepEqual(doomed, ['tree-2-2', 'tree-1-1']);
});

test('a box with only fresh trees loses nothing', () => {
  const entries = [tree('tree-1-1', 0.1), tree('tree-2-2', 0.2)];
  assert.deepEqual(treesToPrune({ entries, current: '/b/tree-3-3', now: NOW }), []);
});

test('ignores anything that is not a deploy build tree', () => {
  // The lock, the Mac's gui-jobs and anything else living beside the trees are
  // not ours to delete.
  const entries = [
    { name: 'deploy.lock', path: '/b/deploy.lock', mtimeMs: NOW - 100 * HOUR },
    { name: 'gui-jobs', path: '/b/gui-jobs', mtimeMs: NOW - 100 * HOUR },
    { name: 'tree-x', path: '/b/tree-x', mtimeMs: NOW - 100 * HOUR },
    tree('tree-1-1', 100),
    tree('tree-2-2', 99),
    tree('tree-3-3', 98),
  ];
  const doomed = treesToPrune({ entries, current: null, now: NOW }).map((t) => t.name);
  assert.deepEqual(doomed, ['tree-1-1']);
});

test('the pre-df15a598 stable `tree` is swept by the same rules, not kept for ever', () => {
  // Nothing has built in it since trees got unique names; on the box and the
  // Mac it was ~2 GB each that no rule ever reached.
  const entries = [
    { name: 'tree', path: '/b/tree', mtimeMs: NOW - 200 * HOUR },
    tree('tree-1-1', 3),
    tree('tree-2-2', 2.5),
  ];
  const doomed = treesToPrune({ entries, current: null, now: NOW }).map((t) => t.name);
  assert.deepEqual(doomed, ['tree']);
});

test('never touches a tree a running process is in — a detached APK follower runs from it for hours', () => {
  const entries = [
    tree('tree-1-1', 9),
    tree('tree-2-2', 8),
    tree('tree-3-3', 7),
    tree('tree-4-4', 1),
  ];
  const doomed = treesToPrune({
    entries,
    current: '/b/tree-9-9',
    now: NOW,
    inUse: (p) => p === '/b/tree-2-2',
  }).map((t) => t.name);
  assert.deepEqual(doomed, ['tree-1-1'], 'old enough and not among the newest two, but in use');
});

test('never touches the tree a concurrent deploy holds the lock for, however old', () => {
  const entries = [
    tree('tree-1-1', 9),
    tree('tree-2-2', 8),
    tree('tree-3-3', 7),
    tree('tree-4-4', 6),
  ];
  const doomed = treesToPrune({
    entries,
    current: '/b/tree-9-9',
    now: NOW,
    protect: ['/b/tree-1-1'],
  }).map((t) => t.name);
  assert.deepEqual(doomed, ['tree-2-2']);
});

test('the policy is the published one: newest 2 kept, nothing under 2h touched', async () => {
  const { TREE_POLICY } = await import('./build-tree.mjs');
  assert.deepEqual(TREE_POLICY, { keep: 2, minAgeMs: 2 * HOUR });
});

test('a missing build dir is not an error — nothing has been built yet', () => {
  assert.deepEqual(
    readTreeEntries('/b', {
      readdir: () => {
        throw new Error('ENOENT');
      },
    }),
    [],
  );
});

test('a tree that vanishes mid-scan is skipped, not fatal', () => {
  const entries = readTreeEntries('/b', {
    readdir: () => ['tree-1-1', 'tree-2-2'],
    stat: (p) => {
      if (p.endsWith('tree-1-1')) throw new Error('ENOENT');
      return { mtimeMs: NOW };
    },
  });
  assert.deepEqual(
    entries.map((e) => e.name),
    ['tree-2-2'],
  );
});

test('falls back to rm when git has forgotten the worktree', () => {
  const calls = [];
  const removed = pruneBuildTrees({
    dir: '/b',
    current: '/b/tree-9-9',
    now: NOW,
    read: () => [tree('tree-1-1', 100), tree('tree-2-2', 99), tree('tree-3-3', 98)],
    run: (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      if (cmd === 'git' && args[1] === 'remove') throw new Error('not a working tree');
      return '';
    },
  });
  assert.deepEqual(removed, ['/b/tree-1-1']);
  assert.ok(
    calls.includes('git worktree remove --force /b/tree-1-1'),
    'it must try git first, so the registry stays honest',
  );
  assert.ok(
    calls.includes('rm -rf /b/tree-1-1'),
    'and fall back to rm, or a tree git has forgotten is immortal',
  );
  assert.ok(calls.includes('git worktree prune'), 'then prune the registry once');
});

test('a delete that fails does NOT fail the deploy — this is housekeeping', () => {
  // A leftover directory nobody can remove must never be the reason a deploy
  // does not ship.
  const logged = [];
  const removed = pruneBuildTrees({
    dir: '/b',
    current: '/b/tree-9-9',
    now: NOW,
    read: () => [tree('tree-1-1', 100), tree('tree-2-2', 99), tree('tree-3-3', 98)],
    run: () => {
      throw new Error('EPERM');
    },
    log: (m) => logged.push(m),
  });
  assert.deepEqual(removed, ['/b/tree-1-1'], 'it reports what it meant to remove');
  assert.ok(
    logged.some((m) => m.includes('could not remove') && m.includes('continuing')),
    'and says so rather than dying, or failing silently',
  );
});

test('a removal that fails is reported to the caller, so the summary can say so', () => {
  const failed = [];
  pruneBuildTrees({
    dir: '/b',
    current: '/b/tree-9-9',
    now: NOW,
    read: () => [tree('tree-1-1', 100), tree('tree-2-2', 99), tree('tree-3-3', 98)],
    run: () => {
      throw new Error('EBUSY');
    },
    onError: (t, err) => failed.push(`${t.name}: ${err.message}`),
  });
  assert.deepEqual(failed, ['tree-1-1: EBUSY']);
});

test('a sweep with nothing to do runs no commands at all', () => {
  const calls = [];
  const removed = pruneBuildTrees({
    dir: '/b',
    current: '/b/tree-1-1',
    now: NOW,
    read: () => [tree('tree-1-1', 0.1)],
    run: (cmd, args) => calls.push([cmd, ...args].join(' ')),
  });
  assert.deepEqual(removed, []);
  assert.deepEqual(calls, [], 'not even a prune — a quiet box stays untouched');
});

test('a caller that asks for a different policy actually gets it', () => {
  // `keep` and `minAgeMs` reach treesToPrune rather than being swallowed by
  // pruneBuildTrees' own signature.
  const removed = pruneBuildTrees({
    dir: '/b',
    current: '/b/tree-9-9',
    now: NOW,
    keep: 0,
    read: () => [tree('tree-1-1', 100), tree('tree-2-2', 99), tree('tree-3-3', 98)],
    run: () => '',
  });
  assert.deepEqual(removed, ['/b/tree-3-3', '/b/tree-2-2', '/b/tree-1-1']);
});
