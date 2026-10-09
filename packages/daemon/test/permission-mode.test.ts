// Permission mode (spec/02 § Permission mode).
//
// Three properties are under test here that nothing else covers:
//   1. `auto` is what a host reports until a default is chosen. Nothing anywhere
//      may fall back to a mode that skips the classifier.
//   2. A chat is STAMPED with a mode when it is created and keeps it. Changing
//      the host default afterwards steers the chats created next and must never
//      reach back into one that already exists.
//   3. That mode is stored WITH THE CHAT, not in the host process, so a
//      restart does not disturb it.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';
import { chatStateFromMeta } from '../src/chatState.js';

const silent = pino({ level: 'silent' });

function setup(
  opts: {
    permissionModeDefault?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'auto';
  } = {},
) {
  const home = mkdtempSync(join(tmpdir(), 'patch-perm-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-perm-folder-')));
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
    ...(opts.permissionModeDefault !== undefined
      ? { permissionModeDefault: opts.permissionModeDefault }
      : {}),
  });
  return { daemon, sdk, events, home, folder, metaStore };
}

describe('permission mode: a chat is stamped at creation and keeps it', () => {
  it('a chat created on a host with no default is stamped auto', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    expect(daemon.chatPermissionMode(chatId)).toBe('auto');
  });

  it('the host default reports auto when nothing has been set', () => {
    const { daemon } = setup();
    expect(daemon.permissionModeDefault()).toBe('auto');
  });

  it('a chat takes the host default in force when it is created', async () => {
    const { daemon, folder } = setup({ permissionModeDefault: 'plan' });
    const chatId = await daemon.spawnChat({ folder });
    expect(daemon.chatPermissionMode(chatId)).toBe('plan');
  });

  it('a spawn naming a mode is stamped with that, not the host default', async () => {
    const { daemon, folder } = setup({ permissionModeDefault: 'plan' });
    const chatId = await daemon.spawnChat({ folder, permissionMode: 'bypassPermissions' });
    expect(daemon.chatPermissionMode(chatId)).toBe('bypassPermissions');
  });

  it('setting the chat replaces its mode', async () => {
    const { daemon, folder } = setup({ permissionModeDefault: 'plan' });
    const chatId = await daemon.spawnChat({ folder });
    daemon.setChatPermissionMode(chatId, 'bypassPermissions');
    expect(daemon.chatPermissionMode(chatId)).toBe('bypassPermissions');
  });

  it('changing the host default LATER leaves an existing chat where it was', async () => {
    const { daemon, folder, metaStore } = setup({ permissionModeDefault: 'auto' });
    const chatId = await daemon.spawnChat({ folder });
    expect(daemon.chatPermissionMode(chatId)).toBe('auto');

    daemon.setPermissionModeDefault('bypassPermissions');

    // The chat that already exists is untouched, on disk as well as in memory.
    expect(daemon.chatPermissionMode(chatId)).toBe('auto');
    expect(metaStore.read(chatId)?.permissionMode).toBe('auto');
    // ...and the NEXT chat takes the new default.
    const later = await daemon.spawnChat({ folder });
    expect(daemon.chatPermissionMode(later)).toBe('bypassPermissions');
  });

  it('changing the host default does not disturb a chat that set its own mode', async () => {
    const { daemon, folder } = setup({ permissionModeDefault: 'auto' });
    const chatId = await daemon.spawnChat({ folder });
    daemon.setChatPermissionMode(chatId, 'plan');
    daemon.setPermissionModeDefault('bypassPermissions');
    expect(daemon.chatPermissionMode(chatId)).toBe('plan');
  });

  it('a chat it does not know is refused rather than answered with a default', () => {
    const { daemon } = setup({ permissionModeDefault: 'plan' });
    expect(() => daemon.chatPermissionMode('nope')).toThrow(/nope/);
  });

  it('auto reaches the SDK as the permissionMode for a turn', async () => {
    const { daemon, sdk, folder } = setup();
    await daemon.spawnChat({ folder, prompt: 'go' });
    await new Promise((r) => setTimeout(r, 20));
    expect(sdk.lastOptions()?.permissionMode).toBe('auto');
  });

  it("a chat's own mode reaches the SDK for the next turn", async () => {
    const { daemon, sdk, folder } = setup();
    const chatId = await daemon.spawnChat({ folder, prompt: 'go' });
    await new Promise((r) => setTimeout(r, 20));
    daemon.setChatPermissionMode(chatId, 'plan');
    await daemon.sendInput({ chatId, message: 'again', localId: 'L1' });
    await new Promise((r) => setTimeout(r, 20));
    expect(sdk.lastOptions()?.permissionMode).toBe('plan');
  });

  it('a host default raised after the chat started does NOT reach the SDK', async () => {
    const { daemon, sdk, folder } = setup();
    const chatId = await daemon.spawnChat({ folder, prompt: 'go' });
    await new Promise((r) => setTimeout(r, 20));
    daemon.setPermissionModeDefault('bypassPermissions');
    await daemon.sendInput({ chatId, message: 'again', localId: 'L1' });
    await new Promise((r) => setTimeout(r, 20));
    expect(sdk.lastOptions()?.permissionMode).toBe('auto');
  });
});

