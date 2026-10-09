// Server-side cache of chat state, populated by `chat.spawned` + `chat.state`
// events from the host. Drives REST endpoints like `GET /api/chats` so HTTP
// surfaces (CLI cold-start, mobile pull-to-refresh) don't need a live WS.
//
// This is a thin mirror — the host remains the source of truth for a chat's
// work, but the server OWNS what it last knew: the mirror is written to
// `<dataDir>/chat-registry.json` as it changes and read back at startup, so a
// restart begins from what the server knew rather than from nothing. A chat
// restored this way is unconfirmed until its host reports it again; when a
// host closes its re-announcement (`folders.list`), a restored chat of that
// host that it did not report is dropped, so a chat deleted while the server
// was down does not linger.
//
// Phantom-row gating (group 8 / DX-M1): a `chat.state` event for a chatId
// the registry has never seen `chat.spawned` for is dropped (with a warn).
// Without this, a `setPinned` / `setArchived` rejection that nevertheless
// emits a chat.state would synthesise a row from thin air. `chat.error` with
// a spawn-time code (`folder_not_found`) tears the row down — the spawn
// failed, the row should not exist.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { Logger } from 'pino';
import type {
  ChatErrorCode,
  ChatStateEvent,
  PendingWake,
  TodoItem,
  PermissionMode,
  StatusKind,
  WireEvent,
  ChatContextUsage,
  GoalProgress,
  FinishedGoal,
} from '@patch/wire';
import { isReservedSpecialThread } from '@patch/wire';

