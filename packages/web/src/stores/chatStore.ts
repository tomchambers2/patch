// chatStore — chats list, active chat, kebab menu state.
//
// Synced from REST cold-start (`GET /api/chats`) plus live WS events. Per
// spec/03 the host emits `chat.spawned`, `chat.state`, `chat.message`,
// `chat.tool_call`, `chat.permission_request`, `chat.archive_request` (no —
// archive is surface-→-server). We keep enough state for the sidebar +
// chat panel to render directly off this store.

import { create } from 'zustand';
import { formatReset } from '../lib/usage.js';
import type {
  AttachmentRef,
  ChatBranch,
  ChatDelegateUpdateEvent,
  FinishedGoal,
  GoalProgress,
  MessageCompaction,
  PendingWake,
  PermissionMode,
  StatusKind,
  SystemContextItem,
  TodoItem,
  WireEvent,
} from '@patch/wire';
import { clearsLimitPause, isTransientChatError } from '@patch/wire';
import {
  deriveBadge,
  type ChatRow,
  type DisplayBadge,
  type FolderRosterEntry,
  type PendingPermission,
  type SectionCounts,
} from './types.js';
import { loadReadState, saveReadWatermark } from '../lib/readState.js';
import { clearComposerDraft } from './composerDraftStore.js';

/**
 * Strip the host's `[voice • <surface>]` / `[voice • device:<id>]` tag that
 * is prepended to spoken user turns. It's agent context (so Claude knows the
 * input arrived by voice), not display text — the chat should show what the
 * user actually said, and stripping it lets the persisted (tagged) copy
 * reconcile with the optimistic (clean) echo the surface renders on send.
 */
function stripVoicePrefix(s: string): string {
  return s.replace(/^\[voice(?: hand-off)? • [^\]]+\]\s*/, '');
}

/** Words spoken in a call — tagged `[voice • …]` by the host — as opposed to a hand-off's request. */
function isSpokenInCall(s: string): boolean {
  return /^\[voice • [^\]]+\]/.test(s);
}

/**
 * Whether the reply about to be drawn answers a hand-off: the last thing the user's side said
 * in this timeline was the fast voice's request to the agent, so the agent's answer is spoken.
 */
function answersHandoff(list: ChatEventEntry[] | undefined): boolean {
  for (let i = (list?.length ?? 0) - 1; i >= 0; i--) {
    const e = list![i]!;
    if (e.kind === 'message' && e.role === 'user') return e.voiceHandoff === true;
  }
  return false;
}

/** A fast voice's hand-off to the chat's agent (spec/07 § The fast voice and the chat's agent). */
function isVoiceHandoff(s: string): boolean {
  return /^\[voice hand-off • [^\]]+\]/.test(s);
}

/** Field-by-field comparison of two chat rows (all fields are primitives bar
 *  `pendingPermissions`, which is replaced wholesale, so identity is right). */
function sameRow(a: ChatRow, b: ChatRow): boolean {
  const keys = Object.keys(a) as Array<keyof ChatRow>;
  if (keys.length !== Object.keys(b).length) return false;
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
}

/**
 * spec/14 § Sidebar — "a commit that changes no row must not invalidate the
 * chat list". `applyEvent` builds its next `chats` map by copying (`{...state
 * .chats}`) and rewriting the touched row, so EVERY event — including the one
 * `chat.message_delta` per streamed token — hands zustand a brand-new
 * container and a brand-new row object even when not one field differs. The
 * sidebar subscribes to `s.chats`, so that churn re-ran `groupChats` (a sort
 * over every chat) and re-rendered every folder and row, once per token.
 *
 * This collapses the no-op back down: rows that are field-identical keep their
 * previous object, and if no row changed at all (and none was added or
 * removed) the previous container is returned unchanged, so the subscription
 * never fires. Purely an identity fix — the VALUES are exactly as computed.
 */
function reuseUnchangedRows(
  prev: Record<string, ChatRow>,
  next: Record<string, ChatRow>,
): Record<string, ChatRow> {
  const nextKeys = Object.keys(next);
  let changed = nextKeys.length !== Object.keys(prev).length;
  for (const id of nextKeys) {
    const before = prev[id];
    const after = next[id];
    if (before === undefined || after === undefined) {
      changed = true;
      continue;
    }
    if (before === after) continue;
    if (sameRow(before, after)) next[id] = before;
    else changed = true;
  }
  return changed ? next : prev;
}

interface ChatState {
  chats: Record<string, ChatRow>;
  /**
   * True once a `GET /api/chats` snapshot has landed (`hydrate`). Before that,
   * a chatId missing from `chats` only means the roster has not arrived; after
   * it, the absence is an answer. A surface that has to tell a still-loading
   * chat apart from a genuinely-absent one reads this rather than inferring it
   * from an empty map.
   */
  hydrated: boolean;
  /**
   * spec/04 § Branching — each chat's track graph, as published by
   * `chat.branches`. Absent for a chat whose graph we haven't seen yet; a
   * single-root graph means the chat has never been forked and shows no track
   * switcher.
   */
  branchGraphs: Record<string, { activeBranchId: string; branches: ChatBranch[] }>;
  /**
   * spec/14 § Side threads panel — a `chat.permission_request` tagged with a
   * NON-active branch (a side thread's own question) is kept here instead of
   * the chat's own `pendingPermissions`/timeline, keyed by `${chatId}::
   * ${branchId}`: the main transcript draws only the active branch's track,
   * so a side branch's card has nowhere honest to render there. The panel
   * reads this to show the card on the right tab and drive its "needs you"
   * status dot. Resolving it is unchanged (`chat.permission_response`
   * addresses by `requestId` alone) — this map is cleared the same way
   * `pendingPermissions` is.
   */
  sideThreadPermissions: Record<string, PendingPermission[]>;
  activeChatId: string | null;
  /** Kebab popover open? When set, anchors to this chatId's kebab button. */
  openKebabFor: string | null;
  /** Per-chat event timeline for the main panel. */
  timelines: Record<string, ChatEventEntry[]>;
  /**
   * spec/14 § Tool runs — each chat's AI summaries of its closed tool runs,
   * keyed by the run's FIRST call id. Not timeline entries: a summary labels
   * the collapsed run whose calls it names, and a row of its own would split
   * the very run it describes.
   */
  toolRunSummaries: Record<string, Record<string, ToolRunSummary>>;
  /**
   * spec/14 § Main chat panel — Delegate tool row: a `patch_delegate` call's
   * live state from `chat.delegate_update`, keyed by the subagent's own
   * chatId (the `id` its tool result returns) under the PARENT chat it was
   * called from. Reassigned only by that event, like `toolRunSummaries`.
   */
  delegateUpdates: Record<string, Record<string, DelegateUpdateInfo>>;
  /**
   * The server's folder roster (`GET /api/chats/folders`, spec/04 § Folders →
   * Folder roster), loaded once at cold start. Every folder with a non-deleted
   * chat, ARCHIVED INCLUDED — which is precisely what `chats` above cannot tell
   * you, since the cold-start roster excludes archived chats. `groupChats`
   * seeds Recent projects from this, and the new-chat picker resolves a
   * folder's host from it, so a folder whose chats are all archived stays
   * reachable after a reload. Empty until the boot fetch lands.
   */
  folderRoster: FolderRosterEntry[];
  /**
   * Section counts (spec/04 § Section counts) — the size of each collapsed
   * lifecycle section, from `GET /api/chats/counts`. `chats` cannot answer this
   * either: those lists load on expand, so before a section is opened the store
   * holds none of its rows and a locally-derived count would read 0.
   *
   * `null` until the boot fetch lands, and it stays `null` if that fetch fails.
   * NOT zeroes: `0` is a real, meaningful value here (it is a section's entire
   * empty state), so a placeholder zero would render as a confident "nothing in
   * there" for a section that might be full. Unknown draws no badge at all.
   */
  sectionCounts: SectionCounts | null;

  // ---- mutations ----
  /** Replace the folder roster from a `GET /api/chats/folders` snapshot. */
  setFolderRoster(roster: FolderRosterEntry[]): void;
  /** Replace the section counts from a `GET /api/chats/counts` snapshot. */
  setSectionCounts(counts: SectionCounts): void;
  hydrate(
    rows: Array<
      Omit<
        ChatRow,
        | 'awaitingPermission'
        | 'lastReadSeq'
        | 'preview'
        | 'goal'
        | 'goalProgress'
        | 'lastGoal'
        | 'reminder'
        | 'pendingWake'
        | 'todos'
        | 'statusSummary'
        | 'statusKind'
        | 'statusDeclared'
        | 'pendingPermissions'
        | 'lastSeq'
        | 'snoozedUntil'
        | 'jobId'
        | 'model'
        | 'rateLimitResumingAt'
        | 'resumeKind'
        | 'lastUserActivity'
      > & {
        preview?: string | null;
        goal?: string | null;
        goalProgress?: GoalProgress | null;
        lastGoal?: FinishedGoal | null;
        reminder?: string | null;
        pendingWake?: PendingWake | null;
        todos?: TodoItem[];
        snoozedUntil?: number | null;
        /**
         * What the chat is to the user (spec/04 § Current status). Optional, so
         * a caller with nothing to say about it leaves the known value alone.
         */
        statusSummary?: string | null;
        statusKind?: StatusKind | null;
        statusDeclared?: boolean | null;
        // Optional: a caller that predates the Automations group (spec/14 §
        // Sidebar) doesn't know about job-spawned chats — omitting it PRESERVES
        // whatever is already known rather than wiping the tag (jobId is set
        // once at spawn and never changes).
        jobId?: string | null;
        // Optional, same reason as jobId: a caller that predates the model
        // top-bar label omits it, which PRESERVES whatever is already known.
        model?: string | null;
        rateLimitResumingAt?: number | null;
        resumeKind?: 'rate_limit' | 'overloaded' | null;
        // Optional: an older server predates the field. Store-side merge falls
        // back to the existing value, then to `lastUpdated` (spec/14 § Sidebar
        // ordering).
        lastUserActivity?: number;
      }
    >,
  ): void;
  applyEvent(event: WireEvent): void;
  /**
   * Apply a run of events as a SINGLE commit.
   *
   * A `chat.replay` re-emits a whole transcript as one frame per entry —
   * measured at 582 events on a busy chat. One commit per event meant one
   * render of the whole stream per message, so a chat visibly filled in a
   * message at a time while the scroll chased the growing content. The fold is
   * sequential and in arrival order, so the result is identical to applying the
   * events one by one; `applyEvent` is just the single-event case.
   */
  applyEvents(events: WireEvent[]): void;
  /**
   * Merge rows into the store WITHOUT dropping chats already present (unlike
   * `hydrate`, which replaces the whole map from a `GET /api/chats` snapshot).
   * Used to lazily fold archived chats in when the Archived section is expanded
   * or an AI-search needs them, so the active-inbox snapshot isn't bloated with
   * the monotonically-growing archive on every cold start (spec/14).
   */
  mergeChats(
    rows: Array<
      Omit<
        ChatRow,
        | 'awaitingPermission'
        | 'lastReadSeq'
        | 'preview'
        | 'goal'
        | 'goalProgress'
        | 'lastGoal'
        | 'reminder'
        | 'pendingWake'
        | 'todos'
        | 'statusSummary'
        | 'statusKind'
        | 'statusDeclared'
        | 'pendingPermissions'
        | 'lastSeq'
        | 'snoozedUntil'
        | 'jobId'
        | 'model'
        | 'rateLimitResumingAt'
        | 'resumeKind'
        | 'lastUserActivity'
      > & {
        preview?: string | null;
        goal?: string | null;
        goalProgress?: GoalProgress | null;
        lastGoal?: FinishedGoal | null;
        reminder?: string | null;
        pendingWake?: PendingWake | null;
        todos?: TodoItem[];
        snoozedUntil?: number | null;
        /**
         * What the chat is to the user (spec/04 § Current status). Optional so
         * a caller with nothing to say about it leaves the known value alone —
         * but it must be CARRYABLE, which it was not: both fields were in the
         * `Omit` above, so the Automations section, which loads through here,
         * could not deliver a status even though the server sends one. Every
         * overnight job row was blank as a result.
         */
        statusSummary?: string | null;
        statusKind?: StatusKind | null;
        statusDeclared?: boolean | null;
        // See `hydrate` above: optional so pre-Automations callers don't have
        // to know about it, and omitting it preserves the known tag.
        jobId?: string | null;
        // See `hydrate` above: optional so pre-model-label callers don't have
        // to know about it, and omitting it preserves the known value.
        model?: string | null;
        rateLimitResumingAt?: number | null;
        resumeKind?: 'rate_limit' | 'overloaded' | null;
        // Optional: an older server predates the field. Store-side merge falls
        // back to the existing value, then to `lastUpdated` (spec/14 § Sidebar
        // ordering).
        lastUserActivity?: number;
      }
    >,
  ): void;
  /**
   * Locally resolve a pending permission once the user has answered (the WS
   * `chat.permission_response` is fired separately by the component). Clears
   * the request from the row's pending list, marks the timeline card resolved,
   * and drops `awaitingPermission` when nothing is left outstanding.
   *
   * `answers` is only ever supplied for an `AskUserQuestion`, and is stored on
   * the resolved entry as `permissionAnswers` so the card can still show what
   * was picked after a remount, a reload, or the host's own echo of a
   * resolution this surface didn't originate (spec/14 § Main chat panel —
   * Question prompts) — the alternative is a resolved card whose local
   * `picked` state is gone and reads as "Answered" with every option blank.
   */
  resolvePermission(
    chatId: string,
    requestId: string,
    decision: 'approve' | 'deny',
    answers?: Record<string, string>,
  ): void;
  /**
   * spec/14 § Side threads panel — drop a side branch's own permission card
   * once answered (local removal only; the wire resolution is unchanged,
   * `chat.permission_response` by `requestId` alone — see `resolvePermission`).
   */
  resolveSideThreadPermission(chatId: string, branchId: string, requestId: string): void;
  /**
   * Apply a live `chat.permission_expiry_update` (`ws.ts`) to the matching
   * question card's countdown — focus reset it, and every open surface needs
   * the new deadline without waiting for a replay (`02-daemon.md` § Questions
   * are not approvals). A no-op if the card isn't in the timeline yet (the
   * request and its reset raced in the same batch window) or is already
   * resolved (a reset that lost the race with the answer).
   */
  updatePermissionExpiry(
    chatId: string,
    requestId: string,
    expiry: { at: number; windowMs: number },
  ): void;
  /**
   * Discard whatever this row's `pendingPermissions` currently holds, right
   * before a `chat.replay` is requested (`ws.ts`'s `requestReplay`). A host
   * restart wipes its in-memory `pendingPermissionEvents`/`pendingPermissions`
   * Maps (chatRunner.ts) with no wire event to say so — there is no
   * `chat.permission_response` for a request the host has simply forgotten
   * — so a client that missed the real resolution is stuck showing `permission`
   * forever otherwise (confirmed live: a chat with `activity: idle`, no
   * `declaredStatus`, no pending-decisions record server-side, still drawing
   * the indigo badge). `replayChat` (chatRunner.ts) re-emits
   * `chat.permission_request` ONLY for entries still in its live map, so
   * treating a replay as the authoritative resync — clear first, let the
   * incoming stream re-establish anything genuinely still open — matches the
   * host's own truth instead of accumulating client-only state forever.
   */
  clearPendingPermissions(chatId: string): void;
  setActiveChat(chatId: string | null): void;
  /**
   * Optimistically render an outgoing user message the moment the composer
   * sends it. The host does NOT emit a live `chat.message` for the user's own
   * input (only the assistant reply streams back), so without this the sender
   * never sees their own message until a reload replays history. Keyed by
   * localId so the persisted copy is reconciled (not duplicated) on replay.
   */
  addLocalMessage(
    chatId: string,
    content: string,
    localId: string,
    folder?: string,
    attachments?: AttachmentRef[],
    opts?: { dedupeAgainstPersisted?: boolean; localAttachments?: LocalAttachment[] },
  ): void;
  /** Patch an outgoing turn (matched by `localId`) — upload progress, refs. */
  patchLocalMessage(chatId: string, localId: string, patch: Partial<ChatEventEntry>): void;
  /** Drop an outgoing turn the user discarded (× on a `Not uploaded` turn). */
  removeLocalMessage(chatId: string, localId: string): void;
  /**
   * Voice notes: render the message bubble the INSTANT the user finishes
   * speaking, in a live "Transcribing…" state, instead of only after the upload
   * + Whisper round-trip lands (Tom, patch/todo.md — "Voice message should
   * appear live."). Keyed by localId so the persisted `[voice • web]` echo folds
   * into it on replay.
   *   - `addTranscribingMessage` — seed the optimistic empty bubble (transcribing).
   *   - `resolveTranscription`   — fill it with the recognised text (clears the
   *     transcribing flag); an empty/whitespace transcript removes the bubble.
   *   - `cancelTranscription`    — drop the bubble (failed upload / aborted).
   */
  addTranscribingMessage(chatId: string, localId: string, folder?: string): void;
  resolveTranscription(chatId: string, localId: string, transcript: string): void;
  cancelTranscription(chatId: string, localId: string): void;
  /**
   * Seed an optimistic row for a freshly-created chat that has no first message
   * yet (the voice-note-starts-a-chat flow). Like the new-chat text path, this
   * lets ChatRoute render immediately instead of flashing "chat not found yet"
   * while the host's `chat.spawned` is in flight; the event reconciles it.
   * No-op if the row already exists.
   */
  ensureChat(chatId: string, folder: string): void;
  /**
   * Optimistically drop a still-queued message when the user removes it (the
   * component also fires `chat.unqueue_request`). The host's `chat.dequeued`
   * echo then no-ops. spec/04 ## Message queueing.
   */
  removeQueued(chatId: string, localId: string): void;
  /**
   * spec/12 § Guaranteed input delivery — delivery state machine for an
   * optimistic outgoing user turn, keyed by `localId`:
   *   - `clearDelivery` — observed as delivered (ack / queued / running / reply
   *     / error): drop both pending + failed marks.
   *   - `failDelivery` — retries exhausted: show "not delivered — tap to retry".
   *   - `retryDelivery` — (re)mark pending (initial submit re-arm, or a tapped
   *     retry): pending on, failed off.
   */
  clearDelivery(chatId: string, localId: string): void;
  failDelivery(chatId: string, localId: string): void;
  retryDelivery(chatId: string, localId: string): void;
  markRead(chatId: string): void;
  setKebabOpen(chatId: string | null): void;
  /** Local optimistic update for archive (REST POST issued by component). */
  setArchived(chatId: string, archived: boolean): void;
  /**
   * Local optimistic update for a special thread's on/off switch (spec/06 §
   * Disabled). REST POST issued by the component.
   */
  setDisabled(chatId: string, disabled: boolean): void;
  /**
   * Optimistically stamp (or clear) a chat's snooze (spec/04 § Snooze). The
   * caller POSTs and reverts on failure — NO FALLBACK.
   */
  setSnoozed(chatId: string, snoozedUntil: number | null): void;
  /**
   * Optimistically hide (or show) a chat (spec/04 § Hidden). The caller POSTs
   * and reverts on failure — NO FALLBACK.
   */
  setHidden(chatId: string, hidden: boolean): void;
  /**
   * Local optimistic update for soft-delete / restore (spec/04 § Lifecycle).
   * `deleted` flips status to `deleted` (row leaves the active list into the
   * Deleted section); restoring returns it to `active`. REST DELETE / restore
   * is issued by the component.
   */
  setDeleted(chatId: string, deleted: boolean): void;
  /** Local optimistic update for pin. */
  setPinned(chatId: string, pinned: boolean): void;
  /** Local optimistic update for a rename (spec/04 § Name); null clears it. */
  setName(chatId: string, name: string | null): void;
  /** Local optimistic update for the chat's goal (patch/todo.md — `/goal`). */
  setGoal(chatId: string, goal: string | null): void;
  /** Local optimistic update for the chat's reminder (patch/todo.md — Reminders). */
  setReminder(chatId: string, reminder: string | null): void;
  /**
   * Local optimistic update for the chat's task list (spec/02 § Task list).
   * Replaces the whole list, matching what the surface POSTs.
   */
  setTodos(chatId: string, todos: TodoItem[]): void;
  /**
   * spec/04 § Branching — drop a chat's transcript because the TRACK changed
   * (an edit forked a new one, or the user switched). The host's replay of
   * the newly-active track is the authority; keeping the old track's turns on
   * screen would show a conversation that no longer exists.
   */
  clearTimeline(chatId: string): void;
  /** Drop a chat row + its timeline (post-DELETE). */
  removeChat(chatId: string): void;
  /**
   * Drop a chat that never came into existence (spec/04 § Spawn — a refused
   * spawn). Same teardown as `removeChat`, plus the id is remembered so a
   * `chat.error` for it arriving AFTER the refusal cannot rebuild the row it
   * just retracted — the two travel on different connections (the refusal is
   * the POST's own 400, the error is the host's fan-out over the WS), so
   * neither order is guaranteed. Use `removeChat` for a chat that DID exist.
   */
  retractChat(chatId: string): void;
  /** Reset (used in tests). */
  _reset(): void;
}

