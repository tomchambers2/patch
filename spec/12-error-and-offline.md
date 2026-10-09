# Error and Offline Behaviour

Patch has several parties holding connections: surfaces ↔ server ↔ hosts. Any of them can disappear. This doc defines what happens.

## Principles

- Disconnects don't lose conversation state. the agent's session history is persisted by the backend on the host regardless of whether the host is reachable. The next user message resumes from there.
- No fallbacks. Per the portfolio convention — when something breaks, it's visible, not silently absorbed.
- One surface per failure. A failure is reported once, in one place. A surface never repeats the same message in a second element beside the first — two copies of one message read as two separate faults, and the spare copy is the one that ends up unstyled. On web that one place is the error toast; a failure that needs to persist past the toast belongs in the affected control's own state, saying something the toast doesn't.
- Said in plain English, code kept. What the user reads is one sentence saying what to do next. The machine-readable code, and any wording a host wrote for whoever wrote the host, are never the message and are never appended to it — an unrecognised code least of all, which takes a generic sentence rather than being interpolated into one. Neither is discarded: both are kept verbatim in a Details disclosure under the sentence, collapsed by default, and a toast holding one does not auto-dismiss while that disclosure is open.
- Full-page failures use one page. A path no pane claims, and a crash while rendering a pane, each take the panel with a title, one sentence, the path or stack under Details, and the way out (Back to Manager / Reload). A render crash never leaves a blank window, and navigating away clears it. A failed action's toast is `<Action> failed. Try again.` with the thrown message under Details.
- Sequence-based replay. Every `chat.*` event carries a monotonic `seq` per chat. Reconnecting parties request `chat.replay {chatId, fromSeq}`; host emits missed events from its history.
- When a surface requests a replay. A surface requests `chat.replay` when it opens a chat, and on (re)connect only for chats whose transcript it is already holding — i.e. the chat it currently has open, plus any chat with a non-empty rendered timeline. The chat it has open counts whether or not the roster knows about it: a chat opened from a notification tap that launched the app is on screen before the roster has arrived, and it is the one chat that must not be missed. A request made while the link is down is not a request — the surface asks again on connect. State-level events (`chat.spawned` / `chat.state`) fan out to all of an account's surfaces unconditionally, so a chat spawned on one surface appears in another's sidebar (name + preview) without that surface ever having replayed it; its transcript and live detail events (`chat.message` and the rest) only arrive once the surface replays it. Opening such a chat therefore requests a replay so its transcript loads instead of showing empty — a chat that first appeared after connect is not covered by the connect-time replay alone. `fromSeq` derives from the durable timeline the surface has already rendered (`-1` when it has none), so re-opening a chat already in hand replays nothing.
- A replay arrives as a burst, and is applied as one commit. The host re-emits a transcript as one event per entry, so a busy chat replays as hundreds of frames in a fraction of a second. A surface gathers inbound events for up to one frame and applies the run to its store as a single commit, in arrival order — the result is identical to applying them one by one. Applying them one at a time costs a render of the whole transcript per message: the chat visibly fills in from its oldest message down while the scroll chases the growing content, and the work is quadratic in the transcript's length. Anything that reads or writes chat state outside that fold — deriving a replay's `fromSeq`, or resolving a permission card the host has just echoed — commits the gathered events first, so it never acts on a transcript missing entries that have already arrived.
- Cold start loads metadata only — one call, no transcript fan-in. A freshly-booted surface has no transcripts, so it must NOT ask for one per known chat. The roster comes from the single `GET /api/chats` metadata snapshot, which carries each chat's metadata as `04-chats-and-folders.md` § Chat model defines it — its host `daemonId` alongside name, preview, folder, activity, status, pin, snooze and `lastUpdated` — and carries no transcript events; transcripts arrive lazily, one chat at a time, on open. Blanket-replaying every chat on connect made cold start cost O(chats) inbound event streams — each one rewriting sidebar rows and the store — which is the "loading thrashing" the roster snapshot exists to avoid. The reconnect case is unaffected: a surface that has already rendered transcripts still replays exactly those, so no live chat silently misses events across a drop.

### Running-turn resync

While the open chat's turn is `running`, the web surface re-asks the host for everything after its cursor every few seconds (`RUNNING_RESYNC_MS`). A live detail event that never reached the surface — a dropped subscription, a lost frame — would otherwise leave the pane frozen mid-turn with the spinner up until the user typed again; the replay back-fills the gap and re-subscribes the socket to the chat. A healthy chat answers with an empty batch. An idle chat is not polled.

