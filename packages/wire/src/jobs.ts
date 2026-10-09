// Canonical Job + JobsInterface types.
//
// Per group 10 BLOCKER B.8: server (canonical owner of /data/jobs/*.json)
// and host (cross-chat tools relay) share these schemas. The host's
// `RemoteJobsStore` implements JobsInterface by sending `patch.jobs.request`
// events upstream over the daemon-link and awaiting the matching
// `patch.jobs.response` (see `./events.ts`).

import { z } from 'zod';
import { isValidTimeZone } from './cron-tz.js';
import { PermissionMode } from './events.js';
import { DEFAULT_JOB_AUTONOMY_PROMPT } from './job-autonomy-prompt.js';

/**
 * An IANA zone name (`Europe/London`, `UTC`, …). Validated against the
 * runtime's own ICU database, so a typo is refused at write time on every
 * surface rather than silently demoted to UTC (NO FALLBACK).
 */
export const IanaTimeZone = z
  .string()
  .min(1)
  .refine(isValidTimeZone, (tz) => ({ message: `invalid IANA timezone: "${tz}"` }));

export const CronTrigger = z
  .object({
    type: z.literal('cron'),
    /** Standard 5-field cron, evaluated in `timezone`. */
    expression: z.string().min(1),
    /**
     * IANA zone the expression is evaluated in (spec/08 § Cron). The
     * expression is stored EXACTLY as authored and node-cron is handed the
     * zone, so DST is handled for us: `0 9 * * *` in `Europe/London` is 09:00
     * local in both GMT and BST.
     *
     * OPTIONAL, and omitted means UTC — three reasons it can never become
     * required:
     *   1. Every job stored before this field existed has a UTC expression.
     *      Absent === UTC keeps them firing at exactly the same instant.
     *   2. `CronTrigger` is `.strict()` and travels the daemon-link. A host
     *      OTAs its host on a different cadence to the server, so a host
     *      on an older `@patch/wire` has a `CronTrigger` with no `timezone`
     *      key at all — posting one to that host's `/internal/jobs` is a
     *      loud 400 `invalid_input` from its own bundled schema. An agent on
     *      such a host must still be able to create a cron job.
     *   3. `patch.jobs.response.result` is `z.unknown()`, so READING a job
     *      that carries a timezone is safe on any host; only the write path
     *      is version-sensitive.
     */
    timezone: IanaTimeZone.optional(),
  })
  .strict();
export type CronTrigger = z.infer<typeof CronTrigger>;

export const WebhookScheme = z.enum(['none', 'hmac-sha256', 'github', 'stripe', 'todoist']);
export type WebhookScheme = z.infer<typeof WebhookScheme>;

export const WebhookTrigger = z
  .object({
    type: z.literal('webhook'),
    scheme: WebhookScheme,
    /** Shared secret. Required for all schemes other than `none`. */
    secret: z.string().min(1).optional(),
    /** Cosmetic label only — URL secrecy comes from the unguessable jobId. */
    path: z.string().optional(),
  })
  .strict();
export type WebhookTrigger = z.infer<typeof WebhookTrigger>;

/**
 * A general recurring schedule expressed as an RFC 5545 RRULE (spec/08 §
 * Recurrence) — cron can only say "these exact clock fields, every day",
 * which has no way to express "every 3rd Sunday, May through August" or any
 * other nth-weekday / date-range pattern. RRULE is the same recurrence-rule
 * standard iCal uses, and the `rrule` npm package (server-side only —
 * `packages/server/src/jobs/recurrence.ts`) already knows how to enumerate
 * it, so this trigger stores the rule text rather than inventing a second
 * rules engine.
 *
 * `rrule` is the bare RRULE value string (e.g.
 * `FREQ=MONTHLY;BYDAY=SU;BYSETPOS=3;BYMONTH=5,6,7,8;BYHOUR=9;BYMINUTE=0`) —
 * no leading `RRULE:` label and no `DTSTART` line. `DTSTART` is deliberately
 * NOT part of this trigger: the schedule's clock time lives in the rule
 * itself (`BYHOUR`/`BYMINUTE`), and its start-of-enumeration anchor is a
 * runtime concern of the scheduler, not stored state — the two triggers that
 * do carry stored clock state (`CronTrigger.expression`, `CronTrigger.timezone`)
 * both stay exactly as authored for the same reason: nothing here should have
 * to be rewritten as time passes.
 *
 * `timezone` is REQUIRED, unlike `CronTrigger.timezone` (optional, absent ⇒
 * UTC) — this is a NEW trigger type with no pre-existing jobs to keep
 * byte-identical, so there is no back-compatibility reason to allow an
 * implicit UTC default here. Every recurrence job names its zone explicitly,
 * the same DST-tracking reason cron's zone exists at all: `BYHOUR=9` in
 * `Europe/London` must mean 9am local through a DST transition, not 9am UTC.
 */
export const RecurrenceTrigger = z
  .object({
    type: z.literal('recurrence'),
    rrule: z.string().min(1),
    timezone: IanaTimeZone,
  })
  .strict();
export type RecurrenceTrigger = z.infer<typeof RecurrenceTrigger>;

export const TodoistTrigger = z
  .object({
    type: z.literal('todoist'),
    /**
     * Todoist-native task filter (spec/08 ## Todoist example: `filter` lives
     * ON the trigger). This is a Todoist query string (e.g.
     * "labels contains 'agent'"), distinct from the job-level JSONata `filter`.
     * Used to scope which Todoist tasks the integration considers.
     */
    filter: z.string().min(1).optional(),
    /**
     * Reference to a stored Todoist credential — no plaintext token here.
     * Spec/08 writes this as `auth: "token-ref"`; `auth` is accepted as an
     * alias on input and normalised to `authRef`.
     */
    authRef: z.string().min(1).optional(),
    auth: z.string().min(1).optional(),
    /** Webhook client secret for HMAC verification. */
    clientSecret: z.string().min(1).optional(),
  })
  .strict();