/**
 * One run of a turn (spec/12 § A turn is owed until it settles). `seq` is the
 * user `chat.message` that attempt was persisted under — the original's own seq
 * for the first, and the re-send's for each one after it.
 *
 * `error` is set only on an attempt that ENDED in a failure, and is what the
 * `< >` pager shows when the user walks back to it. A superseded attempt's
 * failure is not an outcome any more — the turn went round again — so it is not
 * drawn at rest, but it is not thrown away either.
 */
export interface TurnAttempt {
  seq: number;
  error?: string;
  errorCode?: string;
}

/** A file an outgoing turn carries, as the local copy in this browser. */
export interface LocalAttachment {
  name: string;
  kind: 'image' | 'file';
  /** Object URL of the local copy — images only. */
  url?: string;
}

/** A closed tool run's AI summary (spec/14 § Tool runs), or why there is none. */
export interface ToolRunSummary {
  /** The run's call ids, in order — the run this labels. */
  callIds: string[];
  /** Null exactly when generation failed; `error` then says why. */
  summary: string | null;
  error?: string;
}

/** A `patch_delegate` subagent's live state (spec/14 § Main chat panel —
 *  Delegate tool row), from `chat.delegate_update`. */
export interface DelegateUpdateInfo {
  label: string;
  status: ChatDelegateUpdateEvent['status'];
  /** Epoch ms this surface first saw the subagent — the running-time clock. */
  since: number;
}

export interface ChatEventEntry {
  /** Source seq (or local timestamp for outgoing user messages). */
  seq: number;
  kind:
    | 'message'
    | 'tool_call'
    | 'tool_result'
    | 'permission'
    | 'system'
    | 'artifact'
    | 'error'
    | 'compaction'
    | 'permission_mode';
  role?: 'user' | 'assistant' | 'system';
  content?: string;
  /**
   * spec/02 § Context compression — the figures behind a `compaction` entry.
   * `content` is the one-line record the host wrote; this is what the
   * expanded disclosure shows.
   */
  compaction?: MessageCompaction;
  /**
   * spec/02 § System-reminder disclosure — every leading `<system-reminder>`
   * block this user turn actually carried, captured out-of-band instead of
   * inlined into `content`. Present only on a `message` entry that had one;
   * rendered as a collapsed, click-to-expand disclosure at that turn.
   */
  systemContext?: SystemContextItem[];
  /**
   * spec/02 § Permission mode — the mode the chat moved to, on a
   * `permission_mode` entry. `content` is the one-line record the host wrote.
   */
  permissionMode?: PermissionMode;
  /**
   * spec/02 § Permission mode's plan-mode exception — set only when Claude
   * Code made the change itself rather than a person using the mode control.
   * `content` already reads that way (the host's own wording); this is the
   * structured half, alongside `compaction`'s figures, for anything that wants
   * to key off it rather than parse the line.
   */
  permissionModeChangeAutomatic?: boolean;
  /**
   * `chat.error.error.code` on an `error` entry — the machine-readable half of
   * a failed turn (`sdk_error`, `claude_oauth_missing`, `daemon_unavailable`…).
   * The human half is `content`.
   */
  errorCode?: string;
  tool?: string;
  toolArgs?: unknown;
  toolResult?: unknown;
  callId?: string;
  requestId?: string;
  permissionDescription?: string;
  permissionResolved?: 'approve' | 'deny';
  /**
   * The user approved this request, but the host then resolved it as a deny
   * (an interrupt/stop cancelled it before the approval landed). The card keeps
   * the user's decision rather than relabelling it Denied, and says it was
   * cancelled so the label is not a lie about whether the tool ran.
   */
  permissionCancelled?: boolean;
  /**
   * The `{[questionText]: selectedOptionLabel}` an `AskUserQuestion` was
   * resolved with, once `permissionResolved` is set. Only ever present on a
   * question card — every other permission kind has no answer of this shape,
   * just approve/deny. Without this, the resolved card's picked options live
   * only in the component's own local state, which a remount (switching
   * chats and back, a reload, a resolution echoed from elsewhere) throws
   * away, leaving "Answered" with nothing on screen showing what was picked.
   */
  permissionAnswers?: Record<string, string>;
  /**
   * When the host will resolve this request itself if nobody answers, and
   * the whole window it was given (spec/02 § Questions are not approvals). The
   * question card counts down to THIS — the host's own deadline — rather
   * than starting a clock when it renders, so a chat opened late shows the
   * time actually left and a ring already partly gone. Absent means the
   * request does not expire and no countdown is drawn.
   */
  permissionExpiry?: { at: number; windowMs: number };
  /**
   * spec/14 § Artifacts — a page the agent published with `patch_artifact`.
   * `artifactId` is stable per source file, so a republish updates THIS entry
   * (new title/url/seq) instead of stacking a second card for the same page.
   */
  artifactId?: string;
  artifactTitle?: string;
  artifactUrl?: string;
  artifactPath?: string;
  /**
   * Set on an OPTIMISTIC outgoing user message (rendered locally the instant
   * the composer sends, before the host persists it). The matching persisted
   * `chat.message` that arrives on a later `chat.replay`/reconnect is reconciled
   * against this localId so the turn is never shown twice. spec/03: chat.input
   * carries a localId "for dedup".
   */
  localId?: string;
  /**
   * spec/08 § Action, spec/14 § Job trigger turn — this user-role turn is a
   * job's own fire into the chat, not something Tom typed, whichever turn of
   * the chat it lands on (the `spawn` action's own first turn is flagged a
   * different way — see `isJobTrigger` in ChatRoute.tsx). Mirrors the wire
   * `ChatMessageEvent.jobTrigger` field untouched.
   */
  jobTrigger?: boolean;
  /**
   * spec/20-hooks.md § On the agent's response, spec/14 § Agent-response
   * hooks — this user-role turn is a `block` resubmit the host fired
   * because a hook needed the agent to redo its answer, not something Tom
   * typed. Mirrors the wire `ChatMessageEvent.hookTrigger` field untouched;
   * the turn's own `content` is the hook's analysis/suggestion verbatim.
   */
  hookTrigger?: { hooks: Array<{ hookId: string; hookName: string }> };
  /**
   * spec/04 § Goals — this user-role turn is a `not_met` resubmit the host
   * fired because the chat's goal evaluator judged the condition not yet
   * satisfied, not something Tom typed. Mirrors the wire
   * `ChatMessageEvent.goalTrigger` field untouched; the turn's own `content`
   * is the evaluator's reason verbatim.
   */
  goalTrigger?: { reason: string };
  /**
   * spec/02 § Per-turn process / warm sessions — this system line is a reply
   * Claude Code wrote itself (`model: "<synthetic>"`), such as `No response
   * requested.`, not the agent speaking. Mirrors the wire
   * `ChatMessageEvent.synthetic` field untouched.
   */
  synthetic?: boolean;
  /**
   * spec/07 § The fast voice and the chat's agent — a request the call's fast
   * voice handed to the agent, not words the user said. Rendered as a quiet
   * line naming what was asked.
   */
  voiceHandoff?: boolean;
  /**
   * Words said in a call, transcribed: the user's own, or the fast voice's reply.
   * Drawn in italics with a call icon on the message's own side.
   */
  voice?: boolean;
  /**
   * spec/20-hooks.md § On the user's message — the `advise` outcome(s) a
   * `POST /api/hooks/check` returned for this SENT message, attached via
   * `patchLocalMessage` right after send. Client-local, this surface's own
   * session only (§ Never reaches the agent) — never sent over the wire,
   * never part of the persisted transcript, so it does not survive a reload.
   */
  hookAdvise?: { hookId: string; hookName: string; analysis?: string }[];
  /**
   * True while an assistant message is still streaming in (built from live
   * `chat.message_delta` chunks ahead of the turn's final `chat.message`).
   * The finalising `chat.message` (same `seq`) clears it. Lets the panel show
   * a typing/caret affordance and lets us reconcile the accumulator with the
   * durable message instead of rendering the reply twice.
   */
  streaming?: boolean;
  /**
   * True while this OUTGOING voice-note user turn is being transcribed — the
   * bubble is rendered the instant the user finishes speaking (a live
   * "Transcribing…" placeholder) so the message appears immediately rather than
   * only after the upload + Whisper round-trip (Tom, patch/todo.md — "Voice
   * message should appear live."). Cleared by `resolveTranscription` once the
   * recognised text arrives; the whole entry is removed by `cancelTranscription`
   * (failed upload) or an empty transcript. An empty-content entry with this set
   * is NOT dropped by the transcript's empty-message guard.
   */
  transcribing?: boolean;
  /**
   * True while this user turn is PARKED in the chat's queue behind a running
   * turn (spec/04 ## Message queueing). Set by `chat.queued`, cleared by
   * `chat.dequeued{running}` (it becomes a live turn) or the whole entry is
   * removed by `chat.dequeued{cancelled}`. Rendered as a distinct pending chip
   * with a remove (×) affordance.
   */
  queued?: boolean;
  /**
   * This user message reached the agent at a tool boundary of the turn that was
   * already running (spec/04 § Message delivery). `midTurnStep` is how many tool
   * calls the turn had made when it landed, shown as "after step N".
   */
  midTurn?: boolean;
  midTurnStep?: number;
  /**
   * The user pressed send now on this message while it was queued, which
   * interrupted the running turn (spec/04 § Message queueing § Promote). Shown
   * as `interrupted` in the message's hover strip.
   */
  sentNow?: boolean;
  /**
   * spec/15 § Composer → Attachments — the files an outgoing turn was sent
   * with, as the LOCAL copies the user picked (`url` is the object URL of an
   * image). The bubble draws its attachments from these, so the turn is on
   * screen before any upload lands; `attachments` gains the server refs, index
   * for index, once they do.
   */
  localAttachments?: LocalAttachment[];
  /**
   * spec/15 § Composer → Attachments — an outgoing turn whose attachments are
   * still uploading (`Uploading done/total`) or failed to (`failed`: `Not
   * uploaded`, Retry / ×). Absent once every upload has landed and the turn
   * has been handed to delivery (`deliveryPending` takes over from there).
   */
  upload?: { done: number; total: number; failed: boolean };
  /**
   * spec/12 § Guaranteed input delivery — this OUTGOING user turn has been
   * submitted but the surface has not yet OBSERVED it take effect (no
   * `chat.input_ack`, no `chat.queued`, no `running`, no reply, no error). Set
   * the instant the composer sends; cleared the moment any of those is observed.
   * Rendered as a distinct "sending…" (host online) / "queued — will send when
   * the agent reconnects" (host offline) affordance — never a bare spinner.
   *
   * DISTINCT from `queued` (type-ahead behind a running turn): a message can be
   * delivery-pending without being type-ahead-queued, and vice-versa. Do not
   * conflate them.
   */
  deliveryPending?: boolean;
  /**
   * spec/12 — the delivery-pending retries were exhausted (never acked/observed
   * while the link + host were up). Rendered as "not delivered — tap to
   * retry"; the retry re-sends the same `localId` (the host dedups). NEVER a
   * silent forever-spinner.
   */
  deliveryFailed?: boolean;
  /**
   * spec/12 — this turn WAS delivered and started, then failed generically
   * partway through (an unclassified agent/SDK error — a specific,
   * recoverable failure like an offline host or invalid session gets its
   * own dedicated `error` timeline entry instead, see `errorCode`). Rendered
   * on the ORIGINATING user message exactly like `deliveryFailed` — "tap to
   * retry" — rather than as a separate error line, so every "this didn't get
   * a reply" case looks and behaves the same regardless of which hop failed.
   * Retry re-submits the message as a brand new turn (a fresh `localId`): the
   * host has already run and dedups the original one, so re-sending it
   * would be a silent no-op.
   */
  turnFailed?: boolean;
  /**
   * The host's human-readable failure detail behind `turnFailed`, kept for
   * a tooltip/diagnostic surface — never rendered as prominently as the old
   * bare error-code chip was.
   */
  turnErrorMessage?: string;
  /**
   * Every ATTEMPT this one turn has been run as, oldest first — the original
   * plus one record per host re-send (spec/12 § A turn is owed until it
   * settles). Absent on a turn that has only ever been run once, which is
   * almost all of them.
   *
   * A re-send is the SAME turn going round again, not a second message, so it
   * folds into this list instead of appending a bubble. The list is what the
   * `< >` pager walks and what the "Retried twice" marker counts; an attempt
   * that ended in a failure keeps that failure's text here, which is the only
   * place it is still reachable once the transient error card has gone.
   */
  attempts?: TurnAttempt[];
  /**
   * The `chat.error` seq that set `turnFailed` on this entry — dedupes a
   * replayed/redelivered copy of the same failure (which must not re-search
   * for a message to attach to; by the time a redelivery arrives a retry may
   * already have moved this entry's `localId` on).
   */
  turnFailedSeq?: number;
  /**
   * spec/14 § Running-turn controls — this turn was interrupted by a NEWER
   * message being promoted ahead of it (`chat.stopped` fired while the chat's
   * `activity` is still `running` — the drain never went idle in between). The
   * agent DID see this turn; the promoted turn's run is what resumed the same
   * session, so there is nothing to retry and re-sending would duplicate it.
   * Rendered as a muted "Interrupted." with no action.
   */
  turnInterrupted?: boolean;
  /**
   * spec/14 § Running-turn controls — this turn was interrupted by the user
   * pressing Stop / `Esc` / `patch chats stop` with nothing queued behind it
   * (`chat.stopped` fired while the chat's `activity` had already settled
   * `idle`). The agent saw it and started on it, so "Continue" sends a fresh
   * nudge turn rather than re-submitting this message's text, which would
   * duplicate what the agent already has in context.
   *
   * NOT an error: a stop is something the user asked for, so it renders muted
   * rather than in the danger colour.
   */
  turnStopped?: boolean;
  /**
   * Composer attachments carried by a user turn (spec/14 § Composer). Refs
   * only; the renderer builds each inline URL from the chatId + id
   * (`/api/chats/:chatId/attachment/:id`). Set on the optimistic outgoing echo
   * and on a persisted `chat.message` that carries them.
   */
  attachments?: AttachmentRef[];
  at: number;
  /** tool_call only: when the call really started (wire `startedAt`), not when this surface received it. */
  startedAt?: number;
  /**
   * ms epoch this turn was actually written (`ChatMessageEvent.createdAt`) —
   * the moment Claude Code persisted it, or the host minted it, NOT the
   * moment this frame happened to arrive at this client (`at`, above). `at`
   * is "now" on every replay (a reopened chat re-fetches history and every
   * message gets "now"), so it can't be shown as a message time; this field
   * is the one the per-message hover strip actually renders (spec/14 §
   * Messages). Absent when the host that produced this message predates
   * the field, or the transcript line carried no timestamp of its own — the
   * strip then shows nothing for that message rather than inventing a time.
   */
  messageAt?: number;
}

