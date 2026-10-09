// A1-17 regression — the voice session's TTS down leg.
//
// The failing behaviour: four real voice turns, each with a real assistant
// reply in history, received ZERO `audio.tts_chunk` frames. `audio.tts_end`
// arrived with nothing before it, there was no `audio.state: speaking`, and no
// error frame — a totally silent failure.
//
// Root cause (see src/audio/replyBridge.ts): the host read a voice turn's
// reply off its own event stream and settled the waiter on the FIRST
// `chat.state {activity:'idle'}` it saw after accepting the input. chatRunner
// emits idle `chat.state` frames BEFORE the SDK query starts — `sendInput`
// clears the stale status summary, `runQuery` captures the chat preview. Both
// resolved the reply promise instantly with an empty string and tore down the
// streaming sink, so every assistant delta was dropped and there was nothing
// to synthesise.
//
// These tests drive (1) the bridge against chatRunner's REAL emission
// ordering, and (2) the REAL audio WSS with a `submitUserTurn` wired through
// the REAL bridge, asserting binary TTS frames land on the wire. The second
// group uses the real Kokoro sidecar when one is reachable on the standard
// loopback port. NO audio is ever played — PCM values only.

import { describe, test, expect, afterEach } from 'vitest';
import pino from 'pino';
import { createHmac } from 'node:crypto';
import { WebSocket } from 'ws';
import type { WireEvent } from '@patch/wire';
import { encodeAudio, decodeAudio, type AudioEvent } from '@patch/wire/audio';
import { startAudioServer, type AudioServerHandle } from '../src/audio/server.js';
import { createVoiceReplyBridge } from '../src/audio/replyBridge.js';
import { createWhisper, type WhisperBackend } from '../src/audio/whisper.js';
import { createKokoro, type KokoroBackend } from '../src/audio/kokoro.js';
import { MockVad, type Vad, type VadFrameResult } from '../src/audio/vad.js';

const SECRET = 'a117-internal-token-aaaaaaaaaaaaaaaa';
const logger = pino({ level: 'silent' });
const CHAT = 'chat-a117';

// --------------------------------------------------------------------------
// The exact `chat.state` / `chat.message` sequence chatRunner emits for a turn.
// --------------------------------------------------------------------------

function stateEvent(activity: 'idle' | 'running' | 'errored'): WireEvent {
  return {
    type: 'chat.state',
    chatId: CHAT,
    daemonId: 'host-a',
    activity,
    permissionMode: 'bypassPermissions',
    lastUpdated: Date.now(),
    pinned: false,
    pinnedAt: null,
    status: 'active',
    name: null,
    preview: null,
    folder: '/tmp/a117',
  } as WireEvent;
}

function assistantMessage(content: string, seq: number): WireEvent {
  return { type: 'chat.message', chatId: CHAT, role: 'assistant', content, seq } as WireEvent;
}

function delta(text: string, seq: number): WireEvent {
  return { type: 'chat.message_delta', chatId: CHAT, messageSeq: seq, delta: text } as WireEvent;
}

/**
 * Replay a realistic turn: the pre-run idle emissions chatRunner really makes
 * (status-summary clear in `sendInput`, preview capture in `runQuery`), then
 * running → deltas → the durable assistant message → idle.
 */
async function replayTurn(
  emit: (e: WireEvent) => void,
  reply: string,
  opts: { deltas?: boolean } = {},
): Promise<void> {
  emit({ type: 'chat.input_ack', chatId: CHAT, localId: 'l1' } as WireEvent);
  // >>> The two frames that used to resolve the reply promise with '' <<<
  emit(stateEvent('idle')); // sendInput: stale statusSummary cleared
  emit(stateEvent('idle')); // runQuery: preview captured
  await new Promise((r) => setTimeout(r, 5));
  emit(stateEvent('running'));
  if (opts.deltas !== false) {
    for (const piece of reply.match(/.{1,12}/gs) ?? []) {
      emit(delta(piece, 7));
      await new Promise((r) => setTimeout(r, 1));
    }
  }
  if (reply.length > 0) emit(assistantMessage(reply, 7));
  emit(stateEvent('idle'));
}

