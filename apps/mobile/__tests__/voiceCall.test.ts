// lib/voiceCall.ts — the sustained voice-CALL session (spec/07 § End-to-end
// voice transport). voiceGestures.test.ts already pins the SYNCHRONOUS
// overlay-mount guarantee; this file drives the full async setup (token
// mint → mic permission → TTS sink → audio WS → session_start → mic uplink)
// and the WS message dispatch table, using the FakeWebSocket test double and
// mocked native-bridge modules (voiceMic/voiceTts/voiceAudioService — their
// OWN NativeModules-branch tests live in voiceMic.test.ts / voiceTts.test.ts
// / voiceAudioService.test.ts; here we only care that voiceCall wires them
// correctly).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installFakeWebSocket, restoreWebSocket, FakeWebSocket } from './testUtils/fakeWebSocket';
import { useVoiceStore } from '../src/stores/voiceStore';
import { useUiStore } from '../src/stores/uiStore';

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
vi.mock('../src/api/rest', () => ({ api: { me: meMock, voiceToken: voiceTokenMock } }));

const startVoiceAudioServiceMock = vi.fn(async () => undefined);
const stopVoiceAudioServiceMock = vi.fn(async () => undefined);
const updateVoiceAudioServiceMock = vi.fn(async () => undefined);
// The notification's buttons come back through this; capture the handler so a
// test can press them (spec/15 § Voice tab — the notification is the control
// surface for a phone the user is not looking at).
let serviceActionHandler: ((action: 'mute' | 'mode' | 'stop') => void) | undefined;
const onVoiceServiceActionMock = vi.fn((h: (action: 'mute' | 'mode' | 'stop') => void) => {
  serviceActionHandler = h;
  return () => {
    serviceActionHandler = undefined;
  };
});
vi.mock('../src/lib/voiceAudioService', () => ({
  startVoiceAudioService: startVoiceAudioServiceMock,
  stopVoiceAudioService: stopVoiceAudioServiceMock,
  updateVoiceAudioService: updateVoiceAudioServiceMock,
  onVoiceServiceAction: onVoiceServiceActionMock,
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

const startTtsPlaybackMock = vi.fn(async () => undefined);
const writeTtsPcmMock = vi.fn();
const flushTtsPlaybackMock = vi.fn(async () => undefined);
const stopTtsPlaybackMock = vi.fn(async () => undefined);
vi.mock('../src/lib/voiceTts', () => ({
  startTtsPlayback: startTtsPlaybackMock,
  writeTtsPcm: writeTtsPcmMock,
  flushTtsPlayback: flushTtsPlaybackMock,
  stopTtsPlayback: stopTtsPlaybackMock,
}));

async function flush(n = 6): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

beforeEach(() => {
  installFakeWebSocket();
  vi.clearAllMocks();
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
  startMicCaptureMock.mockImplementation(async (onFrame, onError) => {
    micOnFrame = onFrame;
    micOnError = onError;
  });
  useVoiceStore.setState({
    activeSession: null,
    callMuted: false,
    callError: null,
    callPhase: 'connecting',
    callTranscriptPartial: null as unknown as string,
  });
  useUiStore.setState({ errors: [] });
});

afterEach(() => {
  restoreWebSocket();
});

describe('startVoiceCall — happy path', () => {
  it('mints a token, opens the audio WS, sends session_start, and starts mic uplink', async () => {
    const { startVoiceCall } = await import('../src/lib/voiceCall');
    startVoiceCall('c1');
    await flush();
    expect(voiceTokenMock).toHaveBeenCalledWith('c1', 'voice-call');
    expect(startTtsPlaybackMock).toHaveBeenCalled();
    expect(useVoiceStore.getState().activeSession).toMatchObject({
      sessionId: 'sess-1',
      audioUrl: '/audio/sess-1',
    });
    // The notification names the mode it is running in (spec/15 § Voice tab).
    expect(startVoiceAudioServiceMock).toHaveBeenCalledWith('c1', 'call', false);

    const sock = FakeWebSocket.last();
    expect(sock.url).toContain('/audio/sess-1');
    sock.emitOpen();
    await flush();
    const start = JSON.parse(sock.sent[0] as string);
    expect(start).toMatchObject({
      type: 'audio.session_start',
      sessionId: 'sess-1',
      accountId: 'acc1',
      surfaceId: 'surf1',
      chatId: 'c1',
      role: 'voice-call',
      token: 'tok1',
    });
    expect(startMicCaptureMock).toHaveBeenCalled();
  });

  it('forwards a captured mic frame as a pcm16 header + binary frame', async () => {
    const { startVoiceCall } = await import('../src/lib/voiceCall');
    startVoiceCall('c1');
    await flush();
    const sock = FakeWebSocket.last();
    sock.emitOpen();
    await flush();
    sock.sent.length = 0;
    micOnFrame!(new Int16Array([1, 2, 3]));
    expect(sock.sent.length).toBe(2);
    const header = JSON.parse(sock.sent[0] as string);
    expect(header).toMatchObject({ type: 'audio.pcm16', sampleRate: 16000, samples: 3 });
  });

  it('does not forward a mic frame while muted', async () => {
    const { startVoiceCall } = await import('../src/lib/voiceCall');
    startVoiceCall('c1');
    await flush();
    const sock = FakeWebSocket.last();
    sock.emitOpen();
    await flush();
    useVoiceStore.getState().setMuted(true);
    sock.sent.length = 0;
    micOnFrame!(new Int16Array([1]));
    expect(sock.sent.length).toBe(0);
  });

  it('a send failure while forwarding a mic frame sets a call error', async () => {
    const { startVoiceCall } = await import('../src/lib/voiceCall');
    startVoiceCall('c1');
    await flush();
    const sock = FakeWebSocket.last();
    sock.emitOpen();
    await flush();
    sock.send.mockImplementationOnce(() => {
      throw new Error('socket gone');
    });
    micOnFrame!(new Int16Array([1]));
    expect(useVoiceStore.getState().callError).toMatch(/mic frame send failed/);
  });

  it('a mid-stream mic read failure (onError) sets a call error + pushes a UI error', async () => {
    const { startVoiceCall } = await import('../src/lib/voiceCall');
    startVoiceCall('c1');
    await flush();
    FakeWebSocket.last().emitOpen();
    await flush();
    micOnError!('AudioRecord died');
    expect(useVoiceStore.getState().callError).toMatch(/mic failed: AudioRecord died/);
    expect(useUiStore.getState().errors.some((e) => e.message.includes('AudioRecord died'))).toBe(
      true,
    );
  });

  it('a mic-capture start failure (native module missing) sets a call error', async () => {
    startMicCaptureMock.mockRejectedValueOnce(new Error('native module missing'));
    const { startVoiceCall } = await import('../src/lib/voiceCall');
    startVoiceCall('c1');
    await flush();
    FakeWebSocket.last().emitOpen();
    await flush();
    expect(useVoiceStore.getState().callError).toMatch(/mic unavailable/);
  });

  it('logs the 50th frame milestone without sending extra frames', async () => {
    const { startVoiceCall } = await import('../src/lib/voiceCall');
    startVoiceCall('c1');
    await flush();
    const sock = FakeWebSocket.last();
    sock.emitOpen();
    await flush();
    sock.sent.length = 0; // drop the session_start frame — count only mic frames
    for (let i = 0; i < 50; i++) micOnFrame!(new Int16Array([1]));
    // 2 sends per frame (header + binary) * 50 frames.
    expect(sock.sent.length).toBe(100);
  });
});

describe('startVoiceCall — mounts synchronously in CONNECTING state', () => {
  it('activeSession is set before any await resolves', async () => {
    const { startVoiceCall } = await import('../src/lib/voiceCall');
    startVoiceCall('c1');
    const s = useVoiceStore.getState().activeSession;
    expect(s).not.toBeNull();
    expect(s?.sessionId).toBe('');
    await flush();
  });
});

describe('startVoiceCall — setup failures (NO FALLBACK, overlay stays up with an error)', () => {
  it('an empty audioUrl surfaces an error', async () => {
    voiceTokenMock.mockResolvedValueOnce({
      token: 't',
      sessionId: 's',
      audioUrl: '',
      expiresAt: 0,
    });
    const { startVoiceCall } = await import('../src/lib/voiceCall');
    startVoiceCall('c1');
    // The catch block awaits stopMicCapture/stopTtsPlayback/stopVoiceAudioService
    // (all mocked async) before setError — more microtask hops than a fixed
    // flush() count reliably covers, so poll instead of guessing a tick count.
    await vi.waitFor(() => expect(useVoiceStore.getState().callError).toMatch(/empty audioUrl/));
    expect(useUiStore.getState().errors.some((e) => e.message.includes('voice call:'))).toBe(true);
  });

  it('a denied mic permission surfaces an error and tears down TTS/mic/audio-service', async () => {
    const { Audio } = await import('expo-av');
    vi.spyOn(Audio, 'requestPermissionsAsync').mockResolvedValueOnce({ granted: false });
    const { startVoiceCall } = await import('../src/lib/voiceCall');
    startVoiceCall('c1');
    await vi.waitFor(() =>
      expect(useVoiceStore.getState().callError).toMatch(/mic permission denied/),
    );
    expect(stopMicCaptureMock).toHaveBeenCalled();
    expect(stopTtsPlaybackMock).toHaveBeenCalled();
    expect(stopVoiceAudioServiceMock).toHaveBeenCalled();
  });

  it('a TTS sink start failure tears the call down with an error', async () => {
    startTtsPlaybackMock.mockRejectedValueOnce(new Error('AudioTrack init failed'));
    const { startVoiceCall } = await import('../src/lib/voiceCall');
    startVoiceCall('c1');
    await vi.waitFor(() =>
      expect(useVoiceStore.getState().callError).toMatch(/AudioTrack init failed/),
    );
  });

  it('a WebSocket constructor failure surfaces a VoiceAudioConnectError message', async () => {
    const RealWS = globalThis.WebSocket;
    class ThrowingWS {
      constructor() {
        throw new Error('ENOTFOUND');
      }
    }
    globalThis.WebSocket = ThrowingWS as unknown as typeof WebSocket;
    try {
      const { startVoiceCall } = await import('../src/lib/voiceCall');
      startVoiceCall('c1');
      await vi.waitFor(() =>
        expect(useVoiceStore.getState().callError).toMatch(/failed to open audio WS/),
      );
    } finally {
      globalThis.WebSocket = RealWS;
    }
  });

  it('a call ended (gen bump) during token mint bails without opening a WS', async () => {
    let resolveToken!: (v: {
      token: string;
      sessionId: string;
      audioUrl: string;
      expiresAt: number;
    }) => void;
    voiceTokenMock.mockReturnValueOnce(
      new Promise((r) => {
        resolveToken = r;
      }),
    );
    const { startVoiceCall, endVoiceCall } = await import('../src/lib/voiceCall');
    startVoiceCall('c1');
    await endVoiceCall(); // bumps _callGen before the token mint resolves
    resolveToken({ token: 't', sessionId: 's', audioUrl: '/audio/s', expiresAt: 0 });
    await flush();
    expect(FakeWebSocket.instances.length).toBe(0);
  });

  it('a call ended during the mic-permission wait bails before touching audio setup', async () => {
    let resolvePerm!: (p: { granted: boolean }) => void;
    const { Audio } = await import('expo-av');
    vi.spyOn(Audio, 'requestPermissionsAsync').mockReturnValueOnce(
      new Promise((r) => {
        resolvePerm = r;
      }),
    );
    const { startVoiceCall, endVoiceCall } = await import('../src/lib/voiceCall');
    startVoiceCall('c1');
    // Wait until we're KNOWN to be blocked on the (still-pending) permission
    // prompt — polling avoids guessing a fixed microtask-tick count, which
    // is fragile given the number of awaits ahead of this point.
    await vi.waitFor(() => expect(Audio.requestPermissionsAsync).toHaveBeenCalled());
    await endVoiceCall(); // bumps _callGen while the permission prompt is still open
    resolvePerm({ granted: true });
    await flush();
    expect(startTtsPlaybackMock).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances.length).toBe(0);
  });

  it('a call ended during the audio-mode setup bails before starting the TTS sink', async () => {
    let resolveMode!: () => void;
    const { Audio } = await import('expo-av');
    vi.spyOn(Audio, 'setAudioModeAsync').mockReturnValueOnce(
      new Promise<void>((r) => {
        resolveMode = r;
      }),
    );
    const { startVoiceCall, endVoiceCall } = await import('../src/lib/voiceCall');
    startVoiceCall('c1');
    await vi.waitFor(() => expect(Audio.setAudioModeAsync).toHaveBeenCalled());
    await endVoiceCall();
    resolveMode();
    await flush();
    expect(startTtsPlaybackMock).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances.length).toBe(0);
  });

  it('a setup failure from an already-superseded call is silently dropped (outer catch gen-check)', async () => {
    // The token mint rejects, but only AFTER this call has already been
    // superseded by endVoiceCall() — the outer catch's own gen-check must
    // stop it from tearing down / erroring over the CURRENT (different) call.
    let rejectToken!: (e: Error) => void;
    voiceTokenMock.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectToken = reject;
      }),
    );
    const { startVoiceCall, endVoiceCall } = await import('../src/lib/voiceCall');
    startVoiceCall('c1');
    await vi.waitFor(() => expect(voiceTokenMock).toHaveBeenCalled());
    await endVoiceCall();
    useUiStore.setState({ errors: [] }); // clear whatever endVoiceCall itself may have logged
    rejectToken(new Error('mint failed, but too late to matter'));
    await flush();
    expect(useUiStore.getState().errors).toHaveLength(0);
  });

  it('a mic frame arriving after the call ended (stale gen) is dropped, not forwarded', async () => {
    const { startVoiceCall, endVoiceCall } = await import('../src/lib/voiceCall');
    startVoiceCall('c1');
    await flush();
    const sock = FakeWebSocket.last();
    sock.emitOpen();
    await flush();
    await endVoiceCall();
    sock.sent.length = 0; // drop endVoiceCall's own session_end send
    // The mic module still holds the OLD onFrame closure (nothing unsubscribed
    // it synchronously) — a frame arriving after teardown must be a no-op.
    expect(() => micOnFrame!(new Int16Array([1]))).not.toThrow();
    expect(sock.sent.length).toBe(0);
  });

  it('a call ended during TTS start tears the just-started TTS sink down', async () => {
    let resolveTts!: () => void;
    startTtsPlaybackMock.mockReturnValueOnce(
      new Promise<void>((r) => {
        resolveTts = r;
      }),
    );
    const { startVoiceCall, endVoiceCall } = await import('../src/lib/voiceCall');
    startVoiceCall('c1');
    await vi.waitFor(() => expect(startTtsPlaybackMock).toHaveBeenCalled());
    await endVoiceCall();
    resolveTts();
    await flush();
    expect(stopTtsPlaybackMock).toHaveBeenCalled();
    expect(FakeWebSocket.instances.length).toBe(0);
  });

  it('a call ended during the audio-service start tears the service down', async () => {
    let resolveSvc!: () => void;
    startVoiceAudioServiceMock.mockReturnValueOnce(
      new Promise<void>((r) => {
        resolveSvc = r;
      }),
    );
    const { startVoiceCall, endVoiceCall } = await import('../src/lib/voiceCall');
    startVoiceCall('c1');
    await vi.waitFor(() => expect(startVoiceAudioServiceMock).toHaveBeenCalled());
    await endVoiceCall();
    resolveSvc();
    await flush();
    expect(stopVoiceAudioServiceMock).toHaveBeenCalled();
    expect(FakeWebSocket.instances.length).toBe(0);
  });

  it('the overlay timer keeps running off the original startedAt if activeSession vanished mid-setup (?? Date.now() fallback)', async () => {
    const { startVoiceCall } = await import('../src/lib/voiceCall');
    startVoiceCall('c1');
    // Between the synchronous mount and the async continuation reaching the
    // "upgrade to live session" step, something else clears activeSession
    // (e.g. a store reset) without bumping _callGen — the upgrade must still
    // produce a usable startedAt rather than crash on `undefined.startedAt`.
    useVoiceStore.setState({ activeSession: null });
    await flush();
    expect(useVoiceStore.getState().activeSession?.startedAt).toEqual(expect.any(Number));
  });
});

