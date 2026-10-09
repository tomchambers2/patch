// Queueing modes — spec/08 § Queueing: parallel, queue (concurrency + key),
// append (idle timeout / reset time / reset length).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { ChatActivity, WireEvent } from '@patch/wire';
import { InProcessDaemonLink } from '../src/daemon-link.js';
import { JobLogs } from '../src/jobs/logs.js';
import { JobDispatcher } from '../src/jobs/dispatcher.js';
import { JobStore } from '../src/jobs/store.js';
import type { Job } from '../src/jobs/types.js';

const silentLogger = pino({ level: 'silent' });
const JOB_ID = 'j_00000000000000000000000077';

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: JOB_ID,
    name: 'q',
    enabled: true,
    trigger: { type: 'todoist' },
    filter: null,
    action: { type: 'spawn', daemonId: 'd1', folder: '/work', prompt: 'go' },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const continueAction = {
  type: 'continue' as const,
  daemonId: 'd1',
  folder: '/work',
  prompt: 'go',
};

function stateEvent(chatId: string, activity: ChatActivity): WireEvent {
  return {
    type: 'chat.state',
    chatId,
    activity,
    lastUpdated: 1,
    permissionMode: 'bypassPermissions',
  };
}

describe('job queueing modes', () => {
  let dir: string;
  let now: number;
  let link: InProcessDaemonLink;
  let disp: JobDispatcher;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-queueing-'));
    now = 1_000_000;
    link = new InProcessDaemonLink();
    let n = 0;
    disp = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger: silentLogger,
      idGenerator: () => `id${++n}`,
      nowMs: () => now,
    });
  });
  afterEach(() => {
    disp.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const spawned = (): string[] =>
    link.sent.flatMap((s) => (s.event.type === 'chat.spawn_request' ? [s.event.chatId] : []));
  const inputs = (): string[] =>
    link.sent.flatMap((s) => (s.event.type === 'chat.input' ? [s.event.chatId] : []));

  it('parallel sends every fire at once', () => {
    const job = makeJob({ queueing: { mode: 'parallel' } });
    for (let i = 0; i < 4; i++) expect(disp.dispatch(job, { i }, 'todoist').status).toBe('sent');
    expect(disp.counts(JOB_ID)).toEqual({ inFlight: 0, queued: 0 });
  });

  it('queue defaults to one at a time', () => {
    const job = makeJob({ queueing: { mode: 'queue' } });
    expect(disp.dispatch(job, {}, 'todoist').status).toBe('sent');
    expect(disp.dispatch(job, {}, 'todoist').status).toBe('queued');
  });

  it('queue honours its concurrency', () => {
    const job = makeJob({ queueing: { mode: 'queue', concurrency: 2 } });
    expect(disp.dispatch(job, {}, 'todoist').status).toBe('sent');
    expect(disp.dispatch(job, {}, 'todoist').status).toBe('sent');
    expect(disp.dispatch(job, {}, 'todoist').status).toBe('queued');
    expect(disp.queue(JOB_ID).concurrency).toBe(2);
  });

  it('a keyed queue limits per subject: different keys run together, the same key waits', () => {
    const job = makeJob({ queueing: { mode: 'queue', key: '{{id}}' } });
    expect(disp.dispatch(job, { id: 'a' }, 'todoist').status).toBe('sent');
    expect(disp.dispatch(job, { id: 'b' }, 'todoist').status).toBe('sent');
    expect(disp.dispatch(job, { id: 'a' }, 'todoist').status).toBe('queued');
    expect(disp.dispatch(job, { id: 'b' }, 'todoist').status).toBe('queued');
    expect(disp.counts(JOB_ID)).toEqual({ inFlight: 2, queued: 2 });
  });

  it("a keyed queue releases a subject's waiting fire when that subject's chat finishes, not another's", () => {
    const job = makeJob({ queueing: { mode: 'queue', key: '{{id}}' } });
    disp.dispatch(job, { id: 'a' }, 'todoist');
    disp.dispatch(job, { id: 'b' }, 'todoist');
    disp.dispatch(job, { id: 'a' }, 'todoist');
    const [chatA, chatB] = spawned() as [string, string];
    link.emit(stateEvent(chatB, 'running'));
    link.emit(stateEvent(chatB, 'idle'));
    expect(spawned()).toHaveLength(2); // b finishing frees nothing for a
    link.emit(stateEvent(chatA, 'running'));
    link.emit(stateEvent(chatA, 'idle'));
    expect(spawned()).toHaveLength(3);
  });

  it('a keyed queue refuses a fire whose key renders empty rather than falling back', () => {
    const job = makeJob({ queueing: { mode: 'queue', key: '{{id}}' } });
    expect(disp.dispatch(job, {}, 'todoist').status).toBe('rejected');
    expect(spawned()).toHaveLength(0);
  });

  describe('append', () => {
    const base = (q: Extract<NonNullable<Job['queueing']>, { mode: 'append' }>): Job =>
      makeJob({ action: continueAction, queueing: q });

    it('appends into one chat while no reset limit is hit', () => {
      const job = base({ mode: 'append' });
      for (let i = 0; i < 3; i++) disp.dispatch(job, {}, 'todoist');
      expect(spawned()).toEqual([`jobchat-${JOB_ID}`]);
      expect(inputs()).toEqual([`jobchat-${JOB_ID}`, `jobchat-${JOB_ID}`]);
    });

    it('starts a fresh chat after the idle timeout', () => {
      const job = base({ mode: 'append', idleTimeoutMs: 60_000 });
      disp.dispatch(job, {}, 'todoist');
      now += 59_000;
      disp.dispatch(job, {}, 'todoist');
      expect(spawned()).toHaveLength(1);
      now += 60_000;
      disp.dispatch(job, {}, 'todoist');
      expect(spawned()).toEqual([`jobchat-${JOB_ID}`, `jobchat-${JOB_ID}-g1`]);
    });

    it('idle timeout counts from the last fire, reset time from the chat start', () => {
      const job = base({ mode: 'append', resetAfterMs: 100_000 });
      disp.dispatch(job, {}, 'todoist');
      now += 60_000;
      disp.dispatch(job, {}, 'todoist');
      now += 60_000; // 120s since start, only 60s since last fire
      disp.dispatch(job, {}, 'todoist');
      expect(spawned()).toEqual([`jobchat-${JOB_ID}`, `jobchat-${JOB_ID}-g1`]);
    });

    it('starts a fresh chat after the reset length', () => {
      const job = base({ mode: 'append', resetAfterMessages: 2 });
      for (let i = 0; i < 5; i++) disp.dispatch(job, {}, 'todoist');
      expect(spawned()).toEqual([
        `jobchat-${JOB_ID}`,
        `jobchat-${JOB_ID}-g1`,
        `jobchat-${JOB_ID}-g2`,
      ]);
    });

    it('resets per subject when the action is keyed', () => {
      const job = makeJob({
        action: { ...continueAction, key: '{{id}}' },
        queueing: { mode: 'append', resetAfterMessages: 1 },
      });
      disp.dispatch(job, { id: 'a' }, 'todoist');
      disp.dispatch(job, { id: 'b' }, 'todoist');
      disp.dispatch(job, { id: 'a' }, 'todoist');
      expect(spawned()).toEqual([
        `jobchat-${JOB_ID}-a`,
        `jobchat-${JOB_ID}-b`,
        `jobchat-${JOB_ID}-a-g1`,
      ]);
    });

    it('keeps its generation across a restart', () => {
      const job = base({ mode: 'append', resetAfterMessages: 1 });
      disp.dispatch(job, {}, 'todoist');
      disp.dispatch(job, {}, 'todoist'); // g1
      disp.close();
      const link2 = new InProcessDaemonLink();
      const disp2 = new JobDispatcher({
        dataDir: dir,
        logs: new JobLogs(dir),
        daemonLink: link2,
        logger: silentLogger,
        idGenerator: () => 'x',
        nowMs: () => now,
        chatExists: () => true,
      });
      disp2.dispatch(job, {}, 'todoist'); // g2
      const ids = link2.sent.flatMap((s) =>
        s.event.type === 'chat.spawn_request' || s.event.type === 'chat.input'
          ? [s.event.chatId]
          : [],
      );
      expect(ids).toEqual([`jobchat-${JOB_ID}-g2`]);
      disp2.close();
    });
  });
});

