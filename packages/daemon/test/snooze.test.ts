// Snooze (spec/04-chats-and-folders.md § Snooze) — patch/todo.md: "ability to
// snooze a chat for 2, 5, 30, 1 hour, 1 day, next week or custom amount of
// time, like in gmail".
//
// A snooze is an absolute `snoozedUntil` timestamp on the chat, persisted in
// meta.json and orthogonal to `status`: the chat stays `active` and keeps
// running, it just leaves the active list until its wake time, then comes back
// on its own (the host arms a timer; timers are re-armed on hydrate so a
// restart mid-snooze still wakes the chat).

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { ChatNotFoundError, Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';
import { createHistoryReader } from '../src/history.js';

const silent = pino({ level: 'silent' });
const T0 = 1_700_000_000_000;

function setup(opts: { now?: () => number; home?: string } = {}) {
  const home = opts.home ?? mkdtempSync(join(tmpdir(), 'patch-snooze-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-snooze-folder-')));
  mkdirSync(folder, { recursive: true });
  const metaStore = createMetaStore(home);
  const events: WireEvent[] = [];
  let id = 0;
  const claudeRoot = mkdtempSync(join(tmpdir(), 'patch-snooze-claude-'));
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore,
    sdkBackend: createMockSdkBackend(),
    oauthAccessToken: 'fake-token',
    emit: (e) => events.push(e),
    logger: silent,
    now: opts.now ?? (() => T0),
    generateChatId: () => `chat-${++id}`,
    historyReader: createHistoryReader({ claudeProjectsRoot: claudeRoot }),
  });
  return { daemon, events, home, folder, metaStore };
}

function snoozedUntilOf(events: WireEvent[]): number | null | undefined {
  const ev = [...events].reverse().find((e) => e.type === 'chat.state');
  return ev && 'snoozedUntil' in ev ? (ev.snoozedUntil as number | null) : undefined;
}

describe('Host snooze (spec/04 § Snooze)', () => {
  it('setSnoozed persists snoozedUntil to meta.json and emits it on chat.state', async () => {
    const { daemon, folder, events, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder });
    expect(metaStore.read(chatId)?.snoozedUntil ?? null).toBe(null);
    events.length = 0;
    const until = T0 + 60_000;
    await daemon.setSnoozed(chatId, until);
    expect(snoozedUntilOf(events)).toBe(until);
    expect(metaStore.read(chatId)?.snoozedUntil).toBe(until);
    // Snooze is NOT archive/delete — the chat is still active.
    expect(daemon.chatState.get(chatId)?.status).toBe('active');
    daemon.shutdown();
  });

  it('a snoozed chat leaves the default list and appears in the snoozed-only list', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.setSnoozed(chatId, T0 + 60_000);
    expect(daemon.listWithFilter().some((c) => c.chatId === chatId)).toBe(false);
    expect(daemon.listWithFilter({ snoozed: 'only' }).some((c) => c.chatId === chatId)).toBe(true);
    expect(daemon.listWithFilter({ snoozed: 'include' }).some((c) => c.chatId === chatId)).toBe(
      true,
    );
    daemon.shutdown();
  });

  it('unsnooze (null) returns the chat to the active list immediately', async () => {
    const { daemon, folder, events, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.setSnoozed(chatId, T0 + 60_000);
    events.length = 0;
    await daemon.setSnoozed(chatId, null);
    expect(snoozedUntilOf(events)).toBe(null);
    expect(metaStore.read(chatId)?.snoozedUntil).toBe(null);
    expect(daemon.listWithFilter().some((c) => c.chatId === chatId)).toBe(true);
    expect(daemon.listWithFilter({ snoozed: 'only' }).some((c) => c.chatId === chatId)).toBe(false);
    daemon.shutdown();
  });

  it('the armed timer clears snoozedUntil and re-emits chat.state when it fires', async () => {
    vi.useFakeTimers();
    try {
      let clock = T0;
      const { daemon, folder, events, metaStore } = setup({ now: () => clock });
      const chatId = await daemon.spawnChat({ folder });
      await daemon.setSnoozed(chatId, T0 + 60_000);
      events.length = 0;
      clock = T0 + 60_000;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(snoozedUntilOf(events)).toBe(null);
      expect(metaStore.read(chatId)?.snoozedUntil).toBe(null);
      expect(daemon.listWithFilter().some((c) => c.chatId === chatId)).toBe(true);
      daemon.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('waking does not disturb lastUpdated (the chat returns exactly as it left)', async () => {
    vi.useFakeTimers();
    try {
      let clock = T0;
      const { daemon, folder } = setup({ now: () => clock });
      const chatId = await daemon.spawnChat({ folder });
      await daemon.setSnoozed(chatId, T0 + 60_000);
      const before = daemon.chatState.get(chatId)!.lastUpdated;
      clock = T0 + 60_000;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(daemon.chatState.get(chatId)?.lastUpdated).toBe(before);
      daemon.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a snoozedUntil in the past (NO FALLBACK to "now")', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await expect(daemon.setSnoozed(chatId, T0 - 1)).rejects.toThrow(/past/i);
    daemon.shutdown();
  });

  it('rejects snoozing a special thread', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder, chatId: 'thread_manager' });
    await expect(daemon.setSnoozed(chatId, T0 + 60_000)).rejects.toThrow(/special/i);
    daemon.shutdown();
  });

  it('setSnoozed on an unknown chat → ChatNotFoundError', async () => {
    const { daemon } = setup();
    await expect(daemon.setSnoozed('nope', T0 + 1000)).rejects.toThrow(ChatNotFoundError);
    daemon.shutdown();
  });

  it('hydrate re-arms a future snooze and clears one that lapsed while down', async () => {
    vi.useFakeTimers();
    try {
      let clock = T0;
      const first = setup({ now: () => clock });
      const lapsed = await first.daemon.spawnChat({ folder: first.folder });
      const future = await first.daemon.spawnChat({ folder: first.folder });
      await first.daemon.setSnoozed(lapsed, T0 + 10_000);
      await first.daemon.setSnoozed(future, T0 + 600_000);
      first.daemon.shutdown();

      // Restart: the clock has moved past the first snooze but not the second.
      clock = T0 + 60_000;
      const second = setup({ now: () => clock, home: first.home });
      second.daemon.hydrate();
      expect(second.daemon.chatState.get(lapsed)?.snoozedUntil).toBe(null);
      expect(second.metaStore.read(lapsed)?.snoozedUntil).toBe(null);
      expect(second.daemon.listWithFilter().some((c) => c.chatId === lapsed)).toBe(true);
      // The future one is still snoozed, and its timer was re-armed.
      expect(second.daemon.listWithFilter().some((c) => c.chatId === future)).toBe(false);
      second.events.length = 0;
      clock = T0 + 600_000;
      await vi.advanceTimersByTimeAsync(600_000);
      expect(second.metaStore.read(future)?.snoozedUntil).toBe(null);
      expect(second.daemon.listWithFilter().some((c) => c.chatId === future)).toBe(true);
      second.daemon.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });
});
