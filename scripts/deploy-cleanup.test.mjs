// A deploy's end-of-run cleanup (scripts/deploy-cleanup.mjs, lib/in-use.mjs).
//
// Freeing disk is the easy half. The half these tests are mostly about is what
// must SURVIVE: this run's tree, the tree a concurrent deploy holds the lock
// for, anything a live process stands in (a detached APK follower runs from its
// tree for hours), the host version the service execs and the one before it,
// a log still being written — and the rule that a cleanup that fails is
// reported, never thrown into the deploy.
//
// Run: node --test scripts/deploy-cleanup.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  apkOutputDirs,
  formatCleanup,
  logsToPrune,
  runCleanup,
  staleToPrune,
  versionsToPrune,
} from './deploy-cleanup.mjs';
import { inUseChecker, referencesPath, scanProcesses } from './lib/in-use.mjs';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-09-25T12:00:00Z');
const entry = (name, ageMs, dir = '/d') => ({ name, path: `${dir}/${name}`, mtimeMs: NOW - ageMs });

// --- what counts as "in use" -------------------------------------------------

test('a path is referenced by itself, anything under it, and inside a shell line', () => {
  assert.ok(referencesPath('/b/tree-1-1', '/b/tree-1-1'));
  assert.ok(referencesPath('/b/tree-1-1/scripts/ship.mjs', '/b/tree-1-1'));
  assert.ok(referencesPath('cd /b/tree-1-1 && node x', '/b/tree-1-1'));
  assert.ok(referencesPath('--current=/b/tree-1-1', '/b/tree-1-1'));
});

test('a sibling whose name merely starts the same is NOT referenced', () => {
  assert.ok(!referencesPath('/b/tree-1-10/scripts/ship.mjs', '/b/tree-1-1'));
  assert.ok(!referencesPath('/b/tree-1-1.bak', '/b/tree-1-1'));
  assert.ok(!referencesPath('/b/tree-1-1-x', '/b/tree-1-1'));
});

test('a path reached through a symlink is matched by its realpath — /proc reports that', () => {
  const root = mkdtempSync(join(tmpdir(), 'in-use-'));
  mkdirSync(join(root, 'real'));
  symlinkSync(join(root, 'real'), join(root, 'link'));
  const inUse = inUseChecker([`${join(root, 'real')}/node_modules`]);
  assert.ok(inUse(join(root, 'link')));
});

test('the process scan sees this very process standing in its working directory', () => {
  const procs = scanProcesses();
  const me = procs.find((p) => p.pid === process.pid);
  assert.ok(me, 'this process is in the table');
  assert.ok(inUseChecker(me.refs)(process.cwd()));
});

// --- policies ----------------------------------------------------------------

test('logs: the 30 newest and anything under 30 days survive; the rest go', () => {
  const entries = [];
  for (let i = 0; i < 40; i++) entries.push(entry(`deploy-${i}.log`, i * 2 * DAY));
  const doomed = logsToPrune({ entries, now: NOW }).map((e) => e.name);
  // 0..29 are the newest 30; 30..39 are 60–78 days old.
  assert.deepEqual(
    doomed,
    [30, 31, 32, 33, 34, 35, 36, 37, 38, 39].map((i) => `deploy-${i}.log`),
  );
});

test('logs: a busy month is not cut to thirty — nothing under 30 days is deleted', () => {
  const entries = [];
  for (let i = 0; i < 100; i++) entries.push(entry(`deploy-${i}.log`, i * HOUR));
  assert.deepEqual(logsToPrune({ entries, now: NOW }), []);
});

test('logs: one a process still holds open survives, however old', () => {
  const entries = [];
  for (let i = 0; i < 35; i++) entries.push(entry(`apk-${i}.log`, (40 + i) * DAY));
  const doomed = logsToPrune({ entries, now: NOW, inUse: (p) => p === '/d/apk-34.log' });
  assert.ok(!doomed.some((e) => e.name === 'apk-34.log'));
  assert.equal(doomed.length, 4);
});

test('logs: only .log files are candidates', () => {
  const entries = [];
  for (let i = 0; i < 35; i++) entries.push(entry(`x-${i}.txt`, 90 * DAY));
  assert.deepEqual(logsToPrune({ entries, now: NOW }), []);
});

