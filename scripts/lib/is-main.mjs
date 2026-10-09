// Is this module the process entrypoint?
//
// The obvious spelling — `process.argv[1] === fileURLToPath(import.meta.url)` —
// compares an UNRESOLVED path against a RESOLVED one. Node resolves a module's
// URL through symlinks; `process.argv[1]` keeps whatever path the caller typed.
// Invoke a script through a symlinked path and the two strings differ, the
// guard is silently false, and the CLI body never runs: no output, no error,
// exit 0.
//
// That is not hypothetical. `/srv/patch` became a symlink into
// `projects/portfolio/projects/patch`, so `node /srv/patch/scripts/version.mjs
// --json` printed nothing, `scripts/start-server.sh` exported an empty
// PATCH_VERSION, and the server refused to boot — correctly, since version.mjs
// has NO FALLBACK. `set -euo pipefail` did not catch it because the failure was
// empty output, not a non-zero exit. That is the whole failure mode: a guard
// that is wrong this way is silent, and everything downstream inherits an empty
// string instead of an error.
//
// Comparing realpaths on both sides is symlink-proof in either direction — the
// symlink may be on the invoked path, the module path, or both. An absent or
// unstattable argv[1] (`node -e`, a REPL, an entry deleted mid-run) means "not
// main" rather than throwing: a guard that crashes a module on import is worse
// than one that declines to run a CLI body.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * True when `importMetaUrl`'s module is the script node was asked to run.
 *
 * @param {string} importMetaUrl Always pass `import.meta.url` from the caller.
 * @returns {boolean}
 */
export function isMain(importMetaUrl) {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}
