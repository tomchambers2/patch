// Mic Float32 → PCM16 at the host's 16 kHz, for anything that streams mic
// audio over the audio WSS.
//
// The AudioContext runs at the hardware's own rate (44.1/48 kHz), the host's
// Whisper path wants 16 kHz mono PCM16, and a ScriptProcessor hands over a
// fixed-size buffer whose length is not a whole number of output samples. The
// leftover fraction has to be carried into the next callback or the stream
// drifts, so the resampler is stateful and there is exactly one of it per
// capture.

/** Sample rate the host's Whisper path expects. */
export const MIC_SAMPLE_RATE = 16_000;

/**
 * Build a stateful linear decimator from `inputSampleRate` down to
 * `targetRate`. Call the returned function with each successive input buffer;
 * it returns that buffer's PCM16 samples and carries the fractional read
 * position across calls.
 */
export function createPcm16Downsampler(
  inputSampleRate: number,
  targetRate: number = MIC_SAMPLE_RATE,
): (input: Float32Array) => Int16Array {
  const ratio = inputSampleRate / targetRate;
  let carry = 0;
  return (input: Float32Array): Int16Array => {
    const out: number[] = [];
    for (let pos = carry; pos < input.length; pos += ratio) {
      /* v8 ignore next -- `pos < input.length` is the loop invariant and floor only decreases, so `input[Math.floor(pos)]` is always defined; the `?? 0` only exists to satisfy noUncheckedIndexedAccess. */
      const s = input[Math.floor(pos)] ?? 0;
      const clamped = Math.max(-1, Math.min(1, s));
      out.push(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
    }
    carry = carry + Math.ceil((input.length - carry) / ratio) * ratio - input.length;
    /* v8 ignore next -- defensive floating-point safety net: exhaustive search across sample rates (8kHz-96kHz) and buffer sizes found no input that drives this negative — the ceil()-based carry formula stays in [0, ratio) by construction. */
    if (carry < 0) carry = 0;
    return new Int16Array(out);
  };
}
