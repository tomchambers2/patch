// Shared store types.
//
// Per spec/14-design-web.md sidebar status badges + chat lifecycle. We do not
// re-export wire types directly because surfaces map activity → display state
// (e.g. `done`/`unread` is "activity is idle AND lastSeq > lastReadSeq").

import type {
  ChatContextUsage,
  ChatActivity,
  ChatStateEvent,
  ChatStatus,
  FinishedGoal,
  GoalProgress,
  PendingWake,
  PermissionMode,
  StatusKind,
  TodoItem,
} from '@patch/wire';

export interface ChatRow {
  chatId: string;
  name: string | null;
  /**
   * The host this chat is pinned to (`chat.spawned`), fixed for its life.
   * Empty only for a row the surface created optimistically before the
   * host's `chat.spawned` reconciled it — every host-scoped action on the
   * chat refuses while it is empty rather than guessing a machine.
   */
  daemonId: string;
  folder: string;
  activity: ChatActivity;
  /** The effective permission mode the chat's next turn will use (`chat.state`). */
  permissionMode: PermissionMode;
  status: ChatStatus;
  pinned: boolean;
  pinnedAt: number | null;
  /** A special thread turned off (spec/06 § Disabled). `false` for ordinary chats. */
  disabled: boolean;
  lastUpdated: number;
  /**
   * ms epoch of the user's own last activity on this chat — when they last
   * sent a message, or chat creation if they never have (spec/14 § Sidebar
   * ordering). `chatGroups.ts` sorts Pinned and Folders rows by this instead
   * of `lastUpdated`, so an agent reply, a status change, a job tick or a
   * finished turn never moves a row.
   */
  lastUserActivity: number;
  /** Set when this chat is awaiting a permission decision. */
  awaitingPermission: boolean;
  /**
   * Local-only: the highest per-chat `seq` the user had seen the last time they
   * opened this chat. Drives unread vs read. We track read state by SEQ, not by
   * wall-clock, because opening a chat triggers a `chat.replay` that re-delivers
   * the chat's history — those replayed events carry their ORIGINAL (≤ current)
   * seqs, so a seq-based watermark is immune to replay. A wall-clock model is
   * not: replayed messages would bump a `lastUpdated` to "now" and perpetually
   * out-run any visit timestamp, so the chat could never settle to `read`.
   *
   * Initialised to `-1` (nothing seen) so a freshly-hydrated chat — whose true
   * `seq` we don't yet know from the REST cold-start — reads as unread until the
   * user actually visits it. `seq` is always `>= 0` for real stream items.
   */
  lastReadSeq: number;
  /**
   * Durable first-user-message snippet — the sidebar one-line label for a row
   * (used for archived rows, which carry no live timeline). Captured ONCE from
   * the first user message and never overwritten by later turns, so the label
   * stays stable instead of flipping as a turn streams.
   */
  preview: string | null;
  /**
   * The chat's goal (patch/todo.md — `/goal`). Shown in a banner at the top of
   * the chat. `null` when no goal is set.
   */
  goal: string | null;
  /** Live progress on the active goal (spec/04 § Goals). `null` iff `goal` is `null`. */
  goalProgress: GoalProgress | null;
  /** The most recently finished goal (spec/04 § Goals), kept after `goal` clears. */
  lastGoal: FinishedGoal | null;
  /**
   * The chat's reminder (patch/todo.md — Reminders). A configurable reminder to
   * do / not do something, shown in a banner at the top of the chat. `null` when
   * no reminder is set.
   */
  reminder: string | null;
  /**
   * The chat's pending self-wake (spec/02 § Self-wake) — the message the host
   * will deliver back into this chat, and when. Drives the wake bar above the
   * chat (patch/todo.md — "cron should be visible in a bar above the chat,
   * showing how long until next wakeup and the prompt"). `null` when nothing is
   * armed; clears when the wake fires or is cancelled.
   */
  pendingWake: PendingWake | null;
  /**
   * The chat's task list (spec/02 § Task list), mirrored from the agent's native
   * TodoWrite and editable from here. Drives the task bar above the transcript.
   * Empty until the agent writes a list.
   */
  todos: TodoItem[];
  /**
   * Auto-generated one-line "current status" summary of the thread and any
   * action it needs (patch/todo.md § Features to add — "Current status"). Shown
   * nested under the sidebar row. `null` until the host generates one.
   */
  statusSummary: string | null;
  /**
   * Whether the thread is paused on a user `question` or simply `complete`
   * (stopped, nothing outstanding). Drives the sidebar's distinct treatment of
   * the two. `null` until a summary lands.
   */
  statusKind: StatusKind | null;
  /**
   * Whether `statusKind` is a real declared status (`patch_ask_human` /
   * `patch_report`) rather than a generated one-shot's guess. Only a declared
   * `question` outranks the read/unread check in `deriveBadge` — a generated
   * guess is a frequent false positive (any reply containing a `?`) and must
   * not freeze the row indigo forever. `null`/`false` for a generated status
   * or when nothing has landed.
   */
  statusDeclared: boolean | null;
  /**
   * ms epoch this chat is snoozed until (spec/04 § Snooze), or `null` when it
   * is not snoozed. Snoozed ⇔ `snoozedUntil > Date.now()` — derived at render
   * time, so a snooze that lapses while the app is open simply comes back.
   */
  snoozedUntil: number | null;
  /**
   * Running out of the active list (spec/04 § Hidden), from `chat.state`. A
   * separate axis from `status`, like `snoozedUntil`: the chat is drawn hidden
   * only while it is also `active` (`isHidden`) — an archived chat may keep the
   * flag and is drawn as archived.
   *
   * Optional like `backgroundTasks`, so the row fixtures that say nothing about
   * it do not all have to declare it; `emptyRow` sets it. Absent is not hidden,
   * which is also what the wire's absent field means.
   */
  hidden?: boolean;
  /** Pending permission requests (unanswered). */
  pendingPermissions: PendingPermission[];
  /** Highest seq we've seen — used for chat.replay on reconnect. */
  lastSeq: number;
  /**
   * The job whose `spawn` action created this chat (spec/08 § Action), or
   * `null` for a chat a user/surface started. Server-populated, set once at
   * spawn time and never changed — drives the sidebar's `▸ Automations`
   * group (spec/14 § Sidebar), which is an ADDITIONAL, always-current view
   * onto whichever job-spawned chats exist, not a chat mover: this field
   * never moves a chat out of wherever else it also sits (active/archived/
   * snoozed).
   */
  jobId: string | null;
  /**
   * The model this chat is running on: what it spawned with (`chat.spawned`),
   * then whatever a later change made it (`chat.state`, spec/04 § Model). Shown
   * in the header's folder crumb, which is also the control that changes it.
   * `null` when the chat's host has no model catalogue support configured to
   * report one — a `null` here is "not known", never a model.
   */
  model: string | null;
  /**
   * ms-epoch when this chat's rate-limit auto-resume is scheduled, or `null`
   * when no retry is pending. Surfaced by the host when `autoResumeRateLimit`
   * is on and a turn was blocked by a usage/rate-limit error. Shown above the
   * composer as "paused — resuming at HH:MM".
   */
  rateLimitResumingAt: number | null;
  /**
   * Distinguishes the pause reason when `rateLimitResumingAt` is set:
   * `'rate_limit'` for a 429/usage-limit block (shows "Usage limit — paused");
   * `'overloaded'` for a transient 529 (shows "Server busy — paused"). `null`
   * when no resume is pending. Optional for back-compat with older hosts.
   */
  resumeKind: 'rate_limit' | 'overloaded' | null;
  /**
   * Why the chat is blocked, in figures — which account, which pool, how full,
   * when it clears. `null` when it is not blocked.
   *
   * Carried separately from the provider's sentence on purpose. "You've hit
   * your monthly spend limit · your session limit resets 9:40am (UTC)" names
   * two different limits, states a time in a zone the reader is not in, and
   * says nothing about which of several accounts it is talking about — and it
   * was the only thing a surface had to show.
   *
   * Optional rather than required so the two dozen existing row fixtures do not
   * all have to declare a field they say nothing about; `emptyRow` sets it, so
   * every row the app actually builds carries it.
   */
  limitBlock?: ChatStateEvent['limitBlock'] | null;
  /**
   * The account the chat's latest turn ran on (`chat.state`, spec/10 § Backend
   * credentials). Null until a turn has run on the host holding the chat.
   */
  account?: { id: string; label: string } | null;
  /**
   * How many of this chat's backgrounded commands and sub-agents are still
   * RUNNING, as the host counted them (`chat.state`, spec/02 § Background
   * task completions). Drives the sidebar's `background` badge.
   *
   * `null` is UNKNOWN and is never rendered as anything: a host that predates
   * the field reports nothing, and a row that has not yet heard a state frame
   * knows nothing either. `0` is the positive claim that nothing is running.
   * The distinction is the whole point — drawing "nothing running" from silence
   * is the guess this field exists to avoid (spec/12 — NO FALLBACK).
   *
   * Optional like `limitBlock`, so the row fixtures that say nothing about it do
   * not all have to declare it; `emptyRow` sets it, so every row the app
   * actually builds carries it.
   */
  backgroundTasks?: number | null;
  /**
   * Tool calls this surface has seen start and not yet seen finish. A call that
   * is still running means the chat is working, whatever `activity` says: a
   * two-minute `Bash` showed the finished tick in the sidebar because nothing
   * but the host's `activity` fed the badge. Counted from the live
   * `chat.tool_call` / `chat.tool_result` stream; cleared when the turn is
   * stopped. Optional like `backgroundTasks`, so fixtures need not declare it.
   */
  openToolCalls?: number;
  /**
   * `callId`s of this chat's open tool calls — same lifecycle as
   * `openToolCalls` above (one array entry per outstanding call, pushed on
   * `chat.tool_call`, removed on its `chat.tool_result`, cleared on stop/idle)
   * but keyed by call rather than counted, so a single call's own row can ask
   * "is MY call still open" instead of "is the chat working on something".
   * Without this a call's row fell back to the chat-wide `openToolCalls`/
   * `activity` check, which is also true for a LATER call in a promoted turn —
   * so a tool call the user had already cancelled kept showing a live spinner
   * and ticking elapsed time for as long as the chat went on being busy with
   * something else entirely.
   */
  openCallIds?: string[];
  /**
   * How full the chat's context window is (spec/14 § Composer — context ring).
   * `null`/absent means nothing measured, which draws no ring — not an empty one.
   */
  context?: ChatContextUsage | null;
  /**
   * Claude Code's OWN provider-level context this chat has received
   * (`chat.provider_context`, spec/02 § Provider-level context) — environment,
   * model identity, token counts, and the rest of Claude Code's native
   * `type: "attachment"` entries, as distinct from Patch's own five
   * hand-injected `<system-reminder>` builders (`ChatEventEntry.systemContext`
   * below).
   *
   * Keyed by `providerType` (Claude Code's own stable name, e.g.
   * `"environment"`), because these recur constantly within a session — one
   * ROW per category, not one per occurrence, upserted to the latest
   * label/text with a running count (ProviderContextPanel renders this).
   * Optional like `backgroundTasks`, so fixtures that don't care about it
   * don't all have to declare it; `emptyRow` sets `{}` for every row the app
   * actually builds.
   */
  providerContext?: Record<string, ProviderContextEntry>;
}

