// Optional components (spec/02 § Optional components): the download must be
// verified against the digest huggingface.co publishes on ITS redirect, and the
// verdict must survive a host restart.
//
// The regression these cover: with `redirect: 'follow'` the host only ever
// saw the FINAL CDN response's headers, whose `etag` for a Xet-backed LFS
// object is the Xet content hash — 64 hex characters that are not the sha256 of
// the payload. Every install of every component failed on digest. The fake
// upstream below reproduces that shape exactly: a 302 from the origin carrying
// the true digest in `x-linked-etag`, and a CDN 200 carrying a different,
// sha256-shaped `etag`.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import {
  ComponentManager,
  ComponentNotOfferedError,
  COMPONENT_SPECS,
  parseLinkedDigest,
  type ComponentManagerOptions,
} from '../src/components.js';

const logger = pino({ level: 'silent' });

const KOKORO = COMPONENT_SPECS.find((s) => s.id === 'kokoro');
if (KOKORO === undefined) throw new Error('kokoro spec missing');

const CONFIG_URL = KOKORO.files[0]?.url as string;
const WEIGHTS_URL = KOKORO.files[1]?.url as string;
/** The voice pack — the one file whose NAME carries a subdirectory. */
const VOICE_URL = KOKORO.files[2]?.url as string;

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const gitBlobSha1 = (b: Buffer): string =>
  createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');

interface UpstreamFile {
  body: Buffer;
  /** What huggingface.co puts in `x-linked-etag` on its redirect. */
  linkedEtag: string | null;
  /** What the CDN puts in its own `etag` — never a digest of these bytes. */
  cdnEtag: string;
  /** Present for LFS objects only (small git-stored files get none). */
  linkedSize: boolean;
}

const CDN = 'https://us.aws.cdn.hf.co/xet-bridge-us';

/**
 * A fake upstream with huggingface.co's real redirect shape. HEAD on the origin
 * URL answers 302 → CDN with `x-linked-etag`; HEAD on the CDN URL answers 200
 * with a bogus `etag`; GET (redirect: 'follow') answers 200 with the bytes and
 * that same bogus `etag`, which the host must ignore.
 */
function makeUpstream(files: Record<string, UpstreamFile>): {
  fetchImpl: typeof fetch;
  gets: string[];
} {
  const gets: string[] = [];
  const cdnUrl = (url: string): string => `${CDN}/${encodeURIComponent(url)}`;
  const originOf = (cdn: string): string => decodeURIComponent(cdn.slice(`${CDN}/`.length));

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const isCdn = url.startsWith(`${CDN}/`);
    const originUrl = isCdn ? originOf(url) : url;
    const file = files[originUrl];
    if (file === undefined) return new Response(null, { status: 404 });

    if (method === 'HEAD' && !isCdn) {
      const headers: Record<string, string> = { location: cdnUrl(url) };
      if (file.linkedEtag !== null) headers['x-linked-etag'] = `"${file.linkedEtag}"`;
      if (file.linkedSize) headers['x-linked-size'] = String(file.body.length);
      return new Response(null, { status: 302, headers });
    }
    if (method === 'HEAD') {
      return new Response(null, {
        status: 200,
        headers: { etag: `"${file.cdnEtag}"`, 'content-length': String(file.body.length) },
      });
    }
    gets.push(originUrl);
    const range = new Headers(init?.headers ?? {}).get('range');
    if (range !== null) {
      const from = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? '0');
      const slice = file.body.subarray(from);
      return new Response(slice, { status: 206, headers: { etag: `"${file.cdnEtag}"` } });
    }
    return new Response(file.body, { status: 200, headers: { etag: `"${file.cdnEtag}"` } });
  };
  return { fetchImpl: fetchImpl as unknown as typeof fetch, gets };
}

const CONFIG_BODY = Buffer.from('{"model":"kokoro"}\n');
const WEIGHTS_BODY = Buffer.from('W'.repeat(4096));
const VOICE_BODY = Buffer.from('V'.repeat(512));