test('host versions: current, the one before it, and anything newer survive', () => {
  const entries = ['0.1.1042', '0.1.1089', '0.1.1100', '0.1.1101', '0.1.999', 'custom'].map((n) =>
    entry(n, 3 * DAY),
  );
  const doomed = versionsToPrune({ entries, current: '0.1.1100', now: NOW }).map((e) => e.name);
  // 0.1.1101 is newer (an install in flight); 0.1.1089 is the rollback; `custom`
  // is not a version this understands.
  assert.deepEqual(doomed, ['0.1.1042', '0.1.999']);
});

test('host versions: no resolvable current means nothing is removed', () => {
  const entries = ['0.1.1', '0.1.2', '0.1.3'].map((n) => entry(n, 3 * DAY));
  assert.deepEqual(versionsToPrune({ entries, current: '0.1.9', now: NOW }), []);
});

test('host versions: in use or younger than 2h survive', () => {
  const entries = [
    entry('0.1.1', 3 * DAY),
    entry('0.1.2', HOUR),
    entry('0.1.3', 3 * DAY),
    entry('0.1.4', 3 * DAY),
    entry('0.1.5', 3 * DAY),
  ];
  const doomed = versionsToPrune({
    entries,
    current: '0.1.5',
    now: NOW,
    inUse: (p) => p === '/d/0.1.1',
  }).map((e) => e.name);
  assert.deepEqual(doomed, ['0.1.3']);
});

test('temp files: only stale matches that nobody holds', () => {
  const entries = [
    entry('patch-smoke-aaa', 3 * HOUR),
    entry('patch-smoke-bbb', 0.5 * HOUR),
    entry('patch-smoke-ccc', 5 * HOUR),
    entry('other', 9 * HOUR),
  ];
  const doomed = staleToPrune({
    entries,
    pattern: /^patch-smoke-/,
    now: NOW,
    inUse: (p) => p.endsWith('ccc'),
  }).map((e) => e.name);
  assert.deepEqual(doomed, ['patch-smoke-aaa']);
});

test('APK outputs are the android build dirs — node_modules itself survives', () => {
  const tree = mkdtempSync(join(tmpdir(), 'apk-out-'));
  const made = [
    'apps/mobile/android/app/build/outputs',
    'apps/mobile/android/.gradle',
    'node_modules/.pnpm/expo-modules-core@2/node_modules/expo-modules-core/android/build',
    'node_modules/.pnpm/expo-modules-core@2/node_modules/expo-modules-core/android/.cxx',
    'node_modules/.pnpm/scoped@1/node_modules/@scope/pkg/android/build',
    'node_modules/.pnpm/expo-modules-core@2/node_modules/expo-modules-core/android/src',
  ];
  for (const d of made) mkdirSync(join(tree, d), { recursive: true });
  const dirs = apkOutputDirs(tree)
    .map((d) => d.slice(tree.length + 1))
    .sort();
  assert.deepEqual(dirs, [
    'apps/mobile/android/.gradle',
    'apps/mobile/android/app/build',
    'node_modules/.pnpm/expo-modules-core@2/node_modules/expo-modules-core/android/.cxx',
    'node_modules/.pnpm/expo-modules-core@2/node_modules/expo-modules-core/android/build',
    'node_modules/.pnpm/scoped@1/node_modules/@scope/pkg/android/build',
  ]);
});

// --- the summary line --------------------------------------------------------

const clean = {
  removed: { trees: 2, logs: 1, downloads: 0, versions: 0, temp: 0, apkOutputs: 0 },
  errors: [],
  freed: 4.2e9,
  after: 18e9,
  usedPct: 88,
  buildDaemons: 0,
};

test('the summary is one line naming what went and what it freed', () => {
  const line = formatCleanup(clean, 'box');
  assert.equal(line.split('\n').length, 1);
  assert.match(line, /^cleanup on box: freed 4\.20 GB \(2 build trees, 1 log\); disk 88% used/);
});

test('a failure is LOUD in the summary line, and still says what did happen', () => {
  const line = formatCleanup(
    { ...clean, errors: ['build trees: could not remove tree-1-1'] },
    'box',
  );
  assert.match(line, /^CLEANUP FAILED on box/);
  assert.match(line, /could not remove tree-1-1/);
  assert.match(line, /freed 4\.20 GB/);
});

// --- a whole run, on a scratch "machine" -------------------------------------

/**
 * A scratch machine: a build dir of trees, a deploy-state dir with logs and
 * downloads, host versions and a temp dir. Ages in hours.
 */
