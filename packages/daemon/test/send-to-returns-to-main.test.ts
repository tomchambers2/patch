// An agent's `patch_send_to` landing in a chat that is out of the main list —
// hidden, snoozed or archived — brings it back to the main list (spec/04 §
// Hidden, § Snooze, § Lifecycle). Machine sends that are not an agent writing
// (a self-wake, a job tick) leave it where it was.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import type { SdkBackend } from '../src/sdkBackend.js';

const NOW = 1_700_000_000_000;

const backend: SdkBackend = {
  run: async function* () {
    yield { type: 'assistant', content: 'ok', sessionId: 's' };
    yield { type: 'result', sessionId: 's' };
  },
};

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'patch-sendto-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-sendto-f-')));
  mkdirSync(folder, { recursive: true });
  const metaStore = createMetaStore(home);
  let id = 0;
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore,
    sdkBackend: backend,
    oauthAccessToken: 'x',
    emit: () => undefined,
    logger: pino({ level: 'silent' }),
    now: () => NOW,
    generateChatId: () => `chat-${++id}`,
  });
  return { daemon, folder, metaStore };
}

const tick = () => new Promise((r) => setTimeout(r, 30));

describe('patch_send_to returns a chat to the main view', () => {
  it('un-hides a hidden chat', async () => {
    const { daemon, folder, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder, hidden: true });
    await daemon.submitInput({
      chatId,
      message: 'hi',
      localId: 'L1',
      origin: 'machine',
      fromAgent: true,
    });
    await tick();
    expect(daemon.chatState.get(chatId)?.hidden).toBe(false);
    expect(metaStore.read(chatId)?.hidden).toBe(false);
  });

  it('ends a snooze', async () => {
    const { daemon, folder, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.setSnoozed(chatId, NOW + 3_600_000);
    await daemon.submitInput({
      chatId,
      message: 'hi',
      localId: 'L1',
      origin: 'machine',
      fromAgent: true,
    });
    await tick();
    expect(daemon.chatState.get(chatId)?.snoozedUntil).toBeNull();
    expect(metaStore.read(chatId)?.snoozedUntil).toBeNull();
    daemon.shutdown();
  });

  it('un-archives and un-hides an archived hidden chat', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder, hidden: true });
    await daemon.setArchived(chatId, true);
    await daemon.submitInput({
      chatId,
      message: 'hi',
      localId: 'L1',
      origin: 'machine',
      fromAgent: true,
    });
    await tick();
    expect(daemon.chatState.get(chatId)?.status).toBe('active');
    expect(daemon.chatState.get(chatId)?.hidden).toBe(false);
  });

  it('a machine send that is not an agent writing leaves hidden and snoozed alone', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder, hidden: true });
    await daemon.setSnoozed(chatId, NOW + 3_600_000);
    await daemon.sendInput({ chatId, message: 'tick', localId: 'L1', origin: 'machine' });
    await tick();
    expect(daemon.chatState.get(chatId)?.hidden).toBe(true);
    expect(daemon.chatState.get(chatId)?.snoozedUntil).toBe(NOW + 3_600_000);
    daemon.shutdown();
  });
});
