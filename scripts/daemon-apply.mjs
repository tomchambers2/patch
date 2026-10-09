// What `patch hosts update --json` told the deploy, in words a deploy log can use.
//
// The host's own self-update poll and the deploy's explicit update call race to
// apply the same build. The loser gets {"error":"no_update_available"}, which is
// harmless when the host is already on the shipped version and a real failure
// when it is not. Deciding which is the job of the caller, who can ask the host
// its version; this only reads the output.

/** 'applied' | 'deferred' | 'not-newer' | 'failed' — never throws on odd output. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * argv for running the @patch/cli from this checkout. A bare `patch` on PATH is
 * not that CLI on the box — it resolves to GNU patch, which rejects `--json` —
 * so the deploy names the built entry point instead. Throws if it isn't built.
 */
export function patchCliCommand(repo, args) {
  const entry = join(repo, 'packages/cli/dist/index.js');
  if (!existsSync(entry)) throw new Error(`@patch/cli is not built: ${entry} is missing`);
  return { cmd: process.execPath, args: [entry, ...args] };
}

export function classifyUpdate(stdout, exitCode) {
  let parsed;
  try {
    parsed = JSON.parse(String(stdout ?? '').trim());
  } catch {
    parsed = undefined;
  }
  if (parsed?.error === 'no_update_available') return 'not-newer';
  // The host answers a request made while turns are running with HTTP 202
  // and `deferred: true` — accepted, but not applied until they finish
  // (`requestUpdate` in selfUpdate.ts). That carries no `error`, so checked
  // after `applied` it read as a clean, already-finished update: the deploy
  // declared success on a restart that had not started, then failed the
  // version check moments later for a reason its own log never named.
  if (parsed?.deferred === true) return 'deferred';
  if (exitCode === 0 && !parsed?.error) return 'applied';
  return 'failed';
}

/** The one line the deploy log carries for an update call's outcome. */
export function updateLine(kind, expectedVersion, stdout) {
  if (kind === 'applied') return `host → update accepted, restarting onto ${expectedVersion}`;
  if (kind === 'deferred') {
    let parsed;
    try {
      parsed = JSON.parse(String(stdout ?? '').trim());
    } catch {
      parsed = undefined;
    }
    return `host → ${parsed?.message ?? `update to ${expectedVersion} deferred until running turns finish`}`;
  }
  if (kind === 'not-newer') {
    return `host → no update to apply (self-update may have got to ${expectedVersion} first); checking its version`;
  }
  return `host → update call did not complete (${String(stdout ?? '').trim() || 'no output'}); the host restarting under it looks the same, so checking its version`;
}