/** One category's latest state in `ChatRow.providerContext` — see there. */
export interface ProviderContextEntry {
  label: string;
  text: string;
  /** How many `chat.provider_context` events of this `providerType` have
   *  landed — the deduplication this exists for, made visible rather than
   *  silently discarding every occurrence but the last. */
  count: number;
  /** The seq of the FIRST occurrence — stable sort key, so a row's position
   *  in the panel doesn't jump every time it updates. */
  firstSeq: number;
  /** The seq of the latest occurrence applied — the replay-dedup guard
   *  (`chatStore.ts`), same idea as every other seq-keyed upsert here. */
  lastSeq: number;
}

export interface PendingPermission {
  requestId: string;
  tool: string;
  description: string | undefined;
  args: unknown;
}

export type DisplayBadge =
  | 'working'
  | 'permission'
  | 'errored'
  | 'done'
  | 'background'
  | 'monitoring'
  | 'read';

/**
 * Whether the Stop control belongs on the composer. A chat parked only on the
 * agent's own question is waiting for the user, not working, so there is
 * nothing to stop; an approval (a turn paused mid-work) still can be stopped.
 */
export function isStoppable(row: Pick<ChatRow, 'activity' | 'pendingPermissions'>): boolean {
  if (row.activity === 'running') return true;
  if (row.activity !== 'awaiting-permission') return false;
  const pending = row.pendingPermissions;
  return pending.length === 0 || pending.some((p) => p.tool !== 'AskUserQuestion');
}