function machine() {
  const root = mkdtempSync(join(tmpdir(), 'deploy-cleanup-'));
  const age = (path, hours) => {
    const t = (NOW - hours * HOUR) / 1000;
    utimesSync(path, t, t);
  };
  const buildDir = join(root, 'build');
  const trees = {};
  for (const [name, hours] of [
    ['tree-1-1', 50],
    ['tree-2-2', 40],
    ['tree-3-3', 30],
    ['tree-4-4', 20],
    ['tree-5-5', 10],
    ['tree-6-6', 5],
  ]) {
    trees[name] = join(buildDir, name);
    mkdirSync(join(trees[name], 'node_modules'), { recursive: true });
    age(trees[name], hours);
  }
  const deployState = join(root, 'deploy-state');
  const downloads = join(root, 'server-home/downloads');
  mkdirSync(join(deployState, 'logs'), { recursive: true });
  mkdirSync(downloads, { recursive: true });
  for (let i = 0; i < 32; i++) {
    const f = join(deployState, 'logs', `deploy-${i}.log`);
    writeFileSync(f, 'x');
    age(f, (i < 30 ? i : 40 * 24 + i) + 1);
  }
  const dl = downloads;
  writeFileSync(join(dl, 'android-latest.json'), JSON.stringify({ file: 'patch-ccccccc.apk' }));
  for (const [n, h] of [
    ['patch-ccccccc.apk', 1],
    ['patch-bbbbbbb.apk', 5],
    ['patch-aaaaaaa.apk', 9],
  ]) {
    writeFileSync(join(dl, n), 'x');
    age(join(dl, n), h);
  }
  writeFileSync(join(deployState, 'apk-incoming-old.apk'), 'x');
  age(join(deployState, 'apk-incoming-old.apk'), 5);
  const versionsDir = join(root, 'versions');
  for (const v of ['0.1.1', '0.1.2', '0.1.3']) {
    mkdirSync(join(versionsDir, v), { recursive: true });
    age(join(versionsDir, v), 72);
  }
  const currentLink = join(root, 'current');
  symlinkSync(join(versionsDir, '0.1.3'), currentLink);
  const smokeTmp = join(root, 'tmp');
  mkdirSync(join(smokeTmp, 'patch-smoke-old'), { recursive: true });
  age(join(smokeTmp, 'patch-smoke-old'), 5);

  const git = [];
  const run = (cmd, args) => {
    if (cmd === 'git') {
      git.push(args.join(' '));
      // Not a real repo: `worktree remove` fails, which sends the sweep to rm.
      if (args[1] === 'remove') throw new Error('not a working tree');
      return '';
    }
    if (cmd === 'rm') rmSync(args[1], { recursive: true, force: true });
    return '';
  };
  const opts = {
    buildDir,
    downloads,
    deployState,
    versionsDir,
    currentLink,
    smokeTmp,
    lockPath: join(buildDir, 'deploy.lock'),
    now: NOW,
    run,
    scan: () => [],
  };
  return { root, buildDir, trees, downloads, deployState, versionsDir, smokeTmp, git, opts };
}

test('a run sweeps old trees, logs, downloads, versions and temp, and prunes the registry', () => {
  const m = machine();
  const report = runCleanup({ ...m.opts, current: m.trees['tree-6-6'] });
  assert.deepEqual(report.errors, []);
  // Newest two besides this run's (tree-5-5, tree-4-4) survive, and this run's.
  for (const t of ['tree-4-4', 'tree-5-5', 'tree-6-6']) assert.ok(existsSync(m.trees[t]), t);
  for (const t of ['tree-1-1', 'tree-2-2', 'tree-3-3']) assert.ok(!existsSync(m.trees[t]), t);
  assert.equal(report.removed.trees, 3);
  assert.ok(m.git.includes('worktree prune'));
  assert.equal(report.removed.logs, 2);
  assert.ok(existsSync(join(m.downloads, 'patch-bbbbbbb.apk')), 'rollback APK kept');
  assert.ok(!existsSync(join(m.downloads, 'patch-aaaaaaa.apk')));
  assert.ok(!existsSync(join(m.versionsDir, '0.1.1')));
  assert.ok(existsSync(join(m.versionsDir, '0.1.2')), 'rollback version kept');
  assert.ok(!existsSync(join(m.deployState, 'apk-incoming-old.apk')));
  assert.ok(!existsSync(join(m.smokeTmp, 'patch-smoke-old')));
});

test('`git worktree prune` runs even when no tree was removed', () => {
  const m = machine();
  runCleanup({ ...m.opts, current: null, buildDir: join(m.root, 'nothing-here') });
  assert.ok(m.git.includes('worktree prune'));
});