function goodFiles(): Record<string, UpstreamFile> {
  return {
    // Small git-stored file: HF publishes the git blob id (40 hex).
    [CONFIG_URL]: {
      body: CONFIG_BODY,
      linkedEtag: gitBlobSha1(CONFIG_BODY),
      cdnEtag: 'deadbeef'.repeat(5),
      linkedSize: false,
    },
    // LFS/Xet object: HF publishes the payload sha256, the CDN publishes the
    // Xet content hash (also 64 hex — the whole trap).
    [WEIGHTS_URL]: {
      body: WEIGHTS_BODY,
      linkedEtag: sha256(WEIGHTS_BODY),
      cdnEtag: '0c0ac263f5ae91312df578d1b6adfb4c6dfda401cc3696ba97042f835619c52f',
      linkedSize: true,
    },
    // A file whose name is `voices/af_heart.pt`: the write stream will not
    // create that subdirectory, so the download must.
    [VOICE_URL]: {
      body: VOICE_BODY,
      linkedEtag: sha256(VOICE_BODY),
      cdnEtag: 'a'.repeat(64),
      linkedSize: true,
    },
  };
}

let root: string;

/**
 * Stand in for a completed `provisionSidecarRuntime`: an interpreter plus the
 * stamp it writes last. The stamp is what `installed` is read from.
 */
function buildRuntime(componentId: string): void {
  const venv = join(root, componentId, 'venv');
  mkdirSync(join(venv, 'bin'), { recursive: true });
  writeFileSync(join(venv, 'bin', 'python'), '');
  writeFileSync(join(venv, '.patch-runtime-complete'), `${new Date().toISOString()}\n`);
}

function manager(
  fetchImpl: typeof fetch,
  // A voice component's weights are useless without its Python sidecar, so the
  // install builds that runtime too (spec/02 § Optional components). A unit test
  // must not spawn `uv`, so it stands in for that step — and can fail it.
  provisionRuntime: ComponentManagerOptions['provisionRuntime'] = async (spec) => {
    buildRuntime(spec.id);
  },
): {
  mgr: ComponentManager;
  events: WireEvent[];
  settled: () => Promise<void>;
} {
  const events: WireEvent[] = [];
  const mgr = new ComponentManager({
    root,
    daemonId: 'host-test',
    emit: (e) => events.push(e),
    logger,
    onSettled: () => {},
    fetchImpl,
    provisionRuntime,
  });
  const settled = async (): Promise<void> => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const done = events.some(
        (e) =>
          e.type === 'host.component_progress' && (e.state === 'installed' || e.state === 'failed'),
      );
      if (done) return;
      if (Date.now() > deadline) throw new Error('component never settled');
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  return { mgr, events, settled };
}

const stateOf = (mgr: ComponentManager, id: string): { state: string; error?: string } => {
  const entry = mgr.describe().find((c) => c.id === id);
  if (entry === undefined) throw new Error(`no component ${id}`);
  return entry as { state: string; error?: string };
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'patch-components-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('parseLinkedDigest', () => {
  it('reads a 64-hex x-linked-etag as the payload sha256', () => {
    expect(
      parseLinkedDigest('"496DBA118D1A58F5F3DB2EFC88DBDC216E0483FC89FE6E47EE1F2C53F18AD1E4"'),
    ).toEqual({
      algo: 'sha256',
      value: '496dba118d1a58f5f3db2efc88dbdc216e0483fc89fe6e47ee1f2c53f18ad1e4',
    });
  });

  it('reads a 40-hex x-linked-etag as the git blob id', () => {
    expect(parseLinkedDigest('"14a726edd3718279eac426630879ff743955b16a"')).toEqual({
      algo: 'git-blob-sha1',
      value: '14a726edd3718279eac426630879ff743955b16a',
    });
  });

  it('rejects anything that is not one of those two digests', () => {
    expect(parseLinkedDigest(null)).toBeNull();
    expect(parseLinkedDigest('W/"abc"')).toBeNull();
    expect(parseLinkedDigest('"d41d8cd98f00b204e9800998ecf8427e-3"')).toBeNull();
  });
});

