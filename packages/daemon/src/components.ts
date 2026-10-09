// Optional components (spec/02 § Optional components).
//
// The two weight sets too large for the installer — Kokoro TTS (~340 MB) and a
// local Whisper model (~1.5 GB) — downloaded on demand, PER MACHINE, from the
// upstream the repo's `scripts/fetch-models.sh` uses. The host owns the
// download because the weights land on the host's own disk.
//
// Behaviour this file is responsible for:
//   - real HTTP downloads with live progress (received/total bytes) streamed to
//     every surface as `host.component_progress`;
//   - resume: an interrupted download restarts from the bytes already on disk
//     via a Range request;
//   - a component counts as installed only once its size AND digest verify
//     against the digest huggingface.co publishes on its redirect (see
//     `resolveUpstream` below — NOT the CDN's own ETag);
//   - remove deletes the real bytes.
//
// NO FALLBACK: a failed or unverifiable download lands in `failed` carrying the
// reason. It is never reported installed, and nothing substitutes a stub file.
// That verdict is persisted beside the payload (`install-state.json`), so a
// host restart cannot silently promote unverified bytes to `installed`.

import { createHash } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createReadStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type { Logger } from 'pino';
import type { HostComponent, HostComponentProgressEvent, WireEvent } from '@patch/wire';
import { sidecarRuntimeReady } from './audio/sidecarRuntime.js';

/** One file that makes up a component. */
interface ComponentFile {
  /** Path under the component directory. */
  name: string;
  url: string;
  /** Approximate size, used for the aggregate total before headers arrive. */
  bytes: number;
}

export interface ComponentSpec {
  id: string;
  label: string;
  /** Advertised total size in bytes (what a surface shows before starting). */
  bytes: number;
  files: ComponentFile[];
  /** The file whose presence marks the component installed. */
  sentinel: string;
  /**
   * The Python sidecar this component's weights are useless without. Present ⇒
   * installing the component also builds that sidecar's runtime on this machine
   * (spec/02 § Optional components). The artifact carries the sidecar's source
   * and none of its wheels, so this is where the wheels arrive.
   */
  runtime?: {
    /** Which sidecar package — names the artifact's `sidecars/<id>` directory. */
    sidecar: 'kokoro' | 'whisper';
    /** Wheels the sidecar's manifest cannot name (a URL, not a package). */
    extraWheels?: string[];
  };
}

const HF = 'https://huggingface.co';

/**
 * The catalogue. Sources match `scripts/fetch-models.sh` — the Kokoro TTS
 * sidecar needs `kokoro-v1_0.pth` + `config.json`; faster-whisper needs the
 * ctranslate2 `medium.en` directory.
 */
export const COMPONENT_SPECS: readonly ComponentSpec[] = [
  {
    id: 'kokoro',
    label: 'Kokoro TTS',
    bytes: 340_000_000,
    sentinel: 'kokoro-v1_0.pth',
    runtime: {
      sidecar: 'kokoro',
      // Kokoro's misaki G2P needs spaCy's English model, which is published as a
      // wheel URL rather than a package name — so the manifest cannot name it,
      // and without it the first synthesis goes and fetches it mid-call.
      extraWheels: [
        'https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl',
      ],
    },
    files: [
      {
        name: 'config.json',
        url: `${HF}/hexgrad/Kokoro-82M/resolve/main/config.json`,
        bytes: 2_351,
      },
      {
        name: 'kokoro-v1_0.pth',
        url: `${HF}/hexgrad/Kokoro-82M/resolve/main/kokoro-v1_0.pth`,
        bytes: 327_212_226,
      },
      // The voice pack. Kokoro's weights are the model; a voice is what it
      // speaks WITH, and `patch_kokoro_sidecar` refuses to start without the one
      // it is configured for (NO SILENT FALLBACK, sidecar.py). Leaving it out
      // made "installed" mean a component that died on first start with
      // "KOKORO_MODEL_PATH missing voices/ directory". One voice, the default —
      // the other 53 are a menu nobody has asked for yet, at 0.5 MB each.
      {
        name: 'voices/af_heart.pt',
        url: `${HF}/hexgrad/Kokoro-82M/resolve/main/voices/af_heart.pt`,
        bytes: 523_425,
      },
    ],
  },
  {
    id: 'whisper',
    label: 'Whisper (local STT)',
    bytes: 1_500_000_000,
    sentinel: 'model.bin',
    runtime: { sidecar: 'whisper' },
    files: [
      {
        name: 'config.json',
        url: `${HF}/Systran/faster-whisper-medium.en/resolve/main/config.json`,
        bytes: 2_000,
      },
      {
        name: 'tokenizer.json',
        url: `${HF}/Systran/faster-whisper-medium.en/resolve/main/tokenizer.json`,
        bytes: 2_200_000,
      },
      {
        name: 'vocabulary.txt',
        url: `${HF}/Systran/faster-whisper-medium.en/resolve/main/vocabulary.txt`,
        bytes: 460_000,
      },
      {
        name: 'model.bin',
        url: `${HF}/Systran/faster-whisper-medium.en/resolve/main/model.bin`,
        bytes: 1_527_000_000,
      },
    ],
  },
];

