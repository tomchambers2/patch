// Whisper STT backend (group 13).
//
// Pluggable per `WHISPER_BACKEND` env var:
//   - 'groq'  (default): direct REST POST to Groq's transcribe endpoint.
//   - 'local': spawn faster-whisper as a long-running Python sidecar
//              (`uv run` → WS in/transcript out).
//   - 'mock' : test-stack stub that echoes a synthetic transcript per
//              utterance — keeps docker-compose.test.yml viable without
//              shipping API keys.
//
// NO FALLBACK: if WHISPER_BACKEND=groq and GROQ_API_KEY is missing the host
// ABORTS at startup (see validateWhisperCredentials below, wired from
// index.ts). The deployment contract (spec/11-deployment.md § Env, group H1)
// requires the credential to be validated "before any attempt to serve
// requests" — a green audio WSS that 500s the first real utterance is exactly
// the degraded mode the contract forbids. The per-call guards in the backends
// below are a belt-and-braces second line, not the primary check.

import type { Logger } from 'pino';
import type { ChildProcess } from 'node:child_process';
import { existsSync as existsSyncFs } from 'node:fs';
import { PersistentWsClient } from './persistent-ws.js';
import { readKey, type KeySource } from './keySource.js';

/** Subset of the host's audio config the credential check needs. */
export interface WhisperCredentialConfig {
  whisperBackend: WhisperBackendKind;
  groqApiKey?: string | undefined;
  whisperLocalSidecarUrl?: string | undefined;
  whisperModelPath?: string | undefined;
}

/**
 * Eager startup validation of the selected whisper backend's credentials
 * (spec/11-deployment.md § Env, group H1). Throws — aborting host boot —
 * when the backend is selected but its required credential/endpoint is absent.
 * The `mock` backend needs nothing. NO SILENT FALLBACK.
 */
export function validateWhisperCredentials(config: WhisperCredentialConfig): void {
  switch (config.whisperBackend) {
    // 'off' is NOT a degraded fallback — it is the absence of an optional
    // component. A machine carrying only an OS has no voice weights and no
    // STT credential (the artifact deliberately ships neither), and spec/11
    // requires the host to install and run there. Voice stays unconfigured
    // until it is installed as an optional component, at which point a backend
    // is chosen explicitly and the checks below apply in full. Choosing a
    // backend and omitting its credential still aborts — that is the case the
    // NO SILENT FALLBACK rule is about.
    case 'off':
      return;
    case 'groq':
      if (!config.groqApiKey || config.groqApiKey.length === 0) {
        throw new Error(
          'WHISPER_BACKEND=groq (the default) but GROQ_API_KEY is missing. ' +
            'Set GROQ_API_KEY in .env, or switch WHISPER_BACKEND=local (+ WHISPER_LOCAL_SIDECAR_URL). ' +
            'Refusing to start in a degraded mode (NO SILENT FALLBACK).',
        );
      }
      return;
    case 'local': {
      const hasUrl = !!config.whisperLocalSidecarUrl && config.whisperLocalSidecarUrl.length > 0;
      const hasModel = !!config.whisperModelPath && config.whisperModelPath.length > 0;
      // Either connect to an external sidecar (URL) OR spawn one (model path).
      if (!hasUrl && !hasModel) {
        throw new Error(
          'WHISPER_BACKEND=local but neither WHISPER_LOCAL_SIDECAR_URL nor WHISPER_MODEL_PATH is set. ' +
            'Set WHISPER_MODEL_PATH to the faster-whisper medium.en dir (the host will spawn the ' +
            'sidecar), or WHISPER_LOCAL_SIDECAR_URL to an external sidecar. ' +
            'Refusing to start in a degraded mode (NO SILENT FALLBACK).',
        );
      }
      if (!hasUrl && hasModel && !existsSyncFs(config.whisperModelPath!)) {
        throw new Error(
          `WHISPER_MODEL_PATH points at a path that does not exist on disk: ${config.whisperModelPath}. ` +
            'A missing faster-whisper model must abort at startup (NO SILENT FALLBACK).',
        );
      }
      return;
    }
    case 'mock':
      return;
  }
}

