// The Threads strip's ordering rule (spec/14 § Manager view): every active
// chat on every host, needs-you first, then by recency — and nothing the user
// has already put away.

import { describe, it, expect } from 'vitest';
import { threadRows } from '../components/ThreadsStrip.js';
import { SPECIAL_THREAD_IDS } from '@patch/wire';
import type { ChatRow, PendingPermission } from '../stores/types.js';

const NOW = 1_000_000;

function row(chatId: string, overrides: Partial<ChatRow> = {}): ChatRow {
  return {
    pendingWake: null,
    todos: [],
    snoozedUntil: null,
    chatId,
    daemonId: 'd1',
    permissionMode: 'bypassPermissions',
    name: chatId,
    folder: '/tmp',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: NOW,
    lastUserActivity: NOW,
    awaitingPermission: false,
    lastReadSeq: -1,
    preview: null,
    goal: null,
    goalProgress: null,
    lastGoal: null,
    reminder: null,
    statusSummary: null,
    statusKind: null,
    statusDeclared: null,
    pendingPermissions: [],
    lastSeq: 0,
    jobId: null,
    model: null,
    rateLimitResumingAt: null,
    resumeKind: null,
    ...overrides,
  };
}

const permission: PendingPermission = {
  requestId: 'r1',
  tool: 'Bash',
  description: undefined,
  args: {},
};

function ids(chats: ChatRow[]): string[] {
  return threadRows(Object.fromEntries(chats.map((c) => [c.chatId, c])), NOW).map((c) => c.chatId);
}

describe('threadRows', () => {
  it('puts what needs you first: permission, then question, then working, then the rest', () => {
    expect(
      ids([
        row('idle'),
        row('working', { activity: 'running' }),
        row('question', { statusKind: 'question', statusDeclared: true }),
        row('permission', { pendingPermissions: [permission] }),
      ]),
    ).toEqual(['permission', 'question', 'working', 'idle']);
  });

  it('a GENERATED question guess (not declared) does not rank as needing you', () => {
    expect(
      ids([
        row('idle', { lastUpdated: NOW - 5_000 }),
        row('working', { activity: 'running' }),
        row('guessed-question', {
          statusKind: 'question',
          statusDeclared: false,
          lastUpdated: NOW - 1_000,
        }),
      ]),
    ).toEqual(['working', 'guessed-question', 'idle']);
  });

  it('orders equally-blocked rows by recency', () => {
    expect(
      ids([
        row('older', { lastUpdated: NOW - 10_000 }),
        row('newer', { lastUpdated: NOW - 1_000 }),
      ]),
    ).toEqual(['newer', 'older']);
  });

  it('lists nothing the user has already put away, nor the special threads', () => {
    expect(
      ids([
        row('active'),
        row('archived', { status: 'archived' }),
        row('deleted', { status: 'deleted' }),
        row('snoozed', { snoozedUntil: NOW + 60_000 }),
        row(SPECIAL_THREAD_IDS.manager),
        row(SPECIAL_THREAD_IDS.speakers),
      ]),
    ).toEqual(['active']);
  });

  it('brings a lapsed snooze back on its own, with no event to do it', () => {
    expect(ids([row('lapsed', { snoozedUntil: NOW - 1 })])).toEqual(['lapsed']);
  });
});
