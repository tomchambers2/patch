// All wire-protocol event schemas.
//
// Source of truth: spec/03-wire-protocol.md. Auth events extend per spec/10-auth.md.
// Every event is a zod object with a literal `type` discriminator. The full
// `WireEvent` type is the discriminated union exported from `./index.ts`.
//
// Per spec: every chat-scoped event carries `seq` (per-chat monotonic). Surface
// inputs (`chat.input`) carry `localId` for server-side dedup on (chatId, localId).

import { z } from 'zod';
import { DEFAULT_SWEEP_PROMPT } from './sweep-prompt.js';
import {
  DEFAULT_GOAL_EVAL_PROMPT,
  DEFAULT_GOAL_MODEL,
  DEFAULT_GOAL_REFUSAL_LIMIT,
} from './goal-prompt.js';
import { MeetingState } from './meeting.js';
import { DEFAULT_JOB_AUTONOMY_PROMPT } from './job-autonomy-prompt.js';
import { HostProviderKey, ProviderKeyId } from './provider-keys.js';
import {
  HookDecision,
  HookImages,
  HookKind,
  HookPrompt,
  HookRunResult,
  HookScript,
} from './hooks.js';

/**
 * WebSocket close codes the hub uses (spec/03 § Wire protocol). They are part
 * of the protocol, not an implementation detail of the server: a surface has to
 * tell "the link dropped, retry" from "your credential was REFUSED, stop and
 * re-pair", and the code is how it knows. Retrying a refusal reports
 * "reconnecting" for ever while the server has already said no.
 */
export const CLOSE_MALFORMED_FRAME = 4400;
export const CLOSE_AUTH_FAILED = 4401;

// ---------------------------------------------------------------------------
// Shared atoms

export const ChatActivity = z.enum(['idle', 'running', 'awaiting-permission', 'errored']);
export type ChatActivity = z.infer<typeof ChatActivity>;

/**
 * Who started a turn (spec/09 § Whose turn it was). `user` is a person putting
 * a turn in — any surface's composer, voice, a fork or a side thread.
 * `machine` is the host starting a turn for the chat on its own: a self-wake
 * firing, the todo list advancing, another agent's `patch_send_to` landing.
 *
 * It exists so the server can tell a chat finishing work the user is waiting on
 * from a background loop ticking over, and only ring the doorbell for the
 * former. A retry inherits the origin of the turn it retries.
 */
export const TurnOrigin = z.enum(['user', 'machine']);
export type TurnOrigin = z.infer<typeof TurnOrigin>;

/**
 * The agent harness a turn ran on (spec/02 § Agent backends). A chat's history
 * is Patch's own and outlives any one harness (spec/04 § History), so the
 * history log names which one produced each turn and session.
 */
export const HarnessId = z.enum(['claude', 'codex']);
export type HarnessId = z.infer<typeof HarnessId>;

/**
 * Which harness a model id belongs to — the one client-safe copy of the
 * `openai/` prefix check (`packages/daemon/src/codexAccounts.ts`'s
 * `isCodexModel`, which callers on the host side keep using; this is the
 * same rule for surfaces, which have no reason to depend on `@patch/daemon`
 * just for a string prefix). Used by a surface's model picker to tell a
 * same-provider model change from a cross-provider one (spec/04 § History —
 * the provider-switch confirmation).
 */
export function harnessForModel(model: string | null | undefined): HarnessId {
  return model?.startsWith('openai/') === true ? 'codex' : 'claude';
}

// `deleted` is a recoverable soft-delete (spec/04 § Lifecycle, spec/14 §
// Chat lifecycle): a deleted chat leaves the active list into the sidebar's
// _Deleted_ section and can be restored back to `active`. Nothing is
// hard-deleted from the surface.
export const ChatStatus = z.enum(['active', 'archived', 'errored', 'deleted']);
export type ChatStatus = z.infer<typeof ChatStatus>;

// What a chat is TO THE USER right now — the one fact the sidebar draws a row
// from (spec/04 § Current status).
//
// Three of these put a chat in the list and one keeps it out, which is the
// whole point: a host running twenty overnight jobs must be able to say which
// one or two of them are worth a person's morning.
//
//   `question`  Paused on the USER, and cannot proceed without them. An answer,
//               a decision, or a thing only a person can do in the world —
//               `patch_ask_human` sets this, because "I need you to plug the
//               drive in" and "I need you to pick one" are the same fact about
//               the chat: it is blocked on you.
//   `report`    NOT blocked, but the agent has elected to say this one is worth
//               seeing. The only kind an agent chooses for itself, which is
//               what makes it the one whose bar has to be written into each
//               job's own prompt.
//   `complete`  Finished, nothing outstanding, nothing for the user. Stays
//               wherever it was — a hidden job that ends `complete` stays
//               hidden. Silence is the default and costs the user nothing.
//
// A permission prompt is the fourth way into the list, but it is not a kind:
// it is a live request the chat is holding, derived from `pendingPermissions`
// rather than declared.
//
// Notifications are INDEPENDENT of all of this. A chat may notify as often as
// it has something to say and never appear in the list; appearing in the list
// fires nothing on its own. Welding the two is what left a hidden job with only
// two options, silence or an interruption.
export const StatusKind = z.enum(['question', 'report', 'complete']);
export type StatusKind = z.infer<typeof StatusKind>;

/**
 * A single item on a chat's todo list (patch/todo.md § Features to add — "todo
 * list"). The host mirrors the agent's native TodoWrite list onto chat state
 * so surfaces can render it, and uses it to keep the agent focused: when a turn
 * settles with items still pending, it fires the next one back as a fresh turn.
 * `text` is the item's content; `status` mirrors TodoWrite's own lifecycle.
 */
export const TodoItem = z
  .object({
    text: z.string().min(1),
    status: z.enum(['pending', 'in_progress', 'completed']),
  })
  .strict();
export type TodoItem = z.infer<typeof TodoItem>;

/**
 * The chat's pending self-wake (`02-daemon.md` § Self-wake) as surfaces see it:
 * the message the host will deliver back into this chat and when. Carried on
 * `chat.state` so a scheduled future turn is never invisible — surfaces render
 * it as a bar above the chat with a live countdown to `fireAt` and the message
 * (patch/todo.md — "cron should be visible in a bar above the chat").
 */
export const PendingWake = z
  .object({
    /** The message the host will deliver back into the chat (unprefixed). */
    message: z.string().min(1),
    /** Absolute fire time (ms epoch). */
    fireAt: z.number().int(),
    /** Optional validity cutoff (ms epoch) — the wake is dropped past this. */
    notAfter: z.number().int().optional(),
    /**
     * Recurring interval (ms) — present means this is a LOOP: the host
     * re-arms `fireAt = now + every` on every fire instead of clearing it
     * (`02-daemon.md` § Self-wake, "One-shot + loop"). Absent means the
     * ordinary one-shot self-wake. Surfaces use this to decide whether to
     * render a stop control — a loop is user-stoppable, a plain one-shot
     * wake is not (`14-design-web.md` § Wake bar).
     */
    every: z.number().int().positive().optional(),
    /**
     * Present (and `true`) only while a loop's tick is being absorbed
     * because the chat's turn is already running (`02-daemon.md` § Self-wake,
     * "count the interval from the end of the turn") — `fireAt` is stale
     * until the host arms the next one once that turn ends. Surfaces show
     * "waiting for current turn" instead of a countdown to a time that
     * isn't real yet, and no QUEUED wake bubble.
     */
    waiting: z.literal(true).optional(),
  })
  .strict();
export type PendingWake = z.infer<typeof PendingWake>;

/**
 * Sentinel `seq` for an out-of-band `chat.error` — one emitted by the host
 * outside any known chat context (e.g. a spawn-time `folder_not_found`, where
 * the chat was never registered because folder validation failed). Negative so
 * surfaces never mistake it for a replayable per-chat stream event (those are
 * always `>= 0`). This is the ONLY case where a wire `seq` may be negative; all
 * real stream events use the per-chat monotonic counter. See
 * `02-daemon.md` / `12-error-and-offline.md` (out-of-band control errors).
 */
export const OUT_OF_BAND_SEQ = -1;

/**
 * Discriminator for `chat.error` payloads. The codes are stable and
 * surface-meaningful — surfaces decide whether to offer "fresh start"
 * (claude_session_invalid / claude_session_missing), "log in again"
 * (claude_oauth_missing) etc. `folder_missing` is raised when a resumed
 * chat's pinned folder no longer exists on disk (spec/04 ## Resume).
 */
export const ChatErrorCode = z.enum([
  'folder_not_found',
  'chat_not_found',
  'sdk_error',
  'claude_session_invalid',
  'claude_session_missing',
  'folder_missing',
  'claude_oauth_missing',
  // Surface `file.write` refused because the chat was not `idle` (the agent
  // may be editing the same files) or escaped the chat folder. See
  // spec/14-design-web.md § Diff editor and spec/03-wire-protocol.md.
  'file_write_rejected',
  // The host↔server link dropped mid-turn (host restart, network blip,
  // deploy churn). The host that owned the in-flight turn is gone, so its
  // completion/activity event will never arrive — the server resolves the
  // stuck chat to `errored` with this code so the UI unsticks instead of
  // spinning forever (spec/04 ## Activity, spec/12). NO FALLBACK / fail loud.
  'daemon_unavailable',
  // spec/04 § Branching — a `chat.fork_request` named a `seq` that is not a
  // user turn in this chat's transcript, so there is nothing to fork FROM.
  // NO FALLBACK to forking at the end (that would silently run the edit as an
  // ordinary new message on the current track).
  'fork_point_not_found',
  // spec/04 § Branching — a `chat.branch_switch_request` named a branch this
  // chat does not have, or one whose first turn hasn't produced a session id
  // yet, so there is no track to switch TO.
  'branch_not_found',
  // spec/04 § Spawn — a host-addressed frame named a machine this account has
  // not registered. Refused at the server ingress with the offending id in the
  // message. NO FALLBACK to the only/attached host: with one machine online
  // that substitution is invisible, and with two it silently runs the work on
  // the wrong filesystem.
  'host_not_registered',
  // spec/03 § Host events — a surface frame failed contract validation. The
  // message names the offending field and value, because a frame silently
  // dropped at the ingress is indistinguishable from an edit that did not save.
  'invalid_frame',
  // spec/02 § Optional components — a component operation named a component
  // that machine does not offer. Named, never ignored.
  'component_not_offered',
  // spec/10 § Backend credentials — a credential operation named a backend that
  // machine does not have.
  'backend_not_found',
  // spec/04 § Folders — a folder-registry edit named a path that is empty or
  // does not exist on that machine.
  'folder_invalid',
  // spec/04 § Spawn — a spawn naming no model landed on a machine that has
  // never read a model catalogue, so it has no last-used model to take. Said
  // out loud; NEVER silently defaulted to a hard-coded model id.
  'no_model_catalogue',
  // spec/02 § Claude Code settings — a `host.claude_settings_set` wrote text
  // that does not parse as JSON, or a `host.claude_memory_delete` named a
  // memory entry that machine does not have.
  'claude_settings_invalid',
  // RETIRED. A spawn used to be able to name the Claude account its chat ran
  // on, and this refused an id the host had no stored account for. A chat has
  // no account now — every turn resolves the host's stored keys in order and
  // takes the first with credit (spec/10 § Backend credentials) — so nothing
  // produces this any more. Kept so a refusal from an older host still
  // decodes instead of failing the whole frame.
  'account_not_found',
  // spec/04 § Model — a `chat.model_request` named a model this host's
  // catalogue does not offer. The chat stays on the model it was already
  // running; NEVER rounded to a near match or dropped to the host's last-used.
  'unknown_model',
  // spec/02 § Permission mode — Claude Code resolved the turn onto a DIFFERENT
  // permission mode than the one the chat was given, because the one asked for
  // is unavailable to it (an old `claude` build, or a model that does not
  // support the mode). Claude Code substitutes another mode silently, which
  // for most targets (`default` in practice) asks for approval on every tool
  // call — fatal for an unattended job chat, and invisible, since the chat
  // just sits there looking busy. The turn is refused and the substitution
  // named. NO FALLBACK: patch never runs a turn in one of these modes nobody
  // chose. `plan` is the one substitution target this code never fires for —
  // it is not a dead end, so it runs on and is recorded as an ordinary
  // mode-change instead (`permissionModeChange`/`permissionModeChangeAutomatic`
  // on `chat.message`).
  'permission_mode_downgraded',
  // spec/04 § History — the host could not append to the chat's own history
  // log, so the turn stops rather than carry on showing things the chat will
  // not remember.
  'history_write_failed',
  // spec/04 § History — "switch and compact" asked the outgoing session to
  // write its own handoff before a provider switch, and that failed (OAuth
  // miss, SDK error, timeout, empty reply). NO FALLBACK to the full native
  // reconstruction instead: the user asked for the cheap path specifically,
  // and silently running the expensive one instead would hide that their
  // request didn't happen. The switch itself does not run; sending again
  // retries the whole thing.
  'switch_compact_failed',
  // spec/04 § Send back; spec/14 § Side threads panel — a `chat.send_back_request`
  // named a branch with no parent (the root), or one that has already sent
  // back once. Mirrors the refusal the `patch_send_back` tool itself gives.
  'send_back_failed',
]);
export type ChatErrorCode = z.infer<typeof ChatErrorCode>;

/**
 * Chat error codes that describe a TRANSIENT condition of the control plane
 * rather than the outcome of a turn.
 *
 * Everything else in `ChatErrorCode` is a durable record: the turn really did
 * fail, and the transcript must keep saying so until the user acts on it
 * (spec/12 § No fallbacks). `daemon_unavailable` is the one that is not — the
 * server invents it when the host↔server link drops mid-turn, purely so the
 * UI unsticks instead of spinning (spec/04 § Activity), and it is emitted
 * out-of-band (`OUT_OF_BAND_SEQ`) precisely because it is NOT part of the
 * host's replayable per-chat stream. The condition it describes resolves on
 * its own: the host comes back, re-sends the interrupted turn, and the chat
 * returns to `running`/`idle` under its own steam. A surface holding the notice
 * past that point is showing a failure that is over.
 *
 * So a surface drops a transient error entry the moment the host speaks for
 * that chat again (a `chat.state` whose activity is no longer `errored`) — and
 * ONLY then. No timer, and no clearing on `daemon.online` alone: a host coming
 * back does not mean this chat's turn did. If the host never returns, the
 * notice stays, which is the honest outcome.
 *
 * Keep this list at exactly the codes that are self-resolving. Adding a real
 * turn failure here would silently erase it from the transcript.
 */
export const TRANSIENT_CHAT_ERROR_CODES: readonly ChatErrorCode[] = ['daemon_unavailable'];

/** True when `code` names a self-resolving control-plane notice (see above). */
export function isTransientChatError(code: string | undefined): boolean {
  return code !== undefined && (TRANSIENT_CHAT_ERROR_CODES as readonly string[]).includes(code);
}

/**
 * The activities that say a chat's turn is IN FLIGHT — and therefore that the
 * chat is not parked on a usage limit.
 *
 * A limit pause and a running turn are mutually exclusive states of one chat:
 * the host clears the pause as the next turn starts. So a `chat.state`
 * carrying one of these is proof the pause is over, whatever the frame's own
 * `limitBlock` / `rateLimitResumingAt` fields happen to say (spec/12 § A usage
 * or rate limit). A surface holding the notice past that point is showing a
 * limit that is not blocking anything, with a `Try now` button that has nothing
 * to run.
 *
 * `idle` is deliberately NOT here: a pause with auto-resume armed IS an idle
 * chat, and `errored` is the shape of a limit nobody parked. Neither says the
 * pause has lifted, so neither may clear it.
 */
export const IN_FLIGHT_CHAT_ACTIVITIES: readonly ChatActivity[] = [
  'running',
  'awaiting-permission',
];

/**
 * True when `activity` says the chat's turn is in flight, so any limit pause a
 * surface is still holding for it has ended (see above).
 */
export function clearsLimitPause(activity: string | undefined): boolean {
  return (
    activity !== undefined && (IN_FLIGHT_CHAT_ACTIVITIES as readonly string[]).includes(activity)
  );
}

export const NotifyChannel = z.enum(['push', 'desktop', 'speakers']);
export type NotifyChannel = z.infer<typeof NotifyChannel>;

export const NotifyPriority = z.enum(['silent', 'normal', 'urgent']);
export type NotifyPriority = z.infer<typeof NotifyPriority>;

export const ClientType = z.enum([
  'surface-cli',
  'surface-web',
  'surface-desktop',
  'surface-mobile',
  'surface-voice-device',
  'daemon',
]);
export type ClientType = z.infer<typeof ClientType>;

export const MessageRole = z.enum(['user', 'assistant', 'system']);
export type MessageRole = z.infer<typeof MessageRole>;

/**
 * Composer attachments (spec/14 § Composer, spec/15 § Composer —
 * "Attachments (images + files)"). A `chat.input` / `chat.message` may carry a
 * short list of attachment REFS — never the bytes. The bytes are uploaded
 * out-of-band to `POST /api/chats/:chatId/attachment` (multipart), which stores
 * the file, hands a copy to the host (so Claude can read it by path), and
 * mints the `id`. The ref is what rides the wire; a surface renders it inline by
 * fetching `GET /api/chats/:chatId/attachment/:id`.
 *
 * `kind` is `'image'` when the file's mime type is `image/*` (rendered inline as
 * a thumbnail/picture) and `'file'` otherwise (rendered as a chip/link). Kept
 * separate from `mimeType` so a surface can branch on render style without
 * re-parsing the mime.
 */
export const AttachmentKind = z.enum(['image', 'file']);
export type AttachmentKind = z.infer<typeof AttachmentKind>;

export const AttachmentRef = z
  .object({
    /** Server-minted id (ULID). Addresses the file at `/api/chats/:chatId/attachment/:id`. */
    id: z.string().min(1),
    /** Original filename (for display + the on-disk name Claude reads). */
    name: z.string().min(1),
    mimeType: z.string().min(1),
    kind: AttachmentKind,
  })
  .strict();
export type AttachmentRef = z.infer<typeof AttachmentRef>;

/** Upper bound on attachments per turn — matches the server multipart `files` limit. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

// ---------------------------------------------------------------------------
// Session events (server/host → surfaces)

/**
 * Routing envelope field present on host→server events that are streamed to
 * a SINGLE requesting surface rather than fanned out — i.e. `chat.replay`
 * results and the per-surface re-sync the host emits on (re)connect. The
 * server's `onDaemonEvent` reads it to route to one surface, then STRIPS it
 * before forwarding (so surfaces never see it). It must be an allowed key on
 * every replayable event schema, otherwise the server's strict `decode()`
 * rejects the inbound frame and per-surface replay silently breaks (the host
 * wraps each replayed event with this field — see host `replayChat` /
 * `index.ts` onAuthed). spec/12 § "Sequence-based replay".
 */
const forSurfaceIdField = { forSurfaceId: z.string().min(1).optional() };

// ---------------------------------------------------------------------------
// Host addressing (spec/03 § Host events, spec/02 § Host identity)
//
// There is no longer "the host" — there are N hosts, each running one. Every
// event that describes, addresses, or originates from a machine names it with
// `daemonId`. A frame that omits it is rejected by validation rather than
// routed to whichever host happens to be attached (NO FALLBACK): silently
// picking a host is how a chat ends up running on the wrong filesystem.

/** A registered host's stable id, issued at registration (spec/02 § Host identity). */
export const DaemonId = z.string().min(1);
export type DaemonId = z.infer<typeof DaemonId>;

/** Required host addressing, spread into every host-scoped frame. */
const daemonIdField = { daemonId: DaemonId };

/**
 * Host addressing on a frame whose chat ALREADY pinned its machine at
 * `chat.spawned`. Producers always set it — it is optional only so a consumer
 * decoding a frame from a peer that predates it is not left unable to read the
 * rest of the state.
 */
const daemonIdOptionalField = { daemonId: DaemonId.optional() };

/**
 * The Claude Code permission modes Patch offers, taken as-is (spec/02 §
 * Permission mode). Patch adds no mode of its own — a value outside this set is
 * a validation failure naming the offending value, never coerced to the
 * default. `dontAsk` is deliberately absent: with no interactive prompt channel
 * it is indistinguishable from `default`, so offering both would be a choice
 * without a consequence.
 */
export const PermissionMode = z.enum([
  'auto',
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
]);
export type PermissionMode = z.infer<typeof PermissionMode>;

/**
 * The Claude Code backend's id (spec/02 § Agent backends: "The backend in use
 * is Claude Code"). It lives in the wire package because every credential,
 * catalogue entry and account report on the protocol is keyed by backend id —
 * a surface has to name a backend to connect one, so it needs the id the
 * host will recognise. Adding a second backend must not be a breaking wire
 * change, which is why these are ids and not a boolean.
 */
export const CLAUDE_BACKEND_ID = 'claude-code';

/**
 * A host's question-expiry window (spec/02 § Questions are not approvals), in
 * seconds, and the bounds the setting is clamped to on the wire.
 *
 * The floor exists because the window has to be long enough to read the
 * question in: below a few seconds the card would expire while it was still
 * being drawn. The ceiling keeps a mistyped value from being indistinguishable
 * from the feature being off, which is what the separate on/off flag is for.
 */
export const QUESTION_EXPIRY_SECONDS_DEFAULT = 600;
export const QUESTION_EXPIRY_SECONDS_MIN = 5;
export const QUESTION_EXPIRY_SECONDS_MAX = 3600;

/** An agent backend provisioned on a host (spec/02 § Agent backends). */
export const HostBackend = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    /** The resolved backend executable's version; null until it resolves. */
    version: z.string().min(1).nullable(),
    state: z.enum(['present', 'installing', 'absent', 'logged-out', 'failed']),
    /** Why `failed`/`absent`, verbatim. Absent otherwise. */
    error: z.string().min(1).optional(),
  })
  .strict();
export type HostBackend = z.infer<typeof HostBackend>;

/** State of one optional component on one host (spec/02 § Optional components). */
export const HostComponentState = z.enum(['not-installed', 'downloading', 'installed', 'failed']);
export type HostComponentState = z.infer<typeof HostComponentState>;

export const HostComponent = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    /** Download size in bytes, so a surface can say "340 MB" before starting. */
    bytes: z.number().int().nonnegative(),
    state: HostComponentState,
    /** 0..1 while `downloading`. */
    progress: z.number().min(0).max(1).optional(),
    error: z.string().min(1).optional(),
  })
  .strict();
export type HostComponent = z.infer<typeof HostComponent>;

export const ChatSpawnedEvent = z
  .object({
    type: z.literal('chat.spawned'),
    chatId: z.string().min(1),
    /** The host this chat is pinned to, fixed for the chat's lifetime. */
    ...daemonIdField,
    folder: z.string().min(1),
    parentChatId: z.string().min(1).optional(),
    ...forSurfaceIdField,
    /**
     * The job whose `spawn` action created this chat (spec/08 § Action), or
     * absent for a chat spawned by a user/surface. Server-populated only —
     * the host has no notion of jobs — so this is optional purely for
     * back-compat with an older host that has never heard of it; a host
     * never needs to (and never does) set it itself.
     */
    jobId: z.string().min(1).optional(),
    /**
     * The model this chat resolved to at spawn (spec/04 § Spawn) — the
     * request's named model, else the host's last-used one. Fixed for the
     * chat's life, same as `folder`. Optional purely for back-compat with an
     * older host that has never heard of this field, or one with no model
     * catalogue support configured at all (e.g. a minimal test host) — the
     * chat still spawns, it just has no model to report.
     */
    model: z.string().min(1).optional(),
  })
  .strict();
export type ChatSpawnedEvent = z.infer<typeof ChatSpawnedEvent>;

/** Whether the agent compacted on its own or the user asked for it. */
export const CompactionTrigger = z.enum(['auto', 'manual']);
export type CompactionTrigger = z.infer<typeof CompactionTrigger>;

/**
 * The figures behind a context compression (spec/02 § Context compression),
 * carried on the `system` `chat.message` that marks the boundary. `postTokens`
 * and `durationMs` are optional because the SDK does not always report them —
 * a surface omits what it wasn't given rather than showing a guess.
 */
export const MessageCompaction = z
  .object({
    trigger: CompactionTrigger,
    preTokens: z.number().int().nonnegative(),
    postTokens: z.number().int().nonnegative().optional(),
    durationMs: z.number().int().nonnegative().optional(),
  })
  .strict();
export type MessageCompaction = z.infer<typeof MessageCompaction>;

/**
 * One injected `<system-reminder>` block a turn actually received, carried
 * out-of-band from `content` rather than inlined into it (spec/02 §
 * System-reminder disclosure). Patch prepends several of these across a
 * chat's life — a daemon-restart notice, a rewritten todo list, a broadcast
 * digest — and used to strip every one of them before persistence/display, so
 * a reply reacting to one read as reacting to nothing. `source` says who
 * injected it: `patch` for the host's own mechanism (today the only kind
 * ever emitted — see spec/02 § System-reminder disclosure); `sdk` remains
 * reserved for a future one-off block genuinely scoped to a single turn's
 * prompt the way Patch's own five are. Claude Code's OWN recurring
 * provider-level context (environment, token counts, and the rest) turned out
 * NOT to fit this shape — it isn't scoped to one turn's prompt, and the same
 * kind recurs constantly within a session — so that got its own event,
 * `ChatProviderContextEvent` below, rather than a `source: 'sdk'` item here.
 * `label` is a short, human-readable name for what the block was (e.g. "Turn
 * interrupted by restart"); `text` is the block's raw inner text, unmodified.
 */
export const SystemContextItem = z
  .object({
    source: z.enum(['patch', 'sdk']),
    label: z.string().min(1),
    text: z.string().min(1),
  })
  .strict();
export type SystemContextItem = z.infer<typeof SystemContextItem>;