/**
 * Why a transcription is being asked for. A `final` is the user's actual words
 * and losing one loses the turn; a `partial` only paints the live overlay and
 * is expendable. The distinction exists because a shared provider quota can be
 * exhausted, and when it is, the expendable one must be what gives way.
 */
export interface TranscribeOptions {
  priority?: 'final' | 'partial';
}

/**
 * Thrown when a `partial` is skipped to keep provider quota in reserve for the
 * finals. Not a failure — the caller stops asking for partials this utterance
 * and says nothing about it.
 */
export class PartialBudgetExhaustedError extends Error {
  override readonly name = 'PartialBudgetExhaustedError';
}

export interface WhisperBackend {
  /**
   * Whether interim transcripts of an utterance still in progress are worth
   * attempting on this backend. NOT a claim that the backend streams — none of
   * them do. Groq answers a fresh request for the growing prefix fast enough,
   * and cheaply enough against a reserved slice of its per-minute quota, that
   * re-asking about once a second is worth the live text; a model running on
   * this machine's own CPU is not.
   *
   * The two costs of doing it are paid elsewhere, not by reporting false here:
   * the quota reserve keeps the final's request slots (`admit`), and the
   * partial-side hallucination filter drops the stock phrases Whisper answers a
   * near-silent prefix with (`partial-filter.ts`).
   */
  readonly supportsLivePartials: boolean;
  /**
   * The paid model this backend bills for (spec/07 § Call cost). Absent on a
   * backend that costs nothing per request (local, mock).
   */
  readonly costModel?: string;
  /**
   * Synchronous-style: takes a complete utterance buffer (PCM16 mono
   * 16kHz) and returns the final transcript. Streaming partials are
   * out-of-scope here — Groq's REST endpoint isn't streaming, and the
   * UX cost is small (a partial-transcript ticker is tracked separately
   * in the orchestrator's local state).
   */
  transcribe(pcm: Int16Array, opts?: TranscribeOptions): Promise<string>;
  /**
   * Transcribe a complete, already-encoded audio clip (spec/07 § End-to-end
   * voice transport — the mobile voice-note upload path). Unlike `transcribe`,
   * which takes raw PCM16 from the streaming audio WSS, this takes a compressed
   * container (m4a/wav) uploaded as one file to `POST /api/voice/note`.
   *
   * The Groq REST backend accepts compressed audio directly, so it sends the
   * clip straight through (no PCM→WAV step). The `local` faster-whisper sidecar
   * speaks PCM only and CANNOT decode m4a — it throws `UnsupportedClipFormatError`
   * rather than fake a transcript (NO FALLBACK); documented in spec/07.
   */
  transcribeClip(audio: Buffer, format: 'm4a' | 'wav'): Promise<string>;
  close(): Promise<void>;
}

/**
 * Thrown by a backend whose transcription engine cannot decode the uploaded
 * clip's container (spec/07 — the local faster-whisper sidecar is PCM-only and
 * can't accept m4a). Surfaced to the caller as a typed `unsupported_format`
 * error, never silently swallowed.
 */
export class UnsupportedClipFormatError extends Error {
  override readonly name = 'UnsupportedClipFormatError';
  constructor(message: string) {
    super(message);
  }
}

export type WhisperBackendKind = 'off' | 'groq' | 'local' | 'mock';

export interface CreateWhisperOptions {
  backend: WhisperBackendKind;
  logger: Logger;
  /**
   * GROQ_API_KEY (only required when backend === 'groq'). Read per request, so
   * a key changed in Settings → Hosts → Keys applies to the next one.
   */
  groqApiKey?: KeySource;
  /**
   * faster-whisper sidecar URL (e.g. ws://localhost:5018). If omitted on the
   * `local` backend, the host spawns `patch_whisper_sidecar` itself and
   * connects on the default loopback port.
   */
  localSidecarUrl?: string;
  /** Path to the faster-whisper model dir (medium.en) — spawned-sidecar mode. */
  localModelPath?: string;
  /** Working directory for the spawned `uv run` (the whisper-sidecar pkg). */
  localSidecarCwd?: string;
  /** Test hook: substitute fetch (used by groq-backend tests). */
  fetchImpl?: typeof fetch;
  /** Test hook: injectable clock for the request-quota window. */
  nowMs?: () => number;
  /** Override the per-request timeout (tests). */
  requestTimeoutMs?: number;
}

