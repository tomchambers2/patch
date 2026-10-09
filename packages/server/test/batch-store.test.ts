// Batch store (spec/14 § Batch mode).

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { BatchStore } from '../src/batch/store.js';

const logger = pino({ level: 'silent' });

describe('BatchStore', () => {
  let dir: string;
  let now: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-batch-'));
    now = Date.parse('2026-10-02T10:00:00Z');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeStore(): BatchStore {
    let id = 0;
    return new BatchStore({
      dataDir: dir,
      logger,
      nowMs: () => now,
      idGenerator: () => `batch_${++id}`,
    });
  }

  test('starts empty, with no batch running', () => {
    const store = makeStore();
    expect(store.current()).toBeNull();
    expect(store.carryoverMembers()).toEqual([]);
  });

  test('start() creates a running batch with the chosen check-in', () => {
    const store = makeStore();
    const batch = store.start({ type: 'time', minutes: 20 });
    expect(batch).toEqual({
      id: 'batch_1',
      startedAt: now,
      checkIn: { type: 'time', minutes: 20 },
      checkInAt: now + 20 * 60_000,
      members: [],
      checkedIn: false,
      openedMemberIds: [],
    });
    expect(store.current()).toEqual(batch);
  });

  test('"when all done" caps the check-in deadline at 30 minutes', () => {
    const store = makeStore();
    const batch = store.start({ type: 'all-done' });
    expect(batch.checkInAt).toBe(now + 30 * 60_000);
  });

  test('start() is a no-op while a batch is already running', () => {
    const store = makeStore();
    const first = store.start({ type: 'time', minutes: 15 });
    store.ensureMember('c1');
    const second = store.start({ type: 'time', minutes: 30 });
    expect(second).toEqual(store.current());
    expect(second.checkIn).toEqual({ type: 'time', minutes: 15 });
    expect(second.members).toEqual(['c1']);
    expect(first.id).toBe(second.id);
  });

  test('ensureMember adds a chat once, in join order, only while running', () => {
    const store = makeStore();
    store.ensureMember('c1'); // no batch running — no-op
    expect(store.current()).toBeNull();
    store.start({ type: 'time', minutes: 20 });
    store.ensureMember('c1');
    store.ensureMember('c2');
    store.ensureMember('c1'); // already a member — no duplicate
    expect(store.current()?.members).toEqual(['c1', 'c2']);
  });

  test('removeMember drops a chat and its opened flag', () => {
    const store = makeStore();
    store.start({ type: 'time', minutes: 20 });
    store.ensureMember('c1');
    store.ensureMember('c2');
    store.checkIn();
    store.markOpened('c1');
    store.removeMember('c1');
    expect(store.current()?.members).toEqual(['c2']);
    expect(store.current()?.openedMemberIds).toEqual([]);
  });

  test('isSuppressedMember is true only for a member of the running batch', () => {
    const store = makeStore();
    expect(store.isSuppressedMember('c1')).toBe(false);
    store.start({ type: 'time', minutes: 20 });
    store.ensureMember('c1');
    expect(store.isSuppressedMember('c1')).toBe(true);
    expect(store.isSuppressedMember('c2')).toBe(false);
    store.checkIn();
    // Suppression lasts through check-in, until the batch actually ends.
    expect(store.isSuppressedMember('c1')).toBe(true);
  });

  test('checkIn() flips the flag once and is idempotent', () => {
    const store = makeStore();
    store.start({ type: 'time', minutes: 20 });
    store.checkIn();
    const checkedIn = store.current();
    store.checkIn();
    expect(store.current()).toEqual(checkedIn);
    expect(store.current()?.checkedIn).toBe(true);
  });

  test('end() clears the batch and rolls not-ready members into carryover', () => {
    const store = makeStore();
    store.start({ type: 'time', minutes: 20 });
    store.ensureMember('done1');
    store.ensureMember('running1');
    const isReady = (id: string): boolean => id === 'done1';
    store.end(isReady);
    expect(store.current()).toBeNull();
    expect(store.carryoverMembers()).toEqual(['running1']);
  });

  test('a batch started after one ended is pre-populated with the carryover', () => {
    const store = makeStore();
    store.start({ type: 'time', minutes: 20 });
    store.ensureMember('done1');
    store.ensureMember('running1');
    store.end((id) => id === 'done1');
    const next = store.start({ type: 'time', minutes: 15 });
    expect(next.members).toEqual(['running1']);
    expect(store.carryoverMembers()).toEqual([]);
  });

  test('persists across instances', () => {
    const store = makeStore();
    store.start({ type: 'time', minutes: 20 });
    store.ensureMember('c1');
    const reloaded = new BatchStore({ dataDir: dir, logger, nowMs: () => now });
    expect(reloaded.current()).toEqual(store.current());
  });

  test('NO FALLBACK: a corrupt file resets to no batch running', () => {
    writeFileSync(join(dir, 'batch.json'), '{ not json', 'utf8');
    const store = new BatchStore({ dataDir: dir, logger, nowMs: () => now });
    expect(store.current()).toBeNull();
    expect(store.carryoverMembers()).toEqual([]);
  });
});