/** Mapping per spec/14 ## Status badges. */
export function deriveBadge(row: ChatRow): DisplayBadge {
  // An unresolved pending permission is the canonical "needs yes/no" signal —
  // it outlives the transient `awaiting-permission` activity flag, which the
  // host clears when the turn completes even though the prompt is unanswered.
  if (row.pendingPermissions.length > 0) return 'permission';
  if (row.activity === 'awaiting-permission') return 'permission';
  // A declared QUESTION (`patch_ask_human`) is the same fact as a permission
  // request — the agent is blocked on the user — even though nothing native is
  // pending. Tom: "same difference as needs you." One badge, one colour, for
  // both ways a chat can be paused on a person rather than a process.
  //
  // Gated on `statusDeclared`: a GENERATED `question` guess is not the agent
  // saying it is blocked, just a one-shot's reading of the last reply (any "?"
  // is enough to trip it), so it does not get to override the read/unread
  // check below — it falls through like any other settled turn instead of
  // freezing the row indigo until a new message arrives.
  if (row.statusKind === 'question' && row.statusDeclared) return 'permission';
  // A FAILED chat, ranked above `working` and below a pending decision.
  //
  // There was no errored badge at all, so a chat whose turn had died fell
  // through to `done`/`read` and read as finished — indistinguishable in the
  // sidebar from one that had succeeded. That is how a run of chats sat there
  // with "You've hit your monthly spend limit" as their last word and nobody
  // noticed: the list said they were done.
  //
  // Below `permission` because a prompt is answerable right now, whereas a
  // failure is usually waiting on something else; above `working` because a
  // chat cannot be both, and if it somehow claims to be, the failure is the more
  // important fact.
  if (row.activity === 'errored' || row.status === 'errored') return 'errored';
  if (row.activity === 'running' || (row.openToolCalls ?? 0) > 0) return 'working';
  // Unread beats a still-running background job or self-wake loop (Tom: "unread
  // beats background always"). The chat HAS something new to look at — that is
  // the strongest true claim available, and it does not stop being true just
  // because the same chat also has other work in flight. Ranked here, above
  // `background`/`monitoring` and below the states above it for the same reason
  // those are above it: a decision or a failure is a stronger claim than "there
  // is unread output", but unread output is a stronger claim than "nothing to
  // see yet, still going".
  if (row.lastSeq > row.lastReadSeq) return 'done';
  // An IDLE chat that still has a background command or sub-agent running
  // (spec/14 § Status badges). The agent is not mid-turn, so nothing else here
  // fires — the row fell through to `done`/`read` and drew the finished tick
  // while a build, a test run or a sub-agent it launched was still going. The
  // tick is the strongest "nothing to do here" signal in the list, and it was
  // the one being shown for the case where work is still in flight.
  //
  // NO FALLBACK: only a POSITIVE count does this. `null`/`undefined` is "nobody
  // measured" — an older host, or a row that has not yet heard a state frame
  // — and shows the badge it always did rather than inventing a state.
  if (typeof row.backgroundTasks === 'number' && row.backgroundTasks > 0) return 'background';
  // A self-wake armed (`patch_wake_me`): the agent is not doing anything right
  // now, has said everything it has to say, and will check back on its own —
  // distinct from `background` (an actual process running right now) even
  // though both mean "not finished, nothing to read yet". Below `done`/
  // `background` for the same reason `background` is below `done`: this is the
  // quietest true claim, so anything with a stronger one wins first.
  if (row.pendingWake) return 'monitoring';
  return 'read';
}

