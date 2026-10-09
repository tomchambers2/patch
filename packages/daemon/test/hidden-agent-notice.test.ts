// spec/04 § Hidden — the agent is told when the user hides or shows its chat,
// the same way it is told a surface edited its task list: a one-shot
// `<system-reminder>` on its next turn.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import type { SdkBackend } from '../src/sdkBackend.js';

function setup() {
  const prompts: string[] = [];
  const backend: SdkBackend = {
    run: async function* (opts) {
      prompts.push(opts.prompt);
      yield { type: 'assistant', content: 'ok', sessionId: 'sess-1' };
      yield { type: 'result', sessionId: 'sess-1' };
    },
  };
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-hidenotice-folder-')));
  let id = 0;
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore: createMetaStore(mkdtempSync(join(tmpdir(), 'patch-hidenotice-'))),
    sdkBackend: backend,
    oauthAccessToken: 'fake-token',
    emit: () => undefined,
    logger: pino({ level: 'silent' }),
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${++id}`,
  });
  return { daemon, prompts, folder };
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe('the agent is told its chat was hidden or shown', () => {
  it('prefixes the next turn with a hidden-mode reminder, once', async () => {
    const { daemon, prompts, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.setHidden(chatId, true);
    await daemon.sendInput({ chatId, message: 'carry on', localId: 'L1', origin: 'machine' });
    await tick();
    expect(prompts[0]).toContain('<system-reminder>');
    expect(prompts[0]).toMatch(/now in hidden mode/i);
    await daemon.sendInput({ chatId, message: 'again', localId: 'L2', origin: 'machine' });
    await tick();
    expect(prompts[1]).not.toContain('hidden mode');
  });

  it('tells it when the chat is shown again', async () => {
    const { daemon, prompts, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.setHidden(chatId, true);
    await daemon.sendInput({ chatId, message: 'one', localId: 'L1', origin: 'machine' });
    await tick();
    await daemon.setHidden(chatId, false);
    await daemon.sendInput({ chatId, message: 'two', localId: 'L2', origin: 'machine' });
    await tick();
    expect(prompts[1]).toMatch(/no longer in hidden mode/i);
    expect(prompts[1]).not.toMatch(/now in hidden mode/i);
  });

  it('says nothing when hide and show cancel out before the agent next turn', async () => {
    const { daemon, prompts, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.setHidden(chatId, true);
    await daemon.setHidden(chatId, false);
    await daemon.sendInput({ chatId, message: 'carry on', localId: 'L1', origin: 'machine' });
    await tick();
    expect(prompts[0]).not.toContain('hidden mode');
  });

  it('says nothing when hidden is re-set to what it already was', async () => {
    const { daemon, prompts, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.setHidden(chatId, false);
    await daemon.sendInput({ chatId, message: 'carry on', localId: 'L1', origin: 'machine' });
    await tick();
    expect(prompts[0]).not.toContain('hidden mode');
  });
});
