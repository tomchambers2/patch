#!/usr/bin/env node
// Every deploy cleans up after itself, on every machine it used.
//
//   node scripts/deploy-cleanup.mjs [--current=<tree>] [--apk-outputs=<tree>] [--downloads=DIR] [--deploy-state=DIR] [--dry-run]
//
// ship.mjs runs this at the end of every run — success OR failure — on the box,
// on the Mac at the end of each sub-step it is delegated (desktop, smoke), and
// on the Mac over ssh after an `--apk-local` build has been copied back. It
// exists because nothing did: the box's / reached 97% (5 GB free) with ~36
// build trees of several GB each sitting in ~/.patch-deploy-build, and a box
// APK build (`--apk-here`) leaves gigabytes of gradle and CMake output behind.
//
// What it removes, and what it never does:
//
//   build trees   ~/.patch-deploy-build/tree-*: build-tree.mjs treesToPrune, the
//                 ONE policy — keep the newest 2 and anything younger than 2h —
//                 and never this run's tree, the tree a live deploy holds the
//                 deploy lock for, or any tree a running process stands in,
//                 runs from or holds a file open under (a detached APK follower
//                 runs from its tree for hours). Then `git worktree prune`, so
//                 no registration outlives its directory.
//   APK outputs   the android build dirs of a tree that just built an APK
//                 (`--apk-outputs`), once the APK has been published. The tree
//                 keeps its node_modules.
//   logs          <deploy-state>/logs/*.log: kept if among the newest 30 or
//                 younger than 30 days, and never one a process holds open.
//   downloads     <downloads> via prune-downloads.mjs: whatever a
//                 live manifest points at, plus the build before it.
//   host        ~/.patch/versions/*: the version ~/.patch/current points at,
//                 anything newer (an install in flight), the newest older one
//                 (rollback), anything younger than 2h and anything in use.
//   temp          <deploy-state>/apk-incoming-*.apk and $TMPDIR/patch-smoke-*,
//                 older than 2h and not in use.
//
// It reports one line: what it removed and what that freed on /. A failure is
// reported loudly and NEVER turns a successful ship into a failed one — the
// artifacts are published and the surfaces are live; a directory that would not
// delete is a thing to fix, not a reason to call the deploy broken. It does not
// swallow the failure either: the line says CLEANUP FAILED and why.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync, rmSync, statfsSync, statSync } from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pruneBuildTrees } from './build-tree.mjs';
import { lockedTree } from './deploy-lock.mjs';
import { inUseChecker, scanProcesses } from './lib/in-use.mjs';
import { isMain } from './lib/is-main.mjs';
import { pruneDownloads } from './prune-downloads.mjs';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export const LOG_POLICY = { keep: 30, maxAgeMs: 30 * DAY };
/** Temp files and host versions: nothing younger than this is touched. */
export const STALE_MS = 2 * HOUR;

// --- policy (pure) ----------------------------------------------------------

/**
 * Deploy logs to delete. A log survives if it is among the `keep` newest OR
 * younger than `maxAgeMs` — both, so a quiet month still leaves the last thirty
 * runs to read and a busy week is never cut to thirty — and never while a
 * process has it open (a follower writes its log for hours).
 */
export function logsToPrune({
  entries,
  now,
  keep = LOG_POLICY.keep,
  maxAgeMs = LOG_POLICY.maxAgeMs,
  inUse = () => false,
}) {
  return entries
    .filter((e) => e.name.endsWith('.log'))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(keep)
    .filter((e) => now - e.mtimeMs >= maxAgeMs)
    .filter((e) => !inUse(e.path));
}

