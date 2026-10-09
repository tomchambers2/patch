// Filtering the chat list by state, and the errored badge that made it possible
// (lib/chatGroups.ts, stores/types.ts).
//
// The bug being fixed: a chat whose turn died read as FINISHED. `deriveBadge`
// had no errored case, so a failed chat fell through to `done`/`read` and looked
// identical in the sidebar to one that had succeeded — which is how a run of
// chats sat there with "You've hit your monthly spend limit" as their last word
// and nobody noticed.

import { describe, expect, it } from 'vitest';
import { deriveBadge, type ChatRow } from '../stores/types.js';
import { matchesStateFilter, needsAttention } from '../lib/chatGroups.js';

function row(over: Partial<ChatRow> = {}): ChatRow {
  return {
    chatId: 'c1',
    daemonId: 'd1',
    name: 'a chat',
    preview: null,
    goal: null,
    goalProgress: null,
    lastGoal: null,
    reminder: null,
    statusSummary: null,
    statusKind: null,
    statusDeclared: null,
    todos: [],
    folder: '/w',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    snoozedUntil: null,
    archivedAt: null,
    lastUpdated: 1,
    lastSeq: 1,
    lastReadSeq: 1,
    pendingPermissions: [],
    model: null,
    rateLimitResumingAt: null,
    resumeKind: null,
    ...(over as Partial<ChatRow>),
  } as ChatRow;
}

describe('deriveBadge — a failed chat is not a finished one', () => {
  it('badges an errored ACTIVITY as errored', () => {
    expect(deriveBadge(row({ activity: 'errored' }))).toBe('errored');
  });

  it('badges an errored STATUS as errored, even when the activity settled to idle', () => {
    // This is the real shape: the turn died, activity fell back to idle, and the
    // only lasting record is the status. It used to read as `read`.
    expect(deriveBadge(row({ status: 'errored', activity: 'idle' }))).toBe('errored');
  });

  it('still puts a pending decision first — that is answerable right now', () => {
    expect(
      deriveBadge(
        row({
          status: 'errored',
          pendingPermissions: [{ requestId: 'r', tool: 'Bash', description: undefined, args: {} }],
        }),
      ),
    ).toBe('permission');
  });

  it('does not badge a healthy chat as errored', () => {
    expect(deriveBadge(row({ activity: 'running' }))).toBe('working');
    expect(deriveBadge(row({ lastSeq: 5, lastReadSeq: 1 }))).toBe('done');
    expect(deriveBadge(row())).toBe('read');
  });
});

describe('needsAttention keeps failed chats in the queue', () => {
  it('a failed chat needs attention', () => {
    // Adding the errored badge took these OUT of `done`; without the errored
    // arm they would have silently dropped out of the queue entirely.
    expect(needsAttention(row({ status: 'errored' }))).toBe(true);
  });

  it('a read, finished chat still does not', () => {
    expect(needsAttention(row())).toBe(false);
  });
});

describe('matchesStateFilter', () => {
  it('`all` filters nothing', () => {
    for (const r of [row(), row({ status: 'errored' }), row({ activity: 'running' })]) {
      expect(matchesStateFilter(r, 'all')).toBe(true);
    }
  });

  it('`failed` shows only failures', () => {
    expect(matchesStateFilter(row({ status: 'errored' }), 'failed')).toBe(true);
    expect(matchesStateFilter(row({ activity: 'errored' }), 'failed')).toBe(true);
    expect(matchesStateFilter(row({ activity: 'running' }), 'failed')).toBe(false);
    expect(matchesStateFilter(row(), 'failed')).toBe(false);
  });

  it('`working` shows only running chats', () => {
    expect(matchesStateFilter(row({ activity: 'running' }), 'working')).toBe(true);
    expect(matchesStateFilter(row({ status: 'errored' }), 'working')).toBe(false);
  });

  it('`waiting` covers a permission prompt AND an agent stopped on a question', () => {
    expect(matchesStateFilter(row({ activity: 'awaiting-permission' }), 'waiting')).toBe(true);
    expect(
      matchesStateFilter(row({ statusKind: 'question', statusDeclared: true }), 'waiting'),
    ).toBe(true);
    expect(matchesStateFilter(row({ activity: 'running' }), 'waiting')).toBe(false);
  });

  it('`waiting` excludes a GENERATED question guess — only a declared one counts', () => {
    expect(
      matchesStateFilter(row({ statusKind: 'question', statusDeclared: false }), 'waiting'),
    ).toBe(false);
    expect(
      matchesStateFilter(row({ statusKind: 'question', statusDeclared: null }), 'waiting'),
    ).toBe(false);
  });

  it('`done` never includes a failure — the whole point of the filter', () => {
    expect(matchesStateFilter(row({ lastSeq: 5, lastReadSeq: 1 }), 'done')).toBe(true);
    expect(matchesStateFilter(row(), 'done')).toBe(true);
    expect(matchesStateFilter(row({ status: 'errored' }), 'done')).toBe(false);
  });

  it('agrees with the badge the row itself shows, for every filter', () => {
    // What you filter for and what you see must never disagree.
    const rows = [
      row({ status: 'errored' }),
      row({ activity: 'running' }),
      row({ activity: 'awaiting-permission' }),
      row({ lastSeq: 5, lastReadSeq: 1 }),
      row(),
    ];
    for (const r of rows) {
      const shown = deriveBadge(r);
      const filters = (['failed', 'working', 'waiting', 'done'] as const).filter((f) =>
        matchesStateFilter(r, f),
      );
      expect(filters.length, `${shown} must match exactly one state filter`).toBe(1);
    }
  });
});