export type TodoistTrigger = z.infer<typeof TodoistTrigger>;

export const JobTrigger = z.discriminatedUnion('type', [
  CronTrigger,
  WebhookTrigger,
  TodoistTrigger,
  RecurrenceTrigger,
]);
export type JobTrigger = z.infer<typeof JobTrigger>;

/**
 * The model the action's chat runs on (spec/08 § Action), from the catalogue of
 * the host the action NAMES — which is why only the folder-addressed actions
 * carry it. `message` has no host of its own; it inherits host, folder and model
 * from the chat it delivers into, so a model there would have nothing to
 * resolve against and is refused by `.strict()`.
 *
 * Optional, and its absence is a real setting rather than a missing one: an
 * action storing no model leaves each fire to take that host's last-used model,
 * so the job tracks the machine instead of pinning a value that will eventually
 * be retired. Both states must survive a round-trip through the editor.
 *
 * Shared between the two actions rather than written twice so they cannot drift
 * — as is `startHidden` (`jobActionStartHiddenField`), which both folder-carrying actions
 * carry for the same reason: each of them CREATES the chat it places.
 */
const jobActionModelField = { model: z.string().min(1).optional() };

/**
 * The stored account the action's chat starts its turns on (spec/08 § Action,
 * spec/10 § Backend credentials — preferred account). A preference, not a pin:
 * a spent account is walked past like any other. Fixed when the chat is
 * created, like `model`, so on `continue` it reaches the NEXT chat the job
 * creates. Omitted, the host's strategy alone decides.
 */
const jobActionAccountField = { preferredAccountId: z.string().min(1).optional() };

/**
 * Keep this job's chat out of the inbox — it is spawned into Hidden, running
 * but drawn only in the sidebar's Hidden section (spec/04 § Hidden, spec/08 ##
 * Action). Omitted/false — the default — means a job's chat lands in
 * the sidebar exactly like one the user started, so a run that stops on a
 * QUESTION is visible and answerable without hunting through `▸ Automations`.
 * Set it for a job whose chats are pure background noise.
 *
 * On `spawn` that is every fire (every fire makes a chat). On `ensure` it is
 * every fire that CREATES a chat — the job-wide chat unkeyed, a subject's chat
 * when `key` is set — so a later edit reaches the NEXT chat the job creates
 * rather than the ones it already owns, exactly as `model` does. A keyed
 * `ensure` is the case that needs it most: one chat per subject is one inbox row
 * per subject. `message` has no `startHidden`, having no chat of its own to
 * place.
 *
 * Lives on the ACTION, not the job: `patch_job_create`/`patch_job_update`
 * forward `action` as an opaque blob (host `mcp.ts`), so an agent on a
 * not-yet-OTA'd host can still set it. A new top-level `Job` field could
 * not reach the server from those tools until the host shipped.
 *
 * OPTIONAL, and every writer must OMIT it rather than write `false`: both
 * actions are `.strict()` and a host OTAs separately from the server,
 * so a job that nobody has ticked the box on must serialise byte-identically to
 * how it did before this field existed.
 */
const jobActionStartHiddenField = { startHidden: z.boolean().optional() };

/**
 * Set the chat's goal (spec/04 § Goals) the moment this fire creates it — the
 * same condition text `/goal <condition>` would set, so the chat's evaluator
 * starts judging it from the first turn. Optional and additive, same
 * back-compat shape as `startHidden`/`notifyOnComplete`: an untouched job
 * never writes this key.
 *
 * Unlike the composer's `/goal`, setting it here does NOT also send the
 * condition as the chat's first turn — the action's own `prompt`/`skill`
 * already does that, and the two need not be the same text (a job can brief
 * the agent one way and hold it to a differently-worded stopping condition).
 */
const jobActionGoalField = { goal: z.string().min(1).optional() };

/**
 * Ring the completion doorbell when this job's chat settles (spec/09 § Chat
 * completion, spec/08 ## Action). A fire's turn is a `user` turn — the job
 * dispatched it on the user's behalf, not the host for itself — so a job's
 * chat already notifies on every fire, and this is how a job whose fires are
 * not worth a push each stops doing that.
 *
 * DEFAULT-ON, which inverts the encoding `startHidden` uses: ABSENT MEANS
 * NOTIFY, and only an explicit `false` suppresses. That is what lets every job
 * written before this field existed keep the behaviour it already had with no
 * migration and no rewrite of stored job JSON — a `.strict()` action plus a
 * host that OTAs separately from the server means an untouched job must
 * serialise byte-identically to how it did before. So every writer OMITS the
 * field rather than writing `true`, exactly as `startHidden` omits rather
 * than writing `false`; the editor writes the key only when the user turns the
 * option OFF.
 *
 * `true` is nonetheless ACCEPTED on read — an agent calling `patch_job_create`
 * will reasonably spell the default out, and refusing the whole job over a
 * redundant key that says what the default already says would be hostile. It
 * means the same as absent. Only `false` changes anything.
 *
 * Read SERVER-SIDE and nowhere else: the server holds the chatId -> jobId link
 * and the job store, so it gates the notification itself when the chat settles.
 * Nothing about this field reaches the host, so no host needs to OTA for it.
 *
 * On the ACTION, not the job, for the same reason as `startHidden`:
 * `patch_job_create`/`patch_job_update` forward `action` as an opaque blob
 * (host `mcp.ts`), so an agent on a not-yet-OTA'd host can still set it.
 * Carried by the two actions that CREATE a chat; `message` delivers into a chat
 * the user already owns and already hears from, and has no such flag.
 */
const jobActionNotifyOnCompleteField = { notifyOnComplete: z.boolean().optional() };