test('never deletes a tree a running process is in (a detached follower)', () => {
  const m = machine();
  const follower = {
    pid: 1,
    args: ['node', `${m.trees['tree-2-2']}/scripts/ship.mjs`, '--follow-apk=abc'],
    refs: [`${m.trees['tree-2-2']}/scripts/ship.mjs`, m.trees['tree-2-2']],
  };
  runCleanup({ ...m.opts, current: m.trees['tree-6-6'], scan: () => [follower] });
  assert.ok(existsSync(m.trees['tree-2-2']));
  assert.ok(!existsSync(m.trees['tree-1-1']));
});

test('never deletes the tree a concurrent deploy holds the lock for', () => {
  const m = machine();
  writeFileSync(
    m.opts.lockPath,
    JSON.stringify({ pid: process.ppid, sha: 'x', startedAt: 0, tree: m.trees['tree-1-1'] }),
  );
  runCleanup({ ...m.opts, current: m.trees['tree-6-6'] });
  assert.ok(existsSync(m.trees['tree-1-1']), 'the lock holder is alive and building there');
  assert.ok(!existsSync(m.trees['tree-2-2']));
});

test('a live lock that names no tree stops the tree sweep entirely — and says so', () => {
  const m = machine();
  writeFileSync(m.opts.lockPath, JSON.stringify({ pid: process.ppid, sha: 'x', startedAt: 0 }));
  const report = runCleanup({ ...m.opts, current: m.trees['tree-6-6'] });
  for (const t of Object.values(m.trees)) assert.ok(existsSync(t));
  assert.match(report.errors.join(), /without naming its tree/);
});

test('if the process table cannot be read, nothing that needs it is touched', () => {
  const m = machine();
  const report = runCleanup({
    ...m.opts,
    current: m.trees['tree-6-6'],
    scan: () => {
      throw new Error('no /proc');
    },
  });
  for (const t of Object.values(m.trees)) assert.ok(existsSync(t));
  assert.ok(existsSync(join(m.versionsDir, '0.1.1')));
  assert.ok(existsSync(join(m.smokeTmp, 'patch-smoke-old')));
  assert.match(report.errors.join(), /process scan/);
  // Downloads are decided by manifests, not processes, and still go.
  assert.ok(!existsSync(join(m.downloads, 'patch-aaaaaaa.apk')));
});

test('a failure is reported in the result, never thrown — the deploy result stands', () => {
  const m = machine();
  const report = runCleanup({
    ...m.opts,
    current: m.trees['tree-6-6'],
    run: () => {
      throw new Error('EPERM');
    },
  });
  assert.ok(report.errors.length > 0);
  assert.match(formatCleanup(report), /^CLEANUP FAILED/);
  // The steps after the failing one still ran.
  assert.ok(!existsSync(join(m.versionsDir, '0.1.1')));
});

test('on the Mac (no box) there are no logs or downloads to touch, and the rest still runs', () => {
  const m = machine();
  const report = runCleanup({
    ...m.opts,
    downloads: null,
    deployState: null,
    current: m.trees['tree-6-6'],
  });
  assert.deepEqual(report.errors, []);
  assert.ok(existsSync(join(m.downloads, 'patch-aaaaaaa.apk')));
  assert.ok(existsSync(join(m.deployState, 'logs/deploy-31.log')));
  assert.ok(!existsSync(m.trees['tree-1-1']));
  assert.ok(!existsSync(join(m.smokeTmp, 'patch-smoke-old')));
});

test('APK outputs named by the caller go, and the tree they were in stays', () => {
  const m = machine();
  const tree = m.trees['tree-6-6'];
  mkdirSync(join(tree, 'apps/mobile/android/app/build'), { recursive: true });
  const report = runCleanup({ ...m.opts, current: tree, apkOutputs: [tree] });
  assert.equal(report.removed.apkOutputs, 1);
  assert.ok(!existsSync(join(tree, 'apps/mobile/android/app/build')));
  assert.ok(existsSync(join(tree, 'node_modules')));
});

test('a dry run removes nothing', () => {
  const m = machine();
  runCleanup({ ...m.opts, current: m.trees['tree-6-6'], dryRun: true });
  for (const t of Object.values(m.trees)) assert.ok(existsSync(t));
  assert.ok(existsSync(join(m.versionsDir, '0.1.1')));
  assert.ok(existsSync(join(m.downloads, 'patch-aaaaaaa.apk')));
});
