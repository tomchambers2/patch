// Mobile chatStore — same model as the web one (chats keyed by id, per-chat
// timeline). Ported with React Native idioms (no document/visibility).

import { create } from 'zustand';
import type {
  AttachmentRef,
  ChatBranch,
  ChatDelegateUpdateEvent,
  PermissionMode,
  SystemContextItem,
  TodoItem,
  WireEvent,
} from '@patch/wire';
import { isTransientChatError } from '@patch/wire';
import {
  deriveBadge,
  type ChatListRow,
  type ChatRow,
  type DisplayBadge,
  type PendingPermission,
  type ProviderContextEntry,
} from './types';
import { loadCachedChatList, saveCachedChatList } from '../lib/chatListCache';

/** A closed tool run's AI summary (spec/14 § Tool runs), or why there is none. */
export interface ToolRunSummary {
  callIds: string[];
  /** Null exactly when generation failed; `error` then says why. */
  summary: string | null;
  error?: string;
}

/** A `patch_delegate` subagent's live state (spec/15 § Chat detail —
 *  mirrors web's store of the same name), from `chat.delegate_update`. */
export interface DelegateUpdateInfo {
  label: string;
  status: ChatDelegateUpdateEvent['status'];
  /** Epoch ms this surface first saw the subagent — the running-time clock. */
  since: number;
}

export interface ChatEventEntry {
  seq: number;
  kind:
    | 'message'
    | 'tool_call'
    | 'tool_result'
    | 'permission'
    | 'system'
    | 'error'
    | 'artifact'
    | 'permission_mode';
  role?: 'user' | 'assistant' | 'system';
  content?: string;
  /**
   * spec/02 § Permission mode — the mode the chat moved to, on a
   * `permission_mode` entry. `content` is the one-line record the host wrote.
   */
  permissionMode?: PermissionMode;
  /**
   * spec/02 § Per-turn process / warm sessions — a `system` line Claude Code
   * wrote itself (`model: "<synthetic>"`), such as `No response requested.`.
   * Not the agent speaking. Mirrors the wire `ChatMessageEvent.synthetic`.
   */
  synthetic?: boolean;
  tool?: string;
  toolArgs?: unknown;
  toolResult?: unknown;
  callId?: string;
  requestId?: string;
  permissionDescription?: string;
  /**
   * Composer attachments carried by a user turn (spec/15 § Composer). Refs
   * only; the renderer builds each inline URL from the chatId + id. Set on the
   * optimistic outgoing echo and on a persisted `chat.message` that carries them.
   */
  attachments?: AttachmentRef[];
  /**
   * spec/02 § System-reminder disclosure — every `<system-reminder>` block
   * this user turn received, in injection order, including those of any
   * re-send folded onto it (a restart re-send carries the restart notice).
   * Drawn as collapsed rows under the bubble; absent when there were none.
   */
  systemContext?: SystemContextItem[];
  /**
   * The user turn arrived by voice — the host prepends a `[voice • <surface>]`
   * tag (specialThreads.ts). We strip that literal text (it's agent context, not
   * display copy) and set this flag so the stream renders a small mic glyph next
   * to the bubble instead of the raw bracket text (spec/15 § Chat detail).
   */
  voice?: boolean;
  /**
   * spec/07 § The fast voice and the chat's agent — a request a call's fast
   * voice handed to the agent, not the user's words. Drawn as a muted line.
   */
  voiceHandoff?: boolean;
  /**
   * Idempotency key of an OUTGOING user turn (spec/03). Set on the optimistic
   * echo so the delivery state machine (below) can key its flags to it.
   */
  localId?: string;
  /**
   * `chat.error.error.code` on an `error` entry — the machine-readable half of a
   * failed turn (`sdk_error`, `claude_oauth_missing`, `daemon_unavailable`…).
   * The human half is `content`.
   */
  errorCode?: string;
  /**
   * On an `artifact` entry (spec/14 § Artifacts, spec/15 § Artifacts) —
   * `artifactId` is stable per source file, so a republish updates THIS entry
   * (chatStore's `chat.artifact` handler) rather than appending a second one.
   */
  artifactId?: string;
  artifactTitle?: string;
  artifactUrl?: string;
  artifactPath?: string;
  /**
   * spec/12 § Guaranteed input delivery — submitted but not yet OBSERVED to
   * take effect (no ack / running / reply / error). Renders "Sending…" when the
   * host is online and "Queued — will send when the agent reconnects" when it
   * is offline. Cleared the moment delivery is observed. NOT a silent spinner.
   */
  deliveryPending?: boolean;
  /** spec/12 — redeliveries exhausted: renders "Not delivered — tap to retry". */
  deliveryFailed?: boolean;
  /**
   * spec/04 ## Message queueing — a user turn parked behind the running turn.
   * Set by `chat.queued`, cleared by `chat.dequeued{running}`; removed by
   * `chat.dequeued{cancelled}`. Held at the timeline tail. DISTINCT from
   * `deliveryPending` (waiting on the host reconnecting): only one applies.
   */
  queued?: boolean;
  /**
   * spec/15 § Composer → Attachments — the files an outgoing turn was sent
   * with, as the LOCAL copies the user picked. The bubble draws its
   * attachments from these (the turn is on screen before any upload lands);
   * `attachments` above gains the server refs, index for index, once they do.
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
   * Every ATTEMPT this ONE turn has been run as, oldest first (spec/12 § What a
   * recovery leaves behind). A host re-send — a restart resume, a rung of the
   * error ladder — is the same turn going round again, not a second message, so
   * it folds in here instead of appending a bubble. Absent on a turn that has
   * only ever run once, which is almost all of them.
   */
  attempts?: { seq: number; error?: string; errorCode?: string }[];
  /**
   * On a `permission` entry: the decision this request was answered with
   * (spec/15 § Chat detail). Set once the answer is known — by this surface's
   * own tap, or by the host's `chat.permission_response` echo when the answer
   * came from somewhere else (another surface, or the spoken yes/no voice path).
   * An entry carrying it renders the outcome instead of the options, so an
   * already-answered request cannot be answered a second time.
   */
  permissionResolved?: 'approve' | 'deny';
  /** Approved by the user, then resolved as a deny by the host (an interrupt). Keeps Approved; mirrors web. */
  permissionCancelled?: boolean;
  /**
   * The `{[questionText]: selectedOptionLabel}` an `AskUserQuestion` was
   * resolved with, once `permissionResolved` is set (mirrors web's
   * `permissionAnswers`). Only ever present on a question card. Without it,
   * a resolved card's picked options live only in transient screen state,
   * which a remount (leaving the chat and back, a reload) throws away.
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
  at: number;
  /**
   * ms epoch this turn was actually written (`ChatMessageEvent.createdAt`) —
   * the moment Claude Code persisted it, or the host minted it, NOT the
   * moment this frame happened to arrive at this client (`at`, above). `at`
   * is "now" on every replay, so it can't be shown as a message time; this is
   * the one long-press shows (matches web's `messageAt` — spec/14 §
   * Messages). Absent when the host that produced this message predates
   * the field, or the transcript line carried no timestamp of its own.
   */
  messageAt?: number;
}

