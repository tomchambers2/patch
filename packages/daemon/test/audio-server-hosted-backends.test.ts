// audio/server.ts × hosted voice backends (spec/07 § Voice — a config matrix).
//
// Every surface a phone/web/desktop can open — dictation, hands-free, call —
// on every backend — local, gemini, openai — over a REAL audio WSS against
// fully faked providers: the Gemini Live and OpenAI Realtime sockets are
// in-memory fakes (the `geminiWsCtor` / `openaiWsCtor` hooks) and the hosted
// dictation transcribers are fakes too. No request leaves this process — both
// providers are paid APIs and this suite must never spend.

import { describe, test, expect, afterEach, vi } from 'vitest';
import pino from 'pino';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import type { WebSocket as WsSocket } from 'ws';
import {
  startAudioServer,
  closeReason,
  type AudioServerHandle,
  type AudioServerOptions,
} from '../src/audio/server.js';
import type { WhisperBackend } from '../src/audio/whisper.js';
import { createKokoro } from '../src/audio/kokoro.js';
import type { Vad, VadFrameResult } from '../src/audio/vad.js';
import {
  DEFAULT_GEMINI_LIVE_MODEL,
  DEFAULT_GEMINI_LIVE_HEAVY_MODEL,
} from '../src/audio/gemini-live.js';
import { DEFAULT_OPENAI_REALTIME_MODELS, type OpenAIWsCtor } from '../src/audio/openai-realtime.js';
import {
  encodeAudio,
  decodeAudio,
  DEFAULT_VOICE_CONFIG,
  type AudioEvent,
  type AudioSessionMode,
  type AudioSessionRole,
  type VoiceBackend,
  type VoiceConfig,
} from '@patch/wire/audio';

const SECRET = 'unit-test-internal-token-aaaaaaaaaa';
const logger = pino({ level: 'silent' });

function mintToken(sessionId: string, surfaceId = 'surf'): string {
  const obj = {
    accountId: 'a',
    surfaceId,
    sessionId,
    chatId: 'c1',
    exp: Date.now() + 60_000,
    jti: `jti-${Math.random().toString(36).slice(2)}`,
  };
  const claimsB64 = Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
  const sig = createHmac('sha256', SECRET).update(claimsB64).digest().toString('base64url');
  return `${claimsB64}.${sig}`;
}

/** A connected surface: every JSON frame it has received, and how its socket closed. */
interface Surface {
  ws: WebSocket;
  events: AudioEvent[];
  closed: Promise<number>;
}

