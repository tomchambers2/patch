// TE1 — voice host pipeline end-to-end behaviour gate (group E1).
//
// Each test maps directly to a plan-encoded TE1 behaviour (E1-1 .. E1-10) and
// drives the REAL audio WSS over real WebSocket connections, with a recording
// `submitUserTurn` that captures the exact user-turn text the host would
// commit to chat history (so we can assert the `[voice • <surface>]` prefix is
// ordinary turn TEXT, not a system prompt). NO audio is ever played — we
// inspect PCM frames and control envelopes only.
//
// E1-7 (mint endpoint refuses unauthenticated callers) lives in the server
// package's voice-token.test.ts, which drives the real Fastify route.

import { describe, test, expect, afterEach } from 'vitest';
import pino from 'pino';
import { createHmac } from 'node:crypto';
import { WebSocket } from 'ws';
import { startAudioServer, type AudioServerHandle } from '../src/audio/server.js';
import { createWhisper, validateWhisperCredentials } from '../src/audio/whisper.js';
import {
  createKokoro,
  validateKokoroModel,
  type KokoroBackend,
  type KokoroSynthesis,
} from '../src/audio/kokoro.js';
import { encodeAudio, decodeAudio, type AudioEvent } from '@patch/wire/audio';
import { MockVad, type Vad, type VadFrameResult } from '../src/audio/vad.js';

const SECRET = 'te1-internal-token-aaaaaaaaaaaaaaaa';
const logger = pino({ level: 'silent' });

interface RecordedTurn {
  chatId: string;
  text: string; // the exact text that would be committed as the user turn
  surface: string;
}

function mintToken(c: {
  accountId: string;
  surfaceId: string;
  sessionId: string;
  chatId?: string;
  exp?: number;
  jti?: string;
}): string {
  const obj = {
    accountId: c.accountId,
    surfaceId: c.surfaceId,
    sessionId: c.sessionId,
    chatId: c.chatId ?? 'c',
    exp: c.exp ?? Date.now() + 60_000,
    jti: c.jti ?? `jti-${Math.random().toString(36).slice(2)}`,
  };
  const b = Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
  const sig = createHmac('sha256', SECRET).update(b).digest().toString('base64url');
  return `${b}.${sig}`;
}

/**
 * A VAD whose transitions are scripted per fed frame; lets us deterministically
 * produce one utterance (start, …, end) or fire a barge-in mid-speaking.
 */
class ScriptedVad implements Vad {
  private i = 0;
  constructor(private readonly script: VadFrameResult['event'][]) {}
  async feed(): Promise<VadFrameResult> {
    const event = this.script[this.i] ?? null;
    this.i++;
    const state = event === 'utterance_end' ? 'silence' : 'speech';
    return { prob: event === 'utterance_end' ? 0 : 1, event, state };
  }
  reset(): void {
    this.i = 0;
  }
  async close(): Promise<void> {}
}

/**
 * A Kokoro backend that streams `chunks` frames with a per-frame delay, so the
 * session stays in `speaking` long enough for an over-the-wire barge-in frame
 * to land mid-stream. cancel() stops the stream (drops in-flight audio).
 */
function slowKokoro(chunks: number, delayMs: number): KokoroBackend {
  return {
    async synthesize(): Promise<KokoroSynthesis> {
      let cancelled = false;
      async function* gen(): AsyncIterableIterator<{ pcm: Int16Array; first: boolean }> {
        for (let i = 0; i < chunks; i++) {
          if (cancelled) return;
          await new Promise((r) => setTimeout(r, delayMs));
          if (cancelled) return;
          const pcm = new Int16Array(240);
          pcm[0] = i + 1;
          yield { pcm, first: i === 0 };
        }
      }
      return {
        iterator: gen(),
        async cancel(): Promise<void> {
          cancelled = true;
        },
      };
    },
    isReady: () => true,
    async close(): Promise<void> {},
  };
}

type Handle = AudioServerHandle & { port: number };

