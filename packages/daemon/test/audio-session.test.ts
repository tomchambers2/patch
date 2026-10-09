// Voice session orchestrator end-to-end test (group 13). Mocks every
// dependency (Whisper, Kokoro, VAD, AEC) and drives:
//   - Happy path: silence → speech → silence → STT → SDK → TTS
//   - Barge-in : during 'speaking', a fresh utterance_start cancels TTS

import { describe, test, expect, vi } from 'vitest';
import pino from 'pino';
import type { Vad, VadFrameResult } from '../src/audio/vad.js';
import type { AecProcessor } from '../src/audio/aec.js';
import type { WhisperBackend } from '../src/audio/whisper.js';
import type { KokoroBackend, KokoroSynthesis } from '../src/audio/kokoro.js';
import {
  VoiceSession,
  resampleTtsTo48k,
  type SessionDeps,
  type VoiceTurnSource,
} from '../src/audio/session.js';
import type { AudioEvent } from '@patch/wire/audio';

// The `__WAV__` diag path (session.ts speak()) reads a fixture WAV straight off
// disk (`.tmp/f1-prov/hey_jarvis.wav`) — a runtime artefact from manual F1
// verification sessions that doesn't ship in the repo/worktree. Stand in a
// synthetic-but-valid minimal WAV (44-byte header + PCM16 tone) for exactly
// that path so the diag branch is exercised deterministically, without
// touching the real filesystem or requiring the fixture to exist. Every other
// `fs.readFileSync` call passes through to the real implementation unchanged.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    readFileSync: (path: unknown, ...args: unknown[]) => {
      if (typeof path === 'string' && path.includes('hey_jarvis.wav')) {
        // 8100 samples (after the 22-sample/44-byte header trim, resampled
        // 2x to 48 kHz = 16200 samples = 9 frames of 1920) — long enough
        // that the device-send loop's "yield every 8 frames" branch
        // (session.ts speak(), the `__WAV__` diag path) actually fires.
        const N = 8100;
        const header = Buffer.alloc(44);
        const data = Buffer.alloc(N * 2);
        for (let i = 0; i < N; i++) {
          data.writeInt16LE(Math.round(6000 * Math.sin((2 * Math.PI * 300 * i) / 24000)), i * 2);
        }
        return Buffer.concat([header, data]);
      }
      // @ts-expect-error passthrough spread of unknown args to the real fn
      return actual.readFileSync(path, ...args);
    },
  };
});

const logger = pino({ level: 'silent' });

class ScriptedVad implements Vad {
  private idx = 0;
  constructor(private readonly script: VadFrameResult['event'][]) {}
  async feed(): Promise<VadFrameResult> {
    const event = this.script[this.idx] ?? null;
    this.idx++;
    const state =
      event === 'utterance_end'
        ? 'silence'
        : event === 'utterance_start'
          ? 'speech'
          : this.idx === 1
            ? 'silence'
            : 'speech';
    return { prob: 0.5, event, state };
  }
  reset(): void {
    this.idx = 0;
  }
  async close(): Promise<void> {}
}

class StubAec implements AecProcessor {
  process(mic: Int16Array): Int16Array {
    return mic;
  }
  reset(): void {}
}

function mockWhisper(text: string): WhisperBackend {
  return {
    async transcribe() {
      return text;
    },
    async close() {},
  };
}

function mockKokoro(
  opts: {
    chunks?: number;
    onCancel?: () => void;
    /** Optional per-chunk PCM payload (24 kHz). Default: 240 zero samples. */
    pcmFor?: (chunkIndex: number) => Int16Array;
    /** If provided, records the voice argument passed to synthesize(). */
    onSynthesize?: (text: string, voice: string | undefined) => void;
  } = {},
): KokoroBackend {
  return {
    isReady: () => true,
    async close() {},
    async synthesize(text: string, voice?: string): Promise<KokoroSynthesis> {
      opts.onSynthesize?.(text, voice);
      let cancelled = false;
      const total = opts.chunks ?? 5;
      async function* gen() {
        for (let i = 0; i < total; i++) {
          if (cancelled) return;
          // Tiny delay so barge-in test can interleave a frame in the gap.
          await new Promise((r) => setTimeout(r, 5));
          yield { pcm: opts.pcmFor ? opts.pcmFor(i) : new Int16Array(240), first: i === 0 };
        }
      }
      return {
        iterator: gen(),
        async cancel() {
          cancelled = true;
          opts.onCancel?.();
        },
      };
    },
  };
}

function depsForTest(args: {
  whisper: WhisperBackend;
  kokoro: KokoroBackend;
  vad: Vad;
  capturedAudio: AudioEvent[];
  binaryFrames: Int16Array[];
  reply: string;
  onSubmit?: (chatId: string, source: VoiceTurnSource) => void;
}): SessionDeps {
  return {
    vad: args.vad,
    aec: new StubAec(),
    whisper: args.whisper,
    kokoro: args.kokoro,
    logger,
    sendAudio: (ev) => args.capturedAudio.push(ev),
    sendBinary: (pcm) => args.binaryFrames.push(pcm),
    submitUserTurn: async ({
      chatId,
      source,
    }: {
      chatId: string;
      message: string;
      source: VoiceTurnSource;
    }) => {
      args.onSubmit?.(chatId, source);
      return args.reply;
    },
  };
}

const initBase = {
  sessionId: 'sess1',
  accountId: 'acct1',
  surfaceId: 'surf1',
  surfaceKind: 'web' as const,
  chatId: 'chat1',
  role: 'voice-call' as const,
  surfaceHasAec: true,
};