/**
 * Whether a `todoist`/`webhook` fire's event JSON is appended after the prompt
 * (spec/08 § Action). Default ON: absent and `true` mean the same, only `false`
 * changes anything, so the editors write the key only when it is unticked.
 *
 * Read SERVER-SIDE only, when it renders the first user turn; nothing about it
 * reaches the host. On all three user-turn actions (a `script` has no prompt).
 */
const jobActionIncludePayloadField = { includePayload: z.boolean().optional() };

/**
 * A folder-carrying action names the HOST it runs on (spec/08 § Action: the
 * action is dispatched to the host it names). The folder alone is ambiguous
 * once there is more than one machine — the same path on two hosts is two
 * different directories — so the host travels with it.
 */
export const SpawnAction = z
  .object({
    type: z.literal('spawn'),
    daemonId: z.string().min(1),
    folder: z.string().min(1),
    prompt: z.string().optional(),
    skill: z.string().optional(),
    ...jobActionStartHiddenField,
    ...jobActionNotifyOnCompleteField,
    ...jobActionIncludePayloadField,
    ...jobActionGoalField,
    /**
     * The permission mode this fire's chat runs under, applied as that chat's
     * per-chat override (spec/08 § Action, spec/02 § Permission mode).
     *
     * OPTIONAL here but never absent on the wire: omitted, the dispatcher sends
     * `'auto'` rather than leaving the field off. A job's mode is the job's
     * business, not the host's — a host whose default is a blocking mode (set
     * by whoever is sitting at that machine) would otherwise stall every
     * unattended job that lands on it, with nobody watching the archived chat
     * it stalled in. The schema keeps it optional so a job written before this
     * field existed still parses, and so an editor can express "unset".
     *
     * Spawn-only — unlike `startHidden`, which both folder-carrying actions carry: a
     * `message` action inherits everything from the chat it delivers into, and
     * an `ensure` action's chat is a durable one the user can set an override
     * on directly.
     *
     * Reuses `permissionMode` as it already exists on `chat.spawn_request` —
     * no new daemon-bound field, so a host on an older host accepts the
     * frame unchanged.
     */
    permissionMode: PermissionMode.optional(),
    ...jobActionModelField,
    ...jobActionAccountField,
  })
  .strict();
export type SpawnAction = z.infer<typeof SpawnAction>;

export const MessageAction = z
  .object({
    type: z.literal('message'),
    chatId: z.string().min(1),
    prompt: z.string().optional(),
    skill: z.string().optional(),
    ...jobActionIncludePayloadField,
  })
  .strict();
export type MessageAction = z.infer<typeof MessageAction>;

/**
 * Upsert action — "message a persistent chat, creating it on the first fire."
 * Like `spawn` it carries a `folder` (where the chat is created), but unlike
 * `spawn` (a fresh chat every fire) it targets ONE durable chat derived
 * deterministically from the job id: the first fire spawns it, every later fire
 * delivers into the SAME chat so context accumulates. Lets a recurring job own
 * a long-running chat without the user pre-creating one. See spec/08 ## Action.
 */
export const ContinueAction = z
  .object({
    type: z.literal('continue'),
    daemonId: z.string().min(1),
    folder: z.string().min(1),
    prompt: z.string().optional(),
    skill: z.string().optional(),
    // Applies to the fire that CREATES the durable chat: a chat's model is
    // fixed for its life, so a later edit reaches the next chat this job
    // creates, not the one it already owns (spec/08 § Action).
    ...jobActionModelField,
    // Same creation-time rule as the model.
    ...jobActionAccountField,
    // Same creation-time rule, and the same field the `spawn` action carries —
    // an `ensure` chat is placed once, when it is created. A KEYED ensure is
    // what makes this worth having: it creates a chat per subject, so without
    // it a per-task job is a per-task inbox row (spec/08 ## Action).
    ...jobActionStartHiddenField,
    // Same rule and same encoding as on `spawn` — absent means notify. A
    // `continue` job is the one that needs it most: a keyed action is a chat
    // per subject, so an unsilenced high-volume job is a push per subject.
    ...jobActionNotifyOnCompleteField,
    // Read per fire, not at creation: it shapes each turn's text.
    ...jobActionIncludePayloadField,
    // Same creation-time rule as `startHidden`/`permissionMode` — set once,
    // when a KEYED `continue` creates a new subject's chat.
    ...jobActionGoalField,
    /**
     * Mustache template naming the SUBJECT this fire is about, turning the
     * job's one durable chat into one durable chat PER SUBJECT (spec/08 ##
     * Action). Omitted — the default — keeps the original behaviour: a single
     * chat for the whole job.
     *
     * The motivating case is a Todoist project firing on `item:added` AND
     * `item:updated`. With `key: "{{payload.event_data.id}}"` an edit to a task
     * lands in the chat already working on that task, while a different task
     * opens its own. Unkeyed, every task would pile into one chat; as a
     * `spawn`, an edit would start a second build of the same task.
     *
     * Lives on the ACTION for the same reason as `startHidden`: `patch_job_create` /
     * `patch_job_update` forward `action` as an opaque blob, so an agent on a
     * not-yet-OTA'd host can still set it.
     *
     * NO FALLBACK: a key that renders empty — a payload without that field, as
     * a manual run has — is REFUSED, never quietly collapsed onto the unkeyed
     * chat. Collapsing would merge unrelated subjects into one chat, which is
     * the exact failure keying exists to prevent.
     */
    key: z.string().min(1).optional(),
  })
  .strict();
export type ContinueAction = z.infer<typeof ContinueAction>;