/** Default loopback port the spawned faster-whisper sidecar listens on. */
const DEFAULT_WHISPER_PORT = 5018;

export function createWhisper(opts: CreateWhisperOptions): WhisperBackend {
  switch (opts.backend) {
    case 'off':
      return new UnconfiguredWhisperBackend();
    case 'groq':
      return new GroqWhisperBackend(opts);
    case 'local':
      return new LocalWhisperBackend(opts);
    case 'mock':
      return new MockWhisperBackend();
  }
}

/**
 * Voice is not installed on this machine. Booting is fine — voice is an
 * optional component — but ACTUALLY ASKING for a transcript must fail loudly
 * and say how to fix it, never return a plausible empty string. That is the
 * difference between an unconfigured feature and a silent fallback.
 */
class UnconfiguredWhisperBackend implements WhisperBackend {
  /** Nothing is configured, so there is nothing to ask for a partial either. */
  readonly supportsLivePartials = false;
  private refuse(): never {
    throw new Error(
      'Speech-to-text is not configured on this machine. Voice is an optional component: ' +
        'install it from Settings → Hosts, or set WHISPER_BACKEND (groq + GROQ_API_KEY, or local ' +
        '+ WHISPER_MODEL_PATH). Refusing to return a fabricated transcript.',
    );
  }
  async transcribe(): Promise<string> {
    this.refuse();
  }
  async transcribeClip(): Promise<string> {
    this.refuse();
  }
  async close(): Promise<void> {}
}

class MockWhisperBackend implements WhisperBackend {
  /**
   * The mock returns a synthetic string keyed on the clip's duration, so a
   * partial would just paint a changing `[mock-transcript 1500ms]` over the
   * test stack's composer. Off.
   */
  readonly supportsLivePartials = false;
  async transcribe(pcm: Int16Array): Promise<string> {
    // Deterministic: encode the duration so tests can match on it.
    const ms = Math.round((pcm.length / 16000) * 1000);
    return `[mock-transcript ${ms}ms]`;
  }
  async transcribeClip(audio: Buffer, format: 'm4a' | 'wav'): Promise<string> {
    // Deterministic: encode the byte length + format so the test stack
    // (docker-compose.test.yml) can exercise the upload path without a real key.
    return `[mock-clip ${format} ${audio.byteLength}b]`;
  }
  async close(): Promise<void> {}
}

/**
 * Groq REST. Builds a WAV (PCM16 mono 16kHz) in-memory and posts as
 * multipart/form-data. Streaming-from-Groq isn't a thing; we send once
 * per utterance after VAD-end.
 */
/**
 * Groq's on-demand tier allows 20 transcription requests a minute, shared by
 * every voice session on this host.
 */
const GROQ_RPM_LIMIT = 20;
/**
 * How much of that minute is held back for finals. Partials re-transcribe the
 * growing utterance about once a second, so a long sentence spends the entire
 * allowance on the live overlay and then the final — the user's actual words —
 * is the request that gets refused. Reserving headroom makes the expendable
 * half give way instead.
 */
const GROQ_PARTIAL_BUDGET = 12;
/** How many times a final retries a 429 before giving up. */
const FINAL_RETRIES = 3;
/**
 * Ceiling on one transcription request. Groq answers a short utterance in well
 * under a second; anything approaching this is a stalled connection, and
 * waiting on it forever is worse than failing, because the session sits mute
 * with nothing to show for it.
 */
const GROQ_REQUEST_TIMEOUT_MS = 20_000;

