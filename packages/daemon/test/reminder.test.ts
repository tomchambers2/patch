// patch/todo.md — Reminders: a per-chat reminder (to do / not do something),
// set from the composer and shown at the top of the chat as a banner. The host
// owns per-chat state, so a reminder is a persisted meta field that round-trips
// over `chat.state` (mirrors setGoal / setPinned / setArchived). These tests pin
// the host half: setReminder persists to meta.json, emits chat.state carrying
// the reminder, clears with null, survives a restart, and rejects unknown chats.

import { describe, it, expect } from 'vitest';
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

function setup(opts: { now?: () => number } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'patch-reminder-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-reminder-folder-')));
  mkdirSync(folder, { recursive: true });
  const metaStore = createMetaStore(home);
  const events: WireEvent[] = [];
  const sdk = createMockSdkBackend();
  let id = 0;
  const claudeRoot = mkdtempSync(join(tmpdir(), 'patch-reminder-claude-'));
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore,
    sdkBackend: sdk,
    oauthAccessToken: 'fake-token',
    emit: (e) => events.push(e),
    logger: silent,
    now: opts.now ?? (() => 1_700_000_000_000),
    generateChatId: () => `chat-${++id}`,
    historyReader: createHistoryReader({ claudeProjectsRoot: claudeRoot }),
  });
  return { daemon, events, folder, metaStore };
}

describe('Host setReminder (patch/todo.md — Reminders)', () => {
  it('persists the reminder to meta.json and emits chat.state carrying it', async () => {
    const { daemon, folder, events, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder });
    events.length = 0;

    await daemon.setReminder(chatId, 'Do not touch the prod database');

    const stateEv = events.find((e) => e.type === 'chat.state');
    expect(stateEv).toBeDefined();
    expect(stateEv && 'reminder' in stateEv && stateEv.reminder).toBe(
      'Do not touch the prod database',
    );
    expect(metaStore.read(chatId)?.reminder).toBe('Do not touch the prod database');
  });

  it('clears the reminder when set to null', async () => {
    const { daemon, folder, events, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.setReminder(chatId, 'do the thing');
    events.length = 0;

    await daemon.setReminder(chatId, null);

    const stateEv = events.find((e) => e.type === 'chat.state');
    expect(stateEv && 'reminder' in stateEv && stateEv.reminder).toBe(null);
    expect(metaStore.read(chatId)?.reminder ?? null).toBe(null);
  });

  it('survives a fresh state hydrate from disk (persisted, not in-memory only)', async () => {
    const { daemon, folder, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.setReminder(chatId, 'persisted reminder');

    const events: WireEvent[] = [];
    const daemon2 = new Daemon({
      daemonId: 'd1',
      metaStore,
      sdkBackend: createMockSdkBackend(),
      oauthAccessToken: 'fake-token',
      emit: (e) => events.push(e),
      logger: silent,
      now: () => 1_700_000_000_000,
      historyReader: createHistoryReader({
        claudeProjectsRoot: mkdtempSync(join(tmpdir(), 'patch-reminder-claude2-')),
      }),
    });
    await daemon2.resumeChat(chatId);
    const stateEv = events.find((e) => e.type === 'chat.state');
    expect(stateEv && 'reminder' in stateEv && stateEv.reminder).toBe('persisted reminder');
  });

  it('throws ChatNotFoundError for an unknown chat', async () => {
    const { daemon } = setup();
    await expect(daemon.setReminder('nope', 'x')).rejects.toThrow(ChatNotFoundError);
  });
});
