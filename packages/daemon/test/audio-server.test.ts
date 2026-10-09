// Audio WSS endpoint tests (group 13). Drives:
//   - Auth: bad token → audio.error{auth_failed}
//   - Replay: same token used twice → audio.error{token_replayed}
//   - Concurrency: cap+1 sessions → audio.error{concurrency_cap}
//   - Smoke: a session that sends speech frames receives a transcript +
//            a TTS chunk back.

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import pino from 'pino';
import { createHmac } from 'node:crypto';
import { connect as netConnect } from 'node:net';
import { WebSocket } from 'ws';
import { startAudioServer, type AudioServerHandle } from '../src/audio/server.js';
import { createWhisper } from '../src/audio/whisper.js';
import { createKokoro } from '../src/audio/kokoro.js';
import type { KokoroBackend, KokoroSynthesis } from '../src/audio/kokoro.js';
import { encodeAudio, decodeAudio, type AudioEvent } from '@patch/wire/audio';
import { MockVad, type Vad, type VadFrameResult } from '../src/audio/vad.js';
import { DEVICE_CONTROL_PATH } from '../src/devices/control-ws.js';

const SECRET = 'unit-test-internal-token-aaaaaaaaaa';
const logger = pino({ level: 'silent' });

function mintToken(claims: {
  accountId: string;
  surfaceId: string;
  sessionId: string;
  chatId?: string;
  exp?: number;
  jti?: string;
}): string {
  const obj = {
    accountId: claims.accountId,
    surfaceId: claims.surfaceId,
    sessionId: claims.sessionId,
    chatId: claims.chatId ?? 'c',
    exp: claims.exp ?? Date.now() + 60_000,
    jti: claims.jti ?? `jti-${Math.random().toString(36).slice(2)}`,
  };
  const claimsB64 = Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
  const sig = createHmac('sha256', SECRET).update(claimsB64).digest().toString('base64url');
  return `${claimsB64}.${sig}`;
}

async function recvOne(ws: WebSocket): Promise<AudioEvent> {
  return new Promise<AudioEvent>((resolve, reject) => {
    ws.once('message', (data: Buffer | string, isBinary: boolean) => {
      if (isBinary) {
        reject(new Error('expected json frame, got binary'));
        return;
      }
      try {
        resolve(decodeAudio(data as string | Buffer));
      } catch (e) {
        reject(e as Error);
      }
    });
    ws.once('error', reject);
  });
}

async function startServer(opts?: {
  cap?: number;
  reply?: string;
  onDeviceSession?: (deviceId: string, active: boolean) => void;
  chatExists?: (chatId: string) => boolean;
}): Promise<AudioServerHandle & { port: number }> {
  const handle = await startAudioServer({
    host: '127.0.0.1',
    port: 0,
    logger,
    internalToken: SECRET,
    whisper: createWhisper({ backend: 'mock', logger }),
    kokoro: createKokoro({ backend: 'mock', logger }),
    makeVad: () => new MockVad(),
    submitUserTurn: async () => opts?.reply ?? 'mock reply',
    // Default: every chat exists. Tests for E1-d3 override this.
    chatExists: opts?.chatExists ?? ((): boolean => true),
    ...(opts?.cap !== undefined ? { maxConcurrentSessions: opts.cap } : {}),
    ...(opts?.onDeviceSession !== undefined ? { onDeviceSession: opts.onDeviceSession } : {}),
  });
  const addr = handle.address();
  return Object.assign(handle, { port: addr.port });
}