describe('audio WS message dispatch', () => {
  async function openCall(): Promise<FakeWebSocket> {
    const { startVoiceCall } = await import('../src/lib/voiceCall');
    startVoiceCall('c1');
    await flush();
    const sock = FakeWebSocket.last();
    sock.emitOpen();
    await flush();
    return sock;
  }

  it('a binary tts_chunk frame is forwarded to the TTS sink', async () => {
    const sock = await openCall();
    const buf = new Uint8Array([1, 2, 3, 4]).buffer;
    sock.emitMessage(buf);
    expect(writeTtsPcmMock).toHaveBeenCalledWith(buf);
  });

  it('an odd-length binary frame is truncated to an even byte length', async () => {
    const sock = await openCall();
    const buf = new Uint8Array([1, 2, 3]).buffer; // 3 bytes — odd
    sock.emitMessage(buf);
    const forwarded = writeTtsPcmMock.mock.calls.at(-1)![0] as ArrayBuffer;
    expect(forwarded.byteLength).toBe(2);
  });

  it('a non-ArrayBuffer, non-string message is ignored', async () => {
    const sock = await openCall();
    expect(() => sock.emitMessage(12345)).not.toThrow();
    expect(writeTtsPcmMock).not.toHaveBeenCalled();
  });

  it('audio.state updates the call phase', async () => {
    const sock = await openCall();
    sock.emitMessage(
      JSON.stringify({ type: 'audio.state', sessionId: 'sess-1', state: 'thinking' }),
    );
    expect(useVoiceStore.getState().callPhase).toBe('thinking');
  });

  it('audio.transcript_partial sets phase=transcribing + the partial text', async () => {
    const sock = await openCall();
    sock.emitMessage(
      JSON.stringify({ type: 'audio.transcript_partial', sessionId: 'sess-1', text: 'hel' }),
    );
    expect(useVoiceStore.getState().callPhase).toBe('transcribing');
    expect(useVoiceStore.getState().callTranscriptPartial).toBe('hel');
  });

  it('audio.transcript_final sets phase=thinking + clears the partial', async () => {
    const sock = await openCall();
    useVoiceStore.getState().setCallTranscriptPartial('hel');
    sock.emitMessage(
      JSON.stringify({ type: 'audio.transcript_final', sessionId: 'sess-1', text: 'hello' }),
    );
    expect(useVoiceStore.getState().callPhase).toBe('thinking');
    expect(useVoiceStore.getState().callTranscriptPartial).toBe('');
  });

  it('audio.tts_end (no bargedIn) sets phase=listening', async () => {
    const sock = await openCall();
    sock.emitMessage(JSON.stringify({ type: 'audio.tts_end', sessionId: 'sess-1' }));
    expect(useVoiceStore.getState().callPhase).toBe('listening');
  });

  it('audio.tts_end (bargedIn=true) also sets phase=listening', async () => {
    const sock = await openCall();
    sock.emitMessage(
      JSON.stringify({ type: 'audio.tts_end', sessionId: 'sess-1', bargedIn: true }),
    );
    expect(useVoiceStore.getState().callPhase).toBe('listening');
  });

  it('audio.barge_in sets phase=listening and flushes the TTS sink', async () => {
    const sock = await openCall();
    sock.emitMessage(JSON.stringify({ type: 'audio.barge_in', sessionId: 'sess-1', at: 0 }));
    expect(useVoiceStore.getState().callPhase).toBe('listening');
    expect(flushTtsPlaybackMock).toHaveBeenCalled();
  });

  it('audio.error sets a call error and pushes a UI error', async () => {
    const sock = await openCall();
    sock.emitMessage(
      JSON.stringify({
        type: 'audio.error',
        code: 'sdk_error',
        message: 'boom',
        sessionId: 'sess-1',
      }),
    );
    expect(useVoiceStore.getState().callError).toBe('sdk_error: boom');
    expect(useUiStore.getState().errors.some((e) => e.message.includes('sdk_error: boom'))).toBe(
      true,
    );
  });

  it('a malformed JSON frame surfaces a UI error, does not throw', async () => {
    const sock = await openCall();
    expect(() => sock.emitMessage('not json{{')).not.toThrow();
    expect(
      useUiStore.getState().errors.some((e) => e.message.includes('malformed audio frame')),
    ).toBe(true);
  });

  it('a session_start echo frame (default branch) is a no-op', async () => {
    const sock = await openCall();
    expect(() =>
      sock.emitMessage(
        JSON.stringify({
          type: 'audio.session_start',
          sessionId: 'sess-1',
          accountId: 'a',
          surfaceId: 's',
          surfaceKind: 'mobile',
          chatId: 'c1',
          role: 'voice-call',
          token: 't',
          surfaceHasAec: true,
        }),
      ),
    ).not.toThrow();
  });

  it('onerror sets an "unknown" audio-WS-error message when the event carries no type', async () => {
    const sock = await openCall();
    sock.emitError({} as unknown as Event);
    expect(useVoiceStore.getState().callError).toBe('audio WS error: unknown');
  });

  it('onerror sets a call error', async () => {
    const sock = await openCall();
    sock.emitError({ type: 'error' });
    expect(useVoiceStore.getState().callError).toMatch(/audio WS error/);
  });

  it('onclose stops the mic + TTS sink', async () => {
    const sock = await openCall();
    stopMicCaptureMock.mockClear();
    stopTtsPlaybackMock.mockClear();
    sock.emitClose();
    await flush();
    expect(stopMicCaptureMock).toHaveBeenCalled();
    expect(stopTtsPlaybackMock).toHaveBeenCalled();
  });

  it('a session_start send failure sets a call error', async () => {
    const { startVoiceCall } = await import('../src/lib/voiceCall');
    startVoiceCall('c1');
    await flush();
    const sock = FakeWebSocket.last();
    sock.send.mockImplementationOnce(() => {
      throw new Error('send failed');
    });
    sock.emitOpen();
    await flush();
    expect(useVoiceStore.getState().callError).toMatch(/audio session_start failed/);
    // Mic capture never starts when session_start itself failed to send.
    expect(startMicCaptureMock).not.toHaveBeenCalled();
  });
});

