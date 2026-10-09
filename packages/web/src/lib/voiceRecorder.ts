// voiceRecorder — records mic audio in the browser and flushes it as ONE WAV
// clip for the host's Whisper "uploaded clip" path (`POST /api/voice/note`
// and `POST /api/voice/transcribe`).
//
// This is the RELIABLE path (the same shape the mobile surface uses): the whole
// utterance is captured locally and uploaded once, and the transcript comes
// back in the HTTP response. It deliberately does NOT depend on the host
// streaming a live `audio.transcript_final` back over the (flaky) audio WSS —
// that dependency is exactly why web voice-note text never appeared on prod.
// The live-streaming plane (lib/audioSession.ts) is still used by voice CALLS,
// which are genuinely bidirectional.
//
// Capture uses the Web Audio API (ScriptProcessor), accumulating mono samples
// at the AudioContext's native sample rate; `stop()` encodes a 16-bit PCM WAV
// (Groq/Whisper accept WAV directly). NO FALLBACK: a denied mic or a missing
// Web Audio API is surfaced to the caller rather than silently degrading.

import { createPcm16Downsampler } from './pcmDownsample.js';
import { silentAudioContext } from './silentAudioContext.js';

/** Test seam: inject a mic-stream factory + an AudioContext implementation. */
export interface VoiceRecorderDeps {
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  AudioContextImpl?: typeof AudioContext;
}

/** A live recording. The caller stops (→ clip) or cancels (→ discard). */
export interface VoiceRecording {
  /** Register a smoothed input-level callback (0..1) for the waveform. */
  onLevel(cb: (level: number) => void): void;
  /**
   * Register a callback for each captured buffer, resampled to the host's
   * 16 kHz PCM16. This is a TEE off the same capture, not a second one: the
   * clip `stop()` returns is unaffected by whether anyone listens. It is what
   * lets the live-preview session show interim words without opening a second
   * microphone, which is the one thing that could break the recording itself.
   */
  onPcm(cb: (pcm: Int16Array) => void): void;
  /** Stop capture and return the recorded clip as a WAV blob. */
  stop(): Promise<Blob>;
  /** Discard the recording without producing a clip. */
  cancel(): void;
}

/**
 * Begin recording the mic. Resolves once capture is running. Rejects (and
 * cleans up) on mic-permission denial or a missing Web Audio API.
 */
export async function startRecording(deps: VoiceRecorderDeps = {}): Promise<VoiceRecording> {
  const getMedia =
    deps.getUserMedia ?? ((c: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(c));
  const AudioCtx =
    deps.AudioContextImpl ??
    ((window as unknown as { AudioContext?: typeof AudioContext }).AudioContext as
      | typeof AudioContext
      | undefined);
  if (!AudioCtx) throw new Error('Web Audio API unavailable');

  const stream = await getMedia({ audio: true });
  // No output device: this only records (lib/silentAudioContext.ts).
  const audioCtx = silentAudioContext(AudioCtx);
  // Same gesture-loss workaround as audioSession: the async getUserMedia breaks
  // out of the user-gesture call stack, so Chrome may leave the context
  // suspended — a suspended context never fires onaudioprocess, capturing
  // silence. Resume explicitly before we return.
  if (audioCtx.state === 'suspended') {
    await audioCtx.resume();
  }
  const source = audioCtx.createMediaStreamSource(stream);
  const BUFFER = 2048;
  const processor = audioCtx.createScriptProcessor(BUFFER, 1, 1);

  const chunks: Float32Array[] = [];
  let levelCb: ((level: number) => void) | null = null;
  let pcmCb: ((pcm: Int16Array) => void) | null = null;
  let stopped = false;
  const downsample = createPcm16Downsampler(audioCtx.sampleRate);

  processor.onaudioprocess = (e: AudioProcessingEvent): void => {
    if (stopped) return;
    const input = e.inputBuffer.getChannelData(0);
    let sumSq = 0;
    /* v8 ignore next -- `i < input.length` is the loop invariant, so `input[i]` is always defined; the `?? 0` only satisfies noUncheckedIndexedAccess. */
    for (let i = 0; i < input.length; i++) sumSq += (input[i] ?? 0) ** 2;
    const rms = Math.sqrt(sumSq / input.length);
    levelCb?.(Math.min(1, rms * 4));
    // Copy: the ScriptProcessor reuses its input buffer across callbacks.
    chunks.push(new Float32Array(input));
    // The clip above is already safe by this point, so a throwing listener
    // must not be able to stop the next buffer being captured.
    if (pcmCb) {
      try {
        pcmCb(downsample(input));
      } catch (err) {
        console.error('[patch-voice] live-preview PCM listener threw', err);
      }
    }
  };
  source.connect(processor);
  // ScriptProcessor only fires while connected to the destination; route it
  // through a muted gain node so we don't loop the mic back to the speaker.
  const sink = audioCtx.createGain();
  sink.gain.value = 0;
  processor.connect(sink);
  sink.connect(audioCtx.destination);

  function teardown(): void {
    if (stopped) return;
    stopped = true;
    try {
      processor.disconnect();
      source.disconnect();
      sink.disconnect();
    } catch {
      /* best-effort */
    }
    for (const t of stream.getTracks()) t.stop();
    void audioCtx.close().catch(() => {});
  }

  return {
    onLevel(cb: (level: number) => void): void {
      levelCb = cb;
    },
    onPcm(cb: (pcm: Int16Array) => void): void {
      pcmCb = cb;
    },
    async stop(): Promise<Blob> {
      const rate = audioCtx.sampleRate;
      teardown();
      return encodeWav(chunks, rate);
    },
    cancel(): void {
      teardown();
    },
  };
}

/** Concatenate captured mono float chunks into a 16-bit PCM WAV blob. */
function encodeWav(chunks: Float32Array[], sampleRate: number): Blob {
  let total = 0;
  for (const c of chunks) total += c.length;
  const pcm = new Int16Array(total);
  let o = 0;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++) {
      /* v8 ignore next -- `i < c.length` is the loop invariant, so `c[i]` is always defined; the `?? 0` only satisfies noUncheckedIndexedAccess. */
      const s = Math.max(-1, Math.min(1, c[i] ?? 0));
      pcm[o++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
  }
  const bytesPerSample = 2;
  const dataSize = pcm.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true); // byte rate
  view.setUint16(32, bytesPerSample, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);
  new Int16Array(buffer, 44).set(pcm);
  return new Blob([buffer], { type: 'audio/wav' });
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}