export const ChatMessageEvent = z
  .object({
    type: z.literal('chat.message'),
    chatId: z.string().min(1),
    role: MessageRole,
    content: z.string(),
    seq: z.number().int().nonnegative(),
    /**
     * Every leading `<system-reminder>` block this turn's prompt actually
     * carried, stripped from `content` at the same point they always were
     * (spec/02 § System-reminder disclosure), but captured here instead of
     * discarded. Present only on the user turn that received them, in the
     * order they appeared. Additive/optional for the same reason as
     * `compaction`: a host older than the server never sends it, and the
     * message it does send still validates.
     */
    systemContext: z.array(SystemContextItem).min(1).optional(),
    /**
     * Attachments carried by a user turn (spec/14 & spec/15 § Composer). Refs
     * only — surfaces render each inline by fetching
     * `GET /api/chats/:chatId/attachment/:id`. Additive/optional so existing
     * text-only messages are unchanged.
     */
    attachments: z.array(AttachmentRef).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
    /**
     * Echo of the `localId` the surface sent on `chat.input`, on the PERSISTED
     * user turn. A surface renders its own message optimistically the instant
     * it sends, and reconciles the persisted copy against this id. Without it
     * there was nothing to match on, so both copies rendered and every first
     * message appeared twice — the schema being `.strict()` meant the host
     * could not send the field even though the surface's contract required it.
     * Absent on assistant turns, and on user turns with no originating surface
     * (a trigger, a replay of an older transcript).
     */
    localId: z.string().min(1).optional(),
    /**
     * Present ONLY on the `system` message marking a context compression
     * (spec/02 § Context compression). Additive/optional for the same reason as
     * `attachments`: a host older than the server never sends it, and the
     * message it does send still validates.
     */
    compaction: MessageCompaction.optional(),
    /**
     * Present ONLY on the `system` message marking a change of this chat's
     * permission mode made part-way through the conversation (spec/02 §
     * Permission mode) — the mode the chat moved TO. Additive/optional for the
     * same reason as `compaction`: a host older than the server never sends
     * it, and the message it does send still validates. It rides on
     * `chat.message` rather than taking an event type of its own so a surface
     * that has not been updated still renders the record as the plain system
     * line its `content` already reads as, instead of refusing the frame.
     */
    permissionModeChange: PermissionMode.optional(),
    /**
     * Rides alongside `permissionModeChange`, `true` only when Claude Code
     * made the change itself rather than the mode control (spec/02 §
     * Permission mode's plan-mode exception — the one substitution target
     * that runs on instead of erroring the chat). Absent for a change made
     * from the mode control, and absent whenever `permissionModeChange` is,
     * for the same daemon-may-predate-this reason `compaction` is optional.
     */
    permissionModeChangeAutomatic: z.literal(true).optional(),
    /**
     * Present ONLY on the `system` line marking a turn that ran on a different
     * account because the one before had run out of credit (spec/10 § Backend
     * credentials — which account a turn ran on). `from`/`to` are account
     * labels; `until` is when `from` comes back, when it said. A surface renders
     * `until` in the reader's own zone; `content` reads without it.
     */
    accountSwitch: z
      .object({
        from: z.string().min(1),
        to: z.string().min(1),
        until: z.number().int().optional(),
      })
      .strict()
      .optional(),
    /**
     * Present ONLY on a user turn the host is RE-SENDING on the user's behalf
     * — a turn a host restart cut in half and `resumeInterruptedTurns` put
     * back, or a rung of the SDK-error retry ladder (spec/12 § A turn is owed
     * until it settles). It carries the `seq` of the ORIGINAL user message for
     * that turn, so a surface folds this copy into the bubble already on screen
     * instead of drawing the same message a second time.
     *
     * It is the ORIGINAL's seq on every rung, never the previous rung's: a turn
     * retried three times is one bubble with three attempts hanging off it, not
     * a chain of three bubbles.
     *
     * A surface NEVER sends this — a user retyping the same thing is a new turn,
     * not an attempt at an old one.
     *
     * Additive/optional for the same reason as `compaction`: hosts OTA their
     * host separately from the server, so a host older than the surface
     * never sends it and its frame must still decode.
     */
    retryOfSeq: z.number().int().nonnegative().optional(),
    /**
     * Present ONLY on a user-role turn that a job fired into the chat (spec/08
     * § Action: a `continue`/`message` action's fire into an existing chat,
     * never the `spawn` action's own opening prompt, which has no `chat.input`
     * to carry this and is flagged a different way — spec/14 § Job trigger
     * turn). Set by the host from that turn's `chat.input.source.kind ===
     * 'job'`. A surface renders it as the same quiet transcript furniture as
     * the spawn case rather than a user bubble. Additive/optional for the same
     * reason as `compaction`: a host older than the server never sends it,
     * and the message it does send still validates — it just renders as an
     * ordinary bubble, same as before this field existed.
     */
    jobTrigger: z.literal(true).optional(),
    /**
     * Present ONLY on a user-role turn the host fired because an
     * `agent_response` hook's `block` outcome needs the agent to redo its
     * answer (spec/20-hooks.md § On the agent's response). Carries the
     * blocking hook(s)' own name and analysis — the turn's `content` IS this,
     * verbatim (no invisible injection: what rides to the agent is what the
     * row shows). A surface renders it as the same quiet transcript furniture
     * as a job trigger turn, not a user bubble. Additive/optional for the
     * same reason as `compaction`.
     */
    hookTrigger: z
      .object({
        hooks: z.array(
          z.object({ hookId: z.string().min(1), hookName: z.string().min(1) }).strict(),
        ),
      })
      .strict()
      .optional(),
    /**
     * Present ONLY on a user-role turn the host fired because the chat's
     * goal evaluator judged the condition `not_met` (spec/04 § Goals). Carries
     * the evaluator's own reason — the turn's `content` IS this, verbatim. A
     * surface renders it as the same quiet transcript furniture as a hook
     * block's resubmit. Additive/optional for the same reason as `compaction`.
     */
    goalTrigger: z.object({ reason: z.string() }).strict().optional(),
    /**
     * Present ONLY on a `system` message whose `content` Claude Code wrote
     * itself and stamped `model: "<synthetic>"` — most often `No response
     * requested.`, the placeholder it puts after a turn that ended with nothing
     * to answer (spec/02 § Per-turn process / warm sessions). It is not the
     * agent speaking, so
     * a surface renders it as a muted line attributed to Claude Code, never as
     * a reply. Additive/optional for the same reason as `compaction`: a surface
     * that predates it renders the plain system line its `content` reads as.
     */
    synthetic: z.literal(true).optional(),
    /**
     * Present ONLY on a `system` message that reports a failure the host itself
     * raised (a turn that failed, an unreadable transcript line, a truncated
     * history). It is not the agent speaking, so a surface renders it as an
     * error card (the same one a live `chat.error` draws), never as a plain
     * paragraph. Additive/optional for the same reason as `compaction`.
     */
    error: z.literal(true).optional(),
    /**
     * ms epoch this turn was actually written — the moment Claude Code
     * persisted it (read back off the transcript's own `timestamp` on replay)
     * or the moment the host minted it (a live turn, a rotation/degrade
     * marker). Distinct from a surface's own bookkeeping of when the FRAME
     * arrived over the socket, which is "now" on every replay and therefore
     * useless as a message time (spec/14 § Messages — the per-message meta
     * strip waited for exactly this field rather than show that).
     *
     * Additive/optional for the same reason as `compaction`: a host older
     * than the server never sends it, and the message it does send still
     * validates — a surface simply has nothing to show for that message's
     * time rather than inventing one.
     */
    createdAt: z.number().int().nonnegative().optional(),
    /**
     * Present ONLY on the `system` message marking that the chat moved onto a
     * new harness session — another harness or model, seeded from the chat's
     * own history (spec/04 § History). `seededMessages` is how many of the
     * chat's messages the new session was given. Additive/optional for the same
     * reason as `compaction`.
     */
    sessionChange: z
      .object({
        harness: HarnessId,
        model: z.string().min(1),
        seededMessages: z.number().int().nonnegative(),
        /**
         * Set only when the new harness couldn't fit the whole track and the
         * oldest records were dropped to make it fit (spec/04 § History —
         * Codex has no auto-compaction of its own for an injected thread).
         */
        trimmedRecords: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    /**
     * Present ONLY on the quiet row a side branch's send-back posts into its
     * parent track (spec/04 § Send back). `fromBranchName` is `null` when the
     * branch was never named. Additive/optional for the same reason as
     * `compaction`.
     */
    branchSendBack: z
      .object({
        fromBranchId: z.string().min(1),
        fromBranchName: z.string().min(1).nullable(),
      })
      .strict()
      .optional(),
    /**
     * Present ONLY on a user message that reached the agent in the middle of a
     * turn, at a tool boundary, rather than starting a turn of its own
     * (spec/04 § Message delivery). The message sits in the transcript at the
     * point the agent saw it. Additive/optional like `compaction`.
     */
    midTurn: z.literal(true).optional(),
    ...forSurfaceIdField,
  })
  .strict();
export type ChatMessageEvent = z.infer<typeof ChatMessageEvent>;

/**
 * Delivery receipt (spec/12 § Guaranteed input delivery). The host emits this
 * the moment it ACCEPTS an input for processing — for BOTH the run-now path and
 * the queued-behind-a-running-turn path, and again on a duplicate-`localId`
 * redelivery (it is a receipt, so the surface's retry gets answered) WITHOUT
 * re-running the turn. It is the positive signal that retires a surface's
 * `pending` state before any output streams, distinguishing "delivered,
 * working" from "lost to a flap / server restart".
 *
 * Carries NO `seq`: it is out-of-band and is NEVER persisted or replayed (unlike
 * every `chat.*` stream event). Correlated to the originating `chat.input`
 * purely by `(chatId, localId)`.
 */
export const ChatInputAckEvent = z
  .object({
    type: z.literal('chat.input_ack'),
    chatId: z.string().min(1),
    /** The originating `chat.input.localId` this ack retires. */
    localId: z.string().min(1),
    ...forSurfaceIdField,
  })
  .strict();
export type ChatInputAckEvent = z.infer<typeof ChatInputAckEvent>;

/**
 * Live-only incremental text for an in-flight assistant turn (spec/02 — the
 * SDK is driven with `includePartialMessages`, so chat text arrives as a
 * stream of token/chunk deltas before the turn's final `chat.message`).
 *
 * Mirrors the audio partial pattern (`audio.transcript_partial`): it is a
 * TRANSIENT live event and is NOT persisted / NOT replayed. The durable
 * record of the turn is the final `chat.message` (same `seq` as `messageSeq`
 * here), which is what `chat.replay` / `patch_history` reconstruct. A surface
 * accumulates `delta`s keyed by `messageSeq` to render the reply progressively,
 * then the matching `chat.message` arrives carrying the complete text and
 * supersedes the accumulator. Carries no own `seq` (not a replayable stream
 * event); `messageSeq` is the seq the finalising `chat.message` will use.
 */
export const ChatMessageDeltaEvent = z
  .object({
    type: z.literal('chat.message_delta'),
    chatId: z.string().min(1),
    /** Seq the finalising `chat.message` for this turn will carry. */
    messageSeq: z.number().int().nonnegative(),
    /** Incremental text chunk to append to the accumulator for `messageSeq`. */
    delta: z.string(),
    ...forSurfaceIdField,
  })
  .strict();
export type ChatMessageDeltaEvent = z.infer<typeof ChatMessageDeltaEvent>;

export const ChatToolCallEvent = z
  .object({
    type: z.literal('chat.tool_call'),
    chatId: z.string().min(1),
    tool: z.string().min(1),
    // Tool args are open-ended JSON. We validate `unknown` and let the recipient
    // (which knows the tool schema) refine.
    args: z.unknown(),
    callId: z.string().min(1),
    seq: z.number().int().nonnegative(),
    // Epoch ms the call actually started: stamped by the host when it fires
    // live, the transcript's own timestamp on replay. A surface times a
    // running call from this, never from when it happened to receive the
    // event. Absent only when a replayed line carries no usable timestamp.
    startedAt: z.number().int().nonnegative().optional(),
    ...forSurfaceIdField,
  })
  .strict();
export type ChatToolCallEvent = z.infer<typeof ChatToolCallEvent>;

export const ChatToolResultEvent = z
  .object({
    type: z.literal('chat.tool_result'),
    chatId: z.string().min(1),
    tool: z.string().min(1),
    callId: z.string().min(1),
    // Most tool results are opaque (a Bash stdout string, an arbitrary JSON
    // blob) with no single shape to constrain — same rationale as
    // `ChatToolCallEvent.args` above, so this validates `unknown` and lets
    // each recipient refine for itself. One shape IS well-known though: the
    // Claude Agent SDK's own `tool_result` content (spec/02) is Anthropic's
    // content-block array — `{ type: 'text', text }` / `{ type: 'image',
    // source: { type: 'base64', media_type, data } }` — verbatim from the
    // model's own conversation, e.g. what `Read` returns for an image file.
    // The host (`chatRunner.ts`, `sdkBackend.ts`, `history.ts`) passes this
    // straight through unmodified rather than flattening it, specifically so
    // a surface (`packages/web/src/routes/ChatRoute.tsx`'s `imageDataUri`)
    // can detect an image block and render it as a picture instead of a wall
    // of base64 text. See `ChatToolResultContentBlock` below for that shape —
    // deliberately a plain type, not a schema on this field, so a result that
    // ISN'T structured content (the common case) is never rejected.
    result: z.unknown(),
    isError: z.boolean().optional(),
    seq: z.number().int().nonnegative(),
    ...forSurfaceIdField,
  })
  .strict();
export type ChatToolResultEvent = z.infer<typeof ChatToolResultEvent>;

/**
 * One piece of Claude Code's OWN provider-level context a turn actually
 * received — its own `type: "attachment"` transcript entries (environment,
 * model identity, the day's date, an instruction file that changed, the
 * skill/agent/tool listings, a remaining-token count, ...), as distinct from
 * one of Patch's five hand-injected `<system-reminder>` builders
 * (`SystemContextItem` above).
 *
 * Unlike `SystemContextItem` (attached to the ONE turn whose prompt carried
 * it, one row per occurrence), these recur constantly within a single
 * session — a token-count reminder or a tool-bookkeeping record can fire
 * hundreds of times — so this is NOT "one row per occurrence". `providerType`
 * is the stable dedup key (Claude Code's own `attachment.type`, e.g.
 * `"environment"` / `"total_tokens_reminder"`): a surface keeps ONE row per
 * `providerType` per chat, upserting `label`/`text` to the latest occurrence
 * and counting repeats, rather than accumulating a row per event (spec/02 §
 * Provider-level context).
 */
export const ChatProviderContextEvent = z
  .object({
    type: z.literal('chat.provider_context'),
    chatId: z.string().min(1),
    providerType: z.string().min(1),
    label: z.string().min(1),
    text: z.string().min(1),
    seq: z.number().int().nonnegative(),
    ...forSurfaceIdField,
  })
  .strict();
export type ChatProviderContextEvent = z.infer<typeof ChatProviderContextEvent>;

/**
 * One block of a tool result's structured `content`, when it IS Anthropic's
 * content-block shape (see the comment on `ChatToolResultEvent.result`
 * above). Exported so any consumer that wants to detect an image (currently
 * only `ChatRoute.tsx`'s `imageDataUri`) narrows against one documented
 * shape instead of re-deriving field names ad hoc. Deliberately loose
 * (`media_type`/`data` as plain `string`, no `.strict()` zod schema) — a real
 * `ImageBlockParam` may carry additional fields (e.g. `cache_control`) that
 * must NOT stop it from being recognised as an image.
 */
export type ChatToolResultContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'image'; source: BlobImageSource };

/**
 * An image block whose bytes live in the blob store instead of inline base64
 * (spec/04 § History — blobs). The host swaps every `base64` source for one
 * of these when it logs a tool result, and replay never sends anything else:
 * 1,507 inline images across Tom's logs account for 317 MB of base64, which is
 * most of what made opening a long chat slow.
 *
 * The surface renders `<img src="/api/chats/:chatId/blob/:$blob">`, so the
 * browser streams and caches the picture on its own schedule instead of the
 * transcript carrying it. `width`/`height` are the real pixel size read out of
 * the image header, so the box is reserved at the correct aspect ratio before
 * a single byte arrives and nothing below it moves when it lands.
 */
export type BlobImageSource = {
  type: 'blob';
  $blob: string;
  media_type: string;
  bytes: number;
  width?: number;
  height?: number;
};

// ---------------------------------------------------------------------------
// Artifacts (spec/14 § Artifacts) — Patch's own version of the Artifact tool.
//
// The agent calls `patch_artifact({ path, title? })`; the host reads the HTML
// file, ships it to the server (`patch.artifact.publish_request` →
// `patch.artifact.publish_response`), and then stamps this SLIM event into the
// chat's stream. The event never carries the page body — surfaces fetch the
// published URL — so replay stays cheap.
export const ChatArtifactEvent = z
  .object({
    type: z.literal('chat.artifact'),
    chatId: z.string().min(1),
    /** Stable per (chat, source path): republishing the same file updates it. */
    artifactId: z.string().min(1),
    title: z.string().min(1),
    /** Server path the page is served from (`/api/chats/:id/artifact/:aid`). */
    url: z.string().min(1),
    /** Source file (chat-folder-relative) the artifact was published from. */
    path: z.string().min(1),
    updatedAt: z.number().int().nonnegative(),
    seq: z.number().int().nonnegative(),
    ...forSurfaceIdField,
  })
  .strict();
export type ChatArtifactEvent = z.infer<typeof ChatArtifactEvent>;

// ---------------------------------------------------------------------------
// Tool-run summaries (spec/14 § Main chat panel — "Tool runs collapse to one
// row"). When a run of more than one groupable tool call closes, the host asks
// a small model what the run accomplished and stamps the answer here, keyed by
// the run's call ids. It is NOT a transcript row: surfaces hang it on the
// collapsed run whose calls it names. `summary` is null exactly when generation
// failed, and `error` then says why — a run is never silently left unlabelled.
export const ChatToolRunSummaryEvent = z
  .object({
    type: z.literal('chat.tool_run_summary'),
    chatId: z.string().min(1),
    /** The run's tool-call ids, in order. */
    callIds: z.array(z.string().min(1)).min(2),
    summary: z.string().min(1).nullable(),
    error: z.string().min(1).optional(),
    seq: z.number().int().nonnegative(),
    ...forSurfaceIdField,
  })
  .strict();
export type ChatToolRunSummaryEvent = z.infer<typeof ChatToolRunSummaryEvent>;

export const ChatPermissionRequestEvent = z
  .object({
    type: z.literal('chat.permission_request'),
    chatId: z.string().min(1),
    requestId: z.string().min(1),
    request: z
      .object({
        tool: z.string().min(1),
        args: z.unknown(),
        description: z.string().optional(),
        /**
         * Group 19: when the agent invokes a file-edit tool (Edit, Write,
         * NotebookEdit) the host attaches the unified diff text the user
         * is being asked to approve. Surfaces with a Monaco editor render
         * this diff in their right-rail and let the user tweak it before
         * approving. `null` (or omitted) means the surface should fall
         * back to rendering a plain args summary.
         */
        proposedDiff: z.string().nullable().optional(),
      })
      .strict(),
    seq: z.number().int().nonnegative(),
    /**
     * When the host will resolve this request itself if nobody has answered
     * (spec/02 § Questions are not approvals). ABSENT means the request does
     * not expire — a host with question expiry turned off, or a host older
     * than this field.
     *
     * `at` is an absolute instant, not a duration: the host re-emits a
     * still-pending request verbatim to a surface that connects after it was
     * asked (spec/12 § replay), and a duration measured from whenever the
     * frame happened to arrive would restart the countdown on every
     * reconnect.
     *
     * `windowMs` is the whole window the request was given. ONE OBJECT rather
     * than two sibling fields because neither half is any use alone: a
     * countdown that depletes needs both where it ends and how far it has to
     * fall, and a surface holding only the deadline would have to invent the
     * start — drawing a full ring for a question that is already most of the
     * way gone.
     */
    expiry: z
      .object({
        at: z.number().int().positive(),
        windowMs: z.number().int().positive(),
      })
      .strict()
      .optional(),
    /**
     * Which branch this request belongs to (spec/04 § Branching — "permission
     * … address a branch, not only the chat"). Absent means the chat's active
     * branch, so an older host's frame (or the common single-track chat)
     * still reads correctly with no branch-aware handling at all.
     */
    branchId: z.string().min(1).optional(),
    ...forSurfaceIdField,
  })
  .strict();
export type ChatPermissionRequestEvent = z.infer<typeof ChatPermissionRequestEvent>;

/**
 * A still-outstanding question's deadline moved (`02-daemon.md` § Questions
 * are not approvals): a surface's `chat.focus_change` named this chat, or
 * named something else after previously naming it, and the host gave the
 * question a fresh full window either way. `requestId` ties it to the
 * `chat.permission_request` it updates; `expiry` is the same `{at,
 * windowMs}` shape, always present — there is nothing to reset on a request
 * that carries no deadline at all.
 */
export const ChatPermissionExpiryUpdateEvent = z
  .object({
    type: z.literal('chat.permission_expiry_update'),
    chatId: z.string().min(1),
    requestId: z.string().min(1),
    expiry: z
      .object({
        at: z.number().int().positive(),
        windowMs: z.number().int().positive(),
      })
      .strict(),
    seq: z.number().int().nonnegative(),
    ...forSurfaceIdField,
  })
  .strict();
export type ChatPermissionExpiryUpdateEvent = z.infer<typeof ChatPermissionExpiryUpdateEvent>;

/** One reading of a chat's context window (spec/14 § Composer — context ring). */
export const ChatContextUsage = z
  .object({
    usedTokens: z.number().int().nonnegative(),
    /** Absent until a turn's result has named the model's window. */
    windowTokens: z.number().int().positive().optional(),
    /** ms-epoch the reading was taken. */
    at: z.number().int(),
  })
  .strict();
export type ChatContextUsage = z.infer<typeof ChatContextUsage>;

/** Live progress on a chat's active goal (spec/04 § Goals). */
export const GoalProgress = z
  .object({
    /** ms epoch the current goal was set. */
    startedAt: z.number().int(),
    /** How many settled turns the evaluator has judged this goal against. */
    turnsEvaluated: z.number().int().nonnegative(),
    /** Running total of input tokens the evaluator + resubmitted turns have spent. */
    tokensSpent: z.number().int().nonnegative(),
    /** The evaluator's most recent verdict, or `null` before the first one lands. */
    lastVerdict: z.literal('not_met').nullable(),
    /** The evaluator's most recent reason, or `null` before the first one lands. */
    lastReason: z.string().nullable(),
  })
  .strict();
export type GoalProgress = z.infer<typeof GoalProgress>;

/** A chat's most recently FINISHED goal (spec/04 § Goals). */
export const FinishedGoal = z
  .object({
    condition: z.string().min(1),
    startedAt: z.number().int(),
    endedAt: z.number().int(),
    turns: z.number().int().nonnegative(),
    tokens: z.number().int().nonnegative(),
    outcome: z.enum(['met', 'impossible']),
    reason: z.string(),
  })
  .strict();
export type FinishedGoal = z.infer<typeof FinishedGoal>;

/**
 * How a backend picks which of the shared accounts a turn starts on (spec/10 §
 * Backend credentials — account strategy). Whatever the strategy, a key known
 * to be out of credit is skipped, and a chat's preferred account only changes
 * where the walk starts.
 */
export const AccountStrategy = z.enum(['priority', 'round-robin', 'soonest-reset', 'least-used']);
export type AccountStrategy = z.infer<typeof AccountStrategy>;

export const ChatStateEvent = z
  .object({
    type: z.literal('chat.state'),
    /**
     * The account this chat's current — or most recent — turn ran on (spec/10 §
     * Backend credentials — which account a turn ran on). Absent before the
     * chat has run a turn on this host, and on a backend with no accounts.
     */
    account: z
      .object({ id: z.string().min(1), label: z.string().min(1) })
      .strict()
      .optional(),
    chatId: z.string().min(1),
    /**
     * The highest seq this host's own log of the chat has recorded. The server
     * compares it with what it has committed: a host ahead is asked for what the
     * server missed (`patch.log_sync.request`), a host behind is given what it
     * lost (`patch.log_restore`). Optional: an older host never says.
     */
    lastSeq: z.number().int().nonnegative().optional(),
    /**
     * The machine this chat is pinned to (spec/03 § Host events). `chat.spawned`
     * establishes it for the chat's life; carrying it here too means a surface
     * that groups its sidebar by machine never has to hold a chatId → machine
     * map of its own, and the server's mirror never has to guess when a
     * `chat.state` is the first thing it hears about a chat.
     */
    ...daemonIdOptionalField,
    activity: ChatActivity,
    lastUpdated: z.number().int(),
    /**
     * ms epoch of the user's own last activity on this chat (spec/14 §
     * Sidebar ordering): when they last sent a message, or chat creation if
     * they never have. Drives sidebar ordering instead of `lastUpdated` — an
     * agent reply, a status change, a job tick or a finished turn bumps
     * `lastUpdated` but never this, so none of them moves the chat's row.
     * Optional: a host predating the field never sends it, and a surface
     * on an old host keeps whatever it last knew (falling back further to
     * `lastUpdated` only has the old recency-sorts-everything behaviour to
     * fall back to, which is no worse than before this field existed).
     */
    lastUserActivity: z.number().int().optional(),
    /**
     * The EFFECTIVE permission mode the NEXT turn will use — already resolved
     * by the host through chat override → host default → `auto`
     * (spec/02 § Permission mode). A surface renders this value directly; it
     * does not re-derive it, because it does not know the host's default and
     * would have to guess.
     */
    permissionMode: PermissionMode,
    /**
     * The model the chat's NEXT turn will run on (spec/04 § Model). Carried on
     * every state emit, not only on the one that changed it, so a surface that
     * joins late or reconnects converges on the truth without asking.
     *
     * This is what makes a model change reach the OTHER surfaces holding the
     * chat — two windows on one chat must not disagree about what it is running
     * on — and it doubles as the host's acknowledgement of a
     * `chat.model_request`.
     *
     * Optional, and its absence is meaningful in two different ways that the
     * surface must not conflate: a host predating this field NEVER sends it
     * (so a model change on that host cannot be confirmed and is reported as
     * failed, per spec/14 § Model selector), and a host with no model
     * catalogue wired at all has no model to report for the chat. Neither is a
     * reason to invent one, so absent means "unchanged, and don't guess".
     */
    model: z.string().min(1).optional(),
    /**
     * Who started the turn this state belongs to (spec/09 § Whose turn it was).
     * The server reads it on the running → idle edge to decide whether the turn
     * settling is worth a chat-completion notification: a `machine` turn — a
     * self-wake tick, a todo auto-advance, an agent's `send_to` — is silent.
     *
     * Optional, and absent means `user`. A host predating the field never
     * sends it, and reading that as `user` keeps exactly the behaviour that
     * host already had rather than silencing it.
     */
    turnOrigin: TurnOrigin.optional(),
    /**
     * The turn this state belongs to was STOPPED by the user rather than
     * allowed to finish (spec/09 § A turn the user stopped). Stamped when the
     * stop aborts the turn and cleared as the next turn goes `running`, so it
     * describes one turn and never silences the chat beyond it.
     *
     * The server reads it on the running → idle edge to withhold the
     * chat-completion notification and the Manager's finished-its-turn watch
     * edge. It has to ride on this frame rather than being inferred from
     * `chat.stopped`, because the two are emitted by independent awaiters of
     * the aborted run and their order differs by case: a bare stop settles
     * `idle` BEFORE the stop is announced, while a stop with turns queued
     * behind it announces the stop first and does not settle at all until the
     * drain reaches its true end (spec/04 § Message queueing).
     *
     * Optional, and absent means "not stopped". A host predating the field
     * never sends it, so a chat on that host still announces a stopped turn as
     * finished — the behaviour it already had.
     */
    turnStopped: z.boolean().optional(),
    /**
     * Whether the host will run this errored turn again on its own — a rung
     * of the SDK-error retry ladder is armed (spec/09 § A turn that failed).
     * Stamped on the frame that flips the chat `errored`, so the server can
     * tell a failure that is final from one the ladder will try again, and
     * cleared as the next turn goes `running`.
     *
     * Optional, and absent means "not retrying". A host predating the field
     * never sends it, so every rung of its ladder reads as a final failure —
     * one notification too many per rung, never one too few.
     */
    turnRetrying: z.boolean().optional(),
    /**
     * How many of this chat's background commands and sub-agents are still
     * RUNNING (spec/02 § Background task completions, spec/14 § Status badges).
     *
     * A backgrounded `Bash` command or `Task` sub-agent outlives the turn that
     * launched it, so a chat settles `idle` with work still in flight. The
     * sidebar reads `idle` and draws the finished tick — it holds every chat but
     * the transcript of none, so it has no way of its own to know better. The
     * host does: it folds its own outgoing stream with the shared rules in
     * `background-task-tracking.ts` and reports the count here.
     *
     * Optional, and its ABSENCE IS NOT ZERO. A host predating this field never
     * sends it, and reading that as "nothing running" would state as fact
     * something nobody measured — so a surface shows no background state at all
     * rather than guessing one (spec/12 — NO FALLBACK). `0` is the positive
     * claim that nothing is running, and only a host that tracks them sends it.
     */
    backgroundTasks: z.number().int().nonnegative().optional(),
    /**
     * How full the chat's context window is (spec/14 § Composer — context
     * ring): the tokens the model read on the chat's latest request, against
     * the window its model has. `null` when nothing has been measured — a chat
     * that has run no Claude turn, or a Codex chat — and ABSENT from a host
     * predating the field. Neither is zero, so a surface draws no ring for
     * either.
     */
    context: ChatContextUsage.nullable().optional(),
    /** Pinned in the sidebar (spec/04 ## Pinning). Optional for back-compat. */
    pinned: z.boolean().optional(),
    /**
     * A special thread (Manager/Speakers) turned off (spec/06 §
     * Disabled). Distinct from `disabledTools`, which is a per-chat tool
     * allowlist toggle unrelated to this. Only meaningful for the three
     * special threads — archive/snooze/delete are what regular chats use
     * instead, and are refused for special threads. Optional and absent means
     * not disabled, so a host predating the field reads as fully on.
     */
    disabled: z.boolean().optional(),
    /** Lifecycle status: active or archived (spec/04 ## Chat model). */
    status: ChatStatus.optional(),
    /** Sidebar label override (spec/04). */
    name: z.string().nullable().optional(),
    /**
     * One-line snippet of the chat's first user message (G2-d4). Lets the
     * sidebar — especially the archived list, whose rows are never opened so
     * carry no live timeline — give every otherwise-unnamed row an
     * individually distinguishing label even when several chats share a
     * folder basename. `null` until the first user turn lands.
     */
    preview: z.string().nullable().optional(),
    /**
     * The chat's goal (patch/todo.md — `/goal`). Set from any surface's composer
     * via `/goal <text>` and shown at the top of the chat so the user can always
     * see what the agent is working towards. `null` when no goal is set; optional
     * for back-compat with payloads predating the feature.
     */
    goal: z.string().nullable().optional(),
    /**
     * Live progress on the chat's ACTIVE goal (spec/04 § Goals) — `null`
     * exactly when `goal` is `null`; optional for back-compat.
     */
    goalProgress: GoalProgress.nullable().optional(),
    /**
     * The chat's most recently FINISHED goal (spec/04 § Goals — "A finished
     * goal stays viewable from the chat header"). `null` until one has
     * resolved met/impossible; optional for back-compat.
     */
    lastGoal: FinishedGoal.nullable().optional(),
    /**
     * The chat's reminder (patch/todo.md — Reminders). A configurable reminder to
     * do / not do something, set from any surface's composer via `/remind <text>`
     * and shown at the top of the chat as a banner so the user can always see it.
     * `null` when no reminder is set; optional for back-compat with payloads
     * predating the feature.
     */
    reminder: z.string().nullable().optional(),
    /**
     * Auto-generated one-line "current status" summary of the thread and any
     * action it needs from the user (patch/todo.md § Features to add — "Current
     * status"). Regenerated after each turn settles; shown nested under the chat
     * row. `null` until the first summary lands; optional for back-compat.
     */
    statusSummary: z.string().nullable().optional(),
    /**
     * The CLOSING TEXT of the turn this state belongs to — the last thing the
     * agent itself said before the chat settled, trimmed and cut to a length a
     * notification can carry (`09-notifications.md` § What the message says).
     *
     * Distinct from `statusSummary` in both authorship and timing, which is why
     * it is its own field rather than an early write to that one. `statusSummary`
     * is a MODEL'S reading of the settled thread, produced by a separate call
     * that lands on a LATER `chat.state` than the settling one — so the server's
     * chat-completion doorbell, which fires on the running → idle edge, usually
     * saw no summary at all and fell back to naming the chat after its FIRST
     * message. This is the agent's own words, already in the host's hand when
     * the turn settles, so it rides on the settling frame itself.
     *
     * Describes ONE settled turn: cleared as the next turn goes `running`, like
     * `turnStopped`, so a settling frame never quotes the previous turn.
     *
     * Optional, and absent means "this frame offers no closing text" — a host
     * predating the field never sends it, and its chats must keep announcing
     * themselves exactly as they do today rather than losing the trailing text
     * they already had. `null` says the same thing for a different reason: the
     * turn really did end with nothing said (it finished on a tool call), and
     * the host will not invent a line to cover it. A reader treats the two
     * identically — there is no closing text here, fall through to whatever it
     * would have used before.
     */
    turnSummary: z.string().nullable().optional(),
    /**
     * What this chat is to the user: blocked on them (`question`), worth their
     * attention though not blocking (`report`), or finished with nothing
     * outstanding (`complete`). Drives whether the row appears at all and how it
     * reads. `null` when nothing has been generated or declared; optional for
     * back-compat.
     *
     * A `question` or `report` set by the agent's own tool call is DECLARED and
     * outlives further machine turns — see `chatRunner.declareStatus`. Only a
     * user turn clears it, because only a user turn is evidence the user saw it.
     */
    statusKind: StatusKind.nullable().optional(),
    /**
     * Whether `statusKind` is DECLARED (the agent called `patch_ask_human` /
     * `patch_report` itself) rather than a generated one-shot's guess at
     * whether the thread reads as a question. `report` is only ever declared —
     * the generator's KIND_MAP never produces it — but its generated `question`
     * guesses are frequent false positives (a reply that merely contains a `?`),
     * so a reader gating the `permission` badge on `statusKind === 'question'`
     * alone freezes those chats indigo forever, since only a user turn (not
     * reading) clears the field. `true` for a declared status, `false`/`null`
     * for a generated one or when nothing has landed; optional for back-compat.
     */
    statusDeclared: z.boolean().nullable().optional(),
    /**
     * The chat's todo list (patch/todo.md § Features to add — "todo list"),
     * mirrored from the agent's native TodoWrite so surfaces can show what it is
     * working through. In-memory only (reflects the latest turn); optional for
     * back-compat with payloads predating the feature. Absent ⇒ unchanged.
     */
    todos: z.array(TodoItem).optional(),
    /**
     * The chat's pending self-wake (`02-daemon.md` § Self-wake), or `null` when
     * nothing is armed. Read from the chat's `wake.json` on every state emit, so
     * it stays correct across restarts; re-emitted the moment a wake is
     * scheduled, replaced, cancelled or fires. Surfaces show it as a bar above
     * the chat with a countdown + the wake message. Optional for back-compat
     * with payloads predating the feature.
     */
    pendingWake: PendingWake.nullable().optional(),
    /**
     * ms epoch the chat is snoozed until (spec/04 § Snooze), or `null` when it
     * is not snoozed. A chat counts as snoozed while `snoozedUntil > now`, so a
     * lapsed value needs no event to come back. Optional for back-compat with
     * payloads predating the feature: ABSENT ⇒ unchanged, `null` ⇒ cleared.
     */
    snoozedUntil: z.number().int().nullable().optional(),
    /**
     * Running out of the active list (spec/04 § Hidden) — a job's background
     * run, drawn only in the sidebar's Hidden section. Separate from `status`:
     * a hidden chat is `active`, and an archived one is never hidden. ABSENT
     * from a host predating the field, which surfaces read as not hidden.
     */
    hidden: z.boolean().optional(),
    /** Folder the chat is pinned to. */
    folder: z.string().min(1).optional(),
    /**
     * ms epoch when the chat was last pinned. Drives sidebar ordering
     * (spec/04: most-recent-pinned at top). `null` for non-pinned chats;
     * optional only for backwards compat with tests/payloads predating
     * group 8.
     */
    pinnedAt: z.number().int().nullable().optional(),
    /**
     * Most recent error (group 10 polish m6). Set when activity flips to
     * 'errored'; surfaces show this in the chat row. Cleared (null) when
     * the chat returns to 'idle' or 'running'.
     */
    lastError: z
      .object({
        code: ChatErrorCode,
        message: z.string(),
        at: z.number().int(),
      })
      .strict()
      .nullable()
      .optional(),
    /**
     * ms-epoch timestamp when this chat will automatically retry after being
     * blocked by a Claude API usage/rate limit. Set when `autoResumeRateLimit`
     * is on and the host schedules a retry; cleared to `null` once the retry
     * fires or the chat is manually re-sent. Optional for back-compat: absent
     * means the feature is not in use or the host predates it.
     */
    rateLimitResumingAt: z.number().int().nullable().optional(),
    /**
     * Distinguishes the reason for an auto-resume pause: `'rate_limit'` for a
     * 429/usage-limit block (resumes at a known `resetsAt`), `'overloaded'`
     * for a transient 529 overload (resumes after a short backoff). Absent when
     * `rateLimitResumingAt` is null. Optional for back-compat.
     */
    resumeKind: z.enum(['rate_limit', 'overloaded']).optional(),
    /**
     * WHY this chat is blocked, in figures rather than in Anthropic's prose.
     *
     * The prose is genuinely misleading: "You've hit your monthly spend limit"
     * is what Claude Code prints when the OVERAGE pool refuses, which happens
     * when the 5-hour window is spent and extra usage is not enabled on the
     * account — nobody has overspent anything. Surfaces used to replay
     * that sentence verbatim, so a reader could not tell which limit had been
     * hit, on which account, or whether waiting would help.
     *
     * Present while the chat is blocked, whether or not a resume was scheduled —
     * auto-resume decides only whether `rateLimitResumingAt` is set, and a limit
     * nobody parked still has to be accounted for. Cleared when the chat's next
     * turn starts.
     */
    limitBlock: z
      .object({
        /** The stored account the blocked turn ran on. */
        accountId: z.string().min(1).optional(),
        /** Its label, so a surface need not resolve the id against the host report. */
        accountLabel: z.string().min(1).optional(),
        /**
         * WHICH POOL RAN OUT — the session (5-hour) or the week (7-day).
         * Never `overage`: the overflow pool is not something a person spends,
         * it is what covers for one of these two when they are empty. Naming
         * it as the limit produced "Extra usage limit on Default", which says
         * nothing a reader can act on. `unknown` when nothing structured said.
         */
        scope: z.enum(['session', 'week', 'unknown']),
        /** 0–1 for the refusing window, when known. */
        utilization: z.number().min(0).max(1).optional(),
        /** ms-epoch. Render in the reader's own zone — never pass UTC prose through. */
        resetsAt: z.number().int().optional(),
        /**
         * True when extra usage could NOT cover the spent pool — the reason a
         * limit is a hard stop rather than a spill. Reported separately from
         * the limit itself because it is a different fact with a different
         * remedy: the limit resets on its own, this does not.
         */
        overageBlocked: z.boolean().optional(),
        /**
         * Anthropic's reason code for that, e.g. `org_level_disabled_until` —
         * extra usage not enabled on the account, which is not the same as
         * having spent it.
         */
        overageReason: z.string().min(1).optional(),
        /**
         * HOW THE HOST ROUTES AND WHERE THAT STANDS — the account strategy in
         * force and how many of the held accounts are out, so "round robin, but
         * everything exhausted" is said rather than left to be inferred from one
         * account's countdown. Absent for a host with no account store.
         */
        routing: z
          .object({
            strategy: AccountStrategy,
            /** Accounts the host holds for this backend. */
            accounts: z.number().int().nonnegative(),
            /** How many of them are recorded out of credit right now. */
            exhausted: z.number().int().nonnegative(),
            /** The soonest stated return of an exhausted account, ms-epoch. */
            nextResetsAt: z.number().int().optional(),
            /** That account's label. */
            nextLabel: z.string().min(1).optional(),
          })
          .strict()
          .optional(),
        /** Anthropic's own sentence, kept for the detail view. Never the headline. */
        raw: z.string().optional(),
      })
      .strict()
      .nullable()
      .optional(),
    ...forSurfaceIdField,
  })
  .strict();
export type ChatStateEvent = z.infer<typeof ChatStateEvent>;

export const ChatStoppedEvent = z
  .object({
    type: z.literal('chat.stopped'),
    chatId: z.string().min(1),
    reason: z.string(),
    ...forSurfaceIdField,
  })
  .strict();
export type ChatStoppedEvent = z.infer<typeof ChatStoppedEvent>;

/**
 * A `patch_delegate` subagent's live state changed (spec/06 § Cross-chat
 * tools — patch_delegate). Emitted on the PARENT's `chatId`, never the
 * subagent's own (which never reaches the wire at all — spec/02 § Native
 * subagent dispatch): this is what lets the parent's tool row for the
 * `patch_delegate` call it started show running/done/failed live, and what a
 * surface uses to know the result it is about to read on `chat.message` is
 * attached to this delegate. `label` is the subagent's short description, so
 * a reconnecting surface (which never replayed the original tool call) can
 * still draw the row without a second lookup.
 */
export const ChatDelegateUpdateEvent = z
  .object({
    type: z.literal('chat.delegate_update'),
    chatId: z.string().min(1),
    delegateId: z.string().min(1),
    label: z.string().min(1),
    status: z.enum(['running', 'awaiting-permission', 'done', 'failed', 'stopped']),
    seq: z.number().int().nonnegative(),
    ...forSurfaceIdField,
  })
  .strict();
export type ChatDelegateUpdateEvent = z.infer<typeof ChatDelegateUpdateEvent>;

/**
 * A user turn that arrived while the chat was already `running` has been
 * QUEUED behind the in-flight turn (spec/04 ## Message queueing — parity with
 * Claude Code's type-ahead). The host runs queued turns serially in arrival
 * order once the current turn finishes. Surfaces render queued messages in a
 * distinct pending style and may cancel one with `chat.unqueue_request`.
 *
 * Live-only (like `chat.message_delta`): NOT persisted, NOT replayed by the
 * host. The server keeps the current queue and re-sends one of these per waiting
 * message to a surface that asks for the chat's replay.
 * `queueSeq` is a per-chat monotonic counter giving a stable render order.
 */
export const ChatQueuedEvent = z
  .object({
    type: z.literal('chat.queued'),
    chatId: z.string().min(1),
    /** The surface-supplied idempotency key of the queued turn (same space as `chat.input`). */
    localId: z.string().min(1),
    /**
     * The queued turn's text as the user typed it (so any surface can render
     * it, not just the sender) — never the prompt the host builds around it.
     * Re-sent with the same `localId`/`queueSeq` when the text is edited.
     */
    message: z.string(),
    /** Per-chat monotonic queue position for stable ordering across surfaces. */
    queueSeq: z.number().int().nonnegative(),
    ...forSurfaceIdField,
  })
  .strict();
export type ChatQueuedEvent = z.infer<typeof ChatQueuedEvent>;

/**
 * A previously-`chat.queued` turn has left the queue — either because it is now
 * being RUN (`reason: 'running'`, the normal case: the surface flips it from
 * pending to a live user turn), because it was CANCELLED before running
 * (`reason: 'cancelled'`, via `chat.unqueue_request`), or because the agent
 * took it in at a tool boundary of the turn already running
 * (`reason: 'running'` with `delivered: true`, spec/04 § Message queueing). Live-only.
 */
export const ChatDequeuedEvent = z
  .object({
    type: z.literal('chat.dequeued'),
    chatId: z.string().min(1),
    localId: z.string().min(1),
    reason: z.enum(['running', 'cancelled']),
    /**
     * Set with `reason: 'running'` when the message did not start a turn of its own
     * but was taken in by the turn already running, at a tool boundary (spec/04 §
     * Message queueing). A surface that predates it reads the ordinary `running`
     * and shows the message as taken in, which is what happened; an unknown ENUM
     * value would be refused as malformed, an unknown field is not.
     */
    delivered: z.literal(true).optional(),
    ...forSurfaceIdField,
  })
  .strict();
export type ChatDequeuedEvent = z.infer<typeof ChatDequeuedEvent>;

/**
 * One track of a chat's branch graph (spec/04 § Branching). A chat starts with
 * a single root branch (`parentBranchId: null`, `forkFromSeq: null`); editing a
 * user turn forks a new branch from that turn's seq.
 */
export const ChatBranch = z
  .object({
    branchId: z.string().min(1),
    /** The branch this one forked from; `null` for the root track. */
    parentBranchId: z.string().min(1).nullable(),
    /** Seq of the user turn this branch forked at; `null` for the root track. */
    forkFromSeq: z.number().int().nonnegative().nullable(),
    /** Short label for the track (`main`, `edit 1`, …). */
    label: z.string().min(1),
    /** ms epoch the branch was created. */
    createdAt: z.number().int(),
    /**
     * True for a side thread (spec/04 § Side threads): `forkFromSeq` names a
     * message this track SHARES with its parent, unlike an edit fork, where
     * the message at `forkFromSeq` is being replaced. Absent/false means an
     * edit fork.
     */
    sideThread: z.literal(true).optional(),
    /**
     * A side branch's own name (spec/04 § Branching — "Side branches get a
     * name"), derived like a chat name from its first message and
     * renameable (`chat.branch_rename_request`). `null`/absent until
     * generated. Meaningless for the root/edit-fork tracks, which take their
     * label from `label` instead.
     */
    name: z.string().min(1).nullable().optional(),
    /**
     * True once this branch has posted its conclusion back into its parent
     * track (spec/04 § Send back). One-way — set and never cleared.
     */
    sentBack: z.literal(true).optional(),
    /**
     * True while this branch has a turn actually in flight on its own pump
     * (spec/04 § Parallel branches; spec/14 § Side threads panel — tab status
     * dot). Absent means idle. This is the one live per-branch signal the
     * host surfaces beyond permission requests — everything else about a
     * side branch's content is pull-based (`chat.replay`/history,
     * branch-scoped).
     */
    running: z.literal(true).optional(),
  })
  .strict();
export type ChatBranch = z.infer<typeof ChatBranch>;

/**
 * Surface → host rename of a SIDE BRANCH (spec/04 § Branching — "Side
 * branches get a name … renameable"). Mirrors `chat.rename_request`'s shape
 * for the chat itself. `name: null` is refused — unlike a chat, a branch has
 * no folder-derived fallback label to clear back to; renaming a branch to
 * nothing is not a thing a surface can ask for.
 */
export const ChatBranchRenameRequestEvent = z
  .object({
    type: z.literal('chat.branch_rename_request'),
    chatId: z.string().min(1),
    branchId: z.string().min(1),
    name: z.string().min(1),
  })
  .strict();
export type ChatBranchRenameRequestEvent = z.infer<typeof ChatBranchRenameRequestEvent>;

/**
 * User-triggered send back (spec/04 § Send back; spec/14 § Side threads panel
 * — "Send back to chat" button). Does the SAME thing the agent's own
 * `patch_send_back` tool does (`ChatRunner.sendBackToParent`) — summarises the
 * branch's conclusion and posts it into the parent track — but is invoked
 * directly from a surface rather than requiring a turn to be running on the
 * branch and call the tool itself. Refused the same way the tool is: no
 * parent (the root branch), or already sent back once.
 */
export const ChatSendBackRequestEvent = z
  .object({
    type: z.literal('chat.send_back_request'),
    chatId: z.string().min(1),
    branchId: z.string().min(1),
  })
  .strict();
export type ChatSendBackRequestEvent = z.infer<typeof ChatSendBackRequestEvent>;

/**
 * The chat's track graph (spec/04 § Branching). Emitted on fork, on track
 * switch, and alongside a `chat.replay` so a reconnecting surface learns the
 * graph without a separate request. Out-of-band: carries no `seq` and is not
 * part of the replayable event stream — it describes the chat, not a turn.
 *
 * `branches` is ordered oldest-first (root first), so a surface can render a
 * fork point's tracks in creation order without sorting.
 */
export const ChatBranchesEvent = z
  .object({
    type: z.literal('chat.branches'),
    chatId: z.string().min(1),
    activeBranchId: z.string().min(1),
    branches: z.array(ChatBranch),
    ...forSurfaceIdField,
  })
  .strict();
export type ChatBranchesEvent = z.infer<typeof ChatBranchesEvent>;

export const ChatErrorEvent = z
  .object({
    type: z.literal('chat.error'),
    chatId: z.string().min(1),
    /**
     * Discriminator object — `code` is stable for branching (folder missing,
     * SDK fail, stale Claude session, etc.); `message` is human-readable
     * (the original error message — surfaces show this in the toast). See
     * `ChatErrorCode` for the enumeration.
     */
    error: z
      .object({
        code: ChatErrorCode,
        message: z.string(),
      })
      .strict(),
    /**
     * Per-chat monotonic seq for replayable errors, OR `OUT_OF_BAND_SEQ` (-1)
     * for a spawn-time / no-chat-context control error that surfaces must not
     * treat as a replayable stream event. `chat.error` is the only event whose
     * seq may be negative — see `OUT_OF_BAND_SEQ`.
     */
    seq: z.number().int().gte(OUT_OF_BAND_SEQ),
    /**
     * The canonical seq of the persisted `chat.message` (role user) this
     * error terminates, when the host knows it (an in-flight turn always
     * does; a handful of out-of-band refusals with no turn in progress
     * don't, and omit it). NOT the turn's `chat.input.localId` — the host
     * always persists and echoes that user message (clearing the surface's
     * optimistic `localId` on reconciliation) BEFORE the SDK query that can
     * fail even starts, so by the time this event can arrive the originating
     * message's `localId` is already gone; its seq is the only identity that
     * survives that reconciliation. Lets a surface attach the failure to the
     * originating message (spec/12 § Guaranteed input delivery) instead of
     * rendering a standalone error line. Optional so an older host that
     * hasn't sent it yet still decodes — see `02-daemon.md` on hosts OTA-ing
     * independently.
     */
    causeSeq: z.number().int().gte(0).optional(),
    ...forSurfaceIdField,
  })
  .strict();
export type ChatErrorEvent = z.infer<typeof ChatErrorEvent>;

/** Server-emitted when THAT host WS connects. */
export const DaemonOnlineEvent = z
  .object({
    type: z.literal('daemon.online'),
    ...daemonIdField,
  })
  .strict();
export type DaemonOnlineEvent = z.infer<typeof DaemonOnlineEvent>;

/** Server-emitted on THAT host's WS drop or heartbeat timeout. */
export const DaemonOfflineEvent = z
  .object({
    type: z.literal('daemon.offline'),
    ...daemonIdField,
    reason: z.string().optional(),
  })
  .strict();
export type DaemonOfflineEvent = z.infer<typeof DaemonOfflineEvent>;

/**
 * Host → server: one backend's credential on one host is missing or expired
 * (spec/10 § Backend credentials). Names BOTH the machine and the backend —
 * a host with two backends can be authenticated on one and not the other, and
 * Settings offers that backend's routes to a credential.
 */
export const DaemonUnauthenticatedEvent = z
  .object({
    type: z.literal('daemon.unauthenticated'),
    ...daemonIdField,
    backendId: z.string().min(1),
    reason: z.string(),
  })
  .strict();
export type DaemonUnauthenticatedEvent = z.infer<typeof DaemonUnauthenticatedEvent>;

/**
 * One MCP server a host wires into every chat it runs (Settings → MCP), beside
 * Patch's own tools server, which is always on and is not in this list. The
 * host starts it as a stdio process: `command` with `args`, `env` added to its
 * environment. `name` is how the chat's tools are prefixed (`mcp__<name>__…`),
 * so names are unique per host and `patch` is reserved.
 */
export const McpServerConfig = z
  .object({
    name: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/)
      .refine((n) => n !== 'patch', { message: '"patch" is reserved for Patch\'s own tools' }),
    command: z.string().min(1),
    args: z.array(z.string()),
    env: z.record(z.string(), z.string()),
    enabled: z.boolean(),
  })
  .strict();
export type McpServerConfig = z.infer<typeof McpServerConfig>;

/** The whole list, names unique. */
export const McpServerList = z
  .array(McpServerConfig)
  .refine((xs) => new Set(xs.map((x) => x.name)).size === xs.length, {
    message: 'MCP server names must be unique',
  });

// ---------------------------------------------------------------------------
// Shared settings (spec/01 § Settings)
// ---------------------------------------------------------------------------

