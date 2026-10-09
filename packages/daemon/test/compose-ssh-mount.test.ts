// The daemon's git SSH identity (spec/02 § Terminal sessions).
//
// HISTORY — this file used to assert a blast radius that no longer exists in
// the form it was written for. A containerised host could only see what the
// production compose bind-mounted, so the rules worth pinning were: mount the
// ed25519 key and known_hosts READ-ONLY, and never mount the whole `~/.ssh`
// (that directory also holds `authorized_keys` — who may log into the box —
// and unrelated service keys).
//
// dc38968 moved the host to a native systemd user service. It now runs as the
// host user and therefore reads the REAL `~/.ssh` directly: the whole
// directory, read-write, with no mount to narrow it. The old assertions cannot
// fail any more — the host block they parsed is gone, so the volume list is
// empty and they pass vacuously, which is worse than not having them.
//
// The blast-radius question did not go away; it moved from compose to unix file
// permissions, which no file in this repo can assert. It is now a property of
// the host account. Tracking it needs a decision about how the host should be
// confined (a dedicated user, a narrowed key, or an ssh-agent socket), not a
// test over a YAML file.
//
// What IS still assertable, and what this file now guards: the host must not
// quietly reappear as a container. If it does, the mounts come back with it and
// the rules above start mattering again — at which point this file should be
// restored from git history rather than rewritten from memory.
//
// fe2cbc7 then deleted deploy/docker-compose.yml, the one file this read, and
// the suite started failing on ENOENT. The guard was never about that file
// though — a patch-daemon service reappearing in ANY compose file brings the
// mounts back with it. So it now scans every compose file in the repo, and
// fails loudly if it finds none rather than passing over an empty set.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function composeFilesIn(dir: string): string[] {
  return readdirSync(join(repoRoot, dir))
    .filter((f) => /^docker-compose.*\.ya?ml$/.test(f))
    .map((f) => join(dir, f));
}

const composeFiles = [...composeFilesIn('.'), ...composeFilesIn('deploy')];

describe('daemon compose — git SSH identity', () => {
  it('finds compose files to check', () => {
    // An empty set would make every assertion below pass vacuously, which is
    // the exact failure mode described above.
    expect(composeFiles.length).toBeGreaterThan(0);
  });

  it.each(composeFiles)('%s declares no patch-daemon service', (file) => {
    // Not a style preference: a patch-daemon block here would mean the daemon
    // is being run two ways at once, both claiming ~/.patch and the control
    // socket.
    expect(readFileSync(join(repoRoot, file), 'utf8')).not.toMatch(/^\s{2}patch-daemon:\s*$/m);
  });

  it.each(composeFiles)('%s mounts no SSH material', (file) => {
    // Neither a reverse proxy nor a test stack has any business holding the
    // box's git identity.
    expect(readFileSync(join(repoRoot, file), 'utf8')).not.toMatch(/\.ssh/);
  });
});
