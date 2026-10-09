// Action dispatcher.
//
// Given a fired job + filter-passed payload:
//   1. Mustache-substitute the action's prompt template (if any).
//   2. Build a `chat.spawn_request` (action.type === 'spawn') or
//      `chat.input` (action.type === 'message') wire event.
//   3. If the job is at its concurrency limit → queue the fire
//      (spec/08 ## Concurrency) and stop here.
//   4. If the ACTION'S OWN HOST is online → send via daemon-link.
//      If offline → buffer to `<dataDir>/pending/<jobId>-<ulid>.jsonl`.
//   5. On host online transition → flush per-job in order, max 100 per
//      job (drop-oldest with WARN).
//   6. Write the run entry from the OUTCOME THAT HOST REPORTS BACK — never at
//      dispatch time (spec/08 ## Execution model step 6).
//
// TWO QUEUES, deliberately opposite (spec/08 ## Concurrency, spec/12):
//   - `pending/` is per HOST: the machine can't be reached. Full → drop the
//     OLDEST, because the stalest undelivered work is the least worth keeping.
//   - `queued/` is per JOB: the job asked to run its fires N at a time.
//     Unbounded — a fire waits, it is never refused — because here the oldest
//     work is exactly what the FIFO promise is about. Depth is a signal to
//     look at, not a limit to enforce.
// The gate sits on SENDING, not on `dispatch()`, so a reconnect flushing a
// host's backlog is limited too — otherwise the limit would hold all day and
// then dump thirty fires the moment the host came back.
//
// Run outcomes (spec/08 ## Execution model step 6 + ## Logs):
//   "The server writes the run to runs.jsonl (success or failure), filling the
//    chatId and the outcome from the events that host emits back through it —
//    `chat.spawned` for a fire that landed, the host's own error
//    (`folder_not_found` and the like) for one that did not."
//   "`dispatch-error` covers both ends of the hand-off — the server could not
//    reach the host, or the host took it and refused it (a folder it does not
//    have, a backend with no credential) — and the entry names the host and
//    carries its error text, since a job that silently does nothing on one
//    machine is the failure this log exists to catch."
// So a fire is NOT `ok` until the host says so, and a fire that never landed
// carries no chatId (a dead "open chat" link is exactly the silent failure the
// log exists to catch). A host that answers nothing at all inside the ack
// window is a dispatch-error naming it — never a silent success.
//
// Wire-level details:
//   - spawn → `chat.spawn_request { folder, prompt?, chatId, localId }`.
//     We allocate a server-side ULID for chatId, mirroring what
//     POST /api/chats does. localId is set to a per-fire ULID so the
//     host's spawn-dedupe accepts it.
//   - message → `chat.input { chatId, message, localId }`.
//
// NO FALLBACKS:
//   - Buffer overflow → drop OLDEST, log WARN, continue (the spec
//     explicitly chooses this — see spec/12 ## Cron while host offline).
//   - Mustache reference to a missing payload key → empty string (this is
//     mustache's standard behaviour). Logged at debug.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import Mustache from 'mustache';
import { ulid } from 'ulid';
import type { Logger } from 'pino';
import type {
  ChatActivity,
  ChatInputEvent,
  ChatSpawnRequestEvent,
  JobExecRequestEvent,
  WireEvent,
} from '@patch/wire';
import {
  ensureChatId,
  ensureChatKeySlug,
  GATE_DEFAULT_TIMEOUT_MS,
  gateVerdict,
  inRunWindow,
  jobAutonomyPrompt,
  parseScriptChatId,
  SCRIPT_ACTION_DEFAULT_TIMEOUT_MS,
  scriptVerdictLine,
  DEFAULT_JOB_AUTONOMY_PROMPT,
} from '@patch/wire/jobs';
import type { JobGate, JobTrigger } from '@patch/wire/jobs';
import type { DaemonLink } from '../daemon-link.js';
import { digestPayload, type JobLogs, type RunLogEntry } from './logs.js';
import type { Job, JobAction, JobsInterface } from './types.js';

const DEFAULT_PENDING_CAP_PER_JOB = 100;
/**
 * How long a slot may be held by a chat that never reports itself finished
 * before the server takes the slot back. Generous on purpose: these fires are
 * real builds, and this bound exists to stop a dead chat wedging the queue
 * forever, not to police how long a chat may take.
 */
const DEFAULT_SLOT_TIMEOUT_MS = 4 * 60 * 60 * 1000;
/** Chat activities that mean the chat is doing something (spec/04 ## Activity). */
const WORKING_ACTIVITIES = new Set<ChatActivity>(['running', 'awaiting-permission']);
const DISPATCH_SURFACE_ID = 'jobs-dispatcher';
/**
 * How long the server waits for the host's own answer (`chat.spawned` /
 * `chat.input_ack` / `chat.error`) before recording the fire as a
 * dispatch-error naming that host. The host answers before it starts the
 * turn (it acks at accept time and spawns before the first token), so this is
 * an "is anyone home" bound, not a turn-duration one.
 */
const DEFAULT_ACK_TIMEOUT_MS = 20_000;
/** How often fires held by a run window are checked against the clock. */
const HELD_CHECK_MS = 60_000;
/** The host's stand-in chatId for a spawn that failed before a chat existed. */
const PENDING_SPAWN_PLACEHOLDER = 'pending-spawn';

export interface DispatchResult {
  /**
   * `queued` — held behind the job's concurrency limit, will dispatch when a
   * slot frees. The queue is unbounded (spec/08 ## Concurrency): a fire
   * waits, it is never refused.
   *
   * `rejected` — the fire could not be ADDRESSED at all, so there was never a
   * host to send it to. Today that is only a keyed `ensure` whose key rendered
   * empty (spec/08 ## Action). Distinct from `queued`: nothing is retained and
   * nothing will happen later. Carries no event.
   *
   * `gating` — the job has a gate (spec/08 § Gate) and its command is running.
   * The fire has not been addressed yet and may never be: the gate decides. Its
   * own outcome lands on the job's runs when the command answers, which is why
   * this is not `sent` — nothing has been sent.
   */
  status: 'sent' | 'buffered' | 'queued' | 'rejected' | 'gating';
  /**
   * The fire's own id, on every outcome — NOT the chat it lands in. A spawn
   * generates the fireId first and the chatId second, so the two are adjacent
   * and easy to mistake for each other.
   */
  id: string;
  /** Absent on `rejected` — no fire was ever built. */
  event?: ChatSpawnRequestEvent | ChatInputEvent | JobExecRequestEvent;
}

/** The concurrency gate's view of one job, for `GET /api/jobs/:id`. */
export interface JobConcurrencyCounts {
  inFlight: number;
  queued: number;
}

/** One fire this job has in flight, taken from the slot it holds. */
export interface JobQueueInFlightEntry {
  chatId: string;
  localId: string;
  /** When the slot was taken, i.e. when this fire went out. */
  startedAt: number;
  trigger: RunTrigger;
  actionType: JobAction['type'];
  daemonId: string | null;
  folder?: string;
}

/** One fire parked behind the job's limit, in the order it will be released. */
export interface JobQueueWaitingEntry {
  fireId: string;
  queuedAt: number;
  /** The chat this fire will land in once it is released. */
  chatId: string;
  trigger: RunTrigger;
  actionType: JobAction['type'];
  daemonId: string | null;
  folder?: string;
}

/**
 * The gate's queue for one job, for `GET /api/jobs/:id/queue`: what it is
 * running now and what is waiting behind it. `counts` is the same state
 * counted rather than listed.
 */
export interface JobQueueView {
  /**
   * The limit the gate is holding this job to, or null when it has not seen
   * one — a job with no limit never queues anything.
   */
  concurrency: number | null;
  inFlight: JobQueueInFlightEntry[];
  queued: JobQueueWaitingEntry[];
}

/** Which trigger fired this dispatch — carried onto the run entry. */
export type RunTrigger = RunLogEntry['trigger'];

export interface DispatcherOptions {
  dataDir: string;
  daemonLink: DaemonLink;
  logger: Logger;
  /** Run log — the dispatcher owns the run entry for every fire it takes. */
  logs: JobLogs;
  /** Tests inject a deterministic id. */
  idGenerator?: () => string;
  pendingCapPerJob?: number;
  /**
   * Does a chat with this id already exist on the server (per the ChatRegistry
   * mirror)? Used by the `ensure` (upsert) action to decide spawn-vs-message.
   * Defaults to "never exists" — callers without a registry get spawn-only
   * behaviour, which is safe for the first fire.
   */
  chatExists?: (chatId: string) => boolean;
  /**
   * Which host a `message` action's target chat lives on (ChatRegistry mirror).
   * A chat's host decides whether that fire can land right now or has to wait
   * in that host's pending queue — "whichever host happens to be attached" is
   * the exact substitution host addressing exists to prevent. Null when the
   * registry has never seen the chat.
   */
  chatHost?: (chatId: string) => string | null;
  /**
   * Has this host re-announced its chats since the server started
   * (ChatRegistry.hasSynced)? Until it has, `chatExists` answering false for a
   * chat on it means "not known yet", not "missing": the mirror is in memory
   * and starts empty. An `ensure` fire for such a chat waits for the host to
   * report rather than spawning its durable chat a second time. Defaults to
   * "reported" — callers without a registry keep the old behaviour.
   */
  hostReported?: (daemonId: string) => boolean;
  /**
   * The model a job's chat runs on when the job's action names none — the
   * account's `defaultModel` (spec/08 § Action).
   *
   * Sent EXPLICITLY on every fire, for the same reason the permission mode is:
   * omitting the field leaves the model to be resolved on the machine. It used
   * to resolve through the host's `lastUsedModel` — whatever model the last chat
   * on that machine happened to use — which made every unattended job's model a
   * side effect of the last human choice at that keyboard, drifting silently
   * across deploys and purchases.
   *
   * Absent (a test with no settings store) leaves the field off and restores
   * the host-resolved behaviour, so nothing here depends on a server default.
   */
  defaultModel?: () => string | undefined;
  /**
   * The account-wide autonomy prompt (spec/08 § Autonomy prompt) — what a
   * fire is prefaced with unless its job carries its own override. Read per
   * fire, so an edit in Settings reaches the next fire. Absent (a test with
   * no settings store) uses `DEFAULT_JOB_AUTONOMY_PROMPT`, the setting's own
   * default value.
   */
  autonomyPrompt?: () => string;
  /** Ack window override (tests). */
  ackTimeoutMs?: number;
  nowMs?: () => number;
  /** Held-slot timeout override (tests). */
  slotTimeoutMs?: number;
  /**
   * What a chat is currently doing, per the ChatRegistry mirror; null when the
   * mirror has never heard of it. Used ONLY to reconcile slots that outlived a
   * server restart: a chat still working keeps its slot, anything else gives it
   * back. Defaults to "unknown", which frees the slot — a restart must not
   * wedge a job's queue on a chat nobody can vouch for.
   */
  chatActivity?: (chatId: string) => ChatActivity | null;
  /**
   * Whether a chat has done work since `since` (ms epoch). A restored slot is only
   * given back for a chat that is idle if it has: a chat is reported idle before
   * its first turn, and releasing on that would start a second build beside one
   * that is about to begin. Absent means any idle chat counts, as before.
   */
  chatHasWorked?: (chatId: string, since: number) => boolean;
  /**
   * Records a `spawn` fire's chatId against its jobId (spec/08 § Action,
   * spec/14 § Sidebar — the Automations group). Only `spawn` actions are
   * recorded: `ensure`/`message` deliver into a chat the user already owns
   * or is meant to find and follow, not a fire-and-forget background one.
   */
  chatLinks?: {
    record: (chatId: string, jobId: string) => void;
    /** Read back, so a chat that fails later can be attributed to its job. */
    get: (chatId: string) => string | null;
  };
  /**
   * The jobs this dispatcher may retire (spec/08 § One-off jobs). A one-off
   * job expires the first time one of its fires settles `ok`, and that moment
   * is known only here — `writeRun` is where the host's own outcome lands, and
   * a fire is not `ok` until the host says so.
   *
   * A narrow view of the store rather than the store itself, injected like
   * every other collaborator above. Asking the STORE whether the job is still
   * live (rather than carrying `oneOff` on the in-flight fire) is what makes a
   * second settle a genuine no-op: the stamp lives in one place instead of in
   * dispatcher memory that would have to be kept in step with it.
   */
  jobs?: Pick<JobsInterface, 'expireOneOff' | 'get'>;
}

