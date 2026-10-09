# Shared Manager and server-held messages (draft for review)

Draft amendments to `01-server.md`, `02-daemon.md`, `03-wire-protocol.md`, `04-chats-and-folders.md` and `06-threads-manager-speakers.md`. Written in spec voice so each section can be moved into its file once approved.

## Status

Built:

- The server-run queue and Manager failover to another online host.
- A send-now message shows `interrupted` in its hover strip.
- Codex delivery at a tool boundary through `turn/steer`.
- Messages held for an offline host are written to disk and survive a server restart.
- Delivery at a tool boundary, the `midTurn` flag and `delivered` dequeue reason, and the delivery position in the meta strip.
- The server keeps each chat's state (activity, status, host, job, last-updated time) on disk and restores it at startup, so a job's concurrency slot is released at once on restart for a chat last known to have finished.
- A chat's `patch_send_to` returns once the target has accepted the message instead of when the target's turn ends, and `chat.dequeued` marks a mid-turn delivery with `delivered: true` on an ordinary `running`, so an older surface still reads it.
- Settings → Goals on mobile, with the judge prompt in the shared full-screen editor.
- A restored idle slot is released only for a chat known to have worked since the slot was taken.
- The host's log is a cache the server can rebuild and keep in step: each `chat.state` carries `lastSeq`; a host ahead of the server is asked for what the server missed and answers from its log (`patch.log_sync.*`), a host behind is sent what it lacks (`patch.log_restore`), and a chat the server holds none of is not copied wholesale.
- A tool result over 4 KB is kept in the server's log as a reference to a stored body, served from the server by the blob route with no host online.
- The server is the log of record for each chat's transcript: a finished event is committed to its file before it is broadcast, a resend is not broadcast twice, a contradiction is refused, and the host is told how far the log reaches (`chat.committed`) so its numbering stays above it. It answers replays and history reads from the log while the chat's host is offline.
- The server keeps each chat's waiting messages and re-sends them to a surface that asks for the chat's replay.
- Sweep rules: `stalled` once per quiet stretch, one unread sweep message per chat, early wakes debounced against the last sweep.
- The Manager and Speakers exist only on the home machine, and the server ignores a non-home machine's copy.
- Moving a chat to another machine and folder, and holding a message for an offline machine until it reconnects, were already in place.

Not built:

- Anything beyond the above: the plan is built except what is listed under "by design".

Not built, by design:

- The server handing out each seq itself. The host numbers its own events so a turn can run while its link is down; the server is still the authority, because it refuses an event that contradicts its log and tells the host (`chat.committed`) never to number at or below what it holds. Handing out every seq from the server would stop a host working offline and needs a round trip before each event.
- Replacing the flat files with an indexed store. One append-only file per chat, read whole on first use, is enough at today's sizes; the log is capped at 50,000 events in memory per chat.
- Paged history reads from the server's log beyond what `GET /api/chats/:id/history` already pages.

## Principle

The server owns the conversation. A host executes it.

Every chat's message log lives on the server. A host holds only what it needs to run a turn: the working folder and the live agent session. Any host that has the folder can run any chat, and a chat can move between hosts without losing history.

## Message log

- The server holds the append-only event log for every chat and is the authority on its numbering: a host streams the events a turn produces to the server, the server commits each finished one before broadcasting it, refuses one that contradicts the log, and tells the host how far the log reaches so the host never numbers at or below it (`01-server.md` § Message log).
- Surfaces read history from the server. History stays readable while the chat's host is offline.
- A host keeps a local copy of the logs of chats it runs, as a cache the server can rebuild. Losing a host loses no history.
- The agent session (the native Claude or Codex session) is host-local working state. The server never stores it.

Keeping the server in the path costs no speed a user can see:

- **Live and durable are separate.** Streaming text and tool progress go from the host to surfaces as they happen, and a surface never waits for a commit. Only finished events are written to the server's log, one synchronous append each, before they are broadcast. A turn never waits on it.
- **The host buffers.** If the link to the server drops, the host keeps running the turn and sends the buffered events in order when it reconnects. The server drops any event it already holds. What the buffer lost is recovered from the host's own log.
- **Large results stay light.** A tool result or attachment above a size limit is stored as a reference and fetched on demand, so one big result never slows the log. History loads in pages.
- **History is faster than before.** A surface reads it from the server directly, with no round trip to a host that may be asleep.
- **Storage.** One append-only file per chat, with big tool results held once as separate bodies.