describe('A1-17 — voice reply bridge (root cause)', () => {
  test('an idle chat.state emitted BEFORE the turn starts does not settle the reply', async () => {
    const bridge = createVoiceReplyBridge();
    const chunks: string[] = [];
    const promise = bridge.awaitReply(CHAT, (c) => chunks.push(c));
    let settled = false;
    void promise.then(() => {
      settled = true;
    });

    bridge.observe(stateEvent('idle'));
    bridge.observe(stateEvent('idle'));
    await new Promise((r) => setTimeout(r, 10));
    // Pre-fix this was already resolved with ''.
    expect(settled).toBe(false);
    expect(bridge.pendingCount()).toBe(1);

    bridge.observe(stateEvent('running'));
    bridge.observe(delta('Ban', 7));
    bridge.observe(delta('ana.', 7));
    bridge.observe(assistantMessage('Banana.', 7));
    bridge.observe(stateEvent('idle'));

    await expect(promise).resolves.toBe('Banana.');
    expect(chunks.join('')).toBe('Banana.');
    expect(bridge.pendingCount()).toBe(0);
  });

  test('deltas emitted before the turn arms are not fed to the session', async () => {
    const bridge = createVoiceReplyBridge();
    const chunks: string[] = [];
    const promise = bridge.awaitReply(CHAT, (c) => chunks.push(c));
    // Tail of a PREVIOUS turn still draining while this one is queued.
    bridge.observe(delta('leftover', 6));
    bridge.observe(assistantMessage('previous turn reply', 6));
    bridge.observe(stateEvent('running'));
    bridge.observe(delta('mine', 7));
    bridge.observe(assistantMessage('mine', 7));
    bridge.observe(stateEvent('idle'));
    await expect(promise).resolves.toBe('mine');
    expect(chunks).toEqual(['mine']);
  });

  test('a failing turn rejects rather than resolving empty', async () => {
    const bridge = createVoiceReplyBridge();
    const promise = bridge.awaitReply(CHAT);
    bridge.observe({
      type: 'chat.error',
      chatId: CHAT,
      error: { code: 'sdk_error', message: 'boom' },
      seq: -1,
    } as WireEvent);
    await expect(promise).rejects.toThrow('boom');
  });

  test('abandon fails the waiter loudly when the input never ran', async () => {
    const bridge = createVoiceReplyBridge();
    const promise = bridge.awaitReply(CHAT);
    bridge.abandon(CHAT, new Error('chat not found'));
    await expect(promise).rejects.toThrow('chat not found');
    expect(bridge.pendingCount()).toBe(0);
  });
});

// --------------------------------------------------------------------------
// Over the real audio WSS.
// --------------------------------------------------------------------------

function mintToken(c: {
  accountId: string;
  surfaceId: string;
  sessionId: string;
  chatId: string;
}): string {
  const obj = { ...c, exp: Date.now() + 60_000, jti: `jti-${Math.random().toString(36).slice(2)}` };
  const b = Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
  const sig = createHmac('sha256', SECRET).update(b).digest().toString('base64url');
  return `${b}.${sig}`;
}

/** VAD scripted per fed frame: speech … then one utterance_end. */
class ScriptedVad implements Vad {
  private i = 0;
  constructor(private readonly script: VadFrameResult['event'][]) {}
  async feed(): Promise<VadFrameResult> {
    const event = this.script[this.i] ?? null;
    this.i++;
    return { prob: event === 'utterance_end' ? 0 : 1, event, state: 'speech' };
  }
  reset(): void {
    this.i = 0;
  }
  async close(): Promise<void> {}
}

/**
 * The real Kokoro sidecar if one is listening on the standard loopback port
 * (the live rig owns it), otherwise the host's own real backend would try to
 * spawn one — which is not this test's job. `kokoroReachable` decides.
 */
const KOKORO_URL = 'ws://127.0.0.1:5019';

