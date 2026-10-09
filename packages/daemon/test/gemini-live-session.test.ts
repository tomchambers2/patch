// Native voice tier unit tests (group: native voice tier). Mocks the Gemini
// Live WebSocket entirely — no real network call in this suite (this repo
// explicitly avoids spending in automated runs). See scripts/gemini-live-smoke.mjs
// for the one real, manually-run end-to-end check against the live API.

import { describe, test, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import pino from 'pino';
import type { WebSocket as WsSocket } from 'ws';
import {
  GeminiLiveSession,
  DISPATCH_TOOL_NAME,
  DEFAULT_GEMINI_LIVE_MODEL,
  DEFAULT_GEMINI_LIVE_HEAVY_MODEL,
  geminiLiveModelFor,
  type GeminiLiveDeps,
} from '../src/audio/gemini-live.js';
import type { SessionInit, VoiceTurnSource } from '../src/audio/session.js';
import type { AudioEvent } from '@patch/wire/audio';

const logger = pino({ level: 'silent' });

/** A fake Gemini Live socket: records every outbound frame, lets tests drive inbound ones. */
class FakeGeminiWs extends EventEmitter {
  sent: string[] = [];
  closed = false;
  constructor(public readonly url: string) {
    super();
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  /** Test helper: parse every sent frame as JSON. */
  sentJson(): unknown[] {
    return this.sent.map((s) => JSON.parse(s));
  }
  /** Test helper: simulate the server delivering a message. */
  serverSend(msg: unknown): void {
    this.emit('message', JSON.stringify(msg), false);
  }
}

function makeInit(overrides: Partial<SessionInit> = {}): SessionInit {
  return {
    sessionId: 'sess-1',
    accountId: 'acct-1',
    surfaceId: 'surf-1',
    surfaceKind: 'web',
    chatId: 'chat-1',
    role: 'voice-call',
    surfaceHasAec: true,
    ...overrides,
  };
}

/** Records what a session writes into the chat timeline, in order. */
export class FakeTimeline {
  log: string[] = [];
  userSaid(chatId: string, text: string): void {
    this.log.push(`user:${chatId}:${text}`);
  }
  beginReply(chatId: string): { append(d: string): void; finish(): void } {
    let text = '';
    this.log.push(`begin:${chatId}`);
    return {
      append: (d: string) => {
        text += d;
        this.log.push(`delta:${d}`);
      },
      finish: () => {
        this.log.push(`reply:${chatId}:${text}`);
      },
    };
  }
}

/** The text of every message the host sent Gemini as a user turn, in order. */
function clientTurns(ws: FakeGeminiWs): string[] {
  return (
    ws.sentJson() as Array<{ clientContent?: { turns: Array<{ parts: Array<{ text: string }> }> } }>
  ).flatMap((f) => (f.clientContent ? [f.clientContent.turns[0]?.parts[0]?.text ?? ''] : []));
}

function makeDeps(overrides: Partial<GeminiLiveDeps> = {}): {
  deps: GeminiLiveDeps;
  audioEvents: AudioEvent[];
  binaryFrames: Int16Array[];
  lastWs: { current?: FakeGeminiWs };
  submitUserTurn: ReturnType<typeof vi.fn>;
  timeline: FakeTimeline;
} {
  const audioEvents: AudioEvent[] = [];
  const binaryFrames: Int16Array[] = [];
  const lastWs: { current?: FakeGeminiWs } = {};
  const submitUserTurn = vi.fn(async () => 'the heavy agent reply');
  const timeline = new FakeTimeline();
  const wsCtor = function (this: FakeGeminiWs, url: string): FakeGeminiWs {
    const inst = new FakeGeminiWs(url);
    lastWs.current = inst;
    return inst;
  } as unknown as new (url: string) => WsSocket;
  const deps: GeminiLiveDeps = {
    logger,
    sendAudio: (ev) => audioEvents.push(ev),
    sendBinary: (pcm) => binaryFrames.push(pcm),
    submitUserTurn: submitUserTurn as unknown as GeminiLiveDeps['submitUserTurn'],
    apiKey: 'test-key',
    wsCtor,
    timeline,
    ...overrides,
  };
  return { deps, audioEvents, binaryFrames, lastWs, submitUserTurn, timeline };
}

/** Drive a session through connect + setupComplete, returning the fake ws. */
async function openSession(
  session: GeminiLiveSession,
  lastWs: { current?: FakeGeminiWs },
): Promise<FakeGeminiWs> {
  session.onSessionStart();
  await vi.waitFor(() => expect(lastWs.current).toBeDefined());
  const ws = lastWs.current!;
  ws.emit('open');
  await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(0));
  ws.serverSend({ setupComplete: {} });
  await vi.waitFor(() => expect(session.getState()).toBe('listening'));
  return ws;
}

describe('GeminiLiveSession — connect + setup', () => {
  test('sends a setup message naming the dispatch tool and the default model', async () => {
    const { deps, lastWs } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    const [first] = ws.sentJson() as [{ setup: { model: string; tools: unknown[] } }];
    expect(first.setup.model).toBe(DEFAULT_GEMINI_LIVE_MODEL);
    const tools = first.setup.tools as Array<{ functionDeclarations: Array<{ name: string }> }>;
    expect(tools[0]?.functionDeclarations[0]?.name).toBe(DISPATCH_TOOL_NAME);
  });

  test('honours a model override', async () => {
    const { deps, lastWs } = makeDeps({ model: 'models/gemini-custom' });
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    const [first] = ws.sentJson() as [{ setup: { model: string } }];
    expect(first.setup.model).toBe('models/gemini-custom');
  });

  test('puts a briefing on the chat in the instructions, so the voice knows what the chat is from its first word', async () => {
    const getChatContext = vi.fn(async () => [
      { role: 'user' as const, text: '(This chat is titled "Train times".)' },
      { role: 'user' as const, text: '(It began with the user saying: "when is my train")' },
      { role: 'user' as const, text: 'what time is my train' },
      { role: 'model' as const, text: 'the 09:14' },
    ]);
    const { deps, lastWs } = makeDeps({ getChatContext });
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    expect(getChatContext).toHaveBeenCalledWith('chat-1');
    const [first] = ws.sentJson() as [
      { setup: { systemInstruction: { parts: Array<{ text: string }> } } },
    ];
    const instruction = first.setup.systemInstruction.parts[0]!.text;
    expect(instruction).toContain('This chat is titled "Train times"');
    expect(instruction).toContain('It began with the user saying: "when is my train"');
    expect(instruction).toContain('User: what time is my train');
    expect(instruction).toContain('Agent: the 09:14');
    // The history is not replayed as turns as well.
    expect(ws.sentJson().some((f) => 'clientContent' in (f as object))).toBe(false);
  });

  test('logs the whole briefing the voice was given, so it can be read back', async () => {
    const lines: Array<Record<string, unknown>> = [];
    const logger = {
      info: (o: Record<string, unknown>, msg: string) => lines.push({ ...o, msg }),
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    } as unknown as GeminiLiveDeps['logger'];
    const { deps, lastWs } = makeDeps({
      logger,
      getChatContext: async () => [
        { role: 'user' as const, text: '(This chat is titled "Train times".)' },
        { role: 'user' as const, text: 'what time is my train' },
      ],
    });
    await openSession(new GeminiLiveSession(makeInit(), deps), lastWs);
    const line = lines.find((l) => l['msg'] === 'gemini-live: chat briefing');
    expect(line?.['messages']).toBe(2);
    expect(String(line?.['briefing'])).toContain('Train times');
    expect(String(line?.['briefing'])).toContain('User: what time is my train');
    expect(line?.['chars']).toBe(String(line?.['briefing']).length);
  });

  test('opens with no context when getChatContext is absent — not an error', async () => {
    const { deps, lastWs } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    await expect(openSession(session, lastWs)).resolves.toBeDefined();
  });

  test('emits gemini_unavailable and never sets state=listening when the socket errors before open', async () => {
    const { deps, audioEvents, lastWs } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    session.onSessionStart();
    await vi.waitFor(() => expect(lastWs.current).toBeDefined());
    lastWs.current!.emit('error', new Error('ECONNREFUSED'));
    await vi.waitFor(() =>
      expect(
        audioEvents.some((e) => e.type === 'audio.error' && e.code === 'gemini_unavailable'),
      ).toBe(true),
    );
    expect(session.getState()).not.toBe('listening');
  });
});

describe('GeminiLiveSession — mic audio', () => {
  test('queues mic frames until setup completes, then flushes them as realtimeInput', async () => {
    const { deps, lastWs } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    session.onSessionStart();
    await vi.waitFor(() => expect(lastWs.current).toBeDefined());
    const ws = lastWs.current!;
    // Mic frame BEFORE open/setupComplete: must not be sent yet.
    const pcm = new Int16Array([1, 2, 3, 4]);
    await session.onMicFrame(pcm);
    expect(ws.sent.some((s) => s.includes('realtimeInput'))).toBe(false);
    ws.emit('open');
    await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(0));
    ws.serverSend({ setupComplete: {} });
    await vi.waitFor(() => expect(ws.sent.some((s) => s.includes('realtimeInput'))).toBe(true));
    const frame = (
      ws.sentJson() as Array<{ realtimeInput?: { audio: { data: string; mimeType: string } } }>
    ).find((f) => f.realtimeInput);
    expect(frame?.realtimeInput?.audio.mimeType).toBe('audio/pcm;rate=16000');
    const decoded = Buffer.from(frame!.realtimeInput!.audio.data, 'base64');
    expect(decoded.readInt16LE(0)).toBe(1);
    expect(decoded.readInt16LE(6)).toBe(4);
  });

  test('sends a mic frame immediately once setup is done', async () => {
    const { deps, lastWs } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    const before = ws.sent.length;
    await session.onMicFrame(new Int16Array([42]));
    expect(ws.sent.length).toBe(before + 1);
  });

  test('stats() reports mic frame/sample counts', async () => {
    const { deps, lastWs } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    await openSession(session, lastWs);
    // Rounded to 1 decimal place (mirrors VoiceSession.stats()) — use enough
    // samples that the rounding lands on a non-zero, easily-asserted value.
    await session.onMicFrame(new Int16Array(8000));
    await session.onMicFrame(new Int16Array(8000));
    const stats = session.stats();
    expect(stats.micFrames).toBe(2);
    expect(stats.micSeconds).toBeCloseTo(1.0, 5);
    expect(stats.vadEvents).toBe(0);
  });
});

