// Build provenance for the SPA, read at CONFIG time (not runtime) so the values
// are baked into the bundle as literals.
//
// Shared by vite.config.ts (the real build) and vitest.config.ts (so the same
// `__PATCH_*__` globals exist under test). Without the vitest half, importing
// src/lib/buildInfo.ts in a test would throw ReferenceError — and we don't want a
// runtime fallback papering over a missing define, because a bundle that can't
// say what it is is the whole bug we're fixing.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export interface BuildInfo {
  version: string;
  gitSha: string;
  builtAt: string;
}

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Ask the monorepo's single source of truth (scripts/version.mjs). */
export function readBuildInfo(): BuildInfo {
  return JSON.parse(
    execFileSync('node', [join(REPO_ROOT, 'scripts', 'version.mjs'), '--json'], {
      encoding: 'utf8',
    }),
  ) as BuildInfo;
}

/** `define` entries injecting the provenance as compile-time literals. */
export function buildInfoDefines(info: BuildInfo): Record<string, string> {
  return {
    __PATCH_VERSION__: JSON.stringify(info.version),
    __PATCH_GIT_SHA__: JSON.stringify(info.gitSha),
    __PATCH_BUILT_AT__: JSON.stringify(info.builtAt),
  };
}