// The host tags spoken turns `[voice • <surfaceKind>]` / `[voice • device:<id>]`
// (specialThreads.ts) — data, not display copy. Strip it for the transcript and
// report whether it was present so the renderer can show a mic adornment. Tolerant
// of either separator (•/·) and surrounding whitespace.
function stripVoicePrefix(s: string): { text: string; voice: boolean; handoff: boolean } {
  const m = /^\[voice(\s+hand-off)?\s*[•·]\s*[^\]]+\]\s*/.exec(s);
  if (m) return { text: s.slice(m[0].length), voice: true, handoff: m[1] !== undefined };
  return { text: s, voice: false, handoff: false };
}

interface ChatState {
  chats: Record<string, ChatRow>;
  activeChatId: string | null;
  timelines: Record<string, ChatEventEntry[]>;
  /**
   * Claude Code's own provider-level context per chat (spec/02 § Provider-level
   * context), keyed by chatId then `providerType`: one entry per category,
   * upserted with a running count. Held beside the rows rather than on them
   * because `hydrate` rebuilds rows wholesale from the roster, which knows
   * nothing of this event-sourced state.
   */
  providerContext: Record<string, Record<string, ProviderContextEntry>>;
  /**
   * spec/14 § Tool runs — each chat's AI summaries of its closed tool runs,
   * keyed by the run's FIRST call id (mirrors web's store). Not timeline
   * entries: a row of its own would split the run it labels.
   */
  toolRunSummaries: Record<string, Record<string, ToolRunSummary>>;
  /**
   * spec/15 § Chat detail — Delegate tool row: a `patch_delegate` call's live
   * state from `chat.delegate_update`, keyed by the subagent's own chatId
   * (the `id` its tool result returns) under the PARENT it was called from.
   * Mirrors web's store of the same name.
   */
  delegateUpdates: Record<string, Record<string, DelegateUpdateInfo>>;
  /**
   * spec/04 § Branching — each chat's track graph, as published by
   * `chat.branches`. Mirrors web's store of the same name. Absent for a chat
   * whose graph hasn't been seen yet.
   */
  branchGraphs: Record<string, { activeBranchId: string; branches: ChatBranch[] }>;
  /**
   * spec/15 § Side threads screen — a side branch's own `chat.permission_request`
   * (tagged with a non-active branchId) kept out of the chat's own
   * `pendingPermissions`/timeline, keyed by `${chatId}::${branchId}`. Mirrors
   * web's `sideThreadPermissions`.
   */
  sideThreadPermissions: Record<string, PendingPermission[]>;

  /**
   * Replace the whole roster with the server's answer, and mirror it to the
   * on-device cache for the next launch's first paint (spec/15 § Instant open).
   * Wholesale replacement is the point: a chat deleted or renamed elsewhere is
   * simply absent from `rows` and so cannot survive from the cache.
   */
  hydrate(rows: ChatListRow[]): void;
  /**
   * Bumped by every `hydrate`. A section that lazily merged rows the roster
   * does not carry (Archived, via `mergeRows`) watches it: the wholesale
   * replacement drops those rows, so the section fetches them again.
   */
  rosterGeneration: number;
  /**
   * Add or refresh rows the cold-start roster deliberately leaves out — the
   * Archived section's lazily-fetched list (spec/15 ## Chats tab §7). Unlike
   * `hydrate` it touches only the rows given, keeping each existing row's local
   * fields (preview, read state), and it is NOT mirrored to the on-device cache:
   * the cache holds the cold-start roster and nothing else.
   */
  mergeRows(rows: ChatListRow[]): void;
  applyEvent(event: WireEvent): void;
  /**
   * Apply a whole burst of events as ONE store commit. A `chat.replay` hands a
   * surface its entire transcript at once — 500+ events inside half a second
   * for a long-running chat — and applying them one at a time meant one
   * `set()`, one full re-render and one whole-timeline `groupToolRuns` pass per
   * event, plus an array copy per append. That is quadratic in the transcript
   * length and it is what made opening a busy chat on the phone lock the JS
   * thread for seconds. Batching makes a replay one commit: the timeline array
   * is copied once per chat per batch and appended to in place.
   */
  applyEvents(events: WireEvent[]): void;
  /**
   * Locally resolve a pending permission once the user has answered (the WS
   * `chat.permission_response` is fired separately by the chat screen). Clears
   * the request from the row's pending list, marks the timeline card resolved,
   * and drops `awaitingPermission` when nothing is left outstanding. Mirrors
   * web's store action of the same name.
   */
  resolvePermission(
    chatId: string,
    requestId: string,
    decision: 'approve' | 'deny',
    answers?: Record<string, string>,
  ): void;
  /** spec/15 § Side threads screen — drop a side branch's own permission card
   * once answered (local removal only; mirrors web's action of the same name). */
  resolveSideThreadPermission(chatId: string, branchId: string, requestId: string): void;
  setActiveChat(chatId: string | null): void;
  markRead(chatId: string): void;
  setArchived(chatId: string, archived: boolean): void;
  setPinned(chatId: string, pinned: boolean): void;
  /** Local optimistic update for snooze / unsnooze (spec/04 § Snooze). */
  setSnoozed(chatId: string, snoozedUntil: number | null): void;
  /** Local optimistic update for hide / Show (spec/04 § Hidden). */
  setHidden(chatId: string, hidden: boolean): void;
  /** Optimistic goal write (goal bar); reverted by the caller on failure. */
  setGoal(chatId: string, goal: string | null): void;
  /** Optimistic reminder write (reminder bar). */
  setReminder(chatId: string, reminder: string | null): void;
  /** Optimistic task-list write (task bar) — always the WHOLE list. */
  setTodos(chatId: string, todos: TodoItem[]): void;
  /** Optimistic disable/enable of a special thread (spec/06 § Disabled). */
  setDisabled(chatId: string, disabled: boolean): void;
  /**
   * Seed an optimistic row for a freshly-created chat that has no first message
   * yet (spec/15 § New chat flow). Mirrors web's `ensureChat`.
   *
   * The new-chat flow navigates to `/chats/<id>` the instant `POST /api/chats`
   * returns its 202 — well before the host's `chat.spawned` lands — so
   * without this the chat is not a key of `chats` at all for that window. Two
   * things break, and the second is what "New chat locked up on mobile" is:
   *
   *  1. The detail screen renders with `row === undefined`: title "Chat"
   *     instead of "New chat", folder crumb "—", and `Composer folder=
   *     undefined`, which silently disables `/` skill autocomplete.
   *  2. `api/ws.ts`'s connect handler replays only chats it finds by iterating
   *     `Object.keys(chats)`. A row-less chat is skipped, so no `chat.replay`
   *     is ever sent for it — and `chat.replay` is the ONLY thing that adds the
   *     chat to the server's per-connection `watchedChats`, which gates every
   *     `chat.message` / `chat.tool_call` / `chat.tool_result` /
   *     `chat.permission_request` (`DETAIL_LEVEL_EVENT_TYPES` in
   *     `packages/server/src/ws-hub.ts`). The chat then receives no reply ever.
   *     The phone hits this where the desktop does not, because it reconnects
   *     on every backgrounding and network change, and because on a cold start
   *     the detail screen's own mount-time `requestReplay` no-ops silently
   *     (the socket isn't open yet).
   *
   * No-op if the row already exists, so `chat.spawned`/`chat.state` reconcile
   * ONTO this row (`ensureRow` in `applyEvents` finds it) rather than racing a
   * second one into existence. This is NOT a fallback: it seeds only the two
   * facts the client genuinely knows (the id it was just given and the folder
   * the user picked); `daemonId` stays empty because the host is genuinely
   * unknown until the host names it, and a spawn that FAILS still arrives as
   * `chat.error` and renders as the red `turn-error` row in the transcript
   * (`chat.error` is deliberately not detail-gated, so it lands regardless).
   */
  ensureChat(chatId: string, folder: string): void;
  removeChat(chatId: string): void;
  appendLocalUserMessage(
    chatId: string,
    content: string,
    localId: string,
    attachments?: AttachmentRef[],
    opts?: { dedupeAgainstPersisted?: boolean; localAttachments?: LocalAttachment[] },
  ): void;
  /** Patch an outgoing turn (matched by `localId`) — upload progress, refs. */
  patchLocalMessage(chatId: string, localId: string, patch: Partial<ChatEventEntry>): void;
  /** Drop an outgoing turn the user discarded (× on a `Not uploaded` turn). */
  /** Empty a chat's timeline, so it can be rebuilt from the host (spec/15 § Instant open — a cached track the host disagrees with). */
  clearTimeline(chatId: string): void;
  removeLocalMessage(chatId: string, localId: string): void;
  /**
   * Optimistically drop a still-queued message when the user removes it (the
   * caller also fires `chat.unqueue_request`); the host's `chat.dequeued`
   * echo then no-ops. Only a `queued` entry is touched.
   */
  removeQueued(chatId: string, localId: string): void;
  /**
   * spec/12 § Guaranteed input delivery — delivery state machine for an
   * optimistic outgoing user turn, keyed by `localId`. See the web chatStore
   * for the full contract (observed → clear, exhausted → fail, retry → pending).
   */
  clearDelivery(chatId: string, localId: string): void;
  failDelivery(chatId: string, localId: string): void;
  retryDelivery(chatId: string, localId: string): void;
  _reset(): void;
}