/**
 * The key a `script` fire is tracked under. The dispatcher's waiters, slots and
 * queue are all keyed on a chat id; a script fire has no chat, so it borrows
 * the shape with its own fire id. Prefixed so it can never collide with a real
 * chat id, and never written to a run entry's `chatId` (spec/08 ## Logs).
 */
function execFireKey(fireId: string): string {
  return `exec-${fireId}`;
}

/**
 * The key a GATE's command is tracked under. Separate from `execFireKey` so one
 * `job.exec_result` handler can tell the two apart: a `script` ACTION's result
 * settles the fire, a gate's result only decides whether the fire begins.
 */
function gateFireKey(fireId: string): string {
  return `gate-${fireId}`;
}

/**
 * Why a gate's answer was a fault, in the words most likely to fix it.
 *
 * The bare `exit 1` case gets its OWN message and takes precedence over the
 * host's, which is only ever "command exited 1" — true, and useless. This is
 * the mistake a hand-written gate actually makes, and the reader needs to be
 * told that 1 means hold and that a hold has to say why, not that their command
 * exited 1 (`gateVerdict`).
 */
function gateFaultMessage(exitCode: number | null, daemonError: string | undefined): string {
  if (exitCode === 1) {
    return 'gate exited 1, which means hold, but printed no reason on stdout — a hold must say why, so this is a fault rather than a quiet week';
  }
  if (daemonError !== undefined) return daemonError;
  return `gate exited ${exitCode === null ? 'without a code' : String(exitCode)}`;
}

/**
 * What a PASSING gate hands to the fire it let through (spec/08 § Gate).
 *
 * Two different readers, which is why it is two fields. `gateOutput` is both
 * streams, tailed, and it is what the run row shows a human. `gateStdout` is
 * the half the ACTION may read.
 */
interface GatePassed {
  gateOutput: string;
  gateStdout: string;
}

/**
 * The view a fire's templates render against: the trigger envelope, plus what
 * this fire's gate said if it had one.
 *
 * Every trigger wraps its own payload as `{ payload }` before dispatching
 * (`cron.ts`, `webhooks.ts`, `todoist.ts`), which is why prompts say
 * `{{payload.…}}`. A gate's words arrive alongside it, not inside it — the
 * payload is what the world sent, the gate is what this machine made of it:
 *
 *   {{gate.stdout}}   everything the gate printed, trimmed
 *   {{gate.verdict}}  its last line — the verdict, by the same convention the
 *                     run row's headline already uses (`scriptVerdictLine`)
 *
 * A gate's stdout was, before this, written only on the run row, where nothing
 * but a person ever reads it. But the gate is the half of the job that has
 * already done the looking — which photos landed, which basket crossed its
 * threshold, whether this is the 21:00 audit — so handing it forward is what
 * stops the model paying to discover, expensively, what a shell script
 * established a second ago.
 *
 * STDOUT ONLY, never stderr. The gate contract is that stdout is what the gate
 * MEANT to say and stderr is where its accidents land; a python traceback read
 * as a briefing is how a broken gate becomes a confidently wrong agent.
 *
 * The envelope is always an object, so the type guard is not a fallback for a
 * shape this is legitimately handed — it is there so a hand-built payload
 * cannot throw inside a fire whose gate has already approved it.
 */
function renderView(payload: unknown, gated: GatePassed | undefined): unknown {
  if (gated === undefined) return payload;
  const stdout = gated.gateStdout.trim();
  const envelope = typeof payload === 'object' && payload !== null ? payload : {};
  return { ...envelope, gate: { stdout, verdict: scriptVerdictLine(stdout) ?? '' } };
}

/**
 * A fire whose gate is running. Held only in memory and only for as long as the
 * command takes: a gate asks about NOW, so a server restart mid-gate correctly
 * loses the question rather than answering it late (the next tick asks again).
 */
interface GatingFire {
  job: Job;
  payload: unknown;
  trigger: RunTrigger;
  ts: number;
  payloadDigest: string;
}

interface PendingEntry {
  /** A passing gate's output, carried onto the run row this fire eventually writes. */
  gateOutput?: string;
  jobId: string;
  fireId: string;
  event: ChatSpawnRequestEvent | ChatInputEvent | JobExecRequestEvent;
  createdAt: number;
  /** Source filename in `<dataDir>/pending/`. */
  filename: string;
  /** The chat + input ids this fire's outcome will be reported against. */
  chatId: string;
  localId: string;
  /** The trigger that fired it — needed to write the run entry on flush. */
  trigger: RunTrigger;
  payloadDigest: string;
  actionType: JobAction['type'];
  /** The host this fire is queued for (spawn/ensure), else the chat's host. */
  daemonId: string | null;
  folder?: string;
  /**
   * The job's limit when the fire was made, if it had one. Carried so a fire
   * that outlives a restart in the host buffer is still gated when the host
   * comes back — otherwise a reconnect after a restart would flush a limited
   * job's whole backlog, which is the stampede the limit exists to stop.
   */
  concurrency?: number;
  /**
   * The queue this fire is limited within, when that is narrower than the job:
   * `queueing: { mode: 'queue', key }` gives each subject its own limit, named
   * `<jobId>#<slug>`. Absent → the whole job is one scope (its id).
   */
  scope?: string;
  /**
   * An `ensure` fire whose chat its host had not yet reported either way (see
   * `hostReported`). `event` holds the spawn and this the input; which one goes
   * out is decided when the host has reported, at release — never before.
   */
  ensureInput?: ChatInputEvent;
}

/** The queue a fire or slot counts against: its keyed scope, else the whole job. */
function scopeOf(x: { jobId: string; scope?: string }): string {
  return x.scope ?? x.jobId;
}

/** State of an `append` job's durable chat, per chat id (spec/08 § Queueing). */
interface AppendState {
  generation: number;
  startedAt: number;
  lastFireAt: number;
  count: number;
}

/**
 * A fire waiting for a concurrency slot. Same shape as a pending entry plus
 * the limit that was in force when it queued, which is what reseeds the
 * in-memory limit after a restart (the job store is not wired into the
 * dispatcher, and a queue that forgot its own limit would drain all at once).
 */
interface QueuedEntry extends PendingEntry {
  concurrency: number;
}

/** A fire parked outside its job's run window, as persisted to disk. */
interface HeldFire {
  fireId: string;
  jobId: string;
  payload: unknown;
  trigger: RunTrigger;
  heldAt: number;
}

/** A concurrency slot held by one in-flight fire, as persisted to disk. */
interface HeldSlotRecord {
  jobId: string;
  chatId: string;
  localId: string;
  acquiredAt: number;
  /** The limit in force when it was taken — reseeds the limit on restart. */
  concurrency: number;
  /** The keyed scope it counts against; absent → the job (see `PendingEntry.scope`). */
  scope?: string;
  /**
   * The fire's own trigger and action, carried so a slot that times out can
   * write a run entry that says what actually fired rather than guessing.
   */
  trigger: RunTrigger;
  actionType: JobAction['type'];
  daemonId: string | null;
  folder?: string;
}

interface HeldSlot extends HeldSlotRecord {
  /** Source filename in `<dataDir>/inflight/`. */
  filename: string;
  timer: NodeJS.Timeout | null;
  /**
   * Read back from disk at startup rather than taken by this process. Only
   * these need reconciling against the chat mirror — a slot taken here is
   * tracked live by the events that created it.
   */
  restored: boolean;
}

/** One fire waiting for its host to report the outcome. */
interface AwaitedOutcome {
  jobId: string;
  trigger: RunTrigger;
  payloadDigest: string;
  actionType: JobAction['type'];
  chatId: string;
  localId: string;
  /** The host the fire was addressed to — named in the log either way. */
  daemonId: string | null;
  folder?: string;
  /** Fire time — the run entry is stamped when it FIRED, not when it settled. */
  ts: number;
  /** A passing gate's output, shown as this run's verdict (spec/08 § Gate). */
  gateOutput?: string;
  timer: NodeJS.Timeout;
}

export class JobDispatcher {
  private readonly pendingDir: string;
  private readonly logger: Logger;
  private readonly daemonLink: DaemonLink;
  private readonly idGenerator: () => string;
  private readonly cap: number;
  private readonly chatExists: (chatId: string) => boolean;
  /**
   * `ensure` chat ids we've already issued a spawn for this process. Guards the
   * race where two fires land before the host's `chat.spawned` round-trips
   * back into the registry: the second fire sees this set and sends `chat.input`
   * instead of a duplicate spawn (the host throws on a re-spawn of the same
   * chatId). The daemon-link is ordered, so a spawn followed by an input both
   * arrive in order and the input lands in the just-created chat.
   */
  private readonly ensureSpawned = new Set<string>();
  /**
   * The last `chat.input` an `ensure` fire delivered, per chat — kept so a
   * `claude_session_missing` can be retried without the caller's payload.
   *
   * An `ensure` chat is durable and long-lived, so its Claude session can be
   * gone (a host restart, a pruned transcript, a run the spend limit killed)
   * while the chat itself still holds turns. The host then REFUSES the fire
   * rather than silently resuming into a fresh, contextless session — correct,
   * and documented in chatRunner's pre-flight. But that refusal also marks the
   * chat `errored`, and the same pre-flight lets the NEXT turn start fresh
   * (`wasClearedForRecovery`). A person gets that next turn by typing again. A
   * job has nobody to type: the fire was logged `chat-error` and the work was
   * dropped on the floor, which is how 20 Todoist tasks sat untouched for days
   * with no error anywhere their owner would look.
   */
  private readonly lastEnsureEntry = new Map<string, PendingEntry>();
  /** Chats already retried once, so a chat that stays broken cannot loop. */
  private readonly sessionRetried = new Set<string>();
  /** Cap on `lastEnsureEntry`, which would otherwise grow with every chat. */
  private static readonly MAX_RETAINED_ENSURE = 500;
  private statusUnsub: (() => void) | null = null;
  private eventUnsub: (() => void) | null = null;
  private readonly logs: JobLogs;
  private readonly chatHost: (chatId: string) => string | null;
  private readonly hostReported: (daemonId: string) => boolean;
  private readonly ackTimeoutMs: number;
  private readonly nowMs: () => number;
  /**
   * Fires waiting on their host's answer, keyed by the chatId the fire names.
   * A list per chat because an `ensure`/`message` job can have two fires in
   * flight at once; they settle in order (the daemon-link is ordered).
   */
  private readonly awaiting = new Map<string, AwaitedOutcome[]>();
  private readonly queuedDir: string;
  private readonly inflightDir: string;
  private readonly slotTimeoutMs: number;
  private readonly chatActivity: (chatId: string) => ChatActivity | null;
  private readonly chatHasWorked: ((chatId: string, since: number) => boolean) | undefined;
  private readonly defaultModel: () => string | undefined;
  private readonly autonomyPrompt: () => string;

