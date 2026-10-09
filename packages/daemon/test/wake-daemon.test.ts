// Integration: a self-wake scheduled on the real Host fires through
// deliverWake → sendInput → the SDK, delivering the [wake]-prefixed message as a
// new turn into the SAME chat (spec/02 § Self-wake).

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import type { SdkBackend } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });

function recordingBackend() {
  const prompts: string[] = [];
  const backend: SdkBackend = {
    async *run(opts): AsyncIterable<{ type: string; [k: string]: unknown }> {
      prompts.push(opts.prompt);
      yield { type: 'result', sessionId: 'sess' };
      yield { type: 'assistant', content: `reply:${opts.prompt}`, sessionId: 'sess' };
    },
  };
  return { backend, prompts };
}

/**
 * A backend whose turns block until released, so a test can hold a chat
 * mid-turn and observe what a wake firing during that turn does.
 */
function gatedBackend() {
  const prompts: string[] = [];
  const gates: Array<() => void> = [];
  let pending: Promise<void> | null = null;
  const backend: SdkBackend = {
    async *run(opts): AsyncIterable<{ type: string; [k: string]: unknown }> {
      prompts.push(opts.prompt);
      // Block this turn until the test releases it.
      pending = new Promise<void>((resolve) => gates.push(resolve));
      await pending;
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

function setup(backend: SdkBackend) {
  const home = mkdtempSync(join(tmpdir(), 'patch-waked-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-wfolder-')));
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
  return { daemon, metaStore, folder, events };
}

const tick = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('self-wake on the host (spec/02 § Self-wake)', () => {
  it('fires the wake into the same chat as a [wake]-prefixed turn', async () => {
    const b = recordingBackend();
    const { daemon, folder } = setup(b.backend);
    const chatId = await daemon.spawnChat({ folder });
    await tick(); // let the (empty) spawn settle

    const { fireAt } = daemon.scheduleWake(chatId, { in: '0', message: 'go to bed' });
    expect(typeof fireAt).toBe('number');
    expect(daemon.peekWake(chatId)).not.toBeNull();

    await tick(60);
    // The wake delivered a turn carrying the prefixed message.
    expect(b.prompts).toContain('[wake] go to bed');
    // One-shot: the pending wake cleared after firing.
    expect(daemon.peekWake(chatId)).toBeNull();
  });

  it('cancelWake stops a pending wake before it fires', async () => {
    const b = recordingBackend();
    const { daemon, folder } = setup(b.backend);
    const chatId = await daemon.spawnChat({ folder });
    await tick();
    daemon.scheduleWake(chatId, { in: '1h', message: 'should not fire' });
    expect(daemon.cancelWake(chatId)).toBe(true);
    expect(daemon.peekWake(chatId)).toBeNull();
    await tick(40);
    expect(b.prompts).not.toContain('[wake] should not fire');
  });

  it('surfaces the pending wake on chat.state as `pendingWake` (patch/todo.md — wake bar)', async () => {
    // patch/todo.md — "cron should be visible in a bar above the chat, showing
    // how long until next wakeup and the prompt". spec/02 § Self-wake
    // ("Visible, never invisible"): the host carries the pending wake on
    // chat.state so every surface can render the bar, and re-emits state the
    // moment a wake is scheduled, cancelled or fires.
    const b = recordingBackend();
    const { daemon, folder, events } = setup(b.backend);
    const chatId = await daemon.spawnChat({ folder });
    await tick();

    const lastState = (): { pendingWake?: unknown } | undefined =>
      [...events].reverse().find((e) => e.type === 'chat.state' && e.chatId === chatId) as
        | { pendingWake?: unknown }
        | undefined;

    // Nothing armed → explicitly null (not merely absent).
    expect(lastState()?.pendingWake).toBeNull();

    const { fireAt } = daemon.scheduleWake(chatId, { in: '1h', message: 'check the bus' });
    expect(lastState()?.pendingWake).toEqual({ message: 'check the bus', fireAt });

    // Replacing the wake re-emits with the NEW message/fireAt.
    const second = daemon.scheduleWake(chatId, { in: '2h', message: 'check it again' });
    expect(lastState()?.pendingWake).toEqual({
      message: 'check it again',
      fireAt: second.fireAt,
    });

    // Cancelling clears it.
    daemon.cancelWake(chatId);
    expect(lastState()?.pendingWake).toBeNull();

    // Firing clears it too — the bar disappears as the woken turn lands.
    daemon.scheduleWake(chatId, { in: '0', message: 'go to bed' });
    await tick(60);
    expect(b.prompts).toContain('[wake] go to bed');
    expect(lastState()?.pendingWake).toBeNull();
  });

  it('rejects a wake for an unknown chat, and a missing in/at', async () => {
    const b = recordingBackend();
    const { daemon, folder } = setup(b.backend);
    const chatId = await daemon.spawnChat({ folder });
    await tick();
    expect(() => daemon.scheduleWake('nope', { in: '10m', message: 'x' })).toThrow();
    expect(() => daemon.scheduleWake(chatId, { message: 'x' })).toThrow(/exactly one/);
    expect(() =>
      daemon.scheduleWake(chatId, { in: '10m', at: '2030-01-01T00:00:00Z', message: 'x' }),
    ).toThrow(/exactly one/);
  });

  it('queues behind a running turn when the wake fires mid-turn (spec/02 § Self-wake)', async () => {
    // spec/02-daemon.md § Self-wake: "If the chat is mid-turn, the wake QUEUES
    // behind it." This is the loop case a user hits in practice — a nag wake
    // fires while the chat is still busy with the previous turn. The wake must
    // not be dropped or rejected; it queues and runs once the turn finishes.
    const b = gatedBackend();
    const { daemon, folder, events } = setup(b.backend);
    const chatId = await daemon.spawnChat({ folder });
    await tick();

    // Start a turn that blocks (do NOT await — it holds the chat mid-turn).
    const turn = daemon.sendInput({ chatId, message: 'busy work', localId: 'u1' });
    await tick(); // let the turn enter the backend and block
    expect(b.prompts).toContain('busy work');

    // Fire a wake NOW, while the first turn is still running.
    daemon.scheduleWake(chatId, { in: '0', message: 'nag: go to bed' });
    await tick(60);

    // The wake must have QUEUED behind the running turn, not been dropped.
    const queued = events.find(
      (e) =>
        e.type === 'chat.queued' && (e as { message?: string }).message === '[wake] nag: go to bed',
    );
    expect(queued, 'wake should queue behind the running turn').toBeDefined();
    // It has not run yet — the first turn is still blocking the pump.
    expect(b.prompts).not.toContain('[wake] nag: go to bed');
    // The one-shot wake file cleared on fire (it's now in the turn queue).
    expect(daemon.peekWake(chatId)).toBeNull();

    // Release the first turn; the queued wake then drains and runs.
    b.releaseNext(); // release 'busy work'
    await tick();
    b.releaseNext(); // release the dequeued wake turn
    await turn;
    await tick(40);
    expect(b.prompts).toContain('[wake] nag: go to bed');
  });

  it('loops: a delivered wake turn re-arms the next wake, which also fires (spec/02 § Self-wake)', async () => {
    // spec/02-daemon.md § Self-wake "One-shot + loop": the agent re-arms a fresh
    // wake on each fire to build a nag loop. Simulate the agent by re-scheduling
    // from inside the delivered [wake] turn; the second wake must also fire.
    const prompts: string[] = [];
    let daemonRef: Daemon | null = null;
    let chatIdRef = '';
    let rearmed = false;
    const backend: SdkBackend = {
      async *run(opts): AsyncIterable<{ type: string; [k: string]: unknown }> {
        prompts.push(opts.prompt);
        // On the FIRST wake delivery, the "agent" re-arms the next wake once.
        if (opts.prompt.startsWith('[wake]') && !rearmed) {
          rearmed = true;
          daemonRef!.scheduleWake(chatIdRef, { in: '0', message: 'nag again' });
        }
        yield { type: 'result', sessionId: 'sess' };
        yield { type: 'assistant', content: `reply:${opts.prompt}`, sessionId: 'sess' };
      },
    };
    const { daemon, folder } = setup(backend);
    daemonRef = daemon;
    const chatId = await daemon.spawnChat({ folder });
    chatIdRef = chatId;
    await tick();

    daemon.scheduleWake(chatId, { in: '0', message: 'nag once' });
    await tick(80);

    // Both the initial wake and the re-armed one were delivered — the loop cycled.
    expect(prompts).toContain('[wake] nag once');
    expect(prompts).toContain('[wake] nag again');
    // Loop terminated (the agent stopped re-arming) — no pending wake left.
    expect(daemon.peekWake(chatId)).toBeNull();
  });

  it('persists across a restart: a fresh host re-arms then fires the wake', async () => {
    const b = recordingBackend();
    const home = mkdtempSync(join(tmpdir(), 'patch-waked2-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-wfolder2-')));
    mkdirSync(folder, { recursive: true });
    const metaStore = createMetaStore(home);
    let id = 0;
    const mk = (): Daemon =>
      new Daemon({
        daemonId: 'd1',
        metaStore,
        sdkBackend: b.backend,
        oauthAccessToken: 'fake-token',
        emit: () => {},
        logger: silent,
        now: () => Date.now(),
        generateChatId: () => `chat-${++id}`,
      });
    const d1 = mk();
    const chatId = await d1.spawnChat({ folder });
    await tick();
    // Schedule slightly in the future, then "crash" before it fires.
    d1.scheduleWake(chatId, { in: '0.05', message: 'survives restart' }); // 50ms
    d1.shutdown(); // disarms in-memory timer; wake.json remains on disk
    expect(existsSync(join(home, 'chats', chatId, 'wake.json'))).toBe(true);

    // Fresh host hydrates + re-arms the persisted wake.
    const d2 = mk();
    d2.hydrate();
    await tick(120);
    expect(b.prompts).toContain('[wake] survives restart');
    d2.shutdown();
  });

  it('scheduleWake with `every` arms a loop that keeps re-firing without being re-armed (patch_loop)', async () => {
    // spec/02 § Self-wake — the whole point of `every`: mechanically
    // guaranteed re-firing, not dependent on the agent (or anything else)
    // calling scheduleWake again on each tick.
    const b = recordingBackend();
    const { daemon, folder } = setup(b.backend);
    const chatId = await daemon.spawnChat({ folder });
    await tick();

    daemon.scheduleWake(chatId, { every: '0.03', message: 'check on the build' }); // 30ms
    await tick(60);
    const firstCount = b.prompts.filter((p) => p === '[wake] check on the build').length;
    expect(firstCount).toBeGreaterThanOrEqual(1);
    // Still pending (recurring — not cleared like a one-shot).
    expect(daemon.peekWake(chatId)).not.toBeNull();
    expect(daemon.peekWake(chatId)?.every).toBe(30);

    await tick(90);
    const secondCount = b.prompts.filter((p) => p === '[wake] check on the build').length;
    // No one re-armed it — the host did. Real-timer based (not a virtual
    // clock), so assert monotonic growth rather than an exact count, which
    // would be flaky under system load — the mechanical property under test
    // is that MORE fires land with nothing external re-arming it, not a
    // precise tick count.
    expect(secondCount).toBeGreaterThan(firstCount);
    expect(daemon.peekWake(chatId)).not.toBeNull();
  });

  it('chat.state.pendingWake carries `every` for a loop, absent for a plain one-shot', async () => {
    const b = recordingBackend();
    const { daemon, folder, events } = setup(b.backend);
    const chatId = await daemon.spawnChat({ folder });
    await tick();

    const lastState = (): { pendingWake?: unknown } | undefined =>
      [...events].reverse().find((e) => e.type === 'chat.state' && e.chatId === chatId) as
        | { pendingWake?: unknown }
        | undefined;

    daemon.scheduleWake(chatId, { every: '1h', message: 'loop me' });
    expect(lastState()?.pendingWake).toMatchObject({ message: 'loop me', every: 3_600_000 });

    daemon.scheduleWake(chatId, { in: '1h', message: 'one-shot' });
    const oneShot = lastState()?.pendingWake as { every?: number } | undefined;
    expect(oneShot?.every).toBeUndefined();
  });

  it('a loop tick due mid-turn is absorbed (not queued) and re-arms from the END of the turn, with no stacking (spec/02 § Self-wake)', async () => {
    // Distinct from "queues behind a running turn when the wake fires
    // mid-turn" above, which is a ONE-SHOT wake — one-shots still queue.
    // A `patch_loop` (`every` set) is the bug this test locks the fix for:
    // it must NOT queue a `[wake]` turn behind the running one, and its next
    // fire must be measured from when the running turn actually ends, not
    // from whenever the colliding tick happened to land — otherwise a turn
    // longer than `every` stacks one queued wake per missed tick.
    const b = gatedBackend();
    const { daemon, folder, events } = setup(b.backend);
    const chatId = await daemon.spawnChat({ folder });
    await tick();

    // Start a turn that blocks (holds the chat mid-turn).
    const turn = daemon.sendInput({ chatId, message: 'busy work', localId: 'u1' });
    await tick();
    expect(b.prompts).toContain('busy work');

    // Arm a loop while already busy — its first tick (`every` out) lands
    // squarely inside the still-running turn.
    daemon.scheduleWake(chatId, { every: '0.03', message: 'check it' }); // 30ms
    await tick(100); // several would-be intervals' worth, turn still blocked

    // Never queued, never delivered, however many intervals elapsed.
    const queued = events.find(
      (e) => e.type === 'chat.queued' && (e as { message?: string }).message?.includes('check it'),
    );
    expect(queued, 'a loop tick must not queue behind the running turn').toBeUndefined();
    expect(b.prompts).not.toContain('[wake] check it');
    // Absorbed into a single `waiting` loop, not several stacked attempts.
    expect(daemon.peekWake(chatId)).toMatchObject({ waiting: true, every: 30 });

    // End the running turn.
    b.releaseNext();
    await turn;
    await tick(20);

    // Not delivered the instant the turn ends either — the fresh interval
    // starts counting from now, it isn't already due.
    expect(b.prompts).not.toContain('[wake] check it');
    expect(daemon.peekWake(chatId)?.waiting).toBeFalsy();

    // Once the fresh (post-turn) interval elapses, exactly one delivery
    // lands — no catch-up stacking for the tick absorbed while busy.
    await tick(60);
    expect(b.prompts.filter((p) => p === '[wake] check it').length).toBe(1);
  });

  it('a loop survives a simulated host restart MID-LOOP: it keeps firing after rehydration, not just once', async () => {
    // Distinct from the plain-wake restart test above: proves the RECURRING
    // record (not just the one pending fire) survives — a second tick after
    // rehydration must also land, with nothing re-arming it but the host.
    const b = recordingBackend();
    const home = mkdtempSync(join(tmpdir(), 'patch-loop-restart-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-loop-restart-folder-')));
    mkdirSync(folder, { recursive: true });
    const metaStore = createMetaStore(home);
    let id = 0;
    const mk = (): Daemon =>
      new Daemon({
        daemonId: 'd1',
        metaStore,
        sdkBackend: b.backend,
        oauthAccessToken: 'fake-token',
        emit: () => {},
        logger: silent,
        now: () => Date.now(),
        generateChatId: () => `chat-${++id}`,
      });
    const d1 = mk();
    const chatId = await d1.spawnChat({ folder });
    await tick();
    // Arm a loop, then "crash" the host BEFORE the first fire lands — the
    // in-flight loop itself, not just a single pending wake, must survive.
    d1.scheduleWake(chatId, { every: '0.05', message: 'mid-loop restart' }); // 50ms
    d1.shutdown();
    expect(existsSync(join(home, 'chats', chatId, 'wake.json'))).toBe(true);
    const onDisk = JSON.parse(readFileSync(join(home, 'chats', chatId, 'wake.json'), 'utf8'));
    expect(onDisk.every).toBe(50);

    const d2 = mk();
    d2.hydrate();
    await tick(120);
    expect(b.prompts).toContain('[wake] mid-loop restart');
    // The loop continues after rehydration — a pending wake is still armed,
    // and a SECOND fire lands without anything re-arming it externally.
    expect(d2.peekWake(chatId)).not.toBeNull();
    await tick(120);
    expect(b.prompts.filter((p) => p === '[wake] mid-loop restart').length).toBeGreaterThanOrEqual(
      2,
    );
    d2.shutdown();
  });
});
