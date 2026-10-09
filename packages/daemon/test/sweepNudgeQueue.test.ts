// spec/06 § Sweep — check-in nudges must not stack. A nudge that has to queue
// behind a running turn replaces any nudge already queued; it is not queued at
// all when the chat already has a real queued message; and queued nudges are
// flushed when the chat's goal is met or cleared.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });

async function runningChat() {
  const home = mkdtempSync(join(tmpdir(), 'patch-nudge-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-nudge-folder-')));
  mkdirSync(folder, { recursive: true });
  const events: WireEvent[] = [];
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: createMockSdkBackend({ turnDelayMs: 300 }),
    oauthAccessToken: 'fake-token',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
  });
  const chatId = await daemon.spawnChat({ folder });
  const running = daemon.sendInput({ chatId, message: 'long job', localId: 'u1' });
  await new Promise((r) => setTimeout(r, 30));
  expect(daemon.runningChatIds()).toContain(chatId);
  const nudge = (localId: string) =>
    daemon.sendInput({
      chatId,
      message: `Checking in ${localId}`,
      localId,
      origin: 'machine',
      nudge: true,
    });
  const queued = () =>
    events.filter((e) => e.type === 'chat.queued').map((e) => (e as { localId: string }).localId);
  const cancelled = () =>
    events
      .filter((e) => e.type === 'chat.dequeued' && e.reason === 'cancelled')
      .map((e) => (e as { localId: string }).localId);
  return { daemon, chatId, running, nudge, queued, cancelled };
}

describe('sweep nudges do not stack', () => {
  it('a new nudge replaces the queued one', async () => {
    const t = await runningChat();
    await t.nudge('n1');
    await t.nudge('n2');
    await t.nudge('n3');
    expect(t.queued()).toEqual(['n1', 'n2', 'n3']);
    expect(t.cancelled()).toEqual(['n1', 'n2']);
    await t.running;
  });

  it('is not queued at all when the chat already has a queued message', async () => {
    const t = await runningChat();
    await t.daemon.sendInput({ chatId: t.chatId, message: 'real', localId: 'u2' });
    await t.nudge('n1');
    expect(t.queued()).toEqual(['u2']);
    await t.running;
  });

  it('setGoal(null) flushes a queued nudge', async () => {
    const t = await runningChat();
    await t.daemon.setGoal(t.chatId, 'ship it');
    await t.nudge('n1');
    expect(t.queued()).toEqual(['n1']);
    await t.daemon.setGoal(t.chatId, null);
    expect(t.cancelled()).toEqual(['n1']);
    await t.running;
  });

  it('flushing leaves a real queued message alone', async () => {
    const t = await runningChat();
    await t.daemon.setGoal(t.chatId, 'ship it');
    await t.nudge('n1');
    await t.daemon.sendInput({ chatId: t.chatId, message: 'real', localId: 'u2' });
    await t.daemon.setGoal(t.chatId, null);
    expect(t.cancelled()).toEqual(['n1']);
    await t.running;
  });
});
