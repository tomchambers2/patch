// One chat's unreadable meta.json must not stop the host loading the rest.
// On 28 Sep 2026 an agent hand-edited a thread's meta to `claudeSessionId: null`;
// hydrate threw on it and the host crash-looped, dropping every chat on the
// host until the file was repaired by hand.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import type { SdkBackend } from '../src/sdkBackend.js';

const idle: SdkBackend = {
  run: async function* () {
    yield { type: 'result', sessionId: 'sess-1' };
  },
};

function daemonAt(home: string, logs: Array<Record<string, unknown>> = []) {
  const logger = pino(
    { level: 'error' },
    { write: (line: string) => void logs.push(JSON.parse(line) as Record<string, unknown>) },
  );
  let id = 0;
  return new Daemon({
    daemonId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: idle,
    oauthAccessToken: 'fake-token',
    emit: () => {},
    logger,
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${++id}`,
  });
}

describe('hydrate with an unreadable meta.json', () => {
  it('loads every other chat, logs the bad one at error level, and reports it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-unreadable-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-unreadable-folder-')));
    const first = daemonAt(home);
    const good = await first.spawnChat({ folder });
    const broken = await first.spawnChat({ folder });
    first.shutdown();

    const p = join(home, 'chats', broken, 'meta.json');
    const meta = JSON.parse(readFileSync(p, 'utf8'));
    meta.claudeSessionId = null;
    writeFileSync(p, JSON.stringify(meta));

    const logs: Array<Record<string, unknown>> = [];
    const second = daemonAt(home, logs);
    expect(() => second.hydrate()).not.toThrow();

    expect(second.chatState.get(good)).toBeDefined();
    expect(second.chatState.get(broken)).toBeUndefined();
    expect(second.unreadableChats()).toEqual([
      { chatId: broken, path: p, error: 'claudeSessionId: Expected string, received null' },
    ]);
    expect(logs).toContainEqual(expect.objectContaining({ level: 50, chatId: broken, path: p }));
    second.shutdown();
  });
});