async function openSurface(
  port: number,
  sessionId: string,
  role: AudioSessionRole,
  mode?: AudioSessionMode,
): Promise<Surface> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/audio/${sessionId}`);
  const events: AudioEvent[] = [];
  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (!isBinary) events.push(decodeAudio(data));
  });
  const closed = new Promise<number>((resolve) =>
    ws.once('close', (code: number) => resolve(code)),
  );
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  ws.send(
    encodeAudio({
      type: 'audio.session_start',
      sessionId,
      accountId: 'a',
      surfaceId: 'surf',
      surfaceKind: 'mobile',
      chatId: 'c1',
      role,
      token: mintToken(sessionId),
      surfaceHasAec: true,
      ...(mode ? { mode } : {}),
    }),
  );
  return { ws, events, closed };
}

class FakeGeminiWs extends EventEmitter {
  sent: string[] = [];
  constructor(public readonly url: string) {
    super();
  }
  send(data: string): void {
    this.sent.push(data);
    if ((JSON.parse(data) as { setup?: unknown }).setup) {
      queueMicrotask(() => this.emit('message', JSON.stringify({ setupComplete: {} }), false));
    }
  }
  close(): void {}
}

class FakeOpenAIWs extends EventEmitter {
  sent: Array<Record<string, unknown>> = [];
  constructor(
    public readonly url: string,
    public readonly opts: { headers: Record<string, string> },
  ) {
    super();
  }
  send(data: string): void {
    const msg = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(msg);
    if (msg['type'] === 'session.update' && this.sent.length === 1) {
      queueMicrotask(() => this.emit('message', JSON.stringify({ type: 'session.updated' })));
    }
  }
  close(): void {}
  /** Test helper: the provider sends an event. */
  serverSend(ev: unknown): void {
    this.emit('message', JSON.stringify(ev));
  }
}

/** A transcriber stand-in that records what it was asked to transcribe. */
function fakeTranscriber(text: string): WhisperBackend & { calls: number } {
  const t = {
    calls: 0,
    supportsLivePartials: false,
    async transcribe(): Promise<string> {
      t.calls += 1;
      return text;
    },
    async transcribeClip(): Promise<string> {
      t.calls += 1;
      return text;
    },
    async close(): Promise<void> {},
  };
  return t;
}

class SilentVad implements Vad {
  async feed(): Promise<VadFrameResult> {
    return { event: null };
  }
  reset(): void {}
}

const until = (fn: () => void): Promise<void> => vi.waitFor(fn, { timeout: 2000, interval: 5 });

describe('audio server — hosted backends on every app surface', () => {
  let server: (AudioServerHandle & { port: number }) | undefined;
  let gemini: FakeGeminiWs[] = [];
  let openai: FakeOpenAIWs[] = [];
  const submitted: Array<{ chatId: string; message: string }> = [];
  const transcribers = {
    local: fakeTranscriber('local words'),
    gemini: fakeTranscriber('gemini words'),
    openai: fakeTranscriber('openai words'),
  };

  afterEach(async () => {
    gemini = [];
    openai = [];
    submitted.length = 0;
    for (const t of Object.values(transcribers)) t.calls = 0;
    if (server) await server.close();
    server = undefined;
  });

  async function start(
    voiceConfig: Partial<VoiceConfig>,
    keys: { gemini?: boolean; openai?: boolean } = { gemini: true, openai: true },
    extra: Partial<AudioServerOptions> = {},
  ): Promise<AudioServerHandle & { port: number }> {
    const cfg: VoiceConfig = { ...DEFAULT_VOICE_CONFIG, ...voiceConfig };
    const handle = await startAudioServer({
      makeTimeline: () => ({ userSaid() {}, beginReply: () => ({ append() {}, finish() {} }) }),
      host: '127.0.0.1',
      port: 0,
      logger,
      internalToken: SECRET,
      whisper: transcribers.local,
      kokoro: createKokoro({ backend: 'mock', logger }),
      makeVad: () => new SilentVad(),
      submitUserTurn: async ({ chatId, message }) => {
        submitted.push({ chatId, message });
        return 'heavy agent reply';
      },
      chatExists: () => true,
      getVoiceConfig: () => cfg,
      dictationTranscribers: {
        local: transcribers.local,
        ...(keys.gemini ? { gemini: transcribers.gemini } : {}),
        ...(keys.openai ? { openai: transcribers.openai } : {}),
      },
      ...(keys.gemini ? { geminiApiKey: 'g-key' } : {}),
      ...(keys.openai ? { openaiApiKey: 'o-key' } : {}),
      geminiWsCtor: function (this: unknown, url: string) {
        const inst = new FakeGeminiWs(url);
        queueMicrotask(() => inst.emit('open'));
        gemini.push(inst);
        return inst;
      } as unknown as new (url: string) => WsSocket,
      openaiWsCtor: function (
        this: unknown,
        url: string,
        opts: { headers: Record<string, string> },
      ) {
        const inst = new FakeOpenAIWs(url, opts);
        queueMicrotask(() => inst.emit('open'));
        openai.push(inst);
        return inst;
      } as unknown as OpenAIWsCtor,
      ...extra,
    });
    server = Object.assign(handle, { port: handle.address().port });
    return server;
  }

  // --- dictation × backend -------------------------------------------------

  const DICTATION: Array<[VoiceBackend, keyof typeof transcribers]> = [
    ['local', 'local'],
    ['gemini', 'gemini'],
    ['openai', 'openai'],
  ];
  for (const [backend, which] of DICTATION) {
    test(`dictation on ${backend}: a committed note is transcribed by ${backend} and nothing else`, async () => {
      const s = await start({ dictation: { backend } });
      const surface = await openSurface(s.port, `d-${backend}`, 'voice-note');
      await until(() => expect(surface.events.some((e) => e.type === 'audio.state')).toBe(true));
      surface.ws.send(Buffer.alloc(960), { binary: true });
      surface.ws.send(Buffer.alloc(960), { binary: true });
      await new Promise((r) => setTimeout(r, 20));
      surface.ws.send(encodeAudio({ type: 'audio.session_end', reason: 'committed' }));
      await until(() => expect(submitted).toHaveLength(1));
      expect(submitted[0]!.message).toContain(`${which} words`);
      for (const [name, t] of Object.entries(transcribers)) {
        expect(t.calls, name).toBe(name === which ? 1 : 0);
      }
      // A hosted dictation never dials a realtime session.
      expect(gemini).toHaveLength(0);
      expect(openai).toHaveLength(0);
      surface.ws.close();
    });
  }

  test('dictation on openai with no key on the host is refused, naming the key and the fix', async () => {
    const s = await start({ dictation: { backend: 'openai' } }, { gemini: true });
    const surface = await openSurface(s.port, 'd-nokey', 'voice-note');
    await surface.closed;
    expect(surface.events[0]).toEqual({
      type: 'audio.error',
      code: 'voice_key_missing',
      message:
        'Dictation is set to openai, but OPENAI_REALTIME_API_KEY is not set on this host. ' +
        'Switch Dictation to another backend in Settings → Voice.',
    });
    expect(transcribers.local.calls).toBe(0);
  });

  // --- one conversation with the chat, and call cost (spec/07) -------------

  test('a Gemini call writes into the chat, is findable by chat, and is costed when it ends', async () => {
    const log: string[] = [];
    const started: string[] = [];
    const ended: Array<Parameters<NonNullable<AudioServerOptions['onCallEnded']>>[0]> = [];
    const s = await start({ call: { backend: 'gemini', layer: 'light' } }, undefined, {
      makeTimeline: () => ({
        userSaid: (chatId, text) => log.push(`user:${chatId}:${text}`),
        beginReply: (chatId) => {
          let text = '';
          return {
            append: (d) => {
              text += d;
            },
            finish: () => log.push(`reply:${chatId}:${text}`),
          };
        },
      }),
      onCallStarted: (init) => started.push(init.chatId),
      onCallEnded: (info) => ended.push(info),
    });
    const surface = await openSurface(s.port, 'conv', 'voice-call', 'call');
    await until(() =>
      expect(surface.events).toContainEqual(
        expect.objectContaining({ type: 'audio.state', state: 'listening' }),
      ),
    );
    expect(started).toHaveLength(1);
    const chatId = started[0]!;
    expect(s.sessionsOnChat(chatId)).toHaveLength(1);
    expect(s.sessionsOnChat('another-chat')).toHaveLength(0);

    const g = gemini[0]!;
    const say = (m: unknown): void => {
      g.emit('message', JSON.stringify(m), false);
    };
    say({ serverContent: { inputTranscription: { text: 'what is a nebula' } } });
    say({ serverContent: { outputTranscription: { text: 'A cloud of gas.' } } });
    say({
      serverContent: { turnComplete: true },
      usageMetadata: {
        promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 120 }],
        responseTokensDetails: [{ modality: 'AUDIO', tokenCount: 40 }],
      },
    });
    expect(log).toEqual([`user:${chatId}:what is a nebula`, `reply:${chatId}:A cloud of gas.`]);

    surface.ws.close();
    await until(() => expect(ended).toHaveLength(1));
    expect(ended[0]!.chatId).toBe(chatId);
    expect(ended[0]!.engine).toEqual({
      backend: 'gemini',
      model: DEFAULT_GEMINI_LIVE_MODEL,
      tokens: { textIn: 0, audioIn: 120, cachedIn: 0, textOut: 0, audioOut: 40 },
      stt: null,
    });
    expect(ended[0]!.endedAt).toBeGreaterThanOrEqual(ended[0]!.startedAt);
  });

  test('a dictation is never costed as a call', async () => {
    const ended: unknown[] = [];
    const s = await start({ dictation: { backend: 'local' } }, undefined, {
      onCallEnded: (info) => ended.push(info),
    });
    const surface = await openSurface(s.port, 'dict', 'voice-note');
    await until(() => expect(surface.events.some((e) => e.type === 'audio.state')).toBe(true));
    surface.ws.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(ended).toHaveLength(0);
  });

  // --- call / hands-free × backend × layer --------------------------------

  const CONVERSATIONAL: Array<[AudioSessionMode, 'call' | 'handsFree']> = [
    ['call', 'call'],
    ['hands-free', 'handsFree'],
  ];
  for (const [mode, key] of CONVERSATIONAL) {
    test(`${mode} on local/direct runs the local pipeline — no provider dialled`, async () => {
      const s = await start({ [key]: { backend: 'local', layer: 'direct' } });
      const surface = await openSurface(s.port, `l-${mode}`, 'voice-call', mode);
      await until(() =>
        expect(surface.events).toContainEqual(
          expect.objectContaining({ type: 'audio.state', state: 'listening' }),
        ),
      );
      expect(gemini).toHaveLength(0);
      expect(openai).toHaveLength(0);
      surface.ws.close();
    });

    for (const layer of ['light', 'heavy'] as const) {
      test(`${mode} on gemini/${layer} dials Gemini Live with the ${layer} model`, async () => {
        const s = await start({ [key]: { backend: 'gemini', layer } });
        const surface = await openSurface(s.port, `g-${mode}-${layer}`, 'voice-call', mode);
        await until(() =>
          expect(surface.events).toContainEqual(
            expect.objectContaining({ type: 'audio.state', state: 'listening' }),
          ),
        );
        expect(gemini).toHaveLength(1);
        expect(openai).toHaveLength(0);
        const setup = JSON.parse(gemini[0]!.sent[0]!) as { setup: { model: string } };
        expect(setup.setup.model).toBe(
          layer === 'heavy' ? DEFAULT_GEMINI_LIVE_HEAVY_MODEL : DEFAULT_GEMINI_LIVE_MODEL,
        );
        surface.ws.close();
      });

      test(`${mode} on openai/${layer} dials OpenAI Realtime with the ${layer} model and a bearer key`, async () => {
        const s = await start({ [key]: { backend: 'openai', layer } });
        const surface = await openSurface(s.port, `o-${mode}-${layer}`, 'voice-call', mode);
        await until(() =>
          expect(surface.events).toContainEqual(
            expect.objectContaining({ type: 'audio.state', state: 'listening' }),
          ),
        );
        expect(openai).toHaveLength(1);
        expect(gemini).toHaveLength(0);
        expect(openai[0]!.url).toContain(`model=${DEFAULT_OPENAI_REALTIME_MODELS[layer]}`);
        expect(openai[0]!.opts.headers['Authorization']).toBe('Bearer o-key');
        // hands-free is gated by the address word: the provider must not answer on its own.
        const update = openai[0]!.sent[0] as {
          session: { audio: { input: { turn_detection: { create_response: boolean } } } };
        };
        expect(update.session.audio.input.turn_detection.create_response).toBe(mode === 'call');
        surface.ws.close();
      });
    }

    test(`${mode} on openai with no key is refused as voice_key_missing — never local`, async () => {
      const s = await start({ [key]: { backend: 'openai', layer: 'light' } }, { gemini: true });
      const surface = await openSurface(s.port, `o-nokey-${mode}`, 'voice-call', mode);
      await surface.closed;
      const label = mode === 'call' ? 'Call' : 'Hands-free';
      expect(surface.events).toEqual([
        {
          type: 'audio.error',
          code: 'voice_key_missing',
          message:
            `${label} is set to openai, but OPENAI_REALTIME_API_KEY is not set on this host. ` +
            `Switch ${label} to another backend in Settings → Voice.`,
        },
      ]);
      expect(openai).toHaveLength(0);
    });

    test(`${mode} on local/light is refused — no local front model`, async () => {
      const s = await start({ [key]: { backend: 'local', layer: 'light' } });
      const surface = await openSurface(s.port, `l-light-${mode}`, 'voice-call', mode);
      await surface.closed;
      expect(surface.events[0]).toMatchObject({
        type: 'audio.error',
        code: 'voice_config_not_implemented',
      });
    });
  }

  test('an OpenAI session whose provider hangs up ends the surface session loudly', async () => {
    const s = await start({ call: { backend: 'openai', layer: 'light' } });
    const surface = await openSurface(s.port, 'o-drop', 'voice-call', 'call');
    await until(() => expect(openai).toHaveLength(1));
    await until(() =>
      expect(surface.events).toContainEqual(
        expect.objectContaining({ type: 'audio.state', state: 'listening' }),
      ),
    );
    openai[0]!.emit('close', 1011, Buffer.from('server error'));
    const code = await surface.closed;
    expect(code).toBe(4400);
    expect(surface.events).toContainEqual(
      expect.objectContaining({
        type: 'audio.error',
        code: 'openai_unavailable',
        message: expect.stringContaining('1011'),
      }),
    );
  });

  test('a Gemini session whose provider hangs up ends the surface session loudly', async () => {
    const s = await start({ call: { backend: 'gemini', layer: 'light' } });
    const surface = await openSurface(s.port, 'g-drop', 'voice-call', 'call');
    await until(() =>
      expect(surface.events).toContainEqual(
        expect.objectContaining({ type: 'audio.state', state: 'listening' }),
      ),
    );
    gemini[0]!.emit('close', 1008, Buffer.from('quota'));
    expect(await surface.closed).toBe(4400);
    expect(surface.events).toContainEqual(
      expect.objectContaining({ type: 'audio.error', code: 'gemini_unavailable' }),
    );
  });

  test('switching mode in place across engines is refused; the session keeps its mode', async () => {
    const s = await start({
      call: { backend: 'openai', layer: 'light' },
      handsFree: { backend: 'local', layer: 'direct' },
    });
    const surface = await openSurface(s.port, 'mix-1', 'voice-call', 'call');
    await until(() => expect(openai).toHaveLength(1));
    surface.ws.send(encodeAudio({ type: 'audio.mode', sessionId: 'mix-1', mode: 'hands-free' }));
    await until(() =>
      expect(surface.events).toContainEqual(
        expect.objectContaining({ type: 'audio.error', code: 'voice_config_not_implemented' }),
      ),
    );
    // No session.update for the new mode ever went to the provider.
    expect(openai[0]!.sent.filter((m) => m['type'] === 'session.update')).toHaveLength(1);
    surface.ws.close();
  });

  test('switching mode in place on the same engine flips the provider turn detection', async () => {
    const s = await start({
      call: { backend: 'openai', layer: 'light' },
      handsFree: { backend: 'openai', layer: 'light' },
    });
    const surface = await openSurface(s.port, 'same-1', 'voice-call', 'call');
    await until(() =>
      expect(surface.events).toContainEqual(
        expect.objectContaining({ type: 'audio.state', state: 'listening' }),
      ),
    );
    surface.ws.send(encodeAudio({ type: 'audio.mode', sessionId: 'same-1', mode: 'hands-free' }));
    await until(() =>
      expect(openai[0]!.sent.filter((m) => m['type'] === 'session.update')).toHaveLength(2),
    );
    expect(surface.events.some((e) => e.type === 'audio.error')).toBe(false);
    surface.ws.close();
  });

  test('a device on openai is refused — no hosted device path yet', async () => {
    const s = await start({ device: { backend: 'openai', layer: 'light' } });
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/audio/dev-1`);
    const events: AudioEvent[] = [];
    ws.on('message', (d: Buffer) => events.push(decodeAudio(d)));
    await new Promise<void>((r) => ws.once('open', () => r()));
    ws.send(
      encodeAudio({
        type: 'audio.session_start',
        sessionId: 'dev-1',
        accountId: 'a',
        surfaceId: 'device-kitchen',
        surfaceKind: 'device',
        deviceId: 'device-kitchen',
        chatId: 'c1',
        role: 'voice-device-conv',
        token: mintToken('dev-1', 'device-kitchen'),
        surfaceHasAec: false,
      }),
    );
    await new Promise<void>((r) => ws.once('close', () => r()));
    expect(events[0], JSON.stringify(events[0])).toMatchObject({
      type: 'audio.error',
      code: 'voice_config_not_implemented',
    });
    expect(openai).toHaveLength(0);
  });
});

describe('closeReason', () => {
  test('caps a close reason at 123 bytes on a character boundary', () => {
    const msg = `${'x'.repeat(121)}→ tail`;
    const reason = closeReason(msg);
    expect(Buffer.byteLength(reason, 'utf8')).toBeLessThanOrEqual(123);
    expect(reason).toBe('x'.repeat(121));
    expect(closeReason('short → fine')).toBe('short → fine');
  });
});
