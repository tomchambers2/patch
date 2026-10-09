// Per-job concurrency gate — spec/08 ## Concurrency.
//
// The gate exists so one high-volume subscription can't start everything at
// once: thirty Todoist tasks landing together must become thirty builds run
// `concurrency` at a time, not thirty chats on one box in one working tree.
//
// The cases that actually prove it works:
//   - a job with NO concurrency behaves exactly as before (the promise that
//     existing jobs don't change),
//   - a slot is NOT released by the idle a chat reports before it has done
//     anything (the mirror seeds a fresh chat as idle — releasing on that
//     would make the whole limit a no-op),
//   - the queue is FIFO, unbounded — a fire waits, it is never refused — and
//     survives a restart.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { ChatActivity, WireEvent } from '@patch/wire';
import { InProcessDaemonLink } from '../src/daemon-link.js';
import { JobLogs, type RunLogEntry } from '../src/jobs/logs.js';
import { JobDispatcher } from '../src/jobs/dispatcher.js';
import type { Job } from '../src/jobs/types.js';

const silentLogger = pino({ level: 'silent' });

const JOB_ID = 'j_00000000000000000000000012';

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: JOB_ID,
    name: 'test',
    enabled: true,
    trigger: { type: 'todoist' },
    filter: null,
    action: { type: 'spawn', daemonId: 'd1', folder: '/work', prompt: 'go' },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

/** A sequential id generator so each fire's chatId is predictable. */
function seqIds(): () => string {
  let n = 0;
  return () => `id${++n}`;
}

function stateEvent(chatId: string, activity: ChatActivity): WireEvent {
  return {
    type: 'chat.state',
    chatId,
    activity,
    lastUpdated: 1,
    permissionMode: 'bypassPermissions',
  };
}

function spawnedEvent(chatId: string): WireEvent {
  return { type: 'chat.spawned', chatId, daemonId: 'd1', folder: '/work' };
}

/** chatIds of every spawn request the link was asked to send, in order. */
function spawnedChatIds(link: InProcessDaemonLink): string[] {
  return link.sent
    .filter((s) => s.event.type === 'chat.spawn_request')
    .map((s) => (s.event.type === 'chat.spawn_request' ? s.event.chatId : ''));
}

function readRuns(dir: string): RunLogEntry[] {
  const path = join(dir, 'runs', `${JOB_ID}.jsonl`);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as RunLogEntry);
}