/**
 * Patch the delivery flags of a single timeline entry, matched by `localId`
 * (spec/12). No-op if the chat or the entry is gone. Shared by
 * `clearDelivery` / `failDelivery` / `retryDelivery`.
 */
function updateDeliveryEntry(
  get: () => ChatState,
  set: (partial: Partial<ChatState>) => void,
  chatId: string,
  localId: string,
  patch: { deliveryPending: boolean; deliveryFailed: boolean },
): void {
  const cur = get().timelines[chatId];
  if (!cur) return;
  const idx = cur.findIndex((e) => e.localId === localId && e.kind === 'message');
  if (idx < 0) return;
  const list = [...cur];
  list[idx] = { ...list[idx]!, ...patch };
  set({ timelines: { ...get().timelines, [chatId]: list } });
}

function emptyRow(chatId: string, folder: string): ChatRow {
  return {
    chatId,
    name: null,
    // Unknown until `chat.spawned` names it. Empty is the honest value for an
    // optimistic row, and every host-scoped action checks for it.
    daemonId: '',
    folder,
    activity: 'idle',
    permissionMode: 'auto',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 0,
    lastUserActivity: 0,
    awaitingPermission: false,
    // -1 = nothing read yet, so a hydrated-but-never-opened chat reads as
    // unread (real stream seqs are >= 0). A visit advances this to the row's
    // current `lastSeq` (see markRead).
    lastReadSeq: -1,
    preview: null,
    goal: null,
    goalProgress: null,
    lastGoal: null,
    reminder: null,
    pendingWake: null,
    todos: [],
    statusSummary: null,
    statusKind: null,
    statusDeclared: null,
    snoozedUntil: null,
    hidden: false,
    pendingPermissions: [],
    lastSeq: 0,
    // Unknown until `chat.spawned` names it (server-populated only — spec/08
    // § Action). Default false-y `null` is correct for a user-started chat,
    // not a fallback: absent on the wire IS "no job".
    jobId: null,
    // Unknown until `chat.spawned` names it (spec/04 § Spawn) — `null` until
    // then, and also correct forever if the spawning host has no model
    // catalogue support to report one.
    model: null,
    // `null` until a rate-limit auto-resume is scheduled; cleared when it fires
    // or is cancelled (host's `rateLimitResumingAt` field in `chat.state`).
    rateLimitResumingAt: null,
    resumeKind: null,
    limitBlock: null,
    // Nobody has counted this chat's background work yet. `null` is unknown,
    // not zero — the sidebar draws no background state until a host that
    // tracks them reports a number (spec/02 § Background task completions).
    backgroundTasks: null,
    context: null,
    providerContext: {},
  };
}

/**
 * Chats retracted by `retractChat` — spawns the server refused, so no chat of
 * that id exists anywhere. Every later event naming one is ignored, which is
 * what stops the host's own `chat.error` (fanned out to every surface over
 * the WS, and not ordered against the POST's 400) from rebuilding the row the
 * retraction just dropped.
 *
 * Module-level rather than store state: it is a tombstone list, not something
 * anything renders. Bounded — a failed spawn is rare, but the tab can live for
 * days, and an unbounded set of ULIDs is a leak.
 */
const retractedChatIds = new Set<string>();
const RETRACTED_LIMIT = 200;

/** A turn's move to another account, with when the spent one comes back. */
export function accountSwitchLine(sw: { from: string; to: string; until?: number }): string {
  const back = sw.until !== undefined ? ` until ${formatReset(sw.until)}` : ' of credit';
  return `Switched from ${sw.from} to ${sw.to} — ${sw.from} is out${back}`;
}

/**
 * How many tool calls the running turn had made when a message landed in it:
 * the tool calls since the last user message that started a turn.
 */
function stepsInCurrentTurn(
  list: readonly ChatEventEntry[] | undefined,
  ignoreIndex?: number,
): number {
  if (!list) return 0;
  let steps = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    if (i === ignoreIndex) continue;
    const e = list[i]!;
    if (e.kind === 'message' && e.role === 'user' && e.midTurn !== true && e.queued !== true) break;
    if (e.kind === 'tool_call') steps++;
  }
  return steps;
}