/** Seconds Groq asks us to wait, from its "Please try again in 3s" message. */
export function parseRetryAfterMs(body: string, header: string | null): number | null {
  const fromHeader = header === null ? NaN : Number(header);
  if (Number.isFinite(fromHeader) && fromHeader >= 0) return fromHeader * 1000;
  const m = /try again in ([0-9.]+)\s*(ms|s)\b/i.exec(body);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return null;
  return m[2]?.toLowerCase() === 'ms' ? value : value * 1000;
}

export class GroqWhisperBackend implements WhisperBackend {
  /**
   * Groq's endpoint is request/response, not streaming — the live transcript is
   * produced by re-asking it for the growing prefix. It answers a short clip in
   * well under a second and `GROQ_PARTIAL_BUDGET` keeps that off the final's
   * quota, which is what makes it affordable to do.
   */
  readonly supportsLivePartials = true;
  readonly costModel = 'whisper-large-v3-turbo';
  private readonly opts: CreateWhisperOptions;
  /** ms timestamps of requests sent in the last minute, for the quota gate. */
  private recent: number[] = [];
  constructor(opts: CreateWhisperOptions) {
    this.opts = opts;
  }

  private now(): number {
    return this.opts.nowMs ? this.opts.nowMs() : Date.now();
  }

  /**
   * Record this request against the rolling minute, refusing a partial that
   * would eat into the reserve finals depend on.
   */
  private admit(priority: 'final' | 'partial'): void {
    const cutoff = this.now() - 60_000;
    this.recent = this.recent.filter((t) => t > cutoff);
    if (priority === 'partial' && this.recent.length >= GROQ_PARTIAL_BUDGET) {
      throw new PartialBudgetExhaustedError(
        `partial skipped: ${this.recent.length}/${GROQ_RPM_LIMIT} groq requests used this minute`,
      );
    }
    this.recent.push(this.now());
  }

