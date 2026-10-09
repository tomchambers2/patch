// Per-chat in-memory state, owned by the host.
//
// Spec: spec/04-chats-and-folders.md ## chat_state.
//
// Hydrated on startup from ~/.patch/chats/*/meta.json. NOT persisted —
// rebuilt by tailing history if needed. nextSeq lives here in memory but
// is mirrored to meta.json after every emit (see chatRunner).

import type {
  ChatActivity,
  ChatContextUsage,
  ChatErrorCode,
  ChatStatus,
  StatusKind,
  TodoItem,
  TurnOrigin,
} from '@patch/wire';
import type { ChatMeta } from './meta.js';

export const DEFAULT_LAST_MESSAGES = 20;

/** Agent SDK `query()` permission modes (mirrors the SDK's `PermissionMode`). */
export type SdkPermissionMode = 'auto' | 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';

export interface ChatMessageSnapshot {
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** seq stamped when the host emitted this message. */
  seq: number;
  /** ms epoch. */
  ts: number;
}

export interface ChatLastError {
  code: ChatErrorCode;
  message: string;
  at: number;
}

/**
 * One `agent_response` hook's deferred note, riding onto the chat's next
 * turn (spec/20-hooks.md § On the agent's response) — an `advise` outcome,
 * or a hook that failed/timed out (`failed: true`, `analysis` then carries
 * the error instead).
 */
export interface HookAdviceNote {
  hookId: string;
  hookName: string;
  analysis: string;
  suggestion?: string;
  failed?: boolean;
}

/** {@link ChatState.goalProgress} (spec/04 § Goals). */
export interface GoalProgress {
  /** ms epoch the current goal was set. */
  startedAt: number;
  /** How many settled turns the evaluator has judged this goal against. */
  turnsEvaluated: number;
  /** Running total of input tokens the evaluator + resubmitted turns have spent. */
  tokensSpent: number;
  /** The evaluator's most recent verdict, or `null` before the first one lands. */
  lastVerdict: 'not_met' | null;
  /** The evaluator's most recent reason, or `null` before the first one lands. */
  lastReason: string | null;
}

/** {@link ChatState.lastGoal} (spec/04 § Goals). */
export interface FinishedGoal {
  condition: string;
  startedAt: number;
  endedAt: number;
  turns: number;
  tokens: number;
  outcome: 'met' | 'impossible';
  reason: string;
}