describe('VoiceSession', () => {
  test('happy path: speech → transcript → SDK → TTS', async () => {
    const audio: AudioEvent[] = [];
    const binary: Int16Array[] = [];
    let submittedChatId = '';
    const vad = new ScriptedVad(['utterance_start', null, 'utterance_end']);
    const session = new VoiceSession(
      initBase,
      depsForTest({
        whisper: mockWhisper('hello world'),
        kokoro: mockKokoro({ chunks: 3 }),
        vad,
        capturedAudio: audio,
        binaryFrames: binary,
        reply: 'hi back',
        onSubmit: (id) => {
          submittedChatId = id;
        },
      }),
    );
    session.onSessionStart();
    expect(session.getState()).toBe('listening');
    // Drive 3 mic frames (480 samples each) through the scripted VAD.
    await session.onMicFrame(new Int16Array(480));
    await session.onMicFrame(new Int16Array(480));
    await session.onMicFrame(new Int16Array(480));
    await session.waitForSpeakDone();
    // After utterance_end the orchestrator runs STT → SDK → TTS.
    expect(submittedChatId).toBe('chat1');
    const types = audio.map((e) => e.type);
    expect(types).toContain('audio.transcript_final');
    expect(types).toContain('audio.tts_chunk');
    expect(types[types.length - 1]).toBe('audio.tts_end');
    expect(binary.length).toBeGreaterThan(0);
    expect(session.getState()).toBe('listening');
  });

  test('app surface (web) stamps a voice-app source with its surfaceKind', async () => {
    let captured: VoiceTurnSource | undefined;
    const vad = new ScriptedVad(['utterance_start', 'utterance_end']);
    const session = new VoiceSession(
      initBase,
      depsForTest({
        whisper: mockWhisper('hi'),
        kokoro: mockKokoro({ chunks: 1 }),
        vad,
        capturedAudio: [],
        binaryFrames: [],
        reply: 'ok',
        onSubmit: (_id, source) => {
          captured = source;
        },
      }),
    );
    session.onSessionStart();
    await session.onMicFrame(new Int16Array(480));
    await session.onMicFrame(new Int16Array(480));
    await session.waitForSpeakDone();
    expect(captured).toEqual({ kind: 'voice-app', surfaceKind: 'web', sessionId: 'sess1' });
  });

  test('physical device session stamps a voice-device source carrying its deviceId', async () => {
    // spec/06 ## Speakers thread: a `device` session must produce a
    // voice-device source so the turn is tagged [voice • device:<id>] and the
    // reply auto-routes TTS back to the originating device.
    let captured: VoiceTurnSource | undefined;
    const vad = new ScriptedVad(['utterance_start', 'utterance_end']);
    const session = new VoiceSession(
      {
        ...initBase,
        surfaceKind: 'device',
        role: 'voice-device-conv',
        surfaceHasAec: false,
        chatId: 'thread_speakers',
        deviceId: 'kitchen',
      },
      depsForTest({
        whisper: mockWhisper('lights off'),
        kokoro: mockKokoro({ chunks: 1 }),
        vad,
        capturedAudio: [],
        binaryFrames: [],
        reply: 'done',
        onSubmit: (_id, source) => {
          captured = source;
        },
      }),
    );
    session.onSessionStart();
    await session.onMicFrame(new Int16Array(480));
    await session.onMicFrame(new Int16Array(480));
    await session.waitForSpeakDone();
    expect(captured).toEqual({ kind: 'voice-device', deviceId: 'kitchen' });
  });

  test('focus follow re-targets the next utterance', async () => {
    const audio: AudioEvent[] = [];
    let submittedChatId = '';
    const vad = new ScriptedVad(['utterance_start', 'utterance_end']);
    const session = new VoiceSession(
      initBase,
      depsForTest({
        whisper: mockWhisper('hi'),
        kokoro: mockKokoro({ chunks: 1 }),
        vad,
        capturedAudio: audio,
        binaryFrames: [],
        reply: 'ok',
        onSubmit: (id) => {
          submittedChatId = id;
        },
      }),
    );
    session.onSessionStart();
    session.setFocus('chat-other');
    await session.onMicFrame(new Int16Array(480));
    await session.onMicFrame(new Int16Array(480));
    await session.waitForSpeakDone();
    expect(submittedChatId).toBe('chat-other');
  });

  test('barge-in: VAD start during speaking cancels Kokoro and goes to listening', async () => {
    const audio: AudioEvent[] = [];
    let cancelled = false;
    // Script: end → STT runs → speak() loop iterates Kokoro chunks. We
    // fire utterance_start on the next mic frame to trigger barge-in.
    const vad = new ScriptedVad(['utterance_start', 'utterance_end', 'utterance_start']);
    const session = new VoiceSession(
      initBase,
      depsForTest({
        whisper: mockWhisper('hello'),
        kokoro: mockKokoro({
          chunks: 20,
          onCancel: () => {
            cancelled = true;
          },
        }),
        vad,
        capturedAudio: audio,
        binaryFrames: [],
        reply: 'a long sentence the user wants to interrupt',
      }),
    );
    session.onSessionStart();
    // Two mic frames: start + end → STT → SDK → TTS begins (state=speaking).
    await session.onMicFrame(new Int16Array(480));
    await session.onMicFrame(new Int16Array(480));
    // Spin briefly until the orchestrator transitions to 'speaking'.
    for (let i = 0; i < 50; i++) {
      if (session.getState() === 'speaking') break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(session.getState()).toBe('speaking');
    // Inject a mic frame whose VAD fires utterance_start.
    await session.onMicFrame(new Int16Array(480));
    // Allow speak() to wind down.
    await session.waitForSpeakDone();
    expect(cancelled).toBe(true);
    const bargeIns = audio.filter((e) => e.type === 'audio.barge_in');
    expect(bargeIns.length).toBe(1);
    const bargedTtsEnd = audio.find((e) => e.type === 'audio.tts_end' && e.bargedIn === true);
    expect(bargedTtsEnd).toBeDefined();
  });

  test('injectTranscript routes to the CURRENT focus chat (spec/07 focus-follow)', async () => {
    let submittedChatId = '';
    const vad = new ScriptedVad([]);
    const session = new VoiceSession(
      initBase,
      depsForTest({
        whisper: mockWhisper('unused'),
        kokoro: mockKokoro({ chunks: 1 }),
        vad,
        capturedAudio: [],
        binaryFrames: [],
        reply: 'ok',
        onSubmit: (id) => {
          submittedChatId = id;
        },
      }),
    );
    session.onSessionStart();
    session.setFocus('chat-B');
    await session.injectTranscript('route this to B please');
    await session.waitForSpeakDone();
    // The injected utterance landed in the newly-focused chat, not init chat1.
    expect(submittedChatId).toBe('chat-B');
  });

  test('injectTranscript streams growing transcript_partial frames before the final (spec/07 live transcript)', async () => {
    const audio: import('@patch/wire/audio').AudioEvent[] = [];
    const session = new VoiceSession(
      initBase,
      depsForTest({
        whisper: mockWhisper('unused'),
        kokoro: mockKokoro({ chunks: 1 }),
        vad: new ScriptedVad([]),
        capturedAudio: audio,
        binaryFrames: [],
        reply: 'ok',
      }),
    );
    session.onSessionStart();
    await session.injectTranscript('water the plants tonight');
    await session.waitForSpeakDone();
    const partials = audio
      .filter((e) => e.type === 'audio.transcript_partial')
      .map((e) => (e as { text: string }).text);
    // The italic transcript region visibly updates as words arrive: each partial
    // is the running prefix, growing word-by-word up to the full utterance.
    expect(partials).toEqual([
      'water',
      'water the',
      'water the plants',
      'water the plants tonight',
    ]);
    // A final still lands so downstream commit logic is unchanged.
    const finals = audio.filter((e) => e.type === 'audio.transcript_final');
    expect(finals).toHaveLength(1);
    expect((finals[0] as { text: string }).text).toBe('water the plants tonight');
    // Partials precede the final (live ticker, then commit).
    const firstFinalIdx = audio.findIndex((e) => e.type === 'audio.transcript_final');
    const lastPartialIdx = audio.map((e) => e.type).lastIndexOf('audio.transcript_partial');
    expect(lastPartialIdx).toBeLessThan(firstFinalIdx);
  });

  test('injectTranscript "yes" resolves a pending permission via the STT path (spec/07)', async () => {
    const vad = new ScriptedVad([]);
    let submitted = false;
    let resolved: { requestId: string; approve: boolean } | undefined;
    const deps = depsForTest({
      whisper: mockWhisper('unused'),
      kokoro: mockKokoro({ chunks: 1 }),
      vad,
      capturedAudio: [],
      binaryFrames: [],
      reply: 'should not be spoken',
      onSubmit: () => {
        submitted = true;
      },
    });
    deps.getPendingPermission = (chatId) => (chatId === 'chat1' ? 'req-7' : undefined);
    deps.resolvePermission = (requestId, approve) => {
      resolved = { requestId, approve };
    };
    const session = new VoiceSession(initBase, deps);
    session.onSessionStart();
    await session.injectTranscript('yes');
    // Spoken yes resolved the permission; it was NOT forwarded as a user turn.
    expect(resolved).toEqual({ requestId: 'req-7', approve: true });
    expect(submitted).toBe(false);
  });

  test('injectTranscript "no" denies a pending permission; ambiguous text falls through to a turn', async () => {
    const vad = new ScriptedVad([]);
    let submittedMsg: string | undefined;
    const deps = depsForTest({
      whisper: mockWhisper('unused'),
      kokoro: mockKokoro({ chunks: 1 }),
      vad,
      capturedAudio: [],
      binaryFrames: [],
      reply: 'ok',
    });
    let pending: string | undefined = 'req-9';
    let resolved: { requestId: string; approve: boolean } | undefined;
    deps.getPendingPermission = () => pending;
    deps.resolvePermission = (requestId, approve) => {
      resolved = { requestId, approve };
      pending = undefined;
    };
    deps.submitUserTurn = async ({ message }) => {
      submittedMsg = message;
      return 'ok';
    };
    const session = new VoiceSession(initBase, deps);
    session.onSessionStart();
    await session.injectTranscript('no');
    expect(resolved).toEqual({ requestId: 'req-9', approve: false });
    expect(submittedMsg).toBeUndefined();
    // Now no permission is pending — a normal utterance drives a turn.
    await session.injectTranscript('what is the weather');
    await session.waitForSpeakDone();
    expect(submittedMsg).toBe('what is the weather');
  });

  test('injectTranscript while speaking triggers barge-in then processes the utterance', async () => {
    const audio: AudioEvent[] = [];
    let cancelled = false;
    const vad = new ScriptedVad(['utterance_start', 'utterance_end']);
    const session = new VoiceSession(
      initBase,
      depsForTest({
        whisper: mockWhisper('hello'),
        kokoro: mockKokoro({
          chunks: 30,
          onCancel: () => {
            cancelled = true;
          },
        }),
        vad,
        capturedAudio: audio,
        binaryFrames: [],
        reply: 'a long reply the user interrupts mid-stream',
      }),
    );
    session.onSessionStart();
    await session.onMicFrame(new Int16Array(480));
    await session.onMicFrame(new Int16Array(480));
    for (let i = 0; i < 50; i++) {
      if (session.getState() === 'speaking') break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(session.getState()).toBe('speaking');
    // Inject an utterance mid-TTS — the user spoke over the agent.
    await session.injectTranscript('wait stop');
    await session.waitForSpeakDone();
    expect(cancelled).toBe(true);
    expect(audio.filter((e) => e.type === 'audio.barge_in').length).toBe(1);
    expect(audio.some((e) => e.type === 'audio.tts_end' && e.bargedIn === true)).toBe(true);
  });

  // --- TTS 24k→16k resampling for the physical voice device ----------------
  // The device I2S + firmware play PCM16 mono @ 16 kHz (spec/16: "Binary PCM16
  // mono at 16 kHz, both directions"). Kokoro emits 24 kHz, so the host must
  // resample down before sending to the device — otherwise the 24 kHz samples
  // play 1.5× too fast on the 16 kHz DAC (the garbled/sped-up bug).
  test('device session resamples 24 kHz Kokoro TTS up to 48 kHz before send', async () => {
    const binary: Int16Array[] = [];
    const vad = new ScriptedVad(['utterance_start', 'utterance_end']);
    // 5 chunks of 240 samples @ 24 kHz each = 1200 input samples = 50ms.
    const session = new VoiceSession(
      {
        ...initBase,
        surfaceKind: 'device',
        role: 'voice-device-conv',
        surfaceHasAec: false,
        chatId: 'thread_speakers',
        deviceId: 'kitchen',
      },
      depsForTest({
        whisper: mockWhisper('hello'),
        kokoro: mockKokoro({
          chunks: 5,
          pcmFor: () => new Int16Array(240),
        }),
        vad,
        capturedAudio: [],
        binaryFrames: binary,
        reply: 'ok',
      }),
    );
    session.onSessionStart();
    await session.onMicFrame(new Int16Array(480));
    await session.onMicFrame(new Int16Array(480));
    await session.waitForSpeakDone();
    // The physical device speaker bus is 48 kHz (spec/16): the host collects
    // the whole 24 kHz Kokoro utterance and resamples it ONCE to 48 kHz (clean
    // 2x upsample). 1200 input samples @ 24 kHz → 2400 output samples @ 48 kHz.
    const totalOut = binary.reduce((n, f) => n + f.length, 0);
    expect(totalOut).toBe(2400);
    // Sent in <=1920-sample frames: 2400 → 1920 + 480 = 2 frames.
    expect(binary.length).toBe(2);
    for (const f of binary) {
      expect(f.length).toBeLessThanOrEqual(1920);
    }
  });

  test('web session leaves Kokoro TTS at native 24 kHz (no resample)', async () => {
    const binary: Int16Array[] = [];
    const vad = new ScriptedVad(['utterance_start', 'utterance_end']);
    const session = new VoiceSession(
      // initBase is surfaceKind 'web'.
      initBase,
      depsForTest({
        whisper: mockWhisper('hello'),
        kokoro: mockKokoro({ chunks: 5, pcmFor: () => new Int16Array(240) }),
        vad,
        capturedAudio: [],
        binaryFrames: binary,
        reply: 'ok',
      }),
    );
    session.onSessionStart();
    await session.onMicFrame(new Int16Array(480));
    await session.onMicFrame(new Int16Array(480));
    await session.waitForSpeakDone();
    // Untouched: 5 × 240 = 1200 samples at the native 24 kHz rate.
    const totalOut = binary.reduce((n, f) => n + f.length, 0);
    expect(totalOut).toBe(1200);
    for (const f of binary) expect(f.length).toBe(240);
  });

  test('device 48 kHz TTS resample of a low tone is smooth (no aliasing/garble)', async () => {
    // Feed a clean 1 kHz tone as the Kokoro output. The 24→48 kHz upsampler is a
    // linear-phase windowed-sinc FIR, so the 48 kHz output must remain a smooth
    // 1 kHz tone: adjacent-sample steps stay small. A garbled/aliased resample
    // (imaging near 23 kHz folding back) would inject near-full-scale jumps.
    // NOTE: a monotonic-ramp invariant is INVALID for an FIR resampler (sinc
    // ringing overshoots a ramp), so we assert tone smoothness instead.
    const binary: Int16Array[] = [];
    const vad = new ScriptedVad(['utterance_start', 'utterance_end']);
    let n = 0;
    const session = new VoiceSession(
      {
        ...initBase,
        surfaceKind: 'device',
        role: 'voice-device-conv',
        surfaceHasAec: false,
        chatId: 'thread_speakers',
        deviceId: 'kitchen',
      },
      depsForTest({
        whisper: mockWhisper('hello'),
        kokoro: mockKokoro({
          chunks: 8,
          pcmFor: () => {
            const a = new Int16Array(240);
            for (let i = 0; i < a.length; i++) {
              a[i] = Math.round(8000 * Math.sin((2 * Math.PI * 1000 * n++) / 24000));
            }
            return a;
          },
        }),
        vad,
        capturedAudio: [],
        binaryFrames: binary,
        reply: 'ok',
      }),
    );
    session.onSessionStart();
    await session.onMicFrame(new Int16Array(480));
    await session.onMicFrame(new Int16Array(480));
    await session.waitForSpeakDone();
    const flat: number[] = [];
    for (const f of binary) for (const v of f) flat.push(v);
    // 8 chunks × 240 = 1920 input @ 24 kHz → 3840 output @ 48 kHz.
    expect(flat.length).toBe(3840);
    // Peak after normalization approaches full-scale; a clean 1 kHz tone at
    // 48 kHz has a max per-sample step of ~peak·2π·1000/48000 ≈ 13% of peak.
    // Skip the FIR warm-up/tail (one filter length each side).
    let peak = 0;
    for (const v of flat) peak = Math.max(peak, Math.abs(v));
    let maxStep = 0;
    for (let i = 65; i < flat.length - 65; i++) {
      maxStep = Math.max(maxStep, Math.abs(flat[i]! - flat[i - 1]!));
    }
    // Generous bound (half of peak) — a clean tone is well under it; imaging
    // garble blows far past it.
    expect(maxStep).toBeLessThan(peak * 0.5);
    expect(peak).toBeGreaterThan(20000); // normalized up toward full-scale
  });
});

// spec/07 ## Voice-input modes — mode 1 (voice note): a note is a SINGLE
// utterance bounded by the GESTURE, not VAD silence. "Either gesture, esc
// cancels without sending. After send, the audio is committed as a user turn."
// These regression tests pin G5-d3: a captured-then-cancelled note must commit
// ZERO turns, and only an explicit gesture-end commit submits exactly one.
describe('VoiceSession — voice-note gesture semantics (spec/07 mode 1, G5-d3)', () => {
  const noteInit = { ...initBase, role: 'voice-note' as const };

  test('VAD silence does NOT commit a turn in note mode (gesture bounds the utterance)', async () => {
    let submits = 0;
    // utterance_start → speech → utterance_end: in a CALL this commits a turn;
    // in a NOTE it must NOT — the note is only committed on the gesture end.
    const vad = new ScriptedVad(['utterance_start', null, 'utterance_end']);
    const session = new VoiceSession(
      noteInit,
      depsForTest({
        whisper: mockWhisper('buffered words'),
        kokoro: mockKokoro({ chunks: 1 }),
        vad,
        capturedAudio: [],
        binaryFrames: [],
        reply: 'ok',
        onSubmit: () => {
          submits++;
        },
      }),
    );
    session.onSessionStart();
    await session.onMicFrame(new Int16Array(480));
    await session.onMicFrame(new Int16Array(480));
    await session.onMicFrame(new Int16Array(480));
    await session.waitForSpeakDone();
    expect(submits).toBe(0);
    expect(session.getState()).toBe('listening');
  });

  test('injectTranscript paints the live transcript but does NOT commit a turn until finalize', async () => {
    const audio: AudioEvent[] = [];
    let submits = 0;
    const session = new VoiceSession(
      noteInit,
      depsForTest({
        whisper: mockWhisper(''),
        kokoro: mockKokoro({ chunks: 1 }),
        vad: new ScriptedVad([]),
        capturedAudio: audio,
        binaryFrames: [],
        reply: 'ok',
        onSubmit: () => {
          submits++;
        },
      }),
    );
    session.onSessionStart();
    await session.injectTranscript('discard me on escape');
    // Live partials streamed for the overlay, but no turn yet.
    expect(audio.some((e) => e.type === 'audio.transcript_partial')).toBe(true);
    expect(submits).toBe(0);
    expect(session.getState()).toBe('listening');
  });

  test('captured-then-cancelled note commits NOTHING (Esc): finalizeNote never called', async () => {
    let submits = 0;
    const session = new VoiceSession(
      noteInit,
      depsForTest({
        whisper: mockWhisper(''),
        kokoro: mockKokoro({ chunks: 1 }),
        vad: new ScriptedVad([]),
        capturedAudio: [],
        binaryFrames: [],
        reply: 'ok',
        onSubmit: () => {
          submits++;
        },
      }),
    );
    session.onSessionStart();
    await session.injectTranscript('discard me on escape');
    // Esc → surface closes the session WITHOUT calling finalizeNote. Nothing
    // is ever submitted — this is the G5-d3 stray-turn bug, now fixed.
    await session.waitForSpeakDone();
    expect(submits).toBe(0);
  });

  test('finalizeNote (⏎/release) commits the captured transcript as EXACTLY one turn', async () => {
    let submits = 0;
    let lastMsg = '';
    const session = new VoiceSession(
      noteInit,
      depsForTest({
        whisper: mockWhisper(''),
        kokoro: mockKokoro({ chunks: 1 }),
        vad: new ScriptedVad([]),
        capturedAudio: [],
        binaryFrames: [],
        reply: 'ok',
      }),
    );
    // Capture the submitted message text.
    (session as unknown as { deps: SessionDeps }).deps.submitUserTurn = async ({ message }) => {
      submits++;
      lastMsg = message;
      return 'ok';
    };
    session.onSessionStart();
    await session.injectTranscript('water the plants tonight');
    expect(submits).toBe(0);
    const ran = await session.finalizeNote();
    await session.waitForSpeakDone();
    expect(ran).toBe(true);
    expect(submits).toBe(1);
    expect(lastMsg).toBe('water the plants tonight');
    // A second finalize (double signal) must not stack another turn.
    const again = await session.finalizeNote();
    expect(again).toBe(false);
    expect(submits).toBe(1);
  });
});

describe('parseYesNo (spec/07 spoken permission answers)', () => {
  test('affirmatives → true', async () => {
    const { parseYesNo } = await import('../src/audio/session.js');
    for (const w of ['yes', 'Yeah', 'yep', 'sure', 'approve', 'ok', 'go ahead', 'do it.']) {
      expect(parseYesNo(w)).toBe(true);
    }
  });
  test('negatives → false', async () => {
    const { parseYesNo } = await import('../src/audio/session.js');
    for (const w of ['no', 'Nope', 'nah', 'deny', "don't", 'cancel', 'stop']) {
      expect(parseYesNo(w)).toBe(false);
    }
  });
  test('ambiguous → null', async () => {
    const { parseYesNo } = await import('../src/audio/session.js');
    for (const w of ['what is the weather', 'tell me a joke', 'hmm']) {
      expect(parseYesNo(w)).toBeNull();
    }
  });
});

describe('VoiceSession — misc accessors + lifecycle guards', () => {
  test('getCurrentChatId reflects the init chatId and setFocus updates it', () => {
    const session = new VoiceSession(
      initBase,
      depsForTest({
        whisper: mockWhisper(''),
        kokoro: mockKokoro(),
        vad: new ScriptedVad([]),
        capturedAudio: [],
        binaryFrames: [],
        reply: 'ok',
      }),
    );
    expect(session.getCurrentChatId()).toBe('chat1');
    session.setFocus('chat-z');
    expect(session.getCurrentChatId()).toBe('chat-z');
  });

  test('a duplicate onSessionStart (already past connecting) warns and is a no-op', () => {
    const spyLogger = pino({ level: 'silent' });
    const warnSpy = vi.spyOn(spyLogger, 'warn');
    const deps = depsForTest({
      whisper: mockWhisper(''),
      kokoro: mockKokoro(),
      vad: new ScriptedVad([]),
      capturedAudio: [],
      binaryFrames: [],
      reply: 'ok',
    });
    deps.logger = spyLogger;
    const session = new VoiceSession(initBase, deps);
    session.onSessionStart();
    expect(session.getState()).toBe('listening');
    session.onSessionStart(); // duplicate — must not throw or re-transition.
    expect(session.getState()).toBe('listening');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess1', state: 'listening' }),
      'voice-session: duplicate session_start',
    );
  });
});

describe('VoiceSession — STT / SDK / TTS failure paths', () => {
  test('STT failure emits audio.error{whisper_unavailable} and returns to listening', async () => {
    const audio: AudioEvent[] = [];
    const vad = new ScriptedVad(['utterance_start', 'utterance_end']);
    const throwingWhisper: WhisperBackend = {
      async transcribe() {
        throw new Error('groq 500');
      },
      async close() {},
    };
    const session = new VoiceSession(
      initBase,
      depsForTest({
        whisper: throwingWhisper,
        kokoro: mockKokoro({ chunks: 1 }),
        vad,
        capturedAudio: audio,
        binaryFrames: [],
        reply: 'unused',
      }),
    );
    session.onSessionStart();
    await session.onMicFrame(new Int16Array(480));
    await session.onMicFrame(new Int16Array(480));
    const err = audio.find((e) => e.type === 'audio.error');
    expect(err).toBeDefined();
    if (err?.type === 'audio.error') {
      expect(err.code).toBe('whisper_unavailable');
      expect(err.message).toBe('groq 500');
    }
    expect(session.getState()).toBe('listening');
  });

  test('an empty transcript (silent capture) returns to listening without submitting a turn', async () => {
    const audio: AudioEvent[] = [];
    let submits = 0;
    const vad = new ScriptedVad(['utterance_start', 'utterance_end']);
    const session = new VoiceSession(
      initBase,
      depsForTest({
        whisper: mockWhisper(''),
        kokoro: mockKokoro({ chunks: 1 }),
        vad,
        capturedAudio: audio,
        binaryFrames: [],
        reply: 'unused',
        onSubmit: () => {
          submits++;
        },
      }),
    );
    session.onSessionStart();
    await session.onMicFrame(new Int16Array(480));
    await session.onMicFrame(new Int16Array(480));
    expect(submits).toBe(0);
    expect(session.getState()).toBe('listening');
    const final = audio.find((e) => e.type === 'audio.transcript_final');
    expect(final).toBeDefined();
    if (final?.type === 'audio.transcript_final') expect(final.text).toBe('');
  });

  test('SDK turn failure emits a SANITIZED audio.error{sdk_error} — no raw message leak', async () => {
    const audio: AudioEvent[] = [];
    const vad = new ScriptedVad(['utterance_start', 'utterance_end']);
    const deps = depsForTest({
      whisper: mockWhisper('hello'),
      kokoro: mockKokoro({ chunks: 1 }),
      vad,
      capturedAudio: audio,
      binaryFrames: [],
      reply: 'unused',
    });
    deps.submitUserTurn = async () => {
      throw new Error('internal prompt bytes: SECRET_PATH=/etc/whatever');
    };
    const session = new VoiceSession(initBase, deps);
    session.onSessionStart();
    await session.onMicFrame(new Int16Array(480));
    await session.onMicFrame(new Int16Array(480));
    const err = audio.find((e) => e.type === 'audio.error');
    expect(err).toBeDefined();
    if (err?.type === 'audio.error') {
      expect(err.code).toBe('sdk_error');
      expect(err.message).toBe('turn failed: Error');
      expect(err.message).not.toContain('SECRET_PATH');
    }
    expect(session.getState()).toBe('listening');
  });

  test('kokoro.synthesize failure emits audio.error{kokoro_unavailable} and returns to listening', async () => {
    const audio: AudioEvent[] = [];
    const vad = new ScriptedVad(['utterance_start', 'utterance_end']);
    const throwingKokoro: KokoroBackend = {
      isReady: () => true,
      async close() {},
      async synthesize(): Promise<KokoroSynthesis> {
        throw new Error('kokoro down');
      },
    };
    const session = new VoiceSession(
      initBase,
      depsForTest({
        whisper: mockWhisper('hi'),
        kokoro: throwingKokoro,
        vad,
        capturedAudio: audio,
        binaryFrames: [],
        reply: 'ok',
      }),
    );
    session.onSessionStart();
    await session.onMicFrame(new Int16Array(480));
    await session.onMicFrame(new Int16Array(480));
    await session.waitForSpeakDone();
    const err = audio.find((e) => e.type === 'audio.error');
    expect(err).toBeDefined();
    if (err?.type === 'audio.error') expect(err.code).toBe('kokoro_unavailable');
    expect(session.getState()).toBe('listening');
  });

  test('an error mid-Kokoro-stream is logged (voice-session: speak failed) and the session still recovers', async () => {
    const spyLogger = pino({ level: 'silent' });
    const errorSpy = vi.spyOn(spyLogger, 'error');
    const throwingStreamKokoro: KokoroBackend = {
      isReady: () => true,
      async close() {},
      async synthesize(): Promise<KokoroSynthesis> {
        async function* gen(): AsyncGenerator<{ pcm: Int16Array; first: boolean }> {
          yield { pcm: new Int16Array(240), first: true };
          throw new Error('stream broke');
        }
        return { iterator: gen(), async cancel() {} };
      },
    };
    const vad = new ScriptedVad(['utterance_start', 'utterance_end']);
    const deps = depsForTest({
      whisper: mockWhisper('hi'),
      kokoro: throwingStreamKokoro,
      vad,
      capturedAudio: [],
      binaryFrames: [],
      reply: 'ok',
    });
    deps.logger = spyLogger;
    const session = new VoiceSession(initBase, deps);
    session.onSessionStart();
    await session.onMicFrame(new Int16Array(480));
    await session.onMicFrame(new Int16Array(480));
    await session.waitForSpeakDone();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'stream broke' }),
      'voice-session: speak failed',
    );
    // Despite the mid-stream throw, `finally` still ran: tts_end fired and the
    // state machine recovered to 'listening' (asserted via the state getter —
    // `waitForSpeakDone` already resolved above without hanging).
    expect(session.getState()).toBe('listening');
  });

  test('streaming reply: speaks each sentence as it arrives, markdown-stripped, one tts_end', async () => {
    const audio: AudioEvent[] = [];
    const synthTexts: string[] = [];
    const recordingKokoro: KokoroBackend = {
      isReady: () => true,
      async close() {},
      async synthesize(text: string): Promise<KokoroSynthesis> {
        synthTexts.push(text);
        async function* gen() {
          yield { pcm: new Int16Array(240), first: true };
        }
        return { iterator: gen(), async cancel() {} };
      },
    };
    const deps = depsForTest({
      whisper: mockWhisper('hello'),
      kokoro: recordingKokoro,
      vad: new ScriptedVad(['utterance_start', null, 'utterance_end']),
      capturedAudio: audio,
      binaryFrames: [],
      reply: 'UNUSED-FULL-REPLY',
    });
    // Stream a markdown reply in two chunks via the onReplyText hook.
    deps.submitUserTurn = async ({ onReplyText }) => {
      onReplyText?.('## 🍎 Heading\nFirst sentence here. ');
      onReplyText?.('Second **sentence**! Then a trailing part');
      return 'UNUSED-FULL-REPLY';
    };
    const session = new VoiceSession(initBase, deps);
    session.onSessionStart();
    await session.onMicFrame(new Int16Array(480));
    await session.onMicFrame(new Int16Array(480));
    await session.onMicFrame(new Int16Array(480));
    await session.waitForSpeakDone();

    // Each sentence synthesised individually, markdown/emoji stripped.
    expect(synthTexts).toContain('Heading');
    expect(synthTexts).toContain('First sentence here.');
    expect(synthTexts).toContain('Second sentence!');
    expect(synthTexts).toContain('Then a trailing part');
    expect(synthTexts.join(' ')).not.toMatch(/[#*🍎]/);
    // The full reply is NOT re-spoken — streaming covered it.
    expect(synthTexts).not.toContain('UNUSED-FULL-REPLY');
    // Exactly one tts_end for the whole turn, and it is the last event.
    expect(audio.filter((e) => e.type === 'audio.tts_end')).toHaveLength(1);
    expect(audio[audio.length - 1]!.type).toBe('audio.tts_end');
    expect(session.getState()).toBe('listening');
  });
});

