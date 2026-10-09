// spec/08 § Action, spec/14 § Job trigger turn — a job's fire into an EXISTING
// chat (a `continue`/`message` action's later fire, as opposed to `spawn`'s own
// first prompt) is not something Tom typed. The server's job dispatcher tells
// the host this via `chat.input.source.kind === 'job'` (index.ts), which
// becomes `SendInputOptions.jobTrigger` here; this suite drives `sendInput`
// the way index.ts does and reads the persisted `chat.message` back off the
// wire, the same shape a surface renders from.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { ChatMessageEvent, WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import type { SdkBackend } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });
const tick = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms));

type Env = { type: string; [k: string]: unknown };

function recordingBackend(): { backend: SdkBackend; prompts: string[] } {
  const prompts: string[] = [];
  const backend: SdkBackend = {
    async *run(opts): AsyncIterable<Env> {
      prompts.push(opts.prompt);
      yield { type: 'result', sessionId: 'sess' };
      yield { type: 'assistant', content: `reply:${opts.prompt}`, sessionId: 'sess' };
    },
  };
  return { backend, prompts };
}

function setup(backend: SdkBackend, home = mkdtempSync(join(tmpdir(), 'patch-jobtrigger-'))) {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-jobtriggerfolder-')));
  mkdirSync(folder, { recursive: true });
  const metaStore = createMetaStore(home);
  const events: WireEvent[] = [];
  let id = 0;
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore,
    sdkBackend: backend,
    oauthAccessToken: 'fake-token',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => Date.now(),
    generateChatId: () => `chat-${++id}`,
  });
  return { daemon, metaStore, folder, events, home };
}

/** The persisted user-role `chat.message` frames for this chat, in order. */
function userMessages(events: WireEvent[], chatId: string): ChatMessageEvent[] {
  return events.filter(
    (e): e is ChatMessageEvent =>
      e.type === 'chat.message' && e.chatId === chatId && e.role === 'user',
  );
}

describe('job trigger turn (spec/08 § Action, spec/14 § Job trigger turn)', () => {
  it('an ordinary composer turn carries no jobTrigger', async () => {
    const { backend } = recordingBackend();
    const { daemon, folder, events } = setup(backend);
    const chatId = await daemon.spawnChat({ folder });
    await tick();

    await daemon.sendInput({ chatId, message: 'plan the veg beds', localId: 'u1' });
    await tick();

    expect(userMessages(events, chatId).map((m) => m.jobTrigger)).toEqual([undefined]);
  });

  it("a job's fire into an EXISTING chat carries jobTrigger, even though it is not the chat's first turn", async () => {
    const { backend } = recordingBackend();
    const { daemon, folder, events } = setup(backend);
    const chatId = await daemon.spawnChat({ folder });
    await tick();

    // Turn 1: Tom's own message — the chat is not fresh.
    await daemon.sendInput({ chatId, message: 'watch this bus route for me', localId: 'u1' });
    await tick();
    // Turn 2: the job dispatcher's `continue` action firing a later tick into
    // the SAME chat — exactly what index.ts does for `chat.input.source.kind
    // === 'job'`.
    await daemon.sendInput({
      chatId,
      message: '{"route":"36","etaMinutes":4}',
      localId: 'j1',
      jobTrigger: true,
    });
    await tick();

    const msgs = userMessages(events, chatId);
    expect(msgs.map((m) => m.content)).toEqual([
      'watch this bus route for me',
      '{"route":"36","etaMinutes":4}',
    ]);
    expect(msgs[0]?.jobTrigger).toBeUndefined();
    expect(msgs[1]?.jobTrigger).toBe(true);
  });

  it('a jobTrigger fire that queues behind a running turn still carries it once it runs', async () => {
    const gates: Array<() => void> = [];
    const backend: SdkBackend = {
      async *run(opts): AsyncIterable<Env> {
        await new Promise<void>((resolve) => gates.push(resolve));
        yield { type: 'result', sessionId: 'sess' };
        yield { type: 'assistant', content: `reply:${opts.prompt}`, sessionId: 'sess' };
      },
    };
    const { daemon, folder, events } = setup(backend);
    const chatId = await daemon.spawnChat({ folder });
    await tick();

    const first = daemon.sendInput({ chatId, message: 'from Tom', localId: 'u1' });
    await tick();
    const second = daemon.sendInput({
      chatId,
      message: 'a later job tick',
      localId: 'j1',
      jobTrigger: true,
    });
    await tick();
    gates.shift()?.();
    await tick();
    gates.shift()?.();
    await Promise.all([first, second]);
    await tick();

    const msgs = userMessages(events, chatId);
    expect(msgs.map((m) => m.content)).toEqual(['from Tom', 'a later job tick']);
    expect(msgs[0]?.jobTrigger).toBeUndefined();
    expect(msgs[1]?.jobTrigger).toBe(true);
  });

  it('a jobTrigger turn interrupted by a host restart is resumed still carrying jobTrigger', async () => {
    const { backend } = recordingBackend();
    const { metaStore, folder } = setup(backend);

    const events: WireEvent[] = [];
    let turn = 0;
    const dying = new Daemon({
      daemonId: 'd1',
      metaStore,
      sdkBackend: {
        async *run(opts): AsyncIterable<Env> {
          if (turn++ > 0) await new Promise<void>(() => {});
          yield { type: 'result', sessionId: 'sess' };
          yield { type: 'assistant', content: `reply:${opts.prompt}`, sessionId: 'sess' };
        },
      },
      oauthAccessToken: 'fake-token',
      emit: () => {},
      logger: silent,
      now: () => Date.now(),
      generateChatId: () => 'chat-1',
    });
    const chatId = await dying.spawnChat({ folder });
    await tick();
    await dying.sendInput({ chatId, message: 'watch this for me', localId: 'u1' });
    await tick();
    void dying.sendInput({
      chatId,
      message: 'a job tick killed mid-turn',
      localId: 'j1',
      jobTrigger: true,
    });
    await tick(80);

    // On disk as owed, tagged jobTrigger — exactly like `origin`.
    expect(metaStore.read(chatId)?.pendingTurns?.[0]?.jobTrigger).toBe(true);

    const reborn = new Daemon({
      daemonId: 'd1',
      metaStore,
      sdkBackend: backend,
      oauthAccessToken: 'fake-token',
      emit: (e) => events.push(e),
      logger: silent,
      now: () => Date.now(),
      generateChatId: () => 'chat-2',
    });
    reborn.hydrate();
    await tick(200);

    // The resumed turn's content is the host's own interrupted-turn reminder
    // (see `resumeInterruptedTurns` — "Carry on"), not the original text; what
    // matters here is that jobTrigger rode along, same as `origin` does.
    const msgs = userMessages(events, chatId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.jobTrigger).toBe(true);
  });
});