export interface ChatState {
  chatId: string;
  name: string | null;
  /**
   * One-line snippet of the first user message (G2-d4). Captured once and
   * mirrored to meta.json so the sidebar can label unnamed/archived rows.
   */
  preview: string | null;
  /**
   * The chat's goal (patch/todo.md — `/goal`). Shown at the top of the chat.
   * `null` when no goal is set. Mirrored to meta.json so it survives a restart.
   */
  goal: string | null;
  /**
   * Live progress on the chat's ACTIVE goal (spec/04 § Goals) — `null` exactly
   * when `goal` is `null`. In-memory, rebuilt from `goal`/`lastGoal` on
   * rehydrate rather than mirrored itself: `turnsEvaluated`/`tokensSpent` are
   * cheap running counters that are fine to lose across a restart (the goal
   * keeps running, just starts counting from zero again), unlike the goal
   * text itself.
   */
  goalProgress: GoalProgress | null;
  /**
   * The most recently FINISHED goal (met or impossible), kept after `goal`
   * clears so the chat header can still show what it was working toward, for
   * how long, and how it ended (spec/04 § Goals — "A finished goal stays
   * viewable from the chat header"). Replaced by the next goal to finish;
   * `null` until the first one does. Mirrored to meta.json.
   */
  lastGoal: FinishedGoal | null;
  /**
   * Consecutive `refused` verdicts on the active goal (spec/04 § Goals —
   * deadlock guard). Reset to 0 by any other verdict, or when a new goal is set.
   */
  goalRefusalStreak: number;
  /**
   * Set while goal evaluation is being skipped because the chat has running
   * `patch_watch` tasks (spec/04 § Goals — "Evaluation waits while the chat
   * has running patch_watch tasks... and runs after they finish"); a poll
   * timer re-checks and clears this once they do. In-memory only.
   */
  goalEvalAwaitingWatches: boolean;
  /**
   * The chat's reminder (patch/todo.md — Reminders). A configurable reminder to
   * do / not do something, shown at the top of the chat as a banner. `null` when
   * no reminder is set. Mirrored to meta.json so it survives a restart.
   */
  reminder: string | null;
  /**
   * Auto-generated one-line "current status" summary (patch/todo.md § Features
   * to add — "Current status"), regenerated after each turn settles and CLEARED
   * the moment a new user message is accepted (it describes the settled turn, so
   * a new message makes it stale). `null` until the first summary lands and
   * again from each send until that turn's summary lands. In-memory only — it
   * reflects the LATEST turn
   * and is cheaply regenerated, so it isn't persisted across a host restart.
   */
  statusSummary: string | null;
  /**
   * Whether the thread is paused on a user `question` or simply `complete`. Pairs
   * with `statusSummary`; `null` until the first summary lands.
   */
  statusKind: StatusKind | null;
  /**
   * The CLOSING TEXT of the turn that just settled — the last thing the agent
   * itself said, trimmed and cut to notification length (spec/09 § What the
   * message says). `null` when no turn has settled yet, while a turn is running,
   * or when the turn that settled ended on a tool call with nothing said.
   *
   * Carried on `chat.state` so the server's chat-completion doorbell has real
   * agent-authored text on the very frame it fires on. `statusSummary` cannot do
   * that job: it is generated by a separate model call that lands on a LATER
   * frame, so the doorbell almost never saw one and named the chat after its
   * FIRST message instead.
   *
   * In-memory only, and deliberately NOT mirrored to meta.json: like
   * `statusSummary`/`statusKind` it describes one settled turn rather than
   * anything durable about the chat, and a rehydrated chat that has run no turn
   * this process has no turn to quote.
   */
  turnSummary: string | null;
  /**
   * The status the agent DECLARED for itself, mirrored from `meta.json` so it
   * survives a restart (see `meta.ts` § declaredStatus). While this is set it
   * wins over anything the per-turn summariser produces: the agent saying "I am
   * blocked on you" is a fact, and a model's reading of the transcript is not
   * allowed to overwrite it on the next tick.
   */
  declaredStatus: { kind: 'question' | 'report'; text: string; at: number } | null;
  /**
   * The chat's todo list (patch/todo.md § Features to add — "todo list"),
   * mirrored from the agent's native TodoWrite tool calls. Drives the "keep the
   * agent focused" auto-advance. In-memory only — it reflects the latest turn's
   * TodoWrite state and is not persisted across a host restart. Empty until
   * the agent first writes a todo list.
   */
  todos: TodoItem[];
  /**
   * The text of the todo the host last auto-fired into this chat (or `null`).
   * Guards against re-firing a head item the agent left pending — see
   * `selectNextTodo`. In-memory only.
   */
  lastFiredTodo: string | null;
  /**
   * Set when a surface rewrote the task list (spec/02 § Task list). The agent's
   * own TodoWrite state lives inside its session, so the host can only tell
   * it: the next turn is prefixed with a `<system-reminder>` naming the edited
   * list, and this clears. In-memory only.
   */
  todosEditedBySurface: boolean;
  /**
   * Set when the chat was hidden or shown (spec/04 § Hidden) and the agent has
   * not been told yet: the next turn is prefixed with a `<system-reminder>`
   * saying which, and this clears. Hiding then showing before that turn cancels
   * out. In-memory only.
   */
  hiddenNotice: 'hidden' | 'shown' | null;
  /**
   * Set when the chat's goal was set, replaced or cleared (spec/04 § Goals)
   * and the agent has not been told yet: the next turn is prefixed with a
   * `<system-reminder>` carrying the latest state (`goal: null` = cleared),
   * and this clears. A later change supersedes an unannounced earlier one.
   * In-memory only.
   */
  goalNotice: { goal: string | null } | null;
  /**
   * An `agent_response` hook's `advise` outcome, waiting to ride with this
   * chat's NEXT turn — whichever origin that turn turns out to have
   * (spec/20-hooks.md § On the agent's response: "passed to the agent with
   * its next turn, without forcing a redo"). Consumed and cleared the moment
   * that next turn is accepted. In-memory only — a turn that was going to
   * carry it either already has, or the host restarted and there is
   * nothing left to attach it to.
   */
  pendingHookAdvice: HookAdviceNote[];
  /**
   * How many times in a row an `agent_response` hook's `block` has forced a
   * resubmit on this chat, with no genuine (non-hook) turn in between
   * (spec/20-hooks.md § On the agent's response — loop guard). Reset to 0 the
   * moment any turn that is NOT itself a hook resubmit is accepted. At
   * `HOOK_BLOCK_LOOP_LIMIT` the host stops resubmitting and surfaces the
   * chat instead (`maybeCheckAgentResponseHooks`). In-memory only.
   */
  consecutiveHookBlocks: number;
  /**
   * The `checkId` of the `hook.agent_response_check_request` this chat is
   * currently waiting on, or `null` when none is outstanding. Guards against
   * an outcome for a STALE check (a slow server round-trip landing after a
   * newer turn has already started) being acted on — only an outcome whose
   * `checkId` matches is applied. In-memory only.
   */
  pendingAgentResponseCheckId: string | null;
  /**
   * The turn that just settled was itself a `consecutiveHookBlocks` resubmit
   * the host fired, not a genuine new turn — read-and-cleared at the START
   * of the NEXT `maybeCheckAgentResponseHooks` call to decide whether this
   * settle resets the loop-guard counter (spec/20-hooks.md § On the agent's
   * response — reset "the moment any turn that is NOT itself a hook resubmit
   * is accepted"). In-memory only.
   */
  turnWasHookResubmit: boolean;
  folder: string;
  activity: ChatActivity;
  /**
   * Who started the turn the chat is on — or, once it settles, the turn it just
   * ran (spec/09 § Whose turn it was). Set as each turn goes `running` and left
   * standing through `idle`, because the state that matters is read on the
   * running → idle edge: the server needs to know whose turn just ENDED.
   *
   * In-memory only, like `activity` itself. A restart re-derives it from the
   * pending turns it re-sends.
   */
  turnOrigin: TurnOrigin;
  /**
   * The turn the chat is on — or, once it settles, the turn it just ran — was
   * stopped by the user rather than allowed to finish (spec/09 § A turn the
   * user stopped). Set when a stop aborts the turn, cleared as the next turn
   * goes `running`, so it belongs to one turn only.
   *
   * In-memory only, like `activity` and `turnOrigin`. A restart has no turn in
   * flight to have stopped.
   */
  turnStopped: boolean;
  /**
   * spec/09 § A turn that failed — true while an errored turn has a retry-ladder
   * rung armed, so its failure is not final yet. Cleared as the next turn goes
   * `running`. In-memory only: a restart re-fires owed turns itself.
   */
  turnRetrying: boolean;
  lastMessages: ChatMessageSnapshot[];
  lastUpdated: number;
  claudeSessionId: string | undefined;
  /**
   * SDK `query()` model override (CLI pass-through flag `--model`, spec/13 ##
   * Flag pass-through). Chosen at spawn and changeable at any point after it
   * (spec/04 § Model); read afresh as each turn starts, which is what makes a
   * change take effect on the next turn without disturbing a running one.
   *
   * Persisted to the chat's meta and rehydrated below. A choice the user made
   * about THIS chat has to outlive the host, or a restart would silently move
   * the chat back onto the host's last-used model.
   */
  model: string | undefined;
  /**
   * This chat's permission-mode override, outranking the host default (spec/02
   * § Permission mode). Persisted to the chat's meta and rehydrated below,
   * because the spec requires an override to outlive the host that received
   * it.
   */
  permissionMode: SdkPermissionMode | undefined;
  /**
   * The stored account this chat's turns start on, when it named one at spawn
   * (spec/10 § Backend credentials — preferred account). Persisted to meta and
   * rehydrated below; absent leaves the host's strategy to decide.
   */
  preferredAccountId?: string;
  /**
   * Tools the user has switched OFF for this chat in the surface's Tools panel
   * (patch/todo.md — "allow the user to turn them on and off"). Carried on every
   * `chat.input` (the setting is live, not spawn-only) and reused for the turn's
   * SDK `disallowedTools`. In-memory only; `undefined`/empty ⇒ every tool on.
   */
  disabledTools: string[] | undefined;
  nextSeq: number;
  pinned: boolean;
  pinnedAt: number | null;
  /**
   * A special thread turned off (spec/06 § Disabled) — distinct from
   * `disabledTools` above, which is an unrelated per-chat tool allowlist.
   * Only meaningful for the three special threads.
   */
  disabled: boolean;
  status: ChatStatus;
  archivedAt: number | null;
  /**
   * ms epoch the chat is snoozed until (spec/04 § Snooze), or `null` when it is
   * not snoozed. Mirrored to meta.json so a snooze survives a restart. Snooze is
   * orthogonal to `status` — a snoozed chat is still `active` and still runs.
   */
  snoozedUntil: number | null;
  /**
   * Running out of the active list (spec/04 § Hidden). Mirrored to meta.json.
   * Orthogonal to `status` like `snoozedUntil`; it survives archiving so a
   * machine message starting the chat again puts it back where it was.
   */
  hidden: boolean;
  createdAt: number;
  /**
   * ms epoch of the user's own last activity on this chat (spec/14 § Sidebar
   * ordering): when they last sent a message (`fromUser: true` — a surface
   * composer, voice note, fork or side message), or `createdAt` if they never
   * have. Mirrored to meta.json. Unlike `lastUpdated`, an agent reply, a
   * status change, a job tick or a finished turn never touches this — that is
   * the whole point: it is what sidebar ordering sorts by instead, so none of
   * those move a chat's row.
   */
  lastUserActivity: number;
  /** Set when activity===errored; cleared otherwise. Group 10 polish m6. */
  lastError: ChatLastError | null;
  /**
   * How full the context window is (spec/14 § Composer — context ring), from
   * the latest request's usage and the window its turn's result named.
   * Mirrored to meta.json so a restart does not blank the ring on every chat.
   * Absent or `null` until measured.
   */
  context?: ChatContextUsage | null;
  /**
   * Set when this chat is a `patch_delegate` subagent, mirrored from
   * `meta.subagent` (see meta.ts). `undefined` for an ordinary chat.
   */
  subagent?: ChatSubagentInfo;
}