describe('endVoiceCall', () => {
  it('sends session_end with the sessionId, closes the socket, stops mic/tts/audio-service, clears the store', async () => {
    const { startVoiceCall, endVoiceCall, audioWs } = await import('../src/lib/voiceCall');
    startVoiceCall('c1');
    await flush();
    const sock = FakeWebSocket.last();
    sock.emitOpen();
    await flush();
    sock.sent.length = 0;

    await endVoiceCall();
    const end = JSON.parse(sock.sent[0] as string);
    expect(end).toMatchObject({ type: 'audio.session_end', sessionId: 'sess-1' });
    expect(sock.close).toHaveBeenCalled();
    expect(stopMicCaptureMock).toHaveBeenCalled();
    expect(stopTtsPlaybackMock).toHaveBeenCalled();
    expect(stopVoiceAudioServiceMock).toHaveBeenCalled();
    expect(useVoiceStore.getState().activeSession).toBeNull();
    expect(audioWs()).toBeNull();
  });

  it('a send failure on session_end is swallowed — close() below is the source of truth', async () => {
    const { startVoiceCall, endVoiceCall } = await import('../src/lib/voiceCall');
    startVoiceCall('c1');
    await flush();
    const sock = FakeWebSocket.last();
    sock.emitOpen();
    await flush();
    sock.send.mockImplementationOnce(() => {
      throw new Error('already closing');
    });
    await expect(endVoiceCall()).resolves.toBeUndefined();
    expect(sock.close).toHaveBeenCalled();
  });

  it('with no active session at all, endVoiceCall is a harmless no-op', async () => {
    const { endVoiceCall, audioWs } = await import('../src/lib/voiceCall');
    await expect(endVoiceCall()).resolves.toBeUndefined();
    expect(audioWs()).toBeNull();
  });
});

