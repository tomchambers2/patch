// The chat store carries goal / reminder / task list / disabled — the data the
// chat-detail status bars and the ⋯ menu's Disable read (spec/15 § Chat
// detail). Same rules as web's store: the roster seeds them, `chat.state`
// updates them, an explicit null / [] clears, and an OMITTED field (an older
// server or host, or a state event about something else) keeps what is known.

import { describe, it, expect, beforeEach } from 'vitest';
import type { WireEvent } from '@patch/wire';
import { useChatStore } from '../src/stores/chatStore';
import { toChatListRow } from '../src/lib/chatListRow';
import type { ChatListEntry } from '../src/api/rest';

const ENTRY: ChatListEntry = {
  chatId: 'c1',
  name: 'Chat',
  daemonId: 'd1',
  folder: '/f',
  activity: 'idle',
  permissionMode: 'auto',
  status: 'active',
  pinned: false,
  pinnedAt: null,
  lastUpdated: 1,
  pendingWake: null,
  snoozedUntil: null,
};

function state(extra: Record<string, unknown>): WireEvent {
  return {
    type: 'chat.state',
    chatId: 'c1',
    activity: 'idle',
    permissionMode: 'auto',
    lastUpdated: 2,
    ...extra,
  } as WireEvent;
}

const chat = () => useChatStore.getState().chats['c1']!;

beforeEach(() => {
  useChatStore.getState()._reset();
});

describe('chatStore — goal / reminder / todos / disabled', () => {
  it('a row with none of them known starts empty, not undefined', () => {
    useChatStore.getState().hydrate([toChatListRow(ENTRY)]);
    expect(chat().goal).toBeNull();
    expect(chat().reminder).toBeNull();
    expect(chat().todos).toEqual([]);
    expect(chat().disabled).toBe(false);
  });

  it('the roster seeds them', () => {
    useChatStore.getState().hydrate([
      toChatListRow({
        ...ENTRY,
        goal: 'g',
        reminder: 'r',
        todos: [{ text: 't', status: 'pending' }],
        disabled: true,
      }),
    ]);
    expect(chat().goal).toBe('g');
    expect(chat().reminder).toBe('r');
    expect(chat().todos).toEqual([{ text: 't', status: 'pending' }]);
    expect(chat().disabled).toBe(true);
  });

  it('a roster row that omits them keeps what the store already knew', () => {
    useChatStore.getState().hydrate([toChatListRow({ ...ENTRY, goal: 'g', disabled: true })]);
    useChatStore.getState().hydrate([toChatListRow(ENTRY)]);
    expect(chat().goal).toBe('g');
    expect(chat().disabled).toBe(true);
  });

  it('chat.state sets and clears them; an omitted field is unchanged', () => {
    useChatStore.getState().hydrate([toChatListRow(ENTRY)]);
    useChatStore
      .getState()
      .applyEvent(state({ goal: 'g', reminder: 'r', todos: [{ text: 't', status: 'pending' }] }));
    expect(chat().goal).toBe('g');
    useChatStore.getState().applyEvent(state({}));
    expect(chat().goal).toBe('g');
    expect(chat().todos).toHaveLength(1);
    useChatStore
      .getState()
      .applyEvent(state({ goal: null, reminder: null, todos: [], disabled: true }));
    expect(chat().goal).toBeNull();
    expect(chat().reminder).toBeNull();
    expect(chat().todos).toEqual([]);
    expect(chat().disabled).toBe(true);
  });

  it('the optimistic setters write the row', () => {
    useChatStore.getState().hydrate([toChatListRow(ENTRY)]);
    const s = useChatStore.getState();
    s.setGoal('c1', 'x');
    s.setReminder('c1', 'y');
    s.setTodos('c1', [{ text: 'z', status: 'completed' }]);
    s.setDisabled('c1', true);
    expect(chat()).toMatchObject({
      goal: 'x',
      reminder: 'y',
      todos: [{ text: 'z', status: 'completed' }],
      disabled: true,
    });
  });
});