describe("permission mode: a chat's mode survives a host restart", () => {
  it('spawnChat writes the stamped mode to the chat meta', async () => {
    const { daemon, folder, metaStore } = setup({ permissionModeDefault: 'acceptEdits' });
    const chatId = await daemon.spawnChat({ folder });
    expect(metaStore.read(chatId)?.permissionMode).toBe('acceptEdits');
  });

  it('setChatPermissionMode writes the new mode to the chat meta', async () => {
    const { daemon, folder, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder });
    daemon.setChatPermissionMode(chatId, 'bypassPermissions');
    expect(metaStore.read(chatId)?.permissionMode).toBe('bypassPermissions');
  });

  it('a restarted host still reports the persisted mode', async () => {
    const { daemon, folder, metaStore, home } = setup();
    const chatId = await daemon.spawnChat({ folder });
    daemon.setChatPermissionMode(chatId, 'bypassPermissions');

    // A second host over the SAME patch home is a restart.
    const restarted = new Daemon({
      daemonId: 'd1',
      metaStore: createMetaStore(home),
      sdkBackend: createMockSdkBackend(),
      oauthAccessToken: 'fake-token',
      emit: () => {},
      logger: silent,
      now: () => 1_700_000_000_000,
      generateChatId: () => 'unused',
    });
    restarted.hydrate();

    expect(restarted.chatPermissionMode(chatId)).toBe('bypassPermissions');
    expect(restarted.permissionOverrideCount()).toBe(1);
    expect(metaStore.read(chatId)?.permissionMode).toBe('bypassPermissions');
  });

  it('a restart under a NEW host default leaves the persisted mode alone', async () => {
    const { daemon, folder, metaStore, home } = setup({ permissionModeDefault: 'auto' });
    const chatId = await daemon.spawnChat({ folder });

    const restarted = new Daemon({
      daemonId: 'd1',
      metaStore: createMetaStore(home),
      sdkBackend: createMockSdkBackend(),
      oauthAccessToken: 'fake-token',
      emit: () => {},
      logger: silent,
      now: () => 1_700_000_000_000,
      generateChatId: () => 'unused',
      permissionModeDefault: 'bypassPermissions',
    });
    restarted.hydrate();

    expect(restarted.chatPermissionMode(chatId)).toBe('auto');
    expect(metaStore.read(chatId)?.permissionMode).toBe('auto');
  });

  it('a chat persisted with NO mode adopts the host default once, on disk', async () => {
    // Pre-existing data: chats written before a chat carried its own mode. They
    // adopt the default in force the first time a host loads them, and that
    // adoption is WRITTEN — a later change to the host default leaves them be.
    const { daemon, folder, metaStore, home } = setup();
    const chatId = await daemon.spawnChat({ folder });
    metaStore.update(chatId, (m) => {
      const next = { ...m };
      delete next.permissionMode;
      return next;
    });
    expect(metaStore.read(chatId)?.permissionMode).toBeUndefined();

    const restarted = new Daemon({
      daemonId: 'd1',
      metaStore: createMetaStore(home),
      sdkBackend: createMockSdkBackend(),
      oauthAccessToken: 'fake-token',
      emit: () => {},
      logger: silent,
      now: () => 1_700_000_000_000,
      generateChatId: () => 'unused',
      permissionModeDefault: 'acceptEdits',
    });
    restarted.hydrate();

    expect(restarted.chatPermissionMode(chatId)).toBe('acceptEdits');
    expect(metaStore.read(chatId)?.permissionMode).toBe('acceptEdits');

    restarted.setPermissionModeDefault('bypassPermissions');
    expect(restarted.chatPermissionMode(chatId)).toBe('acceptEdits');
  });

  it('a chat with no persisted mode hydrates with none, before the stamp runs', () => {
    const s = chatStateFromMeta({
      chatId: 'c1',
      folder: '/work',
      name: null,
      nextSeq: 0,
      createdAt: 1,
      updatedAt: 1,
    });
    expect(s.permissionMode).toBeUndefined();
  });

  it('a chat with a persisted mode hydrates carrying it', () => {
    const s = chatStateFromMeta({
      chatId: 'c1',
      folder: '/work',
      name: null,
      nextSeq: 0,
      createdAt: 1,
      updatedAt: 1,
      permissionMode: 'plan',
    });
    expect(s.permissionMode).toBe('plan');
  });
});

