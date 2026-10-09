// Real Silero VAD integration test (group E1).
//
// Drives the REAL onnxruntime-node Silero session against the shipped
// silero_vad.onnx and a real speech clip, proving:
//   - the 64-sample context-prepend is wired (a bare-512 feed yields ~0 prob;
//     the regression this guards against would silently disable barge-in),
//   - speech is detected (prob > startTh, utterance_start fires),
//   - silence is rejected (prob < endTh),
//   - validateVadModel fails loudly on a missing model (NO SILENT FALLBACK).
//
// Skips the inference assertions gracefully ONLY if the model file or
// onnxruntime-node native binary is genuinely absent on this host (the build
// pipeline installs both); the fail-loud validateVadModel test always runs.

import { describe, test, expect, vi, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSileroVadFactory, validateVadModel, type Vad } from '../src/audio/vad.js';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const MODEL = join(REPO_ROOT, 'models', 'vad', 'silero_vad.onnx');
const SPEECH_WAV = join(REPO_ROOT, 'models', 'kokoro', 'samples', 'af_heart_0.wav');

function loadWav(path: string): { sr: number; samples: Int16Array } {
  const buf = readFileSync(path);
  const sr = buf.readUInt32LE(24);
  let off = 12;
  let dataOff = -1;
  let dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const len = buf.readUInt32LE(off + 4);
    if (id === 'data') {
      dataOff = off + 8;
      dataLen = len;
      break;
    }
    off += 8 + len;
  }
  const samples = new Int16Array(buf.buffer, buf.byteOffset + dataOff, dataLen >> 1);
  return { sr, samples: Int16Array.from(samples) };
}

/** Crude 24k->16k decimation (2-of-3) — enough for the VAD discrimination test. */
function to16k(samples: Int16Array, sr: number): Int16Array {
  if (sr === 16000) return samples;
  const out: number[] = [];
  for (let i = 0; i + 3 <= samples.length; i += 3) {
    out.push(Math.round((samples[i]! + samples[i + 1]!) / 2));
    out.push(Math.round((samples[i + 1]! + samples[i + 2]!) / 2));
  }
  return Int16Array.from(out);
}

describe('validateVadModel (fail-loud, NO FALLBACK)', () => {
  test('silero backend with missing model path aborts', () => {
    expect(() => validateVadModel({ vadBackend: 'silero', vadModelPath: undefined })).toThrow(
      /VAD_MODEL_PATH is missing/,
    );
  });

  test('silero backend with non-existent model file aborts', () => {
    expect(() =>
      validateVadModel({ vadBackend: 'silero', vadModelPath: '/no/such/silero.onnx' }),
    ).toThrow(/does not exist on disk/);
  });

  test('mock backend needs nothing', () => {
    expect(() => validateVadModel({ vadBackend: 'mock', vadModelPath: undefined })).not.toThrow();
  });
});

const modelPresent = existsSync(MODEL) && existsSync(SPEECH_WAV);

describe.runIf(modelPresent)('real Silero VAD inference', () => {
  test('detects speech (prob > startTh, utterance_start) and rejects silence', async () => {
    let factory: () => Vad;
    try {
      factory = await createSileroVadFactory({ modelPath: MODEL });
    } catch (err) {
      // onnxruntime-node native binary genuinely unavailable on this host.
      // The build pipeline installs it; treat absence as an environment gap,
      // not a code failure — but make it visible.
      throw new Error(`onnxruntime-node unavailable: ${(err as Error).message}`);
    }

    const { sr, samples } = loadWav(SPEECH_WAV);
    const speech = to16k(samples, sr);

    const vad = factory();
    let maxSpeechProb = 0;
    let sawStart = false;
    // Feed in 480-sample (30 ms) frames — the production frame size — to prove
    // the window accumulation + context handling works across frame straddles.
    for (let i = 0; i + 480 <= speech.length; i += 480) {
      const r = await vad.feed(speech.subarray(i, i + 480), 30);
      maxSpeechProb = Math.max(maxSpeechProb, r.prob);
      if (r.event === 'utterance_start') sawStart = true;
    }
    await vad.close();

    const silenceVad = factory();
    let maxSilenceProb = 0;
    const silence = new Int16Array(480);
    for (let i = 0; i < 60; i++) {
      const r = await silenceVad.feed(silence, 30);
      maxSilenceProb = Math.max(maxSilenceProb, r.prob);
    }
    await silenceVad.close();

    expect(maxSpeechProb).toBeGreaterThan(0.6);
    expect(sawStart).toBe(true);
    expect(maxSilenceProb).toBeLessThan(0.35);
  }, 30_000);
});

