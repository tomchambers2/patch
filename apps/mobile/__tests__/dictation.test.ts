// lib/dictation.ts — the composer live-dictation session. This file exists
// specifically to PROVE the fastest-gesture race fix documented in
// dictation.ts's header (the thing that got the original streaming attempt
// reverted in `2c94aab`): the final transcript must never depend on the
// WSS token-mint/open completing, only on local mic capture. Composer.voice
// test.tsx already covers how Composer REACTS to a `finish()` contract; this
// file proves `lib/dictation.ts` itself UPHOLDS that contract under real
// async/timing conditions, using the same FakeWebSocket double voiceCall.
// test.ts uses.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installFakeWebSocket, restoreWebSocket, FakeWebSocket } from './testUtils/fakeWebSocket';
import { encodeAudio } from '@patch/wire/audio';

const meMock = vi.fn(async () => ({
  account: { accountId: 'acc1', userPublicKey: 'k', createdAt: 0 },
  surface: { surfaceId: 'surf1', surfaceKind: 'mobile', label: 'l', issuedAt: 0 },
}));
const voiceTokenMock = vi.fn(async () => ({
  token: 'tok1',
  sessionId: 'sess-1',
  audioUrl: '/audio/sess-1',
  expiresAt: 0,
}));
const voiceTranscribeMock = vi.fn(async () => ({ ok: true as const, transcript: 'hello world' }));
vi.mock('../src/api/rest', () => ({
  api: { me: meMock, voiceToken: voiceTokenMock, voiceTranscribe: voiceTranscribeMock },
}));

let micOnFrame: ((pcm: Int16Array) => void) | undefined;
let micOnError: ((message: string) => void) | undefined;
const startMicCaptureMock = vi.fn(
  async (onFrame: (pcm: Int16Array) => void, onError: (message: string) => void) => {
    micOnFrame = onFrame;
    micOnError = onError;
  },
);
const stopMicCaptureMock = vi.fn(async () => undefined);
vi.mock('../src/lib/voiceMic', () => ({
  startMicCapture: startMicCaptureMock,
  stopMicCapture: stopMicCaptureMock,
}));

// Generous by default: the cold setup path is a long microtask chain
// (permission -> audio mode -> mic start -> /me -> token mint -> WS
// construction) and a too-small flush reads as "no WebSocket was constructed".
async function flush(n = 20): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

/**
 * One native mic frame: 640 samples of PCM16 @ 16 kHz = 40ms, exactly what
 * PatchVoiceMicModule emits. Length matters now — a clip below
 * MIN_UTTERANCE_MS is reported as `too-short` and never uploaded.
 */
function micFrame(): Int16Array {
  return new Int16Array(640);
}
/** Feed `ms` of audio, rounded up to whole 40ms native frames. */
function speak(ms: number): void {
  for (let i = 0; i < Math.ceil(ms / 40); i++) micOnFrame!(micFrame());
}

beforeEach(async () => {
  installFakeWebSocket();
  vi.clearAllMocks();
  // The resolved permission/audio-mode state is cached module-wide (that
  // caching IS the fix for "the first words are always lost"), so every test
  // has to start from cold or it silently exercises the warm path.
  (await import('../src/lib/dictation')).__resetDictationAudio();
  micOnFrame = undefined;
  micOnError = undefined;
  meMock.mockResolvedValue({
    account: { accountId: 'acc1', userPublicKey: 'k', createdAt: 0 },
    surface: { surfaceId: 'surf1', surfaceKind: 'mobile', label: 'l', issuedAt: 0 },
  });
  voiceTokenMock.mockResolvedValue({
    token: 'tok1',
    sessionId: 'sess-1',
    audioUrl: '/audio/sess-1',
    expiresAt: 0,
  });
  voiceTranscribeMock.mockResolvedValue({ ok: true, transcript: 'hello world' });
  startMicCaptureMock.mockImplementation(async (onFrame, onError) => {
    micOnFrame = onFrame;
    micOnError = onError;
  });
});

afterEach(() => {
  restoreWebSocket();
});

