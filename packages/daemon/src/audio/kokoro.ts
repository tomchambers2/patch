// Kokoro TTS sidecar (group 13).
//
// Long-running Python sidecar (same shape as faster-whisper local). Host
// spawns it at start, monitors process death, restarts on crash. Audio is
// streamed back over a WS at 24kHz mono PCM16; the orchestrator wraps each
// chunk in an `audio.tts_chunk` event and a binary frame on the surface WS.
//
// We expose a streaming interface (`synthesize(text) → AsyncIterable<chunk>`)
// so the orchestrator can stop consumption mid-stream on barge-in. Stopping
// the iteration sends a `cancel` JSON frame to the sidecar so it can drop
// in-flight Kokoro work.
//
// Backends:
//   - 'real' : Python sidecar over WS.
//   - 'mock' : deterministic synthetic chunks (tests + docker-compose.test).

import type { Logger } from 'pino';
import type { ChildProcess } from 'node:child_process';
import { existsSync as existsSyncFs } from 'node:fs';
import { PersistentWsClient } from './persistent-ws.js';

export interface KokoroChunk {
  /** PCM16 mono @ 24 kHz. */
  pcm: Int16Array;
  /** First chunk of an utterance — timestamp deltas anchor here. */
  first: boolean;
}

export interface KokoroSynthesis {
  iterator: AsyncIterableIterator<KokoroChunk>;
  /** Cancel: stops the sidecar mid-stream. Idempotent. */
  cancel(): Promise<void>;
}

export interface KokoroBackend {
  /**
   * Synthesise `text` as PCM audio. `voice` is an optional per-call override
   * (one of the standard Kokoro v1 voice names, e.g. 'af_heart'). When absent
   * the sidecar uses its configured default.
   */
  synthesize(text: string, voice?: string): Promise<KokoroSynthesis>;
  /** True iff the sidecar is alive + accepting requests. */
  isReady(): boolean;
  close(): Promise<void>;
}

export type KokoroBackendKind = 'off' | 'real' | 'mock';

export interface CreateKokoroOptions {
  backend: KokoroBackendKind;
  logger: Logger;
  /**
   * Sidecar WS URL (real backend only). If omitted, the host spawns the
   * `patch_kokoro_sidecar` process itself and connects to it on the default
   * loopback port (KOKORO_SIDECAR_PORT, 5019).
   */
  sidecarUrl?: string;
  /**
   * The loopback port for a sidecar this backend spawns itself. Defaults to
   * DEFAULT_KOKORO_PORT. A machine-wide fixed port with no override meant the
   * spawn-and-connect path could only be exercised by binding 5019 — which the
   * real host on any Patch host already holds, so that test failed with
   * EADDRINUSE on exactly the machines that run the thing.
   */
  sidecarPort?: number;
  /** Path to the kokoro model dir on disk (real backend only). */
  modelPath?: string;
  /** Working directory for the spawned `uv run` (defaults to the sidecar pkg). */
  sidecarCwd?: string;
  /**
   * Extra env for the spawned sidecar. Carries `UV_PROJECT_ENVIRONMENT` — the
   * venv the component install built for this machine (spec/02 § Optional
   * components) — so `uv run --no-sync` uses that environment rather than
   * resolving a fresh one inside the artifact.
   */
  sidecarEnv?: Record<string, string>;
  /**
   * The `uv` to spawn. A machine that had none got one during the component
   * install, in the patch home rather than on PATH (spec/02 § Optional
   * components), so a bare `uv` would not be found. Defaults to `uv`.
   */
  uvPath?: string;
}

/** Default loopback port the spawned Kokoro sidecar listens on. */
export const DEFAULT_KOKORO_PORT = 5019;

export function createKokoro(opts: CreateKokoroOptions): KokoroBackend {
  if (opts.backend === 'off') return new UnconfiguredKokoroBackend();
  if (opts.backend === 'mock') return new MockKokoroBackend();
  return new RealKokoroBackend(opts);
}

/**
 * TTS is not installed on this machine. The ~340 MB Kokoro weights are an
 * optional component the artifact deliberately omits, so a fresh install has
 * no voice — that must not stop the host booting, and must not silently
 * produce silence when something asks it to speak.
 */