describe('queueing validation in the store', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-queueing-store-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const body = {
    name: 'x',
    trigger: { type: 'webhook' as const, scheme: 'none' as const },
    action: { type: 'spawn' as const, daemonId: 'd1', folder: '/w', prompt: 'p' },
  };
  const open = (): JobStore => new JobStore({ dataDir: dir, logger: silentLogger, watch: false });

  it('stores a queueing mode and clears it with null', () => {
    const store = open();
    const job = store.create({ ...body, queueing: { mode: 'queue', concurrency: 3 } });
    expect(store.get(job.id)?.queueing).toEqual({ mode: 'queue', concurrency: 3 });
    expect(store.patch(job.id, { queueing: null }).queueing).toBeUndefined();
    store.close?.();
  });

  it('refuses queueing together with concurrency', () => {
    const store = open();
    expect(() => store.create({ ...body, concurrency: 1, queueing: { mode: 'queue' } })).toThrow(
      /both set the job limit/,
    );
    store.close?.();
  });

  it('refuses append on a non-continue action, including via a patch of the action', () => {
    const store = open();
    expect(() => store.create({ ...body, queueing: { mode: 'append' } })).toThrow(/continue/);
    const job = store.create({
      ...body,
      action: { type: 'continue', daemonId: 'd1', folder: '/w', prompt: 'p' },
      queueing: { mode: 'append' },
    });
    expect(() => store.patch(job.id, { action: body.action })).toThrow(/continue/);
    store.close?.();
  });
});
