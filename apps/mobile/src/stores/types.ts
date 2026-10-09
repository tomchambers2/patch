// Mirrors packages/web/src/stores/types.ts so the row + badge shape is
// identical across surfaces. We re-declare here rather than importing from
// @patch/web to keep the dependency direction sane (mobile -> wire, but
// not mobile -> web).

import type {
  ChatActivity,
  ChatStatus,
  PendingWake,
  PermissionMode,
  StatusKind,
  TodoItem,
} from '@patch/wire';

export interface ChatRow {
  chatId: string;
  name: string | null;
  /**
   * The host this chat runs on (spec/03 § `chat.spawned`). Every host-scoped
   * question about a chat — which machine's credential gates it, whose
   * filesystem its folder is on — needs it, and '' is the honest value for a
   * row the surface has not seen spawned yet.
   */
  daemonId: string;
  folder: string;
  activity: ChatActivity;
  /**
   * The EFFECTIVE permission mode this chat's next turn will use, as the host
   * resolved it on `chat.state` (spec/02 § Permission mode). Never re-derived on
   * a surface — a surface does not hold the host default it was resolved
   * against, so it can only show what the host sent.
   */
  permissionMode: PermissionMode;
  status: ChatStatus;
  pinned: boolean;
  pinnedAt: number | null;
  lastUpdated: number;
  /**
   * ms epoch of the user's own last activity on this chat — when they last
   * sent a message, or chat creation if they never have (spec/14 § Sidebar
   * ordering). The Chats tab sorts Pinned and Folder rows by this instead of
   * `lastUpdated`, so an agent reply, a status change, a job tick or a
   * finished turn never moves a row.
   */
  lastUserActivity: number;
  awaitingPermission: boolean;
  lastVisitedAt: number;
  preview: string | null;
  pendingPermissions: PendingPermission[];
  lastSeq: number;
  /**
   * The chat's pending self-wake (spec/02 § Self-wake), mirrored from
   * `chat.state`. `null` when nothing is armed. Drives the wake bar above the
   * transcript (spec/15 § Chat detail) — a phone isn't left open on a chat the
   * way a desktop tab can be, so this is what gives confidence a scheduled wake
   * wasn't forgotten.
   */
  pendingWake: PendingWake | null;
  /**
   * The chat's wake time (spec/04 § Snooze), ms epoch, or `null` when it is not
   * snoozed. Never read as a boolean — snoozed is `snoozedUntil > now`, derived
   * at render (see `isSnoozed`), so a phone that was asleep through the wake
   * time shows the chat back in its folder on the first paint.
   */
  snoozedUntil: number | null;
  /**
   * Running out of the active list (spec/04 § Hidden), mirrored from
   * `chat.state`. Orthogonal to `status`, like `snoozedUntil`: never read on
   * its own — a row is drawn hidden only while it is also `active` (see
   * `isHidden`), so an archived chat that keeps the flag is drawn as archived.
   */
  hidden: boolean;
  /**
   * How many of this chat's `patch_watch` tasks are still running, mirrored
   * from `chat.state` (spec/02 § Background task completions). `null` is
   * UNKNOWN (no host has reported yet), never zero — mirrors web's
   * chatStore.ts. Drives the Background task bar's own existence
   * (BackgroundTaskBar.tsx): the bar polls the task list only once this is
   * known to be nonzero, so a chat with nothing running never polls at all.
   */
  backgroundTasks: number | null;
  /**
   * The model the chat's NEXT turn runs on (spec/04 § Model): the roster's
   * value, then `chat.spawned`, then every `chat.state` that carries one — the
   * last is also the host's acknowledgement of a `chat.model_request`. `null`
   * is "not known" (a row not yet spawned, or a host with no model catalogue),
   * never a model.
   */
  model: string | null;
  /**
   * The account the chat's latest turn ran on (`chat.state`, spec/10 § Backend
   * credentials). Absent until a turn has run on the host holding the chat.
   */
  account?: { id: string; label: string } | null;
  /**
   * The job whose action created this chat (spec/08 § Action), or `null` for a
   * chat a person started. Server-populated, set once at spawn and never
   * changed. Keeps job chats out of the new-chat screen's recently used models
   * (`recentModelPicks`), since a job's model is the job's setting, not a
   * choice the user last made.
   */
  jobId: string | null;
  /**
   * The chat's one-line status summary and what it is to the user (spec/06 §
   * The watch loop), mirrored from `chat.state` and the roster exactly as web
   * holds them. The Manager's Chats tab ranks and describes rows by them
   * (`threadRows` in `@patch/wire`). `null` until one lands.
   */
  statusSummary: string | null;
  statusKind: StatusKind | null;
  /** Whether `statusKind` was declared by the agent rather than guessed — see wire. */
  statusDeclared: boolean | null;
  /**
   * The chat's goal (`/goal`), mirrored from the roster and `chat.state`.
   * `null` when none is set. Drives the goal bar above the transcript (spec/15
   * § Chat detail → Status bars), same data as web's GoalBanner.
   */
  goal: string | null;
  /** The chat's reminder (`/remind`), or `null`. Drives the reminder bar. */
  reminder: string | null;
  /**
   * The agent's task list (spec/02 § Task list); empty until it writes one.
   * Editable from the task bar — every edit sends the WHOLE list.
   */
  todos: TodoItem[];
  /**
   * A special thread turned off (spec/06 § Disabled). `false` for ordinary
   * chats. Toggled from the chat-detail ⋯ menu (Disable / Enable).
   */
  disabled: boolean;
}

