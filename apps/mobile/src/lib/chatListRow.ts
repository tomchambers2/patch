// A `GET /api/chats` entry as the chat store takes it (`hydrate` for the
// cold-start roster, `mergeRows` for the Archived and Hidden sections' lazy
// lists). Kept
// out of `api/rest.ts` so a test that mocks the REST client still gets the
// real mapping.

import type { ChatListEntry } from '../api/rest';
import type { ChatListRow } from '../stores/types';

export function toChatListRow(c: ChatListEntry): ChatListRow {
  return {
    chatId: c.chatId,
    name: c.name,
    daemonId: c.daemonId,
    folder: c.folder,
    activity: c.activity,
    permissionMode: c.permissionMode,
    status: c.status,
    pinned: c.pinned,
    pinnedAt: c.pinnedAt,
    lastUpdated: c.lastUpdated,
    // Falls back to `lastUpdated` when an older server omits the field
    // (spec/14 § Sidebar ordering) — no worse than the sort behaviour before
    // this field existed.
    lastUserActivity: c.lastUserActivity ?? c.lastUpdated,
    pendingWake: c.pendingWake,
    snoozedUntil: c.snoozedUntil,
    hidden: c.hidden,
    model: c.model,
    jobId: c.jobId,
    statusSummary: c.statusSummary,
    statusKind: c.statusKind,
    statusDeclared: c.statusDeclared,
    goal: c.goal,
    reminder: c.reminder,
    todos: c.todos,
    disabled: c.disabled,
  };
}