describe('GeminiLiveSession — audio out + turn lifecycle', () => {
  test('forwards inlineData audio as tts_chunk/sendBinary and transitions to speaking', async () => {
    const { deps, lastWs, audioEvents, binaryFrames } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    const pcm = new Int16Array([10, 20, 30]);
    const b64 = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64');
    ws.serverSend({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm', data: b64 } }] },
      },
    });
    await vi.waitFor(() => expect(binaryFrames.length).toBe(1));
    expect(Array.from(binaryFrames[0]!)).toEqual([10, 20, 30]);
    expect(audioEvents.some((e) => e.type === 'audio.tts_chunk' && e.samples === 3)).toBe(true);
    expect(session.getState()).toBe('speaking');
  });

  test('turnComplete with accumulated input transcription emits transcript_final + tts_end and returns to listening', async () => {
    const { deps, lastWs, audioEvents } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    ws.serverSend({ serverContent: { inputTranscription: { text: 'what time ' } } });
    ws.serverSend({ serverContent: { inputTranscription: { text: 'is it' } } });
    const pcm = new Int16Array([1]);
    const b64 = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64');
    ws.serverSend({ serverContent: { modelTurn: { parts: [{ inlineData: { data: b64 } }] } } });
    ws.serverSend({ serverContent: { turnComplete: true } });
    await vi.waitFor(() =>
      expect(audioEvents.some((e) => e.type === 'audio.transcript_final')).toBe(true),
    );
    const final = audioEvents.find((e) => e.type === 'audio.transcript_final');
    expect(final && 'text' in final ? final.text : undefined).toBe('what time is it');
    expect(audioEvents.some((e) => e.type === 'audio.tts_end')).toBe(true);
    expect(session.getState()).toBe('listening');
    expect(session.stats().turns).toBe(1);
  });

  test('a turn with input but no TTS audio reports gemini_unavailable (NO SILENT FAILURES)', async () => {
    const { deps, lastWs, audioEvents } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    ws.serverSend({ serverContent: { inputTranscription: { text: 'hello' } } });
    ws.serverSend({ serverContent: { turnComplete: true } });
    await vi.waitFor(() =>
      expect(
        audioEvents.some((e) => e.type === 'audio.error' && e.code === 'gemini_unavailable'),
      ).toBe(true),
    );
  });

  test('a light-layer-only turn with no dispatch still produces exactly one transcript_final + tts_end', async () => {
    const { deps, lastWs, audioEvents, submitUserTurn } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    ws.serverSend({
      serverContent: { inputTranscription: { text: "what's the capital of France" } },
    });
    const pcm = new Int16Array([7]);
    const b64 = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64');
    ws.serverSend({ serverContent: { modelTurn: { parts: [{ inlineData: { data: b64 } }] } } });
    ws.serverSend({ serverContent: { turnComplete: true } });
    await vi.waitFor(() =>
      expect(audioEvents.filter((e) => e.type === 'audio.transcript_final').length).toBe(1),
    );
    expect(audioEvents.filter((e) => e.type === 'audio.tts_end').length).toBe(1);
    // The light layer answered this itself — no dispatch to the heavy agent.
    expect(submitUserTurn).not.toHaveBeenCalled();
  });

  test('barge-in (interrupted) emits audio.barge_in + tts_end{bargedIn:true} and returns to listening', async () => {
    const { deps, lastWs, audioEvents } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    const pcm = new Int16Array([1]);
    const b64 = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64');
    ws.serverSend({ serverContent: { modelTurn: { parts: [{ inlineData: { data: b64 } }] } } });
    await vi.waitFor(() => expect(session.getState()).toBe('speaking'));
    ws.serverSend({ serverContent: { interrupted: true } });
    await vi.waitFor(() => expect(session.getState()).toBe('listening'));
    expect(audioEvents.some((e) => e.type === 'audio.barge_in')).toBe(true);
    const end = audioEvents.find((e) => e.type === 'audio.tts_end');
    expect(end && 'bargedIn' in end ? end.bargedIn : undefined).toBe(true);
  });
});

