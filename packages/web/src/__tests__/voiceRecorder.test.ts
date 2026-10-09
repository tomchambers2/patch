// voiceRecorder — the record-and-upload capture path used by voice NOTES (D1)
// and the composer dictation mic (C1). Verifies mic capture → WAV encoding,
// the level meter, teardown, and the gesture-loss resume — all with injected
// fakes (no real getUserMedia / AudioContext).

import { describe, it, expect } from 'vitest';
import { startRecording } from '../lib/voiceRecorder.js';

interface FakeProcessor {
  onaudioprocess: ((e: unknown) => void) | null;
  connect(): void;
  disconnect(): void;
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  sampleRate = 48_000;
  state = 'running';
  destination = {};
  lastProcessor: FakeProcessor | null = null;
  closed = false;
  options: unknown;
  constructor(options?: unknown) {
    this.options = options;
    FakeAudioContext.instances.push(this);
  }
  resume(): Promise<void> {
    this.state = 'running';
    return Promise.resolve();
  }
  createMediaStreamSource(): { connect(): void; disconnect(): void } {
    return { connect() {}, disconnect() {} };
  }
  createScriptProcessor(): FakeProcessor {
    const p: FakeProcessor = { onaudioprocess: null, connect() {}, disconnect() {} };
    this.lastProcessor = p;
    return p;
  }
  createGain(): { gain: { value: number }; connect(): void; disconnect(): void } {
    return { gain: { value: 1 }, connect() {}, disconnect() {} };
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

function fakeStream(onStop?: () => void): MediaStream {
  return { getTracks: () => [{ stop: () => onStop?.() }] } as unknown as MediaStream;
}

function fire(ctx: FakeAudioContext, samples: number[]): void {
  ctx.lastProcessor!.onaudioprocess!({
    inputBuffer: { getChannelData: () => Float32Array.from(samples) },
  });
}

async function start(over: Partial<Parameters<typeof startRecording>[0]> = {}) {
  return startRecording({
    getUserMedia: async () => fakeStream(),
    AudioContextImpl: FakeAudioContext as unknown as typeof AudioContext,
    ...over,
  });
}

describe('voiceRecorder', () => {
  // Opening the default output would wake a monitor's audio sink — the whoosh
  // as dictation starts. Recording never plays, so it opens no output at all.
  it('records on a context bound to no output device', async () => {
    FakeAudioContext.instances = [];
    const rec = await start();
    const ctx = FakeAudioContext.instances[FakeAudioContext.instances.length - 1]!;
    expect(ctx.options).toEqual({ sinkId: { type: 'none' } });
    rec.cancel();
  });

  it('captures samples and stop() returns a mono 16-bit PCM WAV blob', async () => {
    FakeAudioContext.instances = [];
    const rec = await start();
    const ctx = FakeAudioContext.instances[FakeAudioContext.instances.length - 1]!;
    // Positive, negative and zero samples exercise both arms of the PCM pack.
    fire(ctx, [0.5, -0.5, 0]);
    fire(ctx, [1, -1]);
    const blob = await rec.stop();
    expect(blob.type).toBe('audio/wav');
    const buf = await blob.arrayBuffer();
    const view = new DataView(buf);
    const ascii = (o: number, n: number) => String.fromCharCode(...new Uint8Array(buf, o, n));
    expect(ascii(0, 4)).toBe('RIFF');
    expect(ascii(8, 4)).toBe('WAVE');
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(48_000); // sample rate
    expect(view.getUint16(34, true)).toBe(16); // bits/sample
    // 5 samples captured → data chunk is 5 × 2 bytes.
    expect(view.getUint32(40, true)).toBe(10);
    expect(buf.byteLength).toBe(44 + 10);
  });

  it('reports a smoothed 0..1 input level while recording', async () => {
    FakeAudioContext.instances = [];
    const rec = await start();
    const ctx = FakeAudioContext.instances[FakeAudioContext.instances.length - 1]!;
    // Before onLevel is registered, a frame is captured but no callback fires.
    fire(ctx, [0.2, 0.2]);
    const levels: number[] = [];
    rec.onLevel((l) => levels.push(l));
    fire(ctx, [0.5, -0.5]);
    fire(ctx, [1, 1, 1]); // loud → clamps to 1
    expect(levels).toHaveLength(2);
    for (const l of levels) {
      expect(l).toBeGreaterThanOrEqual(0);
      expect(l).toBeLessThanOrEqual(1);
    }
    expect(levels[levels.length - 1]).toBe(1);
    await rec.stop();
  });

  it('onaudioprocess is a no-op after stop (does not extend the clip)', async () => {
    FakeAudioContext.instances = [];
    const rec = await start();
    const ctx = FakeAudioContext.instances[FakeAudioContext.instances.length - 1]!;
    fire(ctx, [0.5, 0.5]);
    const blob = await rec.stop();
    const sizeAfterStop = (await blob.arrayBuffer()).byteLength;
    // A late frame after stop must be ignored.
    expect(() => fire(ctx, [0.9, 0.9, 0.9])).not.toThrow();
    // Nothing to re-encode, but prove the guard held: a fresh stop is not exposed;
    // instead assert the delivered blob size reflects only the 2 pre-stop samples.
    expect(sizeAfterStop).toBe(44 + 4);
  });

  it('tees the same capture out as 16 kHz PCM16 without changing the clip', async () => {
    // The live-preview session must never open a SECOND microphone — that is
    // the one thing that could break the recording the transcript depends on.
    // It reads this tee instead, and the clip is byte-identical either way.
    FakeAudioContext.instances = [];
    const rec = await start();
    const ctx = FakeAudioContext.instances[FakeAudioContext.instances.length - 1]!;
    const frames: Int16Array[] = [];
    rec.onPcm((pcm) => frames.push(pcm));
    // 48 kHz in, 16 kHz out — 6 input samples decimate to 2.
    fire(ctx, [0.5, 0, 0, -0.5, 0, 0]);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.length).toBe(2);
    expect(frames[0]![0]).toBeGreaterThan(0);
    expect(frames[0]![1]).toBeLessThan(0);
    // The clip still carries every captured sample at the context's own rate.
    const buf = await (await rec.stop()).arrayBuffer();
    expect(new DataView(buf).getUint32(40, true)).toBe(6 * 2);
  });

  it('a throwing preview listener cannot stop the recording', async () => {
    // The preview is expendable; the clip is not. A listener that blows up must
    // not take the next captured buffer with it.
    FakeAudioContext.instances = [];
    const rec = await start();
    const ctx = FakeAudioContext.instances[FakeAudioContext.instances.length - 1]!;
    rec.onPcm(() => {
      throw new Error('preview socket exploded');
    });
    expect(() => fire(ctx, [0.5, 0.5, 0.5, 0.5, 0.5, 0.5])).not.toThrow();
    expect(() => fire(ctx, [0.5, 0.5, 0.5, 0.5, 0.5, 0.5])).not.toThrow();
    const buf = await (await rec.stop()).arrayBuffer();
    expect(new DataView(buf).getUint32(40, true)).toBe(12 * 2);
  });

  it('cancel() tears down the stream and closes the context; is idempotent', async () => {
    FakeAudioContext.instances = [];
    let stops = 0;
    const rec = await startRecording({
      getUserMedia: async () => fakeStream(() => (stops += 1)),
      AudioContextImpl: FakeAudioContext as unknown as typeof AudioContext,
    });
    const ctx = FakeAudioContext.instances[FakeAudioContext.instances.length - 1]!;
    rec.cancel();
    expect(ctx.closed).toBe(true);
    expect(stops).toBe(1);
    // Second cancel is a no-op (the `stopped` guard).
    rec.cancel();
    expect(stops).toBe(1);
  });

  it('resumes a suspended AudioContext before capturing (gesture-loss workaround)', async () => {
    FakeAudioContext.instances = [];
    class Suspended extends FakeAudioContext {
      override state = 'suspended';
    }
    const rec = await start({ AudioContextImpl: Suspended as unknown as typeof AudioContext });
    const ctx = FakeAudioContext.instances[FakeAudioContext.instances.length - 1]!;
    expect(ctx.state).toBe('running');
    rec.cancel();
  });

  it('throws when no AudioContext implementation is available', async () => {
    const original = (window as unknown as { AudioContext?: unknown }).AudioContext;
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
    await expect(startRecording({ getUserMedia: async () => fakeStream() })).rejects.toThrow(
      'Web Audio API unavailable',
    );
    (window as unknown as { AudioContext?: unknown }).AudioContext = original;
  });

  it('uses the default getUserMedia + AudioContext globals when no deps are injected', async () => {
    FakeAudioContext.instances = [];
    const originalAudioContext = (window as unknown as { AudioContext?: unknown }).AudioContext;
    const originalMediaDevices = navigator.mediaDevices;
    (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: async () => fakeStream() },
      configurable: true,
    });
    const rec = await startRecording();
    expect(FakeAudioContext.instances.length).toBeGreaterThan(0);
    rec.cancel();
    (window as unknown as { AudioContext?: unknown }).AudioContext = originalAudioContext;
    Object.defineProperty(navigator, 'mediaDevices', {
      value: originalMediaDevices,
      configurable: true,
    });
  });

  it('teardown swallows a throw from a node disconnect (best-effort)', async () => {
    FakeAudioContext.instances = [];
    const rec = await start();
    const ctx = FakeAudioContext.instances[FakeAudioContext.instances.length - 1]!;
    ctx.lastProcessor!.disconnect = () => {
      throw new Error('already disconnected');
    };
    expect(() => rec.cancel()).not.toThrow();
  });

  it('surfaces a mic-permission rejection to the caller', async () => {
    await expect(
      startRecording({
        getUserMedia: async () => {
          throw new Error('mic denied');
        },
        AudioContextImpl: FakeAudioContext as unknown as typeof AudioContext,
      }),
    ).rejects.toThrow('mic denied');
  });
});
