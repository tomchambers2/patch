// Group H1 (spec/11-deployment.md): the production deploy artifacts encode a
// hard contract that the spec calls out explicitly. These are static files
// (no YAML parser in the dep tree on purpose — the contract is about exact
// content), so we assert them by reading the checked-in files and matching the
// structural invariants:
//
//   - (docker-compose.yml removed: dc38968 moved server+daemon to systemd, and
//     the Caddy-only remainder existed solely to serve an in-repo production
//     site block prod never used -- prod Caddy lives on the box at /etc/caddy.)
//     patch-server runs as a native systemd user service from an installed
//     RELEASE (scripts/build-server.mjs), never from a git checkout.
//   - packages/server/release/patch-server: the launcher. Points the server at
//     the install home's data/downloads and the release's own web/, stamps the
//     build from the release's build-info.json, and never sets
//     ANTHROPIC_API_KEY (spec/10-auth.md "Claude OAuth — non-negotiable").
//   - packages/server/release/install: the installer every deploy runs.
//   - ANTHROPIC_API_KEY MUST NOT be assigned in any production deploy artifact.
//   - Caddyfile: reverse-proxies /api + /ws to patch-server:3000 and serves the
//     SPA at /app.
//   - package.json: `deploy` runs scripts/ship.mjs, which installs a release
//     (restarting the systemd unit); `build:desktop` / `build:android` produce the app artifacts.
//   - backup.sh + install-backup-cron.sh: restic nightly cron on /data.
//   - fetch-models.sh: present/missing-aware model fetch with --check.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const read = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8');

const caddyfile = read('Caddyfile');
const launcher = read('packages/server/release/patch-server');
const installer = read('packages/server/release/install');