  async transcribe(pcm: Int16Array, opts?: TranscribeOptions): Promise<string> {
    const apiKey = readKey(this.opts.groqApiKey);
    if (apiKey === undefined) {
      throw new Error(
        'GROQ_API_KEY missing — set it in Settings → Hosts → Keys or switch WHISPER_BACKEND (NO FALLBACKS).',
      );
    }
    const priority = opts?.priority ?? 'final';
    const fetchFn = this.opts.fetchImpl ?? fetch;
    // Snapshot the audio SYNCHRONOUSLY, before any await. `pcm` is a zero-copy
    // view into the session's reusable utterance ring, which the mic keeps
    // writing into; the caller's contract is that a backend consumes it before
    // yielding. Building the body inside the retry loop broke that — a retry
    // would have uploaded whatever the ring held by then, not what was said.
    const body = Buffer.from(pcm16ToWav(pcm, 16000));
    const buildForm = (): FormData => {
      const form = new FormData();
      form.set('file', new Blob([body], { type: 'audio/wav' }), 'utterance.wav');
      form.set('model', 'whisper-large-v3-turbo');
      form.set('response_format', 'json');
      // Pin English. Without a language hint Whisper auto-detects per-utterance,
      // which misfires on short/noisy clips and tanks accuracy. (Make this an env
      // if multi-language is ever needed.)
      form.set('language', 'en');
      form.set('temperature', '0');
      return form;
    };

    // A final is the user's actual words: a 429 is a documented transient with
    // a stated wait, so waiting it out is the correct handling, not a fallback.
    // Dropping it loses the turn, which is what "I spoke and nothing happened"
    // actually is. A partial has no such claim — it gives up immediately.
    const attempts = priority === 'final' ? FINAL_RETRIES : 1;
    let lastError = '';
    for (let attempt = 0; attempt < attempts; attempt++) {
      this.admit(priority);
      // A transcription that never returns wedges the whole session: the turn
      // never runs, no error reaches the surface, and the call just sits there
      // silent — indistinguishable from "voice is broken". There was no timeout
      // at all, so a stalled connection did exactly that, forever. Bound it and
      // let the failure surface (NO FALLBACK: it becomes a real error, not an
      // empty transcript).
      const res = await fetchFn('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}` },
        body: buildForm(),
        signal: AbortSignal.timeout(this.opts.requestTimeoutMs ?? GROQ_REQUEST_TIMEOUT_MS),
      });
      if (res.ok) {
        const body = (await res.json()) as { text?: string };
        if (typeof body.text !== 'string') {
          throw new Error('groq whisper: response missing .text');
        }
        return body.text.trim();
      }
      const text = await res.text();
      lastError = `groq whisper ${res.status}: ${text}`;
      const isLast = attempt === attempts - 1;
      if (res.status !== 429 || isLast) throw new Error(lastError);
      const waitMs = parseRetryAfterMs(text, res.headers.get('retry-after')) ?? 2_000;
      await new Promise((r) => setTimeout(r, Math.min(waitMs, 10_000)));
    }
    /* v8 ignore next -- the loop either returns or throws on its last attempt. */
    throw new Error(lastError);
  }
  /**
   * Upload path (spec/07): the Groq transcribe endpoint accepts compressed
   * audio (m4a/wav) directly, so we post the clip bytes as-is — no PCM→WAV
   * re-encode. Same model + pinned params as the streaming `transcribe`.
   */
  async transcribeClip(audio: Buffer, format: 'm4a' | 'wav'): Promise<string> {
    const apiKey = readKey(this.opts.groqApiKey);
    if (apiKey === undefined) {
      throw new Error(
        'GROQ_API_KEY missing — set it in Settings → Hosts → Keys or switch WHISPER_BACKEND (NO FALLBACKS).',
      );
    }
    const fetchFn = this.opts.fetchImpl ?? fetch;
    const mime = format === 'm4a' ? 'audio/mp4' : 'audio/wav';
    const form = new FormData();
    form.set('file', new Blob([audio], { type: mime }), `clip.${format}`);
    form.set('model', 'whisper-large-v3-turbo');
    form.set('response_format', 'json');
    form.set('language', 'en');
    form.set('temperature', '0');
    const res = await fetchFn('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`groq whisper ${res.status}: ${text}`);
    }
    const body = (await res.json()) as { text?: string };
    if (typeof body.text !== 'string') {
      throw new Error('groq whisper: response missing .text');
    }
    return body.text.trim();
  }
  async close(): Promise<void> {}
}

/**
 * faster-whisper Python sidecar. The sidecar is launched once at host
 * start by `kokoro.ts` / external supervisor (not this module's job). We
 * connect to its WS, send PCM, await JSON `{text}` response.
 *
 * For the v1 cut we lean on a simple request/response over WS — proper
 * partial streaming is a tightening pass once the sidecar is bedded in.
 */