describe('startDictation — the fastest-gesture race (2c94aab regression coverage)', () => {
  it('a tap-then-immediate-release, BEFORE the token mint / WS ever resolves, still captures + uploads the buffered clip', async () => {
    // Block the token mint indefinitely — the preview socket will never
    // open during this test. If the final transcript depended on it (the
    // original bug), `finish` would come back empty/null.
    let resolveToken:
      | ((v: typeof voiceTokenMock extends () => Promise<infer T> ? T : never) => void)
      | undefined;
    voiceTokenMock.mockReturnValueOnce(
      new Promise((r) => {
        resolveToken = r;
      }),
    );
    const { startDictation } = await import('../src/lib/dictation');
    const onPartial = vi.fn();
    const onError = vi.fn();
    const handle = startDictation('c1', onPartial, onError);

    // Let mic permission + audio-mode + startMicCapture resolve (all local,
    // no network) — this is the ONLY thing the fastest gesture can rely on.
    await flush();
    expect(startMicCaptureMock).toHaveBeenCalled();
    speak(400);

    // Release immediately — well before the still-pending token mint
    // resolves, and therefore before any WS was ever constructed.
    const result = await handle.finish(true);

    expect(FakeWebSocket.instances.length).toBe(0); // never got that far
    expect(voiceTranscribeMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ kind: 'text', text: 'hello world' });
    expect(onError).not.toHaveBeenCalled();

    // The token mint finally resolving afterwards must be a harmless no-op
    // (no crash, no stray WS, no duplicate upload).
    resolveToken!({ token: 'tok1', sessionId: 'sess-1', audioUrl: '/audio/sess-1', expiresAt: 0 });
    await flush();
    expect(FakeWebSocket.instances.length).toBe(0);
    expect(voiceTranscribeMock).toHaveBeenCalledTimes(1);
  });

  it('an even faster release — before startMicCapture itself resolves — captures zero frames and reports no-audio (never a silent empty result)', async () => {
    let resolveMic: (() => void) | undefined;
    startMicCaptureMock.mockImplementationOnce(
      (onFrame, onError) =>
        new Promise<void>((r) => {
          micOnFrame = onFrame;
          micOnError = onError;
          resolveMic = r;
        }),
    );
    const { startDictation } = await import('../src/lib/dictation');
    const handle = startDictation('c1', vi.fn(), vi.fn());

    // Let permission + audio-mode setup resolve so startMicCapture is
    // actually invoked (and its promise executor runs, capturing
    // `resolveMic`) — but don't let THAT promise resolve yet.
    await vi.waitFor(() => expect(startMicCaptureMock).toHaveBeenCalled());

    // Release before startMicCapture's own promise has resolved.
    const resultPromise = handle.finish(true);
    resolveMic!();
    await flush();
    const result = await resultPromise;

    expect(result).toEqual({ kind: 'no-audio' });
    expect(voiceTranscribeMock).not.toHaveBeenCalled();
  });

  it('a token mint that resolves BEFORE release still only uploads via the local buffer, not the socket', async () => {
    const { startDictation } = await import('../src/lib/dictation');
    const handle = startDictation('c1', vi.fn(), vi.fn());
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    const sock = FakeWebSocket.last();
    sock.emitOpen();
    await flush();
    speak(400);

    await handle.finish(true);
    expect(voiceTranscribeMock).toHaveBeenCalledTimes(1);
    // session_end is always 'cancelled' — never 'committed' — regardless of
    // how much of the preview socket lifecycle completed.
    const sent = sock.sent.map((s) => (typeof s === 'string' ? JSON.parse(s) : s));
    const end = sent.find(
      (s) => typeof s === 'object' && s && (s as { type?: string }).type === 'audio.session_end',
    );
    expect(end).toMatchObject({ type: 'audio.session_end', reason: 'cancelled' });
    expect(sock.close).toHaveBeenCalled();
  });
});

