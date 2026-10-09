// Silero VAD wrapper (group 13).
//
// At runtime: load `silero_vad.onnx` via `onnxruntime-node` and feed 30ms
// PCM16 frames. Silero outputs a per-frame speech probability ∈ [0, 1].
// We track a sliding state machine:
//
//   silence → (speech-prob > startTh) → speech
//   speech → (speech-prob < endTh for `silenceHangoverMs`) → silence + END
//
// END-of-utterance is what the session orchestrator listens for to flush
// the buffered mic audio to Whisper. While Kokoro is streaming TTS, the
// SAME VAD instance still runs and a START transition is what fires
// barge-in.
//
// onnxruntime-node is a heavy native dep — we lazy-load it so importing
// this module from a unit test that uses MockVad doesn't pay the cost.
//
// NO FALLBACK: model file missing → fail loudly at first session, NOT
// at import time (matches the lazy-fail policy for Whisper/Kokoro creds).

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bundledNativeDir } from '../installPaths.js';

export interface VadFrameResult {
  /** Per-frame speech probability ∈ [0, 1]. */
  prob: number;
  /** Transition that just fired (if any). */
  event: 'utterance_start' | 'utterance_end' | null;
  /** Current state AFTER the event. */
  state: 'silence' | 'speech';
}

export interface VadConfig {
  /** Sample rate of the input PCM. Silero ships 16 kHz model. */
  sampleRate: 16000;
  /** prob > startTh → silence-to-speech transition. */
  startTh: number;
  /** prob < endTh sustained for hangover → speech-to-silence transition. */
  endTh: number;
  /** ms of below-endTh probability needed to declare end-of-utterance. */
  silenceHangoverMs: number;
}

export const DEFAULT_VAD_CONFIG: VadConfig = {
  sampleRate: 16000,
  startTh: 0.6,
  endTh: 0.35,
  silenceHangoverMs: 500,
};

/** Subset of the host's audio config the Silero startup check needs. */
export interface VadModelConfig {
  vadBackend: 'silero' | 'mock';
  vadModelPath?: string | undefined;
}

/**
 * Eager startup validation of the Silero VAD model file (spec/18 § Daemon:
 * "Silero VAD via onnxruntime-node (the model ships as ONNX)"; spec/07
 * Barge-in). For vadBackend='silero': VAD_MODEL_PATH must be set AND exist on
 * disk. The `mock` backend needs nothing. NO SILENT FALLBACK — throwing here
 * aborts host boot before the audio WSS accepts sessions, so a voice session
 * can never open against a host whose barge-in/EOU detection would fail.
 */
export function validateVadModel(
  config: VadModelConfig,
  existsSyncImpl: (p: string) => boolean = existsSync,
): void {
  if (config.vadBackend !== 'silero') return;
  const path = config.vadModelPath;
  if (!path || path.length === 0) {
    throw new Error(
      'VAD_BACKEND=silero but VAD_MODEL_PATH is missing. ' +
        'Set VAD_MODEL_PATH to silero_vad.onnx on disk, or switch VAD_BACKEND=mock. ' +
        'Refusing to start in a degraded mode (NO SILENT FALLBACK).',
    );
  }
  if (!existsSyncImpl(path)) {
    throw new Error(
      `VAD_MODEL_PATH points at a path that does not exist on disk: ${path}. ` +
        'A missing Silero model must abort at startup, not silently disable barge-in (NO SILENT FALLBACK).',
    );
  }
}

export interface Vad {
  /**
   * Process one frame of int16 PCM at the configured sample rate.
   *
   * Async because the real Silero backend runs ONNX inference per frame
   * (onnxruntime's session.run is async-only). The mock backend resolves
   * synchronously. Callers MUST await so the returned probability reflects
   * THIS frame, not a stale previous one.
   */
  feed(frame: Int16Array, frameMs: number): Promise<VadFrameResult>;
  reset(): void;
  close(): Promise<void>;
}

/**
 * Mock VAD for tests + the host's mock backends. Drives transitions off a
 * deterministic energy threshold (RMS of int16 samples) — sufficient for
 * the orchestrator + barge-in tests without pulling onnxruntime-node into
 * vitest.
 */
export class MockVad implements Vad {
  private state: 'silence' | 'speech' = 'silence';
  private silenceMs = 0;
  private readonly cfg: VadConfig;

  constructor(cfg: Partial<VadConfig> = {}) {
    this.cfg = { ...DEFAULT_VAD_CONFIG, ...cfg };
  }

  async feed(frame: Int16Array, frameMs: number): Promise<VadFrameResult> {
    let sumSq = 0;
    for (let i = 0; i < frame.length; i++) {
      const s = frame[i]!;
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / Math.max(1, frame.length));
    // Map int16 rms → pseudo-prob ∈ [0,1]. 5000 RMS ≈ normal speech.
    const prob = Math.min(1, rms / 5000);
    let event: VadFrameResult['event'] = null;
    if (this.state === 'silence' && prob > this.cfg.startTh) {
      this.state = 'speech';
      this.silenceMs = 0;
      event = 'utterance_start';
    } else if (this.state === 'speech') {
      if (prob < this.cfg.endTh) {
        this.silenceMs += frameMs;
        if (this.silenceMs >= this.cfg.silenceHangoverMs) {
          this.state = 'silence';
          this.silenceMs = 0;
          event = 'utterance_end';
        }
      } else {
        this.silenceMs = 0;
      }
    }
    return { prob, event, state: this.state };
  }