/** spec/04 § Snooze — a chat is snoozed only while its wake time is still ahead. */
export function isSnoozed(row: { snoozedUntil: number | null }, now: number = Date.now()): boolean {
  return row.snoozedUntil !== null && row.snoozedUntil > now;
}

/**
 * spec/04 § Hidden — drawn in the Hidden section, and nowhere else, only while
 * the chat is still `active`. An archived chat that keeps `hidden: true` is
 * archived: the flag is where a machine message starting it again returns it to.
 */
export function isHidden(row: { status: ChatStatus; hidden?: boolean }): boolean {
  return row.status === 'active' && row.hidden === true;
}

/**
 * One row of the server's folder roster (`GET /api/chats/folders`, spec/04
 * § Folders → Folder roster): a folder holding at least one non-deleted chat —
 * ARCHIVED INCLUDED — on `daemonId`, stamped with its most-recent chat's
 * `lastUpdated`.
 *
 * Lives here rather than in `chatGroups.ts` because `chatGroups` already
 * imports from the store; defining it there and importing it back would be a
 * cycle.
 */
export interface FolderRosterEntry {
  folder: string;
  daemonId: string;
  lastUpdated: number;
}

/**
 * The server's section counts (`GET /api/chats/counts`, spec/04 § Section
 * counts): how many chats each collapsed sidebar section holds. Each number is
 * the length of that section's own list query, so the badge on a collapsed row
 * and the rows drawn on expanding it always agree.
 */
export interface SectionCounts {
  hidden: number;
  archived: number;
  snoozed: number;
  deleted: number;
  automations: number;
}
