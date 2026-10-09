// Telling a host how far the server's log of a chat reaches (spec/01 § Message
// log): one frame per chat for a burst, never for a host that is gone.

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { WireEvent } from '@patch/wire';
import { COMMIT_ACK_DELAY_MS, CommitAcks } from '../src/commit-acks.js';

describe('CommitAcks', () => {
  let sent: Array<{ daemonId: string; surfaceId: string; event: WireEvent }>;
  let online: Set<string>;

  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    online = new Set(['d1', 'd2']);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const make = (delayMs?: number): CommitAcks =>
    new CommitAcks({
      sendTo: (daemonId, surfaceId, event) => sent.push({ daemonId, surfaceId, event }),
      isOnline: (id) => online.has(id),
      ...(delayMs !== undefined ? { delayMs } : {}),
    });

  test('sends one frame per chat after a short wait, naming how far the log reaches', () => {
    const acks = make();
    acks.note('c1', 'd1', 3);
    acks.note('c1', 'd1', 7);
    acks.note('c1', 'd1', 5); // an older number never lowers it
    acks.note('c2', 'd2', 2);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(COMMIT_ACK_DELAY_MS);
    expect(sent.map((s) => [s.daemonId, s.event])).toEqual([
      ['d1', { type: 'chat.committed', chatId: 'c1', through: 7 }],
      ['d2', { type: 'chat.committed', chatId: 'c2', through: 2 }],
    ]);
    expect(sent.every((s) => s.surfaceId === '_server')).toBe(true);
  });

  test('uses the host the chat was last noted on', () => {
    const acks = make();
    acks.note('c1', 'd1', 1);
    acks.note('c1', 'd2', 2);
    vi.advanceTimersByTime(COMMIT_ACK_DELAY_MS);
    expect(sent.map((s) => s.daemonId)).toEqual(['d2']);
  });

  test('waits as long as it was told to', () => {
    const acks = make(500);
    acks.note('c1', 'd1', 1);
    vi.advanceTimersByTime(499);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent).toHaveLength(1);
  });

  test('starts a new wait for what comes after a send', () => {
    const acks = make();
    acks.note('c1', 'd1', 1);
    vi.advanceTimersByTime(COMMIT_ACK_DELAY_MS);
    acks.note('c1', 'd1', 2);
    vi.advanceTimersByTime(COMMIT_ACK_DELAY_MS);
    expect(sent.map((s) => (s.event as { through: number }).through)).toEqual([1, 2]);
  });

  test('says nothing to a host that is offline: it is told when it comes back', () => {
    const acks = make();
    acks.note('c1', 'd1', 4);
    online.delete('d1');
    vi.advanceTimersByTime(COMMIT_ACK_DELAY_MS);
    expect(sent).toEqual([]);
  });

  test('send() does it at once, and again with nothing waiting does nothing', () => {
    const acks = make();
    acks.note('c1', 'd1', 4);
    acks.send();
    expect(sent).toHaveLength(1);
    acks.send();
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(COMMIT_ACK_DELAY_MS * 2);
    expect(sent).toHaveLength(1);
  });

  test('stop() drops what was waiting', () => {
    const acks = make();
    acks.note('c1', 'd1', 4);
    acks.stop();
    vi.advanceTimersByTime(COMMIT_ACK_DELAY_MS * 2);
    expect(sent).toEqual([]);
    acks.stop();
  });
});
