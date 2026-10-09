// spec/02 § Permission mode — Claude Code sometimes resolves a turn onto a
// DIFFERENT permission mode than the one it was given (the host's `claude`
// build too old, or the model unsupported). For every substitution target
// except `plan`, that is a dead end for an unattended chat and the turn is
// refused (`chat.error` code `permission_mode_downgraded`, chat `errored`).
// `plan` is the one exception: it is exactly what a person choosing `plan`
// gets, so the turn runs on and the change is recorded like an ordinary
// mode-change — just marked automatic, naming Claude Code rather than the
// mode control as what made it.
//
// sdkBackend-real.test.ts covers the SDK-envelope layer (`permissionMode`
// mismatch detection, throw vs. yield). This file covers what chatRunner DOES
// with each outcome — the turn, the chat's status, and the transcript record.

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { ChatErrorEvent, ChatMessageEvent, WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { PermissionModeDowngradedError } from '../src/sdkBackend.js';
import type { SdkBackend, SdkEnvelope, SdkRunOptions } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });

function setup(sdkBackend: SdkBackend) {
  const home = mkdtempSync(join(tmpdir(), 'patch-perm-downgrade-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-perm-downgrade-folder-')));
  mkdirSync(folder, { recursive: true });
  const metaStore = createMetaStore(home);
  const events: WireEvent[] = [];
  let id = 0;
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore,
    sdkBackend,
    resolveOAuth: () => ({ ok: true as const, accessToken: 'tok' }),
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${++id}`,
  });
  return { daemon, events, folder, metaStore };
}

function backend(run: (opts: SdkRunOptions) => AsyncGenerator<SdkEnvelope>): SdkBackend {
  return { run };
}

describe('a downgrade to any OTHER mode still refuses the turn', () => {
  it('errors the chat with permission_mode_downgraded, exactly as before', async () => {
    const { daemon, events, folder } = setup(
      backend(async function* (): AsyncGenerator<SdkEnvelope> {
        throw new PermissionModeDowngradedError('bypassPermissions', 'default');
      }),
    );
    const chatId = await daemon.spawnChat({ folder, permissionMode: 'bypassPermissions' });
    events.length = 0;
    await daemon.sendInput({ chatId, message: 'go' });

    const errors = events.filter((e): e is ChatErrorEvent => e.type === 'chat.error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error.code).toBe('permission_mode_downgraded');
    expect(daemon.chatState.get(chatId)?.activity).toBe('errored');
    // The chat's OWN configured mode is untouched — only a person's own choice
    // (or the plan exception) may change it.
    expect(daemon.chatState.get(chatId)?.permissionMode).toBe('bypassPermissions');
  });
});

describe('a downgrade to `plan` is not an error', () => {
  function planBackend(): SdkBackend {
    return backend(async function* (): AsyncGenerator<SdkEnvelope> {
      yield {
        type: 'system',
        permissionModeAutoDowngrade: { requested: 'bypassPermissions', effective: 'plan' },
      };
      // No `raw` here — the assistant/synthetic-message guard in
      // `handleEnvelope` reads `env.raw` to decide whether a message is
      // genuine model output, and treats an ABSENT `raw` as "not synthetic"
      // (a backend, like this one, that doesn't carry the SDK message
      // through at all), same as every other fixture in this file.
      yield { type: 'assistant', content: 'working in plan mode' };
      yield { type: 'result', sessionId: 's1', content: 'working in plan mode' };
    });
  }

  it('does not raise a chat.error and does not mark the chat errored', async () => {
    const { daemon, events, folder } = setup(planBackend());
    const chatId = await daemon.spawnChat({ folder, permissionMode: 'bypassPermissions' });
    events.length = 0;
    await daemon.sendInput({ chatId, message: 'go' });

    expect(events.some((e) => e.type === 'chat.error')).toBe(false);
    expect(daemon.chatState.get(chatId)?.status).not.toBe('errored');
    expect(daemon.chatState.get(chatId)?.activity).not.toBe('errored');
  });

  it('lets the turn continue — the real reply still lands in the transcript', async () => {
    const { daemon, events, folder } = setup(planBackend());
    const chatId = await daemon.spawnChat({ folder, permissionMode: 'bypassPermissions' });
    events.length = 0;
    await daemon.sendInput({ chatId, message: 'go' });

    const messages = events.filter((e): e is ChatMessageEvent => e.type === 'chat.message');
    expect(
      messages.some((m) => m.role === 'assistant' && m.content === 'working in plan mode'),
    ).toBe(true);
  });

  it('stamps the chat onto `plan`, exactly like a person choosing it', async () => {
    const { daemon, folder } = setup(planBackend());
    const chatId = await daemon.spawnChat({ folder, permissionMode: 'bypassPermissions' });
    await daemon.sendInput({ chatId, message: 'go' });

    expect(daemon.chatState.get(chatId)?.permissionMode).toBe('plan');
  });

  it('records the change with the same mode-change event a manual switch uses, marked automatic', async () => {
    const { daemon, events, folder } = setup(planBackend());
    const chatId = await daemon.spawnChat({ folder, permissionMode: 'bypassPermissions' });
    events.length = 0;
    await daemon.sendInput({ chatId, message: 'go' });

    const marks = events.filter(
      (e): e is ChatMessageEvent =>
        e.type === 'chat.message' && e.permissionModeChange !== undefined,
    );
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({
      role: 'system',
      permissionModeChange: 'plan',
      permissionModeChangeAutomatic: true,
    });
    // The line names Claude Code, not a person's own choice.
    expect(marks[0]?.content).not.toBe('Permission mode → plan');
    expect(marks[0]?.content).toContain('plan');
  });

  it('a human-chosen switch to plan carries no automatic flag', async () => {
    const { daemon, events, folder } = setup(
      backend(async function* (): AsyncGenerator<SdkEnvelope> {
        yield { type: 'result', sessionId: 's1', content: 'done', raw: {} };
      }),
    );
    const chatId = await daemon.spawnChat({ folder });
    events.length = 0;
    daemon.setChatPermissionMode(chatId, 'plan');

    const marks = events.filter(
      (e): e is ChatMessageEvent =>
        e.type === 'chat.message' && e.permissionModeChange !== undefined,
    );
    expect(marks).toHaveLength(1);
    expect(marks[0]?.permissionModeChangeAutomatic).toBeUndefined();
    expect(marks[0]?.content).toBe('Permission mode → plan');
  });
});