  /**
   * The `model` field for a fire's spawn frame: the action's own choice, else
   * the account default, else nothing at all.
   *
   * "Nothing at all" only happens with no settings store wired (tests), and it
   * is the one case left to the machine's own default — kept so nothing here has
   * to invent a model id of its own.
   */
  private spawnModelField(actionModel: string | undefined): { model?: string } {
    const model = actionModel ?? this.defaultModel();
    return model === undefined ? {} : { model };
  }
  private readonly chatLinks:
    | { record: (chatId: string, jobId: string) => void; get: (chatId: string) => string | null }
    | undefined;
  private readonly jobs: Pick<JobsInterface, 'expireOneOff' | 'get'> | undefined;
  private readonly heldDir: string;
  private heldTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Held slots keyed by the chat whose completion frees them. A list per chat
   * because a `message`/`ensure` job with a limit above 1 can hold several
   * slots on its one chat; each of that chat's work-then-stop cycles frees the
   * oldest.
   */
  private readonly slots = new Map<string, HeldSlot[]>();
  /**
   * Chats seen working since their oldest slot was taken. A chat is reported
   * idle the moment it is spawned, BEFORE its first turn — releasing on that
   * would hand the slot straight back and make the limit a no-op. So a slot is
   * only freed by an idle that follows work.
   */
  private readonly workedSince = new Set<string>();
  /** Fires whose gate is in flight, keyed by `gateFireKey` (spec/08 § Gate). */
  private readonly gating = new Map<string, GatingFire>();
  /** Each SCOPE's limit as of its most recent fire (see `scopeOf`). Absent → no limit. */
  private readonly limits = new Map<string, number>();
  /** Each job's limit as of its most recent fire, for its views. Absent → none. */
  private readonly jobLimits = new Map<string, number>();
  private readonly appendDir: string;

  constructor(opts: DispatcherOptions) {
    this.pendingDir = join(opts.dataDir, 'pending');
    this.queuedDir = join(opts.dataDir, 'queued');
    this.inflightDir = join(opts.dataDir, 'inflight');
    this.appendDir = join(opts.dataDir, 'append');
    this.heldDir = join(opts.dataDir, 'held');
    this.logger = opts.logger;
    this.daemonLink = opts.daemonLink;
    this.logs = opts.logs;
    this.idGenerator = opts.idGenerator ?? ((): string => ulid());
    this.cap = opts.pendingCapPerJob ?? DEFAULT_PENDING_CAP_PER_JOB;
    this.slotTimeoutMs = opts.slotTimeoutMs ?? DEFAULT_SLOT_TIMEOUT_MS;
    this.chatExists = opts.chatExists ?? ((): boolean => false);
    this.chatHost = opts.chatHost ?? ((): string | null => null);
    this.hostReported = opts.hostReported ?? ((): boolean => true);
    this.chatActivity = opts.chatActivity ?? ((): ChatActivity | null => null);
    this.chatHasWorked = opts.chatHasWorked;
    this.defaultModel = opts.defaultModel ?? ((): string | undefined => undefined);
    this.autonomyPrompt = opts.autonomyPrompt ?? ((): string => DEFAULT_JOB_AUTONOMY_PROMPT);
    this.chatLinks = opts.chatLinks;
    this.jobs = opts.jobs;
    this.ackTimeoutMs = opts.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
    this.nowMs = opts.nowMs ?? ((): number => Date.now());
    if (!existsSync(this.pendingDir)) mkdirSync(this.pendingDir, { recursive: true });
    // Slots and queued fires are server-owned state that must outlive a
    // restart (spec/08 ## Concurrency), so both are read back at construction:
    // the queue so nothing queued is lost, the slots so a restart does not
    // start a second build on top of one still running.
    this.loadSlots();
    this.statusUnsub = this.daemonLink.onStatus((s) => {
      if (s === 'online') {
        // Reconcile BEFORE releasing anything: the chat mirror is only seeded
        // once a host is back, so this is the first moment the server can tell
        // which of its restored slots are real.
        this.reconcileSlots();
        this.flush();
        this.drainAll();
      }
    });
    // The run entry for every fire comes from what the host says back.
    this.eventUnsub = this.daemonLink.onEvent((event, fromDaemonId) => {
      this.onDaemonEvent(event, fromDaemonId);
    });
    // If we boot up with the host already online, flush at startup too.
    if (this.daemonLink.status() === 'online') {
      // Defer to next tick so callers wiring this up have a chance to attach.
      queueMicrotask(() => {
        this.reconcileSlots();
        this.flush();
        this.drainAll();
      });
    }
    // Held fires wait on the clock, not on a host event, so something has to
    // look at the clock. Once a minute is finer than the window's HH:MM edges.
    this.heldTimer = setInterval(() => this.releaseHeld(), HELD_CHECK_MS);
    this.heldTimer.unref();
  }

  close(): void {
    if (this.heldTimer) {
      clearInterval(this.heldTimer);
      this.heldTimer = null;
    }
    if (this.statusUnsub) {
      this.statusUnsub();
      this.statusUnsub = null;
    }
    if (this.eventUnsub) {
      this.eventUnsub();
      this.eventUnsub = null;
    }
    for (const waiters of this.awaiting.values()) {
      for (const w of waiters) clearTimeout(w.timer);
    }
    this.awaiting.clear();
    // Slot timers only; the slot RECORDS stay on disk so the next process
    // knows what was in flight when this one stopped.
    for (const held of this.slots.values()) {
      for (const s of held) if (s.timer) clearTimeout(s.timer);
    }
    this.slots.clear();
    this.workedSince.clear();
  }

  // -------------------------------------------------------------------------
  // Run outcomes — spec/08 ## Execution model step 6.

  /**
   * Park a dispatched fire until its host reports what happened to it.
   *
   * `waitMs` overrides the "is anyone home" bound for a fire whose ONLY answer
   * comes when the work itself is done — a `script` action, whose result event
   * arrives after the command has run. Bounding that at the ack timeout would
   * record a dispatch-error for every script taking longer than 20 seconds
   * while it was still happily running.
   */
  private await_(entry: Omit<AwaitedOutcome, 'timer'>, waitMs?: number): void {
    const bound = waitMs ?? this.ackTimeoutMs;
    const timer = setTimeout(() => {
      const w = this.take(entry.chatId, entry.localId);
      if (!w) return;
      this.writeRun(w, {
        status: 'dispatch-error',
        error: `no answer from host ${w.daemonId ?? 'unknown'} within ${bound}ms — the fire was sent but never confirmed`,
      });
      this.logger.error(
        { jobId: w.jobId, daemonId: w.daemonId, chatId: w.chatId },
        'jobs: dispatch unconfirmed by host, recorded dispatch-error',
      );
      // Unconfirmed means it never landed, so nothing is running behind this
      // slot — give it back rather than making the queue wait out the bound.
      const slot = this.takeSlot(w.chatId, w.localId);
      if (slot) this.drain(scopeOf(slot));
    }, bound);
    // A pending run outcome must never hold the process open.
    timer.unref?.();
    const list = this.awaiting.get(entry.chatId) ?? [];
    list.push({ ...entry, timer });
    this.awaiting.set(entry.chatId, list);
  }

  /** Remove and return the oldest waiter for a chat (optionally by localId). */
  private take(chatId: string, localId?: string): AwaitedOutcome | null {
    const list = this.awaiting.get(chatId);
    if (!list || list.length === 0) return null;
    const idx = localId === undefined ? 0 : list.findIndex((w) => w.localId === localId);
    if (idx < 0) return null;
    const [w] = list.splice(idx, 1);
    if (list.length === 0) this.awaiting.delete(chatId);
    if (!w) return null;
    clearTimeout(w.timer);
    return w;
  }

  /** The most recently registered spawn waiter, for the host's placeholder id. */
  private takeAnySpawn(): AwaitedOutcome | null {
    let newest: { chatId: string; w: AwaitedOutcome } | null = null;
    for (const [chatId, list] of this.awaiting) {
      for (const w of list) {
        if (newest === null || w.ts >= newest.w.ts) newest = { chatId, w };
      }
    }
    if (!newest) return null;
    return this.take(newest.chatId, newest.w.localId);
  }

  private onDaemonEvent(event: WireEvent, fromDaemonId: string | null): void {
    // A host's folders.list closes its chat re-announcement: any `ensure` held
    // for it can now be decided. Deferred a tick so the ChatRegistry, which
    // observes the same frame, has marked the host reported whatever order the
    // two listeners run in.
    if (event.type === 'folders.list') {
      queueMicrotask(() => {
        // The host has now said what state its chats are in, which may differ
        // from what the mirror restored from disk: settle any restored slot
        // whose chat turns out to have finished.
        this.reconcileSlots();
        this.flush();
        this.drainAll();
      });
      return;
    }
    // A held slot lasts until its chat stops working (spec/08 ## Concurrency).
    // This is the same stream the ChatRegistry mirrors, so the gate sees a
    // chat's activity at the moment the registry does.
    if (event.type === 'chat.state') {
      this.observeChatActivity(event.chatId, event.activity);
      return;
    }
    if (event.type === 'chat.spawned') {
      const w = this.take(event.chatId);
      if (!w) return;
      this.writeRun(w, { status: 'ok', chatId: event.chatId });
      return;
    }
    if (event.type === 'chat.input_ack') {
      const w = this.take(event.chatId, event.localId);
      if (!w) return;
      this.writeRun(w, { status: 'ok', chatId: event.chatId });
      return;
    }
    if (event.type === 'job.exec_result') {
      // A GATE's command answering (spec/08 § Gate). Checked first and returns
      // early: a gate holds no slot and settles no fire, so none of the script
      // action's bookkeeping below applies to it.
      const gateKey = gateFireKey(event.fireId);
      const gated = this.gating.get(gateKey);
      if (gated) {
        this.gating.delete(gateKey);
        const tail = [event.stdout, event.stderr].filter((t) => t.length > 0).join('\n');
        // The VERDICT is read from stdout alone — a gate's decision is something
        // it says deliberately, and stderr is where a shell's own noise lands.
        // The row keeps both, because the noise is what explains a fault.
        this.settleGate(gated, event.exitCode, event.stdout, tail, event.error);
        return;
      }
      // spec/08 § Action — `script`. The command has finished (or failed to
      // start, or been killed on its timeout); this is the only thing that
      // settles a script fire, and the only thing that frees its slot.
      const key = execFireKey(event.fireId);
      const w = this.take(key);
      if (w) {
        const tail = [event.stdout, event.stderr].filter((t) => t.length > 0).join('\n');
        // The chat the command started, if it said so. Read from STDOUT only:
        // the announcement is a deliberate statement by the gate, and stderr is
        // where a shell's own noise lands (see `SCRIPT_CHAT_MARKER`).
        const announced = parseScriptChatId(event.stdout);
        const chat = announced === null ? {} : { chatId: announced };
        this.writeRun(
          w,
          event.ok
            ? { status: 'ok', exitCode: event.exitCode, output: tail, ...chat }
            : {
                status: 'dispatch-error',
                error:
                  event.error ??
                  `command exited ${event.exitCode === null ? 'without a code' : String(event.exitCode)}`,
                exitCode: event.exitCode,
                output: tail,
                ...chat,
              },
        );
        if (!event.ok) {
          this.logger.error(
            { jobId: event.jobId, exitCode: event.exitCode, err: event.error },
            'jobs: script action failed',
          );
        }
      }
      const slot = this.takeSlot(key, w?.localId);
      if (slot) this.drain(scopeOf(slot));
      return;
    }
    if (event.type === 'chat.error') {
      const w =
        event.chatId === PENDING_SPAWN_PLACEHOLDER ? this.takeAnySpawn() : this.take(event.chatId);
      // No waiter means the fire was already settled `ok` - the host accepted
      // it and created the chat. The chat has now failed anyway. That is still
      // this job's outcome, so record it against the job rather than dropping
      // it: a spawn that lands and then dies is indistinguishable, in the run
      // log, from one that worked.
      if (!w) {
        this.recordChatError(event.chatId, event.error, fromDaemonId);
        return;
      }
      // spec/08 ## Logs: name the host and carry ITS error text. `fromDaemonId`
      // is the machine that actually raised it (authoritative); the addressed
      // host is the fallback label when the link could not attribute it.
      const host = fromDaemonId ?? w.daemonId ?? 'unknown';
      this.writeRun(w, {
        status: 'dispatch-error',
        error: `host ${host} refused the action: ${event.error.code}: ${event.error.message}`,
      });
      this.logger.error(
        { jobId: w.jobId, daemonId: host, code: event.error.code, err: event.error.message },
        'jobs: host refused the dispatched action',
      );
      // A refused fire is not in flight — its slot goes back now rather than
      // waiting for an idle from a chat that was never created.
      const slot = this.takeSlot(w.chatId, w.localId);
      if (slot) this.drain(scopeOf(slot));
      return;
    }
  }

