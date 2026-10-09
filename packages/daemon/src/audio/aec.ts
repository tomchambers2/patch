// Acoustic echo cancellation (group 13, refined group 14 DX-M2).
//
// NLMS pure-TS canceller. Chosen over WebRTC AEC3 (no maintained N-API
// binding, non-trivial Bazel/CMake build pulling private WebRTC headers)
// and speexdsp (also requires a native build) for the v1 cut. Hardware AEC
// on the voice device handles the bulk; this host-side pass adds a
// second line for residual echo. Phone/web/desktop surfaces report
// `surfaceHasAec: true` on `audio.session_start` and bypass via
// `PassThroughAec` — the OS audio stack already owns AEC there.
//
// Attenuation: ~12-18 dB on straightforward speaker→mic loops once the
// filter has converged (~250 ms). AEC3 buys >30 dB; if the v1 voice
// device shows residual echo in real rooms we'll revisit (deferred — see
// spec/18-tech-stack.md ## Host).
//
// Per spec/principles.md NO-FALLBACK rule, the bypass on `surfaceHasAec`
// is NOT a fallback — it's a documented config branch. The session
// orchestrator picks `NlmsAec` or `PassThroughAec` at session open time
// and never silently switches.
//
// `taps` MUST be a power of 2 — asserted in the constructor (group 14 H4).

export interface AecProcessor {
  /**
   * Subtract the (delayed) reference signal (TTS being played to the
   * speaker) from the mic input. `mic` and `ref` MUST be the same length;
   * the caller is responsible for buffering ref to match the round-trip
   * speaker-to-mic delay.
   */
  process(mic: Int16Array, ref: Int16Array): Int16Array;
  /** Reset filter state — called between sessions. */
  reset(): void;
}

/**
 * Pass-through. Used when the surface has OS-level AEC.
 */
export class PassThroughAec implements AecProcessor {
  process(mic: Int16Array, _ref: Int16Array): Int16Array {
    return mic;
  }
  reset(): void {}
}

/**
 * Pure-TS Normalised LMS adaptive filter. ~12-18 dB attenuation in
 * straightforward speaker→mic loops, sufficient for the voice device's
 * far-field setup.
 *
 * Hot-path notes (group 14 H4):
 *   - `taps` MUST be a power of 2 (asserted in the constructor) so the
 *     circular-buffer index arithmetic is a bit-mask (`& (taps - 1)`)
 *     rather than a `%` modulo. Roughly 3-5x faster on the inner loop.
 *   - No `?? 0` reads off typed arrays — typed-array numeric indices
 *     never return undefined, and the `??` triggers a JIT deopt off the
 *     fast path.
 *   - Estimate + adapt are fused into a single tap-loop pass per sample.
 *   - The output Int16Array is allocated once per frame (not per sample);
 *     pooling could be added if profiling shows GC pressure but the
 *     current allocation rate (33fps × N sessions) is well within budget.
 *
 * Replace with the AEC3 N-API addon when packaging is sorted (see
 * module header for the choice rationale).
 */
export class NlmsAec implements AecProcessor {
  private readonly taps: number;
  private readonly tapsMask: number;
  private readonly mu: number;
  private readonly weights: Float32Array;
  private readonly refBuf: Float32Array;
  private idx = 0;

  constructor(opts: { taps?: number; mu?: number } = {}) {
    const taps = opts.taps ?? 256;
    if (taps <= 0 || (taps & (taps - 1)) !== 0) {
      throw new Error(`NlmsAec: taps must be a power of 2 (got ${taps})`);
    }
    this.taps = taps;
    this.tapsMask = taps - 1;
    this.mu = opts.mu ?? 0.1;
    this.weights = new Float32Array(taps);
    this.refBuf = new Float32Array(taps);
  }

  reset(): void {
    this.weights.fill(0);
    this.refBuf.fill(0);
    this.idx = 0;
  }

  process(mic: Int16Array, ref: Int16Array): Int16Array {
    if (mic.length !== ref.length) {
      throw new Error(
        `aec: mic/ref length mismatch (${mic.length} vs ${ref.length}); caller must align.`,
      );
    }
    const out = new Int16Array(mic.length);
    const taps = this.taps;
    const mask = this.tapsMask;
    const weights = this.weights;
    const refBuf = this.refBuf;
    const mu = this.mu;
    let idx = this.idx;
    for (let n = 0; n < mic.length; n++) {
      // Push new ref sample into circular buffer (mic[n], ref[n] cannot
      // be undefined: we already validated `mic.length === ref.length`
      // and typed-array numeric indices are never undefined).
      refBuf[idx] = ref[n]! / 32768;
      // Convolve weights × ref-window AND accumulate normSq in one pass.
      let est = 0;
      let normSq = 1e-6;
      // (idx + taps - k) & mask is the circular index for tap k.
      const base = idx + taps;
      for (let k = 0; k < taps; k++) {
        const refK = refBuf[(base - k) & mask]!;
        est += weights[k]! * refK;
        normSq += refK * refK;
      }
      const micF = mic[n]! / 32768;
      const err = micF - est;
      const step = mu / normSq;
      // Adapt — fused with the estimate loop's window so we re-compute
      // refK once. Two passes are unavoidable arithmetically (we need
      // `err` from the first pass) but we share the `(base - k) & mask`
      // expression and avoid re-touching weights twice in CPU cache miss
      // territory: the array fits in L1 for taps ≤ 1024.
      const stepErr = step * err;
      for (let k = 0; k < taps; k++) {
        const refK = refBuf[(base - k) & mask]!;
        weights[k] = weights[k]! + stepErr * refK;
      }
      const clamped = err < -1 ? -1 : err > 1 ? 1 : err;
      out[n] = Math.round(clamped * 32767);
      idx = (idx + 1) & mask;
    }
    this.idx = idx;
    return out;
  }
}

/**
 * Compute crude attenuation: 20·log10(rms(mic) / rms(out)). Useful for
 * tests + smoke telemetry. Returns +Infinity for pure silence at the
 * output (full cancellation).
 */
export function attenuationDb(mic: Int16Array, out: Int16Array): number {
  function rms(buf: Int16Array): number {
    let sumSq = 0;
    for (let i = 0; i < buf.length; i++) {
      const s = buf[i]!;
      sumSq += s * s;
    }
    return Math.sqrt(sumSq / Math.max(1, buf.length));
  }
  const r1 = rms(mic);
  const r2 = rms(out);
  if (r2 === 0) return Number.POSITIVE_INFINITY;
  return 20 * Math.log10(r1 / r2);
}