export interface ChatSummary {
  chatId: string;
  name: string | null;
  /**
   * One-line snippet of the first user message (G2-d4). Lets the sidebar label
   * unnamed/archived rows distinctly even when several share a folder basename.
   * Null until the first user turn lands.
   */
  preview: string | null;
  /**
   * The chat's goal (patch/todo.md — `/goal`), mirrored from the host's
   * `chat.state`. `null` when unset. Lets REST surfaces show the goal at the top
   * of the chat on cold-start without waiting for a live WS.
   */
  goal: string | null;
  /** Live progress on the chat's active goal, mirrored from the host's `chat.state`. */
  goalProgress: GoalProgress | null;
  /** The chat's most recently finished goal, mirrored from the host's `chat.state`. */
  lastGoal: FinishedGoal | null;
  /**
   * The chat's reminder (patch/todo.md — Reminders), mirrored from the host's
   * `chat.state`. `null` when unset. Lets REST surfaces show the reminder at the
   * top of the chat on cold-start without waiting for a live WS.
   */
  reminder: string | null;
  /**
   * The chat's auto-generated one-line status summary and its kind, mirrored
   * from the host's `chat.state`. `null` until one is generated. The Manager
   * watch loop reports it as the human-readable half of a watch event, and the
   * Manager view's Threads strip renders it per row (`01-server.md`
   * § Responsibilities, `14-design-web.md` § Manager view).
   */
  statusSummary: string | null;
  statusKind: StatusKind | null;
  /**
   * Whether `statusKind` is declared (a real `patch_ask_human`/`patch_report`
   * call) rather than a generated guess — see `wire/events.ts` § statusDeclared.
   */
  statusDeclared: boolean | null;
  /**
   * The chat's pending self-wake (spec/02 § Self-wake), mirrored from the
   * host's `chat.state`. `null` when nothing is armed. Lets a surface render
   * the wake bar on cold-start instead of waiting for the next live `chat.state`.
   */
  pendingWake: PendingWake | null;
  /**
   * The chat's task list (spec/02 § Task list), mirrored from the host's
   * `chat.state`. Empty until the agent writes one. Lets a surface render the
   * task bar on cold-start instead of waiting for the next live `chat.state`.
   */
  todos: TodoItem[];
  /**
   * The host this chat is pinned to, from `chat.spawned`, and changed only by
   * moving the chat (`rehome`). The mirror records it because routing a surface event to a chat's
   * host needs to know which one owns it, and REST callers list chats
   * grouped by host.
   */
  daemonId: string;
  /**
   * The EFFECTIVE permission mode the chat's next turn will use, as the host
   * resolved it. Mirrored, never re-derived: the server does not know the
   * host's default and would have to guess (spec/02 § Permission mode).
   */
  permissionMode: PermissionMode;
  folder: string;
  activity: 'idle' | 'running' | 'awaiting-permission' | 'errored';
  status: 'active' | 'archived' | 'errored' | 'deleted';
  pinned: boolean;
  /**
   * ms epoch when the chat was last pinned. Drives sidebar ordering: pinned
   * chats sort by `pinnedAt` desc (most-recent-pinned at top per spec/04).
   */
  pinnedAt: number | null;
  /**
   * A special thread turned off (spec/06 § Disabled), mirrored from the
   * host's `chat.state`. Only meaningful for Manager/Speakers —
   * `false` for every ordinary chat.
   */
  disabled: boolean;
  /**
   * ms epoch the chat is snoozed until (spec/04 § Snooze), or `null` when it is
   * not snoozed. Snoozed ⇔ `snoozedUntil > now`, so a lapsed snooze needs no
   * event to bring the chat back into the active list.
   */
  snoozedUntil: number | null;
  /**
   * Running out of the active list (spec/04 § Hidden), mirrored from the
   * host's `chat.state`. Drawn only in the sidebar's Hidden section.
   */
  hidden: boolean;
  lastUpdated: number;
  /**
   * ms epoch of the user's own last activity on this chat, mirrored from the
   * host's `chat.state` (spec/14 § Sidebar ordering). Drives sidebar
   * ordering instead of `lastUpdated` — an agent reply, a status change, a
   * job tick or a finished turn never moves it. Falls back to `lastUpdated`
   * when a host predating the field omits it, which is no worse than the
   * sort behaviour before this field existed.
   */
  lastUserActivity: number;
  /**
   * The job whose `spawn` action created this chat (spec/08 § Action), or
   * `null` for a chat a user/surface spawned. Looked up from the injected
   * `jobChatLinks` at `chat.spawned` time — never from the wire event itself,
   * since an old host has no notion of jobs and never sends one. Drives the
   * sidebar's Automations group (spec/14 § Sidebar).
   */
  jobId: string | null;
  /**
   * The model this chat is running on: what it resolved to at spawn (spec/04 §
   * Spawn), kept in step with any later change by the `model` the host
   * carries on `chat.state` (spec/04 § Model). `null` when the spawning host
   * had no model catalogue support configured (an older host, or a minimal
   * test one) — it spawned the chat without one to report.
   */
  model: string | null;
  /**
   * How many of this chat's backgrounded commands and sub-agents are still
   * running, as the host reported on `chat.state` (spec/02 § Background task
   * completions). Mirrored so a surface that cold-starts over REST knows a chat
   * is still working before the next live state frame — that frame only comes
   * when something changes, so without this a reload would show the finished
   * tick on a chat with work in flight for as long as the work took.
   *
   * `null` means UNKNOWN, and is not `0`: a host that predates the field
   * never reports one, and a surface must draw no background state at all
   * rather than claim nothing is running (spec/12 — NO FALLBACK).
   */
  backgroundTasks: number | null;
  /**
   * How full the chat's context window is, as the host last reported on
   * `chat.state` (spec/14 § Composer — context ring). Mirrored for the same
   * cold-start reason as `backgroundTasks`. `null` means nothing measured.
   */
  context: ChatContextUsage | null;
}