/** A file an outgoing turn carries, as the local copy on this phone. */
export interface LocalAttachment {
  uri: string;
  name: string;
  mimeType: string;
  kind: 'image' | 'file';
}

/** Patch the delivery flags of a timeline entry matched by `localId` (spec/12). */
function patchDelivery(
  timelines: Record<string, ChatEventEntry[]>,
  chatId: string,
  localId: string,
  patch: { deliveryPending: boolean; deliveryFailed: boolean },
): Record<string, ChatEventEntry[]> | null {
  const cur = timelines[chatId];
  if (!cur) return null;
  const idx = cur.findIndex((e) => e.localId === localId && e.kind === 'message');
  if (idx < 0) return null;
  const list = [...cur];
  list[idx] = { ...list[idx]!, ...patch };
  return { ...timelines, [chatId]: list };
}

/**
 * The row with `requestId` dropped from its pending set. The paused flags clear
 * only when nothing else is outstanding — a turn can pause on several approvals
 * at once, and the activity itself settles for real on the host's follow-up
 * `chat.state`. Shared by the tap path (`resolvePermission`) and the host's
 * `chat.permission_response` echo so both leave the row in the same shape.
 */
function rowWithPermissionResolved(row: ChatRow, requestId: string): ChatRow {
  const remaining = row.pendingPermissions.filter((p) => p.requestId !== requestId);
  return {
    ...row,
    pendingPermissions: remaining,
    awaitingPermission: remaining.length > 0,
    ...(remaining.length === 0 && row.activity === 'awaiting-permission'
      ? { activity: 'running' as const }
      : {}),
  };
}

/** `approve` is the legacy boolean; `decision` wins where the sender set it. */
function decisionOf(ev: { approve: boolean; decision?: string }): 'approve' | 'deny' {
  return ev.decision === 'deny' || ev.approve === false ? 'deny' : 'approve';
}

function emptyRow(chatId: string, folder: string): ChatRow {
  return {
    chatId,
    name: null,
    // Unknown until `chat.spawned` names it.
    daemonId: '',
    folder,
    activity: 'idle',
    // The floor of the resolution chain (spec/02 § Permission mode) — replaced
    // by the host's resolved value on the first `chat.state`.
    permissionMode: 'auto',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    lastUpdated: 0,
    lastUserActivity: 0,
    awaitingPermission: false,
    lastVisitedAt: 0,
    preview: null,
    pendingPermissions: [],
    lastSeq: 0,
    pendingWake: null,
    snoozedUntil: null,
    hidden: false,
    backgroundTasks: null,
    // Unknown until the roster or `chat.spawned` names it.
    model: null,
    // A chat is a person's until the roster or `chat.spawned` names a job.
    jobId: null,
    statusSummary: null,
    statusKind: null,
    statusDeclared: null,
    goal: null,
    reminder: null,
    todos: [],
    disabled: false,
  };
}

/**
 * A roster row laid over what the store already holds for that chat. A field
 * the row OMITS (an older server, or a cache written before the field existed)
 * keeps the known value rather than being wiped — the same "omitted is
 * unchanged" rule `chat.state` follows.
 */
function mergeListRow(prior: ChatRow | undefined, r: ChatListRow): ChatRow {
  const base = prior ?? emptyRow(r.chatId, r.folder);
  return {
    ...base,
    ...r,
    model: r.model !== undefined ? r.model : (prior?.model ?? null),
    jobId: r.jobId !== undefined ? r.jobId : base.jobId,
    statusSummary: r.statusSummary !== undefined ? r.statusSummary : base.statusSummary,
    statusKind: r.statusKind !== undefined ? r.statusKind : base.statusKind,
    statusDeclared: r.statusDeclared !== undefined ? r.statusDeclared : base.statusDeclared,
    goal: r.goal !== undefined ? r.goal : base.goal,
    reminder: r.reminder !== undefined ? r.reminder : base.reminder,
    todos: r.todos !== undefined ? r.todos : base.todos,
    disabled: r.disabled !== undefined ? r.disabled : base.disabled,
    pendingWake: r.pendingWake !== undefined ? r.pendingWake : base.pendingWake,
    snoozedUntil: r.snoozedUntil !== undefined ? r.snoozedUntil : base.snoozedUntil,
    hidden: r.hidden !== undefined ? r.hidden : base.hidden,
    backgroundTasks: r.backgroundTasks !== undefined ? r.backgroundTasks : base.backgroundTasks,
  };
}