// ---------------------------------------------------------------------------
// The mode is resolved against the chat's MODEL before the turn runs
// (spec/02 § Permission mode).
//
// `auto` needs a model that supports it. Claude Code does not refuse the
// combination — it substitutes `default` and says nothing, so an unattended chat
// quietly starts asking a human to approve every tool call, in a chat nobody is
// watching. Patch resolves it up front instead, and SAYS SO: a degrade nobody is
// told about is the same bug it replaces.
// ---------------------------------------------------------------------------
describe('permission mode: degraded to fit the model, out loud', () => {
  const systemMessages = (events: WireEvent[]): string[] =>
    events
      .filter(
        (e): e is Extract<WireEvent, { type: 'chat.message' }> =>
          e.type === 'chat.message' && e.role === 'system',
      )
      .map((e) => e.content);

  it('runs `auto` on a model that cannot, as `default`, and says which', async () => {
    const { daemon, folder, events } = setup({ permissionModeDefault: 'auto' });
    const chatId = await daemon.spawnChat({ folder, model: 'claude-haiku-4-5-20251001' });
    await daemon.sendInput({ chatId, message: 'go' });
    const notice = systemMessages(events).find((c) => c.includes('Permission mode'));
    expect(notice).toBeDefined();
    expect(notice).toContain("'auto'");
    expect(notice).toContain("'default'");
    expect(notice).toContain('claude-haiku-4-5-20251001');
  });

  it('says it ONCE, not on every turn of a long chat', async () => {
    const { daemon, folder, events } = setup({ permissionModeDefault: 'auto' });
    const chatId = await daemon.spawnChat({ folder, model: 'claude-haiku-4-5-20251001' });
    await daemon.sendInput({ chatId, message: 'one' });
    await daemon.sendInput({ chatId, message: 'two' });
    await daemon.sendInput({ chatId, message: 'three' });
    expect(systemMessages(events).filter((c) => c.includes('Permission mode'))).toHaveLength(1);
  });

  it('says nothing when the model can honour the mode', async () => {
    const { daemon, folder, events } = setup({ permissionModeDefault: 'auto' });
    const chatId = await daemon.spawnChat({ folder, model: 'claude-opus-5' });
    await daemon.sendInput({ chatId, message: 'go' });
    expect(systemMessages(events).filter((c) => c.includes('Permission mode'))).toHaveLength(0);
  });

  it('leaves the chat CONFIGURED on the mode it was given — the degrade is per turn', async () => {
    // What the user chose is still what the chat says it is, so moving it to a
    // capable model starts honouring `auto` without them setting it again.
    const { daemon, folder } = setup({ permissionModeDefault: 'auto' });
    const chatId = await daemon.spawnChat({ folder, model: 'claude-haiku-4-5-20251001' });
    await daemon.sendInput({ chatId, message: 'go' });
    expect(daemon.chatPermissionMode(chatId)).toBe('auto');
  });
});