/**
 * The names these fields and actions used to have, accepted on READ.
 *
 * `ensure` was this action's original name — borrowed from infra-as-code, where
 * it describes the MECHANISM (upsert) rather than what the fire does. `hidden`
 * was renamed to `startArchived` for the same reason, and `startArchived` to
 * `startHidden` on 2026-09-28, when archived came to mean stopped (spec/04 §
 * Lifecycle) and a run kept out of the inbox got a state of its own. Both old
 * names meant "keep this job's runs out of the inbox", which is `startHidden`.
 *
 * Accepted for ever, not for a deprecation window: this is a rename, and no
 * version of this codebase should reject a job file a previous one wrote. The
 * actions are `.strict()`, so a stored `hidden` is not merely ignored — it fails
 * the whole action, and with it the job. Nothing EMITS either old name, because
 * every writer is renamed, so this only ever runs on pre-rename data.
 */
function acceptLegacyActionNames(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const v = value as Record<string, unknown>;
  let next = v;
  if (next['type'] === 'ensure') next = { ...next, type: 'continue' };
  if ('hidden' in next) {
    const { hidden, ...rest } = next;
    next = { ...rest, startHidden: hidden };
  }
  if ('startArchived' in next) {
    const { startArchived, ...rest } = next;
    next = { ...rest, startHidden: startArchived };
  }
  return next === v ? value : next;
}

/**
 * Run a COMMAND on a host, with no chat and no model — the cheap tick.
 *
 * `spawn`, `message` and `continue` all cost an agent turn, so a job that mostly
 * finds nothing to do (poll an API, notice a file, check a queue) burns tokens
 * on every fire to discover that. A `script` action fires a shell command in a
 * folder on the host it names and records its exit code and output tail on the
 * job's runs — nothing else. Where the command DOES find work, it starts a chat
 * itself through the CLI (`patch chats spawn`), so the expensive path runs only
 * when there is something to run it on.
 *
 * It carries no `prompt`/`skill` for the same reason: there is no first user
 * turn, because there is no chat. The `JobAction` refinement below therefore
 * exempts it, and it is the ONLY action that is exempt.
 *
 * The command runs through the host's shell, as the host's user, in `folder`.
 * `timeoutMs` (default 60s, hard ceiling 10 min) kills it and records the run
 * as failed — a hung command must not wedge the job's concurrency slot.
 *
 * `command` IS THE SCRIPT, not a path to one. A multi-line body is handed to
 * `bash -lc` verbatim, so a whole gate lives here rather than in a file on the
 * host — which is the point: a gate kept in a file outside Patch is a decision
 * nobody can read or change from the app that runs it. Every surface renders
 * this field as a code editor for that reason.
 *
 * ITS STDOUT IS ITS DECISION LOG. A gate that spends nothing most fires looks
 * identical on every one of them — `ok`, exit 0, over and over — so a gate that
 * has silently stopped working is indistinguishable from one correctly holding.
 * The contract that fixes that, and which every gate must keep:
 *
 *   - print a verdict on EVERY fire, including the ones that do nothing, and
 *     print it LAST (`scriptVerdictLine` shows it in the run row);
 *   - announce any chat you start with `patch:chat <chatId>`
 *     (`SCRIPT_CHAT_MARKER`), so the fire that spent money links to what it
 *     bought;
 *   - exit non-zero only for a FAULT — a gate that held on purpose succeeded.
 */
export const ScriptAction = z
  .object({
    type: z.literal('script'),
    daemonId: z.string().min(1),
    folder: z.string().min(1),
    command: z.string().min(1),
    timeoutMs: z.number().int().min(1000).max(600_000).optional(),
  })
  .strict();
export type ScriptAction = z.infer<typeof ScriptAction>;

/** What a `script` fire is given when the job names no timeout. */
export const SCRIPT_ACTION_DEFAULT_TIMEOUT_MS = 60_000;

/** Output kept from a script fire, per stream. Enough to diagnose, not a log sink. */
export const SCRIPT_ACTION_OUTPUT_LIMIT = 4000;

/**
 * A gate's chat announcement. A `script` job that decides there IS work starts
 * the chat itself (`patch chats spawn`), so the server never sees a
 * `chat.spawned` for it and the run log has no `chatId` to link — the expensive
 * half of the job is invisible from the job's own history. Printing
 *
 *     patch:chat <chatId>
 *
 * on stdout is how the command says which chat it started; the server lifts it
 * onto the run entry (`action.chatId`) so the row links straight into it.
 *
 * ONE LINE, anywhere in stdout, and the LAST one wins — a command that spawns
 * twice in a fire reports the chat a reader most likely wants. Unannounced is
 * the normal case for a gate that held, and carries no chat link.
 */
export const SCRIPT_CHAT_MARKER = 'patch:chat';

/**
 * The chat a `script` fire announced, or null. See `SCRIPT_CHAT_MARKER`.
 *
 * NO FALLBACK: only a whole line of exactly `patch:chat <id>` counts. A chat id
 * mentioned in passing inside other output is not an announcement, and a marker
 * with no id is not half an announcement — both yield null rather than a link
 * to a chat that may not exist.
 */
export function parseScriptChatId(output: string): string | null {
  let found: string | null = null;
  for (const raw of output.split('\n')) {
    const m = /^\s*patch:chat[ \t]+(\S+)\s*$/.exec(raw);
    if (m?.[1] !== undefined) found = m[1];
  }
  return found;
}

/**
 * The one line of a `script` fire's output worth putting in a run row: its
 * verdict.
 *
 * A gate's whole job is to decide — spawn, or hold, and why — and that decision
 * is the thing a reader is looking for when they ask "why has nothing
 * happened?". By convention a gate prints its verdict LAST, so the last
 * non-empty line is the headline and the rest stays behind the expander.
 * `patch:chat` lines are machinery, not prose, and are skipped.
 *
 * Returns null for a command that printed nothing — a silent success, which
 * the row shows as the bare status it already showed.
 */
export function scriptVerdictLine(output: string): string | null {
  const lines = output.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = (lines[i] ?? '').trim();
    if (line.length === 0) continue;
    if (line.startsWith(SCRIPT_CHAT_MARKER)) continue;
    return line;
  }
  return null;
}