  /**
   * A chat that a job spawned has errored after its fire was already recorded
   * `ok`. Append a second entry for that job so the failure is visible where
   * someone would look for it. Chats nobody's job owns are ignored - the
   * dispatcher only speaks for its own fires.
   */
  private recordChatError(
    chatId: string,
    error: { code: string; message: string },
    fromDaemonId: string | null,
  ): void {
    // A session the host refused to resume is RECOVERABLE, and only here can
    // anyone act on it: the refusal has just marked the chat `errored`, which
    // is the state chatRunner's own pre-flight lets the next turn start fresh
    // from. So send that next turn — once — instead of logging the failure and
    // dropping the job's work. Retried at most once per chat (cleared whenever
    // a later fire for it is sent), so a chat that stays broken records its
    // error and stops rather than looping.
    const retry =
      error.code === 'claude_session_missing' ? this.lastEnsureEntry.get(chatId) : undefined;
    const willRetry = retry !== undefined && !this.sessionRetried.has(chatId);

    const held = this.slots.get(chatId) ?? [];
    // A slot carries the fire's own trigger and action, so prefer it. A job
    // with no concurrency limit holds no slot at all (see acquireSlot), and
    // its chats fail just the same — the persisted chatId → jobId link covers
    // those, at the cost of not knowing which trigger fired.
    const attributions: Array<{
      jobId: string;
      trigger: RunTrigger;
      actionType: JobAction['type'];
      daemonId: string | null;
      folder?: string;
    }> = held.map((slot) => ({
      jobId: slot.jobId,
      trigger: slot.trigger,
      actionType: slot.actionType,
      daemonId: slot.daemonId,
      ...(slot.folder !== undefined ? { folder: slot.folder } : {}),
    }));
    if (attributions.length === 0) {
      const linkedJobId = this.chatLinks?.get(chatId) ?? null;
      // Unattributable: nothing to write to a job's run log. The RETRY below
      // still runs — it is keyed on the chat, not on knowing whose job it was,
      // and dropping the work because the attribution is missing would be the
      // very failure this exists to stop.
      if (linkedJobId !== null) {
        attributions.push({
          jobId: linkedJobId,
          trigger: 'manual',
          actionType: 'spawn',
          daemonId: fromDaemonId,
        });
      }
    }
    for (const at of attributions) {
      this.logs.appendRun({
        ts: Date.now(),
        jobId: at.jobId,
        status: 'chat-error',
        trigger: at.trigger,
        error: willRetry
          ? `chat ${chatId} failed: ${error.code}: ${error.message} — its session was gone, so the fire is being retried once and will start a fresh session`
          : `chat ${chatId} failed: ${error.code}: ${error.message}`,
        action: {
          type: at.actionType,
          chatId,
          ...(at.daemonId !== null ? { daemonId: at.daemonId } : {}),
          ...(at.folder !== undefined ? { folder: at.folder } : {}),
        },
      });
      this.logger.error(
        { jobId: at.jobId, chatId, daemonId: fromDaemonId ?? at.daemonId, code: error.code },
        'jobs: a chat this job spawned has errored',
      );
    }

    if (willRetry && retry !== undefined) {
      this.sessionRetried.add(chatId);
      this.logger.warn(
        { chatId, jobId: retry.jobId },
        'jobs: resending an ensure fire whose chat had lost its session',
      );
      // A fresh localId: the host dedupes on it, and the refused delivery
      // already consumed the original. No slot is taken — the first attempt's
      // slot was released when the chat errored, and taking a second would
      // count one fire twice against the job's concurrency.
      // Narrowed, not cast: only `chat.input` fires are retained (see `send`),
      // and it is the one event in the union that carries a `localId`.
      if (retry.event.type === 'chat.input') {
        const localId = `${retry.localId}-r`;
        this.send(
          { ...retry, localId, event: { ...retry.event, localId } },
          { takeSlot: false, isRetry: true },
        );
      }
    }
  }

  /** Write the settled run entry for one fire. */
  private writeRun(
    w: AwaitedOutcome,
    outcome:
      | { status: 'ok'; chatId: string }
      // A `script` fire settles with no chat of the SERVER's making: its exit
      // code and output tail are the record (spec/08 § Action — `script`).
      // `chatId` is there when the command announced one itself — a gate that
      // found work spawns through the CLI, so the chat exists but no
      // `chat.spawned` ever reached us (see `SCRIPT_CHAT_MARKER`).
      | { status: 'ok'; exitCode: number | null; output: string; chatId?: string }
      | {
          status: 'dispatch-error';
          error: string;
          exitCode?: number | null;
          output?: string;
          chatId?: string;
        },
  ): void {
    const script = 'exitCode' in outcome;
    this.logs.appendRun({
      ts: w.ts,
      jobId: w.jobId,
      status: outcome.status,
      trigger: w.trigger,
      payloadDigest: w.payloadDigest,
      ...(outcome.status === 'dispatch-error' ? { error: outcome.error } : {}),
      action: {
        type: w.actionType,
        // A fire that did not land has NO chat — spec/08 ## Logs exists to
        // catch exactly the case where the log claims one that isn't there. A
        // script fire opens none of the server's, so its chat is only ever the
        // one the command itself announced, which a FAILING fire can also have
        // done (spawned, then fell over) — hence not gated on `ok`.
        ...(outcome.chatId !== undefined ? { chatId: outcome.chatId } : {}),
        ...(script ? { exitCode: outcome.exitCode ?? null } : {}),
        ...(script && outcome.output !== undefined && outcome.output.length > 0
          ? { output: outcome.output }
          : {}),
        // A gated fire's row shows what the gate said when it let it through —
        // the `run` half of the same record that a hold writes (spec/08 § Gate).
        // A `script` action has output of its own and keeps it.
        ...(!script && w.gateOutput !== undefined ? { output: w.gateOutput } : {}),
        ...(w.daemonId !== null ? { daemonId: w.daemonId } : {}),
        ...(w.folder !== undefined ? { folder: w.folder } : {}),
      },
    });
    // A one-off job retires on its first SUCCESSFUL fire (spec/08 § One-off
    // jobs). Only `ok` counts: a `dispatch-error` never did the thing the job
    // exists to do, so the job stays live for its next trigger. The store
    // decides whether there is anything to retire (not one-off / already
    // stamped → no-op), so a second fire settling ok changes nothing.
    if (outcome.status === 'ok') this.expireIfOneOff(w.jobId);
  }

  /**
   * Retire the job behind a fire that just settled ok, if it is a one-off that
   * has not already retired. Isolated from `writeRun` so a store failure can
   * never cost us the run entry that was already written — the run log is the
   * record of what happened and must not be undone by a bookkeeping write.
   */
  private expireIfOneOff(jobId: string): void {
    if (!this.jobs) return;
    let expired;
    try {
      expired = this.jobs.expireOneOff(jobId, this.nowMs());
    } catch (err) {
      this.logger.error(
        { jobId, err },
        'jobs: failed to retire one-off job after a successful fire',
      );
      return;
    }
    if (expired) this.logger.info({ jobId }, 'jobs: one-off job retired after its first ok fire');
  }

  // -------------------------------------------------------------------------
  // Append queueing — spec/08 § Queueing.

  /**
   * The generation of an `append` job's durable chat this fire belongs to. A
   * fire after the chat has been idle `idleTimeoutMs`, has lived `resetAfterMs`
   * or has taken `resetAfterMessages` fires moves to the next generation — a
   * new chat id, so the old chat is left intact. Any other mode is always 0.
   *
   * Server-owned state under `<dataDir>/append`, written atomically. An
   * unreadable file throws: guessing a generation would either append into a
   * chat that should have reset or reset one that should not.
   */
  private appendGeneration(job: Job, keySlug: string | undefined): number {
    const q = job.queueing;
    if (q?.mode !== 'append') return 0;
    const now = this.nowMs();
    const file = join(this.appendDir, `${ensureChatId(job.id, keySlug)}.json`);
    let state: AppendState | undefined;
    if (existsSync(file)) state = JSON.parse(readFileSync(file, 'utf8')) as AppendState;
    if (
      state === undefined ||
      (q.idleTimeoutMs !== undefined && now - state.lastFireAt >= q.idleTimeoutMs) ||
      (q.resetAfterMs !== undefined && now - state.startedAt >= q.resetAfterMs) ||
      (q.resetAfterMessages !== undefined && state.count >= q.resetAfterMessages)
    ) {
      state = {
        generation: state === undefined ? 0 : state.generation + 1,
        startedAt: now,
        lastFireAt: now,
        count: 0,
      };
    }
    state.lastFireAt = now;
    state.count += 1;
    if (!existsSync(this.appendDir)) mkdirSync(this.appendDir, { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), 'utf8');
    renameSync(tmp, file);
    return state.generation;
  }

  // -------------------------------------------------------------------------
  // Concurrency gate — spec/08 ## Concurrency.