/**
 * The two digest algorithms huggingface.co publishes for a `/resolve/` URL, in
 * the `x-linked-etag` header of the redirect it answers with:
 *   - `sha256` (64 hex) for an LFS/Xet-backed object — the sha256 of the payload;
 *   - `git-blob-sha1` (40 hex) for a small file stored in git directly — the
 *     git blob id, i.e. sha1("blob <byteLength>\0" + payload).
 * Both are verifiable locally, so every file of every component is checked.
 */
export type DigestAlgo = 'sha256' | 'git-blob-sha1';

export interface FileDigest {
  algo: DigestAlgo;
  value: string;
}

interface ResolvedFile {
  sizeBytes: number;
  digest: FileDigest;
}

/** What `install-state.json` records beside a component's payload. */
interface InstallRecord {
  state: 'installed' | 'failed';
  at: string;
  error?: string;
  /** Per-file digest proved at install time (informational / debuggable). */
  files?: Record<string, { bytes: number; algo: DigestAlgo; digest: string }>;
}

const INSTALL_RECORD = 'install-state.json';

/**
 * Where a component's sidecar runtime (its Python venv) lives on this machine:
 * `<componentsRoot>/<id>/venv`. One definition, read by the install (which
 * builds it), by the settled state (which checks it) and by the boot gate
 * (which spawns from it), so the three can never disagree about which venv
 * counts.
 */
export function componentRuntimeDir(componentsRoot: string, componentId: string): string {
  return join(componentsRoot, componentId, 'venv');
}

export class ComponentNotOfferedError extends Error {
  readonly code = 'component_not_offered' as const;
  constructor(componentId: string, offered: readonly string[]) {
    super(
      `this machine offers no component with id: ${componentId} (offered: ${offered.join(', ')})`,
    );
    this.name = 'ComponentNotOfferedError';
  }
}

interface LiveDownload {
  receivedBytes: number;
  totalBytes: number;
  abort: AbortController;
  /** Set by `remove()`: this run's outcome must not be recorded or announced. */
  cancelled: boolean;
}

export interface ComponentManagerOptions {
  /** Where components live: `<patchHome>/components/<id>/…`. */
  root: string;
  daemonId: string;
  emit: (event: WireEvent) => void;
  logger: Logger;
  /** Called when a component settles, so the host self-description is re-sent. */
  onSettled: () => void;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Build the Python runtime a component's sidecar needs, once its weights have
   * verified. Injected (index.ts wires the real one) so this module never spawns
   * anything and its tests provision nothing. Absent ⇒ a component that declares
   * a `runtime` cannot be installed, and says so.
   */
  provisionRuntime?: (spec: ComponentSpec, onProgress: (note: string) => void) => Promise<void>;
}

export class ComponentManager {
  private readonly inFlight = new Map<string, LiveDownload>();
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: ComponentManagerOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private dir(componentId: string): string {
    return join(this.opts.root, componentId);
  }

  private spec(componentId: string): ComponentSpec {
    const spec = COMPONENT_SPECS.find((c) => c.id === componentId);
    if (!spec) {
      throw new ComponentNotOfferedError(
        componentId,
        COMPONENT_SPECS.map((c) => c.id),
      );
    }
    return spec;
  }

