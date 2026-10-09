// audio/server.ts voice-config wiring tests (group: voice config matrix).
// Confirms the surface-derivation + per-surface {backend, layer} branching —
// a real end-to-end WSS session against a fully mocked Gemini socket (via the
// `geminiWsCtor` test hook), not just gemini-live.ts's own unit tests.
//
//   - call surface, backend='gemini'          -> GeminiLiveSession (dials "Gemini")
//   - device surface, backend='gemini'        -> voice_config_not_implemented (not a silent fallback)
//   - dictation surface (voice-note role), backend='gemini', no transcriber -> voice_key_missing
//   - call surface, backend='gemini', no key  -> audio.error{voice_key_missing}
//   - call surface, backend='openai', no key  -> audio.error{openai_unavailable}
//   (the working hosted cells are covered in audio-server-hosted-backends.test.ts)
//   - call surface, backend='local', layer='light' -> voice_config_not_implemented (no front model yet)
//   - default voiceConfig (local/direct everywhere) -> never dials Gemini

import { describe, test, expect, afterEach } from 'vitest';
import pino from 'pino';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import type { WebSocket as WsSocket } from 'ws';
import { startAudioServer, type AudioServerHandle } from '../src/audio/server.js';
import { createWhisper } from '../src/audio/whisper.js';
import { createKokoro } from '../src/audio/kokoro.js';
import { MockVad } from '../src/audio/vad.js';
import {
  encodeAudio,
  decodeAudio,
  DEFAULT_VOICE_CONFIG,
  type AudioEvent,
  type VoiceConfig,
} from '@patch/wire/audio';

const SECRET = 'unit-test-internal-token-aaaaaaaaaa';
const logger = pino({ level: 'silent' });

