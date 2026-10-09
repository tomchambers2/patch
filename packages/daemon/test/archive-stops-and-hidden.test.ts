// spec/04 § Lifecycle, § Hidden — archived means stopped, hidden means running
// out of the way.
//
// Archiving used to be a sidebar move and nothing else: a chat archived
// mid-turn kept running, and its self-wakes and watches kept firing into it —
// each of which, being a message, un-archived it again. So "archived" never
// meant finished. Now archiving ends everything the chat has in motion, and the
// state a job's background run needs — running, but not in the inbox — is
// Hidden, a separate flag that survives archiving so a machine message starting
// the chat again puts it back where it was.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { ChatStateEvent, WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore, type MetaStore } from '../src/meta.js';
import type { SdkBackend } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });
const NOW = 1_700_000_000_000;

/**
 * A turn whose prompt says `hang` runs until it is aborted; any other turn
 * answers and settles at once. `prompts` records every turn that actually ran.
 */
function backend(prompts: string[]): SdkBackend {
  return {
    run: async function* (opts) {
      prompts.push(opts.prompt);
      if (opts.prompt.includes('hang')) {
        await new Promise<void>((resolve) => {
          if (opts.abortController.signal.aborted) resolve();
          opts.abortController.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return;
      }
      yield { type: 'assistant', content: 'ok', sessionId: 'sess-1' };
      yield { type: 'result', sessionId: 'sess-1' };
    },
  };
}

function setup(home = mkdtempSync(join(tmpdir(), 'patch-archstop-'))) {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-archstop-folder-')));
  mkdirSync(folder, { recursive: true });
  const metaStore = createMetaStore(home);
  const events: WireEvent[] = [];
  const prompts: string[] = [];
  let id = 0;
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore,
    sdkBackend: backend(prompts),
    oauthAccessToken: 'fake-token',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => NOW,
    generateChatId: () => `chat-${++id}`,
  });
  return { daemon, events, prompts, folder, metaStore, home };
}

async function tick(ms = 30): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function lastState(events: WireEvent[], chatId: string): ChatStateEvent | undefined {
  return events
    .filter((e): e is ChatStateEvent => e.type === 'chat.state' && e.chatId === chatId)
    .at(-1);
}

