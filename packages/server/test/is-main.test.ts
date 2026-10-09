// A CLI guard that is wrong about "am I the entrypoint?" fails SILENTLY: the
// body does not run, nothing is printed, and the exit code is 0. Every caller
// downstream then treats an empty string as a real answer.
//
// That is how a symlinked repo root took prod down. `/srv/patch` became a
// symlink into `projects/portfolio/projects/patch`; `node
// /srv/patch/scripts/version.mjs --json` printed nothing because argv[1] was
// the symlink path while `import.meta.url` was the realpath; `start-server.sh`
// exported an empty PATCH_VERSION; the server refused to boot. The shell's
// `set -euo pipefail` was no help — the command succeeded, it just said nothing.
//
// So the symlink case below is the regression test, not a curiosity.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMain } from '../../../scripts/lib/is-main.mjs';

const SCRIPT = realpathSync(resolve(__dirname, '../../../scripts/lib/is-main.mjs'));
const SCRIPT_URL = pathToFileURL(SCRIPT).href;

const originalArgv1 = process.argv[1];
const madeDirs: string[] = [];

afterEach(() => {
  process.argv[1] = originalArgv1;
  for (const d of madeDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  // realpath: macOS /var/folders tmpdirs are themselves symlinks, which would
  // otherwise make every case here look like the symlink case.
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'patch-is-main-')));
  madeDirs.push(d);
  return d;
}

describe('isMain', () => {
  it('is true when node was asked to run this very file', () => {
    process.argv[1] = SCRIPT;
    expect(isMain(SCRIPT_URL)).toBe(true);
  });

  it('is true when the file was reached through a symlink (the prod outage)', () => {
    const link = join(tempDir(), 'version-alias.mjs');
    symlinkSync(SCRIPT, link);
    process.argv[1] = link;

    // The naive comparison this helper replaces — proof the case is real and
    // that the fix is what makes the assertion below pass.
    expect(link === fileURLToPath(SCRIPT_URL)).toBe(false);

    expect(isMain(SCRIPT_URL)).toBe(true);
  });

  it('is true when a symlinked PARENT DIRECTORY is on the invoked path', () => {
    // The actual /srv/patch shape: the link is a directory further up, not the
    // script itself.
    const realParent = resolve(SCRIPT, '..');
    const linkedDir = join(tempDir(), 'linked-lib');
    symlinkSync(realParent, linkedDir);
    process.argv[1] = join(linkedDir, 'is-main.mjs');

    expect(isMain(SCRIPT_URL)).toBe(true);
  });

  it('is false for a different file', () => {
    process.argv[1] = __filename;
    expect(isMain(SCRIPT_URL)).toBe(false);
  });

  it('is false when there is no entry script (node -e, REPL)', () => {
    delete process.argv[1];
    expect(isMain(SCRIPT_URL)).toBe(false);
  });

  it('returns false rather than throwing when argv[1] does not exist', () => {
    process.argv[1] = join(tempDir(), 'was-deleted.mjs');
    expect(() => isMain(SCRIPT_URL)).not.toThrow();
    expect(isMain(SCRIPT_URL)).toBe(false);
  });
});
