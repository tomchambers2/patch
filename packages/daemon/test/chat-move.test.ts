// spec/04 § Moving a chat to another host — the host half, end to end
// between two real `Daemon`s with their own homes, folders and Claude project
// roots: export on one, import on the other, retire on the first.

import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { SPECIAL_THREAD_IDS, type WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';
import { createHistoryReader } from '../src/history.js';
import { ChatMoveError } from '../src/chatMove.js';

const silent = pino({ level: 'silent' });
const settle = () => new Promise((r) => setTimeout(r, 30));

function host(daemonId: string) {
  const home = mkdtempSync(join(tmpdir(), `patch-move-${daemonId}-`));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), `patch-move-${daemonId}-folder-`)));
  const claudeRoot = mkdtempSync(join(tmpdir(), `patch-move-${daemonId}-claude-`));
  const metaStore = createMetaStore(home);
  const events: WireEvent[] = [];
  const sdk = createMockSdkBackend();
  let id = 0;
  const daemon = new Daemon({
    daemonId,
    metaStore,
    sdkBackend: sdk,
    oauthAccessToken: 'tok',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${daemonId}-${++id}`,
    claudeProjectsRoot: claudeRoot,
    historyReader: createHistoryReader({ claudeProjectsRoot: claudeRoot }),
  });
  return { daemon, events, sdk, metaStore, folder, home };
}

async function chatWithOneTurn(h: ReturnType<typeof host>): Promise<string> {
  h.sdk.enqueue([
    { type: 'result', sessionId: 'sess-1' },
    { type: 'assistant', content: 'the plan is ready', sessionId: 'sess-1' },
  ]);
  const chatId = await h.daemon.spawnChat({ folder: h.folder, prompt: 'make a plan' });
  await settle();
  return chatId;
}

function texts(d: Daemon, chatId: string): string[] {
  return d
    .readHistory({ chatId })
    .events.filter((e) => e.type === 'chat.message')
    .map((e) => (e as { content: string }).content);
}

describe('moving a chat between hosts', () => {
  it('arrives with its history and folder, announces itself, and resumes its session', async () => {
    const mac = host('mac');
    const box = host('box');
    const chatId = await chatWithOneTurn(mac);
    const before = texts(mac.daemon, chatId);
    expect(before).toEqual(['make a plan', 'the plan is ready']);

    const bundle = mac.daemon.exportChatForMove(chatId);
    expect(bundle.sourceFolder).toBe(mac.folder);
    box.events.length = 0;
    box.daemon.importMovedChat(bundle, box.folder);

    const spawned = box.events.find((e) => e.type === 'chat.spawned');
    expect(spawned).toMatchObject({ chatId, daemonId: 'box', folder: box.folder });
    expect(box.events.some((e) => e.type === 'chat.state' && e.chatId === chatId)).toBe(true);
    expect(box.daemon.chatState.get(chatId)?.folder).toBe(box.folder);
    expect(texts(box.daemon, chatId)).toEqual(before);

    mac.daemon.retireMovedChat(chatId);
    expect(mac.daemon.chatState.has(chatId)).toBe(false);
    expect(existsSync(join(mac.home, 'chats', chatId))).toBe(false);
    expect(readdirSync(join(mac.home, 'moved'))).toEqual([`${chatId}-1700000000000`]);

    box.sdk.enqueue([{ type: 'assistant', content: 'carrying on', sessionId: 'sess-1' }]);
    await box.daemon.sendInput({ chatId, message: 'carry on', localId: 'L-after' });
    expect(box.sdk.lastOptions()?.resumeSessionId).toBe('sess-1');
    expect(box.sdk.lastOptions()?.cwd).toBe(box.folder);
    expect(texts(box.daemon, chatId)).toEqual([...before, 'carry on', 'carrying on']);
  });

  it('refuses new turns on the old host between export and retire', async () => {
    const mac = host('mac');
    const chatId = await chatWithOneTurn(mac);
    mac.daemon.exportChatForMove(chatId);
    await expect(
      mac.daemon.sendInput({ chatId, message: 'too late', localId: 'L-x' }),
    ).rejects.toThrow(/moving to another host/);
  });

  it('release lets a chat carry on where it was after a failed move', async () => {
    const mac = host('mac');
    const chatId = await chatWithOneTurn(mac);
    mac.daemon.exportChatForMove(chatId);
    mac.daemon.releaseMovedChat(chatId);
    mac.sdk.enqueue([{ type: 'assistant', content: 'still here', sessionId: 'sess-1' }]);
    await mac.daemon.sendInput({ chatId, message: 'hello?', localId: 'L-y' });
    expect(texts(mac.daemon, chatId).at(-1)).toBe('still here');
  });

  it('will not move a chat that is mid-turn', async () => {
    const mac = host('mac');
    const chatId = await chatWithOneTurn(mac);
    mac.daemon.chatState.setActivity(chatId, 'running');
    expect(() => mac.daemon.exportChatForMove(chatId)).toThrow(
      expect.objectContaining({ code: 'busy' }) as ChatMoveError,
    );
  });

  it('will not move a special thread', () => {
    const mac = host('mac');
    const manager = SPECIAL_THREAD_IDS.manager;
    mac.metaStore.write({
      chatId: manager,
      folder: mac.folder,
      name: null,
      nextSeq: 0,
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
    });
    mac.daemon.hydrate();
    expect(() => mac.daemon.exportChatForMove(manager)).toThrow(
      expect.objectContaining({ code: 'unsupported' }) as ChatMoveError,
    );
  });

  it('refuses a folder the target does not have, and leaves nothing behind', async () => {
    const mac = host('mac');
    const box = host('box');
    const chatId = await chatWithOneTurn(mac);
    const bundle = mac.daemon.exportChatForMove(chatId);
    expect(() => box.daemon.importMovedChat(bundle, '/no/such/folder')).toThrow(
      expect.objectContaining({ code: 'folder_not_found' }) as ChatMoveError,
    );
    expect(box.daemon.chatState.has(chatId)).toBe(false);
    expect(readdirSync(join(box.home, 'chats'))).toEqual([]);
  });

  // patch doesn't recognise tilde in workspace paths — the target folder for
  // a move is typed into the same "type a path" field as a new chat's, so
  // `~/sub` must land the chat there, not fail `folder_not_found`.
  it('expands a leading ~ in the target folder', async () => {
    const mac = host('mac');
    const box = host('box');
    const chatId = await chatWithOneTurn(mac);
    const bundle = mac.daemon.exportChatForMove(chatId);
    const under = mkdtempSync(join(homedir(), 'patch-move-tilde-'));
    try {
      const tildeFolder = join('~', under.slice(homedir().length + 1));
      box.daemon.importMovedChat(bundle, tildeFolder);
      expect(box.daemon.chatState.get(chatId)?.folder).toBe(under);
    } finally {
      rmSync(under, { recursive: true, force: true });
    }
  });

  it('refuses a chat the target already has', async () => {
    const mac = host('mac');
    const box = host('box');
    const chatId = await chatWithOneTurn(mac);
    const bundle = mac.daemon.exportChatForMove(chatId);
    box.daemon.importMovedChat(bundle, box.folder);
    expect(() => box.daemon.importMovedChat(bundle, box.folder)).toThrow(
      expect.objectContaining({ code: 'already_exists' }) as ChatMoveError,
    );
  });

  it('a moved chat survives a restart of its new host', async () => {
    const mac = host('mac');
    const box = host('box');
    const chatId = await chatWithOneTurn(mac);
    box.daemon.importMovedChat(mac.daemon.exportChatForMove(chatId), box.folder);
    mac.daemon.retireMovedChat(chatId);

    const again = new Daemon({
      daemonId: 'box',
      metaStore: box.metaStore,
      sdkBackend: createMockSdkBackend(),
      oauthAccessToken: 'tok',
      emit: () => undefined,
      logger: silent,
      now: () => 1_700_000_000_000,
    });
    again.hydrate();
    expect(again.chatState.get(chatId)?.folder).toBe(box.folder);
    expect(texts(again, chatId)).toEqual(['make a plan', 'the plan is ready']);
  });
});
