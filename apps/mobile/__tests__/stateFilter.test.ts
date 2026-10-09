// Filtering the Chats tab list by state (spec/15 § Chats tab; mirrors
// packages/web/src/__tests__/stateFilter.test.ts's `matchesStateFilter`
// coverage — same behaviour, ported field for field).

import { describe, it, expect } from 'vitest';
import { matchesStateFilter } from '../src/lib/stateFilter';
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

describe('matchesStateFilter', () => {
  it('`all` filters nothing', () => {
    for (const r of [row({ chatId: 'a' }), row({ chatId: 'a', status: 'errored' })]) {
      expect(matchesStateFilter(r, 'all')).toBe(true);
    }
  });

  it('`failed` shows only failures', () => {
    expect(matchesStateFilter(row({ chatId: 'a', status: 'errored' }), 'failed')).toBe(true);
    expect(matchesStateFilter(row({ chatId: 'a', activity: 'errored' }), 'failed')).toBe(true);
    expect(matchesStateFilter(row({ chatId: 'a', activity: 'running' }), 'failed')).toBe(false);
    expect(matchesStateFilter(row({ chatId: 'a' }), 'failed')).toBe(false);
  });

  it('`working` includes background and monitoring, not just a live turn', () => {
    expect(matchesStateFilter(row({ chatId: 'a', activity: 'running' }), 'working')).toBe(true);
    expect(matchesStateFilter(row({ chatId: 'a', backgroundTasks: 1 }), 'working')).toBe(true);
    expect(
      matchesStateFilter(
        row({ chatId: 'a', pendingWake: { message: 'check back', fireAt: 1 } }),
        'working',
      ),
    ).toBe(true);
    expect(matchesStateFilter(row({ chatId: 'a', status: 'errored' }), 'working')).toBe(false);
  });

  it('`waiting` covers a permission prompt AND a declared question', () => {
    expect(
      matchesStateFilter(row({ chatId: 'a', activity: 'awaiting-permission' }), 'waiting'),
    ).toBe(true);
    expect(
      matchesStateFilter(
        row({ chatId: 'a', statusKind: 'question', statusDeclared: true }),
        'waiting',
      ),
    ).toBe(true);
    expect(matchesStateFilter(row({ chatId: 'a', activity: 'running' }), 'waiting')).toBe(false);
  });

  it('`waiting` excludes a GENERATED question guess — only a declared one counts', () => {
    expect(
      matchesStateFilter(
        row({ chatId: 'a', statusKind: 'question', statusDeclared: false }),
        'waiting',
      ),
    ).toBe(false);
  });

  it('`done` never includes a failure', () => {
    expect(
      matchesStateFilter(row({ chatId: 'a', lastUpdated: 10, lastVisitedAt: 5 }), 'done'),
    ).toBe(true);
    expect(matchesStateFilter(row({ chatId: 'a' }), 'done')).toBe(true);
    expect(matchesStateFilter(row({ chatId: 'a', status: 'errored' }), 'done')).toBe(false);
  });
});