export class LocalWhisperBackend implements WhisperBackend {
  /**
   * The sidecar answers one request at a time and runs the model on this
   * machine, so re-transcribing the growing prefix costs more as the utterance
   * lengthens. The session keeps ONE partial pass in flight and spaces them by
   * a second of new audio, so the final queues behind at most one pass. That
   * bound is what makes the live text affordable here; without it dictation on
   * a Mac host showed nothing at all while the user spoke (spec/07 § Live
   * transcript).
   */
  readonly supportsLivePartials = true;
  private readonly opts: CreateWhisperOptions;
  private readonly port = DEFAULT_WHISPER_PORT;
  private readonly spawnsOwn: boolean;
  private client?: PersistentWsClient;
  private proc?: ChildProcess;
  constructor(opts: CreateWhisperOptions) {
    this.opts = opts;
    this.spawnsOwn = !opts.localSidecarUrl || opts.localSidecarUrl.length === 0;
  }
  private resolvedUrl(): string {
    return this.opts.localSidecarUrl && this.opts.localSidecarUrl.length > 0
      ? this.opts.localSidecarUrl
      : `ws://127.0.0.1:${this.port}`;
  }
  private async ensureProcess(): Promise<void> {
    if (!this.spawnsOwn) return;
    if (this.proc && !this.proc.killed) return;
    if (!this.opts.localModelPath) {
      throw new Error(
        'WHISPER_BACKEND=local with no URL requires WHISPER_MODEL_PATH to spawn the sidecar (NO FALLBACKS).',
      );
    }
    const { spawn } = await import('node:child_process');
    // `--no-sync`: use the image-baked venv as-is (see kokoro.ts) — plain
    // `uv run` re-syncs to the CUDA-torch lockfile and bloats the disk.
    const proc = spawn('uv', ['run', '--no-sync', 'python', '-m', 'patch_whisper_sidecar'], {
      env: {
        ...process.env,
        WHISPER_MODEL_PATH: this.opts.localModelPath,
        WHISPER_SIDECAR_HOST: '127.0.0.1',
        WHISPER_SIDECAR_PORT: String(this.port),
      },
      ...(this.opts.localSidecarCwd !== undefined ? { cwd: this.opts.localSidecarCwd } : {}),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.on('exit', (code) => {
      this.opts.logger.warn(
        { code },
        'faster-whisper sidecar exited; will respawn on next request',
      );
      this.proc = undefined;
    });
    proc.on('error', (err) => {
      this.opts.logger.error({ err: err.message }, 'faster-whisper sidecar spawn error');
    });
    this.proc = proc;
  }
  private getClient(): PersistentWsClient {
    if (this.client) return this.client;
    this.client = new PersistentWsClient({ url: this.resolvedUrl(), logger: this.opts.logger });
    return this.client;
  }
  async transcribe(pcm: Int16Array): Promise<string> {
    await this.ensureProcess();
    const client = this.getClient();
    // Persistent WS protocol: text envelope `{requestId,samples}` then a
    // binary PCM frame; sidecar replies with a JSON `{requestId,text}`.
    const requestId = `w-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const payload = JSON.stringify({ requestId, samples: pcm.length });
    const binary = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const result = await client.request({
      payload,
      binaryPayload: binary,
      handlers: {
        onJson(msg: unknown) {
          const m = msg as { text?: unknown; requestId?: unknown };
          if (typeof m.text !== 'string') {
            throw new Error('faster-whisper sidecar: missing .text');
          }
          return { done: true, value: m.text };
        },
      },
    });
    return (result as string).trim();
  }
  /**
   * DOCUMENTED LIMITATION (spec/07 § End-to-end voice transport): the
   * faster-whisper Python sidecar's WS protocol takes raw PCM16 samples only
   * (see `transcribe` above — it sends `{requestId,samples}` + a binary PCM
   * frame). It has no path to decode a compressed m4a container, and the
   * host does not bundle an ffmpeg/AAC decoder to transcode it to PCM.
   *
   * Rather than fake a transcript or silently drop the clip, the local backend
   * refuses the upload with a typed error. The mobile voice-note upload path
   * therefore requires `WHISPER_BACKEND=groq` (the production default, which
   * accepts m4a directly). NO FALLBACK.
   */
  async transcribeClip(_audio: Buffer, format: 'm4a' | 'wav'): Promise<string> {
    throw new UnsupportedClipFormatError(
      `WHISPER_BACKEND=local (faster-whisper) cannot transcribe an uploaded ${format} clip: ` +
        'the sidecar accepts PCM16 samples only and the host bundles no AAC/m4a decoder. ' +
        'Use WHISPER_BACKEND=groq (the production default) for the mobile voice-note upload path.',
    );
  }
  async close(): Promise<void> {
    if (this.client) await this.client.close();
    if (this.proc && !this.proc.killed) this.proc.kill('SIGTERM');
  }
}

// --- WAV encoder -----------------------------------------------------------

export function pcm16ToWav(pcm: Int16Array, sampleRate: number): Buffer {
  const dataLen = pcm.length * 2;
  // Header is fixed 44 bytes; build it then concat with a zero-copy
  // Buffer view over the PCM bytes (LE host + LE wire — see server.ts).
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataLen, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // format = PCM
  header.writeUInt16LE(1, 22); // channels = mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(dataLen, 40);
  const body = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  return Buffer.concat([header, body], 44 + dataLen);
}
