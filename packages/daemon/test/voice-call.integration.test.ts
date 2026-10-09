// A whole voice call, end to end, with only Gemini and the agent's model faked:
// the surface's audio socket, the real audio server, the real Gemini session,
// the real chat host (history log, turn queue, spend bookkeeping) and the real
// call-costing glue. What each test asserts is what Tom sees: the banner the
// call leaves in the chat and the cost on it.
//
// These exist because the cost on that banner was wrong ($4.33 for two
// requests: a long unrelated turn finishing mid-call was charged to the call)
// and no test drove a call through the real pieces to notice.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import pino from 'pino';
import { WebSocket } from 'ws';
import type { WebSocket as WsSocket } from 'ws';
import type { WireEvent } from '@patch/wire';
import { encodeAudio, DEFAULT_VOICE_CONFIG, type VoiceConfig } from '@patch/wire/audio';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createHistoryReader } from '../src/history.js';
import { createChatVoice } from '../src/audio/chatVoice.js';
import { createVoiceReplyBridge } from '../src/audio/replyBridge.js';
import { createVoiceLedger } from '../src/audio/voiceLedger.js';
import { startAudioServer, type AudioServerHandle } from '../src/audio/server.js';
import { createWhisper } from '../src/audio/whisper.js';
import { createKokoro } from '../src/audio/kokoro.js';
import { MockVad } from '../src/audio/vad.js';
import { DISPATCH_TOOL_NAME } from '../src/audio/gemini-live.js';

const SECRET = 'integration-test-internal-token-aaaaaaa';
const silent = pino({ level: 'silent' });
/** What the fake harness reports each agent turn cost. */
const COST_PER_TURN = 0.2;