describe('archiving stops everything the chat has in motion', () => {
  it('stops the running turn and drops the turns queued behind it', async () => {
    const { daemon, events, prompts, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    void daemon.sendInput({ chatId, message: 'hang on this', localId: 'L1', fromUser: true });
    await tick();
    void daemon.sendInput({ chatId, message: 'queued behind', localId: 'L2', fromUser: true });
    await tick();
    expect(daemon.chatState.get(chatId)?.activity).toBe('running');

    await daemon.setArchived(chatId, true);
    await tick();

    expect(daemon.chatState.get(chatId)?.status).toBe('archived');
    expect(daemon.chatState.get(chatId)?.activity).toBe('idle');
    // The queued turn never ran, and surfaces were told it was cancelled.
    expect(prompts.some((p) => p.includes('queued behind'))).toBe(false);
    expect(
      events.some(
        (e) =>
          e.type === 'chat.dequeued' &&
          (e as { localId: string }).localId === 'L2' &&
          (e as { reason: string }).reason === 'cancelled',
      ),
    ).toBe(true);
    expect(events.some((e) => e.type === 'chat.stopped' && e.chatId === chatId)).toBe(true);
  });

  it('cancels the pending self-wake', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    daemon.scheduleWake(chatId, { in: '1h', message: 'check again' });
    expect(daemon.peekWake(chatId)).not.toBeNull();

    await daemon.setArchived(chatId, true);

    expect(daemon.peekWake(chatId)).toBeNull();
  });

  it('stops every running watch without delivering a completion into the chat', async () => {
    const { daemon, prompts, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    daemon.startWatch(chatId, { command: 'sleep 30', description: 'slow thing' });
    expect(daemon.listWatch(chatId).filter((w) => w.status === 'running')).toHaveLength(1);

    await daemon.setArchived(chatId, true);
    await tick();

    expect(daemon.listWatch(chatId).filter((w) => w.status === 'running')).toHaveLength(0);
    expect(daemon.chatState.get(chatId)?.status).toBe('archived');
    expect(prompts).toHaveLength(0);
  });
});

describe('a message into an archived chat starts it again, where it was', () => {
  it("the user's own message brings it into the active list", async () => {
    const { daemon, prompts, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.setArchived(chatId, true);

    await daemon.sendInput({ chatId, message: 'back to this', localId: 'L1', fromUser: true });

    expect(daemon.chatState.get(chatId)?.status).toBe('active');
    expect(daemon.chatState.get(chatId)?.hidden).toBe(false);
    expect(prompts).toEqual(['back to this']);
  });

  it('a machine message into an ordinary archived chat brings it into view', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.setArchived(chatId, true);

    await daemon.sendInput({
      chatId,
      message: 'from another agent',
      localId: 'L1',
      origin: 'machine',
    });

    expect(daemon.chatState.get(chatId)?.status).toBe('active');
    expect(daemon.chatState.get(chatId)?.hidden).toBe(false);
  });

  it('a job tick into a hand-archived hidden run returns it to Hidden, not the inbox', async () => {
    const { daemon, events, folder, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder, hidden: true, prompt: 'first fire' });
    await tick();
    // Finishing leaves it in Hidden; only a person archives it.
    expect(daemon.chatState.get(chatId)?.status).toBe('active');
    await daemon.setArchived(chatId, true);

    // Not awaited to completion before checking: the chat must be hidden the
    // moment it starts running, not only after.
    const run = daemon.sendInput({ chatId, message: 'second fire', localId: 'L2' });
    await tick(5);
    const running = events
      .filter((e): e is ChatStateEvent => e.type === 'chat.state' && e.chatId === chatId)
      .find((e) => e.status === 'active' && e.activity === 'running');
    expect(running?.hidden).toBe(true);
    await run;
    await tick();

    // Finishing again leaves it in Hidden, never in Archived.
    expect(daemon.chatState.get(chatId)?.status).toBe('active');
    expect(metaStore.read(chatId)?.hidden).toBe(true);
  });

  it("the user's message into a finished hidden run brings it into the list for good", async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder, hidden: true, prompt: 'first fire' });
    await tick();
    expect(daemon.chatState.get(chatId)?.status).toBe('active');
    expect(daemon.chatState.get(chatId)?.hidden).toBe(true);

    await daemon.sendInput({ chatId, message: 'what happened?', localId: 'L1', fromUser: true });
    await tick();

    expect(daemon.chatState.get(chatId)?.status).toBe('active');
    expect(daemon.chatState.get(chatId)?.hidden).toBe(false);
  });
});

describe('a hidden chat never archives itself, including with a subagent running', () => {
  it('stays active (and keeps the subagent running) when its own turn settles first', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder, hidden: true });
    const { id: delegateId } = await daemon.createDelegate({
      parentChatId: chatId,
      prompt: 'hang',
    });
    await tick();

    await daemon.sendInput({ chatId, message: 'wake tick', localId: 'L1', origin: 'machine' });
    await tick();

    expect(daemon.chatState.get(chatId)?.status).toBe('active');
    expect(daemon.chatState.get(delegateId)?.subagent?.outcome).toBeUndefined();
  });
});

