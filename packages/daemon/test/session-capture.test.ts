// C1: session-ID capture + rotation (spec/02-daemon.md "Session ID capture").
//
// The SDK emits session_id early in the stream; the host captures it to
// meta.json. On /clear or /compact the SDK rotates session_id mid-session;
// the host updates meta.json to the new id.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });

function setup(sdk = createMockSdkBackend()) {
  const home = mkdtempSync(join(tmpdir(), 'patch-sess-'));
  const folder = mkdtempSync(join(tmpdir(), 'patch-sess-folder-'));
  mkdirSync(folder, { recursive: true });
  const metaStore = createMetaStore(home);
  let id = 0;
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore,
    sdkBackend: sdk,
    oauthAccessToken: 'tok',
    emit: () => undefined,
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${++id}`,
  });
  return { daemon, sdk, metaStore, folder };
}

describe('C1 session-ID capture', () => {
  it('captures session_id from the early result message into meta.json', async () => {
    const { daemon, sdk, metaStore, folder } = setup();
    sdk.enqueue([
      { type: 'result', sessionId: 'sess-initial' },
      { type: 'assistant', content: 'hi', sessionId: 'sess-initial' },
    ]);
    const chatId = await daemon.spawnChat({ folder, prompt: 'go' });
    await new Promise((r) => setTimeout(r, 20));
    expect(metaStore.read(chatId)?.claudeSessionId).toBe('sess-initial');
    expect(daemon.chatState.get(chatId)?.claudeSessionId).toBe('sess-initial');
  });

  it('updates meta.json when the SDK rotates session_id (/clear or /compact)', async () => {
    const { daemon, sdk, metaStore, folder } = setup();
    // First turn establishes sess-A.
    sdk.enqueue([{ type: 'result', sessionId: 'sess-A' }]);
    const chatId = await daemon.spawnChat({ folder, prompt: 'go' });
    await new Promise((r) => setTimeout(r, 20));
    expect(metaStore.read(chatId)?.claudeSessionId).toBe('sess-A');

    // Next turn rotates to sess-B (post /clear).
    sdk.enqueue([
      { type: 'result', sessionId: 'sess-B' },
      { type: 'assistant', content: 'fresh context', sessionId: 'sess-B' },
    ]);
    await daemon.sendInput({ chatId, message: '/clear', localId: 'L2' });
    expect(metaStore.read(chatId)?.claudeSessionId).toBe('sess-B');
    expect(daemon.chatState.get(chatId)?.claudeSessionId).toBe('sess-B');
  });
});
