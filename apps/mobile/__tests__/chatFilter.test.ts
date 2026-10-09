// Chats-tab search is instant client-side filtering (spec/15 ## Chats tab
// § Search, rules shared with spec/14 § Archived search): name + preview,
// case-insensitive, trimmed, preserving the incoming order.
import { describe, it, expect } from 'vitest';
import { filterChats } from '../src/lib/chatFilter';
import type { ChatRow } from '../src/stores/types';

function row(partial: Partial<ChatRow> & { chatId: string }): ChatRow {
  return {
    name: null,
    preview: null,
    folder: '',
    activity: 'idle',
    status: 'archived',
    pinned: false,
    pinnedAt: null,
    lastUpdated: 1,
    ...partial,
  } as ChatRow;
}

describe('filterChats (mobile)', () => {
  const rows = [
    row({ chatId: 'a1', name: 'Pancake recipe', preview: 'maple syrup' }),
    row({ chatId: 'a2', name: 'Sea essay', preview: 'the ocean tides' }),
    row({ chatId: 'a3', name: null, preview: 'talking about PANCAKES again' }),
  ];

  it('returns the full list for an empty query', () => {
    expect(filterChats(rows, '').map((r) => r.chatId)).toEqual(['a1', 'a2', 'a3']);
  });

  it('returns the full list for a whitespace-only query', () => {
    expect(filterChats(rows, '  ').map((r) => r.chatId)).toEqual(['a1', 'a2', 'a3']);
  });

  it('matches the name', () => {
    expect(filterChats(rows, 'sea').map((r) => r.chatId)).toEqual(['a2']);
  });

  it('matches the preview', () => {
    expect(filterChats(rows, 'maple').map((r) => r.chatId)).toEqual(['a1']);
  });

  it('matches case-insensitively across both fields', () => {
    expect(filterChats(rows, 'PaNcAkE').map((r) => r.chatId)).toEqual(['a1', 'a3']);
  });

  it('trims the query', () => {
    expect(filterChats(rows, '  tides ').map((r) => r.chatId)).toEqual(['a2']);
  });

  it('preserves the incoming order rather than ranking', () => {
    const reversed = [...rows].reverse();
    expect(filterChats(reversed, 'pancake').map((r) => r.chatId)).toEqual(['a3', 'a1']);
  });

  it('returns nothing when nothing matches', () => {
    expect(filterChats(rows, 'zzz-quokka')).toEqual([]);
  });
});
