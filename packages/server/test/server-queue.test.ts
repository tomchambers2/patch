// The server-run message queue (spec/04 § Message queueing): messages that
// arrive behind a running turn wait on the server, which decides when each one
// reaches the agent.

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { ChatInputEvent, WireEvent } from '@patch/wire';
import { ChatRegistry } from '../src/chat-registry.js';
import { ServerQueue, RELEASE_GUARD_MS } from '../src/server-queue.js';

const logger = pino({ level: 'silent' });

const input = (localId: string, over: Partial<ChatInputEvent> = {}): ChatInputEvent =>
  ({
    type: 'chat.input',
    chatId: 'c1',
    message: `text ${localId}`,
    localId,
    ...over,
  }) as ChatInputEvent;

const spawned = (chatId = 'c1', daemonId = 'd1'): WireEvent =>
  ({ type: 'chat.spawned', chatId, daemonId, folder: '/w', seq: 1, ts: 0 }) as WireEvent;

const state = (activity: string, over: Record<string, unknown> = {}): WireEvent =>
  ({
    type: 'chat.state',
    chatId: 'c1',
    daemonId: 'd1',
    activity,
    permissionMode: 'auto',
    folder: '/w',
    lastUpdated: 0,
    seq: 2,
    ts: 0,
    ...over,
  }) as WireEvent;

