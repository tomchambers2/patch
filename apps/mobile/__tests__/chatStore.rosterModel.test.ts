// The roster carries each chat's model (spec/15 § Composer → model pill). A
// full hydrate and an archived-page mergeRows must both keep a model the store
// already knows when the incoming row does not name one, and take it when it does.

import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from '../src/stores/chatStore';
import type { ChatListRow } from '../src/stores/types';

function row(chatId: string, model?: string | null): ChatListRow {
  return {
    chatId,
    name: chatId,
    daemonId: 'd1',
    folder: '/f',
    activity: 'idle',
    permissionMode: 'default',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    lastUpdated: 1,
    ...(model !== undefined ? { model } : {}),
  } as ChatListRow;
}

beforeEach(() => {
  useChatStore.getState()._reset();
});

describe('chatStore roster model', () => {
  it('hydrate takes a named model and bumps rosterGeneration', () => {
    const gen = useChatStore.getState().rosterGeneration;
    useChatStore.getState().hydrate([row('a', 'claude-opus-5-5')]);
    expect(useChatStore.getState().chats['a']?.model).toBe('claude-opus-5-5');
    expect(useChatStore.getState().rosterGeneration).toBe(gen + 1);
  });

  it('hydrate keeps a known model when the row omits it', () => {
    useChatStore.getState().hydrate([row('a', 'claude-opus-5-5')]);
    useChatStore.getState().hydrate([row('a')]);
    expect(useChatStore.getState().chats['a']?.model).toBe('claude-opus-5-5');
  });

  it('mergeRows keeps a known model when the row omits it, and takes a named one', () => {
    useChatStore.getState().hydrate([row('a', 'claude-opus-5-5')]);
    useChatStore.getState().mergeRows([row('a'), row('b', 'claude-sonnet-5')]);
    const chats = useChatStore.getState().chats;
    expect(chats['a']?.model).toBe('claude-opus-5-5');
    expect(chats['b']?.model).toBe('claude-sonnet-5');
  });

  it('mergeRows of a new row with no model leaves it unknown (null)', () => {
    useChatStore.getState().mergeRows([row('c')]);
    expect(useChatStore.getState().chats['c']?.model).toBeNull();
  });
});
