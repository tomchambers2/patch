// Mid-chat model switching (spec/04 § Model).
//
// The properties under test are the ones a fallback would quietly break:
//   1. A switch takes effect on the NEXT turn, and leaves a running turn alone.
//   2. A model this host does not offer is REFUSED naming it, and the chat stays
//      on the model it was already running — never rounded, never dropped to the
//      host's last-used model.
//   3. The switch is persisted, so a host restart does not silently return the
//      chat to the model it spawned on.
//   4. The new model rides out on `chat.state`, which is how a second surface
//      holding the same chat finds out.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { ChatStateEvent, WireEvent } from '@patch/wire';
import { Daemon, UnknownModelError, NoModelCatalogueError } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';
import { chatStateFromMeta } from '../src/chatState.js';

const silent = pino({ level: 'silent' });

const CATALOGUE = ['claude-opus-4-1', 'claude-sonnet-4-6', 'claude-haiku-4-5'];

function setup(opts: { knownModelIds?: () => Promise<ReadonlySet<string>> } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'patch-model-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-model-folder-')));
  mkdirSync(folder, { recursive: true });
  const metaStore = createMetaStore(home);
  const events: WireEvent[] = [];
  const sdk = createMockSdkBackend();
  let id = 0;
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore,
    sdkBackend: sdk,
    oauthAccessToken: 'fake-token',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${++id}`,
    knownModelIds: opts.knownModelIds ?? (async () => new Set(CATALOGUE)),
  });
  return { daemon, sdk, events, home, folder, metaStore };
}

function states(events: WireEvent[]): ChatStateEvent[] {
  return events.filter((e): e is ChatStateEvent => e.type === 'chat.state');
}

describe('a chat model change takes effect on the next turn', () => {
  it('the next turn reaches the SDK on the newly chosen model', async () => {
    const { daemon, sdk, folder } = setup();
    const chatId = await daemon.spawnChat({ folder, model: 'claude-sonnet-4-6', prompt: 'go' });
    await new Promise((r) => setTimeout(r, 20));
    expect(sdk.lastOptions()?.model).toBe('claude-sonnet-4-6');

    await daemon.setChatModel(chatId, 'claude-opus-4-1');
    await daemon.sendInput({ chatId, message: 'again', localId: 'L1' });
    await new Promise((r) => setTimeout(r, 20));
    expect(sdk.lastOptions()?.model).toBe('claude-opus-4-1');
  });

  it('does not change the host last-used model, so later spawns are untouched', async () => {
    // A mid-chat switch is scoped to the chat it was made in. Repointing every
    // future spawn from it would be a change the user did not ask for and
    // cannot see (spec/04 § Model).
    const chosen: (string | undefined)[] = [];
    const home = mkdtempSync(join(tmpdir(), 'patch-model-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-model-folder-')));
    let id = 0;
    const daemon = new Daemon({
      daemonId: 'd1',
      metaStore: createMetaStore(home),
      sdkBackend: createMockSdkBackend(),
      oauthAccessToken: 'fake-token',
      emit: () => {},
      logger: silent,
      now: () => 1_700_000_000_000,
      generateChatId: () => `chat-${++id}`,
      knownModelIds: async () => new Set(CATALOGUE),
      onModelChosen: (m) => chosen.push(m),
    });
    const chatId = await daemon.spawnChat({ folder, model: 'claude-sonnet-4-6' });
    chosen.length = 0;
    await daemon.setChatModel(chatId, 'claude-opus-4-1');
    expect(chosen).toEqual([]);
  });
});

describe('a chat model change is refused rather than approximated', () => {
  it('rejects a model this host does not offer, naming it', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder, model: 'claude-sonnet-4-6' });
    await expect(daemon.setChatModel(chatId, 'gpt-9')).rejects.toBeInstanceOf(UnknownModelError);
    await expect(daemon.setChatModel(chatId, 'gpt-9')).rejects.toThrow(/gpt-9/);
  });

  it('leaves the chat on the model it was already running after a refusal', async () => {
    const { daemon, folder, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder, model: 'claude-sonnet-4-6' });
    await daemon.setChatModel(chatId, 'gpt-9').catch(() => {});
    expect(metaStore.read(chatId)?.model).toBe('claude-sonnet-4-6');
  });

  it('refuses when the catalogue cannot be read at all, carrying the reason', async () => {
    // NO FALLBACK: unable to check ⇒ unable to honour. Waving the change
    // through would run later turns on an unverified model.
    const { daemon, folder } = setup({
      knownModelIds: () => Promise.reject(new Error('anthropic said 401')),
    });
    const chatId = await daemon.spawnChat({ folder, model: 'claude-sonnet-4-6' });
    await expect(daemon.setChatModel(chatId, 'claude-opus-4-1')).rejects.toBeInstanceOf(
      NoModelCatalogueError,
    );
    await expect(daemon.setChatModel(chatId, 'claude-opus-4-1')).rejects.toThrow(
      /anthropic said 401/,
    );
  });

  it('rejects a model change for a chat this host does not have', async () => {
    const { daemon } = setup();
    await expect(daemon.setChatModel('nope', 'claude-opus-4-1')).rejects.toThrow(/nope/);
  });
});

describe('a chat model change survives a host restart', () => {
  it('writes the new model to the chat meta', async () => {
    const { daemon, folder, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder, model: 'claude-sonnet-4-6' });
    await daemon.setChatModel(chatId, 'claude-opus-4-1');
    expect(metaStore.read(chatId)?.model).toBe('claude-opus-4-1');
  });

  it('a restarted host runs the next turn on the changed model', async () => {
    const { daemon, folder, home } = setup();
    const chatId = await daemon.spawnChat({ folder, model: 'claude-sonnet-4-6' });
    await daemon.setChatModel(chatId, 'claude-opus-4-1');

    // A second host over the SAME patch home is a restart.
    const sdk = createMockSdkBackend();
    const restarted = new Daemon({
      daemonId: 'd1',
      metaStore: createMetaStore(home),
      sdkBackend: sdk,
      oauthAccessToken: 'fake-token',
      emit: () => {},
      logger: silent,
      now: () => 1_700_000_000_000,
      generateChatId: () => 'unused',
      knownModelIds: async () => new Set(CATALOGUE),
    });
    restarted.hydrate();
    await restarted.sendInput({ chatId, message: 'again', localId: 'L1' });
    await new Promise((r) => setTimeout(r, 20));
    expect(sdk.lastOptions()?.model).toBe('claude-opus-4-1');
  });

  it('a chat with a persisted model hydrates carrying it', () => {
    const s = chatStateFromMeta({
      chatId: 'c1',
      folder: '/work',
      name: null,
      nextSeq: 0,
      createdAt: 1,
      updatedAt: 1,
      model: 'claude-opus-4-1',
    });
    expect(s.model).toBe('claude-opus-4-1');
  });

  it('a chat with no persisted model hydrates with none, rather than a guess', () => {
    const s = chatStateFromMeta({
      chatId: 'c1',
      folder: '/work',
      name: null,
      nextSeq: 0,
      createdAt: 1,
      updatedAt: 1,
    });
    expect(s.model).toBeUndefined();
  });
});

describe('a chat model change reaches every surface holding the chat', () => {
  it('emits a chat.state carrying the new model', async () => {
    const { daemon, folder, events } = setup();
    const chatId = await daemon.spawnChat({ folder, model: 'claude-sonnet-4-6' });
    events.length = 0;
    await daemon.setChatModel(chatId, 'claude-opus-4-1');
    const emitted = states(events);
    expect(emitted.length).toBeGreaterThan(0);
    expect(emitted.at(-1)?.model).toBe('claude-opus-4-1');
  });

  it('carries the model on every chat.state, not only the one after a change', async () => {
    // A surface that opened the chat later (or reconnected) has to converge on
    // the model too, and it only ever sees ordinary state emits.
    const { daemon, folder, events } = setup();
    const chatId = await daemon.spawnChat({ folder, model: 'claude-sonnet-4-6' });
    events.length = 0;
    await daemon.setPinned(chatId, true);
    expect(states(events).at(-1)?.model).toBe('claude-sonnet-4-6');
  });

  it('omits the model for a chat that has none, rather than inventing one', async () => {
    const { daemon, folder, events } = setup();
    const chatId = await daemon.spawnChat({ folder });
    events.length = 0;
    await daemon.setPinned(chatId, true);
    expect(states(events).at(-1)?.model).toBeUndefined();
  });
});
