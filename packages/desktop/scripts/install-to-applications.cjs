#!/usr/bin/env node
// Copy the freshly-built Patch.app into /Applications. This is the DELIBERATE
// local install (`pnpm install:app`, and `pnpm dist:dry` for an unpacked dev
// build) — it is deliberately NOT wired to `pnpm dist`, because a deploy must
// not kill the shell the user is sitting in front of. A deployed build reaches
// this Mac over the update feed instead, which relaunches on install.
//
// macOS only; no-op (with a notice) elsewhere.
//
// NO FALLBACK: if the expected .app isn't where electron-builder puts it, we
// fail loudly rather than silently leaving a stale app in /Applications. Same
// for a running instance that won't quit — deleting a bundle out from under a
// live process crashes it and leaves a half-installed app behind.

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (os.platform() !== 'darwin') {
  console.log('[install-to-applications] not macOS — skipping');
  process.exit(0);
}

const releaseDir = path.resolve(__dirname, '..', 'release');
// electron-builder emits the unpacked .app under release/mac-<arch>/Patch.app
// (mac-arm64 on Apple Silicon, mac for x64). Pick whichever exists, preferring
// the host arch.
const arch = process.arch === 'arm64' ? 'mac-arm64' : 'mac';
const candidates = [
  path.join(releaseDir, arch, 'Patch.app'),
  path.join(releaseDir, 'mac-arm64', 'Patch.app'),
  path.join(releaseDir, 'mac', 'Patch.app'),
];
const src = candidates.find((p) => fs.existsSync(p));
if (!src) {
  console.error(
    `[install-to-applications] no built Patch.app found in ${releaseDir} ` +
      `(looked for: ${candidates.join(', ')})`,
  );
  process.exit(1);
}

const dest = '/Applications/Patch.app';

// Quit a running instance so the copy doesn't clobber an in-use bundle.
// `quit app` only DISPATCHES the quit; macOS termination is asynchronous, so
// deleting the bundle straight afterwards races a process that is still
// running out of it. Wait for the process to actually go away.
const runningPids = () => {
  const probe = spawnSync('pgrep', ['-f', `^${dest}/Contents/MacOS/Patch`], { encoding: 'utf8' });
  return (probe.stdout ?? '').split('\n').filter((l) => l.trim() !== '');
};

if (runningPids().length > 0) {
  try {
    execFileSync('osascript', ['-e', 'quit app "Patch"'], { stdio: 'ignore' });
  } catch {
    // No such app registered with the OS — the pgrep hit is stale or the
    // bundle isn't launchable. The wait below decides whether that matters.
  }
  const deadline = Date.now() + 15_000;
  while (runningPids().length > 0) {
    if (Date.now() > deadline) {
      console.error(
        `[install-to-applications] REFUSING: ${dest} is still running 15s after a quit was ` +
          `requested (pids ${runningPids().join(', ')}). Replacing a live bundle crashes it. ` +
          `Quit Patch and re-run.`,
      );
      process.exit(1);
    }
    execFileSync('sleep', ['0.25']);
  }
}

fs.rmSync(dest, { recursive: true, force: true });
execFileSync('ditto', [src, dest]);

// Stamp the installed bundle with the git sha it was built from, so
// scripts/deploy.sh can tell whether the installed app is stale relative to
// HEAD (a COMMITTED desktop-shell change is invisible to a working-tree diff).
// Best-effort: a missing sha just makes deploy.sh treat the app as stale and
// rebuild, which is the safe direction.
try {
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
  }).trim();
  fs.writeFileSync(path.join(dest, 'Contents', 'Resources', 'patch-build-sha.txt'), sha + '\n');
  console.log(`[install-to-applications] stamped build sha ${sha.slice(0, 7)}`);
} catch {
  // No git / detached — deploy.sh will just rebuild next time (safe default).
}

console.log(`[install-to-applications] installed ${src} -> ${dest}`);
