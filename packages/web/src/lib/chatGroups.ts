// Chat grouping + ordering — the single derivation of "the list" the sidebar
// draws (spec/14 § Sidebar), shared with anything that has to reason about that
// order without drawing it (spec/04 § Lifecycle: where archiving the open chat
// takes you next).

import { SPECIAL_THREAD_IDS } from '@patch/wire';
import { deriveBadge } from '../stores/chatStore.js';
import type { ChatRow, FolderRosterEntry } from '../stores/types.js';
import { isHidden, isSnoozed } from '../stores/types.js';

export interface Grouped {
  manager: ChatRow | null;
  speakers: ChatRow | null;
  pinned: ChatRow[];
  folders: Array<{ folder: string; rows: ChatRow[] }>;
  archived: ChatRow[];
  /** Soft-deleted chats (spec/04 § Lifecycle → E5). */
  deleted: ChatRow[];
  /** Chats snoozed into the future (spec/04 § Snooze). */
  snoozed: ChatRow[];
  /**
   * Chats running out of the active list (spec/04 § Hidden). Exclusive, like
   * `snoozed`: a hidden chat is drawn here and in none of the active buckets. A
   * chat both hidden and snoozed is drawn here, once — the server's list
   * queries make the same call. FIFO (oldest first), for the same reason as
   * `automations`: these are usually a job's runs, several working at once.
   */
  hidden: ChatRow[];
  /**
   * Every job-spawned chat (spec/08 § Action), regardless of its
   * active/archived/snoozed state — an ADDITIONAL, always-current view, not
   * exclusive with the buckets above (spec/14 § Sidebar — Automations). Soft-
   * deleted chats are excluded (cold storage, same as every other section
   * here). Special threads (Manager/Speakers) never appear — they
   * are never job-spawned. FIFO order (oldest first): a run's activity
   * updating while it's already in the list settles it at the BOTTOM rather
   * than jumping it to the top, so watching several runs land doesn't
   * reshuffle everything above them.
   */
  automations: ChatRow[];
  /**
   * Every folder that has ≥1 non-deleted chat — active OR archived — with
   * special-thread folders excluded. Recency-ordered. Backs the Recent folders
   * list (E6): a folder whose chats are ALL archived still appears here as an
   * entry point to start a new chat.
   *
   * Union of `groupChats`'s two inputs: the store's own rows AND the server
   * folder roster passed as the second argument. The roster is what makes the
   * "all archived" half of that promise survive a reload — the store's rows
   * come from `GET /api/chats`, which excludes archived chats.
   */
  recentFolders: string[];
}

const MANAGER_THREAD_ID = 'thread_manager';

function isSpecialThread(chatId: string): boolean {
  return chatId === MANAGER_THREAD_ID || chatId === SPECIAL_THREAD_IDS.speakers;
}

/**
 * Every chat in `folder` that an "archive all in project" would move
 * (spec/14 § Sidebar → Folders). Deliberately NOT `grouped.folders[].rows`:
 * `groupChats` buckets pinned and snoozed chats out before the folder list is
 * built, so the drawn rows are only the part of the project that happens to be
 * listed under its header. Archiving just those leaves the pinned and snoozed
 * ones behind — the project looks half-archived, which reads as the archive
 * having silently failed.
 *
 * Excluded: special threads (can't be archived — spec/06), already-archived
 * chats (nothing to do) and soft-deleted chats (cold storage; archiving them
 * would drag them back out of Deleted).
 */
export function chatsInProject(all: ChatRow[], folder: string): ChatRow[] {
  return all
    .filter(
      (c) =>
        c.folder === folder &&
        !isSpecialThread(c.chatId) &&
        c.status !== 'archived' &&
        c.status !== 'deleted',
    )
    .sort((a, b) => b.lastUpdated - a.lastUpdated || cmpId(a, b));
}

/**
 * How the active list is ordered (spec/14 § Sidebar ordering). `last-action` is
 * the user's own last send or the chat's creation — the default, because it is
 * the only key an agent reply cannot move. `last-update` is any activity at all
 * (agent replies, job ticks), `name` is case-insensitive A-Z.
 */
