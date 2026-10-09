// Scheduled special-thread session rotation (spec/06 § Session rotation).
// The judgement (the digest, the actual session swap) is the host's
// (`rotateThread` in chatRunner.ts); what's tested here is the deterministic
// half — when a rotation fires, which threads it skips, and that it fires at
// most once per thread per day.

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { SPECIAL_THREAD_IDS } from '@patch/wire';
import { ChatRegistry } from '../src/chat-registry.js';
import { ThreadRotator } from '../src/thread-rotation.js';
import { DEFAULT_SETTINGS, type AccountSettings } from '../src/settings.js';
import { SharedSettingsService } from '../src/shared-settings.js';

const logger = pino({ level: 'silent' });

function spawned(chatId: string): WireEvent {
  return {
    type: 'chat.spawned',
    chatId,
    daemonId: 'hetzner',
    folder: '/home/tom/.patch/threads/manager',
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
    folder: '/home/tom/.patch/threads/manager',
    lastUpdated: 0,
    seq: 2,
    ts: 0,
    ...over,
  } as WireEvent;
}

describe('ThreadRotator', () => {
  let chats: ChatRegistry;
  let rotated: string[];
  let settings: AccountSettings;
  let rotator: ThreadRotator;
  let clockDate: Date;

  beforeEach(() => {
    chats = new ChatRegistry({ logger });
    rotated = [];
    settings = { ...DEFAULT_SETTINGS, rotationTime: '02:00' };
    clockDate = new Date('2026-08-24T02:00:00');
    rotator = new ThreadRotator({
      chats,
      settings: () => settings,
      rotate: (chatId) => rotated.push(chatId),
      logger,
      clock: () => clockDate,
    });
  });

  function seed(chatId: string, over: Partial<Record<string, unknown>> = {}): void {
    chats.observe(spawned(chatId));
    chats.observe(state(chatId, over));
  }

  test('does nothing outside the configured minute', () => {
    seed(SPECIAL_THREAD_IDS.manager);
    clockDate = new Date('2026-08-24T02:01:00');
    expect(rotator.tick()).toBe(false);
    expect(rotated).toEqual([]);
  });

  test('rotates every registered special thread at the configured minute', () => {
    seed(SPECIAL_THREAD_IDS.manager);
    seed(SPECIAL_THREAD_IDS.speakers);
    expect(rotator.tick()).toBe(true);
    expect(rotated.sort()).toEqual(
      [SPECIAL_THREAD_IDS.manager, SPECIAL_THREAD_IDS.speakers].sort(),
    );
  });

  test('skips a thread that has not been registered yet', () => {
    // Nothing seeded at all — a fresh install whose host hasn't
    // bootstrapped the special threads.
    expect(rotator.tick()).toBe(false);
    expect(rotated).toEqual([]);
  });

  test('skips a disabled thread — nothing accumulating to rotate away from', () => {
    seed(SPECIAL_THREAD_IDS.manager, { disabled: true });
    expect(rotator.tick()).toBe(false);
    expect(rotated).toEqual([]);
  });

  test('skips a thread mid-turn, and does not retry it later the same day', () => {
    seed(SPECIAL_THREAD_IDS.manager, { activity: 'running' });
    expect(rotator.tick()).toBe(false);
    expect(rotated).toEqual([]);
    // Same minute, chat finishes its turn — still not retried today; the
    // day-key was already consumed at the first attempt.
    chats.observe(state(SPECIAL_THREAD_IDS.manager, { activity: 'idle' }));
    expect(rotator.tick()).toBe(false);
    expect(rotated).toEqual([]);
  });

  test('fires at most once per thread per day, even ticked repeatedly through the minute', () => {
    seed(SPECIAL_THREAD_IDS.manager);
    expect(rotator.tick()).toBe(true);
    expect(rotator.tick()).toBe(false);
    expect(rotator.tick()).toBe(false);
    expect(rotated).toEqual([SPECIAL_THREAD_IDS.manager]);
  });

  test('rotates again the next day at the same minute', () => {
    seed(SPECIAL_THREAD_IDS.manager);
    expect(rotator.tick()).toBe(true);
    clockDate = new Date('2026-08-25T02:00:00');
    expect(rotator.tick()).toBe(true);
    expect(rotated).toEqual([SPECIAL_THREAD_IDS.manager, SPECIAL_THREAD_IDS.manager]);
  });

  test('rotationEnabled: false suppresses every rotation', () => {
    seed(SPECIAL_THREAD_IDS.manager);
    settings = { ...settings, rotationEnabled: false };
    expect(rotator.tick()).toBe(false);
    expect(rotated).toEqual([]);
  });
});

// The toggle's whole chain on the server: the write the Settings page makes
// (`SharedSettingsService.update`), the file it persists, a server restart
// reading that file back, and the rotator reading the restarted service.
describe('ThreadRotator against the real settings store', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-rotation-settings-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const makeService = () =>
    new SharedSettingsService({
      dataDir: dir,
      sendToDaemon: () => {},
      onlineDaemonIds: () => [],
      broadcast: () => {},
      validateClaude: async () => ({ kind: 'valid' }),
      validateOpenAIKey: async () => ({ ok: true }),
      adoptTimeoutMs: 200,
    });

  function rotatorOver(service: SharedSettingsService, rotated: string[]): ThreadRotator {
    const chats = new ChatRegistry({ logger });
    chats.observe(spawned(SPECIAL_THREAD_IDS.manager));
    chats.observe(state(SPECIAL_THREAD_IDS.manager));
    return new ThreadRotator({
      chats,
      settings: () => service.current(),
      rotate: (chatId) => rotated.push(chatId),
      logger,
      clock: () => new Date('2026-10-07T02:00:00'),
    });
  }

  test('rotationEnabled: false survives a restart and still suppresses rotation', () => {
    makeService().update({ rotationEnabled: false });
    const rotated: string[] = [];
    expect(rotatorOver(makeService(), rotated).tick()).toBe(false);
    expect(rotated).toEqual([]);
  });

  test('turning it back on rotates at the scheduled minute', () => {
    const service = makeService();
    service.update({ rotationEnabled: false });
    service.update({ rotationEnabled: true });
    const rotated: string[] = [];
    expect(rotatorOver(makeService(), rotated).tick()).toBe(true);
    expect(rotated).toEqual([SPECIAL_THREAD_IDS.manager]);
  });
});