describe('startDictation — live preview (best-effort, never affects the final transcript)', () => {
  it('forwards audio.transcript_partial frames to onPartial once the socket is open', async () => {
    const { startDictation } = await import('../src/lib/dictation');
    const onPartial = vi.fn();
    const handle = startDictation('c1', onPartial, vi.fn());
    await flush();
    const sock = FakeWebSocket.last();
    sock.emitOpen();
    await flush();
    sock.emitMessage(
      encodeAudio({ type: 'audio.transcript_partial', sessionId: 'sess-1', text: 'buy oat' }),
    );
    expect(onPartial).toHaveBeenCalledWith('buy oat');
    await handle.finish(false);
  });

  it('queues frames captured before the socket opens, then flushes them once open', async () => {
    const { startDictation } = await import('../src/lib/dictation');
    const handle = startDictation('c1', vi.fn(), vi.fn());
    await flush();
    const sock = FakeWebSocket.last();
    // Frames arrive BEFORE emitOpen — preview queue path.
    micOnFrame!(new Int16Array([1]));
    micOnFrame!(new Int16Array([2]));
    expect(sock.sent.length).toBe(0);
    sock.emitOpen();
    await flush();
    // session_start + 2 queued frames * 2 sends each (header + binary).
    expect(sock.sent.length).toBe(1 + 4);
    await handle.finish(false);
  });

  it('a dead/never-opened preview socket does not call onError — only local capture failures do', async () => {
    voiceTokenMock.mockRejectedValueOnce(new Error('network down'));
    const { startDictation } = await import('../src/lib/dictation');
    const onError = vi.fn();
    const handle = startDictation('c1', vi.fn(), onError);
    await flush();
    expect(onError).not.toHaveBeenCalled();
    speak(400);
    const result = await handle.finish(true);
    expect(result).toEqual({ kind: 'text', text: 'hello world' });
  });

  it('a genuine local mic read failure DOES call onError (NO FALLBACK — surfaced, not swallowed)', async () => {
    const { startDictation } = await import('../src/lib/dictation');
    const onError = vi.fn();
    startDictation('c1', vi.fn(), onError);
    await flush();
    micOnError!('AudioRecord died');
    expect(onError).toHaveBeenCalledWith('dictation mic failed: AudioRecord died');
  });

  it('mic permission denied surfaces onError and never starts capture', async () => {
    const { Audio } = await import('expo-av');
    vi.spyOn(Audio, 'requestPermissionsAsync').mockResolvedValueOnce({ granted: false });
    const { startDictation } = await import('../src/lib/dictation');
    const onError = vi.fn();
    startDictation('c1', vi.fn(), onError);
    await flush();
    expect(onError).toHaveBeenCalledWith('dictation setup failed: mic permission denied');
    expect(startMicCaptureMock).not.toHaveBeenCalled();
  });
});

describe('startDictation — finish() idempotency + cancel', () => {
  it('finish(false) never uploads, closes the socket, stops the mic', async () => {
    const { startDictation } = await import('../src/lib/dictation');
    const handle = startDictation('c1', vi.fn(), vi.fn());
    await flush();
    const sock = FakeWebSocket.last();
    sock.emitOpen();
    await flush();
    speak(400);

    const result = await handle.finish(false);
    expect(result).toEqual({ kind: 'discarded' });
    expect(voiceTranscribeMock).not.toHaveBeenCalled();
    expect(sock.close).toHaveBeenCalled();
    expect(stopMicCaptureMock).toHaveBeenCalled();
  });

  it('calling finish() a second time is a harmless no-op (does not re-upload)', async () => {
    const { startDictation } = await import('../src/lib/dictation');
    const handle = startDictation('c1', vi.fn(), vi.fn());
    await flush();
    speak(400);
    await handle.finish(true);
    voiceTranscribeMock.mockClear();
    const second = await handle.finish(true);
    expect(second).toEqual({ kind: 'discarded' });
    expect(voiceTranscribeMock).not.toHaveBeenCalled();
  });

  it('an onPartial arriving after finish() is not possible — the socket is closed synchronously by finish()', async () => {
    const { startDictation } = await import('../src/lib/dictation');
    const onPartial = vi.fn();
    const handle = startDictation('c1', onPartial, vi.fn());
    await flush();
    const sock = FakeWebSocket.last();
    sock.emitOpen();
    await flush();
    await handle.finish(false);
    expect(sock.readyState).toBe(FakeWebSocket.CLOSED);
  });
});

