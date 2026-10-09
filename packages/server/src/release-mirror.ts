// Follows a release channel on GitHub and mirrors it into this server's
// downloads folder, which the server already serves to its hosts, desktop app
// and phone (the update channel of spec/11 § Version reporting).
//
// Nothing about delivery changes for a client. A host asks THIS server for
// `daemon-latest.json`, the desktop app for `latest-mac.yml`, the phone for
// `android-latest.json`; what changes is where this server gets them from: a
// published release instead of a deploy someone ran by hand.
//
// Off unless `PATCH_RELEASE_REPO` (owner/repo) is set, so a server that is
// deployed some other way is untouched. `PATCH_RELEASE_CHANNEL` is `stable`
// (the default: the newest non-prerelease) or `dev` (the newest of anything).
//
// NO FALLBACK: a release that is incomplete, a checksum that does not match, two
// host manifests that disagree about the build, or a GitHub that will not answer
// is an error that is logged and retried next time. The folder is never left
// half-updated: everything is downloaded and checked in a staging directory
// first, then moved into place, manifests last.

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export type Channel = 'stable' | 'dev';

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}
export interface Release {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  assets: ReleaseAsset[];
}

export interface MirrorState {
  tag: string;
  version: string;
  mirroredAt: string;
}

/** Host manifest as build-daemon writes it; only what the merge needs is typed. */
interface DaemonManifest {
  version: string;
  gitSha: string;
  signingPublicKey: string;
  artifacts: { target: string }[];
  [k: string]: unknown;
}

const STATE_FILE = 'release-mirror.json';

/** The release a channel follows, or null when it has none. Pure. */
export function selectRelease(releases: Release[], channel: Channel): Release | null {
  const live = releases.filter((r) => !r.draft && r.published_at);
  const pool = channel === 'stable' ? live.filter((r) => !r.prerelease) : live;
  const sorted = [...pool].sort(
    (a, b) => Date.parse(b.published_at!) - Date.parse(a.published_at!),
  );
  return sorted[0] ?? null;
}

/**
 * One manifest from the per-target ones a release carries
 * (`daemon-latest-<target>.json`). They must describe ONE build and ONE signing
 * key: mixing two would install code that claims to be a version it is not.
 */
export function mergeHostManifests(manifests: DaemonManifest[]): DaemonManifest {
  const [first, ...rest] = manifests;
  if (!first) throw new Error('the release has no host manifest');
  for (const m of rest) {
    if (m.version !== first.version || m.gitSha !== first.gitSha) {
      throw new Error(
        `host manifests disagree: ${first.version} (${first.gitSha}) vs ${m.version} (${m.gitSha})`,
      );
    }
    if (m.signingPublicKey !== first.signingPublicKey) {
      throw new Error('host manifests were signed with different artifact keys');
    }
  }
  const byTarget = new Map<string, DaemonManifest['artifacts'][number]>();
  for (const m of manifests) for (const a of m.artifacts) byTarget.set(a.target, a);
  return { ...first, artifacts: [...byTarget.values()] };
}

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

/** `<hex>  <name>` lines, as `sha256sum` writes them. */
export function parseChecksum(text: string): string {
  const hex = text.trim().split(/\s+/)[0] ?? '';
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`not a sha256 checksum: ${text.slice(0, 80)}`);
  return hex;
}

/** Files copied into the downloads folder as they are, when the release has them. */
const PASS_THROUGH = [
  /^patch-daemon-.+\.tar\.gz(\.sig)?$/,
  /^patch-.+\.apk$/,
  /^android-latest\.json$/,
  /^latest-mac\.yml$/,
  /^.+\.zip(\.blockmap)?$/,
  /^desktop-latest\.json$/,
];
const SERVER_RELEASE = ['patch-server.tar.gz', 'patch-server.tar.gz.sha256', 'install.sh'];
const HOST_MANIFEST = /^daemon-latest-.+\.json$/;

export interface MirrorOptions {
  repo: string;
  channel: Channel;
  downloadsDir: string;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
}

export function readMirrorState(downloadsDir: string): MirrorState | null {
  const file = join(downloadsDir, STATE_FILE);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as MirrorState;
}

/**
 * Check the channel once and mirror a newer release if there is one. Resolves to
 * the tag now mirrored, or null when there was nothing to do.
 */
