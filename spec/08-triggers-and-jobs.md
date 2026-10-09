# Triggers and Jobs

A job is a persistent automation — a trigger, an optional filter and gate, and one action, stored as a JSON file on the server. Jobs fire when something matches: a webhook arrives, a Todoist task lands, or a cron schedule ticks.

Jobs survive sessions, host restarts, and arbitrary time. They're for cross-session automations — the weekly newsletter, the morning bus check, the alert that spawns a fresh chat at 7am. For an in-chat reminder/loop use `patch_wake_me` or `patch_loop` (`02-daemon.md` § Self-wake).

## Disambiguation: `patch_job_*` vs `patch_wake_me`/`patch_loop`

| Situation                                                                                                 | Use                                          |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Re-invoke THIS chat after a delay, re-arming adaptively each time (durable across restarts)               | `patch_wake_me` (`02-daemon.md` § Self-wake) |
| Re-invoke THIS chat on a FIXED interval, forever, without re-arming it yourself (durable across restarts) | `patch_loop` (`02-daemon.md` § Self-wake)    |
| Spawns a new chat, or messages a different chat                                                           | `patch_job_*`                                |
| Recurring wall-clock schedule (cron), indefinite                                                          | `patch_job_*`                                |
| Triggered by an external event (webhook / Todoist)                                                        | `patch_job_*`                                |
| Spawns or messages elsewhere, but only ever once                                                          | `patch_job_*` with `oneOff` (§ One-off jobs) |

> ⚠️ `CronCreate` / `CronList` / `CronDelete` are disallowed in patch (`principles.md` § Tool ownership). The host drives the agent through its backend: each turn's `query()` exits when the turn ends, so an in-session cron would have no resident process to fire it. The host removes them from the model's context via `disallowedTools`. Every in-chat timer is `patch_wake_me` or `patch_loop`; cross-chat / external schedules are `patch_job_*`.

## Job shape

```json
{
  "id": "j_01HXYZ...",
  "name": "github merge alerts",
  "trigger": { ... },                   // exactly one — cron | recurrence | webhook | todoist
  "filter": "...",                      // optional JSONata expression over the payload
  "gate": { ... },                      // optional shell command that decides each fire
  "action": { ... },                    // exactly one — spawn | message | continue | script
  "concurrency": 1,                     // optional — max fires in flight at once
  "queueing": { ... },                  // optional — parallel | queue | append (§ Queueing)
  "oneOff": false,                      // optional — retire after the first successful fire
  "expiredAt": "...",                   // set by the server when a one-off job has retired
  "archived": false,                    // optional — put away: does not fire, folded out of the list
  "group": "Home",                      // optional — free-text organisational label (§ Groups)
  "autonomyPrompt": "...",              // optional — this job's override of the account-wide autonomy prompt (§ Autonomy prompt)
  "enabled": true,
  "createdAt": "...",
  "updatedAt": "..."
}
```

Stored at `/data/jobs/<id>.json` on the server.

## Trigger types

### Cron

```json
{ "type": "cron", "expression": "57 8 * * 1-5", "timezone": "Europe/London" }
```

Standard 5-field cron, stored exactly as authored and evaluated in `timezone` — an IANA zone name. The expression is never rewritten: the zone is applied at every tick, so a job written as "weekdays at 9am" fires at 09:00 local on both sides of a daylight-saving change. A zone the server cannot resolve is rejected at write time.

`timezone` is optional and an absent one means UTC. The job editors on web and mobile default a new cron job to the client's own zone and show the stored zone for an existing one; the CLI defaults to `$TZ` and `--utc` stores no zone.

Cron is agent-generated. The user describes the schedule in natural language ("every weekday morning", "every other Tuesday at 5pm"); the agent turns it into the cron expression at setup time. Server doesn't parse natural language at fire time. The job form's English-to-cron field accepts several exact times sharing one minute ("every day at 9am and 10pm" → `0 9,22 * * *`); times with different minutes cannot be one 5-field cron, so it declines to parse and the raw cron field stays authoritative.

Wherever a schedule is shown to a person — a job list row, a job editor's live preview, on any surface — the expression is rendered as a natural-language label by one shared describer, so the same expression reads identically everywhere: `*/30 7-22 * * *` is "every 30 minutes between 7am and 10pm", `17 7,11,15,19 * * *` is "at 7:17am, 11:17am, 3:17pm and 7:17pm", `0 8 * * 1-5` is "weekdays at 8am". On-the-hour times read "9am" and times with minutes read "8:57am"; a window names its bounds, preferring "midnight" and "noon".

The describer never guesses. A shape it cannot phrase exactly produces no label and the surface shows the raw expression instead, so a reader is never told a schedule the job does not keep: an evenly-spaced minute list is the same instants as the equivalent step and reads as one, but a list of hours names every time it fires rather than rounding to an interval it only covers part of the day with.

Payload to filter/action: `{ firedAt: <ISO timestamp> }`.

### Recurrence

```json
{
  "type": "recurrence",
  "rrule": "FREQ=MONTHLY;BYDAY=SU;BYSETPOS=3;BYMONTH=5,6,7,8;BYHOUR=9;BYMINUTE=0",
  "timezone": "Europe/London"
}
```

An RFC 5545 RRULE, for the schedules cron cannot express. Cron can only say "these exact clock fields, every day" — it has no way to write "every 3rd Sunday, May through August" or any other nth-weekday / date-range pattern, because none of its five fields can mean "the 3rd occurrence" or "restricted to some months but not by exact date." RRULE is the same recurrence-rule standard iCal uses; the server enumerates it with the `rrule` npm package (`packages/server/src/jobs/recurrence.ts`).

`rrule` is the bare RRULE value string — no leading `RRULE:` label and no `DTSTART` line. `DTSTART` is deliberately not part of this trigger: the schedule's clock time lives in the rule itself (`BYHOUR`/`BYMINUTE`), and where enumeration _starts_ is a scheduler runtime concern, not stored state — nothing about a recurrence job should have to be rewritten as time passes.

`timezone` is **required**, unlike cron's optional/UTC-default zone — this is a new trigger type with no pre-existing jobs to keep byte-identical, so there is no back-compatibility reason to allow an implicit UTC default. `BYHOUR=9` in `Europe/London` means 9am local through a DST transition, the same reason cron's zone exists at all.

Unlike cron, which node-cron re-evaluates on its own wall-clock tick, RRULE has no built-in "call me at each occurrence" primitive. The server computes the next occurrence via `RRule.after(now)`, arms a single timer for it, and re-arms — from a fresh "now" — after every fire and immediately on every edit, so a change takes effect right away rather than after a restart. A rule with no future occurrences left (an `UNTIL` in the past, for example) is not silently inert: it is logged loudly, both to the server log and as a `dispatch-error` run-log entry naming the reason, so a job that will never fire again always leaves a trace.