describe('VoiceSession — speak() diag/guard branches', () => {
  test('a mock-backend auto-reply ("[mock] echo: …") is suppressed — never spoken (feedback-loop guard)', async () => {
    const binary: Int16Array[] = [];
    const audio: AudioEvent[] = [];
    const session = new VoiceSession(
      initBase,
      depsForTest({
        whisper: mockWhisper(''),
        kokoro: mockKokoro({ chunks: 3 }),
        vad: new ScriptedVad([]),
        capturedAudio: audio,
        binaryFrames: binary,
        reply: 'ok',
      }),
    );
    session.onSessionStart();
    await session.speak('[mock] echo: hello');
    expect(binary.length).toBe(0);
    expect(audio.some((e) => e.type === 'audio.tts_chunk')).toBe(false);
    expect(session.getState()).toBe('listening');
  });

  test('__SINE__ streams a device sine sweep straight down the WS (device sessions only)', async () => {
    const binary: Int16Array[] = [];
    const audio: AudioEvent[] = [];
    const session = new VoiceSession(
      {
        ...initBase,
        surfaceKind: 'device',
        role: 'voice-device-conv',
        surfaceHasAec: false,
        chatId: 'thread_speakers',
        deviceId: 'kitchen',
      },
      depsForTest({
        whisper: mockWhisper(''),
        kokoro: mockKokoro({ chunks: 1 }),
        vad: new ScriptedVad([]),
        capturedAudio: audio,
        binaryFrames: binary,
        reply: 'ok',
      }),
    );
    session.onSessionStart();
    await session.speak('__SINE__');
    expect(binary.length).toBeGreaterThan(0);
    const totalSamples = binary.reduce((n, f) => n + f.length, 0);
    expect(totalSamples).toBe(48000 * 2); // 2s @ 48kHz
    expect(audio.some((e) => e.type === 'audio.tts_end')).toBe(true);
    expect(session.getState()).toBe('listening');
  });

  test('__SINE__ text on a non-device surface falls through to normal Kokoro TTS (not the diag sweep)', async () => {
    const binary: Int16Array[] = [];
    const session = new VoiceSession(
      initBase, // surfaceKind: 'web'
      depsForTest({
        whisper: mockWhisper(''),
        kokoro: mockKokoro({ chunks: 2, pcmFor: () => new Int16Array(100) }),
        vad: new ScriptedVad([]),
        capturedAudio: [],
        binaryFrames: binary,
        reply: 'ok',
      }),
    );
    session.onSessionStart();
    await session.speak('__SINE__');
    // Normal (non-diag) native-24kHz path: 2 chunks × 100 samples, untouched —
    // NOT the 96,000-sample 48kHz sweep.
    const total = binary.reduce((n, f) => n + f.length, 0);
    expect(total).toBe(200);
  });

  test('__WAV__ plays the known-clean fixture through the resample→device path (device sessions only)', async () => {
    const binary: Int16Array[] = [];
    const audio: AudioEvent[] = [];
    const session = new VoiceSession(
      {
        ...initBase,
        surfaceKind: 'device',
        role: 'voice-device-conv',
        surfaceHasAec: false,
        chatId: 'thread_speakers',
        deviceId: 'kitchen',
      },
      depsForTest({
        whisper: mockWhisper(''),
        kokoro: mockKokoro({ chunks: 1 }),
        vad: new ScriptedVad([]),
        capturedAudio: audio,
        binaryFrames: binary,
        reply: 'ok',
      }),
    );
    session.onSessionStart();
    await session.speak('__WAV__');
    expect(binary.length).toBeGreaterThan(0);
    expect(audio.some((e) => e.type === 'audio.tts_end')).toBe(true);
    expect(session.getState()).toBe('listening');
  });

  test('__WAV__ text on a non-device surface falls through to normal Kokoro TTS (not the diag playback)', async () => {
    const binary: Int16Array[] = [];
    const session = new VoiceSession(
      initBase, // surfaceKind: 'web'
      depsForTest({
        whisper: mockWhisper(''),
        kokoro: mockKokoro({ chunks: 2, pcmFor: () => new Int16Array(100) }),
        vad: new ScriptedVad([]),
        capturedAudio: [],
        binaryFrames: binary,
        reply: 'ok',
      }),
    );
    session.onSessionStart();
    await session.speak('__WAV__');
    const total = binary.reduce((n, f) => n + f.length, 0);
    expect(total).toBe(200);
  });
});