## Message delivery

A message sent to a chat that is mid-turn is held by the server, not the host. The server delivers it to the chat's host in one of two ways:

- **At the next tool boundary.** The default. The message is injected after the tool call currently running completes, labelled for the agent as arriving mid-task.
- **Immediately.** The user presses send now (the up arrow on a waiting message). The current step is interrupted and the message is delivered at once.

If the turn ends first, the message starts the next turn.

Each message carries one state, shown on its bubble:

| State       | Shown as                                                                         |
| ----------- | -------------------------------------------------------------------------------- |
| waiting     | the bubble in the waiting style, no label                                        |
| delivered   | time sent and the position it landed at, for example `12:34:07 · after step 14`  |
| interrupted | the same as delivered. `interrupted` appears when the user hovers over the label |

A delivered message never shows a queue label again. The server records the state change as an event, so every surface shows the same thing and a reload cannot bring a stale label back.

Messages from the same sender that are waiting together are delivered as one message.

## Moving a chat between hosts

- A move happens only when the user asks, from any surface. A host going offline never moves a chat. The Manager is the one exception (§ One Manager).
- The user picks the target host and the working folder on it, since the folder changes. The chat then runs from that folder.
- The server stops routing to the old host, routes to the new one, and the new host seeds a fresh agent session from the server's log (the same reconstruction a provider switch uses).
- A turn in progress finishes or is stopped before the move.

## One Manager

There is one Manager conversation per account, held on the server like any chat log.

- **Where turns run.** The server runs each Manager turn on one online host. It prefers the home host and falls back to any other online host. A turn that is running stays on its host to the end.
- **Home host.** The home host is a preference for where the Manager runs. It is not a requirement, and the Manager keeps working while the home host is offline as long as any host is online.
- **No per-host copies.** A host never creates its own Manager thread. Thread folders and the Manager's `CLAUDE.md` are created on whichever host runs a turn, from the account's copy.
- **Disabled.** The disabled flag is account-wide and held by the server. A disabled Manager drops sweep candidates, receives no ingress, and shows greyed out everywhere. Only the user can change it, from the header's Power icon or `patch chats disable`.
- **Reaching chats.** The Manager sends to any chat through the server. A send does not pass through the host the Manager happens to be running on.

Speakers keeps its current rule: it lives on the home host, because the physical devices connect there.

## The sweep

The sweep gate and its decision run once per account, not once per host.

- The server checks the gate (`06-threads-manager-speakers.md` § The sweep) against every chat on every host and, when a sweep is due, asks one online host to run the decision call.
- A disabled Manager is checked first. A disabled Manager sweeps nothing and makes no model call.
- The decision call returns its actions to the server. The server delivers nudges and wakes directly to each target chat's host, as machine messages that follow the delivery rules above.

Rules that keep it from stacking messages:

- A chat has at most one undelivered sweep message. While one is waiting, the chat is not a candidate.
- A chat that has produced output since the last sweep message is not a candidate for `wake`.
- `stalled` fires once per quiet stretch, not on every tick. The next `wake` for the same chat needs another full stalled threshold of silence after the previous one.
- Sweeps are never more frequent than `sweepIntervalMinutes`, whatever fires the gate. The event-woken trigger is debounced against the last sweep, not against the last event.

## Wire changes

- Transcript events flow host to server as they do now. The server answers with `chat.committed { chatId, through }`, `chat.state` carries `lastSeq`, and `patch.log_sync.request`, `patch.log_sync.batch` and `patch.log_restore` keep the two logs in step.
- A message's delivery is shown by the existing events rather than a new one: `chat.queued` while it waits, `chat.dequeued { reason: 'running', delivered: true }` and a user `chat.message` with `midTurn: true` when the agent takes it in at a tool boundary.
- Send now is the existing `chat.promote_request`.
- Moving a chat is the existing `POST /api/chats/:id/move { daemonId, folder }`.
- `patch_send_to` and the Manager's sweep nudges do not go through the server's queue. A message one chat sends to another is held in the target host's own queue and delivered at the target's next tool boundary like any other, and the call returns once the target has accepted it. The server's queue is for messages from surfaces.