describe('ComponentManager install', () => {
  it('verifies against x-linked-etag, not the CDN etag, and lands installed', async () => {
    const { fetchImpl } = makeUpstream(goodFiles());
    const { mgr, events, settled } = manager(fetchImpl);
    expect(stateOf(mgr, 'kokoro').state).toBe('not-installed');

    mgr.install('kokoro');
    await settled();

    const settledFrame = events.filter(
      (e) => e.type === 'host.component_progress' && e.state !== 'downloading',
    );
    expect(settledFrame).toHaveLength(1);
    expect(settledFrame[0]).toMatchObject({ componentId: 'kokoro', state: 'installed' });

    // Real bytes on disk, byte-identical to the upstream payload.
    expect(readFileSync(join(root, 'kokoro', 'kokoro-v1_0.pth'))).toEqual(WEIGHTS_BODY);
    expect(readFileSync(join(root, 'kokoro', 'config.json'))).toEqual(CONFIG_BODY);
    expect(stateOf(mgr, 'kokoro').state).toBe('installed');

    // The verdict is persisted beside the payload with the digest that proved it.
    const record = JSON.parse(readFileSync(join(root, 'kokoro', 'install-state.json'), 'utf8'));
    expect(record.state).toBe('installed');
    expect(record.files['kokoro-v1_0.pth']).toMatchObject({
      algo: 'sha256',
      digest: sha256(WEIGHTS_BODY),
    });
  });

  it('streams progress frames with the real resolved total, not the advertised estimate', async () => {
    const { fetchImpl } = makeUpstream(goodFiles());
    const { mgr, events, settled } = manager(fetchImpl);
    mgr.install('kokoro');
    await settled();
    const totals = new Set(
      events.flatMap((e) => (e.type === 'host.component_progress' ? [e.totalBytes] : [])),
    );
    expect(totals).toEqual(new Set([CONFIG_BODY.length + WEIGHTS_BODY.length + VOICE_BODY.length]));
  });

  it('fails when the bytes do not match the origin digest', async () => {
    const files = goodFiles();
    (files[WEIGHTS_URL] as UpstreamFile).body = Buffer.from('T'.repeat(4096));
    const { fetchImpl } = makeUpstream(files);
    const { mgr, settled } = manager(fetchImpl);
    mgr.install('kokoro');
    await settled();

    const entry = stateOf(mgr, 'kokoro');
    expect(entry.state).toBe('failed');
    expect(entry.error).toMatch(/digest mismatch/);
    expect(entry.error).toMatch(/sha256/);
  });

  it('refuses to install when the origin publishes no digest (NO FALLBACK)', async () => {
    const files = goodFiles();
    (files[WEIGHTS_URL] as UpstreamFile).linkedEtag = null;
    const { fetchImpl, gets } = makeUpstream(files);
    const { mgr, settled } = manager(fetchImpl);
    mgr.install('kokoro');
    await settled();

    const entry = stateOf(mgr, 'kokoro');
    expect(entry.state).toBe('failed');
    expect(entry.error).toMatch(/refusing to install unverifiable bytes/);
    // It failed during resolution, before writing a single byte.
    expect(gets).toEqual([]);
    expect(existsSync(join(root, 'kokoro', 'kokoro-v1_0.pth'))).toBe(false);
  });

  it('never trusts the CDN etag even when it is sha256-shaped', async () => {
    // The CDN etag here is the sha256 of DIFFERENT bytes; if the host ever
    // fell back to it, this install would wrongly pass.
    const files = goodFiles();
    const weights = files[WEIGHTS_URL] as UpstreamFile;
    weights.cdnEtag = sha256(Buffer.from('some other object'));
    const { fetchImpl } = makeUpstream(files);
    const { mgr, settled } = manager(fetchImpl);
    mgr.install('kokoro');
    await settled();
    expect(stateOf(mgr, 'kokoro').state).toBe('installed');
  });

  it('resumes a partial file and still verifies the whole payload', async () => {
    mkdirSync(join(root, 'kokoro'), { recursive: true });
    writeFileSync(join(root, 'kokoro', 'kokoro-v1_0.pth'), WEIGHTS_BODY.subarray(0, 1000));
    const { fetchImpl } = makeUpstream(goodFiles());
    const { mgr, settled } = manager(fetchImpl);
    mgr.install('kokoro');
    await settled();
    expect(stateOf(mgr, 'kokoro').state).toBe('installed');
    expect(readFileSync(join(root, 'kokoro', 'kokoro-v1_0.pth'))).toEqual(WEIGHTS_BODY);
  });

  it('re-downloads a full-size file whose digest does not match (size is not proof)', async () => {
    mkdirSync(join(root, 'kokoro'), { recursive: true });
    writeFileSync(join(root, 'kokoro', 'kokoro-v1_0.pth'), Buffer.from('X'.repeat(4096)));
    const { fetchImpl, gets } = makeUpstream(goodFiles());
    const { mgr, settled } = manager(fetchImpl);
    mgr.install('kokoro');
    await settled();
    expect(gets).toContain(WEIGHTS_URL);
    expect(readFileSync(join(root, 'kokoro', 'kokoro-v1_0.pth'))).toEqual(WEIGHTS_BODY);
    expect(stateOf(mgr, 'kokoro').state).toBe('installed');
  });

  it('skips the download of a full-size file whose digest already matches', async () => {
    mkdirSync(join(root, 'kokoro'), { recursive: true });
    writeFileSync(join(root, 'kokoro', 'kokoro-v1_0.pth'), WEIGHTS_BODY);
    const { fetchImpl, gets } = makeUpstream(goodFiles());
    const { mgr, settled } = manager(fetchImpl);
    mgr.install('kokoro');
    await settled();
    expect(gets).not.toContain(WEIGHTS_URL);
    expect(stateOf(mgr, 'kokoro').state).toBe('installed');
  });

  it('ignores a second install while one is already running', async () => {
    const { fetchImpl } = makeUpstream(goodFiles());
    const { mgr, settled } = manager(fetchImpl);
    mgr.install('kokoro');
    expect(stateOf(mgr, 'kokoro').state).toBe('downloading');
    mgr.install('kokoro');
    await settled();
    expect(stateOf(mgr, 'kokoro').state).toBe('installed');
  });

  it('refuses an id this machine does not offer, naming it', () => {
    const { fetchImpl } = makeUpstream(goodFiles());
    const { mgr } = manager(fetchImpl);
    expect(() => mgr.install('nope')).toThrow(ComponentNotOfferedError);
    expect(() => mgr.install('nope')).toThrow(/nope/);
  });
});