describe('VoiceSession — utterance ring-buffer overflow (group 14 M3)', () => {
  test('a long utterance without VAD-end slides the window, keeping the tail (keep > 0 branch)', async () => {
    const vad = new ScriptedVad([]); // never fires an event
    let transcribedSamples = -1;
    const whisper: WhisperBackend = {
      async transcribe(pcm) {
        transcribedSamples = pcm.length;
        return 'ok';
      },
      async close() {},
    };
    const session = new VoiceSession(
      initBase,
      depsForTest({
        whisper,
        kokoro: mockKokoro({ chunks: 1 }),
        vad,
        capturedAudio: [],
        binaryFrames: [],
        reply: 'ok',
      }),
    );
    session.onSessionStart();
    // UTTERANCE_CAP_SAMPLES = 30 * 16000 = 480,000. 480-sample frames: the
    // 1000th call exactly fills the buffer (simple append); the 1001st
    // overflows and must slide the window, keeping the tail.
    const frame = new Int16Array(480);
    for (let i = 0; i < 1001; i++) {
      await session.onMicFrame(frame);
    }
    await session.runTurn();
    expect(transcribedSamples).toBe(480_000);
  });

  test('a single mic frame LARGER than the whole utterance buffer drops the oldest samples (keep <= 0 branch)', async () => {
    const vad = new ScriptedVad([]);
    let transcribedSamples = -1;
    const whisper: WhisperBackend = {
      async transcribe(pcm) {
        transcribedSamples = pcm.length;
        return 'ok';
      },
      async close() {},
    };
    const session = new VoiceSession(
      initBase,
      depsForTest({
        whisper,
        kokoro: mockKokoro({ chunks: 1 }),
        vad,
        capturedAudio: [],
        binaryFrames: [],
        reply: 'ok',
      }),
    );
    session.onSessionStart();
    const huge = new Int16Array(500_000); // > UTTERANCE_CAP_SAMPLES (480,000)
    await session.onMicFrame(huge);
    await session.runTurn();
    expect(transcribedSamples).toBe(480_000);
  });
});

