import { CodexTurnError } from './codexBackend.js';
import { expandHome } from './expandHome.js';
import { isCodexModel, CODEX_BACKEND_ID } from './codexAccounts.js';
import { invalidateGitDirtyCache } from './git-dirty.js';
import { invalidateFilesRecursiveCache } from './files-recursive.js';
import { discoverClaudeMcpServers } from './claudeConfigMcp.js';
// Host's session manager.
//
// Owns chat_state, the per-chat AbortControllers, the per-chat seq counter,
// and the bridge from SDK envelopes to `@patch/wire` events. Public methods
// on `Daemon` are the action-execution interface used by group 7+ over the
// server-daemon WS link, and by the loopback CLI control HTTP.
//
// Per spec/02-daemon.md and spec/04-chats-and-folders.md.

import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, relative, resolve as pathResolve, sep } from 'node:path';
import { ulid } from 'ulid';
import type { Logger } from 'pino';
import type {
  WireEvent,
  AttachmentRef,
  AttachmentKind,
  ChatActivity,
  ChatErrorCode,
  ChatErrorEvent,
  ChatMessageEvent,
  ChatMessageDeltaEvent,
  ChatToolCallEvent,
  ChatToolResultEvent,
  ChatProviderContextEvent,
  ChatPermissionRequestEvent,
  ChatPermissionResponseEvent,
  ChatDelegateUpdateEvent,
  ChatStateEvent,
  ChatSpawnedEvent,
  ChatMoveBundle,
  ChatStoppedEvent,
  ChatBranchesEvent,
  HookAgentResponseOutcomeEvent,
  PendingWake,
  StatusKind,
  TodoItem,
  TurnOrigin,
  RateLimitWindow,
  HarnessId,
  LoggedEvent,
  NativeRef,
  PermissionDecisionBy,
  TurnOutcome,
  McpServerConfig,
} from '@patch/wire';

import {
  ChatStateMap,
  type ChatState,
  type ChatMessageSnapshot,
  type HookAdviceNote,
  type ChatSubagentInfo,
  type ChatLastError,
  type SdkPermissionMode,
} from './chatState.js';
import { type MetaStore, type ChatMeta, type UnreadableChat } from './meta.js';
import {
  PermissionModeDowngradedError,
  type SdkBackend,
  type SdkEnvelope,
  type SdkRunOptions,
} from './sdkBackend.js';
import {
  createHistoryReader,
  eventIdentity,
  persistedUserContent,
  extractSystemContext,
  type CanonicalSeqIndex,
  type HistoryReader,
  defaultClaudeProjectsRoot,
} from './history.js';
import { randomUUID } from 'node:crypto';
import { WakeScheduler, parseDelayMs, type WakeRecord } from './wake.js';
import { WatchScheduler, type WatchRecord } from './watch.js';
import { webBotAuthFromEnv } from './webBotAuth.js';
import {
  BrowserManager,
  BrowserNotInstalledError,
  type BrowserProfile,
  type OpenResult,
  type PointerRequest,
  type RouteThrough,
  type SnapshotNode,
  type TabInfo,
} from './browser.js';
import {
  persistPendingDecision,
  clearPendingDecision,
  clearAllPendingDecisions,
  readPendingDecisions,
  type PendingDecisionRecord,
} from './pendingDecisions.js';
import {
  buildGoalSystemReminder,
  buildHiddenSystemReminder,
  buildTodoEditSystemReminder,
  buildTodoFireSystemReminder,
  markTodoStarted,
  parseTodoWriteArgs,
  selectNextTodo,
  TODO_PREFIX,
} from './todos.js';
import { assistantContextTokens, resultContextWindow } from './contextUsage.js';
import { renderGoalTranscript } from './goalEval.js';
import {
  isReservedSpecialThread,
  resolvePermissionModeForModel,
  DEFAULT_GOAL_REFUSAL_LIMIT,
  QUESTION_EXPIRY_SECONDS_DEFAULT,
  QUESTION_EXPIRY_SECONDS_MIN,
  QUESTION_EXPIRY_SECONDS_MAX,
  LOGGED_EVENT_TYPES,
  SPECIAL_THREAD_IDS,
  type ManagerSweepCandidate,
  type ManagerSweepResultEvent,
} from '@patch/wire';
import type { SweepDecisionResult } from './managerSweepGen.js';
import { countMessages, windowTrack } from './managerContext.js';
import { permissionModeChangeLine } from './permissionMode.js';
import {
  isAccountExhausted,
  isAccountExhaustedError,
  parseLimitResetsAt,
} from './accountFailover.js';
import { assistantErrorText, isModelOutput, TurnFailedError } from './sdkBackend.js';
import type { LimitFacts } from './sdkBackend.js';
import type { SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import {
  isOverloadedError,
  isRateLimitError,
  limitFailureMessage,
  statedLimitOf,
} from './limitFailure.js';
import { CLAUDE_BACKEND_ID } from './host.js';
import {
  applyFindReplace,
  countOccurrences,
  DocConflictError,
  readSidecar,
  recordVersion,
  sidecarPathFor,
  writeSidecar,
  type DocMode,
  type DocSidecarData,
  type DocSuggestion,
  type DocThread,
} from './docSidecar.js';
import { importDocx, exportMarkdownToDocx, exportMarkdownToPdf } from './docConvert.js';
import type { AccountStrategy, ChatInputEvent, DocExportFormat } from '@patch/wire';
import { voicePrefixForSource } from './specialThreads.js';

/**
 * Result of the per-query OAuth check. `ok:true` carries the access token to
 * bake into the SDK env; `ok:false` carries a human-readable reason that is
 * fanned out as `daemon.unauthenticated`. NO FALLBACK to an API key — a miss
 * means the query is refused outright.
 */
/**
 * The credential a turn is about to run on — and WHICH account it came from.
 *
 * A chat has no account of its own (spec/10-auth.md § Backend credentials):
 * every turn resolves the host's ordered keys afresh and takes the first with
 * credit. So the only place the account a turn is running on exists is here,
 * for the turn that is running — reported back so a failure can be attributed
 * to the key that actually spent, and never stored on the chat.
 */
export type OAuthCheckResult =
  | { ok: true; accessToken: string; accountId?: string }
  | { ok: false; reason: string };

export interface DaemonOptions {
  /**
   * This host's id (spec/02 § Host identity). Every frame the host emits is
   * addressed with it — an unaddressed `chat.spawned` would leave the server
   * unable to say which machine a chat lives on. Required: there is no sane
   * placeholder, and a wrong one silently binds chats to another host.
   */
  daemonId: string;
  /**
   * The host's DEFAULT permission mode, applying to new chats on this machine
   * (spec/02 § Permission mode). Omitted → `auto`, which is the documented
   * base of the resolution chain, not a fallback for a failed read.
   */
  permissionModeDefault?: SdkPermissionMode;
  /**
   * The model a spawn that names none runs on — the ACCOUNT's `defaultModel`,
   * mirrored to this host by the server (spec/02 § Agent backends, spec/04
   * § Spawn). Returning `undefined` means no default has reached this machine,
   * and such a spawn is REFUSED saying exactly that — never quietly handed to
   * the SDK's own default, which would silently run the chat on a model nobody
   * chose.
   *
   * This replaced `lastUsedModel`, which was DERIVED: it took the model of
   * whatever chat last ran on the machine, so one throwaway cheap-model chat
   * silently moved every later model-less spawn — every unattended job included
   * — onto it, and it stayed there until someone happened to pick something
   * else. Nothing writes back to this now; a default is a decision, in one
   * place, not the trailing edge of unrelated activity.
   *
   * Absent (not wired) leaves model resolution to the caller.
   */
  defaultModel?: () => string | undefined;
  /**
   * Every model id this host's catalogue currently offers (spec/02 § Model
   * catalogue), used to validate a mid-chat model change (spec/04 § Model).
   * Async because reading the catalogue can mean going to the provider; in
   * practice the surface has just listed it, so the host's cache is warm.
   *
   * REJECTING is a real answer: throwing (no credential, provider down) means
   * the change cannot be checked, and an unchecked change is refused rather
   * than waved through — the point of validating is that a typo'd or retired
   * id must not reach the SDK.
   *
   * Absent (mock backend, most existing tests) skips validation, same "not
   * wired" convention as `defaultModel`.
   */
  knownModelIds?: () => Promise<ReadonlySet<string>>;
  metaStore: MetaStore;
  sdkBackend: SdkBackend;
  /**
   * Which SDK backend is wired (`'real'` | `'mock'`). The real Claude Agent
   * SDK `query({ resume })` HANGS forever (no first message, no result, no
   * error) when handed a `resume` session id whose transcript JSONL is absent
   * from `claude-projects/<folder>/<sessionId>.jsonl` — e.g. a `claudeSessionId`
   * persisted by a previous MOCK run (mock writes `mock-session-*.jsonl`, never
   * `<sessionId>.jsonl`), or a transcript pruned out from under us. The mock
   * backend, by contrast, resumes fine without a matching file (it replays from
   * its own store / the ring). So runQuery clears an orphaned resume id ONLY
   * for the real backend (spec/04 ## Resume recovery — start fresh, NO hang).
   * Defaults to `'mock'` when unset so tests keep their existing resume
   * behaviour.
   */
  sdkBackendKind?: 'real' | 'mock';
  /**
   * MCP servers Claude Code's own config already names for a chat's folder
   * (`claudeConfigMcp.ts`), merged into `extraMcpServers` ahead of the host's
   * own Settings → MCP list. Defaults to the real reader; tests inject a stub
   * (usually `() => []`) so a suite's result never depends on the ambient
   * `~/.claude.json`/`~/.claude/settings.json` of whatever machine runs it.
   */
  discoverClaudeMcpServers?: (folder: string) => McpServerConfig[];
  /**
   * OAuth gate (spec/10-auth.md "Claude OAuth — non-negotiable"). Called
   * BEFORE every SDK `query()` — re-reads ~/.claude.json so a credential that
   * expired or was deleted mid-run is caught. On a miss the host emits
   * `daemon.unauthenticated` and refuses to start the query. Production wires
   * this to a live re-read of the OAuth file; tests inject a stub.
   *
   * Exactly one of `resolveOAuth` / `oauthAccessToken` must be supplied.
   * `resolveOAuth` takes precedence when both are present. It takes no
   * account: which key a turn runs on is decided host-wide, first-with-credit
   * in the stored order (spec/10 § Backend credentials — multiple accounts),
   * and is reported back on the result rather than chosen by the caller.
   */
  resolveOAuth?: (
    model?: string,
    /**
     * Present when a TURN is starting, naming its chat — so the host can put
     * that chat's preferred account first and move a round-robin on. Absent for
     * a check that runs nothing (a spawn's credential check), which must not
     * spend a place in the rotation.
     */
    turn?: { chatId: string; preferredAccountId?: string },
  ) => OAuthCheckResult | Promise<OAuthCheckResult>;
  /**
   * A turn just failed because ITS ACCOUNT has no credit left. Return the next
   * account to try, by the host's priority order, or undefined when there is
   * none (spec/10-auth.md § Backend credentials — multiple accounts).
   *
   * The point of a host holding two accounts is that the second one gets used:
   * an account hitting its spend limit used to stop every chat on it dead, in a
   * retry loop, while a funded account sat unused. Returning an id here runs
   * the turn again immediately — on whatever the host now resolves to, which is
   * this id, because the spent one has just been recorded as spent.
   *
   * `spentAccountId` is the account the failing turn actually RAN on, as
   * reported by `resolveOAuth` — not a preference, which a chat does not have.
   *
   * Absent (tests, single-account hosts) means no failover: the turn falls
   * through to the usual rate-limit park, which waits for the reset.
   */
  /** An account's label, for the chat header and the switch line. */
  accountLabel?: (model: string | undefined, accountId: string) => string | undefined;
  /**
   * Whether a turn moving off `fromAccountId` is because that account is out
   * of credit, and when it comes back if known. Only such a move is said in
   * the chat: a round-robin turn moving on is the strategy working, not news.
   */
  accountSpent?: (
    model: string | undefined,
    fromAccountId: string,
  ) => { spent: boolean; until?: number };
  nextAccountAfterExhausted?: (
    chatId: string,
    spentAccountId: string | undefined,
    message: string,
    /**
     * What the provider said about the limit, structured — in particular
     * `resetsAt`, an exact epoch on the failing message.
     *
     * Passed through because the host records the exhaustion, and a reset it
     * has to re-derive from the prose ("… resets 7pm (UTC)") is one that a
     * structured-only refusal leaves it without: the account is then sidelined
     * with no reset time, so nothing is armed for its return. The turn path
     * already prefers the structured field for its own park; the rotation was
     * reading the sentence.
     */
    limit?: { resetsAt?: number },
  ) => string | undefined;
  /**
   * What the host knows about an account's limits right now — its label, which
   * pool is refusing, how full it is, when it clears, and whether other stored
   * accounts went down with it because they share its organisation.
   *
   * Injected rather than read here because the runner owns turns, not
   * credentials; the host owns the account store and the usage tracker.
   * Absent (tests, hosts with no store) simply means the block is reported with
   * whatever the turn itself observed.
   */
  accountLimitInfo?: (accountId: string | undefined) =>
    | {
        label?: string;
        /**
         * The pool that RAN OUT. Never the overflow pool: that is what covers
         * for these two, and naming it as the limit hit reads as nonsense.
         */
        scope?: 'session' | 'week';
        utilization?: number;
        resetsAt?: number;
        /** Extra usage could not cover it — why this is a stop, not a spill. */
        overageBlocked?: boolean;
        overageReason?: string;
      }
    | undefined;
  /**
   * Does this host have NO account with credit right now?
   *
   * The same question `nextAccountAfterExhausted` answers by returning
   * undefined, asked WITHOUT a failure to hang it on — because the knowledge is
   * the host's and outlives the turn that discovered it. A turn that dies for
   * some unrelated reason (a killed `claude`, a dropped socket) while every key
   * is spent is still a turn blocked on credit, and the retry ladder must not
   * treat it as a blip: three attempts 90 seconds apart cannot outlast a weekly
   * window, and the generic failure they end on overwrites the chat's stored
   * limit wording — which is the only thing the credit-return sweep recognises.
   *
   * That is how chat 01M3Y2GYHVQB6N1N3MV6WH6P32 died for thirteen hours on
   * 6 Oct 2026: parked correctly at 19:59 against a spent host, re-run by the
   * 60-second guess at 20:00, killed with `exited with code 143`, laddered four
   * times, left `errored` reading "Claude Code process exited with code 143" —
   * so when the limit reset at 21:00 nothing could tell it had ever been about
   * credit.
   *
   * Absent (tests, hosts with no account store) means "cannot tell", which is
   * reported as `false`: the ladder behaves exactly as it did before.
   */
  hostOutOfCredit?: () => boolean;
  /**
   * The routing strategy in force and how far through the held accounts the
   * exhaustion has got, for the chat to say beside the limit ("Round robin —
   * all 3 accounts out, next resets 14:00 (personal)"). Undefined for a host
   * with no account store, which has nothing to say.
   */
  accountRouting?: (model: string | undefined) =>
    | {
        strategy: AccountStrategy;
        accounts: number;
        exhausted: number;
        nextResetsAt?: number;
        nextLabel?: string;
      }
    | undefined;
  /**
   * Static access token — convenience for tests that don't exercise the gate.
   * When `resolveOAuth` is absent this is wrapped into an always-ok resolver.
   */
  oauthAccessToken?: string;
  /** Emit each fan-out event upstream + into observers. */
  emit: (event: WireEvent) => void;
  /**
   * The SDK reported this account's usage for the session (5-hour) or week
   * (7-day) window (spec/10 § Surface in Settings — Usage). Optional: tests
   * that don't care about usage omit it and the report is just dropped.
   * Wired to re-send this host's `daemon.account` with the merged figures —
   * ChatRunner doesn't own the connected/email half of that report, so it
   * hands the window off rather than emitting `daemon.account` itself.
   */
  onRateLimit?: (chatId: string, scope: 'session' | 'week', window: RateLimitWindow) => void;
  logger: Logger;
  /** MCP child the SDK should launch per-query (real backend only). */
  mcpServer?: { command: string; args: string[]; env: Record<string, string> };
  /** Test hook: clock. */
  now?: () => number;
  /** Test hook: id generator. */
  generateChatId?: () => string;
  /** Inject a history reader (tests). Defaults to ~/.claude/projects. */
  historyReader?: HistoryReader;
  /**
   * Root Claude Code persists native transcripts under (spec/04 § History).
   * Defaults to `~/.claude/projects`. Needed here (not just inside the
   * default `historyReader`) for the Claude `sessionStore`'s own local-disk
   * fallback (`claudeSessionStore.ts`) and for a provider switch's
   * reconstruction — both run outside `historyReader`'s closure.
   */
  claudeProjectsRoot?: string;
  /**
   * Hook called at the start of every `sendInput` to optionally prepend
   * harness context (e.g. broadcast `<system-reminder>` for special threads,
   * spec/06 + spec/09). Returns the (possibly-rewritten) message that should
   * be passed to the SDK.
   */
  preprocessInput?: (req: SendInputOptions) => string | undefined;
  /** Hook called once the agent has committed a response on a chat (per turn). */
  onTurnCommitted?: (chatId: string) => void;
  /**
   * Optional AI title summariser (spec/04 § Name). When set, the host fires
   * it ONCE per chat as soon as the chat's first user message is accepted —
   * asynchronously and non-blocking, before the turn itself even starts, so a
   * long-running first turn never delays the title landing — to turn that
   * message into a short human-readable title. It is deliberately OPTIONAL and
   * defaults to undefined: the existing host tests never provide it, so they
   * never touch the SDK for a title and are wholly unaffected. On success the
   * host sets `state.name`, persists it, and re-emits `chat.state`; on
   * null/failure the name stays null (NO FALLBACK to dumping the first user
   * message — the client shows "New chat"/folder).
   */
  generateTitle?: (input: {
    chatId: string;
    firstUserMessage: string;
    folder: string;
    chatModel?: string;
  }) => Promise<string | null>;
  /**
   * Optional AI "current status" summariser (patch/todo.md § Features to add —
   * "Current status"). When set, the host fires it after EACH turn settles
   * (not just the first) — asynchronously and non-blocking — to produce a
   * one-line status of the thread plus a KIND distinguishing a thread paused on
   * a user `question` from one that has merely stopped (`complete`). On success
   * the host sets `state.statusSummary`/`state.statusKind` and re-emits
   * `chat.state`; on null/failure nothing is written (the status stays as it is
   * — which, after a fresh user message, means the cleared `null`). Like
   * `generateTitle` it is OPTIONAL and defaults to undefined, so existing host
   * tests never touch the SDK for a status and are unaffected.
   */
  /**
   * spec/14 § Tool runs — when a run of more than one groupable tool call
   * closes, the host asks this for a one-line label of what the run was for
   * and stamps it as `chat.tool_run_summary`. It THROWS on failure, and the
   * failure is stamped instead (NO FALLBACK). Optional so existing host tests
   * never reach the SDK.
   */
  summarizeToolRun?: (input: {
    chatId: string;
    folder: string;
    userMessage: string;
    assistantBefore: string;
    calls: Array<{ tool: string; args: unknown; failed?: boolean; outcome?: string }>;
  }) => Promise<string>;
  generateStatus?: (input: {
    chatId: string;
    lastUserMessage: string;
    assistantReply: string;
    folder: string;
  }) => Promise<{ kind: StatusKind; summary: string } | null>;
  /**
   * Optional goal evaluator (spec/04 § Goals; `goalEval.ts`). When set, the
   * host fires it after EACH turn settles on a chat with an active goal —
   * asynchronously and non-blocking — to judge the condition against the
   * transcript so far. On `not_met` the host resubmits with the reason as
   * guidance; on `met`/`impossible` it clears the goal (§ `settleGoal`). On
   * null (failure) nothing changes — the next settle tries again. Optional so
   * existing host tests never touch the SDK for a goal.
   */
  evaluateGoal?: (input: {
    chatId: string;
    condition: string;
    transcript: string;
    turnsEvaluated: number;
    folder: string;
  }) => Promise<{
    verdict: 'met' | 'not_met' | 'refused' | 'impossible';
    reason: string;
  } | null>;
  /**
   * How long to wait before re-checking a goal deferred on running
   * `patch_watch` tasks (`GOAL_WATCH_POLL_MS`'s default). Overridable so tests
   * don't wait out the real interval; production never sets it.
   */
  goalWatchPollMs?: number;
  /**
   * Branch send-back summariser (spec/04 § Send back; `branchSendBackGen.ts`).
   * Same cheap-model shape as `summarizeToolRun`. THROWS on failure (NO
   * FALLBACK) — the caller records the attempt either way. Optional so
   * existing host tests never reach the SDK.
   */
  summarizeBranchSendBack?: (input: {
    chatId: string;
    branchId: string;
    folder: string;
    firstMessage: string;
    lastAssistantText: string;
  }) => Promise<string>;
  /**
   * Session-handoff digest generator (spec/06 § Session rotation, spec/04 §
   * History — "switch and compact"; `rotationDigest.ts`). When set,
   * `rotateThread` uses it to ask the OUTGOING session for a handoff before
   * retiring it, and a compact provider switch uses it the same way before
   * building the target's small starting context. OPTIONAL — both callers
   * refuse rather than starting a fresh session/switch with nothing carried
   * over (NO FALLBACK). `model` names the resuming session's OWN model, so a
   * Codex `resumeSessionId` resumes on Codex rather than being sent to Claude.
   */
  generateDigest?: (input: {
    chatId: string;
    resumeSessionId: string;
    folder: string;
    model?: string | null;
  }) => Promise<string | null>;
  /**
   * The Manager sweep's one decision call (spec/06 § Sweep;
   * `managerSweepGen.ts`). OPTIONAL — `runManagerSweep` refuses rather than
   * guessing when it's unset (NO FALLBACK), same contract as `generateDigest`.
   */
  decideSweep?: (input: {
    digest: string;
    prompt: string;
    model: string;
  }) => Promise<SweepDecisionResult | null>;
  /**
   * Cross-host history read (spec/03 § Cross-chat tools — same relay
   * `patch_history` uses). `runManagerSweep` uses this for a candidate whose
   * `daemonId` is not this host's own.
   */
  historyRemoteChat?: (req: {
    sourceChatId: string;
    targetChatId: string;
    fromSeq?: number;
    limit?: number;
  }) => Promise<{ events: WireEvent[]; nextFromSeq?: number }>;
  /**
   * Cross-host turn delivery (spec/03 § Cross-chat tools — same relay
   * `patch_send_to` uses). `runManagerSweep` uses this to nudge/wake a
   * candidate not on this host.
   */
  sendToRemoteChat?: (req: {
    sourceChatId: string;
    targetChatId: string;
    message: string;
  }) => Promise<void>;
  /**
   * The Manager's bounded context window (spec/06 § Manager conversation) —
   * how many of its own messages the model sees, reconstructed fresh from
   * that window once the full track grows past it. Mutable at runtime via
   * `setManagerContextWindow` (`host.settings` → `managerContextWindow`),
   * same pattern as `chatNameInterval`. Defaults to a generous 200 so a host
   * that hasn't heard from the server yet doesn't truncate aggressively.
   */
  managerContextWindow?: number;
  /**
   * Ask the server what it is holding for this chat, at a tool boundary (spec/04
   * § Message queueing — the server-run queue). Absent, or an empty answer, means
   * nothing is waiting there.
   */
  pullQueued?: (chatId: string) => Promise<ChatInputEvent[]>;
  /** The thread's pending handoff was given to the agent with a message. */
  onHandoffConsumed?: (chatId: string) => void;
  /**
   * Enable the todo auto-advance manager (patch/todo.md § Features to add —
   * "todo list"). When set, the host mirrors each chat's native TodoWrite list
   * onto chat state AND, once a turn settles with items still pending, fires the
   * next pending item back into the chat as a fresh `[todo]` turn — so the agent
   * works its list one focused turn at a time. OPTIONAL, defaults to false, so
   * existing host tests observe no TodoWrite mirroring or self-firing and are
   * unaffected. Production wires this on.
   */
  autoAdvanceTodos?: boolean;
  /**
   * Enable `agent_response` hooks (spec/20-hooks.md § On the agent's
   * response). When set, the host sends a `hook.agent_response_check_request`
   * to the server after EACH turn settles (special threads included — the
   * hook's own gate decides whether it applies), carrying the agent's full
   * reply and a deterministic tool-call tally. OPTIONAL, defaults to false, so
   * existing host tests observe no agent-response dispatch and are
   * unaffected. Production wires this on.
   */
  checkAgentResponseHooks?: boolean;
  /**
   * How many user messages between auto-regen of the chat name (task: "chat
   * names should update every 10 messages"). `0` (default) disables periodic
   * regen — the title is only generated from the first message, as before.
   * When set, the title is regenerated every `chatNameInterval` user messages
   * after the first title has already been generated. Optional — absent or 0
   * leaves existing behaviour entirely unchanged.
   */
  chatNameInterval?: number;
  /**
   * Delay before `maybeGenerateTitle`'s retry attempt, in ms. Defaults to
   * `TITLE_GEN_RETRY_DELAY_MS`. Tests override this to keep the retry-path
   * assertions fast.
   */
  titleGenRetryDelayMs?: number;
  /**
   * Per-host Claude harness config (Task 3). When set, overrides the SDK query
   * options for every turn on this host. `systemPrompt` replaces the SDK
   * default; `skills` controls which skills are visible.
   */
  harnessConfig?: {
    systemPrompt?: string;
    toolsPrompt?: string;
    skills?: string[] | 'all';
    /** spec/14 § Agent behavior — Memory toggle. Gates the SDK's `settings.autoMemoryEnabled`. */
    memoryEnabled?: boolean;
    /**
     * Settings → MCP: the host's ENABLED MCP servers, wired into every turn
     * after Patch's own `patch` server (Claude and Codex alike).
     */
    mcpServers?: McpServerConfig[];
    /** spec/14 § Agent behavior — CLAUDE.md toggle, off. Excluded via `settings.claudeMdExcludes`. */
    claudeMdExcludePaths?: string[];
  };
  /**
   * The chats' own history log (spec/04 § History). Omitted → one rooted
   * beside the meta store: `~/.patch/chats/<id>/events.jsonl` and
   * `~/.patch/blobs`. Injected by tests that need to watch its fsyncs.
   */
  chatLog?: ChatLog;
  /**
   * The agent browser (spec/02 § Browser). Omitted → one rooted beside the
   * meta store: `~/.patch/browser/profile` for the persistent 'logged-in'
   * context. Injected by tests that need a fake Chromium.
   */
  browser?: BrowserManager;
  /**
   * spec/02 § Browser — Route through: resolves THIS host's current routing
   * target (if any) into what `BrowserManager.open` needs — whether that
   * host is online, its display name, and a ready SOCKS proxy address.
   * Omitted → browsing is always direct, same as before this existed (the
   * in-process control smoke tests have no other hosts to route through).
   */
  browserRouting?: BrowserRoutingDeps;
}

/**
 * index.ts wires this from the same `onlineHosts`/`sender` it already keeps
 * for cross-chat tools — this interface is what keeps `chatRunner.ts`
 * ignorant of hosts, the server, and the wire, same discipline as every
 * other cross-machine seam here (`spawnOnRemoteHost`, `peekRemoteChat`, …).
 */
export interface BrowserRoutingDeps {
  /** This host's current `browserRouteThrough` setting, or undefined when off. */
  target: () => string | undefined;
  isOnline: (daemonId: string) => boolean;
  /** Display name for a daemonId, falling back to the id itself if unknown. */
  hostName: (daemonId: string) => string;
  /** Starts (or reuses) a SOCKS listener for this target; resolves to its `socks5://127.0.0.1:<port>`. */
  proxyServerFor: (daemonId: string) => Promise<string>;
}

/** `Daemon.estimateProviderSwitch`'s result (spec/04 § History — the switch
 * confirmation's cost line). */
export interface ProviderSwitchEstimate {
  fromHarness: HarnessId;
  toHarness: HarnessId;
  /** Rides the target's OWN prior session (only the delta is new), rather
   * than rebuilding the whole track from scratch. */
  resumesExistingSession: boolean;
  /** chars/4 ballpark of what the target must re-read uncached — the whole
   * track if rebuilding from scratch, just the delta if resuming. Always
   * shown with a "~", never presented as an exact count. */
  approxTokens: number;
  /** This chat has been idle long enough that the relevant prompt cache
   * entry has almost certainly expired — the "resumes its session" framing
   * would be misleading without this caveat. */
  cacheProbablyCold: boolean;
}

/**
 * Tools a `patch_delegate` subagent never gets, on top of whatever the user
 * has switched off for the chat (spec/02 § Native subagent dispatch —
 * "talking to the user is the parent's job"). Fully-qualified MCP ids, same
 * form as the user's own Tools-panel toggle (`toolsCatalog.ts`'s
 * `patchToolId`) — this is the one place the host itself needs that
 * prefix, so it is inlined rather than importing the web package for it.
 */
const SUBAGENT_DISALLOWED_PATCH_TOOLS = [
  'mcp__patch__patch_notify',
  'mcp__patch__patch_report',
  'mcp__patch__patch_call',
  'mcp__patch__patch_speak',
  'mcp__patch__patch_ask_human',
  'mcp__patch__patch_artifact',
  'mcp__patch__patch_pad_create',
  'mcp__patch__patch_pad_update',
  'mcp__patch__patch_pad_reply',
  'mcp__patch__patch_pad_list',
];

/** `patch_delegate`'s live/settled state (spec/06 § Cross-chat tools). */
export type DelegateStatus = 'running' | 'awaiting-permission' | 'done' | 'failed' | 'stopped';

/** One row of `patch_delegate_list` / the parent's tool-row live state. */
/** What a waited-on subagent settled as (`patch_delegate` `wait: true`). */
export interface DelegateResult {
  status: 'done' | 'failed' | 'stopped';
  reply: string;
}

export interface DelegateSummary {
  id: string;
  label: string;
  status: DelegateStatus;
  createdAt: number;
  finishedAt: number | null;
}

export interface SpawnChatOptions {
  folder: string;
  name?: string;
  prompt?: string;
  /**
   * Server-allocated chatId (ULID per spec/04). When omitted, the host
   * generates one. Production traffic over WS always supplies it; the unit
   * tests omit it (the host's `generateChatId` hook produces deterministic
   * ids in those cases).
   */
  chatId?: string;
  /** Idempotency key for spawn — host dedupes (localId) within a window. */
  localId?: string;
  /**
   * Spawn into HIDDEN (spec/04 § Hidden) — a job whose action sets
   * `startHidden` (spec/08 ## Action). Defaults to the active list.
   */
  hidden?: boolean;
  /**
   * SDK `query()` model override (CLI `--model`). Persisted to in-memory chat
   * state and reused for every turn in this chat's host lifetime.
   */
  model?: string;
  /**
   * SDK `query()` permission mode for the new chat. Unset means no per-chat
   * override — the chat follows its host's default, floored at `'auto'`
   * (spec/02 § Permission mode).
   */
  permissionMode?: SdkPermissionMode;
  /**
   * The stored account this chat's turns start on (spec/10 § Backend
   * credentials — preferred account). The caller has already checked the host
   * holds it; fixed for the chat's life.
   */
  preferredAccountId?: string;
  /**
   * Marks the new chat as a `patch_delegate` subagent of `parentChatId`
   * rather than an ordinary chat (spec/06 § Cross-chat tools —
   * patch_delegate). Stamped onto `meta.subagent` and never cleared.
   */
  subagent?: { parentChatId: string; label: string; disallowedTools?: string[] };
}

/**
 * Backoff ladder for retrying a turn that died on a generic SDK error, in ms.
 * Its length IS the retry ceiling.
 */
const SDK_RETRY_BACKOFF_MS = [10_000, 30_000, 90_000];

/**
 * How old a failed turn may be and still be re-fired automatically.
 *
 * Retrying when the blocker clears is the point — a chat must not sit on
 * "you've hit your spend limit" forever. But a turn that failed days ago is
 * about a world that has moved on, so past this it stays errored and visible and
 * waits for a person.
 */
const STALE_RETRY_CUTOFF_MS = 6 * 60 * 60 * 1000;

/**
 * How long a provider's prompt cache entry is assumed to survive with no
 * traffic (spec/04 § History — flag when a switch confirmation's "resumes
 * its session" framing is misleading because the cache is probably gone
 * anyway). Anthropic's default `ephemeral` cache is a 5-minute TTL; a 1-hour
 * TTL exists but is opt-in per `cache_control` block (`ttl: "1h"`) — checked
 * against the installed `@anthropic-ai/claude-agent-sdk` bundle (no literal
 * `"1h"` anywhere in it, only the two `cache_creation` USAGE field names it
 * always reports), so Claude Code itself does not request the longer TTL and
 * this uses the 5-minute default for both harnesses.
 */
const PROMPT_CACHE_TTL_MS = 5 * 60 * 1000;

/** "Switch and compact" (spec/04 § History): how many of the track's own most
 * recent entries ride along with the handoff note verbatim, on top of the
 * digest. A handful of exchanges, not a real window — the point of this path
 * is that everything OLDER is summarised, not reconstructed. */
const COMPACT_SWITCH_RECENT_ENTRIES = 6;

export class FolderNotFoundError extends Error {
  constructor(folder: string) {
    super(`folder does not exist or is not a directory: ${folder}`);
    this.name = 'FolderNotFoundError';
  }
}

export class ChatNotFoundError extends Error {
  constructor(chatId: string) {
    super(`chat not found: ${chatId}`);
    this.name = 'ChatNotFoundError';
  }
}

/** `storeAttachment` was asked to store a file for a chat that doesn't exist. */
export class AttachmentChatNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentChatNotFoundError';
  }
}

/**
 * On-disk filename for a stored attachment: `<id>-<sanitized name>`. The id is a
 * server-minted ULID (unique + path-safe); the original name is sanitized to a
 * basename with separators/control chars neutralised so it can never traverse
 * out of the attachments dir. Deterministic so `resolveAttachmentPath` can
 * reconstruct the same path at send time.
 */
export function attachmentFileName(id: string, name: string): string {
  /* v8 ignore next -- String.split() always returns >=1 element, so .pop() is never undefined; the `?? name` fallback is unreachable defensive code. */
  const base = name.split(/[/\\]/).pop() ?? name;
  const safe = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_') || 'file';
  return `${id}-${safe}`;
}

/**
 * Header line that opens the attachment block folded into a user turn's prompt
 * (spec/14 & spec/15 § Composer). Kept human-readable so Claude reads the files
 * by path, but STABLE + machine-parseable (see `parseAttachmentBlock`) so the
 * host can lift the refs back out on replay and RE-EMIT them structurally —
 * the block is never shown as literal transcript text (spec/14 § Composer —
 * attachments "render inline in the stream", never as a raw marker).
 */
const ATTACHMENT_BLOCK_HEADER = '[Attachments]';

/** Total attempts `maybeGenerateTitle` makes before leaving a chat unnamed. */
const TITLE_GEN_ATTEMPTS = 5;

/** Delay before the first retry in `maybeGenerateTitle`; doubles each attempt, so a host that is briefly saturated (a deploy restart) gets time to recover. */
const TITLE_GEN_RETRY_DELAY_MS = 3_000;

/**
 * Prefixed onto a turn that a host restart cut in half, when `hydrate` puts it
 * back (see `resumeInterruptedTurns`). A leading `<system-reminder>` block is
 * stripped by `persistedUserContent`, so this reaches the agent as context and
 * never appears in the chat as text the user appears to have typed — what DOES
 * appear is just `'Carry on'`, not the original turn's own text (see
 * `resumeInterruptedTurns`).
 *
 * It matters that this says "continue" rather than nothing at all: the turn is
 * re-sent against the same Claude session, so the agent can see whatever it had
 * already done before it was killed, and re-running that work from scratch is
 * both wasteful and — for anything it already wrote — wrong.
 */
export const INTERRUPTED_TURN_REMINDER =
  '<system-reminder>\n' +
  'This turn was already running when the host restarted, so it was cut off partway ' +
  'through. Check what you had already done before you continue — carry on from there ' +
  'rather than starting the whole request again.\n' +
  '</system-reminder>\n\n';

const ORIGINAL_OPEN = '<original-prompt>\n';
const ORIGINAL_CLOSE = '\n</original-prompt>';
const REMINDER_CLOSE = '</system-reminder>';
const REMINDER_CLOSE_ESCAPED = '</system-reminder-escaped>';

/**
 * Appends the interrupted turn's own prompt to a restart reminder, inside the
 * reminder block so it reaches the agent but is stripped from the chat text.
 * The resumed session does not reliably still hold the original ask (nor its
 * autonomy instructions), so without this a bare "Carry on" leaves the agent
 * guessing. Any closing tag in the prompt is escaped so it cannot end the block.
 */
function withOriginalPrompt(reminder: string, original: string): string {
  const body =
    ORIGINAL_OPEN + original.split(REMINDER_CLOSE).join(REMINDER_CLOSE_ESCAPED) + ORIGINAL_CLOSE;
  const end = reminder.lastIndexOf('\n' + REMINDER_CLOSE);
  return (
    reminder.slice(0, end) +
    '\nThe prompt that turn was given, in full — follow it, including any instructions about ' +
    'not asking questions:\n' +
    body +
    reminder.slice(end)
  );
}

/**
 * The prompt a previously resumed turn carried, so a second restart re-supplies
 * the real original rather than the previous reminder wrapped around "Carry on".
 */
function originalPromptOf(message: string): string {
  const start = message.indexOf(ORIGINAL_OPEN);
  const end = message.lastIndexOf(ORIGINAL_CLOSE);
  if (!message.startsWith('<system-reminder>') || start < 0 || end < start) return message;
  return message
    .slice(start + ORIGINAL_OPEN.length, end)
    .split(REMINDER_CLOSE_ESCAPED)
    .join(REMINDER_CLOSE);
}

/** The text a cut-off head turn is re-sent as. */
export function interruptedTurnResend(reminder: string, turnMessage: string): string {
  return withOriginalPrompt(reminder, originalPromptOf(turnMessage)) + 'Carry on';
}

/**
 * One pending decision (pendingDecisions.ts), described for a human/agent to
 * read rather than as raw args — `AskUserQuestion`'s actual question text when
 * we can find it, else the permission's own description, else the bare tool
 * call. Best-effort: args are opaque `Record<string, unknown>` from the SDK,
 * so a shape this doesn't recognise falls back to a truncated JSON dump rather
 * than throwing.
 */
/**
 * Folded into a voice hand-off's turn: the request was spoken to the call's fast voice
 * and relayed here, and the answer is read aloud to the person on the call.
 */
export const VOICE_HANDOFF_REMINDER =
  '<system-reminder>\n' +
  "This turn is a request spoken on a voice call and relayed to you by the call's voice. " +
  'Do exactly what it asks and nothing more: do not resume, continue or report on any other ' +
  'work you have in progress, and do not start anything else. Reply in a sentence or two that ' +
  'reads well aloud, with no formatting. If it asks about something you are mid-way through, ' +
  'say where it stands.\n' +
  '</system-reminder>\n';

/** A spoken message's `[voice • …]` / `[voice hand-off • …]` tag, removed. */
export function stripVoiceTag(text: string): string {
  return text.replace(/^\[voice[^\]]*\]\s*/, '');
}

function describePendingDecision(rec: PendingDecisionRecord): string {
  if (rec.tool === ASK_USER_QUESTION && Array.isArray(rec.args['questions'])) {
    const texts = (rec.args['questions'] as unknown[])
      .map((q) =>
        q && typeof q === 'object' && typeof (q as { question?: unknown }).question === 'string'
          ? (q as { question: string }).question
          : null,
      )
      .filter((q): q is string => q !== null);
    if (texts.length > 0) return `asked: ${texts.join(' / ')}`;
  }
  if (rec.description) return `${rec.tool}: ${rec.description}`;
  const argsStr = JSON.stringify(rec.args);
  return `${rec.tool}(${argsStr.length > 200 ? argsStr.slice(0, 200) + '…' : argsStr})`;
}

/**
 * Like `INTERRUPTED_TURN_REMINDER`, but for a turn that was also blocked on a
 * permission/question when the restart hit (pendingDecisions.ts). The plain
 * reminder alone leaves the resumed agent with no memory a question was ever
 * asked, so it either silently re-derives from scratch or — worse — assumes
 * something was approved that never was. `armAnswerExpiry`'s timeout already
 * denies a request left unanswered too long; this covers the much larger
 * window before that timeout fires, or one disabled entirely (question
 * expiry can be turned off host-wide).
 */
function interruptedTurnReminderWithPendingDecisions(pending: PendingDecisionRecord[]): string {
  const asks = pending.map(describePendingDecision).join('; ');
  return (
    '<system-reminder>\n' +
    'This turn was already running when the host restarted, so it was cut off partway ' +
    `through. Before the restart it had ${asks}, and was waiting for an answer — no answer was ` +
    'recorded, because a restart discards it even if the user answered right before the crash. ' +
    'Check what you had already done, then decide whether to ask again or proceed without it. ' +
    'Do NOT assume it was approved.\n' +
    '</system-reminder>\n\n'
  );
}

/** One appended attachment line: `- <kind>: <abs path> (<display name>)`. */
/** What a Claude Code `result` message says the turn cost, for its `turn.end`. */
function resultUsage(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (r['type'] !== 'result') return undefined;
  const usage = r['usage'];
  const out: Record<string, unknown> = {};
  if (typeof usage === 'object' && usage !== null) Object.assign(out, usage);
  if (typeof r['total_cost_usd'] === 'number') out['totalCostUsd'] = r['total_cost_usd'];
  if (typeof r['duration_ms'] === 'number') out['durationMs'] = r['duration_ms'];
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The Claude Code `uuid` a raw SDK message or transcript entry carries. */
function rawUuid(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const uuid = (raw as Record<string, unknown>)['uuid'];
  return typeof uuid === 'string' ? uuid : undefined;
}

/** The text blocks of a transcript assistant entry, joined. */
function assistantText(entry: SessionStoreEntry): string {
  const message = (entry['message'] ?? {}) as Record<string, unknown>;
  const content = message['content'];
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return (content as Record<string, unknown>[])
    .filter((b) => b && b['type'] === 'text' && typeof b['text'] === 'string')
    .map((b) => String(b['text']))
    .join('\n')
    .trim();
}

/** A wire event the history log stores whole (spec/04 § History). */
function isLoggedEvent(ev: WireEvent): ev is LoggedEvent {
  return LOGGED_EVENT_TYPES.has(ev.type as LoggedEvent['type']);
}

/** The event as history keeps it: routing to one surface is not part of it. */
function stripSurfaceId(ev: LoggedEvent): LoggedEvent {
  if (!('forSurfaceId' in ev)) return ev;
  const { forSurfaceId: _drop, ...rest } = ev;
  void _drop;
  return rest as LoggedEvent;
}

function attachmentLine(kind: AttachmentKind, path: string, name: string): string {
  return `- ${kind}: ${path} (${name})`;
}

/**
 * Per-chat manifest of every attachment ever stored for the chat, keyed by ref
 * id, persisted at `<folder>/.patch/attachments/manifest.json`. Written by
 * `storeAttachment` BEFORE the turn is sent, so it always predates the turn's
 * JSONL. On replay the host reads it to reconstruct the full `AttachmentRef`
 * (crucially the `mimeType`, which the prompt block doesn't carry) for each id
 * parsed out of the persisted `[Attachments]` block. NO FALLBACK: a ref with no
 * manifest entry is reconstructed from the parsed line so replay still renders
 * it (a manifest read failure never silently drops the attachment).
 */
type AttachmentManifest = Record<string, AttachmentRef>;

function attachmentsDirFor(folder: string): string {
  return join(folder, '.patch', 'attachments');
}
function manifestPathFor(folder: string): string {
  return join(attachmentsDirFor(folder), 'manifest.json');
}

function readManifest(folder: string): AttachmentManifest {
  const path = manifestPathFor(folder);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (typeof parsed === 'object' && parsed !== null) return parsed as AttachmentManifest;
  } catch {
    // A corrupt manifest is not fatal to replay — treat as empty and let the
    // block parser reconstruct refs from the line itself.
    return {};
  }
  return {};
}

function writeManifestEntry(folder: string, ref: AttachmentRef): void {
  const dir = attachmentsDirFor(folder);
  mkdirSync(dir, { recursive: true });
  const manifest = readManifest(folder);
  manifest[ref.id] = ref;
  writeFileSync(manifestPathFor(folder), JSON.stringify(manifest), 'utf8');
}

/**
 * Extract the attachment ids + parsed shape out of a persisted user message's
 * appended `[Attachments]` block, and return the message text with the block
 * stripped. Returns `null` when there is no block (a plain text turn), so the
 * caller leaves the message untouched. The block is always appended as the
 * suffix `\n\n[Attachments]\n<lines>` (or the whole message when text-only), so
 * we anchor on the LAST header occurrence.
 */
function parseAttachmentBlock(content: string): {
  text: string;
  parsed: { id: string; name: string; kind: AttachmentKind }[];
} | null {
  const idx = content.lastIndexOf(`${ATTACHMENT_BLOCK_HEADER}\n`);
  if (idx < 0) return null;
  const body = content.slice(idx + ATTACHMENT_BLOCK_HEADER.length + 1);
  // The trailing `(<name>)` is the DISPLAY filename, which can itself contain
  // parentheses — duplicate-download / screenshot naming produces `photo
  // (1).jpg`, `Screenshot (2).png`, etc. An `[^)]*` name group rejects those,
  // making the whole line un-parseable → the block leaked into the bubble as
  // raw text and the image VANISHED on replay (patch/todo.md — "image being
  // passed along properly"). `(.*)` tolerates a `)` in the name; the attachment
  // id is taken from the sanitized path basename (never a space or paren — see
  // `attachmentFileName`), so a greedy split can't corrupt it, and the real
  // name+mime are read back authoritatively from the manifest by id below.
  const lineRe = /^- (image|file): (.+) \((.*)\)$/;
  const parsed: { id: string; name: string; kind: AttachmentKind }[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const m = lineRe.exec(line);
    if (!m) return null; // Not our block after all — leave the message intact.
    const kind = m[1] as AttachmentKind;
    /* v8 ignore next -- `m[2]` is the mandatory `(.+)` group; once the regex has matched, it is always a defined (>=1 char) string, so the `?? ''` fallback is unreachable defensive code. */
    const path = m[2] ?? '';
    /* v8 ignore next -- `m[3]` is the `(.*)` group; a successful match always defines it (possibly as ''), so the `?? ''` fallback is unreachable defensive code. */
    const name = m[3] ?? '';
    /* v8 ignore next -- `path` is non-empty (see above), so String.split() always returns >=1 element and .pop() is never undefined; the `?? ''` fallback is unreachable defensive code. */
    const fileName = (path.split(/[/\\]/).pop() ?? '').trim();
    /* v8 ignore next -- String.split() on any string (including '') always returns >=1 element, so `[0]` is never undefined; the `?? ''` fallback is unreachable defensive code. */
    const id = fileName.split('-')[0] ?? '';
    if (id.length === 0) return null;
    parsed.push({ id, name, kind });
  }
  if (parsed.length === 0) return null;
  // Strip the block (and the blank-line separator before it, if any).
  let text = content.slice(0, idx);
  text = text.replace(/\n+$/, '');
  return { text, parsed };
}

/**
 * Sentinel seq for control-path `chat.error` events emitted when no chat
 * context exists (F4). Negative so a surface's replay logic — which only ever
 * sees `seq >= 0` for real persisted stream events — won't mistake it for a
 * gap-fill or reuse it. See `allocErrorSeq`.
 *
 * Single source of truth lives in `@patch/wire` (the wire `ChatErrorEvent.seq`
 * schema admits this exact sentinel); re-exported here for daemon-local use.
 */
export { OUT_OF_BAND_SEQ } from '@patch/wire';
import { OUT_OF_BAND_SEQ, isGroupableToolCall } from '@patch/wire';
import { identityHash, readSeqIndexFile } from './seqIndex.js';
import { ChatLog, HistoryWriteError } from './chatLog.js';
import { readTrack, readTrackRecords } from './readTrack.js';
import { toClaudeSessionEntries, estimateTokens, type TrackEntry } from './nativeReconstruct.js';
import {
  buildMoveBundle,
  ChatMoveError,
  setAsideMovedChat,
  writeMoveBundle,
  type ChatMovePaths,
} from './chatMove.js';
import { createClaudeSessionStore } from './claudeSessionStore.js';
import { hasConversation } from './syntheticTurns.js';

/**
 * Hard cap on events returned by a single `patch_history` page. A caller
 * requesting more is CLAMPED to this (never rejected) — mirrors the job-runs
 * 200 cap. Enforced here as the single source of truth.
 */
export const HISTORY_PAGE_HARD_CAP = 200;

/**
 * setTimeout's signed-32-bit ms ceiling (~24.8 days). A snooze longer than this
 * (a custom "in two months") re-arms in chunks rather than firing immediately,
 * which is what a raw overflowing delay would do.
 */
const MAX_SNOOZE_TIMEOUT_MS = 2_147_483_000;

/** The agent's built-in question tool (spec/02 § Questions are not approvals). */
const ASK_USER_QUESTION = 'AskUserQuestion';

/**
 * Tools whose completed `tool_result` means a file changed on disk — the
 * trigger for invalidating the file-listing caches (git-dirty.ts,
 * files-recursive.ts). `computeEditInfo` below recognizes the same three for
 * the permission-card diff.
 */
const FILE_EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);

/**
 * What the agent is told when a question expires. NOT a refusal.
 *
 * A FUNCTION of the window, not a constant, because the window is a per-host
 * setting (spec/02 § Questions are not approvals) — a fixed "after 30 minutes"
 * in the text would be a lie the moment the setting moved off its default, and
 * it is a lie told to the AGENT, which is the one reader with no other way to
 * find out what actually happened.
 */
export function questionExpiredMessage(seconds: number): string {
  return `No answer: the question timed out after ${seconds} seconds without a reply. The user did not refuse — nobody saw it. Do not assume any of the options; ask again or proceed only where you can without the answer.`;
}

/**
 * How long an unanswered TOOL APPROVAL holds the turn open before it expires
 * (`armAnswerExpiry`).
 *
 * This used to be "forever", on the reasoning that an approval left waiting is
 * a turn paused on purpose. That holds for a chat someone is sitting in front
 * of and fails for every job fire: `bypassPermissions` does NOT stop the SDK
 * escalating its own safety checks through `canUseTool` (sdkBackend.ts
 * § onPermissionRequest), so an unattended worker can be handed an approval
 * card nobody will ever see. One was — an `app-update` worker built its
 * feature, committed it, then parked on an `rm -rf` cleanup and never pushed,
 * and nothing downstream noticed, because a wedged chat frees its queue slot
 * and looks idle rather than failed.
 *
 * Longer than a question's window: someone who IS there is likelier to want to
 * approve a tool call than to answer a question, so the benefit of the doubt is
 * worth more minutes. Short enough that a wedged job heals inside the 4-hourly
 * catchup pass that would otherwise have to notice it.
 */
export const APPROVAL_ANSWER_TIMEOUT_MS = 60 * 60 * 1000;

/** What the agent is told when a tool approval expires. NOT a refusal. */
export const APPROVAL_EXPIRED_MESSAGE =
  'Not approved: the approval request timed out after 60 minutes without an answer. The user did not refuse — nobody saw it, and this chat may be unattended. Do not retry the same call blind. Carry on without it where the work does not depend on it, and say plainly in your report that it was skipped.';

/**
 * What the agent is told when a question is superseded by the user typing a
 * message instead of answering it (spec/02 § Questions are not approvals).
 * NOT a refusal, and not a timeout: the answer IS there, in the turn that runs
 * next, so the agent is pointed at it rather than left to guess.
 */
export const QUESTION_SUPERSEDED_MESSAGE =
  'No answer through this tool: the user replied with a message instead of picking an option. That message is the next user turn in this conversation — read it and take it as the answer. Do not assume any of the options you offered, and do not ask the same question again.';

/**
 * What the agent is told when the user stops the turn while a permission
 * request is still on screen (spec/04 § Message queueing). NOT a refusal of the
 * specific call: the whole turn is being ended, and the tool just happened to
 * be what it was paused on.
 */
export const PERMISSION_STOPPED_MESSAGE =
  'Not approved: the user stopped this turn while the request was still outstanding. They did not refuse the call itself — the turn is over. Stop work here; do not retry it or start anything else.';

/**
 * What the agent is told when the user presses Cancel on an `AskUserQuestion`
 * card directly, rather than superseding it with a message (`QUESTION_SUPERSEDED_MESSAGE`),
 * letting it expire (`questionExpiredMessage`), or stopping the whole turn
 * (`PERMISSION_STOPPED_MESSAGE`). Left unset, this deny falls through to
 * `sdkBackend.ts`'s generic `'Permission denied by user'`, which reads to the
 * agent as the user refusing the plan behind the question — so it stops
 * entirely, on a card that only meant "I'm not answering that". Dismissing a
 * question is not the same act as stopping a turn: the turn is still live, and
 * the agent should keep going on whatever it can decide for itself. It should
 * only come back and ask again — or stop — for the cases a question exists
 * for in the first place: an ambiguity it genuinely cannot resolve alone, or a
 * next step that is destructive, irreversible, costs money, or otherwise
 * reaches outside the chat into the real world.
 */
export const QUESTION_CANCELLED_MESSAGE =
  'No answer: the user cancelled this question without picking an option. This is not a refusal of your plan — they are declining to answer, not telling you to stop. Continue the turn and use your own judgement on anything you can decide yourself. Only stop and come back to them if what is next is genuinely something only they can resolve: an ambiguity you cannot settle any other way, or a step that is destructive, irreversible, spends money, or otherwise affects the real world.';

/**
 * What a `chat.input` frame asks the runner to do. One place, so a message that
 * arrives as a frame and one the server hands over at a tool boundary become
 * the same turn.
 */
export function chatInputToSendOptions(event: ChatInputEvent): SendInputOptions {
  const voicePrefix = voicePrefixForSource(event.source);
  return {
    chatId: event.chatId,
    message: event.message,
    localId: event.localId,
    ...(voicePrefix !== undefined ? { voicePrefix } : {}),
    // spec/14 & spec/15 § Composer — attachments ride the chat.input; the host
    // resolves each ref to its stored path and folds it into the turn.
    ...(event.attachments !== undefined ? { attachments: event.attachments } : {}),
    // patch/todo.md — per-chat Tools panel OFF set rides the chat.input so a
    // disabled tool is removed from the model's context for the turn.
    ...(event.disabledTools !== undefined ? { disabledTools: event.disabledTools } : {}),
    // spec/04 § Hidden — a person's message takes a chat out of Hidden; a job's
    // fire into it does not. spec/14 § Job trigger turn — the SAME signal also
    // flags the turn itself as transcript furniture rather than a user bubble.
    ...(event.source?.kind === 'job' ? { jobTrigger: true } : { fromUser: true }),
    // spec/04 § Branching — address a specific branch; absent means the active one.
    ...(event.branchId !== undefined ? { branchId: event.branchId } : {}),
  };
}

export interface SendInputOptions {
  chatId: string;
  message: string;
  /** Idempotency key (chatId, localId). */
  localId: string;
  voicePrefix?: string;
  /**
   * Composer attachments (spec/14 & spec/15 § Composer). Refs only — the bytes
   * were already stored under the chat's dir by `storeAttachment` (the server
   * round-trips the upload over `patch.attachment.store_*` before the surface
   * sends this turn). The host resolves each ref to its on-disk path and folds
   * the paths into the prompt so Claude reads the files. NO FALLBACK: a ref with
   * no file on disk fails the turn loudly.
   */
  attachments?: AttachmentRef[];
  /**
   * Tools the user switched OFF for this chat in the surface's Tools panel
   * (patch/todo.md — "turn them on and off"). Carried on every turn; the host
   * mirrors it onto chat state so it applies to this turn and any queued behind
   * it. Absent ⇒ the OFF set is cleared (all tools back on).
   */
  disabledTools?: string[];
  /**
   * Run this turn as the first turn of a FORKED session (spec/04 § Branching).
   * Set only by `forkChat`; carried through the queue so a fork that lands
   * behind a running turn still forks when IT runs, never earlier and never on
   * some other turn.
   */
  fork?: ForkRun;
  /**
   * Who started this turn (spec/09 § Whose turn it was). Omitted means `user` —
   * which is what every surface composer and voice turn is, so
   * only the host's own self-started turns (a self-wake firing, the todo list
   * advancing) and an agent's `patch_send_to` have to say anything.
   *
   * It decides whether the turn SETTLING raises a chat-completion notification,
   * and nothing else: a `machine` turn runs exactly like a `user` one.
   */
  origin?: TurnOrigin;
  /**
   * A person sent this — a surface composer, a voice turn, a fork or side
   * message — rather than a job fire, an agent, or the host itself (spec/04
   * § Hidden). Only a person's message takes a chat out of Hidden. Separate
   * from `origin`, which is about the completion doorbell: a job's fire is a
   * `user` turn there (spec/09 § Whose turn it was) but not a person here.
   */
  fromUser?: boolean;
  /**
   * This turn is a job's own fire into the chat (spec/08 § Action — a
   * `continue`/`message` action's fire into an EXISTING chat), not something
   * the user typed. Set only by the server's job dispatcher via
   * `chat.input.source.kind === 'job'` (index.ts). Rides onto the persisted
   * user `chat.message` as `jobTrigger` so a surface renders it as transcript
   * furniture (spec/14 § Job trigger turn) instead of a user bubble, whichever
   * turn of the chat it lands on — unlike `fromUser`, which only ever decides
   * Hidden membership.
   */
  jobTrigger?: boolean;
  /**
   * This turn is a `block` resubmit the host fired because an
   * `agent_response` hook asked the agent to redo its answer
   * (`handleHookAgentResponseOutcome`, spec/20-hooks.md § On the agent's
   * response). Rides onto the persisted `chat.message` as `hookTrigger` so a
   * surface renders it as the same quiet transcript furniture as a job
   * trigger turn. Never set by a surface — only the host's own
   * `handleHookAgentResponseOutcome`.
   */
  hookTrigger?: HookTriggerInfo;
  /**
   * This turn is a `not_met` resubmit the host fired because the chat's goal
   * evaluator judged the condition not yet satisfied (spec/04 § Goals —
   * `maybeEvaluateGoal`). Rides onto the persisted `chat.message` as
   * `goalTrigger` so a surface renders it as the same quiet transcript
   * furniture as a hook's `block` resubmit. Never set by a surface — only the
   * host's own `maybeEvaluateGoal`.
   */
  goalTrigger?: GoalTriggerInfo;
  /**
   * This is a Manager-sweep check-in nudge (spec/06 § Sweep). If it has to
   * queue behind a running turn it replaces any nudge already queued, and it is
   * not queued at all when the chat already has a queued message — nudges must
   * never stack up behind each other. Queued nudges are flushed when the chat's
   * goal is met or cleared (`flushQueuedNudges`).
   */
  nudge?: boolean;
  /**
   * This turn has ALREADY been drawn as a user bubble once and is being re-sent
   * by the host on the user's behalf — a restart resume, or a rung of the
   * SDK-error ladder (spec/12 § A turn is owed until it settles). The value is
   * the seq of the ORIGINAL user message, which rides out on this attempt's
   * `chat.message` as `retryOfSeq` so the surfaces fold it into the bubble
   * already on screen instead of drawing the same message again.
   *
   * Set ONLY by the host's own re-send paths. A surface never sends it: a
   * user retyping the same thing is a new turn, not an attempt at an old one.
   */
  retryOfSeq?: number;
  /**
   * The host is re-sending a turn it accepted under this SAME `localId`
   * before a restart (`resumeInterruptedTurns`). The chat's accepted localIds
   * outlive the process (they are in its history log), so without this the
   * duplicate guard would take the re-send for a surface redelivery and drop
   * it. Never set by a surface.
   */
  redeliver?: boolean;
  /**
   * Address this input at a specific branch (spec/04 § Branching). Absent
   * means the chat's active branch — today's behaviour, unchanged. Naming a
   * non-active branch routes to `sendToBranch`'s own independent pump.
   */
  branchId?: string;
}

/** {@link SendInputOptions.hookTrigger} — mirrors the wire's `ChatMessageEvent.hookTrigger`. */
export interface HookTriggerInfo {
  hooks: Array<{ hookId: string; hookName: string }>;
}

/** {@link SendInputOptions.goalTrigger} — mirrors the wire's `ChatMessageEvent.goalTrigger`. */
export interface GoalTriggerInfo {
  reason: string;
}

/** The fork point a forked turn resumes its parent session at (spec/04 § Branching). */
export interface ForkRun {
  resumeAtUuid: string | null;
}

/** Metadata for a stored attachment (spec § Composer). */
export interface StoredAttachment {
  path: string;
}

/**
 * One persisted track of a chat's branch graph (spec/04 § Branching). Same
 * shape as the wire `ChatBranch` plus the daemon-internal `sessionId` — the
 * Claude session backing that track, which never leaves the host.
 */
type PersistedBranch = NonNullable<ChatMeta['branches']>[number];

/**
 * A turn the chat still owes the agent, as persisted to meta.json's
 * `pendingTurns`. `localId` is optional here (unlike {@link QueuedTurn}) because
 * a daemon-originated turn — a spawn's opening prompt, a self-wake — has none.
 */
type PendingTurn = NonNullable<ChatMeta['pendingTurns']>[number];

/** A user turn parked in a chat's queue (spec/04 ## Message queueing). */
interface QueuedTurn {
  message: string;
  /** The originating `chat.input.localId` — keys chat.queued/dequeued/unqueue. */
  localId: string;
  /** Its `chat.queued` position, re-announced unchanged when the text is edited. */
  queueSeq: number;
  /** Set when this queued turn is a fork's first turn (spec/04 § Branching). */
  fork?: ForkRun;
  /**
   * Who started this turn (spec/09 § Whose turn it was). Carried through the
   * queue so a turn that lands behind a running one is still attributed to
   * whoever started IT — a user turn queued behind a wake tick is still the
   * user's, and vice versa.
   */
  origin?: TurnOrigin;
  /** {@link SendInputOptions.retryOfSeq} — carried through the queue with the turn. */
  retryOfSeq?: number;
  /** {@link SendInputOptions.jobTrigger} — carried through the queue with the turn. */
  jobTrigger?: boolean;
  /** {@link SendInputOptions.hookTrigger} — carried through the queue with the turn. */
  hookTrigger?: HookTriggerInfo;
  /** {@link SendInputOptions.goalTrigger} — carried through the queue with the turn. */
  goalTrigger?: GoalTriggerInfo;
  /** {@link SendInputOptions.nudge} — marks a sweep nudge so it can be replaced or flushed. */
  nudge?: boolean;
  /**
   * The text as the user typed it — what `chat.queued` announces, and the part
   * an edit replaces (spec/04 ## Message queueing § Edit).
   */
  text: string;
  /**
   * Rebuild the prompt around replacement typed text, keeping everything the
   * host folded around the original when it accepted the turn. Absent when
   * the typed text cannot be separated from the prompt, which makes the turn
   * uneditable.
   */
  compose?: (text: string) => string;
}

/**
 * A spawn named no model on a machine that has never read a model catalogue
 * successfully (spec/04 § Spawn). NO FALLBACK: running it on a hard-coded model
 * id would silently pick a model nobody chose.
 */
export class NoModelCatalogueError extends Error {
  readonly code = 'no_model_catalogue' as const;
  /**
   * `reason` is supplied when the catalogue could not be READ just now (a model
   * change has to check the id against it — spec/04 § Model), as against the
   * spawn case, where the machine has simply never read one. Both leave the
   * caller with no list to pick from, so they share a code, but the provider's
   * own complaint is worth carrying when there is one.
   */
  constructor(daemonId: string, reason?: string) {
    super(
      reason === undefined
        ? `machine ${daemonId} has never read a model catalogue, so it has no last-used model; ` +
            `name a model on the spawn or connect the backend credential on that machine`
        : `machine ${daemonId} could not read its model catalogue, so the model could not be ` +
            `checked: ${reason}`,
    );
    this.name = 'NoModelCatalogueError';
  }
}

/**
 * A model change named a model this host's catalogue does not offer (spec/04 §
 * Model). NO FALLBACK: the chat stays on the model it was already running,
 * rather than being rounded to a near match or dropped onto the host's
 * last-used model, either of which would run the next turn on a model the user
 * did not pick while the surface showed the one they did.
 */
export class UnknownModelError extends Error {
  readonly code = 'unknown_model' as const;
  constructor(daemonId: string, model: string) {
    super(`machine ${daemonId} offers no model with id: ${model}`);
    this.name = 'UnknownModelError';
  }
}

/**
 * Why a file-browser create / rename / delete was refused (spec/03 § Files —
 * `patch.file_op.response`). Every one of these reaches the user as itself;
 * none of them is recoverable by guessing at what was meant.
 */
export type FileOpCode =
  | 'chat_not_found'
  | 'path_escape'
  | 'not_found'
  | 'exists'
  | 'not_empty'
  | 'missing_target'
  | 'internal';

export type FileOpOutcome =
  | { ok: true; path: string }
  | { ok: false; code: FileOpCode; message: string };

class FileOpRejection extends Error {
  constructor(
    readonly code: FileOpCode,
    message: string,
  ) {
    super(message);
    this.name = 'FileOpRejection';
  }
}

function asFileOpRejection(err: unknown): { code: FileOpCode; message: string } {
  if (err instanceof FileOpRejection) return { code: err.code, message: err.message };
  // Anything else came off node:fs. Map the codes that are really the user's
  // answer, and sanitise the rest — an errno string carries the absolute host
  // path, which is not the surface's to know.
  const errno = (err as NodeJS.ErrnoException).code;
  if (errno === 'ENOENT') return { code: 'not_found', message: 'no such file or directory' };
  if (errno === 'EEXIST') return { code: 'exists', message: 'already exists' };
  if (errno === 'ENOTEMPTY') return { code: 'not_empty', message: 'directory is not empty' };
  return { code: 'internal', message: 'operation failed on disk' };
}

/**
 * Resolve a chat-folder-relative path to an absolute one inside `root`, or
 * refuse. The same guard `writeFile` applies, plus the one it does not need:
 * a path whose nearest EXISTING ancestor is a symlink out of the folder is an
 * escape that lexical resolution alone cannot see, and delete/rename act on
 * what is already there rather than creating it.
 *
 * `root` itself is never a legal target — deleting or renaming the chat's own
 * folder from its file browser is not an operation this offers.
 */
function resolveInChatFolder(root: string, rel: string): string {
  if (rel.startsWith('/')) {
    throw new FileOpRejection('path_escape', 'path must be relative to the chat folder');
  }
  const target = pathResolve(join(root, rel));
  if (target === root || !target.startsWith(root + sep)) {
    throw new FileOpRejection('path_escape', 'path escapes chat folder');
  }
  let probe = dirname(target);
  while (probe !== root && probe.startsWith(root + sep) && !existsSync(probe)) {
    probe = dirname(probe);
  }
  if (!existsSync(probe)) {
    throw new FileOpRejection('not_found', `no such directory: ${dirname(rel)}`);
  }
  const realProbe = realpathSync(probe);
  if (realProbe !== root && !realProbe.startsWith(root + sep)) {
    throw new FileOpRejection('path_escape', 'path escapes chat folder');
  }
  return target;
}

/**
 * spec/14 § Document editor — the doc view/action RPCs' own error shape.
 * `path_escape`/`not_found` are raised by `resolveInChatFolder` itself (a
 * `FileOpRejection`, translated below); `conflict` is `DocConflictError`
 * (`docSidecar.ts`) — a suggestion whose `find` no longer uniquely matches.
 */
type DocErrorCode =
  | 'chat_not_found'
  | 'path_escape'
  | 'not_found'
  | 'conflict'
  | 'internal'
  // Word import/export (spec/14 § Document editor, step 3 of 3):
  | 'invalid'
  | 'browser_missing';
class DocActionRejection extends Error {
  constructor(
    readonly code: DocErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DocActionRejection';
  }
}
function asDocActionRejection(err: unknown): { code: DocErrorCode; message: string } {
  if (err instanceof DocActionRejection) return { code: err.code, message: err.message };
  if (err instanceof FileOpRejection) {
    const code = err.code === 'path_escape' || err.code === 'not_found' ? err.code : 'internal';
    return { code, message: err.message };
  }
  if (err instanceof DocConflictError) return { code: 'conflict', message: err.message };
  return { code: 'internal', message: err instanceof Error ? err.message : String(err) };
}

/** The directory a new path will land in must already exist — see `not_found`. */
function requireExistingParent(target: string, rel: string): void {
  const parent = dirname(target);
  if (!existsSync(parent) || !statSync(parent).isDirectory()) {
    throw new FileOpRejection(
      'not_found',
      `no such directory: ${dirname(rel) === '.' ? '/' : dirname(rel)}`,
    );
  }
}

/**
 * The four operations. Nothing here overwrites and nothing recurses: `create`
 * and `rename` refuse an occupied destination, and `delete` refuses a
 * directory with anything in it.
 */
function runFileOp(args: {
  op: 'create' | 'create_dir' | 'delete' | 'rename';
  root: string;
  target: string;
  rel: string;
  to?: string | undefined;
}): string {
  const { op, root, target, rel } = args;
  if (op === 'create') {
    requireExistingParent(target, rel);
    // `wx` is the race-free form of "only if it is not already there" — an
    // existsSync check leaves a window in which the file appears between the
    // look and the write, and the write would then blank it.
    writeFileSync(target, '', { encoding: 'utf8', mode: 0o644, flag: 'wx' });
    return rel;
  }
  if (op === 'create_dir') {
    requireExistingParent(target, rel);
    // Deliberately not recursive: a mistyped intermediate directory would
    // otherwise be created silently and the real one never made.
    mkdirSync(target);
    return rel;
  }
  if (op === 'delete') {
    const stat = lstatSync(target);
    if (stat.isDirectory()) {
      if (readdirSync(target).length > 0) {
        throw new FileOpRejection(
          'not_empty',
          `directory is not empty: ${rel} — delete its contents first`,
        );
      }
      rmdirSync(target);
      return rel;
    }
    unlinkSync(target);
    return rel;
  }
  const to = args.to;
  if (to === undefined) {
    throw new FileOpRejection('missing_target', 'rename needs a destination');
  }
  const dest = resolveInChatFolder(root, to);
  if (dest === target) return rel;
  const stat = lstatSync(target);
  requireExistingParent(dest, to);
  if (existsSync(dest)) {
    throw new FileOpRejection('exists', `already exists: ${to}`);
  }
  if (stat.isDirectory()) {
    renameSync(target, dest);
    return to;
  }
  // For a file, link+unlink rather than rename: POSIX `rename()` replaces an
  // existing destination file silently, so the existsSync above would be the
  // only thing standing between a rename and someone else's file. `link()`
  // fails with EEXIST instead, which closes that window.
  linkSync(target, dest);
  unlinkSync(target);
  return to;
}

/**
 * spec/20-hooks.md § On the agent's response — loop guard. After this many
 * CONSECUTIVE `block` resubmits on one chat with no genuine turn in between,
 * the host stops resubmitting and surfaces the chat instead, so a hook
 * cannot loop forever. Declared in code, not configurable — the point is a
 * hard ceiling a hook cannot talk its way past.
 */
const HOOK_BLOCK_LOOP_LIMIT = 3;

/**
 * Visible prefix on a `block`-resubmit turn (spec/20-hooks.md § On the
 * agent's response — "the row is visible and is what the agent receives, no
 * invisible injection"). Same idea as `TODO_PREFIX`'s `[todo]` marker: the
 * marker and the hook's own analysis/suggestion ARE the message, verbatim,
 * not a hidden wrapper around different visible text.
 */
const HOOK_BLOCK_PREFIX = '[hook: blocked]';

/**
 * One or more deferred `agent_response` hook notes — `advise` outcomes,
 * failed/timed-out hooks, or both — formatted as a `<system-reminder>` block
 * prepended to whichever turn carries them (spec/20-hooks.md § On the
 * agent's response — "passed to the agent with its next turn"). This rides
 * the SAME capture-and-disclose pipeline as every other leading reminder
 * (`extractSystemContext`, `history.ts`'s `labelSystemReminder` — matched
 * there on "agent_response hook"): stripped from the persisted/displayed
 * turn, carried out-of-band as a `systemContext` disclosure under it, so the
 * row is still exactly what the agent received (no invisible injection). A
 * failed hook is never resubmitted (there is nothing to redo), but still
 * draws this same visible disclosure rather than failing silently.
 */
function buildHookAdviceBlock(notes: HookAdviceNote[]): string {
  const lines = notes.map((n) => {
    if (n.failed) return `"${n.hookName}" failed to run: ${n.analysis}`;
    const suggestion = n.suggestion !== undefined ? `\nSuggestion: ${n.suggestion}` : '';
    return `"${n.hookName}": ${n.analysis}${suggestion}`;
  });
  const intro = notes.some((n) => n.failed)
    ? 'One or more agent_response hooks could not be run on your last reply (never resubmitted — nothing to redo):'
    : 'One or more agent_response hooks advised on your last reply (they did not block it):';
  return `<system-reminder>\n${intro}\n\n${lines.join('\n\n')}\n</system-reminder>\n\n`;
}

/** The message a `block` resubmit sends — the hook's own analysis, verbatim. */
function buildHookBlockMessage(
  results: Array<{ hookName: string; analysis?: string; suggestion?: string }>,
): string {
  const lines = results.map((r) => {
    const suggestion = r.suggestion !== undefined ? `\nSuggestion: ${r.suggestion}` : '';
    return `"${r.hookName}": ${r.analysis ?? '(no analysis given)'}${suggestion}`;
  });
  return `${HOOK_BLOCK_PREFIX}\n${lines.join('\n\n')}`;
}

/**
 * spec/04 § Goals — how long to wait before re-checking whether a chat's
 * `patch_watch` tasks have finished, once evaluation has deferred to them.
 */
const GOAL_WATCH_POLL_MS = 15_000;

/** Visible prefix on a goal's `not_met` resubmit (mirrors `HOOK_BLOCK_PREFIX`). */
const GOAL_NOT_MET_PREFIX = '[goal: not met]';

/** The message a goal's `not_met` resubmit sends — the evaluator's own reason, verbatim. */
function buildGoalNotMetMessage(condition: string, reason: string): string {
  return `${GOAL_NOT_MET_PREFIX}\nGoal: ${condition}\n\n${reason}`;
}

/** Visible marker row for a goal that has just resolved (spec/04 § Goals). */
function buildGoalOutcomeMessage(outcome: 'met' | 'impossible', reason: string): string {
  return `[goal: ${outcome}]\n${reason}`;
}

const SETTLED_ECHO_CAP = 200;

export class Daemon {
  readonly chatState: ChatStateMap;
  private readonly opts: Required<
    Pick<DaemonOptions, 'now' | 'generateChatId' | 'discoverClaudeMcpServers'>
  > &
    Omit<DaemonOptions, 'now' | 'generateChatId' | 'discoverClaudeMcpServers'>;

  /** Active AbortControllers for in-flight queries, keyed by chatId. */
  private readonly aborters = new Map<string, AbortController>();
  /**
   * spec/04 ## Message queueing — per-chat FIFO of turns waiting behind the
   * in-flight turn (parity with Claude Code's type-ahead). Drained serially by
   * the pump in arrival order once the current turn finishes.
   */
  private readonly turnQueues = new Map<string, QueuedTurn[]>();
  /**
   * Chats with an active serial pump — a turn is running OR its queue is
   * draining. This is the SINGLE guard that gates "enqueue behind the running
   * turn" vs "run now": set synchronously before the pump's first `await`, so
   * concurrent `sendInput` calls can't both start a turn (no race).
   */
  private readonly pumping = new Set<string>();
  /**
   * Chats whose current drain has run at least one `user` turn. The chat reports
   * one continuous `running` period across a drain (spec/04 § Message queueing),
   * so the frame that settles it is the whole drain ending, not the last turn
   * ending — and spec/09 § Whose turn it was makes that frame's `turnOrigin` the
   * thing that decides whether the user is told. A user message anywhere in the
   * drain means the user IS waiting, even when a self-wake or a `send_to`
   * happened to queue in behind it and run last. Cleared with the pump.
   */
  private readonly drainHadUserTurn = new Set<string>();
  /** Per thread: what a Manager standing in for another host is to be told with its next message. */
  private readonly threadHandoffs = new Map<string, string>();
  /** Callers waiting for an input to be accepted (`submitInput`), by chat and localId. */
  private readonly inputAcceptWaiters = new Map<string, () => void>();
  /**
   * spec/04 § Goals — deadlock guard. A goal keeps going until the evaluator judges
   * it met or impossible; the one thing that stops it earlier is the agent
   * declining this many times IN A ROW. Settings → Goals.
   */
  private goalRefusalLimit = DEFAULT_GOAL_REFUSAL_LIMIT;
  /**
   * The turn currently being run by the pump, keyed by chatId — the head of
   * "what this chat still owes the agent", with `turnQueues` as the tail. Held
   * separately from `turnQueues` because a running turn has already been shifted
   * off the queue, and `persistPendingTurns` needs both halves to write a
   * complete picture to meta.json.
   */
  private readonly runningTurn = new Map<string, PendingTurn>();
  /** Per-chat monotonic queue position, for stable `chat.queued` ordering. */
  private readonly queueSeqCounter = new Map<string, number>();
  /**
   * Group 20: in-flight permission requests keyed by `${chatId}:${requestId}`.
   * Tracks the absolute file path the agent wants to edit and the user's
   * approved-with-edits payload (when present). dirtyFilePaths() reads
   * this for the file browser's ● dirty marker; permission_response
   * resolves it.
   */
  private readonly pendingPermissions = new Map<
    string,
    {
      chatId: string;
      requestId: string;
      tool: string;
      absPath: string;
      originalArgs: Record<string, unknown>;
      /** Set once the surface emits `chat.permission_response`. */
      response?: {
        decision: 'approve' | 'deny' | 'approve_with_edits';
        editedNewString?: string;
      };
    }
  >();
  /**
   * G2-d1: the full, still-unresolved `chat.permission_request` wire event per
   * chat (keyed by `${chatId}:${requestId}`). A permission is recorded in the
   * SDK transcript as a plain assistant `tool_use` block (Claude Code's shape),
   * so on a `chat.replay`/reload the history reader reconstructs it as a
   * `chat.tool_call` — losing the approve/deny affordance and stranding the
   * user in `awaiting-permission` with no way to resolve it. We re-emit any
   * pending permission_request at the end of `replayChat` so a surface that
   * reconnects AFTER the turn produced the prompt still renders the permission
   * card. Covers EVERY permission tool (not just file edits, unlike
   * `pendingPermissions` which is edit-specific). Cleared on resolution.
   */
  private readonly pendingPermissionEvents = new Map<string, ChatPermissionRequestEvent>();
  /**
   * The echo each recently settled request went out with, by requestId, so a
   * surface redelivering an answer that already landed is told the same
   * outcome again. Bounded; oldest out.
   */
  private readonly settledPermissionEchoes = new Map<string, WireEvent>();
  /**
   * Resolves the SDK's `canUseTool` callback (sdkBackend.ts) once the matching
   * `chat.permission_response` arrives, keyed identically to
   * `pendingPermissionEvents` (`${chatId}:${requestId}`). `onPermissionRequest`
   * is wired for every turn regardless of effective permission mode, so a gate
   * can be created here for ANY mode — including `auto` and
   * `bypassPermissions`, which the SDK normally resolves itself without
   * reaching here but can still escalate through this same path for a rare
   * safety-check case (spec/02 § Permission mode).
   */
  private readonly permissionGates = new Map<
    string,
    {
      resolve: (result: {
        approve: boolean;
        updatedInput?: Record<string, unknown>;
        denyMessage?: string;
      }) => void;
      /** Cleared when the surface answers, so an answered question never expires. */
      expiry?: NodeJS.Timeout;
    }
  >();
  /**
   * Which chat each surface last said it has open (`chat.focus_change`,
   * forwarded from the server with `forSurfaceId` stamped on). `null` is a
   * real value — "nothing open" — same as the wire event itself. Used only to
   * tell a focus TRANSITION from a repeat, so a pending question's expiry can
   * be given a fresh window on the edge that touches it (`resetQuestionExpiry`)
   * without resetting on every navigation elsewhere in the app.
   */
  private readonly surfaceFocusChat = new Map<string, string | null>();
  /** Seen (chatId, localId) tuples for dedup. */
  private readonly seenLocalIds = new Map<string, Set<string>>();
  /** Seen spawn-request localIds → returned chatId, for spawn idempotency. */
  private readonly seenSpawnLocalIds = new Map<string, string>();
  /** Per-chat run promise — used so stopChat can await teardown deterministically in tests. */
  private readonly runs = new Map<string, Promise<unknown>>();
  /** Chats whose `chat.stopped` is owed but not yet emitted (`announceStopped`). */
  private readonly stopAnnouncePending = new Set<string>();
  /**
   * Per-chat in-flight streaming-text accumulator. When the SDK streams
   * `assistant_delta` chunks (real backend, `includePartialMessages`), the
   * FIRST delta of a turn reserves the seq the finalising `chat.message` will
   * carry (via `bumpSeq`) and records the accumulated text here. Each delta
   * fans out a live `chat.message_delta {messageSeq, delta}`; the matching
   * final `assistant` envelope emits the durable `chat.message` at the SAME
   * reserved seq, then clears this entry. If a turn produces NO deltas (e.g. a
   * backend without partial streaming) this stays unset and the final
   * `assistant` envelope allocates its seq the normal way.
   */
  private readonly pendingDelta = new Map<string, { seq: number; text: string }>();
  /**
   * The mode to restore once a mid-conversation Plan Mode exits (spec/02 §
   * Permission mode — the agent's own `EnterPlanMode`/`ExitPlanMode` tools,
   * DISTINCT from the plan-mode-substitution exception `recordAutomaticPermissionModeChange`
   * already handles for a chat whose CONFIGURED mode the SDK silently
   * downgraded at query start). This is the agent choosing, mid-turn, to slow
   * down and plan — the chat's own configured mode (`bypassPermissions`, say)
   * is what should be showing again once it's done, not whatever Plan Mode
   * happened to leave behind. In-memory only: a host restart mid-plan-mode
   * leaves the chat reading `plan` until the agent calls `ExitPlanMode` again
   * or the user changes it by hand — an acceptable edge case for a state that
   * is inherently transient within one turn's tool-call sequence.
   */
  private readonly planModeRestore = new Map<string, SdkPermissionMode>();
  /**
   * spec/14 § File browser — live updates: a file-editing tool call
   * (Edit/Write/NotebookEdit) recorded at `tool_use` time, so the MATCHING
   * `tool_result` — which carries only a callId + the tool's return value,
   * never its args — can still say WHICH path just changed when it lands
   * without error. Keyed on `${chatId}:${callId}` (callIds are only unique
   * within a turn); each entry is consumed (deleted) the moment its result
   * arrives, successful or not, so this never grows past one turn's
   * in-flight edit tool calls.
   */
  private readonly pendingEditToolCalls = new Map<string, string>();
  /**
   * Chats restored from disk via `hydrate()` (or lazy-hydrated in
   * `resumeChat`) — i.e. pre-existing chats from before a host restart. For
   * these, the next query is a RESUME and MUST carry a `claudeSessionId`; a
   * missing/empty one means the resume is broken and the chat is marked
   * `errored` rather than silently starting a fresh contextless session
   * (spec/04 line 46 — NO FALLBACK, F1).
   *
   * Chats created live this process (via `spawnChat`, or a special-thread
   * bootstrap) are NOT in this set, so their legitimate FIRST query correctly
   * runs with `resumeSessionId: undefined` (spec/04 behaviour 3). Once such a
   * chat captures a session id, later turns resume normally; if it is later
   * hydrated after a restart it joins this set.
   */
  private readonly hydratedFromDisk = new Set<string>();
  /**
   * Chats being moved to another host (spec/04 § Moving a chat to another
   * host): exported, and not yet retired or released. A new turn is refused
   * while a chat is here, so nothing lands in a copy that is about to stop
   * being the chat.
   */
  private readonly movingOut = new Set<string>();
  /**
   * Chats already told that their permission mode was degraded to fit their
   * model, keyed by (chat, model, from, to) so a later model change announces
   * again rather than staying quiet about a new degrade.
   */
  private readonly announcedModeDegrades = new Set<string>();
  /**
   * Chats a title generation has already been kicked off for. Guards the
   * once-per-chat guarantee (spec/04 § Name): after the first successful turn
   * fires the summariser, later turns never regenerate — even if that first
   * attempt returned null / is still in flight.
   */
  private readonly titleGenerated = new Set<string>();
  /**
   * Per-chat count of user messages seen since the last title generation.
   * Reset each time a title is (re-)generated; used to implement
   * `chatNameInterval` periodic re-titling.
   */
  private readonly userMessagesSinceTitle = new Map<string, number>();
  private readonly historyReader: HistoryReader;
  private readonly claudeProjectsRoot: string;
  /** The chats' own history log and seq authority (spec/04 § History). */
  readonly chatLog: ChatLog;
  /** Active branch per chat, as records are stamped with it. Dropped when the track changes. */
  private readonly branchIds = new Map<string, string>();
  /** The branch each running turn started on. */
  private readonly turnBranches = new Map<string, string>();
  /** The native id of the harness message being handled, while `handleEnvelope` runs. */
  private readonly envelopeRefs = new Map<string, NativeRef>();
  /** A running turn whose history append failed — it ends `history_write_failed`. */
  private readonly historyFailures = new Map<string, HistoryWriteError>();
  /** Usage the harness reported for the running turn, for its `turn.end`. */
  private readonly turnUsage = new Map<string, Record<string, unknown>>();
  /** The fork each running turn opened, so its new session is recorded as one. */
  private readonly runningForks = new Map<string, ForkRun>();
  /** The running turn is a provider switch (spec/04 § History — seamless
   * reconstruction), so its `session` record is `reason:'switch'`, not
   * `'rotate'`, and its arrival gets a quiet `sessionChange` divider. */
  private readonly runningProviderSwitch = new Map<
    string,
    {
      toHarness: HarnessId;
      toModel: string | null;
      seededMessages: number;
      /** Set once the target harness reports it had to drop the oldest
       * records to fit its context window (spec/04 § History — Codex has no
       * auto-compaction for an injected thread, unlike Claude Code). */
      trimmedRecords?: number;
    }
  >();
  /**
   * Set by `setChatModel(chatId, model, { compact: true })` (spec/04 § History
   * — "switch and compact", the cheap path for huge chats): the NEXT turn's
   * switch, if it's still a cross-provider switch by the time it runs, hands
   * the target a handoff note (the outgoing session's own self-summary, via
   * `generateDigest`) plus the last few turns, instead of the full native
   * reconstruction. Consumed (and cleared) the moment that turn's switch
   * block runs, so it never lingers onto some LATER, unrelated switch.
   */
  private readonly pendingCompactSwitch = new Map<
    string,
    { outgoingModel: string | null; outgoingSessionId: string }
  >();
  /**
   * Per-chat ring of the most-recent emitted wire events. Backs `patch_peek`
   * (spec/06): peek returns the recent wire-event slice so the agent can see
   * "what's going on right now" without paging through history. Hard cap per
   * chat is the peek ceiling (200) — peek never needs more, and patch_history
   * exists for deeper retrospection. Only chat-scoped stream events are kept
   * (those carry a `chatId` and a `seq`); daemon-global events (daemon.online,
   * etc.) are not chat-addressable and are skipped.
   */
  private readonly recentEvents = new Map<string, WireEvent[]>();
  /**
   * spec/14 § Tool runs — per chat, the run of groupable tool calls currently
   * open (by the rule surfaces fold runs with, `isGroupableToolCall`) and the
   * prose it sits in, which is what its summary is written from.
   */
  private readonly toolRuns = new Map<
    string,
    {
      calls: Array<{
        callId: string;
        tool: string;
        args: unknown;
        failed?: boolean;
        outcome?: string;
      }>;
      userMessage: string;
      assistantBefore: string;
    }
  >();
  /**
   * chatIds whose ring has dropped at least one event past the cap — so older
   * events exist on disk (reachable via patch_history) even when the returned
   * peek slice equals the whole ring. Keeps `truncated` honest.
   */
  private readonly recentEventsDropped = new Set<string>();
  /**
   * spec/20-hooks.md § On the agent's response — a deterministic (no model
   * call) per-chat tally of the CURRENT turn's tool calls by tool name,
   * always tracked (unlike `toolRuns` above, which only runs when
   * `summarizeToolRun` is configured) since an `agent_response` hook's
   * `toolCallsSummary` must not depend on that optional feature. Read and
   * cleared by `maybeCheckAgentResponseHooks` at turn settle.
   */
  private readonly hookToolTally = new Map<string, Map<string, number>>();
  /**
   * spec/04 § Goals — armed while evaluation is deferred on a chat with
   * running `patch_watch` tasks, so it can re-check once they finish instead
   * of leaving the goal silently un-evaluated until the next real turn.
   */
  private readonly goalWatchPollTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private static readonly RECENT_EVENTS_CAP = 200;
  /** OAuth gate run before every query. See DaemonOptions.resolveOAuth. */
  private readonly resolveOAuth: NonNullable<DaemonOptions['resolveOAuth']>;
  /**
   * Per-chat record of the resume argument handed to the SDK on the MOST
   * RECENT query (spec/02 ## Host restart behaviour, spec/04 ## Resume).
   * `resumeSessionId` is the value of `options.resume` passed to `query()` —
   * `undefined` for a chat's genuine first turn, the persisted
   * `meta.claudeSessionId` for every resumed turn. Surfaced via
   * `lastQueryDiagnostics()` on the host control UDS so the resume guarantee
   * is OBSERVABLE on the running app (D3-6), not only via the mock SDK's
   * in-process `lastOptions()` hook. Diagnostics only — never gates behaviour.
   */
  private readonly lastQuery = new Map<
    string,
    { resumeSessionId: string | undefined; at: number }
  >();

  constructor(options: DaemonOptions) {
    this.opts = {
      ...options,
      now: options.now ?? (() => Date.now()),
      generateChatId: options.generateChatId ?? (() => ulid()),
      discoverClaudeMcpServers: options.discoverClaudeMcpServers ?? discoverClaudeMcpServers,
    };
    // Build the OAuth gate. `resolveOAuth` wins; otherwise wrap the static
    // token into an always-ok resolver (test convenience). NO FALLBACK:
    // neither supplied is a programming error, surfaced loudly.
    if (options.resolveOAuth) {
      this.resolveOAuth = options.resolveOAuth;
    } else if (options.oauthAccessToken !== undefined) {
      const token = options.oauthAccessToken;
      this.resolveOAuth = () => ({ ok: true, accessToken: token });
    } else {
      throw new Error('Daemon: one of resolveOAuth / oauthAccessToken is required');
    }
    this.chatState = new ChatStateMap();
    this.chatLog =
      options.chatLog ??
      new ChatLog({
        chatDir: (chatId) => dirname(options.metaStore.pathFor(chatId)),
        // pathFor → <home>/chats/<id>/meta.json, so <home>/blobs sits beside chats/.
        blobsDir: join(dirname(dirname(dirname(options.metaStore.pathFor('_')))), 'blobs'),
        logger: options.logger,
        now: this.opts.now,
      });
    this.claudeProjectsRoot = options.claudeProjectsRoot ?? defaultClaudeProjectsRoot();
    this.historyReader =
      options.historyReader ?? createHistoryReader({ claudeProjectsRoot: this.claudeProjectsRoot });
    // spec/02 § Self-wake: the host owns durable per-chat timers. On fire it
    // re-invokes the SAME chat (resuming its Claude session) — the agent declares
    // intent via patch_wake_me and ends its turn; the host does the waiting.
    this.wake = new WakeScheduler({
      deliver: (chatId, message) => this.deliverWake(chatId, message),
      dirForChat: (chatId) => dirname(this.opts.metaStore.pathFor(chatId)),
      allChatIds: () => this.opts.metaStore.list().map((m) => m.chatId),
      // spec/02 § Self-wake — "count the interval from the end of the turn":
      // a loop tick due while the chat's pump is occupied is absorbed rather
      // than queued (see wake.ts `fire`/`onTurnEnd`).
      isBusy: (chatId) => this.pumping.has(chatId),
      now: () => this.opts.now(),
      logger: this.opts.logger,
    });
    // patch_watch (background-task reliability overhaul, part 1): the host
    // itself owns the spawn, so it holds a real pid/pgid a native
    // Bash/Agent-run_in_background call never gives it (backgroundTaskStats.ts).
    this.watch = new WatchScheduler({
      deliver: (chatId, message) => this.deliverWatch(chatId, message),
      dirForChat: (chatId) => dirname(this.opts.metaStore.pathFor(chatId)),
      allChatIds: () => this.opts.metaStore.list().map((m) => m.chatId),
      now: () => this.opts.now(),
      logger: this.opts.logger,
    });
    // spec/02 § Browser: the agent browser, one real Chromium this host owns.
    // Rooted beside the meta store, same trick ChatLog's blobsDir above uses
    // to find `<home>` without a separate config field.
    const webBotAuth = options.browser ? undefined : webBotAuthFromEnv(process.env);
    this.browser =
      options.browser ??
      new BrowserManager({
        root: join(dirname(dirname(dirname(options.metaStore.pathFor('_')))), 'browser'),
        logger: options.logger.child({ component: 'browser' }),
        ...(webBotAuth ? { webBotAuth } : {}),
      });
    // Seed the mutable harness config from the initial opts (Task 3).
    if (options.harnessConfig) {
      this.harnessConfig = { ...options.harnessConfig };
    }
  }

  private readonly wake: WakeScheduler;
  private readonly watch: WatchScheduler;
  private readonly browser: BrowserManager;

  /** Per-chat snooze-expiry timers (spec/04 § Snooze). Re-armed on hydrate. */
  private readonly snoozeTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Per-chat auto-resume timers: when a turn fails with a rate limit error and
   * `autoResumeRateLimit` is on, the host parks the user message here and fires
   * it again once the limit resets (or after a 60s backoff). Cleared when the
   * timer fires, is cancelled, or the host shuts down.
   */
  private readonly rateLimitTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * ms-epoch when each chat's rate-limit auto-resume is scheduled. Carried into
   * `chat.state` so surfaces can show "paused — resuming at HH:MM".
   */
  private readonly rateLimitResumingAt = new Map<string, number>();
  /**
   * Why each blocked chat is blocked, in figures.
   *
   * Held beside `rateLimitResumingAt` and cleared with it, because they are one
   * fact: "paused until 10:40" is unreadable without "because work's 5-hour
   * window is spent", and Anthropic's own sentence supplies neither reliably.
   */
  private readonly limitBlocks = new Map<string, NonNullable<ChatStateEvent['limitBlock']>>();

  /**
   * Whether the scheduled auto-resume is for a rate-limit or an overload.
   * Cleared alongside `rateLimitResumingAt`.
   */
  private readonly resumeKindMap = new Map<string, 'rate_limit' | 'overloaded'>();

  /**
   * Pending turn info for rate-limit auto-resume — the original user message
   * and its localId, so the retry can re-send the exact same turn. Cleared
   * when the timer fires or the resume is cancelled.
   */
  private readonly rateLimitPendingTurns = new Map<
    string,
    { message: string; localId?: string; retryOfSeq?: number }
  >();

  /**
   * Whether this host auto-resumes turns blocked by a Claude API usage/rate
   * limit. Set by `setAutoResumeRateLimit`; read in the runQuery catch block.
   */
  private autoResumeRateLimitEnabled = false;

  /**
   * This host's question-expiry setting (spec/02 § Questions are not
   * approvals). Set by `setQuestionExpiry`, read when a question request is
   * armed. `enabled: false` means a question waits indefinitely — an APPROVAL
   * is unaffected either way: it has its own fixed window, and the setting the
   * user is offered is about questions.
   */
  private questionExpiry: { enabled: boolean; seconds: number } = {
    enabled: true,
    seconds: QUESTION_EXPIRY_SECONDS_DEFAULT,
  };

  /**
   * Set the question-expiry window. THROWS on a window outside the wire's
   * bounds rather than clamping it: a clamp would leave the host running one
   * number while Settings showed another, which is the silent disagreement
   * spec/12 forbids.
   */
  setQuestionExpiry(next: { enabled?: boolean; seconds?: number }): void {
    if (next.seconds !== undefined) {
      if (
        !Number.isInteger(next.seconds) ||
        next.seconds < QUESTION_EXPIRY_SECONDS_MIN ||
        next.seconds > QUESTION_EXPIRY_SECONDS_MAX
      ) {
        throw new Error(
          `question expiry must be a whole number of seconds between ${QUESTION_EXPIRY_SECONDS_MIN} and ${QUESTION_EXPIRY_SECONDS_MAX}, got ${next.seconds}`,
        );
      }
      this.questionExpiry.seconds = next.seconds;
    }
    if (next.enabled !== undefined) this.questionExpiry.enabled = next.enabled;
  }

  /** What this host currently holds, for `daemon.host`. */
  questionExpirySetting(): { enabled: boolean; seconds: number } {
    return { ...this.questionExpiry };
  }

  /** Toggle auto-resume and emit updated `daemon.host` if available. */
  /**
   * Every chat parked waiting for a limit to reset, run again NOW.
   *
   * Called when an account is added or reconnected: the thing they were waiting
   * for has been overtaken by a person putting credit in, and "these
   * conversations should continue once I put a new key in" is the whole point of
   * holding a second account.
   *
   * Cancels the pending reset timer first — otherwise the turn would run here
   * AND again when the timer fires, delivering it twice. Returns how many were
   * resumed so the caller can log a number rather than an intention.
   */
  /**
   * The id a re-sent parked turn travels under. A FRESH one, every time.
   *
   * This is load-bearing, and it is not obvious. `sendInput` keeps a permanent
   * per-chat set of every localId it has ever accepted (`seenLocalIds`) and
   * silently re-acks — without running — anything it has seen before. That
   * guard exists for ONE thing: a surface blindly redelivering a message it
   * never got an ack for (spec/12 § Guaranteed input delivery).
   *
   * A parked turn's localId is by definition already in that set — the turn was
   * accepted under it, ran, and failed. Re-sending it under its own id
   * therefore did not resume the chat at all: it took the duplicate branch,
   * logged "duplicate localId, re-acked without re-running", and the turn was
   * dropped. Every in-process resume path did this, so the parked half of the
   * credit machinery was a no-op end to end — which is exactly the reported
   * symptom, a chat that never picks back up while the errored ones (which have
   * always minted a fresh id, see `resumeErroredOnExhaustedAccount`) do.
   *
   * Nothing is lost by re-identifying it. The surface drops its optimistic
   * localId the moment the turn's `chat.message` lands, which happens BEFORE
   * the SDK query that later failed (see the note on `userMessageSeq`), so by
   * the time a park can happen no client is still holding that id.
   *
   * The RESTART path is the deliberate exception and keeps the original id
   * (`resumeInterruptedTurns`): a new process has an empty `seenLocalIds`, so
   * there is no guard to trip, and a surface reconnecting across the restart
   * may still be holding the id.
   */
  private resumeLocalId(kind: 'manual' | 'acct' | 'rl', chatId: string): string {
    return `${kind}-resume-${chatId}-${this.opts.now()}`;
  }

  /**
   * Run ONE parked chat's turn now, abandoning the wait.
   *
   * The owed turn is re-sent through `sendInput` like any other, so it resolves
   * an account afresh — which is the point, since the reason to press this is
   * usually that the account situation has changed. Returns false when the chat
   * owes nothing, so the caller can say nothing happened rather than imply it
   * did.
   */
  resumeRateLimitedNow(chatId: string): boolean {
    // A limit nobody parked is offered the same control (spec/12): auto-resume
    // decides whether a TIMER was set, not whether the turn is still owed. The
    // owed turn is the parked one — written by the limit path itself, and by the
    // retry ladder before it gave up — or, after a restart, the one meta.json
    // still lists.
    const pending =
      this.rateLimitPendingTurns.get(chatId) ??
      (this.limitBlocks.has(chatId)
        ? (this.parkedTurns.get(chatId) ?? this.opts.metaStore.read(chatId)?.pendingTurns?.[0])
        : undefined);
    const timer = this.rateLimitTimers.get(chatId);
    if (!pending && !timer) {
      // Nobody presses this button at a chat that is not showing a pause, so a
      // press with nothing parked means the SURFACE's copy of the pause has
      // outlived the host's. Clear it and emit, rather than returning in
      // silence: a control that does nothing, visibly, is indistinguishable
      // from a broken one, and it was pressed nine times in a row on the
      // strength of that.
      this.rateLimitResumingAt.delete(chatId);
      this.limitBlocks.delete(chatId);
      this.resumeKindMap.delete(chatId);
      this.emitState(chatId);
      this.opts.logger.info(
        { chatId },
        'resume-now with nothing parked — cleared a stale usage-limit pause',
      );
      return false;
    }
    if (timer) clearTimeout(timer);
    this.rateLimitTimers.delete(chatId);
    this.rateLimitResumingAt.delete(chatId);
    this.limitBlocks.delete(chatId);
    this.resumeKindMap.delete(chatId);
    this.rateLimitPendingTurns.delete(chatId);
    this.unparkTurn(chatId);
    // The account that ran out is eligible again for this attempt: the user is
    // asserting the situation changed, and the alternative — refusing to try
    // the only account there is — is how this gets stuck.
    this.failoverTriedAccounts.delete(chatId);
    // Before the re-send, not after it and not only on the empty path: a
    // `sendInput` that re-acks a duplicate localId emits no state, and the pause
    // is over either way.
    this.emitState(chatId);
    if (!pending) return true;
    const state = this.chatState.get(chatId);
    void this.sendInput({
      chatId,
      message: pending.message,
      localId: this.resumeLocalId('manual', chatId),
      // Waiting out a limit does not change whose turn it was (spec/09).
      ...(state?.turnOrigin === 'machine' ? { origin: 'machine' as const } : {}),
      // spec/12 § A turn is owed until it settles — the bubble is already on
      // screen from the attempt the limit killed, so fold onto it.
      ...(pending.retryOfSeq !== undefined ? { retryOfSeq: pending.retryOfSeq } : {}),
    });
    return true;
  }

  resumeAllRateLimited(): number {
    const parked = [...this.rateLimitPendingTurns.entries()];
    let resumed = 0;
    for (const [chatId, pending] of parked) {
      if (isCodexModel(this.chatState.get(chatId)?.model)) continue;
      const timer = this.rateLimitTimers.get(chatId);
      if (timer) clearTimeout(timer);
      this.rateLimitTimers.delete(chatId);
      this.rateLimitResumingAt.delete(chatId);
      this.limitBlocks.delete(chatId);
      this.resumeKindMap.delete(chatId);
      this.rateLimitPendingTurns.delete(chatId);
      this.unparkTurn(chatId);
      // Every account is eligible again for this attempt. The reason this is
      // being resumed at all is that credit came back somewhere, and the set of
      // keys this chat already tried is a record of the situation that has just
      // ended — carrying it forward would park the turn again on its first
      // refusal without trying the key that just came back.
      this.failoverTriedAccounts.delete(chatId);
      // Same reason as the auto-resume timer: the pause is lifted here, and a
      // `sendInput` that takes the duplicate-localId branch emits no state, so
      // the bubble would survive the thing it is describing.
      this.emitState(chatId);
      const state = this.chatState.get(chatId);
      void this.sendInput({
        chatId,
        message: pending.message,
        localId: this.resumeLocalId('acct', chatId),
        // Waiting out a limit does not change whose turn it was (spec/09).
        ...(state?.turnOrigin === 'machine' ? { origin: 'machine' as const } : {}),
        // spec/12 § A turn is owed until it settles.
        ...(pending.retryOfSeq !== undefined ? { retryOfSeq: pending.retryOfSeq } : {}),
      });
      resumed += 1;
    }
    return resumed;
  }

  /**
   * Chats that ERRORED on a spent account, re-run.
   *
   * Distinct from the parked ones above: before the spend-limit wording was
   * recognised as a rate limit at all, those turns were not parked — they errored,
   * exhausted their retries and stopped, with the turn recorded in the chat's
   * `pendingTurns` on disk. A new key has to pick those up too, or the very chats
   * that hit the problem first are the ones it does not fix.
   *
   * The case it ACTUALLY has to carry is a turn blocked on credit that never
   * reached the rate-limit park at all — because its failure said nothing about
   * a limit. A killed `claude`, a dropped socket, any fault on a host whose
   * every key is spent: `isRateLimitError` is false, so the park path is skipped
   * and the turn is parked by the tail instead, which puts it in `parkedTurns`
   * and NOT in `rateLimitPendingTurns`. `resumeAllRateLimited` therefore cannot
   * see it, ever. This list is the only thing that can.
   *
   * It could not see it either. The filter was `state.status === 'errored'`, and
   * a credit park deliberately leaves the lifecycle status `active` — a chat
   * with work owed is not a dead chat — so it matched nothing a limit had ever
   * produced, and the second half of CreditResume was dead for the exact case
   * it was written for. Chat 01M3Y2GYHVQB6N1N3MV6WH6P32 sat errored for
   * thirteen hours through a credit top-up because of it.
   *
   * The failure is read off META first because that is the copy that survives,
   * and because a persisted `lastError` is only rehydrated into chat state for a
   * chat whose stored status says errored — which, per the above, this never is.
   * (A restart is NOT this method's problem: `hydrate` re-sends every
   * `pendingTurns` entry on boot, so a park lost to a restart is re-run, fails
   * again if there is still no credit, and parks again.)
   */
  resumeErroredOnExhaustedAccount(maxAgeMs: number = STALE_RETRY_CUTOFF_MS): number {
    const now = this.opts.now();
    let resumed = 0;
    let skippedStale = 0;
    for (const state of this.chatState.list()) {
      if (isCodexModel(state.model)) continue;
      // Anything the PARKED sweep owns is not also this sweep's to re-send.
      // `resumeWaitingWork` runs the two back to back and a park's re-send is
      // async, so a chat in both lists would be read here as still errored with
      // its resumed turn already queued — and sent a second time. A chat with
      // its own armed timer is the same story with a different owner.
      if (this.rateLimitPendingTurns.has(state.chatId)) continue;
      if (this.rateLimitTimers.has(state.chatId)) continue;
      // Nothing to resume into: a turn is already running or waiting to.
      if (this.runs.has(state.chatId) || this.hasQueuedTurns(state.chatId)) continue;
      const meta = this.opts.metaStore.read(state.chatId);
      // Disk first, memory second — see this method's note. On disk it is the
      // record a restart kept; in memory it is all there is for a park whose
      // host never went down.
      const last = (meta?.lastError as ChatLastError | undefined) ?? state.lastError;
      if (!last || !isAccountExhaustedError(last.message)) continue;
      // A CUTOFF, so nothing ancient springs back to life. A turn that failed
      // days ago is about a world that has moved on — a deploy since superseded,
      // a task already done by hand, a purchase no longer wanted — and firing it
      // now is worse than leaving it failed. It stays errored and VISIBLE; a
      // person can re-send it deliberately.
      if (now - last.at > maxAgeMs) {
        skippedStale += 1;
        continue;
      }
      const pending = meta?.pendingTurns?.[0];
      if (pending === undefined) continue;
      // Same as the parked path: credit has returned, so every key is worth a
      // go again.
      this.failoverTriedAccounts.delete(state.chatId);
      void this.sendInput({
        chatId: state.chatId,
        message: pending.message,
        localId: `acct-resume-errored-${state.chatId}-${this.opts.now()}`,
        ...(state.turnOrigin === 'machine' ? { origin: 'machine' as const } : {}),
        // spec/12 § A turn is owed until it settles — the turn already has a
        // bubble from the attempt that errored, so fold onto it.
        ...(pending.retryOfSeq !== undefined ? { retryOfSeq: pending.retryOfSeq } : {}),
      });
      resumed += 1;
    }
    if (skippedStale > 0) {
      // Said out loud: chats deliberately left behind must not look forgotten.
      this.opts.logger.info(
        { skippedStale, cutoffHours: Math.round(maxAgeMs / 3_600_000) },
        'account resume: left stale failed turns alone — too old to re-fire safely',
      );
    }
    return resumed;
  }

  setAutoResumeRateLimit(enabled: boolean): void {
    this.autoResumeRateLimitEnabled = enabled;
  }

  /** Per-host harness config (Task 3). Updated via `setHarnessConfig`. */
  private harnessConfig: {
    systemPrompt?: string;
    toolsPrompt?: string;
    skills?: string[] | 'all';
    memoryEnabled?: boolean;
    mcpServers?: McpServerConfig[];
    claudeMdExcludePaths?: string[];
  } = {};

  /** Update the per-host harness config — applies to the next turn. */
  setHarnessConfig(config: {
    systemPrompt?: string;
    toolsPrompt?: string;
    skills?: string[] | 'all';
    memoryEnabled?: boolean;
    mcpServers?: McpServerConfig[];
    claudeMdExcludePaths?: string[];
  }): void {
    this.harnessConfig = config;
  }

  /**
   * Most recent `resetsAt` ms-epoch per chat and scope, from `onRateLimit`
   * events. Tracked separately so auto-resume picks the SOONEST relevant
   * window: a 5-hour session limit resets hours from now, not days.
   */
  private readonly lastResetsAtByScope = new Map<string, { session?: number; week?: number }>();

  /**
   * Per-chat overload retry count for exponential backoff (Task 2). Reset
   * when a non-overloaded error occurs or when a turn succeeds.
   */
  private readonly overloadRetryCount = new Map<string, number>();
  /**
   * The accounts a chat has ALREADY been failed over onto for the turn it is
   * currently trying to get through, cleared the moment a turn settles.
   *
   * Failover re-runs the turn on another account, and the re-run reports the
   * failure against the chat's PREFERENCE, not the account it actually ran on
   * (the preference is deliberately never rewritten). So a host whose accounts
   * are all spent read the same "account A is out, move to B" every time and
   * re-ran the turn forever: on 2026-09-07 three chats span a fresh `claude`
   * process every second for hours, none of which could ever succeed. A turn
   * gets ONE go on each account; when the next one has already been tried it is
   * not a failover any more, and the turn falls through to the rate-limit park
   * that waits for the reset.
   */
  private readonly failoverTriedAccounts = new Map<string, Set<string>>();
  /**
   * The account each chat's most recent turn resolved onto, as `resolveOAuth`
   * reported it. Set as that turn starts, and left standing after it — a usage
   * reading that lands late still belongs to the turn that produced it.
   *
   * Deliberately not chat state and never persisted: a chat has no account
   * (spec/10 § Backend credentials — multiple accounts), only a turn does, and
   * the next turn resolves the host's keys again from the top. It exists so a
   * failure can be attributed to the key that actually spent.
   */
  private readonly runningOnAccount = new Map<string, string>();
  /**
   * Consecutive generic `sdk_error` retries per chat, for the backoff in the
   * catch below. Cleared by a settled turn, so it counts a run of failures
   * rather than a chat's lifetime total.
   */
  private readonly sdkRetryCount = new Map<string, number>();
  /** Armed generic-error retries, so shutdown can cancel them. */
  private readonly sdkRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Turns parked waiting for a retry — a rate-limit reset or a backoff step.
   * Held here as well as in the timer's closure so `persistPendingTurns` can
   * write them to meta.json: a park can last hours, every deploy restarts the
   * host, and a timer does not survive that. On the way back up
   * `resumeInterruptedTurns` re-sends them like any other interrupted turn.
   */
  private readonly parkedTurns = new Map<string, PendingTurn>();

  /** Stop background timers. Call before letting the host go out of scope in tests. */
  shutdown(): void {
    for (const t of this.snoozeTimers.values()) clearTimeout(t);
    this.snoozeTimers.clear();
    for (const t of this.rateLimitTimers.values()) clearTimeout(t);
    this.rateLimitTimers.clear();
    for (const t of this.sdkRetryTimers.values()) clearTimeout(t);
    this.sdkRetryTimers.clear();
    this.sdkRetryCount.clear();
    // NOT persisted away on shutdown: a parked turn is still owed, and
    // meta.json is exactly how the next host finds out about it.
    this.parkedTurns.clear();
    this.rateLimitResumingAt.clear();
    this.limitBlocks.clear();
    this.rateLimitPendingTurns.clear();
    this.lastResetsAtByScope.clear();
    this.overloadRetryCount.clear();
    this.resumeKindMap.clear();
    // Disarm in-memory wake timers (the persisted wake.json files remain, so a
    // restart re-adds them — spec/02 § Self-wake durability).
    this.wake.dispose();
    // Disarm goal-evaluation watch-deferral polls (spec/04 § Goals). The goal
    // itself is persisted, so a restart just stops polling until this chat's
    // next real turn re-evaluates it.
    for (const t of this.goalWatchPollTimers.values()) clearTimeout(t);
    this.goalWatchPollTimers.clear();
    // Stop the resident watch poll. Persisted watch records (and any process
    // they still name) are untouched — a fresh host re-attaches on hydrate.
    this.watch.dispose();
    // Close every open browser tab/context and this manager's own Xvfb.
    // Fire-and-forget: shutdown() is sync (tests call it to go out of scope
    // without awaiting), and a slow Playwright teardown must never block it.
    void this.browser.dispose().catch((err: unknown) => {
      this.opts.logger.error({ err }, 'shutdown: browser dispose failed');
    });
    // Make the history log durable and release its descriptors.
    try {
      this.flushHistory();
    } catch (err) {
      this.opts.logger.error({ err }, 'shutdown: history log flush failed');
    }
  }

  /**
   * Give a chat restored from disk a mode of its own if it was persisted before
   * chats carried one (spec/02 § Permission mode). It adopts the host default in
   * force at the moment it is first loaded, and that is WRITTEN to its meta — a
   * one-off adoption, not a read-time fallback, so the next change to the host
   * default leaves it alone like every other chat.
   */
  private stampMissingPermissionMode(chatId: string): void {
    const state = this.chatState.get(chatId);
    if (!state || state.permissionMode !== undefined) return;
    const mode = this.permissionModeDefault();
    state.permissionMode = mode;
    this.opts.metaStore.update(chatId, (m) => ({ ...m, permissionMode: mode }));
    this.opts.logger.info(
      { chatId, permissionMode: mode },
      'chat had no permission mode; adopted the host default once',
    );
  }

  /** Hydrate chat_state from disk on startup. */
  hydrate(): void {
    const metas = this.opts.metaStore.list();
    for (const u of this.opts.metaStore.unreadable()) {
      this.opts.logger.error(
        { chatId: u.chatId, path: u.path, error: u.error },
        'hydrate: meta.json unreadable; chat not loaded (fix or remove the file, then restart the host)',
      );
    }
    for (const m of metas) {
      if (!existsSync(m.folder)) {
        this.opts.logger.warn(
          { chatId: m.chatId, folder: m.folder },
          'hydrate: folder no longer exists; chat will be marked errored on next input (folder_missing)',
        );
      }
    }
    this.chatState.hydrate(metas);
    // Mark every restored chat as hydrated-from-disk: its next query is a
    // RESUME and must carry a claudeSessionId (F1).
    for (const m of metas) this.hydratedFromDisk.add(m.chatId);
    for (const m of metas) this.stampMissingPermissionMode(m.chatId);
    // Resume each chat's seq above everything any store remembers
    // (spec/02-daemon.md § Sequence durability): its history log, the meta
    // mirror, and the legacy `seq` file older hosts wrote after every emit.
    // Replay must never reuse a seq. Opening the log also repairs a torn last
    // record and closes a turn the previous process never ended.
    const repaired: Array<{ chatId: string; droppedBytes: number }> = [];
    // `pendingTurns` (meta.json) and the chat's own log can disagree about
    // whether the turn meta.json still calls owed actually settled — a crash
    // between the log's own turn.end (fsynced) and the later meta.json rewrite
    // that would have cleared it leaves the stale entry behind. The log is
    // read here, once, while it is open anyway; `resumeInterruptedTurns` below
    // is what actually acts on it.
    const lastTurnOutcomeByChatId = new Map<string, TurnOutcome | null>();
    for (const m of metas) {
      const state = this.chatState.get(m.chatId);
      if (!state) continue;
      const persisted = this.opts.metaStore.readSeq(m.chatId);
      const floor = Math.max(state.nextSeq, persisted ?? 0);
      try {
        const opened = this.chatLog.hydrate(m.chatId, floor);
        state.nextSeq = opened.nextSeq;
        lastTurnOutcomeByChatId.set(m.chatId, opened.lastTurnOutcome);
        if (opened.repaired) {
          repaired.push({ chatId: m.chatId, droppedBytes: opened.repaired.droppedBytes });
        }
      } catch (err) {
        // One unreadable log must not keep every other chat from loading. The
        // chat still loads; its next write fails loudly (history_write_failed).
        state.nextSeq = floor;
        this.opts.logger.error(
          { chatId: m.chatId, err: (err as Error).message },
          'hydrate: history log could not be opened',
        );
      }
    }
    // Say so in the chat: a record was lost, and the reader should know.
    for (const r of repaired) {
      this.emit({
        type: 'chat.message',
        chatId: r.chatId,
        role: 'system',
        content:
          'The end of this chat’s history was cut short by an unclean shutdown; ' +
          `an incomplete last record (${r.droppedBytes} bytes) was dropped.`,
        error: true,
        seq: this.bumpSeq(r.chatId),
        createdAt: this.opts.now(),
      });
    }
    // G2-d4 backfill: chats persisted before `preview` existed (or any chat
    // whose first turn predates this field) have a null preview but a transcript
    // on disk. Recover a one-line snippet of the first user message so the
    // archived sidebar can label them distinctly instead of repeating the folder
    // basename. Read-only best-effort: a chat whose transcript can't be read
    // simply keeps its folder-derived label.
    for (const m of metas) {
      const state = this.chatState.get(m.chatId);
      if (!state || state.preview !== null) continue;
      const snippet = this.firstUserPreviewFromHistory(m.chatId);
      if (snippet === null) continue;
      state.preview = snippet;
      this.opts.metaStore.update(m.chatId, (meta) => ({
        ...meta,
        preview: snippet,
        updatedAt: meta.updatedAt,
      }));
    }
    // spec/04 § Snooze: re-arm live snoozes; a snooze that lapsed while the
    // host was down clears now, so the chat is simply back in the list.
    for (const m of metas) {
      const state = this.chatState.get(m.chatId);
      if (!state || state.snoozedUntil === null) continue;
      if (state.snoozedUntil <= this.opts.now()) this.wakeFromSnooze(m.chatId);
      else this.armSnoozeTimer(m.chatId, state.snoozedUntil);
    }
    this.opts.logger.info({ count: metas.length }, 'chat_state hydrated from disk');
    // spec/02 § Self-wake: re-arm persisted self-wakes; fire any that came due
    // while the host was down (restart catch-up). Runs after chat hydrate so
    // deliveries resolve against in-memory state.
    this.hideArchivedWithLiveWork(metas);
    this.wake.loadAll();
    // patch_watch: re-attach to whatever is still alive across the restart —
    // the resident poll discovers state fresh from disk, so this only logs.
    this.watch.loadAll();
    this.resumeInterruptedTurns(metas, lastTurnOutcomeByChatId);
  }

  /**
   * Chats archived before archiving meant stopped (2026-09-28) may still own
   * work — a pending self-wake, a running watch, an owed turn. Under the old
   * rules archived meant only "out of the way", which is what Hidden is now
   * (spec/04 § Hidden), so they move there. Runs before the wakes are re-armed:
   * an overdue wake fires on boot, and firing into an archived chat would put
   * it in the active list rather than back out of the way.
   *
   * Nothing written under the new rules can match — archiving stops all of it —
   * so on a host that has already run once this finds nothing.
   */
  private hideArchivedWithLiveWork(metas: ChatMeta[]): void {
    for (const m of metas) {
      const state = this.chatState.get(m.chatId);
      if (!state || state.status !== 'archived') continue;
      const live =
        this.wake.peek(m.chatId) !== null ||
        this.watch.count(m.chatId) > 0 ||
        (m.pendingTurns?.length ?? 0) > 0;
      if (!live) continue;
      state.status = 'active';
      state.archivedAt = null;
      state.hidden = true;
      this.opts.metaStore.update(m.chatId, (meta) => ({
        ...meta,
        status: 'active',
        archivedAt: null,
        hidden: true,
        updatedAt: meta.updatedAt,
      }));
      this.opts.logger.info({ chatId: m.chatId }, 'archived chat with live work moved to Hidden');
    }
  }

  /**
   * Restart catch-up for turns, the counterpart to the self-wake one above: put
   * back every turn the previous host was still running or holding in a queue
   * when it died (`pendingTurns`, written by `persistPendingTurns`).
   *
   * A host restart — which is the last thing every deploy does — kills the SDK
   * query mid-turn. The server sees the link drop and resolves those chats to
   * `errored` / `daemon_unavailable` ("Connection to the host was lost.
   * Message will resend."), and this is what makes that promise true — without
   * it the work simply stopped and waited for a human to notice and retype.
   *
   * The head turn is re-sent with a `<system-reminder>` (stripped from the
   * persisted transcript by `persistedUserContent`, so it never shows in the
   * chat) telling the agent it was cut off. The reminder also carries the turn's
   * ORIGINAL prompt in full (`interruptedTurnResend`): the resumed session is
   * not a reliable copy of it, and an autonomous turn's instructions ("don't ask
   * questions") were being lost, so the agent guessed. Being inside the reminder
   * it stays out of the visible chat — what shows is just `'Carry on'`. Turns
   * that were only ever queued never began, so they go back verbatim.
   *
   * The head entry is trusted only as far as the chat's own log backs it up.
   * `persistPendingTurns` writes meta.json separately from (and after) the
   * log's own `turn.end` for the same turn, so a process killed between the
   * two — the log durably shows the turn finished, meta.json's clearing
   * rewrite never landed — leaves a stale head behind: the previous host's
   * `finally` block had already reached `completed`/`stopped` before it died,
   * meta.json just never heard about it. Resending that head as `'Carry on'`
   * would reprompt a conversation this chat's own transcript already shows as
   * finished, so it is dropped instead of resent. A `failed` outcome is not
   * this case — a turn parked for retry (`parkTurn`) closes its attempt as
   * `failed` and stays legitimately owed — and an unsettled (`interrupted`,
   * or no turn yet) outcome means the head really was cut off, so both resend
   * as before. Anything still queued behind a dropped head never ran either,
   * and goes out exactly as it would if it had been queue position two all
   * along — verbatim, no reminder.
   */
  private resumeInterruptedTurns(
    metas: ChatMeta[],
    lastTurnOutcomeByChatId: Map<string, TurnOutcome | null>,
  ): void {
    for (const m of metas) {
      const recorded = m.pendingTurns;
      if (!recorded || recorded.length === 0) continue;
      // Clear the marker BEFORE re-sending: each resumed turn re-persists itself
      // the moment it starts running, so a second interruption is still caught,
      // while a turn that somehow takes the host down with it is not retried
      // forever.
      this.opts.metaStore.update(m.chatId, (meta) => ({
        ...meta,
        pendingTurns: [],
        updatedAt: this.opts.now(),
      }));
      if (m.status === 'deleted') {
        this.opts.logger.info(
          { chatId: m.chatId, turns: recorded.length },
          'resume: chat was deleted while running; dropping its interrupted turns',
        );
        continue;
      }
      const settledOutcome = lastTurnOutcomeByChatId.get(m.chatId);
      const headAlreadySettled = settledOutcome === 'completed' || settledOutcome === 'stopped';
      const pending = headAlreadySettled ? recorded.slice(1) : recorded;
      if (headAlreadySettled) {
        this.opts.logger.info(
          { chatId: m.chatId, outcome: settledOutcome },
          'resume: the recorded head turn already settled per the chat log; dropping the stale resend',
        );
      }
      if (pending.length === 0) continue;
      this.opts.logger.info(
        { chatId: m.chatId, turns: pending.length },
        'resume: re-sending turns interrupted by the previous host',
      );
      // pendingDecisions.ts: a turn cut off while blocked on a permission or
      // AskUserQuestion needs a richer reminder than "you were cut off" — see
      // interruptedTurnReminderWithPendingDecisions. Read once per chat, fold
      // into the first resumed turn, then clear: the text is now IN the
      // conversation, so a stale on-disk copy would only mislead a later
      // restart into repeating context the agent has already seen.
      const chatDir = dirname(this.opts.metaStore.pathFor(m.chatId));
      const pendingDecisions = readPendingDecisions(chatDir);
      if (pendingDecisions.length > 0) clearAllPendingDecisions(chatDir);
      // `pending[0]` is the genuinely-interrupted head only when the head was
      // NOT dropped above as already-settled — once dropped, `pending[0]` is
      // whatever was queued behind it, which never began and goes back
      // verbatim like every other queued entry, not with the cut-off framing.
      const headIsInterrupted = !headAlreadySettled;
      for (const [i, turn] of pending.entries()) {
        const reminder =
          pendingDecisions.length > 0
            ? interruptedTurnReminderWithPendingDecisions(pendingDecisions)
            : INTERRUPTED_TURN_REMINDER;
        const message =
          i === 0 && headIsInterrupted
            ? interruptedTurnResend(reminder, turn.message)
            : turn.message;
        // Deliberately not awaited, and deliberately issued in one synchronous
        // pass: `sendInput` sets the chat's `pumping` guard before its first
        // await, so the second and later turns here see a live pump and queue
        // behind the first in their original order — exactly where they were.
        void this.sendInput({
          chatId: m.chatId,
          message,
          localId: turn.localId ?? randomUUID(),
          // The chat's accepted localIds are in its history log, so this
          // original id is already "seen" — say it is a re-send, not a
          // surface redelivery (see `SendInputOptions.redeliver`).
          redeliver: true,
          ...(turn.fork ? { fork: turn.fork } : {}),
          // spec/09 § Whose turn it was — the turn is resumed as what it was
          // when the previous host died. A self-wake killed mid-tick by a
          // deploy must not come back as a user turn and ring the doorbell.
          ...(turn.origin ? { origin: turn.origin } : {}),
          // spec/12 § A turn is owed until it settles — this turn already has a
          // bubble on every surface, from the attempt the dead host drew, so
          // the re-send NAMES it rather than asking for a second one. Absent
          // only on a turn interrupted before its `chat.message` ever landed
          // (nothing was drawn, so there is nothing to fold into).
          ...(turn.retryOfSeq !== undefined ? { retryOfSeq: turn.retryOfSeq } : {}),
          // spec/14 § Job trigger turn — resumed as what it was, same as `origin`.
          ...(turn.jobTrigger ? { jobTrigger: turn.jobTrigger } : {}),
        }).catch((err: unknown) => {
          this.opts.logger.error(
            { chatId: m.chatId, err },
            'resume: interrupted turn could not be re-sent',
          );
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Self-wake (spec/02 § Self-wake)

  /**
   * Schedule (or REPLACE) a self-wake for a chat: deliver `message` back into
   * THIS chat after a delay. Exactly one of `in` (relative duration), `at`
   * (absolute ISO timestamp), or `every` alone (recurring — see below) fixes
   * the first fire. Optional `notAfter` (ISO) bounds validity — a wake that
   * would fire past it is dropped. Returns the resolved fire time.
   *
   * `every` (relative duration, same grammar as `in`) makes this a LOOP
   * (`patch_loop`, spec/02 § Self-wake): the host re-arms `fireAt = now +
   * every` on every fire instead of clearing the record, so the cadence does
   * not depend on the agent (or a surface) re-arming it each tick. `every` may
   * be given alone (first fire after one interval) or alongside `in`/`at` (an
   * explicit first fire, then that cadence thereafter).
   */
  scheduleWake(
    chatId: string,
    opts: {
      in?: string | number;
      at?: string;
      every?: string | number;
      message: string;
      notAfter?: string;
    },
  ): { fireAt: number } {
    if (!this.chatState.get(chatId) && !this.opts.metaStore.read(chatId)) {
      throw new ChatNotFoundError(chatId);
    }
    const message = opts.message.trim();
    if (!message) throw new Error('scheduleWake: message is required');
    const hasIn = opts.in !== undefined && opts.in !== '';
    const hasAt = opts.at !== undefined && opts.at !== '';
    const hasEvery = opts.every !== undefined && opts.every !== '';
    if (hasIn && hasAt) {
      throw new Error("scheduleWake: provide exactly one of 'in' or 'at'");
    }
    if (!hasIn && !hasAt && !hasEvery) {
      throw new Error("scheduleWake: provide exactly one of 'in' or 'at'");
    }
    const every = hasEvery ? parseDelayMs(opts.every!) : undefined;
    let fireAt: number;
    if (hasIn) {
      fireAt = this.opts.now() + parseDelayMs(opts.in!);
    } else if (hasAt) {
      const t = Date.parse(opts.at!);
      if (Number.isNaN(t)) throw new Error(`scheduleWake: invalid 'at' timestamp: ${opts.at}`);
      fireAt = t;
    } else {
      // `every` alone: the first fire is one interval out, same as every
      // subsequent one.
      fireAt = this.opts.now() + every!;
    }
    let notAfter: number | undefined;
    if (opts.notAfter !== undefined && opts.notAfter !== '') {
      const na = Date.parse(opts.notAfter);
      if (Number.isNaN(na)) throw new Error(`scheduleWake: invalid 'notAfter': ${opts.notAfter}`);
      notAfter = na;
    }
    const rec: WakeRecord = {
      chatId,
      message,
      fireAt,
      createdAt: this.opts.now(),
      ...(notAfter !== undefined ? { notAfter } : {}),
      ...(every !== undefined ? { every } : {}),
    };
    this.wake.schedule(rec);
    this.opts.logger.info({ chatId, fireAt, notAfter, every }, 'wake: scheduled');
    // Surfaces show the pending wake as a bar above the chat, so an armed (or
    // replaced) wake must reach them immediately — not at the next unrelated
    // state change (spec/02 § Self-wake, "Visible, never invisible").
    this.emitState(chatId);
    return { fireAt };
  }

  /** Cancel a chat's pending self-wake (stop the loop). Returns whether one existed. */
  cancelWake(chatId: string): boolean {
    const had = this.wake.cancel(chatId);
    // Re-emit so the wake bar clears on every surface the moment the loop stops.
    this.emitState(chatId);
    return had;
  }

  /** The chat's pending self-wake, or null (introspection / tests). */
  peekWake(chatId: string): WakeRecord | null {
    return this.wake.peek(chatId);
  }

  /**
   * Deliver a fired wake into its chat as a new user turn. Lazy-hydrates a chat
   * that's on disk but not in memory; drops silently if the chat was deleted.
   * The `[wake]` prefix rides in the message (data, not directive) so the agent
   * knows the turn came from its own timer, not the user.
   */
  private async deliverWake(chatId: string, message: string): Promise<void> {
    if (!this.chatState.get(chatId)) {
      const meta = this.opts.metaStore.read(chatId);
      if (!meta) {
        this.opts.logger.warn({ chatId }, 'wake: chat gone, dropping');
        return;
      }
      this.chatState.hydrate([meta]);
      this.hydratedFromDisk.add(chatId);
      this.stampMissingPermissionMode(chatId);
    }
    // The wake file is already cleared by the time we get here (one-shot), so
    // this emit is what takes the bar down as the woken turn lands.
    this.emitState(chatId);
    // spec/09 § Whose turn it was — the chat woke ITSELF. This is the loop that
    // checks something every few minutes, and it is the reason the rule exists:
    // the turn runs normally, it just does not ring the doorbell when it ends.
    await this.sendInput({ chatId, message, localId: randomUUID(), origin: 'machine' });
  }

  /**
   * Start a durable background task for a chat (patch_watch). `cwd` defaults
   * to the chat's own folder when omitted — the common case, since most
   * watched commands are just "keep building/testing in this chat's project".
   */
  startWatch(
    chatId: string,
    opts: { command: string; description: string; cwd?: string },
  ): WatchRecord {
    const state = this.chatState.get(chatId);
    const meta = this.opts.metaStore.read(chatId);
    if (!state && !meta) throw new ChatNotFoundError(chatId);
    const cwd = opts.cwd && opts.cwd.length > 0 ? opts.cwd : (state?.folder ?? meta?.folder);
    if (!cwd) {
      throw new Error(`startWatch: could not resolve a cwd for chat ${chatId}`);
    }
    const rec = this.watch.start({
      chatId,
      command: opts.command,
      description: opts.description,
      cwd,
    });
    this.opts.logger.info({ chatId, taskId: rec.taskId }, 'watch: started');
    // spec/02 § Background task completions — a launch starts work the turn
    // will not wait for, so the sidebar's count (chat.state.backgroundTasks,
    // now read straight off watch.count) must move NOW, not at the next turn
    // settle: a chat that goes idle before this is announced would show the
    // finished tick while the watched command is still running.
    this.emitState(chatId);
    return rec;
  }

  /** Every watch this chat has running or recently ended (patch_watch_list). */
  listWatch(chatId: string): WatchRecord[] {
    return this.watch.list(chatId);
  }

  /** A task's combined stdout+stderr (patch_watch_output). */
  watchOutput(chatId: string, taskId: string, tail?: number): string {
    return this.watch.output(chatId, taskId, tail);
  }

  /** Kill a running task's whole process group (patch_watch_stop). */
  stopWatch(chatId: string, taskId: string): boolean {
    const stopped = this.watch.stop(chatId, taskId);
    // Mirrors startWatch: the count must drop the moment a kill actually
    // lands, not wait for the chat's next turn to settle.
    if (stopped) this.emitState(chatId);
    return stopped;
  }

  // ---- Browser (spec/02 § Browser, spec/06 § Browser tools) ---------------
  // Thin passthroughs to BrowserManager, same shape as the watch methods
  // above. `chatId` is carried through to the tab (BrowserManager's
  // `ownerChatId`) for a future "Browsing <site>" status row — this step
  // emits no new chat state itself.

  /** `patch_browser_open`. */
  async browserOpen(chatId: string, url: string, profile?: BrowserProfile): Promise<OpenResult> {
    const routeThrough = await this.resolveRouteThrough();
    return this.browser.open({
      url,
      ...(profile ? { profile } : {}),
      chatId,
      ...(routeThrough ? { routeThrough } : {}),
    });
  }

  /** spec/02 § Browser — Route through: this host's current setting, resolved into what `BrowserManager.open` needs. */
  private async resolveRouteThrough(): Promise<RouteThrough | undefined> {
    const routing = this.opts.browserRouting;
    if (!routing) return undefined;
    const daemonId = routing.target();
    if (!daemonId) return undefined;
    const hostName = routing.hostName(daemonId);
    if (!routing.isOnline(daemonId)) return { daemonId, hostName, online: false };
    return {
      daemonId,
      hostName,
      online: true,
      proxyServer: await routing.proxyServerFor(daemonId),
    };
  }

  /** `patch_browser_read`. */
  browserRead(tabId: string): Promise<{ title: string; url: string; snapshot: SnapshotNode[] }> {
    return this.browser.read(tabId);
  }

  /** `patch_browser_click`. */
  browserClick(tabId: string, ref: string): Promise<void> {
    return this.browser.click(tabId, ref);
  }

  /** `patch_browser_type`. */
  browserType(tabId: string, ref: string, text: string, submit?: boolean): Promise<void> {
    return this.browser.type(tabId, ref, text, submit !== undefined ? { submit } : undefined);
  }

  /** `patch_browser_fill_form`. */
  browserFillForm(tabId: string, fields: { ref: string; value: string }[]): Promise<void> {
    return this.browser.fillForm(tabId, fields);
  }

  /** `patch_browser_select`. */
  browserSelect(tabId: string, ref: string, value: string): Promise<void> {
    return this.browser.select(tabId, ref, value);
  }

  /** `patch_browser_upload`. */
  browserUpload(tabId: string, ref: string, filePaths: string[]): Promise<void> {
    return this.browser.upload(tabId, ref, filePaths);
  }

  /** `patch_browser_screenshot`. */
  browserScreenshot(tabId: string): Promise<{ data: string; mimeType: string }> {
    return this.browser.screenshot(tabId);
  }

  /** `patch_browser_mouse` — acts, then returns a fresh screenshot plus its viewport size. */
  async browserMouse(
    tabId: string,
    req: PointerRequest,
  ): Promise<{ data: string; mimeType: string; width: number; height: number }> {
    await this.browser.pointer(tabId, req);
    return this.browserScreenshotWithSize(tabId);
  }

  /** `patch_browser_key` — acts, then returns a fresh screenshot plus its viewport size. */
  async browserKey(
    tabId: string,
    keys: string[],
  ): Promise<{ data: string; mimeType: string; width: number; height: number }> {
    await this.browser.pressKeys(tabId, keys);
    return this.browserScreenshotWithSize(tabId);
  }

  private async browserScreenshotWithSize(
    tabId: string,
  ): Promise<{ data: string; mimeType: string; width: number; height: number }> {
    const shot = await this.browser.screenshot(tabId);
    return { ...shot, ...(await this.browser.viewport(tabId)) };
  }

  /** `patch_browser_tabs`. */
  browserTabs(): Promise<TabInfo[]> {
    return this.browser.tabs();
  }

  /** `patch_browser_close`. */
  browserClose(tabId: string): Promise<void> {
    return this.browser.close(tabId);
  }

  /**
   * Deliver a watch's completion into its chat as a new user turn. Mirrors
   * `deliverWake` exactly — lazy-hydrates a chat that's on disk but not in
   * memory; drops silently if the chat was deleted.
   */
  private async deliverWatch(chatId: string, message: string): Promise<void> {
    if (!this.chatState.get(chatId)) {
      const meta = this.opts.metaStore.read(chatId);
      if (!meta) {
        this.opts.logger.warn({ chatId }, 'watch: chat gone, dropping completion');
        return;
      }
      this.chatState.hydrate([meta]);
      this.hydratedFromDisk.add(chatId);
      this.stampMissingPermissionMode(chatId);
    }
    await this.sendInput({ chatId, message, localId: randomUUID(), origin: 'machine' });
  }

  /**
   * Read the first user message of a chat's persisted transcript and return a
   * cleaned one-line preview snippet, or null if none is readable. Used to
   * backfill `preview` for chats created before the field existed (G2-d4).
   */
  private firstUserPreviewFromHistory(chatId: string): string | null {
    try {
      const hist = this.readHistory({ chatId, fromSeq: 0, limit: 20 });
      for (const ev of hist.events) {
        if (ev.type !== 'chat.message') continue;
        if ((ev as { role?: string }).role !== 'user') continue;
        const content = (ev as { content?: unknown }).content;
        if (typeof content !== 'string') continue;
        const snippet = makePreviewSnippet(content);
        if (snippet !== null) return snippet;
      }
    } catch {
      // Unreadable transcript — keep the folder-derived label.
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Public action interface (server WS / CLI / cross-chat tools)

  async spawnChat(req: SpawnChatOptions): Promise<string> {
    // The "type a path" field (new chat, job editor) is typed the way a shell
    // accepts paths — `~/projects/x` — but `req.folder` never goes through a
    // shell, so expand it here before it reaches any fs call.
    const requestedFolder = expandHome(req.folder);
    if (!existsSync(requestedFolder) || !statSync(requestedFolder).isDirectory()) {
      throw new FolderNotFoundError(req.folder);
    }
    // Canonicalise the folder to its realpath. The Claude Agent SDK runs the
    // query with this path as `cwd` and encodes ITS realpath into the
    // `~/.claude/projects/<encoded>` transcript dir (e.g. macOS `/tmp` →
    // `/private/tmp`). The host's HistoryReader encodes the STORED folder, so
    // unless we store the same canonical path, history/replay can't find the
    // transcript the real SDK just wrote. Resolving here keeps both in lockstep
    // (a no-op on Linux where there's no symlink divergence).
    const folder = realpathSync(requestedFolder);
    // Spawn-request idempotency on localId.
    if (req.localId !== undefined) {
      const existing = this.seenSpawnLocalIds.get(req.localId);
      if (existing !== undefined) {
        this.opts.logger.info(
          { localId: req.localId, chatId: existing },
          'spawnChat: duplicate localId, returning existing chatId',
        );
        return existing;
      }
    }
    const chatId = req.chatId ?? this.opts.generateChatId();
    if (this.chatState.has(chatId)) {
      throw new Error(`spawnChat: chatId ${chatId} already exists`);
    }
    const now = this.opts.now();
    // A spawn is always active: it exists to run, and archived means stopped
    // (spec/04 § Lifecycle). A job whose runs are background noise spawns them
    // HIDDEN instead (spec/08 ## Action), which keeps them out of the inbox
    // until one needs the user.
    const status = 'active';
    const archivedAt = null;
    const hidden = req.hidden === true;
    // spec/04 § Spawn — model is optional at every spawn site and resolves ON
    // THE MACHINE: the model named, else the account default mirrored here. A
    // machine with neither refuses the spawn saying so.
    //
    // Nothing is written BACK from here. The resolved model used to be recorded
    // as the machine's last-used, which made the next model-less spawn inherit
    // it — so the default drifted with whatever anyone last ran, and every
    // unattended job drifted with it.
    let model = req.model;
    if (this.opts.defaultModel) {
      model = req.model ?? this.opts.defaultModel();
      if (model === undefined) {
        throw new NoModelCatalogueError(this.opts.daemonId);
      }
    }
    // spec/02 § Permission mode — a chat is STAMPED with a mode at creation and
    // keeps it. The stamp is the spawn request's mode where it named one (a job
    // decides its own), otherwise the host default in force right now. It is not
    // re-derived later: a chat created today under `auto` stays on `auto` when
    // the host default is raised tomorrow.
    const permissionMode =
      req.permissionMode ??
      (isCodexModel(model) && this.permissionModeDefault() === 'auto'
        ? 'default'
        : this.permissionModeDefault());
    const meta: ChatMeta = {
      chatId,
      folder,
      name: req.name ?? null,
      nextSeq: 0,
      pinned: false,
      pinnedAt: null,
      disabled: false,
      status,
      archivedAt,
      ...(hidden ? { hidden } : {}),
      // Persisted so the chat is still on this model after a host restart
      // (spec/04 § Model) — rehydrated by `chatStateFromMeta`.
      ...(model !== undefined ? { model } : {}),
      permissionMode,
      ...(req.preferredAccountId !== undefined
        ? { preferredAccountId: req.preferredAccountId }
        : {}),
      ...(req.subagent ? { subagent: { ...req.subagent } } : {}),
      createdAt: now,
      updatedAt: now,
      lastUserActivity: now,
    };
    this.opts.metaStore.write(meta);
    this.chatState.set({
      chatId,
      name: meta.name,
      preview: meta.preview ?? null,
      goal: meta.goal ?? null,
      goalProgress: null,
      lastGoal: meta.lastGoal ?? null,
      goalRefusalStreak: 0,
      goalEvalAwaitingWatches: false,
      reminder: meta.reminder ?? null,
      declaredStatus: null,
      statusSummary: null,
      statusKind: null,
      turnSummary: null,
      todos: [],
      lastFiredTodo: null,
      todosEditedBySurface: false,
      hiddenNotice: null,
      goalNotice: null,
      pendingHookAdvice: [],
      consecutiveHookBlocks: 0,
      pendingAgentResponseCheckId: null,
      turnWasHookResubmit: false,
      folder,
      activity: 'idle',
      // A brand-new chat has run no turn yet; its first one stamps the real
      // origin (spec/09 § Whose turn it was).
      turnOrigin: 'user',
      turnStopped: false,
      turnRetrying: false,
      lastMessages: [],
      lastUpdated: now,
      claudeSessionId: undefined,
      model,
      permissionMode,
      ...(req.preferredAccountId !== undefined
        ? { preferredAccountId: req.preferredAccountId }
        : {}),
      disabledTools: undefined,
      nextSeq: 0,
      pinned: false,
      pinnedAt: null,
      disabled: false,
      status,
      archivedAt,
      snoozedUntil: null,
      hidden,
      createdAt: now,
      lastUserActivity: now,
      lastError: null,
      subagent: req.subagent ? { ...req.subagent } : undefined,
    });

    if (req.localId !== undefined) {
      this.seenSpawnLocalIds.set(req.localId, chatId);
    }

    const spawned: ChatSpawnedEvent = {
      type: 'chat.spawned',
      chatId,
      daemonId: this.opts.daemonId,
      folder,
      // The model the chat STARTS on (spec/04 § Spawn); it can be changed later
      // (§ Model), and a change is announced on `chat.state`, not by re-emitting
      // this. Absent when this host has no model catalogue support configured
      // at all (`model` stays `undefined` above rather than the resolved block).
      ...(model !== undefined ? { model } : {}),
    };
    this.emit(spawned);
    // Emit initial chat.state so surfaces have full sidebar info immediately.
    this.emitState(chatId);

    if (req.prompt !== undefined && req.prompt.length > 0) {
      // Kick off the first SDK run in the background; surface errors via
      // chat.error rather than rejecting spawnChat (the chat exists either way).
      // Routed through the pump so input arriving DURING the spawn turn queues
      // behind it instead of hitting the "already running" guard (spec/04).
      void this.runTurnsFrom(chatId, req.prompt).catch((err: unknown) => {
        this.opts.logger.error({ chatId, err }, 'spawn-prompt run failed');
      });
    }

    return chatId;
  }

  // ---------------------------------------------------------------------
  // Delegate: durable subagent primitive (spec/06 § Cross-chat tools —
  // patch_delegate). A subagent is an ordinary chat — same meta.json, same
  // SDK session, same restart-resume — carrying `meta.subagent`, which is
  // what makes `private emit()` withhold it from the server and what
  // `listWithFilter` excludes from every listing. Durability and parallelism
  // both fall out of that for free: nothing here is special-cased for restart
  // or for running several at once, because to the rest of the host a
  // subagent chat IS just a chat.

  /**
   * `patch_delegate` — create a subagent chat under `parentChatId`, start it
   * on `prompt`, and return immediately (mirrors `patch_watch`'s shape: the
   * caller does not await completion). Defaults folder/model to the PARENT
   * chat's own, per spec. The label shown on the parent's tool row and in the
   * `[from <label>]` delivery is derived from the prompt, the same way a
   * chat's sidebar preview is.
   */
  async createDelegate(opts: {
    parentChatId: string;
    prompt: string;
    model?: string;
    folder?: string;
    /** Tools withheld from this subagent (SDK tool names or `mcp__…` ids). */
    disallowedTools?: string[];
    /**
     * The caller blocks for the result: `result` resolves when the subagent
     * settles and the host does NOT also deliver it as a `[from]` turn.
     */
    wait?: boolean;
  }): Promise<{ id: string; label: string; result?: Promise<DelegateResult> }> {
    const parent = this.chatState.get(opts.parentChatId);
    if (!parent) throw new ChatNotFoundError(opts.parentChatId);
    const label = makePreviewSnippet(opts.prompt) ?? 'subagent';
    // The id is allocated here, not inside spawnChat, so the waiter is
    // registered before the first turn can possibly settle.
    const chatId = this.opts.generateChatId();
    const result = opts.wait ? this.registerDelegateWaiter(chatId) : undefined;
    try {
      await this.spawnChat({
        chatId,
        folder: opts.folder ?? parent.folder,
        ...(opts.model !== undefined
          ? { model: opts.model }
          : parent.model !== undefined
            ? { model: parent.model }
            : {}),
        permissionMode: parent.permissionMode,
        prompt: opts.prompt,
        subagent: {
          parentChatId: opts.parentChatId,
          label,
          ...(opts.disallowedTools?.length ? { disallowedTools: opts.disallowedTools } : {}),
        },
      });
    } catch (err) {
      this.delegateWaiters.delete(chatId);
      throw err;
    }
    return { id: chatId, label, ...(result ? { result } : {}) };
  }

  /** Subagent id → resolvers of callers blocked on it (`wait: true`). Live only: a restart drops the blocked call, so the delivery path takes over. */
  private readonly delegateWaiters = new Map<string, Array<(r: DelegateResult) => void>>();

  private registerDelegateWaiter(id: string): Promise<DelegateResult> {
    return new Promise<DelegateResult>((resolve) => {
      const list = this.delegateWaiters.get(id) ?? [];
      list.push(resolve);
      this.delegateWaiters.set(id, list);
    });
  }

  /**
   * `patch_delegate_send` — a follow-up message to one of the caller's own
   * subagents. A settled one is re-armed (outcome cleared, running again) and
   * keeps its whole context; a running one queues the message behind its
   * current turn. Throws for an id that is not the caller's subagent — loudly,
   * unlike stop, since a message that goes nowhere is a bug to surface.
   */
  async sendToDelegate(opts: {
    parentChatId: string;
    id: string;
    message: string;
    wait?: boolean;
  }): Promise<{ id: string; result?: Promise<DelegateResult> }> {
    const meta = this.opts.metaStore.read(opts.id);
    if (!meta?.subagent || meta.subagent.parentChatId !== opts.parentChatId) {
      throw new Error(`${opts.id} is not a subagent of this chat`);
    }
    if (!this.chatState.has(opts.id)) this.chatState.hydrate([meta]);
    const state = this.chatState.get(opts.id)!;
    const result = opts.wait ? this.registerDelegateWaiter(opts.id) : undefined;
    if (state.subagent?.outcome !== undefined) {
      const { outcome: _o, finishedAt: _f, ...rest } = state.subagent;
      state.subagent = rest;
      this.opts.metaStore.update(opts.id, (m) => {
        if (!m.subagent) return m;
        const { outcome: _mo, finishedAt: _mf, ...mrest } = m.subagent;
        return { ...m, subagent: mrest };
      });
      this.emitDelegateUpdate(opts.parentChatId, opts.id, state.subagent.label, 'running');
    }
    try {
      await this.sendInput({
        chatId: opts.id,
        message: opts.message,
        localId: randomUUID(),
        origin: 'machine',
      });
    } catch (err) {
      this.delegateWaiters.delete(opts.id);
      throw err;
    }
    return { id: opts.id, ...(result ? { result } : {}) };
  }

  /**
   * True when `chatId` is a `patch_delegate` subagent. The outbound gate in
   * index.ts uses it to drop every frame addressed to a subagent — including
   * ones that never pass through `emit()` (notify/push, voice, auto-title).
   */
  isSubagent(chatId: string): boolean {
    return this.chatState.get(chatId)?.subagent !== undefined;
  }

  /**
   * `chatId`'s parent, if it is a `patch_delegate` subagent — the ownership
   * check behind the parent's "open read-only transcript" route
   * (`PatchChatHistoryRequestEvent.requireParent`, index.ts
   * `handleChatHistoryRequest`), since that route can't use the ordinary
   * `chatRegistry` gate (a subagent is never in it).
   */
  delegateParentOf(chatId: string): string | undefined {
    return (this.chatState.get(chatId)?.subagent ?? this.opts.metaStore.read(chatId)?.subagent)
      ?.parentChatId;
  }

  /** `patch_delegate_list` — every subagent `parentChatId` has created, newest first. */
  listDelegates(parentChatId: string): DelegateSummary[] {
    const out: DelegateSummary[] = [];
    for (const meta of this.opts.metaStore.list()) {
      if (meta.subagent?.parentChatId !== parentChatId) continue;
      const live = this.chatState.get(meta.chatId);
      const status: DelegateStatus =
        meta.subagent.outcome ??
        (live?.activity === 'awaiting-permission' ? 'awaiting-permission' : 'running');
      out.push({
        id: meta.chatId,
        label: meta.subagent.label,
        status,
        createdAt: meta.createdAt,
        finishedAt: meta.subagent.finishedAt ?? null,
      });
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * `patch_delegate_stop` — stop `id`, but only if it is really a subagent
   * `parentChatId` itself created (a chat cannot stop a sibling's, or
   * anything that isn't a delegate at all). Returns false, not an error, for
   * one already finished or unknown — mirrors `patch_watch_stop`.
   */
  async stopDelegate(parentChatId: string, id: string): Promise<boolean> {
    const meta = this.opts.metaStore.read(id);
    if (!meta?.subagent || meta.subagent.parentChatId !== parentChatId) return false;
    if (meta.subagent.outcome !== undefined) return false;
    if (!this.chatState.has(id)) this.chatState.hydrate([meta]);
    await this.stopChat(id);
    this.finishDelegate(id, 'stopped');
    return true;
  }

  /**
   * Stop every still-running subagent `parentChatId` has created — "archiving
   * or stopping the parent stops its subagents" (spec/06). Called from
   * `stopChat` itself so BOTH a plain stop and an archive (which stops the
   * chat first, see `stopAllWork`) cascade through one place. Recurses through
   * `stopChat`, so a delegate that itself delegated stops its own chain too.
   * A no-op scan (no matching meta) for the overwhelmingly common case of an
   * ordinary chat that never delegated anything.
   */
  private async stopDelegatesOf(parentChatId: string): Promise<void> {
    const delegates = this.opts.metaStore
      .list()
      .filter((m) => m.subagent?.parentChatId === parentChatId && m.subagent.outcome === undefined);
    await Promise.all(
      delegates.map(async (meta) => {
        if (!this.chatState.has(meta.chatId)) this.chatState.hydrate([meta]);
        await this.stopChat(meta.chatId);
        this.finishDelegate(meta.chatId, 'stopped');
      }),
    );
  }

  /**
   * Read a subagent's settled turn off `maybeSettleDelegate` (the ONLY
   * caller) and deliver it into its parent. Idempotent — `state.subagent`
   * is checked for an already-stamped `outcome` by the caller, but this is
   * re-checked here too since `stopDelegatesOf`/`stopDelegate` can reach the
   * same chat by a different path.
   */
  private finishDelegate(chatId: string, outcome: 'done' | 'failed' | 'stopped'): void {
    const state = this.chatState.get(chatId);
    if (!state?.subagent || state.subagent.outcome !== undefined) return;
    const { parentChatId, label } = state.subagent;
    const finishedAt = this.opts.now();
    state.subagent = { ...state.subagent, outcome, finishedAt };
    this.opts.metaStore.update(chatId, (m) => ({
      ...m,
      subagent: m.subagent ? { ...m.subagent, outcome, finishedAt } : m.subagent,
      updatedAt: finishedAt,
    }));
    // A stop the parent itself asked for (directly, or by archiving) already
    // told the parent what happened — nothing to deliver. A stop is also
    // never "failed": the subagent didn't fail, it was ended.
    const reply =
      outcome === 'done'
        ? lastAssistantMessage(state)?.content.trim() || '(no reply)'
        : outcome === 'failed'
          ? `FAILED — ${state.lastError?.message ?? 'the turn ended in error'}`
          : 'stopped';
    // A caller blocked on this subagent (`wait: true`) gets the result as its
    // tool result, so it is not ALSO delivered as a turn.
    const waiters = this.delegateWaiters.get(chatId);
    this.delegateWaiters.delete(chatId);
    if (waiters?.length) {
      for (const w of waiters) w({ status: outcome, reply });
    } else if (outcome !== 'stopped') {
      this.deliverToParent(parentChatId, `[from ${label}] ${reply}`);
    }
    this.emitDelegateUpdate(parentChatId, chatId, label, outcome);
  }

  /**
   * Checked at the end of EVERY turn a subagent chat runs (the `finally` in
   * `runQuery`/`runTurnsFrom` — same shape as `stampTurnSummary`'s hook). A
   * no-op for every ordinary chat (`state.subagent` unset) and for a subagent
   * mid-queue or still `awaiting-permission` — those settle later, from the
   * same hook on their own next finally. `turnStopped` wins over the activity
   * read: a stop lands the chat `idle` too, and without checking it first a
   * subagent the parent just stopped would be delivered as a normal success.
   */
  private maybeSettleDelegate(chatId: string): void {
    const state = this.chatState.get(chatId);
    if (!state?.subagent || state.subagent.outcome !== undefined) return;
    if (state.turnStopped) {
      this.finishDelegate(chatId, 'stopped');
    } else if (state.activity === 'idle') {
      this.finishDelegate(chatId, 'done');
    } else if (state.activity === 'errored' && !state.turnRetrying) {
      this.finishDelegate(chatId, 'failed');
    }
  }

  /** Deliver a machine message into `parentChatId`, lazy-hydrating it from
   *  disk like `deliverWatch`/`deliverWake` do, dropping silently if the
   *  parent chat is gone. */
  private deliverToParent(parentChatId: string, message: string): void {
    if (!this.chatState.get(parentChatId)) {
      const meta = this.opts.metaStore.read(parentChatId);
      if (!meta) {
        this.opts.logger.warn(
          { parentChatId },
          'patch_delegate: parent chat gone, dropping delivery',
        );
        return;
      }
      this.chatState.hydrate([meta]);
      this.hydratedFromDisk.add(parentChatId);
      this.stampMissingPermissionMode(parentChatId);
    }
    void this.sendInput({
      chatId: parentChatId,
      message,
      localId: randomUUID(),
      origin: 'machine',
    }).catch((err: unknown) => {
      this.opts.logger.error({ parentChatId, err }, 'patch_delegate: delivery to parent failed');
    });
  }

  /** Live status ping for the parent's `patch_delegate` tool row (spec/14 §
   *  Main chat panel — Delegate tool row). Never withheld by `private emit()`
   *  — it is emitted under the PARENT's own chatId, which is never itself a
   *  subagent. */
  private emitDelegateUpdate(
    parentChatId: string,
    delegateId: string,
    label: string,
    status: DelegateStatus,
  ): void {
    if (!this.chatState.has(parentChatId)) return;
    const ev: ChatDelegateUpdateEvent = {
      type: 'chat.delegate_update',
      chatId: parentChatId,
      delegateId,
      label,
      status,
      seq: this.bumpSeq(parentChatId),
    };
    this.emit(ev);
  }

  /**
   * Resume a chat — ensures it's in chat_state (hydrating from disk if not in
   * memory), emits a fresh chat.state. Does NOT spawn an SDK session: that
   * happens lazily on the next user input via the stored claudeSessionId
   * (per spec/04 ## Resume).
   */
  async resumeChat(chatId: string): Promise<ChatState> {
    let state = this.chatState.get(chatId);
    if (!state) {
      const meta = this.opts.metaStore.read(chatId);
      if (!meta) throw new ChatNotFoundError(chatId);
      this.chatState.hydrate([meta]);
      // Lazy-hydrated from disk: its next query is a RESUME (F1).
      this.hydratedFromDisk.add(chatId);
      this.stampMissingPermissionMode(chatId);
      state = this.chatState.get(chatId);
      if (!state) throw new ChatNotFoundError(chatId);
    }
    // Opening/resuming an archived chat must NOT un-archive it (patch/todo.md:
    // "Archive should remove it from the home screen"). Merely viewing a chat
    // is not a signal to bring it back onto the home screen — it stays archived
    // (still openable + sendable) until the user explicitly unarchives it.
    this.emitState(chatId);
    return state;
  }

  /** Pin/unpin a chat. Persists + emits chat.state. */
  async setPinned(chatId: string, pinned: boolean): Promise<void> {
    const state = this.chatState.get(chatId);
    if (!state) throw new ChatNotFoundError(chatId);
    if (state.pinned === pinned) {
      // Idempotent — re-emit so surfaces converge on stored state.
      this.emitState(chatId);
      return;
    }
    const now = this.opts.now();
    state.pinned = pinned;
    state.pinnedAt = pinned ? now : null;
    state.lastUpdated = now;
    this.opts.metaStore.update(chatId, (m) => ({
      ...m,
      pinned,
      pinnedAt: pinned ? now : null,
      updatedAt: now,
    }));
    this.emitState(chatId);
  }

  /**
   * Set (or clear, with `null`) a chat's goal (spec/04 § Goals — `/goal`).
   * Persists to meta.json + emits chat.state so every surface shows the goal at
   * the top of the chat. Idempotent re-emit when unchanged (surfaces converge).
   *
   * Setting a NEW goal (re-setting one chat can only ever have one — spec/04 §
   * Goals: "a new one replaces the old") starts its progress counters fresh;
   * clearing drops them. Neither touches `lastGoal` — that is written only
   * when a goal resolves met/impossible (`settleGoal` below), not on every
   * set/clear, so an in-progress goal abandoned by a new `/goal` or a bare
   * clear leaves the chat header showing whatever last actually FINISHED.
   */
  async setGoal(chatId: string, goal: string | null): Promise<void> {
    const state = this.chatState.get(chatId);
    if (!state) throw new ChatNotFoundError(chatId);
    if (state.goal === goal) {
      this.emitState(chatId);
      return;
    }
    const now = this.opts.now();
    state.goal = goal;
    state.goalProgress =
      goal === null
        ? null
        : {
            startedAt: now,
            turnsEvaluated: 0,
            tokensSpent: 0,
            lastVerdict: null,
            lastReason: null,
          };
    state.goalRefusalStreak = 0;
    state.goalEvalAwaitingWatches = false;
    // spec/04 § Goals — the agent is told on its next turn.
    state.goalNotice = { goal };
    state.lastUpdated = now;
    if (goal === null) this.flushQueuedNudges(chatId);
    this.opts.metaStore.update(chatId, (m) => ({ ...m, goal, updatedAt: now }));
    this.emitState(chatId);
  }

  /**
   * Adopt a surface's rewrite of the chat's task list (spec/02 § Task list).
   * The list is taken wholesale — the surface sends the whole list, not a delta
   * — and drives the auto-advance from here on. The agent's own TodoWrite state
   * cannot be written from outside its session, so the edit is flagged and its
   * next turn carries a `<system-reminder>` telling it to adopt the new list;
   * without that its next TodoWrite would silently overwrite the user's edit.
   * NOT persisted: todos are in-memory, like the TodoWrite mirror they replace.
   */
  setTodos(chatId: string, todos: TodoItem[]): void {
    const state = this.chatState.get(chatId);
    if (!state) throw new ChatNotFoundError(chatId);
    state.todos = todos;
    state.todosEditedBySurface = true;
    // The user's list supersedes whatever the host last fired: clearing the
    // marker lets the auto-advance fire the new head item even when its text
    // matches the item that was already fired once.
    state.lastFiredTodo = null;
    state.lastUpdated = this.opts.now();
    this.emitState(chatId);
  }

  /**
   * Rename a chat (spec/04 § Name). Persists to meta.json + emits chat.state so
   * every surface relabels. A `null` — or a name that is only whitespace —
   * clears it and the surface falls back to the folder-derived label. Special
   * threads keep their fixed names and are refused. A set name is never
   * overwritten by the summariser, which only runs while the name is null.
   */
  async setName(chatId: string, name: string | null): Promise<void> {
    const state = this.chatState.get(chatId);
    if (!state) throw new ChatNotFoundError(chatId);
    if (isReservedSpecialThread(chatId)) {
      throw new Error(`setName: ${chatId} is a special thread and cannot be renamed`);
    }
    const trimmed = name === null || name.trim() === '' ? null : name.trim();
    if (state.name === trimmed) {
      this.emitState(chatId);
      return;
    }
    const now = this.opts.now();
    state.name = trimmed;
    state.lastUpdated = now;
    this.opts.metaStore.update(chatId, (m) => ({ ...m, name: trimmed, updatedAt: now }));
    this.emitState(chatId);
  }

  /**
   * Set (or clear, with `null`) a chat's reminder (patch/todo.md — Reminders).
   * Persists to meta.json + emits chat.state so every surface shows the reminder
   * at the top of the chat. Idempotent re-emit when unchanged (surfaces converge).
   */
  async setReminder(chatId: string, reminder: string | null): Promise<void> {
    const state = this.chatState.get(chatId);
    if (!state) throw new ChatNotFoundError(chatId);
    if (state.reminder === reminder) {
      this.emitState(chatId);
      return;
    }
    const now = this.opts.now();
    state.reminder = reminder;
    state.lastUpdated = now;
    this.opts.metaStore.update(chatId, (m) => ({ ...m, reminder, updatedAt: now }));
    this.emitState(chatId);
  }

  /** Archive/unarchive a chat. Persists + emits chat.state. */
  /**
   * The agent declaring what this chat is to the user (spec/04 § Current
   * status) — `question` when it is blocked on them, `report` when it simply
   * wants to be seen.
   *
   * Three things happen together because they are one idea: the status is
   * recorded (persisted, so a deploy's restart cannot lose it), the chat comes
   * out of Archived, and surfaces are told. A hidden job with something to say
   * had no way to become merely VISIBLE before this — every route out of hiding
   * was welded to an interruption (a permission block, a question, a
   * notification), so its only options were silence or a push.
   *
   * It fires NO notification. Reaching the user is `patch_notify`'s job and is
   * independent in both directions: a chat may notify all day and stay hidden,
   * and it may come into the list without making a sound.
   *
   * One-way, like the un-archive it performs. Nothing re-hides the chat and
   * nothing downgrades the status except a user turn — see `sendInput`.
   */
  async declareStatus(chatId: string, kind: 'question' | 'report', text: string): Promise<void> {
    const state = this.chatState.get(chatId);
    if (!state) throw new ChatNotFoundError(chatId);
    const at = this.opts.now();
    const declared = { kind, text, at };
    state.declaredStatus = declared;
    state.statusKind = kind;
    state.statusSummary = text;
    this.opts.metaStore.update(chatId, (m) => ({
      ...m,
      declaredStatus: declared,
      updatedAt: at,
    }));
    // Announcing itself is what takes a chat out of hiding (spec/04 § Hidden).
    // `setArchived`/`setHidden` emit the state themselves, so only the case
    // where neither applies has to.
    const moved = state.status === 'archived' || state.hidden;
    if (state.status === 'archived') await this.setArchived(chatId, false);
    if (state.hidden) await this.setHidden(chatId, false);
    if (!moved) this.emitState(chatId);
  }

  async setArchived(chatId: string, archived: boolean): Promise<void> {
    const state = this.chatState.get(chatId);
    if (!state) throw new ChatNotFoundError(chatId);
    // Special threads hold fixed sidebar slots and have no "off the home
    // screen" state to hold — that concept is `setDisabled` for them instead
    // (spec/06 § Disabled). Mirrors the existing setName/setSnoozed guards.
    if (archived && isReservedSpecialThread(chatId)) {
      throw new Error(`setArchived: ${chatId} is a special thread and cannot be archived`);
    }
    const desired = archived ? 'archived' : 'active';
    if (state.status === desired) {
      this.emitState(chatId);
      return;
    }
    const now = this.opts.now();
    state.status = desired;
    state.archivedAt = archived ? now : null;
    state.lastUpdated = now;
    this.opts.metaStore.update(chatId, (m) => ({
      ...m,
      status: desired,
      archivedAt: archived ? now : null,
      updatedAt: now,
    }));
    // Status first, so anything racing the stop already sees a chat that is
    // archived; the stop's own settling frames then carry it too.
    if (archived) await this.stopAllWork(chatId);
    this.emitState(chatId);
  }

  /**
   * Archived means stopped (spec/04 § Lifecycle): end everything the chat has
   * in motion, so that nothing it set going can fire later and start it again.
   *
   * The queue is emptied BEFORE the stop, because stopping hands the pump on to
   * the next queued turn — that is how promote works — and a turn that started
   * running here would run in an archived chat. The timers go after it, because
   * the stop is what settles any turn that might otherwise arm one.
   */
  private async stopAllWork(chatId: string): Promise<void> {
    const queued = this.turnQueues.get(chatId)?.splice(0) ?? [];
    for (const item of queued) {
      this.emit({ type: 'chat.dequeued', chatId, localId: item.localId, reason: 'cancelled' });
    }
    await this.stopChat(chatId);
    this.wake.cancel(chatId);
    // `watch.stop` never delivers a completion (watch.ts), so killing a task
    // does not post a message that would start the chat again.
    for (const rec of this.watch.list(chatId)) {
      if (rec.status === 'running') this.watch.stop(chatId, rec.taskId);
    }
    // A turn parked on a usage limit or a retry backoff is still owed, and its
    // timer would re-send it — which, being a message, would un-archive.
    const limitTimer = this.rateLimitTimers.get(chatId);
    if (limitTimer !== undefined) clearTimeout(limitTimer);
    this.rateLimitTimers.delete(chatId);
    this.rateLimitPendingTurns.delete(chatId);
    this.rateLimitResumingAt.delete(chatId);
    // The limit block stays: it is the notice of why the reply never came
    // (which account, when it lifts), and archiving does not un-say it.
    this.resumeKindMap.delete(chatId);
    const retryTimer = this.sdkRetryTimers.get(chatId);
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    this.sdkRetryTimers.delete(chatId);
    this.sdkRetryCount.delete(chatId);
    this.parkedTurns.delete(chatId);
    this.persistPendingTurns(chatId);
    // spec/04 § Branching — "Archiving/stopping the chat stops all its
    // branches": every OTHER branch's own independent pump too, queue and all.
    const meta = this.opts.metaStore.read(chatId);
    const activeBranchId = meta?.activeBranchId;
    for (const b of meta?.branches ?? []) {
      if (b.branchId === activeBranchId) continue;
      const key = this.branchKey(chatId, b.branchId);
      const queued = this.sideBranchQueues.get(key)?.splice(0) ?? [];
      for (const item of queued) {
        this.emit({ type: 'chat.dequeued', chatId, localId: item.localId, reason: 'cancelled' });
      }
      this.stopBranch(chatId, b.branchId);
    }
  }

  /**
   * Hide / show a chat (spec/04 § Hidden): running, but out of the active list.
   * `false` is the Hidden section's Show. Refused for special threads, which
   * hold fixed sidebar slots, and for a chat that is not active — an archived
   * chat is stopped, and hidden is a state of running (NO FALLBACK: the caller
   * is told, not quietly given something else).
   */
  async setHidden(chatId: string, hidden: boolean): Promise<void> {
    const state = this.chatState.get(chatId);
    if (!state) throw new ChatNotFoundError(chatId);
    if (hidden && isReservedSpecialThread(chatId)) {
      throw new Error(`setHidden: ${chatId} is a special thread and cannot be hidden`);
    }
    if (hidden && state.status !== 'active') {
      throw new Error(
        `setHidden: only an active chat can be hidden (${chatId} is ${state.status})`,
      );
    }
    if (state.hidden === hidden) {
      this.emitState(chatId);
      return;
    }
    state.hidden = hidden;
    // spec/04 § Hidden — the agent is told on its next turn. Undoing a change
    // the agent was never told about cancels it instead of announcing a no-op.
    const notice = hidden ? 'hidden' : 'shown';
    state.hiddenNotice =
      state.hiddenNotice !== null && state.hiddenNotice !== notice ? null : notice;
    // Like snooze, moving between sections is not activity: `updatedAt` and
    // `lastUpdated` stay as they were, so the chat keeps its place by recency.
    this.opts.metaStore.update(chatId, (m) => ({ ...m, hidden, updatedAt: m.updatedAt }));
    this.emitState(chatId);
  }

  /** True while a `patch_delegate` subagent of `parentChatId` has not yet finished. */
  private hasRunningDelegates(parentChatId: string): boolean {
    return this.opts.metaStore
      .list()
      .some((m) => m.subagent?.parentChatId === parentChatId && m.subagent.outcome === undefined);
  }

  /**
   * Turn a special thread on/off (spec/06 § Disabled) — the real "off" switch
   * special threads use instead of archive (which `setArchived` refuses for
   * them). Disabling Manager stops the sweep raising candidates or flagging
   * into it (`manager-sweep.ts` checks this flag); disabling Speakers stops
   * its own ingress handlers from delivering a turn. The chat itself is
   * untouched otherwise — still openable, still in its fixed sidebar slot,
   * just greyed out with its composer inactive.
   */
  async setDisabled(chatId: string, disabled: boolean): Promise<void> {
    const state = this.chatState.get(chatId);
    if (!state) throw new ChatNotFoundError(chatId);
    if (!isReservedSpecialThread(chatId)) {
      throw new Error(`setDisabled: ${chatId} is not a special thread`);
    }
    if (state.disabled === disabled) {
      this.emitState(chatId);
      return;
    }
    state.disabled = disabled;
    state.lastUpdated = this.opts.now();
    this.opts.metaStore.update(chatId, (m) => ({
      ...m,
      disabled,
      updatedAt: this.opts.now(),
    }));
    this.emitState(chatId);
  }

  /**
   * This host is to run a special thread another host ran (spec/06 § Manager
   * failover). The thread carries on numbering from `nextSeq`, so its sequence
   * stays one across hosts, and the agent is given `handoff` with its next
   * message. A handoff already waiting is replaced by the newer one.
   */
  adoptThread(chatId: string, adopt: { nextSeq: number; handoff: string }): void {
    const state = this.chatState.get(chatId);
    if (!state) throw new ChatNotFoundError(chatId);
    if (adopt.nextSeq > state.nextSeq) state.nextSeq = adopt.nextSeq;
    this.threadHandoffs.set(chatId, adopt.handoff);
  }

  /**
   * This host's logged events of the chat after `afterSeq`, oldest first, on the
   * chat's active track. What the server asks for with `patch.log_sync.request`
   * when its log falls behind this one.
   */
  eventsAfter(chatId: string, afterSeq: number): WireEvent[] {
    if (!this.chatState.get(chatId)) throw new ChatNotFoundError(chatId);
    const meta = this.opts.metaStore.read(chatId);
    if (!meta) throw new ChatNotFoundError(chatId);
    const branchId = meta.activeBranchId ?? this.branchIdFor(chatId);
    return readTrack(this.chatLog, chatId, meta, branchId, afterSeq).map(
      (e) => e.event as WireEvent,
    );
  }

  /**
   * Rebuild this host's log of a chat from the server's (`patch.log_restore`):
   * write each event the log does not already hold, and carry the chat's
   * numbering on above them. Events at or below what the log records are left
   * alone, so a restore can be sent twice. Returns how many were written.
   */
  restoreEvents(chatId: string, events: readonly WireEvent[]): number {
    const state = this.chatState.get(chatId);
    if (!state) throw new ChatNotFoundError(chatId);
    let written = 0;
    for (const event of [...events].sort(
      (a, b) => ((a as { seq?: number }).seq ?? 0) - ((b as { seq?: number }).seq ?? 0),
    )) {
      const seq = (event as { seq?: unknown }).seq;
      if (typeof seq !== 'number' || !isLoggedEvent(event)) continue;
      if (seq <= this.chatLog.recordedHighWater(chatId)) continue;
      this.logRecord(chatId, { k: 'event', event: stripSurfaceId(event) }, { seq });
      if (seq + 1 > state.nextSeq) state.nextSeq = seq + 1;
      written += 1;
    }
    if (written > 0) this.chatLog.flush();
    return written;
  }

  /**
   * The server says its log of this chat reaches `through` (`chat.committed`).
   * The chat's numbering never falls at or below it, so a chat the server holds
   * further on than this host's own log (another host ran it, or this host's log
   * was lost) carries on from the server's numbering rather than colliding.
   */
  noteCommitted(chatId: string, through: number): void {
    const state = this.chatState.get(chatId);
    if (!state) return;
    if (through + 1 > state.nextSeq) state.nextSeq = through + 1;
  }

  /** Put back a handoff that was waiting when this host last stopped. */
  restoreThreadHandoff(chatId: string, handoff: string): void {
    this.threadHandoffs.set(chatId, handoff);
  }

  /** The Manager is back on its home host: whatever handoff was waiting is moot. */
  dropThreadHandoff(chatId: string): void {
    this.threadHandoffs.delete(chatId);
  }

  /**
   * Retire a special thread's underlying Claude session and start a fresh
   * one, seeded with a handoff digest from the outgoing session (spec/06 §
   * Session rotation, `rotationDigest.ts`). The scheduled, deliberate
   * alternative to "wait for the SDK's own auto-compact to eventually fire" —
   * Manager alone ran 18 days on ~750k cached tokens a turn without a single
   * one. `chatId` never changes: only the session underneath it does, so
   * pinning, ingress wiring and sidebar identity are untouched.
   *
   * NO FALLBACK: refuses to rotate a chat that's mid-turn (the caller should
   * retry next cycle), a chat with no digest generator wired, or one whose
   * digest generation failed — starting a fresh session with nothing carried
   * over is not a degraded rotation, it is a different, worse operation this
   * method does not perform silently.
   */
  async rotateThread(chatId: string): Promise<void> {
    const state = this.chatState.get(chatId);
    if (!state) throw new ChatNotFoundError(chatId);
    if (!isReservedSpecialThread(chatId)) {
      throw new Error(`rotateThread: ${chatId} is not a special thread`);
    }
    if (state.activity === 'running' || state.activity === 'awaiting-permission') {
      throw new Error(`rotateThread: ${chatId} is mid-turn`);
    }
    if (!this.opts.generateDigest) {
      throw new Error('rotateThread: no digest generator configured');
    }
    const outgoingSessionId = state.claudeSessionId;
    if (outgoingSessionId === undefined) {
      // Nothing to rotate away from — a thread that has never run a turn (or
      // was already rotated onto a session that has not run one yet) has no
      // history to hand off.
      this.opts.logger.info({ chatId }, 'rotateThread: no session yet, nothing to rotate');
      return;
    }
    const digest = await this.opts.generateDigest({
      chatId,
      resumeSessionId: outgoingSessionId,
      folder: state.folder,
    });
    if (digest === null) {
      this.opts.logger.warn(
        { chatId },
        'rotateThread: digest generation failed; skipping this cycle rather than rotating blind',
      );
      return;
    }
    const at = this.opts.now();
    // Boundary marker on the OUTGOING session's transcript, same arrangement
    // a compaction boundary uses (compaction.ts / spec/02 § Context
    // compression) — a system chat.message so it replays with the rest of the
    // chat instead of vanishing on re-entry.
    const seq = this.bumpSeq(chatId);
    this.emit({
      type: 'chat.message',
      chatId,
      role: 'system',
      content: 'Session rotated · digest carried over',
      seq,
      createdAt: at,
    });
    // Clear the session so the next turn starts fresh — the same "session
    // lost, start clean" idiom `runQuery` already uses for an orphaned resume
    // id (above), just deliberate here rather than a recovery from a bad state.
    state.claudeSessionId = undefined;
    this.opts.metaStore.update(chatId, (m) => {
      const { claudeSessionId: _drop, ...rest } = m;
      void _drop;
      return { ...rest, updatedAt: at };
    });
    this.opts.logger.info({ chatId }, 'rotateThread: session rotated, seeding fresh session');
    await this.sendInput({
      chatId,
      message: `[rotation] Picking up from a rotated session. Handoff from the outgoing one:\n\n${digest}`,
      localId: `rotation-${chatId}-${at}`,
    });
  }

  /**
   * Keep the Manager's native session bounded to its last N messages
   * (spec/06 § Manager conversation). A no-op while the full track is still
   * within the window — only a track that's grown PAST it gets a fresh
   * session seeded from the trailing slice `windowTrack` computes. History
   * is untouched either way: this only ever changes which native session
   * `state.claudeSessionId` points at, never the chat's own log.
   */
  private async ensureBoundedManagerContext(chatId: string): Promise<void> {
    const windowSize = this.opts.managerContextWindow;
    if (windowSize === undefined || windowSize <= 0) return;
    const state = this.chatState.get(chatId);
    if (!state?.claudeSessionId) return; // nothing to bound yet
    const meta = this.opts.metaStore.read(chatId);
    if (!meta) return;
    const activeBranchId = meta.activeBranchId ?? this.branchIdFor(chatId);
    const full = readTrack(this.chatLog, chatId, meta, activeBranchId, -1);
    if (countMessages(full) <= windowSize) return; // already within budget
    const windowed = windowTrack(full, windowSize);
    const freshSessionId = randomUUID();
    const store = this.claudeSessionStoreFor(chatId, state.folder);
    await store.append(
      { projectKey: chatId, sessionId: freshSessionId },
      toClaudeSessionEntries(windowed, {
        sessionId: freshSessionId,
        folder: state.folder,
        model: state.model ?? null,
      }),
    );
    state.claudeSessionId = freshSessionId;
    this.opts.metaStore.update(chatId, (m) => ({ ...m, claudeSessionId: freshSessionId }));
  }

  /**
   * Read a candidate's most recent `limit` `chat.message` events (user/
   * assistant only — a sweep flag is not the model's own conversation, spec/06
   * § Sweep). Local candidates read straight off this host's log; a candidate
   * on another host rides the same cross-host relay `patch_history` uses.
   * `readHistory`/`historyRemoteChat` only page OLDEST-first, so this walks
   * forward collecting a rolling tail rather than asking for the end
   * directly — bounded to 10 pages (2000 events) so one huge chat can't make
   * a sweep hang collecting history nobody asked for.
   */
  private async recentMessagesFor(
    candidate: ManagerSweepCandidate,
    limit: number,
  ): Promise<{ role: 'user' | 'assistant'; content: string }[]> {
    const tail: { role: 'user' | 'assistant'; content: string }[] = [];
    let fromSeq: number | undefined;
    for (let page = 0; page < 10; page++) {
      let slice: { events: WireEvent[]; nextFromSeq?: number } | undefined;
      try {
        slice =
          candidate.daemonId === this.opts.daemonId
            ? this.readHistory({ chatId: candidate.chatId, ...(fromSeq ? { fromSeq } : {}) })
            : await this.opts.historyRemoteChat?.({
                sourceChatId: SPECIAL_THREAD_IDS.manager,
                targetChatId: candidate.chatId,
                ...(fromSeq ? { fromSeq } : {}),
              });
      } catch (err) {
        // A candidate the gate saw a moment ago but has since vanished
        // (archived, deleted, host dropped) is not worth failing the whole
        // sweep over — it just gets no transcript in the digest.
        this.opts.logger.warn(
          { chatId: candidate.chatId, err: (err as Error).message },
          'manager-sweep: history read failed; digest will have no transcript for this chat',
        );
        break;
      }
      if (!slice) break;
      for (const event of slice.events) {
        if (event.type !== 'chat.message' || event.role === 'system') continue;
        tail.push({ role: event.role, content: event.content });
        if (tail.length > limit) tail.shift();
      }
      if (slice.nextFromSeq === undefined) break;
      fromSeq = slice.nextFromSeq;
    }
    return tail;
  }

  /** Render the sweep's digest text (spec/06 § Sweep — "a compact digest"). */
  private async buildSweepDigest(
    candidates: readonly ManagerSweepCandidate[],
    messagesPerChat: number,
  ): Promise<string> {
    const sections = await Promise.all(
      candidates.map(async (c) => {
        const messages = await this.recentMessagesFor(c, messagesPerChat);
        const lines = messages.map((m) => `  ${m.role}: ${m.content.slice(0, 400)}`);
        return [
          `- ${c.chatId} (${c.folder} on ${c.daemonId}) — ${c.edge}, idle ${Math.round(c.idleMinutes)}m`,
          ...lines,
        ].join('\n');
      }),
    );
    return `${candidates.length} chat${candidates.length === 1 ? '' : 's'} changed:\n\n${sections.join('\n\n')}`;
  }

  /** Deliver a sweep's nudge/wake message — local chats via `sendInput`, a
   * remote candidate via the same cross-host relay `patch_send_to` uses. */
  private async deliverSweepMessage(
    candidate: ManagerSweepCandidate,
    message: string,
  ): Promise<boolean> {
    const at = this.opts.now();
    try {
      if (candidate.daemonId === this.opts.daemonId) {
        // A chat with a turn running (or a queue draining) isn't idle: the
        // message would only park in its queue until the turn ends, by which
        // time it's stale — and every later sweep would stack another behind
        // it. Not delivered; the next sweep reconsiders once the chat settles.
        if (this.pumping.has(candidate.chatId)) return false;
        await this.sendInput({
          chatId: candidate.chatId,
          message,
          localId: `sweep-${candidate.chatId}-${at}`,
          origin: 'machine',
          nudge: true,
        });
      } else {
        if (!this.opts.sendToRemoteChat) return false;
        await this.opts.sendToRemoteChat({
          sourceChatId: SPECIAL_THREAD_IDS.manager,
          targetChatId: candidate.chatId,
          message,
        });
      }
      return true;
    } catch (err) {
      this.opts.logger.warn(
        { chatId: candidate.chatId, err: (err as Error).message },
        'manager-sweep: delivery failed',
      );
      return false;
    }
  }

  /** Quiet one-line note on the Manager thread's own log (spec/06 § Sweep —
   * "Sweep traffic never enters it, only the one-line flags"): a `system`
   * `chat.message`, same arrangement a rotation boundary uses — never a turn,
   * so it never reaches the Manager's own model context (`nativeReconstruct`
   * drops `role: 'system'`). */
  private flagOnManager(text: string): void {
    this.emit({
      type: 'chat.message',
      chatId: SPECIAL_THREAD_IDS.manager,
      role: 'system',
      content: `[sweep] ${text}`,
      seq: this.bumpSeq(SPECIAL_THREAD_IDS.manager),
      createdAt: this.opts.now(),
    });
  }

  /**
   * Run one Manager sweep (spec/06 § Sweep). The server's gate has already
   * decided this is due and handed over the candidates; this method makes
   * the one decision call, then executes it — nudge/wake by delivering a
   * message, flag by a quiet note on the Manager thread, leave by doing
   * nothing. NO FALLBACK: no decider configured, or the decision call itself
   * failing, ends the run with `error` set and touches nothing.
   *
   * A candidate blocked on a person (`permission`/`question`) is NEVER
   * nudged/woken even if the decision call said to — downgraded to `flag`
   * here, in code, rather than trusted to the prompt alone (spec/06 §
   * Sweep — "It never answers real decisions and never approves tool
   * permissions").
   */
  async runManagerSweep(req: {
    runId: string;
    candidates: ManagerSweepCandidate[];
    messagesPerChat: number;
    prompt: string;
    model: string;
  }): Promise<ManagerSweepResultEvent> {
    if (!this.opts.decideSweep) {
      return {
        type: 'manager.sweep_result',
        runId: req.runId,
        actions: [],
        tokensUsed: 0,
        error: 'manager-sweep: no decider configured',
      };
    }
    const digest = await this.buildSweepDigest(req.candidates, req.messagesPerChat);
    const result = await this.opts.decideSweep({
      digest,
      prompt: req.prompt,
      model: req.model,
    });
    if (result === null) {
      return {
        type: 'manager.sweep_result',
        runId: req.runId,
        actions: [],
        tokensUsed: 0,
        error: 'manager-sweep: decision call failed or returned an unparseable reply',
      };
    }
    const byChatId = new Map(req.candidates.map((c) => [c.chatId, c]));
    const actions: { chatId: string; action: 'nudge' | 'wake' | 'flag' | 'leave' }[] = [];
    const seen = new Set<string>();
    for (const decision of result.decisions) {
      const candidate = byChatId.get(decision.chatId);
      if (!candidate || seen.has(decision.chatId)) continue; // not asked about, or a duplicate — ignore
      seen.add(decision.chatId);
      const blocked = candidate.edge === 'permission' || candidate.edge === 'question';
      const action =
        blocked && (decision.action === 'nudge' || decision.action === 'wake')
          ? 'flag'
          : decision.action;
      if (action === 'nudge' || action === 'wake') {
        const message =
          decision.message?.trim() ||
          (action === 'nudge' ? 'Carry on.' : 'Checking in — still working?');
        const delivered = await this.deliverSweepMessage(candidate, message);
        actions.push({ chatId: candidate.chatId, action: delivered ? action : 'leave' });
      } else if (action === 'flag') {
        this.flagOnManager(
          decision.flagText?.trim() || `${candidate.chatId} (${candidate.folder}) needs a look`,
        );
        actions.push({ chatId: candidate.chatId, action: 'flag' });
      } else {
        actions.push({ chatId: candidate.chatId, action: 'leave' });
      }
    }
    // Anything the decision call never addressed: a person-blocked candidate
    // is still flagged deterministically; everything else is left alone.
    for (const candidate of req.candidates) {
      if (seen.has(candidate.chatId)) continue;
      if (candidate.edge === 'permission' || candidate.edge === 'question') {
        this.flagOnManager(`${candidate.chatId} (${candidate.folder}) needs a look`);
        actions.push({ chatId: candidate.chatId, action: 'flag' });
      } else {
        actions.push({ chatId: candidate.chatId, action: 'leave' });
      }
    }
    return {
      type: 'manager.sweep_result',
      runId: req.runId,
      actions,
      tokensUsed: result.tokensUsed,
    };
  }

  /**
   * Snooze / unsnooze a chat (spec/04 § Snooze). `snoozedUntil` is an ABSOLUTE
   * ms epoch (the surface resolves its preset — a relative delta would drift in
   * flight); `null` unsnoozes. Persists to meta.json, arms the wake timer, and
   * emits `chat.state`. Orthogonal to `status`: the chat stays `active` and keeps
   * running — only where it is listed changes.
   *
   * NO FALLBACK: a timestamp already in the past throws rather than being
   * silently rounded up to "now", and special threads (fixed sidebar slots)
   * cannot be snoozed.
   */
  async setSnoozed(chatId: string, snoozedUntil: number | null): Promise<void> {
    const state = this.chatState.get(chatId);
    if (!state) throw new ChatNotFoundError(chatId);
    if (isReservedSpecialThread(chatId)) {
      throw new Error(`setSnoozed: ${chatId} is a special thread and cannot be snoozed`);
    }
    const now = this.opts.now();
    if (snoozedUntil !== null && snoozedUntil <= now) {
      throw new Error(`setSnoozed: snoozedUntil ${snoozedUntil} is in the past (now ${now})`);
    }
    if (state.snoozedUntil === snoozedUntil) {
      this.emitState(chatId);
      return;
    }
    state.snoozedUntil = snoozedUntil;
    // A snooze is not activity — `lastUpdated` is deliberately untouched so the
    // chat returns to the list exactly where it left (spec/04 § Snooze).
    this.opts.metaStore.update(chatId, (m) => ({ ...m, snoozedUntil, updatedAt: m.updatedAt }));
    this.armSnoozeTimer(chatId, snoozedUntil);
    this.emitState(chatId);
  }

  /**
   * (Re-)arm the in-process timer that ends a snooze. Fires once at
   * `snoozedUntil`, clearing the field + re-emitting `chat.state` so an open
   * surface pops the chat back into the active list with no reload. `null`
   * disarms. setTimeout's ~24.8-day ceiling is handled by re-arming in chunks,
   * so "next week" (and anything longer a custom snooze can name) is safe.
   */
  private armSnoozeTimer(chatId: string, snoozedUntil: number | null): void {
    const existing = this.snoozeTimers.get(chatId);
    if (existing !== undefined) {
      clearTimeout(existing);
      this.snoozeTimers.delete(chatId);
    }
    if (snoozedUntil === null) return;
    const delay = Math.max(0, snoozedUntil - this.opts.now());
    const timer = setTimeout(
      () => {
        this.snoozeTimers.delete(chatId);
        if (this.opts.now() < snoozedUntil) {
          // Chunked long delay — keep waiting.
          this.armSnoozeTimer(chatId, snoozedUntil);
          return;
        }
        this.wakeFromSnooze(chatId);
      },
      Math.min(delay, MAX_SNOOZE_TIMEOUT_MS),
    );
    // Never hold the process open just to end a snooze.
    timer.unref?.();
    this.snoozeTimers.set(chatId, timer);
  }

  /** End a snooze: clear the field in memory + on disk and re-emit chat.state. */
  private wakeFromSnooze(chatId: string): void {
    const state = this.chatState.get(chatId);
    if (!state || state.snoozedUntil === null) return;
    state.snoozedUntil = null;
    this.opts.metaStore.update(chatId, (m) => ({
      ...m,
      snoozedUntil: null,
      updatedAt: m.updatedAt,
    }));
    this.opts.logger.info({ chatId }, 'snooze elapsed: chat returned to the active list');
    this.emitState(chatId);
  }

  /**
   * Soft-delete / restore a chat (spec/04 § Lifecycle). `deleted: true` flips
   * status to `deleted` (it leaves the active list into the surface's _Deleted_
   * section); `deleted: false` restores it to `active`. Recoverable — the
   * on-disk transcript is untouched. Persists + emits chat.state.
   */
  async setDeleted(chatId: string, deleted: boolean): Promise<void> {
    const state = this.chatState.get(chatId);
    if (!state) throw new ChatNotFoundError(chatId);
    const desired = deleted ? 'deleted' : 'active';
    if (state.status === desired) {
      this.emitState(chatId);
      return;
    }
    const now = this.opts.now();
    state.status = desired;
    // A soft-delete leaves the active list; a restore returns it fresh to
    // active. Either way it is not archived, so clear archivedAt.
    state.archivedAt = null;
    state.lastUpdated = now;
    this.opts.metaStore.update(chatId, (m) => ({
      ...m,
      status: desired,
      archivedAt: null,
      updatedAt: now,
    }));
    this.emitState(chatId);
  }

  /**
   * Stream replay events for a chat (per-surface). Emitted through the
   * caller-supplied `emitToSurface` so the server can route to a single
   * surface rather than fan-out broadcasting.
   *
   * Replay reads straight from the chat's own log (spec/04 § History).
   */
  replayChat(
    chatId: string,
    fromSeq: number,
    emitToSurface: (event: WireEvent) => void,
    /** Replay THIS branch's own track (spec/04 § Branching). Default: the active branch. */
    branchId?: string,
  ): void {
    if (!this.chatState.get(chatId)) throw new ChatNotFoundError(chatId);
    this.replayFromLog(chatId, fromSeq, emitToSurface, branchId);
  }

  /**
   * One stored blob's bytes, for serving a tool result or image body that
   * replay deliberately did not send (spec/04 § History — blobs).
   *
   * Scoped to a chat this host actually has: the blob store is shared across
   * every chat on the machine, so without this check any host could be asked
   * to hand back any sha anyone happened to learn. `null` means this host
   * holds no such blob, which is a 404 and not an error.
   */
  readChatBlob(chatId: string, sha: string): { bytes: Buffer; mime: string } | null {
    if (!this.chatState.get(chatId)) throw new ChatNotFoundError(chatId);
    return this.chatLog.readBlobBytes(sha);
  }

  /**
   * Replay a chat straight from its own log (spec/04 § History) — the active
   * track's records, blobs already rehydrated, no ring/transcript merge: the
   * log already IS what was shown, in the order it was shown. A failed turn's
   * `turn.end` (never itself a logged event — `chat.error` is not durable)
   * replays as a system message flagged `error`, which a surface draws as an error card.
   */
  private replayFromLog(
    chatId: string,
    fromSeq: number,
    emitToSurface: (event: WireEvent) => void,
    branchId?: string,
  ): void {
    const state = this.chatState.get(chatId)!;
    const meta = this.opts.metaStore.read(chatId);
    if (!meta) throw new ChatNotFoundError(chatId);
    emitToSurface({
      type: 'chat.spawned',
      chatId,
      daemonId: this.opts.daemonId,
      folder: state.folder,
    });
    const activeBranchId = meta.activeBranchId ?? this.branchIdFor(chatId);
    const targetBranchId = branchId ?? activeBranchId;
    const records = readTrackRecords(this.chatLog, chatId, meta, targetBranchId, fromSeq);
    for (const record of records) {
      if (record.rec.k === 'event') {
        const ev = record.rec.event;
        // Send the blob REFERENCE, never the body. Tool output is 85-99% of a
        // long chat's bytes — one measured chat shipped 23 MB to draw 150 KB
        // of conversation — and every one of those rows arrives collapsed, so
        // the surface fetches a body only when the reader opens that row.
        emitToSurface(this.chatLog.externalizeForReplay(chatId, ev));
      } else if (record.rec.k === 'turn.end' && record.rec.outcome === 'failed') {
        emitToSurface({
          type: 'chat.message',
          chatId,
          role: 'system',
          content: record.rec.error
            ? `This turn failed: ${record.rec.error.message}`
            : 'This turn failed.',
          error: true,
          seq: record.seq,
        });
      }
    }
    for (const ev of this.pendingPermissionEvents.values()) {
      if (ev.chatId === chatId && (ev.branchId ?? activeBranchId) === targetBranchId) {
        emitToSurface(ev);
      }
    }
    emitToSurface(this.branchesEvent(chatId));
    // Top the replay up with the CURRENT chat.state — a reconnecting surface
    // may have missed the live running -> idle edge entirely while
    // disconnected, and the message history it just replayed carries no
    // activity of its own, so without this the Stop button it drove stays
    // stuck showing "running" even though the reply already came back.
    const stateEvent = this.buildStateEvent(chatId);
    if (stateEvent) emitToSurface(stateEvent);
  }

  /**
   * Read a slice of a chat's persisted history. Used by `patch_history`.
   * Returns events with seq >= fromSeq (or fromSeq=0 for the start), capped
   * at limit. nextFromSeq is set when more events exist beyond the slice.
   */
  readHistory(req: {
    chatId: string;
    fromSeq?: number;
    limit?: number;
    /** Read THIS branch's own track (spec/04 § Branching). Default: the active branch. */
    branchId?: string;
  }): {
    events: WireEvent[];
    nextFromSeq?: number;
  } {
    if (!this.chatState.get(req.chatId)) throw new ChatNotFoundError(req.chatId);
    // Clamp to the hard cap — a limit:5000 request yields at most 200 events,
    // never an error (spec/06 patch_history; C2-6).
    const limit = Math.min(req.limit ?? 50, HISTORY_PAGE_HARD_CAP);
    const fromSeq = req.fromSeq ?? 0;
    const meta = this.opts.metaStore.read(req.chatId);
    if (!meta) throw new ChatNotFoundError(req.chatId);
    const targetBranchId = req.branchId ?? meta.activeBranchId ?? this.branchIdFor(req.chatId);
    const all = readTrack(
      this.chatLog,
      req.chatId,
      meta,
      targetBranchId,
      fromSeq > 0 ? fromSeq - 1 : -1,
    ).map((e) => e.event as WireEvent);
    const events = all.slice(0, limit);
    if (all.length > limit) {
      const last = events[events.length - 1] as { seq?: number } | undefined;
      const nextFromSeq = last && typeof last.seq === 'number' ? last.seq + 1 : fromSeq + limit;
      return { events, nextFromSeq };
    }
    return { events };
  }

  /**
   * List chats with optional archive filter, matching server's REST shape.
   * Default omits archived AND soft-deleted. `archived='only'` returns only
   * archived; `archived='include'` returns active + archived (never deleted);
   * `deleted='only'` returns only soft-deleted (spec/04 § Lifecycle). Sorted:
   * pinned first (most-recent pinnedAt), then most-recent lastUpdated.
   */
  listWithFilter(
    opts: {
      archived?: 'only' | 'include';
      deleted?: 'only';
      snoozed?: 'only' | 'include';
    } = {},
  ): ChatState[] {
    const all = this.chatState.list();
    const now = this.opts.now();
    // spec/04 § Snooze: snoozed ⇔ `snoozedUntil > now`, derived every call so a
    // lapsed snooze needs no event to reappear.
    const isSnoozed = (c: ChatState): boolean =>
      c.snoozedUntil !== null && c.snoozedUntil > now && c.status === 'active';
    const filtered = all.filter((c) => {
      // spec/02 § Native subagent dispatch — a `patch_delegate` subagent is
      // never in ANY listing, whatever filter was asked for (not even
      // `deleted:'only'` or `archived:'include'`): the only way into one is
      // the parent's own tool row.
      if (c.subagent) return false;
      // Soft-deleted chats live only in their own view — never in the active or
      // archived lists.
      if (opts.deleted === 'only') return c.status === 'deleted';
      if (c.status === 'deleted') return false;
      if (opts.snoozed === 'only') return isSnoozed(c);
      if (opts.archived === 'only') return c.status === 'archived';
      if (opts.snoozed !== 'include' && isSnoozed(c)) return false;
      if (opts.archived === 'include') return true;
      return c.status !== 'archived';
    });
    return filtered.sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      if (a.pinned && b.pinned) {
        return (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0);
      }
      return b.lastUpdated - a.lastUpdated;
    });
  }

  async sendInput(req: SendInputOptions): Promise<void> {
    const state = this.chatState.get(req.chatId);
    if (!state) throw new ChatNotFoundError(req.chatId);
    if (this.movingOut.has(req.chatId)) {
      throw new Error('This chat is moving to another host; send it again once it has arrived.');
    }

    // spec/20-hooks.md § On the agent's response — an `advise` outcome rides
    // with the chat's NEXT turn, whichever origin it turns out to have. The
    // note is prepended to the actual message text (visible in the transcript
    // AND in what the agent reads — no invisible injection), so this is the
    // one place every turn funnels through regardless of where it came from.
    // Consumed once: cleared the instant it's attached, win or lose the race
    // with whatever else is about to run.
    // spec/06 § Manager failover — the conversation the Manager is picking up
    // from, given with its next message. Shown as a disclosed system reminder,
    // like any other context the host adds, and given once.
    const handoff = this.threadHandoffs.get(req.chatId);
    if (handoff !== undefined) {
      this.threadHandoffs.delete(req.chatId);
      this.opts.onHandoffConsumed?.(req.chatId);
      req.message = `<system-reminder>\n${handoff}\n</system-reminder>\n\n${req.message}`;
    }
    if (state.pendingHookAdvice.length > 0) {
      const notes = state.pendingHookAdvice;
      state.pendingHookAdvice = [];
      req.message = `${buildHookAdviceBlock(notes)}${req.message}`;
    }

    // Any send un-archives (Todoist 6hXRrVfCVgCrvC86): archived means stopped
    // (spec/04 § Lifecycle), and a message landing in the chat — the user's,
    // a job's, another agent's `patch_send_to` — is exactly what starts it
    // again. It comes back to where it was: `hidden` survives archiving, so a
    // hidden job's chat returns to Hidden, and only a person's message (below)
    // brings it into the list. `setArchived`/`setHidden` emit the state
    // themselves, so this doesn't need its own emit.
    if (state.status === 'archived') await this.setArchived(req.chatId, false);
    if (req.fromUser === true && state.hidden) await this.setHidden(req.chatId, false);

    // spec/04 § Branching — `chat.input` can address a specific branch. Only
    // a branch OTHER than the active one is routed to the independent
    // per-branch pump (`sendToBranch`): naming the active branch (or naming
    // none, the default) is indistinguishable from today's behaviour and
    // keeps running through the single pump below, unchanged.
    if (req.branchId !== undefined) {
      const meta = this.opts.metaStore.read(req.chatId);
      const activeBranchId = meta?.activeBranchId ?? this.branchIdFor(req.chatId);
      if (req.branchId !== activeBranchId) {
        if (!meta?.branches?.some((b) => b.branchId === req.branchId)) {
          throw new Error(`sendInput: chat ${req.chatId} has no branch ${req.branchId}`);
        }
        await this.sendToBranch({
          chatId: req.chatId,
          branchId: req.branchId,
          message: req.message,
          localId: req.localId,
        });
        return;
      }
    }

    let seen = this.seenLocalIds.get(req.chatId);
    if (!seen) {
      // Every localId the chat has ever accepted a turn under, from its history
      // log — so a surface redelivering one after a host restart is still
      // recognised as a redelivery.
      seen = new Set(this.chatLog.localIds(req.chatId));
      this.seenLocalIds.set(req.chatId, seen);
    }
    if (seen.has(req.localId) && !req.redeliver) {
      // spec/12 § Guaranteed input delivery — a duplicate is a REDELIVERY (the
      // surface's pending-timeout retry, or a reconnect flush). Re-emit the ack
      // so the surface's retry is answered and its pending state retires, but do
      // NOT run the turn again (idempotency: the first delivery already ran/queued
      // it). This is what makes the surface's blind retry safe.
      this.emit({ type: 'chat.input_ack', chatId: req.chatId, localId: req.localId });
      this.noteInputAccepted(req.chatId, req.localId);
      this.opts.logger.info(
        { chatId: req.chatId, localId: req.localId },
        'duplicate localId, re-acked without re-running',
      );
      return;
    }
    seen.add(req.localId);
    // spec/14 § Sidebar ordering — the user's own last activity on this chat
    // is what sidebar ordering sorts by, never `lastUpdated` (an agent reply,
    // a status change, a job tick or a finished turn never moves a row).
    // `fromUser` is already the "a person sent this" signal spec/04 § Hidden
    // uses, so it doubles as this one. Stamped at ACCEPT time, not when the
    // turn starts running, so a message that queues behind another still
    // moves the chat's row the moment it's sent, not once it's dequeued.
    if (req.fromUser === true) {
      state.lastUserActivity = this.opts.now();
      this.opts.metaStore.update(req.chatId, (m) => ({
        ...m,
        lastUserActivity: state.lastUserActivity,
      }));
    }
    // patch/todo.md — "allow the user to turn them on and off": mirror the
    // surface's live per-chat OFF set onto chat state so it applies to THIS turn
    // and any that queue behind it. Sent with every input, so a turn with no
    // `disabledTools` clears the set (tools switched back on take effect at once).
    state.disabledTools = req.disabledTools;
    // spec/12 § Guaranteed input delivery — positive receipt the moment the
    // host accepts the input (before any output streams). Covers BOTH paths
    // below (run-now and queued-behind-a-running-turn), since it precedes the
    // `pumping` branch. The server relays it to the originating surface, which
    // retires the message's `pending` state — never a silent forever-spinner.
    this.emit({ type: 'chat.input_ack', chatId: req.chatId, localId: req.localId });
    this.noteInputAccepted(req.chatId, req.localId);

    // patch/todo.md — "the status update for a chat is out of date as soon as
    // you send a new message, it should clear that" (spec/04 § Current status).
    // The summary describes the turn that just SETTLED; the moment the user adds
    // another message it is stale, so clear it at accept time (this also covers
    // a message that queues behind a running turn) and tell surfaces at once.
    // It stays null until this turn's own generation lands — a generation that
    // fails leaves it null rather than resurrecting the previous turn's line.
    // A DECLARED status (spec/04 § Current status) is cleared here too, and
    // ONLY here: the user putting a turn in is the one event that is evidence
    // they saw it. A machine turn — a self-wake, a job tick, another agent's
    // `patch_send_to` — is the chat carrying on by itself, and letting that
    // clear the mark is how "I need you to plug the drive in" would disappear
    // overnight without anybody reading it.
    if (req.origin !== 'machine' && state.declaredStatus !== null) {
      state.declaredStatus = null;
      this.opts.metaStore.update(req.chatId, (m) => ({
        ...m,
        declaredStatus: null,
        updatedAt: this.opts.now(),
      }));
    }
    // spec/09 § What the message says — the previous turn's closing text goes
    // stale the instant a new message is accepted, exactly as the generated
    // summary below does. Cleared at ACCEPT time and not only when the next turn
    // goes `running`, because a queued message can sit behind a whole turn
    // before `runQuery` reaches it.
    //
    // NOT gated on `declaredStatus`: a status the agent declared outranks a
    // model's generated summary, which is what that guard protects, but it says
    // nothing about what the last turn happened to close with.
    //
    // And it does NOT emit a frame of its own. No surface renders this field —
    // it exists for the server's chat-completion doorbell, which reads the
    // running → idle edge — and an extra `idle` frame here is an idle → idle
    // that is not a settle, which every reader watching that edge then has to
    // step over. The frame that starts the turn carries the cleared value a
    // moment later, which is soon enough for something nothing is looking at.
    state.turnSummary = null;
    if (
      (state.statusSummary !== null || state.statusKind !== null) &&
      state.declaredStatus === null
    ) {
      state.statusSummary = null;
      state.statusKind = null;
      this.emitState(req.chatId);
    }

    // The prompt is built AROUND the typed text: `head` is everything folded in
    // front of it (voice prefix, broadcast reminder, todo-edit reminder) and the
    // attachment block goes after it. Kept apart rather than only concatenated
    // so a queued turn's typed text can be edited in place without losing any
    // of it (spec/04 ## Message queueing § Edit). `head` is null only when a
    // rewrite did not keep the typed text as its suffix — then there is no
    // typed text to swap and the turn cannot be edited.
    const body = `${req.voicePrefix ?? ''}${req.message}`;
    let head: string | null = req.voicePrefix ?? '';
    let rewrittenWhole = '';
    if (this.opts.preprocessInput) {
      const rewritten = this.opts.preprocessInput(req);
      if (rewritten !== undefined) {
        if (rewritten.endsWith(body)) {
          head = rewritten.slice(0, rewritten.length - req.message.length);
        } else {
          head = null;
          rewrittenWhole = rewritten;
        }
      }
    }

    // spec/02 § Task list — the user edited this chat's task list from a
    // surface. The agent's TodoWrite state is inside its session and can't be
    // written from out here, so tell it on this turn and clear the flag: one
    // reminder per edit, not on every subsequent turn.
    if (state.todosEditedBySurface) {
      state.todosEditedBySurface = false;
      const reminder = buildTodoEditSystemReminder(state.todos);
      if (head !== null) head = reminder + head;
      else rewrittenWhole = reminder + rewrittenWhole;
    }

    // spec/04 § Hidden — the user hid or showed this chat since the agent's
    // last turn; one reminder per change.
    if (state.hiddenNotice !== null) {
      const reminder = buildHiddenSystemReminder(state.hiddenNotice);
      state.hiddenNotice = null;
      if (head !== null) head = reminder + head;
      else rewrittenWhole = reminder + rewrittenWhole;
    }

    // spec/04 § Goals — the goal was set, replaced or cleared since the agent's
    // last turn; one reminder per change.
    if (state.goalNotice !== null) {
      const reminder = buildGoalSystemReminder(state.goalNotice.goal);
      state.goalNotice = null;
      if (head !== null) head = reminder + head;
      else rewrittenWhole = reminder + rewrittenWhole;
    }

    // spec/04 § Send back — a side branch's conclusion owed to this turn
    // (this turn targets the active branch here; a non-active `branchId`
    // already returned via `sendToBranch`, above, which folds the same way).
    const sendBackReminder = this.consumeBranchSendBacks(
      req.chatId,
      this.opts.metaStore.read(req.chatId)?.activeBranchId ?? this.branchIdFor(req.chatId),
    );
    if (sendBackReminder !== '') {
      if (head !== null) head = sendBackReminder + head;
      else rewrittenWhole = sendBackReminder + rewrittenWhole;
    }

    // spec/14 § Document editor — any `.md` file a surface saved since the
    // agent last saw it, as a diff.
    // spec/07 § Keeping voice and text as one conversation — what the fast
    // voice said on this chat that the agent never saw.
    const voiceReminder = this.consumeVoiceExchanges(req.chatId);
    if (voiceReminder !== '') {
      if (head !== null) head = voiceReminder + head;
      else rewrittenWhole = voiceReminder + rewrittenWhole;
    }

    const documentDiffReminder = this.consumeDocumentDiffs(req.chatId);
    if (documentDiffReminder !== '') {
      if (head !== null) head = documentDiffReminder + head;
      else rewrittenWhole = documentDiffReminder + rewrittenWhole;
    }

    // spec/07 § The fast voice and the chat's agent — a hand-off lands in whatever
    // the chat was doing. Without this the agent treats it as an interjection and
    // carries on with the earlier work, and every spoken request fans out into it.
    if (req.voicePrefix?.startsWith('[voice hand-off')) {
      if (head !== null) head = VOICE_HANDOFF_REMINDER + head;
      else rewrittenWhole = VOICE_HANDOFF_REMINDER + rewrittenWhole;
    }

    // spec/14 § Document editor — comments both ways: a user comment or
    // reply left on a document since the agent last saw it.
    const docCommentsReminder = this.consumeDocComments(req.chatId);
    if (docCommentsReminder !== '') {
      if (head !== null) head = docCommentsReminder + head;
      else rewrittenWhole = docCommentsReminder + rewrittenWhole;
    }

    // spec/14 & spec/15 § Composer — fold attachment paths into the turn so the
    // agent reads the files. Each ref was stored under the chat's dir by
    // `storeAttachment`; resolve it to its absolute on-disk path (NO FALLBACK: a
    // ref with no file on disk throws, failing the turn rather than silently
    // dropping the attachment). The block is plain data appended to the prompt —
    // Claude's Read tool handles images and text by path.
    let block: string | undefined;
    if (req.attachments && req.attachments.length > 0) {
      const lines = req.attachments.map((att) => {
        const path = this.resolveAttachmentPath(req.chatId, att);
        return attachmentLine(att.kind, path, att.name);
      });
      block = `${ATTACHMENT_BLOCK_HEADER}\n${lines.join('\n')}`;
    }
    const withBlock = (m: string): string =>
      block === undefined ? m : m.length > 0 ? `${m}\n\n${block}` : block;
    const promptHead = head;
    const compose =
      promptHead === null ? undefined : (typed: string): string => withBlock(promptHead + typed);
    const message = compose ? compose(req.message) : withBlock(rewrittenWhole);

    // spec/02 § Questions are not approvals — a message sent while the agent's
    // own question is still on screen IS the answer, so cancel the question
    // rather than parking behind it. Without this the typed message is accepted
    // and queued and then goes nowhere: the running turn is blocked inside
    // `canUseTool` on the question's gate, which nothing but a hand-pressed
    // Cancel (or the expiry window running out) resolves.
    //
    // Done HERE, above the queueing decision, for two reasons. Every surface
    // gets it — nothing about "I typed instead of answering" is web-specific,
    // and a mobile/CLI/voice send must behave the same. And the running turn is
    // already unblocked by the time this turn queues behind it, so the drain
    // that follows is the ordinary one.
    //
    // Only a PERSON's message is an answer. A machine-started turn (self-wake,
    // `patch_send_to`, todo advance), a job fire, a hook or goal resubmit says
    // nothing about the question: letting it through denied the question the
    // user was in the middle of answering, so their submitted answers hit a
    // gone gate and the agent was told "the user replied with a message".
    // Those turns queue behind the question like any other pending approval.
    let questionsCancelled = 0;
    const isAnswerByMessage =
      req.origin !== 'machine' &&
      req.jobTrigger !== true &&
      req.hookTrigger === undefined &&
      req.goalTrigger === undefined;
    if (isAnswerByMessage) {
      questionsCancelled = this.cancelPendingPermissions(req.chatId, {
        questionsOnly: true,
        denyMessage: QUESTION_SUPERSEDED_MESSAGE,
        reason: 'cancelling pending AskUserQuestion: the user sent a message instead',
      });
    }

    // spec/04 ## Message queueing (parity with Claude Code's type-ahead): if a
    // turn is already running for this chat, QUEUE this one behind it rather
    // than rejecting it. The serial pump runs queued turns in arrival order
    // once the current turn finishes. `pumping` is the single in-flight guard,
    // set synchronously before the pump's first await, so this check can't race.
    if (this.pumping.has(req.chatId)) {
      if (req.nudge) {
        // A nudge replaces a queued nudge, and yields to any real queued message.
        this.flushQueuedNudges(req.chatId);
        if (this.hasQueuedTurns(req.chatId)) return;
      }
      this.enqueueQueued(
        req.chatId,
        message,
        req.localId,
        req.fork,
        req.origin,
        req.retryOfSeq,
        req.jobTrigger,
        req.hookTrigger,
        req.goalTrigger,
        {
          text: req.message,
          ...(compose ? { compose } : {}),
        },
        req.nudge,
      );
      // A turn that was parked on a question was not working, so the message
      // that replaced the question must not wait for the agent to finish its
      // reply to the refusal: interrupt it and let the queue drain now.
      if (questionsCancelled > 0) await this.stopChat(req.chatId);
      return;
    }
    // Idle: run THIS turn now, then drain anything that queues up while it (and
    // each subsequent queued turn) runs. Awaiting the full drain preserves the
    // "await sendInput ⇒ my turn ran" contract callers/tests rely on.
    await this.runTurnsFrom(
      req.chatId,
      message,
      req.fork,
      req.localId,
      req.origin,
      req.retryOfSeq,
      req.jobTrigger,
      req.hookTrigger,
      req.goalTrigger,
    );
  }

  private noteInputAccepted(chatId: string, localId: string): void {
    this.inputAcceptWaiters.get(`${chatId}\u0000${localId}`)?.();
  }

  /**
   * `sendInput`, for a caller that wants to know the message was taken, not that
   * the turn it started is over. Resolves once the host has accepted the input
   * (acknowledged it, and either started its turn or queued it behind the one
   * running), and rejects if it is refused first (an unknown chat, a chat that is
   * moving). The turn goes on afterwards: how it ends belongs to the chat, which
   * says so itself, and is not the sender's to wait for.
   *
   * This is what an agent's `patch_send_to` uses: waiting for the whole of the
   * target's turn held the sender inside its own turn for as long as the other
   * chat worked, and past its tool timeout for a long one.
   */
  async submitInput(req: SendInputOptions): Promise<void> {
    const key = `${req.chatId}\u0000${req.localId}`;
    let accept!: () => void;
    const accepted = new Promise<void>((resolve) => (accept = resolve));
    this.inputAcceptWaiters.set(key, accept);
    const run = this.sendInput(req);
    // After acceptance a failed run is the chat's own error; it must not also
    // surface as an unhandled rejection here.
    run.catch((err: unknown) => {
      this.opts.logger.warn(
        { chatId: req.chatId, err: err instanceof Error ? err.message : String(err) },
        'submitInput: the turn it started failed',
      );
    });
    try {
      await Promise.race([accepted, run]);
    } finally {
      this.inputAcceptWaiters.delete(key);
    }
  }

  /**
   * Stamp the origin of the DRAIN on the chat before it settles. A drain the
   * user put a turn into is news for the user even if a machine turn ran last.
   */
  private settleTurnOrigin(chatId: string): void {
    if (!this.drainHadUserTurn.delete(chatId)) return;
    const state = this.chatState.get(chatId);
    if (state) state.turnOrigin = 'user';
  }

  /**
   * True when this chat still owes turns to the pump, so whatever just ended
   * must NOT report `idle`: `drainQueue` starts the next one on the very next
   * tick (spec/04 § Activity across a drain). A chat that blinks `idle`
   * mid-queue is read everywhere as having finished — the server's
   * chat-completion notifier (spec/09 § Chat completion) pushes "<chat>
   * finished", the Manager watch loop (spec/06) raises it as needing a look,
   * and every surface flashes a done badge — while it is still working.
   */
  /**
   * Chats with a turn running or a queue draining — what a restart of this
   * process would cut off. Self-update holds its installer until this is empty.
   */
  runningChatIds(): string[] {
    return [...this.pumping];
  }

  private hasQueuedTurns(chatId: string): boolean {
    return (this.turnQueues.get(chatId)?.length ?? 0) > 0;
  }

  /**
   * Own the per-chat serial pump: run `firstMessage`, then drain any turns that
   * queued up while it (and each subsequent turn) ran. The single execution path
   * for both a fresh idle turn (`sendInput`) and a spawn's initial prompt — so
   * input arriving during the spawn turn queues correctly too.
   */
  private async runTurnsFrom(
    chatId: string,
    firstMessage: string,
    fork?: ForkRun,
    localId?: string,
    origin?: TurnOrigin,
    retryOfSeq?: number,
    jobTrigger?: boolean,
    hookTrigger?: HookTriggerInfo,
    goalTrigger?: GoalTriggerInfo,
  ): Promise<void> {
    this.pumping.add(chatId);
    try {
      const committed = await this.runQuery(
        chatId,
        firstMessage,
        fork,
        localId,
        origin,
        retryOfSeq,
        jobTrigger,
        hookTrigger,
        goalTrigger,
      );
      // Only signal turn-commit when the agent actually produced a response.
      // spec/09 ## Broadcast context ## Flush: a failed agent invocation (SDK
      // error, OAuth gap, folder/session preflight) does NOT flush the sidecar.
      if (committed) this.opts.onTurnCommitted?.(chatId);
      await this.drainQueue(chatId);
    } finally {
      this.pumping.delete(chatId);
      // Normally empty. When a turn threw, whatever queued behind it is dropped
      // here — each was announced with `chat.queued`, so say it is gone or the
      // surface shows it as QUEUED forever.
      for (const abandoned of this.turnQueues.get(chatId) ?? []) {
        this.emit({
          type: 'chat.dequeued',
          chatId,
          localId: abandoned.localId,
          reason: 'cancelled',
        });
      }
      this.turnQueues.delete(chatId);
      this.queueSeqCounter.delete(chatId);
      // spec/02 § Self-wake — "count the interval from the end of the turn":
      // the chat's pump is genuinely empty now, so this is what arms a loop
      // that was left `waiting` on it (its own just-finished delivery, or an
      // unrelated turn that collided with a tick). No-op for every chat
      // without one.
      const rearmedLoop = this.wake.onTurnEnd(chatId);
      // A settled turn only hands `running` on to the next queued turn (see
      // runQuery), so the pump is what finally settles the chat — and it must do
      // that however it ended. When `runQuery` throws, the queue behind it is
      // abandoned right here and no turn is left to emit the idle: without this
      // the chat would claim to be running forever. Anything the turn itself
      // settled on (idle, errored, awaiting-permission) is left alone.
      if (this.chatState.get(chatId)?.activity === 'running') {
        this.settleTurnOrigin(chatId);
        this.chatState.setActivity(chatId, 'idle');
        this.emitState(chatId);
      } else if (rearmedLoop) {
        // The turn settled on something other than idle (errored,
        // awaiting-permission — its own code already emitted that), so the
        // branch above won't re-emit. The loop's next `fireAt` just moved —
        // say so, or the wake bar sits on a stale time until something else
        // happens to touch this chat's state.
        this.emitState(chatId);
      }
      this.drainHadUserTurn.delete(chatId);
      // The pump is done, so the chat owes nothing. Clears the crash marker even
      // when `runQuery` threw before its own finally could (a preflight failure
      // leaves the queue behind it un-drained).
      this.persistPendingTurns(chatId);
    }
  }

  /** Run queued turns FIFO until the queue empties (spec/04 ## Message queueing). */
  private async drainQueue(chatId: string): Promise<void> {
    for (;;) {
      // A stop that ended the turn we just awaited has to be on the wire before
      // the next turn is announced as running, or the surface pins the stop on
      // the wrong message (see `announceStopped`).
      this.announceStopped(chatId);
      const item = this.turnQueues.get(chatId)?.shift();
      if (!item) return;
      // It was announced via chat.queued → tell surfaces it's now running, so
      // they flip it from a pending chip to a live user turn.
      this.emit({ type: 'chat.dequeued', chatId, localId: item.localId, reason: 'running' });
      const committed = await this.runQuery(
        chatId,
        item.message,
        item.fork,
        item.localId,
        item.origin,
        item.retryOfSeq,
        item.jobTrigger,
        item.hookTrigger,
        item.goalTrigger,
      );
      if (committed) this.opts.onTurnCommitted?.(chatId);
    }
  }

  /**
   * Hand the chat's waiting messages to the agent at a tool boundary instead of
   * leaving them for after the whole turn (spec/04 § Message delivery).
   *
   * Takes the leading run of plain messages from the queue, in order, and stops
   * at the first turn that needs a run of its own (a fork, a job, a hook or goal
   * resubmit), so nothing is delivered ahead of a turn that was queued before
   * it. Each one is recorded in the transcript at this point and announced as
   * delivered. Returns the text to put in front of the agent, or undefined when
   * nothing was waiting.
   */
  private deliverQueuedAtBoundary(chatId: string): string | undefined {
    const queue = this.turnQueues.get(chatId);
    if (!queue || queue.length === 0) return undefined;
    const delivered: QueuedTurn[] = [];
    while (queue.length > 0) {
      const item = queue[0]!;
      if (item.fork || item.jobTrigger || item.hookTrigger || item.goalTrigger) break;
      const content = persistedUserContent(item.message);
      if (content !== null) {
        const systemContext = extractSystemContext(item.message);
        try {
          this.emit({
            type: 'chat.message',
            chatId,
            role: 'user',
            content,
            seq: this.bumpSeq(chatId),
            createdAt: this.opts.now(),
            localId: item.localId,
            midTurn: true,
            ...(systemContext.length > 0 ? { systemContext } : {}),
          });
        } catch (err) {
          if (!(err instanceof HistoryWriteError)) throw err;
          // Not recorded, so not delivered: it stays queued and runs as its own turn.
          break;
        }
      }
      queue.shift();
      delivered.push(item);
      this.emit({
        type: 'chat.dequeued',
        chatId,
        localId: item.localId,
        reason: 'running',
        delivered: true,
      });
      if (item.origin !== 'machine') this.drainHadUserTurn.add(chatId);
    }
    if (delivered.length === 0) return undefined;
    this.persistPendingTurns(chatId);
    return delivered
      .map((item) =>
        item.origin === 'machine'
          ? `An automatic message arrived while you were working:\n\n${item.message}`
          : `The user sent a message while you were working:\n\n${item.message}`,
      )
      .join('\n\n');
  }

  /** Drop every queued sweep nudge from the chat's queue, announcing each as cancelled. */
  private flushQueuedNudges(chatId: string): void {
    const q = this.turnQueues.get(chatId);
    if (!q?.some((it) => it.nudge)) return;
    const kept: QueuedTurn[] = [];
    for (const it of q) {
      if (it.nudge)
        this.emit({ type: 'chat.dequeued', chatId, localId: it.localId, reason: 'cancelled' });
      else kept.push(it);
    }
    this.turnQueues.set(chatId, kept);
    this.persistPendingTurns(chatId);
  }

  /** Append a turn to the chat's queue and announce it (`chat.queued`). */
  private enqueueQueued(
    chatId: string,
    message: string,
    localId: string,
    fork: ForkRun | undefined,
    origin: TurnOrigin | undefined,
    retryOfSeq: number | undefined,
    jobTrigger: boolean | undefined,
    hookTrigger: HookTriggerInfo | undefined,
    goalTrigger: GoalTriggerInfo | undefined,
    typed: { text: string; compose?: (text: string) => string },
    nudge?: boolean,
  ): void {
    const q = this.turnQueues.get(chatId) ?? [];
    const queueSeq = (this.queueSeqCounter.get(chatId) ?? 0) + 1;
    this.queueSeqCounter.set(chatId, queueSeq);
    q.push({
      message,
      localId,
      queueSeq,
      text: typed.text,
      ...(typed.compose ? { compose: typed.compose } : {}),
      ...(fork ? { fork } : {}),
      ...(origin ? { origin } : {}),
      ...(retryOfSeq !== undefined ? { retryOfSeq } : {}),
      ...(jobTrigger ? { jobTrigger } : {}),
      ...(hookTrigger ? { hookTrigger } : {}),
      ...(goalTrigger ? { goalTrigger } : {}),
      ...(nudge ? { nudge } : {}),
    });
    this.turnQueues.set(chatId, q);
    this.persistPendingTurns(chatId);
    this.emit({ type: 'chat.queued', chatId, localId, message: typed.text, queueSeq });
  }

  /**
   * Mirror "what this chat still owes the agent" — the running turn plus its
   * queue — to meta.json, so a host that is killed mid-turn leaves a record of
   * exactly what died. `hydrate` re-sends it (see `resumeInterruptedTurns`).
   *
   * Called whenever the pump's contents change. Cheap enough to do eagerly: the
   * write is the same atomic meta.json rewrite the seq mirror already performs
   * after every emit, and the pump changes far less often than that.
   *
   * A chat whose meta.json is gone (deleted mid-turn) has nothing to record and
   * nothing to resume, so a missing file is not an error here.
   */
  private persistPendingTurns(chatId: string): void {
    const running = this.runningTurn.get(chatId);
    const parked = this.parkedTurns.get(chatId);
    const queued = this.turnQueues.get(chatId) ?? [];
    // A parked turn is not running (its attempt already failed) and not queued
    // (nothing is pumping it), but it is still owed. Persist it in the same
    // list so a restart mid-park resumes it instead of forgetting it.
    const pendingTurns: PendingTurn[] = [
      ...(running ? [running] : []),
      ...(parked ? [parked] : []),
      // Only what a restart needs to re-send the turn. A queued turn's typed
      // text and prompt builder are live-editing state (spec/04 ## Message
      // queueing § Edit): an edit rewrites `message` itself, so the persisted
      // prompt is always the current one.
      ...queued.map(
        (q): PendingTurn => ({
          message: q.message,
          localId: q.localId,
          ...(q.fork ? { fork: q.fork } : {}),
          ...(q.origin ? { origin: q.origin } : {}),
          ...(q.retryOfSeq !== undefined ? { retryOfSeq: q.retryOfSeq } : {}),
          ...(q.jobTrigger ? { jobTrigger: q.jobTrigger } : {}),
        }),
      ),
    ];
    if (!this.opts.metaStore.read(chatId)) return;
    this.opts.metaStore.update(chatId, (m) => ({
      ...m,
      pendingTurns,
      updatedAt: this.opts.now(),
    }));
  }

  /** A reset the failure itself states and that is still ahead, structured first. */
  private statedResetOf(limit: LimitFacts | undefined, errMsg: string): number | undefined {
    const now = this.opts.now();
    const at = limit?.resetsAt ?? parseLimitResetsAt(errMsg, now);
    return at !== undefined && at > now ? at : undefined;
  }

  /**
   * WHY this chat is blocked, in figures — the structured account of a limit
   * that the surfaces render instead of the provider's sentence (spec/12).
   *
   * Set on both limit paths, because what differs between them is only whether
   * a resume was scheduled: a limit nobody parked is still a limit, and gating
   * this on a resume time is what left that case with nothing to show.
   */
  private setLimitBlock(
    chatId: string,
    errMsg: string,
    limit: LimitFacts | undefined,
    /**
     * A reset the caller read off the failure or the account's own windows.
     * Only ever a STATED one — never the instant an auto-resume was armed for,
     * which falls back to a made-up minute when nothing stated anything.
     */
    statedResetsAt: number | undefined,
  ): void {
    const ranOn = this.runningOnAccount.get(chatId);
    const info = this.opts.accountLimitInfo?.(ranOn);
    // The probe's reset is preferred over the one the failure states: it is the
    // window's own figure, and the failure names whichever window Claude Code
    // felt like mentioning. `stated` also drops a non-positive value: nobody's
    // window resets at epoch 0, so a 0 that reached this far (from either
    // source) is treated the same as no reset stated, not as a real one — the
    // `??` chain below only skips null/undefined, and a 0 would otherwise
    // survive it and render as a ~56-year-old countdown.
    const stated = (v: number | undefined): number | undefined =>
      v !== undefined && v > 0 ? v : undefined;
    const resetsAt = stated(info?.resetsAt) ?? stated(limit?.resetsAt) ?? stated(statedResetsAt);
    const routing = this.opts.accountRouting?.(this.chatState.get(chatId)?.model);
    this.limitBlocks.set(chatId, {
      ...(routing !== undefined ? { routing } : {}),
      ...(ranOn !== undefined ? { accountId: ranOn } : {}),
      ...(info?.label !== undefined ? { accountLabel: info.label } : {}),
      scope: info?.scope ?? 'unknown',
      ...(info?.utilization !== undefined ? { utilization: info.utilization } : {}),
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      ...(info?.overageBlocked !== undefined ? { overageBlocked: info.overageBlocked } : {}),
      ...(info?.overageReason !== undefined ? { overageReason: info.overageReason } : {}),
      // The provider's sentence, kept where a diagnosis needs it and nowhere a
      // reader is shown it as the failure.
      raw: errMsg.slice(0, 300),
    });
  }

  /**
   * Record a turn as owed while it waits out a retry, and write that to disk.
   * The in-memory timer is the fast path; meta.json is what survives a deploy.
   */
  private parkTurn(
    chatId: string,
    message: string,
    localId: string | undefined,
    /**
     * spec/12 § A turn is owed until it settles — the seq of the user bubble
     * this turn is already drawn as, so the re-send folds back onto it. Carried
     * on the park too, so a host restarted mid-park resumes onto the same
     * bubble the in-process ladder would have.
     */
    retryOfSeq: number | undefined,
  ): void {
    // spec/09 § Whose turn it was — a park is the SAME turn waiting to go round
    // again, so it keeps the origin it already had. Read off chat state, which
    // still holds the origin of the turn that just failed.
    const origin = this.chatState.get(chatId)?.turnOrigin;
    this.parkedTurns.set(chatId, {
      message,
      ...(localId !== undefined ? { localId } : {}),
      ...(origin && origin !== 'user' ? { origin } : {}),
      ...(retryOfSeq !== undefined ? { retryOfSeq } : {}),
    });
    this.persistPendingTurns(chatId);
  }

  /** The park is over — the turn is about to be re-sent, or has been dropped. */
  private unparkTurn(chatId: string): void {
    if (!this.parkedTurns.delete(chatId)) return;
    this.persistPendingTurns(chatId);
  }

  /**
   * Re-send a turn that died on a transient SDK failure, with a widening
   * backoff and a hard ceiling.
   *
   * The rate-limit branch above handles the failure whose reset time we know;
   * this handles the rest, where we do not. Three attempts at 10s / 30s / 90s
   * covers a connection blip or a brief API fault without hammering a service
   * that is genuinely down, and the ceiling means a chat that fails for a real
   * reason still settles into `errored` rather than looping forever.
   *
   * NOT retried, deliberately: a user stop (the aborted-signal check returns
   * before this), a refused credential (no amount of retrying fixes it) and a
   * dead session (its own branch clears the session id so the NEXT turn starts
   * fresh - retrying that one here would race the clear).
   */
  private scheduleSdkRetry(
    chatId: string,
    prompt: string,
    errMsg: string,
    /**
     * spec/12 § A turn is owed until it settles — the seq of the user message
     * this turn is already drawn as. Every rung carries the ORIGINAL's seq, not
     * the previous rung's, so three retries leave ONE bubble with three attempts
     * hanging off it rather than a chain of three bubbles.
     */
    retryOfSeq: number | undefined,
  ): void {
    const attempt = (this.sdkRetryCount.get(chatId) ?? 0) + 1;
    if (attempt > SDK_RETRY_BACKOFF_MS.length) {
      this.opts.logger.error(
        { chatId, attempt, err: errMsg },
        'sdk error: retries exhausted, leaving the chat errored',
      );
      return;
    }
    this.sdkRetryCount.set(chatId, attempt);
    this.parkTurn(chatId, prompt, undefined, retryOfSeq);
    const delayMs = SDK_RETRY_BACKOFF_MS[attempt - 1] ?? 0;
    this.opts.logger.warn({ chatId, attempt, delayMs, err: errMsg }, 'sdk error: scheduling retry');
    const existing = this.sdkRetryTimers.get(chatId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.sdkRetryTimers.delete(chatId);
      this.unparkTurn(chatId);
      // A turn that arrived while we were waiting has already revived the
      // chat, and a stop or delete means nobody wants this one any more.
      const cur = this.chatState.get(chatId);
      if (!cur || cur.activity !== 'errored') return;
      // A FRESH localId per attempt, never the original turn's: (chatId,
      // localId) is the idempotency key, so re-sending under the failed turn's
      // id is silently deduped and the retry never happens. That made the
      // second and third rungs of the ladder unreachable.
      void this.sendInput({
        chatId,
        message: prompt,
        localId: `sdk-retry-${chatId}-${attempt}-${this.opts.now()}`,
        // spec/09 § Whose turn it was — a retry is the same turn, so it settles
        // as whatever it was. A user turn that had to go round the error ladder
        // still notifies once; a wake tick that did still says nothing.
        ...(cur.turnOrigin ? { origin: cur.turnOrigin } : {}),
        // The fresh localId above is what makes the host RUN this rung at
        // all; this is what stops every surface drawing it as a second message.
        ...(retryOfSeq !== undefined ? { retryOfSeq } : {}),
      }).catch((err: unknown) => {
        this.opts.logger.error({ chatId, err }, 'sdk error: retry could not be sent');
      });
    }, delayMs);
    timer.unref?.();
    this.sdkRetryTimers.set(chatId, timer);
  }

  /**
   * Cancel a still-pending queued turn (spec/04 ## Message queueing) — the user
   * removed a queued message before it ran. No-op if it already started running
   * (stop it with `stopChat` instead) or never existed. Echoes
   * `chat.dequeued{ reason: 'cancelled' }`.
   */
  unqueueInput(chatId: string, localId: string): void {
    const q = this.turnQueues.get(chatId);
    if (!q) return;
    const idx = q.findIndex((it) => it.localId === localId);
    if (idx < 0) return;
    q.splice(idx, 1);
    this.persistPendingTurns(chatId);
    this.emit({ type: 'chat.dequeued', chatId, localId, reason: 'cancelled' });
  }

  /**
   * Replace the typed text of a still-pending queued turn (spec/04 ## Message
   * queueing § Edit). The turn keeps its place, its attachments and whatever
   * was folded around the typed text when it was accepted; `chat.queued` is
   * re-announced with the same `localId` + `queueSeq`. A no-op if the turn
   * already started or never existed — an edit never runs as a new turn.
   */
  editQueuedInput(chatId: string, localId: string, text: string): void {
    const item = this.turnQueues.get(chatId)?.find((it) => it.localId === localId);
    if (!item) return;
    if (!item.compose) {
      // NO FALLBACK: swapping the whole prompt would drop what the host
      // folded around the typed text, so say so rather than guess.
      this.opts.logger.warn(
        { chatId, localId },
        'queued turn cannot be edited: its typed text is not separable from its prompt',
      );
      return;
    }
    item.message = item.compose(text);
    item.text = text;
    this.persistPendingTurns(chatId);
    this.emit({ type: 'chat.queued', chatId, localId, message: text, queueSeq: item.queueSeq });
  }

  /**
   * Promote a still-pending queued turn (spec/04 ## Message queueing — the "I
   * meant this instead, stop what you're doing" control): interrupts the
   * in-flight turn so the queue starts draining NOW instead of waiting for it
   * to finish naturally. It does NOT reorder the queue — turns queued above
   * the promoted one are already scheduled to run sooner and stay there;
   * pushing one turn pushes everything queued above it too, rather than
   * shoving those turns behind the one that was clicked. Turns queued below
   * it are unaffected — they were already behind it.
   *
   * NO FALLBACK: if `localId` isn't a still-pending queued turn, this is a
   * complete no-op — it never interrupts the running turn "anyway", which would
   * be a destructive surprise with nothing promoted to show for it.
   */
  async promoteInput(chatId: string, localId: string): Promise<void> {
    const q = this.turnQueues.get(chatId);
    if (!q) return;
    const idx = q.findIndex((it) => it.localId === localId);
    if (idx < 0) return;
    // Interrupting closes the SDK query; the pump's drainQueue then picks up
    // the queue head — already the promoted turn, or whatever was already
    // scheduled ahead of it.
    await this.stopChat(chatId);
  }

  async stopChat(chatId: string): Promise<void> {
    // spec/06 § Cross-chat tools — "archiving or stopping the parent stops
    // its subagents". Unconditional, before the early return below: a parent
    // that is itself idle (nothing of its OWN to abort) can still have a
    // subagent running, and that is exactly the case this cascade is for.
    // Started, not awaited, and stopped in parallel: Stop must abort THIS
    // chat's turn at once, not wait for each subagent to wind down first.
    const delegatesStopped = this.stopDelegatesOf(chatId);
    const ac = this.aborters.get(chatId);
    if (!ac) {
      // Idle already.
      await delegatesStopped;
      return;
    }
    // spec/04 § Message queueing — a turn parked on a permission request is
    // blocked inside `canUseTool`, and the abort below does not reach it: the
    // gate is a host-side promise the SDK is awaiting, so until it resolves
    // the run never settles, `await run` here never returns, `chat.stopped` is
    // never announced and every turn queued behind it waits out the expiry
    // window (an hour, for an approval). Stop ends the turn, so it ends what the
    // turn was paused on too. Resolved BEFORE the abort, so the abort is what
    // the settling run reports rather than a tool call resuming past it.
    this.cancelPendingPermissions(chatId, {
      questionsOnly: false,
      denyMessage: PERMISSION_STOPPED_MESSAGE,
      reason: 'cancelling outstanding permission request: the user stopped the turn',
    });
    this.stopAnnouncePending.add(chatId);
    // spec/09 § A turn the user stopped. Stamped on the state BEFORE the abort,
    // so whichever settling frame the aborted run produces already carries it —
    // `runQuery`'s own idle on a bare stop, or `runTurnsFrom`'s finally when the
    // queue behind it is abandoned. Inferring it from `chat.stopped` instead is
    // not open to the server: that event is emitted by a different awaiter of
    // the same run and lands AFTER the idle on a bare stop.
    const state = this.chatState.get(chatId);
    if (state) state.turnStopped = true;
    ac.abort();
    const run = this.runs.get(chatId);
    if (run) await run.catch(() => undefined);
    await delegatesStopped;
    // Backstop: if no queue drain got there first, announce it here.
    this.announceStopped(chatId);
  }

  /**
   * Emit `chat.stopped` ONCE, for whichever of the two awaiters of the aborted
   * run reaches it first.
   *
   * `chat.stopped` carries no localId, so surfaces attach it to the newest user
   * turn that is no longer queued (spec/14 § Running-turn controls). That only
   * works if it arrives BEFORE the next turn is announced as running — and it
   * did not. `stopChat` and the pump await the SAME run promise, and the pump
   * registered first, so on a promote the pump resumed first, `drainQueue`
   * emitted `chat.dequeued{running}` for the promoted turn, and only then did
   * `stopChat` emit the stop. The surface then stamped `Cancelled — turn
   * stopped` on the message that had just STARTED running, while the turn that
   * was actually interrupted got no label at all.
   *
   * So the drain announces the stop before it dequeues anything, and this stays
   * idempotent because `stopChat` still needs to announce when the queue is
   * empty and there is no drain to do it.
   */
  private announceStopped(chatId: string): void {
    if (!this.stopAnnouncePending.delete(chatId)) return;
    const stopped: ChatStoppedEvent = { type: 'chat.stopped', chatId, reason: 'user-stop' };
    this.emit(stopped);
  }

  // ---- Branching: a chat is a graph, not a line (spec/04 § Branching) -------

  /**
   * The chat's track graph, creating the ROOT branch on first use. A chat that
   * predates branching (or has simply never been forked) gets exactly one root
   * branch here — synthesised from the chat's current `claudeSessionId`, so the
   * graph and the session id can never disagree. Idempotent: once persisted it
   * is read back untouched.
   */
  private ensureBranches(chatId: string): { branches: PersistedBranch[]; activeBranchId: string } {
    const meta = this.opts.metaStore.read(chatId);
    if (!meta) throw new ChatNotFoundError(chatId);
    const existing = meta.branches;
    if (existing && existing.length > 0 && meta.activeBranchId) {
      return { branches: existing, activeBranchId: meta.activeBranchId };
    }
    const state = this.chatState.get(chatId);
    const root: PersistedBranch = {
      branchId: `${chatId}-b0`,
      parentBranchId: null,
      forkFromSeq: null,
      label: 'main',
      createdAt: meta.createdAt,
      ...(state?.claudeSessionId ? { sessionId: state.claudeSessionId } : {}),
    };
    this.opts.metaStore.update(chatId, (m) => ({
      ...m,
      branches: [root],
      activeBranchId: root.branchId,
      updatedAt: this.opts.now(),
    }));
    return { branches: [root], activeBranchId: root.branchId };
  }

  /** The chat's graph as the wire event surfaces render the track switcher from. */
  branchesEvent(chatId: string): ChatBranchesEvent {
    const { branches, activeBranchId } = this.ensureBranches(chatId);
    return {
      type: 'chat.branches',
      chatId,
      activeBranchId,
      // `sessionId`/`harnessSessions` are daemon-internal plumbing — surfaces
      // switch by branchId and never see which native session backs a track.
      branches: branches.map(({ sessionId: _drop, harnessSessions: _drop2, ...b }) => {
        void _drop;
        void _drop2;
        // spec/14 § Side threads panel — tab status dot. A side branch's own
        // pump (`sideBranchRunning`, below) is the one per-branch activity
        // signal the host tracks; the active branch's own running-ness is
        // already covered by `chat.state` and has no need of this field.
        const running = this.sideBranchRunning.has(this.branchKey(chatId, b.branchId));
        return running ? { ...b, running: true as const } : b;
      }),
    };
  }

  private emitBranches(chatId: string): void {
    this.emit(this.branchesEvent(chatId));
  }

  /**
   * Edit a user turn, forking a new TRACK from it (spec/04 § Branching).
   *
   * The prefix up to the turn BEFORE `seq` is shared; `message` replaces the
   * edited turn and runs as the first turn of a brand-new Claude session, so the
   * original track's transcript is untouched and stays switchable-to.
   *
   * NO FALLBACK: a `seq` that is not a user turn in this chat's transcript is a
   * `fork_point_not_found` error and creates no branch — forking from the end
   * instead would silently turn the edit into an ordinary new message.
   */
  async forkChat(req: {
    chatId: string;
    seq: number;
    message: string;
    localId: string;
  }): Promise<void> {
    const state = this.chatState.get(req.chatId);
    if (!state) throw new ChatNotFoundError(req.chatId);
    const graph = this.ensureBranches(req.chatId);

    const sessionId = state.claudeSessionId;
    const point =
      sessionId !== undefined && sessionId.length > 0
        ? this.historyReader.forkPoint({
            folder: state.folder,
            sessionId,
            seq: req.seq,
            seqIndex: this.canonicalSeqIndex(req.chatId),
            nativeDir: this.nativeClaudeDirFor(req.chatId),
          })
        : null;
    if (!point) {
      this.emit({
        type: 'chat.error',
        chatId: req.chatId,
        error: {
          code: 'fork_point_not_found',
          message: `no user turn at seq ${req.seq} to fork from`,
        },
        seq: OUT_OF_BAND_SEQ,
      });
      this.opts.logger.warn(
        { chatId: req.chatId, seq: req.seq },
        'fork refused: seq is not a user turn in this transcript (NO FALLBACK)',
      );
      return;
    }

    const branch: PersistedBranch = {
      branchId: `${req.chatId}-b${graph.branches.length}`,
      parentBranchId: graph.activeBranchId,
      forkFromSeq: req.seq,
      label: `edit ${graph.branches.length}`,
      createdAt: this.opts.now(),
    };
    this.opts.metaStore.update(req.chatId, (m) => ({
      ...m,
      branches: [...graph.branches, branch],
      activeBranchId: branch.branchId,
      updatedAt: this.opts.now(),
    }));
    this.branchIds.delete(req.chatId);
    this.emitBranches(req.chatId);

    // `state.claudeSessionId` is still the PARENT's: that is exactly what the
    // fork resumes from. The new session id arrives on the turn's `result`
    // envelope and is recorded onto this (now active) branch.
    await this.sendInput({
      chatId: req.chatId,
      message: req.message,
      localId: req.localId,
      fork: { resumeAtUuid: point.resumeAtUuid },
      // A fork or side message is typed by a person (spec/04 § Hidden).
      fromUser: true,
    });
  }

  /**
   * Start a SIDE thread off the message at `seq` (spec/04 § Side threads).
   *
   * Same machinery as `forkChat`, one difference that is the whole point: the
   * shared prefix includes the message itself, so `message` is asked ALONGSIDE
   * that turn rather than in place of it, and the main track's continuation
   * below it is left completely alone. The message may be an assistant turn —
   * a side question about an answer is the common case.
   *
   * NO FALLBACK: a `seq` that is not in this chat's transcript is a
   * `fork_point_not_found` error and creates no branch — hanging the side
   * thread off the end instead would silently make it an ordinary main-track
   * message.
   */
  async sideChat(req: {
    chatId: string;
    seq: number;
    message: string;
    localId: string;
    /**
     * Which branch `seq` belongs to (spec/14 § Side threads panel —
     * "branching again from inside the panel"). Absent means the chat's
     * active branch — the ordinary main-track trigger, unchanged.
     */
    branchId?: string;
  }): Promise<void> {
    const state = this.chatState.get(req.chatId);
    if (!state) throw new ChatNotFoundError(req.chatId);
    const graph = this.ensureBranches(req.chatId);

    const fromBranchId = req.branchId ?? graph.activeBranchId;
    const fromBranch = graph.branches.find((b) => b.branchId === fromBranchId);
    if (!fromBranch) {
      this.emit({
        type: 'chat.error',
        chatId: req.chatId,
        error: { code: 'branch_not_found', message: `no branch ${fromBranchId}` },
        seq: OUT_OF_BAND_SEQ,
      });
      return;
    }

    const sessionId = fromBranch.sessionId;
    const point =
      sessionId !== undefined && sessionId.length > 0
        ? this.historyReader.sidePoint({
            folder: state.folder,
            sessionId,
            seq: req.seq,
            seqIndex: this.canonicalSeqIndex(req.chatId),
            nativeDir: this.nativeClaudeDirFor(req.chatId),
          })
        : null;
    if (!point) {
      this.emit({
        type: 'chat.error',
        chatId: req.chatId,
        error: {
          code: 'fork_point_not_found',
          message: `no message at seq ${req.seq} to hang a side thread off`,
        },
        seq: OUT_OF_BAND_SEQ,
      });
      this.opts.logger.warn(
        { chatId: req.chatId, seq: req.seq },
        'side thread refused: seq is not in this transcript (NO FALLBACK)',
      );
      return;
    }

    const branch: PersistedBranch = {
      branchId: `${req.chatId}-b${graph.branches.length}`,
      parentBranchId: fromBranchId,
      forkFromSeq: req.seq,
      label: `side ${graph.branches.length}`,
      createdAt: this.opts.now(),
      sideThread: true,
    };
    // spec/04 § Side threads / § Branching ("activeBranchId stays as the
    // chat's main track"): a side branch does NOT become active. It runs
    // independently, alongside whatever the active track is doing — unlike
    // an edit fork (forkChat, above), which still switches.
    this.opts.metaStore.update(req.chatId, (m) => ({
      ...m,
      branches: [...graph.branches, branch],
      updatedAt: this.opts.now(),
    }));
    this.emitBranches(req.chatId);

    await this.sendToBranch({
      chatId: req.chatId,
      branchId: branch.branchId,
      message: req.message,
      localId: req.localId,
      fork: { resumeAtUuid: point.resumeAtUuid },
    });
  }

  /**
   * Make `branchId` the chat's active track (spec/04 § Branching): repoint
   * `activeBranchId` — and with it `claudeSessionId` — and tell surfaces, which
   * re-replay to render the newly-active track.
   *
   * NO FALLBACK: an unknown branch, or one whose first turn has not yet produced
   * a session id, is a `branch_not_found` error and leaves the active track
   * exactly as it was.
   */
  async switchBranch(chatId: string, branchId: string): Promise<void> {
    const state = this.chatState.get(chatId);
    if (!state) throw new ChatNotFoundError(chatId);
    const graph = this.ensureBranches(chatId);
    const target = graph.branches.find((b) => b.branchId === branchId);
    if (!target || target.sessionId === undefined || target.sessionId.length === 0) {
      this.emit({
        type: 'chat.error',
        chatId,
        error: {
          code: 'branch_not_found',
          message: !target
            ? `chat ${chatId} has no branch ${branchId}`
            : `branch ${branchId} has no session yet — its first turn hasn't landed`,
        },
        seq: OUT_OF_BAND_SEQ,
      });
      return;
    }
    if (graph.activeBranchId === branchId) return;
    // A running turn belongs to the CURRENT track; switching underneath it would
    // land its output on the wrong branch. Stop it first, explicitly.
    if (this.aborters.has(chatId)) {
      this.emit({
        type: 'chat.error',
        chatId,
        error: {
          code: 'branch_not_found',
          message: 'cannot switch track while a turn is running — stop it first',
        },
        seq: OUT_OF_BAND_SEQ,
      });
      return;
    }
    state.claudeSessionId = target.sessionId;
    this.opts.metaStore.update(chatId, (m) => ({
      ...m,
      activeBranchId: branchId,
      claudeSessionId: target.sessionId,
      updatedAt: this.opts.now(),
    }));
    this.branchIds.delete(chatId);
    // The ring holds the track we just left — drop it so a replay renders the
    // newly-active transcript alone.
    this.recentEvents.delete(chatId);
    this.emitBranches(chatId);
    this.emitState(chatId);
  }

  // -------------------------------------------------------------------------
  // Parallel branches (spec/04 § Branching — "Every branch can take input and
  // run independently"). A SIDE branch (created by `sideChat`, above) never
  // becomes `activeBranchId`, so it cannot run through the single-turn-per-
  // chat pump (`sendInput`/`runQuery`) that path still owns unchanged. It runs
  // through this smaller, independent pump instead — its own queue, its own
  // abort controller, its own session — so it can be mid-turn at the same time
  // as the active branch.
  //
  // Deliberately NOT at parity with the active branch's own runner: no
  // provider/harness switching, no compaction, no SDK-error retry ladder, no
  // rate-limit backoff. A side branch's content (messages, tool calls) is
  // persisted to its own track for replay but NOT broadcast live — no surface
  // today knows how to render a second track, so broadcasting it would
  // interleave it into the one view a surface draws for this chat (step 2,
  // "side threads in a tabbed panel", is what gives it somewhere to go).
  // `chat.state` (aggregate activity) and `chat.permission_request` (branch-
  // tagged) are the two live signals this step DOES surface, because the
  // DONE WHEN list requires them: a side branch's question must reach
  // somebody, and the sidebar must know the chat is still working.

  private branchKey(chatId: string, branchId: string): string {
    return `${chatId}::${branchId}`;
  }

  /** A side branch's own, independent turn-execution state (branchKey-keyed). */
  private readonly sideBranchQueues = new Map<
    string,
    Array<{ message: string; localId: string }>
  >();
  private readonly sideBranchRunning = new Set<string>();
  private readonly sideBranchAborters = new Map<string, AbortController>();
  /** The side branch's own last assistant text, for the send-back summariser. */
  private readonly sideBranchLastAssistantText = new Map<string, string>();
  /** The side branch's first message, for naming + the send-back summariser. */
  private readonly sideBranchFirstMessage = new Map<string, string>();
  /**
   * A send-back still owed to whichever turn next runs on this PARENT branch
   * (branchKey-keyed), folded into that turn's prompt as a `<system-reminder>`
   * the instant it is accepted — the SAME capture-and-disclose mechanism
   * every other injected reminder uses (spec/02 § System-reminder disclosure),
   * mirroring `pendingHookAdvice` (spec/04 § Turns a hook resubmits). Consumed
   * once the moment that turn is accepted, then cleared.
   */
  private readonly pendingBranchSendBacks = new Map<
    string,
    Array<{ fromBranchId: string; fromBranchName: string | null; summary: string }>
  >();

  /**
   * spec/07 § Keeping voice and text as one conversation — exchanges a fast
   * voice (Gemini Live / OpenAI Realtime) had on this chat without the agent
   * running, in order, owed to the agent's next turn. Consumed by
   * `consumeVoiceExchanges` the moment that turn is accepted.
   */
  private readonly pendingVoiceExchanges = new Map<
    string,
    Array<{ role: 'user' | 'assistant'; text: string }>
  >();

  /**
   * Write one spoken message into a chat's timeline as an ordinary
   * `chat.message`, with no agent turn: a fast-voice exchange the agent never
   * ran for. `seq` finalises a reply that was streamed on a reserved seq
   * (`reserveVoiceSeq` / `emitVoiceDelta`). Returns the seq it landed on.
   */
  recordVoiceMessage(req: {
    chatId: string;
    role: 'user' | 'assistant';
    content: string;
    seq?: number;
  }): number {
    if (!this.chatState.has(req.chatId)) throw new ChatNotFoundError(req.chatId);
    const seq = req.seq ?? this.bumpSeq(req.chatId);
    this.emit({
      type: 'chat.message',
      chatId: req.chatId,
      role: req.role,
      content: req.content,
      seq,
      createdAt: this.opts.now(),
    });
    let owed = this.pendingVoiceExchanges.get(req.chatId);
    if (!owed) {
      owed = [];
      this.pendingVoiceExchanges.set(req.chatId, owed);
    }
    owed.push({ role: req.role, text: stripVoiceTag(req.content) });
    return seq;
  }

  /** True while an agent turn is running on `chatId`. */
  isTurnRunning(chatId: string): boolean {
    return this.chatState.get(chatId)?.activity === 'running';
  }

  /** spec/07 § Call cost — the one quiet line a voice session leaves when it ends. */
  recordCallSummary(chatId: string, line: string): void {
    if (!this.chatState.has(chatId)) throw new ChatNotFoundError(chatId);
    this.emit({
      type: 'chat.message',
      chatId,
      role: 'system',
      content: `[call] ${line}`,
      seq: this.bumpSeq(chatId),
      createdAt: this.opts.now(),
    });
  }

  /** Reserve the seq a streamed fast-voice reply will finalise on. */
  reserveVoiceSeq(chatId: string): number {
    if (!this.chatState.has(chatId)) throw new ChatNotFoundError(chatId);
    return this.bumpSeq(chatId);
  }

  /** One live chunk of a streamed fast-voice reply (live-only, never persisted). */
  emitVoiceDelta(chatId: string, messageSeq: number, delta: string): void {
    this.emit({ type: 'chat.message_delta', chatId, messageSeq, delta });
  }

  /**
   * What a fast voice is seeded with at session start: the chat's name and its
   * MOST RECENT user/agent messages, walking back from the end until
   * `maxChars` of text is used, returned in chronological order. Tool calls,
   * tool output and system notes are left out.
   */
  voiceContext(
    chatId: string,
    opts: { maxChars: number },
  ): {
    name: string | null;
    /** The first thing the user said in the chat, so a call knows how it began. */
    opening: string | null;
    turns: Array<{ role: 'user' | 'model'; text: string }>;
  } {
    const state = this.chatState.get(chatId);
    if (!state) throw new ChatNotFoundError(chatId);
    const meta = this.opts.metaStore.read(chatId);
    if (!meta) throw new ChatNotFoundError(chatId);
    const branchId = meta.activeBranchId ?? this.branchIdFor(chatId);
    const all = readTrack(this.chatLog, chatId, meta, branchId, -1).map(
      (e) => e.event as WireEvent,
    );
    const turns: Array<{ role: 'user' | 'model'; text: string }> = [];
    let used = 0;
    for (let i = all.length - 1; i >= 0; i--) {
      const e = all[i]!;
      if (e.type !== 'chat.message' || (e.role !== 'user' && e.role !== 'assistant')) continue;
      const text = stripVoiceTag(e.content).trim();
      if (text.length === 0) continue;
      if (used + text.length > opts.maxChars) break;
      used += text.length;
      turns.push({ role: e.role === 'assistant' ? 'model' : 'user', text });
    }
    turns.reverse();
    let opening: string | null = null;
    for (const e of all) {
      if (e.type !== 'chat.message' || e.role !== 'user') continue;
      const text = stripVoiceTag(e.content).trim();
      if (text.length > 0) {
        opening = text;
        break;
      }
    }
    return { name: meta.name ?? null, opening, turns };
  }

  private consumeVoiceExchanges(chatId: string): string {
    const owed = this.pendingVoiceExchanges.get(chatId);
    if (!owed || owed.length === 0) return '';
    this.pendingVoiceExchanges.delete(chatId);
    const lines = owed.map((m) => `${m.role === 'user' ? 'User' : 'Voice'}: ${m.text}`);
    return (
      '<system-reminder>\n' +
      'The user talked to this chat by voice since your last turn. A fast voice model answered ' +
      'them without you. The conversation, in order:\n' +
      `${lines.join('\n')}\n` +
      '</system-reminder>\n\n'
    );
  }

  /**
   * Document editor (spec/14 § Document editor, step 1 of 3): a `.md` file a
   * SURFACE saved (`writeFile`, below) since the agent last saw it, keyed
   * chatId -> relative path -> the content that was on disk the first time
   * this batch of edits started (every later save to the SAME path before the
   * agent's next turn only updates the file itself, not this baseline, so the
   * eventual diff covers the whole run of edits in one). Consumed (diffed
   * against the CURRENT on-disk content, then cleared) by `consumeDocumentDiffs`
   * the moment the chat's next turn is accepted — the same capture-and-disclose
   * `<system-reminder>` mechanism `pendingBranchSendBacks` above uses.
   */
  private readonly pendingDocumentDiffs = new Map<string, Map<string, { before: string }>>();

  /**
   * spec/14 § Document editor — comments both ways, step 2 of 3: a user
   * comment or reply (`docAction`'s `add_comment`/`reply_comment`) owed to
   * this chat's agent, queued here the instant it's made and consumed (as a
   * `<system-reminder>`, then cleared) by `consumeDocComments` the moment the
   * chat's next turn is accepted — same capture-and-disclose mechanism as
   * `pendingDocumentDiffs` above. The agent's OWN comments/replies
   * (`patch_doc_comment`/`patch_doc_reply`) never land here — they're already
   * visible as that turn's own tool call.
   */
  private readonly pendingDocComments = new Map<
    string,
    Array<{ path: string; threadId: string; anchor: string; text: string }>
  >();

  /**
   * Send input to a SPECIFIC branch (spec/04 § Branching). Mirrors
   * `sendInput`'s accept/queue shape, scoped to this one branch's own pump
   * rather than the chat's: a turn already running on a DIFFERENT branch of
   * the same chat never blocks or is blocked by this.
   */
  async sendToBranch(req: {
    chatId: string;
    branchId: string;
    message: string;
    localId: string;
    fork?: ForkRun;
  }): Promise<void> {
    const state = this.chatState.get(req.chatId);
    if (!state) throw new ChatNotFoundError(req.chatId);
    const graph = this.ensureBranches(req.chatId);
    const branch = graph.branches.find((b) => b.branchId === req.branchId);
    if (!branch) {
      throw new Error(`sendToBranch: chat ${req.chatId} has no branch ${req.branchId}`);
    }
    this.emit({ type: 'chat.input_ack', chatId: req.chatId, localId: req.localId });
    const key = this.branchKey(req.chatId, req.branchId);
    if (this.sideBranchRunning.has(key)) {
      const queue = this.sideBranchQueues.get(key) ?? [];
      queue.push({ message: req.message, localId: req.localId });
      this.sideBranchQueues.set(key, queue);
      this.emit({
        type: 'chat.queued',
        chatId: req.chatId,
        localId: req.localId,
        message: req.message,
        queueSeq: queue.length,
      });
      return;
    }
    await this.runBranchTurns(req.chatId, req.branchId, req.message, req.localId, req.fork);
  }

  /** Own this branch's own serial pump: run one turn, then drain its own queue. */
  private async runBranchTurns(
    chatId: string,
    branchId: string,
    firstMessage: string,
    localId: string,
    fork?: ForkRun,
  ): Promise<void> {
    const key = this.branchKey(chatId, branchId);
    this.sideBranchRunning.add(key);
    this.emitState(chatId);
    // spec/14 § Side threads panel — the tab's status dot reads this branch's
    // own `running`, not just the chat's aggregate activity.
    this.emitBranches(chatId);
    try {
      await this.runBranchQuery(chatId, branchId, firstMessage, localId, fork);
      for (;;) {
        const next = this.sideBranchQueues.get(key)?.shift();
        if (!next) break;
        this.emit({ type: 'chat.dequeued', chatId, localId: next.localId, reason: 'running' });
        await this.runBranchQuery(chatId, branchId, next.message, next.localId);
      }
    } finally {
      this.sideBranchRunning.delete(key);
      this.sideBranchQueues.delete(key);
      this.sideBranchAborters.delete(key);
      this.emitState(chatId);
      this.emitBranches(chatId);
    }
  }

  /** Stop a specific branch's running turn, or no-op if it has none. */
  stopBranch(chatId: string, branchId: string): void {
    const key = this.branchKey(chatId, branchId);
    this.sideBranchAborters.get(key)?.abort();
  }

  /**
   * Stop EVERY branch of this chat (spec/04 § Branching — "Archiving/stopping
   * the chat stops all its branches"). The active branch goes through the
   * ordinary `stopChat`; every other branch through `stopBranch`.
   */
  async stopAllBranches(chatId: string): Promise<void> {
    await this.stopChat(chatId);
    const meta = this.opts.metaStore.read(chatId);
    for (const b of meta?.branches ?? []) {
      if (b.branchId !== meta?.activeBranchId) this.stopBranch(chatId, b.branchId);
    }
  }

  /**
   * One turn on a side branch: resolve credentials, persist the user turn
   * onto the branch's OWN track, run the SDK, persist what comes back. NO
   * FALLBACK on a credential failure — the branch just stays idle, exactly
   * like the active branch's own turn does.
   */
  private async runBranchQuery(
    chatId: string,
    branchId: string,
    prompt: string,
    localId: string,
    fork?: ForkRun,
  ): Promise<void> {
    const key = this.branchKey(chatId, branchId);
    const state = this.chatState.get(chatId);
    if (!state) return;
    if (!this.sideBranchFirstMessage.has(key)) this.sideBranchFirstMessage.set(key, prompt);

    const abortController = new AbortController();
    this.sideBranchAborters.set(key, abortController);

    const oauth = await this.resolveOAuth(state.model);
    if (abortController.signal.aborted) {
      this.sideBranchAborters.delete(key);
      return;
    }
    if (!oauth.ok) {
      this.sideBranchAborters.delete(key);
      this.emit({
        type: 'daemon.unauthenticated',
        daemonId: this.opts.daemonId,
        backendId: CLAUDE_BACKEND_ID,
        reason: oauth.reason,
      });
      return;
    }

    const turnId = randomUUID();
    const reminder = this.consumeBranchSendBacks(chatId, branchId);
    const composedPrompt = reminder + prompt;
    const userContent = persistedUserContent(composedPrompt) ?? '';
    const systemContext = extractSystemContext(composedPrompt);
    const userSeq = this.bumpSeq(chatId);
    const userEvent: ChatMessageEvent = {
      type: 'chat.message',
      chatId,
      role: 'user',
      content: userContent,
      seq: userSeq,
      localId,
      createdAt: this.opts.now(),
      ...(systemContext.length > 0 ? { systemContext } : {}),
    };
    // spec/14 § Side threads panel — "branching again from inside the panel"
    // hangs a NEW side thread off a message that lives only on this branch's
    // own session. That later `sideChat` call resolves its fork point by
    // walking THIS branch's own raw SDK transcript (`history.ts#sidePoint`),
    // which re-derives a canonical seq from the identity-hash index — so this
    // turn's identity must be recorded here, exactly as the active branch's
    // own `sendInput` already does for the same reason, or the walk allocates
    // a fresh seq that never matches `userSeq` and the nested fork is refused
    // as `fork_point_not_found`.
    const identityKey = eventIdentity(userEvent);
    if (identityKey !== null) this.recordCanonicalSeq(chatId, identityHash(identityKey), userSeq);
    try {
      this.chatLog.append(
        chatId,
        { k: 'event', event: userEvent },
        { branchId, sync: true },
        turnId,
      );
    } catch (err) {
      this.sideBranchAborters.delete(key);
      this.opts.logger.error(
        { chatId, branchId, err },
        'side branch: could not record its user turn',
      );
      return;
    }

    // Re-read after the OAuth await in case the branch's session landed while
    // we were waiting (can't happen today — nothing else writes it mid-flight
    // — but reading fresh here costs nothing and never goes stale).
    const branch = (this.opts.metaStore.read(chatId)?.branches ?? []).find(
      (b) => b.branchId === branchId,
    );
    const mcpServer = this.opts.mcpServer
      ? {
          ...this.opts.mcpServer,
          env: { ...this.opts.mcpServer.env, PATCH_CHAT_ID: chatId, PATCH_BRANCH_ID: branchId },
        }
      : undefined;
    const sdkOpts: SdkRunOptions = {
      prompt: composedPrompt,
      cwd: state.folder,
      resumeSessionId: branch?.sessionId ?? state.claudeSessionId,
      ...(fork ? { fork } : {}),
      abortController,
      oauthAccessToken: oauth.accessToken,
      ...(oauth.accountId ? { accountId: oauth.accountId } : {}),
      ...(mcpServer ? { mcpServer } : {}),
      ...(state.model !== undefined ? { model: state.model } : {}),
      permissionMode: this.chatPermissionMode(chatId),
      disabledTools: state.disabledTools,
      onPermissionRequest: (req: {
        tool: string;
        args: Record<string, unknown>;
        description?: string;
      }) => this.requestPermission(chatId, req.tool, req.args, req.description, branchId),
      extraMcpServers: this.opts.discoverClaudeMcpServers(state.folder),
    };

    let newSessionId: string | undefined;
    let outcome: TurnOutcome;
    try {
      for await (const env of this.opts.sdkBackend.run(sdkOpts)) {
        const r = this.handleBranchEnvelope(chatId, branchId, turnId, env);
        if (r.sessionId !== undefined) newSessionId = r.sessionId;
      }
      outcome = abortController.signal.aborted ? 'stopped' : 'completed';
    } catch (err) {
      outcome = abortController.signal.aborted ? 'stopped' : 'failed';
      this.opts.logger.error({ chatId, branchId, err }, 'side branch turn failed');
    } finally {
      this.sideBranchAborters.delete(key);
    }

    if (newSessionId !== undefined) {
      this.opts.metaStore.update(chatId, (m) => ({
        ...m,
        branches: (m.branches ?? []).map((b) =>
          b.branchId === branchId ? { ...b, sessionId: newSessionId } : b,
        ),
        updatedAt: this.opts.now(),
      }));
    }
    try {
      this.chatLog.append(chatId, { k: 'turn.end', outcome }, { branchId, sync: true }, turnId);
    } catch (err) {
      this.opts.logger.error({ chatId, branchId, err }, 'side branch: could not close its turn');
    }
    try {
      this.mirrorSeqToMeta(chatId);
    } catch (err) {
      this.opts.logger.error(
        { chatId, branchId, err },
        'could not mirror seq to meta after a side branch turn',
      );
    }
    if (branch && !branch.name) this.maybeGenerateBranchName(chatId, branchId, prompt);
  }

  /**
   * Fold one SDK envelope into a side branch's OWN track. Deliberately
   * smaller than `handleEnvelopeInner`: logs what happened for later replay,
   * but does not broadcast it live (see § Parallel branches, above) and skips
   * everything the active branch's runner does that a side branch does not
   * need for step 1 (file-browser dirty tracking, plan-mode restore, context
   * ring). Permission envelopes (the mock backend's non-blocking trigger, the
   * only path that yields one here — a blocking `canUseTool` request arrives
   * via `onPermissionRequest` above instead) route through the same
   * `handlePermissionEnvelope` the active branch uses, branch-tagged.
   */
  private handleBranchEnvelope(
    chatId: string,
    branchId: string,
    turnId: string,
    env: SdkEnvelope,
  ): { sessionId?: string } {
    if (env.permission) {
      this.handlePermissionEnvelope(chatId, env, undefined, branchId);
      return { sessionId: env.sessionId };
    }
    const append = (event: LoggedEvent): void => {
      try {
        this.chatLog.append(chatId, { k: 'event', event }, { branchId }, turnId);
      } catch (err) {
        this.opts.logger.error({ chatId, branchId, err }, 'side branch: could not record an event');
      }
    };
    const lastTextKey = this.branchKey(chatId, branchId);
    switch (env.type) {
      case 'tool_use':
        if (env.tool) {
          append({
            type: 'chat.tool_call',
            chatId,
            tool: env.tool.name,
            args: env.tool.args,
            callId: env.tool.callId,
            seq: this.bumpSeq(chatId),
            startedAt: Date.now(),
          });
        }
        break;
      case 'tool_result':
        if (env.toolResult) {
          append({
            type: 'chat.tool_result',
            chatId,
            tool: env.toolResult.name,
            callId: env.toolResult.callId,
            result: env.toolResult.result,
            ...(env.toolResult.isError !== undefined ? { isError: env.toolResult.isError } : {}),
            seq: this.bumpSeq(chatId),
          });
        }
        break;
      case 'assistant':
      case 'user':
      case 'system':
        if (env.content) {
          if (env.type === 'assistant')
            this.sideBranchLastAssistantText.set(lastTextKey, env.content);
          const seq = this.bumpSeq(chatId);
          const msgEvent: ChatMessageEvent = {
            type: 'chat.message',
            chatId,
            role: env.type,
            content: env.content,
            seq,
            createdAt: this.opts.now(),
          };
          // Same reason as the branch's own user turn, above: a later
          // `sideChat` naming this message as ITS fork point walks this
          // branch's own raw SDK transcript and needs this identity recorded
          // to re-derive the same seq.
          const key = eventIdentity(msgEvent);
          if (key !== null) this.recordCanonicalSeq(chatId, identityHash(key), seq);
          append(msgEvent);
        }
        break;
      case 'assistant_delta':
        if (env.content) {
          this.sideBranchLastAssistantText.set(
            lastTextKey,
            (this.sideBranchLastAssistantText.get(lastTextKey) ?? '') + env.content,
          );
        }
        break;
      case 'error':
        this.opts.logger.warn(
          { chatId, branchId, err: env.errorMessage },
          'side branch turn: SDK error envelope',
        );
        break;
      default:
        break;
    }
    return { sessionId: env.sessionId };
  }

  /** Same mechanism as a chat's own name (spec/04 § Name), scoped to one branch. */
  private maybeGenerateBranchName(chatId: string, branchId: string, firstMessage: string): void {
    const gen = this.opts.generateTitle;
    if (!gen) return;
    const state = this.chatState.get(chatId);
    if (!state) return;
    const folder = state.folder;
    void (async () => {
      try {
        const name = await gen({
          chatId,
          firstUserMessage: firstMessage,
          folder,
          ...(state.model !== undefined ? { chatModel: state.model } : {}),
        });
        if (name === null || name.trim() === '') return;
        const meta = this.opts.metaStore.read(chatId);
        const current = meta?.branches?.find((b) => b.branchId === branchId);
        // Only when still unnamed — a rename the user made in the meantime wins.
        if (!current || current.name) return;
        this.opts.metaStore.update(chatId, (m) => ({
          ...m,
          branches: (m.branches ?? []).map((b) => (b.branchId === branchId ? { ...b, name } : b)),
          updatedAt: this.opts.now(),
        }));
        this.emitBranches(chatId);
      } catch (err) {
        this.opts.logger.warn({ chatId, branchId, err }, 'branch name generation failed');
      }
    })();
  }

  /**
   * Surface → host rename of a side branch (spec/04 § Branching). NO
   * FALLBACK: an unknown branch is a `branch_not_found` error.
   */
  renameBranch(chatId: string, branchId: string, name: string): void {
    const meta = this.opts.metaStore.read(chatId);
    const branch = meta?.branches?.find((b) => b.branchId === branchId);
    if (!branch) {
      this.emit({
        type: 'chat.error',
        chatId,
        error: { code: 'branch_not_found', message: `chat ${chatId} has no branch ${branchId}` },
        seq: OUT_OF_BAND_SEQ,
      });
      return;
    }
    const trimmed = name.trim();
    this.opts.metaStore.update(chatId, (m) => ({
      ...m,
      branches: (m.branches ?? []).map((b) =>
        b.branchId === branchId ? { ...b, name: trimmed } : b,
      ),
      updatedAt: this.opts.now(),
    }));
    this.emitBranches(chatId);
  }

  /**
   * Pull (and clear) whatever a side branch has sent back to THIS branch,
   * rendered as a leading `<system-reminder>` block for the turn about to
   * run on it — spec/02 § System-reminder disclosure's capture-and-disclose
   * mechanism, so it is stripped from the turn's own displayed content and
   * carried out-of-band as a `systemContext` entry instead of silently
   * dropped. Empty string when nothing is owed.
   */
  private consumeBranchSendBacks(chatId: string, branchId: string): string {
    const key = this.branchKey(chatId, branchId);
    const owed = this.pendingBranchSendBacks.get(key);
    if (!owed || owed.length === 0) return '';
    this.pendingBranchSendBacks.delete(key);
    return owed
      .map(
        (sb) =>
          '<system-reminder>\n' +
          `From ${sb.fromBranchName ?? 'a side branch'}: ${sb.summary}\n` +
          '</system-reminder>\n\n',
      )
      .join('');
  }

  /**
   * Document editor (spec/14 § Document editor, step 1 of 3): pull (and
   * clear) every `.md` file this chat's surfaces have saved since the agent
   * last saw it, rendered as one leading `<system-reminder>` block per file
   * for the turn about to run — the same capture-and-disclose mechanism
   * `consumeBranchSendBacks` above uses, so it shows up in the transcript as
   * a collapsed row rather than invisible injection (principles.md). A file
   * saved back to EXACTLY what it already was (baseline === current) is not
   * reported — nothing actually changed for the agent to be told about.
   * Empty string when nothing is owed.
   */
  private consumeDocumentDiffs(chatId: string): string {
    const owed = this.pendingDocumentDiffs.get(chatId);
    if (!owed || owed.size === 0) return '';
    this.pendingDocumentDiffs.delete(chatId);
    const state = this.chatState.get(chatId);
    /* v8 ignore next -- defensive only: `owed` only has entries because `writeFile` resolved this exact chatId's state to record them, and a chat's state is never removed while the chat exists. */
    if (!state) return '';
    const root = state.folder;
    let out = '';
    for (const [relPath, { before }] of owed) {
      let after: string;
      try {
        after = readFileSync(join(root, relPath), 'utf8');
      } catch {
        // Deleted since the save that queued this diff — nothing left to show.
        continue;
      }
      if (after === before) continue;
      out +=
        '<system-reminder>\n' +
        `The user edited ${relPath} since you last saw it. Diff:\n` +
        '```diff\n' +
        unifiedDiff(relPath, before, after) +
        '```\n' +
        '</system-reminder>\n\n';
    }
    return out;
  }

  /**
   * spec/14 § Document editor — comments both ways, step 2 of 3: pull (and
   * clear) every comment/reply the user left on this chat's documents since
   * the agent last saw it, one `<system-reminder>` per comment naming the
   * file and thread so the agent can reply with `patch_doc_reply`. Same
   * capture-and-disclose mechanism `consumeDocumentDiffs` above uses.
   */
  private consumeDocComments(chatId: string): string {
    const owed = this.pendingDocComments.get(chatId);
    if (!owed || owed.length === 0) return '';
    this.pendingDocComments.delete(chatId);
    return owed
      .map(
        (c) =>
          '<system-reminder>\n' +
          `The user left a comment on ${c.path} (thread ${c.threadId}), anchored to: "${c.anchor}"\n` +
          `Comment: ${c.text}\n` +
          `Reply with patch_doc_reply({ path: ${JSON.stringify(c.path)}, threadId: ${JSON.stringify(c.threadId)}, text: ... }).\n` +
          '</system-reminder>\n\n',
      )
      .join('');
  }

  /**
   * A side branch posts its conclusion back to its parent track (spec/04 §
   * Send back). Two halves, both from the SAME generated summary: a quiet
   * `From <branch name>:` row lands in the parent's track RIGHT NOW (visible
   * even if the parent's next turn is a long way off — principles.md § no
   * invisible injection), and the summary is ALSO queued to ride as a
   * `<system-reminder>` on the parent's next turn, so its agent reads it as
   * part of that turn's own context rather than having to notice the row.
   *
   * NO FALLBACK: a branch with no parent, or one that has already sent back,
   * refuses naming why. A summariser failure still records the attempt — the
   * row says the summary could not be generated rather than saying nothing.
   */
  async sendBackToParent(
    chatId: string,
    branchId: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const meta = this.opts.metaStore.read(chatId);
    const branch = meta?.branches?.find((b) => b.branchId === branchId);
    if (!branch) return { ok: false, error: `chat ${chatId} has no branch ${branchId}` };
    if (branch.parentBranchId === null) {
      return { ok: false, error: 'the root branch has no parent to send back to' };
    }
    if (branch.sentBack) {
      return { ok: false, error: 'this branch has already sent back to its parent' };
    }
    const state = this.chatState.get(chatId);
    if (!state) return { ok: false, error: `chat ${chatId} not found` };
    const parentBranchId = branch.parentBranchId;
    const key = this.branchKey(chatId, branchId);
    const firstMessage = this.sideBranchFirstMessage.get(key) ?? '';
    const lastAssistantText = this.sideBranchLastAssistantText.get(key) ?? '';

    let summary: string;
    const gen = this.opts.summarizeBranchSendBack;
    if (gen) {
      try {
        summary = await gen({
          chatId,
          branchId,
          folder: state.folder,
          firstMessage,
          lastAssistantText,
        });
      } catch (err) {
        summary = `(could not summarise: ${err instanceof Error ? err.message : String(err)})`;
      }
    } else {
      summary =
        lastAssistantText.trim() !== '' ? lastAssistantText.trim() : '(no conclusion recorded)';
    }

    this.opts.metaStore.update(chatId, (m) => ({
      ...m,
      branches: (m.branches ?? []).map((b) =>
        b.branchId === branchId ? { ...b, sentBack: true } : b,
      ),
      updatedAt: this.opts.now(),
    }));
    this.emitBranches(chatId);

    const fromBranchName = branch.name ?? null;
    const parentKey = this.branchKey(chatId, parentBranchId);
    const owed = this.pendingBranchSendBacks.get(parentKey) ?? [];
    owed.push({ fromBranchId: branchId, fromBranchName, summary });
    this.pendingBranchSendBacks.set(parentKey, owed);

    const seq = this.bumpSeq(chatId);
    const row: ChatMessageEvent = {
      type: 'chat.message',
      chatId,
      role: 'system',
      content: `From ${fromBranchName ?? 'a side branch'}: ${summary}`,
      seq,
      createdAt: this.opts.now(),
      branchSendBack: { fromBranchId: branchId, fromBranchName },
    };
    try {
      this.chatLog.append(
        chatId,
        { k: 'event', event: row },
        { branchId: parentBranchId, sync: true },
      );
    } catch (err) {
      this.opts.logger.error({ chatId, branchId, err }, 'send back: could not record the row');
    }
    // Live-emit only when the parent IS the active branch — the chat's one
    // live view. A parent that is itself a side branch gets the row on its
    // own track's next replay, same as the rest of its content (§ Parallel
    // branches, above).
    if (parentBranchId === (meta?.activeBranchId ?? parentBranchId)) this.emit(row);
    return { ok: true };
  }

  /**
   * Status in the sidebar as a WHOLE (spec/04 § Branching — "working if any
   * branch is working, needs-you if any branch needs you"). The active
   * branch's own activity is the floor — unchanged from before branches could
   * run in parallel — raised by any OTHER branch currently running or
   * awaiting permission. `errored` never raises past what the active branch
   * itself reports: a side branch failing silently is not something the
   * sidebar escalates on its own.
   */
  private aggregateActivity(chatId: string): ChatActivity {
    const state = this.chatState.get(chatId);
    if (!state) return 'idle';
    // `awaiting-permission` outranks `running`: it is the more specific,
    // more actionable state (the single-branch model never shows both at
    // once for the same turn — a question always wins), so a side branch
    // blocked on one must not be masked by another branch merely running.
    const rank: Record<ChatActivity, number> = {
      'awaiting-permission': 3,
      running: 2,
      errored: 1,
      idle: 0,
    };
    let best = state.activity;
    const prefix = `${chatId}::`;
    for (const key of this.sideBranchRunning) {
      if (key.startsWith(prefix) && rank.running > rank[best]) best = 'running';
    }
    for (const ev of this.pendingPermissionEvents.values()) {
      if (ev.chatId === chatId && rank['awaiting-permission'] > rank[best]) {
        best = 'awaiting-permission';
      }
    }
    return best;
  }

  // -------------------------------------------------------------------------
  // Moving a chat to another host (spec/04 § Moving a chat to another host).
  // The server drives it: export here, import there, retire here. `chatMove.ts`
  // does the files; these do the chat.

  private movePaths(): ChatMovePaths {
    const chatsRoot = dirname(dirname(this.opts.metaStore.pathFor('_')));
    const patchHome = dirname(chatsRoot);
    return {
      chatsRoot,
      blobsDir: join(patchHome, 'blobs'),
      claudeProjectsRoot: this.claudeProjectsRoot,
      movedRoot: join(patchHome, 'moved'),
    };
  }

  /**
   * Everything this chat is on disk, and from now until `retireMovedChat` or
   * `releaseMovedChat` it takes no new turns. Refused for anything that is
   * doing something right now — a move is of a chat at rest.
   */
  exportChatForMove(chatId: string): ChatMoveBundle {
    const state = this.chatState.get(chatId);
    if (!state) throw new ChatMoveError('not_found', `no chat ${chatId} on this host`);
    if (isReservedSpecialThread(chatId)) {
      throw new ChatMoveError('unsupported', 'a special thread stays on the home host');
    }
    if (
      this.pumping.has(chatId) ||
      state.activity === 'running' ||
      state.activity === 'awaiting-permission'
    ) {
      throw new ChatMoveError('busy', 'this chat is mid-turn; move it once it has finished');
    }
    if (this.wake.peek(chatId) !== null) {
      throw new ChatMoveError('busy', 'this chat has a self-wake armed; cancel it before moving');
    }
    if (this.watch.count(chatId) > 0) {
      throw new ChatMoveError(
        'busy',
        'this chat is watching a process on this host; stop the watch before moving',
      );
    }
    if (this.hasRunningDelegates(chatId)) {
      throw new ChatMoveError(
        'busy',
        'this chat has a subagent running on this host; let it finish or stop it before moving',
      );
    }
    if (state.claudeSessionId?.startsWith('codex-')) {
      throw new ChatMoveError(
        'unsupported',
        'this chat is on a Codex session, which a move cannot carry yet',
      );
    }
    this.movingOut.add(chatId);
    try {
      this.chatLog.flush();
      return buildMoveBundle(chatId, this.movePaths());
    } catch (err) {
      this.movingOut.delete(chatId);
      throw err;
    }
  }

  /** A move that failed after export: the chat carries on here as it was. */
  releaseMovedChat(chatId: string): void {
    this.movingOut.delete(chatId);
  }

  /**
   * The chat has arrived on its new host: it stops being one of this host's.
   * Its directory is set aside, not deleted.
   */
  retireMovedChat(chatId: string): string {
    if (!this.movingOut.has(chatId)) {
      throw new ChatMoveError('not_found', `chat ${chatId} is not being moved from this host`);
    }
    this.chatLog.close(chatId);
    const keptAt = setAsideMovedChat(chatId, this.movePaths(), this.opts.now());
    this.chatState.delete(chatId);
    this.hydratedFromDisk.delete(chatId);
    this.seenLocalIds.delete(chatId);
    this.recentEvents.delete(chatId);
    this.movingOut.delete(chatId);
    this.opts.logger.info({ chatId, keptAt }, 'chat moved to another host; retired here');
    return keptAt;
  }

  /**
   * Take in a chat moved from another host, to run in `folder` here, and
   * announce it exactly as a new chat of this host's is announced. Its next
   * turn resumes the session it arrived with.
   */
  importMovedChat(bundle: ChatMoveBundle, folder: string): void {
    if (this.chatState.has(bundle.chatId)) {
      throw new ChatMoveError('already_exists', `this host already has chat ${bundle.chatId}`);
    }
    const meta = writeMoveBundle(bundle, folder, this.movePaths(), this.opts.now());
    const chatId = meta.chatId;
    this.chatState.hydrate([meta]);
    this.hydratedFromDisk.add(chatId);
    this.stampMissingPermissionMode(chatId);
    const state = this.chatState.get(chatId)!;
    const floor = Math.max(state.nextSeq, this.opts.metaStore.readSeq(chatId) ?? 0);
    state.nextSeq = this.chatLog.hydrate(chatId, floor).nextSeq;
    this.opts.logger.info(
      { chatId, from: bundle.sourceFolder, folder, files: bundle.files.length },
      'chat moved here from another host',
    );
    this.emit({
      type: 'chat.spawned',
      chatId,
      daemonId: this.opts.daemonId,
      folder,
      ...(state.model !== undefined ? { model: state.model } : {}),
    });
    this.emitState(chatId);
  }

  /** Chats left out of hydrate because their meta.json could not be read. */
  unreadableChats(): UnreadableChat[] {
    return this.opts.metaStore.unreadable();
  }

  list(): ChatState[] {
    return this.chatState.list();
  }

  /**
   * `patch host clean` (spec/02-daemon.md ## CLI, spec/13 § Subcommands):
   * remove meta.json entries for chats Claude Code has lost. A chat is "lost"
   * when it captured a Claude session id (so it expects to RESUME from a
   * transcript) but that transcript JSONL no longer exists on disk — the
   * Agent SDK can never resume it, so the meta entry is dead weight. Chats
   * with no session id yet (freshly spawned, never queried) are NOT lost and
   * are left untouched; a running chat (in-flight aborter) is also skipped.
   *
   * NO FALLBACK: a chat is removed only when its loss is positively
   * established (session id present + transcript absent), never on a probe
   * error. Removal deletes the on-disk meta dir and the in-memory chat_state.
   * Returns the removed chatIds.
   */
  cleanStaleChats(): { removed: string[] } {
    const removed: string[] = [];
    for (const state of this.chatState.list()) {
      // Skip in-flight chats — a running query is by definition not lost.
      if (this.aborters.has(state.chatId)) continue;
      // A chat with no session id has never produced a transcript; it is a
      // fresh chat, not a lost one. Leave it.
      if (!state.claudeSessionId) continue;
      // Lost iff the captured session's transcript is gone on disk.
      if (this.historyReader.hasSession({ folder: state.folder, sessionId: state.claudeSessionId }))
        continue;

      // Delete the on-disk meta dir (meta.json + seq sidecar) and the
      // in-memory state. pathFor returns .../chats/<id>/meta.json; its parent
      // is the chat's meta dir.
      const metaDir = dirname(this.opts.metaStore.pathFor(state.chatId));
      this.chatLog.close(state.chatId);
      rmSync(metaDir, { recursive: true, force: true });
      this.chatState.delete(state.chatId);
      this.hydratedFromDisk.delete(state.chatId);
      removed.push(state.chatId);
      this.opts.logger.info(
        { chatId: state.chatId, folder: state.folder, sessionId: state.claudeSessionId },
        'host clean: removed lost chat (transcript gone)',
      );
    }
    return { removed };
  }

  // -------------------------------------------------------------------------
  // Internal: run one SDK query for the chat. Emits wire events as they
  // arrive, persists nextSeq + claudeSessionId after every emit.

  private async runQuery(
    chatId: string,
    prompt: string,
    fork?: ForkRun,
    /** The surface's id for this turn, echoed on the persisted user message. */
    localId?: string,
    /** Who started this turn (spec/09 § Whose turn it was); absent means `user`. */
    origin?: TurnOrigin,
    /**
     * spec/12 § A turn is owed until it settles — the seq of the ORIGINAL user
     * message when this run is the host RE-SENDING a turn that already has a
     * bubble. Rides out on the user `chat.message` as `retryOfSeq`.
     */
    retryOfSeq?: number,
    /** {@link SendInputOptions.jobTrigger} — rides out on the user `chat.message` as `jobTrigger`. */
    jobTrigger?: boolean,
    /** {@link SendInputOptions.hookTrigger} — rides out on the user `chat.message` as `hookTrigger`. */
    hookTrigger?: HookTriggerInfo,
    /** {@link SendInputOptions.goalTrigger} — rides out on the user `chat.message` as `goalTrigger`. */
    goalTrigger?: GoalTriggerInfo,
  ): Promise<boolean> {
    // The bubble this whole run belongs to. On a re-send it is the anchor the
    // caller handed us; on a first attempt it is this run's own user message,
    // filled in below once that message has taken its seq. Everything that has
    // to name the turn later — the crash marker, the park, the retry ladder —
    // reads THIS, so every rung points at the original rather than at the rung
    // before it.
    let turnAnchorSeq: number | undefined = retryOfSeq;
    /* v8 ignore next 3 -- defensive invariant only: every path into runQuery (runTurnsFrom / drainQueue) is serialized behind the synchronous `pumping` add/check with no `await` in between, so a second runQuery for the same chatId can never observe an existing aborter. Unreachable via the public API. */
    if (this.aborters.has(chatId)) {
      throw new Error(`runQuery: chat ${chatId} is already running`);
    }
    const state = this.chatState.get(chatId);
    if (!state) throw new Error(`runQuery: unknown chatId ${chatId}`);

    // G2-d4: capture a one-line snippet of the FIRST user message as the chat's
    // durable `preview`. The sidebar uses it to give otherwise-unnamed rows —
    // especially archived ones, which are never opened and so carry no live
    // timeline — an individually distinguishing label even when several chats
    // share a folder basename. Captured once (never overwritten) and mirrored
    // to meta.json so it survives a host restart.
    if (state.preview === null) {
      const snippet = makePreviewSnippet(prompt);
      if (snippet !== null) {
        state.preview = snippet;
        this.opts.metaStore.update(chatId, (m) => ({
          ...m,
          preview: snippet,
          updatedAt: this.opts.now(),
        }));
        this.emitState(chatId);
      }
    }

    // spec/04 § Name: summarise the FIRST user message into a human title as
    // soon as it is accepted — before the turn itself runs, so a long-running
    // first turn never delays the title landing. Fire-and-forget.
    this.maybeGenerateTitle(chatId, prompt);

    // A RESUME is any query on a chat restored from disk (pre-existing across
    // a host restart). A chat created live this process (spawn / special
    // thread bootstrap) is on its legitimate first turn — resume undefined is
    // correct there (spec/04 behaviour 3).
    const isResume = this.hydratedFromDisk.has(chatId);

    // F5 — validate the pinned folder still exists at RESUME time, mirroring
    // the spawn-time FolderNotFoundError check. A chat hydrated after the
    // folder was deleted must NOT hand a bad cwd to the SDK (spec/04 ## Resume,
    // NO FALLBACK). Mark errored and surface `folder_missing`.
    if (!existsSync(state.folder) || !statSync(state.folder).isDirectory()) {
      this.failPreflight(chatId, 'folder_missing', `chat folder no longer exists: ${state.folder}`);
      return false;
    }

    // F1 — a RESUME with no claudeSessionId would silently start a brand-new
    // contextless session. Distinguish the legitimate first query of a
    // freshly-spawned chat (resume undefined is correct) from a resume of a
    // pre-existing/hydrated chat whose session id is missing/empty. The latter
    // is marked errored (spec/04 line 46, NO FALLBACK) — the next user action
    // can explicitly start fresh.
    //
    // A chat that was hydrated from disk but has never emitted a single event
    // (`nextSeq === 0`) has never had a turn — it lost no context, so its first
    // query is a legitimate fresh start (resume undefined is correct). This is
    // the normal case for special threads (Manager/Speakers): they are
    // bootstrapped into meta.json on first boot, persist across host
    // restarts, and may receive their very first user turn only after a
    // restart. Guarding those with `claude_session_missing` would make the
    // first turn of every special thread permanently impossible. We only treat
    // a missing session as an error when the chat HAS produced events before
    // (nextSeq > 0) and therefore genuinely lost a session it once had.
    const hasPriorTurns = state.nextSeq > 0;
    // A chat already in `errored` status with no session id had its session
    // CLEARED by the invalid-session path (spec/04 line 46) — its transcript
    // is provably gone. A subsequent user turn is a deliberate RECOVERY, and
    // the spec promises it "starts fresh". So do NOT apply the resume-only
    // guard to it: that guard exists to catch a chat that silently lost a
    // session it should still have (crash), not one we already determined is
    // unrecoverable and cleared. Without this carve-out a lost-session chat
    // (e.g. a special thread whose transcript was pruned) deadlocks forever.
    const wasClearedForRecovery = state.status === 'errored';
    if (
      isResume &&
      hasPriorTurns &&
      !wasClearedForRecovery &&
      (state.claudeSessionId === undefined || state.claudeSessionId === '')
    ) {
      // No provider session to resume. That is NOT lost work: the chat's own
      // history is Patch's, in ~/.patch/chats/<id>, and a turn killed mid-flight
      // is held in `pendingTurns`. The Claude session is a pointer into the
      // provider's context cache — useful, and not the record.
      //
      // So start one and get on with it. Refusing meant the chat sat `errored`
      // until a person re-sent the message, which is no recovery at all for an
      // unattended chat: a job's `continue` action resolves to the same durable
      // chat on every fire, so the refusal was permanent and the work was never
      // done. Nothing is written into the transcript about it — there is
      // nothing a reader needs to act on, and a chat is not the place for
      // plumbing notices.
      this.opts.logger.info(
        { chatId, priorSeq: state.nextSeq },
        'no provider session to resume; rebuilding one from the chat log',
      );
    }

    // F1 — orphaned resume id against the REAL SDK. The real Claude Agent SDK
    // `query({ resume })` HANGS indefinitely (no first message, no result, no
    // error — observed as "starting SDK query (resume)" with zero completions)
    // when the resume session id has no transcript JSONL on disk. This happens
    // when `claudeSessionId` was persisted by a prior MOCK run (which writes
    // `mock-session-*.jsonl`, never `<sessionId>.jsonl`) or the transcript was
    // pruned. The mock backend resumes fine without the file, so we only apply
    // this for the real backend. Per spec/04 ## Resume, a session we provably
    // cannot resume is treated as session-lost: clear it and start fresh on
    // this turn rather than hanging forever (NO FALLBACK to a phantom resume).
    if (
      isResume &&
      this.opts.sdkBackendKind === 'real' &&
      typeof state.claudeSessionId === 'string' &&
      state.claudeSessionId.length > 0 &&
      !this.historyReader.hasSession({
        folder: state.folder,
        sessionId: state.claudeSessionId,
      })
    ) {
      this.opts.logger.warn(
        { chatId, orphanedSessionId: state.claudeSessionId, folder: state.folder },
        'resume session id has no transcript on disk (mock-origin or pruned); ' +
          'clearing it and starting fresh to avoid the real-SDK resume hang',
      );
      state.claudeSessionId = undefined;
      this.opts.metaStore.update(chatId, (m) => {
        const { claudeSessionId: _drop, ...rest } = m;
        void _drop;
        return { ...rest, updatedAt: this.opts.now() };
      });
    }

    // spec/02 § Per-turn process / warm sessions — a session with no
    // conversation left once harness-written turns are stripped (a chat whose
    // only turn died: one prompt, answered by nothing or by a placeholder).
    // Resuming it hands Claude Code an empty session, which it refuses ("No
    // conversation found"), and keeping the prompt makes it answer that prompt
    // itself. There is nothing to resume, so this turn starts a fresh session,
    // exactly as a chat's first turn does; the chat's own history is untouched.
    // Every resume, not only a chat hydrated from disk: a placeholder lands in
    // a live chat's session as easily as in a restored one's.
    if (
      this.opts.sdkBackendKind === 'real' &&
      this.harnessOf(chatId) === 'claude' &&
      typeof state.claudeSessionId === 'string' &&
      state.claudeSessionId.length > 0
    ) {
      const loaded = await this.claudeSessionStoreFor(chatId, state.folder).load({
        projectKey: chatId,
        sessionId: state.claudeSessionId,
      });
      if (loaded !== null && !hasConversation(loaded)) {
        this.opts.logger.info(
          { chatId, emptySessionId: state.claudeSessionId },
          'resume session has no conversation once harness-written turns are stripped; ' +
            'starting a fresh session',
        );
        state.claudeSessionId = undefined;
        this.opts.metaStore.update(chatId, (m) => {
          const { claudeSessionId: _drop, ...rest } = m;
          void _drop;
          return { ...rest, updatedAt: this.opts.now() };
        });
      }
    }

    // Register the abort controller BEFORE the (now async) OAuth gate so a
    // `stopChat` issued in the window between sendInput and the SDK call still
    // aborts the in-flight query (the OAuth gate may await a token refresh).
    // Without this, a stop landing during OAuth resolution would find no
    // aborter and silently no-op.
    const abortController = new AbortController();
    this.aborters.set(chatId, abortController);

    // OAuth gate (spec/10-auth.md): re-read the credential BEFORE the SDK query,
    // self-refreshing an expiring token (see makeResolveOAuth). Missing/expired
    // and unrefreshable → emit `daemon.unauthenticated`, refuse the query. NO
    // FALLBACK to an API key. The chat stays idle (not errored): once the user
    // runs `claude login` the next message just works. The account is the
    // host's business, not the chat's: this resolves the stored keys in order
    // and takes the first with credit (spec/10 § Backend credentials).
    const oauth = await this.resolveOAuth(state.model, {
      chatId,
      ...(state.preferredAccountId !== undefined
        ? { preferredAccountId: state.preferredAccountId }
        : {}),
    });
    // Which key this turn is actually spending, for as long as it runs. Not a
    // preference and never persisted — it is re-decided next turn — but a
    // failure has to name the key that spent, or a host whose first key is out
    // marks the wrong one and never learns.
    if (oauth.ok) {
      const previous = this.runningOnAccount.get(chatId);
      if (oauth.accountId === undefined) this.runningOnAccount.delete(chatId);
      else this.runningOnAccount.set(chatId, oauth.accountId);
      if (previous !== undefined && oauth.accountId !== undefined && previous !== oauth.accountId) {
        this.sayAccountSwitch(chatId, state.model, previous, oauth.accountId);
      }
    }
    // A stop that landed during OAuth resolution is a clean user-stop, not an
    // auth failure: honour the abort and emit chat.stopped (stopChat already
    // queued the event path via the aborter).
    if (abortController.signal.aborted) {
      this.aborters.delete(chatId);
      // Same rule as the aborted branch in the catch below: a stop that landed
      // with turns still queued (a promote fired while this turn was still
      // resolving its credential) is mid-drain, not the end of it. Hold
      // `running` so the drain reports one settle at its true end.
      if (this.hasQueuedTurns(chatId)) return false;
      this.chatState.setActivity(chatId, 'idle');
      this.emitState(chatId);
      return false;
    }
    if (!oauth.ok) {
      this.aborters.delete(chatId);
      this.emit({
        type: 'daemon.unauthenticated',
        daemonId: this.opts.daemonId,
        backendId: isCodexModel(state.model) ? CODEX_BACKEND_ID : CLAUDE_BACKEND_ID,
        reason: oauth.reason,
      });
      this.opts.logger.error(
        { chatId, reason: oauth.reason },
        'runQuery refused: Claude OAuth not available (NO API-key fallback)',
      );
      // SAY SO IN THE CHAT. `daemon.unauthenticated` tells Settings, and the
      // activity going idle tells the composer it may type again — but the turn
      // itself simply vanished: the message sat there with no reply and no
      // reason, which reads as the app being broken rather than as a credential
      // that needs renewing. A refused turn is an outcome, not a non-event.
      this.emit({
        type: 'chat.error',
        chatId,
        error: {
          code: 'claude_oauth_missing',
          message: isCodexModel(state.model)
            ? oauth.reason
            : `${this.opts.daemonId} isn't signed in to Claude, so this turn can't run. Sign in from Settings → Hosts.`,
        },
        seq: OUT_OF_BAND_SEQ,
      });
      this.chatState.setActivity(chatId, 'idle');
      this.emitState(chatId);
      return false;
    }

    // Clear any pending rate-limit auto-resume timer: a new turn starting (either
    // the auto-retry firing, or the user sending manually before it fires) means
    // the chat is back in play — we don't want to double-retry.
    const rlTimer = this.rateLimitTimers.get(chatId);
    if (rlTimer) {
      clearTimeout(rlTimer);
      this.rateLimitTimers.delete(chatId);
    }
    this.rateLimitResumingAt.delete(chatId);
    this.limitBlocks.delete(chatId);
    this.resumeKindMap.delete(chatId);
    this.rateLimitPendingTurns.delete(chatId);

    // spec/09 § Whose turn it was. Stamped as the turn goes running and left
    // standing when it settles, because the frame the server acts on is the
    // running → idle edge — it needs to know whose turn just ENDED, not who is
    // about to start the next one.
    state.turnOrigin = origin ?? 'user';
    if (state.turnOrigin === 'user') this.drainHadUserTurn.add(chatId);
    // spec/09 § A turn the user stopped. A stop belongs to the turn it killed,
    // so the flag is cleared here rather than when the stop settles: a chat
    // that is stopped and then given a fresh turn announces that turn's real
    // completion like any other, and a promoted turn that starts because the
    // one before it was stopped is a completion in its own right too.
    state.turnStopped = false;
    state.turnRetrying = false;
    // spec/09 § What the message says. The closing text describes ONE settled
    // turn, so it is cleared here for the same reason `turnStopped` is: without
    // this, a turn that ends on a tool call — or that is stopped, or that dies
    // in the SDK ladder — would settle still carrying the PREVIOUS turn's words,
    // and the doorbell would announce work that had already been announced.
    state.turnSummary = null;
    // `lastMessages` is a rolling window across turns, not this turn's
    // transcript, so "the last assistant message" is only THIS turn's if it is
    // newer than everything that was already there. Remembered here rather than
    // counted at the end, because a turn that says nothing at all leaves the
    // previous turn's reply sitting at the end of the window looking exactly
    // like a fresh one.
    const assistantSeqBeforeTurn = lastAssistantMessage(state)?.seq ?? -1;

    this.chatState.setActivity(chatId, 'running');
    this.emitState(chatId);

    // Record the turn as in-flight BEFORE the SDK is asked to run it. Everything
    // above this line is a preflight that either ran to completion or refused
    // loudly; from here on the turn can be killed halfway through with no trace,
    // and this is the trace. Cleared in the `finally` below, so it only survives
    // a host that never got to run one — which is every deploy.
    this.runningTurn.set(chatId, {
      message: prompt,
      ...(localId !== undefined ? { localId } : {}),
      ...(fork ? { fork: { resumeAtUuid: fork.resumeAtUuid } } : {}),
      // Persisted with the turn so a restart re-sends it as what it was — a
      // wake tick killed mid-turn must not come back as a user turn.
      ...(origin ? { origin } : {}),
      // spec/12 — an attempt that dies here is still an attempt at the ORIGINAL
      // turn, so the anchor rides on the crash marker too. Absent on a first
      // attempt until its `chat.message` lands (see the re-persist below).
      ...(turnAnchorSeq !== undefined ? { retryOfSeq: turnAnchorSeq } : {}),
      // Persisted with the turn for the same reason `origin` is — a restart
      // must not resume a job's fire as a plain user bubble just because it
      // happened to die mid-turn (spec/14 § Job trigger turn).
      ...(jobTrigger ? { jobTrigger } : {}),
    });
    this.persistPendingTurns(chatId);

    // This turn opens a NEW track (fork / side thread). The live tail in the
    // ring belongs to the track being left — including a turn that was still
    // running when the fork was requested and queued behind it — so a replay of
    // the new track must not top its transcript up with those. Dropped HERE, as
    // the new track actually starts, not when the fork was requested: between
    // those two moments the old track can still be emitting into the ring.
    if (fork) {
      this.recentEvents.delete(chatId);
      this.recentEventsDropped.delete(chatId);
    }

    // The user turn is a `chat.message` like any other (spec/03 § Session
    // events: `{chatId, role, content, seq}`), so it is emitted HERE, live, at
    // its own canonical seq — the same slot it will occupy in `chat.replay` and
    // in `GET /api/chats/:id/history`.
    //
    // It has to be. Claude Code persists the prompt as a user turn, so replay
    // reconstructs it; if it never took a canonical seq live, the live and
    // persisted numbering drift by one per turn, and a surface reconnecting
    // with `fromSeq = <highest seq it saw>` gets the assistant reply it has
    // already rendered handed back to it at a higher number (spec/12 §
    // Replay vs history cursors — `fromSeq` is exclusive precisely so that
    // cannot happen). Emitting it also means a SECOND surface watching this
    // chat sees the message as it is sent rather than only after a reload.
    //
    // Content is what the transcript will yield for the same turn — internal
    // wrappers stripped (`persistedUserContent`), attachment block lifted into
    // structured refs (`hydrateReplayAttachments`) — so the live event and its
    // persisted twin share ONE identity and therefore one seq. The index entry
    // is written against the PERSISTED text (the block still inline), which is
    // the form the transcript reader will key on.
    // Emitted after every preflight gate above: a turn that never reaches the
    // SDK never lands in the transcript, so it must not consume a seq either.
    // spec/04 § History — the turn opens in the chat's own history log before
    // anything it produces is written there.
    const turnId = randomUUID();
    let turnOutcome: TurnOutcome = 'failed';
    let turnError: { code: ChatErrorCode; message: string } | undefined;
    this.branchIds.delete(chatId);
    // This turn opens a new track (fork/side thread): it is that track's OWN
    // inaugural turn, so it belongs to `activeBranchId` directly — `forkChat`/
    // `sideChat` already made it active — never to `branchIdFor`'s
    // session-matching fallback, which would find the PARENT's branch instead
    // (the new branch has no session of its own yet; the parent's still does,
    // since this turn resumes the parent's session under the hood).
    this.turnBranches.set(
      chatId,
      fork
        ? (this.opts.metaStore.read(chatId)?.activeBranchId ?? `${chatId}-b0`)
        : this.branchIdFor(chatId),
    );
    if (fork) this.runningForks.set(chatId, fork);
    this.chatLog.beginTurn(chatId, turnId);
    try {
      this.logRecord(chatId, {
        k: 'turn.start',
        harness: this.harnessOf(chatId),
        model: state.model ?? null,
        ...(state.claudeSessionId ? { sessionId: state.claudeSessionId } : {}),
        origin: origin ?? 'user',
        ...(localId !== undefined ? { localId } : {}),
        ...(retryOfSeq !== undefined ? { retryOfSeq } : {}),
      });
    } catch (err) {
      if (!(err instanceof HistoryWriteError)) throw err;
      this.abandonTurnOnHistoryFailure(chatId, err);
      return false;
    }
    const userContent = persistedUserContent(prompt);
    // Every leading `<system-reminder>` block this prompt actually carried
    // (spec/02 § System-reminder disclosure) — the same blocks `userContent`
    // above just had stripped out of it, captured here instead of discarded so
    // the live event carries them out-of-band, exactly like the replayed twin
    // `jsonlLineToWire` builds from the persisted transcript later.
    const systemContext = extractSystemContext(prompt);
    // The persisted user turn's OWN seq — captured here so a later failure
    // (either branch below) can attach itself to this exact message. Not
    // `localId`: the surface reconciles and drops its optimistic localId the
    // moment this chat.message lands, which is BEFORE the SDK query below
    // even starts, so by the time a failure can occur the localId is already
    // gone from the client's copy of this entry. The seq survives that
    // reconciliation (spec/12), so it is the only identity that still works.
    let userMessageSeq: number | undefined;
    if (userContent !== null) {
      const raw: ChatMessageEvent = {
        type: 'chat.message',
        chatId,
        role: 'user',
        content: userContent,
        seq: this.bumpSeq(chatId),
        createdAt: this.opts.now(),
        // Echo the surface's id so it reconciles its optimistic bubble with
        // this persisted copy instead of rendering the turn twice.
        ...(localId !== undefined ? { localId } : {}),
        // spec/12 § A turn is owed until it settles — this attempt is a RE-SEND
        // of a turn already drawn, so it NAMES the bubble it belongs to instead
        // of asking every surface for one of its own.
        ...(retryOfSeq !== undefined ? { retryOfSeq } : {}),
        ...(systemContext.length > 0 ? { systemContext } : {}),
        // spec/08 § Action, spec/14 § Job trigger turn — a job's fire, not Tom
        // typing, whichever turn of the chat this is.
        ...(jobTrigger ? { jobTrigger } : {}),
        // spec/20-hooks.md § On the agent's response — this turn IS a hook
        // block's resubmit, or carries a deferred advise note (or both are
        // absent, the ordinary case).
        ...(hookTrigger ? { hookTrigger } : {}),
        // spec/04 § Goals — this turn IS a goal's `not_met` resubmit.
        ...(goalTrigger ? { goalTrigger } : {}),
      };
      userMessageSeq = raw.seq;
      const key = eventIdentity(raw);
      /* v8 ignore next -- chat.message always has an identity; the null branch exists only to satisfy the union-wide return type of eventIdentity. */
      if (key !== null) this.recordCanonicalSeq(chatId, identityHash(key), raw.seq);
      const [hydrated] = this.hydrateReplayAttachments(chatId, [raw]);
      try {
        this.emit(hydrated as ChatMessageEvent);
      } catch (err) {
        if (!(err instanceof HistoryWriteError)) throw err;
        this.abandonTurnOnHistoryFailure(chatId, err);
        return false;
      }
      if (retryOfSeq !== undefined) {
        // Claude Code's transcript stores this re-send as an ordinary user turn
        // and knows nothing about the one it is repeating, so a replay would
        // re-expand the fold into one bubble per attempt. Record the link where
        // replay can splice it back in (`replayChat`, like permissionModeMarks).
        this.recordRetryMark(chatId, raw.seq, retryOfSeq);
      } else {
        // FIRST attempt: the turn now HAS a bubble, so from here on it can be
        // named. Re-persist the crash marker with it, or a host killed after
        // this point resumes the turn with no anchor and draws a second bubble
        // — which is exactly the duplicate this whole field exists to stop.
        turnAnchorSeq = raw.seq;
        const running = this.runningTurn.get(chatId);
        if (running !== undefined) {
          this.runningTurn.set(chatId, { ...running, retryOfSeq: raw.seq });
          this.persistPendingTurns(chatId);
        }
      }
    }

    // Per-query MCP child env: bake PATCH_CHAT_ID in here, NOT at host
    // boot, because the chatId is per-query. patch-tools-server.ts hard-fails
    // (NO FALLBACK) when PATCH_CHAT_ID is missing, so a missed injection
    // 100% breaks every Claude SDK query. Group 10 BLOCKER A.2.
    const mcpServer = this.opts.mcpServer
      ? {
          ...this.opts.mcpServer,
          env: { ...this.opts.mcpServer.env, PATCH_CHAT_ID: chatId },
        }
      : undefined;
    // The mode the turn runs under: the chat's own, stamped when it was created
    // and changed only from within the chat (spec/02 § Permission mode) — then
    // resolved against what this chat's MODEL can actually do.
    //
    // `auto` needs a model that supports it, and Claude Code does not refuse the
    // combination: it substitutes `default` and says nothing, so an unattended
    // chat quietly starts asking a human to approve every tool call. Resolving
    // it here makes the degrade patch's own decision, announced once in the chat
    // rather than discovered from the outside. The `init` check in sdkBackend
    // stays as the backstop for anything this table gets wrong.
    const configuredMode = this.chatPermissionMode(chatId);
    const resolved =
      state.model === undefined || isCodexModel(state.model)
        ? { mode: configuredMode }
        : resolvePermissionModeForModel(configuredMode, state.model);
    const permissionMode = resolved.mode;
    if (resolved.degradedFrom !== undefined) {
      this.announcePermissionModeDegrade(
        chatId,
        resolved.degradedFrom,
        permissionMode,
        state.model,
      );
    }
    // spec/06 § Manager conversation — bounded context: the Manager's model
    // only ever sees the last N messages of its own conversation. Checked
    // BEFORE the provider-switch logic below so a bounded reseed and a
    // switch never fight over `state.claudeSessionId` in the same turn — a
    // bounded reseed that fires rewrites it in place, and the switch logic
    // then sees the fresh session like any other.
    if (chatId === SPECIAL_THREAD_IDS.manager) {
      await this.ensureBoundedManagerContext(chatId);
    }
    // spec/04 § History — a seamless provider switch: the chat's own session
    // and its MODEL's harness have fallen out of step (setChatModel crossed
    // providers), so this turn resumes onto the NEW harness by reconstructing
    // the chat's own track as a native session there, rather than resuming
    // `state.claudeSessionId` (which belongs to the OLD harness) or starting
    // fresh with nothing.
    const sessionHarness: HarnessId | undefined = state.claudeSessionId
      ? state.claudeSessionId.startsWith('codex-')
        ? 'codex'
        : 'claude'
      : undefined;
    const targetHarness = this.harnessOf(chatId);
    const isProviderSwitch = sessionHarness !== undefined && sessionHarness !== targetHarness;
    // Patch's own log is the record, the provider session only a cache of it.
    // A chat restored from disk that has no native session left to resume (the
    // host died before the provider ever returned an id, or the id/transcript
    // was cleared above as orphaned or empty) is rebuilt from the log exactly
    // as a provider switch is — the prior messages, tool calls and results,
    // and the interrupted turn's own original prompt all reach the model —
    // instead of starting a contextless session that only sees this prompt.
    const isNativeRebuild =
      !isProviderSwitch &&
      isResume &&
      !fork &&
      !state.claudeSessionId &&
      this.hasPriorTrack(chatId, userMessageSeq);
    // spec/04 § History — preserve the cached prefix: a return to a harness
    // this track used before resumes ITS OWN prior session and hands over
    // only the delta (everything that happened elsewhere since), so the
    // provider's prompt cache still covers everything up to the switch.
    // Building from scratch is reserved for a harness this track has never
    // run on (or whose prior session is genuinely gone).
    let reconstructTrack: readonly TrackEntry[] | undefined;
    let resumeExistingNativeSessionId: string | undefined;
    if (isProviderSwitch || isNativeRebuild) {
      const compactRequest = this.pendingCompactSwitch.get(chatId);
      this.pendingCompactSwitch.delete(chatId);
      // spec/04 § History — "switch and compact": only honoured when it's
      // still the SAME switch it was requested for (the model hasn't moved
      // again since — a stale request from a switch that never ran does not
      // silently fire on a different one).
      const useCompact =
        isProviderSwitch &&
        compactRequest !== undefined &&
        compactRequest.outgoingSessionId === state.claudeSessionId;
      let chosen: {
        track: TrackEntry[];
        activeBranchId: string;
        fullTrackLastSeq: number;
      };
      if (useCompact) {
        const compact = await this.buildCompactSwitchTrack(
          chatId,
          state.folder,
          compactRequest!.outgoingSessionId,
          compactRequest!.outgoingModel,
          userMessageSeq,
        );
        // NO FALLBACK: the user asked for the cheap path specifically: a
        // digest failure fails the SWITCH loudly rather than silently
        // reconstructing in full instead (spec/04 § History).
        if (!compact.ok) {
          this.aborters.delete(chatId);
          const error = { code: 'switch_compact_failed' as const, message: compact.error };
          this.emit({
            type: 'chat.error',
            chatId,
            error,
            seq: this.bumpSeq(chatId),
            ...(userMessageSeq !== undefined ? { causeSeq: userMessageSeq } : {}),
          });
          this.closeTurnInHistory(chatId, 'failed', error);
          this.chatState.setActivity(chatId, 'idle');
          this.emitState(chatId);
          return false;
        }
        chosen = compact;
      } else {
        const plan = await this.planHarnessReconstruction(
          chatId,
          targetHarness,
          state.folder,
          userMessageSeq,
        );
        chosen = plan;
        resumeExistingNativeSessionId = plan.resumeExistingSessionId;
      }
      reconstructTrack = chosen.track;
      // A rebuild after a restart is not a switch: no divider to announce.
      if (isProviderSwitch) {
        this.runningProviderSwitch.set(chatId, {
          toHarness: targetHarness,
          toModel: state.model ?? null,
          // `role: 'system'` messages (a compaction note, an earlier
          // `sessionChange` divider) never make it into the reconstruction
          // itself (`toClaudeSessionEntries`/`toResponsesItems` both drop
          // them) — excluded here too so this count matches what the target
          // harness actually receives.
          seededMessages: reconstructTrack.filter(
            (t) => t.event.type === 'chat.message' && t.event.role !== 'system',
          ).length,
        });
      }
      // Stash the OUTGOING harness's own session + how much of the track it
      // already has — a LATER return to it reads this back as `prior` above.
      // Written unconditionally (a chat leaving a harness for the first
      // time), never mind whether THIS switch resumes an old session itself,
      // or compacted rather than reconstructing in full — a plain return trip
      // LATER should still ride the outgoing session's own full cache.
      if (sessionHarness !== undefined && state.claudeSessionId) {
        const outgoingSessionId = state.claudeSessionId;
        const lastSeq = chosen.fullTrackLastSeq;
        this.opts.metaStore.update(chatId, (m) => ({
          ...m,
          branches: (m.branches ?? []).map((b) =>
            b.branchId === chosen.activeBranchId
              ? {
                  ...b,
                  harnessSessions: {
                    ...b.harnessSessions,
                    [sessionHarness]: { sessionId: outgoingSessionId, lastSeq },
                  },
                }
              : b,
          ),
        }));
      }
      // Claude's resume rides the SDK's own SessionStore, which we drive
      // ourselves here rather than through `sessionStoreOptFor` (sdkBackend.ts)
      // so the delta lands in the mirror BEFORE the resume call, threaded onto
      // the existing session's own last entry rather than a disconnected
      // second root (spec/04 § History).
      if (resumeExistingNativeSessionId && targetHarness === 'claude') {
        const store = this.claudeSessionStoreFor(chatId, state.folder);
        const key = { projectKey: chatId, sessionId: resumeExistingNativeSessionId };
        const existing = await store.load(key);
        // `load()` can source `existing` from the harness's own on-disk
        // transcript when this session predates the mirror (never resumed
        // through this feature before). `append()` only ever writes the
        // MIRROR, so without re-affirming `existing` there first, appending
        // just the delta would leave the mirror holding ONLY the delta — the
        // next resume would find that non-empty mirror and lose everything
        // before it. A no-op (dedup by uuid) when `existing` already WAS the
        // mirror's own content.
        if (existing && existing.length > 0) await store.append(key, existing);
        const startParentUuid = existing?.at(-1)?.['uuid'];
        await store.append(
          key,
          toClaudeSessionEntries(reconstructTrack, {
            sessionId: resumeExistingNativeSessionId,
            folder: state.folder,
            model: state.model ?? null,
            startParentUuid: typeof startParentUuid === 'string' ? startParentUuid : null,
          }),
        );
      }
    }
    const sdkOpts: SdkRunOptions = {
      prompt,
      cwd: state.folder,
      // Keys the persistent warm-session map (PATCH_PERSISTENT_SESSIONS=1);
      // ignored by the one-shot default path.
      chatId,
      resumeSessionId:
        resumeExistingNativeSessionId ??
        ((isProviderSwitch || isNativeRebuild) && targetHarness === 'claude'
          ? randomUUID()
          : state.claudeSessionId),
      ...(targetHarness === 'claude'
        ? {
            claudeSessionStore: {
              nativeDir: this.nativeClaudeDirFor(chatId),
              claudeProjectsRoot: this.claudeProjectsRoot,
              logger: this.opts.logger,
              onAppend: (entries) => this.noteMirroredEntries(chatId, entries),
              // Only a from-scratch rebuild reseeds — a resume of an existing
              // session already had its delta appended to the mirror above,
              // so a PLAIN resume picks it up.
              ...((isProviderSwitch || isNativeRebuild) &&
              !resumeExistingNativeSessionId &&
              reconstructTrack
                ? { reseed: { events: reconstructTrack, model: state.model ?? null } }
                : {}),
            },
          }
        : {}),
      ...((isProviderSwitch || isNativeRebuild) && targetHarness === 'codex' && reconstructTrack
        ? resumeExistingNativeSessionId
          ? { codexAppendItems: { events: reconstructTrack } }
          : { codexReseed: { events: reconstructTrack } }
        : {}),
      // spec/04 § Branching — this turn opens a new TRACK: resume the parent
      // session only up to the shared prefix and land the turn in a fresh
      // session, leaving the parent transcript intact.
      ...(fork ? { fork } : {}),
      abortController,
      oauthAccessToken: oauth.accessToken,
      ...(oauth.accountId ? { accountId: oauth.accountId } : {}),
      ...(mcpServer ? { mcpServer } : {}),
      ...(state.model !== undefined ? { model: state.model } : {}),
      permissionMode,
      // spec/02 § Native subagent dispatch — talking to the user is the
      // PARENT's job, so a subagent never gets the tools that do it, on top
      // of whatever the user has toggled off for this chat.
      disabledTools: state.subagent
        ? [
            ...(state.disabledTools ?? []),
            ...(state.subagent.disallowedTools ?? []),
            ...SUBAGENT_DISALLOWED_PATCH_TOOLS,
          ]
        : state.disabledTools,
      // Wired for EVERY mode: the underlying SDK decides internally whether
      // to actually invoke this, based on its own per-mode rules AND its own
      // safety checks — `auto`'s classifier and `bypassPermissions` normally
      // resolve an ordinary tool call themselves without reaching here, but
      // we've proven live that the SDK can still escalate a rare
      // safety-check case (e.g. a write to a "sensitive file") through this
      // same callback even under those modes. Second-guessing that with our
      // own mode check meant such an escalation had nowhere to go and hung
      // forever, so patch no longer omits this for any mode — it trusts the
      // SDK's own gating instead.
      onPermissionRequest: (req: {
        tool: string;
        args: Record<string, unknown>;
        description?: string;
      }) => this.requestPermission(chatId, req.tool, req.args, req.description),
      onToolBoundary: async () => {
        // What the server holds joins the host's own queue behind this turn, then
        // the whole queue is handed over in order.
        for (const waiting of (await this.opts.pullQueued?.(chatId)) ?? []) {
          await this.sendInput(chatInputToSendOptions(waiting));
        }
        return this.deliverQueuedAtBoundary(chatId);
      },
      // Per-host harness config (Task 3): system prompt and skill list overrides.
      ...(this.harnessConfig.systemPrompt ? { systemPrompt: this.harnessConfig.systemPrompt } : {}),
      // The patch-tools guidance rides alongside as an APPEND, so it adds to
      // whichever prompt is in force rather than replacing it.
      ...(this.harnessConfig.toolsPrompt ? { toolsPrompt: this.harnessConfig.toolsPrompt } : {}),
      ...(this.harnessConfig.skills !== undefined ? { skills: this.harnessConfig.skills } : {}),
      // spec/14 § Agent behavior — Memory + CLAUDE.md toggles both ride the
      // SDK's `settings` flag-layer option (highest-priority settings
      // source), rather than editing the host's own settings.json, so
      // flipping either never touches a file another chat might be reading.
      ...(this.harnessConfig.memoryEnabled !== undefined ||
      (this.harnessConfig.claudeMdExcludePaths?.length ?? 0) > 0
        ? {
            settings: {
              ...(this.harnessConfig.memoryEnabled !== undefined
                ? { autoMemoryEnabled: this.harnessConfig.memoryEnabled }
                : {}),
              ...(this.harnessConfig.claudeMdExcludePaths?.length
                ? { claudeMdExcludes: this.harnessConfig.claudeMdExcludePaths }
                : {}),
            },
          }
        : {}),
      // Settings → MCP — the host's enabled MCP servers, wired in after
      // `patch` by `buildSdkEnv` (Claude) or `config.mcp_servers` (Codex) —
      // plus whatever Claude Code's own config already names for this folder
      // (`claudeConfigMcp.ts`), which the SDK's inline `mcpServers` option
      // would otherwise silently drop. The host's own list is listed second so
      // it wins a name collision: it is the one the user can see and edit
      // inside Patch, so it is the one that should win.
      // Undefined (mock/test callers that never configured harness) reads as
      // none, same as every other harness field's absence.
      extraMcpServers: [
        ...this.opts.discoverClaudeMcpServers(state.folder),
        ...(this.harnessConfig.mcpServers ?? []),
      ],
    };
    // Record + log the resume argument so it's observable on the live host
    // (control-UDS `lastQueryDiagnostics`, `patch doctor`) — the spec/02
    // restart-resume guarantee (D3-6) without needing the in-process mock hook.
    this.lastQuery.set(chatId, {
      resumeSessionId: state.claudeSessionId,
      at: this.opts.now(),
    });
    this.opts.logger.info(
      {
        chatId,
        resumeSessionId: state.claudeSessionId ?? null,
        // Pass-through SDK options (spec/13): observable on the live host.
        model: state.model ?? null,
        permissionMode,
      },
      state.claudeSessionId ? 'starting SDK query (resume)' : 'starting SDK query (fresh session)',
    );

    const run = (async (): Promise<boolean> => {
      try {
        for await (const env of this.opts.sdkBackend.run(sdkOpts)) {
          this.handleEnvelope(chatId, env, userMessageSeq);
        }
        turnOutcome = 'completed';
        // A turn that completes cleanly RECOVERS an errored chat: drop the
        // errored status and the persisted error detail so it no longer counts
        // toward doctor's erroredChats and stops advertising a stale lastError.
        const settled = this.chatState.get(chatId);
        if (settled && settled.status === 'errored') {
          settled.status = 'active';
          this.opts.metaStore.update(chatId, (m) => {
            const { lastError: _drop, ...rest } = m;
            void _drop;
            return { ...rest, status: 'active', updatedAt: this.opts.now() };
          });
        }
        // If the turn ended while a permission request is still outstanding,
        // the chat is paused on the user, not finished — keep it
        // `awaiting-permission` so the surface badge + `waiting on you` pill
        // stay up. (With the real SDK the `canUseTool` callback blocks the
        // iterator until the user responds, so the loop wouldn't complete with
        // a pending request; the dev mock yields the permission envelope then
        // returns, so we must hold the state here.) The chat settles back to
        // idle once `submitPermissionResponse` resolves the request.
        if (this.hasPendingPermission(chatId)) {
          this.chatState.setActivity(chatId, 'awaiting-permission');
          this.emitState(chatId);
          return true;
        }
        // Successful turn clears any overload backoff count so the next retry
        // starts fresh from 5 s if the server is overloaded again (Task 2).
        this.overloadRetryCount.delete(chatId);
        // A settled turn also ends any run of generic SDK failures, so the
        // next one starts from the first backoff step rather than inheriting
        // an old chat's exhausted budget.
        this.sdkRetryCount.delete(chatId);
        // A turn that got through owes nothing to the accounts it was bounced
        // between: the next turn starts with every account eligible again.
        this.failoverTriedAccounts.delete(chatId);
        this.unparkTurn(chatId);
        // spec/04 § Message queueing — a turn that settles with more turns still
        // queued behind it has NOT finished the chat's work: `drainQueue` starts
        // the next one on the very next tick. Reporting `idle` here and `running`
        // again a moment later is a lie the whole system acts on — the server's
        // Manager watch loop reads the running → idle edge as "finished its turn"
        // (spec/06 § The watch loop) and pages the user to go and look at a chat
        // that is still working, and every surface's badge blinks "done"
        // mid-queue. The chat holds `running` until the queue is empty. An auth
        // refusal, a rate-limit park and `awaiting-permission` are NOT gated:
        // they settle for reasons the queue cannot fix, so they stay exactly as
        // they were. A stop IS gated, on the same condition — see the aborted
        // branches: a promote stops the turn precisely BECAUSE there is a
        // queued turn waiting to run.
        if (this.hasQueuedTurns(chatId)) return true;
        // The drain is over, so this frame reports the whole drain ending. If the
        // user sent anything into it they are waiting on it, whatever the last
        // turn happened to be (spec/09 § Whose turn it was).
        this.settleTurnOrigin(chatId);
        // spec/09 § What the message says — stamp the turn's own closing words
        // onto the state BEFORE the settling frame goes out, so the frame the
        // server's doorbell fires on already carries them. This is the whole
        // point of the field: `maybeGenerateStatus` below produces a nicer line
        // but does it in a separate model call that lands on a later frame, by
        // which time the notification has already been sent.
        this.stampTurnSummary(chatId, assistantSeqBeforeTurn);
        this.chatState.setActivity(chatId, 'idle');
        this.emitState(chatId);
        // patch/todo.md § Features to add — "Current status": summarise the
        // thread's current status after EACH turn settles (not just the first).
        // Fire-and-forget — the assistant response was already emitted, so this
        // never delays the surface. Skipped mid-queue with the idle transition
        // above: the summary describes a SETTLED turn (`maybeGenerateStatus`
        // discards it unless the chat is still idle when it lands), so firing it
        // between queued turns only spends a model call on a line that is thrown
        // away — the last turn of the drain generates the one that sticks.
        if (!isCodexModel(state.model)) this.maybeGenerateStatus(chatId, prompt);
        // A first title that failed every attempt (host busy at deploy time,
        // provider timeout) cleared its guard; the settled turn is the next
        // chance, so a chat is never left "New chat" while turns keep landing.
        if (state.name === null && !this.titleGenerated.has(chatId)) {
          this.maybeGenerateTitle(chatId, prompt);
        }
        // patch/todo.md § "todo list": the turn has settled idle with nothing
        // outstanding — if the agent's todo list still has a pending item, fire
        // the next one back into the chat so it works the list one focused turn
        // at a time. Fire-and-forget (starts a new turn), like the self-wake.
        // Also gated on the empty queue: the user's own waiting messages come
        // first, and the todo the host would pick now is chosen from a list
        // those turns are about to rewrite. Nothing is lost — the item is
        // re-selected from fresh state when the last queued turn settles.
        this.maybeAdvanceTodos(chatId);
        // spec/20-hooks.md § On the agent's response — fire the check for
        // EVERY turn, Claude and Codex alike (unlike `maybeGenerateStatus`
        // above, this is not an extra model call of its own unless the hook
        // itself is a `prompt` one, and that is the user's own hook config,
        // not this host's choice to make on a model's behalf).
        this.maybeCheckAgentResponseHooks(chatId);
        // spec/04 § Goals — judge the chat's active goal (if any) against the
        // turn that just settled. Claude and Codex alike, like the hook check
        // above, since this is the host's own choice to spend a model call,
        // not something the user configured.
        this.maybeEvaluateGoal(chatId);
        return true;
      } catch (err) {
        // spec/04 § History — the chat's history could not be written. Checked
        // before the stop below: a failed append aborts the turn itself, and
        // that abort is not the user's.
        const historyFailure =
          this.historyFailures.get(chatId) ?? (err instanceof HistoryWriteError ? err : undefined);
        if (historyFailure) {
          turnError = { code: 'history_write_failed', message: historyFailure.message };
          this.reportHistoryFailure(chatId, historyFailure, userMessageSeq);
          return false;
        }
        // A user-initiated stop (`patch stop` / stopChat → abortController.abort)
        // is NOT an error: the SDK iterator throws an AbortError, but the chat
        // was terminated deliberately. `stopChat` already emits `chat.stopped`
        // (reason: user-stop). Settle the chat back to `idle` WITHOUT emitting a
        // spurious chat.error or marking it `errored` (which would otherwise
        // inflate doctor's errored-chat count and surface a red error in the
        // UI). spec/13 + spec/17: `patch stop` = clean termination.
        if (abortController.signal.aborted) {
          turnOutcome = 'stopped';
          // ...but a stop with turns still QUEUED is not the end of the chat's
          // work, it is the middle of it. `promoteInput` stops the in-flight
          // turn precisely BECAUSE there is a queued turn waiting to run (the
          // up-arrow, and the head-of-queue 30 s auto-interrupt), so the queue
          // is exactly what resolves this stop: `drainQueue` starts the
          // promoted turn on the very next tick. Reporting `idle` here emitted
          // a running -> idle edge indistinguishable from a real finish, and
          // sending a second message into a working chat pushed a "<chat>
          // finished" notification for a chat that went straight back to
          // `running`. Hold `running` across the interrupted drain like the
          // settled-turn path does, so the drain produces ONE settling frame at
          // its true end. `chat.stopped{user-stop}` is emitted independently
          // (see `announceStopped`), so the surface still labels the
          // interrupted turn, and `runTurnsFrom`'s finally still settles a chat
          // whose queue is abandoned. A BARE stop — nothing queued — is
          // unchanged: it has no turn to hand `running` on to and the composer
          // must reopen.
          if (this.hasQueuedTurns(chatId)) return false;
          this.chatState.setActivity(chatId, 'idle');
          this.emitState(chatId);
          return false;
        }
        const errMsg = (err as Error).message ?? String(err);
        turnError = { code: 'sdk_error', message: errMsg };
        // What the provider said about the limit, structured — carried through
        // the error boundary rather than re-read out of the sentence. Undefined
        // for a failure that stated no limit (a crash, an abort).
        const limit = err instanceof TurnFailedError ? err.limit : undefined;
        // A rate-limit or overloaded error is temporary — the limit resets on a
        // known schedule (the SDK's `rate_limit_event` carries `resetsAt`). When
        // `autoResumeRateLimit` is on, park the turn and retry at `resetsAt`
        // instead of leaving the chat in a permanent `errored` state. The chat
        // moves to `idle` immediately (so a manual re-send is also possible) and
        // surfaces see `rateLimitResumingAt` so they can show "paused — resuming
        // at HH:MM". A chat stopped by the user mid-turn has its aborter set, so
        // the aborted-check above already returned — this branch is only reached
        // for genuine API-side limit rejections.
        // THIS ACCOUNT is out of credit, and the host may have another with
        // funds. Re-run the turn: the account resolver has just been told this
        // account is spent, so the re-run resolves to one that is not.
        //
        // The chat's own account preference is deliberately NOT rewritten. It is
        // re-resolved every turn, so the moment the spent account's limit resets
        // this chat is back on it — it is the higher priority and always was.
        // Re-pinning would strand it on the second account, spending the wrong
        // credit indefinitely, and would need undoing later by something that
        // remembered why.
        //
        // Only THIS turn pays a failure. Every other chat routes around the
        // spent account without failing at all.
        //
        // IS THERE CREDIT ANYWHERE ON THIS HOST? Asked of the host rather than
        // of this error, so it is true for a turn that died of something else
        // entirely while every key was spent, and settled BEFORE the failover
        // walk below can mark another account and change the answer.
        let hostOutOfCredit = this.opts.hostOutOfCredit?.() === true;
        if (
          (!isCodexModel(state.model) || (err instanceof CodexTurnError && err.retrySafe)) &&
          isAccountExhausted(limit, errMsg) &&
          this.opts.nextAccountAfterExhausted
        ) {
          const cur = this.chatState.get(chatId);
          const failed = this.runningOnAccount.get(chatId);
          const next = this.opts.nextAccountAfterExhausted(chatId, failed, errMsg, limit);
          const tried = this.failoverTriedAccounts.get(chatId) ?? new Set<string>();
          if (failed !== undefined) tried.add(failed);
          if (next !== undefined && next !== failed && !tried.has(next)) {
            // `next` counts as tried from here: a host that keeps handing out the
            // spent key while its rotation keeps naming another would otherwise
            // re-run this turn for ever. Under round-robin another chat's turn
            // can move the rotation on so the re-run lands elsewhere; the key it
            // skipped then waits for the reset rather than being tried — the
            // price of the loop being impossible.
            tried.add(next);
            this.failoverTriedAccounts.set(chatId, tried);
            this.opts.logger.warn(
              { chatId, spentAccount: failed ?? null, runningOn: next },
              'account out of credit — re-running this turn on an account that has some',
            );
            if (prompt !== undefined) {
              void this.sendInput({
                chatId,
                message: prompt,
                localId: `acct-failover-${chatId}-${this.opts.now()}`,
                ...(cur?.turnOrigin === 'machine' ? { origin: 'machine' as const } : {}),
              });
            }
            this.chatState.setActivity(chatId, 'idle');
            this.emitState(chatId);
            return false;
          }
          this.failoverTriedAccounts.set(chatId, tried);
          // Nowhere left to go: this IS a host with no credit, whatever a
          // store-less `hostOutOfCredit` was able to say a moment ago.
          hostOutOfCredit = true;
          this.opts.logger.warn(
            { chatId, spentAccount: failed ?? null, alreadyTried: [...tried] },
            'account out of credit and no other untried account has any — waiting for the reset',
          );
        }
        if (
          this.autoResumeRateLimitEnabled &&
          (!isCodexModel(state.model) ||
            (err instanceof CodexTurnError &&
              err.retrySafe &&
              this.opts.accountLimitInfo?.(this.runningOnAccount.get(chatId))?.resetsAt !==
                undefined)) &&
          // A failure that STATES when it lifts is a limit whatever its wording:
          // the structured `resetsAt`, or a reset the prose gives. Without this
          // such a failure matched neither phrase list and went down the 10/30/90s
          // ladder against a limit that was already known to last hours.
          (isRateLimitError(errMsg) || this.statedResetOf(limit, errMsg) !== undefined)
        ) {
          const now = this.opts.now();
          const isOverload = isOverloadedError(errMsg);
          /**
           * The instant to re-run the turn at — or UNDEFINED for "park it and
           * wait to be told", which is a real and correct outcome rather than a
           * missing value.
           *
           * It is undefined when nothing stated a reset AND the host has no
           * credit on any account. There is then no instant worth arming for:
           * the only honest wait is for one of `creditResume.ts`'s events — a
           * key added, a key reconnected, or a usage reading that shows an
           * account spendable again — and a timer is a guess competing with
           * them. The 60-second guess that used to go here re-ran a real turn
           * against a host it had JUST reported as having no credit anywhere,
           * once a minute, for as long as the limit lasted.
           *
           * It also defeated the observation path that was supposed to save it:
           * every re-run refused again and re-marked the account, so
           * `observedUsable`'s "is this reading LATER than the refusal" test
           * never came true and logged the contradiction 334 times instead.
           */
          let resumeAt: number | undefined;
          let resumeKind: 'rate_limit' | 'overloaded';
          /**
           * The reset the provider actually STATED, which is not the same thing
           * as the instant a resume was armed for. Only a stated one may reach
           * the block, and through it the countdown (spec/12): where nothing
           * states a reset there is no countdown at all, because a promise the
           * limit has not made is worse than an open-ended wait. Publishing the
           * 60-second fallback here made every unstated limit claim to reset in
           * a minute, and a minute later the notice read as though the limit
           * were over while the account was still spent for days.
           */
          let statedResetsAt: number | undefined;
          if (isOverload) {
            // 529 overloaded: transient server load, no SDK resetsAt. Use
            // exponential backoff starting at 5 s, doubling per retry, capped
            // at 60 s so the retry stays prompt once load clears (Task 2).
            const retries = (this.overloadRetryCount.get(chatId) ?? 0) + 1;
            this.overloadRetryCount.set(chatId, retries);
            const backoffMs = Math.min(5_000 * Math.pow(2, retries - 1), 60_000);
            resumeAt = now + backoffMs;
            resumeKind = 'overloaded';
          } else {
            // 429 / usage-limit: pick the SOONEST per-scope resetsAt so a
            // 5-hour session limit (resetting hours from now) is not
            // accidentally deferred to the 7-day week's resetsAt (days away).
            // Task 1 fix: track session and week separately.
            this.overloadRetryCount.delete(chatId);
            const scopes = this.lastResetsAtByScope.get(chatId);
            // The failure carries its own reset instant — `quotaLimits.resetsAt`,
            // an exact epoch on the same message as the text. Prefer it over
            // re-deriving one from the prose ("… resets 7pm (UTC)"), which is
            // both lossy and one wording change away from silently returning
            // nothing. The prose parse stays as the fallback for a provider
            // that states a reset but carries no structured field.
            const stated = limit?.resetsAt ?? parseLimitResetsAt(errMsg, now);
            const candidates = [scopes?.session, scopes?.week, stated].filter(
              (t): t is number => t !== undefined && t > now,
            );
            const soonest = candidates.length > 0 ? Math.min(...candidates) : undefined;
            // The fallback is for a limit on a host that still has credit
            // SOMEWHERE — one key refused, the rotation has another, and a
            // prompt re-run lands on it. Where there is none, a minute is not a
            // short wait for the right thing, it is the wrong thing repeated.
            const FALLBACK_DELAY_MS = 60_000;
            resumeAt = soonest ?? (hostOutOfCredit ? undefined : now + FALLBACK_DELAY_MS);
            statedResetsAt = soonest;
            resumeKind = 'rate_limit';
          }
          // Surface "paused — resuming at HH:MM" before the timer fires. Only
          // ever a real instant: a park with nothing to arm for has no HH:MM to
          // show, and showing one would promise a resume nobody scheduled.
          if (resumeAt !== undefined) this.rateLimitResumingAt.set(chatId, resumeAt);
          this.resumeKindMap.set(chatId, resumeKind);
          if (resumeKind === 'rate_limit') {
            this.setLimitBlock(chatId, errMsg, limit, statedResetsAt);
          }
          if (prompt !== undefined) {
            this.rateLimitPendingTurns.set(chatId, {
              message: prompt,
              localId,
              ...(turnAnchorSeq !== undefined ? { retryOfSeq: turnAnchorSeq } : {}),
            });
            this.parkTurn(chatId, prompt, localId, turnAnchorSeq);
          }
          // A usage limit is a failed turn that happens to be owed, not a
          // finished one: `idle` drew the green tick and rang "finished". The
          // transcript bubble carries the detail, so no `chat.error` row — but
          // the state is `errored`, with patch's own words as the last error
          // for the triangle and the failure notification. An overload backoff
          // is transient load and stays quiet.
          if (resumeKind === 'rate_limit') {
            const stated = statedLimitOf(limit, errMsg);
            const block = this.limitBlocks.get(chatId);
            const reportedMsg =
              stated === undefined
                ? errMsg
                : limitFailureMessage(stated, {
                    ...(block?.accountLabel !== undefined
                      ? { accountLabel: block.accountLabel }
                      : {}),
                    ...(block?.resetsAt !== undefined ? { resetsAt: block.resetsAt } : {}),
                  });
            const detail = {
              code: 'sdk_error' as const,
              message: reportedMsg,
              at: this.opts.now(),
            };
            this.chatState.setLastError(chatId, detail);
            this.chatState.setActivity(chatId, 'errored');
            // AND ON DISK — not as `status`, which stays `active` because a
            // parked turn is a chat with work owed rather than a dead one (the
            // lifecycle status is what archives and sidebars read), but the
            // DETAIL has to survive a restart. Chat state is memory: a host
            // restarted during a limit forgot both the park and the reason for
            // it, which left the turn on disk with nothing able to say it had
            // ever been about credit. `resumeErroredOnExhaustedAccount` and the
            // boot re-arm both read this back.
            this.opts.metaStore.update(chatId, (m) => ({
              ...m,
              lastError: detail,
              updatedAt: this.opts.now(),
            }));
          } else {
            this.chatState.setActivity(chatId, 'idle');
          }
          this.emitState(chatId);
          // Whichever of the two this is, said as what it is. A park with no
          // timer is not a quiet version of a scheduled resume — it is the host
          // declining to guess, and a log that called it "scheduling" would
          // have nothing to show for the schedule it claimed.
          const existing = this.rateLimitTimers.get(chatId);
          if (existing) clearTimeout(existing);
          if (resumeAt === undefined) {
            this.rateLimitTimers.delete(chatId);
            this.opts.logger.warn(
              { chatId, resumeKind },
              'out of credit with no stated reset — turn parked, waiting for credit to return rather than retrying',
            );
            return false;
          }
          const delayMs = resumeAt - now;
          this.opts.logger.warn(
            { chatId, resumeAt, delayMs, resumeKind },
            'rate limit / overload hit — scheduling auto-resume',
          );
          const timer = setTimeout(() => {
            this.rateLimitTimers.delete(chatId);
            this.rateLimitResumingAt.delete(chatId);
            this.limitBlocks.delete(chatId);
            this.resumeKindMap.delete(chatId);
            const pending = this.rateLimitPendingTurns.get(chatId);
            this.rateLimitPendingTurns.delete(chatId);
            this.unparkTurn(chatId);
            // The pause ends HERE, so say so HERE — on every path out of this
            // callback. Surfaces draw the "resuming at HH:MM" bubble and its Try
            // now button from `chat.state` alone, and NEITHER branch below is
            // guaranteed to emit one: the no-pending branch returns, and a
            // `sendInput` whose localId is already in `seenLocalIds` re-acks and
            // emits nothing at all. Without this the bubble outlives the pause
            // it describes, and every press of Try now afterwards finds nothing
            // parked.
            this.emitState(chatId);
            if (!pending) return;
            // Re-send the original turn. `sendInput` is the public entry point
            // and handles its own queue/pump logic, so a concurrent turn that
            // arrived while we were waiting gets handled correctly.
            void this.sendInput({
              chatId,
              message: pending.message,
              localId: this.resumeLocalId('rl', chatId),
              // spec/09 § Whose turn it was — waiting out a rate limit does not
              // change whose turn this is; it settles as what it started as.
              ...(this.chatState.get(chatId)?.turnOrigin === 'machine'
                ? { origin: 'machine' as const }
                : {}),
              // spec/12 § A turn is owed until it settles — this is the SAME
              // turn going round again, so it names the bubble it already has.
              ...(pending.retryOfSeq !== undefined ? { retryOfSeq: pending.retryOfSeq } : {}),
            });
          }, delayMs);
          this.rateLimitTimers.set(chatId, timer);
          return false;
        }
        // The credential passed the pre-query gate but the API rejected it, so
        // it is dead and NO turn on this host can run until it is replaced.
        // Same outcome as a gate miss: the chat stays idle and re-runnable, and
        // the host is reported unauthenticated rather than this looking like a
        // one-off SDK fault on one chat.
        if (isClaudeCredentialRejectedMessage(errMsg)) {
          this.emitCredentialRejected(chatId, errMsg, userMessageSeq);
          this.chatState.setActivity(chatId, 'idle');
          this.emitState(chatId);
          return false;
        }
        // Claude Code ran the turn in a permission mode nobody chose — and it
        // is not the `plan` exception (spec/02 § Permission mode), which never
        // reaches here: `sdkBackend.ts` yields a `permissionModeAutoDowngrade`
        // envelope for that case instead of throwing, and `handleEnvelope`
        // records it as an ordinary mode change. Every OTHER target is
        // terminal by construction: the mode is unavailable to that `claude`
        // build or that model, so every retry resolves to the same substitution
        // and only buries the reason under three more failures. Report it and
        // stop — the fix is a mode change, a CLI update, or a model change, all
        // of which are a person's decision.
        if (err instanceof PermissionModeDowngradedError) {
          const seq = this.bumpSeq(chatId);
          const detail = {
            code: 'permission_mode_downgraded' as const,
            message: errMsg,
            at: this.opts.now(),
          };
          turnError = { code: detail.code, message: errMsg };
          this.emit({
            type: 'chat.error',
            chatId,
            error: { code: detail.code, message: errMsg },
            seq,
            ...(userMessageSeq !== undefined ? { causeSeq: userMessageSeq } : {}),
          } satisfies ChatErrorEvent);
          this.chatState.setLastError(chatId, detail);
          this.opts.metaStore.update(chatId, (m) => ({
            ...m,
            status: 'errored',
            lastError: detail,
            updatedAt: this.opts.now(),
          }));
          this.chatState.setActivity(chatId, 'errored');
          this.emitState(chatId);
          this.opts.logger.error(
            {
              chatId,
              requested: err.requested,
              effective: err.effective,
              model: this.chatState.get(chatId)?.model ?? null,
            },
            'permission mode downgraded by Claude Code — turn refused',
          );
          return false;
        }
        // Distinguish a stale/missing Claude session from generic SDK
        // failures (spec/04 line 46): clear claudeSessionId so the next
        // input starts fresh, and surface a `claude_session_invalid` code.
        const isSessionInvalid = isClaudeSessionInvalidError(err);
        const code: ChatErrorCode = isSessionInvalid ? 'claude_session_invalid' : 'sdk_error';
        if (isSessionInvalid) {
          const cur = this.chatState.get(chatId);
          if (cur) {
            cur.claudeSessionId = undefined;
            cur.status = 'errored';
            this.opts.metaStore.update(chatId, (m) => {
              const { claudeSessionId: _drop, ...rest } = m;
              void _drop;
              return {
                ...rest,
                status: 'errored',
                lastError: { code, message: errMsg, at: this.opts.now() },
                updatedAt: this.opts.now(),
              };
            });
          }
          // The session is gone and has been cleared, so the chat's NEXT turn
          // must be allowed to start a genuinely fresh session. A chat
          // hydrated-from-disk is otherwise pinned to RESUME-only (F1 guard):
          // with no session id that guard would reject every future turn with
          // `claude_session_missing`, deadlocking the chat forever. Drop it
          // from the hydrated set so the recovery turn is treated as a
          // legitimate first turn (spec/04 line 46: "starts fresh").
          this.hydratedFromDisk.delete(chatId);
        }
        // A LIMIT THE PROVIDER STATED, THAT NOBODY PARKED — auto-resume off, or
        // its retry budget spent. Patch renders its own structured account of
        // this exact failure (spec/12), so the provider's sentence must not be
        // what any surface shows: it is reported in patch's words, from the
        // fields it stated, and the sentence stays in the log and on the block's
        // `raw` where a diagnosis needs it.
        //
        // The block is published HERE and not only on the park path, so there is
        // something in the sentence's place — removing it and leaving nothing
        // would be the worse bug. Driven off the structured facts, never off a
        // match on the wording.
        const stated = statedLimitOf(limit, errMsg);
        // A failure that stated NOTHING about a limit, on a host with no credit
        // on any account, is still a turn blocked on credit — and it must be
        // RECORDED as one. A chat's stored `lastError` is the only evidence the
        // credit-return sweep has (`resumeErroredOnExhaustedAccount` classifies
        // it by text, and so does the re-arm at boot), so a message that says
        // only "Claude Code process exited with code 143" is a turn that can
        // never be picked up again however much credit arrives.
        //
        // Patch's own account of the credit state goes FIRST, so it is what a
        // reader and the sweep both see, and the real failure is preserved in
        // full after it — patch does not get to replace a message it has no
        // account of (see `limitFailure.ts`), only to say what else it knows.
        const blockedOnCredit =
          stated !== undefined ||
          hostOutOfCredit ||
          this.statedResetOf(limit, errMsg) !== undefined;
        if (blockedOnCredit) {
          this.setLimitBlock(chatId, errMsg, limit, undefined);
        }
        // Written off the BLOCK, so the sentence and the bubble state the same
        // account and the same instant rather than two readings of one limit.
        const block = blockedOnCredit ? this.limitBlocks.get(chatId) : undefined;
        const limitWords =
          stated === undefined
            ? undefined
            : limitFailureMessage(stated, {
                ...(block?.accountLabel !== undefined ? { accountLabel: block.accountLabel } : {}),
                ...(block?.resetsAt !== undefined ? { resetsAt: block.resetsAt } : {}),
              });
        const reportedMsg =
          limitWords ??
          (hostOutOfCredit
            ? `Usage limit reached — every account on this host is out of credit. The turn also failed with: ${errMsg}`
            : errMsg);
        turnError = { code, message: reportedMsg };
        const seq = this.bumpSeq(chatId);
        const errorEvent: ChatErrorEvent = {
          type: 'chat.error',
          chatId,
          error: { code, message: reportedMsg },
          seq,
          // Lets the surface attach this failure to the turn's own message
          // (spec/12) instead of a standalone error row.
          ...(userMessageSeq !== undefined ? { causeSeq: userMessageSeq } : {}),
        };
        this.emit(errorEvent);
        // m6: stash on chat_state so patch_peek and chat.state surface the
        // most-recent error reason without forcing surfaces to read history.
        this.chatState.setLastError(chatId, { code, message: reportedMsg, at: this.opts.now() });
        // chat_state is memory: a host restart drops it, and with it the only
        // record of WHY a chat died. The session-invalid branch above persists
        // its own; every other code needs the same, or a chat that failed
        // before a restart comes back looking untouched (`lastError: null`,
        // `activity: idle`) and is indistinguishable from one that never ran.
        if (!isSessionInvalid) {
          this.opts.metaStore.update(chatId, (m) => ({
            ...m,
            lastError: { code, message: reportedMsg, at: this.opts.now() },
            updatedAt: this.opts.now(),
          }));
        }
        this.chatState.setActivity(chatId, 'errored');
        // spec/09 § A turn that failed — say on THIS frame whether the ladder
        // below will run the turn again, because the server decides whether to
        // notify on the edge into `errored` and the retry is armed after it.
        // Same condition as the branch below plus `scheduleSdkRetry`'s budget.
        const failing = this.chatState.get(chatId);
        if (failing) {
          failing.turnRetrying =
            !blockedOnCredit &&
            !isSessionInvalid &&
            (this.sdkRetryCount.get(chatId) ?? 0) < SDK_RETRY_BACKOFF_MS.length;
        }
        this.emitState(chatId);
        this.opts.logger.error({ chatId, err, code }, 'SDK run errored');
        // Everything above reports the failure; this retries it. A turn should
        // only die for a reason someone chose - the user stopped it, the
        // credential was refused, the session is gone, or the retries ran out.
        // A dropped connection or a 5xx mid-stream is none of those, and used
        // to discard the turn in silence. The chat still goes `errored` and
        // still emits chat.error, so surfaces show the failure; the retry then
        // either clears it or exhausts its budget in the open.
        if (blockedOnCredit) {
          // A STATED LIMIT IS NOT ON THE LADDER, and neither is ANY failure on
          // a host with no credit anywhere. The window resets hours away, so
          // three attempts a minute apart only fail three more times, each
          // reporting itself again everywhere a failure is reported — and the
          // last of them is what the chat is left reading, which is how a turn
          // parked for credit came to be recorded as a bare process exit. The
          // turn is still owed, and stays owed: parked with no timer, so `Try
          // now`, the credit-return sweep and the next host boot each have
          // the turn to run, and a turn that settles clears it.
          this.parkTurn(chatId, prompt, localId, turnAnchorSeq);
        } else if (!isSessionInvalid) {
          // Loud on purpose: a failure that reaches the ladder carried no reset
          // patch recognised. If it WAS a limit, this line is the unrecognised
          // shape that needs teaching — so it logs the raw error and limit facts.
          this.opts.logger.warn(
            { chatId, errMsg, limit: limit ?? null },
            'failure matched no stated limit and no reset — falling to the retry ladder',
          );
          this.scheduleSdkRetry(chatId, prompt, errMsg, turnAnchorSeq);
        }
        return false;
        /* v8 ignore next -- coverage-v8 records a phantom always-0 branch at the try/catch->finally boundary; both the try's normal-return and this catch's return are exercised by tests, so this is an instrumentation artifact, not a reachable path. */
      } finally {
        this.aborters.delete(chatId);
        this.runs.delete(chatId);
        this.closeTurnInHistory(chatId, turnOutcome, turnError);
        // However the turn ended — settled, stopped, errored — it is no longer
        // in flight, so it must stop looking like a turn a restart interrupted.
        this.runningTurn.delete(chatId);
        this.persistPendingTurns(chatId);
        // Drop any unfinalised streaming accumulator (turn aborted/errored
        // before its final `assistant` envelope) so the next turn doesn't
        // reuse a stale reserved seq. The reserved seq is simply skipped — gaps
        // are fine for replay (it filters by seq, not contiguity).
        this.pendingDelta.delete(chatId);
        // spec/06 § Cross-chat tools — a subagent chat delivers its result (or
        // failure) to its parent the moment ITS OWN turn truly settles. Every
        // turn this chat ever runs passes through this one finally, so this is
        // the single hook, whatever branch above got it here.
        this.maybeSettleDelegate(chatId);
      }
    })();
    this.runs.set(chatId, run);
    return run;
  }

  /**
   * spec/04 § Name — as soon as a chat's FIRST user message is accepted,
   * summarise it into a short human-readable title. Fired asynchronously so it
   * never blocks the turn that is about to start (or delays on a long-running
   * one). Triggered at most ONCE per chat (`titleGenerated` guard) for the
   * first title; after that, when `chatNameInterval > 0`, re-generates the
   * title every N user messages. Special threads keep their fixed names.
   *
   * A job-spawned chat (`dispatcher.ts` `spawn` action) gets exactly one user
   * message ever, so this single trigger gets `TITLE_GEN_ATTEMPTS` real
   * attempts (with `TITLE_GEN_RETRY_DELAY_MS` between them) before giving up —
   * a transient SDK error or empty first reply must not permanently strand
   * that chat as "New chat" with no later message to retry it. On success the
   * name is set + persisted + re-emitted via `chat.state`; once every attempt
   * is spent, the name stays as-is (NO FALLBACK to dumping the first user
   * message — the client shows folder/"New chat" when the name is null).
   */
  private maybeGenerateTitle(chatId: string, userPrompt: string): void {
    const gen = this.opts.generateTitle;
    if (!gen) return;
    if (isReservedSpecialThread(chatId)) return;
    const state = this.chatState.get(chatId);
    if (!state) return;

    // Track user messages per chat for periodic regen.
    const prev = this.userMessagesSinceTitle.get(chatId) ?? 0;
    const count = prev + 1;
    this.userMessagesSinceTitle.set(chatId, count);

    const interval = this.opts.chatNameInterval ?? 0;
    const isFirstTitle = !this.titleGenerated.has(chatId) && state.name === null;
    const isPeriodicRegen =
      interval > 0 && this.titleGenerated.has(chatId) && count % interval === 0;

    if (!isFirstTitle && !isPeriodicRegen) return;

    // Mark BEFORE the async work so a second message arriving while this one
    // is in flight can never kick off a duplicate generation.
    this.titleGenerated.add(chatId);
    // Reset counter so the next interval starts from 0.
    this.userMessagesSinceTitle.set(chatId, 0);

    // Strip the folded [Attachments] block so a pasted image never leaks a raw
    // path into the title prompt; an attachment-only turn passes a short note.
    const parsed = parseAttachmentBlock(userPrompt);
    const messageText = parsed
      ? parsed.text.trim() !== ''
        ? parsed.text.trim()
        : '(image attachment)'
      : userPrompt;

    const folder = state.folder;
    const chatModel = state.model;
    void (async () => {
      try {
        // A single attempt has no second chance: a job-spawned chat gets
        // exactly one user message ever (dispatcher.ts `spawn` action), so a
        // transient SDK error or empty reply here would otherwise strand it
        // as "New chat" forever. Retry once after a short delay first.
        const retryDelayMs = this.opts.titleGenRetryDelayMs ?? TITLE_GEN_RETRY_DELAY_MS;
        let title: string | null = null;
        for (let attempt = 0; attempt < TITLE_GEN_ATTEMPTS; attempt++) {
          if (attempt > 0)
            await new Promise((r) => setTimeout(r, retryDelayMs * 2 ** (attempt - 1)));
          try {
            title = await gen({
              chatId,
              firstUserMessage: messageText,
              folder,
              ...(chatModel !== undefined ? { chatModel } : {}),
            });
          } catch (err) {
            if (attempt === TITLE_GEN_ATTEMPTS - 1) throw err;
            continue;
          }
          if (title !== null && title.trim() !== '') break;
        }
        if (title === null || title.trim() === '') {
          this.opts.logger.warn(
            { chatId },
            'title generation produced no title; leaving name unchanged',
          );
          // Re-arm a failed FIRST title so the turn settling retries it.
          if (isFirstTitle) this.titleGenerated.delete(chatId);
          return;
        }
        const cur = this.chatState.get(chatId);
        if (!cur) return;
        // For first title: only set when still unnamed (no user override).
        // For periodic regen: always overwrite — the user asked for refresh.
        if (isFirstTitle && cur.name !== null) return;
        const now = this.opts.now();
        cur.name = title;
        this.opts.metaStore.update(chatId, (m) => ({ ...m, name: title, updatedAt: now }));
        this.emitState(chatId);
        this.opts.logger.info({ chatId, title, isPeriodicRegen }, 'chat title generated');
      } catch (err) {
        this.opts.logger.warn({ chatId, err }, 'title generation failed; leaving name unchanged');
        if (isFirstTitle) this.titleGenerated.delete(chatId);
      }
    })();
  }

  /**
   * spec/09 § What the message says. Put the closing text of the turn that has
   * just settled onto the chat state, ready for the settling `chat.state`.
   *
   * `assistantSeqBeforeTurn` is where the assistant's messages stood when this
   * turn started. Anything at or below it belongs to an EARLIER turn, and
   * quoting it would make a turn that did nothing but run a tool announce work
   * somebody has already been told about.
   *
   * NO FALLBACK: a turn that ended without saying anything gets `null`, not the
   * nearest available sentence.
   */
  private stampTurnSummary(chatId: string, assistantSeqBeforeTurn: number): void {
    const state = this.chatState.get(chatId);
    if (!state) return;
    const reply = lastAssistantMessage(state);
    state.turnSummary =
      reply && reply.seq > assistantSeqBeforeTurn ? toTurnSummary(reply.content) : null;
  }

  /**
   * patch/todo.md § Features to add — "Current status". After a turn settles,
   * summarise the thread's current status into a one-line `{ kind, summary }`
   * and re-emit it on `chat.state`. Fired asynchronously so it never blocks the
   * assistant response (already emitted). Runs after EVERY turn (the status
   * reflects the latest exchange), but never for a special thread. On
   * null/failure the previous summary is left unchanged (NO FALLBACK to a stale
   * or fabricated status).
   */
  private maybeGenerateStatus(chatId: string, userPrompt: string): void {
    const gen = this.opts.generateStatus;
    if (!gen) return;
    if (isReservedSpecialThread(chatId)) return;
    const state = this.chatState.get(chatId);
    if (!state) return;

    // The reply half of the exchange — the most recent assistant text.
    const assistantReply =
      [...state.lastMessages].reverse().find((m) => m.role === 'assistant')?.content ?? '';

    // Strip the folded [Attachments] block so a pasted image never leaks a raw
    // path into the status prompt; an attachment-only turn passes a short note.
    const parsed = parseAttachmentBlock(userPrompt);
    const lastUserMessage = parsed
      ? parsed.text.trim() !== ''
        ? parsed.text.trim()
        : '(image attachment)'
      : userPrompt;

    const folder = state.folder;
    void (async () => {
      try {
        const status = await gen({
          chatId,
          lastUserMessage,
          assistantReply,
          folder,
        });
        if (status === null) {
          this.opts.logger.warn(
            { chatId },
            'status generation produced nothing; leaving previous status unchanged',
          );
          return;
        }
        const cur = this.chatState.get(chatId);
        if (!cur) return;
        // A newer turn may have started meanwhile — only apply if the chat is
        // still idle (this summary describes a settled turn, not a running one).
        if (cur.activity !== 'idle') return;
        // A status the AGENT declared outranks one a model inferred. The agent
        // said it is blocked on the user; a summariser reading the transcript a
        // moment later is not entitled to decide it is `complete` and drop the
        // chat back out of the list.
        if (cur.declaredStatus !== null) return;
        cur.statusSummary = status.summary;
        cur.statusKind = status.kind;
        this.emitState(chatId);
        this.opts.logger.info({ chatId, kind: status.kind }, 'chat status summary generated');
      } catch (err) {
        this.opts.logger.warn(
          { chatId, err },
          'status generation failed; leaving status unchanged',
        );
      }
    })();
  }

  /**
   * patch/todo.md § "todo list". Mirror a native TodoWrite tool call's list onto
   * chat state and re-emit chat.state so surfaces show what the agent is working
   * through. NO FALLBACK: if the args aren't the TodoWrite shape the existing
   * list is left untouched (a warning is logged), never overwritten with junk.
   */
  private mirrorTodoWrite(chatId: string, args: unknown): void {
    if (isReservedSpecialThread(chatId)) return;
    const state = this.chatState.get(chatId);
    if (!state) return;
    const todos = parseTodoWriteArgs(args);
    if (todos === null) {
      this.opts.logger.warn({ chatId }, 'TodoWrite args unrecognised; leaving todo list unchanged');
      return;
    }
    state.todos = todos;
    state.lastUpdated = this.opts.now();
    this.emitState(chatId);
  }

  /**
   * patch/todo.md § "todo list". Called when a turn settles idle: if the agent's
   * todo list still has a pending item, fire the next one back into the chat as a
   * fresh `[todo]`-prefixed turn so the agent works its list one focused turn at
   * a time. The `lastFiredTodo` guard (see `selectNextTodo`) stops it re-firing a
   * head item the agent left incomplete — that would nag it in a loop and
   * steamroll the user; that item is marked in progress instead, so the list
   * stops claiming a turn was never spent on it. Fire-and-forget (starts a new
   * turn), like the self-wake delivery.
   */
  private maybeAdvanceTodos(chatId: string): void {
    if (!this.opts.autoAdvanceTodos) return;
    if (isReservedSpecialThread(chatId)) return;
    const state = this.chatState.get(chatId);
    if (!state) return;
    const decision = selectNextTodo(state.todos, state.lastFiredTodo);
    if (decision.action === 'clear') {
      state.lastFiredTodo = null;
      return;
    }
    if (decision.action === 'stalled') {
      // A whole turn ran on this item and it came back incomplete. Not re-fired
      // (see above) and NEVER auto-completed — but it has demonstrably been
      // started, so leaving it reading `pending` on every surface is a lie.
      // Promote it to in progress; the agent's own next TodoWrite still wins.
      const started = markTodoStarted(state.todos, decision.text);
      if (started === null) return;
      state.todos = started;
      state.lastUpdated = this.opts.now();
      this.emitState(chatId);
      this.opts.logger.info(
        { chatId, todo: decision.text },
        'todo turn settled without completing its item; marked in progress, not re-fired',
      );
      return;
    }
    state.lastFiredTodo = decision.text;
    void (async () => {
      try {
        await this.sendInput({
          chatId,
          // The bare `[todo] x` line never told the agent that x is one of its
          // own TodoWrite items, so it had no cue to close the item out when the
          // turn finished. The reminder is stripped from the persisted turn, so
          // surfaces still show only `[todo] x`.
          message: buildTodoFireSystemReminder(decision.text) + `${TODO_PREFIX}${decision.text}`,
          localId: randomUUID(),
          // spec/09 § Whose turn it was — the host is advancing the list on
          // the agent's behalf. One request from the user became many turns;
          // notifying per item would notify per item rather than per request.
          origin: 'machine',
        });
      } catch (err) {
        this.opts.logger.warn({ chatId, err }, 'todo auto-advance failed to fire next item');
      }
    })();
  }

  /**
   * spec/04 § Goals. Called at every turn settle on a chat with an active
   * goal. Skips (and arms a poll to retry) while `patch_watch` tasks are still
   * running — "Evaluation waits... and runs after they finish". Otherwise asks
   * the evaluator. Fire-and-forget like `maybeCheckAgentResponseHooks`.
   */
  private maybeEvaluateGoal(chatId: string): void {
    const evaluator = this.opts.evaluateGoal;
    if (!evaluator) return;
    if (isReservedSpecialThread(chatId)) return;
    const state = this.chatState.get(chatId);
    if (!state || state.goal === null) return;

    // A running delegate is work this chat is waiting on, exactly like a watch:
    // judging the goal now would call an idle parent done while it is in flight.
    if (this.watch.count(chatId) > 0 || this.hasRunningDelegates(chatId)) {
      this.armGoalWatchPoll(chatId);
      return;
    }

    const condition = state.goal;
    const transcript = renderGoalTranscript(state.lastMessages);
    const turnsEvaluated = (state.goalProgress?.turnsEvaluated ?? 0) + 1;
    const folder = state.folder;
    void (async () => {
      try {
        const result = await evaluator({
          chatId,
          condition,
          transcript,
          turnsEvaluated,
          folder,
        });
        this.settleGoalEvaluation(chatId, condition, turnsEvaluated, result);
      } catch (err) {
        this.opts.logger.warn({ chatId, err }, 'goal evaluation failed');
      }
    })();
  }

  /** Re-check `maybeEvaluateGoal` once this chat's `patch_watch` tasks finish. */
  private armGoalWatchPoll(chatId: string): void {
    if (this.goalWatchPollTimers.has(chatId)) return;
    const state = this.chatState.get(chatId);
    if (state) state.goalEvalAwaitingWatches = true;
    const timer = setTimeout(() => {
      this.goalWatchPollTimers.delete(chatId);
      const cur = this.chatState.get(chatId);
      if (!cur || cur.goal === null) return;
      cur.goalEvalAwaitingWatches = false;
      this.maybeEvaluateGoal(chatId);
    }, this.opts.goalWatchPollMs ?? GOAL_WATCH_POLL_MS);
    timer.unref?.();
    this.goalWatchPollTimers.set(chatId, timer);
  }

  /**
   * Act on the evaluator's answer (spec/04 § Goals). `null` (a failure) is
   * NO FALLBACK — the goal is left exactly as it was, logged, and the next
   * settle tries again. A stale answer (the goal changed/cleared while the
   * model call was in flight) is dropped.
   */
  private settleGoalEvaluation(
    chatId: string,
    condition: string,
    turnsEvaluated: number,
    result: { verdict: 'met' | 'not_met' | 'refused' | 'impossible'; reason: string } | null,
  ): void {
    const state = this.chatState.get(chatId);
    if (!state || state.goal !== condition) return;
    if (result === null) {
      this.opts.logger.warn({ chatId }, 'goal evaluation produced nothing; trying again next turn');
      return;
    }
    const now = this.opts.now();
    const progress = state.goalProgress;
    state.goalProgress = {
      startedAt: progress?.startedAt ?? now,
      turnsEvaluated,
      tokensSpent: progress?.tokensSpent ?? 0,
      lastVerdict: result.verdict === 'not_met' || result.verdict === 'refused' ? 'not_met' : null,
      lastReason: result.reason,
    };

    if (result.verdict === 'refused') {
      state.goalRefusalStreak += 1;
      if (state.goalRefusalStreak >= this.goalRefusalLimit) {
        // Deadlock: the agent keeps declining. Stop pushing, keep the goal, and
        // put the chat in front of the user.
        state.goalRefusalStreak = 0;
        this.emitState(chatId);
        void this.declareStatus(
          chatId,
          'report',
          `Goal deadlocked: the agent declined ${this.goalRefusalLimit} times running. ${result.reason}`,
        ).catch((err) => {
          this.opts.logger.warn({ chatId, err }, 'goal deadlock guard: declareStatus failed');
        });
        this.opts.logger.warn(
          { chatId, limit: this.goalRefusalLimit },
          'goal deadlock guard tripped; chat surfaced instead of pushed',
        );
        return;
      }
    } else if (result.verdict === 'not_met') {
      state.goalRefusalStreak = 0;
    }

    if (result.verdict === 'not_met' || result.verdict === 'refused') {
      this.emitState(chatId);
      void this.sendInput({
        chatId,
        message: buildGoalNotMetMessage(condition, result.reason),
        localId: randomUUID(),
        // spec/09 § Whose turn it was — the host continuing the goal on its
        // own behalf, not the user. spec/04 § Hidden — `fromUser` omitted, so
        // a hidden/job chat stays hidden.
        origin: 'machine',
        goalTrigger: { reason: result.reason },
      }).catch((err) => {
        this.opts.logger.warn({ chatId, err }, 'goal not-met resubmit failed to send');
      });
      return;
    }

    // met / impossible — the goal is finished. Clear it, record it for the
    // chat header, and append a quiet transcript marker (no new agent turn).
    const startedAt = state.goalProgress.startedAt;
    const tokens = state.goalProgress.tokensSpent;
    this.flushQueuedNudges(chatId);
    state.goal = null;
    state.goalProgress = null;
    state.goalRefusalStreak = 0;
    state.lastGoal = {
      condition,
      startedAt,
      endedAt: now,
      turns: turnsEvaluated,
      tokens,
      outcome: result.verdict,
      reason: result.reason,
    };
    state.lastUpdated = now;
    this.opts.metaStore.update(chatId, (m) => ({
      ...m,
      goal: null,
      lastGoal: state.lastGoal,
      updatedAt: now,
    }));
    const seq = this.bumpSeq(chatId);
    this.emit({
      type: 'chat.message',
      chatId,
      role: 'system',
      content: buildGoalOutcomeMessage(result.verdict, result.reason),
      seq,
      createdAt: now,
    });
    this.emitState(chatId);
    if (result.verdict === 'impossible') {
      void this.declareStatus(chatId, 'report', `Goal impossible: ${result.reason}`).catch(
        (err) => {
          this.opts.logger.warn({ chatId, err }, 'goal impossible: declareStatus failed');
        },
      );
    }
    // 'met' needs nothing further — the ordinary turn-complete path already
    // rings the normal done notification for a turn that was not resubmitted.
  }

  /**
   * spec/20-hooks.md § On the agent's response. Called at every turn settle
   * (gated on `opts.checkAgentResponseHooks`). Resets the loop-guard counter
   * unless this very settle was itself a `block` resubmit the host fired a
   * moment ago, then asks the server which `agent_response` hooks match —
   * `handleHookAgentResponseOutcome` (below) acts on the answer once it
   * lands. Fire-and-forget: the server round-trip never delays the surface,
   * since the turn it is judging has already settled.
   */
  private maybeCheckAgentResponseHooks(chatId: string): void {
    if (!this.opts.checkAgentResponseHooks) return;
    const state = this.chatState.get(chatId);
    if (!state) return;
    const wasResubmit = state.turnWasHookResubmit;
    state.turnWasHookResubmit = false;
    if (!wasResubmit) state.consecutiveHookBlocks = 0;

    const reply = [...state.lastMessages].reverse().find((m) => m.role === 'assistant')?.content;
    const tally = this.hookToolTally.get(chatId);
    this.hookToolTally.delete(chatId);
    const checkId = randomUUID();
    state.pendingAgentResponseCheckId = checkId;
    this.emit({
      type: 'hook.agent_response_check_request',
      daemonId: this.opts.daemonId,
      chatId,
      checkId,
      folder: state.folder,
      specialThread: isReservedSpecialThread(chatId),
      reply: reply ?? '',
      toolCallsSummary: Daemon.describeHookToolTally(tally),
    });
  }

  /**
   * spec/20-hooks.md § On the agent's response. The server's answer to the
   * `hook.agent_response_check_request` above: every matching hook's own
   * result, unaggregated — the host (not the server) decides what each
   * means for the chat. A `block` wins over an `advise` in the same batch,
   * matching the user-message card's own stacking rule (spec/20-hooks.md §
   * On the user's message).
   */
  handleHookAgentResponseOutcome(event: HookAgentResponseOutcomeEvent): void {
    const state = this.chatState.get(event.chatId);
    if (!state) return;
    // A slow round-trip answering a check a NEWER settle has already
    // superseded — the newer check's own outcome is what gets acted on.
    if (state.pendingAgentResponseCheckId !== event.checkId) return;
    state.pendingAgentResponseCheckId = null;

    // A failed/timed-out hook is never resubmitted (unlike a `block`, there
    // is nothing to redo) but must not be silent either — deferred onto the
    // chat's next turn exactly like an `advise`, so it still draws a visible
    // disclosure (labelled "Hook failed" — `history.ts`'s
    // `labelSystemReminder`) without forcing anything.
    for (const r of event.results) {
      if (r.status === 'ok') continue;
      this.opts.logger.warn(
        { chatId: event.chatId, hookId: r.hookId, hookName: r.hookName, error: r.error },
        'agent_response hook failed or timed out — not resubmitted',
      );
      state.pendingHookAdvice.push({
        hookId: r.hookId,
        hookName: r.hookName,
        analysis: r.error ?? 'failed with no reason given',
        failed: true,
      });
    }

    const blocking = event.results.filter((r) => r.status === 'ok' && r.decision === 'block');
    if (blocking.length === 0) {
      // No block this cycle — an `advise` defers onto the chat's next turn
      // rather than forcing one now (spec/20-hooks.md § On the agent's
      // response: "without forcing a redo").
      const advising = event.results.filter((r) => r.status === 'ok' && r.decision === 'advise');
      for (const a of advising) {
        state.pendingHookAdvice.push({
          hookId: a.hookId,
          hookName: a.hookName,
          analysis: a.analysis ?? '',
          ...(a.suggestion !== undefined ? { suggestion: a.suggestion } : {}),
        });
      }
      return;
    }

    if (state.consecutiveHookBlocks >= HOOK_BLOCK_LOOP_LIMIT) {
      const summary = blocking
        .map((b) => `"${b.hookName}": ${b.analysis ?? ''}`)
        .join(' · ')
        .slice(0, 300);
      state.consecutiveHookBlocks = 0;
      // `declareStatus` (spec/04 § Current status) is the one place a
      // `report` is persisted, un-hides/un-archives the chat, and emits —
      // the same "needs attention" claim the agent's own `patch_report`
      // makes, just made by the host on a hook's behalf this time.
      void this.declareStatus(event.chatId, 'report', summary).catch((err) => {
        this.opts.logger.warn(
          { chatId: event.chatId, err },
          'hook loop guard: declareStatus failed',
        );
      });
      this.opts.logger.warn(
        { chatId: event.chatId, limit: HOOK_BLOCK_LOOP_LIMIT },
        'agent_response hook block loop guard tripped; chat surfaced instead of resubmitted',
      );
      return;
    }

    state.consecutiveHookBlocks += 1;
    state.turnWasHookResubmit = true;
    void this.sendInput({
      chatId: event.chatId,
      message: buildHookBlockMessage(blocking),
      localId: randomUUID(),
      // spec/09 § Whose turn it was — the host redoing this on the hook's
      // behalf, not the user. spec/04 § Hidden — `fromUser` omitted, so a
      // hidden chat stays hidden (spec/20-hooks.md: "a block resubmits the
      // same way" for a hidden/job chat).
      origin: 'machine',
      // spec/14 § Agent-response hooks — same quiet furniture treatment as a
      // job trigger turn, not a user bubble.
      hookTrigger: { hooks: blocking.map((b) => ({ hookId: b.hookId, hookName: b.hookName })) },
    }).catch((err) => {
      this.opts.logger.warn({ chatId: event.chatId, err }, 'hook block resubmit failed to send');
    });
  }

  /**
   * The API refused this host's Claude credential (spec/10-auth.md § Backend
   * credentials). Reported exactly like a credential that was missing at the
   * gate: `daemon.unauthenticated` so Settings and the disconnected banner stop
   * claiming this machine is signed in, plus a `chat.error` in words so the turn
   * doesn't just vanish. The raw API JSON stays in the log — it names no action
   * the person reading the chat can take. Callers settle the chat's activity.
   */
  private emitCredentialRejected(
    chatId: string,
    rawMessage: string,
    userMessageSeq?: number,
  ): void {
    this.emit({
      type: 'daemon.unauthenticated',
      daemonId: this.opts.daemonId,
      backendId: CLAUDE_BACKEND_ID,
      reason: `Claude rejected this host's credential: ${rawMessage}`,
    });
    this.emit({
      type: 'chat.error',
      chatId,
      error: {
        code: 'claude_oauth_missing',
        message: `${this.opts.daemonId}'s Claude sign-in is no longer valid, so this turn can't run. Sign in again from Settings → Hosts.`,
      },
      seq: this.bumpSeq(chatId),
      ...(userMessageSeq !== undefined ? { causeSeq: userMessageSeq } : {}),
    });
    this.opts.logger.error(
      { chatId, rawMessage },
      "Claude rejected this host's OAuth credential; treating as unauthenticated (NO API-key fallback)",
    );
  }

  /**
   * Chats whose current turn has produced something REAL — genuine model output
   * or a tool call — as opposed to nothing but injected notices.
   *
   * The safety net behind the error detection, for the failure mode that has now
   * bitten twice: Claude Code reporting a failure in a way patch does not
   * recognise, so the turn settles green having done nothing. Every specific
   * marker we key on can only catch a failure someone has already seen; this
   * catches the SHAPE of it — a turn that claims success while producing nothing.
   *
   * It WARNS rather than failing the turn. A false positive here would kill
   * legitimate work (a turn that only compacted, an older CLI reporting no usage),
   * and the point is to make the unknown case visible, not to guess at it.
   */
  private readonly turnDidSomething = new Set<string>();

  private handleEnvelope(chatId: string, env: SdkEnvelope, userMessageSeq?: number): void {
    // The harness's own id for this message rides on every history record the
    // envelope produces (`logEmitted`), and only for as long as it is handled.
    const sessionForRef = env.sessionId ?? this.chatState.get(chatId)?.claudeSessionId;
    if (env.nativeId !== undefined && sessionForRef) {
      this.envelopeRefs.set(chatId, {
        harness: this.harnessOf(chatId),
        sessionId: sessionForRef,
        id: env.nativeId,
      });
    }
    try {
      this.handleEnvelopeInner(chatId, env, userMessageSeq);
    } finally {
      this.envelopeRefs.delete(chatId);
    }
    this.noteContext(chatId, env);
  }

  /** The API model id behind each chat's latest context reading, to match the result's window. */
  private readonly contextModel = new Map<string, string>();

  /**
   * Fold one envelope into the chat's context reading (spec/14 § Composer —
   * context ring; contextUsage.ts says where each half comes from). Emitted as
   * it moves, so the ring fills during a long turn, and written to meta when
   * the turn's result lands rather than on every request.
   */
  private noteContext(chatId: string, env: SdkEnvelope): void {
    const s = this.chatState.get(chatId);
    if (!s) return;
    if (env.type === 'result') {
      if (!s.context) return;
      const windowTokens = resultContextWindow(env.raw, this.contextModel.get(chatId));
      if (windowTokens !== undefined) s.context = { ...s.context, windowTokens };
      const context = s.context;
      this.opts.metaStore.update(chatId, (m) => ({ ...m, context }));
      this.emitState(chatId);
      return;
    }
    const reading = assistantContextTokens(env.raw);
    if (!reading) return;
    // One message fans out into several envelopes carrying the same reading.
    if (s.context?.usedTokens === reading.tokens) return;
    // spec/04 § Goals — bar contents: each new reading is one real request's
    // worth of input tokens, so summing them while a goal is active approximates
    // its running spend. The evaluator's own one-shot calls run outside this
    // chat's session and never reach `noteContext`, so this counts only the
    // chat's own turns — the spend actually driving the goal forward.
    if (s.goal !== null && s.goalProgress) {
      s.goalProgress = {
        ...s.goalProgress,
        tokensSpent: s.goalProgress.tokensSpent + reading.tokens,
      };
    }
    // A different model has a different window: the old one no longer applies.
    const previousModel = this.contextModel.get(chatId);
    // Unknown on either side (a restart forgets the model) keeps the persisted window.
    const sameModel =
      reading.model === undefined || previousModel === undefined || reading.model === previousModel;
    if (reading.model !== undefined) this.contextModel.set(chatId, reading.model);
    const windowTokens = sameModel ? s.context?.windowTokens : undefined;
    s.context = {
      usedTokens: reading.tokens,
      ...(windowTokens !== undefined ? { windowTokens } : {}),
      at: this.opts.now(),
    };
    this.emitState(chatId);
  }

  /** Claude Code uuids of synthetic replies already shown, per chat. */
  private readonly syntheticShown = new Map<string, Set<string>>();

  /**
   * Show a reply Claude Code wrote itself as a muted `synthetic` system line
   * (spec/02 § Per-turn process). It reaches the daemon one of two ways — over
   * the SDK stream, or only as an entry written to the session mirror (the
   * resume placeholder never streams) — and when both carry it, the uuid keeps
   * it to one line.
   */
  private emitSyntheticNotice(chatId: string, text: string, uuid: string | undefined): void {
    if (uuid !== undefined) {
      let shown = this.syntheticShown.get(chatId);
      if (!shown) {
        shown = new Set();
        this.syntheticShown.set(chatId, shown);
      }
      if (shown.has(uuid)) return;
      shown.add(uuid);
    }
    this.opts.logger.warn(
      { chatId, text: text.slice(0, 200) },
      'synthetic assistant message shown as a Claude Code notice — the CLI generated it, the model did not',
    );
    // Not pushed onto chat state: that list is the conversation as the agent
    // had it, and this line is not part of it.
    this.emit({
      type: 'chat.message',
      chatId,
      role: 'system',
      content: text,
      seq: this.bumpSeq(chatId),
      createdAt: this.opts.now(),
      synthetic: true,
    });
  }

  /**
   * Entries Claude Code just wrote to this chat's session mirror. The one that
   * matters is the `No response requested.` it inserts on resuming a session
   * whose last turn got no reply: it goes into the model's context as the
   * agent's own words but never crosses the SDK stream, so without this the
   * user cannot see it at all. Failure notices are left out — they already
   * fail the turn loudly.
   */
  private noteMirroredEntries(chatId: string, entries: readonly SessionStoreEntry[]): void {
    for (const entry of entries) {
      if (entry.type !== 'assistant' || isModelOutput(entry)) continue;
      if (assistantErrorText(entry) !== undefined) continue;
      const text = assistantText(entry);
      if (text.length === 0) continue;
      this.emitSyntheticNotice(chatId, text, entry.uuid);
    }
  }

  private handleEnvelopeInner(chatId: string, env: SdkEnvelope, userMessageSeq?: number): void {
    if (env.sessionId) {
      const cur = this.chatState.get(chatId);
      if (cur && cur.claudeSessionId !== env.sessionId) {
        // spec/04 § History — the chat moved onto a new harness session. Its
        // first, a fork's own, a provider switch's, or one the harness
        // rotated to on its own (/clear, /compact).
        const fork = this.runningForks.get(chatId);
        const providerSwitch = this.runningProviderSwitch.get(chatId);
        if (providerSwitch && env.seedTrim) {
          providerSwitch.seededMessages -= env.seedTrim;
          providerSwitch.trimmedRecords = env.seedTrim;
        }
        const previous = cur.claudeSessionId;
        this.logRecord(
          chatId,
          {
            k: 'session',
            harness: this.harnessOf(chatId),
            model: cur.model ?? null,
            sessionId: env.sessionId,
            reason: fork
              ? 'fork'
              : providerSwitch
                ? 'switch'
                : previous === undefined
                  ? 'start'
                  : 'rotate',
            ...(fork
              ? {
                  seed: {
                    resumeAtUuid: fork.resumeAtUuid,
                    ...(previous !== undefined ? { parentSessionId: previous } : {}),
                  },
                }
              : providerSwitch
                ? {
                    seed: {
                      seededMessages: providerSwitch.seededMessages,
                      ...(previous !== undefined ? { parentSessionId: previous } : {}),
                      ...(providerSwitch.trimmedRecords
                        ? { trimmedRecords: providerSwitch.trimmedRecords }
                        : {}),
                    },
                  }
                : {}),
          },
          { sync: true },
        );
        cur.claudeSessionId = env.sessionId;
        this.opts.metaStore.update(chatId, (m) => ({
          ...m,
          claudeSessionId: env.sessionId,
          // spec/04 § Branching — `claudeSessionId` always mirrors the ACTIVE
          // branch's session, so a session id captured here (a first turn, or a
          // fork's brand-new session) belongs to whichever track is active.
          // Without this a forked track would never learn its own session and
          // switching back to it would be impossible.
          ...(m.branches && m.activeBranchId
            ? {
                branches: m.branches.map((b) =>
                  b.branchId === m.activeBranchId ? { ...b, sessionId: env.sessionId } : b,
                ),
              }
            : {}),
          updatedAt: this.opts.now(),
        }));
        if (providerSwitch) {
          // A quiet divider, not a notice — the fact rides on the field, not
          // on eye-catching text (spec/04 § History, unlike a permission-mode
          // change, which IS meant to draw the eye).
          this.emit({
            type: 'chat.message',
            chatId,
            role: 'system',
            content: '',
            seq: this.bumpSeq(chatId),
            createdAt: this.opts.now(),
            sessionChange: {
              harness: providerSwitch.toHarness,
              model: providerSwitch.toModel ?? 'default',
              seededMessages: providerSwitch.seededMessages,
              ...(providerSwitch.trimmedRecords
                ? { trimmedRecords: providerSwitch.trimmedRecords }
                : {}),
            },
          });
        }
      }
    }

    // A `permission` envelope is signalled by the `permission` field being set
    // (the dev mock + real SDK set `type: 'permission'`; some callers omit the
    // type and rely on the field alone). Route it explicitly, regardless of
    // `type`, so the permission path is never silently skipped.
    if (env.permission) {
      this.handlePermissionEnvelope(chatId, env);
      return;
    }

    // A `rateLimit` envelope carries no chat-visible content — report it
    // upstream and keep falling into the switch below, where the `system`
    // case's empty-content check no-ops it as normal.
    if (env.rateLimit) {
      this.opts.onRateLimit?.(chatId, env.rateLimit.scope, env.rateLimit.window);
      // Track the most recent `resetsAt` per chat AND per scope so auto-resume
      // can pick the SOONEST relevant window. A 5-hour session limit resets
      // hours from now; using the 7-day week's resetsAt would park the retry
      // for days, which is Task 1's bug.
      if (env.rateLimit.window.resetsAt !== undefined) {
        const existing = this.lastResetsAtByScope.get(chatId) ?? {};
        this.lastResetsAtByScope.set(chatId, {
          ...existing,
          [env.rateLimit.scope]: env.rateLimit.window.resetsAt,
        });
      }
    }

    // Claude Code landed this turn on `plan` itself (spec/02 § Permission
    // mode's plan-mode exception to `PermissionModeDowngradedError`) — record
    // it as an ordinary mode change instead of refusing the turn. The `system`
    // envelope for this same init message still falls through the switch
    // below and no-ops there (it carries no content).
    if (env.permissionModeAutoDowngrade) {
      this.recordAutomaticPermissionModeChange(chatId, env.permissionModeAutoDowngrade.effective);
    }

    // Anything REAL this turn produced — genuine model output or a tool call.
    // Injected notices are neither, which is what makes "nothing real happened"
    // a usable signal about a turn that claims to have succeeded.
    if (env.type === 'tool_use' || isModelOutput(env.raw)) this.turnDidSomething.add(chatId);

    // The model's thinking goes to the history log only; nothing renders it.
    if (env.thinking !== undefined) {
      const ref = this.envelopeRefs.get(chatId);
      this.logRecord(
        chatId,
        { k: 'thinking', text: env.thinking },
        ref !== undefined ? { nativeRef: ref } : {},
      );
      return;
    }

    switch (env.type) {
      case 'assistant_delta': {
        // Live-only incremental text for an in-flight assistant turn
        // (includePartialMessages). The first delta reserves the seq the
        // finalising `chat.message` will carry; deltas fan out as transient
        // `chat.message_delta` events (no own seq, not persisted, not replayed
        // — the final `chat.message` is the durable record). Empty chunks are
        // skipped so we never reserve a seq for a no-op.
        if (!env.content || env.content.length === 0) return;
        let pending = this.pendingDelta.get(chatId);
        if (!pending) {
          pending = { seq: this.bumpSeq(chatId), text: '' };
          this.pendingDelta.set(chatId, pending);
          // The reply's record lands only when it finalises; hold its seq in
          // the history log now, so a restart mid-stream never reuses it.
          this.logRecord(chatId, { k: 'seq.reserve' }, { seq: pending.seq });
        }
        pending.text += env.content;
        const ev: ChatMessageDeltaEvent = {
          type: 'chat.message_delta',
          chatId,
          messageSeq: pending.seq,
          delta: env.content,
        };
        this.emit(ev);
        return;
      }
      case 'assistant':
      case 'user':
      case 'system': {
        if (!env.content || env.content.length === 0) return;
        // A SYNTHETIC assistant message is not the agent speaking. Claude Code
        // injects them — `model: "<synthetic>"`, zero input tokens — and the
        // one that prompted this guard read "No response requested.", the CLI
        // answering its own `Continue from where you left off.` after a turn
        // died on a usage limit. Patch rendered it as the reply, so a turn that
        // had produced nothing at all looked like a turn that had answered.
        // It is re-emitted as a `system` message flagged `synthetic`, which
        // surfaces draw as a muted Claude Code line: the gap stays visible
        // without the agent's name on it.
        //
        // A compaction notice arrives the same way and IS worth showing, so it
        // is exempted explicitly rather than by reading the prose.
        //
        // `env.raw === undefined` is NOT synthetic — it is a backend that does
        // not carry the SDK message through at all (the mock one, every test
        // that uses it). Dropping on an absent marker would silently delete
        // every reply those produce, which is a far worse failure than the one
        // being fixed: the guard fires only on a message we can positively
        // identify as CLI-generated.
        if (
          env.type === 'assistant' &&
          !env.compaction &&
          env.raw !== undefined &&
          !isModelOutput(env.raw)
        ) {
          // A reserved delta seq would otherwise be stranded, and the next real
          // message would finalise into it.
          this.pendingDelta.delete(chatId);
          this.emitSyntheticNotice(chatId, env.content, rawUuid(env.raw));
          return;
        }
        // If this assistant turn streamed deltas, finalise at the SAME
        // reserved seq rather than allocating a new one — otherwise the
        // durable `chat.message` would land after the deltas at a higher seq
        // and the surface would render the reply twice.
        const pending = env.type === 'assistant' ? this.pendingDelta.get(chatId) : undefined;
        const seq = pending ? pending.seq : this.bumpSeq(chatId);
        if (pending) this.pendingDelta.delete(chatId);
        const role = env.type === 'system' ? 'system' : env.type;
        const ts = this.opts.now();
        const ev: ChatMessageEvent = {
          type: 'chat.message',
          chatId,
          role,
          content: env.content,
          seq,
          createdAt: ts,
          // spec/02 § Context compression — a compaction boundary is a system
          // message that also carries its figures.
          ...(env.compaction ? { compaction: env.compaction } : {}),
        };
        this.chatState.pushMessage(chatId, { role, content: env.content, seq, ts });
        this.emit(ev);
        return;
      }
      case 'tool_use': {
        if (!env.tool) return;
        const seq = this.bumpSeq(chatId);
        const ev: ChatToolCallEvent = {
          type: 'chat.tool_call',
          chatId,
          tool: env.tool.name,
          args: env.tool.args,
          callId: env.tool.callId,
          seq,
          startedAt: Date.now(),
        };
        this.emit(ev);
        // patch/todo.md § "todo list": mirror the agent's native TodoWrite list
        // onto chat state so surfaces can show it and the turn-settle
        // auto-advance can pick up the next pending item. Gated on the manager
        // being enabled, so default host behaviour is untouched.
        if (this.opts.autoAdvanceTodos && env.tool.name === 'TodoWrite') {
          this.mirrorTodoWrite(chatId, env.tool.args);
        }
        // spec/02 § Permission mode — the agent's own `EnterPlanMode` tool is a
        // real, immediate SDK mode transition, not something that waits on
        // approval the way `ExitPlanMode` below does. Left unrecorded, the
        // chat's displayed mode (and every surface's composer selector reading
        // it) kept saying whatever the chat was configured to — "Bypass
        // permissions" — while the SDK was, in fact, gating every subsequent
        // tool call through `canUseTool`. Stash the mode to restore ONLY if
        // this is a fresh entry (a chat already on `plan` — configured that
        // way, or already mid-plan-mode — has nothing to remember a second time).
        if (env.tool.name === 'EnterPlanMode') {
          // `chatPermissionMode` (not `state.permissionMode` directly), same
          // resolver `runQuery` uses to stamp a turn's mode — it's the one
          // that's always defined, falling back to the host default when the
          // chat has none of its own.
          const configured = this.chatPermissionMode(chatId);
          if (configured !== 'plan' && !this.planModeRestore.has(chatId)) {
            this.planModeRestore.set(chatId, configured);
          }
          this.recordAutomaticPermissionModeChange(chatId, 'plan');
        }
        // spec/14 § File browser — live updates: record which path this call
        // is about now, while its args are still in hand — `tool_result`
        // carries only a callId + return value, never the args back. Only
        // the matching completed result (not this call itself) means the
        // write actually landed, so nothing is emitted yet.
        if (
          env.tool.name === 'Edit' ||
          env.tool.name === 'Write' ||
          env.tool.name === 'NotebookEdit'
        ) {
          const filePath = editToolFilePath(
            env.tool.name,
            (env.tool.args ?? {}) as Record<string, unknown>,
          );
          const rel = filePath ? this.relativeToChatFolder(chatId, filePath) : null;
          if (rel !== null) {
            this.pendingEditToolCalls.set(`${chatId}:${env.tool.callId}`, rel);
          }
        }
        return;
      }
      case 'tool_result': {
        if (!env.toolResult) return;
        // spec/14 § File browser — live updates: the matching `tool_use`
        // (above) is what named the path; consumed here whether the call
        // succeeded or not, so a failed edit never leaves a stale entry
        // behind. Broadcast only fires for a SUCCESSFUL result — a failed
        // Edit/Write/NotebookEdit never touched disk.
        const pendingKey = `${chatId}:${env.toolResult.callId}`;
        const changedPath = this.pendingEditToolCalls.get(pendingKey);
        this.pendingEditToolCalls.delete(pendingKey);
        if (changedPath !== undefined && !env.toolResult.isError) {
          this.emit({ type: 'patch.file_changed', chatId, path: changedPath });
        }
        const seq = this.bumpSeq(chatId);
        const ev: ChatToolResultEvent = {
          type: 'chat.tool_result',
          chatId,
          tool: env.toolResult.name,
          callId: env.toolResult.callId,
          // Deliberately passed through byte-for-byte, not flattened to a
          // string. `env.toolResult.result` is `env.toolResult.result` /
          // `b['content']` from the SDK's own `tool_result` message content
          // (`sdkBackend.ts`'s `translateSdkMessage`) — when a tool (e.g.
          // `Read` on an image file) returns Anthropic content blocks, that
          // includes an inline `{ type: 'image', source: {...} } }` block.
          // Preserving the raw structure here is what lets the web surface
          // (`ChatRoute.tsx`'s `imageDataUri`) detect it and render an actual
          // `<img>` instead of a wall of base64 text — see the comment on
          // `ChatToolResultEvent.result` in `packages/wire/src/events.ts`.
          result: env.toolResult.result,
          ...(env.toolResult.isError !== undefined ? { isError: env.toolResult.isError } : {}),
          seq,
        };
        this.emit(ev);
        // Perf: a completed Edit/Write/NotebookEdit is the moment the
        // agent's own tool execution (not host code — the SDK writes the
        // file itself) landed a change on disk. The file-listing caches
        // (git-dirty.ts, files-recursive.ts) must not keep serving a
        // pre-edit answer for the rest of their TTL after that.
        if (FILE_EDIT_TOOLS.has(env.toolResult.name) && env.toolResult.isError !== true) {
          const state = this.chatState.get(chatId);
          if (state) {
            const root = realpathSync(pathResolve(state.folder));
            this.invalidateFileListCaches(root);
            // spec/14 § Document editor — history: the agent's own direct
            // edit (only reachable in Change mode — Propose/Comment refuse
            // Edit/Write outright, sdkBackend.ts's `denyForDocMode`) is a
            // version too. Read fresh off disk rather than from the tool's
            // own args — `Edit`'s `new_string` is one hunk, not the whole
            // file `recordDocVersion` keeps.
            // Only for a document the doc editor already tracks (sidecar
            // exists): an agent edit of a SKILL.md/README must not litter a
            // `.patch-doc.json` beside a file nobody opened as a document.
            const editedAbs = changedPath !== undefined ? join(root, changedPath) : undefined;
            if (
              editedAbs !== undefined &&
              editedAbs.toLowerCase().endsWith('.md') &&
              existsSync(sidecarPathFor(editedAbs))
            ) {
              const abs = editedAbs;
              try {
                this.recordDocVersion(abs, readFileSync(abs, 'utf8'), 'agent');
              } catch {
                // Deleted/moved between the write and this read — nothing to version.
              }
            }
          }
        }
        // spec/02 § Permission mode — the mirror of `EnterPlanMode` above.
        // Hooked on the RESULT, not the tool_use: `ExitPlanMode` presents the
        // plan and waits on the user's approval before the SDK actually
        // leaves plan mode, so restoring on an ERRORED/denied result would
        // announce a mode change that didn't happen. A chat with nothing
        // stashed (never entered via the tool, or already restored) is a
        // no-op — `recordAutomaticPermissionModeChange` itself no-ops on an
        // unchanged mode too, so this can never regress a deliberate later
        // choice into a stale stash.
        if (env.toolResult.name === 'ExitPlanMode' && env.toolResult.isError !== true) {
          const restore = this.planModeRestore.get(chatId);
          if (restore !== undefined) {
            this.planModeRestore.delete(chatId);
            this.recordAutomaticPermissionModeChange(chatId, restore);
          }
        }
        return;
      }
      case 'error': {
        const message = env.errorMessage ?? 'unknown sdk error';
        // A refused credential reaching us as an error envelope rather than a
        // throw is the same failure and gets the same report (the turn settles
        // idle on its own once the stream ends, so there is no activity to fix
        // here).
        if (isClaudeCredentialRejectedMessage(message)) {
          this.emitCredentialRejected(chatId, message, userMessageSeq);
          return;
        }
        const seq = this.bumpSeq(chatId);
        const ev: ChatErrorEvent = {
          type: 'chat.error',
          chatId,
          error: { code: 'sdk_error', message },
          seq,
          // Lets the surface attach this failure to the turn's own message
          // (spec/12) instead of a standalone error row.
          ...(userMessageSeq !== undefined ? { causeSeq: userMessageSeq } : {}),
        };
        this.emit(ev);
        return;
      }
      case 'permission':
        // Permission envelopes are routed by the `env.permission` field check
        // above (before this switch). A `type:'permission'` with no permission
        // payload is a no-op.
        return;
      case 'result': {
        // The result carries session_id + cumulative info; nothing to fan out.
        // But it is also the moment to check the invariant: a turn that reports
        // success having produced NO model output and NO tool call did nothing,
        // whatever the reason. Every marker-based check can only catch a failure
        // someone has already seen; this catches the shape of the ones nobody has.
        //
        // A WARN, not a failure. A false positive would kill legitimate work — a
        // turn that only compacted, an older CLI that reports no usage — and the
        // job here is to make an unknown failure visible, not to guess at it.
        const usage = resultUsage(env.raw);
        if (usage !== undefined) this.turnUsage.set(chatId, usage);
        const didSomething = this.turnDidSomething.delete(chatId);
        if (!didSomething) {
          this.opts.logger.warn(
            { chatId, sessionId: env.sessionId ?? null },
            'turn settled having produced no model output and no tool call — it may have failed in a way patch does not recognise',
          );
        }
        return;
      }
      case 'provider_context': {
        // spec/02 § Provider-level context — Claude Code's OWN attachment-
        // shaped context (environment, model identity, token counts, ...).
        // Dedup/collapse-to-one-row-per-providerType is a SURFACE concern
        // (chatStore.ts upserts on `providerType`) — the host just emits
        // every occurrence, live, exactly like every other wire event.
        if (!env.providerContext) return;
        const seq = this.bumpSeq(chatId);
        const ev: ChatProviderContextEvent = {
          type: 'chat.provider_context',
          chatId,
          providerType: env.providerContext.providerType,
          label: env.providerContext.label,
          text: env.providerContext.text,
          seq,
        };
        this.emit(ev);
        return;
      }
    }
  }

  /**
   * Translate a `permission` SDK envelope into a `chat.permission_request`
   * wire event and flip the chat to `awaiting-permission`. Split out of
   * `handleEnvelope` so the routing is explicit (a `permission` envelope is
   * a first-class case, not a post-switch afterthought).
   */
  private handlePermissionEnvelope(
    chatId: string,
    env: SdkEnvelope,
    expiry?: { at: number; windowMs: number },
    /**
     * Which branch this request belongs to (spec/04 § Branching —
     * "permission … address a branch, not only the chat"). Defaults to the
     * chat's active branch, which is every call site before this existed —
     * so the active branch's own activity bookkeeping (`chatState.activity`)
     * is untouched for them.
     */
    branchId?: string,
  ): void {
    if (env.permission) {
      const resolvedBranchId = branchId ?? this.branchIdFor(chatId);
      const isActiveBranch =
        resolvedBranchId === (this.opts.metaStore.read(chatId)?.activeBranchId ?? resolvedBranchId);
      const seq = this.bumpSeq(chatId);
      // Group 20: when the tool is a file edit, compute proposedDiff +
      // remember the absolute file path so the file browser can mark it
      // dirty. NO FALLBACK: if args are malformed the request still
      // emits without proposedDiff and the surface falls through to the
      // raw permission card.
      const args =
        env.permission.args && typeof env.permission.args === 'object'
          ? (env.permission.args as Record<string, unknown>)
          : {};
      const editInfo: { filePath: string; proposedDiff: string } | null = computeEditInfo(
        env.permission.tool,
        args,
      );
      let proposedDiff: string | undefined;
      if (editInfo) {
        const state = this.chatState.get(chatId);
        /* v8 ignore next -- defensive only: `bumpSeq(chatId)` above (which reads the same chatState map) already throws if this chat's state is missing, so this line can never observe `state` as undefined through the public API. */
        const root = state?.folder ?? '';
        const absPath = resolveAbsForChat(root, (editInfo as { filePath: string }).filePath);
        this.pendingPermissions.set(`${chatId}:${env.permission.requestId}`, {
          chatId,
          requestId: env.permission.requestId,
          tool: env.permission.tool,
          absPath,
          originalArgs: args,
        });
        proposedDiff = (editInfo as { proposedDiff: string }).proposedDiff;
      }
      const ev: ChatPermissionRequestEvent = {
        type: 'chat.permission_request',
        chatId,
        requestId: env.permission.requestId,
        request: {
          tool: env.permission.tool,
          args: env.permission.args,
          ...(env.permission.description !== undefined
            ? { description: env.permission.description }
            : {}),
          ...(proposedDiff !== undefined ? { proposedDiff } : {}),
        },
        seq,
        // The deadline the host will act on, when one was armed (spec/02
        // § Questions are not approvals). Stored on the event, so the replay
        // below hands a reconnecting surface the SAME absolute instant rather
        // than a fresh window starting from when it happened to reconnect.
        ...(expiry !== undefined ? { expiry } : {}),
        // Absent when this is the active branch's own request — the common
        // case, and every call site before branches could run in parallel —
        // so an older surface reads it exactly as it always has.
        ...(isActiveBranch ? {} : { branchId: resolvedBranchId }),
      };
      // G2-d1: remember the full request so a surface reconnecting AFTER this
      // turn (the permission lands in the transcript as a bare `tool_use`, which
      // replays as a `chat.tool_call` with no approve/deny) still gets the
      // permission card — re-emitted in `replayChat`. Keyed like
      // `pendingPermissions` so resolution clears both.
      this.pendingPermissionEvents.set(`${chatId}:${env.permission.requestId}`, ev);
      this.emit(ev);
      // spec/04 § Branching — a side branch's own question does not flip the
      // ACTIVE branch's activity (it may still be running fine); it only
      // raises the chat's AGGREGATE status (`aggregateActivity`, read by
      // `buildStateEvent`). Only the active branch's request still drives
      // `chatState.activity` directly, exactly as before branches existed.
      if (isActiveBranch) this.chatState.setActivity(chatId, 'awaiting-permission');
      this.unarchiveForPermission(chatId);
      this.emitState(chatId);
      // spec/02 § Native subagent dispatch — AskUserQuestion arrives through
      // this SAME path (it is just another `tool`), so a subagent's question
      // is routed to its parent for free, with no separate case for it: the
      // mirror below carries whatever `ev.request.tool` is.
      const subagent = this.chatState.get(chatId)?.subagent;
      if (subagent) this.mirrorPermissionRequestToParent(subagent, ev);
    }
  }

  /**
   * Surface a subagent's permission request (or AskUserQuestion — same path)
   * on the PARENT's own transcript, labelled with the subagent's name, so the
   * user answers it from the one chat they can see (spec/02 § Native
   * subagent dispatch — "the request appears in the PARENT chat's permission
   * card"). The REAL gate stays keyed to the subagent's own chatId — nothing
   * here changes it — `submitPermissionResponse` resolves by `requestId`
   * alone, globally, so answering this mirrored copy resolves the real one.
   *
   * KNOWN LIMITATION: this leans on the existing `awaiting-permission`
   * activity to get the card's prominence and badge for free, so it is
   * stamped on the PARENT too. If the parent's own turn is still running when
   * this fires and settles before the question is answered, that settle
   * overwrites it — a narrow interleaving (most subagents are only started
   * once the parent itself has gone idle).
   */
  private mirrorPermissionRequestToParent(
    subagent: ChatSubagentInfo,
    ev: ChatPermissionRequestEvent,
  ): void {
    const parentChatId = subagent.parentChatId;
    if (!this.chatState.has(parentChatId)) {
      const meta = this.opts.metaStore.read(parentChatId);
      if (!meta) return;
      this.chatState.hydrate([meta]);
    }
    const mirrored: ChatPermissionRequestEvent = {
      ...ev,
      chatId: parentChatId,
      seq: this.bumpSeq(parentChatId),
      request: {
        ...ev.request,
        description: `(from subagent "${subagent.label}") ${ev.request.description ?? ev.request.tool}`,
      },
    };
    this.emit(mirrored);
    this.chatState.setActivity(parentChatId, 'awaiting-permission');
    this.unarchiveForPermission(parentChatId);
    this.emitState(parentChatId);
    this.emitDelegateUpdate(parentChatId, ev.chatId, subagent.label, 'awaiting-permission');
  }

  /** The other half of the mirror above — echo the resolution + restore the
   *  parent's activity. Called from both `submitPermissionResponse` branches. */
  private mirrorPermissionResponseToParent(
    realChatId: string,
    requestId: string,
    approve: boolean,
    decision: 'approve' | 'deny' | 'approve_with_edits',
  ): void {
    const subagent = this.chatState.get(realChatId)?.subagent;
    if (!subagent) return;
    const parentChatId = subagent.parentChatId;
    if (!this.chatState.has(parentChatId)) return;
    const ev: ChatPermissionResponseEvent = {
      type: 'chat.permission_response',
      chatId: parentChatId,
      requestId,
      approve,
      decision,
    };
    this.emit(ev);
    const parentRunning = this.aborters.has(parentChatId);
    this.chatState.setActivity(parentChatId, parentRunning ? 'running' : 'idle');
    this.emitState(parentChatId);
    this.emitDelegateUpdate(parentChatId, realChatId, subagent.label, 'running');
  }

  /**
   * A chat that has just blocked on the user comes out of Archived (spec/04
   * § Lifecycle, spec/08 ## Action).
   *
   * The case this exists for is a `hidden` job fire: the action spawns it
   * straight into Archived because its runs are ordinarily noise, and then one
   * of them asks a question. Archived means off the active list, so the
   * permission card would be posted somewhere nobody has a reason to look and
   * the turn would wait until it expired.
   *
   * Lives here rather than at the two call sites because `requestPermission`
   * (the blocking `canUseTool` gate, which is also how `AskUserQuestion`
   * arrives) routes through this same method — so one rule covers a permission
   * decision and a question both. Host-side rather than server-side because
   * the un-archive has to persist to `meta.json` and reach surfaces as an
   * ordinary `chat.state`, which is exactly what `setArchived` already does.
   *
   * One-way: nothing re-archives the chat when the request is answered. It
   * surfaced because it needed the user, and from then on it stays where any
   * other chat would until someone archives it by hand.
   */
  /** A chat that notified the user comes into the list, one-way (spec/04 § Current status). */
  unarchiveForNotify(chatId: string): void {
    this.unarchiveForPermission(chatId);
  }

  private unarchiveForPermission(chatId: string): void {
    const state = this.chatState.get(chatId);
    if (!state) return;
    // `setArchived(false)` and `setHidden` are declared async but do no
    // awaiting on these paths, so the state and meta writes have both landed by
    // the time this returns — the `chat.state` the caller emits next already
    // carries them.
    if (state.status === 'archived') {
      void this.setArchived(chatId, false).catch((err: unknown) => {
        this.opts.logger.error(
          { chatId, err },
          'failed to unarchive a chat that is awaiting permission',
        );
      });
    }
    // A hidden run that blocks on the user comes into the list (spec/04 §
    // Hidden) — the case `startHidden` jobs need, since nobody looks in Hidden
    // for a question.
    if (state.hidden) {
      void this.setHidden(chatId, false).catch((err: unknown) => {
        this.opts.logger.error(
          { chatId, err },
          'failed to unhide a chat that is awaiting permission',
        );
      });
    }
  }

  /**
   * Bridges the SDK backend's `onPermissionRequest` (sdkBackend.ts
   * `SdkRunOptions`) — which the real SDK's `canUseTool` and the mock's
   * `[[bash-permission]]` trigger both await directly, blocking the tool call
   * — to the existing `chat.permission_request`/`chat.permission_response`
   * wire round-trip. Reuses `handlePermissionEnvelope` to emit the request and
   * populate `pendingPermissionEvents` exactly as the envelope-stream path
   * does, so replay-on-reconnect (G2-d1) covers this path too. The returned
   * promise resolves in `submitPermissionResponse` once the surface answers.
   */
  private requestPermission(
    chatId: string,
    tool: string,
    args: Record<string, unknown>,
    description: string | undefined,
    /** Which branch this turn is running on (spec/04 § Branching). Defaults to the active branch. */
    branchId?: string,
  ): Promise<{ approve: boolean; updatedInput?: Record<string, unknown>; denyMessage?: string }> {
    const requestId = randomUUID();
    // Register the gate BEFORE announcing the request, not after.
    //
    // `submitPermissionResponse` unblocks the SDK by looking this entry up, so
    // emitting first leaves a window in which the request is public but
    // unanswerable: a responder that replies synchronously finds no gate,
    // resolves nothing, and `canUseTool` waits forever. A remote surface never
    // loses that race — the round trip through the server guarantees it — which
    // is why this held up in production while hanging instantly for anything
    // in-process. The promise executor runs synchronously, so building it first
    // closes the window entirely.
    const gated = new Promise<{
      approve: boolean;
      updatedInput?: Record<string, unknown>;
      denyMessage?: string;
    }>((resolve) => {
      this.permissionGates.set(`${chatId}:${requestId}`, { resolve });
    });
    // Durable half of the fix (pendingDecisions.ts): the gate above cannot
    // survive a restart, but the FACT that this chat asked something can. If
    // the host dies while this is outstanding, resumeInterruptedTurns reads
    // this back and tells the resumed agent what it had asked instead of
    // nothing.
    persistPendingDecision(dirname(this.opts.metaStore.pathFor(chatId)), {
      requestId,
      tool,
      args,
      ...(description !== undefined ? { description } : {}),
      createdAt: this.opts.now(),
    });
    // Worked out BEFORE the request is announced, because the surfaces are
    // told the deadline in the same frame that asks the question — arming
    // first and emitting after would be two sources for one instant.
    const plan = this.answerExpiryPlan(tool);
    this.handlePermissionEnvelope(
      chatId,
      {
        permission: {
          requestId,
          tool,
          args,
          ...(description !== undefined ? { description } : {}),
        },
      } as SdkEnvelope,
      plan ? { at: this.opts.now() + plan.timeoutMs, windowMs: plan.timeoutMs } : undefined,
      branchId,
    );
    if (plan) this.armAnswerExpiry(chatId, requestId, tool, plan);
    return gated;
  }

  /**
   * Expire an unanswered permission request instead of holding the turn open
   * forever (Tom: "ask user question should have a timeout instead of just
   * waiting forever").
   *
   * Every request is armed, questions and tool approvals alike, because BOTH
   * park the chat in `awaiting-permission` and neither state ever reaches
   * `idle` on its own. A question is the one permission the user cannot simply
   * leave — the turn cannot proceed without it — and an approval raised in a
   * chat nobody is watching is no different in effect: see
   * `APPROVAL_ANSWER_TIMEOUT_MS` for the job fire that proved it. They differ
   * only in how many minutes of benefit of the doubt they get.
   *
   * It expires as a DENY on the wire, because deny is what the existing
   * `chat.permission_response` frame can say and inventing an enum value would
   * be dropped by every surface that has not caught up (spec/03 § Answering
   * with content). The AGENT is told the truth via `denyMessage`, so it re-asks
   * or reports the skip rather than acting on a decision the user never made.
   */
  private armAnswerExpiry(
    chatId: string,
    requestId: string,
    tool: string,
    plan: { timeoutMs: number; denyMessage: string },
  ): void {
    const gate = this.permissionGates.get(`${chatId}:${requestId}`);
    if (!gate) return;
    const { timeoutMs, denyMessage } = plan;
    gate.expiry = setTimeout(() => {
      // Still pending? `submitPermissionResponse` clears the timer when the
      // surface answers, so reaching here means nobody did.
      if (!this.permissionGates.has(`${chatId}:${requestId}`)) return;
      this.opts.logger.warn({ chatId, requestId, tool }, 'permission request expired unanswered');
      this.submitPermissionResponse({ requestId, decision: 'deny', denyMessage, by: 'expiry' });
    }, timeoutMs);
    // A pending request must never hold the process open on its own.
    gate.expiry.unref?.();
  }

  /**
   * How long this request gets, and what the agent is told when it runs out —
   * or `null` for a request that does not expire at all.
   *
   * The ONE place the two windows are chosen, so the deadline put on the wire
   * and the timer actually armed can never disagree. `null` happens only for a
   * question on a host with expiry turned off; an approval's window is fixed
   * and not part of the setting, because turning off the thing that unwedges
   * unattended jobs is not something the question control should quietly do.
   */
  private answerExpiryPlan(tool: string): { timeoutMs: number; denyMessage: string } | null {
    if (tool !== ASK_USER_QUESTION) {
      return { timeoutMs: APPROVAL_ANSWER_TIMEOUT_MS, denyMessage: APPROVAL_EXPIRED_MESSAGE };
    }
    if (!this.questionExpiry.enabled) return null;
    const seconds = this.questionExpiry.seconds;
    return { timeoutMs: seconds * 1000, denyMessage: questionExpiredMessage(seconds) };
  }

  /**
   * Give a still-outstanding QUESTION on `chatId` a fresh full window,
   * because a `chat.focus_change` just touched it (`noteChatFocus`, spec/02
   * § Questions are not approvals). The window re-armed is the one the
   * question was originally ASKED with, not whatever `questionExpiry`
   * currently reads — a setting change mid-flight must not retroactively
   * shrink or stretch a question already in play. A no-op for an ordinary
   * tool approval (only a question resets this way), for a request that
   * carries no deadline at all (expiry off when it was asked), or when
   * nothing is pending on this chat.
   */
  private resetQuestionExpiry(chatId: string): void {
    let found: [string, ChatPermissionRequestEvent] | undefined;
    for (const entry of this.pendingPermissionEvents) {
      if (entry[1].chatId === chatId && entry[1].request.tool === ASK_USER_QUESTION) {
        found = entry;
        break;
      }
    }
    if (!found) return;
    const [key, ev] = found;
    if (ev.expiry === undefined) return;
    const gate = this.permissionGates.get(key);
    if (!gate) return;
    if (gate.expiry) clearTimeout(gate.expiry);
    const windowMs = ev.expiry.windowMs;
    const expiry = { at: this.opts.now() + windowMs, windowMs };
    const denyMessage = questionExpiredMessage(windowMs / 1000);
    // Replayed verbatim to a surface that reconnects after the reset
    // (`replayChat`), so it must carry the SAME deadline the live update
    // below announces, not the stale one from when the question was asked.
    this.pendingPermissionEvents.set(key, { ...ev, expiry });
    gate.expiry = setTimeout(() => {
      // Still pending? `submitPermissionResponse` clears the timer when the
      // surface answers, so reaching here means nobody did.
      if (!this.permissionGates.has(key)) return;
      this.opts.logger.warn(
        { chatId, requestId: ev.requestId, tool: ASK_USER_QUESTION },
        'permission request expired unanswered',
      );
      this.submitPermissionResponse({
        requestId: ev.requestId,
        decision: 'deny',
        denyMessage,
        by: 'expiry',
      });
    }, windowMs);
    // A pending request must never hold the process open on its own.
    gate.expiry.unref?.();
    this.emit({
      type: 'chat.permission_expiry_update',
      chatId,
      requestId: ev.requestId,
      expiry,
      seq: this.bumpSeq(chatId),
    });
  }

  /**
   * A surface named which chat it has open (`chat.focus_change`, forwarded by
   * the server with `forSurfaceId` stamped on — spec/03). Resets a pending
   * question's countdown on every edge that touches THIS chat, gained or
   * lost, so the clock is never quietly running through the moment Tom
   * starts looking at the question or the moment right after he stops
   * (`resetQuestionExpiry`, spec/02 § Questions are not approvals). A repeat
   * of the same value — a heartbeat, a replayed frame — is not an edge and
   * does nothing.
   */
  noteChatFocus(surfaceId: string, chatId: string | null): void {
    const previous = this.surfaceFocusChat.get(surfaceId) ?? null;
    this.surfaceFocusChat.set(surfaceId, chatId);
    if (previous === chatId) return;
    if (previous !== null) this.resetQuestionExpiry(previous);
    if (chatId !== null) this.resetQuestionExpiry(chatId);
  }

  /**
   * Resolve permission requests still outstanding on `chatId` as an explicit
   * deny, because something OTHER than the user's answer has decided them.
   *
   * Both callers exist because a pending request is not merely unanswered — it
   * BLOCKS the turn inside `canUseTool` (`requestPermission`), and only
   * `submitPermissionResponse` (or the expiry timer) ever resolves that gate.
   * Anything that means to end or supersede the turn therefore has to resolve
   * the gate itself, or it changes nothing: the turn stays parked, the chat
   * stays `awaiting-permission`, and every turn queued behind it waits out the
   * expiry window before it can run.
   *
   * Routed through `submitPermissionResponse` rather than resolving the gate
   * directly, so the cancellation is a first-class outcome and not a silent
   * one: it emits `chat.permission_response`, which is what flips the card on
   * every surface to `Cancelled`, clears the replay record so a reconnect does
   * not re-raise it, and settles the chat's activity. `denyMessage` tells the
   * AGENT which of the two happened, since `deny` on the wire cannot.
   */
  private cancelPendingPermissions(
    chatId: string,
    opts: {
      /**
       * Questions only, or every outstanding request on the chat.
       *
       * A new user message cancels only the agent's QUESTION: a question cannot
       * be left (the turn cannot proceed without it) and the message the user
       * just typed is a better answer than any option. An ordinary Bash/Edit
       * approval is the opposite — a turn paused on purpose, which typing must
       * never decide. A stop is not selective: it ends the turn, so whatever
       * the turn was paused on goes with it.
       */
      questionsOnly: boolean;
      denyMessage: string;
      reason: string;
      /**
       * Only cancel requests belonging to THIS branch (spec/04 § Branching) —
       * a message sent to one branch must not cancel a question another
       * branch is sitting on. Defaults to the chat's active branch, matching
       * every call site before parallel branches existed.
       */
      branchId?: string;
    },
  ): number {
    const targetBranchId = opts.branchId ?? this.branchIdFor(chatId);
    const activeBranchId = this.opts.metaStore.read(chatId)?.activeBranchId ?? targetBranchId;
    // Snapshot first: `submitPermissionResponse` deletes from the map being
    // iterated. Non-edit requests (questions included) live ONLY in
    // `pendingPermissionEvents`; edit approvals are in there too, so this one
    // map covers both kinds.
    const requestIds = [...this.pendingPermissionEvents.values()]
      .filter(
        (ev) =>
          ev.chatId === chatId &&
          (ev.branchId ?? activeBranchId) === targetBranchId &&
          (!opts.questionsOnly || ev.request.tool === ASK_USER_QUESTION),
      )
      .map((ev) => ev.requestId);
    for (const requestId of requestIds) {
      this.opts.logger.info({ chatId, requestId }, opts.reason);
      this.submitPermissionResponse({
        requestId,
        decision: 'deny',
        denyMessage: opts.denyMessage,
        by: 'cancelled',
      });
    }
    return requestIds.length;
  }

  /**
   * Group 20 fix #3: surfaces (web/desktop/mobile) emit
   * `chat.permission_response` to either approve, deny, or approve with
   * edits. Beyond echoing the resolution and settling chat activity, this
   * resolves the matching `permissionGates` entry (if one exists — only
   * blocking modes create one, see `requestPermission`), which is what
   * actually unblocks the SDK's `canUseTool` callback (sdkBackend.ts) and
   * lets the tool call proceed or fail with a deny message.
   */
  submitPermissionResponse(ev: {
    requestId: string;
    /**
     * The chat the surface says the request belongs to. Only used to address
     * the echo for a request this host no longer holds.
     */
    chatId?: string;
    decision: 'approve' | 'deny' | 'approve_with_edits';
    editedNewString?: string;
    /**
     * Daemon-internal only — never off the wire. Set by `armQuestionExpiry` so
     * the agent is told the question expired rather than that it was refused.
     */
    denyMessage?: string;
    /** Daemon-internal only: who decided, for the history log. Absent → the user. */
    by?: PermissionDecisionBy;
  }): void {
    // Find the pending request — keyed by requestId across all chats.
    let key: string | undefined;
    for (const k of this.pendingPermissions.keys()) {
      if (k.endsWith(`:${ev.requestId}`)) {
        key = k;
        break;
      }
    }
    if (!key) {
      // G2-d1: a non-edit permission is NOT tracked in `pendingPermissions`
      // (that map is edit-specific for the dirty-file marker), but it IS in
      // `pendingPermissionEvents`. Resolve from there so the chat settles and a
      // later reconnect doesn't re-surface the card.
      let evtKey: string | undefined;
      for (const k of this.pendingPermissionEvents.keys()) {
        if (k.endsWith(`:${ev.requestId}`)) {
          evtKey = k;
          break;
        }
      }
      if (evtKey) {
        const pendingEv = this.pendingPermissionEvents.get(evtKey)!;
        const pendingChatId = pendingEv.chatId;
        this.pendingPermissionEvents.delete(evtKey);
        clearPendingDecision(dirname(this.opts.metaStore.pathFor(pendingChatId)), ev.requestId);
        // A NON-edit tool's `approve_with_edits` payload has to reach
        // `updatedInput` from HERE — this branch is the only one it takes, and
        // resolving the gate with a bare `{approve}` is what silently dropped
        // `AskUserQuestion`'s answers (spec/02 § Questions are not approvals).
        // A payload the tool can't take denies the call and reports why; it is
        // never downgraded to a plain approval.
        let updatedInput: Record<string, unknown> | undefined;
        let editError: PermissionEditInvalidError | undefined;
        if (ev.decision === 'approve_with_edits' && typeof ev.editedNewString === 'string') {
          const originalArgs =
            pendingEv.request.args && typeof pendingEv.request.args === 'object'
              ? (pendingEv.request.args as Record<string, unknown>)
              : {};
          try {
            updatedInput = updatedInputForPermissionEdit(
              pendingEv.request.tool,
              originalArgs,
              ev.editedNewString,
            );
          } catch (err) {
            /* v8 ignore next -- defensive only: `updatedInputForPermissionEdit` throws nothing but PermissionEditInvalidError, so the rethrow arm is unreachable through the public API. */
            if (!(err instanceof PermissionEditInvalidError)) throw err;
            editError = err;
          }
        }
        const approve =
          editError === undefined &&
          (ev.decision === 'approve' || ev.decision === 'approve_with_edits');
        // A bare Cancel click on a question card carries no `denyMessage` of
        // its own (it isn't the superseded, expiry or stop path, each of which
        // sets one) — default it here rather than let it fall through to
        // sdkBackend.ts's generic 'Permission denied by user', which reads to
        // the agent as a refusal of its whole plan rather than a decline to
        // answer this one question. Gated on `decision === 'deny'` specifically
        // (not just `!approve`), so an unusable `approve_with_edits` answer
        // (editError above) keeps its own `invalid_frame` account instead of
        // being relabelled a plain cancel.
        const denyMessage =
          ev.denyMessage ??
          (ev.decision === 'deny' && pendingEv.request.tool === ASK_USER_QUESTION
            ? QUESTION_CANCELLED_MESSAGE
            : undefined);
        this.logPermissionDecision(
          pendingChatId,
          ev.requestId,
          editError ? 'deny' : ev.decision,
          ev.by,
          updatedInput,
        );
        // Unblock the SDK's canUseTool callback, if this request came through
        // the blocking gate (requestPermission) rather than the dev mock's
        // non-blocking `[[permission]]` trigger, which never creates one.
        const gate = this.permissionGates.get(`${pendingChatId}:${ev.requestId}`);
        if (gate) {
          this.permissionGates.delete(`${pendingChatId}:${ev.requestId}`);
          if (gate.expiry) clearTimeout(gate.expiry);
          gate.resolve({
            approve,
            ...(updatedInput !== undefined ? { updatedInput } : {}),
            ...(denyMessage !== undefined ? { denyMessage } : {}),
          });
        }
        if (editError) {
          this.opts.logger.error(
            { chatId: pendingChatId, requestId: ev.requestId, tool: pendingEv.request.tool },
            `permission_response rejected: ${editError.message}`,
          );
          this.emit({
            type: 'chat.error',
            chatId: pendingChatId,
            error: { code: 'invalid_frame', message: editError.message },
            seq: this.bumpSeq(pendingChatId),
          });
        }
        // spec/07 ## Permission prompts during voice: echo the resolution to
        // surfaces. The spoken yes/no path resolves the request host-side
        // (the surface never sent the response), so without this echo the
        // surface's inline permission card never learns the outcome and stays
        // pending. Carries the chatId so the surface can flip the matching card.
        //
        // `updatedInput.answers` only exists for an `AskUserQuestion` resolved
        // with `approve_with_edits` (`updatedInputForPermissionEdit`) — carry
        // it on the echo too, or a surface that didn't originate this
        // resolution (a second tab, a reconnect, the voice path itself) has no
        // way to show what was actually picked (spec/14 § Main chat panel —
        // Question prompts).
        this.emit({
          type: 'chat.permission_response',
          chatId: pendingChatId,
          requestId: ev.requestId,
          approve,
          decision: editError ? 'deny' : ev.decision,
          ...(updatedInput?.['answers'] !== undefined
            ? { answers: updatedInput['answers'] as Record<string, string> }
            : {}),
        });
        const running = this.aborters.has(pendingChatId);
        this.chatState.setActivity(pendingChatId, running ? 'running' : 'idle');
        this.emitState(pendingChatId);
        this.mirrorPermissionResponseToParent(
          pendingChatId,
          ev.requestId,
          approve,
          editError ? 'deny' : ev.decision,
        );
        return;
      }
      this.opts.logger.warn(
        { requestId: ev.requestId },
        'submitPermissionResponse: no pending request',
      );
      // The surface resolved its card the moment it was tapped and now waits
      // for an echo, redelivering until one arrives. Say something rather than
      // leave it greyed and retrying forever: repeat what was decided if this
      // was a redelivery, otherwise report that nothing took the answer.
      const settled = this.settledPermissionEchoes.get(ev.requestId);
      if (settled) {
        this.emit(settled);
      } else if (ev.chatId) {
        this.emit({
          type: 'chat.permission_response',
          chatId: ev.chatId,
          requestId: ev.requestId,
          approve: false,
          decision: 'deny',
        });
      }
      return;
    }
    const pending = this.pendingPermissions.get(key)!;
    pending.response = {
      decision: ev.decision,
      ...(ev.editedNewString !== undefined ? { editedNewString: ev.editedNewString } : {}),
    };

    let updatedInput: Record<string, unknown> | undefined;
    if (ev.decision === 'approve_with_edits' && typeof ev.editedNewString === 'string') {
      updatedInput = updatedInputForPermissionEdit(
        pending.tool,
        pending.originalArgs,
        ev.editedNewString,
      );
    }
    this.logPermissionDecision(pending.chatId, ev.requestId, ev.decision, ev.by, updatedInput);
    // Unblock the SDK's canUseTool callback, if this request came through the
    // blocking gate (requestPermission) rather than the dev mock's
    // non-blocking `[[permission]]` trigger, which never creates one.
    const gate = this.permissionGates.get(`${pending.chatId}:${ev.requestId}`);
    if (gate) {
      this.permissionGates.delete(`${pending.chatId}:${ev.requestId}`);
      if (gate.expiry) clearTimeout(gate.expiry);
      gate.resolve({
        approve: ev.decision === 'approve' || ev.decision === 'approve_with_edits',
        ...(updatedInput !== undefined ? { updatedInput } : {}),
        ...(ev.denyMessage !== undefined ? { denyMessage: ev.denyMessage } : {}),
      });
    } else if (updatedInput !== undefined) {
      // No gate to unblock — this permission was recorded via the
      // non-blocking envelope path (e.g. the mock's `[[permission]]` demo
      // trigger, which emits the request with no real tool execution behind
      // it), so nothing else will ever produce a transcript entry for the
      // user's edit. Emit one as a paper-trail record of what was approved.
      const seq = this.bumpSeq(pending.chatId);
      const callEv: ChatToolCallEvent = {
        type: 'chat.tool_call',
        chatId: pending.chatId,
        tool: pending.tool,
        args: updatedInput,
        callId: `edited-${pending.requestId}`,
        seq,
      };
      this.emit(callEv);
    }
    // Clear after handling — finished.
    this.pendingPermissions.delete(key);
    // G2-d1: drop the replay-affordance record too, so a later reconnect does
    // not re-surface an already-resolved permission card.
    this.pendingPermissionEvents.delete(`${pending.chatId}:${ev.requestId}`);
    clearPendingDecision(dirname(this.opts.metaStore.pathFor(pending.chatId)), ev.requestId);
    // Settle activity. With the real SDK the query iterator is still in flight
    // (the `canUseTool` callback was blocking it) so the turn continues —
    // `running`. With the dev mock the turn already completed (the run loop
    // returned and parked the chat in `awaiting-permission`), so there is no
    // in-flight run to resume: settle to `idle`. Distinguish by whether a run
    // is still tracked for the chat.
    const stillRunning = this.aborters.has(pending.chatId);
    // spec/07: echo the resolution to surfaces (see the pendingPermissionEvents
    // branch above) so a spoken yes/no — or any non-initiating surface — sees
    // the inline card settle to approved/denied, not just the activity change.
    this.emit({
      type: 'chat.permission_response',
      chatId: pending.chatId,
      requestId: ev.requestId,
      approve: ev.decision === 'approve' || ev.decision === 'approve_with_edits',
      decision: ev.decision,
    });
    this.chatState.setActivity(pending.chatId, stillRunning ? 'running' : 'idle');
    this.emitState(pending.chatId);
    this.mirrorPermissionResponseToParent(
      pending.chatId,
      ev.requestId,
      ev.decision === 'approve' || ev.decision === 'approve_with_edits',
      ev.decision,
    );
  }

  /** Record how a permission request was answered, before the answer takes effect. */
  private logPermissionDecision(
    chatId: string,
    requestId: string,
    decision: 'approve' | 'deny' | 'approve_with_edits',
    by: PermissionDecisionBy | undefined,
    editedInput: Record<string, unknown> | undefined,
  ): void {
    this.logRecord(
      chatId,
      {
        k: 'permission.decision',
        requestId,
        decision,
        by: by ?? 'user',
        ...(editedInput !== undefined ? { editedInput } : {}),
      },
      { sync: true },
    );
  }

  /**
   * The requestId of the most-recent permission still outstanding for `chatId`,
   * or undefined if none. Used by the voice session's spoken yes/no path
   * (spec/07 ## Permission prompts during voice): when an utterance arrives
   * while the focused chat is `awaiting-permission`, the host resolves THIS
   * request from the parsed word rather than treating it as a new user-turn.
   */
  getPendingPermissionForChat(chatId: string): string | undefined {
    // pendingPermissionEvents holds every outstanding request (edit + non-edit).
    for (const v of this.pendingPermissionEvents.values()) {
      if (v.chatId === chatId) return v.requestId;
    }
    return undefined;
  }

  /**
   * DEV/TEST seam (G5-9): synthesise a `chat.permission_request` for `chatId`
   * and flip it to `awaiting-permission`, exactly as a real SDK `permission`
   * envelope would (`handlePermissionEnvelope`). The dev SDK runs with tools
   * auto-approved, so a real prompt never surfaces in the mock stack — this
   * lets the mid-voice permission banner (tap Approve/Deny AND spoken yes/no)
   * be exercised. Resolution flows through the normal `submitPermissionResponse`
   * path, so the request genuinely clears (not a no-op). Returns the requestId.
   */
  injectPermissionRequest(chatId: string, tool: string, description: string): string | undefined {
    if (!this.chatState.has(chatId)) {
      this.opts.logger.warn({ chatId }, 'injectPermissionRequest: unknown chatId');
      return undefined;
    }
    const requestId = `diag-perm-${this.opts.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const seq = this.bumpSeq(chatId);
    const ev: ChatPermissionRequestEvent = {
      type: 'chat.permission_request',
      chatId,
      requestId,
      request: { tool, args: {}, description },
      seq,
    };
    this.pendingPermissionEvents.set(`${chatId}:${requestId}`, ev);
    this.emit(ev);
    this.chatState.setActivity(chatId, 'awaiting-permission');
    this.emitState(chatId);
    return requestId;
  }

  /**
   * True when a permission request is outstanding for `chatId` — used by the
   * run loop to keep a mock turn parked in `awaiting-permission` rather than
   * settling it straight to `idle`.
   */
  private hasPendingPermission(chatId: string): boolean {
    for (const v of this.pendingPermissions.values()) {
      if (v.chatId === chatId) return true;
    }
    // G2-d1: non-edit permissions live only in pendingPermissionEvents.
    for (const v of this.pendingPermissionEvents.values()) {
      if (v.chatId === chatId) return true;
    }
    return false;
  }

  /**
   * Group 20 fix #5: file paths the agent has proposed to edit but the
   * user hasn't approved yet. `handleFilesRequest` reads this to mark
   * tree rows ● dirty.
   */
  dirtyFilePaths(chatId: string): Set<string> {
    const out = new Set<string>();
    for (const v of this.pendingPermissions.values()) {
      if (v.chatId === chatId && v.absPath.length > 0) out.add(v.absPath);
    }
    return out;
  }

  /**
   * Perf (git-dirty.ts / files-recursive.ts): both the file browser's dirty-●
   * lookup and the ⌘P recursive index cache their answer for a root briefly
   * so rapid repeated listings don't each re-shell-out to git. Call this
   * right after any write this host knows about landed on disk, so the
   * cache never serves a stale answer past the write that invalidated it —
   * see the three call sites: `writeFile` (editor save), `fileOp`
   * (create/rename/delete), and the `tool_result` handling for an
   * `Edit`/`Write`/`NotebookEdit` tool call.
   */
  private invalidateFileListCaches(root: string): void {
    invalidateGitDirtyCache(root);
    invalidateFilesRecursiveCache(root);
  }

  /**
   * Apply a surface `file.write` (editor save) to disk.
   *
   * spec/14-design-web.md § Diff editor / File browser: both web editor
   * surfaces save via the same `file.write` wire event, and the save is
   * accepted whatever the chat's activity is — the editor is writable while
   * the agent is mid-turn. What keeps the two writers apart is that the write
   * is atomic (temp file + fsync + rename): a concurrent reader sees either
   * the whole old file or the whole new one, never a torn one.
   *
   * Path traversal outside the chat folder is still refused, loudly (a
   * `chat.error`, NO FALLBACK), as is an unknown chat.
   */
  /**
   * spec/14 & spec/15 § Composer — persist a composer attachment under the
   * chat's dir so a later `chat.input` carrying its ref can be fed into the
   * turn by path. The server round-trips the uploaded bytes here
   * (`patch.attachment.store_request`) BEFORE the surface sends the turn.
   *
   * Files land in `<chatFolder>/.patch/attachments/<id>-<name>` (a hidden dir
   * inside the chat's own folder — Claude's cwd — so the path is readable both
   * relatively and absolutely). Returns the absolute path written. Throws on an
   * unknown chat (NO FALLBACK — the server maps it to a typed error).
   */
  storeAttachment(opts: {
    chatId: string;
    id: string;
    name: string;
    mimeType: string;
    kind: AttachmentKind;
    bytes: Buffer;
  }): StoredAttachment {
    const state = this.chatState.get(opts.chatId);
    if (!state) {
      throw new AttachmentChatNotFoundError(`chat not found: ${opts.chatId}`);
    }
    const dir = attachmentsDirFor(state.folder);
    const target = join(dir, attachmentFileName(opts.id, opts.name));
    mkdirSync(dir, { recursive: true });
    writeFileSync(target, opts.bytes);
    // Persist the ref in the chat's manifest so a later history/replay can
    // reconstruct the structured `AttachmentRef` for this id (spec/14 & spec/15
    // § Composer — attachments survive replay). Written BEFORE the turn is sent,
    // so it always predates the turn's JSONL.
    writeManifestEntry(state.folder, {
      id: opts.id,
      name: opts.name,
      mimeType: opts.mimeType,
      kind: opts.kind,
    });
    this.opts.logger.info(
      { chatId: opts.chatId, id: opts.id, bytes: opts.bytes.byteLength, path: target },
      'attachment stored',
    );
    return { path: target };
  }

  /**
   * Reconstruct structured attachment refs on replay (spec/14 & spec/15 §
   * Composer — "attachments must persist on replay"). Claude Code's JSONL only
   * carries the user turn's TEXT, which includes the host's appended
   * `[Attachments]` block. For each replayed user `chat.message` that carries
   * such a block we lift the refs back out (id + kind from the block, full ref
   * incl. mimeType from the chat manifest), attach them structurally, and STRIP
   * the block from the content so it never renders as literal transcript text.
   */
  private hydrateReplayAttachments(chatId: string, events: WireEvent[]): WireEvent[] {
    const state = this.chatState.get(chatId);
    /* v8 ignore next -- defensive only: both callers (readHistory, replayChat) already resolved and confirmed this exact chatId's state synchronously (throwing ChatNotFoundError otherwise) immediately before calling this method, with no `await` in between — state cannot go missing here via the public API. */
    if (!state) return events;
    let manifest: AttachmentManifest | null = null;
    return events.map((ev) => {
      if (ev.type !== 'chat.message' || ev.role !== 'user') return ev;
      const block = parseAttachmentBlock(ev.content);
      if (!block) return ev;
      if (manifest === null) manifest = readManifest(state.folder);
      const attachments: AttachmentRef[] = block.parsed.map((p) => {
        const fromManifest = manifest?.[p.id];
        if (fromManifest) return fromManifest;
        // NO manifest entry (legacy/pre-manifest chat): reconstruct from the
        // parsed line so the attachment still renders. The served copy carries
        // the authoritative mime type; the ref's mimeType is display-only.
        return {
          id: p.id,
          name: p.name,
          kind: p.kind,
          mimeType: p.kind === 'image' ? 'image/*' : 'application/octet-stream',
        };
      });
      return { ...ev, content: block.text, attachments } satisfies ChatMessageEvent;
    });
  }

  /**
   * Resolve an attachment ref to the absolute on-disk path `storeAttachment`
   * wrote. Deterministic (id + name → path under the chat folder) so it survives
   * a host restart between upload and send. NO FALLBACK: a missing file throws
   * — the turn fails loudly rather than referencing a phantom path.
   */
  private resolveAttachmentPath(chatId: string, att: AttachmentRef): string {
    const state = this.chatState.get(chatId);
    /* v8 ignore next -- defensive only: the sole caller (sendInput) already confirmed this exact chatId's state synchronously at the top of the same call, with no `await` in between — state cannot go missing here via the public API. */
    if (!state) throw new Error(`resolveAttachmentPath: unknown chat ${chatId}`);
    const path = join(state.folder, '.patch', 'attachments', attachmentFileName(att.id, att.name));
    if (!existsSync(path)) {
      throw new Error(`attachment not found on disk (id=${att.id}, name=${att.name}): ${path}`);
    }
    return path;
  }

  /**
   * spec/14 § File browser — live updates: resolve an ABSOLUTE path (what a
   * tool call's `file_path`/`notebook_path` arg always is) to a path relative
   * to `chatId`'s own folder — the same contract `writeFile`'s `relPath` and
   * the file-browser API already use, so a `patch.file_changed` broadcast is
   * directly comparable to `openFile.path` on the receiving surface. Returns
   * null for an unknown chat, an unresolvable path, or one that (like
   * `writeFile`'s own escape guard) doesn't actually live inside the folder —
   * there is nothing a surface's OWN file browser could match it against.
   */
  private relativeToChatFolder(chatId: string, absPath: string): string | null {
    const state = this.chatState.get(chatId);
    if (!state) return null;
    try {
      const root = realpathSync(pathResolve(state.folder));
      const rel = relative(root, pathResolve(absPath));
      if (rel === '' || rel.startsWith('..') || pathResolve(root, rel) !== pathResolve(absPath)) {
        return null;
      }
      return rel;
    } catch {
      // Folder gone, or the path doesn't resolve — nothing to compare against.
      return null;
    }
  }

  /**
   * A host-level save (spec/03 § Host files) landed `absPath` on disk. It went
   * through no chat, so any chat whose folder holds that file hears about it
   * the way it would about its own editor's save: caches dropped, and a
   * `patch.file_changed` so a surface with the file open re-reads it.
   */
  noteHostFileWritten(absPath: string): void {
    for (const state of this.chatState.list()) {
      const rel = this.relativeToChatFolder(state.chatId, absPath);
      if (rel === null) continue;
      this.invalidateFileListCaches(realpathSync(pathResolve(state.folder)));
      this.emit({ type: 'patch.file_changed', chatId: state.chatId, path: rel });
    }
  }

  writeFile(chatId: string, relPath: string, content: string): void {
    const state = this.chatState.get(chatId);
    if (!state) {
      // No bumpSeq path for an unknown chat — emit an out-of-band chat.error.
      this.emit({
        type: 'chat.error',
        chatId,
        error: { code: 'chat_not_found', message: `chat not found: ${chatId}` },
        seq: OUT_OF_BAND_SEQ,
      });
      this.opts.logger.warn({ chatId }, 'file.write: unknown chat (NO FALLBACK)');
      return;
    }

    const root = realpathSync(pathResolve(state.folder));
    // `path` is RELATIVE to the chat folder (the same contract the file-browser
    // API uses). An absolute path is a bug in the caller — reject it loudly
    // rather than silently rebasing it onto the chat folder (which would write
    // to the wrong nested location). NO FALLBACK.
    if (relPath.startsWith('/')) {
      const seq = this.bumpSeq(chatId);
      this.emit({
        type: 'chat.error',
        chatId,
        error: { code: 'file_write_rejected', message: 'path must be relative to the chat folder' },
        seq,
      });
      this.opts.logger.warn({ chatId, path: relPath }, 'file.write: absolute path rejected');
      return;
    }
    const rel = relPath;
    const target = pathResolve(join(root, rel));
    if (target !== root && !target.startsWith(root + sep)) {
      const seq = this.bumpSeq(chatId);
      this.emit({
        type: 'chat.error',
        chatId,
        error: { code: 'file_write_rejected', message: 'path escapes chat folder' },
        seq,
      });
      this.opts.logger.warn({ chatId, path: rel }, 'file.write: path escape rejected');
      return;
    }

    // Document editor (spec/14 § Document editor, step 1 of 3): capture what
    // was on disk BEFORE this write, for the eventual agent-facing diff — but
    // only the FIRST time since the last consume, so a run of saves between
    // one agent turn and the next diffs start-to-latest rather than losing
    // everything but the final keystroke. Read before the write below changes
    // it; a brand-new file has no prior content (`''`). NO FALLBACK: only
    // tracked for `.md` files, document-editor's own domain.
    if (rel.toLowerCase().endsWith('.md')) {
      let chatDiffs = this.pendingDocumentDiffs.get(chatId);
      if (!chatDiffs) {
        chatDiffs = new Map();
        this.pendingDocumentDiffs.set(chatId, chatDiffs);
      }
      if (!chatDiffs.has(rel)) {
        let before = '';
        try {
          before = readFileSync(target, 'utf8');
        } catch {
          // New file — no prior content to diff against.
        }
        chatDiffs.set(rel, { before });
      }
    }

    // spec/14 § Document editor — history, step 2 of 3: the version this
    // write is about to retire, read before the write below replaces it. A
    // brand-new file has none (`''`), same convention as the diff baseline
    // above. NO FALLBACK: only `.md` files carry version history.
    let beforeForVersion = '';
    if (rel.toLowerCase().endsWith('.md')) {
      try {
        beforeForVersion = readFileSync(target, 'utf8');
      } catch {
        // New file.
      }
    }

    try {
      mkdirSync(dirname(target), { recursive: true });
      const tmp = `${target}.patch-tmp-${process.pid}`;
      writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o644 });
      const fd = openSync(tmp, 'r');
      fsyncSync(fd);
      closeSync(fd);
      renameSync(tmp, target);
      this.invalidateFileListCaches(root);
      this.opts.logger.info({ chatId, path: rel, bytes: content.length }, 'file.write: committed');
      // spec/14 § File browser — live updates: every surface watching this
      // chat (not just the one that made the edit) needs to know its cached
      // copy of `rel` just went stale.
      this.emit({ type: 'patch.file_changed', chatId, path: rel });
      // spec/14 § Document editor — history: every REAL content change is a
      // version, whoever made it. A save back to exactly what it was is not
      // one — same "nothing actually changed" rule `consumeDocumentDiffs`
      // applies to the agent-facing diff.
      if (rel.toLowerCase().endsWith('.md') && content !== beforeForVersion) {
        this.recordDocVersion(target, content, 'user');
      }
    } catch (err) {
      const seq = this.bumpSeq(chatId);
      /* v8 ignore next -- defensive only: every throw in the try block above comes from node:fs, which always throws a proper Error (NodeJS.ErrnoException); the non-Error branch is unreachable in practice. */
      const message = err instanceof Error ? err.message : String(err);
      this.emit({
        type: 'chat.error',
        chatId,
        error: { code: 'file_write_rejected', message },
        seq,
      });
      this.opts.logger.error({ chatId, path: rel, err: message }, 'file.write: disk write failed');
    }
  }

  /**
   * The file browser's create / rename / delete (spec/14 § File browser,
   * spec/03 § Files). One entry point for all four operations because they
   * share the whole of their safety story: the same root, the same escape
   * guard, and the same rule that nothing is ever overwritten or recursed
   * into.
   *
   * Returns the outcome rather than emitting it — the caller answers the
   * server's `patch.file_op.request` with it, so the user is told what
   * happened. NO FALLBACK: every refusal is a typed code, never a no-op.
   */
  fileOp(args: {
    chatId: string;
    op: 'create' | 'create_dir' | 'delete' | 'rename';
    path: string;
    to?: string | undefined;
  }): FileOpOutcome {
    const state = this.chatState.get(args.chatId);
    if (!state) {
      this.opts.logger.warn({ chatId: args.chatId }, 'file_op: unknown chat (NO FALLBACK)');
      return {
        ok: false,
        code: 'chat_not_found',
        message: `chat not found: ${args.chatId}`,
      };
    }
    const root = realpathSync(pathResolve(state.folder));
    try {
      const target = resolveInChatFolder(root, args.path);
      const landed = runFileOp({ op: args.op, root, target, rel: args.path, to: args.to });
      this.invalidateFileListCaches(root);
      this.opts.logger.info(
        { chatId: args.chatId, op: args.op, path: args.path, to: args.to },
        'file_op: committed',
      );
      // spec/14 § File browser — live updates: a create/rename/delete changes
      // the TREE, not just one file's content — every watching surface's own
      // recursive listing is stale now too, whether or not it has `landed`
      // open (the web client invalidates the chat's whole tree query on any
      // `patch.file_changed`, and additionally the file-content query when the
      // path matches — see `ws.ts`'s dispatch + `EditorRail.tsx`'s
      // `BrowsePanel` invalidation effect).
      this.emit({ type: 'patch.file_changed', chatId: args.chatId, path: landed });
      return { ok: true, path: landed };
    } catch (err) {
      const rejection = asFileOpRejection(err);
      this.opts.logger.warn(
        {
          chatId: args.chatId,
          op: args.op,
          path: args.path,
          to: args.to,
          code: rejection.code,
          err: rejection.message,
        },
        'file_op: refused',
      );
      return { ok: false, code: rejection.code, message: rejection.message };
    }
  }

  /**
   * spec/14 § Document editor, step 2 of 3: resolve `chatId` + a chat-relative
   * `.md` path to its absolute on-disk location, for every doc view/action
   * method below. Same escape guard `fileOp` uses (`resolveInChatFolder`),
   * plus requiring the target to already exist as a real file — every doc
   * operation needs real content to read, unlike `fileOp`'s own `create`.
   */
  private resolveDocPath(chatId: string, relPath: string): string {
    const state = this.chatState.get(chatId);
    if (!state) throw new DocActionRejection('chat_not_found', `chat not found: ${chatId}`);
    const root = realpathSync(pathResolve(state.folder));
    const target = resolveInChatFolder(root, relPath);
    if (!existsSync(target) || !statSync(target).isFile()) {
      throw new DocActionRejection('not_found', `no such file: ${relPath}`);
    }
    return target;
  }

  /** Shared by every surface-facing doc method below — resolve, then translate any throw to its outcome shape. */
  private docCall<T>(
    chatId: string,
    relPath: string,
    fn: (target: string) => T,
  ): { ok: true; value: T } | { ok: false; code: DocErrorCode; message: string } {
    try {
      const target = this.resolveDocPath(chatId, relPath);
      return { ok: true, value: fn(target) };
    } catch (err) {
      return { ok: false, ...asDocActionRejection(err) };
    }
  }

  /** `.md` only, and only when the content actually changed — see the two call sites (`writeFile`, the agent-edit tool_result hook). */
  private recordDocVersion(absPath: string, content: string, savedBy: 'user' | 'agent'): void {
    let sidecar: DocSidecarData;
    try {
      sidecar = readSidecar(absPath);
    } catch (err) {
      this.opts.logger.warn(
        { absPath, err: (err as Error).message },
        'docSidecar: version not recorded — sidecar unreadable',
      );
      return;
    }
    recordVersion(sidecar, content, savedBy, this.opts.now());
    writeSidecar(absPath, sidecar);
  }

  /** The doc view — mode, suggestions, threads, versions (spec/14 § Document editor). */
  getDocView(
    chatId: string,
    relPath: string,
  ): { ok: true; value: DocSidecarData } | { ok: false; code: DocErrorCode; message: string } {
    return this.docCall(chatId, relPath, (target) => readSidecar(target));
  }

  setDocMode(chatId: string, relPath: string, mode: DocMode) {
    return this.docCall(chatId, relPath, (target) => {
      const sidecar = readSidecar(target);
      sidecar.mode = mode;
      writeSidecar(target, sidecar);
      return sidecar;
    });
  }

  acceptDocSuggestion(chatId: string, relPath: string, id: string) {
    return this.docCall(chatId, relPath, (target) => {
      let sidecar = readSidecar(target);
      const suggestion = sidecar.suggestions.find((s) => s.id === id);
      if (!suggestion) throw new DocActionRejection('not_found', `no such suggestion: ${id}`);
      if (suggestion.status !== 'pending') {
        throw new DocActionRejection(
          'conflict',
          `suggestion ${id} is already ${suggestion.status}`,
        );
      }
      const current = readFileSync(target, 'utf8');
      const next = applyFindReplace(current, suggestion.find, suggestion.replace);
      this.writeFile(chatId, relPath, next);
      sidecar = readSidecar(target);
      const landed = sidecar.suggestions.find((s) => s.id === id);
      /* v8 ignore next -- defensive only: the suggestion this function just read above cannot vanish between the two reads — nothing else in this synchronous call rewrites the sidecar's suggestion list. */
      if (landed) landed.status = 'accepted';
      writeSidecar(target, sidecar);
      return sidecar;
    });
  }

  rejectDocSuggestion(chatId: string, relPath: string, id: string) {
    return this.docCall(chatId, relPath, (target) => {
      const sidecar = readSidecar(target);
      const suggestion = sidecar.suggestions.find((s) => s.id === id);
      if (!suggestion) throw new DocActionRejection('not_found', `no such suggestion: ${id}`);
      if (suggestion.status !== 'pending') {
        throw new DocActionRejection(
          'conflict',
          `suggestion ${id} is already ${suggestion.status}`,
        );
      }
      suggestion.status = 'rejected';
      writeSidecar(target, sidecar);
      return sidecar;
    });
  }

  /**
   * Applies every pending suggestion it can, in creation order, against the
   * document as each prior one left it — one `writeFile` (one version), not
   * one per suggestion. A suggestion whose `find` no longer uniquely matches
   * (edited since, or made stale by an earlier one in this same batch) is
   * left pending rather than failing the whole batch — the caller can see
   * which, and how many, by comparing the returned view's still-`pending`
   * suggestions against the ones it asked to accept.
   */
  acceptAllDocSuggestions(chatId: string, relPath: string) {
    return this.docCall(chatId, relPath, (target) => {
      const sidecar = readSidecar(target);
      let content = readFileSync(target, 'utf8');
      let applied = 0;
      for (const s of sidecar.suggestions) {
        if (s.status !== 'pending') continue;
        try {
          content = applyFindReplace(content, s.find, s.replace);
          s.status = 'accepted';
          applied += 1;
        } catch (err) {
          /* v8 ignore next -- defensive only: applyFindReplace only ever throws DocConflictError. */
          if (!(err instanceof DocConflictError)) throw err;
          // Left pending — see the doc comment above.
        }
      }
      if (applied > 0) this.writeFile(chatId, relPath, content);
      writeSidecar(target, sidecar);
      return readSidecar(target);
    });
  }

  rejectAllDocSuggestions(chatId: string, relPath: string) {
    return this.docCall(chatId, relPath, (target) => {
      const sidecar = readSidecar(target);
      for (const s of sidecar.suggestions) {
        if (s.status === 'pending') s.status = 'rejected';
      }
      writeSidecar(target, sidecar);
      return sidecar;
    });
  }

  /**
   * spec/14 § Document editor — comments both ways: the USER opening a new
   * thread. Queues the comment for the agent's next turn (`pendingDocComments`
   * / `consumeDocComments`) — the agent's own `patch_doc_comment` (mcp.ts) is
   * a SEPARATE method (`agentDocComment`, below) that does not queue anything,
   * since the agent already knows what it just said.
   */
  addDocComment(chatId: string, relPath: string, anchor: string, text: string) {
    return this.docCall(chatId, relPath, (target) => {
      const sidecar = readSidecar(target);
      const thread: DocThread = {
        id: ulid(),
        anchor,
        resolved: false,
        comments: [{ id: ulid(), author: 'user', text, createdAt: this.opts.now() }],
      };
      sidecar.threads.push(thread);
      writeSidecar(target, sidecar);
      this.queueDocComment(chatId, relPath, thread.id, anchor, text);
      return sidecar;
    });
  }

  replyDocComment(chatId: string, relPath: string, threadId: string, text: string) {
    return this.docCall(chatId, relPath, (target) => {
      const sidecar = readSidecar(target);
      const thread = sidecar.threads.find((t) => t.id === threadId);
      if (!thread) throw new DocActionRejection('not_found', `no such thread: ${threadId}`);
      thread.comments.push({ id: ulid(), author: 'user', text, createdAt: this.opts.now() });
      writeSidecar(target, sidecar);
      this.queueDocComment(chatId, relPath, thread.id, thread.anchor, text);
      return sidecar;
    });
  }

  resolveDocThread(chatId: string, relPath: string, threadId: string, resolved: boolean) {
    return this.docCall(chatId, relPath, (target) => {
      const sidecar = readSidecar(target);
      const thread = sidecar.threads.find((t) => t.id === threadId);
      if (!thread) throw new DocActionRejection('not_found', `no such thread: ${threadId}`);
      thread.resolved = resolved;
      writeSidecar(target, sidecar);
      return sidecar;
    });
  }

  restoreDocVersion(chatId: string, relPath: string, versionId: string) {
    return this.docCall(chatId, relPath, (target) => {
      const sidecar = readSidecar(target);
      const version = sidecar.versions.find((v) => v.id === versionId);
      if (!version) throw new DocActionRejection('not_found', `no such version: ${versionId}`);
      this.writeFile(chatId, relPath, version.content);
      const after = readSidecar(target);
      // `writeFile`'s own hook already pushed the restored content as a new
      // version with no `restoredFrom` (it doesn't know this write IS a
      // restore) — stamp it on the version that hook just appended, iff one
      // actually landed (restoring to what's already live is a no-op write).
      const pushed = after.versions.at(-1);
      if (pushed && pushed.content === version.content && pushed.restoredFrom === undefined) {
        pushed.restoredFrom = versionId;
        writeSidecar(target, after);
        return after;
      }
      return after;
    });
  }

  /**
   * Atomic binary write — same tmp-write + fsync + rename pattern
   * `writeFile`/`writeSidecar` use, just not text-only. Used by `exportDoc`
   * for the .docx/.pdf bytes it produces, which `writeFile` can't carry
   * (it's `content: string`, UTF-8 only).
   */
  private writeBinaryFileSync(absPath: string, data: Buffer): void {
    mkdirSync(dirname(absPath), { recursive: true });
    const tmp = `${absPath}.patch-tmp-${process.pid}`;
    writeFileSync(tmp, data, { mode: 0o644 });
    const fd = openSync(tmp, 'r');
    fsyncSync(fd);
    closeSync(fd);
    renameSync(tmp, absPath);
  }

  /**
   * spec/14 § Document editor, step 3 of 3 — opening a `.docx`: convert it
   * to the Markdown document the editor actually opens, leaving the
   * original untouched. Re-opening the SAME, unchanged `.docx` is a no-op
   * (`reused: true`) rather than reconverting — the `.md` may carry edits
   * (agent or user) made since the first open, and a `.docx` that hasn't
   * moved gives no reason to discard them. A `.docx` that HAS changed
   * (re-saved from Word) reconverts and overwrites the `.md`, but through
   * `writeFile`, so the previous content is kept as a version
   * (spec/14 § Document editor — History) rather than silently lost.
   */
  async convertDocx(
    chatId: string,
    relDocxPath: string,
  ): Promise<
    | { ok: true; value: { mdPath: string; warnings: string[]; reused: boolean } }
    | { ok: false; code: DocErrorCode; message: string }
  > {
    if (extname(relDocxPath).toLowerCase() !== '.docx') {
      return { ok: false, code: 'invalid', message: `not a .docx file: ${relDocxPath}` };
    }
    let docxAbsPath: string;
    try {
      docxAbsPath = this.resolveDocPath(chatId, relDocxPath);
    } catch (err) {
      return { ok: false, ...asDocActionRejection(err) };
    }
    const relMdPath = relDocxPath.slice(0, -'.docx'.length) + '.md';
    const mdAbsPath = join(dirname(docxAbsPath), relMdPath.slice(relMdPath.lastIndexOf('/') + 1));
    const mtimeMs = statSync(docxAbsPath).mtimeMs;

    if (existsSync(mdAbsPath)) {
      const existing = readSidecar(mdAbsPath);
      if (existing.sourceDocx?.path === relDocxPath && existing.sourceDocx.mtimeMs === mtimeMs) {
        return {
          ok: true,
          value: { mdPath: relMdPath, warnings: existing.importWarnings ?? [], reused: true },
        };
      }
    }

    const imagesDir = join(dirname(mdAbsPath), `${basename(relMdPath, '.md')}.files`);
    let markdown: string;
    let warnings: string[];
    try {
      ({ markdown, warnings } = await importDocx(docxAbsPath, imagesDir, dirname(mdAbsPath)));
    } catch (err) {
      return {
        ok: false,
        code: 'internal',
        message: `docx conversion failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    this.writeFile(chatId, relMdPath, markdown);
    const sidecar = readSidecar(mdAbsPath);
    sidecar.sourceDocx = { path: relDocxPath, mtimeMs };
    sidecar.importWarnings = warnings;
    writeSidecar(mdAbsPath, sidecar);
    return { ok: true, value: { mdPath: relMdPath, warnings, reused: false } };
  }

  /**
   * spec/14 § Document editor, step 3 of 3 — Download/Save as from the
   * editor's menu, and the agent's `patch_doc_export` tool. Writes the
   * exported file BESIDE the `.md` (same basename, new extension) through
   * the same `patch.file_changed` path every other write takes — so it is
   * immediately visible in the file browser and reachable by the agent too,
   * not just whichever surface asked for the download — and returns its
   * bytes so that surface can also hand the user a download directly.
   * `format: 'md'` is the trivial case (the document's own current bytes,
   * nothing written — there is nothing beside itself to write).
   */
  async exportDoc(
    chatId: string,
    relMdPath: string,
    format: DocExportFormat,
  ): Promise<
    | { ok: true; value: { path: string; mimeType: string; buffer: Buffer; warnings: string[] } }
    | { ok: false; code: DocErrorCode; message: string }
  > {
    if (extname(relMdPath).toLowerCase() !== '.md') {
      return { ok: false, code: 'invalid', message: `not a .md file: ${relMdPath}` };
    }
    let mdAbsPath: string;
    try {
      mdAbsPath = this.resolveDocPath(chatId, relMdPath);
    } catch (err) {
      return { ok: false, ...asDocActionRejection(err) };
    }
    const content = readFileSync(mdAbsPath, 'utf8');
    const baseDir = dirname(mdAbsPath);
    const stem = relMdPath.slice(0, -'.md'.length);
    // `resolveDocPath` above already proved this chat exists.
    const root = realpathSync(pathResolve(this.chatState.get(chatId)!.folder));

    if (format === 'md') {
      return {
        ok: true,
        value: {
          path: relMdPath,
          mimeType: 'text/markdown',
          buffer: Buffer.from(content, 'utf8'),
          warnings: [],
        },
      };
    }
    if (format === 'docx') {
      let result: { buffer: Buffer; warnings: string[] };
      try {
        result = await exportMarkdownToDocx(content, baseDir);
      } catch (err) {
        return {
          ok: false,
          code: 'internal',
          message: `docx export failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      const relOut = `${stem}.docx`;
      this.writeBinaryFileSync(join(baseDir, basename(relOut)), result.buffer);
      this.invalidateFileListCaches(root);
      this.emit({ type: 'patch.file_changed', chatId, path: relOut });
      return {
        ok: true,
        value: {
          path: relOut,
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          buffer: result.buffer,
          warnings: result.warnings,
        },
      };
    }
    // format === 'pdf'
    let buffer: Buffer;
    try {
      buffer = await exportMarkdownToPdf(content, baseDir);
    } catch (err) {
      if (err instanceof BrowserNotInstalledError) {
        return { ok: false, code: 'browser_missing', message: err.message };
      }
      return {
        ok: false,
        code: 'internal',
        message: `pdf export failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const relOut = `${stem}.pdf`;
    this.writeBinaryFileSync(join(baseDir, basename(relOut)), buffer);
    this.invalidateFileListCaches(root);
    this.emit({ type: 'patch.file_changed', chatId, path: relOut });
    return {
      ok: true,
      value: { path: relOut, mimeType: 'application/pdf', buffer, warnings: [] },
    };
  }

  /** Owed to the agent's next turn — see `pendingDocComments` / `consumeDocComments`. */
  private queueDocComment(
    chatId: string,
    relPath: string,
    threadId: string,
    anchor: string,
    text: string,
  ): void {
    const owed = this.pendingDocComments.get(chatId) ?? [];
    owed.push({ path: relPath, threadId, anchor, text });
    this.pendingDocComments.set(chatId, owed);
  }

  /**
   * `patch_doc_suggest` (mcp.ts): the agent's own tracked edit in Propose
   * mode. Refused outright — naming the mode — everywhere else: `change`
   * should use `Edit`/`Write` directly, and `comment` touches no text at
   * all. `find` must be a CURRENTLY UNIQUE match, same contract `Edit`'s
   * `old_string` holds, checked at creation time so the agent learns about a
   * bad `find` immediately rather than when a human eventually clicks Accept.
   */
  suggestDoc(chatId: string, relPath: string, find: string, replace: string) {
    return this.docCall(chatId, relPath, (target) => {
      const sidecar = readSidecar(target);
      if (sidecar.mode !== 'propose') {
        throw new DocActionRejection(
          'conflict',
          `this document is in ${sidecar.mode} mode, not propose — patch_doc_suggest is refused`,
        );
      }
      const current = readFileSync(target, 'utf8');
      const count = countOccurrences(current, find);
      if (count !== 1) {
        throw new DocActionRejection(
          'conflict',
          count === 0
            ? `"${find}" is not in the document`
            : `"${find}" matches ${count} places in the document — not unique`,
        );
      }
      const suggestion: DocSuggestion = {
        id: ulid(),
        find,
        replace,
        status: 'pending',
        createdAt: this.opts.now(),
      };
      sidecar.suggestions.push(suggestion);
      writeSidecar(target, sidecar);
      return suggestion;
    });
  }

  /** `patch_doc_comment` (mcp.ts): the agent opening a new thread — allowed in every mode. */
  agentDocComment(chatId: string, relPath: string, anchor: string, text: string) {
    return this.docCall(chatId, relPath, (target) => {
      const sidecar = readSidecar(target);
      const thread: DocThread = {
        id: ulid(),
        anchor,
        resolved: false,
        comments: [{ id: ulid(), author: 'agent', text, createdAt: this.opts.now() }],
      };
      sidecar.threads.push(thread);
      writeSidecar(target, sidecar);
      return thread;
    });
  }

  /** `patch_doc_reply` (mcp.ts): the agent replying in an existing thread — allowed in every mode. */
  agentDocReply(chatId: string, relPath: string, threadId: string, text: string) {
    return this.docCall(chatId, relPath, (target) => {
      const sidecar = readSidecar(target);
      const thread = sidecar.threads.find((t) => t.id === threadId);
      if (!thread) throw new DocActionRejection('not_found', `no such thread: ${threadId}`);
      thread.comments.push({ id: ulid(), author: 'agent', text, createdAt: this.opts.now() });
      writeSidecar(target, sidecar);
      return thread;
    });
  }

  /**
   * Mark a chat `errored` before any SDK query is issued and surface a
   * `chat.error` through the normal per-chat bumpSeq path (monotonic +
   * persisted). Used by runQuery's pre-flight checks (F1 `claude_session_missing`,
   * F5 `folder_missing`) — no SDK query is started, no bad cwd / resume is
   * handed to the backend. NO FALLBACK: the failure surfaces immediately and
   * the next user action can explicitly start fresh.
   */
  private failPreflight(chatId: string, code: ChatErrorCode, message: string): void {
    const seq = this.bumpSeq(chatId);
    const errorEvent: ChatErrorEvent = {
      type: 'chat.error',
      chatId,
      error: { code, message },
      seq,
    };
    this.emit(errorEvent);
    this.chatState.setLastError(chatId, { code, message, at: this.opts.now() });
    this.chatState.setActivity(chatId, 'errored');
    const cur = this.chatState.get(chatId);
    if (cur) cur.status = 'errored';
    this.opts.metaStore.update(chatId, (m) => ({
      ...m,
      status: 'errored',
      lastError: { code, message, at: this.opts.now() },
      updatedAt: this.opts.now(),
    }));
    this.emitState(chatId);
    this.opts.logger.error({ chatId, code, message }, 'runQuery pre-flight failed (NO FALLBACK)');
  }

  /**
   * Stamp a published artifact into the chat's stream (spec/14 § Artifacts).
   * Goes through the normal bumpSeq path so the card is persisted + replayed
   * like any other timeline item. Slim by design — the page body stays on the
   * server; this carries only the URL to fetch it from.
   */
  emitArtifact(
    chatId: string,
    a: { artifactId: string; title: string; url: string; path: string },
  ): number {
    const seq = this.bumpSeq(chatId);
    this.emit({
      type: 'chat.artifact',
      chatId,
      artifactId: a.artifactId,
      title: a.title,
      url: a.url,
      path: a.path,
      updatedAt: this.opts.now(),
      seq,
    });
    return seq;
  }

  /**
   * Allocate a monotonic, persisted seq for a control-path `chat.error` that
   * the host emits OUTSIDE a running SDK query (F4 — the catch-all in
   * index.ts). When the chat is known, route through the normal bumpSeq path
   * so the seq is monotonic and persisted (never collides with a real stream
   * event at seq 0). When no chat context exists, returns OUT_OF_BAND_SEQ
   * (-1) — a clearly non-stream marker a surface must not treat as a replayable
   * event.
   */
  allocErrorSeq(chatId: string): number {
    if (this.chatState.has(chatId)) {
      const seq = this.bumpSeq(chatId);
      // The caller sends this error itself rather than through `emit`, so
      // nothing else will ever put its seq in the history log.
      this.chatLog.reserve(chatId, seq, this.branchIdFor(chatId));
      return seq;
    }
    return OUT_OF_BAND_SEQ;
  }

  /** Bump nextSeq for a chat, persist meta atomically, return the previous seq. */
  /**
   * Say, in the chat, that the permission mode was degraded to fit the model.
   *
   * Announced exactly ONCE per chat. A degrade patch performs silently is the
   * same bug as the one Claude Code was doing — but repeating it on every turn
   * of a long chat would bury the transcript, and the fact does not change
   * while the model and the configured mode do not.
   */
  private announcePermissionModeDegrade(
    chatId: string,
    from: SdkPermissionMode,
    to: SdkPermissionMode,
    model: string | undefined,
  ): void {
    const key = `${chatId}:${model ?? ''}:${from}:${to}`;
    if (this.announcedModeDegrades.has(key)) return;
    this.announcedModeDegrades.add(key);
    this.opts.logger.warn(
      { chatId, model: model ?? null, configured: from, running: to },
      'permission mode degraded to one this model supports',
    );
    const ev: ChatMessageEvent = {
      type: 'chat.message',
      chatId,
      role: 'system',
      content:
        `Permission mode '${from}' is not available on ${model ?? 'this model'}, ` +
        `so this chat is running on '${to}'. Move it to a model that supports ` +
        `'${from}', or choose a mode deliberately.`,
      seq: this.bumpSeq(chatId),
      createdAt: this.opts.now(),
    };
    this.emit(ev);
  }

  private bumpSeq(chatId: string): number {
    const state = this.chatState.get(chatId);
    if (!state) throw new Error(`bumpSeq: unknown chatId ${chatId}`);
    // The history log is the seq authority (spec/02 § Sequence durability):
    // every seq it hands out is recorded in the log, so a restart resumes
    // above it. meta.json mirrors `nextSeq` when a turn settles
    // (`mirrorSeqToMeta`), not on every emit.
    const seq = this.chatLog.allocate(chatId, state.nextSeq, this.branchIdFor(chatId));
    state.nextSeq = seq + 1;
    state.lastUpdated = this.opts.now();
    return seq;
  }

  /**
   * Mirror the chat's seq position and last-updated time into meta.json. Done
   * when a turn settles and on shutdown — the log already holds every seq, so
   * this only keeps the meta the sidebar and hydrate read current.
   *
   * `claudeSessionId` is NOT mirrored here — it is written immediately, at the
   * point it actually changes (`handleEnvelopeInner`), which is the only
   * correct value to persist. Re-asserting it from in-memory state on a delay
   * would clobber a legitimate out-of-band clear (an orphaned-session reset, a
   * hand edit) with a stale value the moment the next turn settles or the
   * process exits.
   */
  private mirrorSeqToMeta(chatId: string): void {
    const state = this.chatState.get(chatId);
    if (!state || !this.opts.metaStore.read(chatId)) return;
    this.opts.metaStore.update(chatId, (m) => ({
      ...m,
      nextSeq: state.nextSeq,
      updatedAt: state.lastUpdated,
    }));
  }

  /**
   * Make the history log durable and release it (shutdown). Also mirrors every
   * chat's seq into its meta, since seqs handed out outside a turn are not
   * mirrored anywhere else.
   */
  flushHistory(): void {
    for (const state of this.chatState.list()) {
      try {
        this.mirrorSeqToMeta(state.chatId);
      } catch (err) {
        this.opts.logger.error(
          { chatId: state.chatId, err },
          'shutdown: could not mirror seq to meta',
        );
      }
    }
    this.chatLog.closeAll();
  }

  /** The branch history records for this chat are stamped with — its active track. */
  private branchIdFor(chatId: string): string {
    // A running turn keeps the track it started on, even if a fork queued
    // behind it has already made another track active.
    const turnBranch = this.turnBranches.get(chatId);
    if (turnBranch !== undefined) return turnBranch;
    const cached = this.branchIds.get(chatId);
    if (cached !== undefined) return cached;
    const meta = this.opts.metaStore.read(chatId);
    const claudeSessionId = this.chatState.get(chatId)?.claudeSessionId;
    // A turn about to start resumes `claudeSessionId` — the true resume
    // target, and (spec/04 § Branching) it changes only once a fork's OWN
    // turn actually completes. `activeBranchId` changes the moment `forkChat`
    // is CALLED, which can be well before a fork carried through the queue
    // (or a message queued ahead of it) actually runs — so it is the wrong
    // signal for "which track is this turn on": match the branch whose
    // session is the one actually being resumed instead. A branch with no
    // session yet (the fork itself, on its own first turn) has nothing to
    // match, so it falls through to `activeBranchId`, which by then IS its
    // branch (`forkChat`'s creation already made it active).
    const bySession = claudeSessionId
      ? meta?.branches?.find((b) => b.sessionId === claudeSessionId)?.branchId
      : undefined;
    const branchId = bySession ?? meta?.activeBranchId ?? `${chatId}-b0`;
    this.branchIds.set(chatId, branchId);
    return branchId;
  }

  private harnessOf(chatId: string): HarnessId {
    return isCodexModel(this.chatState.get(chatId)?.model) ? 'codex' : 'claude';
  }

  /** `~/.patch/chats/<chatId>/native/claude` — the Claude session mirror
   * (spec/04 § History — the native resume cache). */
  private nativeClaudeDirFor(chatId: string): string {
    return join(dirname(this.opts.metaStore.pathFor(chatId)), 'native', 'claude');
  }

  private claudeSessionStoreFor(
    chatId: string,
    folder: string,
  ): ReturnType<typeof createClaudeSessionStore> {
    return createClaudeSessionStore({
      chatId,
      folder,
      nativeDir: this.nativeClaudeDirFor(chatId),
      claudeProjectsRoot: this.claudeProjectsRoot,
      logger: this.opts.logger,
    });
  }

  /**
   * Whether `harness` still has `sessionId` natively available for THIS
   * track (spec/04 § History — "build from scratch only when no original
   * native session exists"). Claude checks the mirror OR the harness's own
   * on-disk transcript (`claudeSessionStore`'s own load() priority — a
   * session can be genuinely resumable even if only one of the two survived);
   * Codex's own history store is the single source of truth for its ids, no
   * separate mirror to fall back to.
   */
  private async hasNativeSessionFor(
    chatId: string,
    folder: string,
    harness: HarnessId,
    sessionId: string,
  ): Promise<boolean> {
    if (harness === 'codex') return this.historyReader.hasSession({ folder, sessionId });
    const loaded = await this.claudeSessionStoreFor(chatId, folder).load({
      projectKey: chatId,
      sessionId,
    });
    return loaded !== null && loaded.length > 0;
  }

  /**
   * What a switch onto `targetHarness` would reconstruct, WITHOUT doing it
   * (spec/04 § History — preserve the cached prefix, and the confirmation
   * estimate that previews it before the user commits). Shared by the actual
   * switch (`runQuery`) and `estimateProviderSwitch` — both need the exact
   * same "resume this track's own prior session, or rebuild from scratch"
   * decision; only `runQuery` acts on it (stashing, mirror-appending).
   *
   * `excludeFromSeq` drops the in-flight turn's own trigger message (already
   * logged by the time `runQuery` reaches this, but not yet run) — omitted
   * for a preview, since there IS no in-flight message yet.
   */
  /** Whether the active track holds anything logged before `beforeSeq`. */
  private hasPriorTrack(chatId: string, beforeSeq: number | undefined): boolean {
    const meta = this.opts.metaStore.read(chatId);
    if (!meta) return false;
    const branchId = meta.activeBranchId ?? this.branchIdFor(chatId);
    return readTrack(this.chatLog, chatId, meta, branchId, -1).some(
      (t) => beforeSeq === undefined || t.record.seq < beforeSeq,
    );
  }

  private async planHarnessReconstruction(
    chatId: string,
    targetHarness: HarnessId,
    folder: string,
    excludeFromSeq?: number,
  ): Promise<{
    track: TrackEntry[];
    resumeExistingSessionId?: string;
    activeBranchId: string;
    fullTrackLastSeq: number;
    /** When the track's own last entry was logged (via `this.opts.now()`,
     * unlike `ChatState.lastUpdated`, which `setActivity` stamps with a raw
     * `Date.now()`) — the cache-cold check's basis. `undefined` for an empty
     * track (nothing has happened yet). */
    lastActivityAt: number | undefined;
  }> {
    // Guarantees `meta.branches` is populated (persisting the synthesised
    // root if this chat predates branching, e.g. every chat that has never
    // been forked) — otherwise `harnessSessions` has nowhere well-formed to
    // live and a cache-preserving return trip could never find what an
    // earlier switch stashed on the way out.
    this.ensureBranches(chatId);
    const meta = this.opts.metaStore.read(chatId);
    const activeBranchId = meta?.activeBranchId ?? this.branchIdFor(chatId);
    const beforeBoundary = (t: { record: { seq: number } }): boolean =>
      excludeFromSeq === undefined || t.record.seq < excludeFromSeq;
    const fullTrack = meta
      ? readTrack(this.chatLog, chatId, meta, activeBranchId, -1).filter(beforeBoundary)
      : [];
    const fullTrackLastSeq = fullTrack.at(-1)?.record.seq ?? -1;
    const lastActivityAt = fullTrack.at(-1)?.record.at;
    const branch = meta?.branches?.find((b) => b.branchId === activeBranchId);
    const prior = branch?.harnessSessions?.[targetHarness];
    if (prior && (await this.hasNativeSessionFor(chatId, folder, targetHarness, prior.sessionId))) {
      const delta = meta
        ? readTrack(this.chatLog, chatId, meta, activeBranchId, prior.lastSeq).filter(
            beforeBoundary,
          )
        : [];
      return {
        track: delta,
        resumeExistingSessionId: prior.sessionId,
        activeBranchId,
        fullTrackLastSeq,
        lastActivityAt,
      };
    }
    return { track: fullTrack, activeBranchId, fullTrackLastSeq, lastActivityAt };
  }

  /**
   * "Switch and compact" (spec/04 § History — the cheap path for a huge
   * chat): the OUTGOING session writes its own handoff (resumed, riding its
   * cache — `generateDigest`, `rotationDigest.ts`, on WHICHEVER harness it
   * actually is, via `model`), and the target starts from that plus the last
   * few turns, instead of the full native reconstruction
   * `planHarnessReconstruction` would build.
   *
   * NO FALLBACK: no generator configured, or the generator itself failing
   * (OAuth miss, SDK error, empty reply — `generateDigest`'s own contract),
   * resolves to `{ok: false}`. The caller fails the whole switch loudly
   * rather than silently reconstructing in full instead — the user asked for
   * the cheap path specifically.
   */
  private async buildCompactSwitchTrack(
    chatId: string,
    folder: string,
    outgoingSessionId: string,
    outgoingModel: string | null,
    excludeFromSeq: number | undefined,
  ): Promise<
    | {
        ok: true;
        track: TrackEntry[];
        activeBranchId: string;
        fullTrackLastSeq: number;
      }
    | { ok: false; error: string }
  > {
    if (!this.opts.generateDigest) {
      return { ok: false, error: 'switch and compact: no digest generator is configured' };
    }
    this.ensureBranches(chatId);
    const meta = this.opts.metaStore.read(chatId);
    const activeBranchId = meta?.activeBranchId ?? this.branchIdFor(chatId);
    const beforeBoundary = (t: { record: { seq: number } }): boolean =>
      excludeFromSeq === undefined || t.record.seq < excludeFromSeq;
    const fullTrack = meta
      ? readTrack(this.chatLog, chatId, meta, activeBranchId, -1).filter(beforeBoundary)
      : [];
    const fullTrackLastSeq = fullTrack.at(-1)?.record.seq ?? -1;
    const digest = await this.opts.generateDigest({
      chatId,
      resumeSessionId: outgoingSessionId,
      folder,
      model: outgoingModel,
    });
    if (digest === null) {
      return {
        ok: false,
        error:
          'switch and compact: the outgoing session could not write a handoff (OAuth, an SDK error, or an empty reply) — try again, or switch without compacting',
      };
    }
    const recent = fullTrack.slice(-COMPACT_SWITCH_RECENT_ENTRIES);
    const handoffSeq = (recent[0]?.record.seq ?? fullTrackLastSeq) - 1;
    const handoffAt = recent[0]?.record.at ?? this.opts.now();
    const handoff: TrackEntry = {
      record: { seq: handoffSeq, at: handoffAt },
      event: {
        type: 'chat.message',
        chatId,
        role: 'user',
        // Framed as user-provided context, the same way patch's own
        // system-reminder blocks are (history.ts's `extractLeadingSystemReminders`)
        // — the Messages/Responses APIs require the first turn to be `user`,
        // and an `assistant`-voiced handoff would misattribute an unspoken
        // reply to the model.
        content: `[Handoff from the previous session]\n\n${digest}`,
        seq: handoffSeq,
      },
    };
    return {
      ok: true,
      track: [handoff, ...recent],
      activeBranchId,
      fullTrackLastSeq,
    };
  }

  /**
   * Append one history record for a chat, stamped with its branch and open
   * turn. Throws `HistoryWriteError`; a running turn records the failure so it
   * ends `history_write_failed` rather than carrying on.
   */
  private logRecord(
    chatId: string,
    body: Parameters<ChatLog['append']>[1],
    o: { seq?: number; sync?: boolean; nativeRef?: NativeRef; dedupeKey?: string } = {},
  ): boolean {
    try {
      return this.chatLog.append(chatId, body, { branchId: this.branchIdFor(chatId), ...o });
    } catch (err) {
      if (err instanceof HistoryWriteError) this.noteHistoryFailure(chatId, err);
      throw err;
    }
  }

  /**
   * End the running turn in the history log: its outcome, the error it ended
   * on, and the usage the harness reported. Never throws — the turn is already
   * over, and a log that cannot take this record has already failed it loudly.
   */
  private closeTurnInHistory(
    chatId: string,
    outcome: TurnOutcome,
    error: { code: ChatErrorCode; message: string } | undefined,
  ): void {
    this.closeToolRun(chatId);
    this.historyFailures.delete(chatId);
    this.runningForks.delete(chatId);
    this.runningProviderSwitch.delete(chatId);
    const usage = this.turnUsage.get(chatId);
    this.turnUsage.delete(chatId);
    try {
      this.chatLog.append(
        chatId,
        {
          k: 'turn.end',
          outcome,
          ...(error !== undefined ? { error } : {}),
          ...(usage !== undefined ? { usage } : {}),
        },
        { branchId: this.branchIdFor(chatId), sync: true },
      );
    } catch (err) {
      this.opts.logger.error(
        { chatId, outcome, err: (err as Error).message },
        'history log: could not record the end of a turn',
      );
    }
    this.chatLog.endTurn(chatId);
    this.turnBranches.delete(chatId);
    try {
      this.mirrorSeqToMeta(chatId);
    } catch (err) {
      this.opts.logger.error({ chatId, err }, 'could not mirror seq to meta after a turn');
    }
  }

  /** A turn whose history append failed before its query started: undo what runQuery set up. */
  private abandonTurnOnHistoryFailure(chatId: string, err: HistoryWriteError): void {
    this.aborters.delete(chatId);
    this.runningTurn.delete(chatId);
    this.persistPendingTurns(chatId);
    this.reportHistoryFailure(chatId, err, undefined);
    this.closeTurnInHistory(chatId, 'failed', {
      code: 'history_write_failed',
      message: err.message,
    });
  }

  /**
   * Fail the chat loudly because its history could not be written (spec/04 §
   * History). The turn does not carry on and is not retried: every retry
   * would show things the chat then fails to remember.
   */
  private reportHistoryFailure(
    chatId: string,
    err: HistoryWriteError,
    causeSeq: number | undefined,
  ): void {
    const message = `This chat's history could not be saved, so the turn was stopped. ${err.message}`;
    const at = this.opts.now();
    this.emit(
      {
        type: 'chat.error',
        chatId,
        error: { code: 'history_write_failed', message },
        seq: OUT_OF_BAND_SEQ,
        ...(causeSeq !== undefined ? { causeSeq } : {}),
      },
      { skipHistory: true },
    );
    this.chatState.setLastError(chatId, { code: 'history_write_failed', message, at });
    const state = this.chatState.get(chatId);
    if (state) state.status = 'errored';
    if (this.opts.metaStore.read(chatId)) {
      this.opts.metaStore.update(chatId, (m) => ({
        ...m,
        status: 'errored',
        lastError: { code: 'history_write_failed', message, at },
        updatedAt: at,
      }));
    }
    this.chatState.setActivity(chatId, 'errored');
    this.emitState(chatId);
    this.opts.logger.error({ chatId, err: err.message }, 'turn failed: history_write_failed');
  }

  private noteHistoryFailure(chatId: string, err: HistoryWriteError): void {
    this.opts.logger.error({ chatId, err: err.message }, 'history log append failed');
    const aborter = this.aborters.get(chatId);
    if (aborter && !this.historyFailures.has(chatId)) {
      this.historyFailures.set(chatId, err);
      aborter.abort();
    }
  }

  /**
   * Put a chat-scoped event with a seq into the history log BEFORE anyone sees
   * it (spec/04 § History). Durable events are stored whole; a permission
   * request as its own record; any other seq'd event (an error) only reserves
   * its seq. Returns false when the event is a harness re-send of one this turn
   * already logged, in which case it is not shown either.
   */
  private logEmitted(chatId: string, event: WireEvent, seq: number): boolean {
    if (isLoggedEvent(event)) {
      // A tool-run summary is Patch's own and lands whenever the model answers,
      // often in a later turn — it belongs to no harness message, so it takes
      // no native ref (and no dedupe key derived from one).
      const ref =
        event.type === 'chat.tool_run_summary' ? undefined : this.envelopeRefs.get(chatId);
      const identity = eventIdentity(event) ?? event.type;
      return this.logRecord(
        chatId,
        { k: 'event', event: stripSurfaceId(event) },
        {
          seq,
          // A person's message is the one thing that cannot be regenerated.
          sync: event.type === 'chat.message' && event.role === 'user',
          ...(ref !== undefined
            ? { nativeRef: ref, dedupeKey: `${ref.harness}:${ref.id}:${identityHash(identity)}` }
            : {}),
        },
      );
    }
    if (event.type === 'chat.permission_request') {
      this.logRecord(
        chatId,
        {
          k: 'permission.request',
          requestId: event.requestId,
          tool: event.request.tool,
          args: event.request.args,
          ...(event.request.description !== undefined
            ? { description: event.request.description }
            : {}),
          ...(event.expiry !== undefined ? { expiresAt: event.expiry.at } : {}),
        },
        { seq },
      );
      return true;
    }
    this.logRecord(chatId, { k: 'seq.reserve' }, { seq });
    return true;
  }

  /**
   * Absolute path of a chat's canonical-seq index sidecar. Lives beside
   * `meta.json` / `seq` in `~/.patch/chats/<chatId>/` (spec/02 § Local storage),
   * derived from the meta store so there is one owner of that layout.
   */
  private seqIndexPath(chatId: string): string {
    return join(dirname(this.opts.metaStore.pathFor(chatId)), 'seqindex.jsonl');
  }

  /**
   * Record that `seq` is the canonical seq of the event whose payload identity
   * hashes to `hash` — the durable half of "the seq a surface saw live is the
   * seq that message replays under". Append-only, one `{seq,hash}` line per
   * persisted-class event; no message text (see `identityHash`).
   *
   * First write per seq wins on read, so a seq recorded deliberately (the user
   * turn, keyed on the text Claude Code will persist) is never displaced by the
   * automatic record `emit()` makes of the same event's rendered form.
   */
  private recordCanonicalSeq(chatId: string, hash: string, seq: number): void {
    const path = this.seqIndexPath(chatId);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify({ seq, hash })}\n`, 'utf8');
  }

  /**
   * The chat's canonical seq index, as `history.ts` consumes it: transcript
   * event identities in order → the seqs the host stamped when it emitted
   * them live.
   *
   * A key with no recorded seq was never emitted by this host — a transcript
   * that predates the sidecar, or a turn produced by `claude --resume` in a
   * terminal. It has no canonical seq yet, so one is ALLOCATED here and
   * recorded, making every later read return the same number. That assignment
   * is a one-off migration step, not a fallback: nothing is guessed and nothing
   * is renumbered twice.
   */
  private canonicalSeqIndex(chatId: string): CanonicalSeqIndex {
    return {
      resolve: (keys: string[]): number[] => {
        const recorded = this.readSeqIndex(chatId);
        return keys.map((key) => {
          const hash = identityHash(key);
          const queued = recorded.get(hash);
          const known = queued?.shift();
          if (known !== undefined) return known;
          const seq = this.bumpSeq(chatId);
          this.recordCanonicalSeq(chatId, hash, seq);
          // The seq now belongs to a transcript entry the history log has no
          // record of; hold it there so it is never handed out again.
          this.chatLog.reserve(chatId, seq, this.branchIdFor(chatId));
          return seq;
        });
      },
    };
  }

  /**
   * Read the sidecar into `hash → seqs in recording order`. Repeated payloads
   * (the user asking the same thing twice) each hold their own entry and are
   * consumed in order, so the n-th occurrence in the transcript resolves to the
   * n-th seq. A seq recorded more than once keeps its FIRST entry only.
   */
  private readSeqIndex(chatId: string): Map<string, number[]> {
    return readSeqIndexFile(this.seqIndexPath(chatId), chatId);
  }

  /**
   * Central emit wrapper. Records chat-scoped stream events into the per-chat
   * recent-events ring (backing patch_peek) and their canonical seq into the
   * chat's seq index, before fanning out via the injected emit. Every event the
   * host emits goes through here.
   */
  private emit(event: WireEvent, o: { skipHistory?: boolean } = {}): void {
    if (event.type === 'chat.permission_response' && event.chatId) {
      this.settledPermissionEchoes.delete(event.requestId);
      this.settledPermissionEchoes.set(event.requestId, event);
      if (this.settledPermissionEchoes.size > SETTLED_ECHO_CAP) {
        this.settledPermissionEchoes.delete(this.settledPermissionEchoes.keys().next().value!);
      }
    }
    const chatId = (event as { chatId?: unknown }).chatId;
    const seq = (event as { seq?: unknown }).seq;
    if (
      !o.skipHistory &&
      typeof chatId === 'string' &&
      chatId.length > 0 &&
      typeof seq === 'number' &&
      seq >= 0 &&
      this.chatState.has(chatId) &&
      !this.logEmitted(chatId, event, seq)
    ) {
      this.opts.logger.info(
        { chatId, seq, type: event.type },
        'history: dropped a harness re-send of an event this turn already logged',
      );
      return;
    }
    if (typeof chatId === 'string' && chatId.length > 0 && typeof seq === 'number' && seq >= 0) {
      // Persisted-class events (messages / tool calls / tool results) are the
      // ones Claude Code also writes to its transcript, so they are the ones
      // replay has to renumber back to their live seq. Live-only events carry
      // no seq at all and never reach here; errors / artifacts / permission
      // requests have a seq but no identity, and are never in the transcript.
      const key = eventIdentity(event);
      if (key !== null && this.chatState.has(chatId)) {
        this.recordCanonicalSeq(chatId, identityHash(key), seq);
      }
    }
    if (typeof chatId === 'string' && chatId.length > 0 && typeof seq === 'number') {
      let ring = this.recentEvents.get(chatId);
      if (!ring) {
        ring = [];
        this.recentEvents.set(chatId, ring);
      }
      ring.push(event);
      if (ring.length > Daemon.RECENT_EVENTS_CAP) {
        ring.splice(0, ring.length - Daemon.RECENT_EVENTS_CAP);
        this.recentEventsDropped.add(chatId);
      }
    }
    // spec/02 § Native subagent dispatch — a `patch_delegate` subagent is
    // invisible to the user: the local bookkeeping above (ring buffer, seq
    // index, history below) still runs, so its own transcript is intact for
    // the read-only viewer and for `maybeSettleDelegate` to read back, but
    // the event never reaches the server. The server only ever creates a
    // sidebar row from `chat.spawned` (chat-registry.ts), so a subagent that
    // never sends one is unreachable from every surface built on top of it —
    // sidebar, search, notifications, badges — with nothing to filter at each
    // of them individually.
    if (typeof chatId === 'string' && this.chatState.get(chatId)?.subagent) {
      if (!o.skipHistory) this.trackToolRun(event);
      return;
    }
    this.opts.emit(event);
    if (!o.skipHistory) this.trackToolRun(event);
    this.trackHookToolTally(event);
  }

  /**
   * spec/20-hooks.md § On the agent's response — always-on tool-call tally,
   * independent of `summarizeToolRun`. Counts by tool name; read and cleared
   * by `maybeCheckAgentResponseHooks` at turn settle.
   */
  private trackHookToolTally(event: WireEvent): void {
    if (event.type !== 'chat.tool_call') return;
    let tally = this.hookToolTally.get(event.chatId);
    if (!tally) {
      tally = new Map();
      this.hookToolTally.set(event.chatId, tally);
    }
    tally.set(event.tool, (tally.get(event.tool) ?? 0) + 1);
  }

  /**
   * "Ran 2 commands, read 1 file" — a cheap, deterministic rendering of a
   * tool tally for a hook's own context (spec/20-hooks.md § On the agent's
   * response). Not the nicer web copy (`toolSummary.ts`'s `toolRunNarrative`)
   * — that is user-facing prose this is not; a hook author reads this
   * verbatim in their own script/prompt, so the exact words don't carry the
   * weight a transcript label would.
   */
  private static describeHookToolTally(tally: Map<string, number> | undefined): string {
    if (!tally || tally.size === 0) return 'No tool calls';
    return [...tally].map(([tool, n]) => `${tool} ×${n}`).join(', ');
  }

  /**
   * spec/14 § Tool runs — follow the live stream's tool runs. A groupable call
   * joins the open run; anything a surface would draw as its own row between
   * two calls (a message, an edit, a Monitor, a view_file, a permission card,
   * an artifact) closes it, as does the end of the turn.
   */
  private trackToolRun(event: WireEvent): void {
    if (!this.opts.summarizeToolRun) return;
    const chatId = (event as { chatId?: unknown }).chatId;
    if (typeof chatId !== 'string' || !this.chatState.has(chatId)) return;
    let run = this.toolRuns.get(chatId);
    if (!run) {
      run = { calls: [], userMessage: '', assistantBefore: '' };
      this.toolRuns.set(chatId, run);
    }
    switch (event.type) {
      case 'chat.tool_call':
        if (isGroupableToolCall(event.tool, event.args)) {
          run.calls.push({ callId: event.callId, tool: event.tool, args: event.args });
        } else {
          this.closeToolRun(chatId);
        }
        return;
      case 'chat.tool_result': {
        // The summary describes what happened, not what was attempted, so a
        // call's outcome rides along with it.
        const call = run.calls.find((c) => c.callId === event.callId);
        if (!call) return;
        call.failed = event.isError === true;
        if (call.failed) {
          call.outcome =
            typeof event.result === 'string' ? event.result : JSON.stringify(event.result ?? '');
        }
        return;
      }
      case 'chat.message':
        this.closeToolRun(chatId);
        if (event.role === 'user') {
          run.userMessage = event.content;
          run.assistantBefore = '';
        } else if (event.role === 'assistant') {
          run.assistantBefore = event.content;
        }
        return;
      case 'chat.permission_request':
      case 'chat.artifact':
        this.closeToolRun(chatId);
        return;
      default:
        return;
    }
  }

  /**
   * Close a chat's open tool run. A run of more than one call — the only kind
   * a surface collapses — is summarised in the background and its label (or
   * the reason there is none) stamped into the stream, keyed by its call ids.
   */
  private closeToolRun(chatId: string): void {
    const gen = this.opts.summarizeToolRun;
    const run = this.toolRuns.get(chatId);
    if (!gen || !run || run.calls.length === 0) return;
    const calls = run.calls;
    run.calls = [];
    if (calls.length < 2) return;
    const state = this.chatState.get(chatId);
    if (!state) return;
    const callIds = calls.map((c) => c.callId);
    const stamp = (result: { summary: string } | { error: string }): void => {
      if (!this.chatState.has(chatId)) return;
      try {
        this.emit({
          type: 'chat.tool_run_summary',
          chatId,
          callIds,
          ...('summary' in result
            ? { summary: result.summary }
            : { summary: null, error: result.error }),
          seq: this.bumpSeq(chatId),
        });
      } catch (err) {
        this.opts.logger.error({ chatId, err }, 'tool run summary: could not stamp it');
      }
    };
    void gen({
      chatId,
      folder: state.folder,
      userMessage: run.userMessage,
      assistantBefore: run.assistantBefore,
      calls: calls.map(({ tool, args, failed, outcome }) => ({
        tool,
        args,
        ...(failed !== undefined ? { failed } : {}),
        ...(outcome !== undefined ? { outcome } : {}),
      })),
    }).then(
      (summary) => stamp({ summary }),
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.opts.logger.warn({ chatId, callIds, err: message }, 'tool run summary failed');
        stamp({ error: message });
      },
    );
  }

  /**
   * Return the most-recent `limit` chat-scoped wire events for a chat plus a
   * `truncated` flag indicating older events exist beyond the returned slice.
   * Backs patch_peek (spec/06). `limit` is clamped to [1, 200].
   */
  getRecentEvents(chatId: string, limit: number): { events: WireEvent[]; truncated: boolean } {
    const clamped = Math.max(1, Math.min(Daemon.RECENT_EVENTS_CAP, Math.floor(limit)));
    const ring = this.recentEvents.get(chatId) ?? [];
    const events = ring.slice(Math.max(0, ring.length - clamped));
    // truncated when the returned slice is smaller than the ring (more recent
    // events held back by `limit`), OR the ring has dropped older events past
    // the cap, OR the ring is COLD: it only ever holds what this process has
    // emitted, so a chat hydrated from disk and not touched since has an empty
    // ring and a full transcript. Reporting `truncated: false` there said "this
    // chat is empty" about a chat with 23 turns, and an agent acted on it.
    // `nextSeq` is the number of events the chat has ever emitted, so it is the
    // honest measure of whether anything is being held back.
    const everEmitted = this.chatState.get(chatId)?.nextSeq ?? 0;
    const truncated =
      ring.length > events.length ||
      this.recentEventsDropped.has(chatId) ||
      everEmitted > events.length;
    return { events, truncated };
  }

  /**
   * Diagnostics readout of the most-recent query's resume argument for a chat
   * (spec/02 ## Host restart behaviour). Returns `undefined` if no query has
   * run for the chat this process. `resumeSessionId` mirrors `options.resume`
   * handed to the SDK — `null`-equivalent (`undefined`) for a fresh first
   * turn, the persisted `meta.claudeSessionId` for a resumed turn. Surfaced on
   * the live control UDS so the restart-resume guarantee (D3-6) is observable
   * against the running app.
   */
  lastQueryDiagnostics(
    chatId: string,
  ): { resumeSessionId: string | undefined; at: number } | undefined {
    return this.lastQuery.get(chatId);
  }

  /**
   * The mode the chat's NEXT turn will use: chat override → host default →
   * `auto` (spec/02 § Permission mode). Resolved here, on the
   * machine that owns both scopes, and carried on `chat.state` so no surface
   * has to re-derive it from a host default it does not have.
   */
  /**
   * Whether this machine currently holds a usable backend credential — a LIVE
   * re-read, not the boot-time snapshot, so a `claude login` since boot counts.
   * Callers use it to refuse a dispatch before creating a chat that could never
   * run a turn: spawning first made the server settle the run as `ok` for work
   * that never happened (spec/08 § Logs calls that `dispatch-error`). Checks
   * the host's own resolution — first stored key with credit
   * the host's active account.
   */
  /**
   * The account this chat's current — or most recent — turn resolved onto.
   *
   * For attributing what a turn SPENDS — usage reports, and the failure that
   * says a key is out of credit. Deliberately not part of chat state: it is a
   * property of the turn, and the next turn resolves the host's keys again
   * (spec/10 § Backend credentials — multiple accounts).
   */
  accountRunningOn(chatId: string): string | undefined {
    return this.runningOnAccount.get(chatId);
  }

  async backendCredential(model?: string): Promise<OAuthCheckResult> {
    return await this.resolveOAuth(model ?? this.opts.defaultModel?.());
  }

  /**
   * The mode this chat's next turn will run under (spec/02 § Permission mode).
   *
   * It is simply what the chat is carrying — there is no resolution chain to
   * walk. Every chat is stamped at creation (`spawnChat`) and every chat
   * restored from disk is stamped on the way in (`stampMissingPermissionMode`),
   * so a chat in state with no mode is a bug rather than a case to paper over
   * with the host default.
   */
  chatPermissionMode(chatId: string): SdkPermissionMode {
    const state = this.chatState.get(chatId);
    if (!state) throw new ChatNotFoundError(chatId);
    if (state.permissionMode === undefined) {
      throw new Error(`chat ${chatId} carries no permission mode`);
    }
    return state.permissionMode;
  }

  /** This host's id, for callers that emit frames on the host's behalf. */
  get daemonId(): string {
    return this.opts.daemonId;
  }

  /**
   * Set the host-wide default (spec/02 § Permission mode). It seeds the chats
   * created AFTER it and reaches no existing chat: every chat already carries
   * its own mode, and quietly re-pointing them here is the behaviour the stamp
   * exists to prevent.
   */
  setPermissionModeDefault(mode: SdkPermissionMode): void {
    this.opts.permissionModeDefault = mode;
  }

  /** The host-wide default currently in force. */
  permissionModeDefault(): SdkPermissionMode {
    return this.opts.permissionModeDefault ?? 'auto';
  }

  /**
   * Update the live chat-name-regeneration interval (from `host.settings`
   * → `chatNameInterval`). Takes effect on the next user message without
   * restarting any in-flight turn.
   */
  setChatNameInterval(interval: number): void {
    this.opts.chatNameInterval = interval;
  }

  /** Settings → Goals: how many refusals in a row end a goal's pushing. */
  setGoalRefusalLimit(limit: number): void {
    this.goalRefusalLimit = limit;
  }

  /**
   * Update the Manager's live bounded-context window (from `host.settings`
   * → `managerContextWindow`). Takes effect on the Manager's next turn.
   */
  setManagerContextWindow(window: number): void {
    this.opts.managerContextWindow = window;
  }

  /**
   * Change this chat's permission mode (spec/02 § Permission mode). There is no
   * clearing it: a chat always has a mode, so the only thing this can do is
   * replace one with another.
   *
   * Written through to the chat's meta, so it outlives this host.
   */
  setChatPermissionMode(chatId: string, mode: SdkPermissionMode): void {
    const s = this.chatState.get(chatId);
    if (!s) throw new ChatNotFoundError(chatId);
    const previous = s.permissionMode;
    s.permissionMode = mode;
    this.opts.metaStore.update(chatId, (m) => ({ ...m, permissionMode: mode }));
    this.emitState(chatId);
    // Re-picking the mode a chat is already on changes nothing, so it marks
    // nothing — the line records where the conversation changed, not where the
    // menu was opened.
    if (previous !== mode) this.markPermissionModeChange(chatId, mode);
  }

  /**
   * Claude Code itself landed this turn on `plan` — the mode it was given
   * (e.g. `bypassPermissions`) is unavailable to this host's `claude` build or
   * this chat's model, and Claude Code substituted `plan` rather than
   * `default` (spec/02 § Permission mode's plan-mode exception). Unlike every
   * OTHER substitution target, `plan` is not a dead end — it still means
   * normal per-tool-call approval, the same thing a person choosing `plan`
   * gets — so this stamps the chat onto `plan` exactly as `setChatPermissionMode`
   * does for a person's own choice, marking the record `automatic` so the
   * transcript says Claude Code made the change, not the person the chat
   * belongs to.
   */
  private recordAutomaticPermissionModeChange(chatId: string, mode: SdkPermissionMode): void {
    const s = this.chatState.get(chatId);
    if (!s || s.permissionMode === mode) return;
    s.permissionMode = mode;
    this.opts.metaStore.update(chatId, (m) => ({ ...m, permissionMode: mode }));
    this.emitState(chatId);
    this.markPermissionModeChange(chatId, mode, { automatic: true });
  }

  /**
   * Record, in the transcript, that the chat's permission mode changed here
   * (spec/02 § Permission mode). It is a `system` `chat.message` carrying the
   * new mode, the same arrangement a compaction boundary uses — so a surface
   * that does not know the field still renders the one-line record.
   *
   * The marker is also written to the chat's meta, because Claude Code's own
   * transcript has no idea this happened: nothing else would replay it once
   * this host process is gone. `automatic` marks the plan-mode exception —
   * Claude Code made the change, not the mode control.
   */
  private markPermissionModeChange(
    chatId: string,
    mode: SdkPermissionMode,
    opts: { automatic?: boolean } = {},
  ): void {
    const automatic = opts.automatic === true;
    this.logRecord(chatId, {
      k: 'permission.mode',
      mode,
      ...(automatic ? { automatic: true as const } : {}),
    });
    const seq = this.bumpSeq(chatId);
    const at = this.opts.now();
    this.opts.metaStore.update(chatId, (m) => ({
      ...m,
      permissionModeMarks: [
        ...(m.permissionModeMarks ?? []),
        { seq, mode, at, ...(automatic ? { automatic: true as const } : {}) },
      ],
      updatedAt: at,
    }));
    this.emit(this.permissionModeMarkEvent(chatId, mode, seq, automatic));
  }

  /**
   * Record that the user message at `seq` is a RE-SEND of the turn at
   * `retryOfSeq` (spec/12 § A turn is owed until it settles).
   *
   * Claude Code's transcript persists every re-sent prompt as an ordinary user
   * turn and has no idea it is a repeat of an earlier one, so without this a
   * reload re-expands the fold into one bubble per attempt — the exact
   * duplication the fold exists to remove, reappearing on refresh. `replayChat`
   * splices these back on by seq, the same way `permissionModeMarks` are.
   */
  private recordRetryMark(chatId: string, seq: number, retryOfSeq: number): void {
    if (!this.opts.metaStore.read(chatId)) return;
    this.opts.metaStore.update(chatId, (m) => ({
      ...m,
      retryMarks: [...(m.retryMarks ?? []), { seq, retryOfSeq }],
      updatedAt: this.opts.now(),
    }));
  }

  /**
   * Say in the chat that this turn runs on a different account because the
   * last one ran out (spec/10 § Backend credentials). Emitted as a system line,
   * so it is logged and replayed like every other message.
   */
  private sayAccountSwitch(
    chatId: string,
    model: string | undefined,
    fromId: string,
    toId: string,
  ): void {
    const reason = this.opts.accountSpent?.(model, fromId);
    if (!reason?.spent) return;
    const from = this.opts.accountLabel?.(model, fromId) ?? fromId;
    const to = this.opts.accountLabel?.(model, toId) ?? toId;
    this.emit({
      type: 'chat.message',
      chatId,
      role: 'system',
      content: `Switched from ${from} to ${to} — ${from} is out of credit`,
      seq: this.bumpSeq(chatId),
      accountSwitch: { from, to, ...(reason.until !== undefined ? { until: reason.until } : {}) },
    });
    this.emitState(chatId);
  }

  /** The wire frame for one recorded mode change; one owner for live and replay. */
  private permissionModeMarkEvent(
    chatId: string,
    mode: SdkPermissionMode,
    seq: number,
    automatic = false,
  ): ChatMessageEvent {
    return {
      type: 'chat.message',
      chatId,
      role: 'system',
      content: permissionModeChangeLine(mode, automatic),
      seq,
      permissionModeChange: mode,
      ...(automatic ? { permissionModeChangeAutomatic: true as const } : {}),
    };
  }

  /**
   * Change the model this chat runs on (spec/04 § Model). Takes effect on the
   * chat's NEXT turn: `runQuery` reads `state.model` as it starts, so a turn
   * already in flight keeps the model it began on and is not interrupted.
   *
   * Validated against the host's live catalogue when one is wired, and REFUSED
   * — leaving the chat on the model it was already running — when the id is not
   * offered or the catalogue cannot be read. Written through to the chat's meta
   * so the change outlives this host, then announced with a `chat.state` so
   * every surface holding the chat converges on it.
   *
   * The host's last-used model is deliberately NOT updated: that value seeds
   * what NEW chats start on, and a change scoped to one chat must not silently
   * repoint every future spawn (spec/04 § Model).
   */
  async setChatModel(
    chatId: string,
    model: string,
    opts?: {
      /** spec/04 § History — "switch and compact": the cheap path for a huge
       * chat. Ignored (falls through to the default full native handoff) when
       * this isn't actually a cross-provider switch, or the outgoing harness
       * has no digest generator configured for it. */
      compact?: boolean;
    },
  ): Promise<void> {
    const s = this.chatState.get(chatId);
    if (!s) throw new ChatNotFoundError(chatId);
    if (this.opts.knownModelIds) {
      let known: ReadonlySet<string>;
      try {
        known = await this.opts.knownModelIds();
      } catch (err) {
        // Can't check ⇒ can't honour. Reported as "this machine has no
        // catalogue" because from the caller's side that is exactly the
        // situation: there is no list to pick from right now.
        throw new NoModelCatalogueError(this.opts.daemonId, (err as Error).message);
      }
      if (!known.has(model)) throw new UnknownModelError(this.opts.daemonId, model);
      // Re-read: awaiting the catalogue yields, so the chat could have been
      // deleted underneath us. Mutating a state object that is no longer in the
      // registry would write the change nowhere and report success.
      if (!this.chatState.get(chatId)) throw new ChatNotFoundError(chatId);
    }
    // spec/04 § History — crossing providers no longer needs a new chat: the
    // NEXT turn reconstructs the chat's own track as a native session on the
    // new harness (chatRunner's `isProviderSwitch` in the turn-start code,
    // `claudeSessionStore.ts` / `codexBackend.ts`'s `codexReseed`), seamlessly,
    // rather than refusing here.
    if (opts?.compact) {
      const targetHarness: HarnessId = isCodexModel(model) ? 'codex' : 'claude';
      const fromHarness: HarnessId | undefined = s.claudeSessionId
        ? s.claudeSessionId.startsWith('codex-')
          ? 'codex'
          : 'claude'
        : undefined;
      if (fromHarness !== undefined && fromHarness !== targetHarness && s.claudeSessionId) {
        this.pendingCompactSwitch.set(chatId, {
          outgoingModel: s.model ?? null,
          outgoingSessionId: s.claudeSessionId,
        });
      }
    } else {
      // An explicit plain switch after a compact one was requested but never
      // ran (model changed again before a turn consumed it) — the stale
      // intent must not silently fire on a later, differently-requested turn.
      this.pendingCompactSwitch.delete(chatId);
    }
    s.model = model;
    this.opts.metaStore.update(chatId, (m) => ({ ...m, model }));
    this.emitState(chatId);
  }

  /**
   * Preview what switching this chat to `targetModel` would cost, WITHOUT
   * doing it (spec/04 § History — show the cost in the switch confirmation:
   * the approximate tokens the target must re-read uncached — the full track
   * from scratch, or just the delta on a cache-preserving resume — plus
   * whether the relevant cache is probably cold anyway from idle time).
   * `null` when this isn't actually a cross-provider switch (same harness as
   * now, or no session yet to leave) — nothing to confirm.
   */
  async estimateProviderSwitch(
    chatId: string,
    targetModel: string,
  ): Promise<ProviderSwitchEstimate | null> {
    const state = this.chatState.get(chatId);
    if (!state) throw new ChatNotFoundError(chatId);
    const targetHarness: HarnessId = isCodexModel(targetModel) ? 'codex' : 'claude';
    const fromHarness: HarnessId | undefined = state.claudeSessionId
      ? state.claudeSessionId.startsWith('codex-')
        ? 'codex'
        : 'claude'
      : undefined;
    if (fromHarness === undefined || fromHarness === targetHarness) return null;
    const plan = await this.planHarnessReconstruction(chatId, targetHarness, state.folder);
    return {
      fromHarness,
      toHarness: targetHarness,
      resumesExistingSession: plan.resumeExistingSessionId !== undefined,
      approxTokens: estimateTokens(plan.track),
      // "The last turn" — this chat's own, whichever harness it ran on: a
      // chat idle long enough that ITS OWN traffic has gone quiet has almost
      // certainly gone cold on the provider side too, resumed session or not.
      cacheProbablyCold:
        plan.lastActivityAt === undefined
          ? false
          : this.opts.now() - plan.lastActivityAt > PROMPT_CACHE_TTL_MS,
    };
  }

  /**
   * How many of this host's chats are running on something other than the mode
   * a chat created right now would be stamped with (`daemon.host`). Every chat
   * carries a mode, so counting chats that HAVE one would only ever report the
   * chat count.
   */
  permissionOverrideCount(): number {
    const dflt = this.permissionModeDefault();
    let n = 0;
    for (const c of this.chatState.list()) {
      if (c.permissionMode !== undefined && c.permissionMode !== dflt) n++;
    }
    return n;
  }

  private emitState(chatId: string): void {
    const ev = this.buildStateEvent(chatId);
    /* v8 ignore next -- defensive only: every caller fetches/mutates the same chat's state synchronously (no `await`) immediately before calling emitState, so chatState can never go missing out from under it via the public API. */
    if (!ev) return;
    this.emit(ev);
  }

  /**
   * Build the current `chat.state` frame without emitting it — the pure half
   * of `emitState`, reused by `replayFromLog` so a reconnecting surface always
   * gets an authoritative activity even when it missed the live running ->
   * idle edge while disconnected (patch/todo.md — "Patch showing stop after
   * message has returned").
   */
  private buildStateEvent(chatId: string): ChatStateEvent | undefined {
    const s = this.chatState.get(chatId);
    if (!s) return undefined;
    const rateLimitResumingAt = this.rateLimitResumingAt.get(chatId) ?? null;
    const resumeKind = rateLimitResumingAt !== null ? this.resumeKindMap.get(chatId) : undefined;
    const runningOn = this.runningOnAccount.get(chatId);
    const runningLabel =
      runningOn !== undefined ? this.opts.accountLabel?.(s.model, runningOn) : undefined;
    const lastSeq = this.chatLog.recordedHighWater(chatId);
    const ev: ChatStateEvent = {
      type: 'chat.state',
      ...(runningOn !== undefined && runningLabel !== undefined
        ? { account: { id: runningOn, label: runningLabel } }
        : {}),
      chatId,
      daemonId: this.opts.daemonId,
      // How far this host's own log of the chat reaches; the server compares it
      // with what it has committed (spec/01 § Message log).
      ...(lastSeq >= 0 ? { lastSeq } : {}),
      // spec/04 § Branching — "Status in the sidebar reflects the chat as a
      // whole": the active branch's own activity, raised by any OTHER branch
      // currently running or awaiting permission (`aggregateActivity`).
      activity: this.aggregateActivity(chatId),
      // spec/09 § Whose turn it was — who started the turn this state belongs
      // to. Carried on every emit, not just the settling one, so a surface (or
      // the server) that joins mid-turn already knows what the idle frame will
      // mean when it arrives.
      turnOrigin: s.turnOrigin,
      // spec/09 § A turn the user stopped — whether the turn this state belongs
      // to was killed by the user instead of finishing. Carried on every emit
      // for the same reason `turnOrigin` is: the frame the server acts on is
      // the running → idle edge, and it has to speak for the turn that ended.
      turnStopped: s.turnStopped,
      // spec/09 § A turn that failed — whether this errored turn is final. Read
      // by the server on the edge into `errored` to decide whether to notify.
      turnRetrying: s.turnRetrying,
      permissionMode: this.chatPermissionMode(chatId),
      lastUpdated: s.lastUpdated,
      // spec/14 § Sidebar ordering — drives sidebar ordering instead of
      // `lastUpdated`. Carried on every emit for the same reason `lastUpdated`
      // is: a surface that joins mid-chat converges on the truth without
      // asking.
      lastUserActivity: s.lastUserActivity,
      pinned: s.pinned,
      pinnedAt: s.pinnedAt,
      disabled: s.disabled,
      status: s.status,
      snoozedUntil: s.snoozedUntil,
      // spec/04 § Hidden — only meaningful while active; an archived chat keeps
      // the flag as where it returns to, but is drawn as archived.
      hidden: s.hidden,
      name: s.name,
      preview: s.preview,
      goal: s.goal,
      goalProgress: s.goalProgress,
      lastGoal: s.lastGoal,
      reminder: s.reminder,
      statusSummary: s.statusSummary,
      statusKind: s.statusKind,
      statusDeclared: s.declaredStatus !== null,
      // spec/09 § What the message says — the closing text of the turn this
      // state belongs to. Carried on EVERY emit like `turnOrigin`/`turnStopped`
      // rather than only the settling one, so the frame the server acts on (the
      // running → idle edge) speaks for the turn that ended without the reader
      // having to stitch two frames together.
      turnSummary: s.turnSummary,
      todos: s.todos,
      // spec/02 § Self-wake ("Visible, never invisible"): a scheduled future turn
      // is never hidden state. Read straight from wake.json (the source of
      // truth, so it's right after a restart or a catch-up fire) rather than
      // mirroring it onto chat_state, where it could drift.
      pendingWake: toPendingWake(this.wake.peek(chatId)),
      folder: s.folder,
      lastError: s.lastError,
      rateLimitResumingAt,
      ...(resumeKind !== undefined ? { resumeKind } : {}),
      // Not gated on a resume time: a limit nobody parked is still a limit, and
      // the block is the whole structured account of it (spec/12).
      limitBlock: this.limitBlocks.get(chatId) ?? null,
      // spec/02 § Background task completions — how many of this chat's
      // patch_watch tasks are still running after the turn that launched them
      // ended. Read straight off the persisted watch records (watch.ts), not
      // folded from the transcript: a watch's `running` status IS the count.
      // Sent on EVERY state emit, `0` included: `0` is the positive claim that
      // nothing is running, and a surface that never hears it is talking to a
      // host that does not track them and must show no background state at
      // all.
      backgroundTasks: this.watch.count(chatId),
      // spec/14 § Composer — context ring. `null` is "not measured", never zero.
      context: s.context ?? null,
      // spec/04 § Model — the model the chat's NEXT turn will run on, carried on
      // EVERY state emit rather than only the one that follows a change, so a
      // surface that opened the chat late (or reconnected) converges on it too.
      // It is also the acknowledgement of a `chat.model_request`. Omitted when
      // the chat has no model of its own; the surface must not read that as a
      // model, only as "unchanged, and don't guess".
      ...(s.model !== undefined ? { model: s.model } : {}),
    };
    return ev;
  }
}

/**
 * The longest closing text a `chat.state` will carry (spec/09 § What the message
 * says). Sized for where it ends up rather than for the wire: an Android push
 * and a desktop toast both cut a long body themselves, and they cut it blind —
 * mid-word, with no ellipsis — so the host does it here where the text is
 * still whole and the cut can be made somewhere sensible.
 */
const TURN_SUMMARY_MAX = 240;

/** The most recent assistant message in the chat's rolling window, if any. */
function lastAssistantMessage(state: ChatState): ChatMessageSnapshot | undefined {
  for (let i = state.lastMessages.length - 1; i >= 0; i--) {
    const msg = state.lastMessages[i];
    if (msg?.role === 'assistant') return msg;
  }
  return undefined;
}

/**
 * An assistant's final message reduced to one line a notification can carry, or
 * `null` when there was nothing to reduce.
 *
 * Whitespace is collapsed, not just trimmed: the agent's last word is usually
 * markdown — headings, bullet lists, blank lines — and a push body and a toast
 * both render it as a single run of text, where the raw newlines read as gaps
 * rather than structure.
 */
function toTurnSummary(raw: string): string | null {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (text === '') return null;
  if (text.length <= TURN_SUMMARY_MAX) return text;
  // Leave room for the ellipsis, then back up to the last word boundary — but
  // only if one is near enough the end to be a cut rather than a truncation of
  // its own. A single unbroken 300-character token has no boundary worth
  // finding, so it is cut where it is.
  const cut = text.slice(0, TURN_SUMMARY_MAX - 1);
  const lastSpace = cut.lastIndexOf(' ');
  const body = lastSpace >= TURN_SUMMARY_MAX / 2 ? cut.slice(0, lastSpace) : cut;
  return `${body.replace(/[\s,;:.!?—–-]+$/, '')}…`;
}

/**
 * Project a persisted `WakeRecord` down to the wire's `PendingWake` — the
 * surface only needs what the bar renders (when it fires, what it will say, and
 * any validity cutoff), not the host's bookkeeping (`chatId`, `createdAt`).
 */
function toPendingWake(rec: WakeRecord | null): PendingWake | null {
  if (!rec) return null;
  return {
    message: rec.message,
    fireAt: rec.fireAt,
    ...(rec.notAfter !== undefined ? { notAfter: rec.notAfter } : {}),
    ...(rec.every !== undefined ? { every: rec.every } : {}),
    // A loop absorbing a tick because the chat is busy — `fireAt` is stale
    // until `onTurnEnd` arms the next one, so surfaces read this instead of
    // a countdown to a time that isn't real yet.
    ...(rec.waiting === true ? { waiting: true } : {}),
  };
}

/**
 * Group 20 fix #3: compute a unified-diff-ish text for the surface to
 * render alongside the raw permission card. Conservative — we just join
 * old + new strings with `--- a/<path>` / `+++ b/<path>` so surfaces
 * that don't have Monaco can still show *something* meaningful. NO
 * FALLBACK: if the tool args don't match the expected shape this
 * returns null and the surface falls back to args-summary rendering.
 */
function computeEditInfo(
  tool: string,
  args: Record<string, unknown>,
): { filePath: string; proposedDiff: string } | null {
  if (tool === 'Edit' && typeof args['file_path'] === 'string') {
    const fp = args['file_path'] as string;
    const oldStr = typeof args['old_string'] === 'string' ? (args['old_string'] as string) : '';
    const newStr = typeof args['new_string'] === 'string' ? (args['new_string'] as string) : '';
    return {
      filePath: fp,
      proposedDiff: unifiedDiff(fp, oldStr, newStr),
    };
  }
  if (tool === 'Write' && typeof args['file_path'] === 'string') {
    const fp = args['file_path'] as string;
    const content = typeof args['content'] === 'string' ? (args['content'] as string) : '';
    return {
      filePath: fp,
      proposedDiff: unifiedDiff(fp, '', content),
    };
  }
  if (tool === 'NotebookEdit' && typeof args['notebook_path'] === 'string') {
    const fp = args['notebook_path'] as string;
    const oldStr = typeof args['old_source'] === 'string' ? (args['old_source'] as string) : '';
    const newStr = typeof args['new_source'] === 'string' ? (args['new_source'] as string) : '';
    return {
      filePath: fp,
      proposedDiff: unifiedDiff(fp, oldStr, newStr),
    };
  }
  return null;
}

/**
 * spec/14 § File browser — live updates: the absolute path a file-editing
 * tool call is ABOUT, read straight off its args — no diff, no reversal, just
 * "which file". Shares `computeEditInfo`'s per-tool arg shape (Edit/Write's
 * `file_path`, NotebookEdit's `notebook_path`) but skips building a
 * `unifiedDiff` this caller has no use for. Returns null for any other tool,
 * or when the expected arg is missing/not a string.
 */
function editToolFilePath(tool: string, args: Record<string, unknown>): string | null {
  if (tool === 'Edit' || tool === 'Write') {
    return typeof args['file_path'] === 'string' ? (args['file_path'] as string) : null;
  }
  if (tool === 'NotebookEdit') {
    return typeof args['notebook_path'] === 'string' ? (args['notebook_path'] as string) : null;
  }
  return null;
}

function unifiedDiff(filePath: string, before: string, after: string): string {
  const beforeLines = before === '' ? [] : before.split('\n');
  const afterLines = after === '' ? [] : after.split('\n');
  let out = `--- a/${filePath}\n+++ b/${filePath}\n@@ -1,${beforeLines.length} +1,${afterLines.length} @@\n`;
  for (const l of beforeLines) out += `-${l}\n`;
  for (const l of afterLines) out += `+${l}\n`;
  return out;
}

function resolveAbsForChat(root: string, fp: string): string {
  /* v8 ignore next -- defensive only: the sole caller passes `state?.folder ?? ''`, and that `state` lookup is itself unreachable-as-undefined (see the ignore comment at its call site) — `root` is always a real folder path through the public API. */
  if (root.length === 0) return fp;
  if (fp.startsWith('/')) return fp;
  // Lazy resolve via path.join semantics — node:path is not statically
  // imported here, so we do a simple join. NO FALLBACK: if the host
  // cwd doesn't match the chat folder, the dirty-marker comparison
  // simply misses (acceptable graceful degrade for a non-critical UX).
  return root.endsWith('/') ? `${root}${fp}` : `${root}/${fp}`;
}

/**
 * Raised when a surface answers `approve_with_edits` with a payload the named
 * tool cannot take. NO FALLBACK: the caller denies the tool call and reports
 * this, rather than approving a call whose answer was silently dropped —
 * which for `AskUserQuestion` means the agent proceeding on an answer the user
 * never gave (spec/02 § Questions are not approvals).
 */
export class PermissionEditInvalidError extends Error {}

/**
 * The `updatedInput` an `approve_with_edits` produces for `tool`
 * (spec/03 § Answering with content). `editedNewString` is ONE string, and
 * where it lands is per-tool: the three file-edit tools take it as the new file
 * content, and `AskUserQuestion` takes it as the JSON-encoded answers the user
 * picked. Anything else has no argument for it to land in, which is an error,
 * not a pass-through.
 */
function updatedInputForPermissionEdit(
  tool: string,
  args: Record<string, unknown>,
  edited: string,
): Record<string, unknown> {
  if (tool === 'Edit') return { ...args, new_string: edited };
  if (tool === 'Write') return { ...args, content: edited };
  if (tool === 'NotebookEdit') return { ...args, new_source: edited };
  if (tool === 'AskUserQuestion') return { ...args, answers: parseQuestionAnswers(edited) };
  throw new PermissionEditInvalidError(
    `approve_with_edits: tool '${tool}' has no editable argument to substitute into`,
  );
}

/**
 * The surface's JSON answers for an `AskUserQuestion`, validated to the shape
 * the tool's own `answers` argument declares: `{[questionText]: string}`, a
 * multi-select's labels already joined into that one string. Throws on anything
 * else — an unparseable or wrong-shaped answer must be visible, because the
 * failure it replaces (approving with `answers` absent) looks to the agent like
 * a question that was asked and answered with nothing.
 */
function parseQuestionAnswers(edited: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(edited);
  } catch (err) {
    throw new PermissionEditInvalidError(
      `AskUserQuestion answers are not valid JSON: ${(err as Error).message}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new PermissionEditInvalidError(
      'AskUserQuestion answers must be a JSON object of question text -> answer',
    );
  }
  const answers: Record<string, string> = {};
  for (const [question, answer] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof answer !== 'string' || answer.length === 0) {
      throw new PermissionEditInvalidError(
        `AskUserQuestion answer for ${JSON.stringify(question)} is not a non-empty string`,
      );
    }
    answers[question] = answer;
  }
  if (Object.keys(answers).length === 0) {
    throw new PermissionEditInvalidError('AskUserQuestion answers object is empty');
  }
  return answers;
}

/**
 * Best-effort detection of "the resumed Claude Code session no longer exists
 * or has expired". The SDK doesn't ship a typed error class for this — we
 * pattern-match on the message text the SDK / underlying transport surfaces.
 * Spec/04 line 46: surface a `claude_session_invalid` code so the surface
 * can offer a fresh-start prompt. NO FALLBACK: if it's not session-invalid,
 * it's classified as a generic `sdk_error`.
 */
function isClaudeSessionInvalidError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const name = err.name;
  if (name === 'SessionNotFoundError' || name === 'SessionExpiredError') return true;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('session not found') ||
    msg.includes('session expired') ||
    msg.includes('invalid session') ||
    msg.includes('unknown session id') ||
    msg.includes('no such session') ||
    // The real Claude Agent SDK rejects a bad `--resume` argument with these
    // phrasings (e.g. a stale non-UUID id, or one no longer on disk). Treat it
    // as a stale session: clear claudeSessionId so the next turn starts fresh.
    msg.includes('--resume requires a valid session') ||
    (msg.includes('is not a uuid') && msg.includes('session title')) ||
    msg.includes('does not match any session') ||
    // The real Claude Agent SDK / CLI surfaces a resume to a session whose
    // transcript no longer exists on disk as "No conversation found with
    // session ID: <uuid>". This is a lost session, not a generic SDK fault —
    // clear claudeSessionId so the next input starts a fresh session rather
    // than re-attempting the dead resume forever (spec/04 line 46, NO
    // FALLBACK to a silently-contextless run, but recoverable on next turn).
    msg.includes('no conversation found')
  );
}

/**
 * Detection of "Anthropic refused the credential we handed the SDK". The
 * pre-query gate only knows whether a token is present and locally unexpired —
 * a revoked one, or one whose stored expiry is a lie, passes the gate and is
 * then rejected on every single turn. Pattern-matched on the message text like
 * the session check above, because the SDK has no typed error for it; the real
 * phrasing is `Failed to authenticate. API Error: 401
 * {"error":{"type":"authentication_error",…}}`.
 *
 * A bare 401 is NOT enough — an HTTP 401 the agent hit inside its own tool call
 * says nothing about this host's Claude credential — so the status only counts
 * alongside an auth-specific word.
 */
function isClaudeCredentialRejectedMessage(message: string): boolean {
  const msg = message.toLowerCase();
  if (
    msg.includes('authentication_error') ||
    msg.includes('failed to authenticate') ||
    msg.includes('oauth access token is invalid') ||
    msg.includes('invalid bearer token')
  ) {
    return true;
  }
  return msg.includes('api error: 401') && (msg.includes('oauth') || msg.includes('bearer token'));
}

/**
 * G2-d4: clean a raw user prompt into a one-line preview snippet for the
 * sidebar. Strips dev control-token markers ([[edit]], [[permission]], …),
 * collapses whitespace, and truncates. Returns null if nothing readable
 * remains (e.g. a bare `[[permission]]` marker), so we never overwrite a
 * meaningful label with an empty string.
 */
export function makePreviewSnippet(prompt: string): string | null {
  // Strip the appended `[Attachments]` block first so a pasted image never
  // titles/previews the chat with a raw file path. When the turn was
  // attachment-ONLY (no typed text), label it from the attachment instead of
  // returning null (which would leave the row showing only its folder).
  const attIdx = prompt.indexOf(`${ATTACHMENT_BLOCK_HEADER}\n`);
  const body = attIdx >= 0 ? prompt.slice(0, attIdx) : prompt;
  const cleaned = body
    .replace(/\[\[[^\]]*\]\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned === '') {
    if (attIdx < 0) return null;
    // Tolerate a `)` in the display name (e.g. `photo (1).jpg`) so an
    // image-only turn is still labelled from its filename rather than falling
    // through — same fragility fixed in `parseAttachmentBlock`.
    const m = /- (image|file): .+ \((.*)\)/.exec(prompt.slice(attIdx));
    if (!m) return null;
    /* v8 ignore next -- `m[2]` is the `(.*)` group; a successful match always defines it (possibly as ''), so the `?? ''` fallback is unreachable defensive code. */
    const name = (m[2] ?? '').trim();
    if (m[1] === 'image') return name && name.toLowerCase() !== 'image' ? name : 'Image';
    return name !== '' ? name : 'Attachment';
  }
  const MAX = 120;
  return cleaned.length > MAX ? `${cleaned.slice(0, MAX - 1)}…` : cleaned;
}