describe('startDictation — the audio plane is warmed AHEAD of the gesture', () => {
  it('after warmDictation, startMicCapture is called SYNCHRONOUSLY with no permission/audio-mode round trip in front of it', async () => {
    const { Audio } = await import('expo-av');
    const { warmDictation, startDictation } = await import('../src/lib/dictation');
    await warmDictation();

    const requestSpy = vi.spyOn(Audio, 'requestPermissionsAsync');
    const modeSpy = vi.spyOn(Audio, 'setAudioModeAsync');
    const handle = startDictation('c1', vi.fn(), vi.fn());

    // No `await`, no `flush()` — the mic is started in the SAME tick as the
    // press. Every awaited step here is a lost word of the user's first
    // sentence, which is why there must be none.
    expect(startMicCaptureMock).toHaveBeenCalledTimes(1);
    expect(requestSpy).not.toHaveBeenCalled();
    expect(modeSpy).not.toHaveBeenCalled();
    await handle.finish(false);
  });

  it('warmDictation resolves permission + the recording audio mode exactly once, however often it is called', async () => {
    const { Audio } = await import('expo-av');
    const modeSpy = vi.spyOn(Audio, 'setAudioModeAsync');
    const { warmDictation } = await import('../src/lib/dictation');
    await Promise.all([warmDictation(), warmDictation()]);
    await warmDictation();
    expect(modeSpy).toHaveBeenCalledTimes(1);
  });

  it('warmDictation never shows a permission dialog — it reads the current grant and stays cold if it is not granted', async () => {
    const { Audio } = await import('expo-av');
    vi.spyOn(Audio, 'getPermissionsAsync').mockResolvedValueOnce({ granted: false });
    const requestSpy = vi.spyOn(Audio, 'requestPermissionsAsync');
    const { warmDictation, startDictation } = await import('../src/lib/dictation');

    await warmDictation();
    expect(requestSpy).not.toHaveBeenCalled();

    // Cold, so the press path is the thing that prompts — and a denial there
    // still reaches onError (NO FALLBACK).
    const handle = startDictation('c1', vi.fn(), vi.fn());
    expect(startMicCaptureMock).not.toHaveBeenCalled();
    await flush();
    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(startMicCaptureMock).toHaveBeenCalledTimes(1);
    await handle.finish(false);
  });

  it('a gesture that ends while the permission dialog is still up never starts the mic', async () => {
    const { Audio } = await import('expo-av');
    let grant!: (v: { granted: boolean }) => void;
    vi.spyOn(Audio, 'requestPermissionsAsync').mockReturnValueOnce(
      new Promise((r) => {
        grant = r;
      }) as ReturnType<typeof Audio.requestPermissionsAsync>,
    );
    const { startDictation } = await import('../src/lib/dictation');
    const onError = vi.fn();
    const handle = startDictation('c1', vi.fn(), onError);

    expect(await handle.finish(true)).toEqual({ kind: 'no-audio' });
    grant({ granted: true });
    await flush();
    expect(startMicCaptureMock).not.toHaveBeenCalled();
    expect(stopMicCaptureMock).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('a warmed session still surfaces a native mic failure (warming is not a bypass)', async () => {
    const { warmDictation, startDictation } = await import('../src/lib/dictation');
    await warmDictation();
    const onError = vi.fn();
    startDictation('c1', vi.fn(), onError);
    await flush();
    micOnError!('AudioRecord died');
    expect(onError).toHaveBeenCalledWith('dictation mic failed: AudioRecord died');
  });
});

describe('startDictation — an empty result always names its cause', () => {
  it('no frames at all: no-audio, and no upload', async () => {
    const { startDictation } = await import('../src/lib/dictation');
    const handle = startDictation('c1', vi.fn(), vi.fn());
    await flush();
    expect(await handle.finish(true)).toEqual({ kind: 'no-audio' });
    expect(voiceTranscribeMock).not.toHaveBeenCalled();
  });

  it('a clip below MIN_UTTERANCE_MS: too-short with its real length, and no upload', async () => {
    const { startDictation, MIN_UTTERANCE_MS } = await import('../src/lib/dictation');
    const handle = startDictation('c1', vi.fn(), vi.fn());
    await flush();
    speak(80); // two 40ms native frames — a stab at the button, not a sentence
    const result = await handle.finish(true);
    expect(result).toEqual({ kind: 'too-short', ms: 80 });
    expect(80).toBeLessThan(MIN_UTTERANCE_MS);
    expect(voiceTranscribeMock).not.toHaveBeenCalled();
  });

  it('a clip on the MIN_UTTERANCE_MS boundary is uploaded, not rejected', async () => {
    const { startDictation, MIN_UTTERANCE_MS } = await import('../src/lib/dictation');
    const handle = startDictation('c1', vi.fn(), vi.fn());
    await flush();
    speak(MIN_UTTERANCE_MS);
    expect(await handle.finish(true)).toEqual({ kind: 'text', text: 'hello world' });
    expect(voiceTranscribeMock).toHaveBeenCalledTimes(1);
  });

  it('a real clip that Whisper hears nothing in: no-speech (the upload DID happen)', async () => {
    voiceTranscribeMock.mockResolvedValueOnce({ ok: true, transcript: '   ' });
    const { startDictation } = await import('../src/lib/dictation');
    const handle = startDictation('c1', vi.fn(), vi.fn());
    await flush();
    speak(400);
    expect(await handle.finish(true)).toEqual({ kind: 'no-speech' });
    expect(voiceTranscribeMock).toHaveBeenCalledTimes(1);
  });

  it('a real transcript comes back trimmed, so the composer never has to re-check it', async () => {
    voiceTranscribeMock.mockResolvedValueOnce({ ok: true, transcript: '  buy oat milk \n' });
    const { startDictation } = await import('../src/lib/dictation');
    const handle = startDictation('c1', vi.fn(), vi.fn());
    await flush();
    speak(400);
    expect(await handle.finish(true)).toEqual({ kind: 'text', text: 'buy oat milk' });
  });
});