/** A subagent's durable record, persisted on its own `meta.subagent`. */
export interface ChatSubagentInfo {
  parentChatId: string;
  label: string;
  outcome?: 'done' | 'failed' | 'stopped';
  finishedAt?: number;
  /** Tools the parent withheld from this subagent. */
  disallowedTools?: string[];
}

export function chatStateFromMeta(meta: ChatMeta): ChatState {
  return {
    chatId: meta.chatId,
    name: meta.name,
    preview: meta.preview ?? null,
    goal: meta.goal ?? null,
    // Progress counters are in-memory only (see field doc) — a rehydrated
    // active goal starts counting from zero again rather than guessing.
    goalProgress: meta.goal
      ? {
          startedAt: meta.updatedAt,
          turnsEvaluated: 0,
          tokensSpent: 0,
          lastVerdict: null,
          lastReason: null,
        }
      : null,
    lastGoal: meta.lastGoal ?? null,
    goalRefusalStreak: 0,
    goalEvalAwaitingWatches: false,
    reminder: meta.reminder ?? null,
    // Status summary is in-memory only (regenerated per turn), so a rehydrated
    // chat starts with none until its next turn settles.
    // A DECLARED status is persisted, so a rehydrated chat keeps it — that is
    // the point of it. The generated pair below is not.
    declaredStatus: meta.declaredStatus ?? null,
    statusSummary: meta.declaredStatus?.text ?? null,
    statusKind: meta.declaredStatus?.kind ?? null,
    // Not persisted either, and unlike the declared status there is nothing to
    // restore it from: the closing text belongs to a turn this process never
    // ran, so a rehydrated chat has none until its next turn settles.
    turnSummary: null,
    // Todos mirror the latest turn's TodoWrite and aren't persisted, so a
    // rehydrated chat starts with an empty list until its next TodoWrite.
    todos: [],
    lastFiredTodo: null,
    todosEditedBySurface: false,
    hiddenNotice: null,
    goalNotice: null,
    pendingHookAdvice: [],
    consecutiveHookBlocks: 0,
    pendingAgentResponseCheckId: null,
    turnWasHookResubmit: false,
    folder: meta.folder,
    activity: 'idle',
    // A chat that has never run a turn this process has no turn to attribute.
    // `user` is the value that leaves a hydrated chat behaving as it did before
    // origins existed; the first real turn overwrites it either way.
    turnOrigin: 'user',
    // A rehydrated chat has no in-flight turn, so nothing has been stopped.
    turnStopped: false,
    turnRetrying: false,
    lastMessages: [],
    lastUpdated: meta.updatedAt,
    claudeSessionId: meta.claudeSessionId,
    model: meta.model ?? undefined,
    permissionMode: meta.permissionMode ?? undefined,
    ...(meta.preferredAccountId !== undefined
      ? { preferredAccountId: meta.preferredAccountId }
      : {}),
    disabledTools: undefined,
    nextSeq: meta.nextSeq,
    pinned: meta.pinned ?? false,
    pinnedAt: meta.pinnedAt ?? null,
    disabled: meta.disabled ?? false,
    status: meta.status ?? 'active',
    archivedAt: meta.archivedAt ?? null,
    snoozedUntil: meta.snoozedUntil ?? null,
    hidden: meta.hidden ?? false,
    createdAt: meta.createdAt,
    lastUserActivity: meta.lastUserActivity ?? meta.createdAt,
    // Rehydrate the persisted error detail so an errored chat that survived a
    // host restart still explains itself (status:errored + lastError:null was
    // the d6 defect). Only meaningful when the chat is still errored.
    lastError:
      meta.status === 'errored' ? ((meta.lastError as ChatLastError | null) ?? null) : null,
    context: meta.context ?? null,
    subagent: meta.subagent,
  };
}