/** The Gemini end of the call: the test plays the model, frame by frame. */
class FakeGemini extends EventEmitter {
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
  say(msg: unknown): void {
    this.emit('message', JSON.stringify(msg), false);
  }
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

function speech(): unknown {
  const pcm = new Int16Array([1, 2]);
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64');
  return { serverContent: { modelTurn: { parts: [{ inlineData: { data } }] } } };
}

function mintToken(sessionId: string, chatId: string): string {
  const claims = Buffer.from(
    JSON.stringify({
      accountId: 'a',
      surfaceId: 'surf',
      sessionId,
      chatId,
      exp: Date.now() + 60_000,
      jti: `jti-${randomUUID()}`,
    }),
    'utf8',
  ).toString('base64url');
  const sig = createHmac('sha256', SECRET).update(claims).digest().toString('base64url');
  return `${claims}.${sig}`;
}

function world(voiceConfig?: Partial<VoiceConfig>) {
  const home = mkdtempSync(join(tmpdir(), 'patch-call-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-call-folder-')));
  const events: WireEvent[] = [];
  let id = 0;
  // Every agent turn waits on this gate before it settles; tests hold and release it.
  let release: () => void = () => undefined;
  let gate: Promise<void> = Promise.resolve();
  const hold = (): void => {
    gate = new Promise((r) => {
      release = r;
    });
  };
  let observe: (e: WireEvent) => void = () => undefined;
  const replies = createVoiceReplyBridge();
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: {
      run: async function* (opts: { prompt: string }) {
        // The reply names what it was asked, so a test can tell whose answer it is.
        const asked = opts.prompt.replace(/\s+/g, ' ').trim().slice(-30);
        yield { type: 'assistant' as const, content: `agent reply to: ${asked}`, sessionId: 'S1' };
        await gate;
        yield {
          type: 'result' as const,
          sessionId: 'S1',
          raw: { type: 'result', total_cost_usd: COST_PER_TURN },
        };
      },
    },
    oauthAccessToken: 'fake-token',
    emit: (e) => {
      events.push(e);
      observe(e);
    },
    logger: silent,
    now: () => Date.now(),
    generateChatId: () => `chat-${++id}`,
    historyReader: createHistoryReader({
      claudeProjectsRoot: mkdtempSync(join(tmpdir(), 'patch-call-claude-')),
    }),
  });
  let server: (AudioServerHandle & { port: number }) | undefined;
  const glue = createChatVoice({
    daemon,
    sessionsOnChat: (chatId) => server?.sessionsOnChat(chatId) ?? [],
    ledger: createVoiceLedger(join(home, 'voice-usage.jsonl')),
    logger: silent,
    onCosted: () => undefined,
  });
  observe = (e) => {
    glue.observe(e);
    replies.observe(e);
  };
  const geminis: FakeGemini[] = [];
  const config: VoiceConfig = {
    ...DEFAULT_VOICE_CONFIG,
    call: { backend: 'gemini', layer: 'light', handoff: 'auto' },
    ...voiceConfig,
  };
  const start = async (): Promise<void> => {
    const handle = await startAudioServer({
      host: '127.0.0.1',
      port: 0,
      logger: silent,
      internalToken: SECRET,
      whisper: createWhisper({ backend: 'mock', logger: silent }),
      kokoro: createKokoro({ backend: 'mock', logger: silent }),
      makeVad: () => new MockVad(),
      chatExists: (chatId) => chatId.startsWith('chat-'),
      getVoiceConfig: () => config,
      geminiApiKey: 'test-key',
      geminiWsCtor: function (url: string): FakeGemini {
        const g = new FakeGemini(url);
        queueMicrotask(() => g.emit('open'));
        geminis.push(g);
        return g;
      } as unknown as new (url: string) => WsSocket,
      makeTimeline: (init) => glue.makeTimeline(init),
      // What index.ts does for a hand-off: a tagged turn on the chat, answered when
      // that turn settles (not when sendInput returns: a queued message returns at once).
      submitUserTurn: async ({ chatId, message, source, handoff, onReplyText }) => {
        const surface = source.kind === 'voice-app' ? source.surfaceKind : 'device';
        const localId = `voice-${randomUUID()}`;
        const reply = replies.awaitReply(chatId, onReplyText, localId);
        try {
          await daemon.sendInput({
            chatId,
            message,
            localId,
            voicePrefix: `[voice${handoff === true ? ' hand-off' : ''} • ${surface}] `,
            fromUser: true,
          });
        } catch (err) {
          replies.abandon(chatId, err as Error);
          throw err;
        }
        return reply;
      },
      onCallEnded: (info) => glue.callEnded(info),
    });
    server = Object.assign(handle, { port: handle.address().port });
  };
  const sockets: WebSocket[] = [];
  /** Pick up a call on `chatId` from a web surface; resolves once Gemini is on the line. */
  const call = async (chatId: string) => {
    const sessionId = `s-${randomUUID()}`;
    const ws = new WebSocket(`ws://127.0.0.1:${server!.port}/audio/${sessionId}`);
    sockets.push(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const before = geminis.length;
    ws.send(
      encodeAudio({
        type: 'audio.session_start',
        sessionId,
        accountId: 'a',
        surfaceId: 'surf',
        surfaceKind: 'web',
        chatId,
        role: 'voice-call',
        token: mintToken(sessionId, chatId),
        surfaceHasAec: true,
      }),
    );
    await vi.waitFor(() => expect(geminis.length).toBe(before + 1));
    const gemini = geminis[before]!;
    await vi.waitFor(() => expect(gemini.sent.length).toBeGreaterThan(0));
    return {
      gemini,
      hangUp: () => ws.close(),
      /** The user speaks and the model decides to hand off to the agent. */
      handOff: (callId: string, request: string) => {
        gemini.say({ serverContent: { inputTranscription: { text: request } } });
        gemini.say({
          toolCall: {
            functionCalls: [{ id: callId, name: DISPATCH_TOOL_NAME, args: { request } }],
          },
        });
        gemini.say(speech());
        gemini.say({ serverContent: { turnComplete: true } });
      },
    };
  };
  const banners = (): string[] =>
    events
      .filter(
        (e): e is Extract<WireEvent, { type: 'chat.message' }> =>
          e.type === 'chat.message' && e.role === 'system' && e.content.startsWith('[call]'),
      )
      .map((e) => e.content);
  return {
    daemon,
    folder,
    start,
    call,
    hold,
    release: () => release(),
    banners,
    close: async () => {
      for (const s of sockets) s.close();
      await server?.close();
    },
  };
}

const typed = (daemon: Daemon, chatId: string) =>
  daemon.sendInput({ chatId, message: 'typed work', localId: randomUUID() });

