// spec/09 § Whose turn it was — the host tags every turn with who started it
// and carries that on `chat.state`, so the server can tell a chat finishing work
// the user is waiting on from a background loop ticking over.
//
// Integration against the real Host: each test drives a turn the way the
// product actually starts one (composer, self-wake, todo auto-advance, an
// agent's send_to) and reads the origin off the `chat.state` that settles it.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent, TurnOrigin } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import type { SdkBackend } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });
const tick = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Poll until `cond` holds — a fixed sleep races the pump's settle -> drain ->
 * next-turn chain on a loaded box.
 */
const waitFor = (cond: () => boolean, ms = 3000): Promise<void> =>
  new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = (): void => {
      if (cond()) return resolve();
      if (Date.now() - start > ms) return reject(new Error('waitFor: condition never held'));
      setTimeout(poll, 5);
    };
    poll();
  });

type Env = { type: string; [k: string]: unknown };
type TodoStatus = 'pending' | 'in_progress' | 'completed';

const withoutReminder = (prompt: string): string =>
  prompt.replace(/^(?:<system-reminder>[\s\S]*?<\/system-reminder>\s*)+/, '');

function recordingBackend() {
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

/** Emits a scripted TodoWrite list per prompt, to drive the auto-advance chain. */
function todoBackend(script: Record<string, Array<[string, TodoStatus]>>) {
  const backend: SdkBackend = {
    async *run(opts): AsyncIterable<Env> {
      const list = script[withoutReminder(opts.prompt)];
      if (list) {
        yield {
          type: 'tool_use',
          tool: {
            name: 'TodoWrite',
            args: {
              todos: list.map(([content, status]) => ({ content, status, activeForm: content })),
            },
            callId: `tw-${Math.random().toString(36).slice(2, 8)}`,
          },
        };
      }
      yield { type: 'result', sessionId: 'sess' };
      yield { type: 'assistant', content: `reply:${opts.prompt}`, sessionId: 'sess' };
    },
  };
  return backend;
}

function setup(backend: SdkBackend, opts: { autoAdvanceTodos?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'patch-origin-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-originfolder-')));
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
    autoAdvanceTodos: opts.autoAdvanceTodos ?? false,
  });
  return { daemon, metaStore, folder, events };
}

/**
 * The origins carried by the `chat.state` frames that settle a turn — the exact
 * frames the server's chat-completion notifier acts on (running → idle).
 */
function settledOrigins(events: WireEvent[], chatId: string): Array<TurnOrigin | undefined> {
  const origins: Array<TurnOrigin | undefined> = [];
  let previous: string | undefined;
  for (const e of events) {
    if (e.type !== 'chat.state' || e.chatId !== chatId) continue;
    const activity = (e as { activity: string }).activity;
    if (activity === 'idle' && previous === 'running') {
      origins.push((e as { turnOrigin?: TurnOrigin }).turnOrigin);
    }
    previous = activity;
  }
  return origins;
}

