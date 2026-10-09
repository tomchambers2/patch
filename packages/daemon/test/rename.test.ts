// spec/04 § Name — renaming a chat. The host owns per-chat state, so a rename
// is a persisted meta field that round-trips over `chat.state` (mirrors setGoal /
// setPinned). These tests pin the host half: setName persists to meta.json,
// emits chat.state carrying the name, clears with null, refuses special threads,
// and — the load-bearing one — stops the AI summariser from overwriting a name a
// user chose before the first turn settled.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { SPECIAL_THREAD_IDS } from '@patch/wire';
import { ChatNotFoundError, Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';
import { createHistoryReader } from '../src/history.js';

const silent = pino({ level: 'silent' });

function setup(
  opts: {
    generateTitle?: (input: {
      chatId: string;
      firstUserMessage: string;
      folder: string;
    }) => Promise<string | null>;
  } = {},
) {
  const home = mkdtempSync(join(tmpdir(), 'patch-rename-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-rename-folder-')));
  mkdirSync(folder, { recursive: true });
  const metaStore = createMetaStore(home);
  const events: WireEvent[] = [];
  const sdk = createMockSdkBackend();
  let id = 0;
  const claudeRoot = mkdtempSync(join(tmpdir(), 'patch-rename-claude-'));
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore,
    sdkBackend: sdk,
    oauthAccessToken: 'fake-token',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${++id}`,
    historyReader: createHistoryReader({ claudeProjectsRoot: claudeRoot }),
    ...(opts.generateTitle ? { generateTitle: opts.generateTitle } : {}),
  });
  return { daemon, events, folder, metaStore, sdk };
}

describe('Host setName (spec/04 § Name — rename)', () => {
  it('persists the name to meta.json and emits chat.state carrying it', async () => {
    const { daemon, folder, events, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder });
    events.length = 0;

    await daemon.setName(chatId, 'Bed Planner Rework');

    const stateEv = events.find((e) => e.type === 'chat.state');
    expect(stateEv).toBeDefined();
    expect(stateEv && 'name' in stateEv && stateEv.name).toBe('Bed Planner Rework');
    expect(metaStore.read(chatId)?.name).toBe('Bed Planner Rework');
  });

  it('clears the name when set to null (surface falls back to the folder basename)', async () => {
    const { daemon, folder, events, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.setName(chatId, 'Temporary Label');
    events.length = 0;

    await daemon.setName(chatId, null);

    const stateEv = events.find((e) => e.type === 'chat.state');
    expect(stateEv && 'name' in stateEv && stateEv.name).toBe(null);
    expect(metaStore.read(chatId)?.name ?? null).toBe(null);
  });

  it('trims surrounding whitespace, and treats an all-whitespace name as a clear', async () => {
    const { daemon, folder, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder });

    await daemon.setName(chatId, '  Spaced Out  ');
    expect(metaStore.read(chatId)?.name).toBe('Spaced Out');

    await daemon.setName(chatId, '   ');
    expect(metaStore.read(chatId)?.name ?? null).toBe(null);
  });

  it('survives a fresh state hydrate from disk (persisted, not in-memory only)', async () => {
    const { daemon, folder, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.setName(chatId, 'Persisted Name');

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
        claudeProjectsRoot: mkdtempSync(join(tmpdir(), 'patch-rename-claude2-')),
      }),
    });
    await daemon2.resumeChat(chatId);
    const stateEv = events.find((e) => e.type === 'chat.state');
    expect(stateEv && 'name' in stateEv && stateEv.name).toBe('Persisted Name');
  });

  it('throws ChatNotFoundError for an unknown chat', async () => {
    const { daemon } = setup();
    await expect(daemon.setName('nope', 'x')).rejects.toThrow(ChatNotFoundError);
  });

  it('refuses to rename a special thread (its name is fixed)', async () => {
    const { daemon, folder } = setup();
    await daemon.spawnChat({ folder, chatId: SPECIAL_THREAD_IDS.manager });
    await expect(daemon.setName(SPECIAL_THREAD_IDS.manager, 'Not Manager')).rejects.toThrow(
      /special thread/,
    );
  });

  it('a rename made before the first turn stops the AI summariser overwriting it', async () => {
    let generated = 0;
    const { daemon, folder, sdk, metaStore } = setup({
      generateTitle: async () => {
        generated += 1;
        return 'AI Chosen Title';
      },
    });
    const chatId = await daemon.spawnChat({ folder });

    await daemon.setName(chatId, 'My Own Name');
    sdk.enqueue([{ type: 'assistant', content: 'hi', sessionId: 's1' }]);
    await daemon.sendInput({ chatId, message: 'go', localId: 'L1' });
    await new Promise((r) => setTimeout(r, 30));

    expect(generated).toBe(0);
    expect(daemon.chatState.get(chatId)?.name).toBe('My Own Name');
    expect(metaStore.read(chatId)?.name).toBe('My Own Name');
  });
});