describe('ServerQueue', () => {
  let dir: string;
  let chats: ChatRegistry;
  let injected: WireEvent[];
  let sent: Array<{ daemonId: string; surfaceId: string; event: WireEvent }>;
  let online: boolean;
  let supports: boolean;
  let nowMs: number;

  const make = (): ServerQueue =>
    new ServerQueue({
      chats,
      sendTo: (daemonId, surfaceId, event) => sent.push({ daemonId, surfaceId, event }),
      isOnline: () => online,
      hostSupports: () => supports,
      inject: (e) => injected.push(e),
      dataDir: dir,
      logger,
      now: () => nowMs,
    });

  /** What production does: the registry and the queue both see a host frame. */
  const hostFrame = (queue: ServerQueue, event: WireEvent, from = 'd1'): WireEvent | null => {
    const gated = queue.gate(event, from);
    if (gated) chats.observe(gated);
    return gated;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-sq-'));
    chats = new ChatRegistry({ logger });
    injected = [];
    sent = [];
    online = true;
    supports = true;
    nowMs = 1_000_000;
    chats.observe(spawned());
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('holds a message that arrives behind a running turn, and acknowledges it', () => {
    const q = make();
    hostFrame(q, state('running'));
    expect(q.enqueueIfBusy('srf-1', input('L1'))).toBe(true);
    expect(sent).toEqual([]);
    expect(injected).toEqual([
      { type: 'chat.input_ack', chatId: 'c1', localId: 'L1', forSurfaceId: 'srf-1' },
      { type: 'chat.queued', chatId: 'c1', localId: 'L1', message: 'text L1', queueSeq: 1 },
    ]);
  });

  test('leaves a message for the host when the chat is idle', () => {
    const q = make();
    hostFrame(q, state('idle'));
    expect(q.enqueueIfBusy('srf-1', input('L1'))).toBe(false);
  });

  test('a message sent right behind one just handed to an idle host queues behind it', () => {
    const q = make();
    hostFrame(q, state('idle'));
    q.noteForwarded('c1');
    expect(q.enqueueIfBusy('srf-1', input('L2'))).toBe(true);
    nowMs += RELEASE_GUARD_MS + 1; // the host never started: not waited on for ever
    expect(make().enqueueIfBusy('srf-1', input('L3'))).toBe(true); // the queue still holds L2
  });

  test.each([
    ['the host is offline', () => (online = false)],
    ['the host does not take queued messages from the server', () => (supports = false)],
  ])('does not take a message when %s', (_name, change) => {
    const q = make();
    hostFrame(q, state('running'));
    change();
    expect(q.enqueueIfBusy('srf-1', input('L1'))).toBe(false);
  });

  test('does not take a side-branch message or a voice-device message', () => {
    const q = make();
    hostFrame(q, state('running'));
    expect(q.enqueueIfBusy('srf-1', input('L1', { branchId: 'b1' }))).toBe(false);
    expect(
      q.enqueueIfBusy(
        'srf-1',
        input('L2', { source: { kind: 'voice-device', deviceId: 'k' } } as never),
      ),
    ).toBe(false);
  });

  test('a redelivered message is acknowledged again and held once', () => {
    const q = make();
    hostFrame(q, state('running'));
    q.enqueueIfBusy('srf-1', input('L1'));
    expect(q.enqueueIfBusy('srf-1', input('L1'))).toBe(true);
    expect(injected.filter((e) => e.type === 'chat.queued')).toHaveLength(1);
    expect(injected.filter((e) => e.type === 'chat.input_ack')).toHaveLength(2);
  });

  test('releases the next message when the chat goes idle, and reports the chat as still running', async () => {
    const q = make();
    hostFrame(q, state('running'));
    q.enqueueIfBusy('srf-1', input('L1'));
    q.enqueueIfBusy('srf-1', input('L2'));
    injected.length = 0;

    const passed = hostFrame(q, state('idle'));
    expect((passed as { activity: string }).activity).toBe('running');
    await Promise.resolve();

    expect(sent.map((s) => (s.event as { localId: string }).localId)).toEqual(['L1']);
    expect(sent[0]).toMatchObject({ daemonId: 'd1', surfaceId: 'srf-1' });
    expect(injected).toEqual([
      { type: 'chat.dequeued', chatId: 'c1', localId: 'L1', reason: 'running' },
    ]);

    // The host started it, finished it, and the last message goes the same way.
    hostFrame(q, state('running'));
    const second = hostFrame(q, state('idle'));
    expect((second as { activity: string }).activity).toBe('running');
    await Promise.resolve();
    expect(sent.map((s) => (s.event as { localId: string }).localId)).toEqual(['L1', 'L2']);

    // With nothing left, idle is idle.
    hostFrame(q, state('running'));
    expect((hostFrame(q, state('idle')) as { activity: string }).activity).toBe('idle');
  });

  test('a tool-boundary pull takes everything waiting, in order, once', () => {
    const q = make();
    hostFrame(q, state('running'));
    q.enqueueIfBusy('srf-1', input('L1'));
    q.enqueueIfBusy('srf-2', input('L2'));
    expect(q.pull('c1').map((e) => e.localId)).toEqual(['L1', 'L2']);
    expect(q.pull('c1')).toEqual([]);
    expect(q.hasWaiting('c1')).toBe(false);
  });

  test("cancel and edit act on what the server holds, and leave the host's own queue alone", () => {
    const q = make();
    hostFrame(q, state('running'));
    q.enqueueIfBusy('srf-1', input('L1'));
    q.enqueueIfBusy('srf-1', input('L2'));
    injected.length = 0;

    expect(q.edit('c1', 'L1', 'changed')).toBe(true);
    expect(injected).toEqual([
      { type: 'chat.queued', chatId: 'c1', localId: 'L1', message: 'changed', queueSeq: 1 },
    ]);
    expect(q.unqueue('c1', 'L2')).toBe(true);
    expect(injected.at(-1)).toEqual({
      type: 'chat.dequeued',
      chatId: 'c1',
      localId: 'L2',
      reason: 'cancelled',
    });
    expect(q.pull('c1').map((e) => [e.localId, e.message])).toEqual([['L1', 'changed']]);

    expect(q.unqueue('c1', 'host-held')).toBe(false);
    expect(q.edit('c1', 'host-held', 'x')).toBe(false);
    expect(q.promote('c1', 'host-held', 'srf-1')).toBe(false);
  });

  test('editing a waiting message to nothing removes it', () => {
    const q = make();
    hostFrame(q, state('running'));
    q.enqueueIfBusy('srf-1', input('L1'));
    expect(q.edit('c1', 'L1', '  ')).toBe(true);
    expect(q.hasWaiting('c1')).toBe(false);
  });

  test('send now stops the running turn without reordering the queue', () => {
    const q = make();
    hostFrame(q, state('running'));
    q.enqueueIfBusy('srf-1', input('L1'));
    q.enqueueIfBusy('srf-1', input('L2'));
    expect(q.promote('c1', 'L2', 'srf-9')).toBe(true);
    expect(sent).toEqual([
      { daemonId: 'd1', surfaceId: 'srf-9', event: { type: 'chat.stop_request', chatId: 'c1' } },
    ]);
    expect(q.pull('c1').map((e) => e.localId)).toEqual(['L1', 'L2']);
  });

  test('keeps the queue when the host is unreachable at release, and retries on the next idle', async () => {
    const q = make();
    hostFrame(q, state('running'));
    q.enqueueIfBusy('srf-1', input('L1'));
    online = false;
    hostFrame(q, state('idle'));
    await Promise.resolve();
    expect(sent).toEqual([]);
    expect(q.hasWaiting('c1')).toBe(true);

    online = true;
    hostFrame(q, state('running'));
    hostFrame(q, state('idle'));
    await Promise.resolve();
    expect(sent).toHaveLength(1);
  });

  test('archiving a chat drops what it was holding', () => {
    const q = make();
    hostFrame(q, state('running'));
    q.enqueueIfBusy('srf-1', input('L1'));
    injected.length = 0;
    hostFrame(q, state('idle', { status: 'archived' }));
    expect(q.hasWaiting('c1')).toBe(false);
    expect(injected).toEqual([
      { type: 'chat.dequeued', chatId: 'c1', localId: 'L1', reason: 'cancelled' },
    ]);
  });

  test('survives a restart, announcing what it restored', () => {
    const q = make();
    hostFrame(q, state('running'));
    q.enqueueIfBusy('srf-1', input('L1'));
    q.enqueueIfBusy('srf-1', input('L2'));

    injected = [];
    const restarted = make();
    restarted.restore();
    expect(injected.map((e) => (e as { localId: string }).localId)).toEqual(['L1', 'L2']);
    expect(restarted.pull('c1').map((e) => e.localId)).toEqual(['L1', 'L2']);
  });

  test('numbers messages from the same count across a restart', () => {
    const q = make();
    hostFrame(q, state('running'));
    q.enqueueIfBusy('srf-1', input('L1'));
    const restarted = make();
    hostFrame(restarted, state('running'));
    restarted.enqueueIfBusy('srf-1', input('L2'));
    expect(
      injected
        .filter((e) => e.type === 'chat.queued')
        .map((e) => (e as { queueSeq: number }).queueSeq),
    ).toEqual([1, 2]);
  });

  describe('edges', () => {
    test('a host going offline lets go of the chats it was starting, and only those', () => {
      chats.observe({
        type: 'chat.spawned',
        chatId: 'c2',
        daemonId: 'd2',
        folder: '/w',
        seq: 1,
        ts: 0,
      } as WireEvent);
      const q = make();
      hostFrame(q, state('idle'));
      q.noteForwarded('c1');
      q.noteForwarded('c2');
      expect(q.enqueueIfBusy('srf-1', input('L1'))).toBe(true); // c1 is being started
      expect(q.enqueueIfBusy('srf-1', input('L2', { chatId: 'c2' }))).toBe(true);

      q.gate({ type: 'daemon.offline', daemonId: 'd1' } as WireEvent, 'd1');
      // c1's release guard is gone; c2's is not. Nothing waits on c1 any more but L1.
      q.pull('c1');
      expect(q.enqueueIfBusy('srf-1', input('L3'))).toBe(false);
      expect(q.enqueueIfBusy('srf-1', input('L4', { chatId: 'c2' }))).toBe(true);
    });

    test('passes any frame that is not about a chat through untouched', () => {
      const q = make();
      const other = { type: 'folders.list', daemonId: 'd1', roots: [], recent: [] } as WireEvent;
      expect(q.gate(other, 'd1')).toBe(other);
      const noActivity = { ...state('idle'), activity: undefined } as WireEvent;
      expect(q.gate(noActivity, 'd1')).toBe(noActivity);
    });

    test('lets an idle chat go to the host after the release guard runs out', () => {
      const q = make();
      hostFrame(q, state('idle'));
      q.noteForwarded('c1');
      expect(q.enqueueIfBusy('srf-1', input('L1'))).toBe(true);
      q.pull('c1');
      nowMs += RELEASE_GUARD_MS + 1;
      expect(q.enqueueIfBusy('srf-1', input('L2'))).toBe(false);
    });

    test('takes the host from its own mirror when a frame does not say where it came from', async () => {
      const q = make();
      hostFrame(q, state('running'));
      q.enqueueIfBusy('srf-1', input('L1'));
      const passed = q.gate(state('idle'), null);
      expect((passed as { activity: string }).activity).toBe('running');
      await Promise.resolve();
      expect(sent.map((s) => s.daemonId)).toEqual(['d1']);
    });

    test('sends nothing when what it meant to release was taken or cancelled in the meantime', async () => {
      const q = make();
      hostFrame(q, state('running'));
      q.enqueueIfBusy('srf-1', input('L1'));
      q.gate(state('idle'), 'd1'); // schedules the release
      q.unqueue('c1', 'L1'); // the surface cancelled it first
      await Promise.resolve();
      expect(sent).toEqual([]);
    });

    test('keeps the message when it has nowhere to send it', async () => {
      const gone = new Map<string, boolean>();
      const q = new ServerQueue({
        chats: { get: (id) => (gone.get(id) ? undefined : chats.get(id)) },
        sendTo: (daemonId, surfaceId, event) => sent.push({ daemonId, surfaceId, event }),
        isOnline: () => online,
        hostSupports: () => supports,
        inject: (e) => injected.push(e),
        logger,
      });
      hostFrame(q, state('running'));
      q.enqueueIfBusy('srf-1', input('L1'));
      gone.set('c1', true); // the mirror no longer knows the chat
      q.gate(state('idle'), null);
      await Promise.resolve();
      expect(sent).toEqual([]);
      expect(q.hasWaiting('c1')).toBe(true);
    });

    test('an edit that empties a message with an attachment keeps it', () => {
      const q = make();
      hostFrame(q, state('running'));
      q.enqueueIfBusy(
        'srf-1',
        input('L1', { attachments: [{ kind: 'image', id: 'a1', name: 'p.png' }] } as never),
      );
      expect(q.edit('c1', 'L1', '')).toBe(true);
      expect(q.hasWaiting('c1')).toBe(true);
      expect(q.pull('c1')[0]!.message).toBe('');
    });

    test('works with no data directory, and says so when it cannot write or read its file', () => {
      const memory = new ServerQueue({
        chats,
        sendTo: () => undefined,
        isOnline: () => true,
        hostSupports: () => true,
        inject: () => undefined,
        logger,
      });
      hostFrame(memory, state('running'));
      expect(memory.enqueueIfBusy('srf-1', input('L1'))).toBe(true);

      const warned: string[] = [];
      const noisy = {
        info: () => undefined,
        warn: (_o: unknown, m?: string) => warned.push(String(m)),
      };
      writeFileSync(join(dir, 'server-queue.json'), '{not json');
      new ServerQueue({
        chats,
        sendTo: () => undefined,
        isOnline: () => true,
        hostSupports: () => true,
        inject: () => undefined,
        dataDir: dir,
        logger: noisy,
      });
      expect(warned.join(' ')).toContain('could not read the queue');

      const unwritable = new ServerQueue({
        chats,
        sendTo: () => undefined,
        isOnline: () => true,
        hostSupports: () => true,
        inject: () => undefined,
        dataDir: join(dir, 'not', 'a', 'directory'),
        logger: noisy,
      });
      hostFrame(unwritable, state('running'));
      unwritable.enqueueIfBusy('srf-1', input('L9'));
      expect(warned.join(' ')).toContain('could not write the queue');
    });

    test('reads a saved queue that is missing its parts as empty', () => {
      writeFileSync(join(dir, 'server-queue.json'), '{}');
      const q = make();
      expect(q.hasWaiting('c1')).toBe(false);
      hostFrame(q, state('running'));
      q.enqueueIfBusy('srf-1', input('L1'));
      expect(injected.at(-1)).toMatchObject({ queueSeq: 1 });
    });
  });
});