// --- AEC reference-ring alignment (alignRefTo) branch coverage -------------
// `alignRefTo` (session.ts, private) feeds the host-side AEC its "what TTS
// was just played" reference window. It has three shapes depending on how
// much TTS has been retained relative to the requested mic-frame length:
//   (a) nothing retained yet            → all-zero (refFilled === 0)
//   (b) partially retained (< len)      → zero-padded head (padHead > 0)
//   (c) retained samples wrap the ring  → two-part copy across the boundary
// Driven directly via the private `retainRef`/`alignRefTo` methods (cast
// through `unknown`, matching the existing private-field pokes elsewhere in
// this file, e.g. the `deps.submitUserTurn` override in the voice-note
// describe block below) — deterministic and free of streaming/timing races.
interface AlignRefTestAccess {
  retainRef(pcm: Int16Array): void;
  alignRefTo(len: number): Int16Array;
  readonly refRing: Int16Array;
  readonly refWrite: number;
  readonly refFilled: number;
}

describe('VoiceSession — AEC reference-ring alignment (alignRefTo branches)', () => {
  test('onMicFrame during "speaking" with surfaceHasAec=false routes the frame through alignRefTo + the host AEC', async () => {
    const vad = new ScriptedVad([]); // never fires — no barge-in noise
    let processCalls = 0;
    const aec: AecProcessor = {
      process: (mic) => {
        processCalls++;
        return mic;
      },
      reset() {},
    };
    let releaseGate!: () => void;
    const gate = new Promise<void>((r) => {
      releaseGate = r;
    });
    const gatedKokoro: KokoroBackend = {
      isReady: () => true,
      async close() {},
      async synthesize(): Promise<KokoroSynthesis> {
        async function* gen(): AsyncGenerator<{ pcm: Int16Array; first: boolean }> {
          yield { pcm: new Int16Array(240), first: true };
          await gate;
        }
        return { iterator: gen(), async cancel() {} };
      },
    };
    const deps = depsForTest({
      whisper: mockWhisper(''),
      kokoro: gatedKokoro,
      vad,
      capturedAudio: [],
      binaryFrames: [],
      reply: 'ok',
    });
    deps.aec = aec;
    const session = new VoiceSession({ ...initBase, surfaceHasAec: false }, deps);
    session.onSessionStart();
    const speaking = session.speak('hello');
    for (let i = 0; i < 100; i++) {
      if (session.getState() === 'speaking') break;
      await new Promise((r) => setTimeout(r, 2));
    }
    expect(session.getState()).toBe('speaking');
    await session.onMicFrame(new Int16Array(480));
    expect(processCalls).toBe(1);
    releaseGate();
    await speaking;
  });

  test('refFilled===0 (nothing retained), partial-fill zero-padding, and ring wraparound are all exercised', () => {
    const session = new VoiceSession(
      { ...initBase, surfaceHasAec: false }, // engages retainRef/alignRefTo
      depsForTest({
        whisper: mockWhisper(''),
        kokoro: mockKokoro(),
        vad: new ScriptedVad([]),
        capturedAudio: [],
        binaryFrames: [],
        reply: 'ok',
      }),
    );
    const s = session as unknown as AlignRefTestAccess;

    // (a) Nothing retained yet → all-zero (the refFilled === 0 early return).
    const outEmpty = s.alignRefTo(480);
    expect(Array.from(outEmpty)).toEqual(new Array(480).fill(0));

    // (b) Partial fill: 100 retained samples < the 480 requested → the head
    // is zero-padded (padHead > 0), no wraparound.
    const chunk1 = new Int16Array(100);
    for (let i = 0; i < chunk1.length; i++) chunk1[i] = 1000 + i; // distinct ramp
    s.retainRef(chunk1);
    const outPartial = s.alignRefTo(480);
    expect(Array.from(outPartial.subarray(0, 380))).toEqual(new Array(380).fill(0));
    expect(Array.from(outPartial.subarray(380))).toEqual(Array.from(chunk1));

    // (c) Retain enough more that the ring (REF_TAIL_CAP = 3200) fills AND
    // wraps such that the NEXT 480-sample align request straddles the wrap
    // boundary (readStart + avail > cap) — the two-segment copy branch.
    const chunk2 = new Int16Array(3150);
    for (let i = 0; i < chunk2.length; i++) chunk2[i] = 2000 + i;
    s.retainRef(chunk2);
    expect(s.refFilled).toBe(3200); // ring is now full
    expect(s.refWrite).toBeLessThan(480); // guarantees the wrap below

    const outWrapped = s.alignRefTo(480);
    // Independently recompute the expected window using the SAME formula,
    // reading straight off the (inspectable) ring — robust to the exact
    // numbers while still proving the wraparound branch executed correctly.
    const cap = s.refRing.length;
    const avail = Math.min(480, s.refFilled);
    const readStart = (s.refWrite - avail + cap) % cap;
    expect(readStart + avail).toBeGreaterThan(cap); // really is the wrap case
    const expected = new Int16Array(480);
    for (let i = 0; i < avail; i++) expected[i] = s.refRing[(readStart + i) % cap]!;
    expect(Array.from(outWrapped)).toEqual(Array.from(expected));
  });
});

