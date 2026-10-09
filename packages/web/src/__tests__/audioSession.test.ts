// G5 — surface side of the voice audio plane (lib/audioSession.ts). Verifies
// the real handshake (mint token → open WSS → session_start frame), mic→PCM16
// streaming, TTS playback, and the transcript / barge-in / error dispatch —
// all with injected fakes (no real WSS, getUserMedia, or AudioContext).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  openAudioSession,
  hasVoiceCredential,
  type AudioSessionCallbacks,
} from '../lib/audioSession.js';
import { clearCredential, saveCredential } from '../lib/credential.js';

// --- fakes -----------------------------------------------------------------

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  OPEN = 1;
  readyState = 0;
  binaryType = 'blob';
  sent: Array<string | ArrayBuffer> = [];
  private listeners: Record<string, Array<(e: unknown) => void>> = {};
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: string, cb: (e: unknown) => void): void {
    (this.listeners[type] ??= []).push(cb);
  }
  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.emit('close', {});
  }
  emit(type: string, e: unknown): void {
    for (const cb of this.listeners[type] ?? []) cb(e);
  }
  open(): void {
    this.readyState = this.OPEN;
    this.emit('open', {});
  }
}

interface FakeProcessor {
  onaudioprocess: ((e: unknown) => void) | null;
  connect(): void;
  disconnect(): void;
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  sampleRate = 48_000;
  currentTime = 0;
  state = 'running';
  destination = {};
  lastProcessor: FakeProcessor | null = null;
  lastBufferSourceStart: ((when: number) => void) | null = null;
  bufferSources: Array<{ buffer: unknown; connect(): void; start(when: number): void }> = [];
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
  createBuffer(_ch: number, len: number): { getChannelData(): Float32Array; duration: number } {
    return { getChannelData: () => new Float32Array(len), duration: len / 24000 };
  }
  createBufferSource(): { buffer: unknown; connect(): void; start(when: number): void } {
    const node = {
      buffer: null as unknown,
      connect() {},
      start: (when: number) => {
        this.lastBufferSourceStart = () => {};
        void when;
      },
    };
    this.bufferSources.push(node);
    return node;
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

function fakeStream(): MediaStream {
  return { getTracks: () => [{ stop() {} }] } as unknown as MediaStream;
}

function noopCallbacks(over: Partial<AudioSessionCallbacks> = {}): AudioSessionCallbacks {
  return {
    onTranscriptPartial: () => {},
    onTranscriptFinal: () => {},
    onTtsStart: () => {},
    onTtsEnd: () => {},
    onBargeIn: () => {},
    onLevel: () => {},
    onError: () => {},
    onClose: () => {},
    ...over,
  };
}

const ME = {
  account: { accountId: 'acc-1', userPublicKey: 'pk', createdAt: 0 },
  surface: { surfaceId: 'web-1', surfaceKind: 'web', label: 'web:web-1' },
};
const TOKEN = { token: 'tok-abc', sessionId: 'sess-9', audioUrl: '/audio/sess-9', expiresAt: 999 };

describe('audioSession', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    // localStorage credential so the rest client attaches a bearer AND so the
    // session can read its surfaceId from the credential's own `surface_id`
    // claim (audioSession reads identity from the credential, not me.surface).
    // A real-shaped 3-part EdDSA JWT with a base64url payload carrying the
    // surface claims; the signature is irrelevant client-side (the server
    // verifies on every request).
    const b64url = (o: unknown) =>
      btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const surfaceJwt = `${b64url({ alg: 'EdDSA' })}.${b64url({
      surface_id: 'web-1',
      surface_kind: 'web',
      sub: 'acc-1',
    })}.sig`;
    window.localStorage.setItem('patch.credential.v1', surfaceJwt);
    // Mock fetch for /api/auth/me and /api/voice/token.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/api/auth/me')) {
          return new Response(JSON.stringify(ME), { status: 200 });
        }
        if (url.endsWith('/api/voice/token')) {
          // Assert the body carries role + surfaceKind (the server schema is
          // .strict {chatId, role, surfaceKind}).
          const body = JSON.parse(String(init?.body ?? '{}'));
          expect(body).toEqual({ chatId: 'c1', role: 'voice-note', surfaceKind: 'web' });
          return new Response(JSON.stringify(TOKEN), { status: 200 });
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
  });