  /** The gate's view of one job: what it is running and what is waiting. */
  counts(jobId: string): JobConcurrencyCounts {
    return {
      inFlight: this.inFlightFor(jobId, true),
      queued: this.listQueuedForJob(jobId, true).length,
    };
  }

  /**
   * The same state as `counts`, listed rather than counted: the fires this job
   * has in flight (oldest first, the order their slots free) and the fires
   * waiting behind its limit (FIFO, the order they will be released).
   */
  queue(jobId: string): JobQueueView {
    const inFlight: JobQueueInFlightEntry[] = [];
    for (const held of this.slots.values()) {
      for (const s of held) {
        if (s.jobId !== jobId) continue;
        inFlight.push({
          chatId: s.chatId,
          localId: s.localId,
          startedAt: s.acquiredAt,
          trigger: s.trigger,
          actionType: s.actionType,
          daemonId: s.daemonId,
          ...(s.folder !== undefined ? { folder: s.folder } : {}),
        });
      }
    }
    // `slots` is keyed by chat, so iterating it yields no useful order at all
    // — the oldest slot is the next one to free, so that is the order to show.
    inFlight.sort((a, b) => a.startedAt - b.startedAt);
    // `listQueuedForJob` is already sorted by createdAt, which IS the release
    // order (drain takes [0]) — don't re-sort it into something else.
    const queued = this.listQueuedForJob(jobId, true).map((e) => ({
      fireId: e.fireId,
      queuedAt: e.createdAt,
      chatId: e.chatId,
      trigger: e.trigger,
      actionType: e.actionType,
      daemonId: e.daemonId,
      ...(e.folder !== undefined ? { folder: e.folder } : {}),
    }));
    return { concurrency: this.jobLimits.get(jobId) ?? null, inFlight, queued };
  }

  /** Slots held in one scope — or, with `wholeJob`, across every scope of that job. */
  private inFlightFor(scope: string, wholeJob = false): number {
    let n = 0;
    for (const held of this.slots.values()) {
      for (const s of held) if ((wholeJob ? s.jobId : scopeOf(s)) === scope) n += 1;
    }
    return n;
  }

  /** Does this job already hold a slot on this exact chat? */
  private holdsSlotFor(jobId: string, chatId: string): boolean {
    return (this.slots.get(chatId) ?? []).some((s) => s.jobId === jobId);
  }

  private hostOnline(daemonId: string | null): boolean {
    return daemonId !== null
      ? this.daemonLink.isOnline(daemonId)
      : this.daemonLink.status() === 'online';
  }

  /** Take a slot for a fire about to go out. No limit on the job → no slot. */
  private acquireSlot(entry: PendingEntry): void {
    const concurrency = this.limits.get(scopeOf(entry));
    if (concurrency === undefined) return;
    const record: HeldSlotRecord = {
      jobId: entry.jobId,
      ...(entry.scope !== undefined ? { scope: entry.scope } : {}),
      chatId: entry.chatId,
      localId: entry.localId,
      acquiredAt: this.nowMs(),
      concurrency,
      trigger: entry.trigger,
      actionType: entry.actionType,
      daemonId: entry.daemonId,
      ...(entry.folder !== undefined ? { folder: entry.folder } : {}),
    };
    if (!existsSync(this.inflightDir)) mkdirSync(this.inflightDir, { recursive: true });
    const filename = `${entry.jobId}-${entry.localId}.json`;
    writeFileSync(join(this.inflightDir, filename), JSON.stringify(record), 'utf8');
    const slot: HeldSlot = { ...record, filename, timer: null, restored: false };
    this.armSlotTimer(slot);
    const list = this.slots.get(entry.chatId) ?? [];
    list.push(slot);
    this.slots.set(entry.chatId, list);
  }

  /**
   * A chat that dies without ever reporting itself finished must not hold its
   * slot forever (spec/08 ## Concurrency) — after the bound the slot comes
   * back, recorded on the job's runs so the wedge is visible where the user
   * looks, not only in the server log.
   *
   * The bound runs from when the slot was TAKEN, not from now, so a restarted
   * server does not hand a wedged slot a fresh one. That matters more now
   * that an unresolved chat keeps its slot: without it, a server restarting
   * under a dead chat would never reach the bound at all.
   */
  private armSlotTimer(slot: HeldSlot): void {
    const remaining = Math.max(0, slot.acquiredAt + this.slotTimeoutMs - this.nowMs());
    const timer = setTimeout(() => {
      const taken = this.takeSlot(slot.chatId, slot.localId);
      if (!taken) return;
      this.logs.appendRun({
        ts: this.nowMs(),
        jobId: taken.jobId,
        status: 'slot-timeout',
        trigger: taken.trigger,
        error: `chat ${taken.chatId} held a concurrency slot for ${this.slotTimeoutMs}ms without finishing — the slot was released so the job's queue could move`,
        action: {
          type: taken.actionType,
          chatId: taken.chatId,
          ...(taken.daemonId !== null ? { daemonId: taken.daemonId } : {}),
          ...(taken.folder !== undefined ? { folder: taken.folder } : {}),
        },
      });
      this.logger.error(
        { jobId: taken.jobId, chatId: taken.chatId, slotTimeoutMs: this.slotTimeoutMs },
        'jobs: concurrency slot held past the bound by a chat that never finished, released',
      );
      this.drain(scopeOf(taken));
    }, remaining);
    // A held slot must never hold the process open.
    timer.unref?.();
    slot.timer = timer;
  }

  /** Remove and return a held slot — oldest for the chat, or one by localId. */
  private takeSlot(chatId: string, localId?: string): HeldSlot | null {
    const list = this.slots.get(chatId);
    if (!list || list.length === 0) return null;
    const idx = localId === undefined ? 0 : list.findIndex((s) => s.localId === localId);
    if (idx < 0) return null;
    const [slot] = list.splice(idx, 1);
    if (list.length === 0) {
      this.slots.delete(chatId);
      this.workedSince.delete(chatId);
    }
    if (!slot) return null;
    if (slot.timer) clearTimeout(slot.timer);
    try {
      rmSync(join(this.inflightDir, slot.filename));
    } catch (err) {
      this.logger.error(
        { err: (err as Error).message, filename: slot.filename },
        'jobs: failed to remove in-flight slot record',
      );
    }
    return slot;
  }

  /**
   * A chat the gate is watching changed activity. A freshly-spawned chat is
   * reported idle BEFORE its first turn, so only an idle that FOLLOWS work
   * frees a slot; an errored chat frees one either way (it is not going to do
   * anything else).
   */
  private observeChatActivity(chatId: string, activity: ChatActivity): void {
    if (!this.slots.has(chatId)) return;
    if (WORKING_ACTIVITIES.has(activity)) {
      this.workedSince.add(chatId);
      return;
    }
    if (activity === 'idle' && !this.workedSince.has(chatId)) return;
    this.workedSince.delete(chatId);
    this.releaseSlot(chatId);
  }

  private releaseSlot(chatId: string): void {
    const slot = this.takeSlot(chatId);
    if (!slot) return;
    this.drain(scopeOf(slot));
  }

  /** Read back the slots and limits a previous process left behind. */
  private loadSlots(): void {
    if (!existsSync(this.inflightDir)) return;
    for (const filename of readdirSync(this.inflightDir)) {
      if (!filename.endsWith('.json')) continue;
      let record: HeldSlotRecord;
      try {
        record = JSON.parse(
          readFileSync(join(this.inflightDir, filename), 'utf8'),
        ) as HeldSlotRecord;
      } catch {
        this.logger.warn({ filename }, 'jobs: malformed in-flight slot record, skipping');
        continue;
      }
      this.limits.set(scopeOf(record), record.concurrency);
      this.jobLimits.set(record.jobId, record.concurrency);
      const slot: HeldSlot = { ...record, filename, timer: null, restored: true };
      this.armSlotTimer(slot);
      const list = this.slots.get(record.chatId) ?? [];
      list.push(slot);
      this.slots.set(record.chatId, list);
    }
    // A queued or buffered fire outlives a restart too, and each carries the
    // limit that was in force — without this the reloaded work would not know
    // what it is waiting for and would go out all at once.
    for (const entry of this.listQueued()) {
      this.limits.set(scopeOf(entry), entry.concurrency);
      this.jobLimits.set(entry.jobId, entry.concurrency);
    }
    for (const entry of this.listPending()) {
      if (entry.concurrency === undefined) continue;
      this.limits.set(scopeOf(entry), entry.concurrency);
      this.jobLimits.set(entry.jobId, entry.concurrency);
    }
  }

  /**
   * Check restored slots against the chat mirror. Run when a host comes back:
   * a chat still working keeps its slot, a chat the mirror says has finished
   * gives it back, and a chat the mirror cannot resolve keeps it too — see
   * below (spec/08 ## Concurrency).
   */
  private reconcileSlots(): void {
    for (const [chatId, held] of [...this.slots]) {
      // Only slots restored from disk need checking — a slot taken in this
      // process is tracked live by the events that created it.
      const restored = held.filter((s) => s.restored);
      if (restored.length === 0) continue;
      const activity = this.chatActivity(chatId);
      if (activity === null) {
        // No answer is not the same as "finished". The mirror is restored from
        // disk at startup, so this is a chat the server has never heard of (or
        // one a host reported as gone), and a chat mid-run is indistinguishable
        // from one that is gone. Freeing here put a second build in the same
        // working tree as a running one. The slot stays held until the chat
        // reports, a host closes its re-announcement, or the bounded wait gives
        // it back — loudly, rather than by forgetting.
        this.logger.warn(
          { chatId, jobIds: restored.map((s) => s.jobId) },
          'jobs: chat not in the mirror yet, keeping its concurrency slot until it reports or the slot times out',
        );
        continue;
      }
      if (WORKING_ACTIVITIES.has(activity)) {
        // Still working: keep the slot, but stop treating it as restored so a
        // later reconnect doesn't re-check a slot this process now owns. The
        // chat has demonstrably worked, so its next idle frees the slot.
        for (const s of restored) s.restored = false;
        this.workedSince.add(chatId);
        continue;
      }
      for (const slot of restored) {
        // An errored chat will do nothing more. An idle one may simply not have
        // started yet: only one that has been seen working since the slot was
        // taken is known to be finished. Otherwise it keeps the slot until it
        // reports working, finishes, or the bounded wait gives it back.
        if (
          activity === 'idle' &&
          this.chatHasWorked !== undefined &&
          !this.chatHasWorked(chatId, slot.acquiredAt)
        ) {
          this.logger.warn(
            { jobId: slot.jobId, chatId },
            'jobs: chat is idle but has not been seen working since its slot was taken, keeping the slot',
          );
          continue;
        }
        const taken = this.takeSlot(chatId, slot.localId);
        if (!taken) continue;
        this.logger.warn(
          { jobId: taken.jobId, chatId, activity },
          'jobs: released a concurrency slot whose chat is no longer working',
        );
        this.drain(scopeOf(taken));
      }
    }
  }

  // ---- the queue ----------------------------------------------------------