function mintToken(claims: {
  accountId: string;
  surfaceId: string;
  sessionId: string;
  chatId?: string;
}): string {
  const obj = {
    accountId: claims.accountId,
    surfaceId: claims.surfaceId,
    sessionId: claims.sessionId,
    chatId: claims.chatId ?? 'c',
    exp: Date.now() + 60_000,
    jti: `jti-${Math.random().toString(36).slice(2)}`,
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

async function openSocket(port: number, sessionId: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/audio/${sessionId}`);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return ws;
}

/** A fake "Gemini Live" socket — never touches the network. */
class FakeGeminiWs extends EventEmitter {
  sent: string[] = [];
  constructor(public readonly url: string) {
    super();
  }
  send(data: string): void {
    this.sent.push(data);
    // Auto-answer setup so the session reaches 'listening' without the test
    // having to drive the handshake for every case.
    const parsed = JSON.parse(data) as { setup?: unknown };
    if (parsed.setup) {
      queueMicrotask(() => this.emit('message', JSON.stringify({ setupComplete: {} }), false));
    }
  }
  close(): void {}
}

let instances: FakeGeminiWs[] = [];
function makeGeminiWsCtor(): new (url: string) => WsSocket {
  return function (this: FakeGeminiWs, url: string): FakeGeminiWs {
    const inst = new FakeGeminiWs(url);
    // Fire 'open' on the next tick, like a real socket would.
    queueMicrotask(() => inst.emit('open'));
    instances.push(inst);
    return inst;
  } as unknown as new (url: string) => WsSocket;
}

describe('audio server — voice config matrix selection', () => {
  let server: AudioServerHandle & { port: number };

  afterEach(async () => {
    instances = [];
    if (server) await server.close();
  });

  async function startServer(opts: {
    voiceConfig?: Partial<VoiceConfig>;
    geminiApiKey?: string;
  }): Promise<AudioServerHandle & { port: number }> {
    const voiceConfig: VoiceConfig = { ...DEFAULT_VOICE_CONFIG, ...opts.voiceConfig };
    const handle = await startAudioServer({
      makeTimeline: () => ({ userSaid() {}, beginReply: () => ({ append() {}, finish() {} }) }),
      host: '127.0.0.1',
      port: 0,
      logger,
      internalToken: SECRET,
      whisper: createWhisper({ backend: 'mock', logger }),
      kokoro: createKokoro({ backend: 'mock', logger }),
      makeVad: () => new MockVad(),
      submitUserTurn: async () => 'mock reply',
      chatExists: () => true,
      getVoiceConfig: () => voiceConfig,
      ...(opts.geminiApiKey !== undefined ? { geminiApiKey: opts.geminiApiKey } : {}),
      geminiWsCtor: makeGeminiWsCtor(),
    });
    const addr = handle.address();
    return Object.assign(handle, { port: addr.port });
  }

  test("call surface, backend='gemini' dials the (fake) Gemini socket", async () => {
    server = await startServer({
      voiceConfig: { call: { backend: 'gemini', layer: 'light' } },
      geminiApiKey: 'test-key',
    });
    const ws = await openSocket(server.port, 's-native-1');
    ws.send(
      encodeAudio({
        type: 'audio.session_start',
        sessionId: 's-native-1',
        accountId: 'a',
        surfaceId: 'surf',
        surfaceKind: 'web',
        chatId: 'c1',
        role: 'voice-call',
        token: mintToken({
          accountId: 'a',
          surfaceId: 'surf',
          sessionId: 's-native-1',
          chatId: 'c1',
        }),
        surfaceHasAec: true,
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(instances.length).toBe(1);
    // Its setup message is the Gemini Live shape, not anything Whisper/Kokoro would send.
    const setup = JSON.parse(instances[0]!.sent[0]!) as { setup?: { model?: string } };
    expect(setup.setup?.model).toBeDefined();
    ws.close();
  });

  test("device surface, backend='gemini' refuses — not implemented, NOT a silent fallback", async () => {
    server = await startServer({
      voiceConfig: { device: { backend: 'gemini', layer: 'light' } },
      geminiApiKey: 'test-key',
    });
    const ws = await openSocket(server.port, 's-device-1');
    ws.send(
      encodeAudio({
        type: 'audio.session_start',
        sessionId: 's-device-1',
        accountId: 'a',
        surfaceId: 'device-kitchen',
        surfaceKind: 'device',
        deviceId: 'device-kitchen',
        chatId: 'c1',
        role: 'voice-device-conv',
        token: mintToken({
          accountId: 'a',
          surfaceId: 'device-kitchen',
          sessionId: 's-device-1',
          chatId: 'c1',
        }),
        surfaceHasAec: false,
      }),
    );
    const msg = await recvOne(ws);
    expect(msg.type).toBe('audio.error');
    if (msg.type === 'audio.error') expect(msg.code).toBe('voice_config_not_implemented');
    expect(instances.length).toBe(0);
    ws.close();
  });

  test("dictation surface (voice-note role), backend='gemini' with no Gemini transcriber refuses — never Whisper", async () => {
    server = await startServer({
      voiceConfig: { dictation: { backend: 'gemini' } },
      geminiApiKey: 'test-key',
    });
    const ws = await openSocket(server.port, 's-note-1');
    ws.send(
      encodeAudio({
        type: 'audio.session_start',
        sessionId: 's-note-1',
        accountId: 'a',
        surfaceId: 'surf',
        surfaceKind: 'web',
        chatId: 'c1',
        role: 'voice-note',
        token: mintToken({
          accountId: 'a',
          surfaceId: 'surf',
          sessionId: 's-note-1',
          chatId: 'c1',
        }),
        surfaceHasAec: true,
      }),
    );
    const msg = await recvOne(ws);
    expect(msg.type).toBe('audio.error');
    expect(msg).toMatchObject({
      code: 'voice_key_missing',
      message:
        'Dictation is set to gemini, but GEMINI_API_KEY is not set on this host. ' +
        'Switch Dictation to another backend in Settings → Voice.',
    });
    expect(instances.length).toBe(0);
    ws.close();
  });

  test("call surface, backend='gemini', no GEMINI_API_KEY refuses the session", async () => {
    server = await startServer({ voiceConfig: { call: { backend: 'gemini', layer: 'light' } } });
    const ws = await openSocket(server.port, 's-nokey-1');
    ws.send(
      encodeAudio({
        type: 'audio.session_start',
        sessionId: 's-nokey-1',
        accountId: 'a',
        surfaceId: 'surf',
        surfaceKind: 'web',
        chatId: 'c1',
        role: 'voice-call',
        token: mintToken({
          accountId: 'a',
          surfaceId: 'surf',
          sessionId: 's-nokey-1',
          chatId: 'c1',
        }),
        surfaceHasAec: true,
      }),
    );
    const msg = await recvOne(ws);
    expect(msg.type).toBe('audio.error');
    expect(msg).toMatchObject({
      code: 'voice_key_missing',
      message:
        'Call is set to gemini, but GEMINI_API_KEY is not set on this host. ' +
        'Switch Call to another backend in Settings → Voice.',
    });
    expect(instances.length).toBe(0);
    ws.close();
  });

  test("call surface, backend='openai', no OPENAI_REALTIME_API_KEY refuses the session", async () => {
    server = await startServer({ voiceConfig: { call: { backend: 'openai', layer: 'heavy' } } });
    const ws = await openSocket(server.port, 's-openai-1');
    ws.send(
      encodeAudio({
        type: 'audio.session_start',
        sessionId: 's-openai-1',
        accountId: 'a',
        surfaceId: 'surf',
        surfaceKind: 'web',
        chatId: 'c1',
        role: 'voice-call',
        token: mintToken({
          accountId: 'a',
          surfaceId: 'surf',
          sessionId: 's-openai-1',
          chatId: 'c1',
        }),
        surfaceHasAec: true,
      }),
    );
    const msg = await recvOne(ws);
    expect(msg.type).toBe('audio.error');
    expect(msg).toMatchObject({
      code: 'voice_key_missing',
      message:
        'Call is set to openai, but OPENAI_REALTIME_API_KEY is not set on this host. ' +
        'Switch Call to another backend in Settings → Voice.',
    });
    expect(instances.length).toBe(0);
    ws.close();
  });

  test("call surface, backend='local', layer='light' refuses — no front model built yet", async () => {
    server = await startServer({ voiceConfig: { call: { backend: 'local', layer: 'light' } } });
    const ws = await openSocket(server.port, 's-light-1');
    ws.send(
      encodeAudio({
        type: 'audio.session_start',
        sessionId: 's-light-1',
        accountId: 'a',
        surfaceId: 'surf',
        surfaceKind: 'web',
        chatId: 'c1',
        role: 'voice-call',
        token: mintToken({
          accountId: 'a',
          surfaceId: 'surf',
          sessionId: 's-light-1',
          chatId: 'c1',
        }),
        surfaceHasAec: true,
      }),
    );
    const msg = await recvOne(ws);
    expect(msg.type).toBe('audio.error');
    if (msg.type === 'audio.error') expect(msg.code).toBe('voice_config_not_implemented');
    expect(instances.length).toBe(0);
    ws.close();
  });

  test('default voiceConfig (local/direct everywhere) never dials Gemini for a plain web voice-call', async () => {
    server = await startServer({});
    const ws = await openSocket(server.port, 's-fb-1');
    ws.send(
      encodeAudio({
        type: 'audio.session_start',
        sessionId: 's-fb-1',
        accountId: 'a',
        surfaceId: 'surf',
        surfaceKind: 'web',
        chatId: 'c1',
        role: 'voice-call',
        token: mintToken({ accountId: 'a', surfaceId: 'surf', sessionId: 's-fb-1', chatId: 'c1' }),
        surfaceHasAec: true,
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(instances.length).toBe(0);
    ws.close();
  });
});
