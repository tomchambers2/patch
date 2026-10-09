// spec/02 § Questions are not approvals — a pending question's deadline is
// reset by `chat.focus_change` (Tom, Todoist: "the question timer should
// reset when you view the chat, and then start again when unfocused"): every
// edge that touches its chat, gained or lost, gives it a fresh full window.

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { QUESTION_EXPIRY_SECONDS_DEFAULT } from '@patch/wire';
import { Daemon, APPROVAL_ANSWER_TIMEOUT_MS } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });
const NOW = 1_700_000_000_000;
const WINDOW_MS = QUESTION_EXPIRY_SECONDS_DEFAULT * 1000;

function setup(opts: { permissionModeDefault?: 'default' } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'patch-qfocus-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-qfocus-folder-')));
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
    now: () => NOW,
    generateChatId: () => `chat-${++id}`,
    ...(opts.permissionModeDefault ? { permissionModeDefault: opts.permissionModeDefault } : {}),
  });
  return { daemon, events, folder };
}

function request(events: WireEvent[]): { requestId: string; chatId: string } {
  const req = events.find((e) => e.type === 'chat.permission_request');
  expect(req, 'no chat.permission_request was emitted').toBeDefined();
  return req as unknown as { requestId: string; chatId: string };
}

function expiryUpdates(
  events: WireEvent[],
): { chatId: string; requestId: string; expiry: { at: number; windowMs: number } }[] {
  return events.filter((e) => e.type === 'chat.permission_expiry_update') as unknown as {
    chatId: string;
    requestId: string;
    expiry: { at: number; windowMs: number };
  }[];
}

function response(events: WireEvent[]): { decision: string } | undefined {
  return events.find((e) => e.type === 'chat.permission_response') as
    | { decision: string }
    | undefined;
}

describe('a question timer resets on chat.focus_change', () => {
  it('gaining focus on the chat gives the countdown a fresh window', async () => {
    vi.useFakeTimers();
    try {
      const { daemon, events, folder } = setup();
      const chatId = await daemon.spawnChat({ folder, prompt: '[[ask-user-question]]' });
      await vi.advanceTimersByTimeAsync(50);
      const { requestId } = request(events);

      // Most of the original window elapses with nobody looking.
      await vi.advanceTimersByTimeAsync(WINDOW_MS - 10_000);
      expect(response(events)).toBeUndefined();

      // Tom opens the chat.
      daemon.noteChatFocus('surface-1', chatId);

      const updates = expiryUpdates(events);
      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({ chatId, requestId, expiry: { windowMs: WINDOW_MS } });

      // Well past where the ORIGINAL deadline would have fired, but well
      // inside the fresh window the reset just granted.
      await vi.advanceTimersByTimeAsync(WINDOW_MS - 10_000);
      expect(response(events)).toBeUndefined();
      expect(daemon.chatState.get(chatId)?.activity).toBe('awaiting-permission');

      // Now the reset window itself runs out.
      await vi.advanceTimersByTimeAsync(20_000);
      expect(response(events)?.decision).toBe('deny');
    } finally {
      vi.useRealTimers();
    }
  });

  it('losing focus on the chat also gives it a fresh window', async () => {
    vi.useFakeTimers();
    try {
      const { daemon, events, folder } = setup();
      const chatId = await daemon.spawnChat({ folder, prompt: '[[ask-user-question]]' });
      await vi.advanceTimersByTimeAsync(50);

      daemon.noteChatFocus('surface-1', chatId); // gained
      await vi.advanceTimersByTimeAsync(WINDOW_MS - 10_000);
      expect(response(events)).toBeUndefined();

      daemon.noteChatFocus('surface-1', null); // lost
      expect(expiryUpdates(events)).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(WINDOW_MS - 10_000);
      expect(response(events)).toBeUndefined();

      await vi.advanceTimersByTimeAsync(20_000);
      expect(response(events)?.decision).toBe('deny');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a repeat of the same focus value is not an edge and does not reset', async () => {
    vi.useFakeTimers();
    try {
      const { daemon, events, folder } = setup();
      const chatId = await daemon.spawnChat({ folder, prompt: '[[ask-user-question]]' });
      await vi.advanceTimersByTimeAsync(50);

      daemon.noteChatFocus('surface-1', chatId);
      daemon.noteChatFocus('surface-1', chatId);
      daemon.noteChatFocus('surface-1', chatId);
      expect(expiryUpdates(events)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('focus on an unrelated chat does not touch this one', async () => {
    vi.useFakeTimers();
    try {
      const { daemon, events, folder } = setup();
      const folder2 = realpathSync(mkdtempSync(join(tmpdir(), 'patch-qfocus-folder2-')));
      mkdirSync(folder2, { recursive: true });
      const chatA = await daemon.spawnChat({ folder, prompt: '[[ask-user-question]]' });
      await vi.advanceTimersByTimeAsync(50);
      const chatB = await daemon.spawnChat({ folder: folder2, prompt: '[[ask-user-question]]' });
      await vi.advanceTimersByTimeAsync(50);

      daemon.noteChatFocus('surface-1', chatA);
      const updates = expiryUpdates(events);
      expect(updates).toHaveLength(1);
      expect(updates[0]?.chatId).toBe(chatA);
      expect(updates.some((u) => u.chatId === chatB)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an ordinary tool approval ignores focus — only a question resets this way', async () => {
    vi.useFakeTimers();
    try {
      const { daemon, events, folder } = setup({ permissionModeDefault: 'default' });
      const chatId = await daemon.spawnChat({ folder, prompt: '[[bash-permission]]' });
      await vi.advanceTimersByTimeAsync(50);

      daemon.noteChatFocus('surface-1', chatId);
      daemon.noteChatFocus('surface-1', null);
      expect(expiryUpdates(events)).toHaveLength(0);

      // The approval's own fixed window still governs it, untouched.
      await vi.advanceTimersByTimeAsync(APPROVAL_ANSWER_TIMEOUT_MS + 1000);
      expect(response(events)?.decision).toBe('deny');
    } finally {
      vi.useRealTimers();
    }
  });

  it('question expiry turned off: focus does nothing, nothing to reset', async () => {
    vi.useFakeTimers();
    try {
      const { daemon, events, folder } = setup();
      daemon.setQuestionExpiry({ enabled: false });
      const chatId = await daemon.spawnChat({ folder, prompt: '[[ask-user-question]]' });
      await vi.advanceTimersByTimeAsync(50);

      expect(() => daemon.noteChatFocus('surface-1', chatId)).not.toThrow();
      expect(expiryUpdates(events)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an answered question is never re-armed by a later focus change', async () => {
    vi.useFakeTimers();
    try {
      const { daemon, events, folder } = setup();
      const chatId = await daemon.spawnChat({ folder, prompt: '[[ask-user-question]]' });
      await vi.advanceTimersByTimeAsync(50);
      const { requestId } = request(events);

      daemon.submitPermissionResponse({ requestId, decision: 'deny' });
      await vi.advanceTimersByTimeAsync(10);

      daemon.noteChatFocus('surface-1', chatId);
      expect(expiryUpdates(events)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