  reset(): void {
    this.state = 'silence';
    this.silenceMs = 0;
  }

  async close(): Promise<void> {
    /* nothing to clean up */
  }
}

/**
 * Real Silero-via-onnxruntime VAD. Lazy-loads the runtime so unit tests
 * never pay the import. Throws at CONSTRUCTION if onnxruntime-node isn't
 * installed or the model file is unreadable — matches the NO-FALLBACK
 * rule (failing loudly is correct).
 *
 * KNOWN GAP (group 14 H3): the real ONNX `session.run` is wired but the
 * tensor input layout (Silero v5: `input` [1, N], `state` [2, 1, 128],
 * `sr` scalar int64) and the `state`/`stateN` recurrent rollover are
 * not exhaustively validated against the upstream model release on this
 * machine. The implementation below follows the documented Silero v5
 * shapes; if the loaded model expects v4 (h/c separately), it will throw
 * at the first `run()` call rather than silently misbehaving. Group 23
 * tightens this alongside the voice-device firmware integration.
 */
/** Minimal shape of the loaded ONNX session + Tensor ctor we depend on. */
interface SileroOrt {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Tensor: new (type: string, data: any, dims: number[]) => unknown;
  session: {
    run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array }>>;
  };
}

/**
 * Load onnxruntime-node + the Silero ONNX session ONCE. The returned factory
 * builds a fresh stateful `Vad` per voice session (each carries its own
 * recurrent state + state machine) while sharing the single heavy ORT session
 * — `session.run` is stateless w.r.t. the host (the recurrent state is
 * passed in/out each call), so concurrent sessions are safe.
 *
 * Throws at load if onnxruntime-node isn't installed or the model is
 * unreadable (NO FALLBACK).
 */
export async function createSileroVadFactory(opts: {
  modelPath: string;
  cfg?: Partial<VadConfig>;
}): Promise<() => Vad> {
  // Dynamic import so onnxruntime-node isn't required for `pnpm test`.
  //
  // An INSTALLED host has no node_modules: the platform's prebuilt addon ships
  // in the artifact's own `native/` directory (spec/18 § Two shipping shapes),
  // so it is imported from there by path. A source checkout has no `native/` and
  // resolves the workspace dependency by name. Neither is a fallback for the
  // other — each is how that program finds the one copy it has.
  const native = bundledNativeDir();
  const ortModuleName: string = native
    ? pathToFileURL(join(native, 'onnxruntime-node', 'dist', 'index.js')).href
    : 'onnxruntime-node';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ort: any;
  try {
    ort = await import(/* @vite-ignore */ ortModuleName);
  } catch (err) {
    throw new Error(
      `Silero VAD: onnxruntime-node not loadable from ${ortModuleName} (${(err as Error).message}). ` +
        'NO FALLBACKS — install the dep or use MockVad in test paths.',
    );
  }
  const session = (await ort.InferenceSession.create(opts.modelPath)) as SileroOrt['session'];
  const loaded: SileroOrt = { Tensor: ort.Tensor, session };
  return () => makeSileroVad(loaded, opts.cfg);
}

/**
 * Backwards-compatible single-session constructor (used by probes/tests):
 * loads the session and returns one `Vad`.
 */
export async function createSileroVad(opts: {
  modelPath: string;
  cfg?: Partial<VadConfig>;
}): Promise<Vad> {
  const factory = await createSileroVadFactory(opts);
  return factory();
}

// Silero v5 @ 16 kHz processes EXACTLY 512-sample windows, each prefixed with
// the 64-sample tail of the previous window (model input length = 64 + 512 =
// 576). This context-prepend is mandatory — feeding a bare 512-sample frame
// (no context) yields near-zero speech probability even on clear speech (the
// model never sees the onset transient). See the upstream OnnxWrapper.
const SILERO_WINDOW = 512;
const SILERO_CONTEXT = 64;
// Per-window duration at 16 kHz, used for the silence-hangover accounting.
const WINDOW_MS = (SILERO_WINDOW / 16000) * 1000;