describe('GeminiLiveSession — dispatch to the heavy agent', () => {
  test('a dispatch_to_patch tool call invokes submitUserTurn and sends the reply back as a toolResponse', async () => {
    const { deps, lastWs, submitUserTurn } = makeDeps();
    const init = makeInit({ surfaceKind: 'mobile', sessionId: 'sess-42', chatId: 'chat-42' });
    const session = new GeminiLiveSession(init, deps);
    const ws = await openSession(session, lastWs);
    ws.serverSend({
      toolCall: {
        functionCalls: [
          { id: 'call-1', name: DISPATCH_TOOL_NAME, args: { request: 'add milk to my list' } },
        ],
      },
    });
    await vi.waitFor(() => expect(submitUserTurn).toHaveBeenCalledTimes(1));
    const call = submitUserTurn.mock.calls[0]![0] as {
      chatId: string;
      message: string;
      source: VoiceTurnSource;
    };
    expect(call.chatId).toBe('chat-42');
    expect(call.message).toBe('add milk to my list');
    expect(call.source).toEqual({ kind: 'voice-app', surfaceKind: 'mobile', sessionId: 'sess-42' });
    // The call is answered at once, so nothing stays pending on Gemini's side …
    await vi.waitFor(() => expect(ws.sent.some((s) => s.includes('toolResponse'))).toBe(true));
    const started = (
      ws.sentJson() as Array<{
        toolResponse?: {
          functionResponses: Array<{
            id: string;
            name: string;
            response: { result: string; scheduling: string };
          }>;
        };
      }>
    ).find((f) => f.toolResponse);
    expect(started?.toolResponse?.functionResponses[0]).toMatchObject({
      id: 'call-1',
      name: DISPATCH_TOOL_NAME,
      response: { result: 'started', scheduling: 'WHEN_IDLE' },
    });
    // … and the agent's answer arrives later, as a message.
    await vi.waitFor(() => expect(ws.sent.some((s) => s.includes('clientContent'))).toBe(true));
    expect(clientTurns(ws)[0]).toContain('the heavy agent reply');
  });

  test('dispatches count toward stats().turns via the following turnComplete', async () => {
    const { deps, lastWs } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    ws.serverSend({ serverContent: { inputTranscription: { text: "what's my next train" } } });
    ws.serverSend({
      toolCall: {
        functionCalls: [
          { id: 'c1', name: DISPATCH_TOOL_NAME, args: { request: "what's my next train" } },
        ],
      },
    });
    await vi.waitFor(() => expect(ws.sent.some((s) => s.includes('toolResponse'))).toBe(true));
    const pcm = new Int16Array([1]);
    const b64 = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64');
    ws.serverSend({ serverContent: { modelTurn: { parts: [{ inlineData: { data: b64 } }] } } });
    ws.serverSend({ serverContent: { turnComplete: true } });
    await vi.waitFor(() => expect(session.stats().turns).toBe(1));
  });

  test('a failed dispatch still reaches the voice (to be spoken as an apology) rather than leaving it waiting forever', async () => {
    const submitUserTurn = vi.fn(async () => {
      throw new Error('host offline');
    });
    const { deps, lastWs } = makeDeps({
      submitUserTurn: submitUserTurn as unknown as GeminiLiveDeps['submitUserTurn'],
    });
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    ws.serverSend({
      toolCall: {
        functionCalls: [{ id: 'c2', name: DISPATCH_TOOL_NAME, args: { request: 'do a thing' } }],
      },
    });
    await vi.waitFor(() => expect(ws.sent.some((s) => s.includes('clientContent'))).toBe(true));
    expect(clientTurns(ws)[0]).toMatch(/host offline/);
  });

  test('ignores a function call for a tool name other than dispatch_to_patch', async () => {
    const { deps, lastWs, submitUserTurn } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    ws.serverSend({
      toolCall: { functionCalls: [{ id: 'x', name: 'some_other_tool', args: {} }] },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(submitUserTurn).not.toHaveBeenCalled();
  });
});

describe('GeminiLiveSession — mode/focus passthrough + scope cuts', () => {
  test('setMode/getMode round-trip', async () => {
    const { deps, lastWs } = makeDeps();
    const session = new GeminiLiveSession(makeInit({ mode: 'call' }), deps);
    await openSession(session, lastWs);
    expect(session.getMode()).toBe('call');
    session.setMode('hands-free');
    expect(session.getMode()).toBe('hands-free');
  });

  test('setFocus/getCurrentChatId round-trip', async () => {
    const { deps, lastWs } = makeDeps();
    const session = new GeminiLiveSession(makeInit({ chatId: 'chat-a' }), deps);
    await openSession(session, lastWs);
    expect(session.getCurrentChatId()).toBe('chat-a');
    session.setFocus('chat-b');
    expect(session.getCurrentChatId()).toBe('chat-b');
  });

  test('finalizeNote is a documented no-op (voice notes stay on the fallback tier)', async () => {
    const { deps, lastWs } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    await openSession(session, lastWs);
    await expect(session.finalizeNote()).resolves.toBe(false);
  });

  test('injectTranscript sends a real text clientContent turn (dev/test seam, spec/07)', async () => {
    const { deps, lastWs } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    await session.injectTranscript('hello there');
    const frame = (
      ws.sentJson() as Array<{
        clientContent?: {
          turns: Array<{ role: string; parts: Array<{ text: string }> }>;
          turnComplete: boolean;
        };
      }>
    ).find((f) => f.clientContent?.turnComplete === true);
    expect(frame?.clientContent?.turns).toEqual([
      { role: 'user', parts: [{ text: 'hello there' }] },
    ]);
  });

  test('speak() asks Gemini to say the text verbatim (documented approximation)', async () => {
    const { deps, lastWs } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    await session.speak('your parcel has arrived');
    const frame = (
      ws.sentJson() as Array<{
        clientContent?: { turns: Array<{ parts: Array<{ text: string }> }> };
      }>
    ).find((f) => f.clientContent);
    expect(frame?.clientContent?.turns[0]?.parts[0]?.text).toContain('your parcel has arrived');
  });

  test('close() closes the socket and further mic frames are dropped', async () => {
    const { deps, lastWs } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    await session.close();
    expect(ws.closed).toBe(true);
    const before = ws.sent.length;
    await session.onMicFrame(new Int16Array([1]));
    expect(ws.sent.length).toBe(before);
  });

  test('the user’s words stream to the surface as partials while Gemini hears them', async () => {
    const { deps, lastWs, audioEvents } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    ws.serverSend({ serverContent: { inputTranscription: { text: 'turn the ' } } });
    ws.serverSend({ serverContent: { inputTranscription: { text: 'lights off' } } });
    expect(
      audioEvents
        .filter((e) => e.type === 'audio.transcript_partial')
        .map((e) => (e as { text: string }).text),
    ).toEqual(['turn the', 'turn the lights off']);
    expect(session.getState()).toBe('transcribing');
  });

  test('Gemini hanging up mid-call is fatal and loud, not a log line', async () => {
    const onFatal = vi.fn();
    const { deps, lastWs, audioEvents } = makeDeps({ onFatal });
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    ws.emit('close', 1011, Buffer.from('internal'));
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(audioEvents.at(-1)).toMatchObject({
      type: 'audio.error',
      code: 'gemini_unavailable',
      message: expect.stringContaining('1011: internal'),
    });
  });

  test('Gemini closing before setupComplete (bad model/key) fails the session instead of hanging', async () => {
    const onFatal = vi.fn();
    const { deps, lastWs, audioEvents } = makeDeps({ onFatal });
    const session = new GeminiLiveSession(makeInit(), deps);
    session.onSessionStart();
    await vi.waitFor(() => expect(lastWs.current).toBeDefined());
    const ws = lastWs.current!;
    ws.emit('open');
    await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(0));
    ws.emit('close', 1008, 'model not found');
    await vi.waitFor(() => expect(onFatal).toHaveBeenCalledTimes(1));
    expect(audioEvents.filter((e) => e.type === 'audio.error')).toHaveLength(1);
    expect(session.getState()).toBe('connecting');
  });

  test('our own close() is not reported as a failure', async () => {
    const onFatal = vi.fn();
    const { deps, lastWs, audioEvents } = makeDeps({ onFatal });
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    await session.close();
    ws.emit('close', 1000, '');
    expect(onFatal).not.toHaveBeenCalled();
    expect(audioEvents.some((e) => e.type === 'audio.error')).toBe(false);
  });
});

describe('geminiLiveModelFor', () => {
  test('heavy runs the extended-thinking Live model; light and direct the default', () => {
    expect(geminiLiveModelFor('heavy')).toBe(DEFAULT_GEMINI_LIVE_HEAVY_MODEL);
    expect(geminiLiveModelFor('light')).toBe(DEFAULT_GEMINI_LIVE_MODEL);
    expect(geminiLiveModelFor('direct')).toBe(DEFAULT_GEMINI_LIVE_MODEL);
    expect(geminiLiveModelFor('heavy', { heavy: 'h' })).toBe('h');
    expect(geminiLiveModelFor('light', { light: 'l' })).toBe('l');
  });
});

// spec/07 § Keeping voice and text as one conversation / § The fast voice and
// the chat's agent / § Call cost.
describe('GeminiLiveSession — one conversation with the chat', () => {
  const audio = (n = 4) => Buffer.alloc(n).toString('base64');

  test('writes the user words, then streams the spoken reply, into the chat timeline', async () => {
    const { deps, lastWs, timeline, audioEvents } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);

    ws.serverSend({ serverContent: { inputTranscription: { text: 'what is ' } } });
    ws.serverSend({ serverContent: { inputTranscription: { text: 'a nebula' } } });
    expect(timeline.log).toEqual([]);
    ws.serverSend({
      serverContent: {
        outputTranscription: { text: 'A cloud ' },
        modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm', data: audio() } }] },
      },
    });
    ws.serverSend({ serverContent: { outputTranscription: { text: 'of gas.' } } });
    ws.serverSend({ serverContent: { turnComplete: true } });

    expect(timeline.log).toEqual([
      'user:chat-1:what is a nebula',
      'begin:chat-1',
      'delta:A cloud ',
      'delta:of gas.',
      'reply:chat-1:A cloud of gas.',
    ]);
    // The final transcript reaches the surface as soon as the reply starts,
    // not only once the whole reply has played.
    const finalIdx = audioEvents.findIndex((e) => e.type === 'audio.transcript_final');
    const ttsIdx = audioEvents.findIndex((e) => e.type === 'audio.tts_chunk');
    expect(finalIdx).toBeGreaterThanOrEqual(0);
    expect(finalIdx).toBeLessThan(ttsIdx);
  });

  test("a hand-off flushes the words and the bridge, goes to the chat's agent tagged as a hand-off, and what the voice says of the answer is written too", async () => {
    const { deps, lastWs, timeline, submitUserTurn } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);

    ws.serverSend({ serverContent: { inputTranscription: { text: 'add milk to my list' } } });
    ws.serverSend({ serverContent: { outputTranscription: { text: 'One sec.' } } });
    ws.serverSend({
      toolCall: {
        functionCalls: [{ id: 'call-1', name: DISPATCH_TOOL_NAME, args: { request: 'Add milk' } }],
      },
    });
    await vi.waitFor(() => expect(submitUserTurn).toHaveBeenCalled());
    expect(submitUserTurn).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'chat-1', message: 'Add milk', handoff: true }),
    );
    expect(timeline.log).toEqual([
      'user:chat-1:add milk to my list',
      'begin:chat-1',
      'delta:One sec.',
      'reply:chat-1:One sec.',
    ]);
    // The bridge turn ends, then the model speaks the agent's answer.
    ws.serverSend({ serverContent: { turnComplete: true } });
    await vi.waitFor(() => expect(ws.sent.some((s) => s.includes('toolResponse'))).toBe(true));
    ws.serverSend({ serverContent: { outputTranscription: { text: 'Milk is on the list.' } } });
    ws.serverSend({ serverContent: { turnComplete: true } });
    expect(timeline.log.filter((l) => l.startsWith('reply:'))).toEqual([
      'reply:chat-1:One sec.',
      'reply:chat-1:Milk is on the list.',
    ]);
    expect(session.isAwaitingHandoff()).toBe(false);
  });

  test('a message landing in the chat is a short quiet note from the user side, not asking for an answer', async () => {
    const { deps, lastWs } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    session.pushContext('assistant', 'The build finished.');
    const last = ws.sentJson().at(-1) as {
      clientContent: {
        turns: Array<{ role: string; parts: Array<{ text: string }> }>;
        turnComplete: boolean;
      };
    };
    expect(last.clientContent.turnComplete).toBe(false);
    expect(last.clientContent.turns[0]!.role).toBe('user');
    expect(last.clientContent.turns[0]!.parts[0]!.text).toContain(
      'the agent wrote in the chat: "The build finished."',
    );
  });

  test('look_back: declared only when the host can search, and answered at once from the chat', async () => {
    const without = makeDeps();
    const w0 = await openSession(new GeminiLiveSession(makeInit(), without.deps), without.lastWs);
    const [first0] = w0.sentJson() as [{ setup: { tools?: unknown } }];
    expect(JSON.stringify(first0.setup.tools ?? [])).not.toContain('look_back');

    const lookBack = vi.fn(() => 'User: why was it archived');
    const { deps, lastWs } = makeDeps({ lookBack });
    const session = new GeminiLiveSession(makeInit({ chatId: 'chat-9' }), deps);
    const ws = await openSession(session, lastWs);
    const [first] = ws.sentJson() as [
      {
        setup: {
          tools: Array<{ functionDeclarations: Array<{ name: string }> }>;
          systemInstruction: { parts: Array<{ text: string }> };
        };
      },
    ];
    expect(first.setup.tools[0]!.functionDeclarations.map((d) => d.name)).toEqual([
      DISPATCH_TOOL_NAME,
      'look_back',
    ]);
    expect(first.setup.systemInstruction.parts[0]!.text).toContain('call look_back');
    ws.serverSend({
      toolCall: { functionCalls: [{ id: 'lb-1', name: 'look_back', args: { query: 'archived' } }] },
    });
    await vi.waitFor(() => expect(lookBack).toHaveBeenCalledWith('chat-9', 'archived'));
    const reply = (ws.sentJson() as Array<Record<string, unknown>>).find(
      (f) => 'toolResponse' in f,
    ) as {
      toolResponse: {
        functionResponses: Array<{ id: string; response: { result: string; scheduling: string } }>;
      };
    };
    expect(reply.toolResponse.functionResponses[0]).toMatchObject({
      id: 'lb-1',
      response: { result: 'User: why was it archived', scheduling: 'INTERRUPT' },
    });
  });

  test('look_back that throws says so to the voice and in the log, never silently', async () => {
    const lookBack = vi.fn(() => {
      throw new Error('chat gone');
    });
    const { deps, lastWs } = makeDeps({ lookBack });
    const ws = await openSession(new GeminiLiveSession(makeInit(), deps), lastWs);
    ws.serverSend({
      toolCall: { functionCalls: [{ id: 'lb-2', name: 'look_back', args: { query: 'x' } }] },
    });
    await vi.waitFor(() =>
      expect(ws.sent.some((s) => s.includes('Looking back failed: chat gone'))).toBe(true),
    );
  });

  test('the instruction makes it the voice of this conversation, not an assistant with no knowledge', async () => {
    const { deps, lastWs } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    const [first] = ws.sentJson() as [
      { setup: { systemInstruction: { parts: [{ text: string }] } } },
    ];
    const text = first.setup.systemInstruction.parts[0].text;
    expect(text).toContain('voice of this conversation');
    expect(text).not.toContain('NO access');
  });

  test('tallies the usage Gemini reports, the last report of each turn, by modality', async () => {
    const { deps, lastWs } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    const usage = (audioIn: number, textIn: number, audioOut: number) => ({
      promptTokenCount: audioIn + textIn,
      responseTokenCount: audioOut,
      promptTokensDetails: [
        { modality: 'AUDIO', tokenCount: audioIn },
        { modality: 'TEXT', tokenCount: textIn },
      ],
      responseTokensDetails: [{ modality: 'AUDIO', tokenCount: audioOut }],
    });
    ws.serverSend({
      serverContent: { inputTranscription: { text: 'hi' } },
      usageMetadata: usage(10, 5, 1),
    });
    ws.serverSend({ serverContent: { turnComplete: true }, usageMetadata: usage(100, 50, 40) });
    ws.serverSend({ serverContent: { inputTranscription: { text: 'again' } } });
    ws.serverSend({ serverContent: { turnComplete: true }, usageMetadata: usage(200, 60, 30) });

    expect(session.engineCosting()).toEqual({
      backend: 'gemini',
      model: DEFAULT_GEMINI_LIVE_MODEL,
      tokens: { textIn: 110, audioIn: 300, cachedIn: 0, textOut: 0, audioOut: 70 },
      stt: null,
    });
  });
});