describe('Hidden', () => {
  it('a hidden chat stays hidden for machine messages', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder, hidden: true });
    // A wake keeps it from finishing, so it stays hidden rather than archiving.
    daemon.scheduleWake(chatId, { in: '1h', message: 'later' });

    await daemon.sendInput({ chatId, message: 'wake tick', localId: 'L1', origin: 'machine' });
    await tick();

    expect(daemon.chatState.get(chatId)?.hidden).toBe(true);
    expect(daemon.chatState.get(chatId)?.status).toBe('active');
  });

  it("the user's message un-hides it", async () => {
    const { daemon, events, folder, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder, hidden: true });

    await daemon.sendInput({ chatId, message: 'hi', localId: 'L1', fromUser: true });
    await tick();

    expect(daemon.chatState.get(chatId)?.hidden).toBe(false);
    expect(metaStore.read(chatId)?.hidden).toBe(false);
    expect(lastState(events, chatId)?.hidden).toBe(false);
    // Not hidden, so finishing does not archive it.
    expect(daemon.chatState.get(chatId)?.status).toBe('active');
  });

  it('declaring a status un-hides it', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder, hidden: true });

    await daemon.declareStatus(chatId, 'report', 'Found three new listings');

    expect(daemon.chatState.get(chatId)?.hidden).toBe(false);
  });

  it('stays hidden while it owns a running watch, and stays hidden once nothing is left', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder, hidden: true });
    const w = daemon.startWatch(chatId, { command: 'sleep 30', description: 'slow' });

    await daemon.sendInput({ chatId, message: 'carry on', localId: 'L1', origin: 'machine' });
    await tick();
    expect(daemon.chatState.get(chatId)?.status).toBe('active');
    expect(daemon.chatState.get(chatId)?.hidden).toBe(true);

    daemon.stopWatch(chatId, w.taskId);
    await daemon.sendInput({ chatId, message: 'done now', localId: 'L2', origin: 'machine' });
    await tick();
    expect(daemon.chatState.get(chatId)?.status).toBe('active');
    expect(daemon.chatState.get(chatId)?.hidden).toBe(true);
  });

  it('a finished hidden job chat is never in Archived, and a question brings it from Hidden into the list', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder, hidden: true, prompt: 'run' });
    await tick();
    expect(daemon.chatState.get(chatId)?.status).toBe('active');
    expect(daemon.chatState.get(chatId)?.hidden).toBe(true);

    await daemon.declareStatus(chatId, 'question', 'Which phone number should I use?');

    expect(daemon.chatState.get(chatId)?.hidden).toBe(false);
    expect(daemon.chatState.get(chatId)?.status).toBe('active');
    expect(daemon.chatState.get(chatId)?.statusKind).toBe('question');
  });

  it('Show un-hides without sending anything', async () => {
    const { daemon, prompts, folder, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder, hidden: true });

    await daemon.setHidden(chatId, false);

    expect(daemon.chatState.get(chatId)?.hidden).toBe(false);
    expect(metaStore.read(chatId)?.hidden).toBe(false);
    expect(prompts).toHaveLength(0);
  });

  it('refuses to hide an archived chat or a special thread', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.setArchived(chatId, true);

    await expect(daemon.setHidden(chatId, true)).rejects.toThrow(/only an active chat/);
  });
});

describe('chats archived before archiving meant stopped', () => {
  it('move to Hidden on load when they still own live work, and stay archived otherwise', async () => {
    const first = setup();
    const live = await first.daemon.spawnChat({ folder: first.folder });
    const idle = await first.daemon.spawnChat({ folder: first.folder });
    first.daemon.scheduleWake(live, { in: '1h', message: 'later' });
    // Write the old state directly: archived, with the wake still armed — the
    // shape the previous rules allowed and the new `setArchived` never leaves.
    const store: MetaStore = first.metaStore;
    for (const id of [live, idle]) {
      store.update(id, (m) => ({ ...m, status: 'archived', archivedAt: NOW }));
    }
    first.daemon.shutdown();

    const second = setup(first.home);
    second.daemon.hydrate();

    expect(second.daemon.chatState.get(live)?.status).toBe('active');
    expect(second.daemon.chatState.get(live)?.hidden).toBe(true);
    expect(second.metaStore.read(live)?.hidden).toBe(true);
    expect(second.daemon.chatState.get(idle)?.status).toBe('archived');
    second.daemon.shutdown();
  });
});