async function startServer(opts: {
  makeVad?: () => Vad;
  reply?: string;
  cap?: number;
  recorded?: RecordedTurn[];
  kokoro?: KokoroBackend;
}): Promise<Handle> {
  const handle = await startAudioServer({
    host: '127.0.0.1',
    port: 0,
    logger,
    internalToken: SECRET,
    whisper: createWhisper({ backend: 'mock', logger }),
    kokoro: opts.kokoro ?? createKokoro({ backend: 'mock', logger }),
    makeVad: opts.makeVad ?? ((): Vad => new MockVad()),
    submitUserTurn: async ({ chatId, message, source }) => {
      // Mirror the host's real prefixing (index.ts submitUserTurn): the voice
      // prefix is prepended to the message TEXT — exactly what gets committed
      // as the user turn. NOT a system prompt.
      const prefix =
        source.kind === 'voice-device'
          ? `[voice • device:${source.deviceId}] `
          : `[voice • ${source.surfaceKind}] `;
      const surface = source.kind === 'voice-device' ? 'device' : source.surfaceKind;
      opts.recorded?.push({ chatId, text: `${prefix}${message}`, surface });
      return opts.reply ?? 'mock reply';
    },
    // This is a happy-path pipeline harness: treat every chat as existing.
    chatExists: (): boolean => true,
    ...(opts.cap !== undefined ? { maxConcurrentSessions: opts.cap } : {}),
  });
  return Object.assign(handle, { port: handle.address().port });
}