export type ChatSort = 'last-action' | 'last-update' | 'name';

export const CHAT_SORTS: ReadonlyArray<{ value: ChatSort; label: string }> = [
  { value: 'last-action', label: 'Last action' },
  { value: 'last-update', label: 'Last update' },
  { value: 'name', label: 'Name' },
];

export const DEFAULT_CHAT_SORT: ChatSort = 'last-action';

/** Independent choices: how chats order within a project, and how projects order. */
export interface ChatOrdering {
  chatSort: ChatSort;
  groupSort: ChatSort;
}

export const DEFAULT_CHAT_ORDERING: ChatOrdering = {
  chatSort: DEFAULT_CHAT_SORT,
  groupSort: DEFAULT_CHAT_SORT,
};

function chatLabel(c: ChatRow): string {
  return c.name ?? '';
}

/** Comparator for two chats under `sort`; ends in the chatId tiebreaker. */
function cmpChats(sort: ChatSort): (a: ChatRow, b: ChatRow) => number {
  switch (sort) {
    case 'last-action':
      return (a, b) => b.lastUserActivity - a.lastUserActivity || cmpId(a, b);
    case 'last-update':
      return (a, b) => b.lastUpdated - a.lastUpdated || cmpId(a, b);
    case 'name':
      return (a, b) =>
        chatLabel(a).localeCompare(chatLabel(b), undefined, { sensitivity: 'base' }) || cmpId(a, b);
  }
}

/** Comparator for two projects: by the newest row (or, for name, the folder's basename). */
function cmpFolders(
  sort: ChatSort,
): (a: { folder: string; rows: ChatRow[] }, b: { folder: string; rows: ChatRow[] }) => number {
  const newest = (rows: ChatRow[], key: 'lastUserActivity' | 'lastUpdated'): number =>
    Math.max(...rows.map((r) => r[key]), 0);
  const base = (f: string): string => f.split('/').filter(Boolean).pop() ?? f;
  return (a, b) => {
    switch (sort) {
      case 'last-action':
        return (
          newest(b.rows, 'lastUserActivity') - newest(a.rows, 'lastUserActivity') ||
          a.folder.localeCompare(b.folder)
        );
      case 'last-update':
        return (
          newest(b.rows, 'lastUpdated') - newest(a.rows, 'lastUpdated') ||
          a.folder.localeCompare(b.folder)
        );
      case 'name':
        return (
          base(a.folder).localeCompare(base(b.folder), undefined, { sensitivity: 'base' }) ||
          a.folder.localeCompare(b.folder)
        );
    }
  };
}

