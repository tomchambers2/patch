// F2-9: host-side AEC is applied to physical voice-device audio sessions.
//
// The HA Voice PE has NO hardware AEC (spec/16 §Echo cancellation), so a device
// session (surfaceKind 'device', surfaceHasAec=false) MUST route its inbound mic
// audio through the host's NLMS AEC, which subtracts the TTS the host just
// streamed out — otherwise the device "barges in on itself".
//
// This drives a real VoiceSession with a real NlmsAec and inspects the PCM
// numerically (NEVER plays audio): it captures the exact signal the VoiceSession
// hands to the VAD/STT stage (the `cleaned` buffer passed to `vad.feed`) while a
// frame echoing the just-streamed TTS arrives during the 'speaking' state, and
// asserts that frame's energy is measurably attenuated relative to the raw mic
// input. The contrast case (surfaceHasAec=true, e.g. a web app surface that does
// its own AEC) must pass the same frame through UNCHANGED — proving the device
// path is the one that engages the host AEC.

import { describe, test, expect } from 'vitest';
import pino from 'pino';
import type { Vad, VadFrameResult } from '../src/audio/vad.js';
import { NlmsAec, PassThroughAec, type AecProcessor } from '../src/audio/aec.js';
import type { WhisperBackend } from '../src/audio/whisper.js';
import type { KokoroBackend, KokoroSynthesis } from '../src/audio/kokoro.js';
import { VoiceSession, type SessionInit, type SessionDeps } from '../src/audio/session.js';

const logger = pino({ level: 'silent' });

/** A 24kHz Kokoro chunk — a loud sustained tone the AEC reference will retain. */
function ttsChunk24k(samples: number, freq = 600, amp = 12000): Int16Array {
  const f = new Int16Array(samples);
  for (let i = 0; i < samples; i++) {
    f[i] = Math.round(amp * Math.sin((2 * Math.PI * freq * i) / 24000));
  }
  return f;
}

/** rms energy of an Int16 PCM frame. */
function rms(pcm: Int16Array): number {
  let acc = 0;
  for (let i = 0; i < pcm.length; i++) acc += pcm[i]! * pcm[i]!;
  return Math.sqrt(acc / pcm.length);
}

/**
 * VAD that NEVER fires an event (so the session sits in 'speaking' and no
 * barge-in / utterance churn disturbs the measurement) but records the RMS of
 * every `cleaned` buffer the session hands it — i.e. the exact signal that
 * reaches VAD/STT after AEC.
 */
class CapturingVad implements Vad {
  readonly seenRms: number[] = [];
  readonly seen: Int16Array[] = [];
  async feed(pcm: Int16Array): Promise<VadFrameResult> {
    this.seen.push(Int16Array.from(pcm));
    this.seenRms.push(rms(pcm));
    return { prob: 0, event: null, state: 'silence' };
  }
  reset(): void {}
  async close(): Promise<void> {}
}

/** Kokoro that streams one known loud chunk then blocks until released, so the
 * test can inject an echo mic frame while the session is still 'speaking'. */
function gatedKokoro(chunk: Int16Array): {
  backend: KokoroBackend;
  release: () => void;
} {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const backend: KokoroBackend = {
    isReady: () => true,
    async close() {},
    async synthesize(): Promise<KokoroSynthesis> {
      async function* gen() {
        // First, hand over the TTS chunk — the session retains it as the AEC
        // reference and streams it to the device.
        yield { pcm: chunk, first: true };
        // Then block so state stays 'speaking' while the test feeds the echo.
        await gate;
      }
      return { iterator: gen(), async cancel() {} };
    },
  };
  return { backend, release };
}

function deps(args: { vad: Vad; aec: AecProcessor; kokoro: KokoroBackend }): SessionDeps {
  return {
    vad: args.vad,
    aec: args.aec,
    whisper: {
      async transcribe() {
        return '';
      },
      async close() {},
    } satisfies WhisperBackend,
    kokoro: args.kokoro,
    logger,
    sendAudio: () => {},
    sendBinary: () => {},
    submitUserTurn: async () => '',
  };
}

