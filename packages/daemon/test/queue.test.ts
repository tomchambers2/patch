// spec/04 ## Message queueing — parity with Claude Code's type-ahead. Input that
// arrives while a chat is already `running` is QUEUED behind the in-flight turn
// (chat.queued) and run serially in arrival order once it finishes
// (chat.dequeued{running}); a still-pending queued turn can be cancelled
// (chat.unqueue_request → chat.dequeued{cancelled}).

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon, PERMISSION_STOPPED_MESSAGE, type DaemonOptions } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend, type SdkBackend } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });

/**
 * A backend whose every turn BLOCKS until the test releases it — lets us hold a
 * turn in `running` while we queue more input, then drain deterministically.
 * Records prompt arrival order so we can assert FIFO execution.
 */
function gatedBackend() {
  const gates: Array<() => void> = [];
  const prompts: string[] = [];
  const backend: SdkBackend = {
    async *run(opts): AsyncIterable<{ type: string; [k: string]: unknown }> {
      prompts.push(opts.prompt);
      await new Promise<void>((resolve) => gates.push(resolve));
      yield { type: 'result', sessionId: 'sess' };
      yield { type: 'assistant', content: `reply:${opts.prompt}`, sessionId: 'sess' };
    },
  };
  // Release the OLDEST still-blocked turn.
  const releaseNext = (): void => {
    const g = gates.shift();
    if (g) g();
  };
  return { backend, prompts, releaseNext, gateCount: () => gates.length };
}

/**
 * Like `gatedBackend`, but the blocked turn HONOURS its abortController the way
 * the real Agent SDK does — the iterator rejects with an AbortError when the
 * query is closed. Needed to exercise promote, which interrupts the in-flight
 * turn (spec/04 ## Message queueing § Promote).
 */
function abortableGatedBackend() {
  const gates: Array<() => void> = [];
  const prompts: string[] = [];
  const backend: SdkBackend = {
    async *run(opts): AsyncIterable<{ type: string; [k: string]: unknown }> {
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
  };
  const releaseNext = (): void => {
    const g = gates.shift();
    if (g) g();
  };
  return { backend, prompts, releaseNext };
}

function setup(backend: SdkBackend, extra: Partial<DaemonOptions> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'patch-queue-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-qfolder-')));
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

