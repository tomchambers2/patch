// chatStateFromMeta: hydration mapping, focusing on the errored-chat lastError
// rehydration (G1-d6). An errored chat restored from disk must re-expose its
// persisted error detail instead of showing status:errored + lastError:null.

import { describe, it, expect } from 'vitest';
import { chatStateFromMeta, ChatStateMap, type ChatState } from '../src/chatState.js';
import type { ChatMeta } from '../src/meta.js';

function meta(over: Partial<ChatMeta> = {}): ChatMeta {
  return {
    chatId: 'c1',
    folder: '/work',
    name: null,
    nextSeq: 0,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

describe('chatStateFromMeta: lastError rehydration (G1-d6)', () => {
  it('rehydrates lastError for an errored chat', () => {
    const s = chatStateFromMeta(
      meta({
        status: 'errored',
        lastError: { code: 'sdk_error', message: 'boom', at: 99 },
      }),
    );
    expect(s.status).toBe('errored');
    expect(s.lastError).toEqual({ code: 'sdk_error', message: 'boom', at: 99 });
  });

  it('leaves lastError null for a non-errored chat even if meta carries stale detail', () => {
    const s = chatStateFromMeta(
      meta({
        status: 'active',
        lastError: { code: 'sdk_error', message: 'stale', at: 1 },
      }),
    );
    expect(s.lastError).toBeNull();
  });

  it('errored chat with no persisted detail rehydrates lastError as null', () => {
    const s = chatStateFromMeta(meta({ status: 'errored' }));
    expect(s.status).toBe('errored');
    expect(s.lastError).toBeNull();
  });
});

function makeState(over: Partial<ChatState> = {}): ChatState {
  return {
    chatId: 'c1',
    name: null,
    preview: null,
    folder: '/work',
    activity: 'idle',
    lastMessages: [],
    lastUpdated: 0,
    claudeSessionId: undefined,
    model: undefined,
    permissionMode: undefined,
    nextSeq: 0,
    pinned: false,
    pinnedAt: null,
    status: 'active',
    archivedAt: null,
    createdAt: 0,
    lastError: null,
    ...over,
  };
}

describe('ChatStateMap', () => {
  it('list() returns every set state and delete() removes it', () => {
    const map = new ChatStateMap();
    map.set(makeState({ chatId: 'a' }));
    map.set(makeState({ chatId: 'b' }));
    expect(
      map
        .list()
        .map((s) => s.chatId)
        .sort(),
    ).toEqual(['a', 'b']);
    expect(map.delete('a')).toBe(true);
    expect(map.delete('a')).toBe(false); // already gone
    expect(map.list().map((s) => s.chatId)).toEqual(['b']);
  });

  it('size() reports the number of tracked chats', () => {
    const map = new ChatStateMap();
    expect(map.size()).toBe(0);
    map.set(makeState({ chatId: 'a' }));
    map.set(makeState({ chatId: 'b' }));
    expect(map.size()).toBe(2);
    map.delete('a');
    expect(map.size()).toBe(1);
  });

  it('hydrate() sets a state per meta', () => {
    const map = new ChatStateMap();
    map.hydrate([meta({ chatId: 'a' }), meta({ chatId: 'b' })]);
    expect(map.size()).toBe(2);
    expect(map.get('a')?.chatId).toBe('a');
  });

  describe('resolve()', () => {
    it('resolves an exact chatId', () => {
      const map = new ChatStateMap();
      map.set(makeState({ chatId: '01M3N32N9T7V75JCV7XHY9NRHM' }));
      expect(map.resolve('01M3N32N9T7V75JCV7XHY9NRHM')?.chatId).toBe('01M3N32N9T7V75JCV7XHY9NRHM');
    });

    it('resolves a unique prefix', () => {
      const map = new ChatStateMap();
      map.set(makeState({ chatId: '01M3N32N9T7V75JCV7XHY9NRHM' }));
      map.set(makeState({ chatId: '01OTHERCHATID000000000000' }));
      expect(map.resolve('01M3N32N')?.chatId).toBe('01M3N32N9T7V75JCV7XHY9NRHM');
    });

    it('returns undefined for an ambiguous prefix', () => {
      const map = new ChatStateMap();
      map.set(makeState({ chatId: 'ab1' }));
      map.set(makeState({ chatId: 'ab2' }));
      expect(map.resolve('ab')).toBeUndefined();
    });

    it('returns undefined for a prefix matching nothing', () => {
      const map = new ChatStateMap();
      map.set(makeState({ chatId: 'ab1' }));
      expect(map.resolve('zz')).toBeUndefined();
    });

    it('an exact id wins even when it also prefixes another chat', () => {
      const map = new ChatStateMap();
      map.set(makeState({ chatId: 'ab' }));
      map.set(makeState({ chatId: 'ab1' }));
      expect(map.resolve('ab')?.chatId).toBe('ab');
    });
  });

  it('pushMessage() trims lastMessages once over maxLastMessages', () => {
    const map = new ChatStateMap({ maxLastMessages: 2 });
    map.set(makeState({ chatId: 'a' }));
    map.pushMessage('a', { role: 'user', content: 'one', seq: 0, ts: 10 });
    map.pushMessage('a', { role: 'assistant', content: 'two', seq: 1, ts: 20 });
    map.pushMessage('a', { role: 'user', content: 'three', seq: 2, ts: 30 });
    const s = map.get('a')!;
    expect(s.lastMessages.map((m) => m.content)).toEqual(['two', 'three']);
    expect(s.lastUpdated).toBe(30);
  });

  it('pushMessage() throws for an unknown chatId', () => {
    const map = new ChatStateMap();
    expect(() => map.pushMessage('nope', { role: 'user', content: 'x', seq: 0, ts: 1 })).toThrow(
      /pushMessage: unknown chatId/,
    );
  });

  it('setActivity() clears lastError when leaving errored, keeps it otherwise', () => {
    const map = new ChatStateMap();
    map.set(
      makeState({
        chatId: 'a',
        activity: 'errored',
        lastError: { code: 'x', message: 'm', at: 1 },
      }),
    );
    map.setActivity('a', 'running');
    expect(map.get('a')?.activity).toBe('running');
    expect(map.get('a')?.lastError).toBeNull();

    map.set(makeState({ chatId: 'b', activity: 'idle' }));
    map.setActivity('b', 'errored');
    expect(map.get('b')?.activity).toBe('errored');
    // setActivity itself doesn't set lastError — only clears it on exit.
    expect(map.get('b')?.lastError).toBeNull();
  });

  it('setActivity() throws for an unknown chatId', () => {
    const map = new ChatStateMap();
    expect(() => map.setActivity('nope', 'running')).toThrow(/setActivity: unknown chatId/);
  });

  it('setLastError() sets and clears the error detail', () => {
    const map = new ChatStateMap();
    map.set(makeState({ chatId: 'a' }));
    map.setLastError('a', { code: 'sdk_error', message: 'boom', at: 5 });
    expect(map.get('a')?.lastError).toEqual({ code: 'sdk_error', message: 'boom', at: 5 });
    map.setLastError('a', null);
    expect(map.get('a')?.lastError).toBeNull();
  });

  it('setLastError() throws for an unknown chatId', () => {
    const map = new ChatStateMap();
    expect(() => map.setLastError('nope', null)).toThrow(/setLastError: unknown chatId/);
  });

  it('has() reflects presence', () => {
    const map = new ChatStateMap();
    expect(map.has('a')).toBe(false);
    map.set(makeState({ chatId: 'a' }));
    expect(map.has('a')).toBe(true);
  });
});