### Replay vs history cursors — boundary semantics (read before mixing them)

There are two "give me events from here" parameters, and they use deliberately opposite boundary conventions. They are not interchangeable — a client must not feed a value from one into the other.

| Surface                           | Param     | Boundary                                           | Meaning of the value                                           | Full history                                                                 |
| --------------------------------- | --------- | -------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| WS `chat.replay`                  | `fromSeq` | exclusive — host emits events with `seq > fromSeq` | the last seq the caller already has (a reconnect/dedup cursor) | pass `-1` (a surface that has seen nothing). `0` deliberately skips `seq 0`. |
| HTTP `GET /api/chats/:id/history` | `since`   | inclusive — returns events with `seq >= since`     | the first seq the caller wants (a paging cursor)               | pass `0`                                                                     |

Rationale: `chat.replay.fromSeq` is a reconnect cursor — the surface passes the highest seq it has already rendered and wants strictly newer events (exclusive avoids re-rendering the boundary event). `history?since` is a paging/fetch cursor — the caller passes the first seq it wants and gets that event included. The HTTP paging loop advances with `since = lastReturnedSeq + 1`; the WS reconnect loop advances with `fromSeq = lastSeenSeq`. Mixing the two without this `±1` adjustment is an off-by-one. This contract is fixed; do not "align" them.