describe('ComponentManager settled state survives a restart', () => {
  it('keeps a failed install failed after the manager is rebuilt', async () => {
    const files = goodFiles();
    (files[WEIGHTS_URL] as UpstreamFile).body = Buffer.from('T'.repeat(4096));
    const { fetchImpl } = makeUpstream(files);
    const { mgr, settled } = manager(fetchImpl);
    mgr.install('kokoro');
    await settled();
    expect(stateOf(mgr, 'kokoro').state).toBe('failed');
    // The failed run leaves the payload on disk — the sentinel exists.
    expect(existsSync(join(root, 'kokoro', 'kokoro-v1_0.pth'))).toBe(true);

    // Restart: a brand new manager over the same root, no memory of the run.
    const { mgr: restarted } = manager(makeUpstream(goodFiles()).fetchImpl);
    const entry = stateOf(restarted, 'kokoro');
    expect(entry.state).toBe('failed');
    expect(entry.error).toMatch(/digest mismatch/);
  });

  it('keeps an installed component installed after the manager is rebuilt', async () => {
    const { fetchImpl } = makeUpstream(goodFiles());
    const { mgr, settled } = manager(fetchImpl);
    mgr.install('kokoro');
    await settled();
    const { mgr: restarted } = manager(fetchImpl);
    expect(stateOf(restarted, 'kokoro').state).toBe('installed');
  });

  it('never reports a payload with no install record as installed', () => {
    mkdirSync(join(root, 'kokoro'), { recursive: true });
    writeFileSync(join(root, 'kokoro', 'kokoro-v1_0.pth'), WEIGHTS_BODY);
    const { mgr } = manager(makeUpstream(goodFiles()).fetchImpl);
    const entry = stateOf(mgr, 'kokoro');
    expect(entry.state).toBe('failed');
    expect(entry.error).toMatch(/no verified install record/);
  });

  it('fails when the record says installed but the payload is gone', async () => {
    const { fetchImpl } = makeUpstream(goodFiles());
    const { mgr, settled } = manager(fetchImpl);
    mgr.install('kokoro');
    await settled();
    rmSync(join(root, 'kokoro', 'kokoro-v1_0.pth'));
    const entry = stateOf(mgr, 'kokoro');
    expect(entry.state).toBe('failed');
    expect(entry.error).toMatch(/missing from disk/);
  });

  // The 18 Sep 2026 outage: the venv was moved aside by hand, the next sidecar
  // spawn's `uv run` recreated it EMPTY, and Settings → Hosts kept saying Kokoro
  // was installed off a record written in August — while every voice call
  // failed with "No module named patch_kokoro_sidecar".
  it('reports a voice component whose venv was emptied as failed, not installed', async () => {
    const { fetchImpl } = makeUpstream(goodFiles());
    const { mgr, settled } = manager(fetchImpl);
    mgr.install('kokoro');
    await settled();
    expect(stateOf(mgr, 'kokoro').state).toBe('installed');

    const venv = join(root, 'kokoro', 'venv');
    rmSync(venv, { recursive: true, force: true });
    // What `uv run --no-sync` leaves where a venv was missing: an interpreter
    // and nothing installed into it.
    mkdirSync(join(venv, 'bin'), { recursive: true });
    writeFileSync(join(venv, 'bin', 'python'), '');

    const { mgr: restarted } = manager(fetchImpl);
    const entry = stateOf(restarted, 'kokoro');
    expect(entry.state).toBe('failed');
    expect(entry.error).toMatch(/Python runtime is missing or incomplete/);
    expect(entry.error).toContain(venv);
  });

  it('reports a voice component whose venv is gone entirely as failed', async () => {
    const { fetchImpl } = makeUpstream(goodFiles());
    const { mgr, settled } = manager(fetchImpl);
    mgr.install('kokoro');
    await settled();
    rmSync(join(root, 'kokoro', 'venv'), { recursive: true, force: true });
    expect(stateOf(mgr, 'kokoro')).toMatchObject({ state: 'failed' });
  });

  it('treats an unreadable install record as a failure, not as installed', () => {
    mkdirSync(join(root, 'kokoro'), { recursive: true });
    writeFileSync(join(root, 'kokoro', 'kokoro-v1_0.pth'), WEIGHTS_BODY);
    writeFileSync(join(root, 'kokoro', 'install-state.json'), '{not json');
    const { mgr } = manager(makeUpstream(goodFiles()).fetchImpl);
    expect(stateOf(mgr, 'kokoro')).toMatchObject({ state: 'failed' });
    expect(stateOf(mgr, 'kokoro').error).toMatch(/unreadable/);

    writeFileSync(join(root, 'kokoro', 'install-state.json'), '{"state":"whatever"}');
    expect(stateOf(mgr, 'kokoro').error).toMatch(/malformed/);
  });
});