const VoiceBackendSetting = z.enum(['local', 'gemini', 'openai']);
const VoiceSurfaceSetting = z
  .object({
    backend: VoiceBackendSetting,
    layer: z.enum(['direct', 'light', 'heavy']),
    // Absent in settings saved before the hand-off choice existed.
    handoff: z.enum(['auto', 'always', 'never']).default('auto'),
  })
  .strict();
/** Per-surface voice config (spec/07 § Voice is a config matrix). */
export const VoiceConfigSetting = z
  .object({
    dictation: z.object({ backend: VoiceBackendSetting }).strict(),
    device: VoiceSurfaceSetting,
    handsFree: VoiceSurfaceSetting,
    call: VoiceSurfaceSetting,
  })
  .strict();
export type VoiceConfigSetting = z.infer<typeof VoiceConfigSetting>;

/** `HH:MM` on a 24-hour clock, in the server's local zone. */
const TimeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/**
 * Claude Code's `settings.json` as a shared setting (spec/02 § Claude Code
 * settings): one text for every host, and an optional override per OS whose
 * top-level keys replace the shared ones on hosts of that OS. Each is JSON text
 * (`''` meaning none), validated as a JSON object on the way in.
 */
export const ClaudeSettingsSetting = z
  .object({
    shared: z.string(),
    darwin: z.string(),
    linux: z.string(),
  })
  .strict();
export type ClaudeSettingsSetting = z.infer<typeof ClaudeSettingsSetting>;

/**
 * Every setting that is not tied to one machine (spec/01 § Settings). The
 * server stores it, every host runs from the copy in the last snapshot.
 */
export const SharedSettings = z
  .object({
    // ---- server-acted preferences ----
    /** Whether the Manager sweep runs at all (spec/06 § Sweep). */
    sweepEnabled: z.boolean(),
    /** How often the interval trigger fires, subject to the gate. */
    sweepIntervalMinutes: z.number().int().positive(),
    /** How long a RUNNING chat may go without output before the gate calls it stalled. */
    stalledThresholdMinutes: z.number().int().positive(),
    /** How many of each changed chat's most recent messages go into the digest. */
    sweepMessagesPerChat: z.number().int().positive(),
    /** The Manager's own bounded context window (spec/06 § Manager conversation). */
    managerContextWindow: z.number().int().positive(),
    /** The sweep's decision-call prompt; "Reset to default" writes `DEFAULT_SWEEP_PROMPT` back. */
    sweepPrompt: z.string().min(1),
    /** The model the sweep's one decision call runs on. */
    sweepModel: z.string().min(1),
    // ---- goals (spec/04 § Goals), applied on every host ----
    /** The goal judge's instructions; "Reset to default" writes `DEFAULT_GOAL_EVAL_PROMPT` back. */
    goalEvalPrompt: z.string().min(1),
    /** The model that judges every chat's goal, whichever provider the chat runs on. */
    goalModel: z.string().min(1),
    /** Consecutive refusals after which a goal stops pushing the agent. */
    goalRefusalLimit: z.number().int().positive(),
    quietHoursStart: TimeOfDay,
    quietHoursEnd: TimeOfDay,
    addressWord: z.string().min(1).max(32),
    reach: z.enum(['notify', 'auto-notify']),
    defaultModel: z.string().min(1),
    specialThreadModel: z.string().min(1),
    rotationEnabled: z.boolean(),
    rotationTime: TimeOfDay,
    suppressProviderSwitchWarning: z.boolean(),
    providerContextVerbosity: z.enum(['off', 'summary', 'full']),
    /**
     * Text prepended to every job's first user-turn unless the job carries its
     * own `autonomyPrompt` (spec/08 § Autonomy prompt). Read by the server per
     * fire. There is no empty state: a job always has an autonomy prompt.
     */
    jobAutonomyPrompt: z.string().min(1),
    // ---- applied on every host ----
    voiceConfig: VoiceConfigSetting,
    /** Absent until one is chosen: each host then uses its Kokoro default. */
    kokoroVoice: z.string().min(1).optional(),
    permissionModeDefault: PermissionMode,
    chatNameInterval: z.number().int().nonnegative(),
    autoResumeRateLimit: z.boolean(),
    questionExpiry: z.boolean(),
    questionExpirySeconds: z
      .number()
      .int()
      .min(QUESTION_EXPIRY_SECONDS_MIN)
      .max(QUESTION_EXPIRY_SECONDS_MAX),
    /** `''` = no override; the SDK's own system prompt stands. */
    harnessSystemPrompt: z.string(),
    /** `null` = the built-in guidance; `''` = turned off. */
    harnessToolsPrompt: z.string().nullable(),
    /** `null` = no explicit configuration. */
    harnessSkills: z.union([z.array(z.string().min(1)), z.literal('all')]).nullable(),
    harnessMemoryEnabled: z.boolean(),
    claudeSettings: ClaudeSettingsSetting,
    accountStrategy: z.object({ claude: AccountStrategy, codex: AccountStrategy }).strict(),
  })
  .strict();
export type SharedSettings = z.infer<typeof SharedSettings>;
/** A write: any subset of the settings. */
export const SharedSettingsPatch = SharedSettings.partial().strict();
export type SharedSettingsPatch = z.infer<typeof SharedSettingsPatch>;

export const DEFAULT_SHARED_SETTINGS: SharedSettings = {
  sweepEnabled: true,
  sweepIntervalMinutes: 30,
  stalledThresholdMinutes: 15,
  sweepMessagesPerChat: 3,
  managerContextWindow: 40,
  sweepPrompt: DEFAULT_SWEEP_PROMPT,
  // Mid-size by default (spec/06 § Settings).
  sweepModel: 'claude-sonnet-5',
  goalEvalPrompt: DEFAULT_GOAL_EVAL_PROMPT,
  goalModel: DEFAULT_GOAL_MODEL,
  goalRefusalLimit: DEFAULT_GOAL_REFUSAL_LIMIT,
  quietHoursStart: '23:00',
  quietHoursEnd: '07:00',
  addressWord: 'patch',
  reach: 'notify',
  // Chats and jobs alike do real work, so the out-of-the-box choice is the
  // strongest model rather than the cheapest.
  defaultModel: 'claude-opus-5',
  specialThreadModel: 'claude-sonnet-5',
  rotationEnabled: true,
  rotationTime: '02:00',
  suppressProviderSwitchWarning: false,
  providerContextVerbosity: 'summary',
  // Every surface starts on the free, self-hosted pipeline talking straight to
  // Manager; each hosted cell is a deliberate opt-in.
  voiceConfig: {
    dictation: { backend: 'local' },
    device: { backend: 'local', layer: 'direct', handoff: 'auto' },
    handsFree: { backend: 'local', layer: 'direct', handoff: 'auto' },
    call: { backend: 'local', layer: 'direct', handoff: 'auto' },
  },
  permissionModeDefault: 'auto',
  chatNameInterval: 0,
  // On: a chat that hits a limit waits for the reset rather than being
  // silently abandoned mid-task.
  autoResumeRateLimit: true,
  questionExpiry: true,
  questionExpirySeconds: QUESTION_EXPIRY_SECONDS_DEFAULT,
  harnessSystemPrompt: '',
  harnessToolsPrompt: null,
  harnessSkills: null,
  harnessMemoryEnabled: false,
  claudeSettings: { shared: '', darwin: '', linux: '' },
  accountStrategy: { claude: 'priority', codex: 'priority' },
  jobAutonomyPrompt: DEFAULT_JOB_AUTONOMY_PROMPT,
};

/**
 * One Claude credential as the server stores and a host receives it. The
 * organisation is the identity of the pool of credit behind it (spec/10 § ONE
 * ROW IS ONE CLAUDE ACCOUNT).
 */
export const ClaudeCredential = z
  .object({
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1).optional(),
    expiresAt: z.number().optional(),
    email: z.string().min(1).optional(),
    organizationId: z.string().min(1).optional(),
  })
  .strict();
export type ClaudeCredential = z.infer<typeof ClaudeCredential>;

export const SharedClaudeAccount = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    /** `null` = disconnected: the row stays, nothing resolves against it. */
    credential: ClaudeCredential.nullable(),
  })
  .strict();
export type SharedClaudeAccount = z.infer<typeof SharedClaudeAccount>;

export const SharedCodexAccount = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    kind: z.enum(['chatgpt', 'apiKey']),
    email: z.string().min(1).optional(),
    /** The pool of credit behind the login, for refusing a duplicate. */
    identity: z.string().min(1).optional(),
    /** Codex's own `auth.json` for this login, or `null` when disconnected. */
    authJson: z.string().min(1).nullable(),
  })
  .strict();
export type SharedCodexAccount = z.infer<typeof SharedCodexAccount>;

/** Every shared secret, in order. Travels to hosts only. */
export const SharedSecrets = z
  .object({
    claude: z.array(SharedClaudeAccount),
    codex: z.array(SharedCodexAccount),
    providerKeys: z
      .object({
        gemini: z.string().min(1).optional(),
        openai: z.string().min(1).optional(),
        groq: z.string().min(1).optional(),
      })
      .strict(),
  })
  .strict();
export type SharedSecrets = z.infer<typeof SharedSecrets>;
export const EMPTY_SHARED_SECRETS: SharedSecrets = { claude: [], codex: [], providerKeys: {} };

/** What a surface may know of the secrets: never a value. */
export const SharedSecretsSummary = z
  .object({
    claude: z.array(
      z
        .object({
          id: z.string().min(1),
          label: z.string().min(1),
          connected: z.boolean(),
          email: z.string().min(1).optional(),
          organizationId: z.string().min(1).optional(),
        })
        .strict(),
    ),
    codex: z.array(
      z
        .object({
          id: z.string().min(1),
          label: z.string().min(1),
          kind: z.enum(['chatgpt', 'apiKey']),
          connected: z.boolean(),
          email: z.string().min(1).optional(),
        })
        .strict(),
    ),
    providerKeys: z.array(
      z
        .object({
          id: ProviderKeyId,
          set: z.boolean(),
          last4: z.string().min(1).max(4).optional(),
        })
        .strict(),
    ),
  })
  .strict();
export type SharedSecretsSummary = z.infer<typeof SharedSecretsSummary>;

/** Server → host: every shared setting and secret (spec/03 § Settings). */
export const SettingsSnapshotEvent = z
  .object({
    type: z.literal('settings.snapshot'),
    daemonId: z.string().min(1),
    version: z.number().int().nonnegative(),
    settings: SharedSettings,
    secrets: SharedSecrets,
  })
  .strict();
export type SettingsSnapshotEvent = z.infer<typeof SettingsSnapshotEvent>;

/** Host → server: the version this host now runs on, or why it could not. */
export const SettingsAppliedEvent = z
  .object({
    type: z.literal('settings.applied'),
    daemonId: z.string().min(1),
    version: z.number().int().nonnegative(),
    error: z.string().min(1).optional(),
  })
  .strict();
export type SettingsAppliedEvent = z.infer<typeof SettingsAppliedEvent>;

export const HostSettingsState = z
  .object({
    daemonId: z.string().min(1),
    /** Absent until the host has answered any snapshot. */
    appliedVersion: z.number().int().nonnegative().optional(),
    error: z.string().min(1).optional(),
  })
  .strict();
export type HostSettingsState = z.infer<typeof HostSettingsState>;

/** Server → surfaces: the shared settings as a surface may see them. */
export const SettingsChangedEvent = z
  .object({
    type: z.literal('settings.changed'),
    version: z.number().int().nonnegative(),
    settings: SharedSettings,
    secrets: SharedSecretsSummary,
    hosts: z.array(HostSettingsState),
    /** Why the stored accounts and keys cannot be read, and how to fix it. */
    problem: z.string().min(1).optional(),
  })
  .strict();
export type SettingsChangedEvent = z.infer<typeof SettingsChangedEvent>;

/** Server → surfaces: the agent-notification log changed (spec/09 § bell). Surfaces refetch. */
export const NotificationsChangedEvent = z
  .object({
    type: z.literal('notifications.changed'),
    unread: z.number().int().nonnegative(),
  })
  .strict();
export type NotificationsChangedEvent = z.infer<typeof NotificationsChangedEvent>;

/** Host → server: a credential this host refreshed while running a turn. */
export const SettingsSecretUpdateEvent = z
  .object({
    type: z.literal('settings.secret_update'),
    daemonId: z.string().min(1),
    update: z.discriminatedUnion('backendId', [
      z
        .object({
          backendId: z.literal('claude-code'),
          accountId: z.string().min(1),
          credential: ClaudeCredential,
        })
        .strict(),
      z
        .object({
          backendId: z.literal('codex'),
          accountId: z.string().min(1),
          authJson: z.string().min(1),
          email: z.string().min(1).optional(),
        })
        .strict(),
    ]),
  })
  .strict();
export type SettingsSecretUpdateEvent = z.infer<typeof SettingsSecretUpdateEvent>;

/**
 * What the server can ask a host to send up (spec/01 § Settings — values that
 * start on a host):
 * - `import` — everything this host held before settings were shared, once.
 * - `claude-login` / `codex-login` — the backend's own login on this machine.
 * - `codex-signin` — run a ChatGPT device sign-in here and send its result.
 * - `provider-key` — the key of `id` in the host's environment.
 * - `claude-settings` — this machine's drifted `settings.json` text.
 */
export const SettingsAdoptKind = z.enum([
  'import',
  'claude-login',
  'codex-login',
  'codex-signin',
  'provider-key',
  'claude-settings',
]);
export type SettingsAdoptKind = z.infer<typeof SettingsAdoptKind>;

export const SettingsAdoptRequestEvent = z
  .object({
    type: z.literal('settings.adopt.request'),
    requestId: z.string().min(1),
    daemonId: z.string().min(1),
    kind: SettingsAdoptKind,
    /** The provider key id for `provider-key`; a label for a sign-in. */
    id: z.string().min(1).optional(),
  })
  .strict();
export type SettingsAdoptRequestEvent = z.infer<typeof SettingsAdoptRequestEvent>;

export const SettingsImport = z
  .object({
    settings: SharedSettingsPatch,
    secrets: SharedSecrets,
  })
  .strict();
export type SettingsImport = z.infer<typeof SettingsImport>;

export const SettingsAdoptResponseEvent = z
  .object({
    type: z.literal('settings.adopt.response'),
    requestId: z.string().min(1),
    daemonId: z.string().min(1),
    ok: z.boolean(),
    /** Present on success, shaped by the request's kind. */
    result: z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('import'), import: SettingsImport }).strict(),
        z.object({ kind: z.literal('claude-login'), account: SharedClaudeAccount }).strict(),
        z
          .object({
            kind: z.enum(['codex-login', 'codex-signin']),
            account: SharedCodexAccount,
          })
          .strict(),
        z
          .object({ kind: z.literal('provider-key'), id: ProviderKeyId, value: z.string().min(1) })
          .strict(),
        z.object({ kind: z.literal('claude-settings'), text: z.string() }).strict(),
      ])
      .optional(),
    error: z.string().min(1).optional(),
  })
  .strict();
export type SettingsAdoptResponseEvent = z.infer<typeof SettingsAdoptResponseEvent>;

/** Surface → host: rewrite a drifted `settings.json` from the snapshot. */
export const HostClaudeSettingsDiscardEvent = z
  .object({
    type: z.literal('host.claude_settings_discard'),
    daemonId: z.string().min(1),
  })
  .strict();
export type HostClaudeSettingsDiscardEvent = z.infer<typeof HostClaudeSettingsDiscardEvent>;

/**
 * Host → server: a ChatGPT sign-in run on this host (`host.backend_add_account`)
 * completed. The login is the account's, not the machine's, so it goes to the
 * server to be stored as a shared Codex account.
 */
export const SettingsAccountSignedInEvent = z
  .object({
    type: z.literal('settings.account_signed_in'),
    daemonId: z.string().min(1),
    requestId: z.string().min(1),
    account: SharedCodexAccount,
  })
  .strict();
export type SettingsAccountSignedInEvent = z.infer<typeof SettingsAccountSignedInEvent>;

/**
 * A host's self-description (spec/03 § Session events → `daemon.host`,
 * spec/02 § Host identity). Emitted by the host on connect and whenever any
 * field changes; the server caches the last report per host and replays it in
 * the `auth.ok` greeting so a surface renders the full host list immediately.
 */