export function groupChats(
  all: ChatRow[],
  folderRoster: FolderRosterEntry[] = [],
  ordering: ChatOrdering = DEFAULT_CHAT_ORDERING,
): Grouped {
  let manager: ChatRow | null = null;
  let speakers: ChatRow | null = null;
  const pinned: ChatRow[] = [];
  const archived: ChatRow[] = [];
  const deleted: ChatRow[] = [];
  const snoozed: ChatRow[] = [];
  const hidden: ChatRow[] = [];
  const automations: ChatRow[] = [];
  // spec/04 § Snooze: "snoozed" is derived from the clock, so a snooze that
  // lapses simply stops matching — no event needed to bring the chat back.
  const now = Date.now();
  const byFolder = new Map<string, ChatRow[]>();
  // Folder → most-recent lastUpdated across its non-deleted chats, for the
  // Recent folders list. Special threads never contribute (E2).
  //
  // Seeded from the server's folder roster BEFORE the store's own rows, because
  // the store alone cannot answer this: the cold-start roster excludes archived
  // chats, so after a reload a folder whose chats are all archived has no row
  // here at all and the folder vanished from Recent projects (Todoist:
  // "archiving the last chat in a project makes the project disappear from the
  // sidebar"). The roster is a FLOOR, not a ceiling — the loop below still
  // raises a folder's recency from a live row, and `deleted` rows still retire
  // a folder outright (handled after the loop).
  const folderRecency = new Map<string, number>();
  for (const entry of folderRoster) {
    folderRecency.set(
      entry.folder,
      Math.max(folderRecency.get(entry.folder) ?? 0, entry.lastUpdated),
    );
  }
  // Folders retired since the roster was fetched. A soft-delete is the one
  // thing that DOES drop a folder, so a stale roster row must not resurrect it.
  const deletedFolders = new Set<string>();
  const liveFolders = new Set<string>();
  for (const c of all) {
    // Special threads are matched by stable chatId — the host emits a
    // lowercase folder-name as `name` and a full filesystem path as `folder`,
    // so neither is a reliable discriminator (spec/06).
    if (c.chatId === MANAGER_THREAD_ID) {
      manager = c;
      continue;
    }
    if (c.chatId === SPECIAL_THREAD_IDS.speakers) {
      speakers = c;
      continue;
    }
    if (c.status === 'deleted') {
      deleted.push(c);
      if (c.folder) deletedFolders.add(c.folder);
      continue;
    }
    // Automations (spec/14 § Sidebar): non-exclusive — deliberately no
    // `continue` here, so a job-spawned chat ALSO falls through to whichever
    // bucket below it belongs in (archived, snoozed, pinned, or a folder).
    if (c.jobId !== null) {
      automations.push(c);
    }
    // A non-deleted chat's folder is a "recent folder" (active or archived).
    if (c.folder) {
      liveFolders.add(c.folder);
      folderRecency.set(c.folder, Math.max(folderRecency.get(c.folder) ?? 0, c.lastUpdated));
    }
    if (c.status === 'archived') {
      archived.push(c);
      continue;
    }
    if (isHidden(c)) {
      hidden.push(c);
      continue;
    }
    if (isSnoozed(c, now)) {
      snoozed.push(c);
      continue;
    }
    if (c.pinned) {
      pinned.push(c);
      continue;
    }
    const list = byFolder.get(c.folder) ?? [];
    list.push(c);
    byFolder.set(c.folder, list);
  }
  // Every sort ends in a deterministic tiebreaker (chatId for chats, folder
  // path for folders). Without it, rows that tie on the primary key fall back
  // to Object.values() insertion order, which shifts as the store merges /
  // re-adds rows — so the same data rendered twice could differ (todo Bugs:
  // "Order not consistent in conversation list"). NO FALLBACK to array order.
  pinned.sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0) || cmpId(a, b));
  // Folders ordered by most-recent USER activity within folder (spec/14 §
  // Sidebar ordering) — the user's own last send on each chat, or its
  // creation, never an agent reply, a status change, a job tick or a
  // finished turn. Unread/needs-you is shown by the badge (deriveBadge),
  // not by position, so there is no separate floating rank here any more.
  const folders = Array.from(byFolder.entries())
    .map(([folder, rows]) => {
      rows.sort(cmpChats(ordering.chatSort));
      return { folder, rows };
    })
    .sort(cmpFolders(ordering.groupSort));
  archived.sort((a, b) => b.lastUpdated - a.lastUpdated || cmpId(a, b));
  deleted.sort((a, b) => b.lastUpdated - a.lastUpdated || cmpId(a, b));
  // Soonest to wake, first.
  snoozed.sort((a, b) => (a.snoozedUntil ?? 0) - (b.snoozedUntil ?? 0) || cmpId(a, b));
  // FIFO — oldest first, so a run updating LANDS AT THE BOTTOM instead of
  // jumping to the top (Todoist: "Load chats bottom up so you don't get a
  // jarring effect as it loads it all in and keeps going down"). Automations
  // is watched live while several webhook/cron-spawned chats are working at
  // once — most-recent-first meant every activity tick reshuffled a run to
  // the top and shoved every row below it down, repeatedly, while a batch was
  // in flight. Same rationale as `sortAttentionQueue` below: a row already in
  // the list rejoining the back of it on update, rather than cutting to the
  // front, is what makes the list stop reshuffling out from under you.
  automations.sort((a, b) => a.lastUpdated - b.lastUpdated || cmpId(a, b));
  hidden.sort((a, b) => a.lastUpdated - b.lastUpdated || cmpId(a, b));
  // Recent folders: most-recently-active first, but ONLY folders that aren't
  // already shown above as an open Folders section or a pinned chat — otherwise
  // the same folder is listed twice. Recent folders then reads as "other
  // folders you could start a chat in" (e.g. folders whose chats are all
  // archived).
  // A folder soft-deleted since the roster was fetched drops out — but only if
  // nothing else still lives in it (deleting ONE chat in a busy folder must not
  // retire the whole folder).
  for (const folder of deletedFolders) {
    if (!liveFolders.has(folder)) folderRecency.delete(folder);
  }
  const shownFolders = new Set<string>(byFolder.keys());
  for (const p of pinned) if (p.folder) shownFolders.add(p.folder);
  const recentFolders = Array.from(folderRecency.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([folder]) => folder)
    .filter((folder) => !shownFolders.has(folder));
  return {
    manager,
    speakers,
    pinned,
    folders,
    archived,
    deleted,
    snoozed,
    hidden,
    automations,
    recentFolders,
  };
}

