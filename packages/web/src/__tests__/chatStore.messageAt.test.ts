// spec/14 § Messages — the per-message meta strip's real arrival time.
//
// `chat.message.createdAt` is the ONE honest source for a message's time: the
// store's own `at` field is stamped `Date.now()` the instant a FRAME arrives,
// which is correct for a message that just streamed in live but wrong on
// replay — reopening a chat re-fetches history and every message would get
// "now" as `at`. `messageAt` carries `createdAt` through untouched (never
// invented, never derived from `at`) so the UI can tell "the host told me
// the real time" from "I have no idea".

import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from '../stores/chatStore.js';

function spawn(): void {
  useChatStore
    .getState()
    .applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
}

function timeline() {
  return useChatStore.getState().timelines['c1'] ?? [];
}

describe('chatStore — messageAt (the real time a message was written)', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    localStorage.removeItem('patch.readState.v1');
  });

  it('carries createdAt through onto the entry as messageAt', () => {
    spawn();
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'assistant',
      content: 'hello',
      seq: 2,
      createdAt: 1_700_000_000_000,
    });
    const entry = timeline().find((e) => e.kind === 'message');
    expect(entry?.messageAt).toBe(1_700_000_000_000);
  });

  it('leaves messageAt unset when the event carries no createdAt — never invents one', () => {
    spawn();
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'assistant',
      content: 'hello',
      seq: 2,
    });
    const entry = timeline().find((e) => e.kind === 'message');
    expect(entry?.messageAt).toBeUndefined();
    // `at` (client-arrival bookkeeping) is still set — the two are distinct.
    expect(entry?.at).toEqual(expect.any(Number));
  });

  it('does not conflate messageAt with at — a replayed message keeps its own time, not "now"', () => {
    spawn();
    const before = Date.now();
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'user',
      content: 'an old message',
      seq: 2,
      // A transcript line from last week — nowhere near "now".
      createdAt: 1_600_000_000_000,
    });
    const entry = timeline().find((e) => e.kind === 'message');
    expect(entry?.messageAt).toBe(1_600_000_000_000);
    expect(entry?.at).toBeGreaterThanOrEqual(before);
  });

  it('finalising a streamed assistant reply picks up createdAt from the settling chat.message', () => {
    spawn();
    useChatStore.getState().applyEvent({
      type: 'chat.message_delta',
      chatId: 'c1',
      messageSeq: 5,
      delta: 'wor',
    });
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'assistant',
      content: 'working on it',
      seq: 5,
      createdAt: 1_700_000_000_500,
    });
    const entry = timeline().find((e) => e.kind === 'message' && e.role === 'assistant');
    expect(entry?.content).toBe('working on it');
    expect(entry?.streaming).toBe(false);
    expect(entry?.messageAt).toBe(1_700_000_000_500);
  });

  it('reconciles an optimistic outgoing user message with the persisted messageAt', () => {
    spawn();
    useChatStore.getState().addLocalMessage('c1', 'hi there', 'lid-1');
    expect(timeline().find((e) => e.kind === 'message')?.messageAt).toBeUndefined();
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'user',
      content: 'hi there',
      seq: 3,
      localId: 'lid-1',
      createdAt: 1_700_000_001_000,
    });
    const entry = timeline().find((e) => e.kind === 'message');
    expect(entry?.localId).toBeUndefined();
    expect(entry?.messageAt).toBe(1_700_000_001_000);
  });
});
