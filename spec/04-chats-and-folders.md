# Chats and Folders

## Chat model

A chat is one agent session pinned to a host and a folder on that host. Analogous to running an agent CLI inside that folder on that machine, except the session is persistent, routable, and observable from other surfaces.

- Identity: `chatId` (ULID, prefix-matchable like Happy's session IDs).
- Host: `daemonId`, chosen at spawn alongside the folder, and changed only by moving the chat (§ Moving a chat to another host). A chat on an offline host stays visible and readable, and a message sent to it queues and delivers when the host reconnects, and the server keeps it on disk meanwhile so a server restart does not lose it (`12-error-and-offline.md` § Host-offline UX). Spawning a new chat on an offline host is refused up front instead, since its folder cannot be validated (§ Spawn).
- Name: short human-readable label for the sidebar. AI-summarised from the chat's first user message — as soon as that message is accepted (not once the turn settles), the host fires a cheap one-shot model query (`claude-haiku-4-5-20251001`) over it (a Codex/ChatGPT chat is titled on its own model, like its goal check, since a Codex-only host has no Claude account) and stores the resulting 2–6-word Title-Case summary in `meta.json.name`. Triggered ONCE per chat, asynchronously and non-blocking, so a long-running turn never delays the title landing, and only for ordinary chats (special threads keep their fixed names). A job-spawned chat gets exactly this one user message and no other, so that single trigger gets two real attempts (a short delay apart) before giving up — a transient SDK error or empty first reply must not permanently strand it as "New chat" with no later message able to retry it. Until a title lands — or once both attempts fail/return empty — `name` stays `null` and the surface shows "New chat" (never the folder basename: two chats in one folder would then carry the same title, and it reads as a real name rather than as "not named yet"); the title comes only from the summariser, so a raw `[Attachments]` path stays out of it. Renameable from any surface: a rename stores the name in `meta.json.name`, and clearing it to empty stores `null` so the surface goes back to "New chat". Because the summariser is only triggered over a chat whose `name` is still `null`, a rename is never overwritten — including one made before generation lands. Special threads are not renameable.
- Current status: what a chat IS to the user, carried on `chat.state` as `statusKind` + a one-line `statusSummary` and rendered under the sidebar title. Three kinds put a chat in the list and one keeps it out — `question` (blocked on the user: an answer, a decision, or a thing only a person can do in the world), `report` (not blocked, but the agent has elected to say this is worth seeing) and `complete` (finished, nothing outstanding — a hidden job that ends `complete` does not come into the list; it stays in Hidden, § Hidden). A permission prompt is the fourth way into the list but is not a kind: it is a live request derived from `pendingPermissions`.

  **Generated vs declared.** Most statuses are GENERATED: a cheap model summarises the settled turn, and the pair is in-memory only, cleared the instant another user message is accepted (including one queuing behind a running turn) so no surface shows a status predating the message on screen. A `question` or `report` set by the agent's own tool call — `patch_ask_human`, `patch_report` — is DECLARED, and is a different kind of fact. It is persisted to `meta.json`, so it survives the host restart every deploy performs; it outranks the generator, which may not overwrite or demote it; and it is cleared by a USER turn and nothing else, because a machine turn is the chat carrying on, not evidence anybody read it. Declaring also takes the chat out of Hidden (and out of Archived), one-way.

  **A notification brings its chat into the list.** `patch_notify` takes its source chat out of Archived and out of Hidden, one-way, exactly as a permission prompt does: a chat that reached for the user must be findable when they come looking. It does not set a status — the row carries no `statusKind` — so it is a way into the list, not a claim that the chat is blocked or worth reading. A chat that wants to stay hidden does not notify.

- Lifecycle: chats run forever in storage, and history is retained. The UI inbox treats them as unread / read / archived (see `14-design-web.md` § Chat lifecycle): new activity → unread (`·`); user visit → read (`✓`, subtly greyed). Read is user-driven only. There is no auto-archive — a chat stays in the active list until it is manually archived (the chat header's archive icon or the sidebar row's archive button).

  **Archived means stopped.** Archiving is how the user says "this is finished", so an archived chat never runs anything: archiving stops the running turn (as Stop does, including any permission request it is parked on), drops every queued message, cancels its pending self-wake, stops every `patch_watch` task it owns, and abandons any turn parked waiting out a usage limit or a retry backoff — on EVERY branch the chat has, not only the active one (§ Branching § Parallel branches): a side branch mid-turn is stopped and its own queue dropped right alongside the active branch's. Nothing the chat set in motion fires afterwards, so nothing the chat did can bring it back. A chat that is working in the background without bothering the user is not archived — it is hidden (below).

  Archive is sticky against being merely opened or resumed: an archived chat stays archived when it is opened, resumes after a restart, or sits idle. But a MESSAGE landing in it starts it again, from any sender: the user's own composer, a job tick into a `continue` chat, or another agent's `patch_send_to` all un-archive the chat before the turn runs. It comes back to where it was before it was archived: a chat that was hidden (§ Hidden) returns to Hidden, unless the message is the user's own, which brings any chat into the active list. Un-archiving is one-way: nothing re-archives the chat afterwards except archiving it by hand again (the chat header's or sidebar row's archive icon, or the chat-panel banner's Unarchive control for un-archiving without sending anything). Archiving the chat you are currently reading moves you on with it: the chat leaves the active list and the surface opens the next chat in the sidebar's drawn order — the row that was below it, the nearest row above it if it was the last one, or the top of the list if it had no row of its own (a snoozed chat, say), and the new-chat screen when nothing active is left. This holds however that chat was archived (its header icon, its sidebar row, the keyboard shortcut, or a bulk/project archive that included it); unarchiving never navigates. Deleting a chat is a recoverable soft-delete — it moves to a Deleted section and can be restored (nothing is hard-deleted from the surface).

