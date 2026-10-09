// The server's record of what each chat is holding behind a running turn
// (spec/04 § Message queueing). The host announces it live only, so this is
// what lets a surface that connects later see it.

import { describe, test, expect, beforeEach } from 'vitest';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { ChatRegistry } from '../src/chat-registry.js';
import { QueueTracker } from '../src/queue-tracker.js';

const logger = pino({ level: 'silent' });

const queued = (chatId: string, localId: string, queueSeq: number, message = localId): WireEvent =>
  ({ type: 'chat.queued', chatId, localId, message, queueSeq }) as WireEvent;

describe('QueueTracker', () => {
  let chats: ChatRegistry;
  let tracker: QueueTracker;

  beforeEach(() => {
    chats = new ChatRegistry({ logger });
    tracker = new QueueTracker(chats);
  });

  const observe = (e: WireEvent): void => {
    chats.observe(e);
    tracker.observe(e);
  };

  test('holds waiting messages in queue order', () => {
    observe(queued('c1', 'b', 2));
    observe(queued('c1', 'a', 1));
    expect(tracker.snapshot('c1').map((q) => q.localId)).toEqual(['a', 'b']);
  });

  test('an edited message keeps its place and takes the new text', () => {
    observe(queued('c1', 'a', 1, 'first'));
    observe(queued('c1', 'a', 1, 'edited'));
    expect(tracker.snapshot('c1')).toEqual([
      { type: 'chat.queued', chatId: 'c1', localId: 'a', message: 'edited', queueSeq: 1 },
    ]);
  });

  test.each(['running', 'cancelled'] as const)(
    'a message dequeued as %s is no longer waiting',
    (reason) => {
      observe(queued('c1', 'a', 1));
      observe(queued('c1', 'b', 2));
      observe({ type: 'chat.dequeued', chatId: 'c1', localId: 'a', reason } as WireEvent);
      expect(tracker.snapshot('c1').map((q) => q.localId)).toEqual(['b']);
    },
  );

  test('the persisted copy of the message releases it even if the dequeue was missed', () => {
    observe(queued('c1', 'a', 1));
    observe({
      type: 'chat.message',
      chatId: 'c1',
      role: 'user',
      content: 'a',
      seq: 3,
      localId: 'a',
    } as WireEvent);
    expect(tracker.snapshot('c1')).toEqual([]);
  });

  test('an agent message does not release a waiting one', () => {
    observe(queued('c1', 'a', 1));
    observe({
      type: 'chat.message',
      chatId: 'c1',
      role: 'assistant',
      content: 'hi',
      seq: 3,
      localId: 'a',
    } as WireEvent);
    expect(tracker.snapshot('c1')).toHaveLength(1);
  });

  test('a chat that goes idle holds nothing', () => {
    observe(queued('c1', 'a', 1));
    observe({
      type: 'chat.state',
      chatId: 'c1',
      daemonId: 'd1',
      activity: 'idle',
      permissionMode: 'auto',
      folder: '/w',
      lastUpdated: 0,
      seq: 2,
      ts: 0,
    } as WireEvent);
    expect(tracker.snapshot('c1')).toEqual([]);
  });

  test("a host going offline drops only that host's queues", () => {
    observe({
      type: 'chat.spawned',
      chatId: 'c1',
      daemonId: 'd1',
      folder: '/a',
      seq: 1,
      ts: 0,
    } as WireEvent);
    observe({
      type: 'chat.spawned',
      chatId: 'c2',
      daemonId: 'd2',
      folder: '/b',
      seq: 1,
      ts: 0,
    } as WireEvent);
    observe(queued('c1', 'a', 1));
    observe(queued('c2', 'b', 1));
    observe({ type: 'daemon.offline', daemonId: 'd1' } as WireEvent);
    expect(tracker.snapshot('c1')).toEqual([]);
    expect(tracker.snapshot('c2')).toHaveLength(1);
  });
});