  /** The venv a component's sidecar runs from (see `componentRuntimeDir`). */
  runtimeDir(componentId: string): string {
    return componentRuntimeDir(this.opts.root, componentId);
  }

  private recordPath(componentId: string): string {
    return join(this.dir(componentId), INSTALL_RECORD);
  }

  /**
   * The persisted verdict of the last install attempt. Survives a restart, so a
   * payload this host declared unverifiable can never come back as
   * `installed`. An unreadable record is itself a failure — never a shrug.
   */
  private readRecord(componentId: string): InstallRecord | null {
    const path = this.recordPath(componentId);
    if (!existsSync(path)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      return {
        state: 'failed',
        at: new Date().toISOString(),
        error: `install record unreadable (${path}): ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const rec = parsed as InstallRecord;
    if (
      rec === null ||
      typeof rec !== 'object' ||
      (rec.state !== 'installed' && rec.state !== 'failed')
    ) {
      return {
        state: 'failed',
        at: new Date().toISOString(),
        error: `install record malformed (${path})`,
      };
    }
    return rec;
  }

  private writeRecord(componentId: string, record: InstallRecord): void {
    mkdirSync(this.dir(componentId), { recursive: true });
    writeFileSync(this.recordPath(componentId), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  }

  private clearRecord(componentId: string): void {
    rmSync(this.recordPath(componentId), { force: true });
  }

  /**
   * The settled state of a component from what is on disk alone (no in-memory
   * state), so it reads the same before and after a host restart.
   */
  private settledState(spec: ComponentSpec): {
    state: 'installed' | 'failed' | 'not-installed';
    error?: string;
  } {
    const record = this.readRecord(spec.id);
    const sentinel = existsSync(join(this.dir(spec.id), spec.sentinel));
    if (record === null) {
      // Payload with no verdict beside it was never verified by this host.
      // Reporting it `installed` would be exactly the silent promotion the
      // NO-FALLBACK rule forbids.
      if (sentinel) {
        return {
          state: 'failed',
          error: `${spec.sentinel} is on disk but no verified install record is beside it — remove and re-install`,
        };
      }
      return { state: 'not-installed' };
    }
    if (record.state === 'failed') {
      return { state: 'failed', error: record.error ?? 'install failed' };
    }
    if (!sentinel) {
      return {
        state: 'failed',
        error: `install record says installed but ${spec.sentinel} is missing from disk`,
      };
    }
    // Weights are half a voice component. The record is written once, at
    // install time, and says nothing about the venv afterwards — a venv that
    // is later moved, emptied or rebuilt by a bare `uv run` (which silently
    // creates an EMPTY environment where one is missing) left the record
    // saying `installed` while every synthesis died with "No module named
    // patch_kokoro_sidecar". Settings then showed Kokoro installed and voice
    // calls went silent. Only the stamp a completed provision writes counts.
    if (spec.runtime !== undefined && !sidecarRuntimeReady(this.runtimeDir(spec.id))) {
      return {
        state: 'failed',
        error:
          `${spec.label} weights are installed but its Python runtime is missing or incomplete ` +
          `(${this.runtimeDir(spec.id)} was not built by a completed install) — install it again`,
      };
    }
    return { state: 'installed' };
  }

  /** The `components[]` entry set for `daemon.host`. */
  describe(): HostComponent[] {
    return COMPONENT_SPECS.map((spec) => {
      const live = this.inFlight.get(spec.id);
      if (live) {
        return {
          id: spec.id,
          label: spec.label,
          bytes: spec.bytes,
          state: 'downloading' as const,
          progress: live.totalBytes > 0 ? live.receivedBytes / live.totalBytes : 0,
        };
      }
      const settled = this.settledState(spec);
      if (settled.state === 'failed') {
        return {
          id: spec.id,
          label: spec.label,
          bytes: spec.bytes,
          state: 'failed' as const,
          error: settled.error as string,
        };
      }
      return {
        id: spec.id,
        label: spec.label,
        bytes: spec.bytes,
        state: settled.state,
      };
    });
  }

  private progress(
    componentId: string,
    state: HostComponentProgressEvent['state'],
    receivedBytes: number,
    totalBytes: number,
    error?: string,
    note?: string,
  ): void {
    this.opts.emit({
      type: 'host.component_progress',
      daemonId: this.opts.daemonId,
      componentId,
      state,
      receivedBytes,
      totalBytes,
      ...(error !== undefined ? { error } : {}),
      ...(note !== undefined ? { note } : {}),
    });
  }

  /**
   * Start (or resume) a component download. Returns immediately; progress
   * streams as `host.component_progress` and the settled state lands on
   * `daemon.host`. Throws `ComponentNotOfferedError` for an id this machine
   * does not offer.
   */
  install(componentId: string): void {
    const spec = this.spec(componentId);
    if (this.inFlight.has(componentId)) {
      this.opts.logger.info({ componentId }, 'component install already running');
      return;
    }
    this.clearRecord(componentId);
    const control: LiveDownload = {
      receivedBytes: 0,
      totalBytes: spec.bytes,
      abort: new AbortController(),
      cancelled: false,
    };
    this.inFlight.set(componentId, control);
    this.opts.onSettled();
    void this.run(spec, control)
      .then((verified) => {
        this.inFlight.delete(componentId);
        // `remove()` won the race: the bytes are gone, so neither a record nor
        // a settled frame belongs to this component any more.
        if (control.cancelled) return;
        this.writeRecord(componentId, {
          state: 'installed',
          at: new Date().toISOString(),
          files: verified,
        });
        this.progress(componentId, 'installed', control.receivedBytes, control.totalBytes);
        this.opts.logger.info({ componentId }, 'component installed');
        this.opts.onSettled();
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.inFlight.delete(componentId);
        if (control.cancelled) {
          this.opts.logger.info({ componentId }, 'component install aborted by remove');
          return;
        }
        this.writeRecord(componentId, {
          state: 'failed',
          at: new Date().toISOString(),
          error: message,
        });
        this.progress(componentId, 'failed', control.receivedBytes, control.totalBytes, message);
        this.opts.logger.error({ componentId, err: message }, 'component install failed');
        this.opts.onSettled();
      });
  }

  /** Delete an installed component's bytes. */
  remove(componentId: string): void {
    const spec = this.spec(componentId);
    const live = this.inFlight.get(componentId);
    if (live) {
      live.cancelled = true;
      live.abort.abort();
      this.inFlight.delete(componentId);
    }
    // Takes the install record with it — the whole component directory goes.
    rmSync(this.dir(spec.id), { recursive: true, force: true });
    this.progress(componentId, 'not-installed', 0, spec.bytes);
    this.opts.logger.info({ componentId }, 'component removed');
    this.opts.onSettled();
  }

  /**
   * Ask huggingface.co (NOT the CDN it redirects to) for a file's real size and
   * its digest, following redirects by hand.
   *
   * Why by hand: `redirect: 'follow'` hands back only the FINAL hop's headers,
   * and for a Xet-backed LFS object the CDN's own `etag` is the Xet content
   * hash — 64 hex characters that look exactly like a sha256 but are not the
   * sha256 of the payload, so every comparison against it fails. The only
   * trustworthy digest is `x-linked-etag` on huggingface.co's own redirect,
   * which `redirect: 'follow'` consumes and throws away.
   */
  private async resolveUpstream(url: string, signal: AbortSignal): Promise<ResolvedFile> {
    let current = url;
    let linkedEtag: string | null = null;
    let linkedSize: number | null = null;
    for (let hop = 0; hop < 6; hop += 1) {
      const res = await this.fetchImpl(current, {
        method: 'HEAD',
        redirect: 'manual',
        signal,
        // Identity encoding or `content-length` is the COMPRESSED length (or
        // absent entirely) and the ETag comes back weak — neither is usable to
        // size or verify the file we are about to write.
        headers: { 'accept-encoding': 'identity' },
      });
      // The first hop that carries them is huggingface.co's own answer; later
      // hops (the CDN) never do, and their `etag` is deliberately ignored.
      linkedEtag ??= res.headers.get('x-linked-etag');
      const sizeHeader = res.headers.get('x-linked-size');
      if (linkedSize === null && sizeHeader !== null && Number(sizeHeader) > 0) {
        linkedSize = Number(sizeHeader);
      }
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (location === null) {
          throw new Error(`HEAD ${current} → HTTP ${res.status} with no location header`);
        }
        current = new URL(location, current).toString();
        continue;
      }
      if (!res.ok) {
        throw new Error(`HEAD ${url} → HTTP ${res.status}`);
      }
      const contentLength = Number(res.headers.get('content-length') ?? '0');
      const sizeBytes = linkedSize ?? (Number.isFinite(contentLength) ? contentLength : 0);
      if (sizeBytes <= 0) {
        throw new Error(`${url}: upstream published no size (x-linked-size / content-length)`);
      }
      const digest = parseLinkedDigest(linkedEtag);
      if (digest === null) {
        // NO FALLBACK: without a digest from the origin there is nothing
        // honest to verify the bytes against, and the CDN's own etag is not a
        // digest of the payload. Refuse the install loudly rather than install
        // unverifiable weights and call them good.
        throw new Error(
          `${url}: upstream published no verifiable digest (x-linked-etag${
            linkedEtag === null ? ' absent' : ` = ${linkedEtag}, unrecognised form`
          }); refusing to install unverifiable bytes`,
        );
      }
      return { sizeBytes, digest };
    }
    throw new Error(`HEAD ${url}: too many redirects`);
  }

  private async run(
    spec: ComponentSpec,
    control: LiveDownload,
  ): Promise<Record<string, { bytes: number; algo: DigestAlgo; digest: string }>> {
    const dir = this.dir(spec.id);
    mkdirSync(dir, { recursive: true });

    // Progress for a run `remove()` has cancelled is noise about bytes that no
    // longer exist — never fan it out to surfaces.
    const emitProgress = (received: number): void => {
      if (control.cancelled) return;
      this.progress(spec.id, 'downloading', received, control.totalBytes);
    };

    // Resolve the real total AND the digest to verify against before streaming,
    // so the progress a surface renders is the real size rather than the
    // advertised estimate, and so an unverifiable file fails before any bytes
    // are written.
    const resolved: ResolvedFile[] = [];
    for (const file of spec.files) {
      resolved.push(await this.resolveUpstream(file.url, control.abort.signal));
    }
    control.totalBytes = resolved.reduce((a, r) => a + r.sizeBytes, 0);
    control.receivedBytes = 0;
    emitProgress(0);

    const verified: Record<string, { bytes: number; algo: DigestAlgo; digest: string }> = {};
    let doneBytes = 0;
    let lastEmit = 0;
    for (const [i, file] of spec.files.entries()) {
      if (control.cancelled) throw new Error('install cancelled');
      const target = join(dir, file.name);
      // A file's name can carry a subdirectory (`voices/af_heart.pt`), and the
      // write stream will not create one.
      mkdirSync(dirname(target), { recursive: true });
      const { sizeBytes: expected, digest } = resolved[i] as ResolvedFile;
      const already = existsSync(target) ? statSync(target).size : 0;
      if (already === expected) {
        // Full size on disk — that is size, not proof. Hash it: matching bytes
        // are a real resume, non-matching bytes are junk that must be
        // re-downloaded rather than trusted.
        const actual = await hashFile(target, digest.algo);
        if (actual === digest.value) {
          verified[file.name] = { bytes: expected, algo: digest.algo, digest: actual };
          doneBytes += expected;
          control.receivedBytes = doneBytes;
          emitProgress(doneBytes);
          continue;
        }
        this.opts.logger.warn(
          { componentId: spec.id, file: file.name, expected: digest.value, actual },
          'existing full-size file failed digest check — re-downloading',
        );
        rmSync(target, { force: true });
      }
      const stale = existsSync(target) ? statSync(target).size : 0;
      const resumeFrom = stale > 0 && stale < expected ? stale : 0;
      if (stale > expected) rmSync(target, { force: true });

      const res = await this.fetchImpl(file.url, {
        redirect: 'follow',
        signal: control.abort.signal,
        // Identity encoding: the bytes on the wire must be the bytes on disk,
        // or the resume offset and the resolved size both mean nothing.
        headers: {
          'accept-encoding': 'identity',
          ...(resumeFrom > 0 ? { range: `bytes=${resumeFrom}-` } : {}),
        },
      });
      if (!res.ok || res.body === null) {
        throw new Error(`GET ${file.url} → HTTP ${res.status}`);
      }

      const out = createWriteStream(target, resumeFrom > 0 ? { flags: 'a' } : { flags: 'w' });
      let fileReceived = resumeFrom;
      const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
      source.on('data', (chunk: Buffer) => {
        fileReceived += chunk.length;
        control.receivedBytes = doneBytes + fileReceived;
        // Throttle the fan-out: one frame per 2 MB is enough to animate a bar
        // without flooding every surface on a 1.5 GB download.
        if (control.receivedBytes - lastEmit >= 2_000_000) {
          lastEmit = control.receivedBytes;
          emitProgress(control.receivedBytes);
        }
      });
      await pipeline(source, out);

      const landed = statSync(target).size;
      if (landed !== expected) {
        throw new Error(
          `${file.name}: size mismatch after download (expected ${expected} bytes, got ${landed})`,
        );
      }
      const actual = await hashFile(target, digest.algo);
      if (actual !== digest.value) {
        throw new Error(
          `${file.name}: digest mismatch (expected ${digest.algo} ${digest.value}, got ${actual})`,
        );
      }
      verified[file.name] = { bytes: expected, algo: digest.algo, digest: actual };
      doneBytes += expected;
      control.receivedBytes = doneBytes;
      emitProgress(doneBytes);
    }

    // Weights are only half of a voice component: the sidecar that reads them is
    // Python, and the artifact carries its source but nothing that can run it —
    // the ~2 GB of wheels is exactly what a host install must not contain
    // (spec/02 § Optional components). Build that runtime HERE, while the user
    // is already watching an install, and let a failure fail the install: a
    // component recorded installed on a runtime that cannot start would surface
    // as silence at the first voice call, far from the cause.
    if (spec.runtime !== undefined) {
      if (control.cancelled) throw new Error('install cancelled');
      if (this.opts.provisionRuntime === undefined) {
        throw new Error(
          `${spec.id} needs a ${spec.runtime.sidecar} runtime, and this host has no way to ` +
            'provision one.',
        );
      }
      await this.opts.provisionRuntime(spec, (note) => {
        if (control.cancelled) return;
        this.progress(
          spec.id,
          'downloading',
          control.receivedBytes,
          control.totalBytes,
          undefined,
          note,
        );
      });
      // The provisioner reporting success is not proof: the settled state reads
      // the runtime stamp, so an install that recorded `installed` without one
      // would read back as failed on the very next describe. Fail it here, at
      // the cause, instead.
      if (!sidecarRuntimeReady(this.runtimeDir(spec.id))) {
        throw new Error(
          `${spec.id}: the ${spec.runtime.sidecar} runtime build finished but ` +
            `${this.runtimeDir(spec.id)} is not a completed runtime`,
        );
      }
    }
    return verified;
  }
}

/**
 * Read huggingface.co's `x-linked-etag` as a digest of the payload:
 *   - 64 hex → the LFS object's sha256;
 *   - 40 hex → the git blob id of a small file stored in git directly.
 * Anything else (a weak `W/"…"` etag, an opaque CDN etag) is NOT a digest of
 * these bytes and is rejected — the caller then fails the install rather than
 * comparing against the wrong thing or skipping the check.
 */
export function parseLinkedDigest(etag: string | null): FileDigest | null {
  if (etag === null) return null;
  const cleaned = etag.replace(/^W\//, '').replace(/"/g, '').trim();
  if (/^[0-9a-f]{64}$/i.test(cleaned)) return { algo: 'sha256', value: cleaned.toLowerCase() };
  if (/^[0-9a-f]{40}$/i.test(cleaned)) {
    return { algo: 'git-blob-sha1', value: cleaned.toLowerCase() };
  }
  return null;
}

async function hashFile(path: string, algo: DigestAlgo): Promise<string> {
  if (algo === 'sha256') {
    const hash = createHash('sha256');
    await pipeline(createReadStream(path), hash);
    return hash.digest('hex');
  }
  // git blob id: sha1("blob <byteLength>\0" + contents).
  const hash = createHash('sha1');
  hash.update(`blob ${statSync(path).size}\0`);
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}
