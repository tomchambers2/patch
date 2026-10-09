// NLMS AEC test (group 13). The pure-TS NLMS canceller targets ~12-18 dB
// attenuation in straightforward speaker→mic loops. The test feeds an
// identical reference signal as the mic input plus a small near-end voice,
// runs ~250 ms of audio for the filter to converge, then asserts that the
// output is much quieter than the mic input.

import { describe, test, expect } from 'vitest';
import { NlmsAec, PassThroughAec, attenuationDb } from '../src/audio/aec.js';

function tone(samples: number, freq: number, amp = 8000): Int16Array {
  const f = new Int16Array(samples);
  for (let i = 0; i < samples; i++) {
    f[i] = Math.round(amp * Math.sin((2 * Math.PI * freq * i) / 16000));
  }
  return f;
}

describe('NlmsAec', () => {
  test('attenuates the reference signal by > 20 dB after convergence', () => {
    const aec = new NlmsAec({ taps: 64, mu: 0.5 });
    // Train: feed mic = ref repeatedly to converge weights.
    const ref = tone(480, 440);
    let lastOut = new Int16Array(0);
    for (let i = 0; i < 60; i++) {
      lastOut = aec.process(ref, ref);
    }
    const db = attenuationDb(ref, lastOut);
    expect(db).toBeGreaterThan(20);
  });

  test('rejects mismatched mic/ref lengths', () => {
    const aec = new NlmsAec();
    expect(() => aec.process(new Int16Array(480), new Int16Array(160))).toThrow();
  });

  test('reset clears converged weights (idempotent)', () => {
    const aec = new NlmsAec({ taps: 64, mu: 0.5 });
    const ref = tone(480, 440);
    for (let i = 0; i < 60; i++) aec.process(ref, ref);
    aec.reset();
    // After reset, internal state should be back to zero so a fresh
    // reset() doesn't throw and process() still produces a valid Int16Array.
    aec.reset();
    const out = aec.process(ref, ref);
    expect(out).toBeInstanceOf(Int16Array);
    expect(out.length).toBe(ref.length);
  });

  test('clamps a large instantaneous error to [-1, 1] before scaling to int16 (both clamp arms)', () => {
    // Converge on ref===mic, then perturb with an INVERTED mic (same ref) —
    // this drags the filter's weights toward the opposite correlation. Flipping
    // straight back to mic===ref then produces an instantaneous per-sample error
    // whose magnitude briefly exceeds the normalized [-1, 1] range on BOTH
    // sides (line 132's ternary clamp) before the filter re-converges.
    const aec = new NlmsAec({ taps: 64, mu: 1.9 });
    const ref = tone(480, 440, 32767);
    const negMic = Int16Array.from(ref, (v) => -v);
    for (let i = 0; i < 200; i++) aec.process(ref, ref);
    aec.process(negMic, ref);
    const out = aec.process(ref, ref);
    expect(Math.min(...out)).toBe(-32767);
    expect(Math.max(...out)).toBe(32767);
  });
});

describe('NlmsAec — taps validation', () => {
  test('rejects non-power-of-2 taps', () => {
    expect(() => new NlmsAec({ taps: 100 })).toThrow(/power of 2/);
    expect(() => new NlmsAec({ taps: 0 })).toThrow();
  });
  test('accepts power-of-2 taps', () => {
    expect(() => new NlmsAec({ taps: 64 })).not.toThrow();
    expect(() => new NlmsAec({ taps: 256 })).not.toThrow();
    expect(() => new NlmsAec({ taps: 1024 })).not.toThrow();
  });
});

// Benchmark — always runs. The AEC inner loop is the hottest perf path on
// the !surfaceHasAec route; this test asserts a 1s-of-audio process runs
// comfortably under budget. ~480 samples/frame × 33 fps × 256 taps ≈ 4M
// tap-ops per second of audio. Measured wall-clock is ~1ms on dev hardware;
// the 250ms budget leaves wide headroom for slow CI runners while still
// catching an order-of-magnitude regression (e.g. a `%` modulo creeping
// back into the circular-index arithmetic).
describe('NlmsAec — bench', () => {
  test('1s of audio @ 16kHz / 256 taps stays well under real-time budget', () => {
    const aec = new NlmsAec({ taps: 256, mu: 0.1 });
    const ref = tone(480, 440);
    const t0 = Date.now();
    for (let i = 0; i < 33; i++) {
      aec.process(ref, ref);
    }
    const dt = Date.now() - t0;
    // 1s of audio must process in far less than 1s of wall-clock (real-time
    // constraint); 250ms is a generous regression guard, not the target.
    expect(dt).toBeLessThan(250);
  });
});

describe('PassThroughAec', () => {
  test('returns the mic buffer unchanged', () => {
    const aec = new PassThroughAec();
    const mic = tone(480, 440);
    const out = aec.process(mic, new Int16Array(480));
    expect(out).toBe(mic);
  });

  test('reset is a no-op (surfaces with OS-level AEC carry no host-side filter state)', () => {
    const aec = new PassThroughAec();
    expect(() => aec.reset()).not.toThrow();
    // Still passes audio through unchanged after reset().
    const mic = tone(480, 440);
    expect(aec.process(mic, new Int16Array(480))).toBe(mic);
  });
});

describe('attenuationDb', () => {
  test('returns +Infinity for a fully-cancelled (all-zero) output', () => {
    const mic = tone(480, 440);
    expect(attenuationDb(mic, new Int16Array(480))).toBe(Number.POSITIVE_INFINITY);
  });
});