One class of event escapes the cursor: a replay also re-sends every permission request still unresolved on the chat, whatever `fromSeq` asked for. The agent layer records an unanswered request only as a plain tool call, so without this a surface that connected after the prompt was produced would render a call with no approve/deny affordance and the chat would sit waiting on a decision it never offered. The consequence is that a surface holding a card already gets it again on any later replay, so surfaces identify a permission by its request id and ignore one they already hold (`14-design-web.md` § Main chat panel, `15-design-mobile.md` ## Chat detail).

## Scenarios

### Surface → server disconnect

- Surface notices WS close and its link state becomes `reconnecting` at once. The "reconnecting..." banner waits for the disconnect grace (see Surface connection state model).
- Surface tries to reconnect with exponential backoff (1s → 2s → 5s → 10s, max 30s).
- On reconnect: surface sends `hello` + `chat.replay {chatId, fromSeq}` for every chat whose transcript it already holds (the open chat and any chat with a rendered timeline), rather than the whole roster (see When a surface requests a replay).
- Server relays replay request to the host. Host streams missed events.
- Inbound from user while disconnected: surface queues in-memory. Emits on reconnect. If the surface is killed before reconnect, queued messages are lost — users get a "not sent" indicator.

### Host → server disconnect

A host dials out to the server, so this fires whenever that link breaks: the host or server restarting, or a laptop host sleeping, changing network, or moving out of range. Reconnection is a normal operating mode.

- Host marks itself as trying-to-reconnect. In-flight `query()` runs continue locally; their output buffers in host memory.
- Outbound events (chat messages, tool calls) buffer in host memory (bounded — 10k events per chat; drop oldest with a warning if exceeded).
- On reconnect: host sends buffered events in order.
- Server marks the host as `online` again. Surfaces get `daemon.online` and their chats re-sync.

### Surface connection state model

A surface tracks two independent things and shows them as two indicators: the WS link to the server, and host presence. The server can be reachable while a host is down.

- The WS link has four states: `connecting` · `connected` · `reconnecting` · `offline`.
- Host presence is tracked per `daemonId`: `unknown` · `online` · `offline` (`unknown` until that host's first `daemon.online` / `daemon.offline` greeting arrives on connect). A chat's indicator reflects the presence of its own host.
- No offline flash on load. On first launch a surface is `connecting` with `unknown` host presence, and shows a neutral, quiet indicator until a connection has been established. The offline/reconnecting treatments are for `reconnecting` (was connected, dropped) and `offline` (a connect attempt has failed) only.
- Disconnect grace: idle is not a disconnect. The link state is always reported truthfully and immediately (diagnostics, composer, connection dot), but the reconnecting/offline banner only appears once the app has been in the foreground with the link down for 3s. Mobile OSes drop a backgrounded app's socket, so a close while backgrounded arms nothing, and on returning to the foreground a surface with no live socket dials at once (skipping any pending backoff step) and starts the 3s grace from there — a resume reconnect that lands within it never shows the banner. Backgrounding hides a banner already up; if the link is still down on return, it reappears after a fresh grace. A successful reconnect clears it.
- The host should dial the server as early as startup allows, and its first reconnect backoff step is short (≤1s) so a transient miss recovers within about a second.

### Hosts fail independently

Offline is per host:

- Chats on reachable hosts stay usable while another host is down. The banner
  names the affected host and appears with that host's chats.
- Every buffer below (pending webhook/cron payloads, queued surface input) is
  keyed per host and flushed when that host reconnects.
- A chat, job or voice request stays with its own host, whose folders, tools and
  state are the ones it needs (`04-chats-and-folders.md`).
- While the home host is offline, Manager and Speakers are unavailable,
  and the surfaces say so (`06-threads-manager-speakers.md`). Announcements
  on the channels those threads mediate still go out from the hosts that own them
  and are still recorded, so the thread has them as context on its next reply
  (`09-notifications.md` § The broadcast log).

### Host-offline UX

A host being unreachable is a first-class, explained UI state. When a surface knows a host is offline:

- The banner appears immediately the moment the surface learns the host is offline — both on a live `daemon.offline` transition AND on (re)connect, because the server sends the current host status as an `auth.ok` greeting so a surface that connects after the host dropped shows it as offline. There is no window where the UI says "connected" while the agent is actually unreachable.
- A persistent banner states that the host is unreachable and that messages will be queued and sent when it reconnects, with a tap-through to Settings → Hosts. It is scoped to that host's chats, and becomes app-level when every host is offline.
- Navigation stays fully available — the user can read history and browse chats/settings everywhere.
- The composer stays usable and QUEUES. A message into an existing chat, or an editor save, sent while its host is offline is ACCEPTED, rendered in a distinct queued — "will send when the agent reconnects" state, buffered, and delivered automatically on reconnect (see Guaranteed input delivery below). It is always accepted and always delivered. Spawning a new chat on an offline host is refused up front instead, because the folder cannot be validated (`04-chats-and-folders.md` § Spawn). Only real-time-only controls that genuinely cannot be queued — a voice note/call, where audio is ephemeral — render visibly disabled with a daemon-offline reason.
- This state is distinct from WS-`reconnecting` and is shown as such.

### Connection diagnostics screen

"Can't reach the agent" is the single most common way Patch looks broken, and a bare `Reconnecting…` banner tells the user nothing they can act on or report. Every surface therefore has a connection diagnostics screen: a real error screen that says what it tried, what happened, and hands over a copyable report.

When it takes over the app (blocking). Only when the surface has yet to establish a WS link in this session AND at least two connect attempts have failed. That is the case where there is nothing else to show — no roster, no transcripts — so a banner over an empty shell is a worse lie than an error screen. It respects No offline flash on load: the first `connecting` attempt shows the quiet neutral indicator.

Closing it is always available. The blocking takeover carries the same Close as the on-demand overlay — leading with the error screen is not the same as trapping the user behind it, and a surface with nothing to show is still a surface the user is allowed to look at. A closed screen stays closed for the rest of the session: attempts keep failing in the background, and re-taking the window on each one would be an overlay that cannot be left. The banners' Diagnose action is how it comes back.

When it is opened on demand (non-blocking). In every other disrupted state — WS `reconnecting` after a good connection, or WS connected with the host `offline` — the existing banners stay exactly as spec'd (navigation available, composer queues) and each carries a Diagnose action that opens the same screen as a dismissible overlay. A surface with a host offline stays navigable behind it (see Host-offline UX).

What it runs. The screen runs the diagnostics itself, on open and on every Retry — it re-runs rather than restating cached state:

| Check      | How                                                                                                                                   | Distinguishes                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Credential | stored surface credential present + well-formed JWT                                                                                   | "not paired" from "paired but rejected"                                                                     |
| Server     | `GET /api/healthz` (public)                                                                                                           | server unreachable (DNS/TLS/offline machine) from server up; reports `version`+`gitSha`                     |
| Host links | `GET /api/daemon/healthz` (authed) — one line per registered host, 401 on a bad credential                                            | a host being down from the server being down from a rejected credential — the whole point                   |
| WebSocket  | live surface state: URL, connection state, failed-attempt count, last close code/reason                                               | a socket that failed to open from one that opened and dropped                                               |
| Protocol   | what forward compatibility absorbed this session (`03-wire-protocol.md` § Forward compatibility): fields ignored, event types dropped | a surface that is merely a little behind its agent from one that is missing behaviour the agent already has |

The Protocol check is the one place a surface admits it is older than its agent,
and it grades the two cases differently. **Ignored FIELDS pass**: the agent sent
something this build has no use for, which is drift worth seeing and nothing
worth acting on. **Dropped event TYPES fail**, naming the types and saying
"update this surface": the agent is emitting behaviour this build does not
implement at all. It is listed last so an upstream failure — no credential, no
server, no host — still supplies the screen's headline; being behind is never
the story when the link is down.

Each check renders pass/fail with its actual detail text (HTTP status, thrown network error message, version strings) — a check that could not run says so, and renders as its own state rather than a pass.

On mobile, Settings → Account → Reconnect to server opens diagnostics even while offline. Diagnostics includes Pair again, available while checks are running, which closes the overlay and opens the pairing scanner. A saved credential without a server route is incomplete pairing: startup opens pairing instead of the tabs and does not start network services. Completing pairing starts the connection and app services immediately, without restarting the app.

Retry cancels the reconnect backoff and dials immediately (backoff resets to its first step), then re-runs the checks.

Report copies a plain-text diagnostic report — timestamp, origin, WS URL, surface build version/sha, connection state, and every check line — to the clipboard, so a broken surface can be reported from the surface itself.

### Guaranteed input delivery (surface → host)

A user's `chat.input` is either delivered or reported as failed. There are two hops (surface↔server, server↔host) and each can flap mid-send: a message handed to a socket that dies a instant later is gone with no error, and the in-memory server→host buffer only catches inputs submitted while the host is already detached — not one lost to a flap, nor one lost when the server process itself restarts. The buffer is necessary but not sufficient; delivery is made resilient by tracking every input to completion:

- Idempotency key. Every `chat.input` / spawn carries a `localId`; the host dedups on `(chatId, localId)`, so re-delivering the same input is a safe no-op. This is what makes blind retry correct.
- Pending until observed. The sending surface marks the message pending the instant it is submitted and keeps it pending until it OBSERVES the turn take effect: a `chat.input_ack` (below), the chat going `running` for that turn, a `chat.queued {localId}`, the assistant `chat.message`, or a `chat.error`. Pending messages render in the distinct "sending…/queued" style — the style says whether the turn actually started.
- Ack. The host emits `chat.input_ack {chatId, localId}` the moment it accepts an input for processing (before the first token); the server relays it. This is the positive receipt that retires the pending state even before output streams — and distinguishes "delivered, working" from "lost".
- Timeout → idempotent redelivery → loud failure. If a pending input is neither acked nor observed-running within a bounded window (~8s), the surface re-delivers it (same `localId`; the host dedups if it did arrive). After a few failed attempts it stops and shows a persistent "not delivered — tap to retry" affordance on that message. A turn NEVER sits as a silent spinner forever — it resolves to running, to an error, or to a retry affordance.
- Tapping retry is chat-wide, not message-wide. Consecutive sends can each fall into the same flap and pile up as several "not delivered" messages in one chat; tapping retry on any one of them re-sends it AND every other still-pending input in that chat submitted before it (idempotent — same `localId`s, the host dedups), so one tap un-sticks the whole backlog instead of making the user hunt down and tap each earlier message individually. Inputs submitted after the tapped one are untouched — they are still on their own timeout/retry schedule.
- Queue across an offline host. While host presence is `offline`, inputs are queued (server-side per-surface buffer — cap 10k, drop-oldest with a warning — when only the host is down; surface-side when the server is also unreachable) and flushed in arrival order on reconnect, where ack/observe proceeds as above. The surface shows them as queued with the reconnect reason.
- Survives a server restart. The server→host buffer is in-memory, so a server restart drops it — but the surface still holds each un-acked input and its pending-timeout redelivers it once the surface's own WS re-establishes. The surface is the source of truth until it sees an ack.
- A turn that was delivered, started, and then failed for an unclassified reason (as opposed to a specific, recoverable case that gets its own error message, like an offline host or an invalid session) is reported on the message that failed, the same "tap to retry" treatment as an undelivered input, rather than as a separate line in the transcript — every "this didn't get a reply" case looks and behaves the same regardless of which hop broke. Retrying resends the message's text as a brand new turn: the original is already recorded as run, so resending its exact input would be deduped into a no-op rather than actually retrying it.

### Server dies

- All connections drop.
- Surfaces show offline. Hosts buffer.
- When server restarts: clients reconnect, replay everything.
- Until a host has reconnected and re-announced its chats, the server does not
  know which chats are on it. A request naming a chat it does not hold is
  answered `503` naming the host that has not reported yet and whether it is
  reconnecting or offline, never "chat not found". Only once every registered
  host has reported is an unknown chat a `404`.

### A host process dies

- All in-flight SDK queries die with the host (the SDK runs in-process; there are no orphan subprocesses to keep alive).
- the agent's native session history (`~/.claude/projects/<encoded>/<session>.jsonl`) is unaffected — it's already on disk up to the last persisted message.
- On host restart: scans `~/.patch/chats/*/meta.json`, marks every chat as `idle`. No PID lookups; no reattach. The next user message for any chat triggers a fresh `query({ resume: meta.claudeSessionId, prompt: <message> })` and the SDK reconstructs context from the JSONL.
- Server notified of `daemon.offline` during the gap, `daemon.online` + per-chat state on recovery.
- A query that was mid-tool-call when the host died loses that tool call. The user (or the host's pending-action queue) decides whether to retry; typically the agent's next turn continues, since the agent sees the partial state via resume.

### A host reboots

- Same as "host process dies." Nothing extra to do. SDK has no live state to restore, only history; resume covers it.
- Chats with no turn owed come back idle and stay there — a reboot does not wake a chat that was already finished.

### A turn only dies for a reason someone chose

A turn is owed until it settles. It stops being owed when the user stops it, the
credential is refused, the session is gone, or its retries run out — and for no
other reason. Everything else the host can be hit with is temporary and is
waited out:

- **A usage or rate limit.** The turn is parked until the limit resets and then
  re-sent. `resetsAt` comes from the SDK's `rate_limit_event` (soonest of the
  session and week windows, so a 5-hour limit is not deferred to a 7-day one);
  with no `resetsAt` to hand, 60 seconds. A 529 overload backs off instead,
  5s doubling to a 60s cap. Detection is on the fields the provider states
  structurally on the failing message — the typed error kind and the
  `quotaLimits` block beside it. The error text is the fallback for a provider
  that sends no such block, and it is needed: a hit limit sometimes arrives as
  prose only ("You've hit your limit · resets 5pm (UTC)"), so matching
  `usage_limit_exceeded`-style codes alone silently drops the very case this
  exists for. A structured block that says the account is not blocked is an
  answer, not a gap — the prose behind it is not consulted.

  AUTO-RESUME DECIDES WHETHER A TIMER IS SET, NOT WHETHER THE FAILURE IS
  UNDERSTOOD. With it off, or once a retry budget is spent, the turn is still
  owed and still carries the same structured notice — without a resume time,
  because none was scheduled. `Try now` re-sends the owed turn. A stated limit
  never goes on the generic retry ladder below: the window resets hours away,
  so three attempts a minute apart only fail three more times, each one saying
  so again everywhere a failure is reported.

  IT IS NOT A BANNER. The failure carries a structured `limitBlock` — which
  account, which pool, how full, when it clears — and the surface renders it as
  A MESSAGE IN THE TRANSCRIPT, under the turn it belongs to. It is about the reply that is not coming yet, so it
  reads as the next thing in the conversation; in the chrome above it, it was
  one more permanent-looking strip among six.

  THE HEADLINE NAMES A POOL A PERSON SPENDS — the session (5-hour) or the week
  (7-day). NEVER the overflow. Overage is what covers for those two when they
  empty; naming it as the limit reached produced "Extra usage limit on Default",
  a sentence about a limit nobody reached that suggests no action. A rejected
  overage on its own blocks nothing and must not read as blocked anywhere.

  THE WAIT IS A COUNTDOWN, IN WORDS, AND IT TICKS — "It resets in 1 hour 3
  minutes, at 15:40". Not `1 h`: a unit symbol is not something a person says,
  and this is read by someone who is stuck. A countdown that does not count is
  a timestamp with extra steps. Where nothing stated a reset there is no
  countdown at all, rather than an invented one: a promise the limit has not
  made is worse than an open-ended wait. Only a reset the provider stated — on
  the failing message, or from the account's own windows — reaches the notice.
  The delay an auto-resume happens to be armed for is not one: with nothing
  stated it is a made-up minute, and publishing it makes every unstated limit
  claim to be over sixty seconds later while the account is still spent.

  AND WHEN THE RESET PASSES AND THE NOTICE IS STILL THERE, IT SAYS THE TRUE
  THING. A chat whose turn has started has no pause left, so a notice standing
  past its own reset means the turn demonstrably has not run: "That was 20
  minutes ago and this turn has not run", and `Try now` becomes the action
  rather than one of three equal controls. Not "it should be back now", which
  describes a limit as over while leaving the reply it is standing in for
  un-sent, with nothing to say what to do about it.

  WHAT CAN BE DONE ABOUT IT IS CONTROLS, NOT PROSE. `Try now`
  (`chat.resume_now_request`) abandons the wait and re-sends the parked turn on
  whatever account the host now resolves to, because the usual reason to press
  it is that the situation has changed. Whenever the pause ends the notice is
  withdrawn from every surface — when an armed wait elapses, whether or not
  there is still a turn to re-send, and when `Try now` finds nothing owed —
  because a notice that outlives its limit leaves a control that does nothing
  when pressed. A surface withdraws it on its own account too, the moment the
  chat reports a turn in flight (`running` or `awaiting-permission`): a running
  turn and a limit pause are mutually exclusive states of one chat, so that
  report is proof the pause is over whatever fields came with it, and a host
  path that forgets to publish the clear cannot strand a ghost notice. An
  `idle` or `errored` chat does not clear it. A usage limit is `errored` whether
  or not a resume is armed — the badge is the failure triangle and the
  notification a failure, never the green tick of a finished turn; only the
  transcript bubble differs, and no `chat.error` row is added for a parked one.
  (A 529 overload backoff is transient load and stays `idle`.) A `Resume automatically` checkbox binds
  to the host's own `autoResumeRateLimit` rather than inventing a second
  setting. And when extra usage is what failed to cover the limit, a link to the
  Claude usage settings carries that explanation in its tooltip — a link,
  because patch cannot flip an Anthropic account setting and a control that
  pretends to is worse than none.

  WHERE PATCH STATES A FAILURE ITSELF, THE PROVIDER'S SENTENCE IS NOT COPY
  ANYWHERE. A failure the provider states structurally is reported in patch's
  own words, built from those fields, and that one account is what every surface
  shows: the transcript, the chat's last error, and the run log of a job whose
  chat failed. The provider's sentence is diagnostic detail — it stays in the
  host log and as the raw field of the structured block — and is never
  rendered as the failure. Otherwise the same failure is read twice, once in
  patch's words and once in the provider's, and the two disagree about which
  limit was even reached. This is driven off the structured fields, never off a
  match on the wording: a failure patch has no structured account of keeps its
  real message, in full.

- **Any other SDK failure** — a dropped connection, a 5xx, a crash mid-stream.
  Retried on a 10s / 30s / 90s ladder. The chat still goes `errored` and still
  emits `chat.error` each time, so the failure is never hidden; the ladder
  either clears it or exhausts itself in the open.
- **The host dying mid-turn**, which is what every deploy does. Owed turns are
  written to `meta.json` as `pendingTurns` and re-sent on the next boot. That
  includes turns parked for a retry: a park can outlast the process, so it
  cannot live only in a timer.

`autoResumeRateLimit` (host state) gates the limit park, and is ON unless the
user turns it off. The generic ladder is not gated: a turn dropped by a network
blip is not a preference.

#### What a recovery leaves behind

A turn that recovered is ONE turn, however many goes it took. Every re-send —
a restart resume, a rung of the ladder, a limit park coming back — is the host
re-running a turn the user sent once, so it must not read as a message the user
sent again.

- The re-sent user `chat.message` carries `retryOfSeq`: the seq of the ORIGINAL
  user message for that turn, on every attempt, never the attempt before it. A
  surface folds the copy into the bubble already on screen instead of drawing
  the same sentence a second time. A surface never sends the field — a user
  retyping the same thing is a new turn.
- The link between attempts is written to the chat's `retryMarks` and spliced
  back on at replay. The agent's own transcript records each attempt as an
  ordinary user turn and knows nothing about the one it repeats, so without this
  the fold would come apart on reload.
- **A failure that has been superseded is not an outcome.** As the turn goes
  round again, the marks that said it failed come off: the `turnFailed` flag on
  the bubble, and the server's out-of-band `daemon_unavailable` card. They are
  not thrown away — each is filed on the ATTEMPT it ended, where the surface's
  `< >` pager can still reach it. Only a genuinely settled failure — the ladder
  exhausted, or nothing ever resumed — leaves a mark at rest, and that one keeps
  its `Tap to retry`.
- A turn that went round again says so, on the message's own meta strip
  (`14-design-web.md` § Messages): `Retried once` / `Retried twice` /
  `Retried N times`.

**Why it matters.** Unattended work has no one to notice. A job-spawned chat
that dies on its first turn has not yet claimed its task, so it leaves no trace
anywhere — the job records the _spawn_ as `ok`, and the task looks like one
nobody ever filed. A job's run log therefore records a `chat-error` entry
against the job when a chat it spawned fails, in addition to the earlier `ok`
for the fire itself, and a chat's `lastError` is persisted for every error code
rather than only for an invalid session, so a restart cannot erase why it died.

### Webhook arrives while a host is down

- Server can't route to that host. Stores the webhook payload in `/data/pending/<daemonId>/<jobId>-<fireId>.jsonl`.
- When that host reconnects, server flushes its pending payloads.
- Bounded: max 100 pending per job, oldest dropped with a log line.

### Cron fires while a host is down

Patch's server owns the cron scheduler (see `08-triggers-and-jobs.md`), so a tick still fires regardless of host presence. Routing the resulting action is the question:

- Server fires the trigger, evaluates the filter, resolves action templates as normal.
- If the action's host is connected, it dispatches over that host's WebSocket.
- If that host is offline, the action payload is written to `/data/pending/<daemonId>/<jobId>-<fireId>.jsonl` (same path as buffered webhooks) and flushed when the host reconnects.
- Bounded the same way: max 100 pending per job, oldest dropped with a log line.

If a host stays offline through multiple cron firings, the user gets a backlog of spawns/messages on reconnect rather than missed work. For idempotent jobs (e.g. "spawn a daily bus-watch chat") this is usually fine; for jobs where a backlog would be wrong, the job should set its own dedup key inside the spawned chat's prompt.

A backlog released by a reconnect is still subject to the job's own concurrency limit (`08-triggers-and-jobs.md` § Concurrency) — a host coming back does not let a limited job run its whole backlog at once. This is the difference between the two queues: the pending buffer is per host, capped, and drops its oldest when full; the concurrency queue is per job and unbounded — a fire waits, it is never refused.

In-chat timers use `patch_wake_me` (`02-daemon.md` § Self-wake), which is durable across host restarts: the pending wake is persisted to disk, re-armed on boot, and any wake that came due during downtime fires once on restart. (the agent's native `CronCreate` would NOT survive — it's scoped to one in-process query and dies with the turn — which is exactly why patch disallows it and owns the timer itself; see `principles.md` § Tool ownership.)

### Voice session mid-disconnect

- All voice surfaces (phone, web, voice device) stream audio to the host over WSS for host-side Whisper + Kokoro. If the WSS drops, the audio session ends. On the phone/web, surface UI shows "voice disconnected" and falls back to text input. On the voice device, LED ring shows the disconnected state and returns to idle.
- Reconnect resumes the next voice session from scratch — audio sessions are not replayed on reconnect (audio is ephemeral).
- If a voice user-turn message had been transcribed but not yet delivered to the chat when WSS dropped, the host retries on reconnect. If retry fails within 10s, the surface is told "delivery failed, try again."

## What we don't do

- No cross-region failover.
- No message deduplication beyond `seq`. If a host emits `seq` 42 twice (shouldn't happen, but belt-and-braces), server sees both and forwards both.
- No transactional guarantees across chats. Each chat is its own stream.
- No end-to-end receipts for notifications — we don't confirm a user actually saw a push. (User input, by contrast, IS delivery-guaranteed — see Guaranteed input delivery. The distinction: an input we accept must reach the host or fail loudly; a push is fire-and-forget.)

## Observability

- Every WebSocket connect/disconnect logged with reason code.
- Host heartbeat dashboard in the web app (admin/developer view).
- `patch doctor` (CLI) runs: check server reachability, per-host status, pending webhook/cron count, chat errored count. See `17-cli.md`.

## Cross-refs

- Sequence numbering on events: `03-wire-protocol.md`
- Host resume mechanics: `02-daemon.md`, `04-chats-and-folders.md`
- Surface heartbeat + presence: `05-surfaces.md`
- Notification-on-disruption: `09-notifications.md`