/**
 * The roster metadata a chat list row is built from: everything a surface knows
 * about a chat WITHOUT its transcript. This is exactly what the roster fetch
 * returns per chat, what `chatStore.hydrate()` takes, and what the on-device
 * read cache persists (spec/15 § Instant open (read cache)). The derived/local
 * fields (`preview`, `lastVisitedAt`, `pendingPermissions`, `lastSeq`,
 * `awaitingPermission`) are deliberately not part of it.
 *
 * A field is optional-with-default only if it is BOTH named in the `Omit<...>`
 * AND re-added below as `field?: T | null` — see `pendingWake`. Miss either half
 * and every `hydrate([...])` call site fails to compile.
 */
export type ChatListRow = Omit<
  ChatRow,
  | 'awaitingPermission'
  | 'lastVisitedAt'
  | 'preview'
  | 'pendingPermissions'
  | 'lastSeq'
  | 'pendingWake'
  | 'snoozedUntil'
  | 'hidden'
  | 'backgroundTasks'
  | 'model'
  | 'jobId'
  | 'statusSummary'
  | 'statusKind'
  | 'statusDeclared'
  | 'goal'
  | 'reminder'
  | 'todos'
  | 'disabled'
> & {
  pendingWake?: PendingWake | null;
  snoozedUntil?: number | null;
  hidden?: boolean;
  backgroundTasks?: number | null;
  model?: string | null;
  jobId?: string | null;
  statusSummary?: string | null;
  statusKind?: StatusKind | null;
  statusDeclared?: boolean | null;
  goal?: string | null;
  reminder?: string | null;
  todos?: TodoItem[];
  disabled?: boolean;
};

/**
 * One category of Claude Code's own provider-level context a chat has received
 * (spec/02 § Provider-level context) — the latest of it, and how often it came.
 * Mirrors web's `ProviderContextEntry`.
 */
export interface ProviderContextEntry {
  label: string;
  text: string;
  /** How many `chat.provider_context` events of this category have landed. */
  count: number;
  /** Seq of the first occurrence — the row's stable position. */
  firstSeq: number;
  /** Seq of the latest occurrence applied — the replay-dedup guard. */
  lastSeq: number;
}

/** Snoozed ⇔ a wake time still in the future (spec/04 § Snooze). */
export function isSnoozed(row: { snoozedUntil: number | null }, now: number = Date.now()): boolean {
  return row.snoozedUntil !== null && row.snoozedUntil > now;
}

/**
 * Hidden ⇔ flagged hidden AND still active (spec/04 § Hidden). An archived chat
 * may keep `hidden: true` — it is where a machine message starting it again
 * returns it to — but it is drawn as archived.
 */
export function isHidden(row: { hidden: boolean; status: ChatStatus }): boolean {
  return row.hidden && row.status === 'active';
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

/** Mirrors web's deriveBadge precedence (packages/web/src/stores/types.ts),
 *  adapted to the fields this row carries — see spec/14-design-web.md §
 *  Status badges for the full rationale behind the ordering. */
export function deriveBadge(row: ChatRow): DisplayBadge {
  if (row.activity === 'awaiting-permission') return 'permission';
  if (row.activity === 'errored' || row.status === 'errored') return 'errored';
  if (row.activity === 'running') return 'working';
  if (row.lastUpdated > row.lastVisitedAt) return 'done';
  if (typeof row.backgroundTasks === 'number' && row.backgroundTasks > 0) return 'background';
  if (row.pendingWake) return 'monitoring';
  return 'read';
}
