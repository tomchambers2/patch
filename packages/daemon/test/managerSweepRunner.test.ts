// spec/06 § Sweep — `ChatRunner.runManagerSweep` executes a sweep's decision
// call: nudge/wake by delivering a message (locally or cross-host), flag by a
// quiet note on the Manager thread, leave by doing nothing. Covers the
// DONE-WHEN behaviours: nudge vs flag vs leave, never approves permissions
// (a permission/question candidate is downgraded to flag regardless of what
// the decider said), and local vs cross-host delivery.

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { SPECIAL_THREAD_IDS, type ManagerSweepCandidate, type WireEvent } from '@patch/wire';
import { Daemon, type DaemonOptions } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';
import type { SweepDecisionResult } from '../src/managerSweepGen.js';

const silent = pino({ level: 'silent' });

function setup(
  decideSweep: NonNullable<DaemonOptions['decideSweep']>,
  extra: Partial<DaemonOptions> = {},
) {
  const home = mkdtempSync(join(tmpdir(), 'patch-sweep-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-sweep-folder-')));
  mkdirSync(folder, { recursive: true });
  const metaStore = createMetaStore(home);
  const events: WireEvent[] = [];
  const sdk = createMockSdkBackend();
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore,
    sdkBackend: sdk,
    oauthAccessToken: 'fake-token',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
    decideSweep,
    ...extra,
  });
  return { daemon, sdk, events, folder, metaStore };
}

/** Flagging writes onto the Manager thread's own log, so any test exercising
 * it needs that thread to actually exist first. */
function setupWithManager(
  decideSweep: NonNullable<DaemonOptions['decideSweep']>,
  extra: Partial<DaemonOptions> = {},
) {
  const home = mkdtempSync(join(tmpdir(), 'patch-sweep-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-sweep-folder-')));
  mkdirSync(folder, { recursive: true });
  const metaStore = createMetaStore(home);
  const events: WireEvent[] = [];
  const sdk = createMockSdkBackend();
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore,
    sdkBackend: sdk,
    oauthAccessToken: 'fake-token',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => SPECIAL_THREAD_IDS.manager,
    decideSweep,
    ...extra,
  });
  return { daemon, sdk, events, folder, metaStore };
}

function candidate(over: Partial<ManagerSweepCandidate> = {}): ManagerSweepCandidate {
  return {
    chatId: 'chat-local',
    daemonId: 'd1',
    folder: '/work/x',
    edge: 'stalled',
    idleMinutes: 20,
    ...over,
  };
}

const result = (decisions: SweepDecisionResult['decisions']): SweepDecisionResult => ({
  decisions,
  tokensUsed: 42,
});