export const useChatStore = create<ChatState>((set, get) => ({
  chats: {},
  hydrated: false,
  branchGraphs: {},
  sideThreadPermissions: {},
  activeChatId: null,
  openKebabFor: null,
  timelines: {},
  toolRunSummaries: {},
  delegateUpdates: {},
  folderRoster: [],
  sectionCounts: null,

  setFolderRoster(roster) {
    set({ folderRoster: roster });
  },

  setSectionCounts(counts) {
    set({ sectionCounts: counts });
  },

  hydrate(rows) {
    // `hydrate` runs on every `GET /api/chats` — cold start AND any React Query
    // refetch (window focus, reconnect). It must PRESERVE local-only inbox state
    // for chats we already know about: `lastReadSeq` (the read watermark) and
    // `lastSeq` / `preview` / `pendingPermissions` (built from the live WS
    // stream, which the REST snapshot doesn't carry). Rebuilding rows from
    // `emptyRow` defaults here is what silently wiped every chat back to unread
    // on refetch — the roster showed zero `read` badges no matter how many
    // chats you'd opened.
    const prev = get().chats;
    // Persisted per-surface read watermarks (localStorage). The REST snapshot
    // carries no read state, so without this every reload reset visited chats
    // back to `done`. Seed `lastReadSeq` from here so a visit's mark-read
    // survives a page reload (spec/14 ## Chat lifecycle: a visit durably flips
    // the badge to the grey read tick).
    const persistedRead = loadReadState();
    const next: Record<string, ChatRow> = {};
    for (const r of rows) {
      const existing = prev[r.chatId];
      const persisted = persistedRead[r.chatId];
      // A row from a caller that predates `preview` omits the field; never let
      // that `undefined` clobber a known preview (or the typed `null` default).
      const preview = r.preview ?? existing?.preview ?? null;
      // Goal CAN be cleared (null is meaningful) — only fall back to the known
      // goal when the incoming row omits the field entirely (undefined).
      const goal = r.goal !== undefined ? r.goal : (existing?.goal ?? null);
      const goalProgress =
        r.goalProgress !== undefined ? r.goalProgress : (existing?.goalProgress ?? null);
      const lastGoal = r.lastGoal !== undefined ? r.lastGoal : (existing?.lastGoal ?? null);
      // Reminder CAN be cleared (null is meaningful) — only fall back to the
      // known reminder when the incoming row omits the field entirely (undefined).
      const reminder = r.reminder !== undefined ? r.reminder : (existing?.reminder ?? null);
      // A pending wake CAN clear (fired / cancelled) — `null` is meaningful, so
      // only fall back to the known wake when the field is omitted entirely.
      const pendingWake =
        r.pendingWake !== undefined ? r.pendingWake : (existing?.pendingWake ?? null);
      // The task list CAN empty (agent finished it, user deleted every item) so
      // `[]` is meaningful — only keep the known list when the field is OMITTED.
      const todos = r.todos !== undefined ? r.todos : (existing?.todos ?? []);
      // A snooze CAN clear (unsnoozed / woken) — `null` is meaningful, so only
      // keep the known value when the incoming row omits the field entirely.
      const snoozedUntil =
        r.snoozedUntil !== undefined ? r.snoozedUntil : (existing?.snoozedUntil ?? null);
      // Hidden (spec/04 § Hidden) — only an OMITTED field (an older server)
      // keeps the known value; `false` is meaningful, it is Show.
      const hidden = r.hidden !== undefined ? r.hidden : (existing?.hidden ?? false);
      // jobId is set once at spawn and never changes (spec/08 § Action) — only
      // fall back to the known value when the incoming row omits the field
      // entirely (a caller that predates the Automations group).
      const jobId = r.jobId !== undefined ? r.jobId : (existing?.jobId ?? null);
      // model is set once at spawn and never changes (spec/04 § Spawn) — same
      // fallback rule as jobId.
      const model = r.model !== undefined ? r.model : (existing?.model ?? null);
      // rateLimitResumingAt can clear (timer fired) — `null` is meaningful.
      const rateLimitResumingAt =
        r.rateLimitResumingAt !== undefined
          ? r.rateLimitResumingAt
          : (existing?.rateLimitResumingAt ?? null);
      const resumeKind = r.resumeKind !== undefined ? r.resumeKind : (existing?.resumeKind ?? null);
      // Same rule as rateLimitResumingAt above: an explicit `null` CLEARS the
      // block (the pause ended), an absent field preserves what is known — a
      // host that predates the field must not blank it on every state frame.
      const limitBlock = r.limitBlock !== undefined ? r.limitBlock : (existing?.limitBlock ?? null);
      // A status CAN clear (the user answered, the chat moved on), so `null` is
      // meaningful — only keep the known value when the field is OMITTED.
      const statusSummary =
        r.statusSummary !== undefined ? r.statusSummary : (existing?.statusSummary ?? null);
      const statusKind = r.statusKind !== undefined ? r.statusKind : (existing?.statusKind ?? null);
      const statusDeclared =
        r.statusDeclared !== undefined ? r.statusDeclared : (existing?.statusDeclared ?? null);
      // Background-task count (spec/02 § Background task completions). `0` is
      // meaningful (the last task finished), so only an OMITTED field keeps the
      // known value — a caller that predates the field must not blank it.
      const backgroundTasks =
        r.backgroundTasks !== undefined ? r.backgroundTasks : (existing?.backgroundTasks ?? null);
      const context = r.context !== undefined ? r.context : (existing?.context ?? null);
      if (existing) {
        // Keep the live-stream + local fields; refresh the server-authoritative
        // ones (name, folder, activity, status, pinned, lastUpdated) from REST.
        // Never lower the in-memory watermark below the persisted one.
        const lastReadSeq =
          persisted !== undefined
            ? Math.max(existing.lastReadSeq, persisted)
            : existing.lastReadSeq;
        // Same rule as chat.state: a REST snapshot older than what the row
        // already holds must not roll the live activity back.
        const stale = r.lastUpdated < existing.lastUpdated;
        next[r.chatId] = {
          ...existing,
          ...r,
          ...(stale ? { activity: existing.activity, lastUpdated: existing.lastUpdated } : {}),
          // A snapshot that settles the chat means no call is in flight; the
          // counter is client-side and a lost result would pin `working`.
          ...(!stale && (r.activity === 'idle' || r.activity === 'errored')
            ? { openToolCalls: 0, openCallIds: [] }
            : {}),
          preview,
          goal,
          goalProgress,
          lastGoal,
          reminder,
          pendingWake,
          todos,
          snoozedUntil,
          hidden,
          jobId,
          model,
          rateLimitResumingAt,
          resumeKind,
          limitBlock,
          statusSummary,
          statusKind,
          statusDeclared,
          backgroundTasks,
          context,
          lastReadSeq,
        };
      } else {
        const base = {
          ...emptyRow(r.chatId, r.folder),
          ...r,
          preview,
          goal,
          goalProgress,
          lastGoal,
          reminder,
          pendingWake,
          todos,
          snoozedUntil,
          hidden,
          jobId,
          model,
          rateLimitResumingAt,
          resumeKind,
          limitBlock,
          statusSummary,
          statusKind,
          statusDeclared,
          backgroundTasks,
          context,
        };
        next[r.chatId] =
          persisted !== undefined
            ? { ...base, lastReadSeq: Math.max(base.lastReadSeq, persisted) }
            : base;
      }
    }
    set({ chats: next, hydrated: true });
  },

  mergeChats(rows) {
    const prev = get().chats;
    const persistedRead = loadReadState();
    const next: Record<string, ChatRow> = { ...prev };
    for (const r of rows) {
      const existing = prev[r.chatId];
      const persisted = persistedRead[r.chatId];
      const preview = r.preview ?? existing?.preview ?? null;
      const goal = r.goal !== undefined ? r.goal : (existing?.goal ?? null);
      const goalProgress =
        r.goalProgress !== undefined ? r.goalProgress : (existing?.goalProgress ?? null);
      const lastGoal = r.lastGoal !== undefined ? r.lastGoal : (existing?.lastGoal ?? null);
      const reminder = r.reminder !== undefined ? r.reminder : (existing?.reminder ?? null);
      // A pending wake CAN clear (fired / cancelled) — `null` is meaningful, so
      // only fall back to the known wake when the field is omitted entirely.
      const pendingWake =
        r.pendingWake !== undefined ? r.pendingWake : (existing?.pendingWake ?? null);
      // The task list CAN empty (agent finished it, user deleted every item) so
      // `[]` is meaningful — only keep the known list when the field is OMITTED.
      const todos = r.todos !== undefined ? r.todos : (existing?.todos ?? []);
      // A snooze CAN clear (unsnoozed / woken) — `null` is meaningful, so only
      // keep the known value when the incoming row omits the field entirely.
      const snoozedUntil =
        r.snoozedUntil !== undefined ? r.snoozedUntil : (existing?.snoozedUntil ?? null);
      // Hidden (spec/04 § Hidden) — only an OMITTED field (an older server)
      // keeps the known value; `false` is meaningful, it is Show.
      const hidden = r.hidden !== undefined ? r.hidden : (existing?.hidden ?? false);
      // See `hydrate` above.
      const jobId = r.jobId !== undefined ? r.jobId : (existing?.jobId ?? null);
      // See `hydrate` above.
      const model = r.model !== undefined ? r.model : (existing?.model ?? null);
      const rateLimitResumingAt =
        r.rateLimitResumingAt !== undefined
          ? r.rateLimitResumingAt
          : (existing?.rateLimitResumingAt ?? null);
      const resumeKind = r.resumeKind !== undefined ? r.resumeKind : (existing?.resumeKind ?? null);
      // See `hydrate` above: an explicit null clears, an absent field preserves.
      const limitBlock = r.limitBlock !== undefined ? r.limitBlock : (existing?.limitBlock ?? null);
      // A status CAN clear (the user answered, the chat moved on), so `null` is
      // meaningful — only keep the known value when the field is OMITTED.
      const statusSummary =
        r.statusSummary !== undefined ? r.statusSummary : (existing?.statusSummary ?? null);
      const statusKind = r.statusKind !== undefined ? r.statusKind : (existing?.statusKind ?? null);
      const statusDeclared =
        r.statusDeclared !== undefined ? r.statusDeclared : (existing?.statusDeclared ?? null);
      // Background-task count (spec/02 § Background task completions). `0` is
      // meaningful (the last task finished), so only an OMITTED field keeps the
      // known value — a caller that predates the field must not blank it.
      const backgroundTasks =
        r.backgroundTasks !== undefined ? r.backgroundTasks : (existing?.backgroundTasks ?? null);
      const context = r.context !== undefined ? r.context : (existing?.context ?? null);
      if (existing) {
        const lastReadSeq =
          persisted !== undefined
            ? Math.max(existing.lastReadSeq, persisted)
            : existing.lastReadSeq;
        next[r.chatId] = {
          ...existing,
          ...r,
          preview,
          goal,
          goalProgress,
          lastGoal,
          reminder,
          pendingWake,
          todos,
          snoozedUntil,
          hidden,
          jobId,
          model,
          rateLimitResumingAt,
          resumeKind,
          limitBlock,
          statusSummary,
          statusKind,
          statusDeclared,
          backgroundTasks,
          context,
          lastReadSeq,
        };
      } else {
        const base = {
          ...emptyRow(r.chatId, r.folder),
          ...r,
          preview,
          goal,
          goalProgress,
          lastGoal,
          reminder,
          pendingWake,
          todos,
          snoozedUntil,
          hidden,
          jobId,
          model,
          rateLimitResumingAt,
          resumeKind,
          limitBlock,
          statusSummary,
          statusKind,
          statusDeclared,
          backgroundTasks,
          context,
        };
        next[r.chatId] =
          persisted !== undefined
            ? { ...base, lastReadSeq: Math.max(base.lastReadSeq, persisted) }
            : base;
      }
    }
    set({ chats: next });
  },

  applyEvent(event) {
    get().applyEvents([event]);
  },

  applyEvents(events) {
    if (events.length === 0) return;
    const state = get();
    const chats = { ...state.chats };
    const timelines = { ...state.timelines };
    // spec/04 § Branching — reassigned only by `chat.branches`, so an ordinary
    // event hands zustand the SAME container and never invalidates a subscriber.
    let branchGraphs = state.branchGraphs;
    // Reassigned only by a side-thread-tagged `chat.permission_request`, for
    // the same reason.
    let sideThreadPermissions = state.sideThreadPermissions;
    // Reassigned only by `chat.tool_run_summary`, for the same reason.
    let toolRunSummaries = state.toolRunSummaries;
    // Reassigned only by `chat.delegate_update`, for the same reason.
    let delegateUpdates = state.delegateUpdates;
    // Whether anything in this batch actually changed the store. A batch of
    // purely unhandled event types must not commit — an unconditional `set()`
    // hands every subscriber fresh `chats`/`timelines` identities and re-renders
    // the whole sidebar for nothing.
    let changed = false;
    // Timeline arrays this batch has already copied. The store is immutable to
    // the OUTSIDE (subscribers only ever see the previous array or the new one),
    // so within a batch we may copy once and then append in place instead of
    // copying per event — otherwise applying a 582-event replay as a batch is
    // still quadratic in the transcript length.
    const copied = new Set<string>();

    function ensureRow(chatId: string, folder?: string): ChatRow {
      const existing = chats[chatId];
      if (existing) return existing;
      const created = emptyRow(chatId, folder ?? '');
      chats[chatId] = created;
      return created;
    }

    /** This batch's private, mutable copy of a chat's timeline. */
    function ownTimeline(chatId: string): ChatEventEntry[] {
      if (!copied.has(chatId)) {
        timelines[chatId] = timelines[chatId] ? [...timelines[chatId]] : [];
        copied.add(chatId);
      }
      return timelines[chatId]!;
    }

    // Insert a live-transcript entry, keeping any trailing queued (type-ahead)
    // messages below it (spec/04 ## Message queueing — a queued message stays
    // below the live transcript and never interleaves with the running turn's
    // ongoing output). Queued entries are held at the tail, so a new live entry
    // slots in just before that trailing block.
    function insertLive(list: ChatEventEntry[], entry: ChatEventEntry): void {
      let at = list.length;
      while (at > 0 && list[at - 1]?.queued) at--;
      list.splice(at, 0, entry);
    }

    function pushTimeline(chatId: string, entry: ChatEventEntry): void {
      insertLive(ownTimeline(chatId), entry);
    }

    /**
     * Drop the chat's TRANSIENT error entries (`isTransientChatError` —
     * currently only `daemon_unavailable`).
     *
     * Called when the host speaks for this chat again with a non-`errored`
     * activity: the link is back and the turn has resumed or finished, so the
     * "Connection to the host was lost" card is describing a condition that
     * is over. Leaving it made a two-second blip look like a permanent failure
     * in the transcript (spec/04 § Activity).
     *
     * NOT a fallback: only the code that the server itself invents out-of-band
     * for a link drop is removable. A real turn failure (`sdk_error`,
     * `claude_oauth_missing`, …) is an outcome and stays put forever.
     */
    function clearTransientErrors(chatId: string): void {
      const held = timelines[chatId];
      if (!held?.some((e) => e.kind === 'error' && isTransientChatError(e.errorCode))) return;
      const list = ownTimeline(chatId);
      let last: ChatEventEntry | undefined;
      for (let i = list.length - 1; i >= 0; i--) {
        const e = list[i]!;
        if (e.kind === 'error' && isTransientChatError(e.errorCode)) {
          last ??= e;
          list.splice(i, 1);
        }
      }
      // Off the transcript is not the same as thrown away. The card was the
      // outcome of ONE attempt at the turn above it, so it is filed on that
      // attempt's record, where the `< >` pager can still reach it (spec/12 §
      // A turn is owed until it settles). Tom asked for exactly this pair:
      // "the error should be temporary, not there forever" AND "< > to show
      // the retries if there is failed content".
      if (last === undefined) return;
      for (let i = list.length - 1; i >= 0; i--) {
        const e = list[i]!;
        // A type-ahead message parked BELOW the live transcript never ran, so
        // it is not what failed — the failed turn is the last one that did.
        if (e.kind !== 'message' || e.role !== 'user' || e.queued === true) continue;
        const prior = e.attempts ?? [{ seq: e.seq }];
        const tail = prior[prior.length - 1]!;
        // Already filed (a second `chat.state` for the same recovery) — an
        // attempt has ONE outcome and the first one recorded is the real one.
        if (tail.error !== undefined) return;
        list[i] = {
          ...e,
          attempts: [
            ...prior.slice(0, -1),
            {
              ...tail,
              error: last.content,
              ...(last.errorCode !== undefined ? { errorCode: last.errorCode } : {}),
            },
          ],
        };
        return;
      }
    }

    /**
     * Fold a host RE-SEND of a turn onto the bubble that turn already has
     * (spec/12 § A turn is owed until it settles).
     *
     * The host re-sends an owed turn itself — on restart (`resumeInterruptedTurns`)
     * and on every rung of the SDK-error ladder — and each re-send is a real,
     * separately-persisted user message with its own seq. Rendered naively that
     * is the same sentence on screen once per attempt, which is what Tom
     * photographed: one question, three identical bubbles, a red card between
     * the first two. So the copy folds in as an ATTEMPT of the turn already
     * drawn rather than as a message of its own.
     *
     * Folding is also what makes the failure TEMPORARY. The turn is running
     * again, so the marks that said it had failed come off — and the transient
     * card that stood for the attempt that died moves onto that attempt's own
     * record, where the `< >` pager can still reach it. Nothing is hidden; it
     * stops being the headline.
     *
     * The re-send's own captured `<system-reminder>` blocks (spec/02 §
     * System-reminder disclosure) join the bubble's disclosures in the same
     * step. A restart re-send carries the restart notice, and folding the
     * attempt without it hid exactly the block that disclosure exists for.
     *
     * Returns false when there is no bubble to fold onto (the original scrolled
     * out of a trimmed timeline). The caller then appends the message normally —
     * NO FALLBACK to swallowing a user turn the host really did persist.
     */
    function foldRetryAttempt(
      chatId: string,
      seq: number,
      retryOfSeq: number,
      systemContext: SystemContextItem[] | undefined,
    ): boolean {
      const isAnchor = (e: ChatEventEntry): boolean =>
        e.kind === 'message' &&
        e.role === 'user' &&
        (e.seq === retryOfSeq || (e.attempts?.some((a) => a.seq === retryOfSeq) ?? false));
      if (!timelines[chatId]?.some(isAnchor)) return false;
      const anchorIdx = timelines[chatId]!.findIndex(isAnchor);
      const anchor = timelines[chatId]![anchorIdx]!;
      const prior = anchor.attempts ?? [{ seq: anchor.seq }];
      // Idempotent: a replay hands the same re-send back, and an attempt must
      // not be counted twice (that is how "Retried twice" becomes a lie).
      if (prior.some((a) => a.seq === seq)) return true;
      // Whatever ended the PREVIOUS attempt belongs to that attempt. The
      // server's out-of-band `daemon_unavailable` card was already filed there
      // by `clearTransientErrors`; this is the other shape — a generic
      // `sdk_error`, which is marked on the bubble itself rather than drawn as
      // a card of its own.
      const settled = prior.map((a, i) =>
        i !== prior.length - 1 ||
        a.error !== undefined ||
        anchor.turnFailed !== true ||
        anchor.turnErrorMessage === undefined
          ? a
          : { ...a, error: anchor.turnErrorMessage, errorCode: 'sdk_error' },
      );
      const updated = ownTimeline(chatId);
      updated[updated.findIndex(isAnchor)] = {
        ...anchor,
        attempts: [...settled, { seq }],
        // The turn is in flight again, so every mark that said it had stopped
        // is describing a condition that is over.
        turnFailed: false,
        turnErrorMessage: undefined,
        turnFailedSeq: undefined,
        turnInterrupted: false,
        turnStopped: false,
        deliveryPending: false,
        deliveryFailed: false,
        ...(systemContext && systemContext.length > 0
          ? { systemContext: [...(anchor.systemContext ?? []), ...systemContext] }
          : {}),
      };
      return true;
    }

    for (const event of events) {
      // A retracted chat never existed (spec/04 § Spawn — a refused spawn). The
      // host's spawn-time `chat.error` for it can arrive after the refusal has
      // already been handled, and `ensureRow` would take that as a new chat and
      // draw the ghost row back into the sidebar. Ignore it outright — there is
      // no chat to update and no transcript to record it in.
      if (
        'chatId' in event &&
        typeof event.chatId === 'string' &&
        retractedChatIds.has(event.chatId)
      ) {
        continue;
      }
      // Host refusals with no chat of their own (`host.update` finding no
      // artifact, a refused settings edit) are addressed to `pending-spawn`.
      // PatchWs turns them into a toast; recording one as a chat would draw a
      // stray "New chat" row in the sidebar.
      if (event.type === 'chat.error' && event.chatId === 'pending-spawn') continue;
      switch (event.type) {
        case 'chat.spawned': {
          const row = ensureRow(event.chatId, event.folder);
          chats[event.chatId] = {
            ...row,
            daemonId: event.daemonId,
            folder: event.folder,
            // spec/08 § Action, spec/14 § Sidebar — Automations: set ONCE, at
            // spawn, never re-derived later. `event.jobId` is absent both for a
            // user-started chat and for an old-daemon frame (wire back-compat);
            // either way `null` (never a job) is correct — an old host never
            // spawns jobs of its own for this field to be lying about.
            jobId: event.jobId ?? null,
            // spec/04 § Spawn: set ONCE, at spawn, never re-derived later.
            // `event.model` is absent for an old-daemon frame (wire back-compat)
            // or a host with no model catalogue support — either way `null`
            // (unknown) is correct, never a guess.
            model: event.model ?? null,
          };
          break;
        }
        case 'chat.state': {
          const row = ensureRow(event.chatId, event.folder);
          // `lastUpdated` is host-owned and only ever set from state frames,
          // so an older one is a replay/race, not news. Applying it rolled
          // `activity` back: a tick on a working chat, orange on a finished one.
          if (event.lastUpdated < row.lastUpdated) break;
          // An UNRESOLVED pending permission is the canonical "agent paused on a
          // yes/no" signal (spec/14 ## Status badges → `permission`). The mock
          // backend (and the SDK under `bypassPermissions`) emits the permission
          // event and then completes the turn, so a trailing `chat.activity:
          // idle` arrives while the prompt is still unanswered. We must NOT let
          // that settle the row back to `done` — the badge + waiting-pill stay
          // on `permission` until the user actually approves/denies. NO FALLBACK:
          // the pending list is cleared explicitly on response, not by a timer.
          const hasPending = row.pendingPermissions.length > 0;
          const nextActivity = hasPending ? 'awaiting-permission' : event.activity;
          chats[event.chatId] = {
            ...row,
            activity: nextActivity,
            // The turn is over, so no tool call is in flight. The counter is
            // client-side and only a tool_result decrements it; a result that
            // never arrived would otherwise pin the row on `working` for good.
            openToolCalls:
              event.activity === 'idle' || event.activity === 'errored'
                ? 0
                : (row.openToolCalls ?? 0),
            openCallIds:
              event.activity === 'idle' || event.activity === 'errored'
                ? []
                : (row.openCallIds ?? []),
            // Rendered as reported. The host resolved it against the host
            // default the surface does not hold (spec/02 § Permission mode).
            permissionMode: event.permissionMode,
            status: event.status ?? row.status,
            pinned: event.pinned ?? row.pinned,
            pinnedAt: event.pinnedAt ?? row.pinnedAt,
            disabled: event.disabled ?? row.disabled,
            name: event.name ?? row.name,
            // G2-d4: the first-user-message preview is captured once by the
            // host and never cleared; never let an absent field wipe it.
            preview: event.preview ?? row.preview,
            // Goal CAN be cleared (null is meaningful) — only keep the existing
            // goal when the event omits the field (undefined), not when it's null.
            goal: event.goal !== undefined ? event.goal : row.goal,
            goalProgress: event.goalProgress !== undefined ? event.goalProgress : row.goalProgress,
            lastGoal: event.lastGoal !== undefined ? event.lastGoal : row.lastGoal,
            // Reminder CAN be cleared (null is meaningful) — only keep the existing
            // reminder when the event omits the field (undefined), not when it's null.
            reminder: event.reminder !== undefined ? event.reminder : row.reminder,
            // Pending self-wake (spec/02 § Self-wake) — drives the wake bar above
            // the chat. Clears to null when the wake fires or is cancelled, so
            // only keep the existing value when the field is OMITTED.
            pendingWake: event.pendingWake !== undefined ? event.pendingWake : row.pendingWake,
            // Task list (spec/02 § Task list) — drives the task bar. An empty list
            // is meaningful (finished / cleared), so only keep the known list when
            // the field is OMITTED (a payload predating the feature).
            todos: event.todos !== undefined ? event.todos : row.todos,
            // Snooze (spec/04 § Snooze). `null` is meaningful — the host clears
            // it when the snooze elapses — so only keep the existing value when
            // the field is OMITTED (a payload predating the feature).
            snoozedUntil: event.snoozedUntil !== undefined ? event.snoozedUntil : row.snoozedUntil,
            // Hidden (spec/04 § Hidden). ABSENT from a host predating the
            // field, so keep what is known; `false` is meaningful (shown).
            hidden: event.hidden !== undefined ? event.hidden : row.hidden,
            // Current status (patch/todo.md § Features to add). Regenerated after
            // each turn; a null in the event means "no status yet", so keep the
            // existing summary only when the field is OMITTED (undefined) — a
            // back-compat payload predating the feature — never overwrite a real
            // summary with an absent field.
            statusSummary:
              event.statusSummary !== undefined ? event.statusSummary : row.statusSummary,
            statusKind: event.statusKind !== undefined ? event.statusKind : row.statusKind,
            statusDeclared:
              event.statusDeclared !== undefined ? event.statusDeclared : row.statusDeclared,
            folder: event.folder ?? row.folder,
            lastUpdated: event.lastUpdated,
            // spec/14 § Sidebar ordering — an older host never sends the
            // field, so keep what is known rather than losing the sort key.
            lastUserActivity: event.lastUserActivity ?? row.lastUserActivity,
            awaitingPermission: hasPending || event.activity === 'awaiting-permission',
            // Rate-limit auto-resume timestamp — null when no retry is pending,
            // set when the host schedules one, cleared when it fires. Null is
            // meaningful so only keep the existing value when OMITTED (undefined).
            rateLimitResumingAt:
              event.rateLimitResumingAt !== undefined
                ? event.rateLimitResumingAt
                : row.rateLimitResumingAt,
            // Resume kind (rate_limit vs overloaded) — cleared alongside
            // rateLimitResumingAt. Absent on payloads from older hosts.
            resumeKind: event.resumeKind !== undefined ? event.resumeKind : row.resumeKind,
            // The figures behind the pause — which account, which pool, how
            // full, when it clears. Same absent/null rule as the two above.
            limitBlock:
              event.limitBlock !== undefined ? event.limitBlock : (row.limitBlock ?? null),
            // spec/04 § Model — a chat's model can change mid-chat, and this is
            // how the change reaches every surface holding the chat, including
            // the ones that did not ask for it. It is also the acknowledgement of
            // THIS surface's `chat.model_request`.
            //
            // An ABSENT field means "unchanged, and don't guess": a host too old
            // to know the field never sends it, and wiping the known model to null
            // on its every state emit would blank the header crumb of a perfectly
            // healthy chat.
            model: event.model !== undefined ? event.model : row.model,
            // spec/10 § Backend credentials — the account the latest turn ran
            // on. Absent until this host has run one; keep what is known.
            account: event.account !== undefined ? event.account : (row.account ?? null),
            // spec/02 § Background task completions — how much of this chat's
            // work is still in flight now the turn has ended. `0` is meaningful
            // (the last task finished), so only an ABSENT field keeps the known
            // count: a host too old to track them sends nothing, and reading
            // that as "none running" would be a state nobody measured.
            backgroundTasks:
              event.backgroundTasks !== undefined
                ? event.backgroundTasks
                : (row.backgroundTasks ?? null),
            context: event.context !== undefined ? event.context : (row.context ?? null),
          };
          // The host is speaking for this chat again. If it reports anything
          // other than `errored`, the daemon-link-lost notice the SERVER raised
          // while the host was gone has resolved — the turn carried on, or was
          // re-sent on restart, exactly as the message promised. Clear it.
          // Nothing else clears it: no timer, and not `daemon.online` on its own
          // (a host returning says nothing about whether THIS chat's turn did).
          // If the host never comes back there is no such event and the notice
          // stays, which is the truth.
          if (event.activity !== 'errored') clearTransientErrors(event.chatId);
          // The chat's turn is in flight, so it is not parked on a limit — the
          // host clears the pause as the next turn starts, and the two states
          // cannot both be true (spec/12 § A usage or rate limit). Drop the
          // pause whatever this frame's own fields said, so a host path that
          // forgets to publish the clear cannot leave a notice describing a
          // limit that is blocking nothing, behind a `Try now` with nothing to
          // run. `idle` and `errored` are NOT triggers: an armed pause is an
          // idle chat and a limit nobody parked is an errored one.
          if (clearsLimitPause(event.activity)) {
            const settled = chats[event.chatId]!;
            if (
              settled.limitBlock !== null ||
              settled.rateLimitResumingAt !== null ||
              settled.resumeKind !== null
            ) {
              chats[event.chatId] = {
                ...settled,
                limitBlock: null,
                rateLimitResumingAt: null,
                resumeKind: null,
              };
            }
          }
          break;
        }
        case 'chat.message_delta': {
          // Live incremental assistant text (spec/02 includePartialMessages).
          // Accumulate into a single in-flight streaming entry so the reply
          // renders progressively, chunk by chunk; the turn's final
          // `chat.message` then supersedes it. This is transient/live-only —
          // never persisted, never arrives on replay.
          //
          // The accumulator is matched by the `streaming` flag, NOT by seq: a
          // resumed chat's replayed history carries line-index-derived seqs
          // (history.ts KNOWN LIMITATION) that can collide with this turn's
          // canonical `messageSeq`, so a seq match would append onto an OLD
          // message. At most one entry is streaming at a time (the host runs
          // one turn per chat), so the flag uniquely identifies it.
          const row = ensureRow(event.chatId);
          chats[event.chatId] = {
            ...row,
            lastSeq: Math.max(row.lastSeq, event.messageSeq),
          };
          const existingList = timelines[event.chatId];
          const list = existingList ? [...existingList] : [];
          const idx = list.findIndex(
            (e) => e.kind === 'message' && e.role === 'assistant' && e.streaming === true,
          );
          if (idx >= 0) {
            const prev = list[idx]!;
            /* v8 ignore next -- defensive only: the streaming accumulator entry is always created below with `content: event.delta` (a string, never undefined), so `prev.content` is always defined by the time a second delta arrives. */
            const content = (prev.content ?? '') + event.delta;
            list[idx] = { ...prev, content, seq: event.messageSeq, streaming: true };
            // Do NOT touch `preview`: the sidebar row preview is the durable
            // first-user-message label (chatRunner captures it once, never
            // overwrites it). Letting live assistant text drive it makes the
            // left-hand label flip around as a turn streams.
          } else {
            insertLive(list, {
              seq: event.messageSeq,
              kind: 'message',
              role: 'assistant',
              content: event.delta,
              streaming: true,
              ...(answersHandoff(list) ? { voice: true } : {}),
              at: Date.now(),
            });
            // Preview is left untouched here too — see the note above.
          }
          timelines[event.chatId] = list;
          break;
        }
        case 'chat.message': {
          const row = ensureRow(event.chatId);
          // A failure the host raised (a failed turn, a damaged transcript) is
          // an error card, never a plain paragraph that reads as the model
          // talking. (seq, kind) is its identity so a repeated replay draws it once.
          if (event.error) {
            chats[event.chatId] = { ...row, lastSeq: Math.max(row.lastSeq, event.seq) };
            const held = timelines[event.chatId];
            if (held?.some((e) => e.kind === 'error' && e.seq === event.seq)) break;
            pushTimeline(event.chatId, {
              seq: event.seq,
              kind: 'error',
              content: event.content,
              at: Date.now(),
            });
            break;
          }
          // spec/02 § Context compression — a boundary is its own kind of entry,
          // not a message: it renders as a disclosure line, is never streamed,
          // reconciled or edited, and none of the message bookkeeping below
          // applies to it. It carries a canonical seq, so (seq, kind) is its
          // identity on a repeated replay.
          // spec/02 § Permission mode — the record of a mid-conversation mode
          // change. Like a compaction boundary it is transcript furniture, not
          // a message: never streamed, reconciled or edited, and identified by
          // (seq, kind) so a repeated replay draws it once.
          if (event.permissionModeChange !== undefined) {
            chats[event.chatId] = { ...row, lastSeq: Math.max(row.lastSeq, event.seq) };
            const list = timelines[event.chatId];
            if (list?.some((e) => e.kind === 'permission_mode' && e.seq === event.seq)) break;
            pushTimeline(event.chatId, {
              seq: event.seq,
              kind: 'permission_mode',
              content: event.content,
              permissionMode: event.permissionModeChange,
              ...(event.permissionModeChangeAutomatic
                ? { permissionModeChangeAutomatic: true }
                : {}),
              at: Date.now(),
            });
            break;
          }
          if (event.compaction) {
            chats[event.chatId] = { ...row, lastSeq: Math.max(row.lastSeq, event.seq) };
            const list = timelines[event.chatId];
            if (list?.some((e) => e.kind === 'compaction' && e.seq === event.seq)) break;
            pushTimeline(event.chatId, {
              seq: event.seq,
              kind: 'compaction',
              content: event.content,
              compaction: event.compaction,
              at: Date.now(),
            });
            break;
          }
          // Voice turns carry the host's `[voice • …]` tag — strip it for both
          // display and reconcile (the optimistic echo is the clean transcript).
          const content =
            event.role === 'user' || event.role === 'assistant'
              ? stripVoicePrefix(event.content)
              : event.content;
          // Said in a call: the user's own words, or the fast voice's reply (the
          // host tags both). A hand-off request is not spoken words.
          const spoken = isSpokenInCall(event.content);
          // If this turn streamed in via `chat.message_delta`, an in-flight
          // streaming assistant entry already exists — finalise it in place
          // (set the authoritative content + canonical seq, clear `streaming`)
          // rather than appending a duplicate. Matched by the `streaming` flag,
          // not seq (see chat.message_delta for the resume-seq-collision reason).
          if (event.role === 'assistant') {
            const existing = timelines[event.chatId];
            const sidx = existing
              ? existing.findIndex(
                  (e) => e.kind === 'message' && e.role === 'assistant' && e.streaming === true,
                )
              : -1;
            if (sidx >= 0 && existing) {
              const updated = [...existing];
              updated[sidx] = {
                ...updated[sidx]!,
                content,
                seq: event.seq,
                streaming: false,
                ...(spoken || answersHandoff(existing) ? { voice: true } : {}),
                ...(event.createdAt !== undefined ? { messageAt: event.createdAt } : {}),
              };
              timelines[event.chatId] = updated;
              chats[event.chatId] = {
                ...row,
                // Preview stays the durable first-user-message label — an
                // assistant reply must never overwrite it (see chat.message_delta).
                lastSeq: Math.max(row.lastSeq, event.seq),
              };
              break;
            }
          }
          // Do NOT touch `lastUpdated` here. The host owns that timestamp and
          // ships it on `chat.state` (it's `msg.ts` for the real message, not the
          // moment a frame happens to arrive at this client). Bumping it on every
          // `chat.message` would corrupt it during a `chat.replay`, where the
          // whole history re-arrives — every replayed message would reset
          // `lastUpdated` to "now", which is exactly what defeated mark-read.
          chats[event.chatId] = {
            ...row,
            // Durable first-user-message label: seed it ONCE from the first user
            // message and never let a later message (user or assistant) overwrite
            // it, so the sidebar row preview stays stable instead of flipping.
            preview: row.preview ?? (event.role === 'user' ? content.slice(0, 140) : row.preview),
            lastSeq: Math.max(row.lastSeq, event.seq),
            // A user message after a call means that call is over: a cancelled
            // call never gets a tool_result, so a replay would otherwise
            // reopen it and its row would tick forever.
            ...(event.role === 'user' && event.retryOfSeq === undefined
              ? { openToolCalls: 0, openCallIds: [] }
              : {}),
          };
          // spec/12 § A turn is owed until it settles — the host is re-sending
          // a turn it has already drawn a bubble for. Fold it onto that bubble
          // as another ATTEMPT instead of drawing the same sentence again. A
          // surface NEVER sets this field, so a user retyping the same thing is
          // unaffected: that is a new turn and gets a new bubble.
          if (event.role === 'user' && event.retryOfSeq !== undefined) {
            if (foldRetryAttempt(event.chatId, event.seq, event.retryOfSeq, event.systemContext))
              break;
            // The bubble it names is not here (a trimmed timeline). Fall through
            // and render it as its own message: showing the turn twice is worse
            // than showing it once, but dropping a user message the host
            // really did persist would be hiding it, which is the bug.
          }
          // ALREADY HELD: this exact persisted turn is in the timeline. A surface
          // can be handed the same transcript more than once — opening a chat asks
          // for a replay, and the socket completing its connect a moment later
          // asks again for every held chat, both with `fromSeq: -1` because
          // neither has rendered anything yet — and that put two of every message
          // on screen. The canonical seq is the identity ("the seq a surface saw
          // live is the seq that message replays under"), so the same (seq, role,
          // content) is the same turn: update it in place, never append. Content
          // is part of the key deliberately — a resumed chat's replayed history
          // can carry line-index-derived seqs that COLLIDE with a live seq
          // (history.ts KNOWN LIMITATION), and two different messages must not
          // silently swallow one another.
          {
            const list = timelines[event.chatId];
            const held = list
              ? list.findIndex(
                  (e) =>
                    e.kind === 'message' &&
                    e.seq === event.seq &&
                    e.role === event.role &&
                    e.content === content &&
                    e.localId === undefined &&
                    e.streaming !== true,
                )
              : -1;
            if (held >= 0 && list) {
              const updated = [...list];
              updated[held] = {
                ...updated[held]!,
                ...(event.createdAt !== undefined ? { messageAt: event.createdAt } : {}),
                ...(event.attachments && event.attachments.length > 0
                  ? { attachments: event.attachments }
                  : {}),
              };
              timelines[event.chatId] = updated;
              break;
            }
          }
          // Reconcile an optimistic outgoing user message (rendered locally on
          // send) with its persisted echo when it re-arrives on a `chat.replay`
          // after reconnect — match by content on an entry still carrying a
          // localId, and promote it to the real seq rather than appending a dup.
          if (event.role === 'user') {
            const list = timelines[event.chatId];
            // `localId` is the IDENTITY of the turn (spec/03 — chat.input carries
            // it "for dedup"; the host echoes it on the persisted user message).
            // Match on it FIRST and match on content only for an echo that carries
            // none — a turn sent from another surface, or an older host. Content
            // equality is not identity: the host persists what the transcript
            // will yield, which drifts from what was typed (injected context
            // blocks, command wrappers, voice prefixes), and every such drift used
            // to render the user's message twice.
            const byLocalId =
              event.localId === undefined || !list
                ? -1
                : list.findIndex((e) => e.kind === 'message' && e.localId === event.localId);
            const idx =
              byLocalId >= 0
                ? byLocalId
                : list
                  ? list.findIndex(
                      (e) =>
                        e.localId !== undefined &&
                        e.kind === 'message' &&
                        e.role === 'user' &&
                        e.content === content &&
                        // A turn still uploading has not been sent, so no
                        // persisted copy can be its echo — a same-text turn
                        // from another surface must not swallow it.
                        e.upload === undefined,
                    )
                  : -1;
            // A voice note's live "Transcribing…" placeholder (addTranscribingMessage)
            // starts with `content: ''`, so the content match above can't catch it —
            // it's still empty at the moment the persisted `[voice • web]` copy
            // broadcasts back over the main WS, which can win the race against the
            // HTTP upload response that would otherwise fill it via
            // resolveTranscription. Fold into that placeholder instead of appending
            // a second entry: at most one is ever in flight per chat, so no other
            // identifier is needed. resolveTranscription itself is a safe no-op
            // after this (its own localId lookup finds nothing once cleared below).
            const transcribingIdx =
              idx >= 0 || !list
                ? -1
                : list.findIndex(
                    (e) => e.kind === 'message' && e.role === 'user' && e.transcribing === true,
                  );
            const finalIdx = idx >= 0 ? idx : transcribingIdx;
            const prev = finalIdx >= 0 && list ? list[finalIdx] : undefined;
            if (prev && list) {
              const updated = [...list];
              // The persisted echo confirms delivery — drop any delivery marks.
              updated[finalIdx] = {
                ...prev,
                content,
                seq: event.seq,
                localId: undefined,
                transcribing: false,
                deliveryPending: false,
                deliveryFailed: false,
                // The persisted copy only exists once the turn has left the queue.
                // `chat.dequeued` is live-only, so a surface that missed it would
                // otherwise keep showing a delivered message as queued.
                queued: false,
                ...(event.midTurn
                  ? { midTurn: true, midTurnStep: stepsInCurrentTurn(list, finalIdx) }
                  : {}),
                ...(spoken ? { voice: true } : {}),
                ...(event.createdAt !== undefined ? { messageAt: event.createdAt } : {}),
                ...(event.systemContext && event.systemContext.length > 0
                  ? { systemContext: event.systemContext }
                  : {}),
                ...(event.jobTrigger ? { jobTrigger: true } : {}),
                ...(event.hookTrigger ? { hookTrigger: event.hookTrigger } : {}),
                ...(event.goalTrigger ? { goalTrigger: event.goalTrigger } : {}),
              };
              timelines[event.chatId] = updated;
              break;
            }
          }
          pushTimeline(event.chatId, {
            seq: event.seq,
            kind: 'message',
            role: event.role,
            // spec/10 § Backend credentials — a turn that moved to another
            // account because the last ran out. The host's line carries no
            // time; the reset is shown here, in the reader's own zone.
            content: event.accountSwitch ? accountSwitchLine(event.accountSwitch) : content,
            ...(event.attachments && event.attachments.length > 0
              ? { attachments: event.attachments }
              : {}),
            ...(event.midTurn
              ? { midTurn: true, midTurnStep: stepsInCurrentTurn(timelines[event.chatId]) }
              : {}),
            ...(event.createdAt !== undefined ? { messageAt: event.createdAt } : {}),
            ...(event.systemContext && event.systemContext.length > 0
              ? { systemContext: event.systemContext }
              : {}),
            ...(event.jobTrigger ? { jobTrigger: true } : {}),
            ...(event.hookTrigger ? { hookTrigger: event.hookTrigger } : {}),
            ...(event.goalTrigger ? { goalTrigger: event.goalTrigger } : {}),
            ...(event.synthetic ? { synthetic: true } : {}),
            ...(event.role === 'user' && isVoiceHandoff(event.content)
              ? { voiceHandoff: true }
              : {}),
            ...(spoken || (event.role === 'assistant' && answersHandoff(timelines[event.chatId]))
              ? { voice: true }
              : {}),
            at: Date.now(),
          });
          break;
        }
        case 'chat.error': {
          // A turn that FAILED is an outcome, not a non-event (spec/12 § No
          // fallbacks — "when something breaks, it's visible, not silently
          // absorbed"). The host emits this at a canonical seq for every refused
          // or errored turn; without a case here the message simply sat in the
          // transcript with no reply and no reason, which reads as the app being
          // broken rather than as something that went wrong and can be acted on.
          //
          // Out-of-band errors (a refusal that never took a seq) all arrive with
          // the same sentinel seq, so identity is (seq, code, message) — a replay
          // of the same failure updates nothing rather than stacking a second card.
          const row = ensureRow(event.chatId);
          chats[event.chatId] = { ...row, lastSeq: Math.max(row.lastSeq, event.seq) };
          const cur = timelines[event.chatId] ?? [];
          // An unclassified agent/SDK failure (as opposed to a specific,
          // recoverable case like an offline host or invalid session) is
          // attached to the message that failed, not rendered as its own
          // standalone line — the same "tap to retry" treatment as an
          // undelivered input, so every "this didn't get a reply" case reads
          // the same way (spec/12 § Guaranteed input delivery).
          if (event.error.code === 'sdk_error') {
            const alreadyApplied = cur.some(
              (e) => e.kind === 'message' && e.turnFailedSeq === event.seq,
            );
            if (alreadyApplied) break;
            // Matched by the persisted message's own seq, NOT its localId: the
            // host always persists (and this store reconciles/clears the
            // localId off of) the user's chat.message BEFORE the SDK query that
            // can produce this failure even starts, so by the time this event
            // arrives the target entry's localId is already gone. Its seq
            // survives that reconciliation, so it is the identity that works.
            // A folded turn's later attempts have seqs of their own, and the
            // failure of attempt 3 names attempt 3 — so the bubble that owns
            // that seq is found through its attempt list as well as its own.
            let targetIdx =
              event.causeSeq !== undefined
                ? cur.findIndex(
                    (e) =>
                      e.kind === 'message' &&
                      (e.seq === event.causeSeq ||
                        (e.attempts?.some((a) => a.seq === event.causeSeq) ?? false)),
                  )
                : -1;
            if (targetIdx < 0) {
              // Older host (no causeSeq on the event yet) — the failed turn's
              // own message is the newest user entry not already marked failed.
              for (let i = cur.length - 1; i >= 0; i--) {
                const e = cur[i]!;
                if (e.kind === 'message' && e.role === 'user' && !e.turnFailed) {
                  targetIdx = i;
                  break;
                }
              }
            }
            if (targetIdx >= 0) {
              const updated = [...cur];
              updated[targetIdx] = {
                ...updated[targetIdx]!,
                turnFailed: true,
                turnErrorMessage: event.error.message,
                turnFailedSeq: event.seq,
              };
              timelines[event.chatId] = updated;
              break;
            }
            // NO FALLBACK to silently dropping a failure that can't be
            // attached anywhere (e.g. its message already scrolled out of a
            // trimmed timeline) — fall through to the generic error row so it
            // is never hidden.
          }
          const already = cur.some(
            (e) =>
              e.kind === 'error' &&
              e.seq === event.seq &&
              e.errorCode === event.error.code &&
              e.content === event.error.message,
          );
          if (already) break;
          pushTimeline(event.chatId, {
            seq: event.seq,
            kind: 'error',
            errorCode: event.error.code,
            content: event.error.message,
            at: Date.now(),
          });
          break;
        }
        case 'chat.queued': {
          // spec/04 ## Message queueing: a user turn parked behind the running
          // turn. Flag the sender's optimistic message (matched by localId) as
          // queued; if it came from another surface, append it as a pending turn.
          ensureRow(event.chatId);
          const list = timelines[event.chatId] ? [...timelines[event.chatId]!] : [];
          const idx = list.findIndex((e) => e.localId === event.localId && e.kind === 'message');
          if (idx >= 0 && list[idx]!.queued === true) {
            // Already queued: this is the host re-announcing it after its
            // text was edited (spec/04 ## Message queueing § Edit). Update the
            // text IN PLACE — the turn keeps its place in the queue.
            list[idx] = { ...list[idx]!, content: event.message };
          } else if (idx >= 0) {
            // `chat.queued` is a positive delivery signal (spec/12): the host
            // received and parked this turn — clear the delivery-pending mark so
            // it renders as type-ahead-queued, not "sending…". These are distinct
            // states; only ONE applies at a time. Move it to the tail so it sits
            // BELOW the live transcript even if turn output raced in between the
            // optimistic send and this event (spec/04 ## Message queueing).
            const [msg] = list.splice(idx, 1);
            list.push({
              ...msg!,
              queued: true,
              deliveryPending: false,
              deliveryFailed: false,
            });
          } else {
            list.push({
              // Local-timestamp seq sorts after real stream seqs (see addLocalMessage).
              seq: Date.now(),
              kind: 'message',
              role: 'user',
              content: event.message,
              localId: event.localId,
              queued: true,
              at: Date.now(),
            });
          }
          timelines[event.chatId] = list;
          break;
        }
        case 'chat.stopped': {
          // spec/14 § Running-turn controls — an interrupted turn is an OUTCOME,
          // not a non-event. The host settles the chat idle with NO chat.error
          // and NO reply, so with no case here the stopped message reads exactly
          // like one still being worked on, and any half-streamed reply keeps its
          // live caret forever.
          const stoppedRow = chats[event.chatId];
          if (stoppedRow?.openToolCalls || stoppedRow?.openCallIds?.length) {
            chats[event.chatId] = { ...stoppedRow, openToolCalls: 0, openCallIds: [] };
          }
          const cur = timelines[event.chatId];
          if (!cur) break;
          const list = [...cur];
          // The reply stopped mid-stream: settle it so the caret goes away and the
          // partial text reads as all there is.
          for (let i = list.length - 1; i >= 0; i--) {
            const e = list[i]!;
            if (e.kind === 'message' && e.role === 'assistant' && e.streaming) {
              list[i] = { ...e, streaming: false };
              break;
            }
          }
          // Promoted vs bare stop (spec/09 § A turn the user stopped): on a
          // PROMOTE, `chat.stopped` lands before the drain's own `chat.dequeued`
          // / `chat.state{running}` for the turn it promoted, so `activity` is
          // still `running` here — the session resumed on its own, the agent DID
          // see this turn, and there is nothing to do. On a BARE stop (nothing
          // queued), the aborted run's own settle already flipped `activity` to
          // `idle` before this event arrives, so a running chat here means a
          // promote and anything else (idle, or no row at all) means bare.
          const promoted = chats[event.chatId]?.activity === 'running';
          // The interrupted turn's own message is the newest user entry that had
          // actually started: anything still `queued` (type-ahead behind this
          // turn) or `deliveryPending` (not yet observed) was never the running
          // turn, and one already resolved to a failure is not an interruption.
          for (let i = list.length - 1; i >= 0; i--) {
            const e = list[i]!;
            if (e.kind !== 'message' || e.role !== 'user') continue;
            if (e.queued || e.deliveryPending || e.deliveryFailed || e.turnFailed) continue;
            list[i] = promoted ? { ...e, turnInterrupted: true } : { ...e, turnStopped: true };
            break;
          }
          timelines[event.chatId] = list;
          break;
        }
        case 'chat.dequeued': {
          // The queued turn left the queue: 'running' → it's now live (clear the
          // queued flag so it renders as a normal turn); 'cancelled' → drop it.
          const cur = timelines[event.chatId];
          if (cur) {
            const idx = cur.findIndex((e) => e.localId === event.localId && e.kind === 'message');
            if (idx >= 0) {
              const list = [...cur];
              if (event.reason === 'cancelled') {
                list.splice(idx, 1);
              } else {
                list[idx] = { ...list[idx]!, queued: false };
              }
              timelines[event.chatId] = list;
            }
          }
          break;
        }
        case 'chat.branches': {
          // spec/04 § Branching — the chat's track graph. Not a transcript event:
          // it describes the chat, so it touches no timeline entry.
          ensureRow(event.chatId);
          branchGraphs = {
            ...branchGraphs,
            [event.chatId]: {
              activeBranchId: event.activeBranchId,
              branches: event.branches,
            },
          };
          break;
        }
        case 'chat.tool_run_summary': {
          const row = ensureRow(event.chatId);
          chats[event.chatId] = { ...row, lastSeq: Math.max(row.lastSeq, event.seq) };
          const first = event.callIds[0];
          if (first === undefined) break;
          toolRunSummaries = {
            ...toolRunSummaries,
            [event.chatId]: {
              ...toolRunSummaries[event.chatId],
              [first]: {
                callIds: event.callIds,
                summary: event.summary,
                ...(event.error !== undefined ? { error: event.error } : {}),
              },
            },
          };
          break;
        }
        case 'chat.artifact': {
          const row = ensureRow(event.chatId);
          chats[event.chatId] = {
            ...row,
            lastSeq: Math.max(row.lastSeq, event.seq),
          };
          // Republish = same artifactId: replace the existing card in place
          // (spec/14 § Artifacts) rather than adding a near-identical second one.
          const cur = timelines[event.chatId];
          const existing = cur
            ? cur.findIndex((e) => e.kind === 'artifact' && e.artifactId === event.artifactId)
            : -1;
          const entry: ChatEventEntry = {
            seq: event.seq,
            kind: 'artifact',
            artifactId: event.artifactId,
            artifactTitle: event.title,
            artifactUrl: event.url,
            artifactPath: event.path,
            at: Date.now(),
          };
          if (cur && existing >= 0) {
            const list = [...cur];
            list[existing] = entry;
            timelines[event.chatId] = list;
          } else {
            pushTimeline(event.chatId, entry);
          }
          break;
        }
        case 'chat.tool_call': {
          const row = ensureRow(event.chatId);
          chats[event.chatId] = {
            ...row,
            lastSeq: Math.max(row.lastSeq, event.seq),
          };
          // ALREADY HELD (see the `chat.message` / `chat.error` reconciliation
          // above): a chat.replay can re-arrive for a transcript we've already
          // rendered — opening a chat requests it, and the socket's own connect
          // handler asks again for every held chat a moment later, both from
          // `fromSeq: -1`. Without this guard the re-delivered call was appended
          // a SECOND time at the tail via `pushTimeline`, landing after whatever
          // later messages had already been (correctly) deduped back into their
          // original position — a tool call rendering out of message order. The
          // callId is the identity of a call (a second delivery at another seq is
          // still the same call, not a second row).
          const cur = timelines[event.chatId] ?? [];
          const already = cur.some((e) => e.kind === 'tool_call' && e.callId === event.callId);
          if (already) break;
          chats[event.chatId] = {
            ...chats[event.chatId]!,
            // A row the host has already settled (idle/errored, with a state
            // frame or REST snapshot behind it) is not working: this call is a
            // replayed one whose result never came, and counting it pinned a
            // finished chat on the orange `working` badge. A live call re-arms
            // the count via the `chat.state{running}` that accompanies it.
            openToolCalls:
              (row.activity === 'idle' || row.activity === 'errored') && row.lastUpdated > 0
                ? (row.openToolCalls ?? 0)
                : (row.openToolCalls ?? 0) + 1,
            openCallIds: (row.openCallIds ?? []).includes(event.callId)
              ? row.openCallIds!
              : [...(row.openCallIds ?? []), event.callId],
          };
          pushTimeline(event.chatId, {
            seq: event.seq,
            kind: 'tool_call',
            tool: event.tool,
            toolArgs: event.args,
            callId: event.callId,
            at: Date.now(),
            ...(event.startedAt !== undefined ? { startedAt: event.startedAt } : {}),
          });
          break;
        }
        case 'chat.tool_result': {
          const row = ensureRow(event.chatId);
          chats[event.chatId] = {
            ...row,
            lastSeq: Math.max(row.lastSeq, event.seq),
          };
          // Same re-delivered-replay guard as chat.tool_call above.
          const cur = timelines[event.chatId] ?? [];
          const already = cur.some(
            (e) => e.kind === 'tool_result' && e.seq === event.seq && e.callId === event.callId,
          );
          if (already) break;
          chats[event.chatId] = {
            ...chats[event.chatId]!,
            openToolCalls: Math.max(0, (row.openToolCalls ?? 0) - 1),
            openCallIds: (row.openCallIds ?? []).filter((id) => id !== event.callId),
          };
          pushTimeline(event.chatId, {
            seq: event.seq,
            kind: 'tool_result',
            tool: event.tool,
            toolResult: event.result,
            callId: event.callId,
            at: Date.now(),
          });
          break;
        }
        case 'chat.provider_context': {
          // spec/02 § Provider-level context — ONE row per `providerType`,
          // not one per occurrence (these recur constantly within a session):
          // upsert to the latest label/text, counting repeats, keeping the
          // FIRST seq as the row's stable position and the LATEST as the
          // replay-dedup guard below.
          const row = ensureRow(event.chatId);
          const existingEntry = row.providerContext?.[event.providerType];
          // A chat.replay can re-deliver an event already applied (opening a
          // chat re-asks from fromSeq: -1, same as chat.tool_call/tool_result
          // above) — without this guard every reopen would double-count.
          if (existingEntry && event.seq <= existingEntry.lastSeq) {
            chats[event.chatId] = { ...row, lastSeq: Math.max(row.lastSeq, event.seq) };
            break;
          }
          chats[event.chatId] = {
            ...row,
            lastSeq: Math.max(row.lastSeq, event.seq),
            providerContext: {
              ...row.providerContext,
              [event.providerType]: {
                label: event.label,
                text: event.text,
                count: (existingEntry?.count ?? 0) + 1,
                firstSeq: existingEntry?.firstSeq ?? event.seq,
                lastSeq: event.seq,
              },
            },
          };
          break;
        }
        case 'chat.delegate_update': {
          const row = ensureRow(event.chatId);
          chats[event.chatId] = { ...row, lastSeq: Math.max(row.lastSeq, event.seq) };
          delegateUpdates = {
            ...delegateUpdates,
            [event.chatId]: {
              ...delegateUpdates[event.chatId],
              [event.delegateId]: {
                label: event.label,
                status: event.status,
                since: delegateUpdates[event.chatId]?.[event.delegateId]?.since ?? Date.now(),
              },
            },
          };
          break;
        }
        case 'chat.permission_request': {
          // spec/14 § Side threads panel — a side branch's own question is
          // tagged with its branchId. The main transcript draws only the
          // active branch's track, so this does NOT go into the chat's own
          // pendingPermissions/timeline (there is no honest place to show it
          // there); it goes to the panel's own map instead, keyed per branch.
          const activeBranchId = branchGraphs[event.chatId]?.activeBranchId;
          if (event.branchId !== undefined && event.branchId !== activeBranchId) {
            const key = `${event.chatId}::${event.branchId}`;
            const existing = sideThreadPermissions[key] ?? [];
            if (existing.some((p) => p.requestId === event.requestId)) break;
            sideThreadPermissions = {
              ...sideThreadPermissions,
              [key]: [
                ...existing,
                {
                  requestId: event.requestId,
                  tool: event.request.tool,
                  description: event.request.description,
                  args: event.request.args,
                  ...(event.expiry !== undefined ? { expiry: event.expiry } : {}),
                },
              ],
            };
            break;
          }
          const row = ensureRow(event.chatId);
          // ALREADY HELD — the same re-delivered-replay guard as chat.tool_call /
          // chat.tool_result above, but this event reaches it by a WIDER path.
          // `replayChat` in the host (G2-d1) deliberately re-emits the canonical
          // `chat.permission_request` for every STILL-PENDING permission on the
          // chat, and that re-emit is NOT gated on the replay's `fromSeq` the way
          // the transcript events are. So every subsequent replay re-delivers it —
          // not only two racing from `fromSeq: -1` (which ws.ts's
          // `lastReplayCursor` already suppresses), but the ordinary "leave a chat
          // with a pending Write approval and come back" replay from a further-on
          // cursor. Without this guard that drew the Approve/Deny card twice.
          //
          // `requestId` alone is the identity: the host mints it with
          // `randomUUID()` per request (`askPermission`) and keys its own
          // `pendingPermissions` / `pendingPermissionEvents` / `permissionGates`
          // maps on it, so unlike a tool call it needs no seq+callId pair.
          //
          // Both halves must dedup. The duplicate timeline entry is the visible
          // "shows twice"; a duplicate `pendingPermissions` entry for the same
          // requestId is just as wrong — it inflates the awaiting-permission state
          // and makes the "Approve all outstanding" sweep resolve the same request twice.
          const curPerm = timelines[event.chatId] ?? [];
          const alreadyHeld =
            curPerm.some((e) => e.kind === 'permission' && e.requestId === event.requestId) ||
            row.pendingPermissions.some((p) => p.requestId === event.requestId);
          if (alreadyHeld) {
            // Still advance the cursor: the re-delivery is a real, in-order event,
            // and dropping its seq would leave the chat re-asking for history it
            // already holds.
            chats[event.chatId] = { ...row, lastSeq: Math.max(row.lastSeq, event.seq) };
            break;
          }
          const perm: PendingPermission = {
            requestId: event.requestId,
            tool: event.request.tool,
            description: event.request.description,
            args: event.request.args,
            // Same deadline the timeline entry gets below — carried on the ROW
            // too so the sidebar badge's ring can drain in step with the
            // question card's own countdown (spec/14 § Status badges; Tom:
            // "this blue outer circle should go down along with the question
            // timer its waiting on").
            ...(event.expiry !== undefined ? { expiry: event.expiry } : {}),
          };
          chats[event.chatId] = {
            ...row,
            awaitingPermission: true,
            activity: 'awaiting-permission',
            pendingPermissions: [...row.pendingPermissions, perm],
            lastSeq: Math.max(row.lastSeq, event.seq),
          };
          pushTimeline(event.chatId, {
            seq: event.seq,
            kind: 'permission',
            tool: event.request.tool,
            requestId: event.requestId,
            permissionDescription: event.request.description,
            // The card needs the tool's own arguments, not just its name: an
            // `AskUserQuestion` renders the questions and options from here
            // (spec/14 § Main chat panel — Question prompts).
            toolArgs: event.request.args,
            ...(event.expiry !== undefined ? { permissionExpiry: event.expiry } : {}),
            at: Date.now(),
          });
          break;
        }
        default:
          continue; // unhandled event type — no state change
      }
      // Reached only when a case above broke out of the switch; the `default`
      // arm and the retracted-chat guard both `continue` past it. So this marks
      // exactly "some event in this batch was handled".
      changed = true;
    }

    if (!changed) return;

    // The chat the user is currently viewing is, by definition, read: anything
    // that lands while it's open has been seen. Pin its read watermark to its
    // `lastSeq` so the post-open `chat.replay` (which raises `lastSeq` AFTER the
    // mount-time markRead already ran) does not re-flip it to unread, and so
    // genuinely-new live messages in the open chat don't show a stale `done`.
    //
    // Gated on the tab actually being visible: the route that owns
    // `activeChatId` unmounts only on navigation, so it stays "active" while
    // merely backgrounded (phone locked, switched app, occluded desktop
    // window). Without this, a turn that finished while nobody was looking
    // still pinned the watermark here, so the sidebar skipped the green
    // `done` dot entirely and went straight to the grey `read` tick the
    // moment anyone looked — the bug this guard exists to stop.
    const activeId = state.activeChatId;
    const activeTabVisible = typeof document === 'undefined' || !document.hidden;
    if (activeTabVisible && activeId && chats[activeId]) {
      const arow = chats[activeId];
      if (arow.lastReadSeq < arow.lastSeq) {
        chats[activeId] = { ...arow, lastReadSeq: arow.lastSeq };
        // Persist so the read state survives a reload (the active chat is, by
        // definition, read up to its latest seq).
        saveReadWatermark(activeId, arow.lastSeq);
      }
    }

    set({
      chats: reuseUnchangedRows(state.chats, chats),
      timelines,
      branchGraphs,
      sideThreadPermissions,
      toolRunSummaries,
      delegateUpdates,
    });
  },

  resolvePermission(chatId, requestId, decision, answers) {
    const state = get();
    const row = state.chats[chatId];
    if (!row) return;
    const remaining = row.pendingPermissions.filter((p) => p.requestId !== requestId);
    const chats = {
      ...state.chats,
      [chatId]: {
        ...row,
        pendingPermissions: remaining,
        // Clear the paused flag only when nothing else is outstanding; the
        // activity itself settles via the host's follow-up `chat.state`.
        awaitingPermission: remaining.length > 0,
        ...(remaining.length === 0 && row.activity === 'awaiting-permission'
          ? { activity: 'running' as const }
          : {}),
      },
    };
    const existing = state.timelines[chatId];
    const timelines = existing
      ? {
          ...state.timelines,
          [chatId]: existing.map((e) =>
            e.kind === 'permission' && e.requestId === requestId
              ? e.permissionResolved === 'approve' && decision === 'deny'
                ? { ...e, permissionCancelled: true }
                : {
                    ...e,
                    permissionResolved: decision,
                    ...(answers !== undefined ? { permissionAnswers: answers } : {}),
                  }
              : e,
          ),
        }
      : state.timelines;
    set({ chats, timelines });
  },

  resolveSideThreadPermission(chatId, branchId, requestId) {
    const key = `${chatId}::${branchId}`;
    const state = get();
    const existing = state.sideThreadPermissions[key];
    if (!existing) return;
    set({
      sideThreadPermissions: {
        ...state.sideThreadPermissions,
        [key]: existing.filter((p) => p.requestId !== requestId),
      },
    });
  },

  updatePermissionExpiry(chatId, requestId, expiry) {
    const state = get();
    const existing = state.timelines[chatId];
    if (!existing) return;
    const timelines = {
      ...state.timelines,
      [chatId]: existing.map((e) =>
        e.kind === 'permission' && e.requestId === requestId && !e.permissionResolved
          ? { ...e, permissionExpiry: expiry }
          : e,
      ),
    };
    set({ timelines });
  },

  clearPendingPermissions(chatId) {
    const state = get();
    const row = state.chats[chatId];
    if (!row || row.pendingPermissions.length === 0) return;
    set({
      chats: {
        ...state.chats,
        [chatId]: {
          ...row,
          pendingPermissions: [],
          awaitingPermission: false,
          ...(row.activity === 'awaiting-permission' ? { activity: 'idle' as const } : {}),
        },
      },
    });
  },

  setActiveChat(chatId) {
    set({ activeChatId: chatId });
    if (chatId !== null) get().markRead(chatId);
  },

  addLocalMessage(chatId, content, localId, folder, attachments, opts) {
    const state = get();
    if (opts?.dedupeAgainstPersisted) {
      // Voice call echo only (`opts.dedupeAgainstPersisted`): this fires when
      // the client's OWN transcript-final event lands, which races the
      // host's persisted `chat.message` broadcast for the same spoken turn
      // arriving over the main WS first (the host mints its own localId for
      // the injected turn, unrelated to this client's one, so the reconcile
      // match above has nothing to fold into and pushes it as a plain entry).
      // Without this guard this call then adds an undeduped second copy. NOT
      // applied to typed sends (the default/composer path): those always call
      // this BEFORE the message reaches the server, so a same-content
      // persisted entry found there is a genuinely distinct earlier message,
      // not this race — suppressing it would silently drop a legitimate
      // repeat send.
      const existing = state.timelines[chatId];
      const alreadyPersisted = existing?.some(
        (e) =>
          e.kind === 'message' &&
          e.role === 'user' &&
          e.content === content &&
          e.localId === undefined,
      );
      if (alreadyPersisted) return;
    }
    const list = state.timelines[chatId] ? [...state.timelines[chatId]] : [];
    const local = opts?.localAttachments ?? [];
    list.push({
      // Local monotonic seq: real stream seqs are small integers, so a
      // timestamp sorts after them and keeps the optimistic message last until
      // its persisted echo reconciles it.
      seq: Date.now(),
      kind: 'message',
      role: 'user',
      content,
      localId,
      // The live echo of words said in a call (the only caller that dedupes against the
      // persisted copy) is a spoken message from the first frame.
      ...(opts?.dedupeAgainstPersisted ? { voice: true } : {}),
      // spec/12: every optimistic send starts delivery-pending until the surface
      // observes it take effect (ack / queued / running / reply / error). A
      // turn with local files to upload starts in the upload state instead:
      // nothing has been sent yet (spec/15 § Composer → Attachments).
      deliveryPending: local.length === 0,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
      ...(local.length > 0
        ? { localAttachments: local, upload: { done: 0, total: local.length, failed: false } }
        : {}),
      at: Date.now(),
    });
    // For a brand-new chat (the `+ New chat` flow) the row doesn't exist yet —
    // `chat.spawned` lands a beat after createChat returns. Seed an optimistic
    // row so ChatRoute renders the transcript immediately instead of flashing
    // "chat not found yet"; the spawned/state events reconcile it in place.
    const row = state.chats[chatId] ?? emptyRow(chatId, folder ?? '');
    set({
      timelines: { ...state.timelines, [chatId]: list },
      chats: {
        ...state.chats,
        // Seed the durable first-user-message preview ONCE — a later optimistic
        // send must not overwrite it, or the sidebar label flips around.
        [chatId]: { ...row, preview: row.preview ?? content.slice(0, 140) },
      },
    });
  },

  addTranscribingMessage(chatId, localId, folder) {
    const state = get();
    const list = state.timelines[chatId] ? [...state.timelines[chatId]] : [];
    list.push({
      // Local-timestamp seq sorts after real stream seqs (see addLocalMessage),
      // keeping the optimistic bubble last until its persisted echo reconciles it.
      seq: Date.now(),
      kind: 'message',
      role: 'user',
      content: '',
      localId,
      transcribing: true,
      at: Date.now(),
    });
    // Seed an optimistic row so ChatRoute renders the bubble immediately even for
    // a brand-new chat (the voice-note-starts-a-chat flow); events reconcile it.
    const row = state.chats[chatId] ?? emptyRow(chatId, folder ?? '');
    set({
      timelines: { ...state.timelines, [chatId]: list },
      chats: { ...state.chats, [chatId]: row },
    });
  },

  resolveTranscription(chatId, localId, transcript) {
    const cur = get().timelines[chatId];
    if (!cur) return;
    const idx = cur.findIndex((e) => e.localId === localId && e.kind === 'message');
    if (idx < 0) return;
    const text = transcript.trim();
    const list = [...cur];
    if (!text) {
      // Nothing was recognised — drop the placeholder rather than leaving a
      // perpetual empty "Transcribing…" bubble.
      list.splice(idx, 1);
      set({ timelines: { ...get().timelines, [chatId]: list } });
      return;
    }
    // Fill the SAME bubble in place. Keep `localId` so the persisted `[voice •
    // web]` copy reconciles by content on replay (chatStore.stripVoicePrefix)
    // instead of appending a duplicate. The upload returned 200 (turn delivered),
    // so it is NOT delivery-pending.
    list[idx] = {
      ...list[idx]!,
      content: text,
      transcribing: false,
      deliveryPending: false,
      deliveryFailed: false,
    };
    set({ timelines: { ...get().timelines, [chatId]: list } });
  },

  cancelTranscription(chatId, localId) {
    const cur = get().timelines[chatId];
    if (!cur) return;
    const list = cur.filter((e) => !(e.localId === localId && e.kind === 'message'));
    if (list.length === cur.length) return;
    set({ timelines: { ...get().timelines, [chatId]: list } });
  },

  ensureChat(chatId, folder) {
    const state = get();
    if (state.chats[chatId]) return;
    set({ chats: { ...state.chats, [chatId]: emptyRow(chatId, folder) } });
  },

  patchLocalMessage(chatId, localId, patch) {
    const cur = get().timelines[chatId];
    const idx = cur ? cur.findIndex((e) => e.localId === localId && e.kind === 'message') : -1;
    if (!cur || idx < 0) return;
    const list = [...cur];
    const next: ChatEventEntry = { ...list[idx]!, ...patch };
    // A key patched to `undefined` is cleared, not kept as an own key.
    for (const k of Object.keys(patch) as Array<keyof ChatEventEntry>) {
      if (patch[k] === undefined) delete next[k];
    }
    list[idx] = next;
    set({ timelines: { ...get().timelines, [chatId]: list } });
  },

  removeLocalMessage(chatId, localId) {
    const cur = get().timelines[chatId];
    if (!cur) return;
    set({
      timelines: {
        ...get().timelines,
        [chatId]: cur.filter((e) => !(e.localId === localId && e.kind === 'message')),
      },
    });
  },

  removeQueued(chatId, localId) {
    const cur = get().timelines[chatId];
    if (!cur) return;
    const list = cur.filter((e) => !(e.localId === localId && e.queued === true));
    if (list.length === cur.length) return;
    set({ timelines: { ...get().timelines, [chatId]: list } });
  },

  clearDelivery(chatId, localId) {
    updateDeliveryEntry(get, set, chatId, localId, {
      deliveryPending: false,
      deliveryFailed: false,
    });
  },

  failDelivery(chatId, localId) {
    updateDeliveryEntry(get, set, chatId, localId, {
      deliveryPending: false,
      deliveryFailed: true,
    });
  },

  retryDelivery(chatId, localId) {
    updateDeliveryEntry(get, set, chatId, localId, {
      deliveryPending: true,
      deliveryFailed: false,
    });
  },

  markRead(chatId) {
    const row = get().chats[chatId];
    if (!row) return;
    // Advance the read watermark to whatever seq we've seen so far. New activity
    // (seq > this) re-marks the chat unread; a `chat.replay` of older seqs does
    // not. Never lower the watermark — guards against an out-of-order call.
    const nextRead = Math.max(row.lastReadSeq, row.lastSeq);
    if (nextRead === row.lastReadSeq) return;
    set({
      chats: {
        ...get().chats,
        [chatId]: { ...row, lastReadSeq: nextRead },
      },
    });
    // Persist the watermark so the visit→read transition survives a reload.
    saveReadWatermark(chatId, nextRead);
  },

  setKebabOpen(chatId) {
    set({ openKebabFor: chatId });
  },

  setArchived(chatId, archived) {
    const row = get().chats[chatId];
    if (!row) return;
    set({
      chats: {
        ...get().chats,
        [chatId]: { ...row, status: archived ? 'archived' : 'active' },
      },
    });
  },

  setDisabled(chatId, disabled) {
    const row = get().chats[chatId];
    if (!row) return;
    set({
      chats: {
        ...get().chats,
        [chatId]: { ...row, disabled },
      },
    });
  },

  setSnoozed(chatId, snoozedUntil) {
    const row = get().chats[chatId];
    if (!row) return;
    set({
      chats: {
        ...get().chats,
        [chatId]: { ...row, snoozedUntil },
      },
    });
  },

  setHidden(chatId, hidden) {
    const row = get().chats[chatId];
    if (!row) return;
    set({
      chats: {
        ...get().chats,
        [chatId]: { ...row, hidden },
      },
    });
  },

  setDeleted(chatId, deleted) {
    const row = get().chats[chatId];
    if (!row) return;
    set({
      chats: {
        ...get().chats,
        [chatId]: { ...row, status: deleted ? 'deleted' : 'active' },
      },
    });
  },

  setPinned(chatId, pinned) {
    const row = get().chats[chatId];
    if (!row) return;
    set({
      chats: {
        ...get().chats,
        [chatId]: {
          ...row,
          pinned,
          pinnedAt: pinned ? Date.now() : null,
        },
      },
    });
  },

  setName(chatId, name) {
    const row = get().chats[chatId];
    if (!row) return;
    set({
      chats: {
        ...get().chats,
        [chatId]: { ...row, name },
      },
    });
  },

  setGoal(chatId, goal) {
    const row = get().chats[chatId];
    if (!row) return;
    // Optimistic reset of the live counters too (mirrors the host's own
    // `setGoal`): a NEW goal starts the bar fresh rather than showing the
    // previous goal's turns/tokens until the server's chat.state confirms it.
    const goalProgress: ChatRow['goalProgress'] =
      goal === null
        ? null
        : {
            startedAt: Date.now(),
            turnsEvaluated: 0,
            tokensSpent: 0,
            lastVerdict: null,
            lastReason: null,
          };
    set({
      chats: {
        ...get().chats,
        [chatId]: { ...row, goal, goalProgress },
      },
    });
  },

  setReminder(chatId, reminder) {
    const row = get().chats[chatId];
    if (!row) return;
    set({
      chats: {
        ...get().chats,
        [chatId]: { ...row, reminder },
      },
    });
  },

  setTodos(chatId, todos) {
    const row = get().chats[chatId];
    if (!row) return;
    set({
      chats: {
        ...get().chats,
        [chatId]: { ...row, todos },
      },
    });
  },

  removeChat(chatId) {
    // The chat is gone, so its unsent composer text goes with it (spec/14
    // § Composer). Only on a HARD removal — an archived chat keeps its text,
    // which is why nothing here prunes against the chats map.
    clearComposerDraft(chatId);
    const { [chatId]: _row, ...restChats } = get().chats;
    const { [chatId]: _tl, ...restTimelines } = get().timelines;
    void _row;
    void _tl;
    const next: Partial<ChatState> = { chats: restChats, timelines: restTimelines };
    if (get().activeChatId === chatId) next.activeChatId = null;
    if (get().openKebabFor === chatId) next.openKebabFor = null;
    set(next as ChatState);
  },

  retractChat(chatId) {
    // Oldest-first eviction: a Set iterates in insertion order, so the first
    // key is the oldest tombstone. Only ever holds ids of chats that do not
    // exist, so evicting one can never resurrect a real chat.
    if (retractedChatIds.size >= RETRACTED_LIMIT) {
      const oldest = retractedChatIds.values().next();
      if (!oldest.done) retractedChatIds.delete(oldest.value);
    }
    retractedChatIds.add(chatId);
    get().removeChat(chatId);
  },

  clearTimeline(chatId) {
    set((s) => ({ timelines: { ...s.timelines, [chatId]: [] } }));
  },

  _reset() {
    retractedChatIds.clear();
    set({
      chats: {},
      hydrated: false,
      branchGraphs: {},
      sideThreadPermissions: {},
      activeChatId: null,
      openKebabFor: null,
      timelines: {},
      toolRunSummaries: {},
      delegateUpdates: {},
      folderRoster: [],
      sectionCounts: null,
    });
  },
}));

export type { ChatRow, DisplayBadge };
export { deriveBadge };
