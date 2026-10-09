// The release mirror fills the downloads folder from a GitHub Release channel
// (src/release-mirror.ts). GitHub is a fake `fetch` here; what is under test is
// what lands in the folder, and that a bad release leaves it untouched.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mergeHostManifests,
  mirrorOnce,
  parseChecksum,
  readMirrorState,
  selectRelease,
  startReleaseMirror,
  type Release,
} from '../src/release-mirror.js';
import { readChannel, writeChannel } from '../src/release-channel.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patch-mirror-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const manifest = (target: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: '1.2.3',
    gitSha: 'abc1234',
    signingPublicKey: 'KEY',
    artifacts: [{ target }],
    ...over,
  });

/** A release's files by name, and a fetch that serves them. */
function github(files: Record<string, string>, over: Partial<Release> = {}, extra: Release[] = []) {
  const release: Release = {
    tag_name: 'v1.2.3',
    draft: false,
    prerelease: false,
    published_at: '2026-10-01T00:00:00Z',
    assets: Object.keys(files).map((name) => ({
      name,
      browser_download_url: `https://dl.test/${name}`,
    })),
    ...over,
  };
  const fetchImpl = (async (url: string) => {
    if (url.startsWith('https://api.github.com/repos/o/r/releases')) {
      return new Response(JSON.stringify([release, ...extra]), { status: 200 });
    }
    const name = url.replace('https://dl.test/', '');
    return name in files ? new Response(files[name]) : new Response('nope', { status: 404 });
  }) as typeof fetch;
  return { fetchImpl };
}

const GOOD = (): Record<string, string> => ({
  'patch-server.tar.gz': 'SERVER-TARBALL',
  'patch-server.tar.gz.sha256': `${sha('SERVER-TARBALL')}  patch-server.tar.gz\n`,
  'install.sh': '#!/bin/sh\n',
  'patch-daemon-1.2.3-linux-x64.tar.gz': 'X64',
  'patch-daemon-1.2.3-linux-x64.tar.gz.sig': 'SIG-X64',
  'patch-daemon-1.2.3-linux-arm64.tar.gz': 'ARM',
  'patch-daemon-1.2.3-linux-arm64.tar.gz.sig': 'SIG-ARM',
  'daemon-latest-linux-x64.json': manifest('linux-x64'),
  'daemon-latest-linux-arm64.json': manifest('linux-arm64'),
});

const opts = (fetchImpl: typeof fetch) => ({
  repo: 'o/r',
  channel: 'stable' as const,
  downloadsDir: dir,
  fetchImpl,
});
const rel = (tag: string, at: string, prerelease = false, draft = false): Release => ({
  tag_name: tag,
  draft,
  prerelease,
  published_at: at,
  assets: [],
});

describe('selectRelease', () => {
  const list = [
    rel('dev-1.0.9', '2026-10-09T00:00:00Z', true),
    rel('v1.0.0', '2026-10-01T00:00:00Z'),
    rel('v1.1.0', '2026-10-05T00:00:00Z'),
    rel('v2.0.0', '2026-10-08T00:00:00Z', false, true),
  ];
  it('stable ignores prereleases and drafts and takes the newest of the rest', () => {
    expect(selectRelease(list, 'stable')?.tag_name).toBe('v1.1.0');
  });
  it('dev takes the newest published release of any kind', () => {
    expect(selectRelease(list, 'dev')?.tag_name).toBe('dev-1.0.9');
  });
  it('a channel with nothing in it follows nothing', () => {
    expect(selectRelease([rel('dev-1', '2026-10-01T00:00:00Z', true)], 'stable')).toBeNull();
  });
});

describe('mergeHostManifests', () => {
  it('one manifest holding every target of one build', () => {
    const merged = mergeHostManifests([
      JSON.parse(manifest('linux-x64')),
      JSON.parse(manifest('linux-arm64')),
    ]);
    expect(merged.artifacts.map((a) => a.target).sort()).toEqual(['linux-arm64', 'linux-x64']);
  });
  it('refuses two different builds', () => {
    expect(() =>
      mergeHostManifests([
        JSON.parse(manifest('linux-x64')),
        JSON.parse(manifest('linux-arm64', { gitSha: 'zzz' })),
      ]),
    ).toThrow(/disagree/);
  });
  it('refuses two signing keys', () => {
    expect(() =>
      mergeHostManifests([
        JSON.parse(manifest('linux-x64')),
        JSON.parse(manifest('linux-arm64', { signingPublicKey: 'OTHER' })),
      ]),
    ).toThrow(/different artifact keys/);
  });
});

describe('parseChecksum', () => {
  it('reads a sha256sum line and refuses anything else', () => {
    expect(parseChecksum(`${'a'.repeat(64)}  file\n`)).toBe('a'.repeat(64));
    expect(() => parseChecksum('not a checksum')).toThrow(/not a sha256/);
  });
});