  async function open(
    cb: AudioSessionCallbacks,
    extra: Partial<Parameters<typeof openAudioSession>[0]> = {},
  ) {
    const p = openAudioSession({
      chatId: 'c1',
      role: 'voice-note',
      callbacks: cb,
      ...extra,
      deps: {
        WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
        getUserMedia: async () => fakeStream(),
        AudioContextImpl: FakeAudioContext as unknown as typeof AudioContext,
        resolveAudioUrl: (path) => `ws://daemon${path}`,
      },
    });
    // openAudioSession awaits api.me() + api.voiceToken() (real fetches) before
    // constructing the WS. Poll until the fake WS is created, then fire 'open'.
    for (let i = 0; i < 50 && FakeWebSocket.instances.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    return { session: await p, ws };
  }

  it('mints a token then sends a well-formed audio.session_start as the first frame', async () => {
    const { ws } = await open(noopCallbacks());
    expect(ws.url).toBe('ws://daemon/audio/sess-9');
    const first = JSON.parse(ws.sent[0] as string);
    expect(first).toMatchObject({
      type: 'audio.session_start',
      sessionId: 'sess-9',
      accountId: 'acc-1',
      surfaceId: 'web-1',
      surfaceKind: 'web',
      chatId: 'c1',
      role: 'voice-note',
      token: 'tok-abc',
      surfaceHasAec: true,
    });
  });

  it('a normal session opens the default output, for the speech it plays', async () => {
    await open(noopCallbacks());
    const ctx = FakeAudioContext.instances[FakeAudioContext.instances.length - 1]!;
    expect(ctx.options).toBeUndefined();
  });

  // Dictation's live preview only listens: it must not wake the output device
  // (the whoosh), and speech arriving on it is reported, not silently dropped.
  it('a silent session opens no output device and reports speech it cannot play', async () => {
    const onError = vi.fn();
    const { ws } = await open(noopCallbacks({ onError }), { withMic: false, silent: true });
    const ctx = FakeAudioContext.instances[FakeAudioContext.instances.length - 1]!;
    expect(ctx.options).toEqual({ sinkId: { type: 'none' } });
    ws.emit('message', { data: new Int16Array([1, 2, 3]).buffer });
    expect(ctx.bufferSources).toHaveLength(0);
    expect(onError).toHaveBeenCalledWith('speech arrived on a session opened without audio output');
  });

  it('dispatches transcript partial/final frames to the callbacks', async () => {
    const partial = vi.fn();
    const final = vi.fn();
    const { ws } = await open(
      noopCallbacks({ onTranscriptPartial: partial, onTranscriptFinal: final }),
    );
    ws.emit('message', {
      data: JSON.stringify({ type: 'audio.transcript_partial', sessionId: 'sess-9', text: 'hi' }),
    });
    ws.emit('message', {
      data: JSON.stringify({
        type: 'audio.transcript_final',
        sessionId: 'sess-9',
        text: 'hi there',
      }),
    });
    expect(partial).toHaveBeenCalledWith('hi');
    expect(final).toHaveBeenCalledWith('hi there', true);
  });

  it('barge-in frame fires the onBargeIn callback (TTS is cut locally)', async () => {
    const bargeIn = vi.fn();
    const { ws } = await open(noopCallbacks({ onBargeIn: bargeIn }));
    ws.emit('message', {
      data: JSON.stringify({ type: 'audio.barge_in', sessionId: 'sess-9', at: 1 }),
    });
    expect(bargeIn).toHaveBeenCalledOnce();
  });

  it('surfaces a backend audio.error to onError', async () => {
    const onError = vi.fn();
    const { ws } = await open(noopCallbacks({ onError }));
    ws.emit('message', {
      data: JSON.stringify({
        type: 'audio.error',
        code: 'concurrency_cap',
        message: 'too many sessions',
      }),
    });
    expect(onError).toHaveBeenCalledWith('concurrency_cap: too many sessions');
  });

  it('a silent microphone reaches onError as the plain sentence, with no code in front', async () => {
    const onError = vi.fn();
    const { ws } = await open(noopCallbacks({ onError }));
    ws.emit('message', {
      data: JSON.stringify({
        type: 'audio.error',
        code: 'mic_silent',
        message: 'Your microphone is sending silence.',
      }),
    });
    expect(onError).toHaveBeenCalledWith('Your microphone is sending silence.');
  });

  it('end() sends audio.session_end and closes the socket', async () => {
    const { session, ws } = await open(noopCallbacks());
    session.end('committed');
    const end = JSON.parse(ws.sent[ws.sent.length - 1] as string);
    expect(end).toMatchObject({
      type: 'audio.session_end',
      sessionId: 'sess-9',
      reason: 'committed',
    });
    expect(ws.readyState).toBe(3);
  });

  it('end() without a reason omits the reason key', async () => {
    const { session, ws } = await open(noopCallbacks());
    session.end();
    const end = JSON.parse(ws.sent[ws.sent.length - 1] as string);
    expect(end.type).toBe('audio.session_end');
    expect('reason' in end).toBe(false);
  });

  it('end() when the socket is already closed skips the session_end send but still closes/cleans up', async () => {
    const { session, ws } = await open(noopCallbacks());
    ws.readyState = 3; // CLOSED, simulating a socket that dropped already
    const sentBefore = ws.sent.length;
    expect(() => session.end('cancelled')).not.toThrow();
    expect(ws.sent.length).toBe(sentBefore); // no session_end frame sent
  });

  it('end() swallows a throw from ws.send (best-effort)', async () => {
    const { session, ws } = await open(noopCallbacks());
    ws.send = () => {
      throw new Error('socket gone');
    };
    expect(() => session.end('committed')).not.toThrow();
  });

  it('tts_chunk fires onTtsStart; tts_end fires onTtsEnd(bargedIn)', async () => {
    const onTtsStart = vi.fn();
    const onTtsEnd = vi.fn();
    const { ws } = await open(noopCallbacks({ onTtsStart, onTtsEnd }));
    ws.emit('message', {
      data: JSON.stringify({ type: 'audio.tts_chunk', sessionId: 'sess-9', samples: 100 }),
    });
    expect(onTtsStart).toHaveBeenCalledOnce();
    ws.emit('message', {
      data: JSON.stringify({ type: 'audio.tts_end', sessionId: 'sess-9', bargedIn: true }),
    });
    expect(onTtsEnd).toHaveBeenCalledWith(true);
    ws.emit('message', {
      data: JSON.stringify({ type: 'audio.tts_end', sessionId: 'sess-9' }),
    });
    expect(onTtsEnd).toHaveBeenLastCalledWith(false);
  });

  it('a binary message plays back as TTS PCM16 (no callback dispatch)', async () => {
    const onError = vi.fn();
    const { ws } = await open(noopCallbacks({ onError }));
    const samples = new Int16Array([100, -200, 300]);
    // Odd trailing byte to exercise the byteLength-alignment guard.
    const buf = new ArrayBuffer(samples.byteLength + 1);
    new Int16Array(buf, 0, samples.length).set(samples);
    ws.emit('message', { data: buf });
    expect(onError).not.toHaveBeenCalled();
  });

  it('a session frame with an unhandled/dispatch-only type is a no-op (default branch)', async () => {
    const onError = vi.fn();
    const { ws } = await open(noopCallbacks({ onError }));
    ws.emit('message', {
      data: JSON.stringify({
        type: 'audio.session_start',
        sessionId: 'sess-9',
        accountId: 'acc-1',
        surfaceId: 'web-1',
        surfaceKind: 'web',
        chatId: 'c1',
        role: 'voice-note',
        token: 'tok',
        surfaceHasAec: true,
      }),
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it('a malformed JSON message frame surfaces onError instead of throwing', async () => {
    const onError = vi.fn();
    const { ws } = await open(noopCallbacks({ onError }));
    expect(() => ws.emit('message', { data: 'not json{{{' })).not.toThrow();
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('malformed audio frame'));
  });

  it('a schema-invalid (but valid JSON) message frame surfaces onError', async () => {
    const onError = vi.fn();
    const { ws } = await open(noopCallbacks({ onError }));
    ws.emit('message', { data: JSON.stringify({ type: 'not.a.real.type' }) });
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('malformed audio frame'));
  });

  it('streams mic frames as PCM16 and reports an RMS level, resampling to 16kHz', async () => {
    const onLevel = vi.fn();
    const { ws } = await open(noopCallbacks({ onLevel }));
    const ctx = FakeAudioContext.instances[FakeAudioContext.instances.length - 1]!;
    const processor = ctx.lastProcessor!;
    expect(processor.onaudioprocess).toBeTypeOf('function');
    const sentBefore = ws.sent.length;
    const channelData = new Float32Array(512).map((_, i) => Math.sin(i / 10) * 0.5);
    processor.onaudioprocess!({
      inputBuffer: { getChannelData: () => channelData },
    });
    expect(onLevel).toHaveBeenCalled();
    const level = onLevel.mock.calls[0]![0] as number;
    expect(level).toBeGreaterThanOrEqual(0);
    expect(level).toBeLessThanOrEqual(1);
    expect(ws.sent.length).toBe(sentBefore + 1);
    expect(ws.sent[ws.sent.length - 1]).toBeInstanceOf(ArrayBuffer);
  });

  it('mutes: setMuted(true) suppresses mic frame sends; isMuted() reflects it', async () => {
    const { session, ws } = await open(noopCallbacks());
    const ctx = FakeAudioContext.instances[FakeAudioContext.instances.length - 1]!;
    const processor = ctx.lastProcessor!;
    expect(session.isMuted()).toBe(false);
    session.setMuted(true);
    expect(session.isMuted()).toBe(true);
    const sentBefore = ws.sent.length;
    processor.onaudioprocess!({
      inputBuffer: { getChannelData: () => new Float32Array(512) },
    });
    expect(ws.sent.length).toBe(sentBefore); // suppressed while muted
    session.setMuted(false);
    processor.onaudioprocess!({
      inputBuffer: { getChannelData: () => new Float32Array(512) },
    });
    expect(ws.sent.length).toBe(sentBefore + 1);
  });

  it('onaudioprocess is a no-op once the socket has closed', async () => {
    const { ws } = await open(noopCallbacks());
    const ctx = FakeAudioContext.instances[FakeAudioContext.instances.length - 1]!;
    const processor = ctx.lastProcessor!;
    ws.close();
    const sentBefore = ws.sent.length;
    expect(() =>
      processor.onaudioprocess!({ inputBuffer: { getChannelData: () => new Float32Array(512) } }),
    ).not.toThrow();
    expect(ws.sent.length).toBe(sentBefore);
  });

  it('onaudioprocess is a no-op while the socket is not OPEN (mid-handshake readyState)', async () => {
    const { ws } = await open(noopCallbacks());
    const ctx = FakeAudioContext.instances[FakeAudioContext.instances.length - 1]!;
    const processor = ctx.lastProcessor!;
    ws.readyState = 0; // CONNECTING
    const sentBefore = ws.sent.length;
    processor.onaudioprocess!({ inputBuffer: { getChannelData: () => new Float32Array(512) } });
    expect(ws.sent.length).toBe(sentBefore);
  });

  it('fires onClose when the WSS closes', async () => {
    const onClose = vi.fn();
    const { ws } = await open(noopCallbacks({ onClose }));
    ws.close();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('resumes a suspended AudioContext before capture (gesture-loss workaround)', async () => {
    const p = openAudioSession({
      chatId: 'c1',
      role: 'voice-note',
      callbacks: noopCallbacks(),
      deps: {
        WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
        getUserMedia: async () => fakeStream(),
        AudioContextImpl: class extends FakeAudioContext {
          override state = 'suspended';
        } as unknown as typeof AudioContext,
        resolveAudioUrl: (path) => `ws://daemon${path}`,
      },
    });
    for (let i = 0; i < 50 && FakeWebSocket.instances.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    await p;
    const ctx = FakeAudioContext.instances[FakeAudioContext.instances.length - 1]!;
    expect(ctx.state).toBe('running');
  });

  it('rejects when the WSS errors before the handshake settles', async () => {
    const p = openAudioSession({
      chatId: 'c1',
      role: 'voice-note',
      callbacks: noopCallbacks(),
      deps: {
        WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
        getUserMedia: async () => fakeStream(),
        AudioContextImpl: FakeAudioContext as unknown as typeof AudioContext,
        resolveAudioUrl: (path) => `ws://daemon${path}`,
      },
    });
    for (let i = 0; i < 50 && FakeWebSocket.instances.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    const ws = FakeWebSocket.instances[0]!;
    ws.emit('error', new Event('error'));
    await expect(p).rejects.toThrow('audio WSS failed to open');
  });

  it('throws when no AudioContext implementation is available at all', async () => {
    const originalAudioContext = (window as unknown as { AudioContext?: unknown }).AudioContext;
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
    await expect(
      openAudioSession({
        chatId: 'c1',
        role: 'voice-note',
        callbacks: noopCallbacks(),
        deps: {
          WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
          getUserMedia: async () => fakeStream(),
          resolveAudioUrl: (path) => `ws://daemon${path}`,
        },
      }),
    ).rejects.toThrow('Web Audio API unavailable');
    (window as unknown as { AudioContext?: unknown }).AudioContext = originalAudioContext;
  });

  it('uses all default deps (WebSocket/getUserMedia/AudioContext/resolveAudioUrl) when none are injected', async () => {
    const originalWebSocket = window.WebSocket;
    const originalAudioContext = (window as unknown as { AudioContext?: unknown }).AudioContext;
    const originalMediaDevices = navigator.mediaDevices;
    (window as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
    (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: async () => fakeStream() },
      configurable: true,
    });

    const p = openAudioSession({ chatId: 'c1', role: 'voice-note', callbacks: noopCallbacks() });
    for (let i = 0; i < 50 && FakeWebSocket.instances.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
    // defaultResolveAudioUrl mounts on the current origin's ws(s) scheme.
    expect(ws.url).toBe(
      `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/audio/sess-9`,
    );
    ws.open();
    await p;

    (window as unknown as { WebSocket: unknown }).WebSocket = originalWebSocket;
    (window as unknown as { AudioContext?: unknown }).AudioContext = originalAudioContext;
    Object.defineProperty(navigator, 'mediaDevices', {
      value: originalMediaDevices,
      configurable: true,
    });
  });

  it('defaultResolveAudioUrl uses wss:// when the page is served over https', async () => {
    const originalWebSocket = window.WebSocket;
    const originalAudioContext = (window as unknown as { AudioContext?: unknown }).AudioContext;
    const originalMediaDevices = navigator.mediaDevices;
    const originalLocation = window.location;
    (window as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
    (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: async () => fakeStream() },
      configurable: true,
    });
    Object.defineProperty(window, 'location', {
      value: { ...originalLocation, protocol: 'https:', host: originalLocation.host },
      configurable: true,
      writable: true,
    });

    const p = openAudioSession({ chatId: 'c1', role: 'voice-note', callbacks: noopCallbacks() });
    for (let i = 0; i < 50 && FakeWebSocket.instances.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
    expect(ws.url).toBe(`wss://${originalLocation.host}/audio/sess-9`);
    ws.open();
    await p;

    (window as unknown as { WebSocket: unknown }).WebSocket = originalWebSocket;
    (window as unknown as { AudioContext?: unknown }).AudioContext = originalAudioContext;
    Object.defineProperty(navigator, 'mediaDevices', {
      value: originalMediaDevices,
      configurable: true,
    });
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      configurable: true,
      writable: true,
    });
  });

  it('cleanup swallows a throw from processor/source/sink disconnect (best-effort teardown)', async () => {
    const onClose = vi.fn();
    const { session, ws } = await open(noopCallbacks({ onClose }));
    const ctx = FakeAudioContext.instances[FakeAudioContext.instances.length - 1]!;
    ctx.lastProcessor!.disconnect = () => {
      throw new Error('already disconnected');
    };
    expect(() => session.end('committed')).not.toThrow();
    expect(ws.readyState).toBe(3);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('a non-string, non-ArrayBuffer message payload (e.g. a Blob) is ignored, not played', async () => {
    const { ws } = await open(noopCallbacks());
    const blobLike = { size: 4 } as unknown; // not an ArrayBuffer instance
    expect(() => ws.emit('message', { data: blobLike })).not.toThrow();
  });

  it('throws when there is no surface credential (no bearer to identify the surface)', async () => {
    clearCredential();
    await expect(
      openAudioSession({
        chatId: 'c1',
        role: 'voice-note',
        callbacks: noopCallbacks(),
        deps: {
          WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
          getUserMedia: async () => fakeStream(),
          AudioContextImpl: FakeAudioContext as unknown as typeof AudioContext,
          resolveAudioUrl: (path) => `ws://daemon${path}`,
        },
      }),
    ).rejects.toThrow('no surface credential');
  });
});

describe('hasVoiceCredential', () => {
  afterEach(() => clearCredential());

  it('is false with no stored credential', () => {
    clearCredential();
    expect(hasVoiceCredential()).toBe(false);
  });

  it('is true once a well-formed credential is stored', () => {
    const b64url = (o: unknown) =>
      btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    saveCredential(`${b64url({ alg: 'EdDSA' })}.${b64url({ surface_id: 'web-1' })}.sig`);
    expect(hasVoiceCredential()).toBe(true);
  });
});