  /**
   * Park a fire behind the limit. Unbounded (spec/08 ## Concurrency): a fire
   * waits, it is never refused — depth is a signal to look at, not a limit to
   * enforce.
   */
  private enqueue(entry: QueuedEntry): 'queued' {
    if (!existsSync(this.queuedDir)) mkdirSync(this.queuedDir, { recursive: true });
    writeFileSync(join(this.queuedDir, entry.filename), `${JSON.stringify(entry)}\n`, 'utf8');
    this.logs.appendRun({
      ts: entry.createdAt,
      jobId: entry.jobId,
      status: 'queued',
      trigger: entry.trigger,
      payloadDigest: entry.payloadDigest,
      action: {
        type: entry.actionType,
        ...(entry.daemonId !== null ? { daemonId: entry.daemonId } : {}),
        ...(entry.folder !== undefined ? { folder: entry.folder } : {}),
      },
    });
    this.logger.info(
      { jobId: entry.jobId, fireId: entry.fireId, concurrency: entry.concurrency },
      'jobs: at concurrency limit, queued the fire',
    );
    return 'queued';
  }

  private listQueued(): QueuedEntry[] {
    // A job with no limit never touches this directory, so a server that has
    // never queued anything has none — reading must not conjure one.
    if (!existsSync(this.queuedDir)) return [];
    const out: QueuedEntry[] = [];
    for (const name of readdirSync(this.queuedDir)) {
      if (!name.endsWith('.jsonl')) continue;
      let raw: string;
      try {
        raw = readFileSync(join(this.queuedDir, name), 'utf8');
      } catch {
        continue;
      }
      const firstLine = raw.split('\n').find((l) => l.length > 0);
      if (!firstLine) continue;
      try {
        out.push(JSON.parse(firstLine) as QueuedEntry);
      } catch {
        this.logger.warn({ filename: name }, 'jobs: malformed queued entry, skipping');
      }
    }
    out.sort((a, b) => a.createdAt - b.createdAt);
    return out;
  }

  private listQueuedForJob(scope: string, wholeJob = false): QueuedEntry[] {
    return this.listQueued().filter((e) => (wholeJob ? e.jobId : scopeOf(e)) === scope);
  }

  /**
   * Release queued fires for one job while it has room. Strictly FIFO: if the
   * oldest fire's host is down the drain stops rather than reaching past it,
   * and the reconnect picks it up.
   */
  private drain(scope: string): void {
    const limit = this.limits.get(scope);
    if (limit === undefined) return;
    while (this.inFlightFor(scope) < limit) {
      const next = this.listQueuedForJob(scope)[0];
      if (!next) return;
      if (!this.hostOnline(next.daemonId)) return;
      try {
        rmSync(join(this.queuedDir, next.filename));
      } catch (err) {
        // Leaving the file would re-send this fire on the next drain, so stop
        // rather than loop on it.
        this.logger.error(
          { err: (err as Error).message, filename: next.filename },
          'jobs: failed to remove queued entry, stopping drain',
        );
        return;
      }
      this.send(next);
    }
  }

  private drainAll(): void {
    const scopes = new Set(this.listQueued().map((e) => scopeOf(e)));
    for (const scope of scopes) this.drain(scope);
  }

  /**
   * Send one prepared fire, take its slot, and park it for its outcome.
   *
   * `takeSlot: false` sends WITHOUT taking one — for a fire delivering into a
   * chat this job already holds a slot on. That chat's slot already stands for
   * the work in flight there; a second slot on the same chat would need a
   * second work-then-idle cycle to come back and would make `inFlight` count
   * messages rather than working chats.
   */
  private send(entry: PendingEntry, opts?: { takeSlot?: boolean; isRetry?: boolean }): void {
    this.daemonLink.send(DISPATCH_SURFACE_ID, entry.event);
    // Retain only what a retry could actually re-send: an `ensure` fire that
    // appends to an existing chat. A spawn creates the chat, so it cannot hit
    // the missing-session guard at all.
    //
    // A RETRY is excluded, and that is load-bearing: retaining it would clear
    // `sessionRetried` below, so the one-shot guard would rearm on its own
    // resend and a permanently session-less chat would be retried forever.
    if (!opts?.isRetry && entry.actionType === 'continue' && entry.event.type === 'chat.input') {
      if (this.lastEnsureEntry.size >= JobDispatcher.MAX_RETAINED_ENSURE) {
        const oldest = this.lastEnsureEntry.keys().next();
        if (!oldest.done) this.lastEnsureEntry.delete(oldest.value);
      }
      this.lastEnsureEntry.set(entry.chatId ?? '', entry);
      this.sessionRetried.delete(entry.chatId ?? '');
    }
    if (opts?.takeSlot !== false) this.acquireSlot(entry);
    this.await_(
      {
        jobId: entry.jobId,
        trigger: entry.trigger,
        payloadDigest: entry.payloadDigest,
        actionType: entry.actionType,
        chatId: entry.chatId,
        localId: entry.localId,
        ...(entry.gateOutput !== undefined ? { gateOutput: entry.gateOutput } : {}),
        daemonId: entry.daemonId,
        ...(entry.folder !== undefined ? { folder: entry.folder } : {}),
        ts: entry.createdAt,
      },
      // A script answers only when its command finishes: give it its own
      // timeout plus the ack bound to get the result frame back.
      entry.event.type === 'job.exec_request'
        ? entry.event.timeoutMs + this.ackTimeoutMs
        : undefined,
    );
  }

  /**
   * Refuse a fire that cannot be addressed, recording it where the user looks.
   * Written here rather than left to the caller because this is the one
   * outcome the host never gets to report on — there is no host.
   */
  private refuse(
    job: Job,
    payload: unknown,
    trigger: RunTrigger,
    fireId: string,
    error: string,
  ): DispatchResult {
    this.logs.appendRun({
      ts: this.nowMs(),
      jobId: job.id,
      status: 'dispatch-error',
      trigger,
      payloadDigest: digestPayload(payload),
      error,
      action: { type: job.action.type },
    });
    this.logger.error({ jobId: job.id, fireId, err: error }, 'jobs: refused an unaddressable fire');
    return { status: 'rejected', id: fireId };
  }

  /** Render an action's first user-turn with mustache substitution. */
  static renderPrompt(
    action: JobAction,
    payload: unknown,
    triggerType: JobTrigger['type'],
    gated?: GatePassed,
  ): string | undefined {
    // A `script` action delivers no user turn — there is no chat (spec/08 §
    // Action). Nothing to render.
    if (action.type === 'script') return undefined;
    const hasSkill = action.skill !== undefined && action.skill.length > 0;
    const hasPrompt = action.prompt !== undefined && action.prompt.length > 0;
    // Mustache without escaping: this is delivered to a Claude chat as a
    // user-turn, not rendered as HTML.
    Mustache.escape = (s): string => s;
    const view = renderView(payload, gated);
    // A todoist/webhook event carries fields no template thought to pick out (a
    // comment's `file_attachment`), so the whole event follows the prompt. A
    // cron/recurrence payload is only `firedAt`, and `includePayload: false` is
    // the job's own opt-out (spec/08 § Action).
    const appendEvent =
      (triggerType === 'todoist' || triggerType === 'webhook') && action.includePayload !== false;
    const eventJson = `Trigger event:\n\`\`\`json\n${JSON.stringify(view, null, 2)}\n\`\`\``;
    const renderedPrompt = hasPrompt
      ? `${Mustache.render(action.prompt as string, view)}${appendEvent ? `\n\n${eventJson}` : ''}`
      : undefined;
    if (hasSkill) {
      // Skill + prompt → invoke the skill with the user's prompt as its body.
      // Skill alone → the trigger payload as JSON is the skill's input
      // (spec/08 ## Action) — and a gated job's includes what its gate said,
      // so a skill-only job inherits the gate's findings without anyone
      // writing a template for them.
      const body = renderedPrompt ?? JSON.stringify(view, null, 2);
      return `/${action.skill}\n\n${body}`;
    }
    return renderedPrompt;
  }

  /**
   * Preface an already-rendered first user-turn with the job's autonomy
   * prompt (spec/08 § Autonomy prompt) — the job's own override, or
   * `accountPrompt` (the account-wide `jobAutonomyPrompt` setting) when the
   * job carries none.
   * Every job fires unattended, so every fire carries one; there is no
   * "none" state to skip.
   *
   * Inserted AFTER the `/<skill>` line when the action names one: that line
   * has to stay the very first thing in the message for the chat to read it
   * as a slash command, so the autonomy text lands as the paragraph after it
   * rather than before. Otherwise it simply prefixes the rendered prompt.
   *
   * A `script` action has no chat and so no first user-turn to preface
   * (`renderPrompt` returns `undefined` for it) — passed through untouched.
   * Likewise an action reaching here with neither `skill` nor `prompt` (only
   * possible by going around the REST/RPC validation directly, since
   * `JobAction`'s refinement requires one) has no body to preface either —
   * there is nothing for the autonomy text to introduce, so it stays empty
   * rather than becoming a prompt out of nothing.
   */
  static withAutonomyPrompt(
    action: JobAction,
    rendered: string,
    job: Pick<Job, 'autonomyPrompt'>,
    accountPrompt: string,
  ): string {
    if (action.type === 'script') return rendered;
    const hasSkill = action.skill !== undefined && action.skill.length > 0;
    if (!hasSkill && rendered.length === 0) return rendered;
    const text = jobAutonomyPrompt(job, accountPrompt);
    if (!hasSkill) return `${text}\n\n${rendered}`;
    const skillLine = `/${action.skill}`;
    const rest = rendered.startsWith(skillLine) ? rendered.slice(skillLine.length) : rendered;
    return `${skillLine}\n\n${text}${rest}`;
  }

  /**
   * Dispatch one fire and OWN its run entry: nothing is written here except
   * `buffered` (the host is down, the fire is queued against it —
   * spec/08 ## Action, spec/12). `ok` / `dispatch-error` are written later,
   * from what that host reports back (## Execution model step 6).
   */
  dispatch(job: Job, payload: unknown, trigger: RunTrigger): DispatchResult {
    // The run window comes before even the gate (spec/08 § Run window): a fire
    // outside it costs nothing but a file. A manual run is a person asking for
    // it now, so it is not held.
    if (job.window && trigger !== 'manual' && !inRunWindow(job.window, this.nowMs())) {
      return this.hold(job, payload, trigger);
    }
    // The gate comes FIRST and on its own (spec/08 § Gate). Nothing about the
    // fire is touched until it answers — no slot taken, no queue entry, no
    // buffered pending record — because a held fire must cost exactly one cheap
    // command and leave nothing behind.
    if (job.gate) return this.runGate(job.gate, job, payload, trigger);
    return this.dispatchAction(job, payload, trigger);
  }

  // -------------------------------------------------------------------------
  // Run window — spec/08 § Run window.

  /** Park a fire that arrived outside its job's window. Survives a restart. */
  private hold(job: Job, payload: unknown, trigger: RunTrigger): DispatchResult {
    const fireId = this.idGenerator();
    const ts = this.nowMs();
    if (!existsSync(this.heldDir)) mkdirSync(this.heldDir, { recursive: true });
    const entry: HeldFire = { fireId, jobId: job.id, payload, trigger, heldAt: ts };
    const name = `${String(ts).padStart(15, '0')}-${job.id}-${fireId}.json`;
    const tmp = join(this.heldDir, `${name}.tmp`);
    writeFileSync(tmp, JSON.stringify(entry), 'utf8');
    renameSync(tmp, join(this.heldDir, name));
    this.logs.appendRun({
      ts,
      jobId: job.id,
      status: 'queued',
      trigger,
      payloadDigest: digestPayload(payload),
      action: {
        type: job.action.type,
        ...('daemonId' in job.action && job.action.daemonId
          ? { daemonId: job.action.daemonId }
          : {}),
      },
    });
    this.logger.info(
      { jobId: job.id, fireId, window: job.window },
      'jobs: outside the run window, held the fire',
    );
    return { status: 'queued', id: fireId };
  }