class UnconfiguredKokoroBackend implements KokoroBackend {
  async synthesize(): Promise<KokoroSynthesis> {
    throw new Error(
      'Text-to-speech is not configured on this machine. Voice is an optional component: ' +
        'install it from Settings → Hosts, or set KOKORO_BACKEND=real with KOKORO_MODEL_PATH. ' +
        'Refusing to return empty audio.',
    );
  }
  isReady(): boolean {
    return false;
  }
  async close(): Promise<void> {}
}

/** Subset of the host's audio config the Kokoro startup check needs. */
export interface KokoroModelConfig {
  kokoroBackend: KokoroBackendKind;
  kokoroModelPath?: string | undefined;
  /** True when KOKORO_MODEL_PATH named the path (see validateKokoroModel). */
  kokoroModelPathFromEnv?: boolean;
}

/**
 * Eager startup validation of the Kokoro model file (spec/07 § Python sidecar
 * lifecycle: "KOKORO_MODEL_PATH ... must be validated at startup — missing
 * model files must abort with a clear error, not a silent failure").
 *
 * For backend=real: KOKORO_MODEL_PATH must be set AND exist on disk. The
 * `mock` backend needs nothing. NO SILENT FALLBACK — throwing here aborts
 * host boot before the audio WSS starts accepting sessions, so a voice
 * session can never open against a host that would 500 the first TTS turn.
 */
export function validateKokoroModel(
  config: KokoroModelConfig,
  existsSync: (p: string) => boolean = existsSyncFs,
): void {
  if (config.kokoroBackend !== 'real') return;
  const path = config.kokoroModelPath;
  if (!path || path.length === 0) {
    throw new Error(
      'KOKORO_BACKEND=real (the default) but no Kokoro model path resolved. ' +
        'Refusing to start in a degraded mode (NO SILENT FALLBACK).',
    );
  }
  if (existsSync(path)) return;
  if (config.kokoroModelPathFromEnv) {
    throw new Error(
      `KOKORO_MODEL_PATH points at a path that does not exist on disk: ${path}. ` +
        'A missing model file must abort at startup, not 500 the first voice turn (NO SILENT FALLBACK).',
    );
  }
  // Nobody named a path: the weights are this machine's Kokoro optional
  // component (~340 MB), downloaded on demand (spec/02 § Optional components).
  // A machine that has only just been installed does not have it yet, and that
  // is the designed state — the host advertises the component as `not
  // installed`, surfaces disable TTS and name what is needed, and a synthesis
  // attempt fails loudly. Aborting boot here instead would mean no host can
  // ever start on a fresh machine, which is the opposite of spec/11's "installs
  // and runs on a machine carrying only an OS".
}

/**
 * Mock: emits fixed-size (240-sample / 10ms @ 24kHz) chunks, PACED over time so
 * a streamed reply takes a realistic span on the wire rather than landing in a
 * single synchronous burst. Real Kokoro streams sentence-by-sentence over
 * hundreds of ms (spec/07); a synchronous mock made the `speaking` state and
 * the barge-in window effectively unobservable (the whole reply flushed in one
 * tick). The chunk count scales with text length so a multi-sentence reply
 * streams for a few seconds — long enough for the surface to show the speaking
 * state and for a mid-stream barge-in to land. `cancel()` halts promptly (the
 * generator returns on the next chunk boundary), so barge-in cuts the audio.
 */
const MOCK_TTS_CHUNK_INTERVAL_MS = 80;
class MockKokoroBackend implements KokoroBackend {
  async synthesize(text: string, _voice?: string): Promise<KokoroSynthesis> {
    let cancelled = false;
    // ~1 chunk per 6 chars, clamped to [3, 48] → a short "yes" still streams a
    // few frames; a multi-sentence reply streams for ~1–4s at 80ms/chunk.
    const len = Math.max(1, text.trim().length);
    const chunks = Math.min(48, Math.max(3, Math.ceil(len / 6)));
    async function* gen(): AsyncIterableIterator<KokoroChunk> {
      for (let i = 0; i < chunks; i++) {
        if (cancelled) return;
        if (i > 0) {
          await new Promise<void>((r) => setTimeout(r, MOCK_TTS_CHUNK_INTERVAL_MS));
        }
        if (cancelled) return;
        // 240 samples = 10ms @ 24kHz.
        const pcm = new Int16Array(240);
        // Encode chunk index into the first sample so tests can assert order.
        pcm[0] = i + 1;
        yield { pcm, first: i === 0 };
      }
    }
    return {
      iterator: gen(),
      async cancel(): Promise<void> {
        cancelled = true;
      },
    };
  }
  isReady(): boolean {
    return true;
  }
  async close(): Promise<void> {}
}