export class ChatStateMap {
  private readonly states = new Map<string, ChatState>();
  private readonly maxLastMessages: number;

  constructor(opts: { maxLastMessages?: number } = {}) {
    this.maxLastMessages = opts.maxLastMessages ?? DEFAULT_LAST_MESSAGES;
  }

  get(chatId: string): ChatState | undefined {
    return this.states.get(chatId);
  }

  /**
   * Resolve a full chatId or a unique prefix of one (spec/17-cli.md: "`<id>`
   * accepts the full ULID or a unique prefix"). An exact id always wins even
   * if it also happens to prefix another chat's id. A prefix matching more
   * than one chat is refused rather than picking one — same shape as
   * `resolveHost`'s daemonId-prefix matching in the CLI's `hosts` command.
   */
  resolve(idOrPrefix: string): ChatState | undefined {
    const exact = this.states.get(idOrPrefix);
    if (exact) return exact;
    let match: ChatState | undefined;
    for (const state of this.states.values()) {
      if (state.chatId.startsWith(idOrPrefix)) {
        if (match) return undefined;
        match = state;
      }
    }
    return match;
  }

  set(state: ChatState): void {
    this.states.set(state.chatId, state);
  }

  has(chatId: string): boolean {
    return this.states.has(chatId);
  }

  list(): ChatState[] {
    return Array.from(this.states.values());
  }

