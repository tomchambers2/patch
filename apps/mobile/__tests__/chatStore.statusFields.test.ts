// The Manager's Chats tab ranks and describes rows by each chat's status
// summary, kind and declared flag (spec/15 § Voice tab (Manager)), so the store holds
// them exactly as web's does: from the roster, and from every `chat.state`
// that carries them (omitted = unchanged, explicit null = cleared).

import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from '../src/stores/chatStore';
import { toChatListRow } from '../src/lib/chatListRow';
import type { ChatListRow } from '../src/stores/types';

const base: ChatListRow = {
  chatId: 'c1',
  name: 'n',
  daemonId: 'd1',
  folder: '~/f',
  activity: 'idle',
  permissionMode: 'default',
  status: 'active',
  pinned: false,
  pinnedAt: null,
  lastUpdated: 1,
};

const state = {
  type: 'chat.state' as const,
  permissionMode: 'default' as const,
  chatId: 'c1',
  activity: 'idle' as const,
  lastUpdated: 2,
};

beforeEach(() => {
  useChatStore.getState()._reset();
});

describe('status summary and kind', () => {
  it('the roster mapping carries them through to the store', () => {
    useChatStore.getState().hydrate([
      toChatListRow({
        ...base,
        pendingWake: null,
        snoozedUntil: null,
        statusSummary: 'Waiting on a yes',
        statusKind: 'question',
        statusDeclared: true,
      }),
    ]);
    const row = useChatStore.getState().chats['c1']!;
    expect([row.statusSummary, row.statusKind, row.statusDeclared]).toEqual([
      'Waiting on a yes',
      'question',
      true,
    ]);
  });

  it('a roster row without them keeps what the store already knew', () => {
    useChatStore.getState().hydrate([{ ...base, statusSummary: 'known', statusKind: 'report' }]);
    useChatStore.getState().hydrate([base]);
    const row = useChatStore.getState().chats['c1']!;
    expect(row.statusSummary).toBe('known');
    expect(row.statusKind).toBe('report');
  });

  it('a fresh row starts with none', () => {
    useChatStore.getState().hydrate([base]);
    const row = useChatStore.getState().chats['c1']!;
    expect([row.statusSummary, row.statusKind, row.statusDeclared]).toEqual([null, null, null]);
  });

  it('chat.state sets them, keeps them when omitted, and clears them on an explicit null', () => {
    useChatStore.getState().applyEvent({
      ...state,
      statusSummary: 'Done the thing',
      statusKind: 'report',
      statusDeclared: true,
    });
    useChatStore.getState().applyEvent(state);
    let row = useChatStore.getState().chats['c1']!;
    expect([row.statusSummary, row.statusKind, row.statusDeclared]).toEqual([
      'Done the thing',
      'report',
      true,
    ]);
    useChatStore
      .getState()
      .applyEvent({ ...state, statusSummary: null, statusKind: null, statusDeclared: null });
    row = useChatStore.getState().chats['c1']!;
    expect([row.statusSummary, row.statusKind, row.statusDeclared]).toEqual([null, null, null]);
  });
});