  private listHeld(): Array<{ name: string; entry: HeldFire }> {
    if (!existsSync(this.heldDir)) return [];
    const out: Array<{ name: string; entry: HeldFire }> = [];
    for (const name of readdirSync(this.heldDir).sort()) {
      if (!name.endsWith('.json')) continue;
      try {
        out.push({
          name,
          entry: JSON.parse(readFileSync(join(this.heldDir, name), 'utf8')) as HeldFire,
        });
      } catch (err) {
        this.logger.error({ filename: name, err }, 'jobs: malformed held fire, skipping');
      }
    }
    return out;
  }

  /** How many fires this job has parked behind its window. */
  heldCount(jobId: string): number {
    return this.listHeld().filter((h) => h.entry.jobId === jobId).length;
  }

  /**
   * Dispatch every held fire whose job's window is now open (or gone), oldest
   * first. A fire whose job was deleted or disabled while it waited is dropped
   * with an error log — nobody asked for it to run any more.
   */
  releaseHeld(): { released: number } {
    let released = 0;
    for (const { name, entry } of this.listHeld()) {
      if (!this.jobs) throw new Error('run windows need the dispatcher to be given `jobs`');
      const job = this.jobs.get(entry.jobId);
      if (!job || !job.enabled) {
        this.logger.error(
          { jobId: entry.jobId, fireId: entry.fireId },
          'jobs: job deleted or disabled while a fire was held, dropped it',
        );
        rmSync(join(this.heldDir, name));
        continue;
      }
      if (job.window && !inRunWindow(job.window, this.nowMs())) continue;
      rmSync(join(this.heldDir, name));
      this.dispatch(job, entry.payload, entry.trigger);
      released += 1;
    }
    return { released };
  }

  /**
   * Ask a job's gate, then either run the action or write down why not.
   *
   * The command is sent as a `job.exec_request` like a `script` action's, and
   * `job.exec_result` brings the answer back — see `gateVerdict` for what the
   * exit code means and `settleGate` for what each verdict does.
   */
  private runGate(gate: JobGate, job: Job, payload: unknown, trigger: RunTrigger): DispatchResult {
    const fireId = this.idGenerator();
    const ts = this.nowMs();
    const payloadDigest = digestPayload(payload);

    // A gate we cannot ASK has not said hold — it has said nothing, and a fire
    // must never proceed on a signal nobody read (`gateVerdict`, NO FALLBACK).
    // Deliberately not `buffered` either, which the action path uses for the
    // same offline host: replaying a gate when the machine comes back would be
    // answering "is this due?" hours after it was asked.
    if (!this.hostOnline(gate.daemonId)) {
      this.logs.appendRun({
        ts,
        jobId: job.id,
        status: 'gate-error',
        trigger,
        payloadDigest,
        error: `gate host ${gate.daemonId} is offline, so the gate could not be asked`,
        action: { type: job.action.type, daemonId: gate.daemonId, folder: gate.folder },
      });
      this.logger.warn(
        { jobId: job.id, fireId, daemonId: gate.daemonId },
        'jobs: gate host offline, fire not dispatched',
      );
      return { status: 'rejected', id: fireId };
    }

    this.gating.set(gateFireKey(fireId), { job, payload, trigger, ts, payloadDigest });
    const event: JobExecRequestEvent = {
      type: 'job.exec_request',
      daemonId: gate.daemonId,
      jobId: job.id,
      fireId,
      folder: gate.folder,
      command: gate.command,
      timeoutMs: gate.timeoutMs ?? GATE_DEFAULT_TIMEOUT_MS,
    };
    // Routed by the event's own `daemonId`, exactly as a script action's is.
    this.daemonLink.send(DISPATCH_SURFACE_ID, event);
    return { status: 'gating', id: fireId, event };
  }

  /**
   * What a gate's answer does. One of exactly three things, and every one of
   * them writes a row — a gate that decided is as much a fact as a fire that
   * ran (spec/08 § Gate).
   */
  private settleGate(
    pending: GatingFire,
    exitCode: number | null,
    stdout: string,
    output: string,
    error: string | undefined,
  ): void {
    const { job, payload, trigger, payloadDigest } = pending;
    const verdict = gateVerdict(exitCode, stdout);
    if (verdict === 'run') {
      // The gate is spent; from here the fire is an ordinary one and takes the
      // slot, the queue and the buffering it always did. The gate's own words go
      // on the row the ACTION writes, so one fire is still one row — and into
      // the action's prompt as `{{gate.stdout}}` (`renderView`), so the work the
      // gate already did is not work the model has to repeat.
      this.dispatchAction(job, payload, trigger, { gateOutput: output, gateStdout: stdout });
      return;
    }
    this.logs.appendRun({
      ts: this.nowMs(),
      jobId: job.id,
      status: verdict === 'hold' ? 'gate-held' : 'gate-error',
      trigger,
      payloadDigest,
      ...(verdict === 'fault' ? { error: gateFaultMessage(exitCode, error) } : {}),
      action: {
        type: job.action.type,
        exitCode,
        ...(output.length > 0 ? { output } : {}),
        ...(job.gate !== undefined && job.gate !== null
          ? { daemonId: job.gate.daemonId, folder: job.gate.folder }
          : {}),
      },
    });
    if (verdict === 'fault') {
      this.logger.error(
        { jobId: job.id, exitCode, err: error },
        'jobs: gate faulted, fire not dispatched',
      );
    }
  }

