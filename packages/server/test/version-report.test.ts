// Unit tests for the version report — the drift detector.
//
// The bug these guard against: prod served a 17 July SPA for eight days while
// /api/healthz reported the 25 July commit, because the server image and the
// mounted web-dist ship down separate paths and nothing compared them. Every case
// below asserts that a layer which is stale, unstamped or unreadable is reported as
// SUCH, never as agreement.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildVersionReport,
  compareVersions,
  computeDrift,
  parseVersion,
  readPublishedArtifact,
  readWebLayer,
  type DriftInput,
} from '../src/version-report.js';

const NOW = new Date('2026-07-28T12:00:00.000Z');

function baseInput(over: Partial<DriftInput> = {}): DriftInput {
  return {
    server: {
      version: '0.1.317',
      gitSha: '9b8635f',
      builtAt: '2026-07-28T10:00:00.000Z',
      serverSha: '9b8635f',
    },
    web: {
      version: '0.1.317',
      gitSha: '9b8635f',
      builtAt: '2026-07-28T10:00:00.000Z',
      bundle: 'assets/index-CtWBatg1.js',
      deployedAt: '2026-07-28T10:05:00.000Z',
      expectedServerSha: '9b8635f',
    },
    daemon: null,
    hosts: [],
    desktop: null,
    android: null,
    clients: [],
    ...over,
  };
}

describe('parseVersion / compareVersions', () => {
  it('parses a monotonic build version', () => {
    expect(parseVersion('0.1.317')).toEqual([0, 1, 317]);
  });

  it('returns null for a non-semver version rather than guessing', () => {
    expect(parseVersion('unstamped')).toBeNull();
    expect(parseVersion('dev')).toBeNull();
    expect(parseVersion(null)).toBeNull();
    expect(parseVersion(undefined)).toBeNull();
  });

  it('orders by patch, which is the commit count', () => {
    expect(compareVersions('0.1.316', '0.1.317')).toBeLessThan(0);
    expect(compareVersions('0.1.318', '0.1.317')).toBeGreaterThan(0);
    expect(compareVersions('0.1.317', '0.1.317')).toBe(0);
  });

  it('orders by major and minor before patch', () => {
    expect(compareVersions('0.2.1', '0.1.999')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '0.9.999')).toBeGreaterThan(0);
  });

  it('returns null — not 0 — when either side is uncomparable', () => {
    // This distinction matters: treating "can't compare" as "equal" is precisely
    // how a stale client would be reported as up to date.
    expect(compareVersions('dev', '0.1.317')).toBeNull();
    expect(compareVersions('0.1.317', 'unstamped')).toBeNull();
  });
});

