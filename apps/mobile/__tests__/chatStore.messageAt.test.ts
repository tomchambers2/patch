// spec/15 § Chat detail — the long-press "Show time" action's real arrival
// time. Ported from packages/web/src/__tests__/chatStore.messageAt.test.ts:
// `chat.message.createdAt` is the ONE honest source for a message's time —
// the store's own `at` field is stamped `Date.now()` the instant a FRAME
// arrives, which is "now" on every replay. `messageAt` carries `createdAt`
// through untouched (never invented, never derived from `at`).

import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from '../src/stores/chatStore';

function timeline() {
  return useChatStore.getState().timelines['c1'] ?? [];
}

beforeEach(() => {
  useChatStore.getState()._reset();
});

describe('chatStore — messageAt (the real time a message was written)', () => {
  it('carries createdAt through onto the entry as messageAt', () => {
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

  it('reconciles an optimistic outgoing user message with the persisted messageAt', () => {
    useChatStore.getState().appendLocalUserMessage('c1', 'hi there', 'lid-1');
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

  it('a replayed already-held message picks up messageAt if the replay carries it and the first frame did not', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'assistant',
      content: 'hello',
      seq: 2,
    });
    expect(timeline().find((e) => e.kind === 'message')?.messageAt).toBeUndefined();
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'assistant',
      content: 'hello',
      seq: 2,
      createdAt: 1_700_000_002_000,
    });
    const entry = timeline().find((e) => e.kind === 'message');
    expect(entry?.messageAt).toBe(1_700_000_002_000);
  });
});
