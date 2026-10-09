// What the server-run queue and the server-held log added to the wire must not
// break a reader that predates it (spec/03 § Forward compatibility): surfaces
// tolerate an unknown FIELD and an unknown event TYPE, but a value outside a
// known enum is refused as malformed, so a new meaning must ride on a field.

import { describe, it, expect } from 'vitest';
import { decode, decodeCompat, encode, type WireEvent } from '../src/index.js';

describe('a message taken in at a tool boundary', () => {
  const taken: WireEvent = {
    type: 'chat.dequeued',
    chatId: 'c1',
    localId: 'L1',
    reason: 'running',
    delivered: true,
  };

  it('is an ordinary running dequeue plus one optional flag', () => {
    expect(decode(encode(taken))).toEqual(taken);
    const without = { type: 'chat.dequeued', chatId: 'c1', localId: 'L1', reason: 'running' };
    expect(decode(JSON.stringify(without))).toEqual(without);
  });

  it('does not add a value to the reason enum, which an older surface would refuse', () => {
    const asNewReason = JSON.stringify({ ...taken, reason: 'delivered', delivered: undefined });
    expect(() => decode(asNewReason)).toThrow();
  });

  it('is tolerated by a reader that has never heard of the flag', () => {
    // The old reader's schema is this one without `delivered`: an unknown key on a known event.
    const result = decodeCompat(JSON.stringify({ ...taken, somethingNewer: true }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tolerated).toEqual(['chat.dequeued.somethingNewer']);
  });
});

describe('what a newer server adds to frames an older host or surface reads', () => {
  it('chat.state carries lastSeq as an optional field', () => {
    const base = {
      type: 'chat.state',
      chatId: 'c1',
      daemonId: 'd1',
      activity: 'idle',
      permissionMode: 'auto',
      folder: '/w',
      lastUpdated: 1,
    };
    expect(decode(JSON.stringify(base)).type).toBe('chat.state');
    expect(decode(JSON.stringify({ ...base, lastSeq: 9 })).type).toBe('chat.state');
  });

  it('a frame type an older reader lacks is dropped, not refused', () => {
    for (const type of [
      'chat.committed',
      'server.queue_mode',
      'patch.queue_pull.request',
      'patch.log_sync.request',
      'patch.log_restore',
      'host.manager_adopt',
    ]) {
      const result = decodeCompat(JSON.stringify({ type: `${type}.future`, chatId: 'c1' }));
      expect(result.ok).toBe(false);
    }
  });

  it('a user message taken in mid-turn is a plain message with one optional flag', () => {
    const message = {
      type: 'chat.message',
      chatId: 'c1',
      role: 'user',
      content: 'hi',
      seq: 3,
    };
    expect(decode(JSON.stringify(message)).type).toBe('chat.message');
    expect(decode(JSON.stringify({ ...message, midTurn: true })).type).toBe('chat.message');
  });
});
