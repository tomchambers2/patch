// Which tree a live deploy is building in (scripts/deploy-lock.mjs).
//
// This used to be a lock that refused a second deploy, because every deploy
// pinned the same build tree. Trees are per-run now, so the refusal guarded
// nothing and only blocked — and blocking is what produced the 7 Oct deploy
// stampede (see the module header). These assertions are therefore about the
// marker: that it NEVER refuses, that a dead or truncated claim is inert, and
// that clearing it only ever removes our own.
//
// Run: node scripts/deploy-lock.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordDeployTree, lockedTree } from './deploy-lock.mjs';

const lockPath = () => join(mkdtempSync(join(tmpdir(), 'deploy-lock-')), 'deploy.lock');

test('records who is building and what', () => {
  const path = lockPath();
  const release = recordDeployTree({ path, sha: 'abc1234', pid: 4242, now: () => 1000 });
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
    pid: 4242,
    sha: 'abc1234',
    startedAt: 1000,
  });
  release();
});

test('does NOT refuse a second deploy while the first is alive', () => {
  // THE CHANGE. A live holder used to make this throw, which is what agents
  // then spin-waited on and stampeded behind. A concurrent deploy builds in its
  // own tree, so there is nothing to protect by refusing it — it just records
  // its own claim over the top.
  const path = lockPath();
  // process.pid is alive by definition — the holder that used to block us.
  writeFileSync(path, JSON.stringify({ pid: process.pid, sha: 'deadbee', startedAt: 0 }));
  const clear = recordDeployTree({
    path,
    sha: 'newsha',
    tree: '/b/tree-2-2',
    pid: process.pid + 1,
    now: () => 120_000,
  });
  const held = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(held.pid, process.pid + 1);
  assert.equal(held.sha, 'newsha');
  // The newer tree is the one cleanup should protect.
  assert.equal(held.tree, '/b/tree-2-2');
  clear();
});

test('a claim whose holder is gone is simply overwritten', () => {
  const path = lockPath();
  // Max pid + 1 can never be running.
  const dead = 2 ** 22 + 1;
  writeFileSync(path, JSON.stringify({ pid: dead, sha: 'old', startedAt: 0 }));
  const release = recordDeployTree({ path, sha: 'new', pid: 999, now: () => 5 });
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).pid, 999);
  release();
});

test('a truncated claim is inert', () => {
  const path = lockPath();
  writeFileSync(path, '{"pid":12');
  const release = recordDeployTree({ path, sha: 'new', pid: 777, now: () => 5 });
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).pid, 777);
  release();
});

test('clearing removes our claim', () => {
  const path = lockPath();
  const release = recordDeployTree({ path, sha: 'a', pid: 111, now: () => 0 });
  release();
  assert.equal(existsSync(path), false);
});

test('clearing does NOT remove a claim someone else has since taken', () => {
  // The stranding bug in reverse: a deploy that took over a stale lock, then
  // exited late, must not delete the lock of whoever took over from it.
  const path = lockPath();
  const release = recordDeployTree({ path, sha: 'a', pid: 111, now: () => 0 });
  writeFileSync(path, JSON.stringify({ pid: 222, sha: 'b', startedAt: 1 }));
  release();
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).pid, 222);
});

test('clearing twice is harmless', () => {
  const path = lockPath();
  const release = recordDeployTree({ path, sha: 'a', pid: 111, now: () => 0 });
  release();
  release();
  assert.equal(existsSync(path), false);
});

// --- the tree a live deploy is building in ---------------------------------
//
// Cleanup (scripts/deploy-cleanup.mjs) reads the lock to learn which build tree
// a concurrent deploy is standing in, so it can leave that one alone.

test('records the build tree, so another run’s cleanup knows which one is live', () => {
  const path = lockPath();
  const release = recordDeployTree({
    path,
    sha: 'a',
    tree: '/b/tree-1-1',
    pid: 111,
    now: () => 0,
  });
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).tree, '/b/tree-1-1');
  release();
});

test('a live holder’s tree is reported', () => {
  const path = lockPath();
  writeFileSync(path, JSON.stringify({ pid: 4242, sha: 'a', startedAt: 0, tree: '/b/tree-1-1' }));
  assert.deepEqual(lockedTree(path, { self: 1, isAlive: () => true }), {
    held: true,
    pid: 4242,
    tree: '/b/tree-1-1',
  });
});

test('our own lock, a dead holder, or no lock at all protects nothing', () => {
  const path = lockPath();
  assert.equal(lockedTree(path, { self: 1, isAlive: () => true }).held, false);
  writeFileSync(path, JSON.stringify({ pid: 4242, sha: 'a', startedAt: 0, tree: '/b/t' }));
  assert.equal(lockedTree(path, { self: 4242, isAlive: () => true }).held, false);
  assert.equal(lockedTree(path, { self: 1, isAlive: () => false }).held, false);
});

test('a live holder that did not record its tree is held with tree unknown, not guessed', () => {
  const path = lockPath();
  writeFileSync(path, JSON.stringify({ pid: 4242, sha: 'a', startedAt: 0 }));
  assert.deepEqual(lockedTree(path, { self: 1, isAlive: () => true }), {
    held: true,
    pid: 4242,
    tree: null,
  });
});

// ---------------------------------------------------------------------------
// The marker's contract with its callers (ship.mjs, ship-openai-*.mjs).

test('ship.mjs records its tree and no longer takes a lock', () => {
  const src = readFileSync(new URL('./ship.mjs', import.meta.url), 'utf8');
  assert.match(src, /recordDeployTree\(\{ path: DEPLOY_LOCK, sha: shipSha, tree: BUILD_TREE \}\)/);
  // The refusal is gone for good: nothing may reintroduce a call that can throw
  // on a live holder, because a deploy blocked behind `apply`'s half-hour wait
  // is what the agents stampeded over.
  assert.doesNotMatch(src, /acquireDeployLock/);
});

test('build trees are per-run, which is why no lock is needed', () => {
  const src = readFileSync(new URL('./ship.mjs', import.meta.url), 'utf8');
  // If this ever goes back to one shared path, the refusal has to come back
  // with it — concurrent deploys would otherwise clean each other's build.
  assert.match(src, /tree-\$\{Date\.now\(\)\}-\$\{process\.pid\}/);
});