  private dispatchAction(
    job: Job,
    payload: unknown,
    trigger: RunTrigger,
    gated?: GatePassed,
  ): DispatchResult {
    const action = job.action;
    const fireId = this.idGenerator();
    const rendered = JobDispatcher.withAutonomyPrompt(
      action,
      JobDispatcher.renderPrompt(action, payload, job.trigger.type, gated) ?? '',
      job,
      this.autonomyPrompt(),
    );
    // Every fire carries the same localId across its event and its run waiter.
    const localId = `job-${job.id}-${fireId}`;

    // Queueing (spec/08 § Queueing). `queue` is the bare limit plus, with a key,
    // a limit per subject; the older `concurrency` is `queue` without a key.
    // `parallel` and `append` carry no limit — append serialises by appending.
    const queueing = job.queueing;
    const limit = queueing?.mode === 'queue' ? (queueing.concurrency ?? 1) : job.concurrency;
    let scope: string | undefined;
    if (queueing?.mode === 'queue' && queueing.key !== undefined) {
      const slug = ensureChatKeySlug(Mustache.render(queueing.key, renderView(payload, gated)));
      if (slug === null) {
        // NO FALLBACK: collapsing onto the job-wide queue would serialise
        // unrelated subjects behind each other, which is what the key is for.
        return this.refuse(
          job,
          payload,
          trigger,
          fireId,
          `queueing.key "${queueing.key}" rendered empty for this payload, so the fire names no subject — a keyed queue will not fall back to the job-wide queue`,
        );
      }
      scope = `${job.id}#${slug}`;
    }
    const fireScope = scope ?? job.id;

    let event: ChatSpawnRequestEvent | ChatInputEvent | JobExecRequestEvent;
    // The chat this fire names. For a spawn that is the id the server allocates
    // (the chat exists only once the host confirms it); for an input it is the
    // chat being delivered into.
    let targetChatId: string;
    let ensureInput: ChatInputEvent | undefined;
    if (action.type === 'script') {
      // No chat: the fire is a command on a host (spec/08 § Action — `script`).
      // Everything downstream — the ack waiter, the concurrency slot, the run
      // entry — is keyed on a chat id, so the fire names itself one. It is
      // deliberately not a real chat id and never reaches the log's `chatId`
      // field: `writeRun` omits that for a script, because there is no chat to
      // open (spec/08 ## Logs).
      targetChatId = execFireKey(fireId);
      event = {
        type: 'job.exec_request',
        daemonId: action.daemonId,
        jobId: job.id,
        fireId,
        folder: action.folder,
        command: action.command,
        timeoutMs: action.timeoutMs ?? SCRIPT_ACTION_DEFAULT_TIMEOUT_MS,
      };
    } else if (action.type === 'spawn') {
      const chatId = this.idGenerator();
      targetChatId = chatId;
      // Recorded now, not once the host confirms: the id is allocated here,
      // and the row must be taggable from the very first `chat.spawned`
      // round-trip (spec/08 § Action, spec/14 § Sidebar — Automations).
      this.chatLinks?.record(chatId, job.id);
      event = {
        type: 'chat.spawn_request',
        daemonId: action.daemonId,
        folder: action.folder,
        chatId,
        ...(rendered ? { prompt: rendered } : {}),
        localId,
        // spec/08 § Action. The job's own model where it names one, otherwise
        // the ACCOUNT's `defaultModel` — never left off. Omitting the field
        // leaves it to the machine. That used to mean the host's `lastUsedModel`
        // — the model the last chat there happened to run on — which made every
        // job's model a side effect of the last human choice at that keyboard.
        ...this.spawnModelField(action.model),
        // Opt-IN hiding (spec/08 ## Action). A job-spawned chat lands in the
        // active inbox like any other by default: an automated run that stops
        // on a question was otherwise invisible unless the user thought to open
        // `▸ Automations`, so it waited unanswered. `startHidden` is for jobs
        // whose runs are genuinely background noise.
        hidden: action.startHidden === true,
        // spec/08 § Action. Always sent, and `auto` when the action stores
        // nothing — the opposite of `model` above. Omitting the field would
        // resolve the mode through the HOST's default, so raising that default
        // to a blocking mode (a person sitting at that machine choosing to be
        // asked) would silently park every unattended job there instead. The
        // job's mode belongs to the job.
        permissionMode: action.permissionMode ?? 'auto',
        // spec/08 § Action — the account the job's chat starts on, if it names one.
        ...(action.preferredAccountId !== undefined
          ? { preferredAccountId: action.preferredAccountId }
          : {}),
        // spec/04 § Goals, spec/08 ## Action — set once, at creation.
        ...(action.goal !== undefined ? { goal: action.goal } : {}),
      };
    } else if (action.type === 'continue') {
      // Upsert: one durable chat per job, or — with `key` — one per SUBJECT
      // within the job. First fire for a subject spawns it (with the
      // deterministic id); every later fire delivers into the SAME chat so
      // context accumulates. We treat the chat as existing if either the
      // registry mirror has seen it OR we've already issued its spawn this
      // process (covers the pre-`chat.spawned` window).
      let keySlug: string | undefined;
      if (action.key !== undefined) {
        // The same view the prompt renders against, so a gated `continue` can
        // name its subject from what the gate found (`renderView`) rather than
        // only from what the trigger happened to carry.
        const slug = ensureChatKeySlug(Mustache.render(action.key, renderView(payload, gated)));
        if (slug === null) {
          // NO FALLBACK (spec/08 ## Action). Collapsing onto the unkeyed chat
          // would merge unrelated subjects into one conversation — precisely
          // what the key exists to prevent — so the fire is refused and said
          // so on the job's runs, where the user looks.
          return this.refuse(
            job,
            payload,
            trigger,
            fireId,
            `action.key "${action.key}" rendered empty for this payload, so the fire names no subject — a keyed ensure will not fall back to the job-wide chat`,
          );
        }
        keySlug = slug;
      }
      const chatId = ensureChatId(job.id, keySlug, this.appendGeneration(job, keySlug));
      targetChatId = chatId;
      // Tagged for `▸ Automations` exactly as a spawn's chat is (spec/08 ##
      // Action, spec/14 § Sidebar). Recorded unconditionally rather than only
      // on the creating fire: `record` is idempotent on (chatId, jobId), and a
      // chat created before this existed would otherwise never gain its tag.
      // This is what stops `startHidden` being a black hole here — a hidden
      // ensure chat is still watchable in the Automations group.
      this.chatLinks?.record(chatId, job.id);
      const input: ChatInputEvent = {
        type: 'chat.input',
        chatId,
        message: rendered,
        localId,
        // spec/04 § Hidden — a job tick, not the user: it must not bring a
        // hidden chat into the list.
        source: { kind: 'job', jobId: job.id },
      };
      const exists = this.ensureSpawned.has(chatId) || this.chatExists(chatId);
      if (exists) {
        event = input;
      } else {
        // A miss only means "missing" once the host has reported its chats.
        // Before that (right after a server restart) the durable chat may well
        // exist, and spawning it again is refused by the host as a duplicate id
        // — the fire is lost. So the choice is held until the host reports.
        if (this.hostReported(action.daemonId)) this.ensureSpawned.add(chatId);
        else ensureInput = input;
        event = {
          type: 'chat.spawn_request',
          daemonId: action.daemonId,
          folder: action.folder,
          chatId,
          ...(rendered ? { prompt: rendered } : {}),
          localId,
          // Only on this branch: the model is fixed when the durable chat is
          // created, and every later fire is a plain `chat.input` into it.
          ...this.spawnModelField(action.model),
          ...(action.preferredAccountId !== undefined
            ? { preferredAccountId: action.preferredAccountId }
            : {}),
          // The persistent chat is something the user wants to find and follow,
          // so it lands in the active inbox unless the job says otherwise —
          // same opt-IN flag `spawn` carries (spec/08 ## Action). Read only on
          // this branch because that is the only fire that PLACES a chat: every
          // later fire is a `chat.input` into one that already has a home.
          hidden: action.startHidden === true,
          // spec/04 § Goals, spec/08 ## Action — set once, when this fire
          // creates the durable chat.
          ...(action.goal !== undefined ? { goal: action.goal } : {}),
        };
      }
    } else {
      targetChatId = action.chatId;
      event = {
        type: 'chat.input',
        chatId: action.chatId,
        message: rendered,
        localId,
        source: { kind: 'job', jobId: job.id },
      };
    }

    // The host THIS fire is addressed to. For a folder-addressed action that is
    // the action's own `daemonId`; for a `message` it is the host its target
    // chat lives on. Whether that ONE machine is reachable decides sent vs
    // buffered — "any host is attached" would queue a fire for a machine that
    // is up while the machine the job names is down (spec/08 ## Action).
    const daemonId = action.type === 'message' ? this.chatHost(action.chatId) : action.daemonId;
    const folder = action.type === 'message' ? undefined : action.folder;
    const ts = this.nowMs();
    const payloadDigest = digestPayload(payload);

    // One description of the fire, whichever of the three things happens to it.
    // The `ensure` spawn-vs-message decision above is part of it and is NOT
    // re-taken later: a fire that queued as a spawn dispatches as a spawn.
    const filename = `${job.id}-${fireId}.jsonl`;
    const entry: PendingEntry = {
      jobId: job.id,
      fireId,
      event,
      createdAt: ts,
      filename,
      chatId: targetChatId,
      localId,
      trigger,
      payloadDigest,
      actionType: action.type,
      daemonId,
      ...(folder !== undefined ? { folder } : {}),
      ...(limit !== undefined ? { concurrency: limit } : {}),
      ...(scope !== undefined ? { scope } : {}),
      ...(ensureInput !== undefined ? { ensureInput } : {}),
      // What the gate said when it let this fire through (spec/08 § Gate). One
      // fire is one row, so the gate's reason rides along to the row the action
      // writes rather than writing a second one for the same fire.
      ...(gated !== undefined && gated.gateOutput.length > 0
        ? { gateOutput: gated.gateOutput }
        : {}),
    };

    // The job definition is the authority on its own limit, and this is the
    // only place the dispatcher sees one. Recording it here (rather than
    // reading the store) keeps the gate to a single source of truth per fire;
    // a limit removed from the job stops applying from its next fire.
    if (limit === undefined) {
      this.limits.delete(fireScope);
      this.jobLimits.delete(job.id);
    } else {
      this.limits.set(fireScope, limit);
      this.jobLimits.set(job.id, limit);
    }

    // A fire delivering into a chat this job is ALREADY running skips the gate
    // (spec/08 ## Concurrency). The limit bounds how many chats a job has
    // working at once; this fire opens no new one, it appends to one already
    // counted. Queueing it would be actively wrong: the update would wait for
    // the very run it is meant to correct to finish first, which is the whole
    // point of keying an `ensure` on its subject.
    const intoOwnInFlightChat =
      event.type === 'chat.input' && this.holdsSlotFor(job.id, targetChatId);

    // The gate (spec/08 ## Concurrency). A fire also waits when the job has a
    // queue but a free slot — jumping the line would break the FIFO promise
    // for work that has already been waiting.
    if (limit !== undefined && !intoOwnInFlightChat && ensureInput === undefined) {
      const waiting = this.listQueuedForJob(fireScope).length;
      if (waiting > 0 || this.inFlightFor(fireScope) >= limit) {
        const status = this.enqueue({ ...entry, concurrency: limit });
        return { status, id: fireId, event };
      }
    }

    if (ensureInput === undefined && this.hostOnline(daemonId)) {
      // The run is written when this host answers — not now.
      this.send(entry, { takeSlot: !intoOwnInFlightChat });
      return { status: 'sent', id: fireId, event };
    }

    // The addressed host is offline — buffer against it (spec/12 § Cron fires
    // while a host is down) and log the fire as pending against that host.
    appendFileSync(join(this.pendingDir, filename), `${JSON.stringify(entry)}\n`, 'utf8');
    this.logs.appendRun({
      ts,
      jobId: job.id,
      status: 'buffered',
      trigger,
      payloadDigest,
      action: {
        type: action.type,
        ...(daemonId !== null ? { daemonId } : {}),
        ...(folder !== undefined ? { folder } : {}),
      },
    });
    this.logger.warn(
      { jobId: job.id, fireId, daemonId, eventType: event.type },
      ensureInput !== undefined
        ? 'jobs: ensure chat not yet reported by its host, buffered until it reports'
        : 'jobs: addressed host offline, buffered action',
    );
    this.enforceCap(job.id);
    return { status: 'buffered', id: fireId, event };
  }

  private enforceCap(jobId: string): void {
    const entries = this.listPendingForJob(jobId);
    while (entries.length > this.cap) {
      const oldest = entries.shift();
      // Defensive: the while condition guarantees entries has at least one
      // element here, so shift() always returns one — unreachable given the
      // loop invariant.
      /* v8 ignore next */
      if (!oldest) break;
      try {
        rmSync(join(this.pendingDir, oldest.filename));
      } catch (err) {
        this.logger.error(
          { err: (err as Error).message, filename: oldest.filename },
          'jobs: failed to remove overflowed pending entry',
        );
      }
      this.logger.warn(
        { jobId, droppedFireId: oldest.fireId, cap: this.cap },
        'jobs: pending buffer overflow, dropped oldest',
      );
    }
  }

  private removePending(filename: string): void {
    try {
      rmSync(join(this.pendingDir, filename));
    } catch (err) {
      this.logger.error(
        { err: (err as Error).message, filename },
        'jobs: failed to remove flushed pending entry',
      );
    }
  }

  /** Every buffered fire across all jobs, oldest first. */
  private listPending(): PendingEntry[] {
    const out: PendingEntry[] = [];
    for (const name of readdirSync(this.pendingDir)) {
      if (!name.endsWith('.jsonl')) continue;
      const path = join(this.pendingDir, name);
      let raw: string;
      try {
        raw = readFileSync(path, 'utf8');
      } catch {
        continue;
      }
      const firstLine = raw.split('\n').find((l) => l.length > 0);
      if (!firstLine) continue;
      try {
        out.push(JSON.parse(firstLine) as PendingEntry);
      } catch {
        // Malformed pending file — surface and skip.
        this.logger.warn({ filename: name }, 'jobs: malformed pending entry, skipping');
      }
    }
    out.sort((a, b) => a.createdAt - b.createdAt);
    return out;
  }

  private listPendingForJob(jobId: string): PendingEntry[] {
    return this.listPending().filter((e) => e.jobId === jobId);
  }

  /**
   * Flush every pending entry across all jobs to the host. Called on
   * `daemon.online` transitions; idempotent and safe to call repeatedly.
   */
  /**
   * Settle an undecided `ensure` now that its host has reported: input if the
   * chat exists (or this process already spawned it), else the spawn.
   */
  private decideEnsure(entry: PendingEntry): PendingEntry {
    const { ensureInput, ...rest } = entry;
    if (ensureInput === undefined) return entry;
    if (this.ensureSpawned.has(entry.chatId) || this.chatExists(entry.chatId)) {
      return { ...rest, event: ensureInput };
    }
    this.ensureSpawned.add(entry.chatId);
    return rest;
  }

  flush(): { flushed: number } {
    if (this.daemonLink.status() !== 'online') return { flushed: 0 };
    let flushed = 0;
    for (let entry of this.listPending()) {
      // Only release a fire to the machine it was queued FOR. Another host
      // coming online says nothing about this one.
      if (entry.daemonId !== null && !this.daemonLink.isOnline(entry.daemonId)) continue;
      // An undecided `ensure` waits for its host's chat list, not just its link:
      // the link comes up before the chats are re-announced.
      if (entry.ensureInput !== undefined) {
        if (entry.daemonId === null || !this.hostReported(entry.daemonId)) continue;
        entry = this.decideEnsure(entry);
      }
      // The gate applies here too (spec/08 ## Concurrency). A host that has
      // been down all morning has a backlog, and releasing it unchecked is the
      // exact stampede the limit exists to stop — so an over-limit fire moves
      // from the host's buffer into the job's queue rather than going out.
      const limit = this.limits.get(scopeOf(entry));
      if (
        limit !== undefined &&
        (this.listQueuedForJob(scopeOf(entry)).length > 0 ||
          this.inFlightFor(scopeOf(entry)) >= limit)
      ) {
        this.enqueue({ ...entry, concurrency: limit });
        this.removePending(entry.filename);
        continue;
      }
      // A released fire settles like any other: its outcome comes from the host.
      this.send({ ...entry, createdAt: this.nowMs() });
      this.removePending(entry.filename);
      flushed += 1;
    }
    if (flushed > 0) {
      this.logger.info({ flushed }, 'jobs: flushed pending actions on host online');
    }
    return { flushed };
  }
}