/**
 * Poll until `cond` holds. The pump chains several microtask hops per turn
 * (settle -> drain -> OAuth gate -> SDK), so a fixed sleep is a race on a loaded
 * box: it fails the PROGRESS assertion ("the next turn really started") rather
 * than the invariant under test. Waiting for the condition also gives a
 * regression more time to emit the frame it must not emit, not less.
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

describe('message queueing (spec/04)', () => {
  it('queues input that arrives while a turn is running, then drains FIFO', async () => {
    const g = gatedBackend();
    const { daemon, events, folder } = setup(g.backend);

    const chatId = await daemon.spawnChat({ folder });
    // Turn 1 — runs immediately (idle), then blocks on its gate.
    void daemon.sendInput({ chatId, message: 'one', localId: 'L1' });
    await tick();
    expect(g.prompts).toEqual(['one']); // turn 1 is running

    // Turns 2 and 3 arrive WHILE turn 1 is running → queued, not run.
    void daemon.sendInput({ chatId, message: 'two', localId: 'L2' });
    void daemon.sendInput({ chatId, message: 'three', localId: 'L3' });
    await tick();
    expect(g.prompts).toEqual(['one']); // still only turn 1 has reached the SDK

    const queued = events.filter((e) => e.type === 'chat.queued');
    expect(queued.map((e) => (e as { localId: string }).localId)).toEqual(['L2', 'L3']);
    expect(queued.map((e) => (e as { queueSeq: number }).queueSeq)).toEqual([1, 2]);
    expect((queued[0] as { message: string }).message).toBe('two');

    // Release turns one at a time → strict FIFO drain.
    g.releaseNext(); // finish turn 1
    await tick();
    expect(g.prompts).toEqual(['one', 'two']); // turn 2 dequeued + running
    g.releaseNext(); // finish turn 2
    await tick();
    expect(g.prompts).toEqual(['one', 'two', 'three']);
    g.releaseNext(); // finish turn 3
    await tick();

    // Each queued turn was announced running on dequeue.
    const dequeuedRunning = events.filter(
      (e) => e.type === 'chat.dequeued' && (e as { reason: string }).reason === 'running',
    );
    expect(dequeuedRunning.map((e) => (e as { localId: string }).localId)).toEqual(['L2', 'L3']);

    // Back to idle once the queue drains.
    expect(daemon.chatState.get(chatId)?.activity).toBe('idle');
  });

  it('unqueueInput cancels a still-pending queued turn (never runs it)', async () => {
    const g = gatedBackend();
    const { daemon, events, folder } = setup(g.backend);
    const chatId = await daemon.spawnChat({ folder });

    void daemon.sendInput({ chatId, message: 'one', localId: 'L1' }); // runs, blocks
    await tick();
    void daemon.sendInput({ chatId, message: 'two', localId: 'L2' }); // queued
    void daemon.sendInput({ chatId, message: 'three', localId: 'L3' }); // queued
    await tick();

    // Cancel the middle queued turn before it runs.
    daemon.unqueueInput(chatId, 'L2');
    const cancelled = events.filter(
      (e) => e.type === 'chat.dequeued' && (e as { reason: string }).reason === 'cancelled',
    );
    expect(cancelled.map((e) => (e as { localId: string }).localId)).toEqual(['L2']);

    g.releaseNext(); // finish turn 1
    await tick();
    g.releaseNext(); // finish turn 3 (L2 was cancelled)
    await tick();

    // L2 ('two') never reached the SDK; only one then three ran.
    expect(g.prompts).toEqual(['one', 'three']);
  });

  it('idle input still runs immediately and is NOT announced as queued', async () => {
    const g = gatedBackend();
    const { daemon, events, folder } = setup(g.backend);
    const chatId = await daemon.spawnChat({ folder });
    void daemon.sendInput({ chatId, message: 'solo', localId: 'L1' });
    await tick();
    expect(g.prompts).toEqual(['solo']);
    expect(events.filter((e) => e.type === 'chat.queued')).toHaveLength(0);
    g.releaseNext();
    await tick();
  });

  it('unqueueInput on a chat with no queue at all is a no-op', async () => {
    const g = gatedBackend();
    const { daemon, folder } = setup(g.backend);
    const chatId = await daemon.spawnChat({ folder });
    expect(() => daemon.unqueueInput(chatId, 'never-queued')).not.toThrow();
  });

  it('unqueueInput with a localId not present in an existing queue is a no-op', async () => {
    const g = gatedBackend();
    const { daemon, events, folder } = setup(g.backend);
    const chatId = await daemon.spawnChat({ folder });
    void daemon.sendInput({ chatId, message: 'one', localId: 'L1' }); // runs, blocks
    await tick();
    void daemon.sendInput({ chatId, message: 'two', localId: 'L2' }); // queued
    await tick();

    daemon.unqueueInput(chatId, 'not-in-the-queue');
    expect(
      events.some(
        (e) => e.type === 'chat.dequeued' && (e as { reason: string }).reason === 'cancelled',
      ),
    ).toBe(false);

    g.releaseNext();
    await tick();
    g.releaseNext();
    await tick();
    expect(g.prompts).toEqual(['one', 'two']);
  });

  it('promoteInput interrupts the running turn WITHOUT reordering the queue — it pushes turns queued above it along too, rather than shoving them behind it', async () => {
    const g = abortableGatedBackend();
    const { daemon, events, folder } = setup(g.backend);
    const chatId = await daemon.spawnChat({ folder });

    void daemon.sendInput({ chatId, message: 'one', localId: 'L1' }); // runs, blocks
    await tick();
    void daemon.sendInput({ chatId, message: 'two', localId: 'L2' }); // queued
    void daemon.sendInput({ chatId, message: 'three', localId: 'L3' }); // queued
    void daemon.sendInput({ chatId, message: 'four', localId: 'L4' }); // queued
    await tick();
    expect(g.prompts).toEqual(['one']);

    // Promote the MIDDLE queued turn: the running turn is stopped, but 'two'
    // (queued above 'three') is NOT shoved behind it.
    await daemon.promoteInput(chatId, 'L3');
    await tick();

    expect(events.some((e) => e.type === 'chat.stopped')).toBe(true);
    // 'two' was already scheduled to run sooner and still runs first.
    expect(g.prompts).toEqual(['one', 'two']);

    // The whole queue drains in its original, untouched order.
    g.releaseNext();
    await tick();
    g.releaseNext();
    await tick();
    g.releaseNext();
    await tick();
    expect(g.prompts).toEqual(['one', 'two', 'three', 'four']);
  });

  it('announces the stop BEFORE the promoted turn is announced as running', async () => {
    // spec/14 § Running-turn controls. `chat.stopped` carries no localId, so the
    // surface pins it on the newest user turn that is no longer queued. Emitted
    // after `chat.dequeued{running}`, that is the turn which just STARTED — Tom
    // saw his own live message stamped `Cancelled — turn stopped`, while the
    // turn actually interrupted got no label. Ordering is the whole fix, so it
    // is what this asserts.
    const g = abortableGatedBackend();
    const { daemon, events, folder } = setup(g.backend);
    const chatId = await daemon.spawnChat({ folder });

    void daemon.sendInput({ chatId, message: 'one', localId: 'L1' }); // runs, blocks
    await tick();
    void daemon.sendInput({ chatId, message: 'two', localId: 'L2' }); // queued
    await tick();

    await daemon.promoteInput(chatId, 'L2');
    await tick();

    const order = events
      .filter(
        (e) =>
          e.type === 'chat.stopped' ||
          (e.type === 'chat.dequeued' && (e as { reason: string }).reason === 'running'),
      )
      .map((e) => e.type);
    expect(order).toEqual(['chat.stopped', 'chat.dequeued']);
    // Emitted exactly once, not by both awaiters of the aborted run.
    expect(events.filter((e) => e.type === 'chat.stopped')).toHaveLength(1);
  });

  // spec/09 § A turn the user stopped. The server withholds the "<chat>
  // finished" notification on the settling frame's own `turnStopped`, and this
  // is why it cannot use `chat.stopped` instead: on a bare stop the settling
  // `chat.state{idle}` is emitted by `runQuery`'s aborted branch and the stop is
  // announced afterwards, by the other awaiter of the same run. The order is the
  // opposite of the promote case above, so no ordering rule covers both.
  it('a bare stop settles idle carrying turnStopped, and announces the stop after it', async () => {
    const g = abortableGatedBackend();
    const { daemon, events, folder } = setup(g.backend);
    const chatId = await daemon.spawnChat({ folder });

    void daemon.sendInput({ chatId, message: 'one', localId: 'L1' });
    await tick();
    const mark = events.length;
    await daemon.stopChat(chatId);
    await waitFor(() => daemon.chatState.get(chatId)?.activity === 'idle');

    const settled = events
      .slice(mark)
      .filter((e) => e.type === 'chat.state' && (e as { activity: string }).activity === 'idle');
    expect(settled).toHaveLength(1);
    expect((settled[0] as { turnStopped?: boolean }).turnStopped).toBe(true);

    const order = events
      .slice(mark)
      .filter((e) => e.type === 'chat.state' || e.type === 'chat.stopped')
      .map((e) => e.type);
    expect(order).toEqual(['chat.state', 'chat.stopped']);
  });

  // The flag belongs to the stopped TURN. A promote stops one turn precisely so
  // the next can run, and that next turn finishes for real — its settling frame
  // must say so or the user loses the notification they were waiting for.
  it('the turn a promote starts settles with turnStopped cleared', async () => {
    const g = abortableGatedBackend();
    const { daemon, events, folder } = setup(g.backend);
    const chatId = await daemon.spawnChat({ folder });

    void daemon.sendInput({ chatId, message: 'one', localId: 'L1' }); // runs, blocks
    await tick();
    void daemon.sendInput({ chatId, message: 'two', localId: 'L2' }); // queued
    await tick();

    const mark = events.length;
    await daemon.promoteInput(chatId, 'L2');
    await waitFor(() => g.prompts.length === 2);
    g.releaseNext(); // the aborted turn's stale gate (abort rejected, never shifted)
    await tick();
    g.releaseNext(); // the promoted turn runs to its real end
    await waitFor(() => daemon.chatState.get(chatId)?.activity === 'idle');

    const settled = events
      .slice(mark)
      .filter((e) => e.type === 'chat.state' && (e as { activity: string }).activity === 'idle');
    expect(settled).toHaveLength(1);
    expect((settled[0] as { turnStopped?: boolean }).turnStopped).toBe(false);
  });

  it('still announces the stop when there is no queue to drain', async () => {
    const g = abortableGatedBackend();
    const { daemon, events, folder } = setup(g.backend);
    const chatId = await daemon.spawnChat({ folder });

    void daemon.sendInput({ chatId, message: 'one', localId: 'L1' });
    await tick();
    await daemon.stopChat(chatId);
    await tick();

    expect(events.filter((e) => e.type === 'chat.stopped')).toHaveLength(1);
  });

  it('promoteInput on a localId that is not queued is a complete no-op (no interrupt)', async () => {
    const g = abortableGatedBackend();
    const { daemon, events, folder } = setup(g.backend);
    const chatId = await daemon.spawnChat({ folder });

    void daemon.sendInput({ chatId, message: 'one', localId: 'L1' }); // runs, blocks
    await tick();
    void daemon.sendInput({ chatId, message: 'two', localId: 'L2' }); // queued
    await tick();

    await daemon.promoteInput(chatId, 'nope');
    await tick();
    // NO FALLBACK: nothing to promote ⇒ the running turn is NOT interrupted.
    expect(events.some((e) => e.type === 'chat.stopped')).toBe(false);
    expect(g.prompts).toEqual(['one']);

    g.releaseNext();
    await tick();
    g.releaseNext();
    await tick();
    expect(g.prompts).toEqual(['one', 'two']);
  });

  it('promoteInput on a chat with no queue at all is a no-op', async () => {
    const g = abortableGatedBackend();
    const { daemon, events, folder } = setup(g.backend);
    const chatId = await daemon.spawnChat({ folder });
    await expect(daemon.promoteInput(chatId, 'never-queued')).resolves.toBeUndefined();
    expect(events.some((e) => e.type === 'chat.stopped')).toBe(false);
  });

  it('promoting the head of the queue still interrupts (it should run NOW)', async () => {
    const g = abortableGatedBackend();
    const { daemon, events, folder } = setup(g.backend);
    const chatId = await daemon.spawnChat({ folder });

    void daemon.sendInput({ chatId, message: 'one', localId: 'L1' });
    await tick();
    void daemon.sendInput({ chatId, message: 'two', localId: 'L2' }); // queued, head
    await tick();

    await daemon.promoteInput(chatId, 'L2');
    await tick();
    expect(events.some((e) => e.type === 'chat.stopped')).toBe(true);
    expect(g.prompts).toEqual(['one', 'two']);
    g.releaseNext();
    await tick();
  });

  it('a chat deleted between two queued turns fails the second turn loudly (runQuery: unknown chatId)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-queue-race-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-queue-race-folder-')));
    mkdirSync(folder, { recursive: true });
    const g = gatedBackend();
    let daemon!: Daemon;
    daemon = new Daemon({
      daemonId: 'd1',
      metaStore: createMetaStore(home),
      sdkBackend: g.backend,
      oauthAccessToken: 'fake-token',
      emit: () => undefined,
      logger: silent,
      now: () => 1_700_000_000_000,
      generateChatId: () => 'queue-race-1',
      onTurnCommitted: (chatId) => {
        // Simulates an external actor (e.g. `patch host clean`) deleting
        // chat_state in the narrow gap between two queued turns finishing and
        // starting.
        daemon.chatState.delete(chatId);
      },
    });
    const chatId = await daemon.spawnChat({ folder });
    const p1 = daemon.sendInput({ chatId, message: 'a', localId: 'A' });
    await tick();
    const p2 = daemon.sendInput({ chatId, message: 'b', localId: 'B' }); // queues behind A
    await tick();
    g.releaseNext(); // finish turn A -> onTurnCommitted deletes chat_state -> drain tries turn B
    await expect(p1).rejects.toThrow(/unknown chatId/);
    await expect(p2).resolves.toBeUndefined();
  });
  // spec/04 ## Message queueing § Activity across a drain. A turn settling with
  // more turns still queued behind it has NOT finished the chat's work — the
  // pump starts the next one immediately. Emitting `idle` there told the server's
  // Manager watch loop (spec/06 § The watch loop) the chat "finished its turn",
  // which paged the user to go and look at a chat that was still working.
  it('does not blink idle between two queued turns — it holds running until the queue empties', async () => {
    const g = gatedBackend();
    const { daemon, events, folder } = setup(g.backend);
    const chatId = await daemon.spawnChat({ folder });

    void daemon.sendInput({ chatId, message: 'one', localId: 'L1' }); // runs, blocks
    await tick();
    void daemon.sendInput({ chatId, message: 'two', localId: 'L2' }); // queued behind it
    await tick();

    const mark = events.length;
    g.releaseNext(); // turn 1 settles — turn 2 is still queued
    await tick();

    const activities = events
      .slice(mark)
      .filter((e) => e.type === 'chat.state')
      .map((e) => (e as { activity: string }).activity);
    expect(activities).not.toContain('idle');
    // ...and the next turn really did start, so this is not "nothing happened".
    expect(g.prompts).toEqual(['one', 'two']);
    expect(daemon.chatState.get(chatId)?.activity).toBe('running');

    g.releaseNext(); // turn 2 settles — queue is empty now
    await tick();
    expect(daemon.chatState.get(chatId)?.activity).toBe('idle');
    expect(
      events
        .slice(mark)
        .some((e) => e.type === 'chat.state' && (e as { activity: string }).activity === 'idle'),
    ).toBe(true);
  });

  // The flip side of holding `running` across the drain: the pump must never
  // leave the chat stuck claiming to be running. `runTurnsFrom`'s finally
  // abandons the queue when a turn throws, and nothing else would settle it.
  it('lands on idle when the pump ends abnormally (a queued turn throws and the queue is abandoned)', async () => {
    const g = gatedBackend();
    let calls = 0;
    const { daemon, folder } = setup(g.backend, {
      resolveOAuth: () => {
        calls += 1;
        // Turn 1 resolves; turn 2's gate blows up before the SDK is reached.
        if (calls >= 2) throw new Error('oauth store unreadable');
        return { ok: true, accessToken: 'fake-token' };
      },
    });
    const chatId = await daemon.spawnChat({ folder });

    const p1 = daemon.sendInput({ chatId, message: 'one', localId: 'L1' });
    await tick();
    const p2 = daemon.sendInput({ chatId, message: 'two', localId: 'L2' }); // queued
    await tick();

    g.releaseNext(); // turn 1 settles holding `running`; the drain then throws
    await expect(p1).rejects.toThrow(/oauth store unreadable/);
    await expect(p2).resolves.toBeUndefined();
    await tick();

    expect(daemon.chatState.get(chatId)?.activity).toBe('idle');
  });

  // "some queued messages just get stuck forever": when the pump dies, turns
  // still waiting behind the one that threw are dropped. Each was announced
  // with chat.queued, so without a matching chat.dequeued the surface shows it
  // as QUEUED permanently.
  it('settles every queued turn the pump abandons when a turn throws (no message stays QUEUED forever)', async () => {
    const g = gatedBackend();
    let calls = 0;
    const { daemon, events, folder } = setup(g.backend, {
      resolveOAuth: () => {
        calls += 1;
        if (calls >= 2) throw new Error('oauth store unreadable');
        return { ok: true, accessToken: 'fake-token' };
      },
    });
    const chatId = await daemon.spawnChat({ folder });

    const p1 = daemon.sendInput({ chatId, message: 'one', localId: 'L1' });
    await tick();
    const p2 = daemon.sendInput({ chatId, message: 'two', localId: 'L2' }); // queued
    const p3 = daemon.sendInput({ chatId, message: 'three', localId: 'L3' }); // queued
    await tick();

    g.releaseNext();
    await expect(p1).rejects.toThrow(/oauth store unreadable/);
    await p2;
    await p3;
    await tick();

    const settled = (id: string) =>
      events.filter((e) => e.type === 'chat.dequeued' && (e as { localId: string }).localId === id);
    // L2 was dequeued as running (its turn is the one that threw); L3 never ran
    // and must be told it is gone.
    expect(settled('L2')).toHaveLength(1);
    expect(settled('L3')).toHaveLength(1);
    expect((settled('L3')[0] as { reason: string }).reason).toBe('cancelled');
  });

  // Tom: "sending a completion notification when a turn is ended via
  // interruption of a new message instead of actually getting to the end".
  // A promote is a stop the queue DOES resolve — `promoteInput` interrupts the
  // in-flight turn precisely BECAUSE there is a queued turn waiting to run, and
  // `drainQueue` starts it on the very next tick. Settling to `idle` in the
  // aborted branch emitted the running -> idle edge the server's
  // chat-completion notifier (spec/09 § Chat completion) reads as "<chat>
  // finished", so typing a second message into a working chat pushed a
  // "finished" notification for a chat that went straight back to `running`.
  it('does not blink idle when a promote interrupts the running turn — the queued turn is what the stop was for', async () => {
    const g = abortableGatedBackend();
    const { daemon, events, folder } = setup(g.backend);
    const chatId = await daemon.spawnChat({ folder });

    void daemon.sendInput({ chatId, message: 'one', localId: 'L1' }); // runs, blocks
    await tick();
    void daemon.sendInput({ chatId, message: 'two', localId: 'L2' }); // queued behind it
    await tick();

    const mark = events.length;
    await daemon.promoteInput(chatId, 'L2'); // interrupt turn 1 so turn 2 runs NOW
    // The promoted turn really did start, so this is not "nothing happened".
    await waitFor(() => g.prompts.length === 2);

    const activities = events
      .slice(mark)
      .filter((e) => e.type === 'chat.state')
      .map((e) => (e as { activity: string }).activity);
    expect(activities).not.toContain('idle');
    // The interrupted turn is still LABELLED as interrupted — holding `running`
    // must not cost the surface its `Cancelled - turn stopped` stamp.
    expect(events.slice(mark).filter((e) => e.type === 'chat.stopped')).toHaveLength(1);
    expect(g.prompts).toEqual(['one', 'two']);
    expect(daemon.chatState.get(chatId)?.activity).toBe('running');

    g.releaseNext(); // the aborted turn's stale gate (abort rejected, never shifted)
    await tick();
    g.releaseNext(); // the promoted turn settles — the queue is empty now
    await waitFor(() => daemon.chatState.get(chatId)?.activity === 'idle');

    // Exactly ONE settling frame for the whole drain, at its true end.
    expect(
      events
        .slice(mark)
        .filter((e) => e.type === 'chat.state' && (e as { activity: string }).activity === 'idle'),
    ).toHaveLength(1);
  });

  // The same rule on the OTHER abort branch. A stop can also land while a turn
  // is still resolving its credential, BEFORE the SDK is reached — a second
  // promote, or the auto-interrupt firing for the queue's new head. That turn
  // aborts pre-SDK, and it must not report `idle` either while the rest of the
  // queue is still waiting to run.
  it('does not blink idle when the stop lands before the SDK, with turns still queued', async () => {
    const g = gatedBackend();
    let d: Daemon | undefined;
    let chatId = '';
    let calls = 0;
    const { daemon, events, folder } = setup(g.backend, {
      resolveOAuth: async () => {
        calls += 1;
        // The FIRST QUEUED turn is interrupted during its OAuth gate: the abort
        // lands after the aborter is registered but before the SDK call.
        if (calls === 2) {
          void d?.stopChat(chatId);
          await tick(0);
        }
        return { ok: true as const, accessToken: 'fake-token' };
      },
    });
    d = daemon;
    chatId = await daemon.spawnChat({ folder });

    void daemon.sendInput({ chatId, message: 'one', localId: 'L1' }); // runs, blocks
    await tick();
    void daemon.sendInput({ chatId, message: 'two', localId: 'L2' }); // queued
    void daemon.sendInput({ chatId, message: 'three', localId: 'L3' }); // queued
    await tick();

    const mark = events.length;
    g.releaseNext(); // turn 1 settles holding `running`; turn 2 is cut off pre-SDK
    // Turn 2 never reached the SDK; turn 3 did, and is what the chat is running.
    await waitFor(() => g.prompts.length === 2);

    const activities = events
      .slice(mark)
      .filter((e) => e.type === 'chat.state')
      .map((e) => (e as { activity: string }).activity);
    expect(activities).not.toContain('idle');
    expect(events.slice(mark).filter((e) => e.type === 'chat.stopped')).toHaveLength(1);
    expect(g.prompts).toEqual(['one', 'three']);
    expect(daemon.chatState.get(chatId)?.activity).toBe('running');

    g.releaseNext(); // turn 3 settles — the queue is empty now
    await waitFor(() => daemon.chatState.get(chatId)?.activity === 'idle');

    expect(
      events
        .slice(mark)
        .filter((e) => e.type === 'chat.state' && (e as { activity: string }).activity === 'idle'),
    ).toHaveLength(1);
  });

  // Preserved behaviour: a BARE stop — the user pressed stop with nothing queued
  // behind it — still settles the chat to idle immediately. Tom's report is
  // specifically about interruption-by-new-message; a stop with an empty queue
  // has no turn to hand `running` on to, and the composer must reopen.
  it('a user stop still settles the chat to idle', async () => {
    const g = abortableGatedBackend();
    const { daemon, events, folder } = setup(g.backend);
    const chatId = await daemon.spawnChat({ folder });

    void daemon.sendInput({ chatId, message: 'one', localId: 'L1' });
    await tick();
    await daemon.stopChat(chatId);
    await tick();

    expect(daemon.chatState.get(chatId)?.activity).toBe('idle');
    expect(
      events.some(
        (e) => e.type === 'chat.state' && (e as { activity: string }).activity === 'idle',
      ),
    ).toBe(true);
  });

  // Preserved behaviour: a turn refused at the OAuth gate is not a turn the
  // queue can fix — the next queued turn will be refused too. It settles idle
  // immediately so the composer reopens and the refusal is visible.
  it('an OAuth-refused turn settles to idle even with turns still queued behind it', async () => {
    const g = gatedBackend();
    let calls = 0;
    const { daemon, folder } = setup(g.backend, {
      resolveOAuth: () => {
        calls += 1;
        if (calls >= 2) return { ok: false as const, reason: 'no credential' };
        return { ok: true as const, accessToken: 'fake-token' };
      },
    });
    const chatId = await daemon.spawnChat({ folder });

    void daemon.sendInput({ chatId, message: 'one', localId: 'L1' });
    await tick();
    void daemon.sendInput({ chatId, message: 'two', localId: 'L2' }); // queued
    void daemon.sendInput({ chatId, message: 'three', localId: 'L3' }); // queued
    await tick();

    g.releaseNext(); // turn 1 settles holding `running`; turn 2 is refused
    await tick();

    expect(daemon.chatState.get(chatId)?.activity).toBe('idle');
    expect(g.prompts).toEqual(['one']); // neither refused turn reached the SDK
  });
});

// ===========================================================================
// Tom, Todoist 6hRRvVhx8v6wVvwc: "stop should stop the ai response. not cancel
// any pending messages. they go through".
//
// The drain has always behaved: `stopChat` aborts only the in-flight turn's
// AbortController and never touches `turnQueues`. Nothing above pins THAT as
// the contract though — the cases above pin idle-blinking and stop ORDERING,
// and every one of them would still pass if a stop quietly emptied the queue
// after the turns they assert on. These are the regression tests for the
// promise itself, so a future "tidy up the queue on stop" cannot land quietly.
//
// NOTE on `abortableGatedBackend`: an aborted turn's gate is REJECTED but never
// shifted off `gates`, so it stays at the head as a dead entry. Every stop
// therefore costs one extra `releaseNext()` before the next live turn's gate is
// reached — `releaseStale()` below names that, rather than leaving a bare
// double-release for the next reader to mis-diagnose as a flake.
// ===========================================================================
describe('a stop keeps the queue (spec/04 ## Message queueing)', () => {
  it('a bare stop interrupts ONLY the running turn — every queued turn still runs, in order', async () => {
    const g = abortableGatedBackend();
    const releaseStale = g.releaseNext;
    const { daemon, events, folder } = setup(g.backend);
    const chatId = await daemon.spawnChat({ folder });

    void daemon.sendInput({ chatId, message: 'one', localId: 'L1' }); // runs, blocks
    await tick();
    void daemon.sendInput({ chatId, message: 'two', localId: 'L2' }); // queued
    void daemon.sendInput({ chatId, message: 'three', localId: 'L3' }); // queued
    await waitFor(() => events.filter((e) => e.type === 'chat.queued').length === 2);
    expect(g.prompts).toEqual(['one']);

    await daemon.stopChat(chatId);

    // The stop did not take the queue with it: 'two' starts on its own.
    await waitFor(() => g.prompts.length === 2);
    releaseStale(); // the aborted 'one' gate
    g.releaseNext(); // 'two' settles
    await waitFor(() => g.prompts.length === 3);
    g.releaseNext(); // 'three' settles
    await waitFor(() => daemon.chatState.get(chatId)?.activity === 'idle');

    expect(g.prompts).toEqual(['one', 'two', 'three']);
    // Nothing was cancelled: chat.unqueue_request is the ONLY cancel path.
    expect(
      events.filter(
        (e) => e.type === 'chat.dequeued' && (e as { reason: string }).reason === 'cancelled',
      ),
    ).toHaveLength(0);
    // Each queued turn was announced as running, not dropped.
    expect(
      events
        .filter((e) => e.type === 'chat.dequeued' && (e as { reason: string }).reason === 'running')
        .map((e) => (e as { localId: string }).localId),
    ).toEqual(['L2', 'L3']);
    // One stop, for the one turn it interrupted.
    expect(events.filter((e) => e.type === 'chat.stopped')).toHaveLength(1);
  });

  it('a stop does not poison the chat against LATER input either — a message sent after it still queues and runs', async () => {
    const g = abortableGatedBackend();
    const releaseStale = g.releaseNext;
    const { daemon, events, folder } = setup(g.backend);
    const chatId = await daemon.spawnChat({ folder });

    void daemon.sendInput({ chatId, message: 'one', localId: 'L1' });
    await tick();
    void daemon.sendInput({ chatId, message: 'two', localId: 'L2' }); // queued
    await waitFor(() => events.some((e) => e.type === 'chat.queued'));

    await daemon.stopChat(chatId);
    // 'two' is now the running turn; queue a third behind it.
    await waitFor(() => g.prompts.length === 2);
    void daemon.sendInput({ chatId, message: 'three', localId: 'L3' });
    await waitFor(() => events.filter((e) => e.type === 'chat.queued').length === 2);

    releaseStale(); // the aborted 'one' gate
    g.releaseNext(); // 'two' settles
    await waitFor(() => g.prompts.length === 3);
    g.releaseNext(); // 'three' settles
    await waitFor(() => daemon.chatState.get(chatId)?.activity === 'idle');
    expect(g.prompts).toEqual(['one', 'two', 'three']);
  });

  it('stopping a turn that is itself draining the queue leaves the REST of the queue intact', async () => {
    // Stop pressed twice over one drain — each stop takes exactly one turn.
    const g = abortableGatedBackend();
    const { daemon, events, folder } = setup(g.backend);
    const chatId = await daemon.spawnChat({ folder });

    void daemon.sendInput({ chatId, message: 'one', localId: 'L1' });
    await tick();
    void daemon.sendInput({ chatId, message: 'two', localId: 'L2' });
    void daemon.sendInput({ chatId, message: 'three', localId: 'L3' });
    await waitFor(() => events.filter((e) => e.type === 'chat.queued').length === 2);

    await daemon.stopChat(chatId); // kills 'one'
    await waitFor(() => g.prompts.length === 2);
    await daemon.stopChat(chatId); // kills 'two' — mid-drain
    await waitFor(() => g.prompts.length === 3); // 'three' still ran

    g.releaseNext(); // aborted 'one' gate
    g.releaseNext(); // aborted 'two' gate
    g.releaseNext(); // 'three' settles
    await waitFor(() => daemon.chatState.get(chatId)?.activity === 'idle');
    expect(g.prompts).toEqual(['one', 'two', 'three']);
    expect(events.filter((e) => e.type === 'chat.stopped')).toHaveLength(2);
    expect(
      events.filter(
        (e) => e.type === 'chat.dequeued' && (e as { reason: string }).reason === 'cancelled',
      ),
    ).toHaveLength(0);
  });

  it('the queued turns survive the stop in meta.json too, so a host killed mid-stop still owes them', async () => {
    const g = abortableGatedBackend();
    const releaseStale = g.releaseNext;
    const home = mkdtempSync(join(tmpdir(), 'patch-queue-'));
    const metaStore = createMetaStore(home);
    const { daemon, events, folder } = setup(g.backend, { metaStore });
    const chatId = await daemon.spawnChat({ folder });

    void daemon.sendInput({ chatId, message: 'one', localId: 'L1' });
    await tick();
    void daemon.sendInput({ chatId, message: 'two', localId: 'L2' });
    void daemon.sendInput({ chatId, message: 'three', localId: 'L3' });
    await waitFor(() => events.filter((e) => e.type === 'chat.queued').length === 2);

    await daemon.stopChat(chatId);
    // 'two' is running, 'three' still owed — `resumeInterruptedTurns` reads
    // exactly this list, so a stop that dropped the queue would show up here.
    await waitFor(() => g.prompts.length === 2);
    await waitFor(
      () => (metaStore.read(chatId)?.pendingTurns ?? []).map((t) => t.message).length === 2,
    );
    expect((metaStore.read(chatId)?.pendingTurns ?? []).map((t) => t.message)).toEqual([
      'two',
      'three',
    ]);

    releaseStale();
    g.releaseNext();
    await waitFor(() => g.prompts.length === 3);
    g.releaseNext();
    await waitFor(() => daemon.chatState.get(chatId)?.activity === 'idle');
  });
});

// ===========================================================================
// The other half of the same promise, and the one that was actually broken: a
// turn parked on a permission request is suspended INSIDE `canUseTool`, on a
// host-side promise the SDK is awaiting. Aborting the query does not reach
// it, so `stopChat` used to hang on its own `await run`, `chat.stopped` was
// never announced, the chat sat in `awaiting-permission`, and every queued turn
// waited out the request's expiry window — a minute for a question, an HOUR for
// a tool approval — before it could run. Stop looked like it did nothing and
// the pending messages did not go through.
//
// Driven against the mock backend, whose `[[ask-user-question]]` and
// `[[bash-permission]]` triggers await `onPermissionRequest` exactly as the real
// SDK's `canUseTool` does, so the turn really is blocked while the test stops.
// ===========================================================================
describe('a stop ends a turn parked on a permission request (spec/04 ## Message queueing)', () => {
  const setupMock = () =>
    setup(createMockSdkBackend(), {
      // The mode the mock blocks an ordinary Bash call under.
      permissionModeDefault: 'default',
    });
  const responses = (events: WireEvent[]) =>
    events.filter((e) => e.type === 'chat.permission_response') as unknown as Array<{
      requestId: string;
      decision?: string;
    }>;
  const assistantText = (events: WireEvent[]) =>
    (
      events.filter(
        (e) => e.type === 'chat.message' && e.role === 'assistant',
      ) as unknown as Array<{
        content: string;
      }>
    ).map((e) => e.content);

  it('stops a turn parked on a QUESTION, and the queued message then goes through', async () => {
    const { daemon, events, folder } = setupMock();
    const chatId = await daemon.spawnChat({ folder, prompt: '[[ask-user-question]]' });
    await waitFor(() => events.some((e) => e.type === 'chat.permission_request'));
    expect(daemon.chatState.get(chatId)?.activity).toBe('awaiting-permission');

    // Queued behind the parked turn, the way type-ahead always is.
    void daemon.sendInput({ chatId, message: 'carry on then', localId: 'L2' });
    await waitFor(() => events.some((e) => e.type === 'chat.queued'));

    // Must RESOLVE — it hung here, which is why Stop read as doing nothing.
    await daemon.stopChat(chatId);

    expect(events.filter((e) => e.type === 'chat.stopped')).toHaveLength(1);
    expect(responses(events).map((r) => r.decision)).toEqual(['deny']);
    await waitFor(() => assistantText(events).includes('[mock] echo: carry on then'));
    await waitFor(() => daemon.chatState.get(chatId)?.activity === 'idle');
    expect(daemon.getPendingPermissionForChat(chatId)).toBeUndefined();
    expect(
      events.filter(
        (e) => e.type === 'chat.dequeued' && (e as { reason: string }).reason === 'cancelled',
      ),
    ).toHaveLength(0);
  });

  it('stops a turn parked on a TOOL APPROVAL too — a stop is not selective', async () => {
    // Unlike a typed message, which decides only a question: a stop ends the
    // whole turn, so whatever it was paused on goes with it. Left pending, this
    // one held the queue for the approval's full hour.
    const { daemon, events, folder } = setupMock();
    const chatId = await daemon.spawnChat({ folder, prompt: '[[bash-permission]]' });
    await waitFor(() => events.some((e) => e.type === 'chat.permission_request'));

    void daemon.sendInput({ chatId, message: 'never mind', localId: 'L2' });
    await waitFor(() => events.some((e) => e.type === 'chat.queued'));

    await daemon.stopChat(chatId);

    expect(responses(events).map((r) => r.decision)).toEqual(['deny']);
    await waitFor(() => assistantText(events).includes('[mock] echo: never mind'));
    await waitFor(() => daemon.chatState.get(chatId)?.activity === 'idle');
    expect(daemon.getPendingPermissionForChat(chatId)).toBeUndefined();
  });

  it('tells the AGENT the turn was stopped, not that the call was refused', async () => {
    const { daemon, events, folder } = setupMock();
    const chatId = await daemon.spawnChat({ folder, prompt: '[[bash-permission]]' });
    await waitFor(() => events.some((e) => e.type === 'chat.permission_request'));

    await daemon.stopChat(chatId);
    await waitFor(() => events.some((e) => e.type === 'chat.tool_result'));

    const result = events.find((e) => e.type === 'chat.tool_result') as { result: unknown };
    expect(String(result.result)).toBe(PERMISSION_STOPPED_MESSAGE);
  });

  it('a BARE stop on a parked turn still settles the chat and clears the card', async () => {
    const { daemon, events, folder } = setupMock();
    const chatId = await daemon.spawnChat({ folder, prompt: '[[ask-user-question]]' });
    await waitFor(() => events.some((e) => e.type === 'chat.permission_request'));

    await daemon.stopChat(chatId);

    expect(events.filter((e) => e.type === 'chat.stopped')).toHaveLength(1);
    await waitFor(() => daemon.chatState.get(chatId)?.activity === 'idle');
    expect(daemon.getPendingPermissionForChat(chatId)).toBeUndefined();
  });

  it('promoting a queued turn past a parked one works too — it is the same stop', async () => {
    // The user-reachable version of the case above: the ↑ on a queued message
    // (spec/04 § Promote) goes through `stopChat`, so a chat parked on a
    // question swallowed the promote exactly as it swallowed a stop, and the
    // queued turn the user was pushing sat there doing nothing.
    const { daemon, events, folder } = setupMock();
    const chatId = await daemon.spawnChat({ folder, prompt: '[[ask-user-question]]' });
    await waitFor(() => events.some((e) => e.type === 'chat.permission_request'));

    void daemon.sendInput({ chatId, message: 'do this instead', localId: 'L2' });
    await waitFor(() => events.some((e) => e.type === 'chat.queued'));

    await daemon.promoteInput(chatId, 'L2');

    await waitFor(() => assistantText(events).includes('[mock] echo: do this instead'));
    await waitFor(() => daemon.chatState.get(chatId)?.activity === 'idle');
    expect(daemon.getPendingPermissionForChat(chatId)).toBeUndefined();
  });

  it('a stop on a chat with nothing pending resolves no permission at all', async () => {
    const { daemon, events, folder } = setupMock();
    const chatId = await daemon.spawnChat({ folder });
    await waitFor(() => daemon.chatState.get(chatId)?.activity === 'idle');

    await daemon.stopChat(chatId); // idle: a complete no-op
    expect(responses(events)).toHaveLength(0);
    expect(events.filter((e) => e.type === 'chat.stopped')).toHaveLength(0);
  });
});

describe('editing a queued message (spec/04 ## Message queueing § Edit)', () => {
  const queuedEvents = (events: WireEvent[]) =>
    events.filter((e) => e.type === 'chat.queued') as Array<
      Extract<WireEvent, { type: 'chat.queued' }>
    >;

  it('replaces the typed text in place — same place in the queue, same localId and queueSeq — and runs the new text', async () => {
    const g = gatedBackend();
    const { daemon, events, folder } = setup(g.backend);
    const chatId = await daemon.spawnChat({ folder });
    void daemon.sendInput({ chatId, message: 'one', localId: 'L1' });
    await tick();
    void daemon.sendInput({ chatId, message: 'two', localId: 'L2' });
    void daemon.sendInput({ chatId, message: 'three', localId: 'L3' });
    await tick();

    daemon.editQueuedInput(chatId, 'L2', 'two, rephrased');

    const q = queuedEvents(events);
    expect(q).toHaveLength(3);
    expect(q[2]).toMatchObject({ localId: 'L2', queueSeq: 1, message: 'two, rephrased' });

    g.releaseNext();
    await waitFor(() => g.prompts.length === 2);
    g.releaseNext();
    await waitFor(() => g.prompts.length === 3);
    g.releaseNext();
    await tick();
    // The edited turn ran in its original place, with the new text.
    expect(g.prompts).toEqual(['one', 'two, rephrased', 'three']);
  });

  it('keeps the attachments folded around the typed text, and announces only the typed text', async () => {
    const g = gatedBackend();
    const { daemon, events, folder } = setup(g.backend);
    const chatId = await daemon.spawnChat({ folder });
    daemon.storeAttachment({
      chatId,
      id: 'att1',
      name: 'photo.jpg',
      mimeType: 'image/jpeg',
      kind: 'image',
      bytes: Buffer.from([1, 2, 3]),
    });
    void daemon.sendInput({ chatId, message: 'one', localId: 'L1' });
    await tick();
    void daemon.sendInput({
      chatId,
      message: 'look at this',
      localId: 'L2',
      attachments: [{ id: 'att1', name: 'photo.jpg', mimeType: 'image/jpeg', kind: 'image' }],
    });
    await tick();
    // The announcement is what the user typed, not the prompt built around it.
    expect(queuedEvents(events)[0]!.message).toBe('look at this');

    daemon.editQueuedInput(chatId, 'L2', 'look at this instead');
    expect(queuedEvents(events)[1]!.message).toBe('look at this instead');

    g.releaseNext();
    await waitFor(() => g.prompts.length === 2);
    const ran = g.prompts[1]!;
    expect(ran.startsWith('look at this instead\n\n[Attachments]\n')).toBe(true);
    expect(ran).toContain('photo.jpg');
    g.releaseNext();
    await tick();
  });

  it('an image-only queued turn can gain text', async () => {
    const g = gatedBackend();
    const { daemon, folder } = setup(g.backend);
    const chatId = await daemon.spawnChat({ folder });
    daemon.storeAttachment({
      chatId,
      id: 'att2',
      name: 'shot.png',
      mimeType: 'image/png',
      kind: 'image',
      bytes: Buffer.from([4, 5]),
    });
    void daemon.sendInput({ chatId, message: 'one', localId: 'L1' });
    await tick();
    void daemon.sendInput({
      chatId,
      message: '',
      localId: 'L2',
      attachments: [{ id: 'att2', name: 'shot.png', mimeType: 'image/png', kind: 'image' }],
    });
    await tick();
    daemon.editQueuedInput(chatId, 'L2', 'what is this?');
    g.releaseNext();
    await waitFor(() => g.prompts.length === 2);
    expect(g.prompts[1]!.startsWith('what is this?\n\n[Attachments]\n')).toBe(true);
    g.releaseNext();
    await tick();
  });

  it('keeps the voice prefix a voice turn was queued with', async () => {
    const g = gatedBackend();
    const { daemon, folder } = setup(g.backend);
    const chatId = await daemon.spawnChat({ folder });
    void daemon.sendInput({ chatId, message: 'one', localId: 'L1' });
    await tick();
    void daemon.sendInput({
      chatId,
      message: 'spoken',
      localId: 'L2',
      voicePrefix: '[voice • web] ',
    });
    await tick();
    daemon.editQueuedInput(chatId, 'L2', 'spoken, corrected');
    g.releaseNext();
    await waitFor(() => g.prompts.length === 2);
    expect(g.prompts[1]).toBe('[voice • web] spoken, corrected');
    g.releaseNext();
    await tick();
  });

  it('is a no-op once the turn has started running — the old text already went in', async () => {
    const g = gatedBackend();
    const { daemon, events, folder } = setup(g.backend);
    const chatId = await daemon.spawnChat({ folder });
    void daemon.sendInput({ chatId, message: 'one', localId: 'L1' });
    await tick();
    void daemon.sendInput({ chatId, message: 'two', localId: 'L2' });
    await tick();
    g.releaseNext();
    await waitFor(() => g.prompts.length === 2);
    const before = events.length;

    daemon.editQueuedInput(chatId, 'L2', 'too late');
    daemon.editQueuedInput(chatId, 'nope', 'unknown');
    daemon.editQueuedInput('no-such-chat', 'L2', 'unknown chat');

    expect(events.length).toBe(before);
    g.releaseNext();
    await tick();
    expect(g.prompts).toEqual(['one', 'two']);
  });

  it('persists the edited text, so a host killed before it runs resumes the edit', async () => {
    const g = gatedBackend();
    const home = mkdtempSync(join(tmpdir(), 'patch-queue-edit-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-qfolder-')));
    const metaStore = createMetaStore(home);
    const daemon = new Daemon({
      daemonId: 'd1',
      metaStore,
      sdkBackend: g.backend,
      oauthAccessToken: 'fake-token',
      emit: () => undefined,
      logger: silent,
      now: () => 1_700_000_000_000,
      generateChatId: () => 'chat-persist',
    });
    const chatId = await daemon.spawnChat({ folder });
    void daemon.sendInput({ chatId, message: 'one', localId: 'L1' });
    await tick();
    void daemon.sendInput({ chatId, message: 'two', localId: 'L2' });
    await tick();
    daemon.editQueuedInput(chatId, 'L2', 'two, edited');
    const pending = metaStore.read(chatId)?.pendingTurns ?? [];
    expect(pending.map((t) => t.message)).toEqual(['one', 'two, edited']);
    g.releaseNext();
    await waitFor(() => g.prompts.length === 2);
    g.releaseNext();
    await tick();
  });
});
