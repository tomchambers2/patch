// Batch notifier (spec/14 § Batch mode, spec/09 § Batch check-in).

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { NotifyEvent, WireEvent } from '@patch/wire';
import { BATCH_NOTIFY_CHAT_ID, SPECIAL_THREAD_IDS } from '@patch/wire';
import { ChatRegistry } from '../src/chat-registry.js';
import { BatchStore } from '../src/batch/store.js';
import { BatchNotifier } from '../src/notifications/batch.js';
import type { NotificationRouter, RouteOptions } from '../src/notifications/router.js';

const logger = pino({ level: 'silent' });

function spawned(chatId: string): WireEvent {
  return {
    type: 'chat.spawned',
    chatId,
    daemonId: 'hetzner',
    folder: '/home/tom/projects/bed-planner',
    seq: 1,
    ts: 0,
  } as WireEvent;
}

function state(chatId: string, over: Partial<Record<string, unknown>> = {}): WireEvent {
  return {
    type: 'chat.state',
    chatId,
    daemonId: 'hetzner',
    activity: 'idle',
    permissionMode: 'auto',
    folder: '/home/tom/projects/bed-planner',
    lastUpdated: 0,
    seq: 2,
    ts: 0,
    ...over,
  } as WireEvent;
}

interface Routed {
  event: NotifyEvent;
  opts: RouteOptions;
}

describe('BatchNotifier', () => {
  let dir: string;
  let chats: ChatRegistry;
  let store: BatchStore;
  let notifier: BatchNotifier;
  let routed: Routed[];
  let now: number;
  let pendingTimers: { cb: () => void; ms: number }[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-batch-notifier-'));
    chats = new ChatRegistry({ logger });
    store = new BatchStore({ dataDir: dir, logger, nowMs: () => now });
    routed = [];
    pendingTimers = [];
    now = 1_000_000;
    const router = {
      route: async (event: NotifyEvent, opts: RouteOptions = {}) => {
        routed.push({ event, opts });
      },
    } as unknown as NotificationRouter;
    notifier = new BatchNotifier({
      store,
      chats,
      router,
      logger: { info: logger.info.bind(logger), warn: logger.warn.bind(logger) },
      now: () => now,
      setTimeout: (cb, ms) => {
        const handle = { cb, ms };
        pendingTimers.push(handle);
        return handle;
      },
      clearTimeout: (h) => {
        const idx = pendingTimers.indexOf(h as { cb: () => void; ms: number });
        if (idx >= 0) pendingTimers.splice(idx, 1);
      },
    });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function feed(event: WireEvent): void {
    chats.observe(event);
    notifier.observe(event);
  }

  function seedRunning(chatId: string): void {
    feed(spawned(chatId));
    feed(state(chatId, { activity: 'running' }));
  }

  /** Simulate the real timer firing at its scheduled time (the test has
   *  already advanced `now` to that point). */
  function fireDueTimer(): void {
    const due = pendingTimers.shift();
    if (!due) throw new Error('no timer armed');
    due.cb();
  }

  test('a user turn starting while a batch runs auto-joins its chat', () => {
    store.start({ type: 'time', minutes: 20 });
    notifier.start();
    seedRunning('c1');
    expect(store.current()?.members).toEqual(['c1']);
  });

  test('a machine-originated turn does not auto-join', () => {
    store.start({ type: 'time', minutes: 20 });
    notifier.start();
    feed(spawned('c1'));
    feed(state('c1', { activity: 'running', turnOrigin: 'machine' }));
    expect(store.current()?.members).toEqual([]);
  });

  test('special threads never auto-join', () => {
    store.start({ type: 'time', minutes: 20 });
    notifier.start();
    feed(spawned(SPECIAL_THREAD_IDS.manager));
    feed(state(SPECIAL_THREAD_IDS.manager, { activity: 'running' }));
    expect(store.current()?.members).toEqual([]);
  });

  test('with no batch running, chat activity is a no-op', () => {
    notifier.start();
    seedRunning('c1');
    expect(store.current()).toBeNull();
  });

  test('a "time" check-in fires the timer and notifies once, desktop + push', () => {
    store.start({ type: 'time', minutes: 20 });
    notifier.start();
    seedRunning('c1');
    now += 20 * 60_000;
    fireDueTimer();
    expect(store.current()?.checkedIn).toBe(true);
    expect(routed).toHaveLength(2);
    expect(routed.map((r) => r.event.channel)).toEqual(['desktop', 'push']);
    for (const r of routed) {
      expect(r.event.chatId).toBe(BATCH_NOTIFY_CHAT_ID);
      expect(r.event.kind).toBe('batch');
      expect(r.event.message).toBe('Batch ready: 0 done, 1 still running');
    }
  });

  test('an "all-done" batch checks in the moment every member is ready, without waiting for the timer', () => {
    store.start({ type: 'all-done' });
    notifier.start();
    seedRunning('c1');
    seedRunning('c2');
    feed(state('c1', { activity: 'idle' }));
    expect(store.current()?.checkedIn).toBe(false); // c2 still running
    feed(state('c2', { activity: 'idle' }));
    expect(store.current()?.checkedIn).toBe(true);
    expect(routed).toHaveLength(2);
    expect(routed[0]?.event.message).toBe('Batch ready: 2 done, 0 still running');
  });

  test('"when all done" never fires the timer-only path early if members are still running', () => {
    store.start({ type: 'all-done' });
    notifier.start();
    seedRunning('c1');
    now += 10 * 60_000;
    expect(routed).toEqual([]);
    // Still armed for the 30-min cap.
    expect(pendingTimers).toHaveLength(1);
  });

  test('a restored batch whose deadline already passed checks in immediately on start()', () => {
    store.start({ type: 'time', minutes: 15 });
    store.ensureMember('c1');
    now += 20 * 60_000; // past the 15-minute deadline, server was "down"
    const fresh = new BatchNotifier({
      store,
      chats,
      router: {
        route: async (e: NotifyEvent) => void routed.push({ event: e, opts: {} }),
      } as unknown as NotificationRouter,
      logger: { info: logger.info.bind(logger), warn: logger.warn.bind(logger) },
      now: () => now,
      setTimeout: (cb) => {
        cb(); // simulate the zero-delay fire a past deadline produces
        return {};
      },
      clearTimeout: () => undefined,
    });
    fresh.start();
    expect(store.current()?.checkedIn).toBe(true);
  });

  test('Check in now (BatchStore.checkIn directly) does not notify', () => {
    store.start({ type: 'time', minutes: 20 });
    notifier.start();
    seedRunning('c1');
    store.checkIn();
    notifier.recomputeTriggers();
    expect(routed).toEqual([]);
    expect(store.current()?.checkedIn).toBe(true);
  });

  test('the batch ends once every ready member has been opened; a still-running one rolls over', () => {
    store.start({ type: 'time', minutes: 20 });
    notifier.start();
    seedRunning('done1');
    seedRunning('running1');
    feed(state('done1', { activity: 'idle' }));
    store.checkIn();
    store.markOpened('done1');
    notifier.recomputeTriggers();
    expect(store.current()).toBeNull();
    expect(store.carryoverMembers()).toEqual(['running1']);
  });

  test('the batch does not end while a ready member remains unopened', () => {
    store.start({ type: 'time', minutes: 20 });
    notifier.start();
    seedRunning('c1');
    feed(state('c1', { activity: 'idle' }));
    store.checkIn();
    notifier.recomputeTriggers();
    expect(store.current()).not.toBeNull();
  });
});
