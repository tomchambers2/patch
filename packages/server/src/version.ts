// Version + git SHA surfaced by /api/healthz.
//
// Production (NODE_ENV=production): both PATCH_VERSION and PATCH_GIT_SHA must
// be set by the Docker build — if either is missing, we crash loudly. NO
// FALLBACKS in prod.
//
// Development: derive BOTH from the working tree — the version via
// scripts/version.mjs (the same source every other layer uses) and the SHA via
// `git rev-parse --short HEAD`. This is a dev affordance, not a runtime fallback.

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Dev-mode version, from the monorepo's single source of truth
 * (scripts/version.mjs → `<major>.<minor>.<commit count>`).
 *
 * This used to read `packages/server/package.json`, whose version is a permanent
 * `0.0.0` placeholder — so in dev the server reported 0.0.0 while the web SPA
 * reported a real version, and the update panel showed the layers disagreeing at
 * the same commit. Every layer must derive its version the same way or comparing
 * them is meaningless. Production takes PATCH_VERSION from the Docker build and
 * never reaches here.
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
  if (process.env.NODE_ENV === 'production') {
    throw new Error('PATCH_VERSION must be set in production (NO FALLBACKS).');
  }
  return readWorkspaceVersion();
}

function resolveGitSha(): string {
  const fromEnv = process.env.PATCH_GIT_SHA;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('PATCH_GIT_SHA must be set in production (NO FALLBACKS).');
  }
  try {
    return readGitSha();
  } catch (err) {
    throw new Error(
      `Cannot resolve git SHA for @patch/server (dev mode): ${(err as Error).message}`,
    );
  }
}

/**
 * Newest commit touching server-side code as of this build.
 *
 * The web publishes the same value (`serverSha` in version.json) so the two can be
 * compared. Comparing it to GIT_SHA instead does not work: GIT_SHA is whatever
 * commit the image was built from, so a web-only release makes them differ while the
 * server code is identical — which reported drift the user could not act on.
 */
function resolveServerSha(): string | null {
  const fromEnv = process.env.PATCH_SERVER_SHA;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  if (process.env.NODE_ENV === 'production') return null; // unstamped build: report unknown
  try {
    return (
      execSync('node scripts/version.mjs --json', {
        cwd: join(here, '..', '..', '..'),
        encoding: 'utf8',
      })
        .trim()
        .split('serverSha":"')[1]
        ?.split('"')[0] ?? null
    );
  } catch {
    return null;
  }
}

export const VERSION = resolveVersion();
export const GIT_SHA = resolveGitSha();
export const SERVER_SHA = resolveServerSha();