/**
 * Roster rows expanded into full store rows, keyed by id. A roster row that
 * does not carry `model` (an older server) keeps the model `existing` already
 * knows from the live stream rather than wiping it to unknown.
 */
function rowsToRecord(
  rows: ChatListRow[],
  existing: Record<string, ChatRow> = {},
): Record<string, ChatRow> {
  const next: Record<string, ChatRow> = {};
  for (const r of rows) {
    // Only the roster's own fields are laid over a FRESH row: `existing` is
    // consulted solely for fields the roster row omits (see mergeListRow).
    const prior = existing[r.chatId];
    const fresh = emptyRow(r.chatId, r.folder);
    next[r.chatId] = mergeListRow(
      prior
        ? {
            ...fresh,
            model: prior.model,
            jobId: prior.jobId,
            statusSummary: prior.statusSummary,
            statusKind: prior.statusKind,
            statusDeclared: prior.statusDeclared,
            goal: prior.goal,
            reminder: prior.reminder,
            todos: prior.todos,
            disabled: prior.disabled,
          }
        : undefined,
      r,
    );
  }
  return next;
}

/** The roster half of a full store row — what the cache round-trips. */
function toListRow(row: ChatRow): ChatListRow {
  return {
    chatId: row.chatId,
    name: row.name,
    daemonId: row.daemonId,
    folder: row.folder,
    activity: row.activity,
    permissionMode: row.permissionMode,
    status: row.status,
    pinned: row.pinned,
    pinnedAt: row.pinnedAt,
    lastUpdated: row.lastUpdated,
    lastUserActivity: row.lastUserActivity,
    pendingWake: row.pendingWake,
    snoozedUntil: row.snoozedUntil,
    hidden: row.hidden,
    backgroundTasks: row.backgroundTasks,
    model: row.model,
    jobId: row.jobId,
    statusSummary: row.statusSummary,
    statusKind: row.statusKind,
    statusDeclared: row.statusDeclared,
    goal: row.goal,
    reminder: row.reminder,
    todos: row.todos,
    disabled: row.disabled,
  };
}

/** A turn's move to another account, with when the spent one comes back. */
export function accountSwitchLine(sw: { from: string; to: string; until?: number }): string {
  const back =
    sw.until !== undefined
      ? ` until ${new Date(sw.until).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`
      : ' of credit';
  return `Switched from ${sw.from} to ${sw.to} — ${sw.from} is out${back}`;
}