- Snooze: a chat can be snoozed until a moment in time (Gmail's snooze). Snooze is a separate axis from `status` — a snoozed chat is still `active`; it carries a `snoozedUntil` ms-epoch timestamp. While `snoozedUntil > now` the chat is hidden from the active list and appears in the sidebar's Snoozed section with its wake time. When `snoozedUntil` passes, `snoozedUntil` clears itself and the chat returns to the active list unchanged (same unread/read state, same `lastUpdated`, so a snooze leaves the chat's activity as it was). See § Snooze below.
- Hidden: a chat can be hidden — running, but out of the active list. Like snooze it is a separate axis from `status`: a hidden chat is `active`, carries `hidden: true` on `chat.state` (persisted in `meta.json`), and is drawn only in the sidebar's Hidden section. It is how a job whose runs are background noise keeps them out of the way (the action's `startHidden`, `08-triggers-and-jobs.md` § Action), and it is the opposite of archived: a hidden chat is expected to be doing something, an archived one never is. A chat leaves Hidden, one-way, when the user needs to see it or has chosen to: a USER message sent into it, the agent declaring a `question` or `report` (§ Current status), or it blocking on a permission decision or an `AskUserQuestion` (`02-daemon.md` § Permission mode), so a request nobody can see cannot sit unanswered. Everything else — a self-wake, a watch completing, a job tick, another agent's `patch_send_to`, the todo list advancing, a turn re-sent after a usage limit — leaves it hidden. The Hidden section's row (and the hidden chat's banner) carries Unhide, which un-hides without sending anything (`chat.hide_request { hidden: false }`). Archiving a hidden chat stops it like any other but leaves `hidden` set: it has no effect while the chat is archived, and it is where a machine message starting the chat again returns it to (§ Lifecycle). A hidden chat that FINISHES stays in Hidden: nothing archives a chat automatically, so a job's chat is never in Archived unless a person put it there, and a `patch_ask_human` or `patch_report` from it reaches the user by moving it from Hidden into the list (the one-way exit above) rather than out of Archived. Its next message starts it again, hidden unless the message is the user's. Special threads cannot be hidden. The user hides a running chat from the chat header's ⋯ menu (web) or the row's long-press sheet (phone) — `chat.hide_request { hidden: true }` — and the AGENT is told: the next turn is prefixed with a one-shot `<system-reminder>` saying the chat is now in hidden mode (or, when it leaves Hidden, no longer in it), the way a surface's edit to the task list is. Hiding then showing before that turn says nothing.

  Chats archived before hidden existed (2026-09-28) that still own live work — a pending self-wake, a running watch or an owed turn — are moved to Hidden when the host loads them, since under the old rules archived meant out of the way, not stopped.

- Pinning: `folder` is set at spawn and holds for the chat's life.
- Many per folder: each `cd ~/projects/x && patch new` creates a fresh chat in that folder. Projects are just folders with ≥1 chat.
- Subagent: a chat created by another chat's `patch_delegate` carries `meta.subagent: { parentChatId, label, outcome? }` for its whole life — never cleared, never on any other chat. Its record lives exactly where every other chat's does (`~/.patch/chats/<chatId>/`); the field is what makes it a subagent rather than a separate storage shape, and what every listing (this section, search, `patch_list_chats`, the sidebar) excludes it on. Full lifecycle/durability/permissions contract: `02-daemon.md` § Native subagent dispatch.

## Spawn

Caller provides:

- `daemonId` — the host to run on. Required. A spawn naming an unregistered host
  is an error, and one naming an offline host is rejected up front with the host
  named.
- `folder` — absolute path on that host. Paths are scoped to their host: the same
  string on two hosts means two different directories.
- `model` — optional, and from that host's catalogue (`02-daemon.md` § Model
  catalogue). The chat starts on the model named here, or on the host's last-used
  model when it is omitted, and can be changed later (§ Model). It selects the
  backend the chat runs on. A host records the model of each chat spawned on it,
  so the last-used value follows the machine rather than the surface that asked,
  and a host carries one from its first successful catalogue read (`02-daemon.md`
  § Agent backends) — so a spawn on a newly added host needs no model. Until a
  host has read a catalogue it has none, and a spawn there that names no model is
  an error saying so.
- No Claude account is named, and a chat has none. Which of the host's stored
  keys a turn runs on is the host's decision, taken afresh for every turn, in
  the stored order (`10-auth.md` § Backend credentials).
- `prompt` — optional initial prompt.
- `parentChatId` — optional, for spawns from a special thread (tracked for observability).

Daemon:

1. Generates `chatId` (ULID) and validates the folder exists on this host.
2. Calls the SDK: `query({ prompt, options: { cwd: folder, mcpServers: { patch: ... }, permissionMode: <the chat's mode>, resume: undefined } })` — the chat's mode is as `02-daemon.md` § Permission mode describes; see `02-daemon.md` for the MCP wiring.
3. Iterates the SDK's async result stream. The SDK emits a `result` message containing `session_id` early in the run; host captures it as `claudeSessionId`.
4. Writes `~/.patch/chats/<chatId>/meta.json` (chatId, claudeSessionId, folder, createdAt, name=null until first turn finishes).
5. Pipes the SDK's message stream into our wire protocol (`03-wire-protocol.md`).
6. Emits `chat.spawned`.

A refused spawn creates no chat, and leaves no trace of one on any surface. The
refusal is reported against the `chatId` the spawn was allocated, and a chat-scoped
error reaches every connected surface — but a surface builds a chat row out of any
`chatId` it has not seen before, so the refusal alone would draw a nameless,
folderless row for a chat that does not exist and never will (it is absent from the
chat list, so nothing later corrects it). The refusal therefore also names that
`chatId` back to the caller as one to retract, and the caller drops the row.
Retracting is idempotent and final: a duplicate or late-arriving error for a
retracted chat does not redraw it, since the error frame and the refusal travel
separately and can arrive in either order. The user still sees the failure once
(`12-error-and-offline.md` § Principles) — the row goes, the error does not.

## Model

A chat's model can be changed at any point in its life, from any surface
(`14-design-web.md` § Model selector). The host owns the value and persists it
with the rest of the chat's state, so a change outlives a host restart instead
of quietly reverting to whatever the host was last used on.

A change takes effect on the chat's NEXT turn. Each turn is its own call to the
backend resuming the same session, and the model in force is read as the turn
starts, so a change made while a turn is running leaves that turn alone. The
surface says which turn the change applies to rather than implying the running
one switched.

The model named must be one the host's catalogue currently offers (`02-daemon.md`
§ Model catalogue). One that isn't is refused naming it, and the chat stays on
the model it was already running — never rounded to a near match. Because a model
selects its backend, a change can move the chat onto a different backend; the
session resumes there on the next turn.

Changing a chat's model does not change the host's last-used model. Last-used
records what new chats start on, and a mid-chat change is scoped to the one chat
it was made in — repointing every future spawn from it would be a change the user
did not ask for and cannot see.

The host reports the chat's current model in the chat's state, so every surface
holding that chat converges on it: two windows open on one chat always agree
about which model it is on.

Also reachable as a composer built-in: `/model <name>` typed in the composer
changes the chat's model the same way the picker does, without opening it —
matched case-insensitively against the host's catalogue by id or label,
uniquely-abbreviated names accepted (e.g. `/model opus` where only one
catalogue entry contains "opus"). A bare `/model` or a name matching nothing
or more than one entry is a usage error naming the problem, and no change is
sent. Unlike the picker, `/model` never shows the cross-provider cost warning
(§ Provider switches) — typing the exact model is already the deliberate act
the warning exists to slow down.

### Provider switches

A model change that crosses harnesses (Claude ↔ Codex) is seamless: the next
turn reconstructs the chat's own track (`## History`) as a native session on
the new harness — no pasted handoff block, no summary. The target gets the
real conversation and resumes into it exactly as if it had been running there
all along. A `chat.message` with `role: 'system'` and a `sessionChange` field
marks where the switch happened — a quiet divider in the transcript, not an
alarming notice.

Riding the cache: a return to a harness this track used BEFORE resumes ITS
OWN prior session (the SDK's `SessionStore` mirror for Claude,
`thread/resume` + `thread/inject_items` for Codex) and hands over only the
delta — what happened elsewhere since the switch away — rather than
rebuilding the whole track from scratch. The track remembers, per branch,
which session it last had on each harness and how much of the track that
session already had (`harnessSessions`); a harness this track has never run
on, or whose prior session is genuinely gone, gets the full reconstruction
instead. Reconstructed entries are deterministic — the same track
reconstructed twice produces byte-identical output — so the target's own
prompt cache still covers everything up to the switch: only the delta is new,
uncached input.

The picker confirms a cross-provider switch before it happens — "Switching
provider may cost more due to lack of a cache, are you sure?", Cancel /
Switch, and a "don't show again" checkbox — never for a same-provider model
change. "Don't show again" is an account-level setting
(`suppressProviderSwitchWarning`, synced from the server like every other
account preference), so it holds on every surface once set; Settings has a
toggle to bring the warning back.

An optional cheap path for a huge chat, reachable via the API only (no button
in any surface yet): the outgoing session writes its own handoff — resumed,
not re-fed from scratch, so it rides that session's own cache — and the
target starts from the handoff plus the last few turns instead of the full
reconstruction. No fallback: if the outgoing session can't produce a handoff,
the switch fails loudly rather than silently doing the full reconstruction
instead — the user asked for the cheap path specifically.

## History

- Location and format: a chat's own record is `~/.patch/chats/<chatId>/events.jsonl` — an append-only log, one record per message, tool call, result, artifact, permission decision, and turn or session boundary, independent of any harness (`principles.md` § History ownership). A tool result too large to keep inline, or one carrying an inline image, is moved out of line into a content-addressed blob store and replaced by a reference. The harness's own native session history (`~/.claude/projects/<encoded-folder>/...jsonl` for Claude) still exists on disk, but is a resumption cache the harness reads from, not the record.
- Access: surfaces request via `chat.replay {chatId, fromSeq, branchId?}` (WS, `fromSeq` exclusive) or `GET /api/chats/:id/history?since=<seq>&branchId=<id>` (HTTP, `since` inclusive). Both take an optional `branchId` — absent means the chat's active branch — and this is how the Side threads panel (`14-design-web.md`, `15-design-mobile.md`) pulls a tab's content: a side branch's messages are not broadcast live (§ Parallel branches), so the panel reads them through this path instead, polling the HTTP route while the branch is `running` and once more on open otherwise. The host reads a chat's active track straight from its own log — no merge with any harness transcript needed, since the log already carries live and historical events in one place, in the order they were shown. A branch's track is its own records plus its ancestors' up to (and, for a side thread, including) the message it forked from — an edit fork excludes the edited message itself, since the fork provides its own replacement. The two cursors above use deliberately opposite boundary conventions — see `12-error-and-offline.md` § Replay vs history cursors before mixing them.
- A failed turn is a quiet system note on replay, never the harsher live `chat.error` — the log never carries `chat.error` itself (it isn't a lasting fact about the chat, unlike the turn's own outcome).
- Command turns: the agent does not persist a slash-command invocation as sent. It records the command name and its arguments separately, with the arguments trimmed and the separator that followed the name discarded, plus the command's own expansion and output as further turns. A replay therefore reconstructs the invocation as `/name args` and drops the expansion and output turns, so history shows what was asked and not the command's internals. The host emits the live user message for such a turn in that same reconstructed form: the live event and its persisted copy must be one payload identity, or the turn has two, its persisted copy gets a newly allocated `seq` instead of the one it was emitted at, and it replays out of order and twice.
- Injected turns are not history: Claude Code persists CLI-injected prompts into the same JSONL as real turns, flagged `isMeta: true` — most visibly "Continue from where you left off.", which the CLI injects on its own when it resumes a transcript whose last turn was interrupted or that has a deferred tool. These are plumbing, not conversation: the host drops every `isMeta` entry when reading a transcript, so a replay shows only messages the user sent. A genuine user turn that happens to contain the same text is not flagged and replays normally. The harness answers its own injected prompts too, and those replies are persisted as ordinary assistant entries carrying only the synthetic marker (`02-daemon.md` § Per-turn process / warm sessions) — they are dropped on the same terms, by that marker and never by their wording, so a reply quoting it still replays.
- Retention: infinite. No pruning.
- Encryption: none. Host disk is considered trusted. See `10-auth.md`.

