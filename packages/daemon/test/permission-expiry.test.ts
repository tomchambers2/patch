// An unanswered TOOL APPROVAL expires, the way an unanswered question already
// did (chatRunner.ts § APPROVAL_ANSWER_TIMEOUT_MS).
//
// The case this exists for is a job fire. `bypassPermissions` does not stop the
// SDK escalating its own safety checks through `canUseTool`, so an unattended
// `app-update` worker can be handed an approval card nobody will ever see —
// and one was: it built its feature, committed it, parked on an `rm -rf`
// cleanup and never pushed. A wedged chat frees its queue slot and reads as
// idle rather than failed, so nothing downstream noticed for hours.
//
// Driven through the mock backend's `[[bash-permission]]` trigger under the
// blocking `default` mode. The mode is incidental: the fix arms the expiry for
// every request regardless of mode, and `default` is simply the one the mock
// will block an ordinary Bash call under.

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { QUESTION_EXPIRY_SECONDS_DEFAULT } from '@patch/wire';
import { Daemon, APPROVAL_ANSWER_TIMEOUT_MS, APPROVAL_EXPIRED_MESSAGE } from '../src/chatRunner.js';

/** The default question window in ms — the setting's default, not a constant. */
const QUESTION_ANSWER_TIMEOUT_MS = QUESTION_EXPIRY_SECONDS_DEFAULT * 1000;
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'patch-permexp-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-permexp-folder-')));
  mkdirSync(folder, { recursive: true });
  const events: WireEvent[] = [];
  let id = 0;
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: createMockSdkBackend(),
    oauthAccessToken: 'fake-token',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${++id}`,
    permissionModeDefault: 'default',
  });
  return { daemon, events, folder };
}

function permissionRequest(events: WireEvent[]): { requestId: string } {
  const req = events.find((e) => e.type === 'chat.permission_request');
  expect(req).toBeDefined();
  return req as unknown as { requestId: string };
}

function bashResult(events: WireEvent[]): { result: string } | undefined {
  return events.find((e) => e.type === 'chat.tool_result' && e.tool === 'Bash') as
    | { result: string }
    | undefined;
}

describe('an unanswered tool approval expires', () => {
  it('waits the full approval window, then denies with the truth and settles the chat', async () => {
    vi.useFakeTimers();
    try {
      const { daemon, events, folder } = setup();
      const chatId = await daemon.spawnChat({ folder, prompt: '[[bash-permission]]' });
      await vi.advanceTimersByTimeAsync(50);
      permissionRequest(events);
      expect(daemon.chatState.get(chatId)?.activity).toBe('awaiting-permission');

      // A question's window passing is not enough — an approval gets longer.
      await vi.advanceTimersByTimeAsync(QUESTION_ANSWER_TIMEOUT_MS + 1000);
      expect(daemon.chatState.get(chatId)?.activity).toBe('awaiting-permission');

      // Just short of its own deadline it is still waiting: a real timer, not
      // an immediate give-up.
      await vi.advanceTimersByTimeAsync(
        APPROVAL_ANSWER_TIMEOUT_MS - QUESTION_ANSWER_TIMEOUT_MS - 2000,
      );
      expect(daemon.chatState.get(chatId)?.activity).toBe('awaiting-permission');

      await vi.advanceTimersByTimeAsync(5000);

      // The agent is told nobody answered — NOT that the user refused.
      const result = bashResult(events);
      expect(result?.result).toBe(APPROVAL_EXPIRED_MESSAGE);
      expect(result?.result).toContain('did not refuse');
      // And the chat is unwedged: it reached a settled state on its own.
      expect(daemon.chatState.get(chatId)?.activity).toBe('idle');
    } finally {
      vi.useRealTimers();
    }
  });

  it('an answered approval never expires', async () => {
    vi.useFakeTimers();
    try {
      const { daemon, events, folder } = setup();
      const chatId = await daemon.spawnChat({ folder, prompt: '[[bash-permission]]' });
      await vi.advanceTimersByTimeAsync(50);
      const req = permissionRequest(events);

      daemon.submitPermissionResponse({ requestId: req.requestId, decision: 'approve' });
      await vi.advanceTimersByTimeAsync(50);

      // Well past the deadline, the approved call's result stands — the expiry
      // timer was cleared rather than firing over the top of it.
      await vi.advanceTimersByTimeAsync(APPROVAL_ANSWER_TIMEOUT_MS * 2);
      expect(bashResult(events)?.result).not.toBe(APPROVAL_EXPIRED_MESSAGE);
      expect(daemon.chatState.get(chatId)?.activity).toBe('idle');
    } finally {
      vi.useRealTimers();
    }
  });
});