async function kokoroReachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = new WebSocket(KOKORO_URL);
    const done = (ok: boolean): void => {
      try {
        probe.close();
      } catch {
        /* already closed */
      }
      resolve(ok);
    };
    probe.once('open', () => done(true));
    probe.once('error', () => done(false));
    setTimeout(() => done(false), 1500);
  });
}

type Handle = AudioServerHandle & { port: number };
const openHandles: Handle[] = [];

async function startServer(o: {
  kokoro: KokoroBackend;
  reply: string;
  deltas?: boolean;
  vad?: () => Vad;
  whisper?: WhisperBackend;
}): Promise<Handle> {
  // The REAL bridge, driven by the REAL chatRunner emission ordering.
  const bridge = createVoiceReplyBridge();
  const handle = await startAudioServer({
    host: '127.0.0.1',
    port: 0,
    logger,
    internalToken: SECRET,
    whisper: o.whisper ?? createWhisper({ backend: 'mock', logger }),
    kokoro: o.kokoro,
    makeVad: o.vad ?? ((): Vad => new MockVad()),
    chatExists: (): boolean => true,
    submitUserTurn: async ({ chatId, onReplyText }) => {
      expect(chatId).toBe(CHAT);
      const promise = bridge.awaitReply(chatId, onReplyText);
      await replayTurn((e) => bridge.observe(e), o.reply, { deltas: o.deltas !== false });
      return promise;
    },
  });
  const h = Object.assign(handle, { port: handle.address().port });
  openHandles.push(h);
  return h;
}