## Resume

The SDK runs in-process. If the host stays up, an idle chat is just an in-memory state object waiting for the next message — no reattach needed.

If the host restarts, in-flight queries are lost. On restart, the host scans `~/.patch/chats/*/meta.json`, marks every chat as `idle`, and on the next user input for a given chat passes `options.resume = meta.claudeSessionId` to `query()`. The SDK rebuilds context from the agent's native session history.

If `meta.claudeSessionId` is missing, the turn starts a new session and runs. This is not lost work and it is not an error: the chat's history is Patch's own, in `~/.patch/chats/<id>`, and a turn killed mid-flight is held in `pendingTurns`. The session id is a pointer into the provider's context cache — useful, and not the record. Nothing is written into the transcript about it; a chat is not the place for plumbing notices.

Refusing instead — marking the chat `errored` and waiting for the user to re-send — is no recovery for an unattended chat. A job's `continue` action resolves to the same durable chat on every fire, so the refusal is permanent: the work is never done and the only trace is a line in a run log.

An invalid (unresumable) session id is cleared the same way, rather than hanging on a phantom resume.

## Moving a chat to another host

A chat can be moved to another machine, into a folder on that machine — usually
the same project checked out at a different path. Web (chat header ⋯ → Move to…),
mobile (chat ⋯ → Move to…, a pushed page) and the CLI (`17-cli.md`) all call
`POST /api/chats/:id/move {daemonId, folder}`, which answers once the move has
finished or failed.

- The picker lists the other machines (offline ones disabled), then the chosen
  machine's own folders; the one with the same name as the chat's current folder
  is pre-selected, else the first folder that machine offers, so choosing a
  machine never leaves the folder for the user to pick; the field is empty only
  when the machine offers no folder. Any absolute path can be typed.
- The server drives three steps, each one `patch.chat_move.request` to one host
  (`03-wire-protocol.md`): `export` on the chat's host, `import` on the target,
  `retire` on the old host, then points its chat mirror — and so all routing —
  at the new host. The target announces the chat with `chat.spawned` +
  `chat.state`, which is how every surface learns its new host and folder.
- What moves: the chat's `~/.patch/chats/<id>/` directory (history log, meta,
  native session mirror), the blobs its log references, the attachments its turns
  carried with their manifest entries, and the harness's own transcript for each
  of its sessions. Every record of the old folder as a session's working
  directory is rewritten to the new one, so the next turn resumes the SAME
  session in the new folder — no reconstruction, no summary. Content that merely
  mentions the old path (tool output, messages) is history and left alone. The
  project's own files are not moved.
- An errored chat arrives ready for its next turn; turns it owed on the old host
  are not re-run.
- Refused, naming why and leaving the chat where it was: a chat mid-turn or
  awaiting a permission, one with a self-wake armed or a watch running (both
  belong to the old machine), a special thread, a chat on a Codex session, a
  target folder that isn't a directory there, a target that already has the
  chat, and a chat over 48 MB on disk.
- From `export` until `retire` the old host refuses new turns for the chat. An
  import that fails sends `release`, which lifts that and leaves the chat as it
  was. A retire that fails after a good import still counts as moved (the new
  copy is live, the old one takes no turns) and the reply says the old copy
  remains.
- The old host keeps the retired chat's directory under `~/.patch/moved/`
  rather than deleting it.

## chat_state (live)

Separate from history. Held in host memory, exposed via `patch_peek`:

```typescript
type ChatState = {
  chatId: string;
  name: string | null; // sidebar label
  activity: 'idle' | 'running' | 'awaiting-permission' | 'errored';
  lastMessages: Message[]; // last N, configurable, default 20
  lastUpdated: ISO8601;
  folder: string;
  eventCount: number; // everything this chat has ever emitted
  hasClaudeSession: boolean; // does the model still remember any of it?
};
```

Not persisted. Rebuilt from tailing history on host restart.

`eventCount` and `hasClaudeSession` are there because the `events` slice
`patch_peek` returns alongside this is a ring held in memory by the running
host process: a chat hydrated from disk and not touched since returns NONE of
its history, which reads as an empty chat when it is nothing of the sort. These
two are read from the chat's own state, so they hold whether or not the ring is
warm — `eventCount: 23, hasClaudeSession: false` is the entire diagnosis of a
chat whose session has been lost. For the same reason `truncated` is true
whenever the chat has emitted more than the slice contains, a cold ring
included.

Activity is driven entirely by events relayed from the host. If the host↔server link drops while a chat is in flight (`running` / `awaiting-permission`) — host restart, network blip, deploy churn — the turn-completion event does not arrive, and the chat would otherwise spin forever. On `daemon.offline` the server resolves that host's in-flight chats — and only that host's — to `errored` for subscribed surfaces: it emits a `chat.error` (code `daemon_unavailable`, message "Connection to the host was lost. Message will resend.") plus a `chat.state` flipping `activity` to `errored`, mirroring the host's own error path, so the failure is visible as an error rather than a stuck spinner. Chats on other hosts are untouched. On reconnect the host is source of truth again: a turn the host was still running carries on and reports its own completion, and a turn a host restart killed is re-sent by the new host (`02-daemon.md` § Host restart behaviour). Either way the chat recovers without the user resending anything, so the message says so rather than asking for a resend. And because it does recover, the notice goes away with it: `daemon_unavailable` is the one chat error that describes a passing condition of the link rather than the outcome of a turn, so a surface DROPS its error entry — and the `errored` activity with it — the moment the host speaks for that chat again with any activity other than `errored`. That is the only thing that clears it. Not a timer, and not `daemon.online` on its own: a host coming back says nothing about whether this chat's turn did. If the host never returns, no such event arrives and the error stands. Every other code — `sdk_error`, `claude_oauth_missing`, `claude_session_missing` and the rest — records a turn that really failed and is never cleared by anything but the user acting on it. See `12-error-and-offline.md`.

## Stopping

`patch chats stop <id>` calls `.close()` on the SDK query (interrupts in-flight tool calls and the model turn). Chat metadata is retained; a later message resumes the chat via `claudeSessionId` automatically. A chat is either running a turn (`running`) or not (`idle` / `errored`). The stopped turn raises no completion notification (`09-notifications.md` § A turn the user stopped).

## Message queueing

Parity with the agent's type-ahead: a user can keep sending messages to a chat that is already `running` a turn. The host queues input behind the in-flight turn and runs queued turns serially, in arrival order, once the current turn finishes.

