// How the hub answers a replay request from the server's own log (spec/01 §
// Message log), driven directly: it answers when the chat's host is offline, adds
// the stretch a home host's log is missing for the Manager, sends in chunks to a
// surface that asked for batches, and says nothing when it has nothing to say.

import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { decode, type WireEvent } from '@patch/wire';
import { WsHub, type WsHubDeps } from '../src/ws-hub.js';
import { Registry } from '../src/registry.js';
import { PresenceTracker } from '../src/presence.js';
import { ChatRegistry } from '../src/chat-registry.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';

const silentLogger = pino({ level: 'silent' });

const say = (chatId: string, seq: number): WireEvent =>
  ({ type: 'chat.message', chatId, role: 'assistant', content: `m${seq}`, seq }) as WireEvent;

function setup(over: Partial<WsHubDeps> = {}) {
  const registry = Registry.load(mkdtempSync(join(tmpdir(), 'patch-replay-held-')));
  registry.bootstrapAccount();
  const chats = new ChatRegistry();
  chats.observe({ type: 'chat.spawned', chatId: 'c1', daemonId: 'd1', folder: '/w' } as WireEvent);
  chats.observe({
    type: 'chat.spawned',
    chatId: 'thread_manager',
    daemonId: 'd1',
    folder: '/m',
  } as WireEvent);
  const link = new InProcessDaemonLink();
  const hub = new WsHub({
    logger: silentLogger,
    registry,
    presence: new PresenceTracker(),
    daemonLink: link,
    chatRegistry: chats,
    idGenerator: () => 'id',
    ...over,
  });
  const sent: WireEvent[] = [];
  const conn = { socket: { send: (data: string) => sent.push(decode(data)) } };
  const replay = (chatId: string, over: { fromSeq?: number; batch?: boolean } = {}): void =>
    (
      hub as unknown as { replayHeldTranscript: (c: unknown, r: unknown) => void }
    ).replayHeldTranscript(conn, {
      type: 'chat.replay',
      chatId,
      fromSeq: over.fromSeq ?? -1,
      ...(over.batch !== undefined ? { batch: over.batch } : {}),
    });
  return { hub, link, sent, replay };
}

const storeOf = (events: WireEvent[]) => ({
  read: (chatId: string, fromSeq: number) =>
    events.filter(
      (e) => (e as { chatId: string }).chatId === chatId && (e as { seq: number }).seq > fromSeq,
    ),
  highWater: () => -1,
  has: () => events.length > 0,
  commit: () => 'new' as const,
  observe: () => undefined,
  readBlob: () => null,
  flush: async () => undefined,
});

describe("answering a replay from the server's log", () => {
  it('says nothing when the hub has no log of its own', () => {
    const t = setup();
    t.link.setStatus('offline');
    t.replay('c1');
    expect(t.sent).toEqual([]);
  });

  it('sends each event after the seq asked for, one frame each, when the host is offline', () => {
    const t = setup({ chatLogStore: storeOf([say('c1', 1), say('c1', 2), say('c1', 3)]) as never });
    t.link.setStatus('offline');
    t.replay('c1', { fromSeq: 1 });
    expect(t.sent.map((e) => (e as { seq: number }).seq)).toEqual([2, 3]);
  });

  it('sends nothing when it holds nothing after that seq', () => {
    const t = setup({ chatLogStore: storeOf([say('c1', 1)]) as never });
    t.link.setStatus('offline');
    t.replay('c1', { fromSeq: 5 });
    expect(t.sent).toEqual([]);
  });

  it('sends a surface that asked for batches chunked frames, closing only the last', () => {
    const many = Array.from({ length: 1_200 }, (_, i) => say('c1', i));
    const t = setup({ chatLogStore: storeOf(many) as never });
    t.link.setStatus('offline');
    t.replay('c1', { batch: true });
    const frames = t.sent as Array<{ type: string; events: unknown[]; done: boolean }>;
    expect(frames.every((f) => f.type === 'chat.replay_batch')).toBe(true);
    expect(frames.map((f) => f.events.length)).toEqual([500, 500, 200]);
    expect(frames.map((f) => f.done)).toEqual([false, false, true]);
  });

  it('sends one closed batch when everything fits in one', () => {
    const t = setup({ chatLogStore: storeOf([say('c1', 1), say('c1', 2)]) as never });
    t.link.setStatus('offline');
    t.replay('c1', { batch: true });
    expect(t.sent).toHaveLength(1);
    expect((t.sent[0] as { done: boolean }).done).toBe(true);
  });

  it('leaves a chat whose host is online to that host', () => {
    const t = setup({ chatLogStore: storeOf([say('c1', 1)]) as never });
    t.replay('c1');
    expect(t.sent).toEqual([]);
  });

  it('leaves a chat it does not know to the host too', () => {
    const t = setup({ chatLogStore: storeOf([say('nope', 1)]) as never });
    t.link.setStatus('offline');
    t.replay('nope');
    expect(t.sent).toEqual([]);
  });

  it("adds the Manager's missing stretch even while the host is online", () => {
    const gap = [say('thread_manager', 5), say('thread_manager', 6)];
    const t = setup({
      chatLogStore: storeOf(gap) as never,
      managerFailover: {
        gapEvents: (from: number) => gap.filter((e) => (e as { seq: number }).seq > from),
      } as never,
    });
    t.replay('thread_manager', { fromSeq: 5 });
    expect(t.sent.map((e) => (e as { seq: number }).seq)).toEqual([6]);
  });

  it('adds nothing for the Manager without a failover, and nothing for another chat with one', () => {
    const gap = [say('thread_manager', 5)];
    const without = setup({ chatLogStore: storeOf(gap) as never });
    without.replay('thread_manager');
    expect(without.sent).toEqual([]);

    const withFailover = setup({
      chatLogStore: storeOf(gap) as never,
      managerFailover: { gapEvents: () => gap } as never,
    });
    withFailover.replay('c1');
    expect(withFailover.sent).toEqual([]);
  });
});