describe('session modes + the notification as a control surface', () => {
  it('opens in `call` by default and carries the mode into session_start', async () => {
    const { startVoiceCall } = await import('../src/lib/voiceCall');
    startVoiceCall('c1');
    await flush();
    FakeWebSocket.last().emitOpen();
    await flush();
    const start = JSON.parse(FakeWebSocket.last().sent[0] as string);
    expect(start.mode).toBe('call');
    expect(useVoiceStore.getState().callMode).toBe('call');
  });

  it('opens hands-free when asked, and tells the notification which mode it is in', async () => {
    const { startVoiceCall } = await import('../src/lib/voiceCall');
    startVoiceCall('c1', 'hands-free');
    await flush();
    expect(startVoiceAudioServiceMock).toHaveBeenCalledWith('c1', 'hands-free', false);
    FakeWebSocket.last().emitOpen();
    await flush();
    expect(JSON.parse(FakeWebSocket.last().sent[0] as string).mode).toBe('hands-free');
  });

  it('switching mode reaches the open session and re-renders the notification', async () => {
    const { startVoiceCall, setCallMode } = await import('../src/lib/voiceCall');
    startVoiceCall('c1');
    await flush();
    const sock = FakeWebSocket.last();
    sock.emitOpen();
    await flush();
    sock.sent.length = 0;
    setCallMode('hands-free');
    expect(useVoiceStore.getState().callMode).toBe('hands-free');
    expect(JSON.parse(sock.sent[0] as string)).toMatchObject({
      type: 'audio.mode',
      mode: 'hands-free',
    });
    expect(updateVoiceAudioServiceMock).toHaveBeenCalledWith('c1', 'hands-free', false);
    // Flipping to what it already is does nothing at all.
    sock.sent.length = 0;
    setCallMode('hands-free');
    expect(sock.sent.length).toBe(0);
  });

  it('an unaddressed utterance is shown as heard and never treated as a turn', async () => {
    const { startVoiceCall } = await import('../src/lib/voiceCall');
    startVoiceCall('c1', 'hands-free');
    await flush();
    const sock = FakeWebSocket.last();
    sock.emitOpen();
    await flush();
    sock.emitMessage(
      JSON.stringify({
        type: 'audio.transcript_final',
        sessionId: 'sess-1',
        text: 'render the whole wall first',
        addressed: false,
      }),
    );
    expect(useVoiceStore.getState().callUnaddressed).toBe('render the whole wall first');
    // No turn is coming, so it goes straight back to listening rather than
    // sitting on 'thinking' forever.
    expect(useVoiceStore.getState().callPhase).toBe('listening');
  });

  it('the notification buttons drive the same state the overlay does', async () => {
    const { startVoiceCall } = await import('../src/lib/voiceCall');
    startVoiceCall('c1');
    await flush();
    FakeWebSocket.last().emitOpen();
    await flush();
    expect(serviceActionHandler).toBeDefined();

    serviceActionHandler!('mute');
    expect(useVoiceStore.getState().callMuted).toBe(true);
    expect(updateVoiceAudioServiceMock).toHaveBeenCalledWith('c1', 'call', true);

    serviceActionHandler!('mode');
    expect(useVoiceStore.getState().callMode).toBe('hands-free');

    serviceActionHandler!('stop');
    await flush();
    expect(useVoiceStore.getState().activeSession).toBeNull();
  });
});