describe('job concurrency gate', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-conc-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a job with no concurrency dispatches every fire, exactly as before', () => {
    const link = new InProcessDaemonLink();
    const disp = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger: silentLogger,
      idGenerator: seqIds(),
    });
    const job = makeJob();
    for (let i = 0; i < 5; i++) {
      expect(disp.dispatch(job, { n: i }, 'todoist').status).toBe('sent');
    }
    expect(spawnedChatIds(link)).toHaveLength(5);
    // No gate in play → no queue files, no slot files, nothing new on disk.
    expect(existsSync(join(dir, 'queued'))).toBe(false);
    expect(disp.counts(JOB_ID)).toEqual({ inFlight: 0, queued: 0 });
    disp.close();
  });

  it('concurrency 1 → the second fire queues instead of sending', () => {
    const link = new InProcessDaemonLink();
    const disp = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger: silentLogger,
      idGenerator: seqIds(),
    });
    const job = makeJob({ concurrency: 1 });
    expect(disp.dispatch(job, { n: 1 }, 'todoist').status).toBe('sent');
    expect(disp.dispatch(job, { n: 2 }, 'todoist').status).toBe('queued');
    expect(spawnedChatIds(link)).toHaveLength(1);
    expect(disp.counts(JOB_ID)).toEqual({ inFlight: 1, queued: 1 });
    // The wait is visible in the job's own history.
    expect(readRuns(dir).filter((r) => r.status === 'queued')).toHaveLength(1);
    disp.close();
  });

  // `counts` says how many; the job page has to say WHICH — spec/08 §
  // Concurrency.
  it('queue() lists the in-flight fires oldest-first and the waiting fires in release order', () => {
    const link = new InProcessDaemonLink();
    const disp = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger: silentLogger,
      idGenerator: seqIds(),
    });
    const job = makeJob({ concurrency: 2 });
    // An unfired job has no queue at all, and the gate has not yet been told
    // its limit.
    expect(disp.queue(JOB_ID)).toEqual({ concurrency: null, inFlight: [], queued: [] });

    for (let n = 0; n < 4; n++) disp.dispatch(job, { n }, 'todoist');

    const view = disp.queue(JOB_ID);
    expect(view.concurrency).toBe(2);
    // Two slots held, two fires parked — the same numbers `counts` reports.
    expect({ inFlight: view.inFlight.length, queued: view.queued.length }).toEqual(
      disp.counts(JOB_ID),
    );
    // The two in flight are exactly the two chats that were actually opened,
    // in the order they were opened.
    expect(view.inFlight.map((e) => e.chatId)).toEqual(spawnedChatIds(link));
    // The two waiting are different fires again — a queue echoing the running
    // chats back would look right and mean nothing — and they are in the order
    // they arrived.
    expect(view.queued.map((e) => e.chatId)).toHaveLength(2);
    expect(view.queued.some((q) => spawnedChatIds(link).includes(q.chatId))).toBe(false);
    expect(view.queued[0]!.queuedAt).toBeLessThanOrEqual(view.queued[1]!.queuedAt);
    expect(view.inFlight[0]).toMatchObject({
      trigger: 'todoist',
      actionType: 'spawn',
      daemonId: 'd1',
      folder: '/work',
    });
    expect(view.queued[0]).toMatchObject({
      trigger: 'todoist',
      actionType: 'spawn',
      daemonId: 'd1',
      folder: '/work',
    });
    expect(typeof view.queued[0]?.fireId).toBe('string');
    expect(typeof view.queued[0]?.queuedAt).toBe('number');
    expect(typeof view.inFlight[0]?.startedAt).toBe('number');

    // Another job's fires never appear in this one's queue.
    const other = makeJob({ id: 'j_00000000000000000000000099', concurrency: 1 });
    disp.dispatch(other, { n: 0 }, 'todoist');
    disp.dispatch(other, { n: 1 }, 'todoist');
    const after = disp.queue(JOB_ID);
    expect(after.inFlight.map((e) => e.chatId)).toEqual(view.inFlight.map((e) => e.chatId));
    expect(after.queued.map((e) => e.fireId)).toEqual(view.queued.map((e) => e.fireId));
    disp.close();
  });

  it('queue() follows the drain: a released fire moves from waiting to in flight', () => {
    const link = new InProcessDaemonLink();
    const disp = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger: silentLogger,
      idGenerator: seqIds(),
    });
    const job = makeJob({ concurrency: 1 });
    disp.dispatch(job, { n: 1 }, 'todoist');
    disp.dispatch(job, { n: 2 }, 'todoist');
    const before = disp.queue(JOB_ID);
    const first = before.inFlight[0]!.chatId;
    expect(before.queued).toHaveLength(1);
    const waiting = before.queued[0]!.chatId;

    // The first works and then stops, which frees its slot and drains the
    // second into it.
    link.emit(spawnedEvent(first));
    link.emit(stateEvent(first, 'running'));
    link.emit(stateEvent(first, 'idle'));

    const view = disp.queue(JOB_ID);
    expect(view.queued).toEqual([]);
    expect(view.inFlight.map((e) => e.chatId)).toEqual([waiting]);
    disp.close();
  });

  it('a keyed ensure update reaches the chat already working that subject, instead of queueing behind it', () => {
    const link = new InProcessDaemonLink();
    const disp = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger: silentLogger,
      idGenerator: seqIds(),
    });
    const job = makeJob({
      concurrency: 1,
      action: {
        type: 'continue',
        daemonId: 'd1',
        folder: '/work',
        prompt: 'go',
        key: '{{id}}',
      },
    });

    // Task A arrives and takes the job's only slot.
    expect(disp.dispatch(job, { id: 'taskA' }, 'todoist').status).toBe('sent');
    expect(disp.counts(JOB_ID)).toEqual({ inFlight: 1, queued: 0 });

    // An EDIT to task A must land NOW. Queueing it would make the correction
    // wait for the very run it is correcting — the case this keying exists for.
    expect(disp.dispatch(job, { id: 'taskA' }, 'todoist').status).toBe('sent');
    const inputs = link.sent.filter((s) => s.event.type === 'chat.input');
    expect(inputs).toHaveLength(1);
    if (inputs[0]?.event.type === 'chat.input') {
      expect(inputs[0].event.chatId).toBe(`jobchat-${JOB_ID}-taskA`);
    }
    // It opened no new chat, so it took no second slot.
    expect(disp.counts(JOB_ID)).toEqual({ inFlight: 1, queued: 0 });

    // A DIFFERENT task is genuinely new work and still respects the limit.
    expect(disp.dispatch(job, { id: 'taskB' }, 'todoist').status).toBe('queued');
    expect(disp.counts(JOB_ID)).toEqual({ inFlight: 1, queued: 1 });
    disp.close();
  });

  it('releases the slot when the chat goes idle after working, and drains the queue', () => {
    const link = new InProcessDaemonLink();
    const disp = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger: silentLogger,
      idGenerator: seqIds(),
    });
    const job = makeJob({ concurrency: 1 });
    disp.dispatch(job, { n: 1 }, 'todoist');
    disp.dispatch(job, { n: 2 }, 'todoist');
    const first = spawnedChatIds(link)[0] as string;

    link.emit(spawnedEvent(first));
    link.emit(stateEvent(first, 'running'));
    expect(spawnedChatIds(link)).toHaveLength(1); // still held

    link.emit(stateEvent(first, 'idle'));
    expect(spawnedChatIds(link)).toHaveLength(2); // drained
    expect(disp.counts(JOB_ID)).toEqual({ inFlight: 1, queued: 0 });
    disp.close();
  });

  it('does NOT release the slot on the idle a chat reports before it has run', () => {
    const link = new InProcessDaemonLink();
    const disp = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger: silentLogger,
      idGenerator: seqIds(),
    });
    const job = makeJob({ concurrency: 1 });
    disp.dispatch(job, { n: 1 }, 'todoist');
    disp.dispatch(job, { n: 2 }, 'todoist');
    const first = spawnedChatIds(link)[0] as string;

    // The mirror seeds a freshly-spawned chat as idle. If that released the
    // slot, the limit would never hold anything back.
    link.emit(spawnedEvent(first));
    link.emit(stateEvent(first, 'idle'));
    link.emit(stateEvent(first, 'idle'));

    expect(spawnedChatIds(link)).toHaveLength(1);
    expect(disp.counts(JOB_ID)).toEqual({ inFlight: 1, queued: 1 });
    disp.close();
  });

  it('drains in FIFO order', () => {
    const link = new InProcessDaemonLink();
    const disp = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger: silentLogger,
      idGenerator: seqIds(),
      nowMs: (() => {
        let t = 1000;
        return () => (t += 1000);
      })(),
    });
    const job = makeJob({ concurrency: 1 });
    for (let i = 1; i <= 4; i++) disp.dispatch(job, { n: i }, 'todoist');
    expect(disp.counts(JOB_ID)).toEqual({ inFlight: 1, queued: 3 });

    // Each completed chat releases exactly one queued fire, oldest first.
    const order: string[] = [];
    for (let i = 0; i < 4; i++) {
      const current = spawnedChatIds(link)[i] as string;
      order.push(current);
      link.emit(spawnedEvent(current));
      link.emit(stateEvent(current, 'running'));
      link.emit(stateEvent(current, 'idle'));
    }
    // Ids are allocated in fire order, so a FIFO drain sends them in that order.
    expect(order).toEqual([...order].sort());
    expect(spawnedChatIds(link)).toHaveLength(4);
    expect(disp.counts(JOB_ID)).toEqual({ inFlight: 0, queued: 0 });
    disp.close();
  });

  it('releases a wedged slot after the bounded wait and records it loudly', () => {
    vi.useFakeTimers();
    const errors: string[] = [];
    const logger = {
      ...silentLogger,
      error: (_o: unknown, msg?: string) => {
        errors.push(String(msg));
      },
    } as unknown as typeof silentLogger;
    const link = new InProcessDaemonLink();
    const disp = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger,
      idGenerator: seqIds(),
      slotTimeoutMs: 60_000,
    });
    const job = makeJob({ concurrency: 1 });
    disp.dispatch(job, { n: 1 }, 'todoist');
    disp.dispatch(job, { n: 2 }, 'todoist');
    // The chat starts working and then dies without ever reporting idle.
    const first = spawnedChatIds(link)[0] as string;
    link.emit(spawnedEvent(first));
    link.emit(stateEvent(first, 'running'));

    vi.advanceTimersByTime(60_001);

    expect(spawnedChatIds(link)).toHaveLength(2); // queue moved on
    expect(readRuns(dir).some((r) => r.status === 'slot-timeout')).toBe(true);
    expect(errors.some((m) => m.includes('slot'))).toBe(true);
    disp.close();
    vi.useRealTimers();
  });

  it('never refuses a fire, even well past the old cap — a fire waits, it is never refused', () => {
    const link = new InProcessDaemonLink();
    const disp = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger: silentLogger,
      idGenerator: seqIds(),
    });
    const job = makeJob({ concurrency: 1 });
    // 1 sent + 101 queuing attempts — one past the old
    // DEFAULT_QUEUE_CAP_PER_JOB of 100, which used to refuse the 101st.
    const statuses: string[] = [];
    for (let n = 1; n <= 102; n++) {
      statuses.push(disp.dispatch(job, { n }, 'todoist').status);
    }

    expect(statuses[0]).toBe('sent');
    expect(statuses.slice(1)).toEqual(Array(101).fill('queued'));
    expect(statuses).not.toContain('refused');

    // Every waiting fire keeps its place — nothing dropped, nothing refused.
    expect(disp.counts(JOB_ID)).toEqual({ inFlight: 1, queued: 101 });
    const runs = readRuns(dir);
    expect(runs.filter((r) => r.status === 'queued')).toHaveLength(101);
    expect(runs.some((r) => (r.status as string) === 'queue-refused')).toBe(false);
    disp.close();
  });

  it('a queued fire survives a restart and still runs', () => {
    const link = new InProcessDaemonLink();
    const first = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger: silentLogger,
      idGenerator: seqIds(),
    });
    const job = makeJob({ concurrency: 1 });
    first.dispatch(job, { n: 1 }, 'todoist');
    first.dispatch(job, { n: 2 }, 'todoist');
    const heldChat = spawnedChatIds(link)[0] as string;
    first.close();

    // New process, same data dir. The queued fire is still on disk, and the
    // slot held by the chat that is still working is still held — otherwise
    // the restart would start a second build on top of a running one.
    const link2 = new InProcessDaemonLink();
    const second = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link2,
      logger: silentLogger,
      idGenerator: seqIds(),
      chatActivity: (id) => (id === heldChat ? 'running' : null),
    });
    expect(second.counts(JOB_ID)).toEqual({ inFlight: 1, queued: 1 });
    // Reconciliation runs when the link comes up; a still-running chat keeps
    // its slot, so nothing is dispatched on top of it.
    link2.setStatus('offline');
    link2.setStatus('online');
    expect(spawnedChatIds(link2)).toHaveLength(0);

    // When that chat finally finishes, the queued fire runs.
    link2.emit(stateEvent(heldChat, 'running'));
    link2.emit(stateEvent(heldChat, 'idle'));
    expect(spawnedChatIds(link2)).toHaveLength(1);
    second.close();
  });

  // The restart repro. On a real restart the chat mirror is EMPTY — it fills
  // only as hosts report in — so a chat that is still mid-run looks exactly
  // like a chat that is gone. Freeing the slot on that read is what drained
  // the queue on prod and put two builds in one working tree.
  it('a restart with an empty chat mirror does not dispatch on top of a running chat', () => {
    const link = new InProcessDaemonLink();
    const first = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger: silentLogger,
      idGenerator: seqIds(),
    });
    const job = makeJob({ concurrency: 1 });
    expect(first.dispatch(job, { n: 1 }, 'todoist').status).toBe('sent');
    expect(first.dispatch(job, { n: 2 }, 'todoist').status).toBe('queued');
    const heldChat = spawnedChatIds(link)[0] as string;
    expect(first.counts(JOB_ID)).toEqual({ inFlight: 1, queued: 1 });
    first.close();

    // Restart against the same data dir. The mirror knows nothing yet.
    const link2 = new InProcessDaemonLink();
    const second = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link2,
      logger: silentLogger,
      idGenerator: seqIds(),
      chatActivity: () => null,
    });
    expect(second.counts(JOB_ID)).toEqual({ inFlight: 1, queued: 1 });
    link2.setStatus('offline');
    link2.setStatus('online');

    // The queued fire must still be waiting: the first chat is really running.
    expect(spawnedChatIds(link2)).toHaveLength(0);
    expect(second.counts(JOB_ID)).toEqual({ inFlight: 1, queued: 1 });

    // Once that chat reports in and finishes, the queue moves — exactly once.
    link2.emit(stateEvent(heldChat, 'running'));
    link2.emit(stateEvent(heldChat, 'idle'));
    expect(spawnedChatIds(link2)).toHaveLength(1);
    expect(second.counts(JOB_ID)).toEqual({ inFlight: 1, queued: 0 });
    second.close();
  });

  it('reconciliation frees a slot whose chat the mirror says has finished', () => {
    const link = new InProcessDaemonLink();
    const first = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger: silentLogger,
      idGenerator: seqIds(),
    });
    const job = makeJob({ concurrency: 1 });
    first.dispatch(job, { n: 1 }, 'todoist');
    first.dispatch(job, { n: 2 }, 'todoist');
    first.close();

    const link2 = new InProcessDaemonLink();
    const second = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link2,
      logger: silentLogger,
      idGenerator: seqIds(),
      // A positive answer: the host is back and that chat is done.
      chatActivity: () => 'idle',
    });
    link2.setStatus('offline');
    link2.setStatus('online');
    expect(spawnedChatIds(link2)).toHaveLength(1);
    expect(second.counts(JOB_ID)).toEqual({ inFlight: 1, queued: 0 });
    second.close();
  });

  it('an unresolvable chat gives its slot back through the bounded wait, loudly', () => {
    vi.useFakeTimers();
    const errors: string[] = [];
    const logger = {
      ...silentLogger,
      warn: () => {},
      error: (_o: unknown, msg?: string) => {
        errors.push(String(msg));
      },
    } as unknown as typeof silentLogger;
    const link = new InProcessDaemonLink();
    const first = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger,
      idGenerator: seqIds(),
      slotTimeoutMs: 60_000,
    });
    const job = makeJob({ concurrency: 1 });
    first.dispatch(job, { n: 1 }, 'todoist');
    first.dispatch(job, { n: 2 }, 'todoist');
    first.close();

    const link2 = new InProcessDaemonLink();
    const second = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link2,
      logger,
      idGenerator: seqIds(),
      slotTimeoutMs: 60_000,
      // Nothing ever resolves this chat — it really is gone.
      chatActivity: () => null,
    });
    link2.setStatus('offline');
    link2.setStatus('online');
    expect(spawnedChatIds(link2)).toHaveLength(0); // held, not forgotten

    vi.advanceTimersByTime(60_001);

    // The queue moves, and the wedge is visible where the user looks.
    expect(spawnedChatIds(link2)).toHaveLength(1);
    expect(readRuns(dir).some((r) => r.status === 'slot-timeout')).toBe(true);
    expect(errors.some((m) => m.includes('slot'))).toBe(true);
    second.close();
    vi.useRealTimers();
  });

  it('the bounded wait counts from when the slot was taken, not from boot', () => {
    vi.useFakeTimers();
    // An explicit wall clock: the point of the test is elapsed time ACROSS a
    // restart, which the timer clock alone can't express.
    let clock = 1_000_000;
    const link = new InProcessDaemonLink();
    const first = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger: silentLogger,
      idGenerator: seqIds(),
      slotTimeoutMs: 60_000,
      nowMs: () => clock,
    });
    const job = makeJob({ concurrency: 1 });
    first.dispatch(job, { n: 1 }, 'todoist');
    first.dispatch(job, { n: 2 }, 'todoist');
    // Most of the bound is spent before the restart.
    clock += 50_000;
    first.close();

    const link2 = new InProcessDaemonLink();
    const second = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link2,
      logger: silentLogger,
      idGenerator: seqIds(),
      slotTimeoutMs: 60_000,
      chatActivity: () => null,
      nowMs: () => clock,
    });
    link2.setStatus('offline');
    link2.setStatus('online');

    // Restarting must not hand the slot another full bound.
    vi.advanceTimersByTime(10_001);
    expect(spawnedChatIds(link2)).toHaveLength(1);
    second.close();
    vi.useRealTimers();
  });

  it('a reconnect flush respects the limit instead of dumping the backlog', () => {
    const link = new InProcessDaemonLink();
    link.setStatus('offline');
    const disp = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger: silentLogger,
      idGenerator: seqIds(),
      nowMs: (() => {
        let t = 1000;
        return () => (t += 1000);
      })(),
    });
    const job = makeJob({ concurrency: 1 });
    // Host down: three fires buffer against it (no slot is held by a fire
    // that never reached a chat).
    for (let i = 1; i <= 3; i++) {
      expect(disp.dispatch(job, { n: i }, 'todoist').status).toBe('buffered');
    }
    expect(disp.counts(JOB_ID)).toEqual({ inFlight: 0, queued: 0 });

    link.setStatus('online');
    // One goes out; the rest wait behind the limit rather than all landing.
    expect(spawnedChatIds(link)).toHaveLength(1);
    expect(disp.counts(JOB_ID)).toEqual({ inFlight: 1, queued: 2 });
    expect(readdirSync(join(dir, 'pending'))).toHaveLength(0);
    disp.close();
  });

  it('an errored chat releases its slot', () => {
    const link = new InProcessDaemonLink();
    const disp = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger: silentLogger,
      idGenerator: seqIds(),
    });
    const job = makeJob({ concurrency: 1 });
    disp.dispatch(job, { n: 1 }, 'todoist');
    disp.dispatch(job, { n: 2 }, 'todoist');
    const first = spawnedChatIds(link)[0] as string;
    link.emit(spawnedEvent(first));
    link.emit(stateEvent(first, 'errored'));
    expect(spawnedChatIds(link)).toHaveLength(2);
    disp.close();
  });

  it('a host refusing the fire releases its slot', () => {
    const link = new InProcessDaemonLink();
    const disp = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger: silentLogger,
      idGenerator: seqIds(),
    });
    const job = makeJob({ concurrency: 1 });
    disp.dispatch(job, { n: 1 }, 'todoist');
    disp.dispatch(job, { n: 2 }, 'todoist');
    const first = spawnedChatIds(link)[0] as string;
    link.emit({
      type: 'chat.error',
      chatId: first,
      error: { code: 'folder_not_found', message: 'nope' },
    });
    expect(spawnedChatIds(link)).toHaveLength(2);
    disp.close();
  });
});
