#!/usr/bin/env node
// The ONE place a Patch build number comes from.
//
// Every layer (web SPA, server, host, desktop shell, Android app) has to agree
// on what "the version" is, otherwise the update panel can't tell you whether
// you're current — which is exactly the hole that let prod serve an 8-day-old
// SPA while /api/healthz cheerfully reported the newest commit.
//
// The scheme: `<major>.<minor>` comes from the root package.json (bump by hand
// when you want a new headline number), and the PATCH component is the commit
// count on HEAD. That makes every commit a strictly increasing semver with no
// manual bookkeeping — a hard requirement for electron-updater, which decides
// "is there an update?" by comparing semver, not git shas.
//
// Usage:
//   node scripts/version.mjs            → 0.1.317
//   node scripts/version.mjs --json     → {"version":…,"gitSha":…,"builtAt":…}
//
// NO FALLBACK: env overrides win (the Docker build injects them because the
// image has no .git), otherwise we derive from git, otherwise we throw. We never
// invent a version — a made-up number would silently defeat update comparison.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isMain } from './lib/is-main.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const git = (args) =>
  execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

/** `<major>.<minor>` from the root package.json — the hand-bumped headline. */
function headline() {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  const m = /^(\d+)\.(\d+)/.exec(pkg.version ?? '');
  if (!m) throw new Error(`root package.json version is not semver: ${pkg.version}`);
  return `${m[1]}.${m[2]}`;
}

/**
 * The build version. `PATCH_VERSION` wins so the Docker build (no .git in the
 * image) can inject the value the host computed.
 */
export function version() {
  const fromEnv = process.env.PATCH_VERSION;
  if (fromEnv) return fromEnv;
  return `${headline()}.${git(['rev-list', '--count', 'HEAD'])}`;
}

/** Short git sha of the build. `PATCH_GIT_SHA` wins, same reason as above. */
export function gitSha() {
  return process.env.PATCH_GIT_SHA || git(['rev-parse', '--short', 'HEAD']);
}

/**
 * When this build was produced. `PATCH_BUILT_AT` wins so a multi-stage build can
 * stamp one consistent instant across layers built seconds apart.
 */
export function builtAt() {
  return process.env.PATCH_BUILT_AT || new Date().toISOString();
}

/**
 * Newest commit touching SERVER-side code, as of HEAD.
 *
 * The web build publishes this so the server can answer "am I missing anything?"
 * without needing git. Comparing raw shas instead reports drift on every web-only
 * release — the shas differ, the code doesn't — which is a warning the user cannot
 * act on and shouldn't see. `PATCH_SERVER_SHA` wins for the same no-.git-in-image
 * reason as the others.
 */
export function serverSha() {
  if (process.env.PATCH_SERVER_SHA) return process.env.PATCH_SERVER_SHA;
  return git([
    'rev-list',
    '-1',
    '--abbrev-commit',
    'HEAD',
    '--',
    'packages/server',
    'packages/daemon',
    'packages/wire',
    'packages/auth',
  ]);
}

/** Everything a layer needs to describe itself to the update panel. */
export function buildInfo() {
  return { version: version(), gitSha: gitSha(), builtAt: builtAt(), serverSha: serverSha() };
}

// CLI: `--json` for scripts, bare for shell interpolation.
if (isMain(import.meta.url)) {
  process.stdout.write(
    process.argv.includes('--json') ? `${JSON.stringify(buildInfo())}\n` : `${version()}\n`,
  );
}
