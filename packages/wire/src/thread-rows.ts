// The Manager's Threads list (spec/14 § Manager view, spec/15 § Voice tab
// (Manager)): which chats it shows and in what order. One copy of the rule, shared
// by the desktop Threads strip and the phone's Manager "Chats" tab, so the two
// can never disagree about what needs the user first.
//
// Structural on purpose: each surface keeps its own store row type, and this
// reads only the fields the rule needs.

import type { ChatActivity, ChatStatus, StatusKind } from './events.js';

/** The slice of a surface's chat row the ordering reads. */
export interface ThreadRankInput {
  chatId: string;
  status: ChatStatus;
  activity: ChatActivity;
  lastUpdated: number;
  snoozedUntil: number | null;
  pendingPermissions: readonly unknown[];
  statusKind: StatusKind | null;
  statusDeclared: boolean | null;
}

/** What a row is blocked on — the same precedence the watch loop ranks by. */
export type ThreadRowState = 'permission' | 'question' | 'report' | 'working' | 'idle';

export function threadRowState(row: ThreadRankInput): ThreadRowState {
  // A NATIVE pending decision. A native request auto-expires, so it is the
  // more urgent of the two ways a chat can be blocked on the user; a declared
  // question just waits.
  if (row.pendingPermissions.length > 0 || row.activity === 'awaiting-permission') {
    return 'permission';
  }
  // A generated `question` guess (not a real `patch_ask_human` call) is a
  // frequent false positive and must not rank the row as blocked.
  if (row.statusKind === 'question' && row.statusDeclared) return 'question';
  // Not blocked, so it ranks below anything that is — but above a chat still
  // working, because the agent has already decided this one is worth seeing.
  if (row.statusKind === 'report') return 'report';
  if (row.activity === 'running') return 'working';
  return 'idle';
}

const STATE_RANK: Record<ThreadRowState, number> = {
  permission: 0,
  question: 1,
  report: 2,
  working: 3,
  idle: 4,
};

// Special-thread ids, repeated here rather than imported from index.ts to keep
// this module free of an import cycle. `isReservedSpecialThread` in index.ts
// is the canonical list; thread-rows.test.ts pins the two together.
const SPECIAL_THREADS = new Set(['thread_manager', 'thread_speakers']);

/**
 * Every active chat, needs-you first, then by recency. Archived, snoozed and
 * deleted chats are not listed, nor are the special threads — the Manager is
 * not one of the things it watches.
 */
export function threadRows<T extends ThreadRankInput>(
  chats: Record<string, T> | readonly T[],
  now: number,
): T[] {
  const all: T[] = Array.isArray(chats) ? [...chats] : Object.values(chats);
  return all
    .filter(
      (c) =>
        c.status === 'active' &&
        !SPECIAL_THREADS.has(c.chatId) &&
        (c.snoozedUntil === null || c.snoozedUntil <= now),
    )
    .sort((a, b) => {
      const byState = STATE_RANK[threadRowState(a)] - STATE_RANK[threadRowState(b)];
      return byState !== 0 ? byState : b.lastUpdated - a.lastUpdated;
    });
}
