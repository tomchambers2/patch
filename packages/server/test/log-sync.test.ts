// Keeping the server's log and a host's log in step (spec/01 § Message log).

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { ChatLogStore } from '../src/chat-log-store.js';
import { LOG_RESTORE_RETRY_MS, LOG_SYNC_DELAY_MS, LogSync } from '../src/log-sync.js';

const logger = pino({ level: 'silent' });

const say = (seq: number, role: 'user' | 'assistant' = 'assistant', chatId = 'c1'): WireEvent =>
  ({ type: 'chat.message', chatId, role, content: `m${seq}`, seq }) as WireEvent;

const reported = (lastSeq: number, chatId = 'c1'): WireEvent =>
  ({ type: 'chat.state', chatId, daemonId: 'd1', activity: 'idle', lastSeq }) as WireEvent;

describe('LogSync', () => {
  let store: ChatLogStore;
  let online: boolean;
  let sent: Array<{ daemonId: string; event: WireEvent }>;
  let injected: WireEvent[];
  let sync: LogSync;
  let nowMs: number;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new ChatLogStore({ logger });
    online = true;
    sent = [];
    injected = [];
    nowMs = 1_000_000;
    sync = new LogSync({
      store,
      chats: {
        get: (id: string) => (id.startsWith('c') ? ({ daemonId: 'd1' } as never) : undefined),
      },
      sendTo: (daemonId, _s, event) => sent.push({ daemonId, event }),
      isOnline: () => online,
      inject: (e) => injected.push(e),
      logger,
      now: () => nowMs,
    });
    for (const seq of [1, 2, 3]) store.commit(say(seq));
  });
  afterEach(() => {
    sync.stop();
    vi.useRealTimers();
  });

  const settle = (): void => {
    vi.advanceTimersByTime(LOG_SYNC_DELAY_MS + 1);
  };

  test('does nothing while the host and the server agree', () => {
    sync.observe(reported(3));
    settle();
    expect(sent).toEqual([]);
  });

  test("asks a host that is ahead for what follows the server's log, once for each new reach", () => {
    sync.observe(reported(7));
    settle();
    expect(sent).toEqual([
      { daemonId: 'd1', event: { type: 'patch.log_sync.request', chatId: 'c1', afterSeq: 3 } },
    ]);

    sent.length = 0;
    sync.observe(reported(7)); // the answer had nothing new; do not ask again for the same reach
    settle();
    expect(sent).toEqual([]);

    sync.observe(reported(9));
    settle();
    expect(sent).toHaveLength(1);
  });

  test('waits, so a host that numbers an event a beat before sending it is not asked', () => {
    sync.observe(reported(4));
    store.commit(say(4)); // it arrives before the wait is over
    settle();
    expect(sent).toEqual([]);
  });

  test('one wait covers a burst of reports', () => {
    sync.observe(reported(5));
    sync.observe(reported(6));
    sync.observe(reported(7));
    settle();
    expect(sent).toHaveLength(1);
  });

  test('sends a host that is behind what it lacks, oldest first', () => {
    sync.observe(reported(1));
    settle();
    expect(sent).toHaveLength(1);
    const restore = sent[0]!.event as {
      type: string;
      events: Array<{ seq: number }>;
      done: boolean;
    };
    expect(restore.type).toBe('patch.log_restore');
    expect(restore.events.map((e) => e.seq)).toEqual([2, 3]);
    expect(restore.done).toBe(true);
  });

  test('splits a long restore into batches, closing only the last', () => {
    for (let seq = 4; seq <= 450; seq++) store.commit(say(seq));
    sync.observe(reported(-0));
    settle();
    const batches = sent.map((s) => s.event as { events: unknown[]; done: boolean });
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.every((b) => b.events.length <= 200)).toBe(true);
    expect(batches.map((b) => b.done)).toEqual(batches.map((_, i) => i === batches.length - 1));
    expect(batches.reduce((n, b) => n + b.events.length, 0)).toBe(450);
  });

  test('does not send the same restore again at once, and does once it has had its chance', () => {
    sync.observe(reported(1));
    settle();
    sent.length = 0;
    sync.observe(reported(1));
    settle();
    expect(sent).toEqual([]);

    nowMs += LOG_RESTORE_RETRY_MS + 1;
    sync.observe(reported(1));
    settle();
    expect(sent).toHaveLength(1);
  });

  test('leaves a chat the server holds none of alone: it keeps what it has seen, not every history', () => {
    sync.observe(reported(500, 'c-unseen'));
    settle();
    expect(sent).toEqual([]);
  });

  test('does nothing for a host that is offline, or a report with no log high-water', () => {
    online = false;
    sync.observe(reported(9));
    settle();
    expect(sent).toEqual([]);
    online = true;
    sync.observe({
      type: 'chat.state',
      chatId: 'c1',
      daemonId: 'd1',
      activity: 'idle',
    } as WireEvent);
    settle();
    expect(sent).toEqual([]);
  });

  test('takes the events a host sends back as live events, transcript only', () => {
    sync.observe({
      type: 'patch.log_sync.batch',
      chatId: 'c1',
      events: [
        say(4),
        { type: 'chat.tool_run_summary', chatId: 'c1', callIds: [], summary: 's', seq: 5 },
        { type: 'chat.message_delta', chatId: 'c1', messageSeq: 4, delta: 'x' },
      ],
      done: true,
    } as WireEvent);
    expect(injected.map((e) => e.type)).toEqual(['chat.message']);
  });

  test('a host going offline cancels what was waiting', () => {
    sync.observe(reported(9));
    sync.observe({ type: 'daemon.offline', daemonId: 'd1' } as WireEvent);
    settle();
    expect(sent).toEqual([]);
  });

  test('works on the real clock when it is not given one', () => {
    const real = new LogSync({
      store,
      chats: { get: () => ({ daemonId: 'd1' }) as never },
      sendTo: (daemonId, _s, event) => sent.push({ daemonId, event }),
      isOnline: () => true,
      inject: () => undefined,
      logger,
    });
    real.observe(reported(1));
    settle();
    expect(sent).toHaveLength(1);
    real.stop();
  });

  test("another host going offline leaves a wait for this host's chat alone, and so does a chat nobody knows", () => {
    sync.observe(reported(9));
    sync.observe({ type: 'daemon.offline', daemonId: 'someone-else' } as WireEvent);
    sync.observe(reported(9, 'x-unknown'));
    sync.observe({ type: 'daemon.offline', daemonId: 'd1' } as WireEvent);
    settle();
    expect(sent).toEqual([]);

    sync.observe(reported(9));
    sync.observe({ type: 'daemon.offline', daemonId: 'someone-else' } as WireEvent);
    settle();
    expect(sent).toHaveLength(1);
  });
});