/**
 * Real sidecar. Lifecycle:
 *   - constructor records config; sidecar process is spawned on first
 *     synthesize() AND restarted on death.
 *   - synthesize() opens a WS, sends `{text}`, streams binary PCM frames
 *     until a `{end:true}` JSON frame arrives.
 *
 * NO FALLBACK: missing model path / failed spawn → throws on synthesize().
 */
class RealKokoroBackend implements KokoroBackend {
  private readonly opts: CreateKokoroOptions;
  private readonly port: number;
  private proc?: ChildProcess;
  private ready = false;
  private client?: PersistentWsClient;
  /** Set to true when the host owns (spawned) the sidecar process. */
  private spawnsOwn: boolean;

  constructor(opts: CreateKokoroOptions) {
    this.opts = opts;
    this.port = opts.sidecarPort ?? DEFAULT_KOKORO_PORT;
    this.spawnsOwn = opts.sidecarUrl === undefined;
  }

  isReady(): boolean {
    return this.ready;
  }

  private resolvedUrl(): string {
    return this.opts.sidecarUrl ?? `ws://127.0.0.1:${this.port}`;
  }

  private getClient(): PersistentWsClient {
    if (this.client) return this.client;
    this.client = new PersistentWsClient({ url: this.resolvedUrl(), logger: this.opts.logger });
    return this.client;
  }