describe('VoiceSession — finalizeNote driven by buffered mic audio (not the inject seam)', () => {
  test('finalizeNote with nothing buffered (utteranceLen === 0) returns false without running a turn', async () => {
    let submits = 0;
    const session = new VoiceSession(
      { ...initBase, role: 'voice-note' },
      depsForTest({
        whisper: mockWhisper(''),
        kokoro: mockKokoro({ chunks: 1 }),
        vad: new ScriptedVad([]),
        capturedAudio: [],
        binaryFrames: [],
        reply: 'ok',
        onSubmit: () => {
          submits++;
        },
      }),
    );
    session.onSessionStart();
    // No onMicFrame / injectTranscript at all — utteranceLen stays 0.
    const ran = await session.finalizeNote();
    expect(ran).toBe(false);
    expect(submits).toBe(0);
  });

  test('finalizeNote with buffered mic PCM (no prior injectTranscript) transcribes it via runTurn', async () => {
    let transcribedSamples = -1;
    const whisper: WhisperBackend = {
      async transcribe(pcm) {
        transcribedSamples = pcm.length;
        return 'buffered gesture audio';
      },
      async close() {},
    };
    let lastMsg = '';
    const session = new VoiceSession(
      { ...initBase, role: 'voice-note' },
      depsForTest({
        whisper,
        kokoro: mockKokoro({ chunks: 1 }),
        vad: new ScriptedVad([]), // no VAD event — the gesture end drives everything
        capturedAudio: [],
        binaryFrames: [],
        reply: 'ok',
        onSubmit: (_id, _source) => {},
      }),
    );
    (session as unknown as { deps: SessionDeps }).deps.submitUserTurn = async ({ message }) => {
      lastMsg = message;
      return 'ok';
    };
    session.onSessionStart();
    // Buffer some mic audio the gesture captured — no injectTranscript, so
    // `pendingNoteTranscript` stays undefined and finalizeNote must fall
    // through to the `utteranceLen > 0 → runTurn()` branch.
    await session.onMicFrame(new Int16Array(480));
    const ran = await session.finalizeNote();
    expect(ran).toBe(true);
    expect(transcribedSamples).toBe(480);
    expect(lastMsg).toBe('buffered gesture audio');
  });
});