export interface ChatRegistryOptions {
  logger?: Pick<Logger, 'warn'>;
  /** Injectable clock — snooze filtering compares `snoozedUntil` against it. */
  now?: () => number;
  /**
   * Server-owned chatId → jobId map (`jobs/chat-links.ts`), consulted on
   * `chat.spawned` to tag a job-spawned chat's row. Absent → every chat's
   * `jobId` is `null` (no automations, e.g. tests that don't need them).
   */
  jobChatLinks?: { get(chatId: string): string | null };
  /**
   * Where the mirror is kept between runs (`<dataDir>/chat-registry.json`).
   * Absent keeps it in memory only, as a bare-registry test wants.
   */
  persistPath?: string;
}

/** How long a change waits before the mirror is written, so a burst is one write. */
const PERSIST_DELAY_MS = 1_000;

/** How far past a slot's start a host's own report must be before an idle chat counts as having worked. */
export const WORK_EVIDENCE_MS = 10_000;

/** Spawn-time error codes that should remove the chat from the registry. */
const SPAWN_TIME_ERROR_CODES = new Set<ChatErrorCode>(['folder_not_found']);

/**
 * Activities that mean a turn is in flight — the host has not yet reported
 * the chat back to `idle`/`errored`. If the host↔server link drops while a
 * chat is in one of these states, the turn-completion event will never arrive,
 * so the server must resolve the chat to `errored` itself (see
 * `WsHub.resolveInFlightChatsOnDaemonOffline`). spec/04 ## Activity + spec/12.
 */
const IN_FLIGHT_ACTIVITIES = new Set<ChatSummary['activity']>(['running', 'awaiting-permission']);

export class ChatRegistry {
  private readonly chats = new Map<string, ChatSummary>();
  /** chatIds we've observed `chat.spawned` for. Gates `chat.state` admission. */
  private readonly spawnedSet = new Set<string>();
  /**
   * Hosts whose full chat list this mirror holds. Empty at server start: a
   * host re-announces every chat right after `auth.ok` and closes that burst
   * with `folders.list`, so once its `folders.list` has been observed, a chat
   * this mirror does not know is not on that host.
   */
  private readonly syncedHosts = new Set<string>();
  private readonly logger: Pick<Logger, 'warn'> | undefined;
  private readonly now: () => number;
  private readonly jobChatLinks: { get(chatId: string): string | null } | undefined;
  private readonly persistPath: string | null;
  private persistTimer: NodeJS.Timeout | null = null;
  /** Chats read back from disk that no host has reported since this process started. */
  private readonly unconfirmed = new Set<string>();
  /** When each chat was last seen working (running, or waiting on a permission). Saved with the mirror. */
  private readonly workedAt = new Map<string, number>();

  constructor(opts: ChatRegistryOptions = {}) {
    this.logger = opts.logger;
    this.now = opts.now ?? (() => Date.now());
    this.jobChatLinks = opts.jobChatLinks;
    this.persistPath = opts.persistPath ?? null;
    this.restore();
  }

