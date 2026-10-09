// Needs-attention filter + FIFO queue (spec/15 § Needs attention; mirrors
// packages/web/src/lib/chatGroups.ts's `needsAttention` / `sortAttentionQueue`
// test coverage).

import { describe, it, expect } from 'vitest';
import { needsAttention, sortAttentionQueue } from '../src/lib/attentionQueue';
import type { ChatRow } from '../src/stores/types';

function row(overrides: Partial<ChatRow> & { chatId: string }): ChatRow {
  return {
    name: null,
    daemonId: 'd1',
    folder: '~/proj',
    activity: 'idle',
    permissionMode: 'bypassPermissions',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    lastUpdated: 0,
    awaitingPermission: false,
    lastVisitedAt: 5,
    preview: null,
    pendingPermissions: [],
    lastSeq: 5,
    pendingWake: null,
    snoozedUntil: null,
    backgroundTasks: null,
    model: null,
    jobId: null,
    statusSummary: null,
    statusKind: null,
    statusDeclared: null,
    goal: null,
    reminder: null,
    todos: [],
    disabled: false,
    ...overrides,
  };
}

describe('needsAttention', () => {
  it('is true for a done (finished, unread) chat', () => {
    expect(needsAttention(row({ chatId: 'a', lastUpdated: 10, lastVisitedAt: 5 }))).toBe(true);
  });

  it('is true for a permission (awaiting-permission) chat', () => {
    expect(needsAttention(row({ chatId: 'a', activity: 'awaiting-permission' }))).toBe(true);
  });

  it('is true for an errored chat', () => {
    expect(needsAttention(row({ chatId: 'a', activity: 'errored' }))).toBe(true);
    expect(needsAttention(row({ chatId: 'a', status: 'errored' as ChatRow['status'] }))).toBe(true);
  });

  it('is true for a declared question, even once read', () => {
    expect(
      needsAttention(
        row({
          chatId: 'a',
          statusKind: 'question',
          statusDeclared: true,
          lastUpdated: 5,
          lastVisitedAt: 9,
        }),
      ),
    ).toBe(true);
  });

  it('is false for an UNdeclared question — only a declared one needs attention', () => {
    expect(
      needsAttention(
        row({
          chatId: 'a',
          statusKind: 'question',
          statusDeclared: false,
          lastUpdated: 5,
          lastVisitedAt: 9,
        }),
      ),
    ).toBe(false);
  });

  it('is true for a report, even once read', () => {
    expect(
      needsAttention(row({ chatId: 'a', statusKind: 'report', lastUpdated: 5, lastVisitedAt: 9 })),
    ).toBe(true);
  });

  it('is false for a working (still going) chat', () => {
    expect(needsAttention(row({ chatId: 'a', activity: 'running' }))).toBe(false);
  });

  it('is false for an already-read chat with no declared question/report', () => {
    expect(needsAttention(row({ chatId: 'a', lastUpdated: 5, lastVisitedAt: 9 }))).toBe(false);
  });

  it('is false for background/monitoring — not yet a result to look at', () => {
    expect(
      needsAttention(row({ chatId: 'a', lastUpdated: 5, lastVisitedAt: 9, backgroundTasks: 2 })),
    ).toBe(false);
    expect(
      needsAttention(
        row({
          chatId: 'a',
          lastUpdated: 5,
          lastVisitedAt: 9,
          pendingWake: { message: 'check back', fireAt: 1 },
        }),
      ),
    ).toBe(false);
  });
});

describe('sortAttentionQueue', () => {
  it('queues oldest-updated first (FIFO), most-recent last', () => {
    const rows = [
      row({ chatId: 'c', lastUpdated: 300, lastVisitedAt: 0 }),
      row({ chatId: 'a', lastUpdated: 100, lastVisitedAt: 0 }),
      row({ chatId: 'b', lastUpdated: 200, lastVisitedAt: 0 }),
    ];
    expect(sortAttentionQueue(rows).map((r) => r.chatId)).toEqual(['a', 'b', 'c']);
  });

  it('permission rows lead the queue regardless of recency', () => {
    const rows = [
      row({ chatId: 'done-old', lastUpdated: 10, lastVisitedAt: 0 }),
      row({ chatId: 'perm-new', activity: 'awaiting-permission', lastUpdated: 999 }),
      row({ chatId: 'done-new', lastUpdated: 500, lastVisitedAt: 0 }),
    ];
    expect(sortAttentionQueue(rows).map((r) => r.chatId)).toEqual([
      'perm-new',
      'done-old',
      'done-new',
    ]);
  });

  it('two permission rows between themselves queue oldest-updated first', () => {
    const rows = [
      row({ chatId: 'p2', activity: 'awaiting-permission', lastUpdated: 200 }),
      row({ chatId: 'p1', activity: 'awaiting-permission', lastUpdated: 100 }),
    ];
    expect(sortAttentionQueue(rows).map((r) => r.chatId)).toEqual(['p1', 'p2']);
  });

  it('breaks a tie in lastUpdated by chatId, stably', () => {
    const rows = [
      row({ chatId: 'b', lastUpdated: 100, lastVisitedAt: 0 }),
      row({ chatId: 'a', lastUpdated: 100, lastVisitedAt: 0 }),
    ];
    expect(sortAttentionQueue(rows).map((r) => r.chatId)).toEqual(['a', 'b']);
  });

  it('does not mutate the input array', () => {
    const rows = [
      row({ chatId: 'b', lastUpdated: 200, lastVisitedAt: 0 }),
      row({ chatId: 'a', lastUpdated: 100, lastVisitedAt: 0 }),
    ];
    const copy = [...rows];
    sortAttentionQueue(rows);
    expect(rows).toEqual(copy);
  });
});