/**
 * A shell command that decides whether a fire proceeds (spec/08 § Gate).
 *
 * `filter` asks a question of the trigger's PAYLOAD; a gate asks one of the
 * WORLD — is there a new photo, is the coach due, is the mac even awake. Both
 * sit in the same place in the pipeline and do the same job: turn a fire away
 * before it costs an agent turn. So a gate is a sibling of `filter`, not part of
 * the action, and it composes with every action type.
 *
 * It exists because the alternative was a `script` action that decided AND
 * spawned — shelling out to `patch chats spawn`, which meant the script had to
 * carry the model, the prompt, the folder and its own "don't start a second one"
 * check, and the job it created was not the job's own action, so none of the
 * machinery applied to it: no `chat.spawned`, so no chat on the run row; no
 * concurrency slot; no `startHidden`; no `notifyOnComplete`. A gate gives the
 * decision back to the script and the work back to the job.
 *
 * EXIT CODE IS THE VERDICT (`GateVerdict`):
 *
 *   0       run — proceed to the action
 *   1       hold — do not, and say why on stdout
 *   other   a FAULT: the gate broke, and the job's history must say so
 *
 * `grep`'s convention, for the same reason grep uses it: the ordinary "no" is
 * not an error. A killed gate, a gate that cannot start, and a gate that exits
 * 1 without saying why are all faults — see `gateVerdict`.
 *
 * A PASSING GATE'S STDOUT IS ALSO THE ACTION'S INPUT, as `{{gate.stdout}}` and
 * `{{gate.verdict}}` beside the trigger's own `{{payload.…}}` (server
 * `dispatcher.renderView`), and as part of the JSON a skill-only action is
 * handed. The gate is the half of the job that has already looked at the world,
 * so what it found is the agent's briefing rather than something the agent pays
 * to rediscover. Stdout only: stderr is where a gate's accidents go, and a
 * traceback read as a briefing is worse than no briefing.
 */
export const JobGate = z
  .object({
    daemonId: z.string().min(1),
    folder: z.string().min(1),
    command: z.string().min(1),
    timeoutMs: z.number().int().min(1000).max(600_000).optional(),
  })
  .strict();
export type JobGate = z.infer<typeof JobGate>;

/** What a gate decided. */
export type GateVerdict = 'run' | 'hold' | 'fault';

/**
 * Read a gate's verdict from what it did.
 *
 * `exitCode` is null when the command was killed (its timeout) or never
 * started, both of which are faults — the gate did not answer.
 *
 * THE `exit 1` WITH NOTHING TO SAY IS A FAULT, and that is the load-bearing
 * rule here. A deliberate hold always has a reason — that reason is the whole
 * value of the row it writes. But 1 is also the code a half-written gate dies
 * with: `curl` that cannot connect, a failing `[ ]`, a python traceback, almost
 * anything under `set -e`. Treating a bare 1 as a hold is how a gate that broke
 * on Tuesday reads as a quiet week, which is the exact failure this whole
 * mechanism exists to make impossible. Accidents print to stderr or print
 * nothing; deliberate holds print their reason. So saying nothing is the fault.
 *
 * NO FALLBACK in either direction: a gate that cannot be read is never assumed
 * to mean run (that spends money on a broken signal) and never assumed to mean
 * hold (that stops the job silently forever).
 */
export function gateVerdict(exitCode: number | null, stdout: string): GateVerdict {
  if (exitCode === 0) return 'run';
  if (exitCode === 1 && stdout.trim().length > 0) return 'hold';
  return 'fault';
}

/** What a gate is given when the job names no timeout. Gates are meant to be quick. */
export const GATE_DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Reduce a rendered `ensure` key to something safe to embed in a chat id.
 * Returns null when nothing usable survives — the caller must REFUSE the fire
 * rather than fall back to the unkeyed chat (see `ContinueAction.key`).
 */
export function ensureChatKeySlug(key: string): string | null {
  const slug = key
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  return slug.length > 0 ? slug : null;
}

/**
 * Deterministic chat id for an `ensure` action's persistent chat. Derived from
 * the job id so it's stable across fires and restarts — both the server (which
 * keys spawn-vs-message on it) and the web (which links the Schedules row to it)
 * compute the same value. Protocol-level convention, hence it lives in wire.
 *
 * `keySlug` (already through `ensureChatKeySlug`) scopes the chat to one
 * subject within the job; omitted gives the job-wide chat. `generation` is the
 * reset count of an `append` job (see `Queueing`).
 */
export function ensureChatId(jobId: string, keySlug?: string, generation = 0): string {
  const base = keySlug === undefined ? `jobchat-${jobId}` : `jobchat-${jobId}-${keySlug}`;
  // `append` queueing resets by moving to the next generation's chat; the first
  // generation keeps the original id so existing links and chats still match.
  return generation > 0 ? `${base}-g${generation}` : base;
}

// An action must carry AT LEAST ONE of `skill` / `prompt` — neither leaves no
// first user-turn to deliver (the job would fire as a no-op). BOTH is allowed:
// the first turn is then the skill invocation with the prompt as its body
// (`/<skill>\n\n<rendered prompt>`), so a job can run a skill AND hand it custom
// instructions (see dispatcher `renderPrompt`). The discriminated union proves
// the shape (spawn/message/continue); this refinement proves the payload semantic.
// NO FALLBACK — reject the empty case at write time on every surface.
const JobActionShape = z.discriminatedUnion('type', [
  SpawnAction,
  MessageAction,
  ContinueAction,
  ScriptAction,
]);
export const JobAction = z
  .preprocess(acceptLegacyActionNames, JobActionShape)
  .superRefine((action, ctx) => {
    // A `script` fire delivers no user turn — it runs a command (see ScriptAction).
    if (action.type === 'script') return;
    const hasSkill = typeof action.skill === 'string' && action.skill.length > 0;
    const hasPrompt = typeof action.prompt === 'string' && action.prompt.length > 0;
    if (!hasSkill && !hasPrompt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'action must carry a skill, a prompt, or both',
        path: ['skill'],
      });
    }
  });