  private async ensureProcess(): Promise<void> {
    // External sidecar (URL given) — the operator owns its lifecycle.
    if (!this.spawnsOwn) return;
    if (this.proc && !this.proc.killed) return;
    if (!this.opts.modelPath) {
      throw new Error('KOKORO_MODEL_PATH missing — required for backend=real (NO FALLBACKS).');
    }
    const { spawn } = await import('node:child_process');
    // `--no-sync`: use the venv baked at image-build time (CPU torch) AS-IS.
    // Plain `uv run` auto-syncs against uv.lock, which resolves the default
    // CUDA torch and pulls ~4GB of unusable nvidia wheels on every spawn,
    // filling the disk. The image already installed the right deps.
    const proc = spawn(
      this.opts.uvPath ?? 'uv',
      ['run', '--no-sync', 'python', '-m', 'patch_kokoro_sidecar'],
      {
        env: {
          ...process.env,
          ...this.opts.sidecarEnv,
          KOKORO_MODEL_PATH: this.opts.modelPath,
          KOKORO_SIDECAR_HOST: '127.0.0.1',
          KOKORO_SIDECAR_PORT: String(this.port),
        },
        ...(this.opts.sidecarCwd !== undefined ? { cwd: this.opts.sidecarCwd } : {}),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    // Surface the sidecar's stdout/stderr. Previously both pipes were opened but
    // never drained, so a native crash (e.g. a torch/kokoro segfault during
    // inference) exited the process with NO visible reason — it just logged
    // "exited; will respawn" and synthesis silently produced nothing. Tail the
    // last lines so the exit log can include why it died.
    let lastErr = '';
    const tail = (buf: Buffer): void => {
      lastErr = (lastErr + buf.toString()).split('\n').slice(-8).join('\n');
    };
    proc.stdout?.on('data', tail);
    proc.stderr?.on('data', tail);
    proc.on('exit', (code, signal) => {
      this.opts.logger.warn(
        { code, signal, tail: lastErr.slice(-1200) },
        'kokoro sidecar exited; will respawn on next request',
      );
      this.ready = false;
      this.proc = undefined;
    });
    proc.on('error', (err) => {
      this.opts.logger.error({ err: err.message }, 'kokoro sidecar spawn error');
      this.ready = false;
    });
    this.proc = proc;
    this.ready = true;
  }

  async synthesize(text: string, voice?: string): Promise<KokoroSynthesis> {
    await this.ensureProcess();
    const client = this.getClient();
    const requestId = `k-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    let cancelled = false;
    let done = false;
    const queue: KokoroChunk[] = [];
    let waiter: ((c: KokoroChunk | null) => void) | undefined;
    let first = true;

    // Persistent WS protocol: client sends `{requestId,text[,voice]}` text frame;
    // sidecar streams binary PCM16 frames followed by a final
    // `{requestId,end:true}` text frame. To cancel, the orchestrator drives
    // an out-of-band `{requestId,cancel:true}` (see cancel() below) — the
    // request still completes once the sidecar acks with `{end:true}` so
    // the persistent socket stays usable for the next request.
    const requestPromise = client.request({
      payload: JSON.stringify({ requestId, text, ...(voice !== undefined ? { voice } : {}) }),
      handlers: {
        onBinary: (data: Buffer): void => {
          if ((data.byteLength & 1) !== 0) {
            throw new Error('kokoro sidecar: pcm16 frame has odd byte length');
          }
          // Copy ONCE into an owned Int16Array — the ws Buffer pool may be
          // recycled before the orchestrator drains the queue. We must NOT
          // alias the ws Buffer's underlying ArrayBuffer at data.byteOffset:
          // with permessage-deflate the inflated frame can land at an ODD
          // byteOffset inside Node's shared buffer pool, and Int16Array
          // requires a 2-byte-aligned offset (otherwise it throws an
          // uncaught RangeError that kills the host). Copy the raw bytes
          // into a fresh, aligned ArrayBuffer first, then view as PCM16.
          const pcm = new Int16Array(data.byteLength >>> 1);
          const bytes = new Uint8Array(pcm.buffer);
          bytes.set(data);
          const chunk: KokoroChunk = { pcm, first };
          first = false;
          if (waiter) {
            waiter(chunk);
            waiter = undefined;
          } else {
            queue.push(chunk);
          }
        },
        onJson: (msg: unknown): boolean | { done: true; value: unknown } => {
          const m = msg as { end?: unknown };
          if (m.end === true) {
            done = true;
            if (waiter) {
              waiter(null);
              waiter = undefined;
            }
            return { done: true, value: null };
          }
          // Other JSON frames (e.g. progress) are ignored for now.
          return false;
        },
      },
    });
    // Detach the promise so a request error (sidecar drop) surfaces via
    // the iterator rather than as an unhandled rejection.
    requestPromise.catch((err: Error) => {
      this.opts.logger.warn({ err: err.message }, 'kokoro: request failed mid-stream');
      done = true;
      if (waiter) {
        waiter(null);
        waiter = undefined;
      }
    });

    const sendCancel = (): void => {
      // Out-of-band: side-channel a cancel frame on the persistent wire so
      // the sidecar can abort the in-flight synth WITHOUT waiting for the
      // FIFO queue (the synth IS the in-flight request — we'd dead-lock).
      // Best effort — if the wire isn't open the request promise's
      // catch-handler tears down anyway.
      client.sendOutOfBand(JSON.stringify({ requestId, cancel: true }));
    };

    async function* gen(): AsyncIterableIterator<KokoroChunk> {
      // BUGFIX: always drain `queue` before honouring `done`. If several
      // binary frames + the `{end:true}` frame arrive in the same
      // synchronous event-loop turn (faster than the consumer drains them),
      // `onBinary` buffers the extra frames in `queue` (no `waiter` is
      // pending yet) while `onJson` flips `done=true` in that same turn.
      // The old `while (!cancelled && !done)` loop condition then exited on
      // the very next iteration without ever re-checking `queue`, silently
      // dropping those already-received chunks. Checking `queue` first (and
      // only consulting `done` once it's empty) ensures every received
      // chunk is yielded before the stream ends.
      while (!cancelled) {
        const head = queue.shift();
        if (head !== undefined) {
          yield head;
          continue;
        }
        if (done) return;
        const next = await new Promise<KokoroChunk | null>((resolve) => {
          waiter = resolve;
        });
        if (next === null) return;
        yield next;
      }
    }
    return {
      iterator: gen(),
      async cancel(): Promise<void> {
        cancelled = true;
        sendCancel();
      },
    };
  }

  async close(): Promise<void> {
    if (this.client) await this.client.close();
    if (this.proc && !this.proc.killed) {
      this.proc.kill('SIGTERM');
    }
  }
}
