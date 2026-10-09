# Hooks

A hook is a user-defined check Patch itself runs on a message, independent of
which backend the chat runs on (Claude Code, Codex). This file covers both
`when` values: `user_message` (a check that runs on what the user is about to
send, before it reaches the agent — § On the user's message) and
`agent_response` (a check that runs on what the agent just sent, after the
turn settles — § On the agent's response). Everything through § Checking a
message — the hook shape, kinds, gate, filter, outcome — is shared by both;
only what happens with the outcome differs.

This is distinct from Claude Code's own hooks, which keep running untouched
inside the harness and are unaffected by anything in this file
(`principles.md`).

## Hook shape

```json
{
  "id": "hook_01HXYZ...",
  "name": "no secrets in the message",
  "enabled": true,
  "when": "user_message",
  "kind": "script",
  "script": { "command": "…" },
  "gate": {
    "hosts": ["d_abc"],
    "folders": null,
    "chatIds": null,
    "specialThreads": false,
    "filter": null
  },
  "timeoutMs": 15000,
  "createdAt": "...",
  "updatedAt": "..."
}
```

Stored at `/data/hooks/<id>.json` on the server, one file per hook — the same
layout jobs use (`08-triggers-and-jobs.md` § Job shape) and for the same
reasons: atomic fsync'd writes, an in-memory cache, a filesystem watcher so a
hook can be hand-edited or kept in a version-controlled checkout, and CRUD
through one `HooksInterface` shared by the REST routes, the CLI and the
cross-chat tools. "Server-owned" (unlike a host's own `~/.patch` config) is
what makes a hook apply identically from every surface: a web edit, a CLI
edit and a direct file edit all reach the one store every host's check
request is answered from.

`kind` is `script` or `prompt`, and the hook carries exactly the matching one
of `script` / `prompt` — never both, never neither. `enabled: false` excludes
the hook from every check without deleting it, exactly like a job.

### `script`

```json
{ "command": "…" }
```

The command is the script, not a path to one (`08-triggers-and-jobs.md` §
Gate) — a multi-line body handed to the chat's own host's shell verbatim, so
every surface renders it as a code editor and nothing kept outside Patch
decides what a hook does. It runs on the chat's own host (never a host named
in the gate — the gate decides WHETHER the hook applies, not where it runs;
see § Gate), as the host's user, in the chat's folder.

The command receives one JSON object on stdin:

```json
{
  "message": "...",
  "chatId": "c_abc",
  "folder": "/path",
  "daemonId": "d_abc",
  "specialThread": false,
  "toolCallsSummary": "Ran 2 commands, read 1 file"
}
```

`message` is the text being judged, exactly as typed/sent: the user's message for a
`user_message` hook, or the agent's full final reply for an `agent_response`
one. `toolCallsSummary` is present only on an `agent_response` check — a
deterministic (no model call of its own) one-line tally of that turn's tool
calls by kind, e.g. the example above; a turn with none reads `"No tool
calls"`. The rest is the same context the gate matched against (§ Gate).

A `user_message` check may also carry `images` — the composer's image
attachments (at most 5, JPEG/PNG/GIF/WebP, base64 with no `data:` prefix, each
already downscaled by the composer). They go only to `prompt` hooks, which are
shown them as images ahead of the message text; a `script` hook's stdin stays
text-only. Non-image attachments are not sent. An image that can't be sent
(unsupported type, too large, too many) fails the check — it is never silently
dropped. `agent_response` checks carry no images.

### `prompt`

```json
{
  "instructions": "Block anything that looks like a secret or credential.",
  "model": "claude-haiku-4-5-20251001"
}
```

`model` is any model from the chat's own host's catalogue (`02-daemon.md` §
Model catalogue) — the same catalogue a job's `action.model` is validated
against (`08-triggers-and-jobs.md` § Action). Patch runs the check itself, as
a single tool-less turn on whichever backend that model belongs to (Claude
Code or Codex) — not a separate paid API call, and not a turn in the user's
own chat: nothing it does is visible in the transcript, and nothing it reads
can be more than it is handed. It is handed `instructions`, the message (the
agent's reply, plus `toolCallsSummary`, for an `agent_response` check), and
the chat's recent turns (the last 20 events of the transcript, user and
assistant, text only — no tool calls, no attachments), and must answer with
the structured outcome (§ Outcome). A reply that is not that shape is a
**failed** run, exactly as a script's malformed stdout is (§ Outcome) — never
silently read as pass.

## Gate

Which chats a hook applies to, matched before the hook ever runs — the same
split job triggers use between a structural gate and a payload `filter`
(`08-triggers-and-jobs.md` § Gate, § Filter), reapplied here to a hook instead
of a fire:

```json
"gate": { "hosts": ["d_abc"], "folders": ["/home/tom/projects/bus"], "chatIds": ["c_abc"], "specialThreads": false, "filter": "$contains(message, 'password')" }
```

`hosts`, `folders` and `chatIds` are each an optional allow-list — null or
absent means no restriction on that axis, and a chat matches only when it
clears every axis the hook sets. There is no deny-list: a hook that should
run everywhere except one place is written with a `filter`.

`specialThreads` decides whether the hook reaches Manager and
Speakers (`06-threads-manager-speakers.md`) at all. Absent or
`false` — the default — means ordinary chats only; `true` means special
threads only; a hook never silently applies to both kinds with no way to
tell them apart, so a hook meant for both is written as two.

`filter` is the same optional JSONata expression a job's `filter` is
(`08-triggers-and-jobs.md` § Filter), evaluated server-side against
`{ payload, now }` where `payload` is the context object (§ `script` above,
plus `message`). A hook with no filter matches every chat that clears its
other axes.

## Outcome

A run — script or prompt — answers exactly one of:

```json
{ "decision": "pass" }
{ "decision": "advise", "analysis": "...", "suggestion": "..." }
{ "decision": "block",  "analysis": "...", "suggestion": "..." }
```

`analysis` is required on `advise` and `block` — the reader must be told why.
`suggestion` (a rewritten message) is optional on both.

A **script** hook reports this on stdout as JSON; **exit 0 with empty
stdout** is shorthand for `pass`, the common case, so a hook that only ever
blocks never has to print `{"decision":"pass"}` on its way out. Any other
exit code, or stdout that is non-empty but not this shape, is a **failed**
run, never a silent pass — the same reasoning a job's gate uses for a bare
`exit 1` (`08-triggers-and-jobs.md` § Gate: "a hold must say why"), because a
hook that broke must never read as a hook that approved.

A **prompt** hook reports the same three shapes as its structured reply.

A run that does not answer inside `timeoutMs` (default 15000, ceiling 60000) is also a **failed** run, carrying a timeout reason rather than a
decision.

## Checking a user_message

`POST /api/hooks/check { chatId, message }` — called by a surface before it
sends a `chat.input`, never by the agent. The server resolves the chat's
host, folder and whether it is a special thread, finds every enabled
`user_message` hook whose gate matches, and dispatches each to the chat's own
host in parallel (`hook.check_request` / `hook.check_result` over the
daemon-link, `03-wire-protocol.md` § Hooks), each bounded by its own
`timeoutMs`. The response is every matching hook's outcome:

```json
{
  "decision": "block",
  "results": [
    {
      "hookId": "hook_...",
      "hookName": "...",
      "status": "ok",
      "decision": "block",
      "analysis": "...",
      "suggestion": "..."
    }
  ]
}
```

`decision` is the response's own aggregate: `block` whenever any result is a
`block`; else `advise` when any result is an `advise` **or** failed/timed
out (a failed hook never holds the message, but is never silently equivalent
to a pass either); else `pass`. A hook must never block a send except by a
genuine `block`. `results` carries every matching hook's own outcome —
including its own `status` — so a client can tell a genuine block from a
broken hook and render each one's card correctly, and a block from one hook
is shown alongside an advise from another rather than the other's note being
lost.

A chat with no matching hooks — the common case, nothing configured — returns
`{ "decision": "pass", "results": [] }` with no dispatch at all. So does a
`chatId` the server holds no row for yet — a brand-new chat's first message,
sent before `chat.spawned` has landed — since there is no host or folder yet
to match a gate against; the first REAL check for that chat is its second
message.

## Checking an agent_response

No surface asks this one — a turn settling has no composer waiting on it, so
the HOST starts it the moment the turn settles (special threads included;
the hook's own gate decides whether it applies — § Gate), carrying the
agent's full reply and a deterministic tool-call tally the host already has
without a round trip:

```
hook.agent_response_check_request  (daemon → server)
{ daemonId, chatId, checkId, folder, specialThread, reply, toolCallsSummary }
```

The server resolves every enabled `agent_response` hook whose gate matches —
same `hookMatches`/`HookRunner` the user_message path uses, just filtered on
`when` — and dispatches each to that SAME host with the ordinary
`hook.check_request` / `hook.check_result` pair (`03-wire-protocol.md` §
Hooks), `reply` standing in for `message` and `toolCallsSummary` riding
alongside it in `context`. It reports every result back in one frame,
unaggregated — the host decides what each means (§ On the agent's
response), not the server:

```
hook.agent_response_outcome  (server → daemon)
{ daemonId, chatId, checkId, results: HookRunResult[] }
```

`checkId` is minted by the host and echoed back, so a slow round-trip
answering a check a NEWER turn has already superseded is recognisable and
ignored — only an outcome whose `checkId` matches the chat's own
currently-outstanding one is acted on. No surface ever sees either frame;
both are host ↔ server only.

## On the user's message

- While the request is in flight the composer shows **Checking…** in place of
  the send button's idle state, disabled, so a wait is never a silent one.
  Hooks run in parallel server-side, so this is bounded by the slowest
  matching hook's own timeout, not their sum. The client also gives up after
  20 seconds if the server never answers. Whenever the check itself can't
  complete (timeout, 502/503/504, any request error, an unprepareable image)
  the message is sent anyway with a "Hook failed: <reason>" note attached,
  never a bare status code and never a held message. Which hooks matched is not known
  client-side until the response lands — the card/note that follows is where
  each hook is named.
- **Pass** (every result is `pass`): nothing shows. The message sends exactly
  as if there were no hooks.
- **Advise**: the message sends. A small note is attached to it in the
  transcript, naming the hook(s) that advised, expandable to each one's
  `analysis`.
- **Block**: the message is **not** sent. It stays in the composer, and a
  card above it shows the blocking hook's name, `analysis` and `suggestion`
  (when one is given), with three actions:
  - **Use suggestion** — replaces the composer's text with `suggestion` and
    closes the card. The user still has to send it themselves; this is not
    an auto-send.
  - **Edit** — closes the card, leaves the composer text as the user left it.
  - **Send anyway** — sends the message as originally typed, skipping only
    the hook(s) that blocked THIS send. The skip is per-message: the next
    message the user sends is checked against every hook again, including
    the one that was overridden.
  - A card with more than one blocking hook stacks them; Send anyway skips
    all of them for this one send.
- A hook that **failed or timed out** does not hold the message: it sends,
  with a "Hook failed: <error>" note attached like an advise. A broken hook
  is exactly as visible as a working one, but never in the way.
- Checking is per-message, not per-keystroke: it runs once, when the user
  commits a send, not while they are still typing.

## Never reaches the agent

An `advise` outcome (`user_message` hook) is attached to the sent message on
the surface that sent it, for that surface's own session — it does not ride
the wire into the persisted transcript, so it is not there after a reload and
is not visible from another surface. None of it is EVER sent to the agent, on
any surface: the agent's turn is built from whatever text the user actually
sent (the original message, or a suggestion they chose to use), with no
mention anywhere in its context that a hook ran, passed, advised or was
overridden. A hook judges the user, not the agent, and the agent is never
told it was judged.

## On the agent's response

Runs when a turn settles (`checkAgentResponseHooks`, `chatRunner.ts`), on the
agent's side, quietly — for the agent, not the user, and unlike § On the
user's message there is no composer waiting, no Checking… state, nothing
blocking a send.

- **Pass** (every matching hook's result is `pass`): nothing happens. No row,
  no log beyond the ordinary one.
- **Block**: the host fires a fresh turn carrying the blocking hook's own
  `analysis`/`suggestion` as its actual message text — `origin: 'machine'`
  (spec/09 § Whose turn it was: no completion doorbell, same as a self-wake
  or the todo auto-advance) and `hookTrigger` on the resulting `chat.message`
  (spec/03-wire-protocol.md § Hooks), which is what tells a surface to render
  it as transcript furniture (04-chats-and-folders.md § Turns a hook
  resubmits) rather than a user bubble. `fromUser` is never set — a hidden
  chat stays hidden (spec/04 § Hidden), a hook resubmitting is exactly as
  quiet as a job's own fire into it. More than one hook blocking the SAME
  turn combines into one resubmit naming each.
- **Advise**: no redo. The analysis is deferred — carried as a
  `<system-reminder>` block (spec/02-daemon.md § System-reminder disclosure)
  prepended to whichever turn the chat runs NEXT, whatever kind that turns
  out to be (a person's reply, a job's fire, another hook's own resubmit),
  consumed once the moment that turn is accepted. The row is a sibling
  disclosure under THAT turn once it lands, labelled "Hook advice" — not its
  own standalone row, and not forced into existence by the advise itself.
- **The row is visible and is what the agent receives.** Nothing here is an
  invisible injection (`principles.md`): a block's resubmit IS the hook's own
  words, verbatim, as the turn's real content; an advise's reminder is
  exactly what the disclosure shows, because the disclosure is built FROM the
  text actually prepended to the prompt (same mechanism as every other
  leading `<system-reminder>` — `history.ts`'s `extractSystemContext`).
- **Loop guard**: `consecutiveHookBlocks` counts block-resubmits in a row with
  no genuine (non-hook) turn in between, reset to 0 the instant one lands.
  At `HOOK_BLOCK_LOOP_LIMIT` (3, declared in `chatRunner.ts` — not
  configurable; the point is a ceiling a hook cannot talk its way past) the
  host stops resubmitting and declares the chat's status instead
  (`statusKind: 'report'`, the same self-chosen sidebar state
  `04-chats-and-folders.md` § Current status describes), carrying the last
  blocking analysis — surfacing it in the "needs attention" list
  (`14-design-web.md` § Sidebar) rather than looping forever.
- **Hidden/job chats**: a block resubmits exactly the same way — nothing
  about `agent_response` hooks distinguishes a hidden or job-owned chat from
  an ordinary one, since the gate (§ Gate) is what decides whether a hook
  applies, not the chat's own visibility. Only the loop guard tripping
  surfaces it (declaring a status is itself a `needs attention` claim,
  regardless of Hidden membership).
- **A hook that fails or times out**: never resubmitted — a broken hook must
  not force the agent to redo work it never earned, unlike a `user_message`
  hook's failure (which holds a send that hasn't happened yet and costs
  nothing to hold). Not silent either: it defers exactly like an `advise`
  (same `<system-reminder>` carry, same next-turn disclosure), labelled "Hook
  failed" instead of "Hook advice" and naming the error in place of an
  analysis. A batch that mixes a failure with a genuine `advise` reads under
  the failure's own label — the less usual fact wins.
- Works identically on a Claude or a Codex chat — nothing here is gated to
  one backend the way the AI-generated "current status" summary is; a
  `script` hook has no model in it at all, and a `prompt` hook's `model`
  already names which backend answers it (§ `prompt`).

## CRUD

- Web/desktop (`14-design-web.md` § `/settings` details — Hooks): list, add,
  edit, enable/disable, delete. Mobile mirrors it (`15-design-mobile.md` §
  Hooks).
- CLI — the `patch message-hooks` family (`17-cli.md` § Commands), REST-only
  (there is no host-side UDS mirror for hooks the way jobs has one) — a
  chat manages its own hooks by shelling out to it, same as a human would.
- Direct file edit — server watches `/data/hooks/`.

Nothing ships preinstalled: an account with no hooks configured checks
nothing and pays no latency on send.

## Cross-refs

- Jobs' gate/filter model this reuses: `08-triggers-and-jobs.md` § Gate,
  § Filter.
- Wire events: `03-wire-protocol.md` § Hooks.
- Composer card, message note, agent-response collapsed row, Settings →
  Hooks: `14-design-web.md` § Main chat panel, § `/settings` details.
- Mobile: `15-design-mobile.md` § Hooks.
- CLI: `17-cli.md` § Commands.
- Turns a hook resubmits/defers onto: `04-chats-and-folders.md` § Turns a
  hook resubmits.
