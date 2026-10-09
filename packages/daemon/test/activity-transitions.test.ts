// C1: chat_state activity-transition matrix (spec/04-chats-and-folders.md
// ## chat_state). idle → running (query start), running →
// awaiting-permission (permission_request), awaiting-permission → running
// (permission_response), running → idle (completion), any → errored (error).

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { ChatActivity, WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });

function setup(sdk = createMockSdkBackend()) {
  const home = mkdtempSync(join(tmpdir(), 'patch-act-'));
  const folder = mkdtempSync(join(tmpdir(), 'patch-act-folder-'));
  mkdirSync(folder, { recursive: true });
  const events: WireEvent[] = [];
  let id = 0;
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: sdk,
    oauthAccessToken: 'tok',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${++id}`,
  });
  return { daemon, sdk, events, folder };
}

function activitySequence(events: WireEvent[]): ChatActivity[] {
  return events
    .filter((e) => e.type === 'chat.state')
    .map((e) => (e as unknown as { activity: ChatActivity }).activity);
}

describe('C1 activity-transition matrix', () => {
  it('idle → running → idle on a clean turn', async () => {
    const { daemon, sdk, events, folder } = setup();
    sdk.enqueue([{ type: 'assistant', content: 'hi', sessionId: 'S' }]);
    const chatId = await daemon.spawnChat({ folder, prompt: 'go' });
    await new Promise((r) => setTimeout(r, 30));
    const seq = activitySequence(events);
    expect(seq).toContain('running');
    expect(seq[seq.length - 1]).toBe('idle');
    expect(daemon.chatState.get(chatId)?.activity).toBe('idle');
  });

  it('running → awaiting-permission on a permission_request, then → running on response', async () => {
    const sdk = {
      async *run() {
        yield { type: 'system' as const, content: 'starting' };
        yield {
          permission: {
            requestId: 'req-1',
            tool: 'Edit',
            args: { file_path: 'f.txt', old_string: 'a', new_string: 'b' },
          },
        };
        // Hold the stream open so the chat stays awaiting-permission until we
        // submit the response below.
        await new Promise((r) => setTimeout(r, 50));
        yield { type: 'assistant' as const, content: 'done', sessionId: 'S' };
      },
    };
    const { daemon, events, folder } = setup(sdk);
    const chatId = await daemon.spawnChat({ folder, prompt: 'run ls' });
    // Wait until the permission request lands.
    await new Promise((r) => setTimeout(r, 20));
    expect(daemon.chatState.get(chatId)?.activity).toBe('awaiting-permission');

    // Surface approves → back to running.
    daemon.submitPermissionResponse({ requestId: 'req-1', decision: 'approve' });
    expect(daemon.chatState.get(chatId)?.activity).toBe('running');

    await new Promise((r) => setTimeout(r, 60));
    const seq = activitySequence(events);
    expect(seq).toContain('running');
    expect(seq).toContain('awaiting-permission');
    // Final state after stream completion is idle.
    expect(daemon.chatState.get(chatId)?.activity).toBe('idle');
  });

  it('stream that emits a permission then COMPLETES stays awaiting-permission (not idle) until resolved', async () => {
    // The dev mock (and any non-blocking backend) yields a permission envelope
    // then returns — the iterator completes while the request is unresolved.
    // The run loop must NOT settle the chat to idle: the user is still being
    // asked. It parks in awaiting-permission; resolving it settles to idle
    // (no in-flight run left to continue). G2-4/G2-15/G2-17.
    const sdk = {
      async *run() {
        yield { type: 'assistant' as const, content: "I'd like to edit a file." };
        yield {
          permission: {
            requestId: 'req-mock',
            tool: 'Edit',
            args: { file_path: 'f.txt', old_string: 'a', new_string: 'b' },
          },
        };
        // No hold — the iterator returns immediately after the permission.
      },
    };
    const { daemon, events, folder } = setup(sdk);
    const chatId = await daemon.spawnChat({ folder, prompt: 'edit' });
    await new Promise((r) => setTimeout(r, 30));
    // The turn finished but the chat is paused on the user, NOT idle.
    expect(daemon.chatState.get(chatId)?.activity).toBe('awaiting-permission');
    const lastBefore = activitySequence(events).at(-1);
    expect(lastBefore).toBe('awaiting-permission');

    // Resolving settles to idle (the mock turn is already complete).
    daemon.submitPermissionResponse({ requestId: 'req-mock', decision: 'approve' });
    expect(daemon.chatState.get(chatId)?.activity).toBe('idle');
    expect(activitySequence(events).at(-1)).toBe('idle');
  });

  it('any → errored when the SDK stream throws', async () => {
    const sdk = {
      async *run() {
        yield { type: 'system' as const, content: 'starting' };
        throw new Error('boom from sdk');
      },
    };
    const { daemon, events, folder } = setup(sdk);
    const chatId = await daemon.spawnChat({ folder, prompt: 'go' });
    await new Promise((r) => setTimeout(r, 30));
    expect(daemon.chatState.get(chatId)?.activity).toBe('errored');
    expect(events.some((e) => e.type === 'chat.error')).toBe(true);
    const seq = activitySequence(events);
    expect(seq).toContain('running');
    expect(seq[seq.length - 1]).toBe('errored');
  });
});

describe('C1 resume with invalid claudeSessionId → errored (spec/04 Resume)', () => {
  it('SDK rejecting the resumed session marks the chat errored and clears the stale session id', async () => {
    // A chat that previously ran (so meta carries claudeSessionId) is resumed
    // after restart; the SDK can no longer find that session. Per spec/04 the
    // chat is marked errored (NO silent proceed) and the stale id is cleared
    // so a subsequent turn can start fresh.
    const home = mkdtempSync(join(tmpdir(), 'patch-resume-'));
    const folder = mkdtempSync(join(tmpdir(), 'patch-resume-folder-'));
    mkdirSync(folder, { recursive: true });
    const metaStore = createMetaStore(home);
    metaStore.write({
      chatId: 'stale-session',
      folder,
      name: null,
      claudeSessionId: 'sess-gone',
      nextSeq: 0,
      createdAt: 1,
      updatedAt: 2,
    });
    const events: WireEvent[] = [];
    const sdk = {
      async *run(o: import('../src/sdkBackend.js').SdkRunOptions) {
        // Resume was attempted with the stale id, and the SDK rejects it.
        expect(o.resumeSessionId).toBe('sess-gone');
        throw new Error('session not found: sess-gone');
        yield { type: 'assistant' as const, content: 'unreachable' };
      },
    };
    const daemon = new Daemon({
      daemonId: 'd1',
      metaStore,
      sdkBackend: sdk,
      oauthAccessToken: 'tok',
      emit: (e) => events.push(e),
      logger: silent,
      now: () => 1_700_000_000_000,
    });
    daemon.hydrate();
    await daemon.sendInput({ chatId: 'stale-session', message: 'hi', localId: 'L1' });

    const errEv = events.find((e) => e.type === 'chat.error');
    expect(errEv && 'error' in errEv && errEv.error.code).toBe('claude_session_invalid');
    expect(daemon.chatState.get('stale-session')?.status).toBe('errored');
    expect(metaStore.read('stale-session')?.claudeSessionId).toBeUndefined();
    daemon.shutdown();
  });
});