Wherever a recurrence schedule is shown to a person, it is rendered as a natural-language label by one shared describer (`recurrence-describe.ts`), the same contract cron's describer keeps: `FREQ=MONTHLY;BYDAY=SU;BYSETPOS=3;BYMONTH=5,6,7,8;BYHOUR=9;BYMINUTE=0` reads "every 3rd Sunday, May through August at 9am". A shape it cannot phrase exactly — a `COUNT`/`UNTIL` bound, an `INTERVAL` other than 1, `BYMONTHDAY`, more than one weekday alongside `BYSETPOS`, and others — produces no label, and the surface shows the raw RRULE instead. Never a guess: "every 4 weeks" for a rule that actually stops after 6 occurrences is a lie about when it fires.

Payload to filter/action: `{ firedAt: <ISO timestamp> }` — same shape as cron's, for the same reason: a recurrence trigger carries no payload of its own, it just fires on its schedule.

### Webhook

```json
{
  "type": "webhook",
  "path": "github",
  "secret": "<random>",
  "scheme": "github"
}
```

Server exposes `POST /api/webhooks/<unguessable-jobId>`. The server-issued jobId (`j_<ulid>`) is the URL secrecy layer. A Todoist app has a single callback URL, so Todoist jobs additionally answer on one shared, job-less endpoint that fans out (see § Todoist below).

`scheme` is one of:

- `none` — URL secrecy only. Accept anything to that URL.
- `hmac-sha256` — generic HMAC. Server expects header `X-Patch-Signature: hex(hmac_sha256(secret, body))`.
- `github` — GitHub's `X-Hub-Signature-256: sha256=<hex>` scheme.
- `stripe` — Stripe's signed-event scheme.
- `todoist` — Todoist's `X-Todoist-Hmac-SHA256: <base64>` over the raw body, keyed on the Todoist app's client secret (the job's `secret`).

Server has built-in code for each scheme (~30 lines apiece).

Security is server-side. Signature verification passes before any chat is spawned; skills run inside spawned chats afterward.

For high-volume sources (GitHub repos that fire on every push/comment), recommend the user configure the source itself to scope which events to send. Patch's filter is the second line of defence; the source's own scoping is the first.

### Todoist

Todoist is not a trigger type of its own: it is an ordinary `webhook` trigger with `scheme: "todoist"` and the Todoist app's client secret as `secret`, put in by whoever creates the job. The `todoist` trigger type below is **legacy** — still read and fired for jobs already stored that way, but no editor, CLI or MCP tool creates it any more.

```json
{ "type": "webhook", "scheme": "todoist", "secret": "<todoist client secret>" }
```

The job-level JSONata `filter` selects events (e.g. `payload.event_name = 'item:added'`).

Legacy form:

```json
{
  "type": "todoist",
  "auth": "token-ref",
  "filter": "labels contains 'agent'"
}
```

Matching tasks produce a payload containing the task object.

#### Shared ingress — `POST /api/webhooks/todoist`

A Todoist app has exactly **one** callback URL. Per-job URLs therefore do not work for Todoist: every new subscription would have to rotate the URL in the app console, breaking the previous one, capping the whole server at a single Todoist job. So Todoist ingress is one shared, job-less endpoint — set it once in the Todoist app console and never touch it again.

`POST /api/webhooks/todoist` **fans out** to every enabled `webhook` job with `scheme: "todoist"` whose own `secret` verifies the signature, plus (legacy) every enabled `todoist`-type job when the signature verifies against `TODOIST_WEBHOOK_SECRET` (`11-deployment.md` § Env). Each such job has its own filter evaluated against that same payload, and each job whose filter passes dispatches its own action. One inbound event may fire zero, one, or several jobs.

Per-job observability is unchanged: each job the event is fanned out to gets its own `webhooks.jsonl` line (signature/filter/status) and, on a fire, its own `runs.jsonl` entry — exactly as if it had its own URL.

No fallback. If `TODOIST_WEBHOOK_SECRET` is unset and no enabled todoist-scheme job has a secret, the endpoint refuses every request (`503`) rather than accepting unverified posts. Signature failures (`401`) and the unconfigured refusal are audited on the server logger, not in any per-job log: the caller is unverified at that point, so it must not be able to cause a write into a job's log file.

Response is the per-job outcome list: `{ "results": [ { "jobId": "j_...", "status": "sent" | "buffered" | "queued" | "refused" | "filter-rejected" | "filter-error", "fireId"?: "..." } ] }`. Zero matching jobs is a normal `200` with an empty list.

#### Per-job ingress — `POST /api/webhooks/todoist/:jobId` (legacy)

The original form, kept working. It verifies against the job's **own** `trigger.clientSecret` rather than the server env, and fires only that job. Use it when a job needs to be driven by a _different_ Todoist app (its own client secret), or for a subscription already wired to a per-job URL. New Todoist jobs should use the shared endpoint and carry no `clientSecret`.

## Filter

Optional JSONata expression applied to the trigger payload. Returns truthy → action fires. Returns falsy → action skipped (logged as `filter rejected`, not a run).

```json
"filter": "payload.action = 'closed' and payload.pull_request.merged = true and payload.pull_request.base.ref = 'main'"
```

Filter is agent-generated. The user describes what they want in natural language; the agent generates the JSONata at setup time and stores it on the trigger. At fire time the server evaluates the stored JSONata in microseconds with no LLM call. This handles the firehose: a busy GitHub repo can fire 40k events/day; the filter rejects most of them server-side before any chat is spawned.

JSONata is shown in the UI for inspection; humans rarely edit it directly. It is declarative, purpose-built for JSON, and has no code-exec surface.

The root object every trigger type's filter runs against is `{ payload, now }` — `payload` is the trigger-specific data (`{ firedAt }` for cron/recurrence, the raw body for webhook/todoist), and `now` is a plain ISO 8601 field carrying this fire's instant, present identically on every trigger type. `now` is what makes `filter` the one generic way to express a date-bounded condition — "every Friday, starting 1 May 2027" is a plain recurrence trigger plus `filter: "now >= \"2027-05-01T00:00:00.000Z\""`, no bespoke start-date field needed, and it composes with a stop date the same way (`now <= "..."`) or with any other condition via `and`.

`now` is deliberately a plain field rather than a function call (`$now()`, a JSONata built-in that would work identically at evaluation time): the web Jobs editor's Starts/Stops widget round-trips a filter through `react-querybuilder`'s `parseJSONata`/`formatQuery`, whose grammar understands `field op value` but not an arbitrary expression on the left — `$now() >= "..."` parses back to an empty rule set, silently unrecognised, and quoting it as a field name (`` `$now()` ``) parses but evaluates to `undefined` (a literal, nonexistent field lookup, not the current time) — both dead ends for a structured editor. A plain `now` field has neither problem and is exactly as valid a comparison target as `payload.foo`.

A payload-bearing filter only makes sense for payload-bearing triggers (webhook / todoist) — cron and recurrence triggers carry only `{ firedAt }` in their payload, nothing meaningful to compare against beyond `now`. The web editor therefore hides the raw JSONata Filter group for cron and recurrence triggers, but the Starts/Stops widget (built on `now`, not `payload`) is offered on every trigger type, cron and recurrence included, since a date bound is meaningful everywhere a schedule is (`14-design-web.md` § Jobs view).

## Gate

Optional shell command that decides whether a fire proceeds at all.

```json
"gate": { "daemonId": "d_abc", "folder": "/path", "command": "…", "timeoutMs": 30000 }
```

`filter` asks a question of the trigger's **payload**; a gate asks one of the **world** — is there a new photo, is the watcher due, is the desktop even awake, has the queue got anything in it. Both sit in the same place in the pipeline and do the same job: turn a fire away before it costs an agent turn. So a gate is a sibling of `filter`, not part of the action, and it composes with all four action types: a gated `spawn`, `message`, `continue` or `script` is the ordinary one with a precondition in front of it. Null/absent → every fire that passed the filter runs its action.

A gate is written for the cron watcher whose honest cadence is every few minutes and whose answer is almost always "nothing to do". A filter cannot help there — a cron payload is `{ firedAt }` and carries nothing to judge — so before gates the only ways to write such a job were to pay a model on every tick to discover there was nothing, or to run it hourly and be late.

It replaces a shape that was worse: a `script` action that decided **and then spawned**, shelling out to `patch chats spawn` when it found work. That script had to carry the prompt, the skill, the model, the folder and its own "don't start a second one" check, none of which a reader could change from the job — and the chat it made was not the job's action, so none of the job's machinery reached it. No `chat.spawned` came back through the server, so the run row had no chat to link. No concurrency slot was taken, so the script needed a hand-rolled is-the-last-one-still-running check against a state file on the host. `startArchived` and `notifyOnComplete` described a chat the job never created. A gate gives the decision back to the script and the work back to the job: the command decides, the action spawns, and everything a job knows how to do applies again.

Like a `script` action's `command`, a gate's **is the script, not a path to one** — a multi-line body handed to the host's shell verbatim. That is deliberate: a gate kept in a file outside Patch is a decision nobody can read or change from the app that runs it, and every surface renders this field as a code editor for that reason. It runs on the host it names, in the folder it names, as the host's user.

### The exit code is the verdict

| exit          | verdict   | what it must print            | recorded as               |
| ------------- | --------- | ----------------------------- | ------------------------- |
| `0`           | **run**   | its verdict, on stdout        | the row the action writes |
| `1`           | **hold**  | the reason it held, on stdout | `gate-held`               |
| anything else | **fault** | what broke, on stderr         | `gate-error`              |

`grep`'s convention, for `grep`'s reason: the ordinary "no" is not an error.

**An `exit 1` with nothing on stdout is a FAULT, not a hold.** That rule is load-bearing. A deliberate hold always has a reason, and that reason is the entire value of the row it writes. But 1 is also the code a half-written gate dies with — a `curl` that cannot connect, a failing `[ ]`, a Python traceback, almost anything under `set -e`. Reading a bare 1 as a hold is how a gate that broke on Tuesday reads as a quiet week, which is the exact failure this mechanism exists to make impossible. Accidents print to stderr or print nothing; deliberate holds print their reason. So saying nothing is the fault.

A gate that cannot be **asked** is a fault too, never a hold: a gate whose host is offline records `gate-error` and the fire is not dispatched. It is deliberately not `buffered` the way an action to an offline host is — replaying a gate when the machine comes back would be answering "is this due?" hours after it was asked. A gate killed on its timeout, or one that could not start, has not said hold either; it has said nothing, and there is **no fallback in either direction**. An unreadable gate is never assumed to mean run (that spends money on a broken signal) and never assumed to mean hold (that stops the job silently for ever).

So a gate is written with its holds explicit and its faults loud:

```bash
set -euo pipefail
if [ "$(TZ=Europe/London date +%-H)" -ge 23 ]; then
  echo "quiet hours — holding"        # stdout + exit 1  = a deliberate no
  exit 1
fi
STATE=$(curl -s -m 10 "$OBSERVER/state") || STATE=''
if [ -z "$STATE" ]; then
  echo "observer unreachable" >&2     # stderr + exit 3  = the gate is broken
  exit 3
fi
echo "due — running"                  # stdout + exit 0  = the action fires
```

### A passing gate's stdout is the action's input

A fire the gate let through renders its prompt against `{{gate.stdout}}` — everything the gate printed, trimmed — and `{{gate.verdict}}`, its last line, alongside the trigger's own `{{payload.…}}`. A skill-only action, which is handed the trigger envelope as JSON, gets the same two fields inside it without anyone writing a template.

This is the point of splitting the job in two rather than merely the price of it. The gate is the half that has already looked at the world: it knows that eleven photos arrived, that Screwfix crossed its delivery threshold at £61.40, that this is the 21:00 audit and not an ordinary tick. Before this it could only write that on the run row, where nothing but a person ever reads it, and the agent it started opened on an empty prompt and paid a model to go and find out again what a shell script had established a second earlier. The script does the cheap deterministic half; the model starts from its answer.

**Stdout only, never stderr.** The gate contract already says stdout is what a gate meant to say and stderr is where its accidents land, and that division is exactly what makes stdout safe to feed a model. A Python traceback read as a briefing is worse than no briefing: it is a confidently wrong agent.

It changes nothing about the verdict. A gate that holds still starts nothing, so there is nothing for its stdout to be the input to — the reason it prints is for the run row, as it always was.

`timeoutMs` is optional; without one a gate gets 60 seconds (`GATE_DEFAULT_TIMEOUT_MS`), and the ceiling is 10 minutes as for a `script` action. Gates are meant to be quick — a gate is asking about **now**, so one that has to think for minutes is answering a question that has moved on. A gate in flight is held only in memory, so a server restart mid-gate correctly loses it rather than answering stale.

### What a gate writes down

Every verdict writes a fact, because a gate that decided is as much a fact as a fire that ran.

A **hold** writes one `gate-held` run carrying the gate's exit code and its reason as the row's output. A **fault** writes one `gate-error` run carrying the code, whatever both streams said, and an `error` naming what went wrong — including, for the bare `exit 1`, that a hold must say why. A fire the gate **let through** writes no row of its own: it goes on to be an ordinary fire, and the gate's own words become the output of the row its action writes. So one fire stays one row, and opening it shows both why the fire was allowed and what it then did.

`gate-held` and `gate-error` are deliberately different statuses because they are different facts and only one of them is news. Held is the gate **working** — on a five-minute watcher nearly every fire is held, and the count of holds is the proof that the gate is alive and deciding. `gate-error` is the gate **broken**, and it has to stand out from the hundreds of holds around it.

That is also why a job's Recent runs panel treats them differently. Holds are **collapsed by default** — a panel 280 holds deep is a panel in which the launch you came to find is not on screen — but collapsed is not buried: the toggle is **counted** ("Show 47 held"), so the count itself says the gate is alive, and one click shows every hold with the reason it gave. A job whose every recent fire was held says so in words rather than reading as a job with no runs. `gate-error` is never collapsed: a watcher whose gate has broken is the one thing that must never need a click to notice.

A gate does **not** hold the job's concurrency slot. It takes no slot, writes no queue entry and leaves no pending record — a held fire must cost exactly one cheap command and leave nothing behind. The slot is taken only once the gate has let the fire through, at which point the fire queues, buffers and counts exactly as an ungated one does.

Because a gate is a top-level field it is version-sensitive on the **write** path, exactly as `CronTrigger.timezone` is: `patch_job_create` / `patch_job_update` name their fields explicitly (only `action` travels as an opaque blob), so an agent on a host older than the field cannot set a gate. Reading one is safe everywhere, and the web and phone editors write to the server's REST directly, so neither is affected.

## Action

Each job has one action; pick `spawn`, `message`, `continue`, or `script`. These are scheduler verbs that fire when the trigger matches — and when the job has a `gate`, when the gate has let the fire through (§ Gate).

```json
{ "type": "spawn",   "daemonId": "d_abc", "folder": "/path", "skill": "bus-watch" }
{ "type": "spawn",   "daemonId": "d_abc", "folder": "/path", "prompt": "..." }
{ "type": "message", "chatId": "c_abc",                      "skill": "bus-watch" }
{ "type": "message", "chatId": "c_abc",                      "prompt": "..." }
{ "type": "continue", "daemonId": "d_abc", "folder": "/path", "skill": "bus-watch" }
{ "type": "continue", "daemonId": "d_abc", "folder": "/path", "prompt": "..." }
```

A folder-addressed action carries both `daemonId` and `folder`, stored with the
job, so a job fires on the host it was written for at the path it was written for.
Both are required: a folder path means nothing without the machine it is on, and
there is no host-wide directory a job could fall back to. An action saved without
either is rejected at the API, and every surface's job editor blocks the save with a
message saying so (`14-design-web.md` § Jobs view, `15-design-mobile.md`
§ Job editor).

An action may also store a `model`, named from the catalogue of the host the action
runs on; without one the spawned chat takes that host's last-used model. A `message`
action takes host, folder and model from the chat it delivers into. On a `continue`
action the model applies to the fire that creates the durable chat — a chat's model
is fixed for its life (`04-chats-and-folders.md` § Spawn), so changing a stored model
afterwards reaches the next chat the job creates, not the one it already owns.

A `spawn` action may also store a `permissionMode`, one of the modes in
`02-daemon.md` § Permission mode, stamped onto the chat it spawns. Without one the
fire spawns under `auto` rather than the host default: a job's mode is decided by
the job, not by whichever host it lands on, so raising a host's default to a
blocking mode for the person sitting at it cannot silently stall every unattended
job running there.

Firing at an offline host writes the action to that host's pending queue, flushed
when the host reconnects and bounded as in `12-error-and-offline.md` § Cron fires
while a host is down. The run log names the host and shows the run as pending.

Two axes: where (`spawn` a new chat, `message` an existing one, or `continue` a persistent one) and what (run a `skill`, a `prompt`, or a `skill` driven by a `prompt`). Every combination is valid; the only rule is that an action carries at least one of `skill` / `prompt`.

### `script` — a fire with no chat

```json
{ "type": "script", "daemonId": "d_abc", "folder": "/path", "command": "scripts/tick.sh" }
```

The three actions above all cost an agent turn. A job that mostly finds nothing to do
— poll an API, notice a file, check a queue — therefore pays a model to discover that,
every fire, forever; the honest cadence for such a job (every five minutes) is exactly
the cadence that makes the cost absurd, so it gets written as an hourly job that is
late instead, or it gets written outside Patch as a system cron and is lost.

A `script` action runs a **command** on the host it names, in the folder it names, and
records its exit code and output tail on the job's runs. There is no chat and no model
anywhere in the path. It is the one action carrying neither `skill` nor `prompt`, because
there is no first user turn to deliver: a fire with no chat has nothing to say anything to.

A `script` action is for the tick whose **whole job** is the command — prune the images,
rotate the log, push the metric. It is **not** the way to write a watcher that sometimes
needs an agent: a script that decides and then shells out to `patch chats spawn` starts a
chat the job does not own, so nothing the job knows how to do applies to it (§ Gate names
what is lost). Put the decision in a `gate` and the work in the action instead. Where a
`script` action does announce a chat it started, it says so with a `patch:chat <chatId>`
line on stdout and the server lifts that onto the run row — the mechanism a gated job has
no need of, because its chat is its action's.

The command runs through the host's login shell as the host's user. `timeoutMs`
(default 60s, ceiling 10 minutes) kills it and records the fire failed — a hung
command must not hold the job's concurrency slot, which a `script` fire frees when its
result arrives rather than when a chat goes idle. A folder that does not exist on that
host fails the fire and says so; it is never run somewhere else instead.

A run entry for a `script` fire carries `exitCode` and an `output` tail (4000
characters per stream, tail kept), and a `chatId` only where the command announced one, so
the runs ARE the record. A non-zero exit is a `dispatch-error`, not a quiet `ok` — note
that this is the opposite of a **gate**'s reading of the same code, where `1` is an
ordinary "no" (§ Gate): an action is doing the work and a non-zero exit means the work
failed, where a gate is answering a question and "no" is half the answers it has.

`spawn` creates a fresh blank chat in `folder` on `daemonId`, so each fire is independent. Spawned chats open in the active inbox like any other chat; the action's optional `startHidden` flag spawns them into Hidden instead (`04-chats-and-folders.md` § Hidden). It was `hidden` until 2026-09-11 and `startArchived` until 2026-09-28, when archived came to mean stopped and a background run needed a state of its own; jobs stored under either old name are translated on read and never written back out.

`message` delivers into an existing chat — a long-running chat that maintains context, a specialised handler chat that's accumulated knowledge, or a special thread (Manager, Speakers). The `chatId` must already exist.

`continue` is the middle ground (named `ensure` until 2026-09-11 — an infra-as-code word for the mechanism rather than for what the fire does; jobs stored under the old name are translated on read and never written back out): the job owns one durable chat, created on the first fire and reused on every fire after, so context accumulates across runs — without the user pre-creating a chat or knowing its id. The chat id is derived deterministically from the job id (`jobchat-<jobId>`); the server keys on it to decide spawn-vs-message (the chat registry mirror plus an in-process guard cover the window before the first `chat.spawned` round-trips, and the ordered daemon-link makes a spawn-then-input pair land in order). The mirror is in memory and empty after a server restart until each host re-announces its chats, so a chat the mirror lacks on a host that has not reported yet is unknown, not missing: the fire is held in that host's buffer and decided, spawn or message, only once the host has reported. Deciding early would spawn a chat the host already has, which it refuses, and the fire would be lost. A `continue` chat opens in the active inbox — it's something the user wants to find and follow — unless the action sets `startHidden` (below). Use it for "a single running digest/log chat this weekly job keeps appending to."

`continue` may also carry a `key` — a mustache template naming the SUBJECT of the fire, giving the job one durable chat _per subject_ rather than one overall (`jobchat-<jobId>-<key>`):

```json
{
  "type": "continue",
  "daemonId": "d_abc",
  "folder": "/path",
  "skill": "app-update",
  "key": "{{payload.event_data.id}}"
}
```

This is what lets one job take both the creation and the revision of the same thing. A Todoist project firing on `item:added` **and** `item:updated`, keyed on the task id, sends a task's first event to a new chat and every later edit of that same task into the chat already working on it, while a different task still opens its own. The three alternatives are each wrong for that: `spawn` starts a second competing run on every edit; an unkeyed `continue` piles every task in the project into one chat; and not listening for `item:updated` at all means an edit is silently ignored — which is what "moving a task into the project does nothing" looked like from the outside.

A key that renders empty — a payload with no such field, as a manual run has — is **refused**, recorded on the job's runs as a `dispatch-error`. There is deliberately no fall back to the job-wide chat: that would merge unrelated subjects into one conversation, the exact failure keying exists to prevent. So `POST /api/jobs/:id/run` on a keyed job is refused unless the payload it is given carries the key's field.

The key is only an addressing device, so it is slugged (runs of non-alphanumerics to `-`, capped at 64 characters) before being embedded in a chat id.

When the action carries a `skill`, the spawned/messaged chat receives this as its first user-turn:

```
/<skill-name>

<trigger-payload-as-JSON>
```

The skill is invoked with the payload as its input. The `SKILL.md` interprets the payload (a GitHub PR, a Todoist task).

When the action carries a `prompt`, the spawned/messaged chat receives the prompt with mustache-substituted payload values:

```
"prompt": "Standup in 30 min. {{event.summary}}. Prep me a brief read."
```

Mustache-style substitution, no logic.

A `prompt` on a job whose trigger is `todoist` or `webhook` is followed by the whole event as a JSON block: a `Trigger event:` heading, then a fenced `json` block holding the pretty-printed view the templates render against (for a gated job, including its `gate` output). Mustache picks fields out for emphasis; it never decides which fields the agent can see, so a field nobody templated (a Todoist comment's `file_attachment`) is still there. The job's autonomy prompt still comes first, ahead of the rendered prompt. `cron` and `recurrence` jobs are unchanged: their payload carries only `firedAt`, so nothing is appended. A skill with no prompt is unchanged too — its body already _is_ the payload JSON, so it is never doubled. A `script` action has no user turn and so nothing to append to.

The action's `includePayload: false` opts a job out (on `spawn`, `continue` and `message`). Absent — the default — and a redundant `true` both mean the block is appended; only `false` changes anything. It is read by the server alone when it renders the turn, so no host needs updating for it.

An action may carry both a `skill` and a `prompt` (it must carry at least one). When both are present the first user-turn is the skill invocation with the rendered prompt as its body — `/<skill-name>\n\n<rendered-prompt>` — so a job can run a skill and hand it custom, mustache-templated instructions instead of the raw JSON payload:

```
{ "type": "spawn", "daemonId": "d_abc", "folder": "/path", "skill": "forage-podcast", "prompt": "Focus on autumn mushrooms near {{home}}." }
```

Alerts come from the chat, not the job. If a job needs to alert the user, the spawned/messaged chat calls `patch_notify` (see `09-notifications.md`). Every fire runs a chat, so every fire is auditable as a real conversation.

A spawned chat opens in the active inbox, exactly where a chat the user started themselves would open. A job's run is a real conversation the agent may need to come back to the user about — a run that stops on a question is a chat waiting for an answer, and burying it made it wait indefinitely unless the user happened to open `▸ Automations`. Being in the inbox means such a run carries the normal badge and reaches the needs-attention filter like anything else.

Setting the action's `startHidden` flag spawns the chat into Hidden instead (`04-chats-and-folders.md` § Hidden): running, but out of the active list. That is for a job whose runs are genuinely background noise (a five-minute tick), where an inbox row per fire is only clutter. It is per-job and opt-in — never inferred from trigger frequency. It never spawns into Archived: archived means stopped, and a fire exists to run. Nor does a run's ending move it there — a hidden job chat only ever leaves Hidden for the active list, when it asks the user something or reports.

`startHidden` is available on `spawn` and on `continue`, and means the same thing on both: keep this job's chat out of the inbox. On `spawn` it applies to every fire, because every fire makes a chat. On `continue` it applies to each fire that CREATES a chat — the job-wide chat on an unkeyed action, a subject's chat on a keyed one — and a later edit of the flag therefore reaches the next chat the job creates, not the ones it already owns, the same rule `model` follows. A keyed `continue` is the case that needs it: one chat per Todoist task is one inbox row per task, which is the clutter `startHidden` exists for. `message` has no `startHidden`, having no chat of its own to place. A later fire into a `continue` chat is a machine message, so it leaves a hidden chat hidden; into an archived chat it starts the chat again, back in Hidden if that is where it was (`04-chats-and-folders.md` § Lifecycle). A fire's `chat.input` carries `source: { kind: 'job', jobId }`, which is how the host tells a job tick from the user's own message.

`spawn` and `continue` can name `preferredAccountId`: the shared account the chat they create starts its turns on (`10-auth.md` § Backend credentials — preferred account). Like `model`, it is fixed when the chat is created, so on `continue` an edit reaches the next chat the job creates. Absent, the backend's account strategy alone decides.

A run started hidden that turns out to need the user does not stay there: the moment it blocks on a permission decision or an `AskUserQuestion`, or declares a `question` or `report`, the chat un-hides itself, so it is in the inbox to be answered. `startHidden` says the run is ordinarily not worth a row, not that the user should never hear from it.

Either way, every job-created chat — `spawn` or `continue` — also appears in the sidebar's `▸ Automations` group (`14-design-web.md` § Sidebar) for as long as it exists, regardless of its state, carrying the standard status badge — this is how the user watches a run go `working` → `done`. A chat that needs attention can additionally call `patch_notify`, and the user surfaces it from the notification (push/desktop/voice). There is no auto-archive, on inactivity or on finishing — a hidden job chat stays in Hidden when its run ends (`04-chats-and-folders.md` § Hidden) — so any chat (automated or not) stays wherever it is until it is manually archived (see `04-chats-and-folders.md` § Lifecycle).

An action's optional `goal` sets the chat's goal (`04-chats-and-folders.md` § Goals) at creation — the same condition text `/goal <condition>` would set. Available on `spawn` and on `continue`, creation-time only like `startHidden`: on `continue` it applies to each fire that CREATES a chat, and a later edit reaches the next chat the job creates, never one it already owns. Unlike the composer's `/goal`, it does NOT also send `goal` as the chat's first turn — the action's own `prompt`/`skill` already supplies one, and the two need not say the same thing: a job can brief the agent on what to do and separately hold it to a stopping condition worded for a judge rather than a worker. `message` has no `goal`, having no chat of its own to place one on.

A fire's turn is a `user` turn — the job dispatched it on the user's behalf, not the machine for itself (`09-notifications.md` § Whose turn it was) — so a job's chat settling rings the completion doorbell like any other chat's. The action's `notifyOnComplete` flag turns that off, for a job whose every fire would otherwise push. It is available on `spawn` and on `continue`, the two actions that create a chat, and it defaults to notifying: an action that omits it notifies, and only an explicit `false` is stored. `message` has no `notifyOnComplete`, delivering into a chat the user already owns and already hears from.

Suppression follows the chat, not the turn: a turn the user types into a suppressed job's chat is silent too, because the flag names this job's chats as not worth a doorbell rather than this fire. Only the doorbell is silenced — a `patch_notify` from inside the run still reaches the user, which is how a job that mostly has nothing to say still reports the fire that does.

## Autonomy prompt

Every fire is unattended — there is nobody at the keyboard to answer a question a chat stops to ask — so every fire carries an autonomy prompt, text prepended to the fire's first user-turn. There is no way to turn it off. It is set ONCE for all jobs, as the account setting `jobAutonomyPrompt` (Settings → Jobs, `14-design-web.md`), whose default is:

> You are running autonomously, don't stop to ask the user questions

The setting is read per fire, so an edit reaches the next fire of every job. A job may override it for itself with `autonomyPrompt`; absent means "use the account setting" (never "use nothing"), so an untouched job follows the setting as it changes. A job that already carries an `autonomyPrompt` keeps it when the account setting changes — nothing is migrated or reverted.

Inserted after the `/<skill>` line when the action names one, so the skill invocation stays the first line of the message; otherwise it prefixes the rendered prompt directly. A `script` action has no chat and so no first user-turn to preface.

The web job editor does not show the prompt by default. A collapsed "Advanced" area holds an "Override autonomy prompt for this job" toggle and a box: unticked, the box shows the account prompt read-only; ticked, it is editable and seeded from the account prompt. A job that already carries an override opens Advanced on load, so a customised job never hides its own text. `patch_job_create` / `patch_job_update` carry the override as `autonomyPrompt`; on update, `null` clears it back to the account setting, where omitting the field leaves whatever the job already has.

## Queueing

`queueing` states how a job's fires relate to one another. Absent means `parallel`. It is one of three modes:

```json
{ "mode": "parallel" }
{ "mode": "queue", "concurrency": 2, "key": "{{payload.event_data.id}}" }
{ "mode": "append", "idleTimeoutMs": 3600000, "resetAfterMs": 86400000, "resetAfterMessages": 50 }
```

- **`parallel`** — every fire runs the moment it arrives. Nothing is gated.
- **`queue`** — fires wait their turn, `concurrency` (default 1) at a time, on the machinery in § Concurrency. With a `key` — a mustache template naming the fire's subject, slugged exactly as a `continue` key is — the limit applies per subject rather than to the job: two subjects run side by side, two fires for one subject run one after the other. A key that renders empty is refused as a `dispatch-error`; it never falls back to the job-wide queue, which would serialise unrelated subjects behind each other. `GET /api/jobs/:id` and `/queue` count across all subjects.
- **`append`** — every fire is delivered into one durable chat (the `continue` action's chat, per key if the action has one), so context accumulates. Only valid with a `continue` action. The chat starts afresh — the next fire moves to a new chat `jobchat-<jobId>[-<key>]-g<n>`, leaving the old one untouched — when it has been idle for `idleTimeoutMs` (measured from the last fire), has existed for `resetAfterMs` (measured from its first fire), or has been sent `resetAfterMessages` fires. Every limit is optional; with none, the chat is never reset. The generation, start time, last fire and fire count live under `/data/append` and survive a restart; an unreadable record fails the fire rather than guessing a generation.

The older `concurrency` field is `queue` without a key. A job may carry one or the other: setting both is refused at write time, as is `append` on an action that is not `continue`. `null` on a patch removes `queueing`.

## Concurrency

A job may set `concurrency` — an integer of 1 or more — and that is how a job serialises its own fires. While the job has that many fires in flight, every further fire is queued rather than run. Omitted means no limit: every fire dispatches the moment it arrives.

This matters for the high-volume triggers. A Todoist project that gets thirty tasks dropped into it at once fires a `spawn` job thirty times, and without a limit that is thirty chats starting together on one machine, in one working tree. `concurrency: 1` turns the same thirty fires into thirty builds, one after another.

The limit counts CHATS a job has working, not messages it has sent. A fire that delivers into a chat this job already has in flight — a keyed `continue` whose subject is already being worked on — therefore skips the gate and takes no second slot: it opens no new chat, it appends to one already counted. Queueing it would be actively wrong, since the update would then wait for the very run it is meant to correct to finish first.

A fire is in flight from the moment it is sent to its host until the chat it landed in goes idle. The server already mirrors chat activity, so this needs nothing from the job itself. Because a chat is reported idle before its first turn begins, a slot is only released once that chat has been seen working and then stops. A chat that dies without ever reporting itself idle releases its slot after a bounded wait, recorded as `slot-timeout` on the job's runs, so a lost chat delays the queue rather than wedging it forever.

The queue is FIFO and per job. When an in-flight fire finishes, the oldest queued fire dispatches. It is server-owned state under `/data`, so it survives a server restart: fires queued before a restart still run after it, and slots held by chats still working are re-checked against the chat mirror on reconnect rather than assumed free.

That re-check has three outcomes, not two. The server restores the chat mirror from disk at startup (`01-server.md` § Chat state), so it begins from what it last knew, and a host's own report refines it as it re-announces. A restored slot whose chat the mirror has as working keeps it. A restored slot whose chat the mirror has as errored gives it back at once. One whose chat is idle gives it back at once if the chat is known to have worked since the slot was taken, because a chat is reported idle before its first turn and releasing on that would start a second build beside one about to begin. That is known if the server saw the chat working (kept across restarts), or if its host reports it idle with a first message accepted and its own clock more than ten seconds past the slot's start. Without that evidence the slot is kept until the chat reports working and finishes, or the bounded wait gives it back; it is checked again when each host closes its re-announcement (`folders.list`), against what the host has just said, so a chat that finished while the server was down is released then. A restored slot whose chat the mirror cannot resolve at all — a chat the server has never heard of, or one its host no longer reports — **keeps** its slot: an unresolved chat is not evidence of a free slot, and treating it as one dispatches a second fire on top of a running one, which is the exact thing the limit exists to prevent. Such a slot is only ever given back through the bounded wait below, never by the server forgetting about it.

The bounded wait is measured from when the slot was taken, not from when the server last started. A slot cannot be extended indefinitely by restarting underneath it: a chat that has held one past the bound releases it on the next boot, recorded as `slot-timeout` exactly as it would be in a long-lived process.

The queue is unbounded — a fire waits, it is never refused. This is the opposite of the host-offline buffer, which is capped and drops its oldest entry when full (`12-error-and-offline.md` § Cron fires while a host is down). One queue exists because a host cannot be reached and discards the stalest work, so a cap bounds how much can pile up behind an outage; this one exists because the job asked to run its work one at a time, where the stalest work is exactly what must not be lost — so it has no cap to lose it against. Depth here is a signal to look at (via `GET /api/jobs/:id`), not a limit to enforce.

`GET /api/jobs/:id` reports the job's current in-flight and queued counts, and `GET /api/jobs/:id/queue` lists what those counts are counting: the fires in flight, oldest first, and the fires waiting, in the order they will be released. Each carries when it started or queued, its trigger, its action type, the host it is addressed to and the chat it landed in or will land in.

## Run window

A job may set `window: { start, end, timezone }`: the hours it may START a fire. `start` and `end` are 24-hour wall-clock `HH:MM` in the IANA `timezone` (required — a window with no stated zone would mean the server's); `start` is inclusive, `end` exclusive, and an `end` earlier than `start` wraps midnight (`22:00`–`06:00`). `start` equal to `end` is refused. Absent means the job fires whenever it is triggered. `PATCH` with `window: null` removes it.

A fire that arrives outside the window is **held**, not dropped: it is written to `<dataDir>/held/`, a `queued` run is logged, and `dispatch` answers `queued`. The window is checked before the gate, so a held fire costs one file. The server looks at the clock once a minute and dispatches every held fire whose window is open, oldest first, as if it had just arrived. Held fires survive a restart. If the window is removed meanwhile the fire is released at the next check; if the job was deleted or disabled meanwhile the fire is dropped with an error log. A manual run ignores the window — a person asked for it now. The window only governs when a fire starts; a chat already running is not stopped when the window closes.

## One-off jobs

A job may set `oneOff`: it does its thing once and then retires itself. The first of its fires to settle `ok` — the host confirmed it landed (§ Execution model step 7) — leaves the job `enabled: false` with `expiredAt` stamped on it. Carrying an `expiredAt` is what expired means; nothing else marks it, and an expired job is always a disabled one.

This is for the single-purpose job: "when the parcel webhook arrives, spawn a chat about it", "at 6pm tomorrow, message the manager thread the result". Agents create these constantly, and without a way to retire them they accumulate for ever beside the genuinely recurring automations. A one-off that has to re-invoke the SAME chat is not a job at all — that is `patch_wake_me` (§ Disambiguation).

A fire that settles `dispatch-error` does not expire the job. It never did its thing, so the job stays enabled and its next trigger fires it again — which is the whole point of expiring on the outcome the host reports rather than at dispatch time. Expiry is idempotent: a second `ok` settling against an already-expired job changes nothing.

`expiredAt` is server-established. No client may write it — it is absent from the create and patch bodies, and a body carrying one is rejected rather than quietly ignored. `oneOff` itself is an ordinary field: whoever creates the job sets it, and it can be changed later like any other.

Enabling an expired job re-arms it — any write that sets `enabled: true` clears `expiredAt`, and the job then fires and expires once more. That keeps the invariant intact: an enabled job is never expired, so a job cannot sit in the list marked retired while still firing.

Expired jobs are kept, not deleted. Their run log and the chats their fire produced stay reachable (§ Logs); the web list simply folds them away (`14-design-web.md` § Jobs view).

## Archived jobs

A job may be archived: `archived: true` puts it away. Absent or false is an ordinary live job, and archiving is a client write like any other field — no server-established stamp, because it records what the user did rather than what a fire did.

An archived job does not fire. Its cron expression is not registered, and a webhook or Todoist push addressed to it is refused and logged exactly as one addressed to a disabled job is, naming which of the two it was. A manual run (§ Manual run) still works, as it does on a disabled job — trying the action out is how the user decides whether to bring the job back.

Archiving is orthogonal to `enabled` and never touches it, so un-archiving restores the job exactly as it was rather than guessing whether it should now run. Archive is the reversible way to get a job out of the way and deleting is the irreversible one; a job's run log and the chats its fires produced survive archiving untouched (§ Logs) and go with it on a delete.

A job can be both archived and expired. Archived is the stronger statement — a deliberate act rather than a job having run its course — so that is how the list groups it (`14-design-web.md` § Jobs view).

## Groups

A job may carry `group`: a free-text label — "Home", "Finance", "Watchers" — the user sets to organise the jobs list. It is purely organisational: never read by any trigger, gate or action, never compared case-insensitively or trimmed server-side, so two jobs land in the same group only when their `group` strings are byte-identical. Absent or `""` means ungrouped.

Unlike `archived`, a job can be given a group at birth — there's no reason a job can only be organised after it exists.

`group` sub-divides the web list's existing recurring / one-off / expired / archived sections (`14-design-web.md` § Jobs view) rather than replacing them: each section draws its own group headers when it holds more than one distinct group, with the ungrouped jobs trailing last.

## Logs

Two log streams per job, both stored under the server's data dir:

- `/data/runs/<jobId>.jsonl` — every fire (cron tick, webhook accepted, todoist push, or a manual Run now — § Manual run). Records `{ts, jobId, status, trigger, payloadDigest, action?}`, where `trigger` is `cron | webhook | todoist | manual`. The `action` carries the chatId this fire dispatched to (the per-fire chat for `spawn`, the stable `jobchat-<jobId>` for `continue`, the target for `message`) so the run is navigable to its chat. Status is one of `ok | dispatch-error | buffered | queued | slot-timeout | chat-error | gate-held | gate-error`. `queued` / `slot-timeout` belong to the concurrency gate (§ Concurrency): a queued fire is recorded when it queues and again when it dispatches, so a job's history shows how long it waited. `gate-held` / `gate-error` belong to the job's own gate (§ Gate) and are the two ways a gate stops a fire; a fire the gate let through writes no row of its own, only the ordinary one its action produces, carrying the gate's reason as that row's `output`. A `script` fire's `exitCode` / `output` and a gate's are the same two fields — for a `script` action they are the record of the work, for a gate they are the verdict and its reason. A filter rejection is NOT a run (§ Filter, § Execution model): it is recorded in `webhooks.jsonl` as `filter: reject` and produces no `runs.jsonl` entry at all, so there is no `filter-rejected`/`filter-error` run status. `dispatch-error` covers both ends of the hand-off — the server could not reach the host, or the host took it and refused it (a folder it does not have, a backend with no credential) — and the entry names the host and carries its error text, since a job that silently does nothing on one machine is the failure this log exists to catch. `chat-error` is the case after that: the spawn landed, the fire was recorded `ok`, and the chat it created then failed anyway. It is written as a SECOND entry for the same fire, leaving the `ok` in place, because the job did do its part. Without it a job whose every chat dies on its first turn reads as an unbroken run of successes — which is how nine app-update fires were lost to a usage limit on 2026-08-26 with nothing noticing for two days. The failing chat is attributed to its job through the concurrency slot it holds, or through the persisted chatId → jobId link when the job has no limit and so holds no slot. This is what powers `GET /api/jobs/:id/runs` and the `patch_job_runs` MCP tool.
- `/data/webhooks/<jobId>.jsonl` — every inbound HTTP webhook hit (only for webhook/todoist triggers), including signature failures and filter rejections. The firehose. Powers `GET /api/jobs/:id/webhooks` and `patch_job_webhooks`.

Both are observability files — non-fsync'd appends. The job definition at `/data/jobs/<id>.json` is fsync'd in the store. The user-visible run record is the chat each fire spawns or messages; `runs.jsonl` is for debugging.

A job that names a `skill` in a `spawn` action delivers `/<skill>\n<payload>` as the spawned chat's first turn:

```json
{
  "name": "todoist @claude tasks",
  "trigger": {
    "type": "todoist",
    "filter": "labels contains 'claude'"
  },
  "action": {
    "type": "spawn",
    "daemonId": "d_abc",
    "folder": "/home/tom/projects/claude-tasks",
    "skill": "todoist-handler"
  }
}
```

## CRUD

- Web UI (`/jobs`) — primary inspect/manage surface. Data-forward: raw JSONata and payload examples visible (see `14-design-web.md` § Jobs view).
- Agents — every chat has `patch_job_create / patch_job_list / patch_job_update / patch_job_delete` (`06-threads-manager-speakers.md` § Cross-chat toolset), and in practice Manager is where "schedule a weekly newsletter" or "remind me about the bins every Tuesday" lands. Most jobs will be created this way.
- CLI — the `patch jobs` family (`17-cli.md` § Commands).
- Direct file edit — server watches `/data/jobs/`. Useful for version-controlling job definitions in a git repo.

Simultaneous edits: last-write-wins. The user is the only writer, just from different surfaces.

## Execution model

1. Trigger fires (cron tick from server's scheduler, HTTP POST to `/api/webhooks/...`, Todoist webhook).
2. For webhooks: server verifies signature against the trigger's `secret + scheme`. Drop on mismatch. Logged in `webhooks.jsonl` either way.
3. Server evaluates filter (JSONata) on the payload. Microseconds. No LLM. Filter rejection logged in `webhooks.jsonl`; no run.
4. If the job has a `gate` (§ Gate), the server sends its command to the gate's host and waits, and the fire is touched no further until an answer comes back: no templates resolved, no slot taken, no queue entry, no pending record. A hold ends the fire here with a `gate-held` run, a fault with a `gate-error` one, and a gate whose host is offline is a fault rather than a buffered fire. Only exit 0 continues to step 5.
5. If filter and gate passed: server resolves templates. If the job is at its concurrency limit the fire is queued here and steps 6-8 wait for a slot (§ Concurrency); otherwise it dispatches the action to the host it names.
6. That host executes (spawns chat or messages an existing one).
7. The server writes the run to `runs.jsonl` (success or failure), filling the chatId and the outcome from the events that host emits back through it — `chat.spawned` for a fire that landed, the host's own error (`folder_not_found` and the like) for one that did not. A gated fire's row also carries what its gate said, so the fire stays one row. No host writes to the server's logs; a host reports and the server records.
8. If the action's host is offline, the server buffers the action in `/data/pending/<daemonId>/` and flushes when that host reconnects (see `12-error-and-offline.md`).

Webhook triggers support a defined set of HMAC signature schemes; other vendors are reached via skills layered over a generic webhook trigger. Cross-job orchestration is done by a chat calling `patch_spawn` itself.

## Manual run

`POST /api/jobs/:id/run` fires a job's action once, immediately, outside its normal trigger — for trying out an action while building or editing a job, without waiting for its real cron tick/webhook/push or having to enable it first. Surfaced as a "Run now" button on the web and mobile editors (`14-design-web.md` § Jobs view, `15-design-mobile.md` § Job editor).

An optional body `{ draft: <job patch body> }` fires that unsaved edit instead of the saved job: the server validates it exactly as `PATCH /api/jobs/:id` would, dispatches the merged result, and persists nothing. The web editor sends it whenever the form has unsaved changes, and labels the button "Test run" (otherwise "Run saved job"), so it is never ambiguous which copy runs.

It skips straight to step 4 of § Execution model: no signature check, and — unlike every other trigger — no filter evaluation, because a manual run is the user directly asking "do the action", not simulating an inbound event a filter should judge. It works whether or not the job is `enabled`, since testing an action before switching it on is the common case. Concurrency still applies (§ Concurrency): a manual fire that lands while the job is at its limit queues like any other. The payload is `{ payload: { firedAt: <now, ISO> } }`, the same shape cron fires carry, so an action's mustache template renders the same way it would from a real cron tick; a template referencing fields specific to another trigger type (e.g. a webhook body) renders those as empty, same as any other payload that lacks them.

The fire is dispatched through the same path every other trigger uses, so it is indistinguishable from a real fire once sent: it lands in the same host queue/buffer, and the server records its outcome to `runs.jsonl` with `trigger: "manual"` from what the host reports back, exactly as step 7 describes. There is no separate manual-run log — it's a run like any other, just tagged by how it started.

## Cross-refs

- Notify channels: `09-notifications.md`
- Cross-chat tools (`patch_job_*`): `06-threads-manager-speakers.md`
- CLI surface: `17-cli.md`
- Buffered delivery when host offline: `12-error-and-offline.md`