describe('VoiceSession.close()', () => {
  test('close() is a no-op when no TTS stream is active', async () => {
    const session = new VoiceSession(
      initBase,
      depsForTest({
        whisper: mockWhisper(''),
        kokoro: mockKokoro(),
        vad: new ScriptedVad([]),
        capturedAudio: [],
        binaryFrames: [],
        reply: 'ok',
      }),
    );
    await expect(session.close()).resolves.toBeUndefined();
  });

  test('close() cancels an in-flight Kokoro stream', async () => {
    let cancelled = false;
    let releaseGate!: () => void;
    const gate = new Promise<void>((r) => {
      releaseGate = r;
    });
    const gatedKokoro: KokoroBackend = {
      isReady: () => true,
      async close() {},
      async synthesize(): Promise<KokoroSynthesis> {
        async function* gen(): AsyncGenerator<{ pcm: Int16Array; first: boolean }> {
          yield { pcm: new Int16Array(240), first: true };
          await gate;
        }
        return {
          iterator: gen(),
          async cancel() {
            cancelled = true;
            releaseGate();
          },
        };
      },
    };
    const session = new VoiceSession(
      initBase,
      depsForTest({
        whisper: mockWhisper('hi'),
        kokoro: gatedKokoro,
        vad: new ScriptedVad([]),
        capturedAudio: [],
        binaryFrames: [],
        reply: 'ok',
      }),
    );
    session.onSessionStart();
    const speaking = session.speak('hello');
    // `state` flips to 'speaking' synchronously (before the first await in
    // speak()), but `kokoroStream` is only assigned once `kokoro.synthesize()`
    // resolves — at least one macrotask later. Poll on a REAL timer (not a
    // microtask) so that assignment has definitely happened before close().
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 2));
      if (session.getState() === 'speaking') break;
    }
    expect(session.getState()).toBe('speaking');
    await session.close();
    expect(cancelled).toBe(true);
    await speaking.catch(() => {});
  });
});

describe('VoiceSession — pre-"listening" no-op guards (state === "connecting")', () => {
  test('onMicFrame before onSessionStart is a no-op', async () => {
    const session = new VoiceSession(
      initBase,
      depsForTest({
        whisper: mockWhisper(''),
        kokoro: mockKokoro(),
        vad: new ScriptedVad([]),
        capturedAudio: [],
        binaryFrames: [],
        reply: 'ok',
      }),
    );
    expect(session.getState()).toBe('connecting');
    await expect(session.onMicFrame(new Int16Array(480))).resolves.toBeUndefined();
    expect(session.getState()).toBe('connecting');
  });

  test('injectTranscript before onSessionStart is a no-op', async () => {
    let submits = 0;
    const session = new VoiceSession(
      initBase,
      depsForTest({
        whisper: mockWhisper(''),
        kokoro: mockKokoro(),
        vad: new ScriptedVad([]),
        capturedAudio: [],
        binaryFrames: [],
        reply: 'ok',
        onSubmit: () => {
          submits++;
        },
      }),
    );
    await session.injectTranscript('hello before start');
    expect(submits).toBe(0);
    expect(session.getState()).toBe('connecting');
  });

  test('finalizeNote before onSessionStart returns false', async () => {
    const session = new VoiceSession(
      { ...initBase, role: 'voice-note' },
      depsForTest({
        whisper: mockWhisper(''),
        kokoro: mockKokoro(),
        vad: new ScriptedVad([]),
        capturedAudio: [],
        binaryFrames: [],
        reply: 'ok',
      }),
    );
    await expect(session.finalizeNote()).resolves.toBe(false);
  });

  test('finalizeNote is a no-op (false) while a turn is already mid-flight (state transcribing/thinking)', async () => {
    let resolveWhisper!: (v: string) => void;
    const whisper: WhisperBackend = {
      transcribe: () =>
        new Promise<string>((r) => {
          resolveWhisper = r;
        }),
      async close() {},
    };
    const session = new VoiceSession(
      { ...initBase, role: 'voice-note' },
      depsForTest({
        whisper,
        kokoro: mockKokoro({ chunks: 1 }),
        vad: new ScriptedVad([]),
        capturedAudio: [],
        binaryFrames: [],
        reply: 'ok',
      }),
    );
    session.onSessionStart();
    await session.onMicFrame(new Int16Array(480)); // buffer some gesture audio
    const turn = session.runTurn(); // synchronously flips state -> 'transcribing', then blocks on whisper
    expect(session.getState()).toBe('transcribing');
    const ranMidFlight = await session.finalizeNote();
    expect(ranMidFlight).toBe(false);
    resolveWhisper('done'); // let the in-flight turn finish so the test doesn't hang
    await turn;
  });
});

describe('VoiceSession — SDK failure message sanitization edge case', () => {
  test('an error with an empty `.name` falls back to the literal "Error" in the sanitized message', async () => {
    const audio: AudioEvent[] = [];
    const vad = new ScriptedVad(['utterance_start', 'utterance_end']);
    const deps = depsForTest({
      whisper: mockWhisper('hello'),
      kokoro: mockKokoro({ chunks: 1 }),
      vad,
      capturedAudio: audio,
      binaryFrames: [],
      reply: 'unused',
    });
    deps.submitUserTurn = async () => {
      const err = new Error('oops');
      err.name = '';
      throw err;
    };
    const session = new VoiceSession(initBase, deps);
    session.onSessionStart();
    await session.onMicFrame(new Int16Array(480));
    await session.onMicFrame(new Int16Array(480));
    const err = audio.find((e) => e.type === 'audio.error');
    expect(err).toBeDefined();
    if (err?.type === 'audio.error') expect(err.message).toBe('turn failed: Error');
  });
});

describe('VoiceSession — device TTS-chunk audio.tts_chunk firstFrameLatencyMs branch', () => {
  test('a device Kokoro stream whose chunks never set `first` omits firstFrameLatencyMs from the tts_chunk event', async () => {
    const audio: AudioEvent[] = [];
    const binary: Int16Array[] = [];
    const vad = new ScriptedVad(['utterance_start', 'utterance_end']);
    const neverFirstKokoro: KokoroBackend = {
      isReady: () => true,
      async close() {},
      async synthesize(): Promise<KokoroSynthesis> {
        async function* gen(): AsyncGenerator<{ pcm: Int16Array; first: boolean }> {
          // `first` is explicitly false on every chunk (including the very
          // first), so `firstFrameLatency` never gets assigned in speak().
          yield { pcm: new Int16Array(240), first: false };
        }
        return { iterator: gen(), async cancel() {} };
      },
    };
    const session = new VoiceSession(
      {
        ...initBase,
        surfaceKind: 'device',
        role: 'voice-device-conv',
        surfaceHasAec: false,
        chatId: 'thread_speakers',
        deviceId: 'kitchen',
      },
      depsForTest({
        whisper: mockWhisper('hi'),
        kokoro: neverFirstKokoro,
        vad,
        capturedAudio: audio,
        binaryFrames: binary,
        reply: 'ok',
      }),
    );
    session.onSessionStart();
    await session.onMicFrame(new Int16Array(480));
    await session.onMicFrame(new Int16Array(480));
    await session.waitForSpeakDone();
    const chunkEvent = audio.find((e) => e.type === 'audio.tts_chunk');
    expect(chunkEvent).toBeDefined();
    if (chunkEvent?.type === 'audio.tts_chunk') {
      expect(chunkEvent.firstFrameLatencyMs).toBeUndefined();
    }
  });
});