describe('turn origin (spec/09 § Whose turn it was)', () => {
  it('a composer turn settles as a user turn', async () => {
    const b = recordingBackend();
    const { daemon, folder, events } = setup(b.backend);
    const chatId = await daemon.spawnChat({ folder });
    await tick();

    await daemon.sendInput({ chatId, message: 'plan the veg beds', localId: 'u1' });
    await tick();

    expect(settledOrigins(events, chatId)).toEqual(['user']);
  });

  // Tom's own example: "some things are silent, like a loop to check something".
  it('a self-wake turn settles as a machine turn', async () => {
    const b = recordingBackend();
    const { daemon, folder, events } = setup(b.backend);
    const chatId = await daemon.spawnChat({ folder });
    await tick();

    daemon.scheduleWake(chatId, { in: 0.01, message: 'check the site again' });
    await tick(200);

    // The wake really did run a turn, and it settled silent.
    expect(b.prompts.some((p) => withoutReminder(p).startsWith('[wake]'))).toBe(true);
    expect(settledOrigins(events, chatId)).toEqual(['machine']);
  });

  it('a wake loop stays silent tick after tick', async () => {
    const b = recordingBackend();
    const { daemon, folder, events } = setup(b.backend);
    const chatId = await daemon.spawnChat({ folder });
    await tick();

    for (let i = 0; i < 3; i++) {
      daemon.scheduleWake(chatId, { in: 0.01, message: `tick ${i}` });
      await tick(120);
    }

    const origins = settledOrigins(events, chatId);
    expect(origins).toHaveLength(3);
    expect(origins.every((o) => o === 'machine')).toBe(true);
  });

  it('a todo auto-advance turn settles as a machine turn, the user turn that started it does not', async () => {
    const backend = todoBackend({
      'do my chores': [
        ['sweep', 'pending'],
        ['mop', 'pending'],
      ],
      '[todo] sweep': [
        ['sweep', 'completed'],
        ['mop', 'pending'],
      ],
      '[todo] mop': [
        ['sweep', 'completed'],
        ['mop', 'completed'],
      ],
    });
    const { daemon, folder, events } = setup(backend, { autoAdvanceTodos: true });
    const chatId = await daemon.spawnChat({ folder });
    await tick();

    await daemon.sendInput({ chatId, message: 'do my chores', localId: 'u1' });
    await tick(200);

    // One request from Tom, three turns — he hears about it once, not per item.
    expect(settledOrigins(events, chatId)).toEqual(['user', 'machine', 'machine']);
  });

  it("an agent's send_to lands as a machine turn in the receiving chat", async () => {
    const b = recordingBackend();
    const { daemon, folder, events } = setup(b.backend);
    const chatId = await daemon.spawnChat({ folder });
    await tick();

    // What control.ts does for `patch_send_to`: the destination is an agent, so
    // nobody is waiting on the doorbell.
    await daemon.sendInput({
      chatId,
      message: 'the build finished, take it from here',
      localId: 's1',
      origin: 'machine',
    });
    await tick();

    expect(settledOrigins(events, chatId)).toEqual(['machine']);
  });

  it('a machine turn does not make the next user turn silent', async () => {
    const b = recordingBackend();
    const { daemon, folder, events } = setup(b.backend);
    const chatId = await daemon.spawnChat({ folder });
    await tick();

    daemon.scheduleWake(chatId, { in: 0.01, message: 'check again' });
    await tick(200);
    await daemon.sendInput({ chatId, message: 'what did you find?', localId: 'u1' });
    await tick();

    expect(settledOrigins(events, chatId)).toEqual(['machine', 'user']);
  });

  // spec/04 § Message queueing — a chat draining a queue reports one continuous
  // `running` period, so there is exactly ONE settling frame for the whole drain
  // and its origin describes the drain, not whichever turn happened to run last.
  it('a drain the user sent into settles as a user turn, whichever turn ran last', async () => {
    const gated = (): { backend: SdkBackend; release: () => void } => {
      const gates: Array<() => void> = [];
      return {
        backend: {
          async *run(opts): AsyncIterable<Env> {
            await new Promise<void>((resolve) => gates.push(resolve));
            yield { type: 'result', sessionId: 'sess' };
            yield { type: 'assistant', content: `reply:${opts.prompt}`, sessionId: 'sess' };
          },
        },
        release: () => gates.shift()?.(),
      };
    };

    // Machine turn running, the user's message queued behind it.
    {
      const g = gated();
      const { daemon, folder, events } = setup(g.backend);
      const chatId = await daemon.spawnChat({ folder });
      await tick();
      const first = daemon.sendInput({
        chatId,
        message: 'from the machine',
        localId: 'm1',
        origin: 'machine',
      });
      await tick();
      const second = daemon.sendInput({ chatId, message: 'from Tom', localId: 'u1' });
      await tick();
      g.release();
      await tick();
      g.release();
      await Promise.all([first, second]);
      await tick();
      expect(settledOrigins(events, chatId)).toEqual(['user']);
    }

    // The other way round: the user's turn running, a self-wake / send_to queued
    // in behind it and running last. The user is still the one waiting, so the
    // settle must not go silent on them.
    {
      const g = gated();
      const { daemon, folder, events } = setup(g.backend);
      const chatId = await daemon.spawnChat({ folder });
      await tick();
      const first = daemon.sendInput({ chatId, message: 'from Tom', localId: 'u1' });
      await tick();
      const second = daemon.sendInput({
        chatId,
        message: 'from the machine',
        localId: 'm1',
        origin: 'machine',
      });
      await tick();
      g.release();
      await tick();
      g.release();
      await Promise.all([first, second]);
      await tick();
      expect(settledOrigins(events, chatId)).toEqual(['user']);
    }
  });

  it('a drain of nothing but machine turns still settles as a machine turn', async () => {
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

    const first = daemon.sendInput({
      chatId,
      message: 'wake tick',
      localId: 'm1',
      origin: 'machine',
    });
    await tick();
    const second = daemon.sendInput({
      chatId,
      message: 'another agent',
      localId: 'm2',
      origin: 'machine',
    });
    await tick();
    gates.shift()?.();
    await tick();
    gates.shift()?.();
    await Promise.all([first, second]);
    await tick();

    expect(settledOrigins(events, chatId)).toEqual(['machine']);
  });

  // Tom: "sending a completion notification when a turn is ended via
  // interruption of a new message instead of actually getting to the end". A
  // promote (the up-arrow, or the head-of-queue 30-second auto-interrupt) stops
  // the in-flight turn so the queued turn runs NOW. That stop is part of the
  // drain, not the end of it, so the drain still has exactly ONE settling frame
  // — the frame the notifier acts on — and it lands when the promoted turn
  // finishes, not when the interrupted one was cut off.
  it('a drain interrupted by a promote still settles exactly once, at the true end', async () => {
    const abortableGated = (): {
      backend: SdkBackend;
      release: () => void;
      prompts: string[];
    } => {
      const gates: Array<() => void> = [];
      const prompts: string[] = [];
      return {
        prompts,
        backend: {
          async *run(opts): AsyncIterable<Env> {
            prompts.push(opts.prompt);
            await new Promise<void>((resolve, reject) => {
              gates.push(resolve);
              opts.abortController?.signal.addEventListener('abort', () => {
                const err = new Error('aborted');
                err.name = 'AbortError';
                reject(err);
              });
            });
            yield { type: 'result', sessionId: 'sess' };
            yield { type: 'assistant', content: `reply:${opts.prompt}`, sessionId: 'sess' };
          },
        },
        // The aborted turn's resolver is never shifted off by its own rejection,
        // so draining the gates takes one extra release per interrupted turn.
        release: () => gates.shift()?.(),
      };
    };

    // Tom's report: his own turn running, his second message queued behind it.
    {
      const g = abortableGated();
      const { daemon, folder, events } = setup(g.backend);
      const chatId = await daemon.spawnChat({ folder });
      await tick();
      void daemon.sendInput({ chatId, message: 'from Tom', localId: 'u1' });
      await tick();
      void daemon.sendInput({ chatId, message: 'actually, this instead', localId: 'u2' });
      await tick();

      await daemon.promoteInput(chatId, 'u2');
      // The promoted turn has started, so the drain has genuinely moved on...
      await waitFor(() => g.prompts.length === 2);
      // ...and nothing has settled yet — the chat is still working on it.
      expect(settledOrigins(events, chatId)).toEqual([]);

      g.release(); // the interrupted turn's stale gate
      await tick();
      g.release(); // the promoted turn finishes
      await waitFor(() => settledOrigins(events, chatId).length > 0);
      expect(settledOrigins(events, chatId)).toEqual(['user']);
    }

    // A machine turn (self-wake / send_to) interrupted by the user's promoted
    // message. The interrupted turn's own origin must not settle either — it
    // would be a `machine` frame the notifier silently drops, splitting one
    // drain into two settles.
    {
      const g = abortableGated();
      const { daemon, folder, events } = setup(g.backend);
      const chatId = await daemon.spawnChat({ folder });
      await tick();
      void daemon.sendInput({
        chatId,
        message: 'from the machine',
        localId: 'm1',
        origin: 'machine',
      });
      await tick();
      void daemon.sendInput({ chatId, message: 'stop, do this', localId: 'u1' });
      await tick();

      await daemon.promoteInput(chatId, 'u1');
      await waitFor(() => g.prompts.length === 2);
      expect(settledOrigins(events, chatId)).toEqual([]);

      g.release();
      await tick();
      g.release();
      await waitFor(() => settledOrigins(events, chatId).length > 0);
      expect(settledOrigins(events, chatId)).toEqual(['user']);
    }
  });

  it('a turn interrupted by a host restart is resumed with the origin it had', async () => {
    const b = recordingBackend();
    const { metaStore, folder } = setup(b.backend);

    // A host that dies mid-wake-turn leaves the turn in meta.json's
    // pendingTurns; the next host re-sends it. It must not come back as a
    // user turn and ring the doorbell for a loop Tom never asked about.
    const events: WireEvent[] = [];
    // The first turn settles (so the chat has a Claude session to resume, as a
    // real chat would); the second hangs — the "host killed mid-turn" shape.
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
    await dying.sendInput({ chatId, message: 'watch the site for me', localId: 'u1' });
    await tick();
    void dying.sendInput({
      chatId,
      message: '[wake] check the site',
      localId: 'w1',
      origin: 'machine',
    });
    await tick(80);

    // The turn is on disk as owed, tagged machine.
    expect(metaStore.read(chatId)?.pendingTurns?.[0]?.origin).toBe('machine');

    // A fresh host over the same home re-sends it.
    const reborn = new Daemon({
      daemonId: 'd1',
      metaStore,
      sdkBackend: b.backend,
      oauthAccessToken: 'fake-token',
      emit: (e) => events.push(e),
      logger: silent,
      now: () => Date.now(),
      generateChatId: () => 'chat-2',
    });
    reborn.hydrate();
    await tick(200);

    expect(settledOrigins(events, chatId)).toEqual(['machine']);
  });
});
