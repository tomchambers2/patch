// Version, source commit and build instant surfaced by the host's /healthz,
// its WS hello and its `daemon.host` report (spec/11 § Version reporting).
//
// Three sources, in order, no fallbacks beyond them:
//   1. env (PATCH_VERSION / PATCH_GIT_SHA / PATCH_BUILT_AT) — the container
//      build injects these because the image has no .git.
//   2. `build-info.json` beside the bundled program — how an INSTALLED artifact
//      knows what it is on a machine with no git and no repo (spec/11 § Host
//      installation: "it reports its version").
//   3. dev only: scripts/version.mjs + `git rev-parse` from the checkout.
// In production with none of those, we throw rather than invent a number.

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { bundledBuildInfo } from './installPaths.js';

const here = dirname(fileURLToPath(import.meta.url));

const artifact = bundledBuildInfo();

/**
 * Dev-mode version, from the monorepo's single source of truth
 * (scripts/version.mjs). Was `packages/daemon/package.json`, a permanent `0.0.0`
 * placeholder — which made the host report 0.0.0 alongside layers reporting a
 * real version, so the update panel couldn't meaningfully compare them.
 */
function readWorkspaceVersion(): string {
  return execSync('node scripts/version.mjs', {
    cwd: join(here, '..', '..', '..'),
    encoding: 'utf8',
  }).trim();
}

function readGitSha(): string {
  return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
}

function resolveVersion(): string {
  const fromEnv = process.env.PATCH_VERSION;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  if (artifact) return artifact.version;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('PATCH_VERSION must be set in production (NO FALLBACKS).');
  }
  return readWorkspaceVersion();
}

function resolveGitSha(): string {
  const fromEnv = process.env.PATCH_GIT_SHA;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  if (artifact) return artifact.gitSha;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('PATCH_GIT_SHA must be set in production (NO FALLBACKS).');
  }
  try {
    return readGitSha();
  } catch (err) {
    throw new Error(
      `Cannot resolve git SHA for @patch/daemon (dev mode): ${(err as Error).message}`,
    );
  }
}

/**
 * When this build was produced. An artifact carries the instant it was built;
 * a dev process is being built right now, so it reports process start.
 */
function resolveBuiltAt(): string {
  const fromEnv = process.env.PATCH_BUILT_AT;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  if (artifact) return artifact.builtAt;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('PATCH_BUILT_AT must be set in production (NO FALLBACKS).');
  }
  return new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString();
}

export const VERSION = resolveVersion();
export const GIT_SHA = resolveGitSha();
export const BUILT_AT = resolveBuiltAt();
/** `<os>-<arch>` of the artifact this host was built for; undefined from source. */
export const BUILD_TARGET = artifact?.target;
