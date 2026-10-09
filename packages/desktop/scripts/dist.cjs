#!/usr/bin/env node
// Package the desktop shell at the monorepo's real version.
//
// package.json stays at a placeholder version because the effective one is
// derived per-commit (scripts/version.mjs). electron-builder is therefore handed
// the version explicitly via `extraMetadata`, which is what lands in the bundle's
// Info.plist AND in latest-mac.yml — the number electron-updater compares. The old
// pinned 0.0.0 could never compare as older than anything, so the updater was
// dead-on-arrival even where it was otherwise configured.
//
// Usage: node scripts/dist.cjs [--dir]     (--dir = unpacked, no dmg/zip)

const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const DESKTOP_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(DESKTOP_DIR, '..', '..');

const version = execFileSync('node', [path.join(REPO_ROOT, 'scripts', 'version.mjs')], {
  encoding: 'utf8',
}).trim();

// Stamp provenance into dist/ first so it is inside the packaged bundle.
execFileSync('node', [path.join(__dirname, 'write-build-info.cjs')], { stdio: 'inherit' });
// The server release and this Mac's host build ride inside the app (electron-builder.yml
// extraResources), so "On this Mac" works with nothing installed.
execFileSync('node', [path.join(__dirname, 'stage-resources.cjs')], { stdio: 'inherit' });
// Meeting mode's native audio helper, carried as Contents/Resources/bin/patch-audio.
execFileSync('node', [path.join(__dirname, 'build-native.cjs')], { stdio: 'inherit' });

const args = [
  '--mac',
  '--config',
  'electron-builder.yml',
  `-c.extraMetadata.version=${version}`,
  // Build the artifacts but never upload: publishing to the box is an rsync in
  // scripts/local/deliver.mjs, not electron-builder's job.
  '--publish',
  'never',
];
if (process.argv.includes('--dir')) args.push('--dir');

console.log(`[dist] packaging Patch ${version}${process.argv.includes('--dir') ? ' (--dir)' : ''}`);
execFileSync(path.join(DESKTOP_DIR, 'node_modules', '.bin', 'electron-builder'), args, {
  cwd: DESKTOP_DIR,
  stdio: 'inherit',
  env: process.env,
});

// The signing gate (spec/11 § Desktop code signing). Signing is what makes the
// shell's own update path work at all: Squirrel's designated requirement check
// rejects an unsigned bundle, so an unsigned build is one that installs and can
// then never update itself. A publish must refuse rather than produce it.
//
// A Developer ID is NOT required — any trusted code-signing identity works,
// self-signed included. What is refused is the ABSENCE of one.
if (!process.argv.includes('--skip-sign-check')) {
  // `release` is electron-builder.yml's `directories.output`. It used to be
  // dist-electron, and this gate kept the old name — so it condemned every build
  // as "nothing was built" while the bundle sat next door.
  const appPath = path.join(DESKTOP_DIR, 'release', 'mac-arm64', 'Patch.app');
  if (!require('node:fs').existsSync(appPath)) {
    console.error(`[dist] REFUSING: no bundle at ${appPath} — nothing was built`);
    process.exit(65);
  }
  // `codesign -dv` writes its report to STDERR and exits 0, so reading only the
  // return value of execFileSync gave an empty string — and an empty string has no
  // `Authority=`, so a correctly signed bundle was condemned as unsigned.
  const probe = spawnSync('codesign', ['-dv', '--verbose=2', appPath], { encoding: 'utf8' });
  const out = `${probe.stdout ?? ''}${probe.stderr ?? ''}`;
  // An ad-hoc signature (`Signature=adhoc`) is what electron-builder produces
  // with no identity. It passes `codesign --verify` and then fails the
  // updater's requirement check — the exact "looks signed, isn't" case.
  if (/Signature=adhoc/.test(out) || !/Authority=/.test(out)) {
    console.error(
      '[dist] REFUSING to publish an unsigned bundle.\n' +
        '  The shell update path verifies the signature, so an unsigned build could install ' +
        'and then never update itself.\n' +
        '  Set CSC_NAME to a trusted code-signing identity (self-signed is fine) and rebuild.\n' +
        `  codesign said:\n${out.trim()}`,
    );
    process.exit(66);
  }
  console.log(`[dist] signed: ${(/Authority=(.*)/.exec(out) ?? [])[1] ?? 'unknown identity'}`);
}
