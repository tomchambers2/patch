// Unit tests for the 24 kHz → 48 kHz TTS resampler (spec/16: the physical voice
// device's speaker bus is clocked at 48 kHz, so the host resamples Kokoro's
// 24 kHz output up to 48 kHz with one clean linear-phase windowed-sinc pass —
// replacing the old lossy 24→16→48 chain that produced harsh imaging).
//
// These assert the DSP contract directly (no VoiceSession), which the
// integration test in audio-session.test.ts cannot isolate.

import { describe, test, expect } from 'vitest';
import { resampleTtsTo48k } from '../src/audio/session.js';

describe('resampleTtsTo48k (24 kHz → 48 kHz)', () => {
  test('output length is exactly 2× the input (clean 2x upsample)', () => {
    for (const n of [0, 1, 240, 1200, 4801]) {
      const out = resampleTtsTo48k(new Int16Array(n));
      expect(out.length).toBe(n * 2);
    }
  });

  test('silence resamples to silence (no injected garble)', () => {
    const out = resampleTtsTo48k(new Int16Array(960)); // all zeros
    expect(out.length).toBe(1920);
    expect(out.every((v) => v === 0)).toBe(true);
  });

  test('a DC level passes through with near-unity gain and no ripple', () => {
    const D = 6000;
    const input = new Int16Array(960).fill(D);
    const out = resampleTtsTo48k(input);
    // Skip the FIR warm-up/tail (one filter length each side).
    const interior = out.subarray(80, out.length - 80);
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    for (const v of interior) {
      min = Math.min(min, v);
      max = Math.max(max, v);
      sum += v;
    }
    const mean = sum / interior.length;
    // Near-unity DC gain (the FIR is gain-x2 to compensate zero-stuffing).
    expect(mean).toBeGreaterThan(D * 0.85);
    expect(mean).toBeLessThan(D * 1.15);
    // A constant must not oscillate — low ripple in the steady state.
    expect(max - min).toBeLessThan(D * 0.1);
  });

  test('a low tone stays smooth (no aliasing/imaging) and in range', () => {
    // 1 kHz tone at 24 kHz, amplitude 9000.
    const n = 1920;
    const input = new Int16Array(n);
    for (let i = 0; i < n; i++)
      input[i] = Math.round(9000 * Math.sin((2 * Math.PI * 1000 * i) / 24000));
    const out = resampleTtsTo48k(input);
    expect(out.length).toBe(3840);
    let peak = 0;
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(-32768);
      expect(v).toBeLessThanOrEqual(32767);
      peak = Math.max(peak, Math.abs(v));
    }
    // Max per-sample step of a clean 1 kHz tone at 48 kHz ≈ peak·2π·1000/48000
    // ≈ 13% of peak. Imaging garble would produce near-full-scale jumps.
    let maxStep = 0;
    for (let i = 81; i < out.length - 81; i++) {
      maxStep = Math.max(maxStep, Math.abs(out[i]! - out[i - 1]!));
    }
    expect(maxStep).toBeLessThan(peak * 0.25);
    // The tone's amplitude is roughly preserved (linear-phase, unity passband).
    expect(peak).toBeGreaterThan(9000 * 0.8);
    expect(peak).toBeLessThan(9000 * 1.2);
  });

  test('an empty buffer resamples to an empty buffer', () => {
    expect(resampleTtsTo48k(new Int16Array(0)).length).toBe(0);
  });
});