describe('ComponentManager remove', () => {
  it('deletes the real bytes and the install record', async () => {
    const { fetchImpl } = makeUpstream(goodFiles());
    const { mgr, events, settled } = manager(fetchImpl);
    mgr.install('kokoro');
    await settled();
    mgr.remove('kokoro');
    expect(existsSync(join(root, 'kokoro'))).toBe(false);
    expect(stateOf(mgr, 'kokoro').state).toBe('not-installed');
    expect(events.at(-1)).toMatchObject({ state: 'not-installed', componentId: 'kokoro' });
  });

  it('aborts an in-flight download and the aborted run records nothing', async () => {
    const { fetchImpl } = makeUpstream(goodFiles());
    const { mgr, events } = manager(fetchImpl);
    mgr.install('kokoro');
    mgr.remove('kokoro');
    expect(stateOf(mgr, 'kokoro').state).toBe('not-installed');
    // Let the aborted run reject and settle: it must not resurrect the
    // component as `failed`, nor emit a settled frame for bytes that are gone.
    await new Promise((r) => setTimeout(r, 200));
    expect(stateOf(mgr, 'kokoro').state).toBe('not-installed');
    expect(existsSync(join(root, 'kokoro'))).toBe(false);
    expect(events.at(-1)).toMatchObject({ state: 'not-installed' });
  });
});

