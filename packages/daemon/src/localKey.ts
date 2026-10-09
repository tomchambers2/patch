// The host's local control key (spec/02 § Control IPC, spec/10 § The
// authority of a turn).
//
// A turn runs with the host user's full authority, so the control socket is an
// entry point to that authority. Same-user/same-machine is the real boundary —
// the socket is `0600` — and this key closes the remaining case: another
// process running as the same user reaching the socket without having been
// started by the host.
//
// THE HOST IS THE ONLY PARTY THAT MINTS IT. It is not configuration: a key
// supplied from outside would outlive restarts, be readable wherever that
// config lives, and be shared by anything that could read it — none of which is
// true of a value generated on each start. So there is no env var for it. The
// host generates one on every start, writes it beside the socket at
// `~/.patch/local.key` mode 0600, passes the current value to the children it
// launches, and every other caller on that machine reads the file. The fixed
// path under `~/.patch` is what makes it findable without a discovery step.
//
// Rotating on each start is deliberate: a stale key from a previous run stops
// working the moment the host it belonged to is gone.

import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** Where the key lives, beside the socket, under the host user's own HOME. */
export function localKeyPath(patchHome: string): string {
  return join(patchHome, 'local.key');
}

/**
 * Mint this run's key and persist it at `<patchHome>/local.key` (mode 0600),
 * replacing whatever the previous run left. Returns the value to hand to
 * children and to the control server.
 *
 * The write is atomic-by-replacement via a temp file in the same directory, so
 * a reader never sees a half-written key: a CLI invoked mid-rotation either
 * reads the old value (and is rejected, loudly) or the new one, never a
 * truncated string that would fail in a confusing way.
 */
export function mintLocalKey(patchHome: string): string {
  const key = randomBytes(32).toString('base64url');
  const path = localKeyPath(patchHome);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const dir = dirname(path);
  const base = basename(path);
  // Temp files from earlier runs that died between create and rename. Named by
  // pid, so each failed start would otherwise leave a new one forever.
  for (const name of readdirSync(dir)) {
    if (name.startsWith(`${base}.`) && name.endsWith('.tmp'))
      rmSync(join(dir, name), { force: true });
  }
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, key, { mode: 0o600 });
    // rename() over an existing file is atomic on POSIX, so there is no window
    // where the file is absent.
    renameSync(tmp, path);
  } catch (err) {
    // Never leave the temp behind, but the failure itself stays loud.
    try {
      rmSync(tmp, { force: true });
    } catch {
      // cleanup failing must not mask the original error
    }
    throw err;
  }
  chmodSync(path, 0o600);
  return key;
}