describe('readWebLayer', () => {
  it('reports the bundle, commit and deploy time of a stamped SPA', () => {
    const dir = mkdtempSync(join(tmpdir(), 'patch-web-'));
    try {
      writeFileSync(
        join(dir, 'index.html'),
        '<script type="module" src="/app/assets/index-CtWBatg1.js"></script>',
      );
      writeFileSync(
        join(dir, 'version.json'),
        JSON.stringify({
          version: '0.1.317',
          gitSha: '9b8635f',
          builtAt: '2026-07-28T10:00:00.000Z',
        }),
      );
      const layer = readWebLayer(dir);
      expect(layer).toMatchObject({
        version: '0.1.317',
        gitSha: '9b8635f',
        bundle: 'assets/index-CtWBatg1.js',
      });
      expect(layer?.deployedAt).toMatch(/^\d{4}-/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports an unstamped SPA as unstamped with a null sha, not as current', () => {
    // This is the ACTUAL state prod was in: a bundle with no provenance at all.
    const dir = mkdtempSync(join(tmpdir(), 'patch-web-'));
    try {
      writeFileSync(
        join(dir, 'index.html'),
        '<script type="module" src="/app/assets/index-C4eo04Yz.js"></script>',
      );
      const layer = readWebLayer(dir);
      expect(layer).toMatchObject({ version: 'unstamped', gitSha: null, builtAt: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats a corrupt version.json as unstamped rather than throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'patch-web-'));
    try {
      writeFileSync(join(dir, 'index.html'), '<script src="/app/assets/index-abc.js"></script>');
      writeFileSync(join(dir, 'version.json'), 'not json{');
      expect(readWebLayer(dir)?.version).toBe('unstamped');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when no SPA is mounted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'patch-web-'));
    try {
      expect(readWebLayer(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when index.html names no hashed bundle', () => {
    const dir = mkdtempSync(join(tmpdir(), 'patch-web-'));
    try {
      writeFileSync(join(dir, 'index.html'), '<html><body>no bundle here</body></html>');
      expect(readWebLayer(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('readPublishedArtifact', () => {
  const withDir = (fn: (dir: string) => void): void => {
    const dir = mkdtempSync(join(tmpdir(), 'patch-dl-'));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('reads a sidecar and dates it by the artifact mtime', () => {
    withDir((dir) => {
      writeFileSync(join(dir, 'Patch-0.1.317-arm64-mac.zip'), 'binary');
      const when = new Date('2026-07-20T09:00:00.000Z');
      utimesSync(join(dir, 'Patch-0.1.317-arm64-mac.zip'), when, when);
      writeFileSync(
        join(dir, 'desktop-latest.json'),
        JSON.stringify({
          version: '0.1.317',
          gitSha: '9b8635f',
          builtAt: '2026-07-28T10:00:00.000Z',
          file: 'Patch-0.1.317-arm64-mac.zip',
        }),
      );
      const pub = readPublishedArtifact(dir, 'desktop-latest.json', (f) => `/api/desktop/${f}`);
      expect(pub).toMatchObject({
        version: '0.1.317',
        gitSha: '9b8635f',
        publishedAt: '2026-07-20T09:00:00.000Z',
        url: '/api/desktop/Patch-0.1.317-arm64-mac.zip',
      });
    });
  });

  it('returns null when nothing is published', () => {
    withDir((dir) => {
      expect(readPublishedArtifact(dir, 'desktop-latest.json', (f) => f)).toBeNull();
    });
  });

  it('returns null for a sidecar whose artifact is missing — nothing is installable', () => {
    withDir((dir) => {
      writeFileSync(
        join(dir, 'desktop-latest.json'),
        JSON.stringify({ version: '0.1.317', gitSha: 'abc', builtAt: 'x', file: 'gone.zip' }),
      );
      expect(readPublishedArtifact(dir, 'desktop-latest.json', (f) => f)).toBeNull();
    });
  });

  it('returns null for a corrupt or incomplete sidecar', () => {
    withDir((dir) => {
      writeFileSync(join(dir, 'a.json'), 'nope{');
      expect(readPublishedArtifact(dir, 'a.json', (f) => f)).toBeNull();
      writeFileSync(join(dir, 'b.json'), JSON.stringify({ version: '0.1.1' })); // no file
      expect(readPublishedArtifact(dir, 'b.json', (f) => f)).toBeNull();
    });
  });
});

describe('computeDrift', () => {
  it('is empty when every layer agrees', () => {
    expect(computeDrift(baseInput())).toEqual([]);
  });

  it('flags THE original bug: server and deployed SPA on different commits', () => {
    const drift = computeDrift(
      baseInput({
        web: {
          version: '0.1.305',
          gitSha: 'f6a6326',
          builtAt: '2026-07-17T14:29:00.000Z',
          bundle: 'assets/index-C4eo04Yz.js',
          deployedAt: '2026-07-17T15:29:00.000Z',
          expectedServerSha: 'f6a6326',
        },
      }),
    );
    expect(drift).toHaveLength(1);
    expect(drift[0]?.kind).toBe('web-server-mismatch');
    // The direction must be explicit — "differs" alone doesn't tell you which
    // layer to ship.
    expect(drift[0]?.detail).toContain('is older than');
    expect(drift[0]?.remedy).toContain('ship');
  });

  it('flags a NEWER deployed SPA too — drift in either direction is drift', () => {
    const drift = computeDrift(
      baseInput({
        web: {
          version: '0.1.320',
          gitSha: 'aaaaaaa',
          builtAt: NOW.toISOString(),
          bundle: 'assets/index-new.js',
          deployedAt: NOW.toISOString(),
          expectedServerSha: 'aaaaaaa',
        },
      }),
    );
    expect(drift[0]?.detail).toContain('is newer than');
  });

  it('flags a mismatch it cannot order as simply different', () => {
    const drift = computeDrift(
      baseInput({
        web: {
          version: 'unstamped-but-shad',
          gitSha: 'zzzzzzz',
          builtAt: null,
          bundle: 'assets/index-x.js',
          deployedAt: NOW.toISOString(),
          expectedServerSha: 'zzzzzzz',
        },
      }),
    );
    expect(drift[0]?.detail).toContain('is a different build to');
  });

  it('flags an unstamped SPA — unknown provenance is not agreement', () => {
    const drift = computeDrift(
      baseInput({
        web: {
          version: 'unstamped',
          gitSha: null,
          builtAt: null,
          bundle: 'assets/index-C4eo04Yz.js',
          deployedAt: '2026-07-17T15:29:00.000Z',
          expectedServerSha: null,
        },
      }),
    );
    expect(drift[0]?.kind).toBe('web-unstamped');
  });

  it('flags a server with no SPA mounted at all', () => {
    const drift = computeDrift(baseInput({ web: null }));
    expect(drift[0]?.kind).toBe('web-missing');
  });

  it('flags the same commit reporting two different versions', () => {
    // Found live: the server read its permanent `0.0.0` package.json placeholder
    // while the SPA reported a real version. Shas matched, so nothing flagged it and
    // the panel said "all layers agree on 0.0.0" — yet every version comparison in
    // this module (is this device behind?) was silently meaningless.
    const drift = computeDrift(
      baseInput({
        server: { version: '0.0.0', gitSha: '9b8635f', builtAt: null, serverSha: '9b8635f' },
      }),
    );
    const d = drift.find((x) => x.kind === 'version-scheme-mismatch');
    expect(d).toBeDefined();
    expect(d?.detail).toContain('same build');
    expect(d?.detail).toContain('0.0.0');
    expect(d?.detail).toContain('0.1.317');
    expect(d?.remedy).toContain('scripts/version.mjs');
  });

  it('does not flag a version difference when the commits ALSO differ', () => {
    // That's already reported as web-server-mismatch; two findings for one cause
    // would just be noise.
    const drift = computeDrift(
      baseInput({
        server: { version: '0.0.0', gitSha: 'different', builtAt: null, serverSha: 'different' },
      }),
    );
    expect(drift.map((d) => d.kind)).not.toContain('version-scheme-mismatch');
    expect(drift.map((d) => d.kind)).toContain('web-server-mismatch');
  });

  it('does not flag a version mismatch when the SPA is unstamped', () => {
    // Unknown provenance is already reported as web-unstamped.
    const drift = computeDrift(
      baseInput({
        web: {
          version: 'unstamped',
          gitSha: null,
          builtAt: null,
          bundle: 'assets/index-x.js',
          deployedAt: NOW.toISOString(),
          expectedServerSha: null,
        },
      }),
    );
    expect(drift.map((d) => d.kind)).not.toContain('version-scheme-mismatch');
  });

  it('flags a host built from a different commit to the server', () => {
    const drift = computeDrift(
      baseInput({
        daemon: { version: '0.1.300', gitSha: 'deadbee', builtAt: null, online: true },
      }),
    );
    expect(drift.map((d) => d.kind)).toContain('daemon-server-mismatch');
  });

  it('does not flag a host with unknown provenance as mismatched', () => {
    const drift = computeDrift(
      baseInput({ daemon: { version: '0.1.317', gitSha: null, builtAt: null, online: true } }),
    );
    expect(drift.map((d) => d.kind)).not.toContain('daemon-server-mismatch');
  });

  it('flags an online surface running an older bundle than the deployed SPA', () => {
    const drift = computeDrift(
      baseInput({
        clients: [
          {
            surfaceId: 'srf_desk',
            surfaceKind: 'desktop',
            online: true,
            lastSeenAt: NOW.toISOString(),
            version: '0.1.310',
            gitSha: 'older00',
            builtAt: null,
          },
        ],
      }),
    );
    const c = drift.find((d) => d.kind === 'client-behind');
    expect(c?.detail).toContain('0.1.310');
    expect(c?.remedy).toContain('reload');
  });

  it('compares a mobile client against the published APK, not the SPA', () => {
    const drift = computeDrift(
      baseInput({
        android: {
          version: '0.1.317',
          gitSha: '9b8635f',
          builtAt: null,
          publishedAt: NOW.toISOString(),
          url: '/api/download/patch-9b8635f.apk',
        },
        clients: [
          {
            surfaceId: 'srf_phone',
            surfaceKind: 'mobile',
            online: true,
            lastSeenAt: NOW.toISOString(),
            version: '0.1.290',
            gitSha: 'oldapk0',
            builtAt: null,
          },
        ],
      }),
    );
    const c = drift.find((d) => d.kind === 'client-behind');
    expect(c?.detail).toContain('your phone');
    expect(c?.remedy).toContain('APK');
  });

  it('ignores an OFFLINE stale device — nothing to act on right now', () => {
    const drift = computeDrift(
      baseInput({
        clients: [
          {
            surfaceId: 'srf_old',
            surfaceKind: 'desktop',
            online: false,
            lastSeenAt: '2026-07-01T00:00:00.000Z',
            version: '0.1.200',
            gitSha: 'ancient',
            builtAt: null,
          },
        ],
      }),
    );
    expect(drift).toEqual([]);
  });

  it('reports an uncomparable client version as unknown rather than current', () => {
    const drift = computeDrift(
      baseInput({
        clients: [
          {
            surfaceId: 'srf_dev',
            surfaceKind: 'web',
            online: true,
            lastSeenAt: NOW.toISOString(),
            version: 'dev',
            gitSha: null,
            builtAt: null,
          },
        ],
      }),
    );
    expect(drift.find((d) => d.kind === 'client-version-unknown')).toBeDefined();
  });

  it('skips a mobile client when no APK has been published (nothing to compare)', () => {
    const drift = computeDrift(
      baseInput({
        android: null,
        clients: [
          {
            surfaceId: 'srf_phone',
            surfaceKind: 'mobile',
            online: true,
            lastSeenAt: NOW.toISOString(),
            version: '0.1.290',
            gitSha: null,
            builtAt: null,
          },
        ],
      }),
    );
    expect(drift).toEqual([]);
  });

  it('skips surface comparison when no SPA is mounted (already flagged as missing)', () => {
    const drift = computeDrift(
      baseInput({
        web: null,
        clients: [
          {
            surfaceId: 'srf_desk',
            surfaceKind: 'desktop',
            online: true,
            lastSeenAt: NOW.toISOString(),
            version: '0.1.300',
            gitSha: null,
            builtAt: null,
          },
        ],
      }),
    );
    expect(drift.map((d) => d.kind)).toEqual(['web-missing']);
  });

  it('does not flag an online client that is AHEAD (mid live-reload)', () => {
    const drift = computeDrift(
      baseInput({
        clients: [
          {
            surfaceId: 'srf_desk',
            surfaceKind: 'desktop',
            online: true,
            lastSeenAt: NOW.toISOString(),
            version: '0.1.318',
            gitSha: 'newer00',
            builtAt: null,
          },
        ],
      }),
    );
    expect(drift).toEqual([]);
  });
});

describe('buildVersionReport', () => {
  it('stamps checkedAt and carries every layer through with its drift', () => {
    const report = buildVersionReport({
      ...baseInput(),
      server: {
        version: '0.1.317',
        gitSha: '9b8635f',
        builtAt: '2026-07-28T10:00:00.000Z',
        startedAt: '2026-07-28T11:00:00.000Z',
        serverSha: '9b8635f',
      },
      now: NOW,
    });
    expect(report.checkedAt).toBe('2026-07-28T12:00:00.000Z');
    expect(report.server.startedAt).toBe('2026-07-28T11:00:00.000Z');
    expect(report.drift).toEqual([]);
  });

  it('surfaces drift in the assembled report', () => {
    const report = buildVersionReport({
      ...baseInput({ web: null }),
      server: {
        version: '0.1.317',
        gitSha: '9b8635f',
        builtAt: null,
        startedAt: '2026-07-28T11:00:00.000Z',
        serverSha: '9b8635f',
      },
      now: NOW,
    });
    expect(report.drift[0]?.kind).toBe('web-missing');
  });
});

describe('mkdirSync guard (published dir that is not a dir)', () => {
  it('reports null when the sidecar path is a directory, not a file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'patch-dl-'));
    try {
      mkdirSync(join(dir, 'desktop-latest.json'));
      // Reading a directory as JSON throws EISDIR — caught and reported unknown.
      expect(readPublishedArtifact(dir, 'desktop-latest.json', (f) => f)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('expectedServerSha (web-only releases are not drift)', () => {
  it('does NOT flag a web-only release, where the shas differ but the code does not', () => {
    // My own guard fired on every web-only deploy: the SPA moves to a new commit,
    // the server image is untouched, so the shas differ while no server code changed.
    // The only "fix" was a ~40 minute rebuild that changed nothing but a stamp.
    const drift = computeDrift(
      baseInput({
        web: {
          version: '0.1.329',
          gitSha: '8348532', // newer than the server…
          builtAt: null,
          bundle: 'assets/index-new.js',
          deployedAt: NOW.toISOString(),
          expectedServerSha: '9b8635f', // …but expects exactly the server code we have
        },
      }),
    );
    expect(drift).toEqual([]);
  });

  it('still flags a genuinely stale server', () => {
    const drift = computeDrift(
      baseInput({
        web: {
          version: '0.1.329',
          gitSha: '8348532',
          builtAt: null,
          bundle: 'assets/index-new.js',
          deployedAt: NOW.toISOString(),
          expectedServerSha: 'cccadaa', // server code moved and wasn't shipped
        },
      }),
    );
    expect(drift[0]?.kind).toBe('web-server-mismatch');
  });

  it('falls back to comparing shas for an SPA that predates the field', () => {
    const drift = computeDrift(
      baseInput({
        web: {
          version: '0.1.305',
          gitSha: 'f6a6326',
          builtAt: null,
          bundle: 'assets/index-old.js',
          deployedAt: NOW.toISOString(),
          expectedServerSha: null,
        },
      }),
    );
    expect(drift[0]?.kind).toBe('web-server-mismatch');
  });
});

describe('serverSha comparison (the fix for the fix)', () => {
  it('does not flag drift when the server was BUILT at a later commit than the last server change', () => {
    // The first attempt compared expectedServerSha to the server's BUILD sha. Those
    // answer different questions — "newest commit touching server code" vs "commit
    // this image was built from" — so a web-only release could never match and the
    // warning stayed on screen. Seen live: expected 37604bf, server reported 83096e8.
    const drift = computeDrift(
      baseInput({
        server: {
          version: '0.1.331',
          gitSha: '83096e8', // built from a later, web-only commit
          builtAt: null,
          serverSha: '37604bf', // …but its server code is 37604bf
        },
        web: {
          version: '0.1.331',
          gitSha: '83096e8',
          builtAt: null,
          bundle: 'assets/index-x.js',
          deployedAt: NOW.toISOString(),
          expectedServerSha: '37604bf',
        },
      }),
    );
    expect(drift).toEqual([]);
  });

  it('still flags a server whose code is genuinely older', () => {
    const drift = computeDrift(
      baseInput({
        server: { version: '0.1.331', gitSha: '83096e8', builtAt: null, serverSha: 'aaaaaaa' },
        web: {
          version: '0.1.331',
          gitSha: '83096e8',
          builtAt: null,
          bundle: 'assets/index-x.js',
          deployedAt: NOW.toISOString(),
          expectedServerSha: '37604bf',
        },
      }),
    );
    expect(drift[0]?.kind).toBe('web-server-mismatch');
  });

  it('falls back to build shas when the server is unstamped', () => {
    const drift = computeDrift(
      baseInput({
        server: { version: '0.1.331', gitSha: '83096e8', builtAt: null, serverSha: null },
        web: {
          version: '0.1.331',
          gitSha: '83096e8',
          builtAt: null,
          bundle: 'assets/index-x.js',
          deployedAt: NOW.toISOString(),
          expectedServerSha: '37604bf',
        },
      }),
    );
    // Same build sha on both sides → agrees, without pretending to know more.
    expect(drift).toEqual([]);
  });
});

// spec/11: "the host layer can differ from host to host". Reporting a single
// `daemon` made drift BETWEEN machines invisible — nine machines on two builds
// looked like agreement.
describe('drift between machines', () => {
  const host = (over: Record<string, unknown> = {}) => ({
    daemonId: 'host-a',
    hostName: 'host-a',
    online: true,
    version: '0.1.375',
    gitSha: 'abc1234',
    builtAt: '2026-08-05T10:00:00.000Z',
    ...over,
  });

  it('is silent when every connected machine agrees', () => {
    const drift = computeDrift(
      baseInput({ hosts: [host(), host({ daemonId: 'host-b', hostName: 'beta' })] }),
    );
    expect(drift.filter((d) => d.kind.startsWith('host'))).toEqual([]);
  });

  it('names the machines on each build when they disagree', () => {
    const drift = computeDrift(
      baseInput({
        hosts: [host(), host({ daemonId: 'host-b', hostName: 'beta', version: '0.1.374' })],
      }),
    );
    const d = drift.find((x) => x.kind === 'hosts-disagree');
    expect(d).toBeDefined();
    expect(d!.detail).toContain('host-a');
    expect(d!.detail).toContain('host-b');
    expect(d!.detail).toContain('0.1.374');
  });

  it('ignores an OFFLINE machine on an older build — it is not drift until it is back', () => {
    const drift = computeDrift(
      baseInput({
        hosts: [host(), host({ daemonId: 'host-b', version: '0.1.100', online: false })],
      }),
    );
    expect(drift.find((x) => x.kind === 'hosts-disagree')).toBeUndefined();
  });

  it('reports an unstamped machine as unknown rather than folding it in as agreeing', () => {
    const drift = computeDrift(baseInput({ hosts: [host({ version: null })] }));
    expect(drift.find((x) => x.kind === 'host-unstamped')).toBeDefined();
    expect(drift.find((x) => x.kind === 'hosts-disagree')).toBeUndefined();
  });

  it('shows a machine below the supported range as needing an update', () => {
    const drift = computeDrift(baseInput({ hosts: [host({ version: '0.0.9' })] }));
    const d = drift.find((x) => x.kind === 'host-unsupported');
    expect(d).toBeDefined();
    expect(d!.remedy).toContain('update');
  });
});