// spec/02 § Optional components. A voice component is weights PLUS the Python
// sidecar that reads them, and the artifact carries the sidecar's source and
// none of its ~2 GB of wheels — deliberately, so a host install stays small.
// Pressing Install is therefore the moment that runtime gets built, and until
// it did, an artifact-installed host downloaded 340 MB of Kokoro weights and
// still could not say a word.
describe('a voice component builds its runtime as part of installing', () => {
  it('provisions the sidecar runtime once the weights verify', async () => {
    const seen: string[] = [];
    const { mgr, settled } = manager(
      makeUpstream(goodFiles()).fetchImpl,
      async (spec, onProgress) => {
        seen.push(spec.id);
        onProgress('building the Python runtime');
        buildRuntime(spec.id);
      },
    );
    mgr.install('kokoro');
    await settled();
    expect(seen).toEqual(['kokoro']);
    expect(stateOf(mgr, 'kokoro').state).toBe('installed');
  });

  it('tells the surface what the slow part is doing', async () => {
    // The bytes are all in by then, so a byte count alone renders as a bar
    // stuck at 100% for several minutes.
    const { mgr, events, settled } = manager(
      makeUpstream(goodFiles()).fetchImpl,
      async (spec, onProgress) => {
        onProgress('building the Python runtime (this is the slow part)');
        buildRuntime(spec.id);
      },
    );
    mgr.install('kokoro');
    await settled();
    expect(
      events.some(
        (e) => e.type === 'host.component_progress' && e.note?.includes('Python runtime') === true,
      ),
    ).toBe(true);
  });

  it('fails the install when the runtime cannot be built', async () => {
    // A component recorded installed on a runtime that cannot start would
    // surface as silence at the first voice call, far from the cause.
    const { mgr, settled } = manager(makeUpstream(goodFiles()).fetchImpl, async () => {
      throw new Error('uv sync failed: no solution found for torch==2.9');
    });
    mgr.install('kokoro');
    await settled();
    const state = stateOf(mgr, 'kokoro');
    expect(state.state).toBe('failed');
    expect(state.error).toMatch(/no solution found for torch/);
  });

  it('fails the install when the provisioner returns without a completed runtime', async () => {
    // "No error" from the build step is not proof there is anything to run.
    const { mgr, settled } = manager(makeUpstream(goodFiles()).fetchImpl, async () => {});
    mgr.install('kokoro');
    await settled();
    const state = stateOf(mgr, 'kokoro');
    expect(state.state).toBe('failed');
    expect(state.error).toMatch(/not a completed runtime/);
  });

  it('refuses a component whose runtime this host cannot provision', async () => {
    const events: WireEvent[] = [];
    const mgr = new ComponentManager({
      root,
      daemonId: 'host-test',
      emit: (e) => events.push(e),
      logger,
      onSettled: () => {},
      fetchImpl: makeUpstream(goodFiles()).fetchImpl,
      // No provisioner wired at all.
    });
    mgr.install('kokoro');
    for (let i = 0; i < 200 && stateOf(mgr, 'kokoro').state !== 'failed'; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(stateOf(mgr, 'kokoro').error).toMatch(/no way to provision/);
  });
});

// The catalogue has to describe a component that WORKS. Installing Kokoro
// fetched its weights and its config and stopped there — and the sidecar died
// on first start with "KOKORO_MODEL_PATH missing voices/ directory", because a
// Kokoro model without a voice pack cannot synthesise anything. Found by
// installing it on the real host; pinned here so the catalogue can't lose it.
describe('the Kokoro component describes everything the sidecar opens', () => {
  const kokoro = COMPONENT_SPECS.find((s) => s.id === 'kokoro');
  if (kokoro === undefined) throw new Error('kokoro spec missing');

  it('carries the default voice, in voices/', () => {
    // `patch_kokoro_sidecar` defaults to `af_heart` and refuses to start
    // without it (NO SILENT FALLBACK, sidecar.py).
    const names = kokoro.files.map((f) => f.name);
    expect(names).toContain('voices/af_heart.pt');
  });

  it('fetches each voice from the model repo', () => {
    for (const file of kokoro.files.filter((f) => f.name.startsWith('voices/'))) {
      expect(file.url).toContain('hexgrad/Kokoro-82M');
      expect(file.url.endsWith(file.name)).toBe(true);
    }
  });

  it('counts the voices in the advertised size', () => {
    const total = kokoro.files.reduce((a, f) => a + f.bytes, 0);
    expect(kokoro.bytes).toBeGreaterThanOrEqual(total);
  });
});

it('creates the subdirectory a file’s name asks for', async () => {
  // `voices/af_heart.pt` — the write stream will not make `voices/`, so the
  // download must, or the whole install dies on the last file.
  const { fetchImpl } = makeUpstream(goodFiles());
  const { mgr, settled } = manager(fetchImpl);
  mgr.install('kokoro');
  await settled();
  expect(stateOf(mgr, 'kokoro').state).toBe('installed');
  expect(readFileSync(join(root, 'kokoro', 'voices', 'af_heart.pt'))).toEqual(VOICE_BODY);
});
