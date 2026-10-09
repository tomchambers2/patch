// The server owns what it last knew about each chat (spec/01 § Chat state): the
// mirror is saved as it changes and read back at startup, so a restart begins
// from that rather than from nothing.

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { ChatRegistry } from '../src/chat-registry.js';

const logger = pino({ level: 'silent' });

const spawned = (chatId: string, daemonId = 'd1'): WireEvent =>
  ({ type: 'chat.spawned', chatId, daemonId, folder: `/w/${chatId}` }) as WireEvent;

const state = (chatId: string, activity: string, over: Record<string, unknown> = {}): WireEvent =>
  ({
    type: 'chat.state',
    chatId,
    daemonId: 'd1',
    activity,
    permissionMode: 'auto',
    folder: `/w/${chatId}`,
    lastUpdated: 100,
    ...over,
  }) as WireEvent;

const foldersList = (daemonId: string): WireEvent =>
  ({ type: 'folders.list', daemonId, roots: [], recent: [] }) as WireEvent;

describe('ChatRegistry persistence', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-reg-'));
    path = join(dir, 'chat-registry.json');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const make = (jobId: string | null = null): ChatRegistry =>
    new ChatRegistry({ logger, persistPath: path, jobChatLinks: { get: () => jobId } });

  test('starts from what it knew: activity, status, host, job and time survive a restart', () => {
    const first = make('j_1');
    first.observe(spawned('c1'));
    first.observe(state('c1', 'idle', { lastUpdated: 777, status: 'active' }));
    first.flush();

    const second = make();
    expect(second.get('c1')).toMatchObject({
      chatId: 'c1',
      activity: 'idle',
      status: 'active',
      daemonId: 'd1',
      jobId: 'j_1',
      lastUpdated: 777,
    });
  });

  test('a restored chat takes chat.state without being announced again', () => {
    const first = make();
    first.observe(spawned('c1'));
    first.observe(state('c1', 'running'));
    first.flush();

    const second = make();
    second.observe(state('c1', 'idle', { lastUpdated: 900 }));
    expect(second.get('c1')).toMatchObject({ activity: 'idle', lastUpdated: 900 });
  });

  test('a chat the server never knew is still refused a row from a bare chat.state', () => {
    const r = make();
    r.observe(state('ghost', 'idle'));
    expect(r.get('ghost')).toBeUndefined();
  });

  test('is written a moment after a change, without being asked', async () => {
    const r = make();
    r.observe(spawned('c1'));
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(JSON.parse(readFileSync(path, 'utf8')).chats[0].chatId).toBe('c1');
  });

  test('keeps an error, a removal, a delete and a move', () => {
    const first = make();
    for (const id of ['c1', 'c2', 'c3', 'c4']) {
      first.observe(spawned(id));
      first.observe(state(id, 'running'));
    }
    first.markErrored('c1', { code: 'internal', message: 'x' }, 5_000);
    first.remove('c2');
    first.setDeleted('c3', true);
    first.rehome('c4', 'd2', '/elsewhere');
    first.flush();

    const second = make();
    expect(second.get('c1')?.activity).toBe('errored');
    expect(second.get('c2')).toBeUndefined();
    expect(second.get('c3')?.status).toBe('deleted');
    expect(second.get('c4')).toMatchObject({ daemonId: 'd2', folder: '/elsewhere' });
  });

  test('a restored chat its host does not report again is dropped when the host closes its list', () => {
    const first = make();
    first.observe(spawned('kept'));
    first.observe(spawned('gone'));
    first.observe(spawned('other-host', 'd2'));
    first.flush();

    const second = make();
    second.observe(spawned('kept')); // host d1 mentions it
    second.observe(foldersList('d1')); // and is done telling us what it has
    expect(second.get('kept')).toBeDefined();
    expect(second.get('gone')).toBeUndefined();
    // Another host's chat is untouched until that host reports.
    expect(second.get('other-host')).toBeDefined();
    second.observe(foldersList('d2'));
    expect(second.get('other-host')).toBeUndefined();
  });

  test('a chat confirmed by a chat.state alone also stays', () => {
    const first = make();
    first.observe(spawned('c1'));
    first.flush();
    const second = make();
    second.observe(state('c1', 'idle'));
    second.observe(foldersList('d1'));
    expect(second.get('c1')).toBeDefined();
  });

  test('a pruned chat stays gone after the next restart', () => {
    const first = make();
    first.observe(spawned('gone'));
    first.flush();
    const second = make();
    second.observe(foldersList('d1'));
    second.flush();
    expect(make().get('gone')).toBeUndefined();
  });

  test('starts empty, saying so, when the saved mirror is damaged', () => {
    writeFileSync(path, '{not json');
    const warnings: string[] = [];
    const r = new ChatRegistry({
      logger: { warn: (_o: unknown, msg?: string) => warnings.push(String(msg)) },
      persistPath: path,
    });
    expect(r.size()).toBe(0);
    expect(warnings.join(' ')).toContain('could not read the saved mirror');
  });

  test('without a path it stays in memory only', () => {
    const r = new ChatRegistry({ logger });
    r.observe(spawned('c1'));
    r.flush();
    expect(r.size()).toBe(1);
  });

  describe('knowing a chat has worked', () => {
    const at = (nowMs: number): ChatRegistry =>
      new ChatRegistry({ logger, persistPath: path, now: () => nowMs });

    test('a chat seen working has worked since before it, and not since after', () => {
      const r = at(5_000);
      r.observe(spawned('c1'));
      expect(r.hasWorkedSince('c1', 0)).toBe(false); // announced, not yet seen working
      r.observe(state('c1', 'running'));
      expect(r.hasWorkedSince('c1', 4_000)).toBe(true);
      expect(r.hasWorkedSince('c1', 6_000)).toBe(false);
    });

    test('is remembered across a restart', () => {
      const first = at(5_000);
      first.observe(spawned('c1'));
      first.observe(state('c1', 'awaiting-permission'));
      first.flush();
      expect(at(9_000).hasWorkedSince('c1', 4_000)).toBe(true);
    });

    test('a chat its host reports idle with a first message and its own clock well past the start has worked', () => {
      const r = at(1);
      r.observe(spawned('c1'));
      r.observe(state('c1', 'idle', { preview: 'first message', lastUpdated: 100_000 }));
      expect(r.hasWorkedSince('c1', 50_000)).toBe(true);
      expect(r.hasWorkedSince('c1', 95_000)).toBe(false); // only just after: not enough
    });

    test('a chat with no first message accepted is not known to have worked', () => {
      const r = at(1);
      r.observe(spawned('c1'));
      r.observe(state('c1', 'idle', { lastUpdated: 100_000 }));
      expect(r.hasWorkedSince('c1', 0)).toBe(false);
    });

    test('an unknown chat has not', () => {
      expect(at(1).hasWorkedSince('nope', 0)).toBe(false);
    });
  });

  describe('reading an odd saved file', () => {
    const read = (body: unknown): ChatRegistry => {
      writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body));
      return new ChatRegistry({ logger, persistPath: path });
    };

    test('a file with no chats and no record of work is an empty mirror', () => {
      const r = read({ version: 1 });
      expect(r.size()).toBe(0);
      expect(r.hasWorkedSince('c1', 0)).toBe(false);
    });

    test('skips an entry with no chat id, an empty one, or that is not an object', () => {
      const good = { chatId: 'c1', daemonId: 'd1', activity: 'idle', status: 'active' };
      const r = read({ version: 1, chats: [null, {}, { chatId: '' }, { chatId: 7 }, good] });
      expect(r.size()).toBe(1);
      expect(r.get('c1')).toBeDefined();
    });

    test('keeps a record of work only when it is a time', () => {
      const r = read({ version: 1, chats: [], worked: { a: 5_000, b: 'yesterday', c: null } });
      expect(r.hasWorkedSince('a', 4_000)).toBe(true);
      expect(r.hasWorkedSince('b', 0)).toBe(false);
      expect(r.hasWorkedSince('c', 0)).toBe(false);
    });
  });
});