/**
 * "Needs attention" (todo: "Add a mode showing just what needs attention and no
 * other chats — i.e. chats that have finished."). A chat needs attention when
 * its badge is `done` (the agent finished and produced new output you haven't
 * seen) or `permission` (the agent paused on a yes/no). A `working` chat is
 * still going — not yet finished — and a `read` chat has already been seen, so
 * neither needs attention.
 */
export function needsAttention(row: ChatRow): boolean {
  const badge = deriveBadge(row);
  // A thread the agent left on a QUESTION is paused on the user and needs an
  // answer to move — it needs attention even once seen (patch/todo.md § Features
  // to add — "Current status": distinguish a question from a merely-stopped
  // thread). A `complete` thread is just stopped and can be picked up any time,
  // so it only surfaces via the normal done/permission badges.
  // `errored` is here for a reason that would otherwise bite silently: adding
  // the errored badge took failed chats OUT of `done`, and without this line
  // they would have dropped out of the attention queue altogether — the exact
  // opposite of the point. A chat whose work did not happen is the strongest
  // possible claim on attention.
  // `background` and `monitoring` are deliberately NOT here, for the same
  // reason `working` is not: a chat with a background command still running,
  // or a self-wake armed, has not finished, so it is not yet a result to look
  // at. It rejoins the queue as `done` the moment it has something new to show.
  // A `report` is the agent electing to say this chat is worth the user's
  // attention (spec/04 § Current status) — the only sidebar state it chooses
  // for itself. Leaving it out would mean the one thing an overnight job did
  // deliberately to be noticed was the one thing the attention filter hid.
  return (
    badge === 'done' ||
    badge === 'permission' ||
    badge === 'errored' ||
    (row.statusKind === 'question' && row.statusDeclared === true) ||
    row.statusKind === 'report'
  );
}

/** The states the sidebar can be filtered down to (spec/14 § Sidebar). */
export type ChatStateFilter = 'all' | 'failed' | 'working' | 'waiting' | 'done';

/** Every `ChatStateFilter` value — used to validate a persisted one on load. */
export const CHAT_STATE_FILTERS: readonly ChatStateFilter[] = [
  'all',
  'failed',
  'working',
  'waiting',
  'done',
];

/**
 * Does this row belong in the list under the chosen state filter?
 *
 * Filtering by state exists because a failure used to be invisible: dozens of
 * chats read as finished while their last word was "You've hit your monthly
 * spend limit". Being able to ask the list "show me what failed" is how that
 * stops needing to be noticed by accident.
 *
 * Driven off the same `deriveBadge` the row's own icon uses, so what you filter
 * for and what you see on the row can never disagree.
 */