async function openSocket(port: number, sessionId: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/audio/${sessionId}`);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return ws;
}

describe('audio WSS server', () => {
  let server: Awaited<ReturnType<typeof startServer>>;

  beforeEach(async () => {
    server = await startServer();
  });
  afterEach(async () => {
    await server.close();
  });

  test('rejects when token signature is bad', async () => {
    const ws = await openSocket(server.port, 'sess-bad');
    ws.send(
      encodeAudio({
        type: 'audio.session_start',
        sessionId: 'sess-bad',
        accountId: 'acct',
        surfaceId: 'surf',
        surfaceKind: 'web',
        chatId: 'c1',
        role: 'voice-call',
        token: 'aaaa.zzzz',
        surfaceHasAec: true,
      }),
    );
    const msg = await recvOne(ws);
    expect(msg.type).toBe('audio.error');
    if (msg.type === 'audio.error') expect(msg.code).toBe('auth_failed');
    ws.close();
  });

  test('rejects expired tokens', async () => {
    const ws = await openSocket(server.port, 'sess-exp');
    const token = mintToken({
      accountId: 'a',
      surfaceId: 's',
      sessionId: 'sess-exp',
      exp: Date.now() - 1000,
    });
    ws.send(
      encodeAudio({
        type: 'audio.session_start',
        sessionId: 'sess-exp',
        accountId: 'a',
        surfaceId: 's',
        surfaceKind: 'web',
        chatId: 'c',
        role: 'voice-call',
        token,
        surfaceHasAec: true,
      }),
    );
    const msg = await recvOne(ws);
    expect(msg.type).toBe('audio.error');
    if (msg.type === 'audio.error') expect(msg.code).toBe('token_expired');
    ws.close();
  });

  test('rejects token replay (same jti twice)', async () => {
    const jti = 'fixed-jti-aaaa';
    // First session: accept and wait briefly for it to register.
    const ws1 = await openSocket(server.port, 'sess-r1');
    const token1 = mintToken({
      accountId: 'a',
      surfaceId: 's1',
      sessionId: 'sess-r1',
      jti,
    });
    ws1.send(
      encodeAudio({
        type: 'audio.session_start',
        sessionId: 'sess-r1',
        accountId: 'a',
        surfaceId: 's1',
        surfaceKind: 'web',
        chatId: 'c',
        role: 'voice-call',
        token: token1,
        surfaceHasAec: true,
      }),
    );
    // Allow the server to consume the JTI.
    await new Promise((r) => setTimeout(r, 50));
    expect(server.activeCount()).toBe(1);
    // Second session reusing the same JTI under a different sessionId.
    const ws2 = await openSocket(server.port, 'sess-r2');
    const token2 = mintToken({
      accountId: 'a',
      surfaceId: 's2',
      sessionId: 'sess-r2',
      jti,
    });
    ws2.send(
      encodeAudio({
        type: 'audio.session_start',
        sessionId: 'sess-r2',
        accountId: 'a',
        surfaceId: 's2',
        surfaceKind: 'web',
        chatId: 'c',
        role: 'voice-call',
        token: token2,
        surfaceHasAec: true,
      }),
    );
    const msg = await recvOne(ws2);
    expect(msg.type).toBe('audio.error');
    if (msg.type === 'audio.error') expect(msg.code).toBe('token_replayed');
    ws1.close();
    ws2.close();
  });

  test('enforces concurrency cap and rejects the overflow session', async () => {
    await server.close();
    server = await startServer({ cap: 2 });
    const sockets: WebSocket[] = [];
    for (let i = 0; i < 2; i++) {
      const sid = `sess-cap-${i}`;
      const ws = await openSocket(server.port, sid);
      const token = mintToken({ accountId: 'a', surfaceId: `s${i}`, sessionId: sid });
      ws.send(
        encodeAudio({
          type: 'audio.session_start',
          sessionId: sid,
          accountId: 'a',
          surfaceId: `s${i}`,
          surfaceKind: 'web',
          chatId: 'c',
          role: 'voice-call',
          token,
          surfaceHasAec: true,
        }),
      );
      sockets.push(ws);
    }
    // Wait for both to register.
    await new Promise((r) => setTimeout(r, 80));
    expect(server.activeCount()).toBe(2);
    // Third session should be rejected.
    const sid3 = 'sess-cap-3';
    const ws3 = await openSocket(server.port, sid3);
    const token3 = mintToken({ accountId: 'a', surfaceId: 's3', sessionId: sid3 });
    ws3.send(
      encodeAudio({
        type: 'audio.session_start',
        sessionId: sid3,
        accountId: 'a',
        surfaceId: 's3',
        surfaceKind: 'web',
        chatId: 'c',
        role: 'voice-call',
        token: token3,
        surfaceHasAec: true,
      }),
    );
    const msg = await recvOne(ws3);
    expect(msg.type).toBe('audio.error');
    if (msg.type === 'audio.error') expect(msg.code).toBe('concurrency_cap');
    ws3.close();
    for (const s of sockets) s.close();
  });

  test('zero-copy PCM16 view preserves little-endian byte order', async () => {
    await server.close();
    // Custom VAD that records the first sample of every fed frame.
    const observed: number[] = [];
    class CapturingVad implements Vad {
      private state: 'silence' | 'speech' = 'silence';
      async feed(frame: Int16Array): Promise<VadFrameResult> {
        if (frame.length > 0) {
          const v = frame[0];
          if (v !== undefined) observed.push(v);
        }
        return { prob: 0, event: null, state: this.state };
      }
      reset(): void {
        this.state = 'silence';
      }
      async close(): Promise<void> {}
    }
    const handle = await startAudioServer({
      host: '127.0.0.1',
      port: 0,
      logger,
      internalToken: SECRET,
      whisper: createWhisper({ backend: 'mock', logger }),
      kokoro: createKokoro({ backend: 'mock', logger }),
      makeVad: () => new CapturingVad(),
      submitUserTurn: async () => 'ok',
      chatExists: (): boolean => true,
    });
    server = Object.assign(handle, { port: handle.address().port });
    const sid = 'sess-le';
    const ws = await openSocket(server.port, sid);
    const token = mintToken({ accountId: 'a', surfaceId: 's-le', sessionId: sid });
    ws.send(
      encodeAudio({
        type: 'audio.session_start',
        sessionId: sid,
        accountId: 'a',
        surfaceId: 's-le',
        surfaceKind: 'web',
        chatId: 'c',
        role: 'voice-call',
        token,
        surfaceHasAec: true,
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    // Now send a binary PCM16 frame whose first 16-bit LE sample is 0x1234.
    // Bytes on the wire: 0x34, 0x12 → Int16Array[0] should be 0x1234.
    const buf = Buffer.alloc(4);
    buf[0] = 0x34;
    buf[1] = 0x12;
    buf[2] = 0xff;
    buf[3] = 0x7f; // = 0x7fff (max positive int16)
    ws.send(buf, { binary: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(observed.length).toBeGreaterThan(0);
    expect(observed[0]).toBe(0x1234);
    ws.close();
  });

  test('first frame must be session_start', async () => {
    const ws = await openSocket(server.port, 'sess-x');
    ws.send(
      encodeAudio({
        type: 'audio.session_end',
        sessionId: 'sess-x',
      }),
    );
    const msg = await recvOne(ws);
    expect(msg.type).toBe('audio.error');
    if (msg.type === 'audio.error') expect(msg.code).toBe('invalid_frame');
    ws.close();
  });

  test('rejects a device session with no deviceId (spec/16 coupling)', async () => {
    const sid = 'sess-dev-missing';
    const ws = await openSocket(server.port, sid);
    const token = mintToken({
      accountId: 'a',
      surfaceId: 's-dev',
      sessionId: sid,
      chatId: 'thread_speakers',
    });
    ws.send(
      encodeAudio({
        type: 'audio.session_start',
        sessionId: sid,
        accountId: 'a',
        surfaceId: 's-dev',
        surfaceKind: 'device',
        chatId: 'thread_speakers',
        role: 'voice-device-conv',
        token,
        surfaceHasAec: false,
      }),
    );
    const msg = await recvOne(ws);
    expect(msg.type).toBe('audio.error');
    if (msg.type === 'audio.error') expect(msg.code).toBe('invalid_frame');
    ws.close();
  });

  test('accepts a device session that carries its deviceId', async () => {
    const sid = 'sess-dev-ok';
    const ws = await openSocket(server.port, sid);
    const token = mintToken({
      accountId: 'a',
      surfaceId: 's-dev2',
      sessionId: sid,
      chatId: 'thread_speakers',
    });
    ws.send(
      encodeAudio({
        type: 'audio.session_start',
        sessionId: sid,
        accountId: 'a',
        surfaceId: 's-dev2',
        surfaceKind: 'device',
        chatId: 'thread_speakers',
        role: 'voice-device-conv',
        token,
        surfaceHasAec: false,
        deviceId: 'kitchen',
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(server.activeCount()).toBe(1);
    ws.close();
  });

  test('F1-audible: speakCanned diag seam streams Kokoro TTS straight to the device session (no SDK)', async () => {
    const sid = 'sess-dev-speak';
    const deviceSurfaceId = 'voice-pe-canned';
    const ws = await openSocket(server.port, sid);
    const token = mintToken({
      accountId: 'a',
      surfaceId: deviceSurfaceId,
      sessionId: sid,
      chatId: 'thread_speakers',
    });
    ws.send(
      encodeAudio({
        type: 'audio.session_start',
        sessionId: sid,
        accountId: 'a',
        surfaceId: deviceSurfaceId,
        surfaceKind: 'device',
        chatId: 'thread_speakers',
        role: 'voice-device-conv',
        token,
        surfaceHasAec: false,
        deviceId: 'voice-pe-canned',
      }),
    );
    await new Promise((r) => setTimeout(r, 50));

    // Collect frames after the canned-speak request.
    const ttsChunks: AudioEvent[] = [];
    let binaryFrames = 0;
    ws.on('message', (data: Buffer | string, isBinary: boolean) => {
      if (isBinary) {
        binaryFrames += 1;
        return;
      }
      const ev = decodeAudio(data as string | Buffer);
      if (ev.type === 'audio.tts_chunk') ttsChunks.push(ev);
    });

    // Fire the diag seam over HTTP (the path the F1 verification uses).
    const res = await fetch(`http://127.0.0.1:${server.port}/internal/diag/voice-device/speak`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-patch-internal-token': SECRET },
      body: JSON.stringify({ surfaceId: deviceSurfaceId, text: 'patch online and ready' }),
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });

    // The device path buffers the WHOLE utterance, then resamples 24→48 kHz
    // ONCE and sends it — so nothing arrives until the (paced) mock stream
    // finishes (4 chunks × 80 ms). Poll up to 2 s instead of a fixed 200 ms
    // sleep that races the pacing and saw zero frames.
    const deadline = Date.now() + 2000;
    while (binaryFrames === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(ttsChunks.length).toBeGreaterThan(0);
    expect(binaryFrames).toBeGreaterThan(0);
    // The session entered the speaking state via the Kokoro path.
    expect(server.getSessionState(sid)).toBeDefined();
    ws.close();
  });

  test('F1-audible: speakCanned diag seam rejects a bad internal token (401) and unknown surface (404)', async () => {
    const bad = await fetch(`http://127.0.0.1:${server.port}/internal/diag/voice-device/speak`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-patch-internal-token': 'wrong' },
      body: JSON.stringify({ surfaceId: 'whoever', text: 'hi' }),
    });
    expect(bad.status).toBe(401);

    const missing = await fetch(
      `http://127.0.0.1:${server.port}/internal/diag/voice-device/speak`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-patch-internal-token': SECRET },
        body: JSON.stringify({ surfaceId: 'no-such-surface', text: 'hi' }),
      },
    );
    expect(missing.status).toBe(404);
  });

  test('speakCanned failure (Kokoro stream throws mid-utterance) is caught and logged, not thrown', async () => {
    await server.close();
    const throwingKokoro: KokoroBackend = {
      isReady: () => true,
      async close() {},
      async synthesize(): Promise<KokoroSynthesis> {
        async function* gen(): AsyncGenerator<{ pcm: Int16Array; first: boolean }> {
          yield { pcm: new Int16Array(240), first: true };
          throw new Error('kokoro stream broke mid-utterance');
        }
        return { iterator: gen(), async cancel() {} };
      },
    };
    const handle = await startAudioServer({
      host: '127.0.0.1',
      port: 0,
      logger,
      internalToken: SECRET,
      whisper: createWhisper({ backend: 'mock', logger }),
      kokoro: throwingKokoro,
      makeVad: () => new MockVad(),
      submitUserTurn: async () => 'ok',
      chatExists: (): boolean => true,
    });
    server = Object.assign(handle, { port: handle.address().port });
    const sid = 'sess-speak-fail';
    const surfaceId = 's-speak-fail';
    const ws = await openSocket(server.port, sid);
    const token = mintToken({
      accountId: 'a',
      surfaceId,
      sessionId: sid,
      chatId: 'chat-speak-fail',
    });
    ws.send(
      encodeAudio({
        type: 'audio.session_start',
        sessionId: sid,
        accountId: 'a',
        surfaceId,
        surfaceKind: 'web',
        chatId: 'chat-speak-fail',
        role: 'voice-call',
        token,
        surfaceHasAec: true,
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(server.speakCanned(surfaceId, 'this will fail mid-stream')).toBe(true);
    // Give the background speak() promise time to reject and be caught.
    await new Promise((r) => setTimeout(r, 100));
    // No crash — the server (and this session) is still healthy.
    expect(server.activeCount()).toBe(1);
    ws.close();
  });

  test('fires onSessionClosed({wasPhoneCall}) correctly for a phone voice-call vs a device session', async () => {
    const closedEvents: { wasPhoneCall: boolean }[] = [];
    // `startServer()` doesn't thread `onSessionClosed` through — build a
    // dedicated handle directly.
    const handle = await startAudioServer({
      host: '127.0.0.1',
      port: 0,
      logger,
      internalToken: SECRET,
      whisper: createWhisper({ backend: 'mock', logger }),
      kokoro: createKokoro({ backend: 'mock', logger }),
      makeVad: () => new MockVad(),
      submitUserTurn: async () => 'ok',
      chatExists: (): boolean => true,
      onSessionClosed: (info) => closedEvents.push(info),
    });
    const s3 = Object.assign(handle, { port: handle.address().port });
    try {
      // A phone-side voice-call (web/desktop/mobile) closing -> wasPhoneCall: true.
      const callSid = 'sess-closed-call';
      const wsCall = await openSocket(s3.port, callSid);
      const callToken = mintToken({
        accountId: 'a',
        surfaceId: 's-closed-call',
        sessionId: callSid,
      });
      wsCall.send(
        encodeAudio({
          type: 'audio.session_start',
          sessionId: callSid,
          accountId: 'a',
          surfaceId: 's-closed-call',
          surfaceKind: 'mobile',
          chatId: 'c',
          role: 'voice-call',
          token: callToken,
          surfaceHasAec: true,
        }),
      );
      await new Promise((r) => setTimeout(r, 50));
      wsCall.close();
      await new Promise((r) => setTimeout(r, 50));

      // A device session closing -> wasPhoneCall: false.
      const devSid = 'sess-closed-device';
      const wsDev = await openSocket(s3.port, devSid);
      const devToken = mintToken({
        accountId: 'a',
        surfaceId: 's-closed-device',
        sessionId: devSid,
        chatId: 'thread_speakers',
      });
      wsDev.send(
        encodeAudio({
          type: 'audio.session_start',
          sessionId: devSid,
          accountId: 'a',
          surfaceId: 's-closed-device',
          surfaceKind: 'device',
          chatId: 'thread_speakers',
          role: 'voice-device-conv',
          token: devToken,
          surfaceHasAec: false,
          deviceId: 'kitchen',
        }),
      );
      await new Promise((r) => setTimeout(r, 50));
      wsDev.close();
      await new Promise((r) => setTimeout(r, 50));

      expect(closedEvents).toEqual([{ wasPhoneCall: true }, { wasPhoneCall: false }]);
    } finally {
      await s3.close();
    }
  });

  test('fires onDeviceSession(active=true) on device session start and (false) on close', async () => {
    const events: { deviceId: string; active: boolean }[] = [];
    const s2 = await startServer({
      onDeviceSession: (deviceId, active) => events.push({ deviceId, active }),
    });
    try {
      const sid = 'sess-dev-pill';
      const ws = await openSocket(s2.port, sid);
      const token = mintToken({
        accountId: 'a',
        surfaceId: 's-pill',
        sessionId: sid,
        chatId: 'thread_speakers',
      });
      ws.send(
        encodeAudio({
          type: 'audio.session_start',
          sessionId: sid,
          accountId: 'a',
          surfaceId: 's-pill',
          surfaceKind: 'device',
          chatId: 'thread_speakers',
          role: 'voice-device-conv',
          token,
          surfaceHasAec: false,
          deviceId: 'kitchen',
        }),
      );
      await new Promise((r) => setTimeout(r, 50));
      expect(events).toEqual([{ deviceId: 'kitchen', active: true }]);
      ws.close();
      await new Promise((r) => setTimeout(r, 50));
      expect(events).toEqual([
        { deviceId: 'kitchen', active: true },
        { deviceId: 'kitchen', active: false },
      ]);
    } finally {
      await s2.close();
    }
  });

  test('setFocusForSurface re-targets the surface session — next utterance lands in the new chat', async () => {
    // Capture which chatId each submitted user-turn lands in.
    const submittedChatIds: string[] = [];
    // VAD that fires utterance_start on the first frame and utterance_end on
    // the second, so a two-frame send completes one full turn deterministically.
    class ScriptedVad implements Vad {
      private n = 0;
      private state: 'silence' | 'speech' = 'silence';
      async feed(): Promise<VadFrameResult> {
        this.n++;
        if (this.n === 1) {
          this.state = 'speech';
          return { prob: 1, event: 'utterance_start', state: this.state };
        }
        this.state = 'silence';
        return { prob: 0, event: 'utterance_end', state: this.state };
      }
      reset(): void {
        this.n = 0;
        this.state = 'silence';
      }
      async close(): Promise<void> {}
    }
    const handle = await startAudioServer({
      host: '127.0.0.1',
      port: 0,
      logger,
      internalToken: SECRET,
      whisper: createWhisper({ backend: 'mock', logger }),
      kokoro: createKokoro({ backend: 'mock', logger }),
      makeVad: () => new ScriptedVad(),
      submitUserTurn: async ({ chatId }) => {
        submittedChatIds.push(chatId);
        return 'ok';
      },
      chatExists: (): boolean => true,
    });
    server = Object.assign(handle, { port: handle.address().port });
    const sid = 'sess-focus';
    const surfaceId = 's-focus';
    const ws = await openSocket(server.port, sid);
    const token = mintToken({ accountId: 'a', surfaceId, sessionId: sid, chatId: 'chat-a' });
    ws.send(
      encodeAudio({
        type: 'audio.session_start',
        sessionId: sid,
        accountId: 'a',
        surfaceId,
        surfaceKind: 'web',
        chatId: 'chat-a',
        role: 'voice-call',
        token,
        surfaceHasAec: true,
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    // Focus-follow: the control plane delivered chat.focus_change → host
    // routes it here for the matching surface. The audio WSS stays open.
    server.setFocusForSurface(surfaceId, 'chat-b');
    // Speak: two binary frames drive ScriptedVad start→end → one full turn.
    const frame = Buffer.alloc(960); // 480 int16 samples
    ws.send(frame, { binary: true });
    ws.send(frame, { binary: true });
    await new Promise((r) => setTimeout(r, 80));
    expect(submittedChatIds).toEqual(['chat-b']);
    ws.close();
  });

  test('does NOT fire onDeviceSession for an app (web) session', async () => {
    const events: { deviceId: string; active: boolean }[] = [];
    const s2 = await startServer({
      onDeviceSession: (deviceId, active) => events.push({ deviceId, active }),
    });
    try {
      const sid = 'sess-web-nopill';
      const ws = await openSocket(s2.port, sid);
      const token = mintToken({ accountId: 'a', surfaceId: 's-web', sessionId: sid, chatId: 'c1' });
      ws.send(
        encodeAudio({
          type: 'audio.session_start',
          sessionId: sid,
          accountId: 'a',
          surfaceId: 's-web',
          surfaceKind: 'web',
          chatId: 'c1',
          role: 'voice-call',
          token,
          surfaceHasAec: true,
        }),
      );
      await new Promise((r) => setTimeout(r, 50));
      ws.close();
      await new Promise((r) => setTimeout(r, 50));
      expect(events).toEqual([]);
    } finally {
      await s2.close();
    }
  });

  // E1-d2: the token is bound to its chatId. A session_start declaring a
  // DIFFERENT chatId than the token was minted for is rejected — a captured
  // token cannot be repointed at another chat.
  test('rejects a session_start whose chatId differs from the token claim (E1-d2)', async () => {
    const sid = 'sess-chat-mismatch';
    const ws = await openSocket(server.port, sid);
    // Token minted for chat-A …
    const token = mintToken({
      accountId: 'a',
      surfaceId: 's-mm',
      sessionId: sid,
      chatId: 'chat-A',
    });
    ws.send(
      encodeAudio({
        type: 'audio.session_start',
        sessionId: sid,
        accountId: 'a',
        surfaceId: 's-mm',
        surfaceKind: 'web',
        // … but session_start declares chat-B.
        chatId: 'chat-B',
        role: 'voice-call',
        token,
        surfaceHasAec: true,
      }),
    );
    const msg = await recvOne(ws);
    expect(msg.type).toBe('audio.error');
    if (msg.type === 'audio.error') expect(msg.code).toBe('auth_failed');
    ws.close();
  });

  // E1-d3: a session bound to a non-existent chat is rejected at
  // session_start time (before any STT runs), with a specific
  // session_not_found — not a late generic sdk_error after Whisper.
  test('rejects session_start for a non-existent chat with session_not_found (E1-d3)', async () => {
    await server.close();
    server = await startServer({ chatExists: (id) => id !== 'GONE_CHAT' });
    const sid = 'sess-no-chat';
    const ws = await openSocket(server.port, sid);
    const token = mintToken({
      accountId: 'a',
      surfaceId: 's-nc',
      sessionId: sid,
      chatId: 'GONE_CHAT',
    });
    ws.send(
      encodeAudio({
        type: 'audio.session_start',
        sessionId: sid,
        accountId: 'a',
        surfaceId: 's-nc',
        surfaceKind: 'web',
        chatId: 'GONE_CHAT',
        role: 'voice-call',
        token,
        surfaceHasAec: true,
      }),
    );
    const msg = await recvOne(ws);
    expect(msg.type).toBe('audio.error');
    if (msg.type === 'audio.error') expect(msg.code).toBe('session_not_found');
    expect(server.activeCount()).toBe(0);
    ws.close();
  });

  // E1-d4: rejected connections close with an explicit WS close code + reason
  // (4400 malformed-frame / 4401 auth), not a bare ws.close() (which surfaces
  // as code 1005 / empty reason).
  test('closes a rejected connection with an explicit close code + reason (E1-d4)', async () => {
    // (1) binary frame before session_start → invalid_frame → 4400.
    const ws1 = await openSocket(server.port, 'sess-close-bin');
    const close1 = new Promise<{ code: number; reason: string }>((resolve) => {
      ws1.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    ws1.send(Buffer.alloc(4), { binary: true });
    const c1 = await close1;
    expect(c1.code).toBe(4400);
    expect(c1.reason.length).toBeGreaterThan(0);

    // (2) forged token in session_start → auth_failed → 4401.
    const ws2 = await openSocket(server.port, 'sess-close-auth');
    const close2 = new Promise<{ code: number; reason: string }>((resolve) => {
      ws2.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    ws2.send(
      encodeAudio({
        type: 'audio.session_start',
        sessionId: 'sess-close-auth',
        accountId: 'a',
        surfaceId: 's-forge',
        surfaceKind: 'web',
        chatId: 'c',
        role: 'voice-call',
        token: 'forged.signature',
        surfaceHasAec: true,
      }),
    );
    const c2 = await close2;
    expect(c2.code).toBe(4401);
    expect(c2.reason.length).toBeGreaterThan(0);
  });

  test('voice-NOTE commits exactly one turn on session_end{committed} even when VAD never fires (G5-1)', async () => {
    // A press-and-hold voice note is a SINGLE explicit utterance bounded by the
    // gesture: the release IS the end-of-utterance, NOT VAD silence. Use a VAD
    // that NEVER emits utterance_start/end so the ONLY way a turn can commit is
    // the session_end{committed} finalize path.
    const submitted: { chatId: string }[] = [];
    class SilentVad implements Vad {
      async feed(): Promise<VadFrameResult> {
        return { event: null };
      }
      reset(): void {}
    }
    const handle = await startAudioServer({
      host: '127.0.0.1',
      port: 0,
      logger,
      internalToken: SECRET,
      whisper: createWhisper({ backend: 'mock', logger }),
      kokoro: createKokoro({ backend: 'mock', logger }),
      makeVad: () => new SilentVad(),
      submitUserTurn: async ({ chatId }) => {
        submitted.push({ chatId });
        return 'ok';
      },
      chatExists: (): boolean => true,
    });
    const s = Object.assign(handle, { port: handle.address().port });
    try {
      const sid = 'sess-note';
      const ws = await openSocket(s.port, sid);
      const token = mintToken({
        accountId: 'a',
        surfaceId: 's-note',
        sessionId: sid,
        chatId: 'note-chat',
      });
      ws.send(
        encodeAudio({
          type: 'audio.session_start',
          sessionId: sid,
          accountId: 'a',
          surfaceId: 's-note',
          surfaceKind: 'web',
          chatId: 'note-chat',
          role: 'voice-note',
          token,
          surfaceHasAec: true,
        }),
      );
      await new Promise((r) => setTimeout(r, 30));
      // Stream a couple of mic frames (the held audio). VAD ignores them, so
      // no turn commits yet.
      const frame = Buffer.alloc(960);
      ws.send(frame, { binary: true });
      ws.send(frame, { binary: true });
      await new Promise((r) => setTimeout(r, 30));
      expect(submitted).toEqual([]);
      // Release → surface sends session_end{committed}. The host finalizes the
      // buffered utterance and commits exactly one turn into the bound chat.
      ws.send(encodeAudio({ type: 'audio.session_end', sessionId: sid, reason: 'committed' }));
      await new Promise((r) => setTimeout(r, 80));
      expect(submitted).toEqual([{ chatId: 'note-chat' }]);
    } finally {
      await s.close();
    }
  });

  test('voice-NOTE session_end{cancelled} commits NOTHING (Esc / abort)', async () => {
    const submitted: string[] = [];
    class SilentVad implements Vad {
      async feed(): Promise<VadFrameResult> {
        return { event: null };
      }
      reset(): void {}
    }
    const handle = await startAudioServer({
      host: '127.0.0.1',
      port: 0,
      logger,
      internalToken: SECRET,
      whisper: createWhisper({ backend: 'mock', logger }),
      kokoro: createKokoro({ backend: 'mock', logger }),
      makeVad: () => new SilentVad(),
      submitUserTurn: async ({ chatId }) => {
        submitted.push(chatId);
        return 'ok';
      },
      chatExists: (): boolean => true,
    });
    const s = Object.assign(handle, { port: handle.address().port });
    try {
      const sid = 'sess-note-cancel';
      const ws = await openSocket(s.port, sid);
      const token = mintToken({ accountId: 'a', surfaceId: 's-nc', sessionId: sid, chatId: 'nc' });
      ws.send(
        encodeAudio({
          type: 'audio.session_start',
          sessionId: sid,
          accountId: 'a',
          surfaceId: 's-nc',
          surfaceKind: 'web',
          chatId: 'nc',
          role: 'voice-note',
          token,
          surfaceHasAec: true,
        }),
      );
      await new Promise((r) => setTimeout(r, 30));
      ws.send(Buffer.alloc(960), { binary: true });
      await new Promise((r) => setTimeout(r, 20));
      ws.send(encodeAudio({ type: 'audio.session_end', sessionId: sid, reason: 'cancelled' }));
      await new Promise((r) => setTimeout(r, 80));
      expect(submitted).toEqual([]);
    } finally {
      await s.close();
    }
  });

  // --- DIAG HTTP endpoint edge cases ---------------------------------------

  test('diag speak endpoint rejects an invalid JSON body with 400', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/internal/diag/voice-device/speak`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-patch-internal-token': SECRET },
      body: '{ not valid json',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid json' });
  });

  test('diag speak endpoint rejects a body missing surfaceId/text as strings with 400', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/internal/diag/voice-device/speak`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-patch-internal-token': SECRET },
      body: JSON.stringify({ surfaceId: 123, text: 'hi' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'surfaceId and text are required strings' });
  });

  test('an unmatched HTTP path/method 404s', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/not-a-real-path`);
    expect(res.status).toBe(404);
  });

  test('a POST to a path OTHER than the diag speak path also 404s (method matches, path does not)', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/not-the-diag-path`, {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(404);
  });

  test('diag speak endpoint destroys the request once the body exceeds 64KB', async () => {
    const hugeBody = 'x'.repeat(70 * 1024);
    // The request socket is destroyed mid-upload — `fetch` surfaces this as a
    // network error (not a normal HTTP response), which is exactly the
    // observable effect of `req.destroy()` on the oversized-body guard.
    await expect(
      fetch(`http://127.0.0.1:${server.port}/internal/diag/voice-device/speak`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-patch-internal-token': SECRET },
        body: hugeBody,
      }),
    ).rejects.toThrow();
  });

  // --- device-control-upgrade mounting --------------------------------------

  test('a /device/control upgrade 404s (raw socket write + destroy) when no deviceControlUpgrade handler is configured', async () => {
    const socket = netConnect(server.port, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('error', reject);
    });
    const responseText = new Promise<string>((resolve) => {
      let buf = '';
      socket.on('data', (d: Buffer) => {
        buf += d.toString();
        resolve(buf);
      });
    });
    socket.write(
      `GET ${DEVICE_CONTROL_PATH} HTTP/1.1\r\n` +
        'Host: 127.0.0.1\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
        'Sec-WebSocket-Version: 13\r\n\r\n',
    );
    const resp = await responseText;
    expect(resp).toContain('404');
    socket.destroy();
  });

  test('a /device/control upgrade delegates to the configured deviceControlUpgrade handler', async () => {
    await server.close();
    let called: { url: string | undefined } | undefined;
    const handle = await startAudioServer({
      host: '127.0.0.1',
      port: 0,
      logger,
      internalToken: SECRET,
      whisper: createWhisper({ backend: 'mock', logger }),
      kokoro: createKokoro({ backend: 'mock', logger }),
      submitUserTurn: async () => 'ok',
      chatExists: (): boolean => true,
      deviceControlUpgrade: (req, socket) => {
        called = { url: req.url };
        socket.write('HTTP/1.1 200 OK\r\n\r\ncustom-handler-ran');
        socket.end();
      },
    });
    server = Object.assign(handle, { port: handle.address().port });
    const socket = netConnect(server.port, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('error', reject);
    });
    const responseText = new Promise<string>((resolve) => {
      let buf = '';
      socket.on('data', (d: Buffer) => {
        buf += d.toString();
        resolve(buf);
      });
    });
    socket.write(
      `GET ${DEVICE_CONTROL_PATH} HTTP/1.1\r\n` +
        'Host: 127.0.0.1\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
        'Sec-WebSocket-Version: 13\r\n\r\n',
    );
    const resp = await responseText;
    expect(resp).toContain('custom-handler-ran');
    expect(called?.url).toBe(DEVICE_CONTROL_PATH);
    socket.destroy();
  });

  test('an upgrade to a path outside /audio/ and /device/control 404s', async () => {
    const socket = netConnect(server.port, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('error', reject);
    });
    const responseText = new Promise<string>((resolve) => {
      let buf = '';
      socket.on('data', (d: Buffer) => {
        buf += d.toString();
        resolve(buf);
      });
    });
    socket.write(
      'GET /something-else HTTP/1.1\r\n' +
        'Host: 127.0.0.1\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
        'Sec-WebSocket-Version: 13\r\n\r\n',
    );
    const resp = await responseText;
    expect(resp).toContain('404');
    socket.destroy();
  });

  test('an upgrade to a bare /audio/ (empty sessionId) gets 400 Bad Request', async () => {
    const socket = netConnect(server.port, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('error', reject);
    });
    const responseText = new Promise<string>((resolve) => {
      let buf = '';
      socket.on('data', (d: Buffer) => {
        buf += d.toString();
        resolve(buf);
      });
    });
    socket.write(
      'GET /audio/ HTTP/1.1\r\n' +
        'Host: 127.0.0.1\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
        'Sec-WebSocket-Version: 13\r\n\r\n',
    );
    const resp = await responseText;
    expect(resp).toContain('400');
    socket.destroy();
  });

  // --- WS message-handling edge cases ---------------------------------------

  test('a ws.send failure while replying is caught and logged (audio: send failed)', async () => {
    const ws = await openSocket(server.port, 'sess-send-fail');
    const original = WebSocket.prototype.send;
    // Let the CLIENT's own sends through unchanged; any OTHER instance (i.e.
    // the server-side socket replying) throws — deterministically exercises
    // the `send()` wrapper's catch without racing on real disconnects.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    WebSocket.prototype.send = function (this: WebSocket, ...args: any[]) {
      if (this === ws) return (original as (...a: unknown[]) => unknown).apply(this, args);
      throw new Error('simulated send failure');
    };
    try {
      ws.send(
        encodeAudio({
          type: 'audio.session_start',
          sessionId: 'sess-send-fail',
          accountId: 'a',
          surfaceId: 's',
          surfaceKind: 'web',
          chatId: 'c',
          role: 'voice-call',
          token: 'forged.bad', // rejected -> server tries to send audio.error back
          surfaceHasAec: true,
        }),
      );
      // Give the server a moment to process + attempt (and fail) its reply.
      await new Promise((r) => setTimeout(r, 50));
      // No crash, and the connection is still tracked as not-yet-active.
      expect(server.activeCount()).toBe(0);
    } finally {
      WebSocket.prototype.send = original;
      ws.close();
    }
  });

  test('a ws protocol error (garbage frame) is caught and logged (audio: ws error), not a crash', async () => {
    const sid = 'sess-ws-proto-err';
    const ws = await openSocket(server.port, sid);
    const token = mintToken({ accountId: 'a', surfaceId: 's-err', sessionId: sid });
    ws.send(
      encodeAudio({
        type: 'audio.session_start',
        sessionId: sid,
        accountId: 'a',
        surfaceId: 's-err',
        surfaceKind: 'web',
        chatId: 'c',
        role: 'voice-call',
        token,
        surfaceHasAec: true,
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(server.activeCount()).toBe(1);
    // Write an invalid WS frame (opcode 0xF is reserved/invalid) straight onto
    // the underlying socket — triggers ws's protocol-error path server-side.
    // @ts-expect-error accessing the underlying net.Socket (internal to `ws`)
    ws._socket.write(Buffer.from([0x8f, 0x80, 0x00, 0x00, 0x00, 0x00]));
    await new Promise((r) => setTimeout(r, 100));
    // The server is still alive and didn't crash the process; the connection
    // was torn down as a result of the protocol violation.
    expect(server.activeCount()).toBe(0);
  });

  test('an audio.pcm16 announcement with a mismatched sample count is logged (debug) and the frame is still processed using its actual length', async () => {
    const observedLengths: number[] = [];
    class RecordingVad implements Vad {
      async feed(frame: Int16Array): Promise<VadFrameResult> {
        observedLengths.push(frame.length);
        return { prob: 0, event: null, state: 'silence' };
      }
      reset(): void {}
      async close(): Promise<void> {}
    }
    await server.close();
    const handle = await startAudioServer({
      host: '127.0.0.1',
      port: 0,
      logger,
      internalToken: SECRET,
      whisper: createWhisper({ backend: 'mock', logger }),
      kokoro: createKokoro({ backend: 'mock', logger }),
      makeVad: () => new RecordingVad(),
      submitUserTurn: async () => 'ok',
      chatExists: (): boolean => true,
    });
    server = Object.assign(handle, { port: handle.address().port });
    const sid = 'sess-pcm-mismatch';
    const ws = await openSocket(server.port, sid);
    const token = mintToken({ accountId: 'a', surfaceId: 's-mismatch', sessionId: sid });
    ws.send(
      encodeAudio({
        type: 'audio.session_start',
        sessionId: sid,
        accountId: 'a',
        surfaceId: 's-mismatch',
        surfaceKind: 'web',
        chatId: 'c',
        role: 'voice-call',
        token,
        surfaceHasAec: true,
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    // Announce 999 samples, then actually send a 480-sample (960-byte) frame.
    ws.send(encodeAudio({ type: 'audio.pcm16', ts: Date.now(), sampleRate: 16000, samples: 999 }));
    ws.send(Buffer.alloc(960), { binary: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(observedLengths).toEqual([480]); // actual byte length wins, not the announced 999
    ws.close();
  });

  test('an odd-byte-length binary PCM16 frame is rejected as invalid_frame', async () => {
    const sid = 'sess-odd-bytes';
    const ws = await openSocket(server.port, sid);
    const token = mintToken({ accountId: 'a', surfaceId: 's-odd', sessionId: sid });
    ws.send(
      encodeAudio({
        type: 'audio.session_start',
        sessionId: sid,
        accountId: 'a',
        surfaceId: 's-odd',
        surfaceKind: 'web',
        chatId: 'c',
        role: 'voice-call',
        token,
        surfaceHasAec: true,
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    ws.send(Buffer.alloc(3), { binary: true }); // odd byte length
    const msg = await recvOne(ws);
    expect(msg.type).toBe('audio.error');
    if (msg.type === 'audio.error') expect(msg.code).toBe('invalid_frame');
    const closed = await closePromise;
    expect(closed.code).toBe(4400);
  });

  test('an onMicFrame error (mic frame processing throws) is caught and logged (audio: mic frame error)', async () => {
    await server.close();
    class ThrowingVad implements Vad {
      async feed(): Promise<VadFrameResult> {
        throw new Error('vad blew up');
      }
      reset(): void {}
      async close(): Promise<void> {}
    }
    const handle = await startAudioServer({
      host: '127.0.0.1',
      port: 0,
      logger,
      internalToken: SECRET,
      whisper: createWhisper({ backend: 'mock', logger }),
      kokoro: createKokoro({ backend: 'mock', logger }),
      makeVad: () => new ThrowingVad(),
      submitUserTurn: async () => 'ok',
      chatExists: (): boolean => true,
    });
    server = Object.assign(handle, { port: handle.address().port });
    const sid = 'sess-mic-err';
    const ws = await openSocket(server.port, sid);
    const token = mintToken({ accountId: 'a', surfaceId: 's-mic-err', sessionId: sid });
    ws.send(
      encodeAudio({
        type: 'audio.session_start',
        sessionId: sid,
        accountId: 'a',
        surfaceId: 's-mic-err',
        surfaceKind: 'web',
        chatId: 'c',
        role: 'voice-call',
        token,
        surfaceHasAec: true,
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    // Should not crash the connection or the process — the error is caught
    // and logged inside the mic-frame handler.
    ws.send(Buffer.alloc(960), { binary: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(server.activeCount()).toBe(1);
    ws.close();
  });

  test('a malformed (non-JSON) text frame is rejected as invalid_frame (decode failed)', async () => {
    const ws = await openSocket(server.port, 'sess-bad-json');
    const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    ws.send('{ this is not valid json at all');
    const msg = await recvOne(ws);
    expect(msg.type).toBe('audio.error');
    if (msg.type === 'audio.error') expect(msg.code).toBe('invalid_frame');
    const closed = await closePromise;
    expect(closed.code).toBe(4400);
  });

  test('rejects a session_start whose sessionId differs from the URL path', async () => {
    const ws = await openSocket(server.port, 'sess-url-one');
    const token = mintToken({ accountId: 'a', surfaceId: 's', sessionId: 'sess-url-one' });
    ws.send(
      encodeAudio({
        type: 'audio.session_start',
        sessionId: 'sess-DIFFERENT', // mismatches the URL's sess-url-one
        accountId: 'a',
        surfaceId: 's',
        surfaceKind: 'web',
        chatId: 'c',
        role: 'voice-call',
        token,
        surfaceHasAec: true,
      }),
    );
    const msg = await recvOne(ws);
    expect(msg.type).toBe('audio.error');
    if (msg.type === 'audio.error') expect(msg.code).toBe('invalid_frame');
    ws.close();
  });

  test('rejects when the token claims a different sessionId than session_start declares', async () => {
    const sid = 'sess-claim-mismatch';
    const ws = await openSocket(server.port, sid);
    // Token internally claims a DIFFERENT sessionId than what session_start
    // (and the URL) declare.
    const token = mintToken({ accountId: 'a', surfaceId: 's', sessionId: 'a-totally-other-id' });
    ws.send(
      encodeAudio({
        type: 'audio.session_start',
        sessionId: sid,
        accountId: 'a',
        surfaceId: 's',
        surfaceKind: 'web',
        chatId: 'c',
        role: 'voice-call',
        token,
        surfaceHasAec: true,
      }),
    );
    const msg = await recvOne(ws);
    expect(msg.type).toBe('audio.error');
    if (msg.type === 'audio.error') {
      expect(msg.code).toBe('auth_failed');
      expect(msg.message).toBe('token sessionId mismatch');
    }
    ws.close();
  });

  test('rejects when the token does not bind to the declared accountId/surfaceId', async () => {
    const sid = 'sess-identity-mismatch';
    const ws = await openSocket(server.port, sid);
    const token = mintToken({ accountId: 'account-A', surfaceId: 'surface-A', sessionId: sid });
    ws.send(
      encodeAudio({
        type: 'audio.session_start',
        sessionId: sid,
        accountId: 'account-B', // mismatches the token's claimed accountId
        surfaceId: 'surface-A',
        surfaceKind: 'web',
        chatId: 'c',
        role: 'voice-call',
        token,
        surfaceHasAec: true,
      }),
    );
    const msg = await recvOne(ws);
    expect(msg.type).toBe('audio.error');
    if (msg.type === 'audio.error') {
      expect(msg.code).toBe('auth_failed');
      expect(msg.message).toBe('token does not bind to declared identity');
    }
    ws.close();
  });

  test('a finalizeNote failure during session_end{committed} is caught and logged, and the socket still closes', async () => {
    await server.close();
    const handle = await startAudioServer({
      host: '127.0.0.1',
      port: 0,
      logger,
      internalToken: SECRET,
      whisper: createWhisper({ backend: 'mock', logger }),
      kokoro: createKokoro({ backend: 'mock', logger }),
      makeVad: () => new MockVad(),
      submitUserTurn: async () => 'ok',
      chatExists: (): boolean => true,
      // `getPendingPermission` throwing SYNCHRONOUSLY inside processTranscript
      // propagates up through finalizeNote's returned promise, exercising the
      // server's `.catch` around the voice-note finalize path.
      getPendingPermission: () => {
        throw new Error('boom mid-finalize');
      },
      resolvePermission: () => {},
    });
    const s = Object.assign(handle, { port: handle.address().port });
    try {
      const sid = 'sess-note-finalize-err';
      const ws = await openSocket(s.port, sid);
      const token = mintToken({
        accountId: 'a',
        surfaceId: 's-note-err',
        sessionId: sid,
        chatId: 'note-chat-err',
      });
      ws.send(
        encodeAudio({
          type: 'audio.session_start',
          sessionId: sid,
          accountId: 'a',
          surfaceId: 's-note-err',
          surfaceKind: 'web',
          chatId: 'note-chat-err',
          role: 'voice-note',
          token,
          surfaceHasAec: true,
        }),
      );
      await new Promise((r) => setTimeout(r, 30));
      // Buffer some mic audio (any nonzero-length frame) so finalizeNote takes
      // the runTurn() branch, which reaches the (throwing) getPendingPermission.
      ws.send(Buffer.alloc(960), { binary: true });
      await new Promise((r) => setTimeout(r, 30));
      const closePromise = new Promise<void>((resolve) => ws.once('close', () => resolve()));
      ws.send(encodeAudio({ type: 'audio.session_end', sessionId: sid, reason: 'committed' }));
      // The socket still closes despite the finalize error (`.finally(() =>
      // ws.close())`), and the server process doesn't crash.
      await closePromise;
    } finally {
      await s.close();
    }
  });

  // --- Handle-level functions: phoneCallActive / injectUtterance / speakCanned ---

  test('phoneCallActive() is true only while a phone-side voice-call (non-device) session is active', async () => {
    await server.close();
    const handle = await startAudioServer({
      host: '127.0.0.1',
      port: 0,
      logger,
      internalToken: SECRET,
      whisper: createWhisper({ backend: 'mock', logger }),
      kokoro: createKokoro({ backend: 'mock', logger }),
      makeVad: () => new MockVad(),
      submitUserTurn: async () => 'ok',
      chatExists: (): boolean => true,
    });
    server = Object.assign(handle, { port: handle.address().port });
    expect(server.phoneCallActive()).toBe(false);

    // A device (voice-device-conv) session must NOT count as a phone call.
    const deviceSid = 'sess-phone-device';
    const wsDevice = await openSocket(server.port, deviceSid);
    const deviceToken = mintToken({
      accountId: 'a',
      surfaceId: 's-phone-device',
      sessionId: deviceSid,
      chatId: 'thread_speakers',
    });
    wsDevice.send(
      encodeAudio({
        type: 'audio.session_start',
        sessionId: deviceSid,
        accountId: 'a',
        surfaceId: 's-phone-device',
        surfaceKind: 'device',
        chatId: 'thread_speakers',
        role: 'voice-device-conv',
        token: deviceToken,
        surfaceHasAec: false,
        deviceId: 'kitchen',
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(server.phoneCallActive()).toBe(false);

    // A phone-side voice-call (web/desktop/mobile, role voice-call) DOES count.
    const callSid = 'sess-phone-call';
    const wsCall = await openSocket(server.port, callSid);
    const callToken = mintToken({ accountId: 'a', surfaceId: 's-phone-call', sessionId: callSid });
    wsCall.send(
      encodeAudio({
        type: 'audio.session_start',
        sessionId: callSid,
        accountId: 'a',
        surfaceId: 's-phone-call',
        surfaceKind: 'mobile',
        chatId: 'c',
        role: 'voice-call',
        token: callToken,
        surfaceHasAec: true,
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(server.phoneCallActive()).toBe(true);

    wsCall.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(server.phoneCallActive()).toBe(false);
    wsDevice.close();
  });

  test('injectUtterance returns false for an unknown surface, true (+ drives a turn) for a live one, and logs a failure without throwing', async () => {
    await server.close();
    const submittedChatIds: string[] = [];
    const handle = await startAudioServer({
      host: '127.0.0.1',
      port: 0,
      logger,
      internalToken: SECRET,
      whisper: createWhisper({ backend: 'mock', logger }),
      kokoro: createKokoro({ backend: 'mock', logger }),
      makeVad: () => new MockVad(),
      submitUserTurn: async ({ chatId }) => {
        submittedChatIds.push(chatId);
        return 'ok';
      },
      chatExists: (): boolean => true,
    });
    server = Object.assign(handle, { port: handle.address().port });

    // No session for this surface yet.
    expect(server.injectUtterance('no-such-surface', 'hello')).toBe(false);

    const sid = 'sess-inject';
    const surfaceId = 's-inject';
    const ws = await openSocket(server.port, sid);
    const token = mintToken({ accountId: 'a', surfaceId, sessionId: sid, chatId: 'chat-inj' });
    ws.send(
      encodeAudio({
        type: 'audio.session_start',
        sessionId: sid,
        accountId: 'a',
        surfaceId,
        surfaceKind: 'web',
        chatId: 'chat-inj',
        role: 'voice-call',
        token,
        surfaceHasAec: true,
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(server.injectUtterance(surfaceId, 'what time is it')).toBe(true);
    // injectTranscript streams per-word partials (60ms apart) before
    // committing the final turn — poll rather than a fixed sleep.
    const deadline = Date.now() + 2000;
    while (submittedChatIds.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(submittedChatIds).toEqual(['chat-inj']);
    ws.close();
  });

  test('injectUtterance failure (rejected injectTranscript) is caught and logged, not thrown', async () => {
    await server.close();
    const handle = await startAudioServer({
      host: '127.0.0.1',
      port: 0,
      logger,
      internalToken: SECRET,
      whisper: createWhisper({ backend: 'mock', logger }),
      kokoro: createKokoro({ backend: 'mock', logger }),
      makeVad: () => new MockVad(),
      submitUserTurn: async () => 'ok',
      chatExists: (): boolean => true,
      // Throws synchronously inside processTranscript -> rejects injectTranscript.
      getPendingPermission: () => {
        throw new Error('boom on inject');
      },
      resolvePermission: () => {},
    });
    server = Object.assign(handle, { port: handle.address().port });
    const sid = 'sess-inject-err';
    const surfaceId = 's-inject-err';
    const ws = await openSocket(server.port, sid);
    const token = mintToken({ accountId: 'a', surfaceId, sessionId: sid, chatId: 'chat-err' });
    ws.send(
      encodeAudio({
        type: 'audio.session_start',
        sessionId: sid,
        accountId: 'a',
        surfaceId,
        surfaceKind: 'web',
        chatId: 'chat-err',
        role: 'voice-call',
        token,
        surfaceHasAec: true,
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    // Returns true synchronously (a session exists) even though the
    // fire-and-forget injectTranscript() will reject shortly after.
    expect(server.injectUtterance(surfaceId, 'yes')).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    // No crash — the server is still healthy.
    expect(server.activeCount()).toBe(1);
    ws.close();
  });

  test('speakCanned (handle-level) returns false for an unknown surface and true for a live one', async () => {
    await server.close();
    const handle = await startAudioServer({
      host: '127.0.0.1',
      port: 0,
      logger,
      internalToken: SECRET,
      whisper: createWhisper({ backend: 'mock', logger }),
      kokoro: createKokoro({ backend: 'mock', logger }),
      makeVad: () => new MockVad(),
      submitUserTurn: async () => 'ok',
      chatExists: (): boolean => true,
    });
    server = Object.assign(handle, { port: handle.address().port });
    expect(server.speakCanned('no-such-surface', 'hello')).toBe(false);

    const sid = 'sess-speak-handle';
    const surfaceId = 's-speak-handle';
    const ws = await openSocket(server.port, sid);
    const token = mintToken({ accountId: 'a', surfaceId, sessionId: sid, chatId: 'chat-speak' });
    ws.send(
      encodeAudio({
        type: 'audio.session_start',
        sessionId: sid,
        accountId: 'a',
        surfaceId,
        surfaceKind: 'web',
        chatId: 'chat-speak',
        role: 'voice-call',
        token,
        surfaceHasAec: true,
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(server.speakCanned(surfaceId, 'a canned phrase to speak')).toBe(true);
    ws.close();
  });

  test('the JTI replay guard prunes entries whose TTL has expired (opts.nowMs clock control)', async () => {
    await server.close();
    let now = 1_000_000;
    const handle = await startAudioServer({
      host: '127.0.0.1',
      port: 0,
      logger,
      internalToken: SECRET,
      whisper: createWhisper({ backend: 'mock', logger }),
      kokoro: createKokoro({ backend: 'mock', logger }),
      makeVad: () => new MockVad(),
      submitUserTurn: async () => 'ok',
      chatExists: (): boolean => true,
      nowMs: () => now,
    });
    server = Object.assign(handle, { port: handle.address().port });
    const jti = 'ttl-jti-1';
    const sid1 = 'sess-ttl-1';
    const ws1 = await openSocket(server.port, sid1);
    const token1 = mintToken({
      accountId: 'a',
      surfaceId: 's1',
      sessionId: sid1,
      jti,
      exp: now + 100,
    });
    ws1.send(
      encodeAudio({
        type: 'audio.session_start',
        sessionId: sid1,
        accountId: 'a',
        surfaceId: 's1',
        surfaceKind: 'web',
        chatId: 'c',
        role: 'voice-call',
        token: token1,
        surfaceHasAec: true,
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(server.activeCount()).toBe(1);
    ws1.close();
    await new Promise((r) => setTimeout(r, 50));

    // Advance the clock PAST the first token's exp — the next `consume()`
    // call prunes it before checking membership.
    now += 200;
    const sid2 = 'sess-ttl-2';
    const ws2 = await openSocket(server.port, sid2);
    const token2 = mintToken({
      accountId: 'a',
      surfaceId: 's2',
      sessionId: sid2,
      jti,
      exp: now + 100,
    });
    ws2.send(
      encodeAudio({
        type: 'audio.session_start',
        sessionId: sid2,
        accountId: 'a',
        surfaceId: 's2',
        surfaceKind: 'web',
        chatId: 'c',
        role: 'voice-call',
        token: token2,
        surfaceHasAec: true,
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    // Accepted, NOT rejected as a replay — the stale jti was pruned.
    expect(server.activeCount()).toBe(1);
    ws2.close();
  });

  test('uses the default VAD factory (MockVad) when opts.makeVad is not supplied', async () => {
    await server.close();
    const handle = await startAudioServer({
      host: '127.0.0.1',
      port: 0,
      logger,
      internalToken: SECRET,
      whisper: createWhisper({ backend: 'mock', logger }),
      kokoro: createKokoro({ backend: 'mock', logger }),
      // No `makeVad` — exercises the internal `?? (() => new MockVad())` default.
      submitUserTurn: async () => 'ok',
      chatExists: (): boolean => true,
    });
    server = Object.assign(handle, { port: handle.address().port });
    const sid = 'sess-default-vad';
    const ws = await openSocket(server.port, sid);
    const token = mintToken({ accountId: 'a', surfaceId: 's-default-vad', sessionId: sid });
    ws.send(
      encodeAudio({
        type: 'audio.session_start',
        sessionId: sid,
        accountId: 'a',
        surfaceId: 's-default-vad',
        surfaceKind: 'web',
        chatId: 'c',
        role: 'voice-call',
        token,
        surfaceHasAec: true,
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(server.activeCount()).toBe(1);
    ws.close();
  });

  test('an unrecognised (but schema-valid) control frame after session_start is a harmless no-op (switch default)', async () => {
    const sid = 'sess-default-case';
    const ws = await openSocket(server.port, sid);
    const token = mintToken({ accountId: 'a', surfaceId: 's-default-case', sessionId: sid });
    ws.send(
      encodeAudio({
        type: 'audio.session_start',
        sessionId: sid,
        accountId: 'a',
        surfaceId: 's-default-case',
        surfaceKind: 'web',
        chatId: 'c',
        role: 'voice-call',
        token,
        surfaceHasAec: true,
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(server.activeCount()).toBe(1);
    // `audio.transcript_partial` is surface-emitted but the host has no
    // handling for it — must fall into the `default:` no-op branch, not
    // close the connection or error.
    ws.send(
      encodeAudio({
        type: 'audio.transcript_partial',
        sessionId: sid,
        text: 'unexpected but valid',
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(server.activeCount()).toBe(1);
    ws.close();
  });

  test('setFocusForSurface is a no-op for a surface with no active session', async () => {
    // No session at all for this surfaceId — must not throw.
    expect(() => server.setFocusForSurface('no-such-surface-anywhere', 'some-chat')).not.toThrow();
  });

  test('address() throws once the server has been closed (not listening)', async () => {
    await server.close();
    expect(() => server.address()).toThrow(/not listening/);
    // Prevent the shared afterEach from calling close() again on an
    // already-closed handle (mutate in place — `server` is a plain object).
    server.close = async () => {};
  });

  test("handle.close() swallows an error thrown by an individual session socket's close()", async () => {
    const sid = 'sess-close-throws';
    const ws = await openSocket(server.port, sid);
    const token = mintToken({ accountId: 'a', surfaceId: 's-close-throws', sessionId: sid });
    ws.send(
      encodeAudio({
        type: 'audio.session_start',
        sessionId: sid,
        accountId: 'a',
        surfaceId: 's-close-throws',
        surfaceKind: 'web',
        chatId: 'c',
        role: 'voice-call',
        token,
        surfaceHasAec: true,
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(server.activeCount()).toBe(1);
    // Throw on ONLY the very first `.close()` call (the handle's own
    // `active.socket.close()` inside its per-session loop, which runs before
    // anything else in `close()`), then immediately restore the real
    // implementation — so the WebSocketServer's OWN internal client cleanup
    // (triggered moments later by `wss.close()`) isn't affected and the test
    // can't hang.
    let thrown = false;
    const original = WebSocket.prototype.close;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    WebSocket.prototype.close = function (this: WebSocket, ...args: any[]) {
      if (!thrown) {
        thrown = true;
        WebSocket.prototype.close = original;
        throw new Error('simulated close failure');
      }
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    };
    try {
      // Must not throw/reject even though the per-session socket.close() call
      // inside it throws — the `try { active.socket.close() } catch {}` swallows it.
      // The throwing close() means the server-side socket never actually got
      // closed, so `wss.close()` won't fire its callback until the client
      // disconnects too — close it from this end to let the promise resolve.
      const closePromise = server.close();
      ws.close();
      await expect(closePromise).resolves.toBeUndefined();
    } finally {
      WebSocket.prototype.close = original;
    }
  });

  // --- Stale surfaceIndex mapping (two connections sharing one sessionId) ---
  //
  // The audio protocol doesn't prevent two DIFFERENT WS connections from
  // opening `/audio/<sameId>` and both completing session_start with that
  // literal sessionId but DIFFERENT surfaceIds (each with its own distinct
  // token/jti). `sessions.set(sessionId, ...)` then has the SECOND
  // connection's ActiveSession silently replace the first's under that
  // shared key. If the FIRST connection's socket closes afterward, its close
  // handler still looks up `sessions.get(claims.sessionId)` (now the SECOND
  // connection's entry) to find `active.surfaceId` — but since that ID is
  // gone/replaced, `sessions.get(id)` on the FIRST connection's own id may by
  // then already be gone (deleted by the SECOND connection's own earlier
  // close), leaving the FIRST connection's `surfaceIndex` entry orphaned
  // (pointing at a sessionId no longer in `sessions`). This test drives that
  // exact sequence and confirms the handle's surface-routing methods degrade
  // to their documented "no active session" behaviour (false / no-op) for
  // the orphaned surfaceId, rather than throwing.
  test('surface-routing methods return false/no-op for a surfaceId whose session was replaced by a same-sessionId collision', async () => {
    await server.close();
    const handle = await startAudioServer({
      host: '127.0.0.1',
      port: 0,
      logger,
      internalToken: SECRET,
      whisper: createWhisper({ backend: 'mock', logger }),
      kokoro: createKokoro({ backend: 'mock', logger }),
      makeVad: () => new MockVad(),
      submitUserTurn: async () => 'ok',
      chatExists: (): boolean => true,
    });
    server = Object.assign(handle, { port: handle.address().port });

    const sharedSessionId = 'sess-collide';
    const surfaceA = 's-collide-a';
    const surfaceB = 's-collide-b';

    const wsA = await openSocket(server.port, sharedSessionId);
    const tokenA = mintToken({ accountId: 'a', surfaceId: surfaceA, sessionId: sharedSessionId });
    wsA.send(
      encodeAudio({
        type: 'audio.session_start',
        sessionId: sharedSessionId,
        accountId: 'a',
        surfaceId: surfaceA,
        surfaceKind: 'web',
        chatId: 'c',
        role: 'voice-call',
        token: tokenA,
        surfaceHasAec: true,
      }),
    );
    await new Promise((r) => setTimeout(r, 40));

    const wsB = await openSocket(server.port, sharedSessionId);
    const tokenB = mintToken({ accountId: 'a', surfaceId: surfaceB, sessionId: sharedSessionId });
    wsB.send(
      encodeAudio({
        type: 'audio.session_start',
        sessionId: sharedSessionId,
        accountId: 'a',
        surfaceId: surfaceB,
        surfaceKind: 'web',
        chatId: 'c',
        role: 'voice-call',
        token: tokenB,
        surfaceHasAec: true,
      }),
    );
    await new Promise((r) => setTimeout(r, 40));
    // `sessions.set(sharedSessionId, …)` was overwritten by B — only 1 entry.
    expect(server.activeCount()).toBe(1);

    // Close B first: its close handler finds itself in `sessions` (still B's
    // entry) and cleans up `surfaceIndex[surfaceB]` + `sessions[sharedSessionId]`.
    wsB.close();
    await new Promise((r) => setTimeout(r, 40));
    expect(server.activeCount()).toBe(0);

    // Close A: its close handler looks up `sessions.get(sharedSessionId)` —
    // already gone (deleted by B's close) — so it CANNOT clean up
    // `surfaceIndex[surfaceA]`, which is now orphaned.
    wsA.close();
    await new Promise((r) => setTimeout(r, 40));

    // The orphaned surfaceId (A) has a dangling surfaceIndex entry pointing
    // at a sessionId no longer in `sessions` — every routing method must
    // degrade gracefully instead of throwing.
    expect(server.injectUtterance(surfaceA, 'hello')).toBe(false);
    expect(server.speakCanned(surfaceA, 'hello')).toBe(false);
    expect(() => server.setFocusForSurface(surfaceA, 'some-chat')).not.toThrow();
  });
});