export async function mirrorOnce(opts: MirrorOptions): Promise<string | null> {
  const f = opts.fetchImpl ?? fetch;
  const log = opts.log ?? (() => {});
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };

  const get = async (url: string): Promise<Response> => {
    const res = await f(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(300_000) });
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    return res;
  };

  const listRes = await f(`https://api.github.com/repos/${opts.repo}/releases?per_page=30`, {
    headers,
    signal: AbortSignal.timeout(60_000),
  });
  // A repository that is not public yet answers 404: nothing to follow, not a fault.
  if (listRes.status === 404) {
    log(`release mirror: ${opts.repo} has no published releases`);
    return null;
  }
  if (!listRes.ok) throw new Error(`listing ${opts.repo} releases answered ${listRes.status}`);
  const list = (await listRes.json()) as Release[];
  const release = selectRelease(list, opts.channel);
  if (!release) {
    log(`release mirror: ${opts.repo} has no ${opts.channel} release yet`);
    return null;
  }
  if (readMirrorState(opts.downloadsDir)?.tag === release.tag_name) return null;

  const assets = new Map(release.assets.map((a) => [a.name, a]));
  const fetchAsset = async (name: string): Promise<Buffer> => {
    const a = assets.get(name);
    if (!a) throw new Error(`release ${release.tag_name} has no ${name}`);
    return Buffer.from(await (await get(a.browser_download_url)).arrayBuffer());
  };

  const staging = join(opts.downloadsDir, `.mirror-${release.tag_name.replace(/[^\w.-]/g, '_')}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(join(staging, 'server-release'), { recursive: true });

  try {
    // The server release: the tarball must match the checksum published beside it.
    for (const name of SERVER_RELEASE) {
      if (!assets.has(name)) continue;
      writeFileSync(join(staging, 'server-release', name), await fetchAsset(name));
    }
    if (assets.has('patch-server.tar.gz')) {
      const want = parseChecksum(
        readFileSync(join(staging, 'server-release', 'patch-server.tar.gz.sha256'), 'utf8'),
      );
      const got = sha256(readFileSync(join(staging, 'server-release', 'patch-server.tar.gz')));
      if (got !== want)
        throw new Error('patch-server.tar.gz does not match its published checksum');
    }

    // Everything else is copied as published. Hosts verify their own artifacts
    // against the signing key they trust, so this server adds no trust of its own.
    const names = [...assets.keys()];
    for (const name of names.filter((n) => PASS_THROUGH.some((re) => re.test(n)))) {
      writeFileSync(join(staging, name), await fetchAsset(name));
    }

    // Host manifests are merged last, once everything they name has arrived.
    const manifestNames = names.filter((n) => HOST_MANIFEST.test(n));
    let version = release.tag_name;
    if (manifestNames.length > 0) {
      const merged = mergeHostManifests(
        await Promise.all(
          manifestNames.map(
            async (n) => JSON.parse((await fetchAsset(n)).toString('utf8')) as DaemonManifest,
          ),
        ),
      );
      for (const art of merged.artifacts) {
        const tar = names.find((n) => n.endsWith(`-${art.target}.tar.gz`));
        if (!tar || !existsSync(join(staging, tar)) || !existsSync(join(staging, `${tar}.sig`))) {
          throw new Error(
            `the manifest names ${art.target} but the release has no signed artifact for it`,
          );
        }
      }
      writeFileSync(join(staging, 'daemon-latest.json'), `${JSON.stringify(merged, null, 2)}\n`);
      version = merged.version;
    }

    // Into place: artifacts first, then the manifests clients poll, so a client
    // never sees a manifest whose files are not there yet.
    const move = (from: string, to: string) => {
      mkdirSync(join(to, '..'), { recursive: true });
      renameSync(from, to);
    };
    const MANIFESTS = new Set([
      'daemon-latest.json',
      'android-latest.json',
      'latest-mac.yml',
      'desktop-latest.json',
    ]);
    const staged = readdirSync(staging).filter((n) => n !== 'server-release');
    for (const n of staged.filter((n) => !MANIFESTS.has(n)))
      move(join(staging, n), join(opts.downloadsDir, n));
    for (const n of staged.filter((n) => MANIFESTS.has(n)))
      move(join(staging, n), join(opts.downloadsDir, n));
    for (const n of readdirSync(join(staging, 'server-release'))) {
      move(join(staging, 'server-release', n), join(opts.downloadsDir, 'server-release', n));
    }
    const state: MirrorState = {
      tag: release.tag_name,
      version,
      mirroredAt: new Date().toISOString(),
    };
    writeFileSync(join(opts.downloadsDir, STATE_FILE), `${JSON.stringify(state)}\n`);
    log(`release mirror: ${opts.repo} ${release.tag_name} (${version}) is now served`);
    return release.tag_name;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Check now and then hourly. The channel is asked for on every check, so an
 * operator changing it is followed without a restart; `off` skips the check.
 * Errors are logged and retried, never fatal.
 */
export function startReleaseMirror(
  opts: Omit<MirrorOptions, 'channel'> & { channel: () => Channel | 'off' },
  everyMs = 60 * 60 * 1000,
): () => void {
  const log = opts.log ?? (() => {});
  const tick = async () => {
    try {
      const channel = opts.channel();
      if (channel === 'off') return;
      await mirrorOnce({ ...opts, channel });
    } catch (err: unknown) {
      log(`release mirror FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  void tick();
  const timer = setInterval(tick, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