describe('runManagerSweep', () => {
  it('reports an error and touches nothing when no decider is configured', async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-sweep-'));
    const metaStore = createMetaStore(home);
    const daemon = new Daemon({
      daemonId: 'd1',
      metaStore,
      sdkBackend: createMockSdkBackend(),
      oauthAccessToken: 'fake-token',
      emit: () => {},
      logger: silent,
      now: () => 1_700_000_000_000,
    });
    const out = await daemon.runManagerSweep({
      runId: 'r1',
      candidates: [candidate()],
      messagesPerChat: 3,
      prompt: 'decide',
      model: 'claude-sonnet-5',
    });
    expect(out.error).toMatch(/no decider configured/i);
    expect(out.actions).toEqual([]);
  });

  it('reports an error when the decision call itself fails (NO FALLBACK)', async () => {
    const { daemon } = setup(async () => null);
    const out = await daemon.runManagerSweep({
      runId: 'r1',
      candidates: [candidate()],
      messagesPerChat: 3,
      prompt: 'decide',
      model: 'claude-sonnet-5',
    });
    expect(out.error).toMatch(/decision call failed/i);
    expect(out.actions).toEqual([]);
  });

  it('nudge: delivers the message into a LOCAL candidate chat as a machine turn', async () => {
    let chatId = '';
    const decide = vi.fn(async () =>
      result([{ chatId, action: 'nudge', message: 'carry on please' }]),
    );
    const { daemon, folder, sdk } = setup(decide);
    sdk.enqueue([
      { type: 'assistant', content: 'ok, continuing' },
      { type: 'result', sessionId: 's1' },
    ]);
    chatId = await daemon.spawnChat({ folder });
    const out = await daemon.runManagerSweep({
      runId: 'r1',
      candidates: [candidate({ chatId, daemonId: 'd1', folder })],
      messagesPerChat: 3,
      prompt: 'decide',
      model: 'claude-sonnet-5',
    });
    expect(out.actions).toEqual([{ chatId, action: 'nudge' }]);
    await new Promise((r) => setTimeout(r, 20));
    const history = daemon.readHistory({ chatId });
    expect(
      history.events.some((e) => e.type === 'chat.message' && e.content === 'carry on please'),
    ).toBe(true);
  });

  it('nudge/wake: a chat mid-turn is left alone — the message would only queue behind the turn and go stale', async () => {
    let chatId = '';
    const decide = vi.fn(async () =>
      result([{ chatId, action: 'wake', message: 'still working?' }]),
    );
    const { daemon, folder, sdk } = setup(decide, {
      sdkBackend: createMockSdkBackend({ turnDelayMs: 300 }),
    });
    void sdk;
    chatId = await daemon.spawnChat({ folder });
    const running = daemon.sendInput({ chatId, message: 'long job', localId: 'u1' });
    await new Promise((r) => setTimeout(r, 30));
    expect(daemon.runningChatIds()).toContain(chatId);
    const sweep = () =>
      daemon.runManagerSweep({
        runId: 'r1',
        candidates: [candidate({ chatId, daemonId: 'd1', folder })],
        messagesPerChat: 3,
        prompt: 'decide',
        model: 'claude-sonnet-5',
      });
    // Two sweeps while the turn runs: neither may park a message in the queue.
    expect((await sweep()).actions).toEqual([{ chatId, action: 'leave' }]);
    expect((await sweep()).actions).toEqual([{ chatId, action: 'leave' }]);
    await running;
    await new Promise((r) => setTimeout(r, 400));
    const history = daemon.readHistory({ chatId });
    expect(
      history.events.some((e) => e.type === 'chat.message' && e.content === 'still working?'),
    ).toBe(false);
  });

  it('wake: delivers a cross-host candidate via sendToRemoteChat, never sendInput', async () => {
    const decide = vi.fn(async () =>
      result([{ chatId: 'chat-remote', action: 'wake', message: 'still working?' }]),
    );
    const sendToRemoteChat = vi.fn(async () => undefined);
    const { daemon } = setup(decide, { sendToRemoteChat });
    const out = await daemon.runManagerSweep({
      runId: 'r1',
      candidates: [candidate({ chatId: 'chat-remote', daemonId: 'd2', folder: '/elsewhere' })],
      messagesPerChat: 3,
      prompt: 'decide',
      model: 'claude-sonnet-5',
    });
    expect(out.actions).toEqual([{ chatId: 'chat-remote', action: 'wake' }]);
    expect(sendToRemoteChat).toHaveBeenCalledWith({
      sourceChatId: SPECIAL_THREAD_IDS.manager,
      targetChatId: 'chat-remote',
      message: 'still working?',
    });
  });

  it('flag: writes a quiet system note on the Manager thread, not a turn anywhere', async () => {
    const decide = vi.fn(async () =>
      result([{ chatId: 'chat-x', action: 'flag', flagText: 'needs a real decision' }]),
    );
    const { daemon, events, folder } = setupWithManager(decide);
    await daemon.spawnChat({ folder });
    const out = await daemon.runManagerSweep({
      runId: 'r1',
      candidates: [candidate({ chatId: 'chat-x' })],
      messagesPerChat: 3,
      prompt: 'decide',
      model: 'claude-sonnet-5',
    });
    expect(out.actions).toEqual([{ chatId: 'chat-x', action: 'flag' }]);
    const flagMsg = events.find(
      (e) => e.type === 'chat.message' && e.chatId === SPECIAL_THREAD_IDS.manager,
    );
    expect(flagMsg).toBeDefined();
    if (flagMsg?.type === 'chat.message') {
      expect(flagMsg.role).toBe('system');
      expect(flagMsg.content).toContain('needs a real decision');
    }
  });

  it('leave: a candidate decided "leave" does nothing observable', async () => {
    const decide = vi.fn(async () => result([{ chatId: 'chat-x', action: 'leave' }]));
    const { daemon, events } = setup(decide);
    const out = await daemon.runManagerSweep({
      runId: 'r1',
      candidates: [candidate({ chatId: 'chat-x' })],
      messagesPerChat: 3,
      prompt: 'decide',
      model: 'claude-sonnet-5',
    });
    expect(out.actions).toEqual([{ chatId: 'chat-x', action: 'leave' }]);
    expect(events).toEqual([]);
  });

  it('never nudges or wakes a permission-blocked candidate, even if told to — downgrades to flag', async () => {
    const decide = vi.fn(async () =>
      result([{ chatId: 'chat-x', action: 'nudge', message: 'go ahead, I approve' }]),
    );
    const { daemon, events, folder } = setupWithManager(decide);
    await daemon.spawnChat({ folder });
    const out = await daemon.runManagerSweep({
      runId: 'r1',
      candidates: [candidate({ chatId: 'chat-x', edge: 'permission' })],
      messagesPerChat: 3,
      prompt: 'decide',
      model: 'claude-sonnet-5',
    });
    expect(out.actions).toEqual([{ chatId: 'chat-x', action: 'flag' }]);
    expect(events.some((e) => e.type === 'chat.input')).toBe(false);
    const flagMsg = events.find(
      (e) => e.type === 'chat.message' && e.chatId === SPECIAL_THREAD_IDS.manager,
    );
    expect(flagMsg).toBeDefined();
  });

  it('never nudges or wakes a question-blocked candidate, even if told to — downgrades to flag', async () => {
    const decide = vi.fn(async () =>
      result([{ chatId: 'chat-x', action: 'wake', message: 'answer: yes' }]),
    );
    const { daemon, folder } = setupWithManager(decide);
    await daemon.spawnChat({ folder });
    const out = await daemon.runManagerSweep({
      runId: 'r1',
      candidates: [candidate({ chatId: 'chat-x', edge: 'question' })],
      messagesPerChat: 3,
      prompt: 'decide',
      model: 'claude-sonnet-5',
    });
    expect(out.actions).toEqual([{ chatId: 'chat-x', action: 'flag' }]);
  });

  it('a permission/question candidate the decider never addressed is still flagged deterministically', async () => {
    const decide = vi.fn(async () => result([]));
    const { daemon, events, folder } = setupWithManager(decide);
    await daemon.spawnChat({ folder });
    const out = await daemon.runManagerSweep({
      runId: 'r1',
      candidates: [candidate({ chatId: 'chat-x', edge: 'permission' })],
      messagesPerChat: 3,
      prompt: 'decide',
      model: 'claude-sonnet-5',
    });
    expect(out.actions).toEqual([{ chatId: 'chat-x', action: 'flag' }]);
    expect(events.some((e) => e.type === 'chat.message')).toBe(true);
  });

  it('a non-blocked candidate the decider never addressed is left alone', async () => {
    const decide = vi.fn(async () => result([]));
    const { daemon, events } = setup(decide);
    const out = await daemon.runManagerSweep({
      runId: 'r1',
      candidates: [candidate({ chatId: 'chat-x', edge: 'stalled' })],
      messagesPerChat: 3,
      prompt: 'decide',
      model: 'claude-sonnet-5',
    });
    expect(out.actions).toEqual([{ chatId: 'chat-x', action: 'leave' }]);
    expect(events).toEqual([]);
  });

  it('passes the digest + prompt + model through to the decider', async () => {
    const decide = vi.fn(async () => result([]));
    const { daemon } = setup(decide);
    await daemon.runManagerSweep({
      runId: 'r1',
      candidates: [candidate({ chatId: 'chat-x', edge: 'stalled', idleMinutes: 17 })],
      messagesPerChat: 3,
      prompt: 'MY PROMPT',
      model: 'claude-haiku-4-5-20251001',
    });
    expect(decide).toHaveBeenCalledTimes(1);
    const arg = decide.mock.calls[0]![0];
    expect(arg.prompt).toBe('MY PROMPT');
    expect(arg.model).toBe('claude-haiku-4-5-20251001');
    expect(arg.digest).toContain('chat-x');
    expect(arg.digest).toContain('stalled');
  });

  it('reports the tokensUsed from the decision call', async () => {
    const decide = vi.fn(async () => ({ decisions: [], tokensUsed: 777 }));
    const { daemon } = setup(decide);
    const out = await daemon.runManagerSweep({
      runId: 'r1',
      candidates: [candidate({ chatId: 'chat-x' })],
      messagesPerChat: 3,
      prompt: 'decide',
      model: 'claude-sonnet-5',
    });
    expect(out.tokensUsed).toBe(777);
  });
});