async function openWs(port: number, sessionId: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/audio/${sessionId}`);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return ws;
}

interface Frame {
  binary: boolean;
  bytes?: number;
  event?: AudioEvent;
}

function record(ws: WebSocket, frames: Frame[]): void {
  ws.on('message', (data: Buffer | string, isBinary: boolean) => {
    if (isBinary) {
      frames.push({ binary: true, bytes: (data as Buffer).byteLength });
    } else {
      frames.push({ binary: false, event: decodeAudio(data as string | Buffer) });
    }
  });
}

async function waitFor(pred: () => boolean, timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

function startSession(ws: WebSocket, sessionId: string): void {
  ws.send(
    encodeAudio({
      type: 'audio.session_start',
      sessionId,
      accountId: 'acct-a117',
      surfaceId: 'surf-a117',
      surfaceKind: 'web',
      chatId: CHAT,
      role: 'voice-call',
      token: mintToken({
        accountId: 'acct-a117',
        surfaceId: 'surf-a117',
        sessionId,
        chatId: CHAT,
      }),
      surfaceHasAec: true,
    }),
  );
}

function sendPcm(ws: WebSocket, samples = 480): void {
  ws.send(encodeAudio({ type: 'audio.pcm16', ts: Date.now(), sampleRate: 16000, samples }));
  const pcm = new Int16Array(samples);
  for (let i = 0; i < samples; i++) pcm[i] = Math.round(6000 * Math.sin(i / 6));
  ws.send(Buffer.from(pcm.buffer), { binary: true });
}

afterEach(async () => {
  while (openHandles.length > 0) {
    const h = openHandles.pop();
    await h?.close().catch(() => undefined);
  }
});

describe('A1-17 — TTS down leg over the real audio WSS', () => {
  test('a real voice turn emits binary audio.tts_chunk frames before tts_end', async () => {
    const useReal = await kokoroReachable();
    const kokoro = useReal
      ? createKokoro({ backend: 'real', logger, sidecarUrl: KOKORO_URL })
      : createKokoro({ backend: 'mock', logger });
    const handle = await startServer({
      kokoro,
      reply: 'Banana. Testing one two three.',
      vad: (): Vad => new ScriptedVad(['utterance_start', null, 'utterance_end']),
    });
    const sessionId = 'sess-a117-1';
    const ws = await openWs(handle.port, sessionId);
    const frames: Frame[] = [];
    record(ws, frames);
    startSession(ws, sessionId);
    await waitFor(() => frames.length > 0, 2000);

    // One utterance: MockVad fires utterance_start / …/ utterance_end across
    // successive fed frames.
    sendPcm(ws);
    sendPcm(ws);
    sendPcm(ws);

    await waitFor(() => frames.some((f) => f.event?.type === 'audio.tts_end'));

    const types = frames.filter((f) => !f.binary).map((f) => f.event!.type);
    const binaries = frames.filter((f) => f.binary);
    const chunkEnvelopes = frames.filter((f) => f.event?.type === 'audio.tts_chunk');

    // THE regression: audio actually flows, and it flows as BINARY frames.
    expect(binaries.length).toBeGreaterThan(0);
    expect(chunkEnvelopes.length).toBeGreaterThan(0);
    expect(binaries.every((f) => (f.bytes ?? 0) % 2 === 0)).toBe(true);
    // Every binary frame precedes the closing tts_end.
    const endIdx = frames.findIndex((f) => f.event?.type === 'audio.tts_end');
    const lastBinaryIdx = frames.map((f) => f.binary).lastIndexOf(true);
    expect(lastBinaryIdx).toBeLessThan(endIdx);
    // The session announced it was speaking, and never reported an error.
    expect(types).toContain('audio.state');
    expect(
      frames.some((f) => f.event?.type === 'audio.state' && f.event.state === 'speaking'),
    ).toBe(true);
    expect(types).not.toContain('audio.error');
    // Audio frames NEVER carry a seq (spec/03 — audio is never replayed).
    for (const f of frames) {
      if (!f.binary) expect(f.event).not.toHaveProperty('seq');
    }
    ws.close();
  }, 45_000);

  test('a turn whose reply never arrives errors loudly instead of a silent tts_end', async () => {
    const handle = await startServer({
      kokoro: createKokoro({ backend: 'mock', logger }),
      reply: '', // turn settles with no assistant text at all
      deltas: false,
      vad: (): Vad => new ScriptedVad(['utterance_start', null, 'utterance_end']),
    });
    const sessionId = 'sess-a117-2';
    const ws = await openWs(handle.port, sessionId);
    const frames: Frame[] = [];
    record(ws, frames);
    startSession(ws, sessionId);
    await waitFor(() => frames.length > 0, 2000);
    sendPcm(ws);
    sendPcm(ws);
    sendPcm(ws);

    await waitFor(() => frames.some((f) => f.event?.type === 'audio.tts_end'), 10_000);

    const err = frames.find((f) => f.event?.type === 'audio.error');
    expect(err, 'a silent tts_end with no audio must never happen').toBeDefined();
    expect(err!.event).toMatchObject({ type: 'audio.error', code: 'sdk_error' });
    // The error precedes the closing tts_end.
    const errIdx = frames.indexOf(err!);
    const endIdx = frames.findIndex((f) => f.event?.type === 'audio.tts_end');
    expect(errIdx).toBeLessThan(endIdx);
    ws.close();
  }, 20_000);
});

describe('A1 — audio.transcript_partial (live STT of the utterance in flight)', () => {
  test('a backend that does not offer partials emits none — it does not fake them', async () => {
    // A live transcript costs one extra transcription request per pass, so it
    // is per-backend: only one that can absorb that (and keep quota back for
    // the final) declares it. Everything else stays quiet until the end rather
    // than inventing text.
    const handle = await startServer({
      kokoro: createKokoro({ backend: 'mock', logger }),
      reply: 'ok',
      // Never fires utterance_end — the user is still talking.
      vad: (): Vad => new ScriptedVad(['utterance_start']),
    });
    const sessionId = 'sess-a117-partial';
    const ws = await openWs(handle.port, sessionId);
    const frames: Frame[] = [];
    record(ws, frames);
    startSession(ws, sessionId);
    await waitFor(() => frames.length > 0, 2000);

    // 0.5 s, then 1.0 s more, then 1.0 s more of mic audio @ 16 kHz — well past
    // what used to trigger three separate prefix transcriptions.
    for (const samples of [8000, 16000, 16000]) {
      sendPcm(ws, samples);
      await new Promise((r) => setTimeout(r, 400));
    }

    expect(frames.filter((f) => f.event?.type === 'audio.transcript_partial')).toHaveLength(0);
    // And still no final — the utterance has not ended.
    expect(frames.some((f) => f.event?.type === 'audio.transcript_final')).toBe(false);
    ws.close();
  }, 30_000);

  test('a backend that offers partials gets them through', async () => {
    // The gate is the backend's own declaration: wire up one that offers
    // partials and the live transcript paints as the utterance grows.
    const streaming: WhisperBackend = {
      supportsLivePartials: true,
      calls: 0,
      async transcribe() {
        this.calls += 1;
        return `prefix ${this.calls}`;
      },
      async transcribeClip() {
        return '';
      },
      async close() {},
    } as unknown as WhisperBackend;
    const handle = await startServer({
      kokoro: createKokoro({ backend: 'mock', logger }),
      reply: 'ok',
      vad: (): Vad => new ScriptedVad(['utterance_start']),
      whisper: streaming,
    });
    const sessionId = 'sess-a117-partial-streaming';
    const ws = await openWs(handle.port, sessionId);
    const frames: Frame[] = [];
    record(ws, frames);
    startSession(ws, sessionId);
    await waitFor(() => frames.length > 0, 2000);

    for (const samples of [8000, 16000, 16000]) {
      sendPcm(ws, samples);
      await waitFor(
        () => frames.filter((f) => f.event?.type === 'audio.transcript_partial').length > 0,
        3000,
      );
      await new Promise((r) => setTimeout(r, 120));
    }

    const partials = frames
      .filter((f) => f.event?.type === 'audio.transcript_partial')
      .map((f) => (f.event as { text: string }).text);
    expect(partials.length).toBeGreaterThanOrEqual(2);
    expect(new Set(partials).size).toBe(partials.length);
    expect(frames.some((f) => f.event?.type === 'audio.transcript_final')).toBe(false);
    ws.close();
  }, 30_000);
});

describe('A1 — audio.session_end accepts the spec-documented payload', () => {
  test('{reason} with no sessionId is accepted and ends the session', async () => {
    const handle = await startServer({
      kokoro: createKokoro({ backend: 'mock', logger }),
      reply: 'unused',
      vad: (): Vad => new ScriptedVad([]),
    });
    const sessionId = 'sess-a117-3';
    const ws = await openWs(handle.port, sessionId);
    const frames: Frame[] = [];
    record(ws, frames);
    let closeCode = 0;
    ws.on('close', (code) => {
      closeCode = code;
    });
    startSession(ws, sessionId);
    await waitFor(() => frames.length > 0, 2000);

    // EXACTLY what spec/03-wire-protocol.md documents: `{reason}`.
    ws.send(JSON.stringify({ type: 'audio.session_end', reason: 'committed' }));
    await waitFor(() => closeCode !== 0, 5000);

    expect(frames.some((f) => f.event?.type === 'audio.error')).toBe(false);
    expect(closeCode).not.toBe(4400);
  }, 20_000);

  test('a session_end naming a DIFFERENT session is refused', async () => {
    const handle = await startServer({
      kokoro: createKokoro({ backend: 'mock', logger }),
      reply: 'unused',
      vad: (): Vad => new ScriptedVad([]),
    });
    const sessionId = 'sess-a117-4';
    const ws = await openWs(handle.port, sessionId);
    const frames: Frame[] = [];
    record(ws, frames);
    startSession(ws, sessionId);
    await waitFor(() => frames.length > 0, 2000);

    ws.send(JSON.stringify({ type: 'audio.session_end', sessionId: 'someone-else', reason: 'x' }));
    await waitFor(() => frames.some((f) => f.event?.type === 'audio.error'), 5000);
    expect(frames.find((f) => f.event?.type === 'audio.error')!.event).toMatchObject({
      code: 'invalid_frame',
    });
  }, 20_000);
});
