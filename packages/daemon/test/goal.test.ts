// patch/todo.md — `/goal` feature: a per-chat goal, set from the composer and
// shown at the top of the chat. The host owns per-chat state, so a goal is a
// persisted meta field that round-trips over `chat.state` (mirrors setPinned /
// setArchived). These tests pin the host half: setGoal persists to meta.json,
// emits chat.state carrying the goal, clears with null, and rejects unknown chats.

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
  const home = mkdtempSync(join(tmpdir(), 'patch-goal-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-goal-folder-')));
  mkdirSync(folder, { recursive: true });
  const metaStore = createMetaStore(home);
  const events: WireEvent[] = [];
  const sdk = createMockSdkBackend();
  let id = 0;
  const claudeRoot = mkdtempSync(join(tmpdir(), 'patch-goal-claude-'));
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

describe('Host setGoal (patch/todo.md — /goal)', () => {
  it('persists the goal to meta.json and emits chat.state carrying it', async () => {
    const { daemon, folder, events, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder });
    events.length = 0;

    await daemon.setGoal(chatId, 'Ship the release by Friday');

    const stateEv = events.find((e) => e.type === 'chat.state');
    expect(stateEv).toBeDefined();
    expect(stateEv && 'goal' in stateEv && stateEv.goal).toBe('Ship the release by Friday');
    expect(metaStore.read(chatId)?.goal).toBe('Ship the release by Friday');
  });

  it('clears the goal when set to null', async () => {
    const { daemon, folder, events, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.setGoal(chatId, 'do the thing');
    events.length = 0;

    await daemon.setGoal(chatId, null);

    const stateEv = events.find((e) => e.type === 'chat.state');
    expect(stateEv && 'goal' in stateEv && stateEv.goal).toBe(null);
    expect(metaStore.read(chatId)?.goal ?? null).toBe(null);
  });

  it('survives a fresh state hydrate from disk (persisted, not in-memory only)', async () => {
    const { daemon, folder, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.setGoal(chatId, 'persisted goal');

    // A brand-new Host reading the same meta store hydrates the goal.
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
        claudeProjectsRoot: mkdtempSync(join(tmpdir(), 'patch-goal-claude2-')),
      }),
    });
    await daemon2.resumeChat(chatId);
    const stateEv = events.find((e) => e.type === 'chat.state');
    expect(stateEv && 'goal' in stateEv && stateEv.goal).toBe('persisted goal');
  });

  it('throws ChatNotFoundError for an unknown chat', async () => {
    const { daemon } = setup();
    await expect(daemon.setGoal('nope', 'x')).rejects.toThrow(ChatNotFoundError);
  });
});
