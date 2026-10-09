// meetingCapture — turns live audio into short 16 kHz mono WAV clips for the
// host's local Whisper (`meeting.audio`). One capture per source: the mic
// ("you") and, on the desktop app, system audio ("them").
//
// Clips are cut by sample count, not by a timer, so a hidden window's
// throttled timers cannot stall it: ScriptProcessor callbacks are driven by the
// audio clock, and the desktop shell turns background throttling off. A clip
// below the silence floor is dropped here, because Whisper invents words
// ("Thank you.") from silence. NO FALLBACK: a denied mic or missing Web Audio
// API rejects `startMeetingCapture`.
//
// The mic is a MediaStream. System audio ("them") is NOT: the desktop shell's
// native helper taps it and hands over 16 kHz PCM (`PcmFeed`), so no screen is
// ever shared to hear a call.

import { createPcm16Downsampler, MIC_SAMPLE_RATE } from './pcmDownsample.js';
import { silentAudioContext } from './silentAudioContext.js';

export const CLIP_SECONDS = 15;
/** A tail shorter than this on stop is not worth a Whisper call. */
export const MIN_TAIL_SECONDS = 1;
/** RMS (0..1 of full scale) below which a clip is treated as silence. */
export const SILENCE_RMS = 0.004;

export type MeetingSource = 'mic' | 'system';

export function rmsOfPcm16(pcm: Int16Array): number {
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) {
    const v = (pcm[i] ?? 0) / 0x8000;
    sum += v * v;
  }
  return Math.sqrt(sum / pcm.length);
}

export function pcm16ToWav(pcm: Int16Array, sampleRate: number = MIC_SAMPLE_RATE): Uint8Array {
  const dataSize = pcm.length * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const ascii = (o: number, t: string): void => {
    for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, 'data');
  v.setUint32(40, dataSize, true);
  new Int16Array(buf, 44).set(pcm);
  return new Uint8Array(buf);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** Accumulates PCM and emits a WAV clip each time `clipSeconds` of it is full. */
export class ClipBuilder {
  private parts: Int16Array[] = [];
  private samples = 0;
  constructor(
    private readonly onClip: (wav: Uint8Array) => void,
    private readonly clipSeconds: number = CLIP_SECONDS,
  ) {}

  push(pcm: Int16Array): void {
    this.parts.push(pcm);
    this.samples += pcm.length;
    if (this.samples >= this.clipSeconds * MIC_SAMPLE_RATE) this.emit();
  }

  /** Emit what is buffered (if worth transcribing) and start over. */
  flush(): void {
    if (this.samples >= MIN_TAIL_SECONDS * MIC_SAMPLE_RATE) this.emit();
    else this.discard();
  }

  discard(): void {
    this.parts = [];
    this.samples = 0;
  }

  private emit(): void {
    const all = new Int16Array(this.samples);
    let o = 0;
    for (const p of this.parts) {
      all.set(p, o);
      o += p.length;
    }
    this.discard();
    if (rmsOfPcm16(all) < SILENCE_RMS) return;
    this.onClip(pcm16ToWav(all));
  }
}

export interface MeetingCaptureDeps {
  AudioContextImpl?: typeof AudioContext;
  clipSeconds?: number;
}

/** Audio that is already 16 kHz mono PCM16, e.g. the desktop shell's system-audio tap. */
export interface PcmFeed {
  subscribe(onPcm: (pcm: Int16Array) => void): () => void;
  /** Stop the underlying source. Called once, on `stop()`. */
  stop(): void;
}

export interface MeetingSources {
  mic?: MediaStream;
  system?: PcmFeed;
}

export interface MeetingCapture {
  /** While paused, audio is dropped (a partial clip is flushed first). */
  setPaused(paused: boolean): void;
  /** Flush the last partial clips, then release the devices. */
  stop(): void;
}

/**
 * Start capturing. The sources are already acquired so the caller owns
 * permission prompts; every one is stopped on `stop()`.
 */
export function startMeetingCapture(
  sources: MeetingSources,
  onClip: (source: MeetingSource, wavBase64: string) => void,
  deps: MeetingCaptureDeps = {},
): MeetingCapture {
  const AudioCtx =
    deps.AudioContextImpl ??
    ((window as unknown as { AudioContext?: typeof AudioContext }).AudioContext as
      | typeof AudioContext
      | undefined);
  if (!AudioCtx) throw new Error('Web Audio API unavailable');

  let paused = false;
  const lanes: { builder: ClipBuilder; teardown: () => void }[] = [];

  if (sources.mic) {
    const stream = sources.mic;
    if (stream.getAudioTracks().length === 0) {
      throw new Error('Microphone stream has no audio track');
    }
    const ctx = silentAudioContext(AudioCtx);
    // A context created after an async getUserMedia may start suspended, and a
    // suspended context never fires onaudioprocess (it records silence).
    void ctx.resume();
    const src = ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    const sink = ctx.createGain();
    sink.gain.value = 0;
    const downsample = createPcm16Downsampler(ctx.sampleRate);
    const builder = new ClipBuilder((wav) => onClip('mic', bytesToBase64(wav)), deps.clipSeconds);
    processor.onaudioprocess = (e: AudioProcessingEvent): void => {
      if (paused) return;
      builder.push(downsample(e.inputBuffer.getChannelData(0)));
    };
    src.connect(processor);
    processor.connect(sink);
    sink.connect(ctx.destination);
    lanes.push({
      builder,
      teardown: () => {
        processor.onaudioprocess = null;
        try {
          processor.disconnect();
          src.disconnect();
          sink.disconnect();
        } catch {
          /* already disconnected */
        }
        for (const t of stream.getTracks()) t.stop();
        void ctx.close().catch(() => undefined);
      },
    });
  }

  if (sources.system) {
    const feed = sources.system;
    const builder = new ClipBuilder(
      (wav) => onClip('system', bytesToBase64(wav)),
      deps.clipSeconds,
    );
    const unsubscribe = feed.subscribe((pcm) => {
      if (!paused) builder.push(pcm);
    });
    lanes.push({
      builder,
      teardown: () => {
        unsubscribe();
        feed.stop();
      },
    });
  }
  if (lanes.length === 0) throw new Error('no audio sources to capture');

  return {
    setPaused(p) {
      if (p && !paused) for (const l of lanes) l.builder.flush();
      paused = p;
    },
    stop() {
      if (!paused) for (const l of lanes) l.builder.flush();
      paused = true;
      for (const l of lanes) l.teardown();
    },
  };
}