export const useChatStore = create<ChatState>((set, get) => ({
  // Painted from the on-device cache SYNCHRONOUSLY, at store construction —
  // before the first render, let alone the first network call (spec/15 §
  // Instant open (read cache)). The roster fetch in `bootstrap()` overwrites it
  // moments later.
  chats: rowsToRecord(loadCachedChatList()),
  activeChatId: null,
  timelines: {},
  providerContext: {},
  toolRunSummaries: {},
  delegateUpdates: {},
  branchGraphs: {},
  sideThreadPermissions: {},
  rosterGeneration: 0,

  hydrate(rows) {
    saveCachedChatList(rows);
    set({
      chats: rowsToRecord(rows, get().chats),
      rosterGeneration: get().rosterGeneration + 1,
    });
  },

  mergeRows(rows) {
    if (rows.length === 0) return;
    const chats = { ...get().chats };
    for (const r of rows) {
      chats[r.chatId] = mergeListRow(chats[r.chatId], r);
    }
    set({ chats });
  },

  applyEvent(event) {
    get().applyEvents([event]);
  },

  applyEvents(events) {
    if (events.length === 0) return;
    const state = get();
    const chats = { ...state.chats };
    const timelines = { ...state.timelines };
    const providerContext = { ...state.providerContext };
    const toolRunSummaries = { ...state.toolRunSummaries };
    const delegateUpdates = { ...state.delegateUpdates };
    const branchGraphs = { ...state.branchGraphs };
    const sideThreadPermissions = { ...state.sideThreadPermissions };
    // Whether anything in this batch actually changed the store. A batch of
    // purely unhandled event types must not commit — an unconditional `set()`
    // hands every subscriber fresh `chats`/`timelines` identities and re-renders
    // the whole sidebar for nothing.
    let changed = false;
    // Timeline arrays this batch has already copied. The store is immutable to
    // the OUTSIDE (subscribers only ever see the previous array or the new one),
    // so within a batch we may copy once and then append in place instead of
    // copying per event.
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
        timelines[chatId] = timelines[chatId] ? [...timelines[chatId]!] : [];
        copied.add(chatId);
      }
      return timelines[chatId]!;
    }

    // A live-transcript entry slots in just before any trailing queued
    // (type-ahead) messages — a queued message stays below the live transcript
    // and never interleaves with the running turn's output (spec/04 ##
    // Message queueing).
    function pushTimeline(chatId: string, entry: ChatEventEntry): void {
      const list = ownTimeline(chatId);
      let at = list.length;
      while (at > 0 && list[at - 1]?.queued) at--;
      list.splice(at, 0, entry);
    }

    /**
     * Drop the chat's TRANSIENT error entries (`isTransientChatError` —
     * currently only `daemon_unavailable`). Mirrors web's `chatStore.ts`; see
     * the contract on `TRANSIENT_CHAT_ERROR_CODES` in `@patch/wire`. A real turn
     * failure is an outcome and is never removed.
     */
    function clearTransientErrors(chatId: string): void {
      const held = timelines[chatId];
      if (!held?.some((e) => e.kind === 'error' && isTransientChatError(e.errorCode))) return;
      const list = ownTimeline(chatId);
      for (let i = list.length - 1; i >= 0; i--) {
        const e = list[i]!;
        if (e.kind === 'error' && isTransientChatError(e.errorCode)) list.splice(i, 1);
      }
    }

    for (const event of events) {
      switch (event.type) {
        case 'chat.spawned': {
          const row = ensureRow(event.chatId, event.folder);
          // Keep the host: a chat row with no daemonId cannot answer "is this
          // machine's Claude connected?" or "whose disk is this folder on?".
          chats[event.chatId] = {
            ...row,
            daemonId: event.daemonId,
            folder: event.folder,
            // Absent on a host with no model catalogue (or an older host):
            // "unchanged, don't guess" — the same rule as `chat.state` below.
            model: event.model !== undefined ? event.model : row.model,
            // Set once at spawn by the server; a frame without it (a user's
            // chat, or an older server) never clears one already known.
            jobId: event.jobId ?? row.jobId,
          };
          break;
        }
        case 'chat.state': {
          const row = ensureRow(event.chatId, event.folder);
          chats[event.chatId] = {
            ...row,
            activity: event.activity,
            // The mode the host RESOLVED for the next turn (spec/02 § Permission
            // mode) — this is the only place a surface learns it, so a change made
            // on another surface lands here too.
            permissionMode: event.permissionMode,
            status: event.status ?? row.status,
            pinned: event.pinned ?? row.pinned,
            pinnedAt: event.pinnedAt ?? row.pinnedAt,
            name: event.name ?? row.name,
            folder: event.folder ?? row.folder,
            lastUpdated: event.lastUpdated,
            // spec/14 § Sidebar ordering — an older host never sends the
            // field, so keep what is known rather than losing the sort key.
            lastUserActivity: event.lastUserActivity ?? row.lastUserActivity,
            awaitingPermission: event.activity === 'awaiting-permission',
            // Incoming value wins whenever the host sends one (including an
            // explicit `null` clearing a fired/cancelled wake); an omitted field
            // (older host, or a `chat.state` not about the wake) preserves
            // what the row already had — matches the web chatStore.
            pendingWake: event.pendingWake !== undefined ? event.pendingWake : row.pendingWake,
            // Same rule as `pendingWake`: an explicit `null` is the host WAKING
            // the chat (spec/04 § Snooze), so it must land; an omitted field is a
            // `chat.state` about something else and preserves the known wake time.
            snoozedUntil: event.snoozedUntil !== undefined ? event.snoozedUntil : row.snoozedUntil,
            // spec/04 § Hidden — same "omitted is unchanged" rule: an explicit
            // `false` is the chat leaving Hidden and must land.
            hidden: event.hidden !== undefined ? event.hidden : row.hidden,
            // spec/02 § Background task completions — same rule again: `0` is
            // the positive claim that nothing is running and must land; an
            // omitted field (a host too old to track them) preserves what
            // the row already had rather than reading as "none running".
            backgroundTasks:
              event.backgroundTasks !== undefined
                ? event.backgroundTasks
                : (row.backgroundTasks ?? null),
            // spec/04 § Model — the model the next turn runs on. Also the
            // acknowledgement of a `chat.model_request` from ANY surface. An
            // omitted field is "unchanged", never "no model".
            model: event.model !== undefined ? event.model : row.model,
            // spec/10 § Backend credentials — the account the latest turn ran
            // on. Absent until this host has run one; keep what is known.
            account: event.account !== undefined ? event.account : (row.account ?? null),
            // The status the Manager's Chats tab ranks by — same "omitted is
            // unchanged, explicit null clears" rule as web's chatStore.
            statusSummary:
              event.statusSummary !== undefined ? event.statusSummary : row.statusSummary,
            statusKind: event.statusKind !== undefined ? event.statusKind : row.statusKind,
            statusDeclared:
              event.statusDeclared !== undefined ? event.statusDeclared : row.statusDeclared,
            // Goal / reminder / task list / disabled: same "omitted is
            // unchanged" rule — an explicit `null` (or `[]`) clears, an absent
            // field is a `chat.state` about something else. Mirrors web.
            goal: event.goal !== undefined ? event.goal : row.goal,
            reminder: event.reminder !== undefined ? event.reminder : row.reminder,
            todos: event.todos !== undefined ? event.todos : row.todos,
            disabled: event.disabled !== undefined ? event.disabled : row.disabled,
          };
          // The host is speaking for this chat again with a non-`errored`
          // activity, so the server's daemon-link-lost notice has resolved —
          // the turn carried on or was re-sent, as its message promised. Only
          // this clears it: no timer, and not `daemon.online` on its own.
          if (event.activity !== 'errored') clearTransientErrors(event.chatId);
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
          // spec/02 § Permission mode — where the mode changed part-way through
          // the conversation. Transcript furniture, not a message: none of the
          // reconcile/preview bookkeeping below applies, and (seq, kind) is its
          // identity so a repeated replay draws it once.
          if (event.permissionModeChange !== undefined) {
            chats[event.chatId] = { ...row, lastSeq: Math.max(row.lastSeq, event.seq) };
            const held = timelines[event.chatId];
            if (held?.some((e) => e.kind === 'permission_mode' && e.seq === event.seq)) break;
            pushTimeline(event.chatId, {
              seq: event.seq,
              kind: 'permission_mode',
              content: event.content,
              permissionMode: event.permissionModeChange,
              at: Date.now(),
            });
            break;
          }
          // spec/02 § Per-turn process / warm sessions — a reply Claude Code
          // wrote itself. Shown as a muted line, never as the chat's preview
          // (it is not what anyone said), and (seq) is its identity so a
          // repeated replay draws it once.
          if (event.synthetic) {
            chats[event.chatId] = { ...row, lastSeq: Math.max(row.lastSeq, event.seq) };
            const held = timelines[event.chatId];
            if (held?.some((e) => e.synthetic === true && e.seq === event.seq)) break;
            pushTimeline(event.chatId, {
              seq: event.seq,
              kind: 'message',
              role: 'system',
              content: event.content,
              synthetic: true,
              at: Date.now(),
            });
            break;
          }
          // Strip the host's `[voice • …]` tag from spoken user turns (display
          // shows the clean transcript + a mic glyph; also lets the persisted copy
          // reconcile with the optimistic, untagged echo — matches web).
          const { text, voice, handoff } =
            event.role === 'user'
              ? stripVoicePrefix(event.content)
              : event.accountSwitch
                ? // spec/10 § Backend credentials — a turn that moved account
                  // because the last ran out; the reset in the reader's zone.
                  { text: accountSwitchLine(event.accountSwitch), voice: false, handoff: false }
                : { text: event.content, voice: false, handoff: false };
          chats[event.chatId] = {
            ...row,
            preview: text.slice(0, 140),
            lastUpdated: Date.now(),
            lastSeq: Math.max(row.lastSeq, event.seq),
          };
          // Reconcile an optimistic outgoing user echo (rendered locally on send —
          // typed or voice) with its persisted copy when it re-arrives (e.g. on a
          // `chat.replay` after reconnect): match by content on an entry still
          // carrying a `localId`, promote it to the real seq, and clear delivery
          // marks — rather than appending a duplicate. Previously mobile relied
          // ONLY on the `fromSeq` replay cursor and would double the turn if the
          // same message re-arrived; this brings it in line with the web store.
          // spec/12 § What a recovery leaves behind — the host is RE-SENDING a
          // turn it has already drawn a bubble for. Fold it onto that bubble as
          // another ATTEMPT rather than drawing the same sentence again: a turn
          // that recovered is one turn, however many goes it took. A surface
          // never sets this field, so a user retyping the same thing is
          // unaffected — that is a new turn and gets a new bubble.
          if (event.role === 'user' && event.retryOfSeq !== undefined) {
            const list = timelines[event.chatId];
            const anchor = list?.findIndex(
              (e) =>
                e.kind === 'message' &&
                e.role === 'user' &&
                (e.seq === event.retryOfSeq ||
                  (e.attempts?.some((a) => a.seq === event.retryOfSeq) ?? false)),
            );
            if (list && anchor !== undefined && anchor >= 0) {
              const prev = list[anchor]!;
              const prior = prev.attempts ?? [{ seq: prev.seq }];
              // Idempotent — a replay hands the same re-send back.
              if (!prior.some((a) => a.seq === event.seq)) {
                const updated = ownTimeline(event.chatId);
                updated[anchor] = {
                  ...prev,
                  attempts: [...prior, { seq: event.seq }],
                  // The turn is in flight again, so the marks that said it had
                  // stopped describe a condition that is over.
                  deliveryPending: false,
                  deliveryFailed: false,
                  // spec/02 § System-reminder disclosure — the re-send's own
                  // blocks join the bubble's. A restart re-send carries the
                  // restart notice, and this fold is the only place it lands.
                  ...(event.systemContext && event.systemContext.length > 0
                    ? { systemContext: [...(prev.systemContext ?? []), ...event.systemContext] }
                    : {}),
                };
              }
              break;
            }
            // NO anchor to fold onto (a trimmed timeline). Fall through and
            // render it: showing the turn twice is bad, dropping a user message
            // the host really persisted is worse.
          }
          // ALREADY HELD: this exact persisted turn is in the timeline. A surface
          // can be handed the same transcript twice — opening a chat asks for a
          // replay, and the socket completing its connect a moment later asks
          // again — and that rendered two of every message. The canonical seq is
          // the identity, so the same (seq, role, content) is the same turn:
          // update it in place, never append. Content is in the key on purpose —
          // replayed history can carry seqs that collide with a live one, and two
          // different messages must not swallow each other.
          {
            const list = timelines[event.chatId];
            const held = list
              ? list.findIndex(
                  (e) =>
                    e.kind === 'message' &&
                    e.seq === event.seq &&
                    e.role === event.role &&
                    e.content === text &&
                    e.localId === undefined,
                )
              : -1;
            if (held >= 0 && list) {
              const updated = ownTimeline(event.chatId);
              updated[held] = {
                ...updated[held]!,
                ...(event.createdAt !== undefined ? { messageAt: event.createdAt } : {}),
              };
              break;
            }
          }
          if (event.role === 'user') {
            const list = timelines[event.chatId];
            // `localId` is the IDENTITY of the turn (spec/03 — chat.input carries
            // it "for dedup"; the host echoes it on the persisted user message).
            // Match on it FIRST; content only for an echo carrying none (a turn
            // sent from another surface, or an older host). Content equality is
            // not identity: the host persists what the transcript will yield,
            // which drifts from what was typed, and every drift showed the user's
            // message twice.
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
                        e.content === text &&
                        // A turn still uploading has not been sent, so no
                        // persisted copy can be its echo — a same-text turn
                        // from another surface must not swallow it.
                        e.upload === undefined,
                    )
                  : -1;
            const prev = idx >= 0 && list ? list[idx] : undefined;
            if (prev && list) {
              const updated = ownTimeline(event.chatId);
              updated[idx] = {
                ...prev,
                seq: event.seq,
                localId: undefined,
                deliveryPending: false,
                deliveryFailed: false,
                ...(voice ? { voice: true } : {}),
                // The optimistic echo cannot know what the host injected.
                ...(event.systemContext && event.systemContext.length > 0
                  ? { systemContext: event.systemContext }
                  : {}),
                ...(event.createdAt !== undefined ? { messageAt: event.createdAt } : {}),
              };
              break;
            }
          }
          pushTimeline(event.chatId, {
            seq: event.seq,
            kind: 'message',
            role: event.role,
            content: text,
            ...(event.attachments && event.attachments.length > 0
              ? { attachments: event.attachments }
              : {}),
            ...(voice ? { voice: true } : {}),
            ...(handoff ? { voiceHandoff: true } : {}),
            ...(event.systemContext && event.systemContext.length > 0
              ? { systemContext: event.systemContext }
              : {}),
            ...(event.createdAt !== undefined ? { messageAt: event.createdAt } : {}),
            at: Date.now(),
          });
          break;
        }
        case 'chat.queued': {
          // spec/04 ## Message queueing: a user turn parked behind the running
          // turn. Flag the sender's optimistic message (by localId) as queued;
          // one from another surface is appended as a queued turn.
          ensureRow(event.chatId);
          const list = ownTimeline(event.chatId);
          const idx = list.findIndex((e) => e.localId === event.localId && e.kind === 'message');
          if (idx >= 0 && list[idx]!.queued === true) {
            // The host re-announcing it after an edit (§ Edit): update the
            // text IN PLACE — the turn keeps its place in the queue.
            list[idx] = { ...list[idx]!, content: event.message };
          } else if (idx >= 0) {
            // A positive delivery signal (spec/12): clear the delivery marks so
            // it reads as queued, not "sending…", and move it to the tail so it
            // sits BELOW the live transcript even if output raced in meanwhile.
            const [msg] = list.splice(idx, 1);
            list.push({ ...msg!, queued: true, deliveryPending: false, deliveryFailed: false });
          } else {
            list.push({
              seq: -Date.now(),
              kind: 'message',
              role: 'user',
              content: event.message,
              localId: event.localId,
              queued: true,
              at: Date.now(),
            });
          }
          break;
        }
        case 'chat.dequeued': {
          // 'running' → the turn is live now (clear the flag); 'cancelled' → drop it.
          const held = timelines[event.chatId];
          const at = held
            ? held.findIndex((e) => e.localId === event.localId && e.kind === 'message')
            : -1;
          if (at < 0) break;
          const list = ownTimeline(event.chatId);
          if (event.reason === 'cancelled') list.splice(at, 1);
          else list[at] = { ...list[at]!, queued: false };
          break;
        }
        case 'chat.provider_context': {
          // spec/02 § Provider-level context — ONE entry per `providerType`:
          // the latest label/text, how many times it came, the first seq as
          // its stable position and the latest as the replay guard (a replay
          // re-delivering an applied event must not count it twice).
          const row = ensureRow(event.chatId);
          chats[event.chatId] = { ...row, lastSeq: Math.max(row.lastSeq, event.seq) };
          const held = providerContext[event.chatId] ?? {};
          const prior = held[event.providerType];
          if (prior && event.seq <= prior.lastSeq) break;
          providerContext[event.chatId] = {
            ...held,
            [event.providerType]: {
              label: event.label,
              text: event.text,
              count: (prior?.count ?? 0) + 1,
              firstSeq: prior?.firstSeq ?? event.seq,
              lastSeq: event.seq,
            },
          };
          break;
        }
        case 'chat.error': {
          // A turn that FAILED is an outcome, not a non-event (spec/12 § No
          // fallbacks). The host emits this at a canonical seq for every refused
          // or errored turn; with no case here the message sat in the transcript
          // with no reply and no reason, which reads as the app being broken
          // rather than as something that went wrong.
          const row = ensureRow(event.chatId);
          chats[event.chatId] = { ...row, lastSeq: Math.max(row.lastSeq, event.seq) };
          const cur = timelines[event.chatId] ?? [];
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
        case 'chat.tool_call': {
          const row = ensureRow(event.chatId);
          chats[event.chatId] = { ...row, lastSeq: Math.max(row.lastSeq, event.seq) };
          pushTimeline(event.chatId, {
            seq: event.seq,
            kind: 'tool_call',
            tool: event.tool,
            toolArgs: event.args,
            callId: event.callId,
            at: Date.now(),
          });
          break;
        }
        case 'chat.tool_result': {
          const row = ensureRow(event.chatId);
          chats[event.chatId] = { ...row, lastSeq: Math.max(row.lastSeq, event.seq) };
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
        case 'chat.branches': {
          // spec/04 § Branching — the chat's track graph. Not a transcript
          // event (no seq, not persisted) — see web's chatStore.ts case of the
          // same name.
          branchGraphs[event.chatId] = {
            activeBranchId: event.activeBranchId,
            branches: event.branches,
          };
          break;
        }
        case 'chat.artifact': {
          const row = ensureRow(event.chatId);
          chats[event.chatId] = { ...row, lastSeq: Math.max(row.lastSeq, event.seq) };
          // Republish = same artifactId: replace the existing card in place
          // (spec/14 § Artifacts, spec/15 § Artifacts) rather than adding a
          // near-identical second one. Mirrors web's `chatStore.ts`.
          const list = ownTimeline(event.chatId);
          const existing = list.findIndex(
            (e) => e.kind === 'artifact' && e.artifactId === event.artifactId,
          );
          const entry: ChatEventEntry = {
            seq: event.seq,
            kind: 'artifact',
            artifactId: event.artifactId,
            artifactTitle: event.title,
            artifactUrl: event.url,
            artifactPath: event.path,
            at: Date.now(),
          };
          if (existing >= 0) list[existing] = entry;
          else list.push(entry);
          break;
        }
        case 'chat.permission_request': {
          // spec/15 § Side threads screen — a side branch's own question is
          // tagged with its branchId. The main transcript draws only the
          // active branch's track, so this does NOT go into the chat's own
          // pendingPermissions/timeline; it goes to the side-thread screen's
          // own map instead, keyed per branch (mirrors web's chatStore.ts).
          const activeBranchId = branchGraphs[event.chatId]?.activeBranchId;
          if (event.branchId !== undefined && event.branchId !== activeBranchId) {
            const key = `${event.chatId}::${event.branchId}`;
            const existing = sideThreadPermissions[key] ?? [];
            if (existing.some((p) => p.requestId === event.requestId)) break;
            sideThreadPermissions[key] = [
              ...existing,
              {
                requestId: event.requestId,
                tool: event.request.tool,
                description: event.request.description,
                args: event.request.args,
              },
            ];
            break;
          }
          const row = ensureRow(event.chatId);
          // ALREADY HELD — same re-delivered-replay guard as `chat.error` above
          // and as web's `chatStore.ts`. `replayChat` in the host (G2-d1)
          // re-emits the canonical `chat.permission_request` for every
          // still-pending permission on the chat, ungated by the replay's
          // `fromSeq`, so ANY second replay re-delivers it — and without this
          // the Approve/Deny card was drawn twice. `requestId` is the identity
          // (`randomUUID()` per request in the host). Dedup BOTH halves: the
          // duplicate timeline card is the visible bug, and a duplicate
          // `pendingPermissions` entry inflates the awaiting-permission state.
          const curPerm = timelines[event.chatId] ?? [];
          const alreadyHeld =
            curPerm.some((e) => e.kind === 'permission' && e.requestId === event.requestId) ||
            row.pendingPermissions.some((p) => p.requestId === event.requestId);
          if (alreadyHeld) {
            chats[event.chatId] = { ...row, lastSeq: Math.max(row.lastSeq, event.seq) };
            break;
          }
          const perm: PendingPermission = {
            requestId: event.requestId,
            tool: event.request.tool,
            description: event.request.description,
            args: event.request.args,
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
            // `AskUserQuestion` renders the question and options from here
            // (spec/15 § Chat detail).
            toolArgs: event.request.args,
            ...(event.expiry !== undefined ? { permissionExpiry: event.expiry } : {}),
            at: Date.now(),
          });
          break;
        }
        case 'chat.permission_response': {
          // The host echoes this back to surfaces when IT resolves a request:
          // notably the spoken yes/no path (spec/07 § Permission prompts during
          // voice), where this surface never sent the response and so never
          // resolved the card itself. Without this case an answered prompt sat
          // in the transcript with its options still live for the rest of the
          // chat. The follow-up `chat.state` settles the activity but says
          // nothing about the card.
          //
          // `chatId` is carried ONLY on that host→surface echo (spec/03 — the
          // surface→host ingress keys on requestId alone); with no chatId
          // there is no card to address, so the frame is not a store event.
          if (event.chatId === undefined) continue;
          const chatId = event.chatId;
          const row = chats[chatId];
          // A response for a chat this surface has never loaded has nothing to
          // resolve — seeding a row from it would invent a chat out of an answer.
          if (!row) continue;
          chats[chatId] = rowWithPermissionResolved(row, event.requestId);
          // Same batch may carry the request that created the card (a spoken
          // answer resolves fast enough to share a flush window); the fold is
          // sequential, so the card is already in this batch's timeline copy.
          const permList = ownTimeline(chatId);
          const permIdx = permList.findIndex(
            (e) => e.kind === 'permission' && e.requestId === event.requestId,
          );
          if (permIdx >= 0) {
            const prev = permList[permIdx]!;
            permList[permIdx] =
              prev.permissionResolved === 'approve' && decisionOf(event) === 'deny'
                ? { ...prev, permissionCancelled: true }
                : {
                    ...prev,
                    permissionResolved: decisionOf(event),
                    ...(event.answers !== undefined ? { permissionAnswers: event.answers } : {}),
                  };
          }
          break;
        }
        case 'chat.permission_expiry_update': {
          // A pending question's deadline was reset by focus, on some OTHER
          // surface — mobile does not send `chat.focus_change` itself yet, but
          // it still renders the countdown ring (spec/15 § Chat detail) and
          // must not keep ticking down toward a deadline the host already
          // moved. Same batch-window race as `chat.permission_response` above.
          const permList = ownTimeline(event.chatId);
          const permIdx = permList.findIndex(
            (e) =>
              e.kind === 'permission' && e.requestId === event.requestId && !e.permissionResolved,
          );
          if (permIdx >= 0) {
            permList[permIdx] = { ...permList[permIdx]!, permissionExpiry: event.expiry };
          }
          break;
        }
        case 'chat.tool_run_summary': {
          const first = event.callIds[0];
          if (first === undefined) continue;
          toolRunSummaries[event.chatId] = {
            ...toolRunSummaries[event.chatId],
            [first]: {
              callIds: event.callIds,
              summary: event.summary,
              ...(event.error !== undefined ? { error: event.error } : {}),
            },
          };
          break;
        }
        case 'chat.delegate_update': {
          delegateUpdates[event.chatId] = {
            ...delegateUpdates[event.chatId],
            [event.delegateId]: {
              label: event.label,
              status: event.status,
              since: delegateUpdates[event.chatId]?.[event.delegateId]?.since ?? Date.now(),
            },
          };
          break;
        }
        default:
          // Not a store event — nothing to commit for it.
          continue;
      }
      changed = true;
    }

    if (!changed) return;
    set({
      chats,
      timelines,
      providerContext,
      toolRunSummaries,
      delegateUpdates,
      branchGraphs,
      sideThreadPermissions,
    });
  },

  resolvePermission(chatId, requestId, decision, answers) {
    const state = get();
    const row = state.chats[chatId];
    if (!row) return;
    const chats = { ...state.chats, [chatId]: rowWithPermissionResolved(row, requestId) };
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

  setActiveChat(chatId) {
    set({ activeChatId: chatId });
    if (chatId !== null) get().markRead(chatId);
  },

  markRead(chatId) {
    const row = get().chats[chatId];
    if (!row) return;
    set({
      chats: { ...get().chats, [chatId]: { ...row, lastVisitedAt: Date.now() } },
    });
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

  setPinned(chatId, pinned) {
    const row = get().chats[chatId];
    if (!row) return;
    set({
      chats: {
        ...get().chats,
        [chatId]: { ...row, pinned, pinnedAt: pinned ? Date.now() : null },
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

  setGoal(chatId, goal) {
    const row = get().chats[chatId];
    if (!row) return;
    set({ chats: { ...get().chats, [chatId]: { ...row, goal } } });
  },

  setReminder(chatId, reminder) {
    const row = get().chats[chatId];
    if (!row) return;
    set({ chats: { ...get().chats, [chatId]: { ...row, reminder } } });
  },

  setTodos(chatId, todos) {
    const row = get().chats[chatId];
    if (!row) return;
    set({ chats: { ...get().chats, [chatId]: { ...row, todos } } });
  },

  setDisabled(chatId, disabled) {
    const row = get().chats[chatId];
    if (!row) return;
    set({ chats: { ...get().chats, [chatId]: { ...row, disabled } } });
  },

  ensureChat(chatId, folder) {
    const state = get();
    // Already known (the row was hydrated, or `chat.spawned` beat us here) —
    // leave it exactly as it is. Overwriting would throw away the host's
    // resolved activity/permissionMode and re-seed a stale folder.
    if (state.chats[chatId]) return;
    set({ chats: { ...state.chats, [chatId]: emptyRow(chatId, folder) } });
  },

  removeChat(chatId) {
    const chats = { ...get().chats };
    const timelines = { ...get().timelines };
    const providerContext = { ...get().providerContext };
    delete chats[chatId];
    delete timelines[chatId];
    delete providerContext[chatId];
    // Drop it from the cache too, or a chat deleted on this device is painted
    // back on the next launch and only disappears once the roster fetch lands.
    saveCachedChatList(Object.values(chats).map(toListRow));
    const next: Partial<ChatState> = { chats, timelines, providerContext };
    if (get().activeChatId === chatId) next.activeChatId = null;
    set(next as ChatState);
  },

  appendLocalUserMessage(chatId, content, localId, attachments, opts) {
    // Optimistic local echo while the wire round-trip lands. Negative seq so
    // it never collides with a server seq (and is naturally ordered first
    // when a real seq arrives). Starts delivery-pending (spec/12).
    const state = get();
    if (opts?.dedupeAgainstPersisted) {
      // Voice notes only (`opts.dedupeAgainstPersisted`): the HTTP upload's
      // response reaches THIS call after the server has already sent
      // `chat.input` to the host, so the host's persisted `chat.message`
      // broadcast can win the race over the main WS and land first — with no
      // localId of ours yet to reconcile against (the host generates its
      // own), the `chat.message` handler has nothing to match and pushes it
      // as a plain entry. Without this guard this call then pushes an
      // undeduped second copy of the same turn. NOT applied to typed sends
      // (the default/composer path): those always call this BEFORE the
      // message is even sent to the server, so an existing same-content
      // persisted entry there is a genuinely distinct earlier message, not
      // a race — suppressing it would silently drop a legitimate repeat send.
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
    const list = state.timelines[chatId] ? [...state.timelines[chatId]!] : [];
    // A turn with local files to upload starts in the upload state, not
    // delivery-pending: nothing has been sent yet (spec/15 § Composer →
    // Attachments). It becomes an ordinary send once the uploads land.
    const local = opts?.localAttachments ?? [];
    list.push({
      seq: -Date.now(),
      kind: 'message',
      role: 'user',
      content,
      localId,
      deliveryPending: local.length === 0,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
      ...(local.length > 0
        ? { localAttachments: local, upload: { done: 0, total: local.length, failed: false } }
        : {}),
      at: Date.now(),
    });
    const row = state.chats[chatId] ?? emptyRow(chatId, '');
    set({
      timelines: { ...state.timelines, [chatId]: list },
      chats: {
        ...state.chats,
        [chatId]: {
          ...row,
          preview: content.slice(0, 140),
          lastUpdated: Date.now(),
          // spec/14 § Sidebar ordering — optimistic, so the row moves to the
          // top of its folder the instant the user sends, not once the
          // host's `chat.state` round-trips back.
          lastUserActivity: Date.now(),
        },
      },
    });
  },

  patchLocalMessage(chatId, localId, patch) {
    const cur = get().timelines[chatId];
    const idx = cur ? cur.findIndex((e) => e.localId === localId && e.kind === 'message') : -1;
    if (!cur || idx < 0) return;
    const list = [...cur];
    list[idx] = { ...list[idx]!, ...patch };
    set({ timelines: { ...get().timelines, [chatId]: list } });
  },

  clearTimeline(chatId) {
    set((s) => ({ timelines: { ...s.timelines, [chatId]: [] } }));
  },

  removeQueued(chatId, localId) {
    const cur = get().timelines[chatId];
    if (!cur) return;
    const list = cur.filter((e) => !(e.localId === localId && e.queued === true));
    if (list.length === cur.length) return;
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

  clearDelivery(chatId, localId) {
    const next = patchDelivery(get().timelines, chatId, localId, {
      deliveryPending: false,
      deliveryFailed: false,
    });
    if (next) set({ timelines: next });
  },

  failDelivery(chatId, localId) {
    const next = patchDelivery(get().timelines, chatId, localId, {
      deliveryPending: false,
      deliveryFailed: true,
    });
    if (next) set({ timelines: next });
  },

  retryDelivery(chatId, localId) {
    const next = patchDelivery(get().timelines, chatId, localId, {
      deliveryPending: true,
      deliveryFailed: false,
    });
    if (next) set({ timelines: next });
  },

  _reset() {
    saveCachedChatList([]);
    set({
      chats: {},
      activeChatId: null,
      timelines: {},
      providerContext: {},
      toolRunSummaries: {},
      delegateUpdates: {},
      branchGraphs: {},
      sideThreadPermissions: {},
    });
  },
}));

export type { ChatRow, DisplayBadge };
export { deriveBadge };