  delete(chatId: string): boolean {
    return this.states.delete(chatId);
  }

  size(): number {
    return this.states.size;
  }

  hydrate(metas: Iterable<ChatMeta>): void {
    for (const m of metas) this.set(chatStateFromMeta(m));
  }

  /** Append a message to lastMessages, trimming to maxLastMessages. */
  pushMessage(chatId: string, msg: ChatMessageSnapshot): void {
    const s = this.states.get(chatId);
    if (!s) throw new Error(`pushMessage: unknown chatId ${chatId}`);
    s.lastMessages.push(msg);
    if (s.lastMessages.length > this.maxLastMessages) {
      s.lastMessages.splice(0, s.lastMessages.length - this.maxLastMessages);
    }
    s.lastUpdated = msg.ts;
  }

  setActivity(chatId: string, activity: ChatActivity): void {
    const s = this.states.get(chatId);
    if (!s) throw new Error(`setActivity: unknown chatId ${chatId}`);
    s.activity = activity;
    s.lastUpdated = Date.now();
    // Clear lastError when leaving the errored state.
    if (activity !== 'errored') s.lastError = null;
  }

  setLastError(chatId: string, err: ChatLastError | null): void {
    const s = this.states.get(chatId);
    if (!s) throw new Error(`setLastError: unknown chatId ${chatId}`);
    s.lastError = err;
  }
}