async function open(port: number, sessionId: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/audio/${sessionId}`);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return ws;
}

function start(
  ws: WebSocket,
  o: {
    sessionId: string;
    accountId: string;
    surfaceId: string;
    surfaceKind: 'web' | 'desktop' | 'mobile' | 'device';
    chatId: string;
    token: string;
    deviceId?: string;
    role?: 'voice-note' | 'voice-call' | 'voice-device-conv';
  },
): void {
  ws.send(
    encodeAudio({
      type: 'audio.session_start',
      sessionId: o.sessionId,
      accountId: o.accountId,
      surfaceId: o.surfaceId,
      surfaceKind: o.surfaceKind,
      chatId: o.chatId,
      role: o.role ?? 'voice-call',
      token: o.token,
      surfaceHasAec: o.surfaceKind === 'web' || o.surfaceKind === 'mobile',
      ...(o.deviceId !== undefined ? { deviceId: o.deviceId } : {}),
    }),
  );
}

/** Send a PCM control frame + a binary frame (drives one VAD step). */
function sendPcm(ws: WebSocket, samples = 480): void {
  ws.send(encodeAudio({ type: 'audio.pcm16', ts: Date.now(), sampleRate: 16000, samples }));
  // 16-bit speech-shaped payload (non-zero so the real VAD path is exercised
  // when a ScriptedVad isn't in use).
  const pcm = new Int16Array(samples);
  for (let i = 0; i < samples; i++) pcm[i] = Math.round(6000 * Math.sin(i / 6));
  ws.send(Buffer.from(pcm.buffer), { binary: true });
}

/** Collect audio events until `pred` is satisfied or timeout. */
async function collectUntil(
  ws: WebSocket,
  pred: (evs: AudioEvent[], binaryCount: number) => boolean,
  timeoutMs = 3000,
): Promise<{ events: AudioEvent[]; binaryCount: number }> {
  const events: AudioEvent[] = [];
  let binaryCount = 0;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve({ events, binaryCount });
    }, timeoutMs);
    const onMsg = (data: Buffer | string, isBinary: boolean): void => {
      if (isBinary) {
        binaryCount++;
      } else {
        try {
          events.push(decodeAudio(data as string | Buffer));
        } catch {
          /* ignore */
        }
      }
      if (pred(events, binaryCount)) {
        cleanup();
        resolve({ events, binaryCount });
      }
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      ws.off('message', onMsg);
    };
    ws.on('message', onMsg);
    ws.once('error', (e) => {
      cleanup();
      reject(e as Error);
    });
  });
}

describe('TE1 voice host pipeline e2e', () => {
  let server: Handle | undefined;
  afterEach(async () => {
    if (server) await server.close();
    server = undefined;
  });

  test('E1-1: utterance lands as a USER turn in the focused chat, tagged [voice • web] in the turn TEXT', async () => {
    const recorded: RecordedTurn[] = [];
    server = await startServer({
      recorded,
      makeVad: () => new ScriptedVad(['utterance_start', 'utterance_end']),
    });
    const sid = 'e1-1';
    const ws = await open(server.port, sid);
    start(ws, {
      sessionId: sid,
      accountId: 'acct',
      surfaceId: 'surf-web',
      surfaceKind: 'web',
      chatId: 'chat-A',
      token: mintToken({
        accountId: 'acct',
        surfaceId: 'surf-web',
        sessionId: sid,
        chatId: 'chat-A',
      }),
    });
    const got = collectUntil(ws, (evs) => evs.some((e) => e.type === 'audio.transcript_final'));
    sendPcm(ws); // utterance_start
    sendPcm(ws); // utterance_end → runs the turn
    await got;
    ws.close();

    expect(recorded.length).toBe(1);
    const turn = recorded[0]!;
    expect(turn.chatId).toBe('chat-A');
    // The mock STT yields a deterministic transcript; the recorded text is the
    // voice prefix PREPENDED to it — ordinary turn text, not a system prompt.
    expect(turn.text.startsWith('[voice • web] ')).toBe(true);
    expect(turn.text).toMatch(/\[mock-transcript \d+ms\]/);
  });

  test('E1-2: Kokoro TTS streams back as binary PCM frames bracketed by transcript_final → tts_chunk(s) → tts_end', async () => {
    server = await startServer({
      reply: 'this is the spoken reply',
      makeVad: () => new ScriptedVad(['utterance_start', 'utterance_end']),
    });
    const sid = 'e1-2';
    const ws = await open(server.port, sid);
    start(ws, {
      sessionId: sid,
      accountId: 'acct',
      surfaceId: 'surf-web',
      surfaceKind: 'web',
      chatId: 'c',
      token: mintToken({ accountId: 'acct', surfaceId: 'surf-web', sessionId: sid }),
    });
    const got = collectUntil(ws, (evs) => evs.some((e) => e.type === 'audio.tts_end'), 4000);
    sendPcm(ws);
    sendPcm(ws);
    const { events, binaryCount } = await got;
    ws.close();

    const types = events.map((e) => e.type);
    expect(types).toContain('audio.transcript_final');
    expect(types).toContain('audio.tts_chunk');
    expect(types).toContain('audio.tts_end');
    // Ordering: transcript_final precedes the first tts_chunk.
    expect(types.indexOf('audio.transcript_final')).toBeLessThan(types.indexOf('audio.tts_chunk'));
    // Real binary PCM frames were streamed back (not just control envelopes).
    expect(binaryCount).toBeGreaterThan(0);
    const end = events.find((e) => e.type === 'audio.tts_end');
    expect(end && end.type === 'audio.tts_end' ? end.bargedIn : true).not.toBe(true);
  });

  test('E1-3: barge-in during TTS emits audio.barge_in + tts_end{bargedIn} and the new utterance is a fresh user turn', async () => {
    const recorded: RecordedTurn[] = [];
    // Frame plan: [0] start utterance, [1] end → turn → TTS begins (speaking),
    // [2] utterance_start DURING speaking → barge-in, [3] utterance_end → 2nd turn.
    server = await startServer({
      recorded,
      reply: 'a long reply that would take a while to speak aloud to the user',
      // Stream 40 chunks @ 25 ms = ~1 s of speaking, ample time for the
      // over-the-wire barge-in frame to land mid-stream.
      kokoro: slowKokoro(40, 25),
      makeVad: () =>
        new ScriptedVad(['utterance_start', 'utterance_end', 'utterance_start', 'utterance_end']),
    });
    const sid = 'e1-3';
    const ws = await open(server.port, sid);
    start(ws, {
      sessionId: sid,
      accountId: 'acct',
      surfaceId: 'surf-web',
      surfaceKind: 'web',
      chatId: 'c',
      token: mintToken({ accountId: 'acct', surfaceId: 'surf-web', sessionId: sid }),
    });
    // First utterance → reply → TTS streaming.
    const firstTts = collectUntil(ws, (evs) => evs.some((e) => e.type === 'audio.tts_chunk'), 4000);
    sendPcm(ws);
    sendPcm(ws);
    await firstTts;
    // Now barge in while speaking, then finish the new utterance.
    const bargeAndSecond = collectUntil(
      ws,
      (evs, _bin) =>
        evs.some((e) => e.type === 'audio.barge_in') &&
        evs.filter((e) => e.type === 'audio.transcript_final').length >= 2,
      4000,
    );
    sendPcm(ws); // utterance_start during speaking → barge-in
    sendPcm(ws); // utterance_end → second turn
    const { events } = await bargeAndSecond;
    ws.close();

    expect(events.some((e) => e.type === 'audio.barge_in')).toBe(true);
    const bargedEnd = events.find((e) => e.type === 'audio.tts_end' && e.bargedIn === true);
    expect(bargedEnd).toBeDefined();
    // Two distinct user turns recorded — the barge-in utterance is its own turn.
    expect(recorded.length).toBe(2);
  });

  test('E1-4: focus-follow — same open session, second utterance lands in the NEW chat', async () => {
    const recorded: RecordedTurn[] = [];
    server = await startServer({
      recorded,
      makeVad: () =>
        new ScriptedVad(['utterance_start', 'utterance_end', 'utterance_start', 'utterance_end']),
    });
    const sid = 'e1-4';
    const surfaceId = 'surf-web-focus';
    const ws = await open(server.port, sid);
    start(ws, {
      sessionId: sid,
      accountId: 'acct',
      surfaceId,
      surfaceKind: 'web',
      chatId: 'chat-A',
      token: mintToken({ accountId: 'acct', surfaceId, sessionId: sid, chatId: 'chat-A' }),
    });
    const first = collectUntil(ws, (evs) => evs.some((e) => e.type === 'audio.transcript_final'));
    sendPcm(ws);
    sendPcm(ws);
    await first;
    expect(recorded[0]!.chatId).toBe('chat-A');

    // Drive the focus-change the way the live host does: the server WS hub
    // stamps forSurfaceId and the host calls setFocusForSurface — exercise
    // that exact entry point on the SAME open session (no reconnect, no new token).
    server.setFocusForSurface(surfaceId, 'chat-B');

    const second = collectUntil(
      ws,
      (evs) => evs.filter((e) => e.type === 'audio.transcript_final').length >= 2,
    );
    sendPcm(ws);
    sendPcm(ws);
    await second;
    ws.close();

    expect(recorded.length).toBe(2);
    expect(recorded[1]!.chatId).toBe('chat-B');
    expect(recorded[0]!.chatId).toBe('chat-A'); // first stays in A
  });

  test('E1-5: rejects no-handshake (binary first) and bad-token; accepts a correctly minted token', async () => {
    server = await startServer({});
    // (a) binary frame before session_start → invalid_frame + close.
    const w1 = await open(server.port, 'e1-5a');
    const r1 = collectUntil(w1, (evs) => evs.some((e) => e.type === 'audio.error'));
    w1.send(Buffer.alloc(64), { binary: true });
    const { events: e1 } = await r1;
    expect(e1.some((e) => e.type === 'audio.error')).toBe(true);

    // (b) bad/garbage token → auth_failed.
    const w2 = await open(server.port, 'e1-5b');
    const r2 = collectUntil(w2, (evs) => evs.some((e) => e.type === 'audio.error'));
    start(w2, {
      sessionId: 'e1-5b',
      accountId: 'a',
      surfaceId: 's',
      surfaceKind: 'web',
      chatId: 'c',
      token: 'forged.deadbeef',
    });
    const { events: e2 } = await r2;
    const err2 = e2.find((e) => e.type === 'audio.error');
    expect(err2 && err2.type === 'audio.error' ? err2.code : '').toBe('auth_failed');

    // (c) correctly minted token → session proceeds (no error frame).
    const sid = 'e1-5c';
    const w3 = await open(server.port, sid);
    start(w3, {
      sessionId: sid,
      accountId: 'a',
      surfaceId: 's',
      surfaceKind: 'web',
      chatId: 'c',
      token: mintToken({ accountId: 'a', surfaceId: 's', sessionId: sid }),
    });
    const r3 = await collectUntil(w3, () => false, 400); // wait, expect no error
    expect(r3.events.some((e) => e.type === 'audio.error')).toBe(false);
    expect(server.activeCount()).toBe(1);
    w1.close();
    w2.close();
    w3.close();
  });

  test('E1-6: voice token is single-use — replaying it on a second session is refused', async () => {
    server = await startServer({});
    const jti = 'replay-jti-1';
    const t1 = mintToken({ accountId: 'a', surfaceId: 's', sessionId: 'e1-6', jti });

    const w1 = await open(server.port, 'e1-6');
    start(w1, {
      sessionId: 'e1-6',
      accountId: 'a',
      surfaceId: 's',
      surfaceKind: 'web',
      chatId: 'c',
      token: t1,
    });
    await collectUntil(w1, () => false, 300); // first session opens cleanly
    expect(server.activeCount()).toBe(1);

    // Replay the EXACT same token (same jti, same sessionId) on a new socket.
    const w2 = await open(server.port, 'e1-6');
    const r2 = collectUntil(w2, (evs) => evs.some((e) => e.type === 'audio.error'));
    start(w2, {
      sessionId: 'e1-6',
      accountId: 'a',
      surfaceId: 's',
      surfaceKind: 'web',
      chatId: 'c',
      token: t1,
    });
    const { events } = await r2;
    const err = events.find((e) => e.type === 'audio.error');
    expect(err && err.type === 'audio.error' ? err.code : '').toBe('token_replayed');
    w1.close();
    w2.close();
  });

  test('E1-8: device session must carry a deviceId; non-device must NOT — both malformed cases rejected, correct one accepted', async () => {
    server = await startServer({});
    // (a) device without deviceId → invalid_frame.
    const w1 = await open(server.port, 'e1-8a');
    const r1 = collectUntil(w1, (evs) => evs.some((e) => e.type === 'audio.error'));
    start(w1, {
      sessionId: 'e1-8a',
      accountId: 'a',
      surfaceId: 's',
      surfaceKind: 'device',
      chatId: 'c',
      role: 'voice-device-conv',
      token: mintToken({ accountId: 'a', surfaceId: 's', sessionId: 'e1-8a' }),
    });
    const { events: e1 } = await r1;
    const err1 = e1.find((e) => e.type === 'audio.error');
    expect(err1 && err1.type === 'audio.error' ? err1.code : '').toBe('invalid_frame');

    // (b) non-device (web) WITH a deviceId → invalid_frame.
    const w2 = await open(server.port, 'e1-8b');
    const r2 = collectUntil(w2, (evs) => evs.some((e) => e.type === 'audio.error'));
    start(w2, {
      sessionId: 'e1-8b',
      accountId: 'a',
      surfaceId: 's',
      surfaceKind: 'web',
      chatId: 'c',
      deviceId: 'kitchen',
      token: mintToken({ accountId: 'a', surfaceId: 's', sessionId: 'e1-8b' }),
    });
    const { events: e2 } = await r2;
    const err2 = e2.find((e) => e.type === 'audio.error');
    expect(err2 && err2.type === 'audio.error' ? err2.code : '').toBe('invalid_frame');

    // (c) device WITH a deviceId → accepted.
    const w3 = await open(server.port, 'e1-8c');
    start(w3, {
      sessionId: 'e1-8c',
      accountId: 'a',
      surfaceId: 's',
      surfaceKind: 'device',
      chatId: 'c',
      deviceId: 'kitchen',
      role: 'voice-device-conv',
      token: mintToken({ accountId: 'a', surfaceId: 's', sessionId: 'e1-8c' }),
    });
    const r3 = await collectUntil(w3, () => false, 400);
    expect(r3.events.some((e) => e.type === 'audio.error')).toBe(false);
    w1.close();
    w2.close();
    w3.close();
  });

  test('E1-9: concurrency cap — sessions up to the cap open; the next is refused with concurrency_cap', async () => {
    const cap = 2;
    server = await startServer({ cap });
    const sockets: WebSocket[] = [];
    for (let i = 0; i < cap; i++) {
      const sid = `e1-9-${i}`;
      const w = await open(server.port, sid);
      start(w, {
        sessionId: sid,
        accountId: 'a',
        surfaceId: `s${i}`,
        surfaceKind: 'web',
        chatId: 'c',
        token: mintToken({ accountId: 'a', surfaceId: `s${i}`, sessionId: sid }),
      });
      await collectUntil(w, () => false, 200);
      sockets.push(w);
    }
    expect(server.activeCount()).toBe(cap);

    // The (cap+1)th session is refused with an explicit concurrency error.
    const over = await open(server.port, 'e1-9-over');
    const r = collectUntil(over, (evs) => evs.some((e) => e.type === 'audio.error'));
    start(over, {
      sessionId: 'e1-9-over',
      accountId: 'a',
      surfaceId: 'sover',
      surfaceKind: 'web',
      chatId: 'c',
      token: mintToken({ accountId: 'a', surfaceId: 'sover', sessionId: 'e1-9-over' }),
    });
    const { events } = await r;
    const err = events.find((e) => e.type === 'audio.error');
    expect(err && err.type === 'audio.error' ? err.code : '').toBe('concurrency_cap');
    // Existing sessions are intact.
    expect(server.activeCount()).toBe(cap);
    for (const w of sockets) w.close();
    over.close();
  });

  test('E1-10: a REAL backend with its model/credential absent fails loudly — no silent fallback', () => {
    // Whisper groq with no key.
    expect(() =>
      validateWhisperCredentials({ whisperBackend: 'groq', groqApiKey: undefined }),
    ).toThrow(/GROQ_API_KEY/);
    // Whisper local with neither URL nor model path.
    expect(() => validateWhisperCredentials({ whisperBackend: 'local' })).toThrow(
      /WHISPER_MODEL_PATH/,
    );
    // Kokoro real with an OPERATOR-named model file that is not there. (An
    // un-downloaded host-local component is a different case — see
    // audio-kokoro.test.ts — because that is the ordinary state of a machine
    // the host has only just been installed on.)
    expect(() =>
      validateKokoroModel({
        kokoroBackend: 'real',
        kokoroModelPath: '/no/such/kokoro',
        kokoroModelPathFromEnv: true,
      }),
    ).toThrow(/does not exist on disk/);
    expect(() =>
      validateKokoroModel({ kokoroBackend: 'real', kokoroModelPath: undefined }),
    ).toThrow(/no Kokoro model path resolved/);
  });
});