function makeSileroVad(ort: SileroOrt, cfgOverride?: Partial<VadConfig>): Vad {
  const session = ort.session;
  const cfg = { ...DEFAULT_VAD_CONFIG, ...(cfgOverride ?? {}) };
  let state: 'silence' | 'speech' = 'silence';
  let silenceMs = 0;
  // Silero v5 recurrent state: shape [2, 1, 128].
  let recurrent = new Float32Array(2 * 1 * 128);
  // 64-sample context carried between windows (last 64 samples of the prior
  // model input). Zeroed at start / reset.
  let context = new Float32Array(SILERO_CONTEXT);
  // Accumulates incoming float32 samples until a full 512-sample window is
  // available (incoming frames are 480 = 30 ms, so windows straddle frames).
  let pending: number[] = [];
  // Pre-allocated model input: [context(64) ++ window(512)] = 576.
  const modelInput = new Float32Array(SILERO_CONTEXT + SILERO_WINDOW);
  const TensorCtor = ort.Tensor;
  const SrTensorCtor = ort.Tensor;
  const sr = new BigInt64Array([16000n]);

  // Hysteresis: require N consecutive windows above startTh / below endTh
  // to flip state, riding out single-window glitches.
  let aboveStart = 0;
  let belowEnd = 0;
  const HYSTERESIS_FRAMES = 2;

  // The ORT session is async-only; serialise inferences on a tail promise so
  // the recurrent `state` + `context` rollover stays strictly ordered.
  let inferenceTail: Promise<unknown> = Promise.resolve();

  async function runWindow(window: Float32Array): Promise<number> {
    // Build [context ++ window] then update context to the last 64 samples.
    modelInput.set(context, 0);
    modelInput.set(window, SILERO_CONTEXT);
    const inputTensor = new TensorCtor('float32', modelInput, [1, modelInput.length]);
    const stateTensor = new TensorCtor('float32', recurrent, [2, 1, 128]);
    const srTensor = new SrTensorCtor('int64', sr, []);
    const out = await session.run({ input: inputTensor, state: stateTensor, sr: srTensor });
    if (out.stateN && out.stateN.data) recurrent = out.stateN.data;
    else if (out.state && out.state.data) recurrent = out.state.data;
    // Carry the last 64 samples of THIS model input as the next context.
    context = modelInput.slice(modelInput.length - SILERO_CONTEXT);
    if (out.output && out.output.data && out.output.data.length > 0) {
      // `?? 0` is unreachable: `data` is a Float32Array and we've just
      // checked `data.length > 0`, so `data[0]` is always a number, never
      // undefined (typed-array numeric indices never return undefined —
      // same reasoning as the AEC hot-path, see aec.ts header).
      return out.output.data[0] ?? 0; /* v8 ignore next */
    }
    throw new Error('Silero VAD: model output missing `output` tensor');
  }

  /** Run the state machine for one window's probability; returns any event. */
  function step(prob: number): VadFrameResult['event'] {
    if (state === 'silence') {
      if (prob > cfg.startTh) aboveStart++;
      else aboveStart = 0;
      if (aboveStart >= HYSTERESIS_FRAMES) {
        state = 'speech';
        aboveStart = 0;
        belowEnd = 0;
        silenceMs = 0;
        return 'utterance_start';
      }
    } else {
      if (prob < cfg.endTh) {
        belowEnd++;
        silenceMs += WINDOW_MS;
        if (belowEnd >= HYSTERESIS_FRAMES && silenceMs >= cfg.silenceHangoverMs) {
          state = 'silence';
          belowEnd = 0;
          silenceMs = 0;
          return 'utterance_end';
        }
      } else {
        belowEnd = 0;
        silenceMs = 0;
      }
    }
    return null;
  }

  return {
    async feed(frame: Int16Array): Promise<VadFrameResult> {
      for (let i = 0; i < frame.length; i++) pending.push(frame[i]! / 32768);
      let lastProb = 0;
      let firedStart: VadFrameResult['event'] = null;
      let firedEnd: VadFrameResult['event'] = null;
      // Drain every complete 512-sample window in this frame.
      while (pending.length >= SILERO_WINDOW) {
        const window = Float32Array.from(pending.slice(0, SILERO_WINDOW));
        pending = pending.slice(SILERO_WINDOW);
        const run = inferenceTail.then(() => runWindow(window));
        inferenceTail = run.catch(() => undefined);
        lastProb = await run;
        const ev = step(lastProb);
        // A single feed() can span multiple windows; surface the most
        // salient transition (start takes priority so barge-in never misses).
        if (ev === 'utterance_start') firedStart = ev;
        else if (ev === 'utterance_end') firedEnd = ev;
      }
      const event = firedStart ?? firedEnd;
      return { prob: lastProb, event, state };
    },
    reset(): void {
      state = 'silence';
      silenceMs = 0;
      aboveStart = 0;
      belowEnd = 0;
      recurrent = new Float32Array(2 * 1 * 128);
      context = new Float32Array(SILERO_CONTEXT);
      pending = [];
      inferenceTail = Promise.resolve();
    },
    async close(): Promise<void> {
      // `inferenceTail` is only ever assigned `Promise.resolve()` or
      // `somePromise.catch(() => undefined)` (see `feed()` / `reset()`
      // above), so it can never reject: the catch below is unreachable
      // defensive code, not a real path.
      try {
        await inferenceTail;
        /* v8 ignore next 3 */
      } catch {
        /* swallow */
      }
    },
  };
}