export const DaemonHostEvent = z
  .object({
    type: z.literal('daemon.host'),
    ...daemonIdField,
    /** User-editable label, defaulted from the machine's hostname. */
    hostName: z.string().min(1),
    platform: z.string().min(1),
    arch: z.string().min(1),
    daemonVersion: z.string().min(1),
    /**
     * The source commit and build instant stamped into this machine's artifact
     * (spec/11 § Version reporting: "the host carries the same three stamped
     * into its artifact and reports them on `daemon.host`"). Optional because a
     * host run from a source checkout has no build stamp — an installed
     * artifact always carries both, and version reporting needs all three to
     * show drift between machines.
     */
    gitSha: z.string().min(1).optional(),
    builtAt: z.string().min(1).optional(),
    /** A newer host build is published for this host's os/arch. */
    updateAvailable: z.boolean(),
    /** Applies to NEW chats on this host (spec/02 § Permission mode). */
    permissionModeDefault: PermissionMode,
    /** How many of this host's chats carry a per-chat override. */
    permissionOverrides: z.number().int().nonnegative(),
    /**
     * The model a spawn that names none runs on — the ACCOUNT's `defaultModel`,
     * mirrored down to this host so a spawn started ON the machine (`patch chats
     * new`, `patch_spawn`) resolves the same model a spawn from a surface does.
     *
     * This replaced `lastUsedModel`, which was derived rather than chosen: it
     * took the model of whatever chat last ran here, so one throwaway
     * cheap-model chat silently moved every later model-less spawn — every
     * unattended job included — onto it, and it stayed there. A default has to
     * be a decision someone made, in one place, not a trailing edge.
     *
     * ABSENT until the account default has reached this host. A spawn naming no
     * model on a host with none is an error saying so, never a guess.
     */
    defaultModel: z.string().min(1).optional(),
    /** The one host running the special threads (spec/06). */
    isHomeHost: z.boolean(),
    /**
     * This host can take the messages waiting behind a running turn from the
     * server, at a tool boundary (`patch.queue_pull.*`), when the server is
     * running the queue (`server.queue_mode`). Optional: an older host never says.
     */
    serverQueue: z.boolean().optional(),
    /**
     * Where the SERVER can reach this host's own audio WSS (`<host>:<port>`,
     * no scheme) to relay a voice session for a chat that lives here but was
     * opened from a surface that only reaches the server (spec/07 § Voice is
     * a per-host capability — the host itself is never internet-reachable;
     * it only dials out). Defaults to loopback (`config.ts`), which is
     * correct for a host that runs on the same box as the server and needs
     * no relay; a host anywhere else must set `PATCH_DAEMON_AUDIO_RELAY_HOST`
     * to an address the server can actually reach it at (its Tailscale name,
     * say) or its chats' voice sessions are refused with `host_unreachable`.
     * Optional on the wire: a host built before the relay (0.1.1286 and
     * earlier) sends none, and requiring it made the server drop that host's
     * whole report. Absent means "no relay address", which the relay refuses
     * as `host_unreachable` like any unreachable host.
     */
    audioRelayHost: z.string().min(1).optional(),
    backends: z.array(HostBackend),
    components: z.array(HostComponent),
    /**
     * Currently selected Kokoro TTS voice for this host (spec/07 § Kokoro).
     * One of the standard Kokoro v1 voice identifiers. Absent when Kokoro is
     * not installed or the voice has never been set.
     */
    kokoroVoice: z.string().min(1).optional(),
    /**
     * Which hosted-voice provider keys this host holds (spec/07 § Voice — a
     * config matrix): GEMINI_API_KEY and OPENAI_REALTIME_API_KEY. Settings →
     * Voice marks a cell whose backend's key is missing here as not configured
     * on this host. A missing key never stops the host; it refuses that
     * surface's sessions with `voice_key_missing`. Absent = a host older than
     * this report, which says nothing either way.
     */
    voiceKeys: z.object({ gemini: z.boolean(), openai: z.boolean() }).strict().optional(),
    /**
     * spec/07 § Call cost — what this host's voice calls have cost, this
     * calendar month (UTC) and in all. Absent = a host older than call
     * costing.
     */
    voiceUsage: z
      .object({
        monthUsd: z.number().nonnegative(),
        monthCalls: z.number().int().nonnegative(),
        allUsd: z.number().nonnegative(),
        allCalls: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    /**
     * Every provider key this host can use and where its value comes from
     * (spec/02 § Provider keys): set from the UI, from the environment, or
     * not at all, with the last four characters of the value in use — never
     * the value. Settings → Hosts → Keys renders it. Absent = a host
     * older than the key store, which gets no Keys block at all.
     */
    providerKeys: z.array(HostProviderKey).optional(),
    /**
     * How many user messages between auto-regen of the chat name. `0` means
     * regen is disabled (name only from first message). Absent means the
     * host is running a version that does not yet honour this setting —
     * treat as 0.
     */
    chatNameInterval: z.number().int().nonnegative().optional(),
    /**
     * Whether this host will automatically retry a turn that was blocked by a
     * Claude API usage/rate limit (`host.settings` § autoResumeRateLimit).
     * Optional for back-compat: absent means the feature is not active.
     */
    autoResumeRateLimit: z.boolean().optional(),
    /**
     * This host's question-expiry setting (`host.settings`), reported back so
     * the Settings surface shows what the machine actually holds rather than
     * what it last sent. BOTH are absent only on a host older than the
     * setting — a surface must not read that as "off", it has no control to
     * offer that host at all.
     */
    questionExpiry: z.boolean().optional(),
    questionExpirySeconds: z
      .number()
      .int()
      .min(QUESTION_EXPIRY_SECONDS_MIN)
      .max(QUESTION_EXPIRY_SECONDS_MAX)
      .optional(),
    /**
     * Per-host Claude harness config (Task 3). When set, overrides the SDK
     * query's system prompt for every chat on this host. Absent = SDK default.
     */
    harnessSystemPrompt: z.string().optional(),
    /** The host's edit of the patch-tools guidance; absent means the default. */
    harnessToolsPrompt: z.string().optional(),
    /** The built-in guidance, so a surface can show it without shipping a copy. */
    harnessToolsPromptDefault: z.string().optional(),
    /**
     * Per-host list of skill names to enable for every chat on this host
     * (`skills: string[] | 'all'` in the SDK query options). `'all'` enables
     * every discovered skill; an array enables only the named skills. Absent =
     * SDK default (no explicit configuration).
     */
    harnessSkills: z.union([z.array(z.string().min(1)), z.literal('all')]).optional(),
    /**
     * Whether Claude Code's own persistent memory (auto-memory files) is
     * enabled for chats on this host (spec/14 § Agent behavior). Stated
     * UNCONDITIONALLY once a host supports it, same discipline as
     * `questionExpiry` above — absent means this host predates the
     * setting, never "off".
     */
    harnessMemoryEnabled: z.boolean().optional(),
    /**
     * LEGACY, for surfaces that predate `harnessMcpServers`: true iff that
     * list holds both `playwright` and `chrome-devtools` and both are
     * enabled. Stated unconditionally once supported; absent means the host
     * predates it. New surfaces read `harnessMcpServers` instead.
     */
    harnessBrowserToolsEnabled: z.boolean().optional(),
    /**
     * The MCP servers this host adds to every chat, in order (Settings → MCP).
     * Stated unconditionally once supported; absent means the host predates
     * it, and the surface should say so rather than show an empty list.
     */
    harnessMcpServers: McpServerList.optional(),
    /**
     * LEGACY: whether the shipped, user-editable CLAUDE.md for the Manager/
     * Speakers threads is loaded on this host. It now always is, so a
     * current host states `true`; absent means the host predates it.
     */
    harnessClaudeMdEnabled: z.boolean().optional(),
    /**
     * Agent browser routing (spec/02 § Browser — Route through): the
     * `daemonId` of another of the user's hosts whose network this host's
     * `patch_browser_*` traffic egresses through, or `null` when the browser
     * goes direct. Stated unconditionally once a host supports it, same
     * discipline as `questionExpiry` above — absent means this host
     * predates the setting, and a surface must read that as "not routed",
     * never as the field being merely unset.
     */
    browserRouteThrough: z.string().min(1).nullable().optional(),
  })
  .strict();
export type DaemonHostEvent = z.infer<typeof DaemonHostEvent>;

/**
 * One rate-limit window's state, as last reported by the SDK's
 * `rate_limit_event` for this backend (spec/10 § Surface in Settings — Usage).
 * `resetsAt` is ms-epoch; absent when the SDK hasn't said when this window
 * clears.
 */
export const RateLimitWindow = z
  .object({
    status: z.enum(['allowed', 'allowed_warning', 'rejected']),
    utilization: z.number().min(0).max(1).optional(),
    resetsAt: z.number().optional(),
    /**
     * Why this window is refusing, in Anthropic's own words, when it says.
     * `org_level_disabled_until` on the overage window means extra usage is
     * not enabled on the account — nothing has been overspent, there was
     * never anything to spill into. Extra usage is a paid add-on, so an
     * account that never took it out reports this for ever: it is a steady
     * state, not a fault, and must not read as blocked anywhere.
     */
    disabledReason: z.string().min(1).optional(),
  })
  .strict();
export type RateLimitWindow = z.infer<typeof RateLimitWindow>;

/**
 * One stored Claude account on one host, as summarised for a surface (spec/10
 * § Backend credentials — multiple accounts). Mirrors a single
 * `DaemonAccountEvent`'s credential-state fields, scoped to just this one
 * stored account rather than the "active" one.
 */
export const DaemonAccountSummary = z
  .object({
    id: z.string().min(1),
    /** User-facing name (Settings list, per-chat account picker). */
    label: z.string().min(1),
    connected: z.boolean(),
    kind: z.enum(['chatgpt', 'apiKey']).optional(),
    error: z.string().optional(),
    accountEmail: z.string().min(1).nullable().optional(),
    /**
     * Which Anthropic organisation this account's token authenticates as.
     *
     * The identity patch could not previously establish, which is why it let
     * one account be stored twice under two labels and then reported "every
     * account is out of credit" having asked the same account twice. Two rows
     * with the same value here share one pool of credit and one set of
     * limits. Absent on a credential stored before this was captured.
     */
    organizationId: z.string().min(1).optional(),
    usage: z
      .object({
        session: RateLimitWindow.optional(),
        week: RateLimitWindow.optional(),
        /**
         * The extra-usage pool the other two spill into once they are spent.
         * Reported separately because its refusal is a DIFFERENT fact from a
         * spent session — and because patch used to discard it, leaving the
         * only account-level limit Claude Code names in prose with no
         * structured counterpart anywhere.
         */
        overage: RateLimitWindow.optional(),
        /**
         * When this reading was taken, ms-epoch. Without it a surface cannot
         * tell a live figure from one left over from the turn that got
         * blocked — which is how Settings came to show a Wednesday reading on
         * a Friday and nobody could tell it was stale.
         */
        at: z.number().optional(),
      })
      .optional(),
  })
  .strict();
export type DaemonAccountSummary = z.infer<typeof DaemonAccountSummary>;

/**
 * The credential state of ONE backend on ONE host (spec/10 § Backend
 * credentials). Replaces the account-wide single-backend report: a machine can
 * be connected on one backend and logged out on another, and the surface must
 * be able to say which. Cached per host and replayed in the auth greeting.
 */
export const DaemonAccountEvent = z
  .object({
    login: z
      .object({
        requestId: z.string(),
        status: z.enum(['pending', 'complete', 'failed', 'cancelled']),
        url: z.string().url().optional(),
        code: z.string().optional(),
        error: z.string().optional(),
      })
      .optional(),
    type: z.literal('daemon.account'),
    ...daemonIdField,
    backendId: z.string().min(1),
    connected: z.boolean(),
    accountEmail: z.string().min(1).nullable().optional(),
    /**
     * The account's Claude usage limits, last reported by this host's SDK
     * (spec/10 § Surface in Settings — Usage). Absent on a host whose host
     * predates this field, or before the SDK has emitted a `rate_limit_event`
     * for either window — the surface shows that as "not reported yet", not
     * an error.
     */
    usage: z
      .object({
        session: RateLimitWindow.optional(),
        week: RateLimitWindow.optional(),
        /**
         * The extra-usage pool the other two spill into once they are spent.
         * Reported separately because its refusal is a DIFFERENT fact from a
         * spent session — and because patch used to discard it, leaving the
         * only account-level limit Claude Code names in prose with no
         * structured counterpart anywhere.
         */
        overage: RateLimitWindow.optional(),
        /**
         * When this reading was taken, ms-epoch. Without it a surface cannot
         * tell a live figure from one left over from the turn that got
         * blocked — which is how Settings came to show a Wednesday reading on
         * a Friday and nobody could tell it was stale.
         */
        at: z.number().optional(),
      })
      .optional(),
    /**
     * Every stored account on this (host, backend), for the multi-account
     * Settings list and the per-chat account picker (spec/10 § Backend
     * credentials — multiple accounts). The top-level `connected`/
     * `accountEmail`/`usage` above always mirror the ACTIVE entry in this
     * list, so an older surface that has never heard of `accounts` still
     * renders correctly off the fields it already reads. Optional/absent for
     * a host that predates multi-account support.
     */
    accounts: z.array(DaemonAccountSummary).optional(),
    /** Which entry in `accounts` is the default a chat takes when it names none. */
    activeAccountId: z.string().min(1).optional(),
    /**
     * Why the credential the surface just submitted was NOT stored (spec/10 §
     * Validating a pasted token). One-shot: it describes the request that
     * caused THIS report, so the server does not cache it and a surface that
     * connects later never sees it.
     *
     * `kind: 'rejected'` means Anthropic answered and refused the token — it is
     * bad. `kind: 'unreachable'` means we could not get an answer, so the
     * token's validity is unknown. `kind: 'duplicate'` means the token is
     * good but is for an account already stored: patch refuses it because two
     * credentials for one organisation share one pool of credit, so the
     * second is not somewhere to fail over to — it is the same account under
     * a second name. In every case nothing was written, because saving on an
     * inconclusive check is how a bad token comes to be discovered by a chat
     * that fails an hour later.
     *
     * `accountId` names the stored account a re-connect targeted, and is absent
     * when the request was adding a new account (there is no id yet).
     */
    credentialError: z
      .object({
        accountId: z.string().min(1).optional(),
        kind: z.enum(['rejected', 'unreachable', 'duplicate']),
        message: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();
export type DaemonAccountEvent = z.infer<typeof DaemonAccountEvent>;

/**
 * Voice-device session presence (host → server → surfaces).
 *
 * Emitted when a physical voice device (HA Voice PE, see `16-voice-device.md`)
 * opens or closes an audio session on the host. Surfaces use it to drive the
 * "mid-session" pill on the Speakers row in the Channels box
 * (`14-design-web.md` ## Sidebar → "When a device is mid-session, the row
 * carries a small green pill (e.g. `🎙 kitchen`)").
 *
 * Account-scoped (no `chatId`) so the server's ws-hub fans it out to every
 * connected surface unconditionally. `name` is the user-given device name
 * ("kitchen", "bedroom") resolved from the host's device registry; surfaces
 * render it in the pill. `active: true` on session start, `false` on end.
 */
export const DeviceSessionEvent = z
  .object({
    type: z.literal('device.session'),
    deviceId: z.string().min(1),
    name: z.string().min(1),
    active: z.boolean(),
  })
  .strict();
export type DeviceSessionEvent = z.infer<typeof DeviceSessionEvent>;

/**
 * Host-owned folder registry snapshot (host → server → surfaces).
 *
 * spec/04-chats-and-folders.md § Folders: folders are DEFINED ON THE HOST —
 * it owns the project filesystem and is the only party that knows which folders
 * actually exist. The host publishes its folder list to the server, which
 * relays it to every connected surface so one consistent picker on every
 * surface (new-chat + schedule-editor) is populated from the same list and a
 * folder that exists on the host is one tap away everywhere. The user never
 * has to type or guess an absolute path in the common case.
 *
 * `folders.list` is the full snapshot the host sends on (re)connect;
 * `folders.updated` is the push it sends whenever the set changes (e.g. a chat
 * is spawned into a new folder, or a project root is registered, including
 * after a `host.folder_add` / `host.folder_remove`). Both carry the COMPLETE
 * registry for ONE host — a surface replaces that host's picker group on
 * either event and leaves every other host's alone.
 *
 * Roots and recents are separate lists, not one concatenation, because the
 * picker renders them as distinct sections (spec/04 § Folders: "that host's
 * registered folders first, then folders seen in recent chats") and because
 * only recents are junk-filtered — an explicitly registered root under, say,
 * `/tmp/work` is a deliberate designation and must survive.
 *
 * Account-scoped (no `chatId`) so the server's ws-hub fans them out to every
 * connected surface unconditionally; `daemonId` says whose filesystem they
 * describe, so two hosts sharing a path string stay two entries.
 *
 * The published list is NOT a substitute for the host's spawn-time
 * `folder exists` check on the CHOSEN host — a stale/ad-hoc path still fails
 * loudly with `folder_not_found` on send (NO FALLBACK).
 */
const folderRegistryFields = {
  ...daemonIdField,
  /** User-designated project roots on this host, in registration order. */
  roots: z.array(z.string().min(1)),
  /** Folders seen in recent chats on this host, most-recent-used first. */
  recent: z.array(z.string().min(1)),
};

export const FoldersListEvent = z
  .object({
    type: z.literal('folders.list'),
    ...folderRegistryFields,
  })
  .strict();
export type FoldersListEvent = z.infer<typeof FoldersListEvent>;

export const FoldersUpdatedEvent = z
  .object({
    type: z.literal('folders.updated'),
    ...folderRegistryFields,
  })
  .strict();
export type FoldersUpdatedEvent = z.infer<typeof FoldersUpdatedEvent>;

// ---------------------------------------------------------------------------
// Surface events (surface → server → host)

/**
 * Per spec/06 ## Special threads — when a user-turn arrives via a non-WS
 * ingress (voice device), the host needs to know so it can:
 * 1. Inject broadcast-sidecar context as a `<system-reminder>` block
 * 2. Auto-route the agent's reply back to the originating channel
 *
 * `kind: 'voice-device'` carries the device id so TTS plays back on the
 * same speaker.
 *
 * SECURITY (group 12 HIGH-1): Surfaces NEVER set this field. The server
 * STRIPS `source` from any `chat.input` arriving on the surface ingress path
 * (see ws-hub `handleSurfaceEvent` case 'chat.input'). Only the voice-device
 * transcript hook is allowed to attach a `source`. A surface that includes it
 * would otherwise be able to spoof the reply-router into delivering the next
 * assistant turn to an attacker-chosen voice device.
 */
export const VoiceAppSurfaceKind = z.enum(['web', 'desktop', 'mobile']);
export type VoiceAppSurfaceKind = z.infer<typeof VoiceAppSurfaceKind>;

export const ChatInputSource = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('voice-device'),
      deviceId: z.string().min(1),
    })
    .strict(),
  /**
   * Group 13: voice on phone/web/desktop app surfaces. The host stamps
   * this onto a `chat.input` event after Whisper transcribes mic audio
   * received over the audio WSS at `:3003/audio/<sessionId>`.
   *
   * Surfaces NEVER set `source.kind === 'voice-app'` directly — only the
   * host (streamed-note / call transcripts) and the server's
   * `POST /api/voice/note` route (uploaded single-clip transcripts) attach
   * it, since the only legitimate source is a transcript produced from an
   * authenticated Whisper run.
   *
   * `sessionId` is present for streamed audio-WSS turns (it binds the reply's
   * TTS back to the originating session). It is OMITTED for an uploaded
   * voice-note clip (`POST /api/voice/note`, spec/07 § End-to-end voice
   * transport): there is no live audio session — the clip is transcribed once
   * and the reply routes as text — so the field is optional.
   */
  z
    .object({
      kind: z.literal('voice-app'),
      surfaceKind: VoiceAppSurfaceKind,
      sessionId: z.string().min(1).optional(),
    })
    .strict(),
  /**
   * A job's fire delivering into an existing chat (spec/08 ## Action — a
   * `message` action, or a later fire of a `continue` one). Set only by the
   * server's job dispatcher. It is how the host tells a job tick from the
   * user's own message: only the latter takes a chat out of Hidden (spec/04 §
   * Hidden).
   */
  z
    .object({
      kind: z.literal('job'),
      jobId: z.string().min(1),
    })
    .strict(),
]);
export type ChatInputSource = z.infer<typeof ChatInputSource>;

export const ChatInputEvent = z
  .object({
    type: z.literal('chat.input'),
    chatId: z.string().min(1),
    message: z.string(),
    /**
     * Idempotency key. Server dedupes on `(accountId, chatId, localId)` —
     * NOTE this is a **separate dedupe space** from `chat.spawn_request.localId`
     * (which is keyed on `(accountId, 'spawn', localId)` since there is no
     * chatId at spawn time). A surface can reuse the same localId string
     * across spawn vs input without collision.
     */
    localId: z.string().min(1),
    /**
     * Optional ingress metadata for special threads (group 11). Surfaces
     * never set this — only the server's voice-device
     * ingress hooks do. The host uses it for reply routing + broadcast
     * sidecar context.
     */
    source: ChatInputSource.optional(),
    /**
     * Composer attachments (spec/14 & spec/15 § Composer — "Attachments
     * (images + files)"). Refs only (bytes were uploaded to
     * `POST /api/chats/:chatId/attachment` first). The host resolves each id
     * to the on-disk copy it stored and feeds the files into the Claude turn by
     * path. Additive/optional so a plain text turn is unchanged.
     */
    attachments: z.array(AttachmentRef).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
    /**
     * Per-chat tool gating (patch/todo.md — "Show the tools in the chat … allow
     * the user to turn them on and off"). The names of tools the user has
     * switched OFF for this chat in the surface's Tools panel. The host merges
     * them into the SDK `disallowedTools` for the turn so a disabled tool is
     * removed from the model's context entirely — the agent can't reach for it.
     * The surface sends the CURRENT disabled set with every turn (the setting is
     * live, not spawn-only), so a mid-chat toggle takes effect on the next
     * message. Omitted/empty ⇒ every tool available (the default).
     */
    disabledTools: z.array(z.string().min(1)).optional(),
    /**
     * Address this input at a specific branch (spec/04 § Branching — "chat.input
     * … address a branch, not only the chat"). Absent means the chat's active
     * branch — today's behaviour, unchanged. Naming a non-active branch runs
     * (or queues behind) a turn on THAT track, independent of whatever the
     * active branch is doing.
     */
    branchId: z.string().min(1).optional(),
  })
  .strict();
export type ChatInputEvent = z.infer<typeof ChatInputEvent>;

/**
 * Permission decision. `approve` and `deny` are the simple cases; the
 * surface emits the response inline. `approve_with_edits` is the channel for
 * a decision whose CONTENT has to reach the tool (spec/03 § Answering with
 * content): the host substitutes the surface-supplied `editedNewString`
 * into the pending tool's arguments before forwarding the call. Where it
 * lands is per-tool — `Edit.new_string` / `Write.content` /
 * `NotebookEdit.new_source` for the Monaco-edited file content, and
 * `AskUserQuestion.answers` for the options the user picked.
 */
export const PermissionDecision = z.enum(['approve', 'deny', 'approve_with_edits']);
export type PermissionDecision = z.infer<typeof PermissionDecision>;

export const ChatPermissionResponseEvent = z
  .object({
    type: z.literal('chat.permission_response'),
    requestId: z.string().min(1),
    /**
     * Chat the request belongs to. Optional on the surface→host ingress
     * (the host keys pending requests by `requestId` alone, per the
     * spec/03 wire table `{requestId, approve}`). REQUIRED on the
     * host→surface echo the host emits when it resolves a request via
     * the spoken yes/no voice path (spec/07 ## Permission prompts during
     * voice: "host parses 'yes' / 'no' and emits chat.permission_response").
     * Surfaces need the chatId to flip the matching inline permission card —
     * they did not initiate the spoken resolution so they cannot supply it.
     */
    chatId: z.string().min(1).optional(),
    /**
     * Backwards-compat boolean flag. `true` ↔ `decision === 'approve'`
     * (or `'approve_with_edits'`); `false` ↔ `'deny'`. Surfaces SHOULD
     * emit `decision` for new code paths; `approve` is preserved so
     * older surfaces (CLI, mobile) continue to work without changes.
     */
    approve: z.boolean(),
    /** Group 19: explicit decision discriminator. */
    decision: PermissionDecision.optional(),
    /**
     * Required iff `decision === 'approve_with_edits'` — required meaning
     * PRESENT and a string, not non-empty. The empty string is a meaningful
     * value: it means "replace the content with nothing", i.e. an `Edit` whose
     * `new_string` is `''` or a `Write` of an empty file. ONE string, whose
     * meaning is fixed by the pending tool (spec/03 § Answering with
     * content): for a file edit it is the full new file content (the
     * `new_string` / `content` / `new_source` the agent proposed, as the
     * user tweaked it in Monaco); for `AskUserQuestion` it is the JSON
     * encoding of `{[questionText]: selectedOptionLabel}`, a multi-select's
     * labels joined with `, `. It is NOT a second, question-shaped field
     * because when this was designed every schema was `.strict()` on every
     * reader, so an unknown key made `decode` drop the whole frame, and host
     * hosts OTA behind the web surface often enough that a new field would
     * hang the chat on any host that hadn't caught up. That constraint is gone
     * (spec/03 § Forward compatibility — a host now ignores a field it does
     * not know); this channel stays as it is because it works end to end. Host substitutes this into the SDK tool call before granting
     * permission. NO FALLBACK: callers/consumers must pair this with the
     * matching decision; `assertValidPermissionResponse` (codec) enforces it.
     * Renamed from the original `editedDiff` in group 20 — the field never
     * carried diff text, only new content.
     */
    editedNewString: z.string().nullable().optional(),
    /**
     * Host→surface echo ONLY (spec/14 § Main chat panel — Question
     * prompts): the `{[questionText]: selectedOptionLabel}` this
     * `AskUserQuestion` was actually resolved with, decoded from
     * `editedNewString` once here rather than left for every surface to
     * re-parse. Present only when the host resolved an `AskUserQuestion`
     * with `approve_with_edits` — never sent by a surface, and absent for
     * every other permission kind. Without it, a surface that did not
     * originate the resolution (a second connected tab, the voice echo, a
     * reconnect after the host settled it) has no way to know what was
     * picked, and its question card can only say "Answered" with every
     * option blank.
     */
    answers: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type ChatPermissionResponseEvent = z.infer<typeof ChatPermissionResponseEvent>;

/**
 * Cross-field invariant for `chat.permission_response`: when
 * `decision === 'approve_with_edits'`, `editedNewString` MUST be a string. The
 * empty string passes — it is a meaningful answer meaning "replace the content
 * with nothing" (an `Edit` deleting its `new_string`, a `Write` of an empty
 * file). `undefined`/`null` still throw: an absent field is an answer that was
 * lost, not an answer of nothing. Kept outside the zod object so the strict
 * discriminated-union remains a plain ZodObject.
 */
export function assertValidPermissionResponse(ev: ChatPermissionResponseEvent): void {
  if (ev.decision === 'approve_with_edits') {
    if (typeof ev.editedNewString !== 'string') {
      throw new Error(
        "chat.permission_response: decision='approve_with_edits' requires editedNewString",
      );
    }
  }
}

export const ChatSpawnRequestEvent = z
  .object({
    type: z.literal('chat.spawn_request'),
    /**
     * The host to run on. REQUIRED (spec/04 § Spawn). A spawn that names no
     * host is rejected here rather than routed to whichever host happens to
     * be attached — the same folder string on two hosts is two different
     * directories, so guessing means running in the wrong one.
     */
    ...daemonIdField,
    folder: z.string().min(1),
    prompt: z.string().optional(),
    parentChatId: z.string().min(1).optional(),
    name: z.string().optional(),
    /**
     * Server-allocated ULID. When present, the host uses this id rather
     * than generating its own (canonical: server allocates — see spec/04).
     * Optional for back-compat with unit tests; production paths always set it.
     */
    chatId: z.string().min(1).optional(),
    /**
     * Idempotency key for the spawn request itself — host dedupes on
     * `(accountId, 'spawn', localId)` so a surface retrying the same
     * spawn doesn't end up with two chats. **Separate dedupe space** from
     * `chat.input.localId`: a surface can reuse the same string across
     * spawn vs input without collision.
     */
    localId: z.string().min(1).optional(),
    /**
     * Spawn the chat into HIDDEN rather than the active inbox (spec/04 §
     * Hidden, spec/08 ## Action): a job whose runs are background noise sets
     * this through its action's `startHidden`. User-initiated spawns leave it
     * unset → active.
     */
    hidden: z.boolean().optional(),
    /**
     * The name `hidden` had before 2026-09-28, when archived came to mean
     * stopped. A server predating the rename still sends it, and it meant
     * "keep this run out of the inbox" — which is `hidden` now, so the host
     * reads it as that. Never sent by a current server.
     */
    archived: z.boolean().optional(),
    /**
     * OPTIONAL at every spawn site. From the NAMED host's catalogue, fixed for
     * the chat's life, and it selects the backend the chat runs on. Omitted,
     * the chat takes that host's last-used model (spec/04 § Spawn) — resolving
     * it belongs to the machine, not to the protocol, so the contract must not
     * oblige any caller to supply one. A host that has never read a catalogue
     * has no last-used model, and a spawn there naming none is an error saying
     * so — resolved on the host, not defaulted here.
     */
    model: z.string().min(1).optional(),
    /**
     * SDK `query()` permission mode (CLI `--dangerously-skip-permissions` →
     * `'bypassPermissions'`). Maps to the Agent SDK `options.permissionMode`
     * (spec/13 ## Flag pass-through). Unset, the chat resolves through the
     * host's default (spec/02 § Permission mode).
     */
    permissionMode: PermissionMode.optional(),
    /**
     * The shared account this chat's turns START on (spec/10 § Backend
     * credentials — preferred account). A preference, not a pin: a turn walks
     * past it when it has no credit, and a failure is attributed to the key
     * the turn actually ran on. Fixed for the chat's life. An id the host does
     * not hold is refused.
     *
     * Not `accountId`: that key is a retired pin still sitting in old chat
     * meta, and reading it back as a preference would revive every one of them.
     */
    preferredAccountId: z.string().min(1).optional(),
    /**
     * Set the chat's goal (spec/04 § Goals) the moment it is created — a job's
     * `spawn`/`continue` action's own `goal` field (spec/08 ## Action).
     * Optional; a user-initiated spawn never sets it.
     */
    goal: z.string().min(1).optional(),
  })
  .strict();
export type ChatSpawnRequestEvent = z.infer<typeof ChatSpawnRequestEvent>;

/**
 * A chat's per-chat permission-mode override (spec/03 § Surface events,
 * spec/02 § Permission mode). Takes precedence over its host's default and
 * takes effect on the next turn.
 *
 * OMITTING `permissionMode` CLEARS the override — it does not mean "no
 * change". A frame with nothing to say is not sent at all, so the only reason
 * to send this without the field is to fall back to the host default, and
 * making that the meaning is what gives the surface a way to undo an override.
 */
export const ChatSettingsEvent = z
  .object({
    type: z.literal('chat.settings'),
    chatId: z.string().min(1),
    permissionMode: PermissionMode.optional(),
  })
  .strict();
export type ChatSettingsEvent = z.infer<typeof ChatSettingsEvent>;

export const ChatStopRequestEvent = z
  .object({
    type: z.literal('chat.stop_request'),
    chatId: z.string().min(1),
    /**
     * Stop a specific branch's turn (spec/04 § Branching). Absent means the
     * chat's active branch — today's behaviour, unchanged.
     */
    branchId: z.string().min(1).optional(),
  })
  .strict();
export type ChatStopRequestEvent = z.infer<typeof ChatStopRequestEvent>;

export const ChatResumeRequestEvent = z
  .object({
    type: z.literal('chat.resume_request'),
    chatId: z.string().min(1),
  })
  .strict();
export type ChatResumeRequestEvent = z.infer<typeof ChatResumeRequestEvent>;

/**
 * Stop waiting out a usage limit and run the parked turn NOW (spec/10 § Usage).
 *
 * The auto-resume is a promise about a future moment, and sometimes the
 * situation has changed before it: a limit reset early, an account was topped
 * up, another was added. Without this the only way to act on that was to retype
 * the message, which loses the queue position and duplicates the turn.
 *
 * A no-op when the chat is not parked. Fires the pending turn on whatever
 * account the host now resolves to — which may be a different one from the
 * account that ran out.
 */
export const ChatResumeNowRequestEvent = z
  .object({
    type: z.literal('chat.resume_now_request'),
    chatId: z.string().min(1),
  })
  .strict();
export type ChatResumeNowRequestEvent = z.infer<typeof ChatResumeNowRequestEvent>;

/**
 * Cancel a still-pending queued turn (spec/04 ## Message queueing). The surface
 * fires this when the user removes a queued message before it runs. The host
 * drops the matching `localId` from the chat's queue and echoes
 * `chat.dequeued{ reason: 'cancelled' }`. A no-op if the turn already started
 * (it can be stopped with `chat.stop_request` instead) or never existed.
 */
export const ChatUnqueueRequestEvent = z
  .object({
    type: z.literal('chat.unqueue_request'),
    chatId: z.string().min(1),
    localId: z.string().min(1),
  })
  .strict();
export type ChatUnqueueRequestEvent = z.infer<typeof ChatUnqueueRequestEvent>;

/**
 * Promote a still-pending queued turn to the HEAD of the chat's queue and
 * interrupt the in-flight turn so it runs next (spec/04 ## Message queueing —
 * "I meant this instead, stop what you're doing"). The host moves the
 * matching `localId` to the front (other queued turns keep their relative
 * order) and then stops the running turn exactly as `chat.stop_request` does,
 * emitting `chat.stopped{ reason: 'user-stop' }`. A no-op — with NO interrupt —
 * if the `localId` is not a still-pending queued turn.
 */
export const ChatPromoteRequestEvent = z
  .object({
    type: z.literal('chat.promote_request'),
    chatId: z.string().min(1),
    localId: z.string().min(1),
  })
  .strict();
export type ChatPromoteRequestEvent = z.infer<typeof ChatPromoteRequestEvent>;

/**
 * Replace the typed text of a still-pending queued turn (spec/04 ## Message
 * queueing § Edit). The turn keeps its queue place, its attachments and
 * whatever the host folded around the typed text when it accepted it. The
 * host echoes `chat.queued` with the same `localId`/`queueSeq` and the new
 * text. A no-op if the `localId` is not a still-pending queued turn — an edit
 * never runs as a new turn.
 */
export const ChatEditQueuedRequestEvent = z
  .object({
    type: z.literal('chat.edit_queued_request'),
    chatId: z.string().min(1),
    localId: z.string().min(1),
    message: z.string(),
  })
  .strict();
export type ChatEditQueuedRequestEvent = z.infer<typeof ChatEditQueuedRequestEvent>;

/**
 * Edit a user turn, forking a new TRACK from it (spec/04 § Branching). `seq` is
 * the seq of the user message being edited and `message` its replacement text.
 * The host forks the active branch's Claude session at the turn immediately
 * before `seq`, makes the new branch active, and runs `message` as its first
 * turn — the original track is left untouched and remains switchable-to.
 *
 * `localId` is the same idempotency key space as `chat.input`.
 */
export const ChatForkRequestEvent = z
  .object({
    type: z.literal('chat.fork_request'),
    chatId: z.string().min(1),
    seq: z.number().int().nonnegative(),
    message: z.string().min(1),
    localId: z.string().min(1),
  })
  .strict();
export type ChatForkRequestEvent = z.infer<typeof ChatForkRequestEvent>;

/**
 * Start a SIDE thread off the message at `seq` (spec/04 § Side threads). Unlike
 * a fork, the shared prefix runs up to AND INCLUDING that message — which may be
 * a user OR an assistant turn — and `message` is a NEW question rather than a
 * replacement. The host creates a `side N` branch and runs `message` there on
 * its own independent pump (spec/04 § Parallel branches) — it does NOT become
 * active, so the main track's continuation runs alongside it, untouched.
 *
 * `localId` is the same idempotency key space as `chat.input`.
 */
export const ChatSideRequestEvent = z
  .object({
    type: z.literal('chat.side_request'),
    chatId: z.string().min(1),
    seq: z.number().int().nonnegative(),
    message: z.string().min(1),
    localId: z.string().min(1),
    /**
     * Which branch `seq` belongs to (spec/14 § Side threads panel — "Side
     * threads can branch again from inside the panel"). Absent means the
     * chat's active branch — the ordinary main-track trigger, unchanged.
     * Naming a side branch forks a NEW side thread off a message inside that
     * branch's own track, parented to it rather than to the active branch.
     */
    branchId: z.string().min(1).optional(),
  })
  .strict();
export type ChatSideRequestEvent = z.infer<typeof ChatSideRequestEvent>;

/**
 * Make `branchId` the chat's active track (spec/04 § Branching). The host
 * repoints `activeBranchId` — and therefore `claudeSessionId` — at that branch
 * and emits `chat.branches` + `chat.state`; the surface re-replays to render
 * the newly-active track. Refused (`branch_not_found`) for an unknown branch.
 */
export const ChatBranchSwitchRequestEvent = z
  .object({
    type: z.literal('chat.branch_switch_request'),
    chatId: z.string().min(1),
    branchId: z.string().min(1),
  })
  .strict();
export type ChatBranchSwitchRequestEvent = z.infer<typeof ChatBranchSwitchRequestEvent>;

export const ChatFocusChangeEvent = z
  .object({
    type: z.literal('chat.focus_change'),
    // `null` unsubscribes (the surface is not watching any chat).
    chatId: z.string().min(1).nullable(),
    // Stamped by the server hub on the surface→host hop so the host can
    // re-target the originating surface's open voice session (focus-follow,
    // spec/07 ## Focus-follow). Surfaces never set it; the hub overwrites.
    ...forSurfaceIdField,
  })
  .strict();
export type ChatFocusChangeEvent = z.infer<typeof ChatFocusChangeEvent>;

/**
 * Surface → server: this chat's composer now holds `text` (spec/14 § Composer
 * — server-owned drafts, spec/15 § Composer). The SERVER holds the draft, not
 * the host: a chat's host can be asleep and the draft still has to reach
 * every other open surface. Sent debounced by the surface (a pause in typing),
 * never per-keystroke. Whitespace-only `text` is accepted here rather than
 * forcing the surface to know to send `composer_draft.clear` instead — the
 * store applies the same not-a-draft rule (`hasDraftText`) and emits
 * `composer_draft.cleared` outward either way.
 */
export const ComposerDraftSetEvent = z
  .object({
    type: z.literal('composer_draft.set'),
    chatId: z.string().min(1),
    text: z.string(),
  })
  .strict();
export type ComposerDraftSetEvent = z.infer<typeof ComposerDraftSetEvent>;

/**
 * Surface → server: drop `chatId`'s draft outright — sent on send, on a
 * composer emptied back out, or when the chat is deleted. Equivalent to
 * `composer_draft.set` with empty text, but explicit so a call site clearing
 * a draft doesn't have to reason about the empty-string special case.
 */
export const ComposerDraftClearEvent = z
  .object({
    type: z.literal('composer_draft.clear'),
    chatId: z.string().min(1),
  })
  .strict();
export type ComposerDraftClearEvent = z.infer<typeof ComposerDraftClearEvent>;

/**
 * Server → every surface: `chatId`'s draft changed. `updatedAt` (server
 * receipt time) is the newest-write-wins clock: a surface with its OWN newer
 * unsent edit compares this against the local edit's own stamp and drops the
 * echo rather than clobbering what's under the cursor. Never sent with empty
 * text — an emptied composer is `composer_draft.cleared`, not this with `''`.
 */
export const ComposerDraftUpdatedEvent = z
  .object({
    type: z.literal('composer_draft.updated'),
    chatId: z.string().min(1),
    text: z.string().min(1),
    updatedAt: z.number(),
  })
  .strict();
export type ComposerDraftUpdatedEvent = z.infer<typeof ComposerDraftUpdatedEvent>;

/**
 * Server → every surface: `chatId`'s draft is gone — it was sent, emptied
 * back out, or the chat was deleted. `updatedAt` is the same newest-write-wins
 * stamp as `composer_draft.updated`.
 */
export const ComposerDraftClearedEvent = z
  .object({
    type: z.literal('composer_draft.cleared'),
    chatId: z.string().min(1),
    updatedAt: z.number(),
  })
  .strict();
export type ComposerDraftClearedEvent = z.infer<typeof ComposerDraftClearedEvent>;

/**
 * Server → surface, once, right after `auth.ok`: every draft the account
 * currently has. Composer drafts are account-wide, not per-machine, so unlike
 * `folders.list` this is sent once per connection rather than once per
 * registered host.
 */
export const ComposerDraftListEvent = z
  .object({
    type: z.literal('composer_draft.list'),
    drafts: z.array(
      z.object({ chatId: z.string().min(1), text: z.string().min(1), updatedAt: z.number() }),
    ),
  })
  .strict();
export type ComposerDraftListEvent = z.infer<typeof ComposerDraftListEvent>;

/**
 * A not-yet-sent NEW chat (spec/14 § New chat drafts): folder + host + model
 * + text. Server-owned exactly like composer drafts — one account-wide set,
 * so a draft typed on one surface is listed and deletable from every other.
 */
export const NewChatDraftBody = z
  .object({
    id: z.string().min(1),
    folder: z.string(),
    daemonId: z.string().min(1).optional(),
    text: z.string(),
    model: z.string().min(1).optional(),
  })
  .strict();
export type NewChatDraftBody = z.infer<typeof NewChatDraftBody>;

/** Surface → server: this new-chat draft now looks like `draft`. Whitespace-only text is a remove. */
export const NewChatDraftSetEvent = z
  .object({ type: z.literal('new_chat_draft.set'), draft: NewChatDraftBody })
  .strict();
export type NewChatDraftSetEvent = z.infer<typeof NewChatDraftSetEvent>;

/** Surface → server: drop the new-chat draft `id` (discarded, or consumed by its first send). */
export const NewChatDraftRemoveEvent = z
  .object({ type: z.literal('new_chat_draft.remove'), id: z.string().min(1) })
  .strict();
export type NewChatDraftRemoveEvent = z.infer<typeof NewChatDraftRemoveEvent>;

/** Server → every surface: a new-chat draft changed. `updatedAt` is the server receipt time. */
export const NewChatDraftUpdatedEvent = z
  .object({
    type: z.literal('new_chat_draft.updated'),
    draft: NewChatDraftBody.extend({ text: z.string().min(1) }),
    updatedAt: z.number(),
  })
  .strict();
export type NewChatDraftUpdatedEvent = z.infer<typeof NewChatDraftUpdatedEvent>;

/** Server → every surface: the new-chat draft `id` is gone. */
export const NewChatDraftRemovedEvent = z
  .object({
    type: z.literal('new_chat_draft.removed'),
    id: z.string().min(1),
    updatedAt: z.number(),
  })
  .strict();
export type NewChatDraftRemovedEvent = z.infer<typeof NewChatDraftRemovedEvent>;

/** Server → surface, once after `auth.ok`: every new-chat draft the account has (always sent, even empty, so a surface drops drafts deleted while it was away). */
export const NewChatDraftListEvent = z
  .object({
    type: z.literal('new_chat_draft.list'),
    drafts: z.array(NewChatDraftBody.extend({ text: z.string().min(1), updatedAt: z.number() })),
  })
  .strict();
export type NewChatDraftListEvent = z.infer<typeof NewChatDraftListEvent>;

/** Surface → host: start, pause, resume or end the meeting in a chat. */
export const MeetingControlRequestEvent = z
  .object({
    type: z.literal('meeting.control_request'),
    chatId: z.string().min(1),
    action: z.enum(['start', 'pause', 'resume', 'end']),
  })
  .strict();
export type MeetingControlRequestEvent = z.infer<typeof MeetingControlRequestEvent>;

/** Surface → host: ask for the chat's meeting (answered by `meeting.state`). */
export const MeetingGetRequestEvent = z
  .object({ type: z.literal('meeting.get_request'), chatId: z.string().min(1) })
  .strict();
export type MeetingGetRequestEvent = z.infer<typeof MeetingGetRequestEvent>;

/** Surface → host: one clip of meeting audio (16 kHz mono PCM16 WAV). */
export const MeetingAudioEvent = z
  .object({
    type: z.literal('meeting.audio'),
    chatId: z.string().min(1),
    source: z.enum(['mic', 'system']),
    audioBase64: z.string().min(1),
  })
  .strict();
export type MeetingAudioEvent = z.infer<typeof MeetingAudioEvent>;

/** Surface → host: run (`do`) or drop (`dismiss`) an action card. */
export const MeetingActionRequestEvent = z
  .object({
    type: z.literal('meeting.action_request'),
    chatId: z.string().min(1),
    actionId: z.string().min(1),
    decision: z.enum(['do', 'dismiss']),
  })
  .strict();
export type MeetingActionRequestEvent = z.infer<typeof MeetingActionRequestEvent>;

/** Host → surfaces: the chat's full meeting state (`null` = no meeting). */
export const MeetingStateEvent = z
  .object({
    type: z.literal('meeting.state'),
    chatId: z.string().min(1),
    meeting: MeetingState.nullable(),
  })
  .strict();
export type MeetingStateEvent = z.infer<typeof MeetingStateEvent>;

export const ChatPinRequestEvent = z
  .object({
    type: z.literal('chat.pin_request'),
    chatId: z.string().min(1),
    pinned: z.boolean(),
  })
  .strict();
export type ChatPinRequestEvent = z.infer<typeof ChatPinRequestEvent>;

export const ChatArchiveRequestEvent = z
  .object({
    type: z.literal('chat.archive_request'),
    chatId: z.string().min(1),
    archived: z.boolean(),
  })
  .strict();
export type ChatArchiveRequestEvent = z.infer<typeof ChatArchiveRequestEvent>;

/**
 * Surface → host: turn a special thread on/off (spec/06 § Disabled). The
 * real "off" switch for Manager/Speakers, since `chat.archive_request`
 * is refused for them.
 */
export const ChatDisableRequestEvent = z
  .object({
    type: z.literal('chat.disable_request'),
    chatId: z.string().min(1),
    disabled: z.boolean(),
  })
  .strict();
export type ChatDisableRequestEvent = z.infer<typeof ChatDisableRequestEvent>;

/**
 * Server → host: rotate a special thread's underlying session (spec/06 §
 * Session rotation). Fire-and-forget, same shape as the other chat request
 * events — the host's own guards (mid-turn, no digest generator, digest
 * failure) decide whether the rotation actually happens; a refusal is logged
 * host-side and the scheduler simply tries again on its next cycle.
 */
export const ChatRotateRequestEvent = z
  .object({
    type: z.literal('chat.rotate_request'),
    chatId: z.string().min(1),
  })
  .strict();
export type ChatRotateRequestEvent = z.infer<typeof ChatRotateRequestEvent>;

/**
 * One chat a sweep found changed, and why (spec/06 § Sweep — Gate). Carries no
 * message content — the digest's transcript snippets are assembled on the
 * HOME host (the one component with both local and cross-host read access
 * via `patch_history`), not here; the server's cross-host view only ever
 * covers chat STATE, never transcripts.
 */
export const ManagerSweepCandidate = z
  .object({
    chatId: z.string().min(1),
    daemonId: z.string().min(1),
    folder: z.string().min(1),
    edge: z.enum(['settled', 'stalled', 'permission', 'question', 'job-failed', 'task-ended']),
    idleMinutes: z.number().nonnegative(),
  })
  .strict();
export type ManagerSweepCandidate = z.infer<typeof ManagerSweepCandidate>;

/**
 * Server → home host: run a sweep (spec/06 § Sweep). Fire-and-forget, same
 * shape as `chat.rotate_request` — the gate has already decided this is due;
 * the host assembles the digest (fetching each candidate's recent messages,
 * local or cross-host), makes the one decision call, and executes it.
 */
export const ManagerSweepRunEvent = z
  .object({
    type: z.literal('manager.sweep_run'),
    runId: z.string().min(1),
    candidates: z.array(ManagerSweepCandidate).min(1),
    messagesPerChat: z.number().int().positive(),
    prompt: z.string().min(1),
    model: z.string().min(1),
  })
  .strict();
export type ManagerSweepRunEvent = z.infer<typeof ManagerSweepRunEvent>;

/** One action the sweep took (or chose not to) on one candidate chat. */
export const ManagerSweepAction = z
  .object({
    chatId: z.string().min(1),
    action: z.enum(['nudge', 'wake', 'flag', 'leave']),
  })
  .strict();
export type ManagerSweepAction = z.infer<typeof ManagerSweepAction>;

/**
 * Home host → server: what a sweep did (spec/06 § Sweep — Visible). Fire-
 * and-forget report, same direction/shape as a job's run outcome — the
 * server records it for the Manager view's "Last sweep" line and the sweep-
 * runs list, but nothing here blocks on the server's reply.
 */
export const ManagerSweepResultEvent = z
  .object({
    type: z.literal('manager.sweep_result'),
    runId: z.string().min(1),
    actions: z.array(ManagerSweepAction),
    tokensUsed: z.number().nonnegative(),
    error: z.string().optional(),
  })
  .strict();
export type ManagerSweepResultEvent = z.infer<typeof ManagerSweepResultEvent>;

/**
 * Surface → host snooze / unsnooze (spec/04 § Snooze). `snoozedUntil` is an
 * ABSOLUTE ms epoch (presets are resolved surface-side — a relative delta would
 * drift while the event is in flight); `null` unsnoozes. A timestamp in the past
 * is rejected by the host (NO FALLBACK — the caller is not given "now").
 */
export const ChatSnoozeRequestEvent = z
  .object({
    type: z.literal('chat.snooze_request'),
    chatId: z.string().min(1),
    snoozedUntil: z.number().int().nullable(),
  })
  .strict();
export type ChatSnoozeRequestEvent = z.infer<typeof ChatSnoozeRequestEvent>;

/**
 * Surface → host hide / show (spec/04 § Hidden). `hidden: false` is the
 * Hidden section's Show — the chat moves into the active list without anything
 * being sent to it. Refused for special threads and for archived chats (an
 * archived chat is stopped, and hidden is a state of running).
 */
export const ChatHideRequestEvent = z
  .object({
    type: z.literal('chat.hide_request'),
    chatId: z.string().min(1),
    hidden: z.boolean(),
  })
  .strict();
export type ChatHideRequestEvent = z.infer<typeof ChatHideRequestEvent>;

/**
 * Surface → host soft-delete / restore (spec/04 § Lifecycle, spec/14 § Chat
 * lifecycle). `deleted: true` moves the chat to status `deleted` (it leaves the
 * active list into the sidebar's _Deleted_ section); `deleted: false` restores
 * it back to `active`. Recoverable — the on-disk transcript is untouched.
 */
export const ChatDeleteRequestEvent = z
  .object({
    type: z.literal('chat.delete_request'),
    chatId: z.string().min(1),
    deleted: z.boolean(),
  })
  .strict();
export type ChatDeleteRequestEvent = z.infer<typeof ChatDeleteRequestEvent>;

/**
 * Surface → host set-goal (patch/todo.md — `/goal`). Sets the chat's goal to
 * `goal` (a `null` clears it). The host persists it to meta.json and echoes a
 * `chat.state` carrying `goal`, so every surface shows the goal at the top of
 * the chat. Mirrors the pin/archive request shape.
 */
export const ChatGoalRequestEvent = z
  .object({
    type: z.literal('chat.goal_request'),
    chatId: z.string().min(1),
    goal: z.string().nullable(),
  })
  .strict();
export type ChatGoalRequestEvent = z.infer<typeof ChatGoalRequestEvent>;

/**
 * Surface → host set-task-list (spec/02 § Task list). Carries the WHOLE list,
 * not a delta — the host adopts it wholesale, echoes a `chat.state` carrying
 * `todos`, and tells the agent about the edit on its next turn (the agent's own
 * TodoWrite state cannot be written from outside). Mirrors the goal request shape.
 */
export const ChatTodosRequestEvent = z
  .object({
    type: z.literal('chat.todos_request'),
    chatId: z.string().min(1),
    todos: z.array(TodoItem),
  })
  .strict();
export type ChatTodosRequestEvent = z.infer<typeof ChatTodosRequestEvent>;

/**
 * Surface → host rename (spec/04 § Name). Sets the chat's name to `name`; a
 * `null` clears it so the surface falls back to the folder-derived label. The
 * host trims it, persists to meta.json and echoes a `chat.state` carrying
 * `name`. Mirrors the goal request shape.
 */
export const ChatRenameRequestEvent = z
  .object({
    type: z.literal('chat.rename_request'),
    chatId: z.string().min(1),
    name: z.string().nullable(),
  })
  .strict();
export type ChatRenameRequestEvent = z.infer<typeof ChatRenameRequestEvent>;

/**
 * Surface → host set-reminder (patch/todo.md — Reminders). Sets the chat's
 * reminder to `reminder` (a `null` clears it). The host persists it to
 * meta.json and echoes a `chat.state` carrying `reminder`, so every surface
 * shows the reminder at the top of the chat. Mirrors the goal request shape.
 */
export const ChatReminderRequestEvent = z
  .object({
    type: z.literal('chat.reminder_request'),
    chatId: z.string().min(1),
    reminder: z.string().nullable(),
  })
  .strict();
export type ChatReminderRequestEvent = z.infer<typeof ChatReminderRequestEvent>;

/**
 * Surface → host arm/cancel a self-wake LOOP (`02-daemon.md` § Self-wake).
 * `/loop <interval> <message>` typed in the composer reaches the SAME
 * underlying scheduler the agent's `patch_loop` tool call reaches, just from a
 * surface instead of from the model — unlike `/goal`/`/remind`, which are pure
 * user-owned banner state with no agent-tool equivalent, a loop needs to land
 * on the real `WakeScheduler` record, so this carries through to
 * `daemon.scheduleWake`/`cancelWake` exactly like the MCP path.
 * `loop: null` cancels the chat's pending wake (loop or plain one-shot — same
 * one-record-per-chat slot, `02-daemon.md` § Self-wake); otherwise `every` is
 * the recurring interval in duration-string form (`"10m"`, `"1h30m"`, seconds
 * — the same grammar `patch_wake_me`'s `in` accepts) and `notAfter` is an
 * optional ISO-8601 validity cutoff.
 */
export const ChatLoopRequestEvent = z
  .object({
    type: z.literal('chat.loop_request'),
    chatId: z.string().min(1),
    loop: z
      .object({
        message: z.string().min(1),
        every: z.union([z.string(), z.number()]),
        notAfter: z.string().optional(),
      })
      .nullable(),
  })
  .strict();
export type ChatLoopRequestEvent = z.infer<typeof ChatLoopRequestEvent>;

/**
 * Surface → host model change (spec/04 § Model). Runs the chat on `model`
 * from its NEXT turn — a turn already running is left alone, because the model
 * is read as a turn starts and every turn is its own backend call.
 *
 * `model` is REQUIRED and has no "clear" meaning, unlike `chat.settings`'
 * permission-mode override: a chat is always running on some model, so there is
 * no host default to fall back to. That difference in meaning is why this is
 * its own event rather than another optional field on `chat.settings` — one
 * frame whose absent fields meant "clear" for one setting and "unchanged" for
 * another would eventually be read wrong.
 *
 * The host answers by emitting the chat's state carrying the new `model`
 * (`ChatStateEvent.model`), which is also how every OTHER surface holding the
 * chat learns of the change.  A model the host's catalogue does not offer is
 * refused with a `chat.error` (`unknown_model`) and the chat stays on the model
 * it was on — NO FALLBACK to a near match or to the host's last-used one.
 *
 * WIRE COMPATIBILITY: hosts update their host separately from the server, so
 * a host can be running a host that predates this EVENT TYPE and will drop
 * the frame (spec/03 § Forward compatibility — tolerance covers unknown fields
 * on events a build knows; it cannot invent a handler for an event it has never
 * heard of). There is deliberately no silent path for that on the surface side:
 * the surface holds its choice as pending until a `chat.state` confirms
 * the new model, and reports a failure to confirm as an error naming the host
 * (spec/14 § Model selector). `ChatStateEvent.model` never arriving is the
 * observable signal — an older host cannot send it.
 */
export const ChatModelRequestEvent = z
  .object({
    type: z.literal('chat.model_request'),
    chatId: z.string().min(1),
    model: z.string().min(1),
  })
  .strict();
export type ChatModelRequestEvent = z.infer<typeof ChatModelRequestEvent>;

export const FileWriteEvent = z
  .object({
    type: z.literal('file.write'),
    chatId: z.string().min(1),
    path: z.string().min(1),
    content: z.string(),
  })
  .strict();
export type FileWriteEvent = z.infer<typeof FileWriteEvent>;

/**
 * Host → surfaces: a file on this chat's folder just landed a real write on
 * disk (spec/14 § File browser — live updates). Fired from every write path —
 * an editor-initiated `file.write`, a file-browser `fileOp` (create/rename),
 * and a completed agent Edit/Write/NotebookEdit tool call — so a surface with
 * that file open (or with the tree open at all) knows to treat its own cached
 * copy as stale, whether or not IT was the one that made the change.
 *
 * Carries no content: the point is "go re-read", not to replace a REST fetch
 * with a push payload — a surface not currently looking at `path` has no
 * reason to receive its bytes at all, and one that is invalidates its own
 * query and re-fetches (`GET /api/chats/:id/files`), which stays the single
 * source of truth for what is actually on disk.
 */
export const PatchFileChangedEvent = z
  .object({
    type: z.literal('patch.file_changed'),
    chatId: z.string().min(1),
    path: z.string().min(1),
  })
  .strict();
export type PatchFileChangedEvent = z.infer<typeof PatchFileChangedEvent>;

export const SurfaceHeartbeatEvent = z
  .object({
    type: z.literal('surface.heartbeat'),
  })
  .strict();
export type SurfaceHeartbeatEvent = z.infer<typeof SurfaceHeartbeatEvent>;

// Server → surface pong for `surface.heartbeat`. Gives the surface an
// application-level liveness signal so it can detect a HALF-OPEN ("zombie")
// socket — the classic flaky-mobile / train-internet failure where TCP dies
// silently, the browser never fires `close`, `readyState` stays OPEN, and the
// surface would otherwise sit "connected" forever while nothing flows. The
// surface arms a watchdog once it has seen at least one ack (proving the server
// pongs), then force-reconnects if acks (and all other inbound traffic) stop.
export const SurfaceHeartbeatAckEvent = z
  .object({
    type: z.literal('surface.heartbeat_ack'),
  })
  .strict();
export type SurfaceHeartbeatAckEvent = z.infer<typeof SurfaceHeartbeatAckEvent>;

// ---------------------------------------------------------------------------
// Host events (spec/03 § Host events)
//
// Every host-scoped control a surface can change has a surface-originated
// frame HERE carrying `daemonId` — no exceptions. A surface with no frame to
// send renders a read-only list instead, which is exactly how a machine
// setting ends up changeable from the web app and not from the phone. The
// host-owned lists are therefore PAIRED: a snapshot and a change push
// outward (`folders.list` / `folders.updated`, `daemon.account`), and an edit
// frame inward. The folder registry was the case that was previously
// outward-only.
//
// Two of these go to the SERVER rather than to a host, because the server owns
// the registry entry rather than the machine: renaming a host and marking one
// the home host. The rest are addressed to the named machine.

/** Surface → server: set a host's user-editable label. */
export const HostRenameEvent = z
  .object({
    type: z.literal('host.rename'),
    ...daemonIdField,
    /**
     * Non-empty. An empty name is rejected naming the offending value rather
     * than falling back to the machine hostname — a host that silently renames
     * itself back is indistinguishable from an edit that did not save.
     */
    hostName: z.string().min(1),
  })
  .strict();
export type HostRenameEvent = z.infer<typeof HostRenameEvent>;

/** Surface → server: make this host the account's home host (spec/06). */
export const HostSetHomeEvent = z
  .object({
    type: z.literal('host.set_home'),
    ...daemonIdField,
  })
  .strict();
export type HostSetHomeEvent = z.infer<typeof HostSetHomeEvent>;

/**
 * Server → surfaces: this host was removed from the account
 * (`DELETE /api/hosts/:daemonId`). Its credential is revoked, so it cannot
 * reconnect without being paired again; a surface drops it from its host list
 * and forgets its cached `daemon.host` / `daemon.account` reports. Sent once,
 * to every connected surface; a surface that was offline learns it from the
 * next `auth.ok` roster, which no longer names the host.
 */
export const HostRemovedEvent = z
  .object({
    type: z.literal('host.removed'),
    ...daemonIdField,
  })
  .strict();
export type HostRemovedEvent = z.infer<typeof HostRemovedEvent>;

/** Surface → host: the settings that stay with one machine (spec/01 § Settings). */
export const HostSettingsEvent = z
  .object({
    type: z.literal('host.settings'),
    ...daemonIdField,
    /**
     * LEGACY, for surfaces that predate `harnessMcpServers`: set `enabled` on
     * the two browser servers. Ignored when the same frame carries the list.
     */
    harnessBrowserToolsEnabled: z.boolean().optional(),
    /** The MCP servers this host adds to every chat — machine-specific commands and paths. */
    harnessMcpServers: McpServerList.optional(),
    /**
     * LEGACY, kept so older surfaces still decode: a current host always
     * loads the shipped Manager/Speakers CLAUDE.md and ignores
     * `false` here (logging it).
     */
    harnessClaudeMdEnabled: z.boolean().optional(),
    /**
     * Set this host's agent-browser routing (spec/02 § Browser — Route
     * through): a `daemonId` routes `patch_browser_*` traffic through that
     * host's network instead of this one's; `null` turns routing off (direct
     * again); absent leaves the current setting unchanged. Changing this
     * value (either direction) closes this host's open browser tabs — the
     * underlying Chromium only picks up a new proxy on launch, so there is no
     * way to re-route a tab already in flight.
     */
    browserRouteThrough: z.string().min(1).nullable().optional(),
  })
  .strict();
export type HostSettingsEvent = z.infer<typeof HostSettingsEvent>;

/** Surface → host: start (or resume) an optional component's download. */
export const HostComponentInstallEvent = z
  .object({
    type: z.literal('host.component_install'),
    ...daemonIdField,
    componentId: z.string().min(1),
  })
  .strict();
export type HostComponentInstallEvent = z.infer<typeof HostComponentInstallEvent>;

/** Surface → host: delete an installed optional component. */
export const HostComponentRemoveEvent = z
  .object({
    type: z.literal('host.component_remove'),
    ...daemonIdField,
    componentId: z.string().min(1),
  })
  .strict();
export type HostComponentRemoveEvent = z.infer<typeof HostComponentRemoveEvent>;

/**
 * Host → surfaces: live component-download progress (spec/02 § Optional
 * components). LIVE-ONLY, like `chat.message_delta`: no `seq`, never
 * persisted, never replayed. The SETTLED result lands on `daemon.host`'s
 * `components[]` instead, which is what a surface that connects mid-download
 * or after one finished reads. Streams to EVERY surface, so a download started
 * on the phone is visible on the desktop.
 */
export const HostComponentProgressEvent = z
  .object({
    type: z.literal('host.component_progress'),
    ...daemonIdField,
    componentId: z.string().min(1),
    state: HostComponentState,
    receivedBytes: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
    error: z.string().min(1).optional(),
    /**
     * What the install is doing right now, for the stretch where bytes alone
     * don't say it. A voice component finishes downloading its weights and then
     * builds a Python runtime for several minutes (spec/02 § Optional
     * components); with only a byte count to render, a surface would sit at
     * 100% looking hung.
     */
    note: z.string().min(1).optional(),
  })
  .strict();
export type HostComponentProgressEvent = z.infer<typeof HostComponentProgressEvent>;

/** Surface → host: apply that host's available host update now. */
export const HostUpdateEvent = z
  .object({
    type: z.literal('host.update'),
    ...daemonIdField,
  })
  .strict();
export type HostUpdateEvent = z.infer<typeof HostUpdateEvent>;

/** Surface → host: designate a project root on that host (spec/04 § Folders). */
export const HostFolderAddEvent = z
  .object({
    type: z.literal('host.folder_add'),
    ...daemonIdField,
    /** Absolute path on THAT host. Empty is rejected, not ignored. */
    path: z.string().min(1),
  })
  .strict();
export type HostFolderAddEvent = z.infer<typeof HostFolderAddEvent>;

/** Surface → host: drop a designated project root on that host. */
export const HostFolderRemoveEvent = z
  .object({
    type: z.literal('host.folder_remove'),
    ...daemonIdField,
    path: z.string().min(1),
  })
  .strict();
export type HostFolderRemoveEvent = z.infer<typeof HostFolderRemoveEvent>;

/**
 * One Claude Code memory entry on one host (spec/02 § Claude Code settings).
 * `project` is the encoded project-directory name under that host's
 * `~/.claude/projects/` (the same encoding Claude Code's own history uses —
 * opaque here, not decoded, so two projects can never collide into one
 * label). `name`/`description`/`type` come from the entry file's frontmatter;
 * a file with missing or unparsable frontmatter still appears, with the
 * unparsed fields blank, because the host still deleted-or-kept it either way
 * — a memory a person cannot see is not one they can decide about.
 */
export const ClaudeMemoryEntry = z
  .object({
    project: z.string().min(1),
    file: z.string().min(1),
    name: z.string(),
    description: z.string(),
    memoryType: z.string(),
    /**
     * The project folder `project` encodes, resolved on the host's disk. The
     * encoding turns both `/` and `-` into `-`, so it cannot be decoded by
     * string alone. Absent when the folder no longer exists or the host
     * predates this; a surface then shows `project` as it is.
     */
    projectDir: z.string().optional(),
    /** The entry's text, frontmatter stripped. Absent: the host predates it. */
    body: z.string().optional(),
    /** The file's last modification, ms since epoch. Absent: the host predates it. */
    updatedAt: z.number().optional(),
  })
  .strict();
export type ClaudeMemoryEntry = z.infer<typeof ClaudeMemoryEntry>;

const claudeSettingsFields = {
  ...daemonIdField,
  /**
   * Raw text of that host's `~/.claude/settings.json` — permissions, hooks,
   * model, statusLine, env and anything else Claude Code itself reads from
   * it. Carried as opaque text rather than a Patch-defined schema because
   * Claude Code owns that shape and evolves it independently; Patch is a
   * pass-through, not a second source of truth for it. Empty string when the
   * host has no such file.
   */
  /**
   * This machine's `settings.json` text when it no longer matches what the
   * last snapshot wrote (spec/02 § Claude Code settings). Absent when in step.
   */
  drift: z.string().optional(),
  /** Every memory entry found under that host's `~/.claude/projects/*\/memory/`. */
  memories: z.array(ClaudeMemoryEntry),
};

/**
 * Host → surfaces: that host's Claude Code settings.json + memory entries
 * (spec/02 § Claude Code settings). `claude_settings.list` is the full
 * snapshot sent on (re)connect; `claude_settings.updated` is the push sent
 * after a `host.claude_settings_set` / `host.claude_memory_delete` lands.
 * Both carry the COMPLETE state for one host, mirroring `folders.list` /
 * `folders.updated`.
 */
export const ClaudeSettingsListEvent = z
  .object({ type: z.literal('claude_settings.list'), ...claudeSettingsFields })
  .strict();
export type ClaudeSettingsListEvent = z.infer<typeof ClaudeSettingsListEvent>;

export const ClaudeSettingsUpdatedEvent = z
  .object({ type: z.literal('claude_settings.updated'), ...claudeSettingsFields })
  .strict();
export type ClaudeSettingsUpdatedEvent = z.infer<typeof ClaudeSettingsUpdatedEvent>;

/**
 * Surface → host: delete one memory entry on that host — the "decide about
 * memories" control. Removes the file and its line in that project's
 * `MEMORY.md` index. A `project`/`file` pair the host does not have is
 * refused naming it, not silently ignored.
 */
export const HostClaudeMemoryDeleteEvent = z
  .object({
    type: z.literal('host.claude_memory_delete'),
    ...daemonIdField,
    project: z.string().min(1),
    file: z.string().min(1),
  })
  .strict();
export type HostClaudeMemoryDeleteEvent = z.infer<typeof HostClaudeMemoryDeleteEvent>;

/**
 * Surface → host: replace one memory entry's text on that host, keeping its
 * frontmatter (name, description, type) as it was. A `project`/`file` pair the
 * host does not have is refused naming it, like the delete.
 */
export const HostClaudeMemorySetEvent = z
  .object({
    type: z.literal('host.claude_memory_set'),
    ...daemonIdField,
    project: z.string().min(1),
    file: z.string().min(1),
    body: z.string(),
  })
  .strict();
export type HostClaudeMemorySetEvent = z.infer<typeof HostClaudeMemorySetEvent>;

/**
 * Surface → host: read every stored account's usage from Anthropic now,
 * rather than waiting for the ten-minute poll (spec/10 § Surface in Settings —
 * Usage).
 *
 * Exists because the figure a person most wants is the one they are looking at
 * while deciding whether to wait or to add an account, and a reading up to ten
 * minutes old is not that. The host answers with a fresh `daemon.account`;
 * there is no dedicated reply frame, because the report IS the answer and a
 * second shape would be a second thing to keep in step.
 */
export const HostBackendUsageRefreshEvent = z
  .object({
    type: z.literal('host.backend_usage_refresh'),
    ...daemonIdField,
    backendId: z.string().min(1),
  })
  .strict();
export type HostBackendUsageRefreshEvent = z.infer<typeof HostBackendUsageRefreshEvent>;

/**
 * Surface → host: add a NEW named Claude credential on one host, alongside
 * whatever is already stored, rather than replacing one (spec/10 § Backend
 * credentials — multiple accounts). `token` is required: an added account has
 * to come from somewhere explicit (a pasted `claude setup-token` value) —
 * there is no "re-adopt the host's own login" case here, since that credential
 * is already covered by the first (legacy-seeded or explicitly connected)
 * account. `label` is the user-given name shown in Settings and the per-chat
 * account picker; omitted, the host derives one (e.g. from the resolved
 * account's email, else a numbered placeholder).
 */
export const HostBackendAddAccountEvent = z
  .object({
    type: z.literal('host.backend_add_account'),
    ...daemonIdField,
    backendId: z.string().min(1),
    token: z.string().min(1).optional(),
    authMethod: z.enum(['browser', 'device', 'cancel']).optional(),
    requestId: z.string().min(1).optional(),
    label: z.string().min(1).optional(),
  })
  .strict();
export type HostBackendAddAccountEvent = z.infer<typeof HostBackendAddAccountEvent>;

export const SurfaceForegroundedEvent = z
  .object({
    type: z.literal('surface.foregrounded'),
  })
  .strict();
export type SurfaceForegroundedEvent = z.infer<typeof SurfaceForegroundedEvent>;

export const SurfaceBackgroundedEvent = z
  .object({
    type: z.literal('surface.backgrounded'),
  })
  .strict();
export type SurfaceBackgroundedEvent = z.infer<typeof SurfaceBackgroundedEvent>;

/**
 * Surface → server: how long since the user last touched this computer
 * (spec/09 § Presence heuristic). The desktop app reports the whole machine's
 * input idle time, so typing in any app counts; a browser tab can only see
 * input on its own page. Sent every 15s whether or not Patch is on screen —
 * it is how the server tells "at the computer" from "a window left open".
 */
export const SurfaceInputEvent = z
  .object({
    type: z.literal('surface.input'),
    idleMs: z.number().int().nonnegative(),
    /** `system`: any input on the machine. `page`: input on this page only. */
    scope: z.enum(['system', 'page']),
  })
  .strict();
export type SurfaceInputEvent = z.infer<typeof SurfaceInputEvent>;

// ---------------------------------------------------------------------------
// Cross-chat tool events
//
// Spec models cross-chat tools as request/response pairs in the audit log.
// `patch.peek` has both; `patch.send_to` and `patch.spawn` are fire-and-forget
// from the source's POV but recorded as events for audit (mirrored on the
// `chat.tool_call` / `chat.tool_result` envelope when the tool fires).
//
// A call whose target chat lives on the calling host's own host is
// short-circuited in-process and never reaches the wire at all. `requestId`
// is present ONLY on the wire frame for a target on ANOTHER host — that is
// what tells the server (spec/03 § Cross-chat tools) this is a relay to
// perform and answer, rather than an audit record of a call already handled
// locally (`patch.send_to` in particular is emitted for audit on every call,
// local or not; `requestId`'s presence is the only signal that distinguishes
// a relay in flight from an audit record of one already finished).

export const PatchPeekRequestEvent = z
  .object({
    type: z.literal('patch.peek.request'),
    sourceChatId: z.string().min(1),
    targetChatId: z.string().min(1),
    /** Present iff this is a cross-host relay the caller is waiting on. */
    requestId: z.string().min(1).optional(),
    /** Mirrors `patch_peek`'s own `limit` (default 50, hard cap 200). */
    limit: z.number().int().positive().max(200).optional(),
  })
  .strict();
export type PatchPeekRequestEvent = z.infer<typeof PatchPeekRequestEvent>;

/**
 * The owning host's answer to a cross-host `patch_peek` (spec/03 § Cross-chat
 * tools). `result`, present iff `ok`, is the same `{ chat_state, events,
 * truncated }` shape `/internal/peek/:id` already returns for a local chat —
 * carried opaquely (`unknown`) rather than re-declared here, since re-typing
 * it would just be a second place for that shape to drift from the first.
 */
export const PatchPeekResponseEvent = z
  .object({
    type: z.literal('patch.peek.response'),
    requestId: z.string().min(1).optional(),
    sourceChatId: z.string().min(1),
    targetChatId: z.string().min(1),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z
      .object({
        code: ChatErrorCode,
        message: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();
export type PatchPeekResponseEvent = z.infer<typeof PatchPeekResponseEvent>;

export const PatchSendToEvent = z
  .object({
    type: z.literal('patch.send_to'),
    sourceChatId: z.string().min(1),
    targetChatId: z.string().min(1),
    message: z.string(),
    /** Present iff this is a cross-host relay the caller is waiting on. */
    requestId: z.string().min(1).optional(),
    voicePrefix: z.string().optional(),
  })
  .strict();
export type PatchSendToEvent = z.infer<typeof PatchSendToEvent>;

/**
 * The owning host's answer to a cross-host `patch_send_to`. NO FALLBACK: a
 * same-host `patch_send_to` resolves synchronously in-process, so before this
 * existed a cross-host one had nothing to carry a `chat_not_found` (or an
 * offline target) back — the calling agent's tool call would hang to its
 * transport timeout instead of failing inside the turn.
 */
export const PatchSendToResponseEvent = z
  .object({
    type: z.literal('patch.send_to.response'),
    requestId: z.string().min(1),
    sourceChatId: z.string().min(1),
    targetChatId: z.string().min(1),
    ok: z.boolean(),
    error: z
      .object({
        code: ChatErrorCode,
        message: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();
export type PatchSendToResponseEvent = z.infer<typeof PatchSendToResponseEvent>;

export const PatchSpawnEvent = z
  .object({
    type: z.literal('patch.spawn'),
    sourceChatId: z.string().min(1),
    /**
     * The host the new chat is created on. Required, exactly as on the surface
     * spawn request — an agent spawning a chat is choosing a machine whether it
     * realises it or not, so the contract makes it say which.
     */
    ...daemonIdField,
    folder: z.string().min(1),
    /** Optional; omitted takes the NAMED host's last-used model (spec/04 § Spawn). */
    model: z.string().min(1).optional(),
    prompt: z.string(),
    /**
     * Correlates the named host's `patch.spawn.response` with THIS call.
     * Present only when the frame is a cross-host REQUEST the caller is waiting
     * on; a same-host `patch.spawn` is only an audit record of a chat that was
     * already created in-process, so there is nothing to answer.
     */
    requestId: z.string().min(1).optional(),
  })
  .strict();
export type PatchSpawnEvent = z.infer<typeof PatchSpawnEvent>;

/**
 * The named host's answer to a cross-host `patch.spawn` (spec/03 § Cross-chat
 * tools: a cross-chat call "resolves rather than buffering ... and the agent
 * decides what to do").
 *
 * NO FALLBACK: without this frame a spawn the target REFUSED (no model
 * catalogue, unknown folder, SDK failure) left the calling agent's tool call
 * reporting success for a chat that does not exist. `ok:false` carries the
 * machine's own reason, and `daemonId` is required so the error can name the
 * machine that refused rather than leaving the agent to guess which of its
 * hosts failed.
 */
export const PatchSpawnResponseEvent = z
  .object({
    type: z.literal('patch.spawn.response'),
    /** Echoed from the request, so a chat with several spawns in flight can tell them apart. */
    requestId: z.string().min(1),
    /** The chat that called `patch_spawn` — the machine the answer is relayed back to. */
    sourceChatId: z.string().min(1),
    /** The machine that handled the spawn. Required, exactly as on the request. */
    ...daemonIdField,
    folder: z.string().min(1),
    ok: z.boolean(),
    /** The new chat, present iff `ok`. */
    chatId: z.string().min(1).optional(),
    /** The target machine's own refusal, present iff `!ok`. */
    error: z
      .object({
        code: ChatErrorCode,
        message: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();
export type PatchSpawnResponseEvent = z.infer<typeof PatchSpawnResponseEvent>;

export const PatchHistoryRequestEvent = z
  .object({
    type: z.literal('patch.history.request'),
    sourceChatId: z.string().min(1),
    targetChatId: z.string().min(1),
    fromSeq: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().max(200).optional(),
    /** Present iff this is a cross-host relay the caller is waiting on. */
    requestId: z.string().min(1).optional(),
  })
  .strict();
export type PatchHistoryRequestEvent = z.infer<typeof PatchHistoryRequestEvent>;

/**
 * The owning host's answer to a cross-host `patch_history`. `result`, present
 * iff `ok`, is the same `{ events, nextFromSeq }` shape `/internal/history/:id`
 * already returns locally — carried opaquely for the same reason as
 * `patch.peek.response.result`.
 */
export const PatchHistoryResponseEvent = z
  .object({
    type: z.literal('patch.history.response'),
    requestId: z.string().min(1).optional(),
    sourceChatId: z.string().min(1),
    targetChatId: z.string().min(1),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z
      .object({
        code: ChatErrorCode,
        message: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();
export type PatchHistoryResponseEvent = z.infer<typeof PatchHistoryResponseEvent>;

export const PatchListChatsRequestEvent = z
  .object({
    type: z.literal('patch.list_chats.request'),
    sourceChatId: z.string().min(1),
    archived: z.enum(['only', 'include']).optional(),
  })
  .strict();
export type PatchListChatsRequestEvent = z.infer<typeof PatchListChatsRequestEvent>;

export const PatchListChatsResponseEvent = z
  .object({
    type: z.literal('patch.list_chats.response'),
    sourceChatId: z.string().min(1),
    chatCount: z.number().int().nonnegative(),
    /**
     * Every listed chat names the machine it lives on. Without this the caller
     * gets a flat list of ids it cannot address: `patch_send_to` and
     * `patch_peek` need to know which host owns a chat before the server can
     * relay to it, and two chats on two hosts can share a folder string.
     */
    chats: z.array(
      z
        .object({
          chatId: z.string().min(1),
          ...daemonIdField,
        })
        .strict(),
    ),
  })
  .strict();
export type PatchListChatsResponseEvent = z.infer<typeof PatchListChatsResponseEvent>;

export const PatchActivityRequestEvent = z
  .object({
    type: z.literal('patch.activity.request'),
    sourceChatId: z.string().min(1),
    since: z.number().int().nonnegative(),
    until: z.number().int().nonnegative(),
    /** Resume cursor from a prior truncated response (spec/06). */
    messagesCursor: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict();
export type PatchActivityRequestEvent = z.infer<typeof PatchActivityRequestEvent>;

export const ActivityMessage = z
  .object({
    chatId: z.string().min(1),
    chatName: z.string().nullable(),
    ...daemonIdField,
    folder: z.string(),
    text: z.string(),
    ts: z.number().int().nonnegative(),
  })
  .strict();
export type ActivityMessage = z.infer<typeof ActivityMessage>;

/**
 * The server's answer to `patch_activity` (spec/06 § Cross-chat toolset) — the
 * user's OWN messages across every host, read through the chats' own logs.
 * Paged: a truncated response carries the resume cursor, used as
 * `messagesCursor` on the next request.
 */
export const PatchActivityResponseEvent = z
  .object({
    type: z.literal('patch.activity.response'),
    sourceChatId: z.string().min(1),
    messages: z.array(ActivityMessage),
    messagesTruncated: z.boolean(),
    nextMessagesCursor: z.number().int().nonnegative().optional(),
  })
  .strict();
export type PatchActivityResponseEvent = z.infer<typeof PatchActivityResponseEvent>;

/** Server → host: read the user messages in this machine's own chat logs for a window. */
export const PatchActivityReadRequestEvent = z
  .object({
    type: z.literal('patch.activity.read.request'),
    requestId: z.string().min(1),
    since: z.number().int().nonnegative(),
    until: z.number().int().nonnegative(),
    /** Most rows the machine may return — the oldest `limit` in the window. */
    limit: z.number().int().positive(),
  })
  .strict();
export type PatchActivityReadRequestEvent = z.infer<typeof PatchActivityReadRequestEvent>;

export const PatchActivityReadResponseEvent = z
  .object({
    type: z.literal('patch.activity.read.response'),
    requestId: z.string().min(1),
    messages: z.array(
      z
        .object({
          chatId: z.string().min(1),
          text: z.string(),
          ts: z.number().int().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict();
export type PatchActivityReadResponseEvent = z.infer<typeof PatchActivityReadResponseEvent>;

export const PatchStopEvent = z
  .object({
    type: z.literal('patch.stop'),
    sourceChatId: z.string().min(1),
    targetChatId: z.string().min(1),
  })
  .strict();
export type PatchStopEvent = z.infer<typeof PatchStopEvent>;

export const PatchJobCreateEvent = z
  .object({
    type: z.literal('patch.job_create'),
    sourceChatId: z.string().min(1),
    jobId: z.string().min(1),
    name: z.string().optional(),
  })
  .strict();
export type PatchJobCreateEvent = z.infer<typeof PatchJobCreateEvent>;

export const PatchJobUpdateEvent = z
  .object({
    type: z.literal('patch.job_update'),
    sourceChatId: z.string().min(1),
    jobId: z.string().min(1),
  })
  .strict();
export type PatchJobUpdateEvent = z.infer<typeof PatchJobUpdateEvent>;

export const PatchJobDeleteEvent = z
  .object({
    type: z.literal('patch.job_delete'),
    sourceChatId: z.string().min(1),
    jobId: z.string().min(1),
  })
  .strict();
export type PatchJobDeleteEvent = z.infer<typeof PatchJobDeleteEvent>;

export const PatchJobToggleEvent = z
  .object({
    type: z.literal('patch.job_toggle'),
    sourceChatId: z.string().min(1),
    jobId: z.string().min(1),
    enabled: z.boolean(),
  })
  .strict();
export type PatchJobToggleEvent = z.infer<typeof PatchJobToggleEvent>;

// ---------------------------------------------------------------------------
// Jobs RPC bridge (group 10 BLOCKER B.8 + B.9).
//
// The host's MCP child invokes `patch_job_*` tools that hit the host's
// UDS. The host then needs to relay the mutation upstream to the SERVER
// (which is the canonical owner of `/data/jobs/*.json`). The transport is
// the existing daemon-link WebSocket; the protocol is a request/response
// pair carried by these two events.
//
// `payload` and `result` are open-ended JSON; the receiving side validates
// against the canonical zod schema in `@patch/wire/jobs`.
//
// NO FALLBACK: if the link is offline when a request is issued, the host
// surfaces an MCP-level error rather than buffering to memory.

export const PatchJobsOp = z.enum([
  'list',
  'get',
  'create',
  'patch',
  'delete',
  'enable',
  'disable',
  'runs',
  'webhooks',
]);
export type PatchJobsOp = z.infer<typeof PatchJobsOp>;

export const PatchJobsRequestEvent = z
  .object({
    type: z.literal('patch.jobs.request'),
    requestId: z.string().min(1),
    op: PatchJobsOp,
    /** For get/patch/delete/enable/disable/runs/webhooks: the target jobId. */
    jobId: z.string().min(1).optional(),
    /** For create/patch: the body. */
    body: z.unknown().optional(),
    /** For runs/webhooks: optional limit (1..200). */
    limit: z.number().int().positive().max(200).optional(),
  })
  .strict();
export type PatchJobsRequestEvent = z.infer<typeof PatchJobsRequestEvent>;

export const PatchJobsResponseEvent = z
  .object({
    type: z.literal('patch.jobs.response'),
    requestId: z.string().min(1),
    /** When `ok`, `result` carries the operation's return value (Job, Job[], or null). */
    ok: z.boolean(),
    result: z.unknown().optional(),
    /** When !ok, `error.code` is one of `not_found` | `invalid_input` | `internal`. */
    error: z
      .object({
        code: z.enum(['not_found', 'invalid_input', 'internal', 'offline']),
        message: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type PatchJobsResponseEvent = z.infer<typeof PatchJobsResponseEvent>;

// ---------------------------------------------------------------------------
// Files RPC bridge (group 19): server → host → on-disk listing.
//
// `patch.files.request` is server-originated: it asks the host for a
// directory listing under a chat's pinned folder. The host resolves the
// chat → folder mapping itself (server doesn't share the host's filesystem)
// and returns `patch.files.response`. Path-traversal is enforced server-side
// in the response (any escape returns an `error.code === 'path_escape'`).

export const FilesEntry = z
  .object({
    name: z.string().min(1),
    type: z.enum(['file', 'dir']),
    size: z.number().int().nonnegative().optional(),
    /**
     * Group 20: `true` iff this file currently has an in-flight
     * `chat.permission_request` (i.e. the agent is proposing to edit it
     * but the user hasn't approved yet). Surfaces render a green ●
     * marker next to dirty rows.
     */
    dirty: z.boolean().optional(),
  })
  .strict();
export type FilesEntry = z.infer<typeof FilesEntry>;

export const PatchFilesRequestEvent = z
  .object({
    type: z.literal('patch.files.request'),
    requestId: z.string().min(1),
    chatId: z.string().min(1),
    /** Relative path under the chat's pinned folder. Empty string = root. */
    path: z.string(),
    /**
     * Group 20: when `content: true` and `path` resolves to a regular
     * file, the host returns the UTF-8 contents in `content`. When
     * `recursive: true`, the host walks the pinned folder up to
     * `maxEntries` and returns a flat list of files (used by the SPA
     * ⌘P file-search). The two flags are mutually exclusive.
     */
    content: z.boolean().optional(),
    recursive: z.boolean().optional(),
    maxEntries: z.number().int().positive().optional(),
    /**
     * G3: when `content: true` and `ref: 'head'`, the host returns the git
     * `HEAD:<path>` blob instead of the working-tree file — backs the file
     * browser's "view diff vs HEAD" link (spec/14 § File browser). An untracked
     * file (no HEAD blob) yields an empty string, not an error.
     */
    ref: z.enum(['head']).optional(),
    /**
     * Editor overhaul (binary preview): when `content: true` and
     * `encoding: 'base64'`, the host reads the file as raw bytes and
     * base64-encodes them into the SAME `content` field, instead of decoding
     * as UTF-8. Backs `GET /api/chats/:id/files/raw` (images/PDF preview) —
     * the plain JSON content route (no `encoding`) is untouched, so nothing
     * that depends on `content` always being UTF-8 text changes shape.
     */
    encoding: z.enum(['base64']).optional(),
  })
  .strict();
export type PatchFilesRequestEvent = z.infer<typeof PatchFilesRequestEvent>;

export const PatchFilesResponseEvent = z
  .object({
    type: z.literal('patch.files.response'),
    requestId: z.string().min(1),
    ok: z.boolean(),
    path: z.string().optional(),
    entries: z.array(FilesEntry).optional(),
    /** Group 20: file content when the request had `content: true`. */
    content: z.string().optional(),
    /** Group 20: file size in bytes (paired with `content`). */
    size: z.number().int().nonnegative().optional(),
    error: z
      .object({
        /**
         * G3:
         * - `chat_not_found` — no chat with that id (→ 404).
         * - `path_escape` — path escaped the chat folder (→ 400).
         * - `not_found` — the requested path does not exist (→ 404).
         * - `not_a_file` — `content` was requested for a directory (→ 400).
         * - `no_head_baseline` — `ref: 'head'` requested but the chat folder is
         *   not a git work-tree / has no HEAD commit, so there is no baseline to
         *   diff against (→ 409). NOT a silent empty fallback — see G3-d1.
         * - `internal` — unexpected host-side failure (→ 502).
         */
        code: z.enum([
          'chat_not_found',
          'path_escape',
          'not_found',
          'not_a_file',
          'no_head_baseline',
          'internal',
        ]),
        message: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type PatchFilesResponseEvent = z.infer<typeof PatchFilesResponseEvent>;

// ---------------------------------------------------------------------------
// File operations RPC (server → host → on-disk mutation).
//
// The file browser's create / rename / delete. Server-originated like
// `patch.files.request`, and for the same reason: only the host has the
// filesystem. It is a REQUEST/RESPONSE pair rather than a fire-and-forget
// surface event because these operations destroy or move real files — the user
// has to be told the outcome, and "the frame went somewhere" is not an outcome.
// A host too old to know this event type drops it, the server's wait times
// out, and the surface reports a failure; an operation can never look like it
// succeeded because nobody answered.

export const PatchFileOpRequestEvent = z
  .object({
    type: z.literal('patch.file_op.request'),
    requestId: z.string().min(1),
    chatId: z.string().min(1),
    /**
     * `create` writes an empty file, `create_dir` makes one directory,
     * `delete` removes one file or one EMPTY directory, `rename` moves a file
     * or directory to `to` (also within the chat folder).
     */
    op: z.enum(['create', 'create_dir', 'delete', 'rename']),
    /** Relative to the chat's pinned folder. The root itself is never a target. */
    path: z.string().min(1),
    /** Destination for `rename`, relative to the same folder. */
    to: z.string().min(1).optional(),
  })
  .strict();
export type PatchFileOpRequestEvent = z.infer<typeof PatchFileOpRequestEvent>;

export const PatchFileOpResponseEvent = z
  .object({
    type: z.literal('patch.file_op.response'),
    requestId: z.string().min(1),
    ok: z.boolean(),
    /** The path the operation landed on — `to` for a rename, `path` otherwise. */
    path: z.string().optional(),
    error: z
      .object({
        /**
         * - `chat_not_found` — no chat with that id (→ 404).
         * - `path_escape` — the path, or a rename's destination, resolved
         *   outside the chat folder, or named the folder itself (→ 400).
         * - `not_found` — the source does not exist, or the destination's
         *   parent directory does not exist (→ 404). A destination parent is
         *   never created implicitly: a mistyped directory would otherwise be
         *   silently made, and the file would vanish into it.
         * - `exists` — the destination is already there (→ 409). Neither
         *   `create` nor `rename` ever overwrites; that is data loss.
         * - `not_empty` — `delete` named a directory with contents (→ 409).
         *   Deletes never recurse.
         * - `missing_target` — `rename` arrived with no `to` (→ 400).
         * - `internal` — the operation failed on disk (→ 502).
         */
        code: z.enum([
          'chat_not_found',
          'path_escape',
          'not_found',
          'exists',
          'not_empty',
          'missing_target',
          'internal',
        ]),
        message: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type PatchFileOpResponseEvent = z.infer<typeof PatchFileOpResponseEvent>;

// ---------------------------------------------------------------------------
// Document editor — modes, suggestions, comments, history (spec/14 § Document
// editor, step 2 of 3). One view (mode + suggestions + threads + versions,
// `.<name>.patch-doc.json` beside the file) and one action RPC covering every
// mutation a surface can make to it. The agent's own mutations (a tracked
// suggestion, a comment, a reply) go through the host's `/internal/doc/*`
// routes instead (mcp.ts) — not this pair, which is server → host only.

export const DocMode = z.enum(['change', 'propose', 'comment']);
export type DocMode = z.infer<typeof DocMode>;

export const DocSuggestion = z
  .object({
    id: z.string().min(1),
    /** Exact, currently-unique substring of the document this replaces — the same contract Edit's `old_string` has. */
    find: z.string().min(1),
    /** What `find` becomes if accepted. Empty = a pure deletion. */
    replace: z.string(),
    status: z.enum(['pending', 'accepted', 'rejected']),
    createdAt: z.number(),
  })
  .strict();
export type DocSuggestion = z.infer<typeof DocSuggestion>;

export const DocCommentEntry = z
  .object({
    id: z.string().min(1),
    author: z.enum(['user', 'agent']),
    text: z.string().min(1),
    createdAt: z.number(),
  })
  .strict();
export type DocCommentEntry = z.infer<typeof DocCommentEntry>;

export const DocThread = z
  .object({
    id: z.string().min(1),
    /** The passage this thread is anchored to — the text selected when it was opened. */
    anchor: z.string(),
    resolved: z.boolean(),
    comments: z.array(DocCommentEntry),
  })
  .strict();
export type DocThread = z.infer<typeof DocThread>;

export const DocVersion = z
  .object({
    id: z.string().min(1),
    content: z.string(),
    savedBy: z.enum(['user', 'agent']),
    createdAt: z.number(),
    /** Set when this version's content was produced by restoring an earlier one. */
    restoredFrom: z.string().optional(),
  })
  .strict();
export type DocVersion = z.infer<typeof DocVersion>;

export const DocSourceDocx = z
  .object({
    /** The `.docx`'s own path, relative to the chat folder. */
    path: z.string().min(1),
    mtimeMs: z.number(),
  })
  .strict();
export type DocSourceDocx = z.infer<typeof DocSourceDocx>;

export const DocView = z
  .object({
    mode: DocMode,
    suggestions: z.array(DocSuggestion),
    threads: z.array(DocThread),
    /** Oldest first. */
    versions: z.array(DocVersion),
    /** Set when this `.md` was produced by converting a `.docx` (spec/14 § Document editor, step 3 of 3). */
    sourceDocx: DocSourceDocx.optional(),
    /** Anything that `.docx` import couldn't carry over, named rather than silently dropped. */
    importWarnings: z.array(z.string()).optional(),
  })
  .strict();
export type DocView = z.infer<typeof DocView>;

const DocErrorCode = z.enum([
  'chat_not_found',
  'path_escape',
  'not_found',
  'conflict',
  'internal',
  // Word import/export (spec/14 § Document editor, step 3 of 3):
  'invalid', // wrong extension for the operation (e.g. convert on a non-.docx)
  'browser_missing', // PDF export needs Playwright's Chromium; this host doesn't have it
]);

export const PatchDocRequestEvent = z
  .object({
    type: z.literal('patch.doc.request'),
    requestId: z.string().min(1),
    chatId: z.string().min(1),
    /** Relative to the chat's pinned folder, a `.md` file. */
    path: z.string().min(1),
  })
  .strict();
export type PatchDocRequestEvent = z.infer<typeof PatchDocRequestEvent>;

export const PatchDocResponseEvent = z
  .object({
    type: z.literal('patch.doc.response'),
    requestId: z.string().min(1),
    ok: z.boolean(),
    view: DocView.optional(),
    error: z.object({ code: DocErrorCode, message: z.string() }).strict().optional(),
  })
  .strict();
export type PatchDocResponseEvent = z.infer<typeof PatchDocResponseEvent>;

export const DocAction = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set_mode'), mode: DocMode }).strict(),
  z.object({ op: z.literal('accept_suggestion'), id: z.string().min(1) }).strict(),
  z.object({ op: z.literal('reject_suggestion'), id: z.string().min(1) }).strict(),
  z.object({ op: z.literal('accept_all') }).strict(),
  z.object({ op: z.literal('reject_all') }).strict(),
  z.object({ op: z.literal('add_comment'), anchor: z.string(), text: z.string().min(1) }).strict(),
  z
    .object({
      op: z.literal('reply_comment'),
      threadId: z.string().min(1),
      text: z.string().min(1),
    })
    .strict(),
  z
    .object({
      op: z.literal('resolve_comment'),
      threadId: z.string().min(1),
      resolved: z.boolean(),
    })
    .strict(),
  z.object({ op: z.literal('restore_version'), versionId: z.string().min(1) }).strict(),
]);
export type DocAction = z.infer<typeof DocAction>;

export const PatchDocActionRequestEvent = z
  .object({
    type: z.literal('patch.doc_action.request'),
    requestId: z.string().min(1),
    chatId: z.string().min(1),
    path: z.string().min(1),
    action: DocAction,
  })
  .strict();
export type PatchDocActionRequestEvent = z.infer<typeof PatchDocActionRequestEvent>;

export const PatchDocActionResponseEvent = z
  .object({
    type: z.literal('patch.doc_action.response'),
    requestId: z.string().min(1),
    ok: z.boolean(),
    view: DocView.optional(),
    error: z.object({ code: DocErrorCode, message: z.string() }).strict().optional(),
  })
  .strict();
export type PatchDocActionResponseEvent = z.infer<typeof PatchDocActionResponseEvent>;

// ---------------------------------------------------------------------------
// Word import/export (spec/14 § Document editor, step 3 of 3).
// ---------------------------------------------------------------------------

export const PatchDocConvertRequestEvent = z
  .object({
    type: z.literal('patch.doc_convert.request'),
    requestId: z.string().min(1),
    chatId: z.string().min(1),
    /** Relative to the chat's pinned folder — a `.docx` file. */
    path: z.string().min(1),
  })
  .strict();
export type PatchDocConvertRequestEvent = z.infer<typeof PatchDocConvertRequestEvent>;

export const PatchDocConvertResponseEvent = z
  .object({
    type: z.literal('patch.doc_convert.response'),
    requestId: z.string().min(1),
    ok: z.boolean(),
    /** The converted file, relative to the chat's folder — same basename, `.md`. */
    mdPath: z.string().optional(),
    /** Anything the conversion couldn't carry over — complex layout, tracked changes, embedded objects — named rather than silently dropped. */
    warnings: z.array(z.string()).optional(),
    /** True when the `.docx` hadn't changed since it was last converted, so the existing `.md` (and anyone's edits to it) was left alone. */
    reused: z.boolean().optional(),
    error: z.object({ code: DocErrorCode, message: z.string() }).strict().optional(),
  })
  .strict();
export type PatchDocConvertResponseEvent = z.infer<typeof PatchDocConvertResponseEvent>;

export const DocExportFormat = z.enum(['docx', 'pdf', 'md']);
export type DocExportFormat = z.infer<typeof DocExportFormat>;

export const PatchDocExportRequestEvent = z
  .object({
    type: z.literal('patch.doc_export.request'),
    requestId: z.string().min(1),
    chatId: z.string().min(1),
    /** Relative to the chat's pinned folder — a `.md` file. */
    path: z.string().min(1),
    format: DocExportFormat,
  })
  .strict();
export type PatchDocExportRequestEvent = z.infer<typeof PatchDocExportRequestEvent>;

export const PatchDocExportResponseEvent = z
  .object({
    type: z.literal('patch.doc_export.response'),
    requestId: z.string().min(1),
    ok: z.boolean(),
    /** Where the exported file landed, relative to the chat's folder (same basename, new extension) — written beside the `.md` so it's also reachable from the file browser/agent, not just this response. */
    path: z.string().optional(),
    mimeType: z.string().optional(),
    /** The exported file's bytes, base64 — wire events are JSON, so this is how a binary export rides one. */
    dataBase64: z.string().optional(),
    /** e.g. an image the export couldn't embed. Empty for a clean export. */
    warnings: z.array(z.string()).optional(),
    error: z.object({ code: DocErrorCode, message: z.string() }).strict().optional(),
  })
  .strict();
export type PatchDocExportResponseEvent = z.infer<typeof PatchDocExportResponseEvent>;

// ---------------------------------------------------------------------------
// Background task resource RPC (server → host → the host's process table).
//
// `patch.background_task_stats.request` is server-originated and backs the
// surface's background task bar: it names the background ids the surface can
// see still running and asks the host what each is costing the machine
// (spec/02 § Background task completions). Routed to the chat's own host by
// `chatId`, because the processes only exist there.
//
// NO FALLBACK, and it is the whole shape of this pair: the response carries a
// stat ONLY for a task the host actually measured. An id that came back with
// no entry was not measured — a backgrounded sub-agent has no process of its
// own, and a command whose processes have exited has none left — and the
// surface must render nothing for it rather than a zero, which is a reading.

export const BackgroundTaskStat = z
  .object({
    /** The background id the launch reported, as the request named it. */
    taskId: z.string().min(1),
    /**
     * Summed over the task's process tree: each process's share of ONE core
     * averaged across its own lifetime, so a four-core build legitimately
     * exceeds 100.
     */
    cpuPercent: z.number().nonnegative(),
    /** Summed resident set size, in bytes. Current, not averaged. */
    rssBytes: z.number().int().nonnegative(),
    /** How many processes the figures were summed over. Always at least one. */
    processes: z.number().int().positive(),
  })
  .strict();
export type BackgroundTaskStat = z.infer<typeof BackgroundTaskStat>;

export const PatchBackgroundTaskStatsRequestEvent = z
  .object({
    type: z.literal('patch.background_task_stats.request'),
    requestId: z.string().min(1),
    chatId: z.string().min(1),
    /** The background ids to measure. Capped: this runs on a poll. */
    taskIds: z.array(z.string().min(1)).min(1).max(50),
  })
  .strict();
export type PatchBackgroundTaskStatsRequestEvent = z.infer<
  typeof PatchBackgroundTaskStatsRequestEvent
>;

export const PatchBackgroundTaskStatsResponseEvent = z
  .object({
    type: z.literal('patch.background_task_stats.response'),
    requestId: z.string().min(1),
    ok: z.boolean(),
    /**
     * One entry per MEASURED task, in no particular order, and never one per
     * requested id. A requested id missing from this array is the host
     * saying it could not measure that task.
     */
    stats: z.array(BackgroundTaskStat).optional(),
    error: z
      .object({
        /**
         * - `chat_not_found` — no chat with that id on this host (→ 404).
         * - `no_process_table` — the host has no usable `lsof`/`ps`, so NO task
         *   can be measured here. Distinct from an empty `stats`, which means
         *   the tools ran and found nothing (→ 501).
         * - `internal` — unexpected host-side failure (→ 502).
         */
        code: z.enum(['chat_not_found', 'no_process_table', 'internal']),
        message: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type PatchBackgroundTaskStatsResponseEvent = z.infer<
  typeof PatchBackgroundTaskStatsResponseEvent
>;

// ---------------------------------------------------------------------------
// patch_watch RPC (server → host → server), backing the web/mobile
// Background task bar (spec/14 § Main chat panel — Background task bar).
//
// Distinct from `patch_watch`/`patch_watch_list`/etc's own agent-facing MCP
// tools (daemon/src/mcp.ts) — those run INSIDE a chat's own turn, addressed by
// `PATCH_CHAT_ID`. This pair is surface-facing: a REST client with no turn of
// its own asks "what does THIS chat have running" and "kill this one", the
// same server→host→server round-trip `patch.background_task_stats.*` uses.
//
// `WatchTaskRow` mirrors `packages/daemon/src/watch.ts`'s persisted
// `WatchRecord`, minus the daemon-internal `chatId`/`pid` a surface has no use
// for — `chatId` is already the request's own scope, and a kill goes through
// `patch.watch_stop.request` below, never a raw pid. `outputFile` DOES cross:
// it is the one thing that lets the bar's click-through open the interactive
// terminal on a `tail -f` of the right file — the old Bash/Task mechanism's
// bar had to glob `/tmp/claude-*/*/*/tasks/*.output` for it (session/project
// unknown to the surface); a watch's record already names its own file
// exactly, so there is nothing to guess.

export const WatchTaskRow = z
  .object({
    taskId: z.string().min(1),
    description: z.string().min(1),
    /** The literal command string that was run — the bar's command preview. */
    command: z.string().min(1),
    /** Absolute path on the chat's own host — the terminal's tail target. */
    outputFile: z.string().min(1),
    status: z.enum(['running', 'exited', 'stopped', 'failed']),
    /** Epoch ms — the bar computes elapsed time from this, ticking locally. */
    startedAt: z.number().int(),
    endedAt: z.number().int().optional(),
    exitCode: z.number().int().nullable().optional(),
    signal: z.string().nullable().optional(),
  })
  .strict();
export type WatchTaskRow = z.infer<typeof WatchTaskRow>;

export const PatchWatchListRequestEvent = z
  .object({
    type: z.literal('patch.watch_list.request'),
    requestId: z.string().min(1),
    chatId: z.string().min(1),
  })
  .strict();
export type PatchWatchListRequestEvent = z.infer<typeof PatchWatchListRequestEvent>;

export const PatchWatchListResponseEvent = z
  .object({
    type: z.literal('patch.watch_list.response'),
    requestId: z.string().min(1),
    ok: z.boolean(),
    tasks: z.array(WatchTaskRow).optional(),
    error: z
      .object({
        /** `chat_not_found` — no chat with that id on this host (→ 404). */
        code: z.enum(['chat_not_found', 'internal']),
        message: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type PatchWatchListResponseEvent = z.infer<typeof PatchWatchListResponseEvent>;

export const PatchWatchStopRequestEvent = z
  .object({
    type: z.literal('patch.watch_stop.request'),
    requestId: z.string().min(1),
    chatId: z.string().min(1),
    taskId: z.string().min(1),
  })
  .strict();
export type PatchWatchStopRequestEvent = z.infer<typeof PatchWatchStopRequestEvent>;

export const PatchWatchStopResponseEvent = z
  .object({
    type: z.literal('patch.watch_stop.response'),
    requestId: z.string().min(1),
    ok: z.boolean(),
    /** False for an already-ended task — idempotent, mirrors `patch_watch_stop`. */
    stopped: z.boolean().optional(),
    error: z
      .object({
        code: z.enum(['chat_not_found', 'internal']),
        message: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type PatchWatchStopResponseEvent = z.infer<typeof PatchWatchStopResponseEvent>;

// ---------------------------------------------------------------------------
// Chat history REST RPC (server → host → server).
//
// `patch.chat_history.request` is server-originated: it backs the REST
// endpoint `GET /api/chats/:id/history?since=<seq>`. The server doesn't share
// the host's filesystem (the host owns Claude Code's persisted JSONL), so
// it round-trips this RPC over the daemon-link and collects the events into
// the HTTP response body. Distinct from the agent-facing `patch.history.*`
// pair (cross-chat peek, delivered via per-surface replay) — this one returns
// the events array inline so a stateless HTTP caller can render history.
//
// `events` is exactly what the host's HistoryReader reconstructs from the
// JSONL today: user/assistant `chat.message` turns. Tool calls/results are
// surfaced via the live stream, not the replay path (see daemon/history.ts).

/**
 * Server -> host: whether the server is running this host's message queues
 * (spec/04 § Message queueing). Sent when the host attaches. While `enabled`,
 * the server holds messages that arrive behind a running turn and hands them
 * over when the host asks at a tool boundary or goes idle.
 */
export const ServerQueueModeEvent = z
  .object({
    type: z.literal('server.queue_mode'),
    enabled: z.boolean(),
  })
  .strict();
export type ServerQueueModeEvent = z.infer<typeof ServerQueueModeEvent>;

/**
 * Server -> host: send what the server is missing (spec/01 § Message log). The
 * host answers with `patch.log_sync.batch` frames carrying its own logged events
 * of the chat after `afterSeq`, in order. Sent when a host's log of a chat reaches
 * further than the server's, for instance after a link that dropped for longer
 * than the host's resend buffer holds.
 */
export const PatchLogSyncRequestEvent = z
  .object({
    type: z.literal('patch.log_sync.request'),
    chatId: z.string().min(1),
    afterSeq: z.number().int().gte(-1),
  })
  .strict();
export type PatchLogSyncRequestEvent = z.infer<typeof PatchLogSyncRequestEvent>;

/** Host -> server: events the server asked for, in seq order. `done` closes the answer. */
export const PatchLogSyncBatchEvent = z
  .object({
    type: z.literal('patch.log_sync.batch'),
    chatId: z.string().min(1),
    /** Shallow like `chat.replay_batch`: each was validated when the host logged it. */
    events: z.array(z.object({ type: z.string().min(1) }).passthrough()),
    done: z.boolean(),
  })
  .strict();
export type PatchLogSyncBatchEvent = z.infer<typeof PatchLogSyncBatchEvent>;

/**
 * Server -> host: events this host's log of the chat lacks, in seq order, so the
 * host's local copy can be rebuilt from the server's (a host whose log was lost,
 * or that another host ran the chat past). The host writes each into its own log
 * and carries its numbering on above them.
 */
export const PatchLogRestoreEvent = z
  .object({
    type: z.literal('patch.log_restore'),
    chatId: z.string().min(1),
    events: z.array(z.object({ type: z.string().min(1) }).passthrough()),
    done: z.boolean(),
  })
  .strict();
export type PatchLogRestoreEvent = z.infer<typeof PatchLogRestoreEvent>;

/**
 * Server -> host: the server holds this chat's transcript up to `through`
 * (spec/01 § Message log). Sent a moment after events are committed, batched per
 * chat. The host never lets its own numbering fall at or below `through`, so a
 * chat that another host ran, or that was restored, carries on from the server's
 * numbering rather than colliding with it.
 */
export const ChatCommittedEvent = z
  .object({
    type: z.literal('chat.committed'),
    chatId: z.string().min(1),
    through: z.number().int().nonnegative(),
  })
  .strict();
export type ChatCommittedEvent = z.infer<typeof ChatCommittedEvent>;

/**
 * Server -> host: this host runs the Manager now, because the home host has
 * been offline for a while (spec/06 § Manager failover). `handoff` is the
 * recent conversation as the server holds it, given to the Manager with its
 * next message; `nextSeq` is where the Manager's own numbering carries on, so
 * the thread keeps one sequence across hosts. `epoch` counts takeovers, so a
 * host that is told the same one twice acts on it once.
 */
export const HostManagerAdoptEvent = z
  .object({
    type: z.literal('host.manager_adopt'),
    daemonId: z.string().min(1),
    epoch: z.number().int().nonnegative(),
    handoff: z.string(),
    nextSeq: z.number().int().nonnegative(),
  })
  .strict();
export type HostManagerAdoptEvent = z.infer<typeof HostManagerAdoptEvent>;

/** Server -> host: the Manager is back on its home host; stop running it here. */
export const HostManagerReleaseEvent = z
  .object({
    type: z.literal('host.manager_release'),
    daemonId: z.string().min(1),
    epoch: z.number().int().nonnegative(),
  })
  .strict();
export type HostManagerReleaseEvent = z.infer<typeof HostManagerReleaseEvent>;

/** Host -> server: "what is waiting for this chat?", asked at a tool boundary. */
export const PatchQueuePullRequestEvent = z
  .object({
    type: z.literal('patch.queue_pull.request'),
    requestId: z.string().min(1),
    chatId: z.string().min(1),
  })
  .strict();
export type PatchQueuePullRequestEvent = z.infer<typeof PatchQueuePullRequestEvent>;

/**
 * Server -> host: the messages that were waiting, in order, exactly as the
 * surfaces sent them. The server has already taken them off its queue.
 */
export const PatchQueuePullResponseEvent = z
  .object({
    type: z.literal('patch.queue_pull.response'),
    requestId: z.string().min(1),
    items: z.array(ChatInputEvent),
  })
  .strict();
export type PatchQueuePullResponseEvent = z.infer<typeof PatchQueuePullResponseEvent>;

export const PatchChatHistoryRequestEvent = z
  .object({
    type: z.literal('patch.chat_history.request'),
    requestId: z.string().min(1),
    chatId: z.string().min(1),
    /** Return events with seq >= since. Defaults to 0 (full history). */
    since: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().max(200).optional(),
    /**
     * Read THIS branch's own track (spec/04 § Branching; spec/14 § Side
     * threads panel, which pulls a side thread's content through this REST
     * path rather than the live WS stream — see `04-chats-and-folders.md` §
     * Parallel branches, "pull-based, not push-based"). Default: the active
     * branch — today's behaviour, unchanged.
     */
    branchId: z.string().min(1).optional(),
    /**
     * Set only by the parent's-tool-row "open read-only transcript" route
     * (spec/14 § Main chat panel — Delegate tool row): `chatId` is never in
     * `chatRegistry`, so the ordinary ownership gate (`GET
     * /api/chats/:id/history`'s `chatRegistry.get` check) can't run — this
     * field is that gate's replacement. The host refuses with
     * `not_a_delegate` unless `chatId`'s `meta.subagent.parentChatId` equals
     * this value, so reading a subagent's transcript still needs its real
     * parent id, not just the subagent's.
     */
    requireParent: z.string().min(1).optional(),
  })
  .strict();
export type PatchChatHistoryRequestEvent = z.infer<typeof PatchChatHistoryRequestEvent>;

export const PatchChatHistoryResponseEvent = z
  .object({
    type: z.literal('patch.chat_history.response'),
    requestId: z.string().min(1),
    ok: z.boolean(),
    events: z.array(ChatMessageEvent).optional(),
    /** Set when more events exist beyond the returned slice. */
    nextFromSeq: z.number().int().nonnegative().optional(),
    error: z
      .object({
        code: z.enum(['chat_not_found', 'internal', 'not_a_delegate']),
        message: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type PatchChatHistoryResponseEvent = z.infer<typeof PatchChatHistoryResponseEvent>;

// `patch.skills.request` is server-originated: it backs
// `GET /api/skills?folder=&daemonId=` (the job-editor's Skill picker, the
// chat transcript's Skill tool-call link, and the composer's `/`
// autocomplete). The host owns the project filesystem, so the server
// round-trips this RPC and the host lists the skills available in
// `<folder>/.claude/skills` (each subdir that contains a `SKILL.md`).

export const PatchSkillsRequestEvent = z
  .object({
    type: z.literal('patch.skills.request'),
    requestId: z.string().min(1),
    /** Absolute host-side folder whose `.claude/skills` is listed. */
    folder: z.string().min(1),
    /**
     * The host whose filesystem is being asked. Skills are PER HOST — a
     * folder's `.claude/skills` only exists on the machine that has it
     * checked out, and a machine-level skill (e.g. one that lives in
     * `~/.claude/skills` only where a particular tool is installed) only
     * exists on that one machine. Required so the request is routed to the
     * caller's actual folder/host rather than falling back to "whichever
     * host last attached" (NO FALLBACK — see `daemonIdField` above).
     */
    ...daemonIdField,
  })
  .strict();
export type PatchSkillsRequestEvent = z.infer<typeof PatchSkillsRequestEvent>;

export const PatchSkillsResponseEvent = z
  .object({
    type: z.literal('patch.skills.response'),
    requestId: z.string().min(1),
    ok: z.boolean(),
    /** Skill names (the `.claude/skills/<name>` dirs), sorted. */
    skills: z.array(z.string()).optional(),
    /**
     * The absolute host-side file defining each skill, keyed by skill name —
     * the `SKILL.md` of a directory-shaped skill, or the flat `<name>.md`. This
     * is what lets a surface link straight to a skill's source (spec/14 § Jobs
     * view) rather than guess which of the two layouts, in which of the two
     * directories, a given name came from. Optional because a host running an
     * older host answers without it: a surface with no path offers no link,
     * it does not invent one.
     */
    paths: z.record(z.string()).optional(),
    /**
     * Each skill's frontmatter `description:`, keyed by skill name — parsed the
     * same lenient way `ClaudeMemoryEntry` reads a memory file's frontmatter
     * (`listClaudeMemories`). Optional for the same reason `paths` is: an older
     * host answers without it, and a surface with no description shows a link
     * with no tooltip rather than inventing one. A skill whose frontmatter has
     * no `description:` (or none at all) is simply absent from this map, not
     * present with an empty string — same "can't say" as a whole older host.
     */
    descriptions: z.record(z.string()).optional(),
    /**
     * Each skill's WHOLE parsed frontmatter block, keyed by skill name then by
     * frontmatter key (`description`, `user-invocable`, `argument-hint`, any
     * other key the file declares) — every value a raw string, exactly as
     * written after the `key:`. Supersedes `descriptions` (kept above for an
     * older surface talking to a new host) as the composer's source for a
     * skill's preview panel (spec/14 § Skill autocomplete), which shows the
     * rest of the frontmatter beyond the description. A skill with no
     * frontmatter block at all is absent from this map, not present with `{}`
     * — same "can't say" as a whole older host answering without it.
     */
    frontmatter: z.record(z.record(z.string())).optional(),
    error: z
      .object({
        code: z.enum(['folder_not_found', 'internal']),
        message: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type PatchSkillsResponseEvent = z.infer<typeof PatchSkillsResponseEvent>;

// `patch.models.request` is server-originated: it backs `GET /api/models` (the
// new-chat model picker). The host holds the Claude Code OAuth credential, so
// only the host can read Anthropic's model list — it does, on a TTL, and
// answers with the catalogue (spec/02 § Model catalogue). NO FALLBACK: a
// credential/API failure comes back as `ok:false`, never a stale invented list.

export const PatchModelsRequestEvent = z
  .object({
    type: z.literal('patch.models.request'),
    requestId: z.string().min(1),
    /**
     * The host whose catalogue is being asked for. The catalogue is PER HOST —
     * a chat's host is chosen before its model, and the models offered are that
     * host's, across that host's backends (spec/02 § Model catalogue).
     */
    ...daemonIdField,
    /** Stamped by the hub — the surface the response routes back to. */
    ...forSurfaceIdField,
  })
  .strict();
export type PatchModelsRequestEvent = z.infer<typeof PatchModelsRequestEvent>;

/** One backend's failure to answer, alongside the backends that did. */
export const ModelCatalogueError = z
  .object({
    backend: z.string().min(1),
    code: z.enum(['oauth_unavailable', 'upstream', 'internal']),
    message: z.string(),
  })
  .strict();
export type ModelCatalogueError = z.infer<typeof ModelCatalogueError>;

/**
 * One host's model catalogue across its backends (spec/02 § Model catalogue).
 *
 * `models` and `errors` are BOTH populated in the normal partial-failure case:
 * a host with two backends where one credential expired still offers the
 * other's models, and the picker shows the error against the failing backend
 * while the models that resolved stay selectable. That is why there is no
 * single `ok` flag any more — it could only have described the whole host, and
 * the whole host is no longer the unit that succeeds or fails.
 */
export const PatchModelsResponseEvent = z
  .object({
    type: z.literal('patch.models.response'),
    requestId: z.string().min(1),
    ...daemonIdField,
    /**
     * Selectable models, newest-first. `id` is the SDK `--model` value;
     * `backend` names which of the host's backends serves it, and is what a
     * chosen model uses to select the backend the chat runs on.
     */
    models: z.array(
      z
        .object({
          id: z.string().min(1),
          label: z.string().min(1),
          backend: z.string().min(1),
        })
        .strict(),
    ),
    /** Empty when every backend answered. */
    errors: z.array(ModelCatalogueError),
    /** When the catalogue was last read from the providers (ISO 8601). */
    fetchedAt: z.string().optional(),
    ...forSurfaceIdField,
  })
  .strict();
export type PatchModelsResponseEvent = z.infer<typeof PatchModelsResponseEvent>;

// `patch.recurrence.translate.request` is server-originated: it backs
// `POST /api/jobs/recurrence/translate` (spec/08 § Recurrence — the job
// editor's natural-language schedule input). The host holds the Claude
// Code OAuth credential, so only it can run the one-shot translation call —
// same reason `patch.models.request` exists. NO FALLBACK: a translation the
// host can't confidently produce, or one the server can't validate/describe
// once it comes back, is `ok:false` with a reason, never a guessed RRULE.

export const PatchRecurrenceTranslateRequestEvent = z
  .object({
    type: z.literal('patch.recurrence.translate.request'),
    requestId: z.string().min(1),
    /** Free text the user typed, e.g. "every 3rd Sunday between May and August". */
    phrase: z.string().min(1),
    /**
     * Which host runs the one-shot query — the host that holds the OAuth
     * credential and the account-failover credit gate, exactly as
     * `patch.models.request` names a host for its catalogue read.
     */
    ...daemonIdField,
    /** Stamped by the hub — the surface the response routes back to. */
    ...forSurfaceIdField,
  })
  .strict();
export type PatchRecurrenceTranslateRequestEvent = z.infer<
  typeof PatchRecurrenceTranslateRequestEvent
>;

export const PatchRecurrenceTranslateResponseEvent = z
  .object({
    type: z.literal('patch.recurrence.translate.response'),
    requestId: z.string().min(1),
    ...daemonIdField,
    /**
     * The bare RRULE value string the model produced, present only when
     * `ok:true`. The SERVER still validates this (`RRule.fromString`) and
     * confirms it renders through `describeRecurrence` before ever handing
     * it back to the client — this field carries the model's raw claim, not
     * a value already known to be trustworthy.
     */
    rrule: z.string().min(1).optional(),
    ok: z.boolean(),
    /** Present when `ok:false` — why the host couldn't produce a rule. */
    error: z.string().optional(),
    ...forSurfaceIdField,
  })
  .strict();
export type PatchRecurrenceTranslateResponseEvent = z.infer<
  typeof PatchRecurrenceTranslateResponseEvent
>;

// ---------------------------------------------------------------------------
// Terminal sessions (spec/02 § Terminal sessions, spec/03 § Terminal sessions,
// spec/14 § Terminal).
//
// A shell on the HOST, driven from a surface. The host owns the
// project filesystem, so it owns the shell — this is the only route a surface
// has to `git clone` a repo onto the host, run an install, or look at what is
// actually on disk. The surface mints the `sessionId`; the hub stamps
// `forSurfaceId` on each surface→host frame so the host streams output back
// to that one surface (never fanned out).
//
// NO PTY: pipes only (no native module in the host image). Raw stdin in, raw
// stdout/stderr chunks out — the host interprets nothing except the one
// completion sentinel it injects itself, which it strips from stdout and
// reports as `patch.terminal.command-exit`. With no prompt and no echo, that
// frame is the ONLY thing that says a command finished.

export const PatchTerminalOpenEvent = z
  .object({
    type: z.literal('patch.terminal.open'),
    /** Surface-minted session id; every later frame correlates on it. */
    sessionId: z.string().min(1),
    /** The host the shell starts on — a terminal is a shell on ONE machine. */
    ...daemonIdField,
    /**
     * Absolute host-side directory the shell starts in. Validated exactly
     * like a chat spawn — a NAMED folder that does not exist on the host is a
     * loud `folder_not_found`, never a shell started somewhere else instead.
     *
     * OMITTED is a different, explicit request: "a shell anywhere I can work".
     * The host starts it in its own home and reports the real directory in
     * `patch.terminal.ready.cwd`. This is what the NEW-CHAT terminal uses —
     * there is no folder yet (that is the whole reason you want a shell: to
     * clone one onto the host), so demanding one would make the terminal
     * useless exactly when it is needed.
     */
    folder: z.string().min(1).optional(),
    /**
     * Ask for a REAL pseudo-terminal of this size instead of the pipe shell
     * (spec/02 § Terminal sessions — PTY sessions). A PTY session echoes, prints
     * a prompt, and runs full-screen programs; its bytes are raw terminal
     * output for an emulator to draw, so it carries no completion sentinel and
     * reports no `command-exit`. Omitted = the pipe shell, unchanged.
     *
     * A host that predates this field strips it and would open a pipe shell,
     * so the host confirms the kind it opened on `ready.pty`. A surface that
     * asked for a PTY and got a ready without `pty: true` must refuse the
     * session, not draw a pipe shell into an emulator (NO FALLBACK).
     */
    pty: z
      .object({
        cols: z.number().int().min(1).max(1000),
        rows: z.number().int().min(1).max(1000),
      })
      .strict()
      .optional(),
    /** Stamped by the hub — the surface the output stream routes back to. */
    forSurfaceId: z.string().min(1).optional(),
  })
  .strict();
export type PatchTerminalOpenEvent = z.infer<typeof PatchTerminalOpenEvent>;

/**
 * The emulator drawing a PTY session changed size (a rotation, the keyboard
 * opening). The host sets the pseudo-terminal's window size, which is what
 * sends the foreground program its SIGWINCH. Routed by session like `input`.
 * Meaningless for a pipe session, which has no window: the host refuses it
 * with `not_a_pty` rather than pretending to have resized something.
 */
export const PatchTerminalResizeEvent = z
  .object({
    type: z.literal('patch.terminal.resize'),
    sessionId: z.string().min(1),
    cols: z.number().int().min(1).max(1000),
    rows: z.number().int().min(1).max(1000),
    forSurfaceId: z.string().min(1).optional(),
  })
  .strict();
export type PatchTerminalResizeEvent = z.infer<typeof PatchTerminalResizeEvent>;

export const PatchTerminalInputEvent = z
  .object({
    type: z.literal('patch.terminal.input'),
    sessionId: z.string().min(1),
    /** Raw bytes for the shell's stdin, written verbatim (newline included). */
    data: z.string(),
    forSurfaceId: z.string().min(1).optional(),
  })
  .strict();
export type PatchTerminalInputEvent = z.infer<typeof PatchTerminalInputEvent>;

export const PatchTerminalSignalEvent = z
  .object({
    type: z.literal('patch.terminal.signal'),
    sessionId: z.string().min(1),
    /**
     * Delivered to the shell's PROCESS GROUP so it interrupts the foreground
     * command without killing the session (Ctrl-C semantics).
     */
    signal: z.literal('SIGINT'),
    forSurfaceId: z.string().min(1).optional(),
  })
  .strict();
export type PatchTerminalSignalEvent = z.infer<typeof PatchTerminalSignalEvent>;

export const PatchTerminalCloseEvent = z
  .object({
    type: z.literal('patch.terminal.close'),
    sessionId: z.string().min(1),
    forSurfaceId: z.string().min(1).optional(),
  })
  .strict();
export type PatchTerminalCloseEvent = z.infer<typeof PatchTerminalCloseEvent>;

export const PatchTerminalReadyEvent = z
  .object({
    type: z.literal('patch.terminal.ready'),
    sessionId: z.string().min(1),
    /** The resolved working directory the shell actually started in. */
    cwd: z.string().min(1),
    /**
     * `true` when the session is a real pseudo-terminal (the open asked for
     * `pty` and this host supports it). Absent = a pipe shell.
     */
    pty: z.boolean().optional(),
    forSurfaceId: z.string().min(1).optional(),
  })
  .strict();
export type PatchTerminalReadyEvent = z.infer<typeof PatchTerminalReadyEvent>;

export const PatchTerminalOutputEvent = z
  .object({
    type: z.literal('patch.terminal.output'),
    sessionId: z.string().min(1),
    stream: z.enum(['stdout', 'stderr']),
    /** Raw chunk exactly as read off the pipe. */
    data: z.string(),
    forSurfaceId: z.string().min(1).optional(),
  })
  .strict();
export type PatchTerminalOutputEvent = z.infer<typeof PatchTerminalOutputEvent>;

export const PatchTerminalCommandExitEvent = z
  .object({
    type: z.literal('patch.terminal.command-exit'),
    sessionId: z.string().min(1),
    /**
     * Exit status of the command that just finished, so the surface can say
     * whether it worked. A pipe shell echoes nothing and prints no prompt, so
     * without this frame a command that produced no output (`cd`, `export`,
     * `mkdir`) is indistinguishable from one still running — or from a session
     * wedged by something reading stdin.
     */
    code: z.number().int(),
    forSurfaceId: z.string().min(1).optional(),
  })
  .strict();
export type PatchTerminalCommandExitEvent = z.infer<typeof PatchTerminalCommandExitEvent>;

export const PatchTerminalExitEvent = z
  .object({
    type: z.literal('patch.terminal.exit'),
    sessionId: z.string().min(1),
    /** Shell exit code, or null when the session was signalled/killed. */
    code: z.number().nullable(),
    /** Why the session ended — rendered inline in the drawer. */
    reason: z.enum(['shell_exit', 'closed', 'idle_timeout', 'daemon_shutdown']),
    forSurfaceId: z.string().min(1).optional(),
  })
  .strict();
export type PatchTerminalExitEvent = z.infer<typeof PatchTerminalExitEvent>;

export const PatchTerminalErrorEvent = z
  .object({
    type: z.literal('patch.terminal.error'),
    sessionId: z.string().min(1),
    // `folder_not_found` — the folder does not exist on the host (NO
    // FALLBACK). `unknown_session` — input / signal / close for a session the
    // host does not have (e.g. after a host restart). `internal` — an
    // unexpected spawn failure.
    //
    // `too_many_sessions` is a RETIRED code, kept in the enum on purpose: the
    // concurrency cap that raised it is gone, but hosts OTA separately from
    // the server, so a host still on an older build emits it. This schema is
    // `.strict()` — dropping the value would make the server reject that frame
    // and leave the surface's prompt hanging with no error at all. It is never
    // emitted by a current host, and can be deleted once none are left.
    //
    // `pty_unavailable` — a PTY was asked for and this host cannot make one
    // (the helper that allocates it, `python3`, is missing or failed). Never
    // answered with a pipe shell instead. `not_a_pty` — a resize for a pipe
    // session.
    code: z.enum([
      'folder_not_found',
      'too_many_sessions',
      'unknown_session',
      'internal',
      'pty_unavailable',
      'not_a_pty',
    ]),
    message: z.string(),
    forSurfaceId: z.string().min(1).optional(),
  })
  .strict();
export type PatchTerminalErrorEvent = z.infer<typeof PatchTerminalErrorEvent>;

// ---------------------------------------------------------------------------
// Browser tunnel (spec/02 § Browser — Route through, spec/03 § Browser
// tunnel). Daemon-to-daemon, relayed by the server exactly like `patch.spawn`
// (never surface-addressed — a surface sets `browserRouteThrough` via
// `host.settings` and the two hosts do the rest).
//
// A host whose Browser settings name another host as "Route through" opens a
// local, loopback-only SOCKS5 listener that its own Chromium is launched
// against (`browser.ts`); each CONNECT that listener gets becomes one of
// these streams. No port is opened on either machine — only the existing
// host↔server WS links carry the bytes. Shaped like `patch.terminal.*`
// (open/data/close over a `sessionId`-like correlator) because it is the same
// problem: a persistent byte stream multiplexed over frames, not a
// request/response RPC.
//
// Lifecycle: `open` (browsing host → routing host) → `ready` or `error`
// (routing host → browsing host) → any number of `data` in EITHER direction →
// `close` from either side, which the server relays to the other and then
// forgets. There is no requestId: `streamId` alone correlates every frame of
// one stream, in both directions, for the stream's whole life.

export const PatchBrowserTunnelOpenEvent = z
  .object({
    type: z.literal('patch.browser_tunnel.open'),
    /** Minted by the browsing host; every later frame of this stream carries it. */
    streamId: z.string().min(1),
    /** The ROUTING host asked to make the real outbound connection. */
    ...daemonIdField,
    /** Destination the browsing host's Chromium asked its SOCKS proxy for. */
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
  })
  .strict();
export type PatchBrowserTunnelOpenEvent = z.infer<typeof PatchBrowserTunnelOpenEvent>;

/** The routing host made the real connection; the browsing host may now send `data`. */
export const PatchBrowserTunnelReadyEvent = z
  .object({
    type: z.literal('patch.browser_tunnel.ready'),
    streamId: z.string().min(1),
  })
  .strict();
export type PatchBrowserTunnelReadyEvent = z.infer<typeof PatchBrowserTunnelReadyEvent>;

/** Raw bytes, base64, in either direction. */
export const PatchBrowserTunnelDataEvent = z
  .object({
    type: z.literal('patch.browser_tunnel.data'),
    streamId: z.string().min(1),
    data: z.string().min(1),
  })
  .strict();
export type PatchBrowserTunnelDataEvent = z.infer<typeof PatchBrowserTunnelDataEvent>;

/** Either side ending the stream cleanly. The server relays it once, then drops the route. */
export const PatchBrowserTunnelCloseEvent = z
  .object({
    type: z.literal('patch.browser_tunnel.close'),
    streamId: z.string().min(1),
  })
  .strict();
export type PatchBrowserTunnelCloseEvent = z.infer<typeof PatchBrowserTunnelCloseEvent>;

/**
 * NO FALLBACK: the one frame that answers a stream the server or the routing
 * host refused — an unregistered or offline routing host (server-raised,
 * `host_not_registered` / `host_offline`), or that host's own outbound
 * connect failing (`connect_failed`). Always ends the stream; the browsing
 * host's SOCKS listener fails the CONNECT it is holding open rather than
 * ever trying the destination itself.
 */
export const PatchBrowserTunnelErrorEvent = z
  .object({
    type: z.literal('patch.browser_tunnel.error'),
    streamId: z.string().min(1),
    code: z.enum(['host_not_registered', 'host_offline', 'connect_failed']),
    message: z.string().min(1),
  })
  .strict();
export type PatchBrowserTunnelErrorEvent = z.infer<typeof PatchBrowserTunnelErrorEvent>;

// ---------------------------------------------------------------------------
// Cross-host audio relay over the host link (spec/07-voice-app.md § Voice is
// a per-host capability, spec/03-wire-protocol.md § Audio relay over the
// host link).
//
// A chat's voice runs on whichever host owns the chat, but a host is never
// itself internet-reachable (spec/01-server.md § WebSocket hub — it only
// dials out), so the server relaying `/audio/:sessionId` to a chat on any
// OTHER host has nothing to dial INTO unless that host has separately
// declared a direct address (`daemon.host.audioRelayHost` — an optional
// latency optimisation, correct only when the host is co-located with the
// server). This is the path that needs NOTHING declared: the server tunnels
// every frame of the session over the SAME outbound link the host already
// holds, tagged by `sessionId`, and the host bridges them to its own LOCAL
// audio WSS (`ws://127.0.0.1:<audioPort>/audio/:sessionId`) exactly as if a
// surface had dialled it directly — `audio/server.ts` runs completely
// unmodified on the other end, same discipline as the direct-dial path in
// `audio-relay.ts`.
//
// Shaped like `patch.browser_tunnel.*` (open/frame/close over a session-scoped
// correlator) — same underlying problem, a persistent byte stream multiplexed
// over frames — with one addition: `frame.binary` marks whether the inner WS
// frame it carries was text or binary, because a voice session's inner stream
// mixes BOTH (JSON control frames and raw PCM16) on one socket, unlike a
// browser tunnel's byte-opaque TCP stream. There is no separate streamId:
// `sessionId` alone correlates every frame, and it is already unique and
// TTL-bounded (`AUDIO_SESSION_ROUTE_TTL_MS` in audio-relay.ts).
//
// Lifecycle: `open` (server → host) → `ready` (informational; the server
// does not wait for it — frames sent before the local bridge is open are
// queued on the host side, same as the direct-dial path's own
// `pipeOnceOpen`) → any number of `frame` in EITHER direction → `close` from
// either side, or `error` (host → server) if the local bridge could not be
// made at all (e.g. voice is not installed on that host).

export const PatchAudioRelayOpenEvent = z
  .object({
    type: z.literal('patch.audio_relay.open'),
    sessionId: z.string().min(1),
  })
  .strict();
export type PatchAudioRelayOpenEvent = z.infer<typeof PatchAudioRelayOpenEvent>;

/** Informational: the host's local bridge socket is open. Nothing waits on this. */
export const PatchAudioRelayReadyEvent = z
  .object({
    type: z.literal('patch.audio_relay.ready'),
    sessionId: z.string().min(1),
  })
  .strict();
export type PatchAudioRelayReadyEvent = z.infer<typeof PatchAudioRelayReadyEvent>;

/** One inner WS frame's bytes, base64, in either direction. `binary` preserves the inner frame's own text/binary kind. */
export const PatchAudioRelayFrameEvent = z
  .object({
    type: z.literal('patch.audio_relay.frame'),
    sessionId: z.string().min(1),
    data: z.string(),
    binary: z.boolean(),
  })
  .strict();
export type PatchAudioRelayFrameEvent = z.infer<typeof PatchAudioRelayFrameEvent>;

/** Either side ending the bridge cleanly. */
export const PatchAudioRelayCloseEvent = z
  .object({
    type: z.literal('patch.audio_relay.close'),
    sessionId: z.string().min(1),
  })
  .strict();
export type PatchAudioRelayCloseEvent = z.infer<typeof PatchAudioRelayCloseEvent>;

/**
 * NO FALLBACK: the host's local bridge connection failed (its own audio WSS
 * refused the connection, or isn't listening at all — voice is an optional
 * component, spec/02 § Optional components). The server turns this into the
 * surface-facing `audio.error {code: 'host_unreachable'}`, never a silent
 * retry against a different pipeline.
 */
export const PatchAudioRelayErrorEvent = z
  .object({
    type: z.literal('patch.audio_relay.error'),
    sessionId: z.string().min(1),
    code: z.literal('connect_failed'),
    message: z.string().min(1),
  })
  .strict();
export type PatchAudioRelayErrorEvent = z.infer<typeof PatchAudioRelayErrorEvent>;

// ---------------------------------------------------------------------------
// Folder browsing RPC (spec/04-chats-and-folders.md § Browsing (directory
// listing)): server → host → on-disk listing.
//
// `patch.folders.browse.request` is server-originated: it backs
// `GET /api/folders/browse?dir=<abs>` — the new-chat / schedule-editor folder
// BROWSER (spec/15 § New chat flow → "Folder browser"). The host owns the
// project filesystem and is the only party that can list it, so the server
// round-trips this RPC exactly like `patch.skills.*` (requestId-correlated).
//
// Given a `dir` the host returns that directory's CHILD DIRECTORIES ONLY
// (name + absolute path; files are never listed — a chat targets a folder, not
// a file). With no `dir` the host returns its browsable ROOTS (the published
// folder list) as the entries, i.e. the top of the tree.
//
// CONFINEMENT (NO FALLBACK): listing is confined to the host's designated
// project roots. A `dir` that resolves outside every root — including `.`/`..`
// traversal escaping a root — yields `folder_not_found`, never a listing of `/`
// or a home directory. This is the flip side of the flat `folders.list`
// shortcut: browse lets a surface drill INTO the tree; `folders.list` is the
// one-tap common case.

export const FolderBrowseEntry = z
  .object({
    /** Directory basename, for display in the tree. */
    name: z.string().min(1),
    /** Absolute host-side path — what a subsequent browse/spawn targets. */
    path: z.string().min(1),
  })
  .strict();
export type FolderBrowseEntry = z.infer<typeof FolderBrowseEntry>;

export const PatchFoldersBrowseRequestEvent = z
  .object({
    type: z.literal('patch.folders.browse.request'),
    requestId: z.string().min(1),
    /**
     * The host whose filesystem is browsed. Browsing is addressed to ONE host
     * at a time — the one whose picker group the user is in (spec/04
     * § Browsing). It is never the surface's own filesystem, even on desktop.
     */
    ...daemonIdField,
    ...forSurfaceIdField,
    /**
     * Absolute directory to list. Omitted → the host returns its browsable
     * roots (the published folder list) as `entries`, with `dir`/`parent` null.
     */
    dir: z.string().min(1).optional(),
  })
  .strict();
export type PatchFoldersBrowseRequestEvent = z.infer<typeof PatchFoldersBrowseRequestEvent>;

export const PatchFoldersBrowseResponseEvent = z
  .object({
    type: z.literal('patch.folders.browse.response'),
    requestId: z.string().min(1),
    /** Echoes the host that answered, so a surface cannot mis-file a listing. */
    ...daemonIdField,
    ok: z.boolean(),
    /**
     * The directory that was listed (absolute), or `null` for the roots view
     * (the request carried no `dir`). Present when `ok`.
     */
    dir: z.string().nullable().optional(),
    /**
     * The parent directory to navigate "up" to (absolute), always still within
     * a confining root; `null` when `dir` is a root itself or for the roots
     * view (already at the top — "up" goes back to the roots list).
     */
    parent: z.string().nullable().optional(),
    /** Child directories of `dir` (or the roots), sorted by name. */
    entries: z.array(FolderBrowseEntry).optional(),
    error: z
      .object({
        // `folder_not_found` — the dir does not exist OR escaped every project
        // root (the confinement rejection; NO FALLBACK). `internal` — an
        // unexpected host-side failure reading the directory.
        code: z.enum(['folder_not_found', 'internal']),
        message: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type PatchFoldersBrowseResponseEvent = z.infer<typeof PatchFoldersBrowseResponseEvent>;

// ---------------------------------------------------------------------------
// Host files RPC (spec/03 § Host files, spec/15 § Host files and terminal):
// server → host → on-disk read / list / write, addressed to a HOST rather
// than resolved through a chat's folder.
//
// The chat-scoped `patch.files.*` pair can only reach inside a chat's pinned
// folder, so editing a skill in `~/.claude/skills` — or anything on a machine
// with no chat open on it — needed a chat first. This pair names the machine
// and an ABSOLUTE path instead. It is deliberately not confined to the project
// roots the way the folder browser is: the same surface can already open a
// shell on the host (`patch.terminal.open`), which reaches every file the
// host's user can, so a narrower file API would guard nothing while making
// the common case (a dotfile, a skill, a config under $HOME) unreachable. The
// gate is the one every host-addressed request has: an authenticated surface
// and a registered host.
//
// Paths must be absolute and already normal (no `.`/`..` segments, no doubled
// or trailing slash) — a relative or un-normalised path is `path_invalid`,
// never resolved against something the surface did not name. An OMITTED path
// on `list` is an explicit request for the host user's home directory, and
// the response's `path` says where that is.
//
// Writes are guarded against lost updates: `read` returns a `version` (the
// SHA-256 of the bytes on disk), and `write` must echo the version it edited
// from. If the file changed on disk since — the agent edited it, another
// surface saved — the write is refused with `conflict` and nothing is written.
// A write lands atomically (temp file + fsync + rename, keeping the file's
// mode), so a concurrent reader never sees half a file.

export const HostFilesEntry = z
  .object({
    name: z.string().min(1),
    /** Symlinks are reported as what they point at; a dangling one is `other`. */
    type: z.enum(['file', 'dir', 'other']),
    size: z.number().int().nonnegative().optional(),
  })
  .strict();
export type HostFilesEntry = z.infer<typeof HostFilesEntry>;

export const PatchHostFilesRequestEvent = z
  .object({
    type: z.literal('patch.host_files.request'),
    requestId: z.string().min(1),
    ...daemonIdField,
    /**
     * `list` a directory's entries, `read` a text file, `write` a text file
     * that already exists (the editor only ever saves a file it opened).
     */
    op: z.enum(['list', 'read', 'write']),
    /** Absolute, normalised host-side path. Omitted only on `list` (= home). */
    path: z.string().min(1).optional(),
    /** `write` only: the whole new content, UTF-8. */
    content: z.string().optional(),
    /** `write` only: the `version` the edit started from. */
    baseVersion: z.string().min(1).optional(),
  })
  .strict();
export type PatchHostFilesRequestEvent = z.infer<typeof PatchHostFilesRequestEvent>;

export const PatchHostFilesResponseEvent = z
  .object({
    type: z.literal('patch.host_files.response'),
    requestId: z.string().min(1),
    /** Echoes the host that answered. */
    ...daemonIdField,
    ok: z.boolean(),
    /** The absolute path acted on (the resolved home for a path-less `list`). */
    path: z.string().optional(),
    /** `list`: the parent directory, `null` at `/`. */
    parent: z.string().nullable().optional(),
    /** `list`: entries, directories first, then by name. */
    entries: z.array(HostFilesEntry).optional(),
    /** `read`: the file's UTF-8 content. */
    content: z.string().optional(),
    /** `read`: size in bytes. */
    size: z.number().int().nonnegative().optional(),
    /** `read` / `write`: SHA-256 (hex) of the bytes now on disk. */
    version: z.string().optional(),
    error: z
      .object({
        /**
         * - `path_invalid` — not absolute / not normalised, a `read`/`write`
         *   with no path, or a `write` missing `content`/`baseVersion` (→ 400).
         * - `not_found` — nothing at that path (→ 404).
         * - `not_a_directory` — `list` of a file (→ 400).
         * - `not_a_file` — `read`/`write` of a directory or special file (→ 400).
         * - `too_large` — over the editor's size cap (→ 413).
         * - `binary` — not UTF-8 text; the editor will not open it (→ 415).
         * - `conflict` — `write` whose `baseVersion` is not what is on disk (→ 409).
         * - `permission_denied` — the host's user cannot read/write it (→ 403).
         * - `internal` — anything else on disk (→ 502).
         */
        code: z.enum([
          'path_invalid',
          'not_found',
          'not_a_directory',
          'not_a_file',
          'too_large',
          'binary',
          'conflict',
          'permission_denied',
          'internal',
        ]),
        message: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type PatchHostFilesResponseEvent = z.infer<typeof PatchHostFilesResponseEvent>;

// ---------------------------------------------------------------------------
// Fetching one blob's bytes (spec/04 § History — blobs)
//
// Replay sends tool output as a REFERENCE, never a body, because tool output
// is 85-99% of a long chat's bytes and every one of those rows draws
// collapsed. These two events are how a body is fetched when the reader
// actually opens one, behind `GET /api/chats/:chatId/blob/:sha`.
//
// The sha IS the content, so a fetched blob can never go stale: the server
// serves it `immutable`, and a surface that has one never asks again — which
// is also why restarting the app does not re-download a single picture or
// tool result it already holds.

/** Ceiling on one blob transfer. The largest blob on this account is 3.9 MB
 *  and p99 is 664 KB, so this is generous headroom while staying far below
 *  the WebSocket frame limit and well clear of the server's memory. */
export const BLOB_FETCH_LIMIT_BYTES = 16 * 1024 * 1024;

export const PatchBlobRequestEvent = z
  .object({
    type: z.literal('patch.blob.request'),
    requestId: z.string().min(1),
    ...daemonIdField,
    /** Which chat the reader is looking at — the host that owns it answers. */
    chatId: z.string().min(1),
    /** Content hash of the wanted blob, as carried on the reference. */
    sha: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type PatchBlobRequestEvent = z.infer<typeof PatchBlobRequestEvent>;

export const PatchBlobResponseEvent = z
  .object({
    type: z.literal('patch.blob.response'),
    requestId: z.string().min(1),
    /** Echoes the host that answered. */
    ...daemonIdField,
    ok: z.boolean(),
    /** What the bytes are, so the server can set `Content-Type` honestly. */
    mime: z.string().min(1).optional(),
    /** The blob itself, base64 — this wire is JSON and a blob is binary. */
    data: z.string().optional(),
    error: z
      .object({
        /**
         * - `not_found` — this host holds no blob with that sha (→ 404).
         * - `too_large` — over `BLOB_FETCH_LIMIT_BYTES` (→ 413).
         * - `internal` — anything else on disk (→ 502).
         */
        code: z.enum(['not_found', 'too_large', 'internal']),
        message: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type PatchBlobResponseEvent = z.infer<typeof PatchBlobResponseEvent>;

// ---------------------------------------------------------------------------
// Moving a chat between hosts (spec/04 § Moving a chat to another host)
//
// A chat lives on one machine, but it is not welded to it. The SERVER drives a
// move as three round trips, each one `patch.chat_move.request` to one host:
//
//   1. `export` on the chat's current host: everything the chat IS on disk —
//      its `~/.patch/chats/<id>/` directory (history log, meta, native session
//      mirror), the blobs its log references, the attachments its turns
//      carried, and the Claude transcript when the mirror has not got it.
//   2. `import` on the target host, with that bundle and the folder the chat
//      will run in there. The target writes it, loads the chat, and announces
//      it (`chat.spawned` + `chat.state`) like any other chat of its own.
//   3. `retire` on the old host: the chat leaves its memory, and its directory
//      is kept aside under `~/.patch/moved/` rather than deleted.
//
// From `export` until `retire` the old host refuses new turns for the chat, so
// nothing can land in a copy that is about to stop existing. A move that fails
// after `export` sends `release`, which lifts that refusal and leaves the chat
// exactly where it was.
//
// NO FALLBACK: any step that fails stops the move where it is, and the chat
// stays on whichever host still owns it — never two live copies, never none.

/** One file in a move bundle. `path` is namespaced: `chat/<rel>`, `blob/<sha256>`, `attachment/<name>`. */
export const ChatMoveFile = z
  .object({
    path: z.string().min(1),
    /** The file's bytes, base64. */
    data: z.string(),
  })
  .strict();
export type ChatMoveFile = z.infer<typeof ChatMoveFile>;

export const ChatMoveBundle = z
  .object({
    chatId: z.string().min(1),
    /** The folder the chat ran in on the host it is leaving. */
    sourceFolder: z.string().min(1),
    files: z.array(ChatMoveFile),
    /** The chat's own entries from its folder's attachment manifest, keyed by id. */
    attachments: z.record(z.string(), z.unknown()),
  })
  .strict();
export type ChatMoveBundle = z.infer<typeof ChatMoveBundle>;

export const ChatMoveOp = z.enum(['export', 'import', 'retire', 'release']);
export type ChatMoveOp = z.infer<typeof ChatMoveOp>;

export const PatchChatMoveRequestEvent = z
  .object({
    type: z.literal('patch.chat_move.request'),
    requestId: z.string().min(1),
    /** The host this step runs on. */
    ...daemonIdField,
    chatId: z.string().min(1),
    op: ChatMoveOp,
    /** `import` only: the absolute folder the chat will run in on this host. */
    folder: z.string().min(1).optional(),
    /** `import` only: what `export` produced. */
    bundle: ChatMoveBundle.optional(),
  })
  .strict();
export type PatchChatMoveRequestEvent = z.infer<typeof PatchChatMoveRequestEvent>;

export const ChatMoveErrorCode = z.enum([
  /** The chat is not on this host. */
  'not_found',
  /** It is mid-turn, waiting on a permission, or has a wake or watch armed. */
  'busy',
  /** A special thread, or a chat whose session is on a harness a move cannot carry. */
  'unsupported',
  /** `import`: the target folder is not a directory on this host. */
  'folder_not_found',
  /** `import`: this host already has a chat with that id. */
  'already_exists',
  /** `export`: the bundle would be too big to send in one frame. */
  'too_large',
  'internal',
]);
export type ChatMoveErrorCode = z.infer<typeof ChatMoveErrorCode>;

export const PatchChatMoveResponseEvent = z
  .object({
    type: z.literal('patch.chat_move.response'),
    requestId: z.string().min(1),
    /** Echoes the host that answered. */
    ...daemonIdField,
    chatId: z.string().min(1),
    op: ChatMoveOp,
    ok: z.boolean(),
    /** `export`: the chat, ready to import. */
    bundle: ChatMoveBundle.optional(),
    error: z.object({ code: ChatMoveErrorCode, message: z.string() }).strict().optional(),
  })
  .strict();
export type PatchChatMoveResponseEvent = z.infer<typeof PatchChatMoveResponseEvent>;

// ---------------------------------------------------------------------------
// Chat search (spec/03 § Chat search, spec/04 § Search)
//
// `GET /api/chats/search?q=` searches every chat on every host — names and the
// full text of what was said. The transcripts live on the hosts, so the server
// fans one `patch.chat_search.request` out to each online host, merges the
// answers, and names every host it could not search. Correlated by
// `requestId`; the response carries message text, so it is never relayed to
// surfaces over the socket.

/** Shortest query (after trimming) a search accepts. */
export const CHAT_SEARCH_MIN_QUERY = 2;
/** Results per page when the caller names no `limit`. */
export const CHAT_SEARCH_DEFAULT_LIMIT = 20;
/** The most results one page may ask for. */
export const CHAT_SEARCH_MAX_LIMIT = 50;
/**
 * The deepest a caller may page (`offset + limit`). Each host is asked for its
 * top `offset + limit` hits, so this bounds what one host sends back.
 */
export const CHAT_SEARCH_MAX_DEPTH = 200;

/** A `[start, end)` character range in the string it rides with. */
export const ChatSearchRange = z.tuple([z.number().int().nonnegative(), z.number().int()]);
export type ChatSearchRange = z.infer<typeof ChatSearchRange>;

/**
 * Where a hit is drawn in the chat list — the section a surface would find it
 * under, so a result says where the chat lives as well as what it said.
 */
export const ChatSearchSection = z.enum([
  'manager',
  'channels',
  'pinned',
  'folders',
  'snoozed',
  'hidden',
  'archived',
]);
export type ChatSearchSection = z.infer<typeof ChatSearchSection>;

/** The matched message, cut down to a window around the match. */
export const ChatSearchSnippet = z
  .object({
    /** A window of the message's text (plain; an ellipsis marks a cut end). */
    text: z.string(),
    /** Every query-term occurrence inside `text`. */
    highlights: z.array(ChatSearchRange),
    role: z.enum(['user', 'assistant']),
    /**
     * The canonical seq of the message — what a surface scrolls the opened chat
     * to. `null` when the host has never numbered it (a turn that has not been
     * replayed since it was written) or the match came from the chat's stored
     * first-message preview rather than its transcript: the chat still opens,
     * at its latest message.
     */
    seq: z.number().int().nonnegative().nullable(),
    /** When the message was written (ms epoch), or `null` when unrecorded. */
    createdAt: z.number().int().nullable(),
  })
  .strict();
export type ChatSearchSnippet = z.infer<typeof ChatSearchSnippet>;

export const ChatSearchHit = z
  .object({
    chatId: z.string().min(1),
    daemonId: DaemonId,
    name: z.string().nullable(),
    preview: z.string().nullable(),
    folder: z.string(),
    status: ChatStatus,
    section: ChatSearchSection,
    pinned: z.boolean(),
    snoozedUntil: z.number().int().nullable(),
    lastUpdated: z.number().int(),
    /**
     * The job that created the chat (spec/08 § Action), filled in by the
     * server from its chat registry; `null` for a chat a person started.
     */
    jobId: z.string().nullable(),
    /** The chat's name matched. Name matches rank above content matches. */
    nameMatch: z.boolean(),
    /** Query-term ranges inside `name` (empty when the name did not match). */
    nameHighlights: z.array(ChatSearchRange),
    /** How many messages in the chat matched. */
    messageMatches: z.number().int().nonnegative(),
    /** The most recent matching message, or `null` for a name-only match. */
    snippet: ChatSearchSnippet.nullable(),
    /**
     * `true` when the server answered from its own copy of the chat because
     * the chat's host is offline (spec/04 § History — server mirror). Absent
     * on a hit the host itself returned.
     */
    mirrored: z.boolean().optional(),
  })
  .strict();
export type ChatSearchHit = z.infer<typeof ChatSearchHit>;

// ---------------------------------------------------------------------------
// Provider keys (server <-> host, spec/02 § Provider keys, spec/03 § Provider
// keys). Set or revoke one of a host's provider keys from Settings → Hosts.
// Surfaces reach it over REST, which round-trips one request to the named
// host. The REQUEST carries a key's value, so it only ever travels server →
// that one host; the RESPONSE carries only the host's key statuses (never a
// value) and is still answered to the one caller over REST, never relayed.

export const PatchChatSearchRequestEvent = z
  .object({
    type: z.literal('patch.chat_search.request'),
    requestId: z.string().min(1),
    ...daemonIdField,
    /** Trimmed, at least `CHAT_SEARCH_MIN_QUERY` characters. */
    query: z.string().min(CHAT_SEARCH_MIN_QUERY),
    /** How many of the host's top hits to send back. */
    limit: z.number().int().positive().max(CHAT_SEARCH_MAX_DEPTH),
    /** false = chat names only; absent or true = names and message text. */
    fullText: z.boolean().optional(),
  })
  .strict();
export type PatchChatSearchRequestEvent = z.infer<typeof PatchChatSearchRequestEvent>;

export const PatchChatSearchResponseEvent = z
  .object({
    type: z.literal('patch.chat_search.response'),
    requestId: z.string().min(1),
    ...daemonIdField,
    ok: z.boolean(),
    /** The host's top hits, best first (name matches, then most recent). */
    hits: z.array(ChatSearchHit).optional(),
    /** Every hit on the host, of which `hits` is the head. */
    total: z.number().int().nonnegative().optional(),
    /** Chats searched (every chat on the host except deleted ones). */
    searchedChats: z.number().int().nonnegative().optional(),
    /**
     * Chats whose transcript is no longer on disk, so only their name and
     * first-message preview could be searched.
     */
    transcriptsMissing: z.number().int().nonnegative().optional(),
    error: z
      .object({ code: z.enum(['internal']), message: z.string() })
      .strict()
      .optional(),
  })
  .strict();
export type PatchChatSearchResponseEvent = z.infer<typeof PatchChatSearchResponseEvent>;

/**
 * One host's part in a search. Every registered host is listed, so a host that
 * was not searched is always named rather than silently absent.
 */
export const ChatSearchHostResult = z
  .object({
    daemonId: DaemonId,
    hostName: z.string().nullable(),
    /**
     * - `searched` — the host answered.
     * - `offline` — the host is not connected; nothing on it was searched.
     * - `timeout` — the host did not answer in time; nothing on it is included.
     * - `error` — the host answered with a failure (`message` says what).
     */
    state: z.enum(['searched', 'offline', 'timeout', 'error']),
    message: z.string().optional(),
    searchedChats: z.number().int().nonnegative().optional(),
    transcriptsMissing: z.number().int().nonnegative().optional(),
    /**
     * On an `offline` host: how many of its chats the server searched from its
     * own mirror instead. Absent when the host was asked directly.
     */
    mirroredChats: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ChatSearchHostResult = z.infer<typeof ChatSearchHostResult>;

/** `GET /api/chats/search` — one page of merged hits. */
export const ChatSearchResponse = z
  .object({
    query: z.string(),
    hits: z.array(ChatSearchHit),
    /** Hits across every host that answered. */
    total: z.number().int().nonnegative(),
    /** The `offset` of the next page, or `null` when this is the last. */
    nextOffset: z.number().int().nonnegative().nullable(),
    hosts: z.array(ChatSearchHostResult),
  })
  .strict();
export type ChatSearchResponse = z.infer<typeof ChatSearchResponse>;

/**
 * The one ordering every host and the server share: the most recently active
 * chat first, whether it matched on name or message text. Ties break on chatId
 * so pages never overlap.
 */
export function compareChatSearchHits(a: ChatSearchHit, b: ChatSearchHit): number {
  if (a.lastUpdated !== b.lastUpdated) return b.lastUpdated - a.lastUpdated;
  return a.chatId < b.chatId ? -1 : a.chatId > b.chatId ? 1 : 0;
}

const SNIPPET_BEFORE = 60;
const SNIPPET_LENGTH = 180;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every occurrence of every term in `text`, merged into sorted disjoint ranges. */
export function highlightRanges(text: string, terms: string[]): ChatSearchRange[] {
  const raw: [number, number][] = [];
  for (const term of terms) {
    // A phrase term has single spaces; let it match any whitespace run in the text.
    const re = new RegExp(escapeRegExp(term).replace(/ /g, '\\s+'), 'gi');
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      raw.push([m.index, m.index + m[0].length]);
      if (m[0].length === 0) re.lastIndex += 1;
    }
  }
  raw.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: ChatSearchRange[] = [];
  for (const r of raw) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/**
 * A window of `text` around the first term's first occurrence, whitespace
 * collapsed, with an ellipsis on each cut end and the ranges of every term.
 */
export function makeSnippet(
  text: string,
  terms: string[],
): { text: string; highlights: ChatSearchRange[] } {
  const flat = text.replace(/\s+/g, ' ').trim();
  const lower = flat.toLowerCase();
  const first = terms.length > 0 ? lower.indexOf(terms[0]!) : -1;
  let start = Math.max(0, (first < 0 ? 0 : first) - SNIPPET_BEFORE);
  let end = Math.min(flat.length, start + SNIPPET_LENGTH);
  start = Math.max(0, Math.min(start, end - SNIPPET_LENGTH));
  // Start and end on a word boundary where one is close, so the window does
  // not open or close mid-word.
  if (start > 0) {
    const space = flat.indexOf(' ', start);
    if (space >= 0 && space < (first < 0 ? end : first)) start = space + 1;
  }
  if (end < flat.length) {
    const space = flat.lastIndexOf(' ', end);
    if (space > start && space > (first < 0 ? start : first + (terms[0]?.length ?? 0))) end = space;
  }
  const window = `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
  return { text: window, highlights: highlightRanges(window, terms) };
}

/**
 * A search query as lowercase terms. Whitespace separates terms; a run in
 * double quotes is ONE term matched as an exact phrase (internal whitespace
 * collapsed to single spaces, an unterminated quote runs to the end). Distinct
 * terms only; empty quotes are ignored.
 */
export function parseSearchQuery(query: string): string[] {
  const terms: string[] = [];
  const re = /"([^"]*)(?:"|$)|(\S+)/g;
  for (let m = re.exec(query); m !== null; m = re.exec(query)) {
    const raw = m[1] !== undefined ? m[1] : (m[2] ?? '');
    const t = raw.toLowerCase().replace(/\s+/g, ' ').trim();
    if (t.length > 0 && !terms.includes(t)) terms.push(t);
  }
  return terms;
}

// ---------------------------------------------------------------------------
// Voice-note clip transcription (spec/07 § End-to-end voice transport —
// "Voice note (single utterance)")
//
// On mobile a streaming PCM tap isn't available, so the surface records the
// note locally and uploads it as one file to `POST /api/voice/note`. The
// server does not own Whisper — the host does — so it round-trips the clip
// over the host link, correlated by `requestId` exactly like
// `patch.skills.*` / `patch.secrets.*`:
//   - `patch.voice_note.transcribe_request`  — server → host: the m4a clip
//     (base64; the JSON wire codec has no binary frame) for the host to run
//     through its Whisper backend's "uploaded clip" path.
//   - `patch.voice_note.transcribe_response` — host → server: the final
//     transcript, or a typed error (e.g. the `local` faster-whisper backend
//     cannot accept compressed m4a — it takes PCM only).
// The server then injects the transcript as a `chat.input` tagged
// `source: { kind: 'voice-app', surfaceKind: 'mobile' }` (above).

// ---------------------------------------------------------------------------
// Script jobs (spec/08 § Action — `script`)
//
// A job whose action is `script` runs a COMMAND on a host instead of starting a
// chat. The server dispatches the request to the host the action names, exactly
// as it addresses a spawn; the host runs it and reports back. There is no
// chat and no model anywhere in this path — that is the whole point of it.

export const JobExecRequestEvent = z
  .object({
    type: z.literal('job.exec_request'),
    /** The host the command runs on. */
    ...daemonIdField,
    /** The job this fire belongs to, echoed back so the run can be logged. */
    jobId: z.string().min(1),
    /** This fire's id — the correlation key for the result. */
    fireId: z.string().min(1),
    /** Absolute host-side directory to run in. Missing → the fire fails. */
    folder: z.string().min(1),
    /** Run through the host's shell, as the host's user. */
    command: z.string().min(1),
    /** Kill and fail after this long. The server always sends it. */
    timeoutMs: z.number().int().min(1000).max(600_000),
  })
  .strict();
export type JobExecRequestEvent = z.infer<typeof JobExecRequestEvent>;

export const JobExecResultEvent = z
  .object({
    type: z.literal('job.exec_result'),
    jobId: z.string().min(1),
    fireId: z.string().min(1),
    /** Exit 0 and not timed out. The server writes ok/failed runs from this. */
    ok: z.boolean(),
    /** Null when the command never ran (bad folder) or was killed. */
    exitCode: z.number().int().nullable(),
    /** Wall-clock ms the command took. */
    durationMs: z.number().int().min(0),
    /** Tail of stdout, capped by the host. Empty string when silent. */
    stdout: z.string(),
    /** Tail of stderr, same cap. A quiet command's diagnosis lives here. */
    stderr: z.string(),
    /** Set when the fire failed BEFORE or AROUND the command (spawn error, timeout). */
    error: z.string().optional(),
  })
  .strict();
export type JobExecResultEvent = z.infer<typeof JobExecResultEvent>;

// ---------------------------------------------------------------------------
// Message hooks (spec/20-hooks.md)
//
// Backing `POST /api/hooks/check`. The server dispatches one of these per
// matching hook, to the CHAT'S OWN host — the gate decides whether a hook
// applies, never where it runs (spec/20-hooks.md § `script`).

export const HookCheckRequestEvent = z
  .object({
    type: z.literal('hook.check_request'),
    ...daemonIdField,
    requestId: z.string().min(1),
    hookId: z.string().min(1),
    kind: HookKind,
    script: HookScript.optional(),
    prompt: HookPrompt.optional(),
    timeoutMs: z.number().int().min(1000).max(60_000),
    context: z
      .object({
        message: z.string(),
        /** `user_message` prompt hooks only — the composer's image attachments. */
        images: HookImages.optional(),
        chatId: z.string().min(1),
        folder: z.string().min(1),
        daemonId: z.string().min(1),
        specialThread: z.boolean(),
        /** `agent_response` only (spec/20-hooks.md § On the agent's response). */
        toolCallsSummary: z.string().optional(),
      })
      .strict(),
  })
  .strict();
export type HookCheckRequestEvent = z.infer<typeof HookCheckRequestEvent>;

export const HookCheckResultEvent = z
  .object({
    type: z.literal('hook.check_result'),
    requestId: z.string().min(1),
    hookId: z.string().min(1),
    status: z.enum(['ok', 'failed', 'timeout']),
    /** Present only when `status === 'ok'`. */
    decision: HookDecision.optional(),
    analysis: z.string().optional(),
    suggestion: z.string().optional(),
    /** Set when `status` is `'failed'` or `'timeout'`. */
    error: z.string().optional(),
    durationMs: z.number().int().min(0),
  })
  .strict();
export type HookCheckResultEvent = z.infer<typeof HookCheckResultEvent>;

// ---------------------------------------------------------------------------
// Agent-response hooks (spec/20-hooks.md § On the agent's response)
//
// Unlike `user_message` (a surface asks `POST /api/hooks/check` before it
// sends), an `agent_response` check has no surface to ask it — it runs the
// moment a turn settles, on whichever backend the chat happens to be on. The
// HOST is the one thing that has the agent's full reply text and the
// turn's own tool calls without a round trip, so it starts this: one
// `hook.agent_response_check_request` per settled turn, carrying everything
// the gate/filter and the hooks themselves need. The server resolves matching
// `agent_response` hooks and dispatches each with the EXISTING
// `hook.check_request` / `hook.check_result` pair (same wire shape as
// `user_message`, just addressed by `checkId` instead of a surface's
// `requestId`), then reports the aggregate back as ONE
// `hook.agent_response_outcome` — the host decides what a block / advise /
// failure actually DOES to the chat (resubmit, defer, notice); the server
// only matches and dispatches, exactly as it does for `user_message`.

export const HookAgentResponseCheckRequestEvent = z
  .object({
    type: z.literal('hook.agent_response_check_request'),
    ...daemonIdField,
    chatId: z.string().min(1),
    /** Correlates the eventual `hook.agent_response_outcome`. */
    checkId: z.string().min(1),
    folder: z.string().min(1),
    specialThread: z.boolean(),
    /** The agent's full final reply for this turn. */
    reply: z.string(),
    /** Deterministic tally of the turn's tool calls, e.g. "Ran 2 commands, read 1 file". */
    toolCallsSummary: z.string(),
  })
  .strict();
export type HookAgentResponseCheckRequestEvent = z.infer<typeof HookAgentResponseCheckRequestEvent>;

export const HookAgentResponseOutcomeEvent = z
  .object({
    type: z.literal('hook.agent_response_outcome'),
    ...daemonIdField,
    chatId: z.string().min(1),
    checkId: z.string().min(1),
    /** Every matching hook's own result — the host sorts out what each means. */
    results: z.array(HookRunResult),
  })
  .strict();
export type HookAgentResponseOutcomeEvent = z.infer<typeof HookAgentResponseOutcomeEvent>;

export const PatchVoiceNoteTranscribeRequestEvent = z
  .object({
    type: z.literal('patch.voice_note.transcribe_request'),
    requestId: z.string().min(1),
    /** The uploading surface (for logging/context). */
    surfaceKind: VoiceAppSurfaceKind,
    /** Container format of the uploaded clip. Mobile records m4a. */
    format: z.enum(['m4a', 'wav']),
    /** The clip bytes, base64-encoded (JSON codec has no binary frame). */
    audioBase64: z.string().min(1),
  })
  .strict();
export type PatchVoiceNoteTranscribeRequestEvent = z.infer<
  typeof PatchVoiceNoteTranscribeRequestEvent
>;

export const PatchVoiceNoteTranscribeResponseEvent = z
  .object({
    type: z.literal('patch.voice_note.transcribe_response'),
    requestId: z.string().min(1),
    ok: z.boolean(),
    /** The final transcript (present when `ok`). */
    transcript: z.string().optional(),
    error: z
      .object({
        /**
         * `voice_key_missing`: dictation is configured onto a hosted backend
         * whose key this host lacks; `message` is `voiceKeyMissingMessage`.
         */
        code: z.enum([
          'unsupported_format',
          'transcription_failed',
          'voice_key_missing',
          'internal',
        ]),
        message: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type PatchVoiceNoteTranscribeResponseEvent = z.infer<
  typeof PatchVoiceNoteTranscribeResponseEvent
>;

// ---------------------------------------------------------------------------
// Composer attachment store (spec/14 & spec/15 § Composer — "Attachments").
//
// The server owns the HTTP upload route (`POST /api/chats/:chatId/attachment`)
// and stores its own copy for serving back to surfaces. But Claude runs on the
// HOST with the chat's folder as cwd, so it can only read files on the
// host's filesystem. The server therefore round-trips the uploaded bytes to
// the host over the host link (base64; the JSON codec has no binary frame),
// correlated by `requestId` exactly like `patch.voice_note.*` / `patch.skills.*`:
//   - `patch.attachment.store_request`  — server → host: the file to write
//     under the chat's dir so a later `chat.input` carrying the ref can be fed
//     into the turn by path.
//   - `patch.attachment.store_response` — host → server: the absolute on-disk
//     path it wrote, or a typed error (unknown chat / write failure).
// NO FALLBACK: a store failure fails the whole upload — the attachment is never
// silently dropped.

export const PatchAttachmentStoreRequestEvent = z
  .object({
    type: z.literal('patch.attachment.store_request'),
    requestId: z.string().min(1),
    chatId: z.string().min(1),
    /** Server-minted id (ULID) — also the on-disk name prefix. */
    id: z.string().min(1),
    name: z.string().min(1),
    mimeType: z.string().min(1),
    kind: AttachmentKind,
    /** The file bytes, base64-encoded (JSON codec has no binary frame). */
    dataBase64: z.string().min(1),
  })
  .strict();
export type PatchAttachmentStoreRequestEvent = z.infer<typeof PatchAttachmentStoreRequestEvent>;

export const PatchAttachmentStoreResponseEvent = z
  .object({
    type: z.literal('patch.attachment.store_response'),
    requestId: z.string().min(1),
    ok: z.boolean(),
    /** Absolute host-side path the file was written to (present when `ok`). */
    path: z.string().optional(),
    error: z
      .object({
        code: z.enum(['chat_not_found', 'invalid_data', 'internal']),
        message: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type PatchAttachmentStoreResponseEvent = z.infer<typeof PatchAttachmentStoreResponseEvent>;

// ---------------------------------------------------------------------------
// Artifact publish (host → server request/response, spec/14 § Artifacts)
//
// The host owns the file (Claude runs there); the server owns the public
// origin, so the bytes travel host→server and the server replies with the
// URL it will serve them from. NO FALLBACK: the tool fails loudly when the
// link is down or the write fails — it never returns a URL that 404s.

export const PatchArtifactPublishRequestEvent = z
  .object({
    type: z.literal('patch.artifact.publish_request'),
    requestId: z.string().min(1),
    chatId: z.string().min(1),
    /** Deterministic id derived from (chatId, source path) — republish updates. */
    artifactId: z.string().min(1),
    title: z.string().min(1),
    /** Source file (chat-folder-relative), for display + provenance. */
    path: z.string().min(1),
    /** The page source. HTML only — see spec/14 § Artifacts. Exactly one of
     * `html`/`raw` is set. */
    html: z.string().min(1).optional(),
    /** Non-HTML body served byte-for-byte with its own content-type — an
     * `<img>` tag needs real image bytes, not an HTML page wrapping a data
     * URI, so `view_file` on an image publishes through here instead of
     * `html`. Exactly one of `html`/`raw` is set. */
    raw: z
      .object({
        contentType: z.string().min(1),
        base64: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();
export type PatchArtifactPublishRequestEvent = z.infer<typeof PatchArtifactPublishRequestEvent>;

export const PatchArtifactPublishResponseEvent = z
  .object({
    type: z.literal('patch.artifact.publish_response'),
    requestId: z.string().min(1),
    ok: z.boolean(),
    /** Server-relative URL the artifact is served from (present when `ok`). */
    url: z.string().optional(),
    error: z
      .object({
        code: z.enum(['invalid_data', 'internal']),
        message: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type PatchArtifactPublishResponseEvent = z.infer<typeof PatchArtifactPublishResponseEvent>;

// ---------------------------------------------------------------------------
// Pads (spec/14 § Pads) — design spaces the agent starts and keeps modifying.
//
// The agent's `patch_pad_*` tools run on the host, which holds the design's
// files; the server owns the Pad (its screens, Tom's changes, the pictures).
// The host asks over this request/response pair: `create`/`update` ship a
// folder of files, `reply` answers a batch of Tom's changes, `list` reads
// what exists. NO FALLBACK: every failure comes back as `ok: false` with why.
export const PadFileEntry = z
  .object({
    /** Pad-relative, forward slashes, no `..`. */
    path: z.string().min(1),
    base64: z.string(),
  })
  .strict();
export type PadFileEntry = z.infer<typeof PadFileEntry>;

export const PatchPadRequestEvent = z
  .object({
    type: z.literal('patch.pad.request'),
    requestId: z.string().min(1),
    op: z.enum(['create', 'update', 'reply', 'list']),
    /** The chat the agent is calling from — the owner of a created Pad. */
    chatId: z.string().min(1),
    padId: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    /** The app the Pad designs for, so it files under that app. */
    app: z.string().min(1).optional(),
    device: z.enum(['desktop', 'phone']).optional(),
    /** The Pad's whole file set (create/update). */
    files: z.array(PadFileEntry).optional(),
    /** The reply text (reply). */
    text: z.string().min(1).optional(),
  })
  .strict();
export type PatchPadRequestEvent = z.infer<typeof PatchPadRequestEvent>;

export const PatchPadResponseEvent = z
  .object({
    type: z.literal('patch.pad.response'),
    requestId: z.string().min(1),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z
      .object({
        code: z.enum(['invalid_input', 'not_found', 'internal']),
        message: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type PatchPadResponseEvent = z.infer<typeof PatchPadResponseEvent>;

// ---------------------------------------------------------------------------
// Secrets (spec/15 § Settings tab — Secrets)
//
// The host owns the key-value secret store (it injects them into chats), the
// same ownership model as folders: the host publishes the current set to the
// server, which mirrors it (SecretsRegistry) and relays it to every surface so
// one consistent, editable list appears everywhere. Values are carried over the
// authenticated links; surfaces mask them by default and reveal on tap.
//
// - `secrets.list`    — full snapshot the host sends on (re)connect.
// - `secrets.updated` — push the host sends whenever the set changes (after a
//                       set/delete lands). Both carry the COMPLETE list.
//
// Writes are surface-originated RPCs the server round-trips to the host (the
// owner), correlated by `requestId` exactly like `patch.skills.*`:
// - `patch.secrets.set_request`    — upsert a key's value.
// - `patch.secrets.delete_request` — remove a key.
// - `patch.secrets.response`       — the host's ack for either.
// After a successful mutation the host also emits `secrets.updated` so every
// mirror + surface reflects the write immediately.

export const SecretEntry = z
  .object({
    key: z.string().min(1),
    value: z.string(),
  })
  .strict();
export type SecretEntry = z.infer<typeof SecretEntry>;

export const SecretsListEvent = z
  .object({
    type: z.literal('secrets.list'),
    secrets: z.array(SecretEntry),
  })
  .strict();
export type SecretsListEvent = z.infer<typeof SecretsListEvent>;

export const SecretsUpdatedEvent = z
  .object({
    type: z.literal('secrets.updated'),
    secrets: z.array(SecretEntry),
  })
  .strict();
export type SecretsUpdatedEvent = z.infer<typeof SecretsUpdatedEvent>;

export const PatchSecretsSetRequestEvent = z
  .object({
    type: z.literal('patch.secrets.set_request'),
    requestId: z.string().min(1),
    key: z.string().min(1),
    value: z.string(),
  })
  .strict();
export type PatchSecretsSetRequestEvent = z.infer<typeof PatchSecretsSetRequestEvent>;

export const PatchSecretsDeleteRequestEvent = z
  .object({
    type: z.literal('patch.secrets.delete_request'),
    requestId: z.string().min(1),
    key: z.string().min(1),
  })
  .strict();
export type PatchSecretsDeleteRequestEvent = z.infer<typeof PatchSecretsDeleteRequestEvent>;

export const PatchSecretsResponseEvent = z
  .object({
    type: z.literal('patch.secrets.response'),
    requestId: z.string().min(1),
    ok: z.boolean(),
    error: z
      .object({
        code: z.enum(['invalid_key', 'not_found', 'internal']),
        message: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type PatchSecretsResponseEvent = z.infer<typeof PatchSecretsResponseEvent>;

// ---------------------------------------------------------------------------
// Notifications (host → server → channel router)

/**
 * `kind` distinguishes a plain push/desktop/speakers notification from a
 * call-style ring (group 11) or a batch check-in (spec/09 § Batch check-in).
 * `'ask'` is a `patch_ask_human` push: the agent is blocked until the user acts,
 * so it is never held back for presence the way an ordinary push is.
 * Default (omitted) is treated as `'message'`.
 */
export const NotifyKind = z.enum(['message', 'call', 'batch', 'ask']);
export type NotifyKind = z.infer<typeof NotifyKind>;

/**
 * The `chatId` a batch check-in notify carries — there is no source chat, so
 * this reserved, never-a-real-chat id stands in (same shape as
 * `SPECIAL_THREAD_IDS` in `index.ts`, kept here to avoid an import cycle).
 * A surface reads `kind === 'batch'` to know to open the batch view instead
 * of resolving this as a chat.
 */
export const BATCH_NOTIFY_CHAT_ID = 'batch_ready';

/**
 * Notification actions (spec/09 § Notification actions). What a push/desktop
 * toast can be acted on without opening the chat — absent means the plain
 * baseline: a Reply text box and nothing else. `actionsKind` names which
 * other controls join it:
 *
 * - `'permission'` — an ordinary tool approval. `requestId` is required; the
 *   surface renders Approve/Deny instead of Reply.
 * - `'question'` — an `AskUserQuestion` permission request. `requestId` and
 *   `questionText` are required (the answer is keyed on the question text,
 *   spec/03 § Answering with content). `options` (≤3) renders as buttons in
 *   place of Reply; its absence (a multi-question batch, >3 options, or a
 *   multi-select question — none of which a button grid can answer) means
 *   the surface falls back to Reply, whose typed text becomes the answer.
 * - `'message'` — a plain chat notification or a `patch_notify` call.
 *   `quickReplies` (≤2) renders as extra buttons alongside Reply, each
 *   sending its own text as the user's reply when tapped.
 */
export const NotifyActionsKind = z.enum(['permission', 'question', 'message']);
export type NotifyActionsKind = z.infer<typeof NotifyActionsKind>;

export const NotifyActions = z
  .object({
    kind: NotifyActionsKind,
    /** Required for 'permission' and 'question'. */
    requestId: z.string().min(1).optional(),
    /** Required for 'question' — the key the answer is returned under. */
    questionText: z.string().min(1).optional(),
    /** 'question' only, ≤3 — Android's/iOS's practical action-button limit. */
    options: z.array(z.string().min(1)).max(3).optional(),
    /** 'message' only, ≤2 (spec/06 § `patch_notify`). */
    quickReplies: z.array(z.string().min(1)).max(2).optional(),
  })
  .strict();
export type NotifyActions = z.infer<typeof NotifyActions>;

export const NotifyEvent = z
  .object({
    type: z.literal('notify'),
    chatId: z.string().min(1),
    /**
     * Where it went. Absent means the agent did not pick and the server routes
     * it — desktop when he is at a computer, phone when he is not. Which surface
     * a message reaches is a fact about where the user is, and the server is the
     * only thing that knows it.
     */
    channel: NotifyChannel.optional(),
    message: z.string(),
    priority: NotifyPriority.optional(),
    // Only meaningful for channel='speakers' per spec/09.
    deviceId: z.string().min(1).optional(),
    /** Defaults to 'message' when omitted. 'call' = part of a patch_call ring. */
    kind: NotifyKind.optional(),
    /** When kind='call', the active callId so surfaces can correlate. */
    callId: z.string().min(1).optional(),
    /**
     * External-app URI (custom scheme or https) a `push` tap should open
     * instead of the source chat — only acted on by channel='push' per
     * spec/09 § `### push`. Carried through on every channel so the chat
     * transcript's tool-call record can render the same link.
     */
    deepLink: z.string().min(1).max(2048).optional(),
    /**
     * Notification actions (spec/09 § Notification actions). Absent means the
     * baseline Reply-only case, which is also what an older host that never
     * sends it reads as — a surface that does not understand this field still
     * shows a sensible notification with no inline actions at all.
     */
    actions: NotifyActions.optional(),
  })
  .strict();
export type NotifyEvent = z.infer<typeof NotifyEvent>;

// ---------------------------------------------------------------------------
// patch.call — host → server → fanout to phone+desktop, first-accept-wins.

/**
 * Daemon-emitted: an agent in `chatId` invoked patch_call. Server fans out as
 * concurrent push (urgent) + desktop notify and starts a 30s timeout.
 */
export const PatchCallEvent = z
  .object({
    type: z.literal('patch.call'),
    /** The chat the user will be voice-connected to on accept. */
    chatId: z.string().min(1),
    /** Optional reason text — pre-call message; falls through as the push body on timeout. */
    message: z.string().optional(),
  })
  .strict();
export type PatchCallEvent = z.infer<typeof PatchCallEvent>;

/** Server → all surfaces: ring on this surface. */
export const ChatCallRequestEvent = z
  .object({
    type: z.literal('chat.call_request'),
    callId: z.string().min(1),
    chatId: z.string().min(1),
    message: z.string().optional(),
  })
  .strict();
export type ChatCallRequestEvent = z.infer<typeof ChatCallRequestEvent>;

/**
 * Server → ringer surfaces: speak this aloud, don't ring (spec/09 § Reaching
 * the user, under `auto-notify`). The surface opens a short session that holds
 * no microphone, takes transient audio focus so a podcast pauses, plays the
 * synthesised message, and releases. Nothing is accepted and nothing is
 * answered — there is no response event for this.
 */
export const ChatSpeakEvent = z
  .object({
    type: z.literal('chat.speak'),
    callId: z.string().min(1),
    chatId: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();
export type ChatSpeakEvent = z.infer<typeof ChatSpeakEvent>;

/** Surface → server: user accepted or declined. */
export const ChatCallResponseEvent = z
  .object({
    type: z.literal('chat.call_response'),
    callId: z.string().min(1),
    response: z.enum(['accept', 'decline']),
  })
  .strict();
export type ChatCallResponseEvent = z.infer<typeof ChatCallResponseEvent>;

/** Server → all surfaces: someone accepted; everyone else stops ringing. */
export const ChatCallWinnerEvent = z
  .object({
    type: z.literal('chat.call_winner'),
    callId: z.string().min(1),
    /** Which surface accepted — others stop ringing. The accepting surface opens voice. */
    acceptedSurfaceId: z.string().min(1),
  })
  .strict();
export type ChatCallWinnerEvent = z.infer<typeof ChatCallWinnerEvent>;

/** Server → all surfaces: 30s elapsed with no accept; surfaces stop ringing. */
export const ChatCallTimeoutEvent = z
  .object({
    type: z.literal('chat.call_timeout'),
    callId: z.string().min(1),
  })
  .strict();
export type ChatCallTimeoutEvent = z.infer<typeof ChatCallTimeoutEvent>;

// ---------------------------------------------------------------------------
// DEV/TEST diagnostic events (server → host). Mounted ONLY off-production
// behind the dev-diag gate; a production host never receives these because
// the server never emits them. They let the G5 voice e2e checks drive paths
// that the mock STT/TTS stack + auto-approve SDK can't otherwise produce.

/**
 * Server → host: synthesise a `chat.permission_request` for `chatId` so the
 * mid-voice permission banner (tap + spoken yes/no) is exercisable against the
 * dev stack, where tools are auto-approved and a real prompt never surfaces
 * (spec/07 ## Permission prompts during voice). Handled by
 * `Daemon.injectPermissionRequest`.
 */
export const PatchDiagInjectPermissionEvent = z
  .object({
    type: z.literal('patch.diag.inject_permission'),
    chatId: z.string().min(1),
    tool: z.string().min(1),
    description: z.string().min(1),
  })
  .strict();
export type PatchDiagInjectPermissionEvent = z.infer<typeof PatchDiagInjectPermissionEvent>;

/**
 * Server → host: inject a transcribed utterance straight into the open voice
 * session for `surfaceId`, exactly as the host's Whisper path would on
 * end-of-utterance. Routes to the session's CURRENT focus chat (proving
 * focus-follow re-routing), drives a real SDK turn whose reply streams back as
 * Kokoro TTS (so barge-in has audio to interrupt), and — when the focused chat
 * is `awaiting-permission` — is parsed as a spoken yes/no permission answer.
 * Handled via `AudioServerHandle.injectUtterance`.
 */
export const PatchDiagVoiceInjectEvent = z
  .object({
    type: z.literal('patch.diag.voice_inject'),
    surfaceId: z.string().min(1),
    text: z.string().min(1),
  })
  .strict();
export type PatchDiagVoiceInjectEvent = z.infer<typeof PatchDiagVoiceInjectEvent>;

// ---------------------------------------------------------------------------
// Control events

export const HelloEvent = z
  .object({
    type: z.literal('hello'),
    clientType: ClientType,
    clientVersion: z.string().min(1),
    /**
     * Short git sha + build instant of the connecting client, recorded into
     * presence so `GET /api/version` can report what every device is ACTUALLY
     * running — the phone included — rather than only what the box has
     * published. Optional because an already-installed older client (or a test
     * client) won't send them; absent means "this build predates check-in", not
     * "assume it's current".
     */
    clientGitSha: z.string().min(1).optional(),
    clientBuiltAt: z.string().min(1).optional(),
    // EdDSA-JWT bearer (or, during pairing, omitted — see auth events below).
    // Pairing handshakes use a separate `pairing.nonce` flow before having a JWT.
    auth: z.string().min(1).optional(),
  })
  .strict();
export type HelloEvent = z.infer<typeof HelloEvent>;

export const AckEvent = z
  .object({
    type: z.literal('ack'),
    // Per-chat ack: server tells host "I have everything up to seq for chatId."
    chatId: z.string().min(1).optional(),
    seq: z.number().int().nonnegative(),
  })
  .strict();
export type AckEvent = z.infer<typeof AckEvent>;

export const ChatReplayEvent = z
  .object({
    type: z.literal('chat.replay'),
    chatId: z.string().min(1),
    // Spec uses both `sinceSequence` (12-error-and-offline) and `fromSeq`
    // (task brief). Canonicalise on `fromSeq`: the host emits all events with
    // seq > fromSeq (exclusive — `fromSeq` is the last seq the caller already
    // has). A fresh surface that has seen nothing passes `-1` to receive the
    // full history including seq 0; `0` would skip the very first event.
    fromSeq: z.number().int().gte(-1),
    /**
     * Replay a specific branch's own track (spec/04 § Branching — "Replay …
     * can be requested per branch, so a surface can show several tracks side
     * by side"). Absent means the chat's active branch — today's behaviour,
     * unchanged.
     */
    branchId: z.string().min(1).optional(),
    /**
     * Server-internal routing tag; surfaces never set this. The server
     * stamps it when forwarding `chat.replay` upstream so the host
     * can route the replayed events back to the requesting surface only
     * (per spec/04: replay is per-surface, not fanout). Surface-side codecs
     * should never read this field.
     */
    forSurfaceId: z.string().min(1).optional(),
    /**
     * This surface can take the whole answer as `chat.replay_batch` frames
     * rather than one frame per event (spec/12 § Sequence-based replay).
     *
     * OPT-IN, by the surface, deliberately. A host updates on its own
     * schedule and a phone can be running an APK from weeks ago; a host
     * that just started batching at a surface which does not know the event
     * would leave that chat looking empty. Asking for it is proof the asker
     * understands the answer.
     */
    batch: z.boolean().optional(),
  })
  .strict();
export type ChatReplayEvent = z.infer<typeof ChatReplayEvent>;

/**
 * A slice of a replay, as ONE frame carrying many events (spec/12 §
 * Sequence-based replay). Sent only to a surface that asked for it with
 * `chat.replay { batch: true }`.
 *
 * Why this exists: a 2,000-event chat was 2,000 separate WebSocket frames
 * crossing host -> server -> surface, each parsed, validated and applied on
 * its own, and drawn as it arrived. That trickle IS the "it loads them in and
 * then scrolls through the messages one by one" — measured at 1-2.5s of a
 * chat's open, against ~0.15s of actual rendering work.
 *
 * Chunked by serialised size rather than sent as one frame, so a huge chat
 * cannot build one enormous string on either end; `done` marks the last
 * chunk, so a surface knows when the transcript is whole. Events inside are
 * validated like any other, so batching costs the server no safety — it is
 * the same work it already did, minus 1,999 frames of overhead.
 */
export const ChatReplayBatchEvent = z
  .object({
    type: z.literal('chat.replay_batch'),
    chatId: z.string().min(1),
    /**
     * In seq order, exactly the events an unbatched replay would have sent.
     *
     * Typed shallowly (an object carrying a `type`) rather than as the full
     * `WireEvent` union, which cannot reference itself from inside one of its
     * own members. The events are not re-validated here, and that is sound
     * for one specific reason: every one of them was validated against
     * `LogRecord` when the host WROTE it, and a replay reads them straight
     * back off that log. This frame carries nothing that did not already pass
     * the schema once. Anything arriving on the LIVE path is unaffected and
     * still decoded individually.
     */
    events: z.array(z.object({ type: z.string().min(1) }).passthrough()),
    /** True on the final chunk of this replay. */
    done: z.boolean(),
    ...forSurfaceIdField,
  })
  .strict();
export type ChatReplayBatchEvent = z.infer<typeof ChatReplayBatchEvent>;

/** Chunk ceiling for a batched replay, in serialised bytes. */
export const REPLAY_BATCH_BYTES = 512 * 1024;

// ---------------------------------------------------------------------------
// Auth events (per spec/10-auth.md)
//
// Wire only owns the *event shapes*. Crypto + business logic land in group 3
// task B. The QR-pairing flow uses these three events end-to-end:
//
//   1. New (unlinked) surface displays QR carrying a pairing nonce; the
//      server emits `pairing.nonce` over the surface's WS to confirm the
//      nonce was registered.
//   2. An already-linked surface, after scanning + approving, emits
//      `pairing.signed_credential` to the server which relays to the new
//      surface; the new surface persists the credential locally.
//   3. Revocation: server emits `auth.revoked` to the affected client just
//      before tearing down the WS.

export const PairingNonceEvent = z
  .object({
    type: z.literal('pairing.nonce'),
    nonce: z.string().min(1),
    // Public key of the *new* surface that wants to be linked. The signing
    // surface uses this to address the credential.
    surfacePublicKey: z.string().min(1),
    expiresAt: z.number().int(),
  })
  .strict();
export type PairingNonceEvent = z.infer<typeof PairingNonceEvent>;

export const PairingSignedCredentialEvent = z
  .object({
    type: z.literal('pairing.signed_credential'),
    nonce: z.string().min(1),
    // Target (new) surface the credential is for. Server relays only to
    // the WS waiting on this nonce.
    surfacePublicKey: z.string().min(1),
    // EdDSA-JWT credential signed by the master key.
    credential: z.string().min(1),
  })
  .strict();
export type PairingSignedCredentialEvent = z.infer<typeof PairingSignedCredentialEvent>;

export const AuthRevokedEvent = z
  .object({
    type: z.literal('auth.revoked'),
    reason: z.string(),
  })
  .strict();
export type AuthRevokedEvent = z.infer<typeof AuthRevokedEvent>;

// `auth.expired` — the surface's credential was signed by the master key and is
// otherwise valid, but its `exp` is in the past. Unlike `auth.revoked` (a
// destructive "wipe credential + re-pair" signal), this is transient: the
// surface should refresh / re-mint rather than discard its pairing. The server
// still closes the WS (4401) after emitting it.
export const AuthExpiredEvent = z
  .object({
    type: z.literal('auth.expired'),
    reason: z.string(),
  })
  .strict();
export type AuthExpiredEvent = z.infer<typeof AuthExpiredEvent>;

/**
 * One registered host as the server knows it at greeting time: its presence,
 * plus the server's CACHED last `daemon.host` / `daemon.account` reports.
 *
 * `host` and `accounts` are null/empty for a host that has never connected
 * since the server started — the server caches what a host told it, and has
 * nothing to say about a machine that has not spoken. A surface renders such a
 * host as offline-and-unknown rather than inventing a description for it.
 */
export const AuthOkHost = z
  .object({
    ...daemonIdField,
    online: z.boolean(),
    /** ms-epoch of the last time this host's link was seen; null if never. */
    lastSeenAt: z.number().int().nullable(),
    /** The cached `daemon.host` payload, minus its envelope. */
    host: DaemonHostEvent.omit({ type: true }).nullable(),
    /** The cached per-backend `daemon.account` payloads, minus their envelopes. */
    accounts: z.array(DaemonAccountEvent.omit({ type: true })),
  })
  .strict();
export type AuthOkHost = z.infer<typeof AuthOkHost>;

export const AuthOkEvent = z
  .object({
    type: z.literal('auth.ok'),
    accountId: z.string().min(1),
    surfaceId: z.string().min(1),
    /**
     * EVERY registered host, not just the connected ones. A surface must be
     * able to render the full Hosts list — including the machines that are
     * asleep — from the greeting alone, without a second round trip and
     * without waiting for a `daemon.online` that may never come.
     */
    hosts: z.array(AuthOkHost),
    /**
     * The content hash of the web bundle this server is serving (e.g.
     * `assets/index-<hash>.js`), so a surface can live-reload when a deploy
     * changed it (spec/14 § Live updates). Absent when no SPA is mounted.
     */
    webBundleHash: z.string().optional(),
  })
  .strict();
export type AuthOkEvent = z.infer<typeof AuthOkEvent>;

/**
 * Every surface-originated frame that names a machine (spec/03 § Host events).
 *
 * The contract's rule is "every host-scoped control a surface changes has a
 * surface-originated frame carrying `daemonId`, no exceptions" — this is that
 * list, made enumerable so the server can gate the whole set at one ingress
 * instead of one `if` per route. A new host-addressed surface frame that is not
 * added here is ungated, which is the failure this list exists to prevent.
 *
 * Ordered as the spec table is: spawn, the host.* control set, then the
 * per-host RPCs.
 */
export const HOST_ADDRESSED_SURFACE_EVENTS = [
  'chat.spawn_request',
  'patch.spawn',
  'host.rename',
  'host.set_home',
  'host.settings',
  'host.component_install',
  'host.component_remove',
  'host.update',
  'host.folder_add',
  'host.folder_remove',
  'host.claude_memory_delete',
  'host.claude_settings_discard',
  'host.claude_memory_set',
  'host.backend_add_account',
  'host.backend_usage_refresh',
  'patch.models.request',
  'patch.recurrence.translate.request',
  'patch.terminal.open',
  'patch.folders.browse.request',
  'patch.host_files.request',
] as const satisfies readonly WireEventType[];

export type HostAddressedSurfaceEventType = (typeof HOST_ADDRESSED_SURFACE_EVENTS)[number];

const HOST_ADDRESSED_SURFACE_EVENT_SET: ReadonlySet<string> = new Set(
  HOST_ADDRESSED_SURFACE_EVENTS,
);

/** Does this frame type carry a `daemonId` a surface chose? */
export function isHostAddressedSurfaceEvent(type: string): type is HostAddressedSurfaceEventType {
  return HOST_ADDRESSED_SURFACE_EVENT_SET.has(type);
}

// ---------------------------------------------------------------------------
// Discriminated union

export const WireEvent = z.discriminatedUnion('type', [
  // Session
  ChatSpawnedEvent,
  ChatMessageEvent,
  ChatInputAckEvent,
  ChatMessageDeltaEvent,
  ChatToolCallEvent,
  ChatToolResultEvent,
  ChatProviderContextEvent,
  ChatPermissionRequestEvent,
  ChatPermissionExpiryUpdateEvent,
  ChatArtifactEvent,
  ChatToolRunSummaryEvent,
  ChatStateEvent,
  ChatStoppedEvent,
  ChatDelegateUpdateEvent,
  ChatQueuedEvent,
  ChatDequeuedEvent,
  ChatBranchesEvent,
  ChatErrorEvent,
  DaemonOnlineEvent,
  DaemonOfflineEvent,
  DaemonUnauthenticatedEvent,
  DaemonHostEvent,
  DaemonAccountEvent,
  DeviceSessionEvent,
  FoldersListEvent,
  FoldersUpdatedEvent,
  ClaudeSettingsListEvent,
  ClaudeSettingsUpdatedEvent,
  // Composer drafts (spec/14 § Composer — server-owned)
  ComposerDraftSetEvent,
  ComposerDraftClearEvent,
  ComposerDraftUpdatedEvent,
  ComposerDraftClearedEvent,
  ComposerDraftListEvent,
  NewChatDraftSetEvent,
  NewChatDraftRemoveEvent,
  NewChatDraftUpdatedEvent,
  NewChatDraftRemovedEvent,
  NewChatDraftListEvent,
  // Host controls (spec/03 § Host events)
  HostRenameEvent,
  HostSetHomeEvent,
  HostRemovedEvent,
  HostSettingsEvent,
  HostComponentInstallEvent,
  HostComponentRemoveEvent,
  HostComponentProgressEvent,
  HostUpdateEvent,
  HostFolderAddEvent,
  HostFolderRemoveEvent,
  HostClaudeMemoryDeleteEvent,
  SettingsSnapshotEvent,
  SettingsAppliedEvent,
  SettingsChangedEvent,
  NotificationsChangedEvent,
  SettingsSecretUpdateEvent,
  SettingsAdoptRequestEvent,
  SettingsAdoptResponseEvent,
  SettingsAccountSignedInEvent,
  HostClaudeSettingsDiscardEvent,
  HostClaudeMemorySetEvent,
  HostBackendAddAccountEvent,
  HostBackendUsageRefreshEvent,
  // Surface
  ChatInputEvent,
  ChatSettingsEvent,
  ChatPermissionResponseEvent,
  ChatSpawnRequestEvent,
  ChatStopRequestEvent,
  ChatUnqueueRequestEvent,
  ChatResumeNowRequestEvent,
  ChatPromoteRequestEvent,
  ChatEditQueuedRequestEvent,
  ChatForkRequestEvent,
  ChatSideRequestEvent,
  ChatBranchSwitchRequestEvent,
  ChatBranchRenameRequestEvent,
  ChatSendBackRequestEvent,
  ChatResumeRequestEvent,
  ChatFocusChangeEvent,
  ChatPinRequestEvent,
  MeetingControlRequestEvent,
  MeetingGetRequestEvent,
  MeetingAudioEvent,
  MeetingActionRequestEvent,
  MeetingStateEvent,
  ChatArchiveRequestEvent,
  ChatDisableRequestEvent,
  ChatRotateRequestEvent,
  ManagerSweepRunEvent,
  ManagerSweepResultEvent,
  ChatSnoozeRequestEvent,
  ChatHideRequestEvent,
  ChatDeleteRequestEvent,
  ChatGoalRequestEvent,
  ChatTodosRequestEvent,
  ChatRenameRequestEvent,
  ChatReminderRequestEvent,
  ChatLoopRequestEvent,
  ChatModelRequestEvent,
  FileWriteEvent,
  PatchFileChangedEvent,
  SurfaceHeartbeatEvent,
  SurfaceHeartbeatAckEvent,
  SurfaceForegroundedEvent,
  SurfaceInputEvent,
  SurfaceBackgroundedEvent,
  // Cross-chat
  PatchPeekRequestEvent,
  PatchPeekResponseEvent,
  PatchSendToEvent,
  PatchSendToResponseEvent,
  PatchSpawnEvent,
  PatchSpawnResponseEvent,
  PatchHistoryRequestEvent,
  PatchHistoryResponseEvent,
  PatchListChatsRequestEvent,
  PatchListChatsResponseEvent,
  PatchActivityRequestEvent,
  PatchActivityResponseEvent,
  PatchActivityReadRequestEvent,
  PatchActivityReadResponseEvent,
  PatchStopEvent,
  PatchJobCreateEvent,
  PatchJobUpdateEvent,
  PatchJobDeleteEvent,
  PatchJobToggleEvent,
  PatchJobsRequestEvent,
  PatchJobsResponseEvent,
  PatchFilesRequestEvent,
  PatchFilesResponseEvent,
  PatchFileOpRequestEvent,
  PatchFileOpResponseEvent,
  PatchDocRequestEvent,
  PatchDocResponseEvent,
  PatchDocActionRequestEvent,
  PatchDocActionResponseEvent,
  PatchDocConvertRequestEvent,
  PatchDocConvertResponseEvent,
  PatchDocExportRequestEvent,
  PatchDocExportResponseEvent,
  PatchBackgroundTaskStatsRequestEvent,
  PatchBackgroundTaskStatsResponseEvent,
  PatchWatchListRequestEvent,
  PatchWatchListResponseEvent,
  PatchWatchStopRequestEvent,
  PatchWatchStopResponseEvent,
  ServerQueueModeEvent,
  PatchLogSyncRequestEvent,
  PatchLogSyncBatchEvent,
  PatchLogRestoreEvent,
  ChatCommittedEvent,
  HostManagerAdoptEvent,
  HostManagerReleaseEvent,
  PatchQueuePullRequestEvent,
  PatchQueuePullResponseEvent,
  PatchChatHistoryRequestEvent,
  PatchChatHistoryResponseEvent,
  PatchSkillsRequestEvent,
  PatchSkillsResponseEvent,
  PatchModelsRequestEvent,
  PatchModelsResponseEvent,
  PatchRecurrenceTranslateRequestEvent,
  PatchRecurrenceTranslateResponseEvent,
  PatchFoldersBrowseRequestEvent,
  PatchFoldersBrowseResponseEvent,
  PatchHostFilesRequestEvent,
  PatchHostFilesResponseEvent,
  PatchBlobRequestEvent,
  PatchBlobResponseEvent,
  ChatReplayBatchEvent,
  PatchChatMoveRequestEvent,
  PatchChatMoveResponseEvent,
  PatchChatSearchRequestEvent,
  PatchChatSearchResponseEvent,
  // Terminal sessions
  PatchTerminalOpenEvent,
  PatchTerminalInputEvent,
  PatchTerminalSignalEvent,
  PatchTerminalCloseEvent,
  PatchTerminalResizeEvent,
  PatchTerminalReadyEvent,
  PatchTerminalOutputEvent,
  PatchTerminalCommandExitEvent,
  PatchTerminalExitEvent,
  PatchTerminalErrorEvent,
  // Browser tunnel
  PatchBrowserTunnelOpenEvent,
  PatchBrowserTunnelReadyEvent,
  PatchBrowserTunnelDataEvent,
  PatchBrowserTunnelCloseEvent,
  PatchBrowserTunnelErrorEvent,
  // Audio relay over the host link
  PatchAudioRelayOpenEvent,
  PatchAudioRelayReadyEvent,
  PatchAudioRelayFrameEvent,
  PatchAudioRelayCloseEvent,
  PatchAudioRelayErrorEvent,
  // Script jobs
  JobExecRequestEvent,
  JobExecResultEvent,
  // Message hooks
  HookCheckRequestEvent,
  HookCheckResultEvent,
  HookAgentResponseCheckRequestEvent,
  HookAgentResponseOutcomeEvent,
  // Voice-note clip transcription
  PatchVoiceNoteTranscribeRequestEvent,
  PatchVoiceNoteTranscribeResponseEvent,
  // Composer attachment store
  PatchAttachmentStoreRequestEvent,
  PatchAttachmentStoreResponseEvent,
  // Artifacts
  PatchArtifactPublishRequestEvent,
  PatchArtifactPublishResponseEvent,
  // Pads
  PatchPadRequestEvent,
  PatchPadResponseEvent,
  // Secrets
  SecretsListEvent,
  SecretsUpdatedEvent,
  PatchSecretsSetRequestEvent,
  PatchSecretsDeleteRequestEvent,
  PatchSecretsResponseEvent,
  // Notifications
  NotifyEvent,
  PatchCallEvent,
  ChatCallRequestEvent,
  ChatSpeakEvent,
  ChatCallResponseEvent,
  ChatCallWinnerEvent,
  ChatCallTimeoutEvent,
  // Dev/test diagnostic (server → host)
  PatchDiagInjectPermissionEvent,
  PatchDiagVoiceInjectEvent,
  // Control
  HelloEvent,
  AckEvent,
  ChatReplayEvent,
  // Auth
  PairingNonceEvent,
  PairingSignedCredentialEvent,
  AuthRevokedEvent,
  AuthExpiredEvent,
  AuthOkEvent,
]);
export type WireEvent = z.infer<typeof WireEvent>;

export type WireEventType = WireEvent['type'];

// Lookup table — useful for tests and for consumers wanting to validate
// a single event type without re-running the whole union.
export const EVENT_SCHEMAS = {
  'chat.spawned': ChatSpawnedEvent,
  'chat.message': ChatMessageEvent,
  'chat.input_ack': ChatInputAckEvent,
  'chat.message_delta': ChatMessageDeltaEvent,
  'chat.tool_call': ChatToolCallEvent,
  'chat.tool_result': ChatToolResultEvent,
  'chat.provider_context': ChatProviderContextEvent,
  'chat.permission_request': ChatPermissionRequestEvent,
  'chat.permission_expiry_update': ChatPermissionExpiryUpdateEvent,
  'chat.artifact': ChatArtifactEvent,
  'chat.tool_run_summary': ChatToolRunSummaryEvent,
  'chat.state': ChatStateEvent,
  'chat.stopped': ChatStoppedEvent,
  'chat.delegate_update': ChatDelegateUpdateEvent,
  'chat.queued': ChatQueuedEvent,
  'chat.dequeued': ChatDequeuedEvent,
  'chat.branches': ChatBranchesEvent,
  'chat.error': ChatErrorEvent,
  'daemon.online': DaemonOnlineEvent,
  'daemon.offline': DaemonOfflineEvent,
  'daemon.unauthenticated': DaemonUnauthenticatedEvent,
  'daemon.host': DaemonHostEvent,
  'daemon.account': DaemonAccountEvent,
  'device.session': DeviceSessionEvent,
  'folders.list': FoldersListEvent,
  'folders.updated': FoldersUpdatedEvent,
  'claude_settings.list': ClaudeSettingsListEvent,
  'claude_settings.updated': ClaudeSettingsUpdatedEvent,
  'composer_draft.set': ComposerDraftSetEvent,
  'composer_draft.clear': ComposerDraftClearEvent,
  'composer_draft.updated': ComposerDraftUpdatedEvent,
  'composer_draft.cleared': ComposerDraftClearedEvent,
  'composer_draft.list': ComposerDraftListEvent,
  'new_chat_draft.set': NewChatDraftSetEvent,
  'new_chat_draft.remove': NewChatDraftRemoveEvent,
  'new_chat_draft.updated': NewChatDraftUpdatedEvent,
  'new_chat_draft.removed': NewChatDraftRemovedEvent,
  'new_chat_draft.list': NewChatDraftListEvent,
  'host.rename': HostRenameEvent,
  'host.set_home': HostSetHomeEvent,
  'host.removed': HostRemovedEvent,
  'host.settings': HostSettingsEvent,
  'host.component_install': HostComponentInstallEvent,
  'host.component_remove': HostComponentRemoveEvent,
  'host.component_progress': HostComponentProgressEvent,
  'host.update': HostUpdateEvent,
  'host.folder_add': HostFolderAddEvent,
  'host.folder_remove': HostFolderRemoveEvent,
  'host.claude_memory_delete': HostClaudeMemoryDeleteEvent,
  'settings.snapshot': SettingsSnapshotEvent,
  'settings.applied': SettingsAppliedEvent,
  'settings.changed': SettingsChangedEvent,
  'notifications.changed': NotificationsChangedEvent,
  'settings.secret_update': SettingsSecretUpdateEvent,
  'settings.adopt.request': SettingsAdoptRequestEvent,
  'settings.adopt.response': SettingsAdoptResponseEvent,
  'settings.account_signed_in': SettingsAccountSignedInEvent,
  'host.claude_settings_discard': HostClaudeSettingsDiscardEvent,
  'host.claude_memory_set': HostClaudeMemorySetEvent,
  'host.backend_add_account': HostBackendAddAccountEvent,
  'host.backend_usage_refresh': HostBackendUsageRefreshEvent,
  'chat.input': ChatInputEvent,
  'chat.settings': ChatSettingsEvent,
  'chat.permission_response': ChatPermissionResponseEvent,
  'chat.spawn_request': ChatSpawnRequestEvent,
  'chat.stop_request': ChatStopRequestEvent,
  'chat.unqueue_request': ChatUnqueueRequestEvent,
  'chat.resume_now_request': ChatResumeNowRequestEvent,
  'chat.promote_request': ChatPromoteRequestEvent,
  'chat.edit_queued_request': ChatEditQueuedRequestEvent,
  'chat.fork_request': ChatForkRequestEvent,
  'chat.side_request': ChatSideRequestEvent,
  'chat.branch_switch_request': ChatBranchSwitchRequestEvent,
  'chat.branch_rename_request': ChatBranchRenameRequestEvent,
  'chat.send_back_request': ChatSendBackRequestEvent,
  'chat.resume_request': ChatResumeRequestEvent,
  'chat.focus_change': ChatFocusChangeEvent,
  'chat.pin_request': ChatPinRequestEvent,
  'meeting.control_request': MeetingControlRequestEvent,
  'meeting.get_request': MeetingGetRequestEvent,
  'meeting.audio': MeetingAudioEvent,
  'meeting.action_request': MeetingActionRequestEvent,
  'meeting.state': MeetingStateEvent,
  'chat.archive_request': ChatArchiveRequestEvent,
  'chat.disable_request': ChatDisableRequestEvent,
  'chat.rotate_request': ChatRotateRequestEvent,
  'manager.sweep_run': ManagerSweepRunEvent,
  'manager.sweep_result': ManagerSweepResultEvent,
  'chat.snooze_request': ChatSnoozeRequestEvent,
  'chat.hide_request': ChatHideRequestEvent,
  'chat.delete_request': ChatDeleteRequestEvent,
  'chat.goal_request': ChatGoalRequestEvent,
  'chat.todos_request': ChatTodosRequestEvent,
  'chat.rename_request': ChatRenameRequestEvent,
  'chat.reminder_request': ChatReminderRequestEvent,
  'chat.loop_request': ChatLoopRequestEvent,
  'chat.model_request': ChatModelRequestEvent,
  'file.write': FileWriteEvent,
  'patch.file_changed': PatchFileChangedEvent,
  'surface.heartbeat': SurfaceHeartbeatEvent,
  'surface.heartbeat_ack': SurfaceHeartbeatAckEvent,
  'surface.foregrounded': SurfaceForegroundedEvent,
  'surface.input': SurfaceInputEvent,
  'surface.backgrounded': SurfaceBackgroundedEvent,
  'patch.peek.request': PatchPeekRequestEvent,
  'patch.peek.response': PatchPeekResponseEvent,
  'patch.send_to': PatchSendToEvent,
  'patch.send_to.response': PatchSendToResponseEvent,
  'patch.spawn': PatchSpawnEvent,
  'patch.spawn.response': PatchSpawnResponseEvent,
  'patch.history.request': PatchHistoryRequestEvent,
  'patch.history.response': PatchHistoryResponseEvent,
  'patch.list_chats.request': PatchListChatsRequestEvent,
  'patch.list_chats.response': PatchListChatsResponseEvent,
  'patch.activity.request': PatchActivityRequestEvent,
  'patch.activity.response': PatchActivityResponseEvent,
  'patch.activity.read.request': PatchActivityReadRequestEvent,
  'patch.activity.read.response': PatchActivityReadResponseEvent,
  'patch.stop': PatchStopEvent,
  'patch.job_create': PatchJobCreateEvent,
  'patch.job_update': PatchJobUpdateEvent,
  'patch.job_delete': PatchJobDeleteEvent,
  'patch.job_toggle': PatchJobToggleEvent,
  'patch.jobs.request': PatchJobsRequestEvent,
  'patch.jobs.response': PatchJobsResponseEvent,
  'patch.files.request': PatchFilesRequestEvent,
  'patch.files.response': PatchFilesResponseEvent,
  'patch.file_op.request': PatchFileOpRequestEvent,
  'patch.file_op.response': PatchFileOpResponseEvent,
  'patch.doc.request': PatchDocRequestEvent,
  'patch.doc.response': PatchDocResponseEvent,
  'patch.doc_action.request': PatchDocActionRequestEvent,
  'patch.doc_action.response': PatchDocActionResponseEvent,
  'patch.doc_convert.request': PatchDocConvertRequestEvent,
  'patch.doc_convert.response': PatchDocConvertResponseEvent,
  'patch.doc_export.request': PatchDocExportRequestEvent,
  'patch.doc_export.response': PatchDocExportResponseEvent,
  'patch.background_task_stats.request': PatchBackgroundTaskStatsRequestEvent,
  'patch.background_task_stats.response': PatchBackgroundTaskStatsResponseEvent,
  'patch.watch_list.request': PatchWatchListRequestEvent,
  'patch.watch_list.response': PatchWatchListResponseEvent,
  'patch.watch_stop.request': PatchWatchStopRequestEvent,
  'patch.watch_stop.response': PatchWatchStopResponseEvent,
  'server.queue_mode': ServerQueueModeEvent,
  'patch.log_sync.request': PatchLogSyncRequestEvent,
  'patch.log_sync.batch': PatchLogSyncBatchEvent,
  'patch.log_restore': PatchLogRestoreEvent,
  'chat.committed': ChatCommittedEvent,
  'host.manager_adopt': HostManagerAdoptEvent,
  'host.manager_release': HostManagerReleaseEvent,
  'patch.queue_pull.request': PatchQueuePullRequestEvent,
  'patch.queue_pull.response': PatchQueuePullResponseEvent,
  'patch.chat_history.request': PatchChatHistoryRequestEvent,
  'patch.chat_history.response': PatchChatHistoryResponseEvent,
  'patch.skills.request': PatchSkillsRequestEvent,
  'patch.skills.response': PatchSkillsResponseEvent,
  'patch.models.request': PatchModelsRequestEvent,
  'patch.models.response': PatchModelsResponseEvent,
  'patch.recurrence.translate.request': PatchRecurrenceTranslateRequestEvent,
  'patch.recurrence.translate.response': PatchRecurrenceTranslateResponseEvent,
  'patch.folders.browse.request': PatchFoldersBrowseRequestEvent,
  'patch.folders.browse.response': PatchFoldersBrowseResponseEvent,
  'patch.host_files.request': PatchHostFilesRequestEvent,
  'patch.host_files.response': PatchHostFilesResponseEvent,
  'patch.blob.request': PatchBlobRequestEvent,
  'patch.blob.response': PatchBlobResponseEvent,
  'chat.replay_batch': ChatReplayBatchEvent,
  'patch.chat_move.request': PatchChatMoveRequestEvent,
  'patch.chat_move.response': PatchChatMoveResponseEvent,
  'patch.chat_search.request': PatchChatSearchRequestEvent,
  'patch.chat_search.response': PatchChatSearchResponseEvent,
  'patch.terminal.open': PatchTerminalOpenEvent,
  'patch.terminal.input': PatchTerminalInputEvent,
  'patch.terminal.signal': PatchTerminalSignalEvent,
  'patch.terminal.close': PatchTerminalCloseEvent,
  'patch.terminal.resize': PatchTerminalResizeEvent,
  'patch.terminal.ready': PatchTerminalReadyEvent,
  'patch.terminal.output': PatchTerminalOutputEvent,
  'patch.terminal.command-exit': PatchTerminalCommandExitEvent,
  'patch.terminal.exit': PatchTerminalExitEvent,
  'patch.terminal.error': PatchTerminalErrorEvent,
  'patch.browser_tunnel.open': PatchBrowserTunnelOpenEvent,
  'patch.browser_tunnel.ready': PatchBrowserTunnelReadyEvent,
  'patch.browser_tunnel.data': PatchBrowserTunnelDataEvent,
  'patch.browser_tunnel.close': PatchBrowserTunnelCloseEvent,
  'patch.browser_tunnel.error': PatchBrowserTunnelErrorEvent,
  'patch.audio_relay.open': PatchAudioRelayOpenEvent,
  'patch.audio_relay.ready': PatchAudioRelayReadyEvent,
  'patch.audio_relay.frame': PatchAudioRelayFrameEvent,
  'patch.audio_relay.close': PatchAudioRelayCloseEvent,
  'patch.audio_relay.error': PatchAudioRelayErrorEvent,
  'job.exec_request': JobExecRequestEvent,
  'job.exec_result': JobExecResultEvent,
  'hook.check_request': HookCheckRequestEvent,
  'hook.check_result': HookCheckResultEvent,
  'hook.agent_response_check_request': HookAgentResponseCheckRequestEvent,
  'hook.agent_response_outcome': HookAgentResponseOutcomeEvent,
  'patch.voice_note.transcribe_request': PatchVoiceNoteTranscribeRequestEvent,
  'patch.voice_note.transcribe_response': PatchVoiceNoteTranscribeResponseEvent,
  'patch.attachment.store_request': PatchAttachmentStoreRequestEvent,
  'patch.attachment.store_response': PatchAttachmentStoreResponseEvent,
  'patch.artifact.publish_request': PatchArtifactPublishRequestEvent,
  'patch.artifact.publish_response': PatchArtifactPublishResponseEvent,
  'patch.pad.request': PatchPadRequestEvent,
  'patch.pad.response': PatchPadResponseEvent,
  'secrets.list': SecretsListEvent,
  'secrets.updated': SecretsUpdatedEvent,
  'patch.secrets.set_request': PatchSecretsSetRequestEvent,
  'patch.secrets.delete_request': PatchSecretsDeleteRequestEvent,
  'patch.secrets.response': PatchSecretsResponseEvent,
  notify: NotifyEvent,
  'patch.call': PatchCallEvent,
  'chat.call_request': ChatCallRequestEvent,
  'chat.speak': ChatSpeakEvent,
  'chat.call_response': ChatCallResponseEvent,
  'chat.call_winner': ChatCallWinnerEvent,
  'chat.call_timeout': ChatCallTimeoutEvent,
  'patch.diag.inject_permission': PatchDiagInjectPermissionEvent,
  'patch.diag.voice_inject': PatchDiagVoiceInjectEvent,
  hello: HelloEvent,
  ack: AckEvent,
  'chat.replay': ChatReplayEvent,
  'pairing.nonce': PairingNonceEvent,
  'pairing.signed_credential': PairingSignedCredentialEvent,
  'auth.revoked': AuthRevokedEvent,
  'auth.expired': AuthExpiredEvent,
  'auth.ok': AuthOkEvent,
} as const satisfies Record<WireEventType, z.ZodTypeAny>;