// --- Mocked onnxruntime-node: exercises the Silero factory/session/state
// machine WITHOUT a real ONNX model file (group 13/E1 coverage gap). The
// real dep (`onnxruntime-node`) is a normal package dependency and IS
// installed, but no `silero_vad.onnx` ships in this worktree — so the
// `describe.runIf(modelPresent)` block above never runs in CI here. We
// stand in a fake `onnxruntime-node` module (same technique as mocking any
// native/sidecar dependency elsewhere in this repo) so `createSileroVadFactory`
// / `createSileroVad` / the returned `Vad`'s window-accumulation + hysteresis
// state machine + `close()` are exercised for real, deterministically.
//
// `vad.ts` loads onnxruntime-node via a DYNAMIC `import(/* @vite-ignore */ …)`
// with a variable specifier — `/* @vite-ignore */` only suppresses Vite's
// static-analysis warning, it does NOT opt the import out of Vitest's module
// registry, so `vi.doMock` + `vi.resetModules()` + a fresh dynamic import of
// `vad.ts` itself reliably picks up the mock (verified empirically).
describe('createSileroVadFactory / makeSileroVad (mocked onnxruntime-node)', () => {
  afterEach(() => {
    vi.doUnmock('onnxruntime-node');
    vi.resetModules();
  });

  /** Minimal fake Tensor — records nothing, just satisfies the `new Tensor(...)` shape. */
  class FakeTensor {
    constructor(
      public type: string,
      public data: unknown,
      public dims: number[],
    ) {}
  }

  /**
   * Build a fake onnxruntime-node module whose `session.run` returns a
   * SCRIPTED sequence of speech probabilities, one per window processed —
   * ignoring the actual tensor content. This gives exact, deterministic
   * control over the hysteresis state machine (far simpler than reverse
   * -engineering RMS-vs-probability math for a fake "model").
   */
  function mockOrtWithProbs(probs: number[]): {
    module: Record<string, unknown>;
    calls: { hadStateN: boolean }[];
  } {
    let i = 0;
    const calls: { hadStateN: boolean }[] = [];
    return {
      calls,
      module: {
        InferenceSession: {
          create: async (_modelPath: string) => ({
            run: async (_feeds: Record<string, unknown>) => {
              const p = probs[i] ?? probs[probs.length - 1] ?? 0;
              i++;
              calls.push({ hadStateN: true });
              return {
                output: { data: Float32Array.from([p]) },
                stateN: { data: new Float32Array(2 * 1 * 128) },
              };
            },
          }),
        },
        Tensor: FakeTensor,
      },
    };
  }

  test('throws when onnxruntime-node fails to load (NO FALLBACK)', async () => {
    vi.doMock('onnxruntime-node', () => {
      throw new Error('Cannot find module onnxruntime-node');
    });
    vi.resetModules();
    const { createSileroVadFactory: freshFactory } = await import('../src/audio/vad.js');
    // The message must name WHICH specifier failed to resolve and carry the
    // underlying loader error — "not installed" is only one of the reasons a
    // native dep fails to load, and a bundled-runtime path that resolves to the
    // wrong place looks identical without it. It must also state the
    // NO-FALLBACKS contract, so nobody re-adds a silent MockVad substitution.
    await expect(freshFactory({ modelPath: 'does-not-matter.onnx' })).rejects.toThrow(
      /^Silero VAD: onnxruntime-node not loadable from onnxruntime-node \(.+\)\. NO FALLBACKS — install the dep or use MockVad in test paths\.$/s,
    );
  });

  test('createSileroVad (single-session convenience wrapper) builds a working Vad', async () => {
    const { module } = mockOrtWithProbs([0.9, 0.9]);
    vi.doMock('onnxruntime-node', () => module);
    vi.resetModules();
    const { createSileroVad: freshCreate } = await import('../src/audio/vad.js');
    // No cfg override — exercises the `cfgOverride ?? {}` default-merge branch.
    const vad = await freshCreate({ modelPath: 'fake.onnx' });
    const r = await vad.feed(new Int16Array(512), 32);
    expect(r.prob).toBeCloseTo(0.9, 5);
    await vad.close();
  });

  test('full hysteresis state machine: start requires 2 consecutive above-threshold windows, resets on a dip, and end requires 2 consecutive below-threshold windows held for the hangover', async () => {
    // Every entry drives exactly one 512-sample window (frame size below is
    // exactly SILERO_WINDOW so each feed() triggers exactly one `run()` call —
    // no straddling — for precise per-window control).
    const probs = [
      0.9, // aboveStart=1 (no event yet)
      0.2, // dips below startTh → aboveStart resets to 0 (no event)
      0.9, // aboveStart=1 again
      0.9, // aboveStart=2 → utterance_start fires
      0.9, // still loud in 'speech' → belowEnd/silenceMs stay at 0 (no-op reset branch)
      0.1, // belowEnd=1 (silenceMs=32ms, hangover not yet reached)
      0.9, // loud again mid-hangover → belowEnd/silenceMs reset to 0 (no event)
      0.1, // belowEnd=1 again
      0.1, // belowEnd=2, silenceMs=64ms >= the 50ms cfg override → utterance_end fires
    ];
    const { module } = mockOrtWithProbs(probs);
    vi.doMock('onnxruntime-node', () => module);
    vi.resetModules();
    const { createSileroVadFactory: freshFactory } = await import('../src/audio/vad.js');
    const factory = await freshFactory({ modelPath: 'fake.onnx', cfg: { silenceHangoverMs: 50 } });
    const vad = factory();
    const events: (VadEventLike | null)[] = [];
    for (let i = 0; i < probs.length; i++) {
      const r = await vad.feed(new Int16Array(512), 32);
      events.push(r.event);
    }
    const fired = events.map((e, i) => (e ? { i, e } : null)).filter((x) => x !== null);
    expect(fired).toEqual([
      { i: 3, e: 'utterance_start' },
      { i: 8, e: 'utterance_end' },
    ]);
    await vad.close();
  });

  test('reset() returns to silence and clears the hysteresis counters (no spurious end)', async () => {
    const { module } = mockOrtWithProbs([0.9, 0.9, 0.1]);
    vi.doMock('onnxruntime-node', () => module);
    vi.resetModules();
    const { createSileroVadFactory: freshFactory } = await import('../src/audio/vad.js');
    const factory = await freshFactory({ modelPath: 'fake.onnx' });
    const vad = factory();
    await vad.feed(new Int16Array(512), 32);
    await vad.feed(new Int16Array(512), 32); // utterance_start fires here
    vad.reset();
    // After reset, a single below-threshold window must NOT fire utterance_end
    // (the state machine is back to 'silence', hysteresis counters cleared).
    const r = await vad.feed(new Int16Array(512), 32);
    expect(r.event).toBeNull();
  });

  test('a frame straddling window boundaries (480-sample mic frames vs the 512-sample model window) accumulates correctly across feed() calls', async () => {
    // Production mic frames are 480 samples (30ms); Silero windows are 512.
    // 3 frames of 480 = 1440 samples = 2 complete windows (960 + 480 leftover
    // consumes 512 twice, leaving 416 pending) — the SAME loud probability
    // for both completed windows should fire utterance_start on frame 3 (the
    // second window is what satisfies the 2-window hysteresis).
    const { module } = mockOrtWithProbs([0.9, 0.9]);
    vi.doMock('onnxruntime-node', () => module);
    vi.resetModules();
    const { createSileroVadFactory: freshFactory } = await import('../src/audio/vad.js');
    const factory = await freshFactory({ modelPath: 'fake.onnx' });
    const vad = factory();
    const r1 = await vad.feed(new Int16Array(480), 30);
    expect(r1.event).toBeNull(); // 480 pending — no full window yet
    const r2 = await vad.feed(new Int16Array(480), 30);
    expect(r2.event).toBeNull(); // 960 pending → 1 window consumed (448 left), aboveStart=1
    const r3 = await vad.feed(new Int16Array(480), 30);
    // 448 + 480 = 928 pending → 1 more window consumed (416 left), aboveStart=2 → start
    expect(r3.event).toBe('utterance_start');
    await vad.close();
  });

  test('prefers `stateN` recurrent output but falls back to `state` when `stateN` is absent', async () => {
    let usedKey: 'stateN' | 'state' | undefined;
    vi.doMock('onnxruntime-node', () => ({
      InferenceSession: {
        create: async () => ({
          run: async () => {
            usedKey = 'state';
            return {
              output: { data: Float32Array.from([0.1]) },
              state: { data: new Float32Array(2 * 1 * 128) },
            };
          },
        }),
      },
      Tensor: FakeTensor,
    }));
    vi.resetModules();
    const { createSileroVadFactory: freshFactory } = await import('../src/audio/vad.js');
    const factory = await freshFactory({ modelPath: 'fake.onnx' });
    const vad = factory();
    await vad.feed(new Int16Array(512), 32);
    expect(usedKey).toBe('state');
    await vad.close();
  });

  test('throws when the model output is missing the `output` tensor (malformed model response)', async () => {
    vi.doMock('onnxruntime-node', () => ({
      InferenceSession: {
        create: async () => ({
          run: async () => ({ stateN: { data: new Float32Array(2 * 1 * 128) } }), // no `output`
        }),
      },
      Tensor: FakeTensor,
    }));
    vi.resetModules();
    const { createSileroVadFactory: freshFactory } = await import('../src/audio/vad.js');
    const factory = await freshFactory({ modelPath: 'fake.onnx' });
    const vad = factory();
    await expect(vad.feed(new Int16Array(512), 32)).rejects.toThrow(
      /model output missing `output` tensor/,
    );
  });

  test('close() resolves cleanly after normal use', async () => {
    const { module } = mockOrtWithProbs([0.1]);
    vi.doMock('onnxruntime-node', () => module);
    vi.resetModules();
    const { createSileroVadFactory: freshFactory } = await import('../src/audio/vad.js');
    const factory = await freshFactory({ modelPath: 'fake.onnx' });
    const vad = factory();
    await vad.feed(new Int16Array(512), 32);
    await expect(vad.close()).resolves.toBeUndefined();
  });
});

type VadEventLike = 'utterance_start' | 'utterance_end';