export function matchesStateFilter(row: ChatRow, filter: ChatStateFilter): boolean {
  if (filter === 'all') return true;
  const badge = deriveBadge(row);
  switch (filter) {
    case 'failed':
      return badge === 'errored';
    case 'working':
      // `background` and `monitoring` both belong here, not under `done`. The
      // chat is idle in the sense that no turn is in flight, but either a
      // command/sub-agent it launched is still running, or it has a self-wake
      // armed and will check back on its own — asking the list for what is
      // working and being shown only mid-turn chats would hide exactly the
      // work that is easiest to forget about, since nothing about it is on
      // screen.
      return badge === 'working' || badge === 'background' || badge === 'monitoring';
    case 'waiting':
      // Anything paused ON THE USER: a permission prompt, or an agent that
      // stopped on a question.
      return (
        badge === 'permission' || (row.statusKind === 'question' && row.statusDeclared === true)
      );
    case 'done':
      return badge === 'done' || badge === 'read';
  }
}

/**
 * Re-orders an already-filtered needs-attention list into a FIFO queue:
 * oldest-waiting first, most-recently-updated LAST (Todoist: "needs
 * attention queue - updated things should be at the bottom of the queue").
 * This is deliberately the opposite of `groupChats`'s own within-folder sort
 * (recency DESCENDING, so a chat you're using stays put at the top) — that
 * ordering is for the always-visible chat list, where jumping on completion
 * would be disorienting. The needs-attention queue is a to-do list you work
 * through front to back; a row that updates again while still in the queue
 * re-joins the back of it rather than cutting back to the front, so working
 * through the queue in order isn't constantly reshuffled by the items you
 * haven't gotten to yet.
 *
 * `permission` rows still come first within the queue — a paused yes/no is a
 * stronger signal than a finished-and-unread chat (spec/14 § Chat header) —
 * but two permission rows (or two done rows) between themselves queue oldest
 * first, same as the rest.
 */
export function sortAttentionQueue(rows: readonly ChatRow[]): ChatRow[] {
  return [...rows].sort(
    (a, b) => attentionRank(a) - attentionRank(b) || a.lastUpdated - b.lastUpdated || cmpId(a, b),
  );
}

function attentionRank(row: ChatRow): number {
  return deriveBadge(row) === 'permission' ? 0 : 1;
}

/**
 * Stable, data-only tiebreaker for two chat rows — by chatId. Used as the final
 * comparator on every chat sort so ties never resolve to insertion order.
 */
function cmpId(a: ChatRow, b: ChatRow): number {
  return a.chatId < b.chatId ? -1 : a.chatId > b.chatId ? 1 : 0;
}

/**
 * Where to go when `archivedIds` leave the active list while `currentChatId` is
 * the open chat (spec/04 § Lifecycle). Resolved against the order the sidebar
 * draws — pinned first, then each folder group top to bottom — so "next" is the
 * row the user can see below the one they just archived. `null` means nothing
 * active is left to open.
 *
 * Call this BEFORE flipping the rows to archived: the answer is a position in
 * the list as it still stands.
 *
 * `attentionOnly` mirrors the needs-attention filter, so archiving down a
 * filtered list walks that list. The open chat itself is kept in the order even
 * when the filter would drop it — you can open a chat the filter hides, and its
 * position is still where "next" starts from.
 */
export function nextChatAfterArchive(
  all: ChatRow[],
  currentChatId: string,
  archivedIds: readonly string[],
  attentionOnly: boolean,
  ordering: ChatOrdering = DEFAULT_CHAT_ORDERING,
): string | null {
  const { pinned, folders } = groupChats(all, [], ordering);
  const rows = [...pinned, ...folders.flatMap((f) => f.rows)];
  const order = (
    attentionOnly ? rows.filter((c) => needsAttention(c) || c.chatId === currentChatId) : rows
  ).map((c) => c.chatId);
  const leaving = new Set(archivedIds);
  // idx < 0 means the open chat has no row of its own (it is snoozed, hidden,
  // or a special thread): slice(0) then scans the whole list, making "next" its
  // top.
  const idx = order.indexOf(currentChatId);
  const below = order.slice(idx + 1).find((id) => !leaving.has(id));
  if (below !== undefined) return below;
  const above = order
    .slice(0, Math.max(idx, 0))
    .reverse()
    .find((id) => !leaving.has(id));
  return above ?? null;
}
