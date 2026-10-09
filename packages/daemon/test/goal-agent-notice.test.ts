// spec/04 § Goals — the agent is told when a goal is set or cleared (one-shot
// `<system-reminder>` on its next turn), and the reminder is disclosed in the
// transcript as a labelled system-context item.

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
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-goalnotice-folder-')));
  let id = 0;
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore: createMetaStore(mkdtempSync(join(tmpdir(), 'patch-goalnotice-'))),
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

describe('the agent is told its goal was set or cleared', () => {
  it('prefixes the next turn with the goal, once', async () => {
    const { daemon, prompts, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.setGoal(chatId, 'Ship the release');
    await daemon.sendInput({ chatId, message: 'carry on', localId: 'L1', origin: 'machine' });
    await tick();
    expect(prompts[0]).toContain('<system-reminder>');
    expect(prompts[0]).toContain('Ship the release');
    expect(prompts[0]).toMatch(/goal/i);
    await daemon.sendInput({ chatId, message: 'again', localId: 'L2', origin: 'machine' });
    await tick();
    expect(prompts[1]).not.toContain('Ship the release');
  });

  it('tells it when the goal is cleared', async () => {
    const { daemon, prompts, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.setGoal(chatId, 'Ship the release');
    await daemon.sendInput({ chatId, message: 'one', localId: 'L1', origin: 'machine' });
    await tick();
    await daemon.setGoal(chatId, null);
    await daemon.sendInput({ chatId, message: 'two', localId: 'L2', origin: 'machine' });
    await tick();
    expect(prompts[1]).toMatch(/goal.*cleared/i);
  });

  it('only announces the latest goal when it is replaced before the next turn', async () => {
    const { daemon, prompts, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.setGoal(chatId, 'first goal');
    await daemon.setGoal(chatId, 'second goal');
    await daemon.sendInput({ chatId, message: 'go', localId: 'L1', origin: 'machine' });
    await tick();
    expect(prompts[0]).toContain('second goal');
    expect(prompts[0]).not.toContain('first goal');
  });

  it('says nothing when the goal is re-set to what it already was', async () => {
    const { daemon, prompts, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.setGoal(chatId, null);
    await daemon.sendInput({ chatId, message: 'go', localId: 'L1', origin: 'machine' });
    await tick();
    expect(prompts[0]).not.toMatch(/goal/i);
  });
});

describe('the goal reminder is disclosed in the transcript', () => {
  it('labels set and cleared reminders', async () => {
    const { extractSystemContext } = await import('../src/history.js');
    const { buildGoalSystemReminder } = await import('../src/todos.js');
    expect(extractSystemContext(buildGoalSystemReminder('Ship it') + 'hi')[0]?.label).toBe(
      'Goal set',
    );
    expect(extractSystemContext(buildGoalSystemReminder(null) + 'hi')[0]?.label).toBe(
      'Goal cleared',
    );
  });
});