describe('VoiceSession — barge-in during the device-audio SEND loop (post-resample)', () => {
  test('a barge-in that lands while the resampled 48kHz frames are still being sent stops mid-stream', async () => {
    // Enough total device audio (>=9 frames of 1920 samples) that the send
    // loop's periodic "yield every 8 frames" (`await new Promise(setTimeout)`)
    // actually fires at least once — that yield point is what lets a
    // concurrently-triggered `onMicFrame` barge-in's microtask chain
    // (vad.feed -> kokoroStream.cancel -> setState) complete BEFORE the loop's
    // next `if (this.bargedIn) break` check, deterministically stopping the
    // send partway through rather than racing on wall-clock timing.
    const audio: AudioEvent[] = [];
    const binary: Int16Array[] = [];
    const startEndVad = new ScriptedVad(['utterance_start', 'utterance_end']);

    class OneShotStartVad implements Vad {
      private fired = false;
      async feed(): Promise<VadFrameResult> {
        if (!this.fired) {
          this.fired = true;
          return { prob: 1, event: 'utterance_start', state: 'speech' };
        }
        return { prob: 0, event: null, state: 'speech' };
      }
      reset(): void {
        this.fired = false;
      }
      async close(): Promise<void> {}
    }

    const deps = depsForTest({
      whisper: mockWhisper('hi'),
      kokoro: mockKokoro({ chunks: 8, pcmFor: () => new Int16Array(2000) }),
      vad: startEndVad,
      capturedAudio: audio,
      binaryFrames: [],
      reply: 'a reply the device plays back over many frames',
    });
    let triggered = false;
    // Assigned after construction below, referenced by the closure above it.
    let session: VoiceSession;
    deps.sendBinary = (pcm) => {
      binary.push(pcm);
      if (!triggered) {
        triggered = true;
        deps.vad = new OneShotStartVad();
        // Fire-and-forget: drives the barge-in branch concurrently with the
        // still-in-flight device-audio send loop below.
        void session.onMicFrame(new Int16Array(480));
      }
    };
    session = new VoiceSession(
      {
        ...initBase,
        surfaceKind: 'device',
        role: 'voice-device-conv',
        surfaceHasAec: false,
        chatId: 'thread_speakers',
        deviceId: 'kitchen',
      },
      deps,
    );
    session.onSessionStart();
    await session.onMicFrame(new Int16Array(480));
    await session.onMicFrame(new Int16Array(480));
    await session.waitForSpeakDone();

    // 8 chunks x 2000 samples = 16,000 @ 24kHz -> 32,000 @ 48kHz -> 17 frames
    // of <=1920 samples if sent in full. The barge-in must have stopped the
    // send loop short of that.
    expect(binary.length).toBeGreaterThan(0);
    expect(binary.length).toBeLessThan(17);
    expect(audio.filter((e) => e.type === 'audio.barge_in').length).toBe(1);
    expect(audio.some((e) => e.type === 'audio.tts_end' && e.bargedIn === true)).toBe(true);
    expect(session.getState()).toBe('listening');
  });
});

describe('VoiceSession: getKokoroVoice forwarding', () => {
  test('voice from getKokoroVoice is passed to kokoro.synthesize()', async () => {
    const capturedVoice: Array<string | undefined> = [];
    const vad = new ScriptedVad(['utterance_start', null, 'utterance_end']);
    const kokoroDeps = depsForTest({
      whisper: mockWhisper('test phrase'),
      kokoro: mockKokoro({
        chunks: 1,
        onSynthesize: (_text, voice) => capturedVoice.push(voice),
      }),
      vad,
      capturedAudio: [],
      binaryFrames: [],
      reply: 'ok',
    });
    const session = new VoiceSession(initBase, {
      ...kokoroDeps,
      getKokoroVoice: () => 'af_sky',
    });
    session.onSessionStart();
    await session.onMicFrame(new Int16Array(480));
    await session.onMicFrame(new Int16Array(480));
    await session.onMicFrame(new Int16Array(480));
    await session.waitForSpeakDone();
    expect(capturedVoice).toHaveLength(1);
    expect(capturedVoice[0]).toBe('af_sky');
  });

  test('when getKokoroVoice is absent, synthesize() is called with undefined voice', async () => {
    const capturedVoice: Array<string | undefined> = [];
    const vad = new ScriptedVad(['utterance_start', null, 'utterance_end']);
    const session = new VoiceSession(
      initBase,
      depsForTest({
        whisper: mockWhisper('test phrase'),
        kokoro: mockKokoro({
          chunks: 1,
          onSynthesize: (_text, voice) => capturedVoice.push(voice),
        }),
        vad,
        capturedAudio: [],
        binaryFrames: [],
        reply: 'ok',
      }),
    );
    session.onSessionStart();
    await session.onMicFrame(new Int16Array(480));
    await session.onMicFrame(new Int16Array(480));
    await session.onMicFrame(new Int16Array(480));
    await session.waitForSpeakDone();
    expect(capturedVoice).toHaveLength(1);
    expect(capturedVoice[0]).toBeUndefined();
  });

  test('getKokoroVoice is read dynamically — a change between turns takes effect on the next utterance', async () => {
    const capturedVoice: Array<string | undefined> = [];
    let currentVoice = 'af_sky';
    // Two back-to-back utterances with the voice changing between them.
    const vadScript1 = new ScriptedVad(['utterance_start', null, 'utterance_end']);
    const session = new VoiceSession(initBase, {
      ...depsForTest({
        whisper: mockWhisper('first'),
        kokoro: mockKokoro({
          chunks: 1,
          onSynthesize: (_text, voice) => capturedVoice.push(voice),
        }),
        vad: vadScript1,
        capturedAudio: [],
        binaryFrames: [],
        reply: 'r',
      }),
      getKokoroVoice: () => currentVoice,
    });
    session.onSessionStart();
    await session.onMicFrame(new Int16Array(480));
    await session.onMicFrame(new Int16Array(480));
    await session.onMicFrame(new Int16Array(480));
    await session.waitForSpeakDone();
    // Change voice for the next utterance.
    currentVoice = 'am_adam';
    // Simulate a second utterance: start a new session with the same getKokoroVoice callback.
    const vadScript2 = new ScriptedVad(['utterance_start', null, 'utterance_end']);
    const session2 = new VoiceSession(initBase, {
      ...depsForTest({
        whisper: mockWhisper('second'),
        kokoro: mockKokoro({
          chunks: 1,
          onSynthesize: (_text, voice) => capturedVoice.push(voice),
        }),
        vad: vadScript2,
        capturedAudio: [],
        binaryFrames: [],
        reply: 'r',
      }),
      getKokoroVoice: () => currentVoice,
    });
    session2.onSessionStart();
    await session2.onMicFrame(new Int16Array(480));
    await session2.onMicFrame(new Int16Array(480));
    await session2.onMicFrame(new Int16Array(480));
    await session2.waitForSpeakDone();
    expect(capturedVoice[0]).toBe('af_sky');
    expect(capturedVoice[1]).toBe('am_adam');
  });
});

describe('resampleTtsTo48k — int16 clamp branch coverage', () => {
  test('clamps FIR-filter overshoot to the int16 range on a full-scale +/-1 bit pattern', () => {
    // A specific full-scale +/-32767/-32768 bit pattern (found by a brute-force
    // search over random full-scale sequences — the very first trial hit it).
    // Unlike a plain alternating square wave or DC (both of which stay inside
    // int16 for this particular FIR), THIS pattern drives the raw pre-clamp
    // convolution sum (`acc`) past +/-32768 on both ends, so the ternary clamp
    // in resampleTtsTo48k (not just its Math.round pass-through) actually
    // fires — verified by inspecting the un-clamped `acc` directly during
    // investigation before picking this fixture.
    const bits = '0110001001111000001011010110111010100110';
    const pcm24 = Int16Array.from(bits, (c) => (c === '1' ? 32767 : -32768));
    const out = resampleTtsTo48k(pcm24);
    expect(out.length).toBe(pcm24.length * 2);
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(-32768);
      expect(v).toBeLessThanOrEqual(32767);
    }
    expect(Math.max(...out)).toBe(32767);
    expect(Math.min(...out)).toBe(-32768);
  });
});

// spec/07 § Call cost — `local` counts what it sent to a paid STT backend.
describe('VoiceSession — engine costing', () => {
  test('counts each Groq request and bills at least 10s per request', async () => {
    const vad = new ScriptedVad(['utterance_start', null, 'utterance_end']);
    const whisper: WhisperBackend = {
      ...mockWhisper('hello world'),
      costModel: 'whisper-large-v3-turbo',
    } as WhisperBackend;
    const session = new VoiceSession(
      initBase,
      depsForTest({
        whisper,
        kokoro: mockKokoro({ chunks: 1 }),
        vad,
        capturedAudio: [],
        binaryFrames: [],
        reply: 'hi back',
      }),
    );
    session.onSessionStart();
    await session.onMicFrame(new Int16Array(480));
    await session.onMicFrame(new Int16Array(480));
    await session.onMicFrame(new Int16Array(480));
    await session.waitForSpeakDone();
    const c = session.engineCosting();
    expect(c.backend).toBe('local');
    expect(c.model).toBe('whisper-large-v3-turbo');
    expect(c.tokens).toBeNull();
    expect(c.stt?.requests).toBe(1);
    expect(c.stt?.billedSeconds).toBe(10);
    expect(c.stt?.audioSeconds).toBeGreaterThan(0);
  });

  test('a free STT backend reports no STT spend', async () => {
    const session = new VoiceSession(
      initBase,
      depsForTest({
        whisper: mockWhisper('x'),
        kokoro: mockKokoro({ chunks: 1 }),
        vad: new ScriptedVad([]),
        capturedAudio: [],
        binaryFrames: [],
        reply: '',
      }),
    );
    expect(session.engineCosting().stt).toBeNull();
    expect(session.isAwaitingHandoff()).toBe(false);
  });
});
