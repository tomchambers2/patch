// OpenAI Realtime session unit tests. The provider socket is an in-memory fake
// — OpenAI Realtime is a paid API and nothing here may reach it.

import { describe, test, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import pino from 'pino';
import {
  OpenAIRealtimeSession,
  DEFAULT_OPENAI_REALTIME_MODELS,
  openaiRealtimeModelFor,
  upsample16kTo24k,
  type OpenAIRealtimeDeps,
  type OpenAIWsCtor,
} from '../src/audio/openai-realtime.js';
import { DISPATCH_TOOL_NAME } from '../src/audio/gemini-live.js';
import type { SessionInit } from '../src/audio/session.js';
import type { AudioEvent } from '@patch/wire/audio';
import { FakeTimeline } from './gemini-live-session.test.js';

const logger = pino({ level: 'silent' });

class FakeOpenAIWs extends EventEmitter {
  sent: Array<Record<string, unknown>> = [];
  closed = false;
  constructor(
    public readonly url: string,
    public readonly opts: { headers: Record<string, string> },
  ) {
    super();
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {
    this.closed = true;
  }
  serverSend(ev: unknown): void {
    this.emit('message', JSON.stringify(ev));
  }
  ofType(type: string): Array<Record<string, unknown>> {
    return this.sent.filter((m) => m['type'] === type);
  }
}

function makeInit(overrides: Partial<SessionInit> = {}): SessionInit {
  return {
    sessionId: 'sess-1',
    accountId: 'acct-1',
    surfaceId: 'surf-1',
    surfaceKind: 'mobile',
    chatId: 'chat-1',
    role: 'voice-call',
    surfaceHasAec: true,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<OpenAIRealtimeDeps> = {}): {
  deps: OpenAIRealtimeDeps;
  events: AudioEvent[];
  binary: Int16Array[];
  last: { ws?: FakeOpenAIWs };
  submitUserTurn: ReturnType<typeof vi.fn>;
  onFatal: ReturnType<typeof vi.fn>;
  timeline: FakeTimeline;
} {
  const events: AudioEvent[] = [];
  const binary: Int16Array[] = [];
  const last: { ws?: FakeOpenAIWs } = {};
  const submitUserTurn = vi.fn(async () => 'next train is 14:05');
  const onFatal = vi.fn();
  const timeline = new FakeTimeline();
  const wsCtor = function (this: unknown, url: string, opts: { headers: Record<string, string> }) {
    last.ws = new FakeOpenAIWs(url, opts);
    return last.ws;
  } as unknown as OpenAIWsCtor;
  const deps: OpenAIRealtimeDeps = {
    logger,
    sendAudio: (ev) => events.push(ev),
    sendBinary: (pcm) => binary.push(pcm),
    submitUserTurn: submitUserTurn as unknown as OpenAIRealtimeDeps['submitUserTurn'],
    apiKey: 'o-key',
    model: 'gpt-realtime-2.1-mini',
    wsCtor,
    onFatal,
    timeline,
    ...overrides,
  };
  return { deps, events, binary, last, submitUserTurn, onFatal, timeline };
}

async function open(
  session: OpenAIRealtimeSession,
  last: { ws?: FakeOpenAIWs },
): Promise<FakeOpenAIWs> {
  session.onSessionStart();
  await vi.waitFor(() => expect(last.ws).toBeDefined());
  const ws = last.ws!;
  ws.emit('open');
  await vi.waitFor(() => expect(ws.ofType('session.update')).toHaveLength(1));
  ws.serverSend({ type: 'session.updated' });
  await vi.waitFor(() => expect(session.getState()).toBe('listening'));
  return ws;
}

function audioDelta(samples: number): { type: string; delta: string } {
  const pcm = new Int16Array(samples).fill(1000);
  return { type: 'response.output_audio.delta', delta: Buffer.from(pcm.buffer).toString('base64') };
}

describe('model per layer', () => {
  test('light and direct run the mini model; heavy runs the flagship', () => {
    expect(openaiRealtimeModelFor('light')).toBe(DEFAULT_OPENAI_REALTIME_MODELS.light);
    expect(openaiRealtimeModelFor('direct')).toBe(DEFAULT_OPENAI_REALTIME_MODELS.light);
    expect(openaiRealtimeModelFor('heavy')).toBe(DEFAULT_OPENAI_REALTIME_MODELS.heavy);
    expect(openaiRealtimeModelFor('heavy', { heavy: 'x' })).toBe('x');
    expect(openaiRealtimeModelFor('light', { light: 'y' })).toBe('y');
  });
});

describe('upsample16kTo24k', () => {
  test('3 output samples per 2 input, endpoints preserved, midpoints interpolated', () => {
    const out = upsample16kTo24k(Int16Array.from([0, 300, 600, 900]));
    expect(out.length).toBe(6);
    expect(Array.from(out)).toEqual([0, 200, 400, 600, 800, 900]);
  });
  test('empty frame → empty frame', () => {
    expect(upsample16kTo24k(new Int16Array(0)).length).toBe(0);
  });
});

describe('OpenAIRealtimeSession', () => {
  test('connects with a bearer key to the model URL and configures a 24 kHz audio session with the dispatch tool', async () => {
    const { deps, last, events } = makeDeps();
    const session = new OpenAIRealtimeSession(makeInit(), deps);
    const ws = await open(session, last);
    expect(ws.url).toBe('wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1-mini');
    expect(ws.opts.headers['Authorization']).toBe('Bearer o-key');
    const update = ws.ofType('session.update')[0] as {
      session: {
        type: string;
        audio: {
          input: { format: { rate: number }; turn_detection: { create_response: boolean } };
          output: { format: { rate: number } };
        };
        tools: Array<{ name: string }>;
      };
    };
    expect(update.session.type).toBe('realtime');
    expect(update.session.audio.input.format.rate).toBe(24000);
    expect(update.session.audio.output.format.rate).toBe(24000);
    expect(update.session.audio.input.turn_detection.create_response).toBe(true);
    expect(update.session.tools.map((t) => t.name)).toEqual([DISPATCH_TOOL_NAME]);
    expect(events).toContainEqual({ type: 'audio.state', sessionId: 'sess-1', state: 'listening' });
  });

  test('mic frames queued before setup are flushed afterwards, upsampled to 24 kHz', async () => {
    const { deps, last } = makeDeps();
    const session = new OpenAIRealtimeSession(makeInit(), deps);
    session.onSessionStart();
    await vi.waitFor(() => expect(last.ws).toBeDefined());
    await session.onMicFrame(new Int16Array(640));
    const ws = last.ws!;
    ws.emit('open');
    await vi.waitFor(() => expect(ws.ofType('session.update')).toHaveLength(1));
    expect(ws.ofType('input_audio_buffer.append')).toHaveLength(0);
    ws.serverSend({ type: 'session.updated' });
    await vi.waitFor(() => expect(ws.ofType('input_audio_buffer.append')).toHaveLength(1));
    const b64 = ws.ofType('input_audio_buffer.append')[0]!['audio'] as string;
    expect(Buffer.from(b64, 'base64').byteLength).toBe(960 * 2);
    await session.onMicFrame(new Int16Array(320));
    expect(ws.ofType('input_audio_buffer.append')).toHaveLength(2);
  });

  test('the chat briefing goes in the instructions before the mic opens', async () => {
    const { deps, last } = makeDeps({
      getChatContext: () => [
        { role: 'user', text: 'what did I buy' },
        { role: 'model', text: 'a drill' },
      ],
    });
    const ws = await open(new OpenAIRealtimeSession(makeInit(), deps), last);
    const update = ws.ofType('session.update')[0] as { session: { instructions: string } };
    expect(update.session.instructions).toContain('User: what did I buy');
    expect(update.session.instructions).toContain('Agent: a drill');
    expect(ws.ofType('conversation.item.create')).toHaveLength(0);
  });

  test('a full turn: partial words, final transcript, audio out, tts_end, back to listening', async () => {
    const { deps, last, events, binary } = makeDeps();
    const session = new OpenAIRealtimeSession(makeInit(), deps);
    const ws = await open(session, last);
    ws.serverSend({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'i1',
      delta: 'hello ',
    });
    ws.serverSend({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'i1',
      delta: 'there',
    });
    ws.serverSend({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'i1',
      transcript: 'hello there',
    });
    ws.serverSend({ type: 'response.created' });
    ws.serverSend(audioDelta(480));
    ws.serverSend(audioDelta(480));
    ws.serverSend({
      type: 'response.done',
      response: { status: 'completed', output: [{ type: 'message' }] },
    });
    expect(
      events
        .filter((e) => e.type === 'audio.transcript_partial')
        .map((e) => (e as { text: string }).text),
    ).toEqual(['hello ', 'hello there']);
    expect(events).toContainEqual({
      type: 'audio.transcript_final',
      sessionId: 'sess-1',
      text: 'hello there',
    });
    expect(binary).toHaveLength(2);
    expect(binary[0]!.length).toBe(480);
    expect(events.filter((e) => e.type === 'audio.tts_chunk')).toHaveLength(2);
    expect(events.at(-2)).toEqual({ type: 'audio.tts_end', sessionId: 'sess-1' });
    expect(session.getState()).toBe('listening');
    expect(session.stats().turns).toBe(1);
    // call mode: the provider answered on its own; we never asked it to.
    expect(ws.ofType('response.create')).toHaveLength(0);
  });

  test('dispatch_to_patch: the heavy agent runs and its answer goes back as function output + response.create', async () => {
    const { deps, last, submitUserTurn } = makeDeps();
    const session = new OpenAIRealtimeSession(makeInit(), deps);
    const ws = await open(session, last);
    ws.serverSend({
      type: 'response.function_call_arguments.done',
      call_id: 'call-1',
      name: DISPATCH_TOOL_NAME,
      arguments: JSON.stringify({ request: 'when is my next train' }),
    });
    ws.serverSend({
      type: 'response.done',
      response: { status: 'completed', output: [{ type: 'function_call' }] },
    });
    expect(session.getState()).toBe('thinking');
    await vi.waitFor(() => expect(ws.ofType('response.create')).toHaveLength(1));
    expect(submitUserTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-1',
        message: 'when is my next train',
        source: { kind: 'voice-app', surfaceKind: 'mobile', sessionId: 'sess-1' },
      }),
    );
    const out = ws.ofType('conversation.item.create').at(-1)!['item'] as {
      type: string;
      call_id: string;
      output: string;
    };
    expect(out).toEqual({
      type: 'function_call_output',
      call_id: 'call-1',
      output: JSON.stringify({ result: 'next train is 14:05' }),
    });
  });

  test('a response with only a tool call and no speech is not a lost reply', async () => {
    const { deps, last, events } = makeDeps();
    const ws = await open(new OpenAIRealtimeSession(makeInit(), deps), last);
    ws.serverSend({
      type: 'response.done',
      response: { status: 'completed', output: [{ type: 'function_call' }] },
    });
    expect(events.some((e) => e.type === 'audio.error')).toBe(false);
  });

  test('a completed reply with no audio is reported loudly', async () => {
    const { deps, last, events } = makeDeps();
    const ws = await open(new OpenAIRealtimeSession(makeInit(), deps), last);
    ws.serverSend({
      type: 'response.done',
      response: { status: 'completed', output: [{ type: 'message' }] },
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'audio.error',
        code: 'openai_unavailable',
        message: expect.stringContaining('no audio'),
      }),
    );
  });

  test('a failed response, an error event, and a failed transcription all surface as openai_unavailable', async () => {
    const { deps, last, events, onFatal } = makeDeps();
    const ws = await open(new OpenAIRealtimeSession(makeInit(), deps), last);
    ws.serverSend({
      type: 'response.done',
      response: { status: 'failed', status_details: { error: { message: 'insufficient_quota' } } },
    });
    ws.serverSend({ type: 'error', error: { code: 'rate_limit_exceeded', message: 'slow down' } });
    ws.serverSend({
      type: 'conversation.item.input_audio_transcription.failed',
      item_id: 'i9',
      error: { message: 'bad audio' },
    });
    const errors = events.filter((e) => e.type === 'audio.error') as Array<{
      code: string;
      message: string;
    }>;
    expect(errors.map((e) => e.code)).toEqual([
      'openai_unavailable',
      'openai_unavailable',
      'openai_unavailable',
    ]);
    expect(errors[0]!.message).toContain('insufficient_quota');
    expect(errors[1]!.message).toContain('rate_limit_exceeded');
    expect(errors[2]!.message).toContain('bad audio');
    // Mid-session errors are loud but not fatal — the provider socket is still up.
    expect(onFatal).not.toHaveBeenCalled();
  });

  test('barge-in in a call: speech_started while speaking flushes the surface', async () => {
    const { deps, last, events } = makeDeps();
    const session = new OpenAIRealtimeSession(makeInit(), deps);
    const ws = await open(session, last);
    ws.serverSend(audioDelta(240));
    expect(session.getState()).toBe('speaking');
    ws.serverSend({ type: 'input_audio_buffer.speech_started' });
    expect(events).toContainEqual(expect.objectContaining({ type: 'audio.barge_in' }));
    expect(events).toContainEqual({ type: 'audio.tts_end', sessionId: 'sess-1', bargedIn: true });
    ws.serverSend({ type: 'response.done', response: { status: 'cancelled' } });
    // No second tts_end for the cancelled reply.
    expect(events.filter((e) => e.type === 'audio.tts_end')).toHaveLength(1);
    expect(session.getState()).toBe('listening');
  });

  describe('hands-free (address-gated)', () => {
    test('the provider is told not to answer or be interrupted on its own', async () => {
      const { deps, last } = makeDeps();
      const ws = await open(
        new OpenAIRealtimeSession(makeInit({ mode: 'hands-free' }), deps),
        last,
      );
      const td = (
        ws.ofType('session.update')[0] as {
          session: { audio: { input: { turn_detection: Record<string, unknown> } } };
        }
      ).session.audio.input.turn_detection;
      expect(td).toMatchObject({ create_response: false, interrupt_response: false });
    });

    test('an unaddressed utterance is heard-but-not-sent and deleted from the conversation', async () => {
      const { deps, last, events } = makeDeps();
      const session = new OpenAIRealtimeSession(
        makeInit({ mode: 'hands-free', addressWord: 'patch' }),
        deps,
      );
      const ws = await open(session, last);
      ws.serverSend({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'i2',
        transcript: 'pass me the trowel',
      });
      expect(events).toContainEqual({
        type: 'audio.transcript_final',
        sessionId: 'sess-1',
        text: 'pass me the trowel',
        addressed: false,
      });
      expect(ws.ofType('conversation.item.delete')).toEqual([
        { type: 'conversation.item.delete', item_id: 'i2' },
      ]);
      expect(ws.ofType('response.create')).toHaveLength(0);
      expect(session.stats().turns).toBe(0);
    });

    test('an addressed utterance becomes a turn: we ask the provider to answer', async () => {
      const { deps, last, events } = makeDeps();
      const session = new OpenAIRealtimeSession(
        makeInit({ mode: 'hands-free', addressWord: 'patch' }),
        deps,
      );
      const ws = await open(session, last);
      ws.serverSend({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'i3',
        transcript: 'Hatch, what time is it',
      });
      expect(events).toContainEqual({
        type: 'audio.transcript_final',
        sessionId: 'sess-1',
        text: 'Hatch, what time is it',
      });
      expect(ws.ofType('response.create')).toHaveLength(1);
      expect(ws.ofType('conversation.item.delete')).toHaveLength(0);
    });

    test('switching mode re-configures the provider turn detection in place', async () => {
      const { deps, last } = makeDeps();
      const session = new OpenAIRealtimeSession(makeInit(), deps);
      const ws = await open(session, last);
      session.setMode('hands-free');
      const updates = ws.ofType('session.update') as Array<{
        session: { audio: { input: { turn_detection: Record<string, unknown> } } };
      }>;
      expect(updates).toHaveLength(2);
      expect(updates[1]!.session.audio.input.turn_detection).toMatchObject({
        create_response: false,
      });
      expect(session.getMode()).toBe('hands-free');
      session.setMode('hands-free');
      expect(ws.ofType('session.update')).toHaveLength(2);
    });

    test('in hands-free, somebody else talking over a reply does not barge in', async () => {
      const { deps, last, events } = makeDeps();
      const ws = await open(
        new OpenAIRealtimeSession(makeInit({ mode: 'hands-free' }), deps),
        last,
      );
      ws.serverSend(audioDelta(240));
      ws.serverSend({ type: 'input_audio_buffer.speech_started' });
      expect(events.some((e) => e.type === 'audio.barge_in')).toBe(false);
    });
  });

  describe('fatal failures end the surface session (NO SILENT FALLBACK)', () => {
    test('the socket never opens', async () => {
      const { deps, last, events, onFatal } = makeDeps();
      const session = new OpenAIRealtimeSession(makeInit(), deps);
      session.onSessionStart();
      await vi.waitFor(() => expect(last.ws).toBeDefined());
      last.ws!.emit('error', new Error('ECONNREFUSED'));
      await vi.waitFor(() => expect(onFatal).toHaveBeenCalledTimes(1));
      expect(events).toEqual([
        expect.objectContaining({
          type: 'audio.error',
          code: 'openai_unavailable',
          message: expect.stringContaining('ECONNREFUSED'),
        }),
      ]);
    });

    test('the provider rejects the session config', async () => {
      const { deps, last, events, onFatal } = makeDeps();
      const session = new OpenAIRealtimeSession(makeInit(), deps);
      session.onSessionStart();
      await vi.waitFor(() => expect(last.ws).toBeDefined());
      last.ws!.emit('open');
      await vi.waitFor(() => expect(last.ws!.ofType('session.update')).toHaveLength(1));
      last.ws!.serverSend({
        type: 'error',
        error: { code: 'invalid_api_key', message: 'Incorrect API key' },
      });
      await vi.waitFor(() => expect(onFatal).toHaveBeenCalledTimes(1));
      expect(events[0]).toMatchObject({
        code: 'openai_unavailable',
        message: expect.stringContaining('invalid_api_key'),
      });
      expect(session.getState()).toBe('connecting');
    });

    test('the provider hangs up mid-call; later mic frames are dropped', async () => {
      const { deps, last, events, onFatal } = makeDeps();
      const session = new OpenAIRealtimeSession(makeInit(), deps);
      const ws = await open(session, last);
      ws.emit('close', 1006, Buffer.from(''));
      expect(onFatal).toHaveBeenCalledTimes(1);
      expect(events.at(-1)).toMatchObject({
        code: 'openai_unavailable',
        message: expect.stringContaining('1006'),
      });
      const before = ws.ofType('input_audio_buffer.append').length;
      await session.onMicFrame(new Int16Array(320));
      expect(ws.ofType('input_audio_buffer.append')).toHaveLength(before);
    });

    test('our own close() is not a failure', async () => {
      const { deps, last, events, onFatal } = makeDeps();
      const session = new OpenAIRealtimeSession(makeInit(), deps);
      const ws = await open(session, last);
      await session.close();
      ws.emit('close', 1000, Buffer.from(''));
      expect(ws.closed).toBe(true);
      expect(onFatal).not.toHaveBeenCalled();
      expect(events.some((e) => e.type === 'audio.error')).toBe(false);
    });
  });

  test('speak() asks for an out-of-band verbatim reply; injectTranscript() drives a real turn', async () => {
    const { deps, last } = makeDeps();
    const session = new OpenAIRealtimeSession(makeInit(), deps);
    const ws = await open(session, last);
    await session.speak('Your parcel is here');
    expect(ws.ofType('response.create')[0]).toMatchObject({
      response: {
        conversation: 'none',
        instructions: expect.stringContaining('Your parcel is here'),
      },
    });
    await session.injectTranscript('hello');
    expect(ws.ofType('conversation.item.create').at(-1)).toMatchObject({
      item: { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
    });
    expect(ws.ofType('response.create')).toHaveLength(2);
    expect(await session.finalizeNote()).toBe(false);
    session.setFocus('chat-2');
    expect(session.getCurrentChatId()).toBe('chat-2');
  });
});

// spec/07 § Keeping voice and text as one conversation / § Call cost.
describe('one conversation with the chat', () => {
  test('writes the user words before the reply even when the transcript lands after the reply starts', async () => {
    const { deps, last, timeline } = makeDeps();
    const session = new OpenAIRealtimeSession(makeInit(), deps);
    const ws = await open(session, last);

    ws.serverSend({ type: 'input_audio_buffer.speech_started' });
    ws.serverSend({ type: 'response.created' });
    ws.serverSend({ type: 'response.output_audio_transcript.delta', delta: 'A cloud ' });
    ws.serverSend(audioDelta(48));
    expect(timeline.log).toEqual([]);
    ws.serverSend({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'i1',
      transcript: 'what is a nebula',
    });
    ws.serverSend({ type: 'response.output_audio_transcript.delta', delta: 'of gas.' });
    ws.serverSend({ type: 'response.done', response: { status: 'completed' } });

    expect(timeline.log).toEqual([
      'user:chat-1:what is a nebula',
      'begin:chat-1',
      'delta:A cloud ',
      'delta:of gas.',
      'reply:chat-1:A cloud of gas.',
    ]);
  });

  test("a hand-off goes to the chat's agent tagged as a hand-off, and what the voice says of the answer is written too", async () => {
    const { deps, last, timeline, submitUserTurn } = makeDeps();
    const session = new OpenAIRealtimeSession(makeInit(), deps);
    const ws = await open(session, last);

    ws.serverSend({ type: 'input_audio_buffer.speech_started' });
    ws.serverSend({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'i1',
      transcript: 'when is my train',
    });
    ws.serverSend({ type: 'response.output_audio_transcript.delta', delta: 'One sec.' });
    ws.serverSend(audioDelta(48));
    ws.serverSend({
      type: 'response.function_call_arguments.done',
      name: DISPATCH_TOOL_NAME,
      call_id: 'c1',
      arguments: JSON.stringify({ request: 'Next train home' }),
    });
    ws.serverSend({ type: 'response.done', response: { status: 'completed' } });
    await vi.waitFor(() => expect(submitUserTurn).toHaveBeenCalled());
    expect(submitUserTurn).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Next train home', handoff: true }),
    );
    await vi.waitFor(() => expect(ws.ofType('response.create').length).toBeGreaterThan(0));
    ws.serverSend({ type: 'response.created' });
    ws.serverSend({ type: 'response.output_audio_transcript.delta', delta: 'It is at 14:05.' });
    ws.serverSend(audioDelta(48));
    ws.serverSend({ type: 'response.done', response: { status: 'completed' } });

    expect(timeline.log.filter((l) => l.startsWith('reply:') || l.startsWith('user:'))).toEqual([
      'user:chat-1:when is my train',
      'reply:chat-1:One sec.',
      'reply:chat-1:It is at 14:05.',
    ]);
  });

  test('pushContext adds a conversation item without asking for a response', async () => {
    const { deps, last } = makeDeps();
    const session = new OpenAIRealtimeSession(makeInit(), deps);
    const ws = await open(session, last);
    const before = ws.ofType('response.create').length;
    session.pushContext('assistant', 'The build finished.');
    expect(ws.sent.at(-1)).toEqual({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'The build finished.' }],
      },
    });
    expect(ws.ofType('response.create').length).toBe(before);
  });

  test('tallies the usage each response reports', async () => {
    const { deps, last } = makeDeps();
    const session = new OpenAIRealtimeSession(makeInit(), deps);
    const ws = await open(session, last);
    const usage = (text: number, audio: number, cached: number, outAudio: number) => ({
      input_tokens: text + audio,
      output_tokens: outAudio,
      input_token_details: {
        text_tokens: text,
        audio_tokens: audio,
        cached_tokens: cached,
        cached_tokens_details: { text_tokens: 0, audio_tokens: cached },
      },
      output_token_details: { text_tokens: 0, audio_tokens: outAudio },
    });
    ws.serverSend(audioDelta(48));
    ws.serverSend({
      type: 'response.done',
      response: { status: 'completed', usage: usage(100, 200, 50, 30) },
    });
    ws.serverSend(audioDelta(48));
    ws.serverSend({
      type: 'response.done',
      response: { status: 'completed', usage: usage(10, 20, 0, 5) },
    });
    // Cached tokens are a subset of the input counts and priced separately.
    expect(session.engineCosting()).toEqual({
      backend: 'openai',
      model: 'gpt-realtime-2.1-mini',
      tokens: { textIn: 110, audioIn: 170, cachedIn: 50, textOut: 0, audioOut: 35 },
      stt: null,
    });
  });
});