/** A hand-off the test resolves when it chooses. */
function pendingHandoff(): {
  submit: GeminiLiveDeps['submitUserTurn'];
  resolve: (reply: string) => void;
} {
  let resolve!: (reply: string) => void;
  const done = new Promise<string>((r) => (resolve = r));
  return { submit: (async () => done) as unknown as GeminiLiveDeps['submitUserTurn'], resolve };
}

function speech(): unknown {
  const pcm = new Int16Array([1, 2]);
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64');
  return { serverContent: { modelTurn: { parts: [{ inlineData: { data } }] } } };
}

const dispatchCall = {
  toolCall: {
    functionCalls: [{ id: 'call-1', name: DISPATCH_TOOL_NAME, args: { request: 'list files' } }],
  },
};

describe('GeminiLiveSession — waiting on a hand-off', () => {
  test('one acknowledgement is spoken; the model talking on its own after that is dropped', async () => {
    const handoff = pendingHandoff();
    const { deps, lastWs, binaryFrames } = makeDeps({ submitUserTurn: handoff.submit });
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    ws.serverSend({ serverContent: { inputTranscription: { text: 'list the files' } } });
    ws.serverSend(dispatchCall);
    ws.serverSend(speech()); // "one sec"
    ws.serverSend({ serverContent: { turnComplete: true } });
    ws.serverSend(speech()); // "I've passed that on" — the one acknowledgement
    ws.serverSend({ serverContent: { turnComplete: true } });
    await vi.waitFor(() => expect(binaryFrames.length).toBe(2));

    ws.serverSend(speech()); // "still working on it"
    ws.serverSend({ serverContent: { turnComplete: true } });
    ws.serverSend(speech()); // "waiting"
    ws.serverSend({ serverContent: { turnComplete: true } });
    expect(binaryFrames.length).toBe(2);
    expect(session.getState()).toBe('thinking');
  });

  test('what the user says while waiting still gets a spoken reply', async () => {
    const handoff = pendingHandoff();
    const { deps, lastWs, binaryFrames } = makeDeps({ submitUserTurn: handoff.submit });
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    ws.serverSend(dispatchCall);
    ws.serverSend(speech());
    ws.serverSend({ serverContent: { turnComplete: true } });
    ws.serverSend(speech());
    ws.serverSend({ serverContent: { turnComplete: true } });
    await vi.waitFor(() => expect(binaryFrames.length).toBe(2));

    ws.serverSend({ serverContent: { inputTranscription: { text: "what's the weather" } } });
    ws.serverSend(speech());
    ws.serverSend({ serverContent: { turnComplete: true } });
    expect(binaryFrames.length).toBe(3);
  });

  test('the agent answer is said as a message once the conversation is quiet', async () => {
    const handoff = pendingHandoff();
    const { deps, lastWs, audioEvents } = makeDeps({ submitUserTurn: handoff.submit });
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    ws.serverSend(dispatchCall);
    ws.serverSend({ serverContent: { turnComplete: true } });
    handoff.resolve('index.html');
    await vi.waitFor(() => expect(clientTurns(ws)).toHaveLength(1));
    expect(clientTurns(ws)[0]).toContain('index.html');
    // The model speaks it; that is the agent's reply, already in the chat.
    ws.serverSend(speech());
    ws.serverSend({ serverContent: { turnComplete: true } });
    expect(audioEvents.some((e) => e.type === 'audio.error')).toBe(false);
    expect(session.isAwaitingHandoff()).toBe(false);
  });

  test('the answer waits while the user is talking, and is said when they stop', async () => {
    const handoff = pendingHandoff();
    const { deps, lastWs } = makeDeps({ submitUserTurn: handoff.submit });
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    ws.serverSend(dispatchCall);
    ws.serverSend({ serverContent: { turnComplete: true } });
    ws.serverSend({ serverContent: { inputTranscription: { text: 'and another thing' } } });
    handoff.resolve('index.html');
    await vi.waitFor(() => expect(session.isAwaitingHandoff()).toBe(true));
    await new Promise((r) => setTimeout(r, 30));
    expect(clientTurns(ws)).toHaveLength(0);
    ws.serverSend(speech());
    ws.serverSend({ serverContent: { turnComplete: true } });
    await vi.waitFor(() => expect(clientTurns(ws)).toHaveLength(1));
  });

  test('a server cancellation does not lose the answer', async () => {
    const handoff = pendingHandoff();
    const { deps, lastWs } = makeDeps({ submitUserTurn: handoff.submit });
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    ws.serverSend(dispatchCall);
    ws.serverSend({ serverContent: { turnComplete: true } });
    ws.serverSend({ toolCallCancellation: { ids: ['call-1'] } });
    handoff.resolve('index.html');
    await vi.waitFor(() => expect(clientTurns(ws)).toHaveLength(1));
    expect(clientTurns(ws)[0]).toContain('index.html');
  });

  test('an answer the model never speaks is reported, not swallowed', async () => {
    const handoff = pendingHandoff();
    const { deps, lastWs, audioEvents } = makeDeps({ submitUserTurn: handoff.submit });
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    ws.serverSend(dispatchCall);
    ws.serverSend({ serverContent: { turnComplete: true } });
    handoff.resolve('index.html');
    await vi.waitFor(() => expect(clientTurns(ws)).toHaveLength(1));
    ws.serverSend({ serverContent: { turnComplete: true } }); // the turn ends with no speech
    expect(audioEvents.some((e) => e.type === 'audio.error')).toBe(true);
  });
});

describe('GeminiLiveSession — hand-off mode', () => {
  async function setupFor(handoff: 'auto' | 'always' | 'never'): Promise<{
    setup: { systemInstruction: { parts: Array<{ text: string }> }; tools?: unknown[] };
  }> {
    const { deps, lastWs } = makeDeps({ handoff });
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    return ws.sentJson()[0] as never;
  }

  test('auto: answers what it can and has the dispatch tool', async () => {
    const first = await setupFor('auto');
    expect(first.setup.tools).toHaveLength(1);
    expect(first.setup.systemInstruction.parts[0]?.text).toMatch(/Answer yourself/);
  });

  test('always: told to answer nothing itself, still has the tool', async () => {
    const first = await setupFor('always');
    expect(first.setup.tools).toHaveLength(1);
    expect(first.setup.systemInstruction.parts[0]?.text).toMatch(
      /do not answer anything yourself/i,
    );
  });

  test('never: no dispatch tool, and told it has no agent', async () => {
    const first = await setupFor('never');
    expect(first.setup.tools).toBeUndefined();
    expect(first.setup.systemInstruction.parts[0]?.text).toMatch(/no agent and no tools/i);
  });
});