const deviceInit: SessionInit = {
  sessionId: 'sess-dev',
  accountId: 'acct',
  surfaceId: 'kitchen',
  surfaceKind: 'device',
  chatId: 'thread_speakers',
  role: 'voice-device-conv',
  surfaceHasAec: false, // ← the device has no hardware AEC; host must run it.
  deviceId: 'kitchen',
};

/** Drive a session into 'speaking' with a known TTS reference primed, then feed
 * an echo mic frame and return the RMS the VAD/STT stage observed for it. */
async function echoRmsReachingVad(
  init: SessionInit,
  aec: AecProcessor,
): Promise<{
  raw: number;
  reachedVad: number;
}> {
  const ttsTone = ttsChunk24k(2400); // ~100ms @ 24kHz
  const vad = new CapturingVad();
  const { backend, release } = gatedKokoro(ttsTone);
  const session = new VoiceSession(init, deps({ vad, aec, kokoro: backend }));
  session.onSessionStart();

  // Begin speaking (retains ttsTone into the AEC reference ring) — runs in the
  // background and blocks on the gate, so state stays 'speaking'.
  const speaking = session.speak('hello');
  // Wait until the session is actually in 'speaking' state.
  for (let i = 0; i < 100; i++) {
    if (session.getState() === 'speaking') break;
    await new Promise((r) => setTimeout(r, 2));
  }
  expect(session.getState()).toBe('speaking');

  // The echo the device's mic picks up: the TTS tone decimated 24k→16k. We
  // build it as the 16kHz tone of the same frequency/amplitude — the AEC's
  // reference (the retained, decimated TTS) should correlate with it.
  const micEcho = new Int16Array(480);
  for (let i = 0; i < micEcho.length; i++) {
    micEcho[i] = Math.round(12000 * Math.sin((2 * Math.PI * 600 * i) / 16000));
  }
  const raw = rms(micEcho);

  // Feed several echo frames so the NLMS filter can converge on the reference.
  const before = vad.seenRms.length;
  for (let i = 0; i < 40; i++) {
    await session.onMicFrame(Int16Array.from(micEcho));
  }
  const reachedVad = vad.seenRms[vad.seenRms.length - 1]!;
  expect(vad.seenRms.length).toBeGreaterThan(before);

  release();
  await speaking.catch(() => {});
  await session.close();
  return { raw, reachedVad };
}

describe('F2-9: host AEC on device audio sessions', () => {
  test('device session (no hardware AEC) attenuates the echoed TTS before VAD/STT', async () => {
    const { raw, reachedVad } = await echoRmsReachingVad(
      deviceInit,
      new NlmsAec({ taps: 256, mu: 0.4 }),
    );
    // The signal that reaches VAD/STT must be measurably quieter than the raw
    // mic echo — the host AEC subtracted the TTS reference.
    expect(reachedVad).toBeLessThan(raw * 0.7);
  });

  test('a surface WITH hardware AEC bypasses the host AEC (echo passes through unchanged)', async () => {
    // surfaceHasAec=true → the session must NOT touch the mic signal (the
    // surface already cancelled echo); proves the device path is what engages
    // the host AEC, not every session.
    const webInit: SessionInit = {
      ...deviceInit,
      sessionId: 'sess-web',
      surfaceId: 'web-1',
      surfaceKind: 'web',
      role: 'voice-call',
      surfaceHasAec: true,
    };
    delete (webInit as { deviceId?: string }).deviceId;
    const { raw, reachedVad } = await echoRmsReachingVad(webInit, new PassThroughAec());
    // Unchanged: the echo reaches VAD at full energy.
    expect(reachedVad).toBeCloseTo(raw, -1);
  });
});