export type JobAction = z.infer<typeof JobAction>;

/**
 * The hours a job is allowed to START a fire (spec/08 § Run window). A fire
 * that arrives outside it is held and released when the window next opens —
 * "arrives late at night, runs in the morning". `start` is inclusive, `end`
 * exclusive, both wall-clock `HH:MM` in `timezone`; `end` earlier than `start`
 * wraps midnight (22:00–06:00). The zone is required, as for a recurrence: a
 * window with no stated zone would mean the server's.
 */
const WindowTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM (24-hour)');
export const RunWindow = z
  .object({ start: WindowTime, end: WindowTime, timezone: IanaTimeZone })
  .strict()
  .refine((w) => w.start !== w.end, {
    message: 'window start and end are the same time — that is either never or always',
    path: ['end'],
  });
export type RunWindow = z.infer<typeof RunWindow>;

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

/** Is `nowMs` inside the window, by the wall clock in the window's zone? */
export function inRunWindow(window: RunWindow, nowMs: number): boolean {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: window.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(nowMs));
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value);
  const now = get('hour') * 60 + get('minute');
  const start = minutesOf(window.start);
  const end = minutesOf(window.end);
  return start < end ? now >= start && now < end : now >= start || now < end;
}

/** A concurrency limit is a count of simultaneous fires — at least one. */
export const Concurrency = z.number().int().min(1);

/**
 * How a job's fires relate to one another (spec/08 § Queueing). Three modes:
 *
 *  - `parallel` — every fire runs at once. The default when `queueing` is
 *    absent; stating it is how a job says it means it.
 *  - `queue` — fires wait their turn, `concurrency` (default 1) at a time.
 *    With a `key` (a mustache template naming the fire's subject) the limit
 *    applies per subject instead of to the job as a whole, so two tasks run
 *    side by side but two fires for the same task run one after the other.
 *  - `append` — fires are delivered into one durable chat (a `continue`
 *    action) so context accumulates, which starts afresh when the chat has
 *    been idle for `idleTimeoutMs`, has lived for `resetAfterMs`, or has been
 *    sent `resetAfterMessages` fires. Every limit is optional; none means the
 *    chat is never reset.
 *
 * Mutually exclusive with the older bare `concurrency`, which is exactly
 * `{ mode: 'queue', concurrency }` without a key.
 */
export const Queueing = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('parallel') }).strict(),
  z
    .object({
      mode: z.literal('queue'),
      concurrency: Concurrency.optional(),
      key: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      mode: z.literal('append'),
      idleTimeoutMs: z.number().int().min(1).optional(),
      resetAfterMs: z.number().int().min(1).optional(),
      resetAfterMessages: z.number().int().min(1).optional(),
    })
    .strict(),
]);
export type Queueing = z.infer<typeof Queueing>;

export const Job = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    enabled: z.boolean(),
    trigger: JobTrigger,
    /** JSONata expression. Null/empty → always pass. */
    filter: z.string().nullable(),
    /**
     * A shell command that decides whether each fire proceeds (`JobGate`).
     * Null/absent → every fire that passed `filter` runs its action.
     *
     * Beside `filter` rather than inside `action` because it is the same KIND of
     * thing — a precondition on the fire — and because it must compose with all
     * four action types. Being top-level does make it version-sensitive on the
     * write path, exactly as `CronTrigger.timezone` is: `patch_job_create` and
     * `patch_job_update` name their fields explicitly (only `action` is an
     * opaque blob), so an agent on a host older than this field cannot SET a
     * gate. Reading one is safe everywhere — `patch.jobs.response.result` is
     * `z.unknown()` — and the web and phone write to the server's REST directly,
     * so neither is affected.
     */
    gate: JobGate.nullable().optional(),
    action: JobAction,
    /**
     * Max fires this job may have in flight at once (spec/08 § Concurrency).
     * Omitted → no limit, every fire dispatches on arrival. Set to 1 for a job
     * that must serialise its own fires, which is what a high-volume trigger
     * (a Todoist project taking a batch of tasks) needs so one subscription
     * cannot start everything at once.
     */
    concurrency: Concurrency.optional(),
    /** Hours fires may start in; outside them a fire is held (`RunWindow`). */
    window: RunWindow.optional(),
    /** Parallel / queue / append (`Queueing`). Not combinable with `concurrency`. */
    queueing: Queueing.optional(),
    /**
     * This job does its thing once and then retires itself (spec/08
     * § One-off jobs). The first of its fires to settle `ok` leaves the job
     * disabled with `expiredAt` stamped. Omitted/false — the default — is an
     * ordinary recurring automation that fires for as long as it is enabled.
     */
    oneOff: z.boolean().optional(),
    /**
     * When the server retired this one-off job (epoch ms). PRESENCE is what
     * "expired" means — there is no second flag that could fall out of step
     * with it.
     *
     * Server-established: stamped when a fire settles `ok`, and deliberately
     * absent from `JobCreateBody`/`JobPatchBody`, whose `.strict()` therefore
     * REFUSES a client that sends one rather than silently dropping it.
     *
     * An expired job is always a disabled one: any write setting
     * `enabled: true` clears this, re-arming the job for one more fire.
     */
    expiredAt: z.number().int().optional(),
    /**
     * The user has put this job away (spec/08 § Archived jobs): it does not
     * fire, and the web list folds it into its own section.
     *
     * OPTIONAL, and absent means not archived — the `CronTrigger.timezone`
     * shape, and for the same reasons: `Job` is `.strict()`, every job stored
     * before this field existed has no such key, and a job travels the
     * daemon-link to hosts whose `@patch/wire` OTAs on their own clock.
     *
     * Orthogonal to `enabled` and never written together with it, so
     * un-archiving restores the job exactly as it was rather than guessing
     * whether it should now run.
     */
    archived: z.boolean().optional(),
    /**
     * Free-text label the user puts on a job to organise it in the web list
     * (spec/08 § Groups): "Home", "Finance", "Watchers". Purely organisational
     * — never read by any trigger, gate or action, and never compared
     * case-insensitively or trimmed server-side, so two jobs group together
     * only when their `group` strings are byte-identical.
     *
     * OPTIONAL, and absent means ungrouped — the same shape `archived` and
     * `CronTrigger.timezone` take, and for the same reason: `Job` is
     * `.strict()` and every job stored before this field existed has no such
     * key.
     */
    group: z.string().optional(),
    /**
     * This job's own override of the account-wide autonomy prompt (spec/08 §
     * Autonomy prompt). Every job runs unattended, so every fire carries
     * one; there is no "none" — hence OPTIONAL means "use the account's
     * `jobAutonomyPrompt` setting", not "use nothing": `jobAutonomyPrompt`
     * is the one place that reads this field.
     *
     * OPTIONAL, and absent means the account setting — the same shape `group` and
     * `archived` take, and for the same reason: `Job` is `.strict()` and
     * every job stored before this field existed has no such key, so an
     * untouched job must keep reading as "default" rather than gain a
     * stored copy of text the account setting might later change.
     */
    autonomyPrompt: z.string().min(1).optional(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
  })
  .strict();