  /** Write anything still waiting. Resolves synchronously; call on shutdown. */
  flush(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.persistPath === null) return;
    try {
      const tmp = `${this.persistPath}.tmp`;
      writeFileSync(
        tmp,
        JSON.stringify({
          version: 1,
          chats: [...this.chats.values()],
          worked: Object.fromEntries(this.workedAt),
        }),
      );
      renameSync(tmp, this.persistPath);
    } catch (err) {
      this.logger?.warn({ err }, 'chat-registry: could not write the mirror');
    }
  }

  private markDirty(): void {
    if (this.persistPath === null || this.persistTimer) return;
    this.persistTimer = setTimeout(() => this.flush(), PERSIST_DELAY_MS);
    this.persistTimer.unref();
  }

  private restore(): void {
    if (this.persistPath === null || !existsSync(this.persistPath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.persistPath, 'utf8')) as {
        chats?: ChatSummary[];
        worked?: Record<string, number>;
      };
      for (const [chatId, at] of Object.entries(parsed.worked ?? {})) {
        if (typeof at === 'number') this.workedAt.set(chatId, at);
      }
      for (const chat of parsed.chats ?? []) {
        if (typeof chat?.chatId !== 'string' || chat.chatId === '') continue;
        this.chats.set(chat.chatId, chat);
        this.spawnedSet.add(chat.chatId);
        this.unconfirmed.add(chat.chatId);
      }
    } catch (err) {
      // NO FALLBACK: say so, then start empty rather than guess at a damaged file.
      this.logger?.warn({ err }, 'chat-registry: could not read the saved mirror; starting empty');
    }
  }

  observe(event: WireEvent): void {
    // A batched replay carries events this would otherwise have seen one by
    // one (spec/12 § Sequence-based replay). Unpack it so asking for batches
    // changes only HOW MANY FRAMES cross the link, never what the mirror is
    // told — there is no `forSurfaceId` guard here, so replayed events have
    // always reached this, and quietly dropping them with batching on would
    // be a difference nobody asked for.
    if (event.type === 'chat.replay_batch') {
      for (const inner of event.events) this.observe(inner as WireEvent);
      return;
    }
    if (event.type === 'folders.list') {
      this.syncedHosts.add(event.daemonId);
      // The host has finished telling us what it has: a restored chat of this
      // host that it did not mention is not on it any more.
      let pruned = false;
      for (const chatId of [...this.unconfirmed]) {
        if (this.chats.get(chatId)?.daemonId !== event.daemonId) continue;
        this.unconfirmed.delete(chatId);
        this.chats.delete(chatId);
        this.spawnedSet.delete(chatId);
        pruned = true;
      }
      if (pruned) this.markDirty();
    }
    if (event.type === 'chat.spawned') {
      this.spawnedSet.add(event.chatId);
      this.unconfirmed.delete(event.chatId);
      const existing = this.chats.get(event.chatId);
      if (existing) return; // chat.state will keep it fresh
      this.markDirty();
      this.chats.set(event.chatId, {
        chatId: event.chatId,
        name: null,
        preview: null,
        goal: null,
        goalProgress: null,
        lastGoal: null,
        reminder: null,
        statusSummary: null,
        statusKind: null,
        statusDeclared: null,
        pendingWake: null,
        todos: [],
        daemonId: event.daemonId,
        permissionMode: 'auto',
        folder: event.folder,
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        disabled: false,
        snoozedUntil: null,
        hidden: false,
        lastUpdated: 0,
        lastUserActivity: 0,
        jobId: this.jobChatLinks?.get(event.chatId) ?? null,
        model: event.model ?? null,
        // Nothing has reported on this chat's background work yet — unknown,
        // which is not the same as none.
        backgroundTasks: null,
        context: null,
      });
      return;
    }
    if (event.type === 'chat.state') {
      if (!this.spawnedSet.has(event.chatId)) {
        // No prior chat.spawned — refuse to fabricate a row. Group 8 fix
        // (DX-M1): without this gate, a host-side rejected pin/archive
        // could still drive a row into existence.
        this.logger?.warn(
          { chatId: event.chatId, type: 'chat.state' },
          'chat-registry: ignoring chat.state for unspawned chat',
        );
        return;
      }
      const existing = this.chats.get(event.chatId);
      const next: ChatSummary = {
        chatId: event.chatId,
        name: event.name ?? existing?.name ?? null,
        // Preview is captured once and never cleared: prefer the incoming value
        // but never let an absent/undefined event field wipe a known preview.
        preview: event.preview ?? existing?.preview ?? null,
        // Goal CAN be cleared (set to null), so `null` is a meaningful value —
        // only fall back to the existing goal when the field is absent (undefined).
        goal: event.goal !== undefined ? event.goal : (existing?.goal ?? null),
        goalProgress:
          event.goalProgress !== undefined ? event.goalProgress : (existing?.goalProgress ?? null),
        lastGoal: event.lastGoal !== undefined ? event.lastGoal : (existing?.lastGoal ?? null),
        // Reminder CAN be cleared (set to null), so `null` is meaningful — only
        // fall back to the existing reminder when the field is absent (undefined).
        reminder: event.reminder !== undefined ? event.reminder : (existing?.reminder ?? null),
        // A status summary CAN clear, so `null` is meaningful — only keep the
        // existing value when the field is absent (undefined).
        statusSummary:
          event.statusSummary !== undefined
            ? event.statusSummary
            : (existing?.statusSummary ?? null),
        statusKind:
          event.statusKind !== undefined ? event.statusKind : (existing?.statusKind ?? null),
        statusDeclared:
          event.statusDeclared !== undefined
            ? event.statusDeclared
            : (existing?.statusDeclared ?? null),
        // A pending wake CAN clear (fired / cancelled), so `null` is meaningful —
        // only keep the existing value when the field is absent (undefined).
        pendingWake:
          event.pendingWake !== undefined ? event.pendingWake : (existing?.pendingWake ?? null),
        // The task list CAN empty (the agent completed it, or the user deleted
        // every item), so `[]` is meaningful — only keep the existing list when
        // the field is absent (undefined).
        todos: event.todos !== undefined ? event.todos : (existing?.todos ?? []),
        daemonId: existing?.daemonId ?? event.daemonId ?? '',
        permissionMode: event.permissionMode,
        folder: event.folder ?? existing?.folder ?? '',
        activity: event.activity,
        status: event.status ?? existing?.status ?? 'active',
        pinned: event.pinned ?? existing?.pinned ?? false,
        pinnedAt: event.pinnedAt ?? existing?.pinnedAt ?? null,
        disabled: event.disabled ?? existing?.disabled ?? false,
        // A snooze CAN clear (unsnoozed / woken), so `null` is meaningful — only
        // keep the existing value when the field is absent (undefined).
        snoozedUntil:
          event.snoozedUntil !== undefined ? event.snoozedUntil : (existing?.snoozedUntil ?? null),
        hidden: event.hidden ?? existing?.hidden ?? false,
        lastUpdated: event.lastUpdated,
        // Back-compat: an older host never sends the field, so fall back to
        // the last known value and, failing that, to `lastUpdated` — no worse
        // than the sort behaviour before this field existed. `||`, not `??`:
        // the `chat.spawned` row seeds this at `0` as a placeholder (same as
        // `lastUpdated`), and `0` is never a real epoch — falling through to
        // `lastUpdated` the first time a real `chat.state` lands (even one
        // omitting the field) is what we want, and `??` would treat that
        // placeholder `0` as a known value and get stuck on it.
        lastUserActivity: event.lastUserActivity || existing?.lastUserActivity || event.lastUpdated,
        // jobId is set once, at spawn time, and never changes — chat.state
        // carries no jobId field, so it always just carries the existing value
        // forward.
        jobId: existing?.jobId ?? null,
        // spec/04 § Model — a chat's model CAN change mid-chat, and `chat.state`
        // is how the change travels, so take the event's value when it carries
        // one. Absence means "unchanged" (an older host never sends the
        // field), not "no model", so the existing value is carried forward
        // rather than being wiped to null.
        model: event.model !== undefined ? event.model : (existing?.model ?? null),
        // spec/02 § Background task completions. `0` is meaningful (the last
        // task finished), so only an ABSENT field carries the known value
        // forward — a host too old to count them must not be read as
        // reporting none.
        backgroundTasks:
          event.backgroundTasks !== undefined
            ? event.backgroundTasks
            : (existing?.backgroundTasks ?? null),
        context: event.context !== undefined ? event.context : (existing?.context ?? null),
      };
      this.chats.set(event.chatId, next);
      this.unconfirmed.delete(event.chatId);
      if (IN_FLIGHT_ACTIVITIES.has(next.activity)) this.workedAt.set(event.chatId, this.now());
      this.markDirty();
      return;
    }
    if (event.type === 'chat.stopped') {
      if (!this.spawnedSet.has(event.chatId)) {
        this.logger?.warn(
          { chatId: event.chatId, type: 'chat.stopped' },
          'chat-registry: ignoring chat.stopped for unspawned chat',
        );
        return;
      }
      // No-op for now; the host emits chat.state with the new activity.
      return;
    }
    if (event.type === 'chat.error') {
      // Spawn-time errors mean the chat never came into existence — clear
      // any phantom row and forget the spawn marker.
      if (SPAWN_TIME_ERROR_CODES.has(event.error.code)) {
        this.chats.delete(event.chatId);
        this.spawnedSet.delete(event.chatId);
        this.markDirty();
      }
      return;
    }
  }

  /**
   * Seed the registry from the host's snapshot. Called once on server
   * startup so REST surfaces don't see an empty list while the host's
   * chat_state is in fact populated. Each entry is treated as a fully-
   * spawned chat (the host wouldn't return it otherwise).
   */
  seed(snapshot: Iterable<ChatSummary>): void {
    for (const c of snapshot) {
      this.spawnedSet.add(c.chatId);
      this.unconfirmed.delete(c.chatId);
      this.chats.set(c.chatId, c);
    }
    this.markDirty();
  }

  get(chatId: string): ChatSummary | undefined {
    return this.chats.get(chatId);
  }

  /**
   * Has this chat done work since `since`? A chat is reported idle before its
   * first turn starts, so an idle chat is only known to be FINISHED if there is
   * evidence it worked. Two kinds count:
   *
   *   - the mirror saw it working after `since` (kept across restarts), or
   *   - failing that, its host reports it idle with a first message accepted and
   *     its own clock well past `since`: a turn that has been accepted and
   *     started runs at once, so one still at rest that long afterwards has run.
   *     This covers a chat that finished while the server was down, or before
   *     this was kept.
   */
  hasWorkedSince(chatId: string, since: number): boolean {
    if ((this.workedAt.get(chatId) ?? -1) >= since) return true;
    const chat = this.chats.get(chatId);
    if (!chat || chat.preview === null) return false;
    return chat.lastUpdated >= since + WORK_EVIDENCE_MS;
  }

  /** Whether this host has re-announced its chats since the server started. */
  hasSynced(daemonId: string): boolean {
    return this.syncedHosts.has(daemonId);
  }

  /**
   * chatIds currently mid-turn (activity `running` or `awaiting-permission`).
   * Used on daemon-link loss to find the chats whose turn-completion event will
   * never arrive, so they can be resolved to `errored` rather than left
   * spinning forever (spec/12 — NO FALLBACK / fail loud).
   */
  inFlightChatIds(): string[] {
    const ids: string[] = [];
    for (const c of this.chats.values()) {
      if (IN_FLIGHT_ACTIVITIES.has(c.activity)) ids.push(c.chatId);
    }
    return ids;
  }

  /**
   * Resolve an in-flight chat to `errored` in the mirror and return the
   * `chat.state` event reflecting the transition (for the caller to broadcast).
   * Returns null if the chat is unknown. Mirrors the host's own SDK-error
   * path (chatRunner: setActivity('errored') + setLastError): activity flips to
   * `errored` and `lastError` is stamped, but `status` is left untouched (the
   * chat is still active and can be retried once the host reconnects).
   */
  markErrored(
    chatId: string,
    error: { code: ChatErrorCode; message: string },
    at: number,
  ): ChatStateEvent | null {
    const existing = this.chats.get(chatId);
    if (!existing) return null;
    const next: ChatSummary = { ...existing, activity: 'errored', lastUpdated: at };
    this.chats.set(chatId, next);
    this.markDirty();
    return {
      type: 'chat.state',
      chatId,
      daemonId: next.daemonId,
      activity: 'errored',
      permissionMode: next.permissionMode,
      status: next.status,
      lastUpdated: at,
      name: next.name,
      preview: next.preview,
      // `folder` on the wire is min(1); a spawned chat always has one, but guard
      // against an empty mirror value so `decode()` never rejects the frame.
      ...(next.folder ? { folder: next.folder } : {}),
      pinned: next.pinned,
      pinnedAt: next.pinnedAt,
      snoozedUntil: next.snoozedUntil,
      hidden: next.hidden,
      lastError: { code: error.code, message: error.message, at },
    };
  }

  /**
   * The chat has moved to another host (spec/04 § Moving a chat to another
   * host). `daemonId` is otherwise fixed at `chat.spawned` for the chat's life,
   * and it is what routes every later frame for the chat, so a move is the one
   * thing that changes it. No-op if unknown.
   */
  rehome(chatId: string, daemonId: string, folder: string): void {
    const existing = this.chats.get(chatId);
    if (!existing) return;
    this.chats.set(chatId, { ...existing, daemonId, folder });
    this.unconfirmed.delete(chatId);
    this.markDirty();
  }

  /** Remove a chat row from the registry mirror. The host remains source of
   *  truth for the on-disk transcript. */
  remove(chatId: string): void {
    this.chats.delete(chatId);
    this.spawnedSet.delete(chatId);
    this.unconfirmed.delete(chatId);
    this.workedAt.delete(chatId);
    this.markDirty();
  }

  /**
   * Optimistically flip a chat's mirror status to `deleted` (soft-delete) or
   * back to `active` (restore) so the REST active/deleted lists update the
   * instant the DELETE / restore route runs, without waiting for the host's
   * `chat.state` echo (which reconciles it identically). No-op if unknown.
   * spec/04 § Lifecycle.
   */
  setDeleted(chatId: string, deleted: boolean): void {
    const existing = this.chats.get(chatId);
    if (!existing) return;
    this.chats.set(chatId, { ...existing, status: deleted ? 'deleted' : 'active' });
    this.markDirty();
  }

  /**
   * List chats. Default: active only (no archived, no deleted). `archivedOnly`
   * → only archived; `includeArchived` → active + archived (never deleted);
   * `deletedOnly` → only soft-deleted (spec/04 § Lifecycle). Sorted: pinned
   * first (by pinnedAt desc), then most-recent.
   */
  list(
    opts: {
      includeArchived?: boolean;
      archivedOnly?: boolean;
      deletedOnly?: boolean;
      snoozedOnly?: boolean;
      includeSnoozed?: boolean;
      /** Only hidden chats (spec/04 § Hidden) — the sidebar's Hidden section. */
      hiddenOnly?: boolean;
      /**
       * Only job-spawned chats (spec/08 § Action), active or archived. This is
       * ORTHOGONAL to the other lifecycle filters — an automation chat is
       * usually archived, so it must show here independent of archived
       * status, alongside wherever else it also sits (spec/14 § Sidebar).
       */
      automationsOnly?: boolean;
      /**
       * Tiebreak direction for chats that aren't pinned-against-each-other:
       * `'desc'` (default) is most-recent-first, matching every filter's own
       * page-one intuition except Hidden/Automations, whose sidebar bucket
       * displays FIFO oldest-first (`web/src/lib/chatGroups.ts`) — callers
       * paging those two pass `'asc'` so a page's fetch order already matches
       * the order it's about to be drawn in, and "scroll down for more" adds
       * rows at the bottom instead of splicing them in above what's on screen.
       */
      order?: 'asc' | 'desc';
    } = {},
  ): ChatSummary[] {
    const all = Array.from(this.chats.values());
    const now = this.now();
    // spec/04 § Snooze: derived from the clock on every call, so a snooze that
    // lapsed while nothing was listening still shows up as active.
    const isSnoozed = (c: ChatSummary): boolean =>
      c.snoozedUntil !== null && c.snoozedUntil > now && c.status === 'active';
    const filtered = all.filter((c) => {
      // Special threads (Manager / Speakers) are pinned UI surfaces,
      // not inbox chats — the sidebar's Channels section always shows them. They
      // are never archived/deleted/job-spawned, so include them only in the
      // active/default list (never in the Archived-only, Deleted-only or
      // Automations-only views).
      if (isReservedSpecialThread(c.chatId))
        return (
          !opts.archivedOnly &&
          !opts.deletedOnly &&
          !opts.snoozedOnly &&
          !opts.hiddenOnly &&
          !opts.automationsOnly
        );
      // Soft-deleted chats live only in the Deleted view.
      if (opts.deletedOnly) return c.status === 'deleted';
      if (c.status === 'deleted') return false;
      // Automations: every job-spawned chat, whatever its archived/snoozed
      // state — checked before those filters narrow the set further.
      if (opts.automationsOnly) return c.jobId !== null;
      // Hidden chats live only in the Hidden view (spec/04 § Hidden) — before
      // snooze, so a hidden chat that is also snoozed is drawn once, here.
      const hidden = c.hidden && c.status === 'active';
      if (opts.hiddenOnly) return hidden;
      if (hidden) return false;
      // Snoozed chats live only in the Snoozed view until their wake time.
      if (opts.snoozedOnly) return isSnoozed(c);
      if (opts.archivedOnly) return c.status === 'archived';
      if (!opts.includeSnoozed && isSnoozed(c)) return false;
      if (opts.includeArchived) return true;
      return c.status !== 'archived';
    });
    filtered.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (a.pinned && b.pinned) {
        // Both pinned: most-recent-pinned at top. Nulls last.
        const ap = a.pinnedAt;
        const bp = b.pinnedAt;
        if (ap === null && bp === null) return b.lastUpdated - a.lastUpdated;
        if (ap === null) return 1;
        if (bp === null) return -1;
        if (ap !== bp) return bp - ap;
      }
      return opts.order === 'asc' ? a.lastUpdated - b.lastUpdated : b.lastUpdated - a.lastUpdated;
    });
    return filtered;
  }

  /**
   * The folder roster (spec/04 § Folders → Folder roster): one row per distinct
   * folder across every NON-DELETED chat — archived and snoozed included —
   * carrying that folder's most-recent chat's `lastUpdated` and the host it
   * lives on. Most-recent-first.
   *
   * Served separately from `list()` because the sidebar's "Recent projects"
   * must include folders whose chats are ALL archived, while the cold-start
   * roster deliberately excludes archived chats to stay small. This is
   * O(folders), so it stays small however many archived chats accumulate.
   *
   * Special threads never contribute — Manager/Speakers are pinned UI
   * surfaces, not projects you would start a chat in (spec/06, and matching
   * `chatGroups.ts`'s own exclusion on the web side).
   */
  folders(): Array<{ folder: string; daemonId: string; lastUpdated: number }> {
    const byFolder = new Map<string, { folder: string; daemonId: string; lastUpdated: number }>();
    for (const c of this.chats.values()) {
      if (isReservedSpecialThread(c.chatId)) continue;
      // A soft-deleted chat stops contributing, exactly as on the web side —
      // deleting the last chat in a folder DOES retire the folder, archiving it
      // does not.
      if (c.status === 'deleted') continue;
      if (!c.folder) continue;
      const existing = byFolder.get(c.folder);
      if (existing && existing.lastUpdated >= c.lastUpdated) continue;
      byFolder.set(c.folder, {
        folder: c.folder,
        daemonId: c.daemonId,
        lastUpdated: c.lastUpdated,
      });
    }
    // Deterministic tiebreaker on folder path, so two folders that tie on
    // recency don't reorder between calls (same rule as `chatGroups.ts`).
    return Array.from(byFolder.values()).sort(
      (a, b) => b.lastUpdated - a.lastUpdated || a.folder.localeCompare(b.folder),
    );
  }

  size(): number {
    return this.chats.size;
  }
}