describe('H1 deploy artifacts — the server release launcher', () => {
  // What the systemd unit execs. The unit is written by the installer, outside
  // the repo; the launcher and installer are the version-controlled contract.
  it('runs the release it sits in, resolved through symlinks', () => {
    expect(launcher).toMatch(/pwd -P/);
    expect(launcher).toMatch(/\$\{REL\}\/server\/dist\/index\.js/);
  });

  it('points the server at the install home, never a checkout', () => {
    expect(launcher).toMatch(/PATCH_DATA_DIR="\$\{PATCH_SERVER_HOME\}\/data"/);
    expect(launcher).toMatch(/PATCH_DOWNLOADS_DIR="\$\{PATCH_SERVER_HOME\}\/downloads"/);
    expect(launcher).toMatch(/PATCH_WEB_DIST="\$\{REL\}\/web"/);
    expect(launcher.replace(/^\s*#.*$/gm, '')).not.toMatch(/deploy\//);
  });

  it('stamps the build from the release, not from git', () => {
    expect(launcher).toMatch(/build-info\.json/);
    expect(launcher).toMatch(/PATCH_VERSION=/);
    expect(launcher).toMatch(/PATCH_GIT_SHA=/);
    const code = launcher.replace(/^\s*#.*$/gm, '');
    expect(code).not.toMatch(/\bgit\b/);
  });

  it('never sets ANTHROPIC_API_KEY (spec/10 OAuth)', () => {
    // Claude Code auth is OAuth; the host additionally strips the key at
    // query() time. The server's env must not reintroduce it.
    expect(launcher).not.toMatch(/^\s*(export\s+)?ANTHROPIC_API_KEY\s*=/m);
    expect(installer).not.toMatch(/ANTHROPIC_API_KEY/);
  });
});

// The Caddyfile now configures ONLY the local test stack. Production routing
// lives on the Hetzner host at /etc/caddy/Caddyfile, outside this repo, so
// there is nothing here to assert about it -- and asserting the old in-repo
// `patch.tomchambers.me` block was actively harmful: it described a narrower
// set of proxied paths than prod really serves, and was read as prod routing
// when diagnosing the Google OAuth redirect_uri_mismatch.
describe('H1 deploy artifacts — Caddyfile (test stack)', () => {
  it('reverse-proxies /api and /ws to the test stack server', () => {
    expect(caddyfile).toMatch(/handle \/api\/\*[\s\S]*?reverse_proxy server:3000/);
    expect(caddyfile).toMatch(/handle \/ws[\s\S]*?reverse_proxy server:3000/);
  });

  it('serves the SPA at /app via the test stack server', () => {
    expect(caddyfile).toMatch(/handle \/app\*[\s\S]*?reverse_proxy server:3000/);
  });

  it('does not reintroduce an in-repo production site block', () => {
    // The hostname may appear in comments (the header explains where prod
    // actually lives); what must not come back is a real site block for it, or
    // the patch-server upstream that only the removed prod block used.
    expect(caddyfile).not.toMatch(/^[^#\n]*patch\.tomchambers\.me/m);
    expect(caddyfile).not.toMatch(/reverse_proxy\s+patch-server:/);
  });

  it('the web delivery verifies the entry bundle LOADS, not just that index.html names it', () => {
    // 2026-08-16: the box served an index.html naming the right hash while the
    // bundle itself came back as 200 text/html. The name comparison passed, the
    // health check passed, and the app was a blank window. A delivery that only
    // compares names cannot tell a shipped app from a broken one, so the check
    // that fetches the bundle and asserts its content-type must stay.
    //
    // It used to live in scripts/local/deliver.mjs, which is GITIGNORED — so this
    // assertion could only pass on a machine that happened to have that private
    // file, and threw ENOENT everywhere else. The check now lives in the shipped
    // ship.mjs, which every checkout has.
    const ship = read('scripts/ship.mjs');
    expect(ship).toMatch(/content_type/);
    expect(ship).toMatch(/javascript/);
  });

  it('one failing surface does not strand the others, and still fails the run', () => {
    // 2026-08-28: the Mac's login keychain grew a password, so desktop() threw.
    // It is called first, deliberately, and the whole deploy was one try block —
    // so 35 commits including the mobile cold-start and new-chat fixes sat
    // unshipped for a day behind a surface that shares nothing with them.
    // Each surface now runs isolated; the run still exits non-zero and pushes a
    // high-priority failure naming every surface that broke.
    const ship = read('scripts/ship.mjs');
    // Every independently-shippable surface goes through the isolating wrapper.
    for (const name of ['desktop', 'daemon', 'ota', 'apk']) {
      expect(ship).toMatch(new RegExp(`surface\\('${name}'`));
    }
    // web and server ship as one release, under whichever of the two was asked for.
    expect(ship).toMatch(
      /surface\(want\('server'\) \? 'server' : 'web', \(\) => release\(info\)\)/,
    );
    // ...which records the failure rather than rethrowing it.
    expect(ship).toMatch(/function surface\([\s\S]*?catch \(err\) \{[\s\S]*?failures\.push/);
    expect(ship).not.toMatch(/function surface\([\s\S]*?catch \(err\) \{[\s\S]*?throw/);
    // A partial ship is still a failed deploy: loud, and non-zero.
    expect(ship).toMatch(/if \(failures\.length\)[\s\S]*?process\.exit\(1\)/);
    expect(ship).toMatch(/notify\('Patch deploy FAILED'/);
  });
});

describe('H1 deploy artifacts — deploy command + backup scripts', () => {
  it('`pnpm run deploy` ships via ship.mjs, which installs a release', () => {
    // `deploy` ships every surface (web, server, host, OTA, APK, desktop).
    // The server step builds a release and runs its installer — the same path
    // a self-hoster uses — which restarts the systemd unit.
    const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
    expect(scripts.deploy ?? '').toMatch(/scripts\/ship\.mjs/);
    // deploy:server was the docker-compose path; dc38968 deleted it with the
    // containers. Its return would mean two ways to ship the server.
    expect(scripts['deploy:server']).toBeUndefined();

    const program = read('scripts/ship.mjs');
    expect(program).toMatch(/buildServerRelease/);
    expect(program).toMatch(/\$\{dir\}\/install/);
    expect(installer).toMatch(/\$\{SYSTEMCTL\} restart patch-server/);
    expect(installer).toMatch(/SYSTEMCTL="systemctl --user"/);
    // It must verify what it shipped rather than assume the restart worked.
    expect(installer).toMatch(/api\/healthz/);
    expect(program).toMatch(/api\/healthz/);
  });

  it('exposes the app builds (desktop + android) as package scripts', () => {
    const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
    expect(scripts['build:desktop'] ?? '').toMatch(/@patch\/desktop/);
    expect(scripts['build:android'] ?? '').toMatch(/assembleRelease/);
  });

  it('backup.sh runs restic against the data dir and requires repo + password', () => {
    const backup = read('deploy/backup.sh');
    expect(backup).toMatch(/set -euo pipefail/);
    expect(backup).toMatch(/RESTIC_REPOSITORY/);
    expect(backup).toMatch(/RESTIC_PASSWORD/);
    expect(backup).toMatch(/restic backup/);
  });

  it('install-backup-cron.sh installs a NIGHTLY cron (runs once a day)', () => {
    const cron = read('deploy/install-backup-cron.sh');
    expect(cron).toMatch(/crontab/);
    // Default schedule is a single daily fire: "M H * * *".
    const m = cron.match(/PATCH_BACKUP_SCHEDULE:-([^}]+)\}/);
    expect(m).not.toBeNull();
    const schedule = m![1]!.trim();
    const fields = schedule.split(/\s+/);
    expect(fields).toHaveLength(5);
    // day-of-month, month, day-of-week all wildcards → fires every day (nightly).
    expect(fields[2]).toBe('*');
    expect(fields[3]).toBe('*');
    expect(fields[4]).toBe('*');
  });

  it('fetch-models.sh is present/missing aware (has a --check mode)', () => {
    const fetch = read('scripts/fetch-models.sh');
    expect(fetch).toMatch(/--check/);
    expect(fetch).toMatch(/kokoro/i);
    expect(fetch).toMatch(/medium\.en/);
  });
});

// The build context is what `docker build` copies into the builder before a
// single instruction runs. On the box, `deploy/downloads` holds every published
// host tarball, APK and desktop build — 2.7 GB and growing — and `COPY . .`
// duplicated all of it into the image layer, filling the disk and failing
// `pnpm ship server` with "no space left on device". Nothing in the build needs
// them: they are artifacts the box SERVES, not inputs it builds from.
describe('the docker build context', () => {
  const dockerignore = read('.dockerignore');

  it('excludes the published artifacts the box serves', () => {
    expect(dockerignore).toMatch(/^deploy\/downloads$/m);
  });

  it('still excludes the runtime data the containers write', () => {
    expect(dockerignore).toMatch(/^deploy\/data$/m);
    expect(dockerignore).toMatch(/^node_modules$/m);
  });
});

// spec/07 § Reaching a non-home host's audio WSS: `/audio/:sessionId` is served
// by the SERVER, which relays it to the chat's own host. Proxying it straight
// to the local host's :3003 (what this installer and prod's Caddy once did)
// sends a session for a chat on another machine to a host that has never
// heard of it: "session_not_found: chat not found: <id>". `/device/*` is the
// one path that does belong to the local host.
describe('H1 deploy artifacts — the installer Caddyfile routes the audio plane', () => {
  const printed = execFileSync(
    'sh',
    [
      join(repoRoot, 'packages/server/release/install-server.sh'),
      '--print-caddyfile',
      '--domain',
      'patch.example.test',
    ],
    { encoding: 'utf8' },
  );

  it('sends /audio/* to the server, which relays it to the owning host', () => {
    expect(printed).not.toMatch(/\/audio\/\*[^\n]*\n[^\n]*reverse_proxy @\w+ 127\.0\.0\.1:3003/);
    const audioMatcher = printed.match(/@(\w+) path ([^\n]*)/g) ?? [];
    for (const line of audioMatcher) expect(line).not.toContain('/audio/');
  });

  it('still sends /device/* to the local host', () => {
    expect(printed).toMatch(/@\w+ path \/device\/\*\n\treverse_proxy @\w+ 127\.0\.0\.1:3003/);
  });
});