describe('mirrorOnce', () => {
  it('serves a release: artifacts, the merged host manifest and the server release', async () => {
    const tag = await mirrorOnce(opts(github(GOOD()).fetchImpl));
    expect(tag).toBe('v1.2.3');
    expect(readFileSync(join(dir, 'patch-daemon-1.2.3-linux-x64.tar.gz'), 'utf8')).toBe('X64');
    expect(readFileSync(join(dir, 'server-release', 'install.sh'), 'utf8')).toContain('#!/bin/sh');
    const served = JSON.parse(readFileSync(join(dir, 'daemon-latest.json'), 'utf8'));
    expect(served.artifacts.map((a: { target: string }) => a.target).sort()).toEqual([
      'linux-arm64',
      'linux-x64',
    ]);
    expect(readMirrorState(dir)).toMatchObject({ tag: 'v1.2.3', version: '1.2.3' });
    expect(readdirSync(dir).filter((n) => n.startsWith('.mirror-'))).toEqual([]);
  });

  it('does nothing when the release is already served', async () => {
    const { fetchImpl } = github(GOOD());
    await mirrorOnce(opts(fetchImpl));
    expect(await mirrorOnce(opts(fetchImpl))).toBeNull();
  });

  it('a tarball that does not match its checksum changes nothing', async () => {
    const bad = { ...GOOD(), 'patch-server.tar.gz': 'TAMPERED' };
    await expect(mirrorOnce(opts(github(bad).fetchImpl))).rejects.toThrow(/checksum/);
    expect(existsSync(join(dir, 'daemon-latest.json'))).toBe(false);
    expect(readMirrorState(dir)).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('a manifest that names a target with no signed artifact changes nothing', async () => {
    const files = GOOD();
    delete files['patch-daemon-1.2.3-linux-arm64.tar.gz.sig'];
    await expect(mirrorOnce(opts(github(files).fetchImpl))).rejects.toThrow(/linux-arm64/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('a download that fails changes nothing and the next check tries again', async () => {
    const files = GOOD();
    const broken = github(files);
    const flaky = (async (url: string, init?: RequestInit) =>
      url.endsWith('patch-daemon-1.2.3-linux-x64.tar.gz')
        ? new Response('boom', { status: 500 })
        : broken.fetchImpl(url, init)) as typeof fetch;
    await expect(mirrorOnce(opts(flaky))).rejects.toThrow(/500/);
    expect(readMirrorState(dir)).toBeNull();
    expect(await mirrorOnce(opts(broken.fetchImpl))).toBe('v1.2.3');
  });

  it('a channel with no release yet is quiet', async () => {
    const { fetchImpl } = github(GOOD(), { prerelease: true });
    expect(await mirrorOnce(opts(fetchImpl))).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('the dev channel follows a prerelease', async () => {
    const { fetchImpl } = github(GOOD(), { prerelease: true, tag_name: 'dev-1.2.3' });
    expect(await mirrorOnce({ ...opts(fetchImpl), channel: 'dev' })).toBe('dev-1.2.3');
  });
});

describe('a repository with no published releases', () => {
  it('is quiet, not a fault', async () => {
    const logs: string[] = [];
    const notFound = (async () => new Response('{}', { status: 404 })) as typeof fetch;
    expect(await mirrorOnce({ ...opts(notFound), log: (m) => logs.push(m) })).toBeNull();
    expect(logs.join(' ')).toMatch(/no published releases/);
    expect(readdirSync(dir)).toEqual([]);
  });
  it('but any other failure to list is an error', async () => {
    const down = (async () => new Response('x', { status: 503 })) as typeof fetch;
    await expect(mirrorOnce(opts(down))).rejects.toThrow(/503/);
  });
});

describe('the channel an operator chooses', () => {
  it('is stable until someone says otherwise, and is kept in a file', () => {
    expect(readChannel(dir)).toBe('stable');
    expect(writeChannel(dir, 'dev')).toBe('dev');
    expect(readChannel(dir)).toBe('dev');
    expect(writeChannel(dir, 'off')).toBe('off');
    expect(readChannel(dir)).toBe('off');
  });
  it('refuses a channel that does not exist, and a file that says one', () => {
    expect(() => writeChannel(dir, 'beta')).toThrow(/not a channel/);
    writeFileSync(join(dir, 'release-channel'), 'beta\n');
    expect(() => readChannel(dir)).toThrow(/must be one of/);
  });
});

describe('startReleaseMirror', () => {
  it('checks nothing while the channel is off, and follows a change without a restart', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    let channel: 'off' | 'stable' = 'off';
    const stop = startReleaseMirror(
      { repo: 'o/r', downloadsDir: dir, fetchImpl, channel: () => channel },
      20,
    );
    await new Promise((r) => setTimeout(r, 70));
    expect(calls).toBe(0);
    channel = 'stable';
    await new Promise((r) => setTimeout(r, 70));
    stop();
    expect(calls).toBeGreaterThan(0);
  });
});