export type Job = z.infer<typeof Job>;

export { DEFAULT_JOB_AUTONOMY_PROMPT };

/**
 * The text actually used to preface this job's first user-turn: the job's own
 * override, or the account-wide `jobAutonomyPrompt` setting the caller passes
 * in (spec/08 § Autonomy prompt). The one place `autonomyPrompt` is read.
 */
export function jobAutonomyPrompt(job: Pick<Job, 'autonomyPrompt'>, accountPrompt: string): string {
  return job.autonomyPrompt ?? accountPrompt;
}

/**
 * Why a job does not fire, or null when it does. The SINGLE definition of that
 * question (spec/08 § Archived jobs), consumed by every trigger ingress — cron
 * registration and the webhook / Todoist routes — so a second way to be
 * inert cannot be honoured by one of them and forgotten by the rest.
 *
 * Archived outranks disabled as the reported reason: it is a deliberate act,
 * where a disabled archived job is merely how it was left before being put
 * away.
 */
export function jobInertReason(
  job: Pick<Job, 'enabled'> & Partial<Pick<Job, 'archived'>>,
): 'archived' | 'disabled' | null {
  if (job.archived === true) return 'archived';
  if (!job.enabled) return 'disabled';
  return null;
}

/** True when this job's triggers are live. The inverse of `jobInertReason`. */
export function jobFires(job: Pick<Job, 'enabled'> & Partial<Pick<Job, 'archived'>>): boolean {
  return jobInertReason(job) === null;
}

/**
 * The outcome recorded for one fire of a job (spec/08 ## Logs). Shared so the
 * run log and the list response cannot drift apart on what an outcome can be.
 */
export const JobRunStatus = z.enum([
  'ok',
  'filter-rejected',
  'filter-error',
  'dispatch-error',
  'buffered',
  'queued',
  'slot-timeout',
  'chat-error',
  'gate-held',
  'gate-error',
]);
export type JobRunStatus = z.infer<typeof JobRunStatus>;

/**
 * A job as the SERVER hands it out. `inFlight`/`queued` are the concurrency
 * gate's live counts (spec/08 ## Concurrency), attached on the way out of
 * `GET /api/jobs` and `GET /api/jobs/:id` and present only when the server has
 * a dispatcher to read them from. They are runtime state and are NEVER part of
 * a written job — hence they live here rather than on `Job`, and are absent
 * from `JobCreateBody`/`JobPatchBody`, whose `.strict()` refuses them coming
 * back. Still strict itself: an unknown key is a real disagreement and fails.
 */
export const JobWithCounts = Job.extend({
  inFlight: z.number().int().nonnegative().optional(),
  queued: z.number().int().nonnegative().optional(),
}).strict();
export type JobWithCounts = z.infer<typeof JobWithCounts>;

/**
 * A job's most recent fire, as reported on the LIST response. Runtime state
 * read off the job's run log, not part of the stored job — the timestamp the
 * list draws its last-fired cell from, the outcome, and the chat the fire
 * landed in, which is what a `spawn` job's row links to.
 */
export const JobLatestRun = z
  .object({
    ts: z.number(),
    status: JobRunStatus,
    /** Present only once a fire actually landed in a chat. */
    chatId: z.string().optional(),
  })
  .strict();
export type JobLatestRun = z.infer<typeof JobLatestRun>;

/**
 * A row of `GET /api/jobs`. The list carries each job's latest run so the page
 * draws a last-fired per row from the one request, rather than every row
 * fetching its own history. Absent on `GET /api/jobs/:id`, which the editors
 * parse as `JobWithCounts`.
 */
export const JobListEntry = JobWithCounts.extend({
  latestRun: JobLatestRun.nullable().optional(),
}).strict();
export type JobListEntry = z.infer<typeof JobListEntry>;