- Server-run queue. For a host that reports `serverQueue` on `daemon.host`, a message a surface sends behind a running turn is held by the server, not the host. The server acknowledges it (`chat.input_ack`), announces it (`chat.queued`) and keeps it in `/data/server-queue.json`, so the queue survives a host restart and a host being offline. The server decides when it goes in: at a tool boundary the host asks (`patch.queue_pull.request`) and takes everything waiting, in order, behind whatever the host itself holds; when the chat goes idle the server sends the next message as a plain `chat.input` and reports the chat as still running until the queue is empty, since an idle report between two queued turns would read as finished. Cancel, edit and send now (`chat.unqueue_request`, `chat.edit_queued_request`, `chat.promote_request`) act on the server's queue when the message is there and go to the host when it is not. Send now stops the running turn and leaves the order alone. A side-branch message, a voice-device message, and a message to a chat whose host is offline or does not report `serverQueue` go to the host as before, which keeps its own queue for turns it starts itself (a goal resubmit, a self-wake). The host takes the server's answer for no longer than two seconds; without one the turn carries on and the message goes in when the chat idles. Archiving a chat drops what the server holds for it.
- Host model. Each chat has a FIFO turn queue drained by a single per-chat serial pump. The pump owns execution for both a fresh idle turn (`chat.input` when idle) and a spawn's initial prompt, so input arriving during the spawn turn queues correctly too. At most one query is in flight per chat.
- Activity across a drain. A chat reports `running` continuously from its first turn starting until its queue is empty. A turn that settles with turns still queued behind it does not report `idle` — the pump starts the next one immediately, and a chat that blinks `idle` mid-queue is read everywhere as having finished: the Manager sweep (`06-threads-manager-speakers.md` § The sweep) can raise it as a candidate, and surfaces flash a done badge, while it is still working. The chat's status summary and its todo auto-advance (`02-daemon.md` § Task list) belong to the same settle, so they happen once the queue is empty rather than after every turn of the drain. An end the queue cannot resolve is unaffected: a credential refusal or a rate-limit park still settles the chat, and a turn pausing on a permission request still reports `awaiting-permission`. A stop is read by what is behind it: a stop with turns still queued IS resolved by the queue — a promote stops the in-flight turn precisely so the queued turn starts now — so the chat holds `running` and the interrupted drain still reports one settle at its true end, whereas a bare stop with an empty queue settles the chat immediately (there is no turn to hand `running` on to, and the composer must reopen). Either way `chat.stopped` is emitted, so the interrupted turn is still labelled. However the drain ends — including on a turn that fails outright and abandons the turns behind it — the chat lands on `idle`.
- Wire. When input is queued behind a running turn the host emits `chat.queued` { chatId, localId, message, queueSeq }, where `message` is the text as the user typed it (never the prompt the host builds around it — reminders, voice prefix, attachment paths); when a queued turn leaves the queue it emits `chat.dequeued` { chatId, localId, reason } — `reason: 'running'` (it is now executing) or `reason: 'cancelled'` (removed before running). Both are live-only (not persisted / not replayed), like `chat.message_delta`; the server keeps the chat's current queue from those frames and re-sends `chat.queued` for each message still waiting to any surface that asks for the chat's replay, so a surface that connects or opens the chat mid-queue sees what is waiting, in order.
- Delivery at a tool boundary. A queued message does not wait for the whole turn to end. After each batch of tool calls and before the agent's next step, the host hands it the leading run of waiting plain messages, in order, as one block labelled as arriving while it worked (a person's message and an automatic one are labelled differently). A message sent with send now (the up arrow) shows `interrupted` in its hover strip. Each is recorded in the transcript at that point as a user `chat.message` with `midTurn: true` and announced with `chat.dequeued{ reason: 'running', delivered: true }`, and it never runs as a turn of its own. A message that needs a turn of its own (a branch's first turn, a job, hook or goal resubmit) is not delivered this way, and nothing is delivered past one that is ahead of it. On Codex the host delivers the same block with `turn/steer` against the running turn once a tool call finishes; a refusal fails the turn visibly, since the message has already left the queue. The message shows the time it went in and `after step N` (N is the number of tool calls the turn had made), or `at the start`, in its meta strip (`14-design-web.md` § Messages).
- Stop keeps the queue. Stopping interrupts the in-flight turn and nothing else: the turns queued behind it are untouched and run in order as the queue drains. A queued message is removed only by `chat.unqueue_request`. Stopping a turn that is paused on a permission request ends that request too, as a deny — the turn is suspended on it, so leaving it outstanding would mean the stop did nothing at all and the queue waited out the request's expiry window. The agent is told that the turn was stopped rather than that the call was refused. Unlike a new message, which cancels only a question (`02-daemon.md` § Questions are not approvals), a stop is not selective: it ends the turn, so whatever the turn was paused on goes with it.
- Cancel. A surface removes a still-pending queued message with `chat.unqueue_request` { chatId, localId }; the host drops it from the queue and echoes `chat.dequeued{ reason: 'cancelled' }`. No-op if the turn already started (use `stop` for that) or is unknown.
- Edit. A surface replaces the text of a still-pending queued message with `chat.edit_queued_request` { chatId, localId, message }. The turn keeps its place in the queue, its attachments and everything the host folded around the typed text when it was accepted; only the typed text changes. The host echoes `chat.queued` again with the same `localId` and `queueSeq` and the new text, and every surface updates that entry in place. No-op if the turn already started or is unknown — an edit never runs as a new turn. An edit to empty text on a message with no attachments is a remove (`chat.unqueue_request`), not an edit.
- Promote (interrupt, don't wait). A surface promotes a still-pending queued message with `chat.promote_request` { chatId, localId }. The host interrupts the in-flight turn exactly as `chat.stop_request` does (`.close()` on the SDK query, `chat.stopped{ reason: 'user-stop' }`), so the queue starts draining now instead of waiting for the current turn to finish naturally — it is the "I meant this instead, stop what you're doing" control. Promoting never reorders the queue: turns already queued above the promoted one are already scheduled to run sooner and are pushed along with it, not shoved behind it; turns queued below it stay behind it, unchanged. Promoting `L3` from `[L2, L3, L4]` leaves the queue `[L2, L3, L4]` — only the in-flight turn is interrupted. Promotion does NOT emit `chat.queued` (it changes nothing about the queue's order); the eventual `chat.dequeued{ reason: 'running' }` events as the queue drains are the only wire signal. No-op if the `localId` is not a still-pending queued turn: interrupting an unrelated turn would be a destructive surprise. ORDERING IS PART OF THE CONTRACT: `chat.stopped` is emitted BEFORE the `chat.dequeued{ reason: 'running' }` of the turn that follows it. `chat.stopped` carries no `localId`, so surfaces attach it to the newest user turn that is no longer queued, reading the chat's `activity` at that moment to tell a promote from a bare stop (`14-design-web.md` § Running-turn controls); emitted the other way round, the surface would stamp `Interrupted.` on the message that has just STARTED running and leave the interrupted one unmarked. Emitted exactly once, whichever awaiter of the aborted run reaches it first.
- Surfaces render queued messages in a distinct pending style with a remove (×) affordance and an up-arrow (↑) promote affordance that fires `chat.promote_request`, always visible — it is the queued message's most useful control and must not depend on discovering hover. Sending never interrupts: the ↑ (and Stop) are the only ways to cut a running turn short, and no key in the composer promotes. `↵` and `⌘↵` both just send, which mid-turn queues; in an empty composer they do nothing. A send-and-promote chord, and `↵` in an emptied composer promoting the head, each made the most common gesture destructive — a second `↵` straight after a send promoted the message just sent and killed the turn it was queued behind. Each queued entry carries a chip saying when it goes in rather than merely that it is waiting: the head of the queue reads `Queued`, and the rest read their place in the line — `2nd in queue`, `3rd in queue`. The chip also names the event that releases it — the head runs when the current turn finishes, the rest run once the turns queued ahead of them have run. Position is counted over the queued block as the surface currently renders it, so promoting or removing an entry renumbers the block immediately and the numbering never contradicts the order on screen. This state is not the offline delivery-pending state (`12-error-and-offline.md`), which waits on the host reconnecting rather than on a running turn; the two are worded differently wherever both can appear, since a reader who confuses them cannot tell whether the agent is working or unreachable. A queued message stays below the live transcript, clear of the running turn's ongoing output: the queued block is always the last thing in the stream — below every settled and streaming message, and below the thinking indicator — so its position reads as not yet sent. It takes its permanent place in the transcript only when it is dequeued and processed, so its position reflects when the agent became aware of it, not when it was sent. Sending while running enqueues the message; the composer stays open. Clicking a queued message's text opens it for editing in place, the same editor a settled turn's edit uses (§ Branching), and saving fires `chat.edit_queued_request`. If the message starts running before the edit is saved, the editor closes, the edit is not applied, an error says it had already been sent, and the edited text is put into the composer so it is not lost.
- No auto-interrupt. A queued message waits for the turn ahead of it to finish, however long it runs; nothing promotes on a timer. Interrupting is always a deliberate ↑ or Stop.

## Turns a hook resubmits

An `agent_response` hook (`20-hooks.md` § On the agent's response) can make the host act on a chat on its own — resubmitting a turn after a `block`, or deferring its `advise`/failure onto the next one — with no composer and no job behind it. Both are shaped like every other daemon-originated turn here, not a special case of their own.

- **Block.** The host calls `sendInput` the same way a self-wake or the todo auto-advance does: `origin: 'machine'` (no completion doorbell — `09-notifications.md` § Whose turn it was), nothing sets `fromUser` (a hidden chat stays hidden — § Hidden — exactly as a job's own fire into it does), and the turn's `message` IS the blocking hook's own `analysis`/`suggestion`, verbatim — there is no separate hidden prompt behind a different visible line. `hookTrigger` rides on the resulting `chat.message` (`03-wire-protocol.md` § Hooks) so a surface renders it as transcript furniture (`14-design-web.md` § Agent-response hooks) instead of a user bubble, the same signal `jobTrigger` is for a job's later fire. More than one hook blocking the same settled turn combines into one resubmit naming each, not one turn per hook.
- **Advise, and a hook that failed or timed out.** Neither creates a turn. The note — the hook's analysis, or its error when it failed/timed out — is held (`pendingHookAdvice`, in-memory) and attached to whichever turn the chat runs NEXT — a person's reply, a job's fire, another hook's own resubmit, anything — the moment that turn is accepted, then cleared: consumed once, win or lose the race with whatever else was about to run. It rides as a leading `<system-reminder>` block, the SAME capture-and-disclose mechanism every other injected reminder uses (`02-daemon.md` § System-reminder disclosure) — stripped from the turn's own displayed content and carried out-of-band as a `systemContext` entry labelled "Hook advice" or "Hook failed", so the turn it attached to still reads as whatever it actually was, with the note a sibling disclosure underneath it rather than inline text nobody asked to read. A batch mixing both kinds reads under the failure's label.
- **Loop guard.** `consecutiveHookBlocks` counts block-resubmits in a row with no genuine (non-hook) turn in between, reset to 0 the instant one lands. At a ceiling declared in code (not a setting — the point is a limit a hook cannot talk its way past) the host stops resubmitting and declares the chat's status instead (`report`, § Chat model — "Current status"), carrying the last blocking analysis: the SAME path `patch_report` uses, which persists, un-hides/un-archives, and puts the chat in the "needs attention" list. A hidden or job-owned chat is surfaced by this exactly as a hidden chat declaring its own status would be — nothing about being hook-driven makes it quieter or louder than the agent doing the same thing on purpose.
- None of this is gated to one backend: it all acts on `sendInput`/the turn-settle hook generically, so a Claude and a Codex chat resubmit/defer identically.

## Goals

A per-chat goal: a condition the user states once, which Patch itself then judges after every turn — modelled on Claude Code's own `/goal`, but VISIBLE the whole time it runs (Claude Code's is not), and provider-agnostic (a Claude chat and a Codex chat both get one, judged by the same model). One goal per chat; setting a new one replaces whatever was running.

- **Model.** `goal: string | null` — the condition text, persisted in `meta.json` so it survives a restart. While non-null, `goalProgress: { startedAt, turnsEvaluated, tokensSpent, lastVerdict: 'not_met' | null, lastReason: string | null }` tracks the run; in-memory only (a restart starts the counters at zero again — the goal itself is what has to survive, not the tally). The most recently FINISHED goal is kept on `lastGoal: { condition, startedAt, endedAt, turns, tokens, outcome: 'met' | 'impossible', reason } | null`, persisted, replaced only when the NEXT goal finishes — so the chat header can still say what it was working toward after it clears.
- **Setting it.** `/goal <condition>` in the composer sets the goal AND sends `condition` as the chat's own next turn — the condition becomes the directive, exactly as typing it yourself would. `/goal` with nothing after it (aliases `stop`/`off`/`cancel`) clears the goal and sends nothing. Wire: `chat.goal_request {chatId, goal: string | null}` → host `setGoal`, echoed on `chat.state`. Setting it from a job's action (below) or a `patch_goal_set` tool call (`06-threads-manager-speakers.md` § Tools) persists the goal the same way but does NOT also send a turn — a job's own prompt, or the fact that a tool is being called mid-conversation at all, already supplies one.
- **Telling the agent.** Every set, replace or clear (from `/goal`, a job, or a tool call) queues a one-shot `<system-reminder>` on the chat's next turn, like § Hidden: it states the goal (or that it was cleared) and that the host will send the agent back until it is met. A later change before that turn supersedes an unannounced earlier one. The reminder is disclosed in the transcript as system context under that turn, labelled `Goal set` / `Goal cleared` (`02` § System-reminder disclosure), so for `/goal <condition>` the user sees it on the very turn the condition is sent.
- **Evaluating it.** After a turn settles on a chat with an active goal, the host asks a one-shot model (`goalEval.ts`) to judge `condition` against the chat's own recent transcript: `not_met` (continue — the reply's `reason` is the guidance), `refused` (the agent has declined to do the work), `met` (satisfied), or `impossible` (cannot be satisfied by anyone). A goal is relentless: it is the user saying "keep going until this is done", so a turn that ends by asking whether to proceed, offering options or waiting for confirmation of something the goal already asks for is `not_met`, and the reason tells the agent to go ahead without asking again. Nothing about the shape of a turn ends a goal, including a turn that uses no tools. One model judges every chat, whichever provider the chat itself runs on, because the judge only reads a transcript; it is `goalModel` (default Sonnet 5.5), set in Settings → Goals. The condition can name its own stopping point in plain English ("...or stop after 20 turns") — there is no separate budget field; the evaluator reads it like anything else. NO FALLBACK: a failed/unparseable/timed-out evaluation changes nothing and is retried at the next settle.
  - **`not_met` and `refused`.** The host resubmits exactly the way a hook's `block` does (§ Turns a hook resubmits): `sendInput` with `origin: 'machine'`, the evaluator's own `reason` AS the message (no hidden wrapper), tagged `goalTrigger: {reason}` on the resulting `chat.message` so a surface renders it as the same quiet transcript furniture a hook block is. This is an ordinary queued turn in every other respect — it goes through the SAME rate-limit pause/resume, SDK-error ladder and queueing machinery any turn does, so a goal paused mid-run by a usage limit resumes on its own exactly as any other parked turn would, with the goal still set the whole time it waited.
  - **`met` / `impossible`.** The goal clears (`goal: null`, `goalProgress: null`), `lastGoal` records the outcome, and a quiet system-role `chat.message` marks the transcript (`[goal: met]`/`[goal: impossible]` + the reason — no new agent turn). `met` needs nothing further: the turn was never resubmitted, so the ordinary turn-complete path already rings the usual done notification. `impossible` additionally calls `declareStatus(chatId, 'report', …)` (§ Current status) — the same "needs attention" claim a hook's loop guard or the agent's own `patch_report` makes — so an impossible goal surfaces the chat rather than clearing silently.
- **Settings.** Settings → Goals (`14-design-web.md` § Goals) holds the judge model (one for every chat, any provider), the refusal ceiling below and the judge prompt, as shared settings (`goalModel`, `goalRefusalLimit`, `goalEvalPrompt`) every host applies. The prompt is the judge's instructions; the host adds the goal, the conversation and the reply format.
- **Deadlock guard.** `goalRefusalStreak` counts consecutive `refused` verdicts, reset by any other verdict or a new goal. At the ceiling (`goalRefusalLimit`, default 3) the host stops resubmitting and `declareStatus('report', …)` surfaces the chat with the evaluator's reason, EXCEPT the goal itself is left set rather than cleared: the agent will not do it, the condition was not judged impossible. This and `met`/`impossible` are the only ways a goal ends.
- **Deferred during background work.** Evaluation is skipped while the chat has running `patch_watch` tasks (`watch.count(chatId) > 0`) — judging a transcript whose last word is "I've started a background job" tells you nothing yet. A poll (`GOAL_WATCH_POLL_MS`) re-checks until the watch finishes, then evaluates normally. A chat's own turns never block on this — only the goal check does.
- **Visibility is the point** (`14-design-web.md` § Goal bar, `15-design-mobile.md`): a bar above the chat while a goal is active (condition, running time, turns evaluated, tokens spent, the evaluator's latest reason, Edit/Clear); a sidebar marker on a chat working toward one; each `not_met` verdict a collapsed transcript row naming the reason (the `goalTrigger` turn itself); a `met`/`impossible` outcome its own quiet row; the chat header keeps `lastGoal` reachable after it finishes.
- **Jobs** (`08-triggers-and-jobs.md` § Action): a `spawn`/`continue` action's optional `goal` sets the new chat's goal at creation, forwarded on `chat.spawn_request`. Creation-time only, like `startHidden`/`permissionMode` — a later fire into an existing chat never touches its goal.
- **Tools** (`06-threads-manager-speakers.md` § Tools): `patch_goal_set(condition)`, `patch_goal_get()`, `patch_goal_clear()` — set/read/clear THIS chat's goal from inside a running turn, over the same `/internal/goal` UDS route the composer's request uses.

## Branching (edit / fork a message)

A chat is not a line, it is a graph. Any user turn can be edited, which does not rewrite history — it forks a new track from that point. The turns before the fork are shared; from the fork point on, each track has its own future. The user switches between tracks at the fork point, so an alternative phrasing is explored without losing the original.

- Branch (track): `{ branchId (ULID), parentBranchId, forkFromSeq, sessionId, label, createdAt }`. `sessionId` is the agent session backing that track.
- Root branch: every chat has exactly one, created the moment the chat's first `claudeSessionId` is known (`parentBranchId: null`, `forkFromSeq: null`, label `main`). Chats that predate branching get their root branch on first read of their meta — no migration step, no second source of truth.
- `activeBranchId`: which track the chat IS right now. `meta.claudeSessionId` always mirrors the active branch's `sessionId`, so resume, replay, status/title generation and every other existing path keep working unchanged and know nothing about branches.
- Persistence: `branches` + `activeBranchId` live in `meta.json`, so the graph survives a host restart exactly like the chat does.

### Forking

`chat.fork_request {chatId, seq, message, localId}` — `seq` is the seq of the user message being edited, `message` its replacement text.

1. The host resolves the fork point: the last persisted transcript entry strictly before `seq` (its transcript `uuid`). The transcript is the one the session resumes from — the chat's session mirror (`native/claude/`) when it has one, else the agent's own file — because a long session's later turns can exist only in the mirror. Everything up to and including that entry is the shared prefix; the edited turn replaces what came after.
2. It creates a new branch (`parentBranchId` = the currently active branch, `forkFromSeq` = `seq`) and makes it active.
3. It runs `message` as that branch's first turn with the SDK forking the parent session at the fork point (`resume` = parent session, `resumeSessionAt` = the fork-point uuid, `forkSession: true`), so the new track starts with the shared prefix as its context and gets its own session id. The parent session is left as it was, so the original track stays intact and re-openable.
4. It emits `chat.branches` (the whole graph + the new active branch), then the turn streams normally.

Forking a `seq` that is not a user message in the chat's transcript is an error (`fork_point_not_found`) . Forking from the end instead would silently run the edit as an ordinary new message.

### Side threads (side message)

An edit replaces a turn; a side message asks something off to the side of a turn without disturbing what came after it. It extends the graph sideways: the shared prefix runs up to and including the message the side thread hangs off, and the side message runs as the first turn of its own track. The main track keeps its own continuation, untouched.

`chat.side_request {chatId, seq, message, localId, branchId?}` — `seq` is the seq of the message the side thread hangs off (user or assistant — asking a side question about an answer is the common case), `message` the new question. `branchId` names which branch `seq` belongs to; absent means the chat's active branch — the ordinary trigger, off the main chat.

1. The host resolves the FROM branch (`branchId`, or the active branch if absent) and refuses with `branch_not_found` if it names nothing real.
2. It resolves the side point against THAT branch's own session: the persisted transcript entry that produced `seq` itself (its transcript `uuid`). That entry and everything before it is the shared prefix.
3. It creates a new branch (`parentBranchId` = the FROM branch, `forkFromSeq` = `seq`, label `side N`). Unlike an edit fork (`chat.fork_request`, above), it does **not** become active — `activeBranchId` is untouched, because a side branch runs _alongside_ whatever is active, not in place of it (§ Parallel branches, below).
4. It runs `message` as that branch's first turn with the SDK forking the FROM branch's session at the side point, exactly as a fork does, so the side thread carries the full context up to that message and gets its own session id. The FROM session is left as it was.
5. It emits `chat.branches`, then the turn runs on the branch's own independent pump (§ Parallel branches).

A `seq` with no persisted transcript entry on the FROM branch is an error (`fork_point_not_found`). Hanging the side thread off the end instead would silently make it an ordinary message on the main track.

**Branching off a side thread.** Naming an existing side branch as `branchId` hangs a NEW side thread off a message that lives only on THAT branch's own track — the Side threads panel's "branching again from inside the panel" (`14-design-web.md`, `15-design-mobile.md`). This needs the FROM branch's own turns (both its first user message and every assistant reply) to have recorded their identity into the chat's canonical-seq index exactly as the active branch's `sendInput` already does — without it, a later `sidePoint` walk of that branch's own raw SDK transcript re-derives a DIFFERENT seq for the same entry and the fork is wrongly refused as `fork_point_not_found`.

The side branch is an ordinary branch: it appears in the graph, the switcher at its `forkFromSeq` message returns to the main track, and it survives restarts like any other.

**Naming.** A side branch gets a name the same way a chat does (§ Name): as soon as its first message is accepted, a cheap one-shot model query (`generateTitle`) summarises it into a short Title-Case label, stored on that branch (not the chat) and never overwritten once set unless the user renames it first. `null`/unnamed until it lands. Renameable from any surface: `chat.branch_rename_request {chatId, branchId, name}` — `name` may not be empty (a branch has no folder-derived fallback to clear back to, unlike a chat's own rename). An unknown branch is a `branch_not_found` error.

### Parallel branches

Several branches of one chat can be mid-turn at once, each in its own session — a side branch never shares the active branch's turn-execution state, so creating one and sending it messages never waits on, or blocks, whatever the active branch is doing.

- **Addressing.** `chat.input`, `chat.stop_request` and `chat.replay` each take an optional `branchId`. Absent means the chat's active branch — every existing caller, unchanged. A `chat.input` naming a branch OTHER than the active one runs (or queues behind) a turn on that branch's own independent pump; the active branch's own single-turn-per-chat pump (`sendInput`/the SDK query loop) is completely unaffected and keeps its full feature set (compaction, provider/harness switching, the SDK-error retry ladder, rate-limit backoff) exactly as before branches could run in parallel.
- **A side branch's own pump is intentionally smaller.** It resolves credentials and runs the SDK exactly as the active branch does, and supports its own queue (a second message to a busy side branch queues behind the first, draining FIFO), its own stop (`chat.stop_request {chatId, branchId}`), and its own permission requests/questions (below) — but it does not yet carry provider/harness switching, context compaction, or the SDK-error retry ladder. Bringing it to full parity is follow-up work (step 2/3), not this step's job.
- **Content stays on its own track.** A side branch's messages and tool calls are persisted to its own track (readable via `chat.replay {branchId}`, `GET /api/chats/:id/history?branchId=`, or `patch_history`) but are **not** broadcast live to every surface holding the chat — no surface broadcasts a second, simultaneous track, so doing so would interleave two conversations into the one view a surface draws for this chat. The Side threads panel (`14-design-web.md`, `15-design-mobile.md`) is what gives it somewhere to go, and it is PULL-based to match: it polls the HTTP history route for the open tab's branch while that branch is `running`, rather than the host pushing content for a branch nothing is broadcasting live.
- **Permissions and questions address a branch.** `chat.permission_request` carries an optional `branchId` (absent ⇒ the active branch, as today). A question or tool-approval raised by a side branch's own turn is tagged with it, so a surface that understands branches routes the card to the right track (the Side threads panel's own card on that tab) rather than the chat's main transcript, which draws only the active branch; one that doesn't understand branches still shows it there (same as before branches existed) rather than losing it. Resolving it (`chat.permission_response`) is unchanged — it already addresses the request by `requestId` alone.
- **`activeBranchId` stays the chat's "main" track** for everything that expects exactly one: the sidebar preview, resume-on-restart, `patch_send_to`, jobs' `continue` action, and an edit fork (`chat.fork_request`) still switches it, exactly as before parallel branches existed.
- **Stopping.** `chat.stop_request {chatId}` with no `branchId` means "stop the chat" and ends EVERY branch's turn, not just the active one's. Archiving (§ Lifecycle) stops all of it the same way: nothing a chat has in motion, on any branch, survives either.
- **Status aggregates.** `chat.state.activity` — what the sidebar reads — is the active branch's own activity, RAISED by any other branch currently running or awaiting permission: `running` if any branch is working, `awaiting-permission` if any branch is blocked on a question (this outranks mere `running` — a blocked branch is more actionable than a busy one), falling back to the active branch's own `errored`/`idle` when nothing else is happening. A side branch failing silently does not, on its own, escalate anything the sidebar shows. A side branch's OWN `running` flag — carried on its `chat.branches` entry, set the instant its pump picks up a turn and cleared the instant it settles — is the one PER-BRANCH signal beyond this aggregate and beyond permission requests; it drives the Side threads panel's tab status dot without needing to poll.

### Send back

A side branch can post its conclusion back into its parent branch's track two ways: the tool `patch_send_back` (no arguments; callable only from a turn running on a side branch, via `PATCH_BRANCH_ID`), or the surface-triggered `chat.send_back_request {chatId, branchId}` — the Side threads panel's "Send back to chat" button (`14-design-web.md`, `15-design-mobile.md`), which does the identical thing without needing a turn to be running on the branch at all. Both land on the same underlying step below. Refused (naming why — `send_back_failed` on the wire path) when the branch has no parent (the root), or when it has already sent back once (one-way, like the edit fork's session capture); the tool form is additionally refused when the calling turn is not on a side branch.

1. The host generates a short summary of the branch's own conclusion — a cheap one-shot model query reading what the branch was asked and what it last said, the same mechanism a collapsed tool run's label uses (`chat.tool_run_summary`).
2. It posts a quiet row into the PARENT branch's track right now: an ordinary `chat.message` (`role: 'system'`, `branchSendBack: {fromBranchId, fromBranchName}`), reading `From <branch name>: <summary>`. Live-emitted when the parent is the active branch (the one view a surface draws for this chat); otherwise it lands on the parent's own track for its next replay, same as any other side-branch content.
3. The SAME summary is also queued for the parent's NEXT turn, riding in as a leading `<system-reminder>` block — the capture-and-disclose mechanism every other injected reminder uses (§ System-reminder disclosure, `02-daemon.md`) — so the parent's agent reads it as part of that turn's own context rather than having to notice the row (principles.md § no invisible injection: the row makes it visible even if the parent's next turn is a long way off; the reminder makes sure the agent doesn't miss it either).
4. The branch is marked `sentBack: true` (carried on `chat.branches`) and the summariser's own failure (no account with credit, SDK error, timeout) is recorded as the row's text rather than silently saying nothing — NO FALLBACK to pretending it worked.

### Switching tracks

`chat.branch_switch_request {chatId, branchId}` — the host points `activeBranchId` (and therefore `claudeSessionId`) at that branch, persists, and emits `chat.branches` + `chat.state`. The surface then re-replays the chat and re-renders the newly-active track. Switching to an unknown branch, or to one whose first turn has not yet produced a session id, is refused (`branch_not_found`) rather than silently landing somewhere else. Switching is refused while a turn is `running` — the in-flight turn belongs to the current track; stop it first.

The host publishes the graph on `chat.branches` {chatId, activeBranchId, branches[]}: on fork, on switch, and as part of a `chat.replay` so a reconnecting surface learns the graph without a separate request.

### Surfaces

A user turn reveals an edit (pencil) affordance on hover/focus. Editing opens the turn's text inline; saving fires `chat.fork_request` and the transcript re-loads on the new track. Where a message is a fork point with more than one track, a track switcher (`‹ 2/3 ›`) renders on that message; the arrows fire `chat.branch_switch_request`. The switcher appears once a chat has been forked; a single-track chat looks exactly as it did.

A side-thread affordance (step 2 of the parallel-branches work, reinstating what Todoist once asked removed, now with a tabbed panel/screen to put it in — `14-design-web.md` § Side threads panel, `15-design-mobile.md` § Side threads screen) sits beside the edit pencil: hovering (desktop/web) or long-pressing (mobile) ANY settled message, user or assistant, offers "Open side thread", as does the message's own right-click/context menu. A message with one or more side threads forked from it carries a marker — "Side thread · N messages · running" — clicking/tapping it opens the panel/screen on that tab. No surface yet renders the second, simultaneous track as a GRAPH (step 3, "branch canvas") — that remains a host capability nothing but the panel/screen triggers.

## Document edits

`14-design-web.md` § Document editor. A `.md` file a surface saves (`file.write`, whichever editor made it — the document editor or the plain one) is tracked per chat against what was on disk before; the chat's NEXT turn is prefixed with a `<system-reminder>` carrying a diff, via the same capture-and-disclose mechanism `§ Branching → Send back` uses, so it shows up in the transcript as a collapsed row (labelled "Document edited") rather than invisible injection (`principles.md`). Several saves to the same file before that next turn diff start-to-latest as one change, not each keystroke; a file saved back to exactly what it was reports nothing. Cleared the instant it is delivered — a later turn with no further edit carries none.

A comment the user leaves on a document (or a reply inside an existing thread — `14-design-web.md` § Document editor's comments both ways) reaches the chat's agent the same way: queued the instant it is made, delivered as its own leading `<system-reminder>` (collapsed row "New comment") naming the file, the thread and the text, the moment the chat's next turn is accepted, then cleared. Independent of the diff reminder above — a turn can carry one, the other, both, or neither.

## Pinning

Any regular chat can be pinned. Pinning lifts the chat out of its folder section and surfaces it at the top of the sidebar, immediately below `Manager`, so the user reaches it without scrolling.

- Storage: pinned state is per-chat metadata on the host (`pinned: true`). Survives host restart.
- UI: pinned chats appear in a Pinned group above the folder list. They keep the same status badge / mic shortcut / kebab menu as any other chat.
- Toggle: kebab menu → `Pin chat` / `Unpin chat`. No dedicated drag-to-pin gesture.
- Order: most-recently-pinned at top.
- Use case: a long-running chat the user opens often. The canonical example is a Home Assistant control chat (see `06-threads-manager-speakers.md` § Smart-home control from a desk) — one chat, pinned forever, used continuously for `lights off` / `kitchen scene`.
- Special threads (`Manager`, `Speakers`) are not "pinned" — they sit in fixed slots (Manager top, Speakers in the Channels section near the bottom) and the pin toggle is hidden for them.

## Snooze

Gmail-style snooze: get a chat out of the way until a chosen moment, then have it come back on its own.

- Model: per-chat `snoozedUntil: number | null` (ms epoch), persisted in `meta.json` so a snooze survives a host restart. Orthogonal to `status` — snoozing does not archive or delete, and an archived/deleted chat is unaffected by its `snoozedUntil`.
- Snoozed ⇔ `snoozedUntil !== null && snoozedUntil > now`. Every surface derives "is snoozed" from that comparison, so a surface that was offline when the snooze lapsed still shows the chat correctly the instant it renders.
- Presets (surface UI): 2 minutes, 5 minutes, 30 minutes, 1 hour, 1 day, next week (7 days), plus custom — a free-form date/time the user picks — on a surface with a date/time field to pick it in. Every preset is just "now + delta" resolved on the surface into an absolute `snoozedUntil`; the host only ever stores the absolute timestamp (a delta would drift while an event is in flight).
- Unsnooze: setting `snoozedUntil = null` at any time (the Snoozed section's row control, or the chat header's snooze control while snoozed) returns the chat to the active list immediately.
- Waking: the host arms a timer for the snooze and, when it fires, clears `snoozedUntil` to `null`, persists, and emits `chat.state` — so an open surface pops the chat back into the active list without a reload. Timers are re-armed from `meta.json` on host start; a `snoozedUntil` already in the past clears on load. Waking does not touch `lastUpdated`, unread state or activity — the chat comes back exactly as it left.
- Snoozing is not muting: a snoozed chat keeps running. Turns still execute, `patch_send_to` still delivers, notifications still fire. The only effect is where the chat is listed. Reaching the chat by URL/deep-link still opens it normally, with a banner naming the wake time.
- Requests: surface → host `chat.snooze_request {chatId, snoozedUntil}` (via REST `POST /api/chats/:id/snooze` with body `{snoozedUntil: number | null}`); host → surfaces the resulting `chat.state` carrying `snoozedUntil`. A `snoozedUntil` in the past is rejected (400), so the caller sees the bad value rather than a silent "now".
- Special threads (`Manager`, `Speakers`) cannot be snoozed; the control is hidden for them and the host rejects the request.
- Whole-project snooze: the folder header's snooze control (`14-design-web.md` § Folders) picks one preset and applies it to every chat the "archive all in project" button would move — the folder's whole chat set (`04` § Folders), including pinned and already-snoozed ones, excluding special threads and anything already archived or deleted. There is no per-chat confirm and no "as listed" variant: unlike archive, leaving a chat snoozed rather than snoozing it isn't a state that needs a name, and "whole" is what a project-wide snooze means. Each chat is its own `chat.snooze_request`, applied and reverted independently — a request that 400s for one chat leaves the rest snoozed and toasts the failure (NO FALLBACK), same as a per-project archive failure.

## Section counts

The lifecycle sections a surface can list — archived, snoozed, deleted and
automations — are also served as bare totals, one small response carrying a
number for each, with no chat rows in it. A surface loads it on cold start
alongside the chat list and refreshes it whenever a chat changes lifecycle
state, so a section's size is known before its list has ever been fetched.

Each total is defined as the size of the list that section's own query returns
— the same filter, not a separately-stated rule — so the number is always
exactly what expanding the section fetches. Carrying no rows, the response
stays small however many archived chats accumulate, which is what lets it be
fetched eagerly when the lists themselves cannot be.

## Search

One search covers every chat on every host except deleted ones — active, pinned, snoozed, archived, the special threads and job-created chats alike. A chat matches when every term of the query appears, case-insensitively, in its name, in a single user or assistant message of its current track, or — for a chat whose transcript the backend has since pruned — in its stored first-message preview. Tool calls and their output are not searched: they are most of a transcript's bytes, and file dumps and command output would put nearly every chat in every result. A term is a whitespace-separated word; a run in double quotes is one term matched as an exact phrase (internal whitespace of the text, line breaks included, counts as a single space; an unterminated quote runs to the end of the query). A search can be limited to titles: with full text off only chat names are searched — no message, no preview — and no transcript is read. Full text is on by default. A query is at least two characters after trimming.

Each chat is one hit. Hits are ordered by date: the most recently active chat first, whether its name or only its messages matched. A hit carries where the chat lives (its host, and the section it is listed under), how many of its messages matched, and a snippet: a window of the most recent matching message with every term occurrence marked, plus that message's `seq`. Opening a hit opens the chat scrolled to that message. A message that has never been numbered (written by the backend but not yet replayed) has no `seq`; its hit opens the chat at its latest message.

Every host is part of the answer. A host that is offline, does not answer in time, or fails is named in the response with what happened to it, so results missing a machine's chats always say so. Results are paged, deepest page 200 hits. The fan-out and wire shapes are in `03-wire-protocol.md` § Chat search; the host's index in `02-daemon.md` § Chat search.

## Folders (host-owned registry)

Projects are just folders with ≥1 chat, so to start the first chat in a
project the user picks a host and a folder on it, in the common case without
typing or guessing an absolute path.

Where a chat runs is chosen first, then the folder on that machine. With more
than one host registered the new-chat screen offers the hosts by name, and the
folder picker lists only the chosen host's registered roots and recent folders,
so picking `~/projects/patch` on hetzner and `~/code/patch` on Tom's MacBook is
the same gesture made after choosing the machine.

- Each host publishes its own folder registry and recent list, and a host's
  folders are only ever offered while that host is chosen, so two hosts sharing
  a path string stay two directories.
- An offline host is listed, marked offline, and cannot be chosen.
- Changing the host keeps the chosen folder only if the new host has a folder at
  that path; otherwise the folder clears.
- The picker defaults to the last used (host, folder) pair, and a draft keeps
  the host it was typed against.
- A host added later appears in the picker as soon as it registers.

Folders are defined on the host — each host owns its host's filesystem
and is the only party that knows which folders actually exist. Each host holds
its own registry (a small set of user-designated project roots, seeded from recent
chats and edited through `patch hosts folders` (`17-cli.md` § Commands) or that
host's Settings → Project folders, both writing through to that host). A host
publishes its folder list to the server, which relays it to every connected
surface over the wire (a `folders.list` snapshot on connect and a
`folders.updated` push on change, both carrying the `daemonId`), so one
consistent picker on every surface is populated from the same lists and a folder
that exists on a host is one tap away everywhere.

An edit travels the other way as `host.folder_add` or `host.folder_remove`,
carrying the `daemonId` of the host being edited and the path
(`03-wire-protocol.md` § Host events). The host validates the path against its
own filesystem, writes its registry, and answers with `folders.updated`, so the
list every surface shows is the one the host actually holds. A path that does
not exist on that host is refused naming it, and an add aimed at an offline host
is refused up front by the surface rather than buffered.

Within each host's group the picker offers, in order: that host's registered
folders first, then folders seen in recent chats on it, then a clearly-secondary
free-text field for a genuine ad-hoc path on that host. Each host stays the
source of truth for its own paths: the published list is not a substitute for
the spawn-time `folder exists` check on the chosen host — an ad-hoc or stale path
still fails loudly with `folder_not_found` on send.

Recent-folder selection rule (real project folders only). The recent list
is seeded from folders seen in recent chats, so it can pick up paths that are
not project roots. The host filters these out before publishing so
"Recent" shows only real project folders, most-recently-used first. A recent
folder is excluded when it is:

- a reserved special thread's folder (Manager / Speakers — excluded
  by chatId), OR
- junk by the shared `isJunkFolder` rule (`@patch/wire`): a special thread's
  working folder recognised by PATH (`isSpecialThreadFolder` — any path ending
  `threads/manager` or `threads/speakers`), any path with a
  dot-directory segment anywhere (`.patch`, `.git`, `.cache`, …), or a system
  scratch dir (`/tmp`, `/var/tmp`, `/private/tmp`, `/var/folders/*`).

The path test for a thread folder is not redundant with the dot-directory test.
The thread dirs sit under the host's patch home, which is `~/.patch` on an
ordinary install but is relocatable (`02-daemon.md` § Stack), so a relocated home
gives thread dirs with no dot segment at all (`/daemon-home/threads/manager`) —
those are still patch's own bookkeeping and still never a project. The chatId
test is not redundant either: a folder reaching a picker through the server's
folder roster or a host's published registry arrives as a bare path with no chat
attached, so path is the only thing there is to test.

Explicitly registered project roots are user-designated and bypass the junk
filter (a root deliberately placed under, say, `/tmp/work` is still shown). The
same `isJunkFolder` rule is applied on the surfaces' pickers, so a folder the
surface knows only from its own chat history is filtered identically — in the
recent lists, in the pickers' dropdowns, AND in whatever those surfaces DEFAULT
to. A default is drawn from the same filtered set as the list it defaults
within, so no surface can preselect a folder it would refuse to offer.

### Folder roster (folders seen in chats)

The half of a surface's recent list that comes from chat history is served by the
server as its own roster, separate from the chat list: one entry per folder that
holds at least one chat, carrying that folder's host and the timestamp of its
most-recent chat, most-recent first. A surface loads it on cold start alongside
the chat list, and it is what "folders seen in recent chats" resolves to in the
picker and in the sidebar's recent projects.

Archiving does not retire a folder — a folder whose chats are all archived stays
in the roster, so it remains a one-tap entry point for starting the next chat
there, and its host still resolves. Only soft-deleting every chat in a folder
drops it. The roster is deliberately not derived from the surface's own chat
list, which holds only active chats and so cannot see an all-archived folder at
all. Being one entry per folder rather than per chat, it stays small however many
archived chats accumulate.

### Browsing (directory listing)

Beyond the published registry, a surface can browse a host's filesystem
to pick a folder, so the user drills into a directory tree instead of typing a
path. Browsing is addressed to one host at a time, the one whose group the user
is in. Each host exposes a directory-listing control — a request naming a
directory (defaulting to the registered roots when none is given) returns that
directory's child directories only (name + absolute path; files are not
listed — a chat targets a folder, not a file). Browsing is NOT confined to the
designated roots: the host runs with its user's whole authority and a chat can
reach any path on that machine the moment it starts, so confining the picker
protected nothing and only stopped a person opening a chat in a folder they had
not registered first. The roots are what the picker OFFERS at the top level —
the shortcuts to where you work — not a boundary on where you may go. Going up
from a registered root returns to that shortcut list; going up from anywhere
else is simply the parent, ending at `/`. A path that does not exist or cannot
be read is still `folder_not_found`, never a listing of something else. The
client renders the tree with a breadcrumb of the current path and a "use this
folder" action at any level. This is the mechanism behind the mobile/web folder
browser (`15-design-mobile.md` § New chat flow); the flat published
`folders.list` remains the one-tap shortcut for the common case.

The browsed filesystem is ALWAYS the selected host's — on every surface,
including the desktop shell. A surface offers only that host's filesystem, not
its own, as the folder source: no OS-native directory dialog, no local file
picker, no drag-a-folder-in. The selected host is frequently a different machine
from the surface (the Hetzner box vs. the user's laptop), so a locally-picked
path is a path that host does not have and every chat spawned into it dies with
`folder_not_found`. This holds even where the desktop app runs on a machine that
is itself a host: it is a surface like any other and uses the same daemon-backed
browser the browser SPA uses, against whichever host the user picked. The only
ways to name a folder are (a) the published/recent list, (b) drilling the chosen
host's tree, and (c) typing an absolute path on that host.

Performance (sub-200ms for a typical directory). The listing must feel
instant. The host-side listing:

- reads a directory in a single `readdir({ withFileTypes: true })` — the
  entry type comes from the dirent, so there is no per-entry `stat`, and the
  redundant pre-`readdir` `stat` is dropped (`readdir` itself surfaces
  ENOTDIR / ENOENT as `folder_not_found`);
- the only `stat` performed is to resolve a symlink's target, and those run
  concurrently (`Promise.all`), rather than one sequential `await` per entry. A
  pnpm `node_modules` is a symlink farm; serialising those stats was the
  dominant latency and turned one listing into hundreds of round trips;
- caches each `browse` result (and the roots view) in memory for a short TTL
  (~3s) keyed by the resolved dir, so the picker's rapid re-opens / re-reads are
  served without touching the filesystem. Confinement is re-checked on every
  call (cheap + in-memory) so a cache hit still passes the root check. The
  cache is a browse convenience only — live registry changes still fan out over
  `folders.updated` independently.

## Constraints

- A chat's `folder` is fixed for its lifetime. For isolation, make a new folder and spawn a chat there.

## Cross-refs

- Spawn sequence on the wire: `03-wire-protocol.md`
- Host internals: `02-daemon.md`
- Stopping behaviour on disconnect: `12-error-and-offline.md`
- Hooks that resubmit/defer onto a turn: `20-hooks.md` § On the agent's response
- Goal bar, sidebar marker, transcript rows: `14-design-web.md` § Goal bar, `15-design-mobile.md`
- Job-set goal: `08-triggers-and-jobs.md` § Action
- Goal tools: `06-threads-manager-speakers.md` § Tools

## History — server mirror

The host's log stays the record. The server additionally keeps a durable copy of the user and assistant messages that stream through it, one JSONL file per chat under `<dataDir>/chat-mirror/`, appended idempotently on `seq` (a replay re-sends old turns). It is a re-derivable secondary store: a corrupt line is logged and skipped, never fatal.

Its only reader today is search. A chat on an online host is always searched by that host. A chat on an offline host is searched by the server from the mirror and the chat registry's names, its hits carry `mirrored: true`, and the host's entry in `hosts[]` stays `offline` with `mirroredChats`. Message text sent before the mirror existed is absent until the host replays it. Moving a chat out of an offline host from the mirror is not yet built.
