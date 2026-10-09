// spec/04 § Message delivery — a message sent while a turn is running reaches
// the agent at the next tool boundary instead of waiting for the turn to end.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { ChatInputEvent, WireEvent } from '@patch/wire';
import { Daemon, type DaemonOptions } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import type { SdkBackend } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });

/**
 * A backend whose turn runs one "tool batch": it blocks until released, then
 * asks the runner what to say at the tool boundary (as the SDK's PostToolBatch
 * hook does), records the answer, and finishes.
 */
function boundaryBackend() {
  const prompts: string[] = [];
  const boundaryText: Array<string | undefined> = [];
  const gates: Array<() => void> = [];
  const backend: SdkBackend = {
    async *run(opts): AsyncIterable<{ type: string; [k: string]: unknown }> {
      prompts.push(opts.prompt);
      await new Promise<void>((resolve) => gates.push(resolve));
      boundaryText.push(await opts.onToolBoundary?.());
      yield { type: 'result', sessionId: 'sess' };
      yield { type: 'assistant', content: `reply:${opts.prompt}`, sessionId: 'sess' };
    },
  };
  const releaseNext = (): void => gates.shift()?.();
  return { backend, prompts, boundaryText, releaseNext };
}

function setup(backend: SdkBackend, extra: Partial<DaemonOptions> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'patch-boundary-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-bfolder-')));
  mkdirSync(folder, { recursive: true });
  const events: WireEvent[] = [];
  let id = 0;
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: backend,
    oauthAccessToken: 'fake-token',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${++id}`,
    ...extra,
  });
  return { daemon, events, folder };
}

const tick = (ms = 15): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('delivery at a tool boundary (spec/04)', () => {
  it('hands waiting messages to the agent at the boundary and runs no extra turn', async () => {
    const b = boundaryBackend();
    const { daemon, events, folder } = setup(b.backend);
    const chatId = await daemon.spawnChat({ folder });

    void daemon.sendInput({ chatId, message: 'one', localId: 'L1' });
    await tick();
    void daemon.sendInput({ chatId, message: 'two', localId: 'L2' });
    void daemon.sendInput({ chatId, message: 'three', localId: 'L3' });
    await tick();
    expect(events.filter((e) => e.type === 'chat.queued')).toHaveLength(2);

    b.releaseNext(); // the tool batch finishes, the boundary fires
    await tick();

    expect(b.prompts).toEqual(['one']); // no turn of their own
    expect(b.boundaryText[0]).toContain('two');
    expect(b.boundaryText[0]).toContain('three');
    expect(b.boundaryText[0]!.indexOf('two')).toBeLessThan(b.boundaryText[0]!.indexOf('three'));

    const delivered = events.filter(
      (e) => e.type === 'chat.dequeued' && (e as { delivered?: boolean }).delivered === true,
    );
    expect(delivered.map((e) => (e as { localId: string }).localId)).toEqual(['L2', 'L3']);
    expect(
      events.filter(
        (e) =>
          e.type === 'chat.dequeued' &&
          (e as { reason: string; delivered?: boolean }).reason === 'running' &&
          (e as { delivered?: boolean }).delivered !== true,
      ),
    ).toEqual([]);

    // Each is in the transcript at the point the agent saw it, flagged as mid-turn.
    const midTurn = events.filter(
      (e) => e.type === 'chat.message' && (e as { midTurn?: boolean }).midTurn === true,
    ) as Array<{ localId: string; content: string; role: string }>;
    expect(midTurn.map((m) => [m.localId, m.content, m.role])).toEqual([
      ['L2', 'two', 'user'],
      ['L3', 'three', 'user'],
    ]);
    expect(daemon.chatState.get(chatId)?.activity).toBe('idle');
  });

  it('says nothing at the boundary when nothing is waiting', async () => {
    const b = boundaryBackend();
    const { daemon, folder } = setup(b.backend);
    const chatId = await daemon.spawnChat({ folder });

    void daemon.sendInput({ chatId, message: 'one', localId: 'L1' });
    await tick();
    b.releaseNext();
    await tick();

    expect(b.boundaryText).toEqual([undefined]);
  });

  it('labels an automatic message as automatic, not as the user', async () => {
    const b = boundaryBackend();
    const { daemon, folder } = setup(b.backend);
    const chatId = await daemon.spawnChat({ folder });

    void daemon.sendInput({ chatId, message: 'one', localId: 'L1' });
    await tick();
    void daemon.sendInput({ chatId, message: 'still there?', localId: 'L2', origin: 'machine' });
    await tick();
    b.releaseNext();
    await tick();

    expect(b.boundaryText[0]).toContain('automatic message');
    expect(b.boundaryText[0]).not.toContain('The user sent');
  });
});

describe('boundaryHooks (SDK wiring)', () => {
  it('adds no hooks when the run has no boundary callback', async () => {
    const { boundaryHooks } = await import('../src/sdkBackend.js');
    expect(boundaryHooks({})).toEqual({});
  });

  it('returns the callback text as PostToolBatch context, and nothing when there is none', async () => {
    const { boundaryHooks } = await import('../src/sdkBackend.js');
    let next: string | undefined = 'hello';
    const hooks = boundaryHooks({ onToolBoundary: () => next }).hooks;
    const run = hooks!.PostToolBatch[0]!.hooks[0]!;
    const input = {} as never;
    const opts = { signal: new AbortController().signal };
    expect(await run(input, undefined, opts)).toEqual({
      hookSpecificOutput: { hookEventName: 'PostToolBatch', additionalContext: 'hello' },
    });
    next = undefined;
    expect(await run(input, undefined, opts)).toEqual({});
  });
});

describe('delivery of what the server holds (spec/04 server-run queue)', () => {
  it('asks the server at the tool boundary and hands the answer to the agent in order', async () => {
    const b = boundaryBackend();
    const asked: string[] = [];
    const waiting: ChatInputEvent[] = [
      { type: 'chat.input', chatId: 'chat-1', message: 'from server one', localId: 'S1' },
      { type: 'chat.input', chatId: 'chat-1', message: 'from server two', localId: 'S2' },
    ];
    const { daemon, events, folder } = setup(b.backend, {
      pullQueued: async (chatId) => {
        asked.push(chatId);
        return waiting.splice(0);
      },
    });
    const chatId = await daemon.spawnChat({ folder });

    void daemon.sendInput({ chatId, message: 'one', localId: 'L1' });
    await tick();
    b.releaseNext();
    await tick(60);

    expect(asked).toEqual([chatId]);
    expect(b.prompts).toEqual(['one']); // no turn of their own
    expect(b.boundaryText[0]).toContain('from server one');
    expect(b.boundaryText[0]!.indexOf('from server one')).toBeLessThan(
      b.boundaryText[0]!.indexOf('from server two'),
    );
    const delivered = events.filter(
      (e) => e.type === 'chat.dequeued' && (e as { delivered?: boolean }).delivered === true,
    );
    expect(delivered.map((e) => (e as { localId: string }).localId)).toEqual(['S1', 'S2']);
  });

  it("puts the server's messages behind what the host already holds", async () => {
    const b = boundaryBackend();
    const { daemon, folder } = setup(b.backend, {
      pullQueued: async () => [
        { type: 'chat.input', chatId: 'chat-1', message: 'from server', localId: 'S1' },
      ],
    });
    const chatId = await daemon.spawnChat({ folder });

    void daemon.sendInput({ chatId, message: 'one', localId: 'L1' });
    await tick();
    void daemon.sendInput({ chatId, message: 'host held', localId: 'H1' });
    await tick();
    b.releaseNext();
    await tick(60);

    expect(b.boundaryText[0]!.indexOf('host held')).toBeLessThan(
      b.boundaryText[0]!.indexOf('from server'),
    );
  });

  it('carries on with the turn when the server cannot be asked', async () => {
    const b = boundaryBackend();
    const { daemon, folder } = setup(b.backend, { pullQueued: async () => [] });
    const chatId = await daemon.spawnChat({ folder });
    void daemon.sendInput({ chatId, message: 'one', localId: 'L1' });
    await tick();
    b.releaseNext();
    await tick(60);
    expect(b.boundaryText).toEqual([undefined]);
    expect(daemon.chatState.get(chatId)?.activity).toBe('idle');
  });
});

describe('standing in for the Manager (spec/06 § Manager failover)', () => {
  it('numbers the thread on from the given seq and gives the handoff once, with the next message', async () => {
    const prompts: string[] = [];
    const backend: SdkBackend = {
      async *run(opts): AsyncIterable<{ type: string; [k: string]: unknown }> {
        prompts.push(opts.prompt);
        yield { type: 'result', sessionId: 'sess' };
        yield { type: 'assistant', content: 'ok', sessionId: 'sess' };
      },
    };
    const consumed: string[] = [];
    const { daemon, events, folder } = setup(backend, {
      onHandoffConsumed: (id) => consumed.push(id),
    });
    const chatId = await daemon.spawnChat({ folder });
    daemon.adoptThread(chatId, { nextSeq: 40, handoff: 'You are the Manager. user: hello' });

    await daemon.sendInput({ chatId, message: 'first', localId: 'L1' });
    await daemon.sendInput({ chatId, message: 'second', localId: 'L2' });

    expect(prompts[0]).toContain('You are the Manager. user: hello');
    expect(prompts[0]).toContain('first');
    expect(prompts[1]).not.toContain('You are the Manager');
    expect(consumed).toEqual([chatId]);

    const seqs = events
      .filter((e) => e.type === 'chat.message')
      .map((e) => (e as { seq: number }).seq);
    expect(Math.min(...seqs)).toBeGreaterThanOrEqual(40);
    // The handoff is disclosed as context, not typed into the user's own message.
    const firstUser = events.find(
      (e) => e.type === 'chat.message' && (e as { role: string }).role === 'user',
    ) as { content: string; systemContext?: unknown[] };
    expect(firstUser.content).toBe('first');
    expect(JSON.stringify(firstUser.systemContext)).toContain('You are the Manager');
  });

  it('never lowers the numbering it already has', async () => {
    const backend: SdkBackend = {
      async *run(): AsyncIterable<{ type: string; [k: string]: unknown }> {
        yield { type: 'result', sessionId: 's' };
        yield { type: 'assistant', content: 'ok', sessionId: 's' };
      },
    };
    const { daemon, events, folder } = setup(backend);
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'a', localId: 'A' });
    const before = Math.max(
      ...events.filter((e) => e.type === 'chat.message').map((e) => (e as { seq: number }).seq),
    );
    daemon.adoptThread(chatId, { nextSeq: 1, handoff: 'h' });
    await daemon.sendInput({ chatId, message: 'b', localId: 'B' });
    const after = Math.max(
      ...events.filter((e) => e.type === 'chat.message').map((e) => (e as { seq: number }).seq),
    );
    expect(after).toBeGreaterThan(before);
  });

  it('forgets a handoff when the Manager goes back to its home host', async () => {
    const prompts: string[] = [];
    const backend: SdkBackend = {
      async *run(opts): AsyncIterable<{ type: string; [k: string]: unknown }> {
        prompts.push(opts.prompt);
        yield { type: 'result', sessionId: 's' };
        yield { type: 'assistant', content: 'ok', sessionId: 's' };
      },
    };
    const { daemon, folder } = setup(backend);
    const chatId = await daemon.spawnChat({ folder });
    daemon.adoptThread(chatId, { nextSeq: 0, handoff: 'stale handoff' });
    daemon.dropThreadHandoff(chatId);
    await daemon.sendInput({ chatId, message: 'hi', localId: 'L1' });
    expect(prompts[0]).not.toContain('stale handoff');
  });
});

describe("the server's numbering (chat.committed)", () => {
  it('carries on above what the server holds, and never lowers the numbering', async () => {
    const backend: SdkBackend = {
      async *run(): AsyncIterable<{ type: string; [k: string]: unknown }> {
        yield { type: 'result', sessionId: 's' };
        yield { type: 'assistant', content: 'ok', sessionId: 's' };
      },
    };
    const { daemon, events, folder } = setup(backend);
    const chatId = await daemon.spawnChat({ folder });
    daemon.noteCommitted(chatId, 40);
    await daemon.sendInput({ chatId, message: 'a', localId: 'A' });
    const seqs = (): number[] =>
      events.filter((e) => e.type === 'chat.message').map((e) => (e as { seq: number }).seq);
    expect(Math.min(...seqs())).toBeGreaterThanOrEqual(41);

    const high = Math.max(...seqs());
    daemon.noteCommitted(chatId, 3); // the server is behind this host: nothing changes
    await daemon.sendInput({ chatId, message: 'b', localId: 'B' });
    expect(Math.max(...seqs())).toBeGreaterThan(high);
  });

  it('ignores a chat it does not hold', () => {
    const { daemon } = setup({
      async *run() {
        yield { type: 'result', sessionId: 's' };
      },
    });
    expect(() => daemon.noteCommitted('nope', 9)).not.toThrow();
  });
});

describe('the host log and the server (spec/01 § Message log)', () => {
  const echo: SdkBackend = {
    async *run(opts): AsyncIterable<{ type: string; [k: string]: unknown }> {
      yield { type: 'result', sessionId: 's' };
      yield { type: 'assistant', content: `re:${opts.prompt}`, sessionId: 's' };
    },
  };

  it('says how far its own log reaches on every state frame', async () => {
    const { daemon, events, folder } = setup(echo);
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'a', localId: 'A' });
    const states = events.filter((e) => e.type === 'chat.state') as Array<{ lastSeq?: number }>;
    const last = states.at(-1)!.lastSeq;
    const messageSeqs = events
      .filter((e) => e.type === 'chat.message')
      .map((e) => (e as { seq: number }).seq);
    expect(last).toBeGreaterThanOrEqual(Math.max(...messageSeqs));
  });

  it('hands over its logged events after a seq, oldest first', async () => {
    const { daemon, folder } = setup(echo);
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'one', localId: 'A' });
    await daemon.sendInput({ chatId, message: 'two', localId: 'B' });
    const all = daemon.eventsAfter(chatId, -1) as Array<{ seq: number; content?: string }>;
    const seqs = all.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(all.map((e) => e.content)).toContain('re:two');
    const tail = daemon.eventsAfter(chatId, seqs[1]!) as Array<{ seq: number }>;
    expect(tail.every((e) => e.seq > seqs[1]!)).toBe(true);
    expect(tail.length).toBe(all.length - 2);
  });

  it("rebuilds a lost log from the server's events, once, and carries its numbering on above them", async () => {
    const source = setup(echo);
    const sourceChat = await source.daemon.spawnChat({ folder: source.folder });
    await source.daemon.sendInput({ chatId: sourceChat, message: 'one', localId: 'A' });
    await source.daemon.sendInput({ chatId: sourceChat, message: 'two', localId: 'B' });
    const held = source.daemon.eventsAfter(sourceChat, -1);

    // A host that lost its log: a fresh chat, holding nothing.
    const lost = setup(echo);
    const chatId = await lost.daemon.spawnChat({ folder: lost.folder });
    const written = lost.daemon.restoreEvents(chatId, held);
    expect(written).toBeGreaterThan(0);

    const restored = lost.daemon.eventsAfter(chatId, -1) as Array<{
      seq: number;
      content?: string;
    }>;
    expect(restored.map((e) => e.content)).toEqual(
      (held as Array<{ content?: string }>).map((e) => e.content),
    );
    // Sent twice, written once.
    expect(lost.daemon.restoreEvents(chatId, held)).toBe(0);

    // New messages carry on above what was restored.
    const top = Math.max(...restored.map((e) => e.seq));
    await lost.daemon.sendInput({ chatId, message: 'three', localId: 'C' });
    const after = lost.daemon.eventsAfter(chatId, top) as Array<{ seq: number }>;
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((e) => e.seq > top)).toBe(true);
  });

  it('skips events that are not part of a transcript when restoring', async () => {
    const { daemon, folder } = setup(echo);
    const chatId = await daemon.spawnChat({ folder });
    expect(
      daemon.restoreEvents(chatId, [
        { type: 'chat.message_delta', chatId, messageSeq: 1, delta: 'x' } as never,
      ]),
    ).toBe(0);
  });
});

describe('a message from one chat to another (submitInput)', () => {
  it('returns once an idle target has taken it, not when its turn is over', async () => {
    const b = boundaryBackend();
    const { daemon, folder } = setup(b.backend);
    const chatId = await daemon.spawnChat({ folder });

    let returned = false;
    const sending = daemon
      .submitInput({ chatId, message: 'from another chat', localId: 'S1', origin: 'machine' })
      .then(() => {
        returned = true;
      });
    await tick(60);
    expect(b.prompts).toEqual(['from another chat']); // its turn started
    expect(returned).toBe(true); // and the sender is not waiting on it
    expect(daemon.chatState.get(chatId)?.activity).toBe('running');

    b.releaseNext();
    await sending;
    await tick(60);
    expect(daemon.chatState.get(chatId)?.activity).toBe('idle');
  });

  it('returns at once for a busy target, and the message reaches the agent at its next tool boundary', async () => {
    const b = boundaryBackend();
    const { daemon, folder } = setup(b.backend);
    const chatId = await daemon.spawnChat({ folder });
    void daemon.sendInput({ chatId, message: 'work', localId: 'L1' });
    await tick();

    await daemon.submitInput({
      chatId,
      message: 'a word from the other chat',
      localId: 'S1',
      origin: 'machine',
    });
    expect(b.prompts).toEqual(['work']); // not a turn of its own

    b.releaseNext();
    await tick(60);
    expect(b.boundaryText[0]).toContain('a word from the other chat');
    expect(b.boundaryText[0]).toContain('automatic message');
  });

  it('refuses an unknown chat, as the caller must hear', async () => {
    const { daemon } = setup(boundaryBackend().backend);
    await expect(
      daemon.submitInput({ chatId: 'nope', message: 'x', localId: 'S1', origin: 'machine' }),
    ).rejects.toThrow();
  });

  it('is answered again, not run again, for a localId it already took', async () => {
    const b = boundaryBackend();
    const { daemon, folder } = setup(b.backend);
    const chatId = await daemon.spawnChat({ folder });
    await daemon.submitInput({ chatId, message: 'once', localId: 'S1', origin: 'machine' });
    await daemon.submitInput({ chatId, message: 'once', localId: 'S1', origin: 'machine' });
    b.releaseNext();
    await tick(60);
    expect(b.prompts).toEqual(['once']);
  });

  it("does not make the sender fail when the target's turn fails after it was taken", async () => {
    const failing: SdkBackend = {
      async *run(): AsyncIterable<{ type: string; [k: string]: unknown }> {
        await new Promise((r) => setTimeout(r, 20));
        throw new Error('the model fell over');
      },
    };
    const { daemon, folder } = setup(failing);
    const chatId = await daemon.spawnChat({ folder });
    await expect(
      daemon.submitInput({ chatId, message: 'x', localId: 'S1', origin: 'machine' }),
    ).resolves.toBeUndefined();
    await tick(120); // the failure lands afterwards, on the chat, with nothing unhandled
  });
});
