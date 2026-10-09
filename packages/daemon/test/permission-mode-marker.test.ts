// The transcript record of a mid-conversation permission-mode change
// (spec/02 § Permission mode).
//
// Claude Code's own transcript knows nothing about a mode change, so the two
// properties that matter here are not the emit — they are that the record is
// written where it happened, and that it is still there after the process that
// emitted it has gone.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { ChatMessageEvent, WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';
import { permissionModeChangeLine } from '../src/permissionMode.js';

const silent = pino({ level: 'silent' });

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'patch-perm-mark-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-perm-mark-folder-')));
  mkdirSync(folder, { recursive: true });
  const metaStore = createMetaStore(home);
  const events: WireEvent[] = [];
  let id = 0;
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore,
    sdkBackend: createMockSdkBackend(),
    oauthAccessToken: 'fake-token',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${++id}`,
  });
  return { daemon, events, home, folder, metaStore };
}

function restart(home: string): Daemon {
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
  return restarted;
}

function markers(events: WireEvent[]): ChatMessageEvent[] {
  return events.filter(
    (e): e is ChatMessageEvent =>
      e.type === 'chat.message' && (e as ChatMessageEvent).permissionModeChange !== undefined,
  );
}

describe('a mid-conversation permission-mode change is recorded in the transcript', () => {
  it('emits one system message naming the mode the chat moved to', async () => {
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    events.length = 0;

    daemon.setChatPermissionMode(chatId, 'acceptEdits');

    const marks = markers(events);
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({
      chatId,
      role: 'system',
      content: 'Permission mode → acceptEdits',
      permissionModeChange: 'acceptEdits',
    });
    expect(marks[0]?.seq).toBeGreaterThanOrEqual(0);
  });

  it('names the mode with the agent’s own word for it, not a friendlier one', () => {
    expect(permissionModeChangeLine('bypassPermissions')).toBe(
      'Permission mode → bypassPermissions',
    );
  });

  it('re-picking the mode the chat is already on records nothing', async () => {
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    // The chat is stamped `auto` at creation, so this is not a change.
    events.length = 0;
    daemon.setChatPermissionMode(chatId, 'auto');
    expect(markers(events)).toHaveLength(0);
  });

  it('records each change of a run of them', async () => {
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    events.length = 0;
    daemon.setChatPermissionMode(chatId, 'plan');
    daemon.setChatPermissionMode(chatId, 'plan');
    daemon.setChatPermissionMode(chatId, 'acceptEdits');
    expect(markers(events).map((m) => m.permissionModeChange)).toEqual(['plan', 'acceptEdits']);
  });
});

describe('the record survives the host that wrote it', () => {
  it('is persisted to the chat meta with the seq it was emitted under', async () => {
    const { daemon, events, folder, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder });
    events.length = 0;
    daemon.setChatPermissionMode(chatId, 'plan');

    const seq = markers(events)[0]?.seq;
    expect(metaStore.read(chatId)?.permissionModeMarks).toEqual([
      { seq, mode: 'plan', at: 1_700_000_000_000 },
    ]);
  });

  it('replays after a restart, when nothing is left in memory to replay it from', async () => {
    const { daemon, folder, home } = setup();
    const chatId = await daemon.spawnChat({ folder });
    daemon.setChatPermissionMode(chatId, 'bypassPermissions');

    const replayed: WireEvent[] = [];
    restart(home).replayChat(chatId, -1, (e) => replayed.push(e));

    expect(markers(replayed).map((m) => m.permissionModeChange)).toEqual(['bypassPermissions']);
  });

  it('replays exactly once while the live host still holds it in memory', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    daemon.setChatPermissionMode(chatId, 'plan');

    const replayed: WireEvent[] = [];
    daemon.replayChat(chatId, -1, (e) => replayed.push(e));

    expect(markers(replayed)).toHaveLength(1);
  });

  it('a surface replaying from a later cursor is not sent a record it already has', async () => {
    const { daemon, events, folder, home } = setup();
    const chatId = await daemon.spawnChat({ folder });
    events.length = 0;
    daemon.setChatPermissionMode(chatId, 'plan');
    const seq = markers(events)[0]?.seq as number;

    const replayed: WireEvent[] = [];
    restart(home).replayChat(chatId, seq, (e) => replayed.push(e));

    expect(markers(replayed)).toHaveLength(0);
  });

  it('replays in the place it happened, not at the end of the transcript', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder, prompt: 'first' });
    await new Promise((r) => setTimeout(r, 30));
    daemon.setChatPermissionMode(chatId, 'plan');
    await daemon.sendInput({ chatId, message: 'second', localId: 'L1' });
    await new Promise((r) => setTimeout(r, 30));

    const replayed: WireEvent[] = [];
    daemon.replayChat(chatId, -1, (e) => replayed.push(e));

    const shape = replayed
      .filter((e): e is ChatMessageEvent => e.type === 'chat.message')
      .map((e) => (e.permissionModeChange !== undefined ? 'MARK' : `${e.role}:${e.content}`));
    const markAt = shape.indexOf('MARK');
    expect(markAt).toBeGreaterThan(shape.indexOf('user:first'));
    expect(markAt).toBeLessThan(shape.indexOf('user:second'));
  });
});
