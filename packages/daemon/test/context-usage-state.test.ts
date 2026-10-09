// spec/14 § Composer — context ring. The host folds each request's usage and
// the turn result's window into `chat.state.context`, and keeps it in meta.json
// so a restart does not blank the ring.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { ChatStateEvent, WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });
const NOW = 1_700_000_000_000;

function setup(home = mkdtempSync(join(tmpdir(), 'patch-ctx-'))) {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-folder-')));
  const events: WireEvent[] = [];
  const sdk = createMockSdkBackend();
  const metaStore = createMetaStore(home);
  let id = 0;
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore,
    sdkBackend: sdk,
    oauthAccessToken: 'fake-token',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => NOW,
    generateChatId: () => `chat-${++id}`,
  });
  return { daemon, sdk, events, folder, metaStore };
}

const states = (events: WireEvent[]): ChatStateEvent[] =>
  events.filter((e): e is ChatStateEvent => e.type === 'chat.state');

const assistantRaw = (read: number) => ({
  type: 'assistant',
  parent_tool_use_id: null,
  session_id: 'sess-A',
  message: {
    model: 'claude-opus-5-5',
    content: [{ type: 'text', text: 'hi' }],
    usage: { input_tokens: 10, cache_read_input_tokens: read - 10, output_tokens: 5 },
  },
});

const resultRaw = {
  type: 'result',
  session_id: 'sess-A',
  modelUsage: {
    'claude-haiku-4-5-20251001': { contextWindow: 200_000 },
    'claude-opus-5-5': { contextWindow: 1_000_000 },
  },
};

describe('chat.state.context', () => {
  it('is null on a chat that has not been measured', async () => {
    const { daemon, sdk, events, folder } = setup();
    sdk.enqueue([{ type: 'result', sessionId: 'sess-A' }]);
    await daemon.spawnChat({ folder, prompt: 'hi' });
    await new Promise((r) => setTimeout(r, 30));
    expect(states(events).length).toBeGreaterThan(0);
    for (const s of states(events)) expect(s.context).toBeNull();
  });

  it("reports the latest request's tokens against the chat model's window, and persists it", async () => {
    const { daemon, sdk, events, folder, metaStore } = setup();
    sdk.enqueue([
      { type: 'assistant', content: 'hi', sessionId: 'sess-A', raw: assistantRaw(40_000) },
      { type: 'assistant', content: 'more', sessionId: 'sess-A', raw: assistantRaw(52_000) },
      { type: 'result', sessionId: 'sess-A', raw: resultRaw },
    ]);
    const chatId = await daemon.spawnChat({ folder, prompt: 'hi' });
    await new Promise((r) => setTimeout(r, 30));

    const readings = states(events)
      .map((s) => s.context)
      .filter((c) => c != null);
    // It moves during the turn, before the window is known.
    expect(readings[0]).toEqual({ usedTokens: 40_000, at: NOW });
    expect(readings.at(-1)).toEqual({ usedTokens: 52_000, windowTokens: 1_000_000, at: NOW });
    expect(metaStore.read(chatId)?.context).toEqual({
      usedTokens: 52_000,
      windowTokens: 1_000_000,
      at: NOW,
    });
  });
});