describe('a voice call, end to end', () => {
  let w: ReturnType<typeof world>;
  afterEach(async () => {
    w.release();
    await w.close();
  });

  async function begin(): Promise<string> {
    w = world();
    await w.start();
    return w.daemon.spawnChat({ folder: w.folder });
  }
  const results = (c: { gemini: FakeGemini }): string[] =>
    c.gemini
      .frames()
      .flatMap((f) =>
        'clientContent' in f
          ? [
              (f['clientContent'] as { turns: Array<{ parts: Array<{ text: string }> }> }).turns[0]!
                .parts[0]!.text,
            ]
          : [],
      );

  it('hands off twice, gets both answers back as messages, and leaves a banner costing the voice alone', async () => {
    const chatId = await begin();
    const c = await w.call(chatId);
    c.handOff('c1', 'list the files');
    await vi.waitFor(() => expect(results(c)).toHaveLength(1));
    expect(results(c)[0]).toContain('agent reply to: ');
    expect(results(c)[0]).toContain('list the files');
    c.gemini.say(speech()); // the voice says the answer
    c.gemini.say({ serverContent: { turnComplete: true } });
    c.handOff('c2', 'what is on my calendar');
    await vi.waitFor(() => expect(results(c)).toHaveLength(2));
    c.hangUp();
    await vi.waitFor(() => expect(w.banners()).toHaveLength(1));
    // Two agent turns ran, at $0.20 each; neither is on the banner.
    expect(w.banners()[0]).toMatch(/^\[call\] Call 0:\d\d · Gemini Flash · \$0/);
    expect(w.banners()[0]).not.toMatch(/agent|\$0\.[2-9]/);
  });

  it('shows the banner the moment you hang up, even with an unrelated turn still running', async () => {
    const chatId = await begin();
    const c = await w.call(chatId);
    w.hold();
    const work = typed(w.daemon, chatId);
    await vi.waitFor(() => expect(w.daemon.isTurnRunning(chatId)).toBe(true));
    c.hangUp();
    await vi.waitFor(() => expect(w.banners()).toHaveLength(1));
    w.release();
    await work;
    expect(w.banners()).toHaveLength(1);
  });

  it("shows the banner the moment you hang up, even with the call's own hand-off still running", async () => {
    const chatId = await begin();
    const c = await w.call(chatId);
    w.hold();
    c.handOff('c1', 'do a long job');
    await vi.waitFor(() => expect(w.daemon.isTurnRunning(chatId)).toBe(true));
    c.hangUp();
    await vi.waitFor(() => expect(w.banners()).toHaveLength(1));
    expect(w.banners()[0]).not.toMatch(/agent/);
  });

  it('says a hand-off answer to a call whose model was mid-sentence only once it has finished', async () => {
    const chatId = await begin();
    const c = await w.call(chatId);
    w.hold();
    c.handOff('c1', 'list the files');
    // The user keeps talking while the agent works.
    c.gemini.say({ serverContent: { inputTranscription: { text: 'and also' } } });
    w.release();
    await new Promise((r) => setTimeout(r, 150));
    expect(results(c)).toHaveLength(0);
    c.gemini.say(speech());
    c.gemini.say({ serverContent: { turnComplete: true } });
    await vi.waitFor(() => expect(results(c)).toHaveLength(1));
  });

  it("a hand-off queued behind other work is answered with its own turn's text, not the other turn's", async () => {
    const chatId = await begin();
    w.hold();
    const work = typed(w.daemon, chatId);
    await vi.waitFor(() => expect(w.daemon.isTurnRunning(chatId)).toBe(true));
    const c = await w.call(chatId);
    c.handOff('c1', 'check the weather');
    await new Promise((r) => setTimeout(r, 100));
    // The typed turn finishes first; the call's answer must wait for its own turn.
    w.release();
    await work;
    await vi.waitFor(() => expect(results(c)).toHaveLength(1));
    expect(results(c)[0]).toContain('check the weather');
    expect(results(c)[0]).not.toContain('typed work');
  });

  it('leaves a banner for a call that handed nothing off', async () => {
    const chatId = await begin();
    const c = await w.call(chatId);
    c.gemini.say({ serverContent: { inputTranscription: { text: 'what is a nebula' } } });
    c.gemini.say(speech());
    c.gemini.say({ serverContent: { turnComplete: true } });
    c.hangUp();
    await vi.waitFor(() => expect(w.banners()).toHaveLength(1));
    expect(w.banners()[0]).toMatch(/Gemini Flash/);
  });
});
