// Which chats are valid "send this share to an existing chat" destinations
// (app/share.tsx), and in what order.

import { describe, it, expect } from 'vitest';
import { shareableChats } from '../src/lib/sharePicker';
import type { ChatRow } from '../src/stores/types';

function row(partial: Partial<ChatRow> & { chatId: string }): ChatRow {
  return {
    name: null,
    preview: null,
    folder: '',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    lastUpdated: 1,
    ...partial,
  } as ChatRow;
}

describe('shareableChats', () => {
  it('orders by most recently updated first', () => {
    const chats = {
      old: row({ chatId: 'old', lastUpdated: 1 }),
      new: row({ chatId: 'new', lastUpdated: 3 }),
      mid: row({ chatId: 'mid', lastUpdated: 2 }),
    };
    expect(shareableChats(chats).map((c) => c.chatId)).toEqual(['new', 'mid', 'old']);
  });

  it('excludes archived chats', () => {
    const chats = {
      a: row({ chatId: 'a', status: 'active', lastUpdated: 1 }),
      b: row({ chatId: 'b', status: 'archived', lastUpdated: 2 }),
    };
    expect(shareableChats(chats).map((c) => c.chatId)).toEqual(['a']);
  });

  it('excludes deleted chats', () => {
    const chats = {
      a: row({ chatId: 'a', status: 'active', lastUpdated: 1 }),
      b: row({ chatId: 'b', status: 'deleted', lastUpdated: 2 }),
    };
    expect(shareableChats(chats).map((c) => c.chatId)).toEqual(['a']);
  });

  it('keeps an errored chat — still a real destination', () => {
    const chats = { a: row({ chatId: 'a', status: 'errored', lastUpdated: 1 }) };
    expect(shareableChats(chats).map((c) => c.chatId)).toEqual(['a']);
  });

  it('is empty for no chats', () => {
    expect(shareableChats({})).toEqual([]);
  });
});