/** Compare dotted numeric versions; null when either is not one. */
function compareVersions(a, b) {
  const pa = a.split('.');
  const pb = b.split('.');
  if (![...pa, ...pb].every((p) => /^\d+$/.test(p))) return null;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = Number(pa[i] ?? 0) - Number(pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Installed host versions to delete. Keeps the one `current` resolves to,
 * everything NEWER than it (an install lays its version down before it repoints
 * `current`), the newest older one (what a rollback goes back to), anything not
 * named like a version, anything younger than `minAgeMs`, and anything in use.
 * No current ⇒ no definition of what is live ⇒ nothing is removed.
 *
 * `current` is the NAME of the live version (the basename `current` resolves to).
 */
export function versionsToPrune({
  entries,
  current,
  now,
  minAgeMs = STALE_MS,
  inUse = () => false,
}) {
  const live = entries.find((e) => e.name === current);
  if (!live) return [];
  const older = entries
    .filter((e) => e !== live && compareVersions(e.name, live.name) !== null)
    .filter((e) => compareVersions(e.name, live.name) < 0)
    .sort((a, b) => compareVersions(b.name, a.name));
  return older
    .slice(1)
    .filter((e) => now - e.mtimeMs >= minAgeMs)
    .filter((e) => !inUse(e.path));
}

/** Leftover temp files/dirs matching `pattern`, stale and not in use. */
export function staleToPrune({ entries, pattern, now, minAgeMs = STALE_MS, inUse = () => false }) {
  return entries
    .filter((e) => pattern.test(e.name))
    .filter((e) => now - e.mtimeMs >= minAgeMs)
    .filter((e) => !inUse(e.path));
}

/**
 * The directories an Android release build writes into `tree`, which are dead
 * the moment the APK is published: the app's gradle/CMake output, and each
 * native module's own `android/build` and `.cxx` inside node_modules (the
 * biggest single one, expo-modules-core, is ~0.75 GB). node_modules itself
 * stays — it is what keeps the next install warm.
 */
export function apkOutputDirs(tree, { readdir = safeReaddir, exists = existsSync } = {}) {
  const android = `${tree}/apps/mobile/android`;
  const dirs = [
    `${android}/app/build`,
    `${android}/app/.cxx`,
    `${android}/build`,
    `${android}/.gradle`,
  ];
  const store = `${tree}/node_modules/.pnpm`;
  for (const entry of readdir(store)) {
    const nm = `${store}/${entry}/node_modules`;
    for (const name of readdir(nm)) {
      const pkgs = name.startsWith('@')
        ? readdir(`${nm}/${name}`).map((n) => `${nm}/${name}/${n}`)
        : [`${nm}/${name}`];
      for (const pkg of pkgs) {
        for (const out of ['android/build', 'android/.cxx']) dirs.push(`${pkg}/${out}`);
      }
    }
  }
  return dirs.filter((d) => exists(d));
}

/** The one line a deploy prints about its cleanup. */
export function formatCleanup(report, host = hostname()) {
  const r = report.removed;
  const parts = [
    [r.trees, 'build tree'],
    [r.logs, 'log'],
    [r.downloads, 'download'],
    [r.versions, 'host version'],
    [r.temp, 'temp file'],
    [r.apkOutputs, 'APK build dir'],
  ]
    .filter(([n]) => n > 0)
    .map(([n, what]) => `${n} ${what}${n === 1 ? '' : 's'}`);
  const gb = (b) => `${(b / 1e9).toFixed(2)} GB`;
  const disk =
    report.after != null ? `; disk ${report.usedPct}% used, ${gb(report.after)} free` : '';
  const daemons =
    report.buildDaemons > 0 ? `; ${report.buildDaemons} gradle/kotlin daemon(s) still running` : '';
  const what = parts.length ? parts.join(', ') : 'nothing to remove';
  const line = `cleanup on ${host}: freed ${gb(Math.max(0, report.freed))} (${what})${disk}${daemons}`;
  if (report.errors.length === 0) return line;
  return `CLEANUP FAILED on ${host} (the deploy result stands): ${report.errors.join('; ')} — ${line}`;
}

// --- doing it ---------------------------------------------------------------

function safeReaddir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function entriesOf(dir) {
  const out = [];
  for (const name of safeReaddir(dir)) {
    const path = join(dir, name);
    try {
      out.push({ name, path, mtimeMs: statSync(path).mtimeMs });
    } catch {
      /* gone mid-scan */
    }
  }
  return out;
}

// The home directory's filesystem: `/` on the box, and on the Mac the data
// volume (statfs of the Mac's `/` reports the sealed system volume instead).
function diskFree(path = homedir()) {
  const s = statfsSync(path);
  const used = s.blocks - s.bfree;
  return { free: s.bavail * s.bsize, usedPct: Math.round((used / (used + s.bavail)) * 100) };
}

function realpathOr(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Clean up this machine. Never throws: every step's failure lands in
 * `report.errors`, and the steps after it still run.
 *
 * `downloads` (the live server's update channel) and `deployState` (the
 * deploy's logs and APKs in transit) are set on the box and null on the Mac;
 * the logs, downloads and incoming-APK sweeps only exist there.
 */
export function runCleanup({
  buildDir = `${homedir()}/.patch-deploy-build`,
  current = null,
  lockPath = `${buildDir}/deploy.lock`,
  downloads = null,
  deployState = null,
  apkOutputs = [],
  versionsDir = `${homedir()}/.patch/versions`,
  currentLink = `${homedir()}/.patch/current`,
  smokeTmp = tmpdir(),
  repo = process.cwd(),
  now = Date.now(),
  dryRun = false,
  log = () => {},
  scan = scanProcesses,
  run = (cmd, args) =>
    execFileSync(cmd, args, { encoding: 'utf8', cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] }),
} = {}) {
  const errors = [];
  const removed = { trees: 0, logs: 0, downloads: 0, versions: 0, temp: 0, apkOutputs: 0 };
  let before = null;
  try {
    before = diskFree();
  } catch {
    /* reported as unknown, below */
  }
  const rm = (path) => {
    log(`cleanup: ${dryRun ? 'would remove' : 'removing'} ${path}`);
    if (!dryRun) rmSync(path, { recursive: true, force: true });
  };
  const step = (name, fn) => {
    try {
      fn();
    } catch (err) {
      errors.push(`${name}: ${String(err.message).split('\n')[0]}`);
    }
  };

  // APK build output first: it is named by the caller, which has just published
  // what it built, and it is the biggest single thing a build leaves.
  for (const tree of apkOutputs) {
    step(`APK build output in ${tree}`, () => {
      for (const dir of apkOutputDirs(tree)) {
        rm(dir);
        removed.apkOutputs++;
      }
    });
  }

  // Who is standing where. Without it, nothing that needs the in-use rule is
  // touched: "could not look" must never read as "nobody is there".
  let inUse = null;
  let buildDaemons = 0;
  step('process scan (nothing in use was swept)', () => {
    const procs = scan();
    inUse = inUseChecker(procs.flatMap((p) => p.refs));
    buildDaemons = procs.filter((p) =>
      p.args.some((a) => /GradleDaemon|KotlinCompileDaemon/.test(a)),
    ).length;
  });

  if (inUse) {
    step('build trees', () => {
      const lock = lockedTree(lockPath);
      if (lock.held && !lock.tree) {
        throw new Error(
          `deploy ${lock.pid} holds the lock without naming its tree — not sweeping any tree`,
        );
      }
      const failed = [];
      const gone = pruneBuildTrees({
        dir: buildDir,
        current,
        now,
        inUse,
        protect: lock.tree ? [lock.tree, realpathOr(lock.tree)] : [],
        run: dryRun ? () => '' : run,
        log: dryRun ? (m) => log(m.replace('removed', 'would remove')) : log,
        onError: (t, err) => failed.push(`${t.name} (${err.message.split('\n')[0]})`),
      });
      removed.trees = gone.length - failed.length;
      if (failed.length) throw new Error(`could not remove ${failed.join(', ')}`);
    });
  }
  // Always, not only after a removal: a tree deleted by hand, or by the Mac's
  // own sweep, leaves a registration behind that nothing else clears.
  step('git worktree prune', () => {
    if (!dryRun) run('git', ['worktree', 'prune']);
  });

  step('downloads', () => {
    if (!downloads) return;
    let n = 0;
    pruneDownloads(downloads, {
      dryRun,
      log: (m) => {
        n++;
        log(`cleanup: downloads: ${m}`);
      },
    });
    removed.downloads = n;
  });

  if (inUse) {
    step('deploy logs', () => {
      if (!deployState) return;
      for (const e of logsToPrune({ entries: entriesOf(`${deployState}/logs`), now, inUse })) {
        rm(e.path);
        removed.logs++;
      }
    });
    step('host versions', () => {
      if (!existsSync(currentLink)) return;
      const target = realpathSync(currentLink);
      // `current` pointing anywhere but into versionsDir is not a layout this
      // knows, so it defines nothing here.
      if (dirname(target) !== realpathOr(versionsDir)) return;
      const current = basename(target);
      for (const e of versionsToPrune({ entries: entriesOf(versionsDir), current, now, inUse })) {
        rm(e.path);
        removed.versions++;
      }
    });
    step('temp files', () => {
      const stale = [
        ...(deployState
          ? staleToPrune({
              entries: entriesOf(deployState),
              pattern: /^apk-incoming-.+\.apk$/,
              now,
              inUse,
            })
          : []),
        ...staleToPrune({ entries: entriesOf(smokeTmp), pattern: /^patch-smoke-/, now, inUse }),
      ];
      for (const e of stale) {
        rm(e.path);
        removed.temp++;
      }
    });
  }

  let after = null;
  let usedPct = null;
  try {
    ({ free: after, usedPct } = diskFree());
  } catch {
    /* unknown */
  }
  const freed = before && after != null ? after - before.free : 0;
  return { removed, errors, freed, after, usedPct, buildDaemons };
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const val = (n) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  const report = runCleanup({
    current: val('current') ?? null,
    downloads: val('downloads') ?? null,
    deployState: val('deploy-state') ?? null,
    apkOutputs: val('apk-outputs') ? [val('apk-outputs')] : [],
    dryRun: args.includes('--dry-run'),
    log: (m) => process.stderr.write(`${m}\n`),
  });
  process.stdout.write(`${formatCleanup(report)}\n`);
  process.exit(report.errors.length ? 1 : 0);
}