export const JobCreateBody = z
  .object({
    name: z.string().min(1),
    enabled: z.boolean().optional(),
    trigger: JobTrigger,
    filter: z.string().nullable().optional(),
    gate: JobGate.nullable().optional(),
    action: JobAction,
    concurrency: Concurrency.optional(),
    /** `null` is accepted so the editor's one body shape serves create and patch. */
    window: RunWindow.nullable().optional(),
    queueing: Queueing.optional(),
    /** Retire this job after its first successful fire (spec/08 § One-off jobs). */
    oneOff: z.boolean().optional(),
    /** Free-text organisational label (spec/08 § Groups). Settable at birth. */
    group: z.string().optional(),
    /**
     * Custom text prepended to this job's first user-turn, replacing
     * `DEFAULT_JOB_AUTONOMY_PROMPT` (spec/08 § Autonomy prompt). Omitted, or
     * `null`, means the default — accepting `null` here too (though a new
     * job has nothing to clear) keeps the same body shape valid for both
     * `create` and `patch`, since the editor submits one either way.
     */
    autonomyPrompt: z.string().min(1).nullable().optional(),
  })
  .strict();
export type JobCreateBody = z.infer<typeof JobCreateBody>;

export const JobPatchBody = z
  .object({
    name: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
    trigger: JobTrigger.optional(),
    filter: z.string().nullable().optional(),
    /** `null` removes the gate; omitted leaves it as it is. */
    gate: JobGate.nullable().optional(),
    action: JobAction.optional(),
    /** `null` removes the limit; omitted leaves it as it is. */
    concurrency: Concurrency.nullable().optional(),
    /** `null` removes the run window; omitted leaves it as it is. */
    window: RunWindow.nullable().optional(),
    /** `null` removes the queueing mode (back to parallel); omitted leaves it. */
    queueing: Queueing.nullable().optional(),
    /**
     * Make the job one-off, or make an existing one recurring again (spec/08
     * § One-off jobs). Clearing it does NOT un-expire an already-retired job —
     * enabling is what re-arms one.
     */
    oneOff: z.boolean().optional(),
    /**
     * Put the job away, or bring it back (spec/08 § Archived jobs). Absent
     * from `JobCreateBody`, whose `.strict()` therefore refuses it: a job is
     * archived after it exists, never at birth.
     */
    archived: z.boolean().optional(),
    /**
     * Change or clear this job's organisational label (spec/08 § Groups).
     * `''` clears it to ungrouped, same as any other optional string field —
     * there is no separate null-to-clear convention here because `group` has
     * no server-established meaning for `null` to remove.
     */
    group: z.string().optional(),
    /**
     * Set a custom text to prepend to this job's first user-turn, or clear
     * back to `DEFAULT_JOB_AUTONOMY_PROMPT` (spec/08 § Autonomy prompt).
     * `null` is the explicit "back to default" instruction — the `gate` /
     * `concurrency` shape — because the editor's toggle has to be able to
     * say "default" again after a job has carried custom text, and an
     * omitted key here means "leave it as it is", not "clear it".
     */
    autonomyPrompt: z.string().min(1).nullable().optional(),
  })
  .strict();
export type JobPatchBody = z.infer<typeof JobPatchBody>;

/**
 * Canonical interface for managing jobs. Owned by the server, consumed by:
 *   - REST routes (`/api/jobs*`)
 *   - Cron scheduler — re-registers on changes
 *   - Webhook ingress (webhook/todoist)
 *   - Cross-chat MCP tools on the host — host's `patch_job_*` MCP tools
 *     forward to the server over the daemon-link via `patch.jobs.request`.
 *
 * Jobs DATA lives on the SERVER (persisted at `/data/jobs/*.json`); the
 * host is a thin RPC client.
 */
/**
 * Server-side (synchronous) jobs interface. Implemented by JobStore which
 * has an in-memory cache backed by `/data/jobs/*.json`.
 */
export interface JobsInterface {
  list(): Job[];
  get(id: string): Job | null;
  create(body: JobCreateBody): Job;
  patch(id: string, body: JobPatchBody): Job;
  delete(id: string): boolean;
  enable(id: string): Job;
  disable(id: string): Job;
  /**
   * The job as it would be with `body` applied — validated like `patch`, never
   * persisted. Backs a manual run of an unsaved draft (spec/08 § Manual run).
   */
  preview(id: string, body: JobPatchBody): Job;
  /**
   * Retire a one-off job whose fire has just settled `ok` (spec/08 § One-off
   * jobs) — disable it and stamp `expiredAt`. Server-only, which is why it
   * lives here and not on `JobPatchBody`: this is the ONE write path for a
   * field no client may set.
   *
   * Returns the retired job, or null when there was nothing to do — the job is
   * gone, is not `oneOff`, or is already expired. Making the no-op cases a null
   * return rather than a throw is what makes a second settle harmless.
   */
  expireOneOff(id: string, at: number): Job | null;
  /** Subscribe to mutations (cron scheduler hooks here for re-registration). */
  onChange(handler: (event: JobsChangeEvent) => void): () => void;
}

/**
 * Async-tolerant interface, used by the host's `RemoteJobsStore` which
 * proxies every call over the daemon-link to the server. Structurally a
 * superset of `JobsInterface` (all methods may return `Promise<T>`).
 */
export interface AsyncJobsInterface {
  list(): Job[] | Promise<Job[]>;
  get(id: string): Job | null | Promise<Job | null>;
  create(body: JobCreateBody): Job | Promise<Job>;
  patch(id: string, body: JobPatchBody): Job | Promise<Job>;
  delete(id: string): boolean | Promise<boolean>;
  enable(id: string): Job | Promise<Job>;
  disable(id: string): Job | Promise<Job>;
  onChange?(handler: (event: JobsChangeEvent) => void): () => void;
  /** Optional read-only history endpoints. RemoteJobsStore implements them. */
  runs?(id: string, limit?: number): unknown[] | Promise<unknown[]>;
  webhooks?(id: string, limit?: number): unknown[] | Promise<unknown[]>;
}

export type JobsChangeEvent =
  | { type: 'created'; job: Job }
  | { type: 'updated'; job: Job }
  | { type: 'deleted'; id: string };
