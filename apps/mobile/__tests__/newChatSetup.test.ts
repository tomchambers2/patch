// lib/newChatSetup.ts — the new-chat screen's quick picks (spec/15 § New
// chat flow; web's setup row, spec/14 § Sidebar §8).

import { describe, it, expect } from 'vitest';
import { recentModelPicks } from '../src/lib/newChatSetup';
import type { ChatRow } from '../src/stores/types';

function chat(partial: Partial<ChatRow> & { chatId: string }): ChatRow {
  return {
    daemonId: 'd1',
    folder: '',
    status: 'active',
    lastUpdated: 1,
    model: null,
    jobId: null,
    ...partial,
  } as ChatRow;
}

const byId = (rows: ChatRow[]): Record<string, ChatRow> =>
  Object.fromEntries(rows.map((r) => [r.chatId, r]));

describe('recentModelPicks', () => {
  const catalogue = [
    { id: 'm1', label: 'M1' },
    { id: 'm2', label: 'M2' },
    { id: 'm3', label: 'M3' },
    { id: 'm4', label: 'M4' },
  ];

  it("the host's used models newest first, topped up from the catalogue head", () => {
    const chats = byId([
      chat({ chatId: 'a', model: 'm4', lastUpdated: 2 }),
      chat({ chatId: 'b', model: 'm3', lastUpdated: 3 }),
      chat({ chatId: 'c', model: 'm4', lastUpdated: 1 }),
      chat({ chatId: 'other', model: 'm2', daemonId: 'd2', lastUpdated: 9 }),
      chat({ chatId: 'retired', model: 'gone', lastUpdated: 8 }),
    ]);
    expect(recentModelPicks(chats, 'd1', catalogue).map((m) => m.id)).toEqual(['m3', 'm4', 'm1']);
  });

  // Todoist: "last used should default to last used in a user initiated chat,
  // not a job (jobs often used sonnet)". A job's chat and a special thread run
  // on models set elsewhere, so neither is a model the user last chose.
  it('counts only chats the user started — never a job chat or a special thread', () => {
    const chats = byId([
      chat({ chatId: 'mine', model: 'm3', lastUpdated: 1, jobId: null }),
      chat({ chatId: 'jobchat-j1', model: 'm4', lastUpdated: 9, jobId: 'j1' }),
      chat({ chatId: 'thread_manager', model: 'm2', lastUpdated: 8, jobId: null }),
    ]);
    expect(recentModelPicks(chats, 'd1', catalogue).map((m) => m.id)).toEqual(['m3', 'm1', 'm2']);
  });

  it('an unloaded catalogue offers nothing', () => {
    expect(recentModelPicks(byId([chat({ chatId: 'a', model: 'm1' })]), 'd1', [])).toEqual([]);
  });
});
