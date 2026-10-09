# Notifications

Outbound messages from a chat to the user (not to another agent).

## Notifications are a doorbell, with a bell to look back at

A notification is a doorbell first: it exists in the moment, on whichever surface it reaches, and the OS keeps its own copy (phone notification centre, macOS notification centre). The user can still miss one, dismiss it by accident, or have it suppressed while a surface was foregrounded, so the server also keeps a short log of what agents sent, and the web surface shows it behind a bell.

- **What is logged:** every agent-sent notification (`patch_notify` at any importance, and `patch_ask_human`'s push). Not logged: a `patch_call` ring, and the notifications the server raises itself (turn finished, permission waiting, batch check-in) — those have their own place in the sidebar (`04-chats-and-folders.md` § Current status).
- **Entry:** id, source chat, message (as the agent wrote it), importance, `deepLink` if any, time sent, and read state. Logged whether or not the channel was suppressed — the log is "what the agent said", not "what reached me".
- **Read state is account-wide and server-held**, so reading on the web clears the badge everywhere. An entry is unread until the user opens it from the bell (which also opens its source chat) or presses "Mark all read". Nothing else marks one read — in particular, a push being tapped does not, since the log is a separate surface from the OS tray.
- **The bell** sits in the web header. It carries a count of unread entries (none shown at zero). Opening it lists entries newest first, unread ones visibly distinct from read ones. Clicking an entry marks it read and opens its source chat.
- **Retention:** the newest 200 entries. Older ones are dropped; read ones are never dropped before unread ones within the cap.
- **Live:** a change to the log is broadcast to every surface as `notifications.changed` (`03-wire-protocol.md`), and surfaces refetch.
- The source chat stays the canonical record: every `patch_notify` call is also a tool-call entry in the source chat's history. There is still no cross-channel timeline of OS-level toasts — the bell shows what agents sent, not how it was delivered.
- The server's broadcast log (speakers) stores broadcast metadata for the agent's reply-context purposes. The thread's agent sees it only when interpreting a reply.

Not in the bell: it is not how a chat becomes worth looking at later. That is a status (`04-chats-and-folders.md` § Current status), persisted and set by a different tool. A notification does, however, un-archive and un-hide its source chat (`04-chats-and-folders.md` § Current status), so the chat that rang is in the list when the user follows it.

REST: `GET /api/notifications` → `{ items, unread }`; `POST /api/notifications/read` with `{ ids: string[] }` or `{ all: true }` → the same shape.

## `notify` vs `send_to`

These are the two cross-chat tools and they answer different questions:

| Tool                                               | Receiver                                                                                | Persisted as                                                                                                                                                             |
| -------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `patch_send_to(chatId, message)`                   | An agent in another chat.                                                               | A `user`-turn message in the recipient chat. The recipient's agent processes it as if you said it and will respond conversationally.                                     |
| `patch_ask_human({ task, why? })`                  | The user, when only they can unblock the agent. Pushes and un-archives the source chat. | Tool-call record in the source chat.                                                                                                                                     |
| `patch_notify({ message, importance, deepLink? })` | The user, on whichever OS surface the server picks from their presence.                 | Tool-call record in the source chat. Nothing in the recipient thread's session JSONL — see Broadcast context below for how the receiving thread's agent learns about it. |

Mental shorthand: if the destination is an agent, it's `send_to`; if the destination is a human, it's `notify`.

## Channel ≠ surface

Two distinct concepts:

- Surface = where patch the app runs: web app, mobile app, voice device. A surface hosts an active session of patch.
- Channel = where a notify gets delivered: phone push, desktop OS toast, voice speaker.

They overlap (your phone hosts both the mobile-app surface and the phone-push channel) but they're different concepts.

`patch_notify` takes no channel. The agent says how much a message matters and the server picks the channel from where the user is (§ Presence heuristic).

## The `patch_notify` tool

Available to every chat (project chats, special threads, automated jobs):

```typescript
patch_notify({
  message: string,
  importance: 'silent' | 'normal' | 'urgent',
  deepLink?: string,
  quickReplies?: string[] // at most 2
})
```

**An agent knows two things: what it has to say, and how much it matters.** It does not choose a channel, and there is no channel argument. Which surface a notification reaches is a fact about where the user is standing, and the server is the only thing that knows it: **desktop when he is at a computer, phone when he is not.** Every rung goes by the same rule, `urgent` included: urgent is normal with a more urgent sound, not a different destination.

Speaking out loud is a different act, not a delivery option, so it is its own tool:

```typescript
patch_speak({
  message: string,
  deviceId?: string
})
```

It fills the room, anyone in it hears, and nothing is left behind to read later. `deviceId` names a speaker; omitted, the host runs the cascade in `### speakers`.

`deepLink` is a URI for an installed app — its own custom scheme (e.g. `citymapper://directions?...`) or an `https://` link the OS routes to that app — that the notification should open instead of the source chat. Only a delivery that lands as a push acts on it (see `### push` below); a desktop toast or a speaker ignores it. Every notify's tool-call record carries whatever `deepLink` was given, so the chat transcript shows the same tappable link that fired (`04-chats-and-folders.md` § tool-call rendering, `14-design-web.md` § Main chat panel, `15-design-mobile.md` § Chat detail).

`quickReplies` is at most 2 short strings the agent can predict as likely answers (e.g. `["Yes", "Snooze 10 min"]`). Each becomes its own button on a push or desktop notification (§ Notification actions); tapping one sends that exact text back into the source chat as the user's reply, the same as typing it. Omitted, the notification carries Reply alone.

The call is fire-and-forget from the source chat's POV — a tool call recorded in the source's history, after which the host takes it from there.

## `patch_ask_human` — blocked on a person

Permissions and questions already escalate themselves: a chat that blocks on either comes out of Archived and pushes (`04-chats-and-folders.md` § Lifecycle, § Waiting on you). That covers a decision to make and a tool to approve. It does not cover the third case — work only a person can do, in the world:

```typescript
patch_ask_human({
  task: string,
  why?: string
})
```

Granting a permission the OS will only take by hand, plugging something in, signing a form, taking a photo. The agent is blocked, but there is nothing to approve and nothing to decide, so neither existing path fits, and without this a job in that position can only write into a chat nobody is looking at.

It pushes at the alert rung and **declares the chat's status as `question`** (`04-chats-and-folders.md` § Current status), which un-archives it on the same one-way rule as a permission block: a chat blocked on a person cannot stay hidden. Blocked on an answer and blocked on a person are the same fact about the chat, so they are the same kind.

Declaring is what makes the ask survive the notification. `task` becomes the line on the chat's row and is persisted, so a missed push does not lose the request and a restart does not either — it used to un-archive and nothing else, leaving the task inside a notification that had already gone, and a row that read as merely finished. It stays until the user puts a turn into the chat. Write `task` as an instruction the user could follow without opening the chat; `why` carries the consequence of not doing it. Having called it, the agent decides for itself whether to wait or carry on with whatever is still possible — the platform does not park the turn on its behalf.

## `patch_report` — worth seeing, nothing blocked

The third and only agent-elected way into the sidebar (`04-chats-and-folders.md` § Current status):

```typescript
patch_report({
  summary: string, // ≤200 chars
});
```

A permission is a request the platform is holding and a question is the chat being stuck; a report is a judgement. Of twenty jobs that ran overnight, this is one of the one or two worth a person's morning. It takes the chat out of Archived and puts `summary` on its row, and it **makes no sound** — that is the point of having it. Before it existed, every route out of hiding was welded to an interruption, so a job with something worth seeing later had to either push or stay invisible.

Because the agent elects it, the bar belongs in each job's own prompt: a run that did what it always does and found nothing unusual says nothing and stays hidden. `summary` is the finding itself ("the backup has been failing silently since Tuesday"), not a description of the run ("backup check complete"). A report and a notification are independent — send both when something is both urgent now and worth seeing later.

## `patch_call` — the phone-call escalation tool

`patch_notify` is one-way speech / text. When an agent wants to engage the user in a sustained voice conversation — Manager ringing you on a walk, an urgent build-failure escalation, a chat saying "I need a decision before I keep going" — it calls `patch_call` instead. See `06-threads-manager-speakers.md` § Cross-chat toolset for the full signature.

`patch_call` rings concurrently on phone (Android `ConnectionService`) and desktop (window-raise + chime banner); first surface to accept wins, the others stop ringing. On accept, the call drops directly into the voice-call overlay (see `07-voice-app.md` § Voice-input modes) targeting the calling chat — not Manager, the chat that called. So a project chat can ring you and you end up in voice with that project chat's agent.

If everyone misses (decline / 30s timeout / all surfaces offline), `patch_call` falls back to a `push` notification carrying the original `reason` text. The failback push is the user's prompt to open the chat manually.

A call demands attention in a way a notification doesn't, so agents reach for it sparingly. CLAUDE.md guidance for Manager and other proactive chats specifies when calling is appropriate ("only ring if I haven't replied for an hour and the question blocks progress").

## Reaching the user

How Patch is allowed to reach the user when no voice session is open is one account-wide setting with two values, set from the Manager surface (`14-design-web.md` § Manager view) and left alone for hours at a time:

| Reach         | What it does                                                             | Good for                                          |
| ------------- | ------------------------------------------------------------------------ | ------------------------------------------------- |
| `notify`      | outbound only — notifications, and a ring the user can accept            | a walk: nothing to check, music playing           |
| `auto-notify` | the same, plus Patch may speak an interrupt aloud without being accepted | driving, or hands in plaster: it reads itself out |

Under `notify` an agent has four rungs and picks the lowest one that fits:

| Rung       | How                                      | What it takes                                               |
| ---------- | ---------------------------------------- | ----------------------------------------------------------- |
| aside      | `patch_notify` at `importance: 'silent'` | nothing now — it is there when the user next looks          |
| alert      | `patch_notify` at `importance: 'normal'` | a notification, suppressed while a surface is foregrounded  |
| high alert | `patch_notify` at `importance: 'urgent'` | a normal notification with a more urgent sound              |
| ring       | `patch_call`                             | the user's attention now — it rings, and they accept or not |

A high alert is the normal rung with a different sound, and nothing else: it is routed the same way, held back by the same foregrounded-surface suppression, and shown the same way. Only what it sounds like changes, so the user can tell from across the room that this one matters. A `patch_call` ring is the rung that gets through regardless.

An aside is the opposite end of the same idea: its own quiet channel, no sound, no vibration, no heads-up. It is also **exempt from suppression**, which reads backwards until you see what the rung is for. An aside asks for nothing now; its whole value is being on the phone when the user next picks it up. Suppressing it because a surface happens to be foregrounded would delete it rather than defer it. It is the rung for a watcher's daily line, an evening summary, anything worth knowing and not worth interrupting for.

The rung is the agent's call. Patch carries out what each one means and does not second-guess the choice, demote a rung it thinks is over-stated, or ration how many an agent sends — the platform gives arms and legs, it does not decide what matters.

Under `auto-notify` the first two rungs are unchanged; the third does not ring. A `patch_call` is spoken aloud on the surface the user is at instead, in the short no-microphone session of `07-voice-app.md` § Speaking with no session open. Nothing is accepted and nothing is answered — the user hears it and carries on, and opens a session if they want to reply. This is the mode for a phone in a pocket with a podcast on: each interrupt pauses it, is read out, and hands it back.

When a sustained voice session IS open, both settings are moot — a `patch_call` speaks into that session (`07-voice-app.md` § Which surface it reaches), because ringing a user who is demonstrably already connected is the wrong doorbell.

Silencing Patch altogether is the operating system's job, not a fourth value here: Do Not Disturb already does it, for every app at once.

## Direct replies vs `patch_notify`

`patch_notify` is for asynchronous outreach — the agent decides to push something to the user that isn't a direct reply (bus reminder fired 20 min later, build failed, scheduled job result).

It is not the mechanism for replying to a turn the user just sent. Direct replies route automatically back to the source channel (per `06-threads-manager-speakers.md` § Reply routing):

| User turn arrived via                            | Direct reply auto-routes to            |
| ------------------------------------------------ | -------------------------------------- |
| Speakers (physical voice device with `deviceId`) | TTS on the originating device          |
| Web/mobile composer in any chat                  | The same surface (text in the thread)  |
| Manager voice queue                              | Voice on the surface holding the focus |

Use `patch_notify` only when the message is unsolicited or destined for a different channel from the one it came in on.

## Notification actions

A `push` or `desktop` notification carries inline actions so it can be acted on without opening the app, on top of the tap-through that already opens the chat (or a `deepLink`). What actions it carries follows from what kind of notification it is:

| Notification                                                  | Actions                                                                                                                                                         |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Any chat notification (turn finished, failed, `patch_notify`) | Reply — a text field whose typed text sends as the user's own message into that chat (queued if the chat is already running).                                   |
| Pending permission (an ordinary tool approval)                | Approve / Deny. Approve requires the device to be unlocked, because approving can run a command; Deny and Reply both work from the lock screen.                 |
| Pending question (`AskUserQuestion`)                          | Its options as buttons, when there are 3 or fewer and it's a single question with a single-select answer. Otherwise, Reply — the typed text becomes the answer. |
| `patch_notify` with `quickReplies`                            | Each of up to 2 short strings renders as its own button alongside Reply; tapping one sends that exact text as the user's reply (spec/06 § `patch_notify`).      |

Tapping the notification's body (rather than one of these actions) still opens the source chat, or follows a `deepLink`, exactly as without actions.

A reply/action that can't be delivered (offline, not authenticated) keeps the notification up, reading "Not sent — tap to retry", and keeps whatever was typed — tapping it again retries the same thing. Nothing an action tries to send is ever silently dropped. A delivered reply/action updates the notification to read "Sent".

Every action answers the SAME request the full app would: a Reply's text is an ordinary chat turn; an Approve/Deny or an option answers the pending permission/question by its `requestId`; a quick reply sends its text as a chat turn.

## Channel semantics

### `push`

Routed via Expo's push API to the user's registered Android phone. The server holds no push credential of its own — it posts the message and the phone's registered Expo push token to Expo, which delivers it on to the device. Goes straight to the OS — no thread record needed; there's no agent that processes the user's tap. Tapping the push opens the source chat in the patch app, unless the call carried a `deepLink` the notification's own text names (`15-design-mobile.md` § Push notifications), in which case the tap opens that URI instead — standard Android intent resolution (the installed app if its scheme/link is registered, otherwise whatever the OS falls back to), not something the host or server picks between. `deepLink` only changes what a _push tap_ does; the chat itself still opens normally from the sidebar or by tapping the `patch_notify` row in its transcript.

Suppression rule: only fires if no surface has sent a `surface.heartbeat` in the last 30 seconds. If any surface is foregrounded, push is suppressed — the user will see the activity on the active surface instead. `importance: 'silent'` overrides, because it is too quiet to be worth holding; `urgent` does not, because it is normal with a louder sound. A `patch_call` ring's fallback push also overrides.

Every push is sent at FCM **high priority**, whatever the rung. Normal priority is deferred while an idle Android phone is in Doze, and a phone idle in a pocket is the very case push exists for; the rung is carried by the channel, not by message priority.

Each rung is **interpreted per surface** — it is a statement about how much this matters, not an instruction about a mechanism, and every surface honours it in its own terms. On Android that means a notification channel, because a channel is the only thing there that controls sound and vibration (message priority merely decides how promptly the device wakes): a silent push carries the LOW-importance `patch_quiet` channel with sound and vibration off, a normal one the default channel and sound, and an urgent one the `patch_urgent_alert` channel, which plays the app's bundled urgent sound (`res/raw/patch_urgent.wav`). A phone on an APK older than that channel shows an urgent push with the ordinary sound. On the desktop the same three rungs are a silent toast, an ordinary toast, and a toast with a more urgent system sound. The rung crosses surfaces; the mechanism never leaves the surface that needs it, and no agent ever names one.

A push from an **archived** chat un-archives it, one-way, exactly as blocking on a permission does (`04-chats-and-folders.md` § Lifecycle). The tap target of a push is its source chat, so a notification from a chat that stays archived points somewhere the user has no reason to look.

### `desktop`

Routed to the desktop notifier process. Direct OS toast — no thread record. A `patch_notify` reaches it when the user is at a computer (§ Presence heuristic); the notifications the server raises itself follow § Chat completion.

Clicking the toast brings the Patch window forward and opens the source chat in it, the same tap target a push has. The window is raised by the desktop shell and the chat is opened by the app running inside it, so both halves have to act on one click.

### `speakers`

Speakers are paired to one host (`16-voice-device.md` § Connection model), so the notify is relayed to that host — not the calling chat's — and that host synthesises the message via its Kokoro and broadcasts to a specific physical voice device. Resolution order:

1. Explicit `deviceId` in the call (e.g. `kitchen`) → speak there.
2. Most-recently-active device (per `16-voice-device.md` § Outbound routing) → speak there if it had a session in the last few minutes.
3. All devices at low volume → general announcement.
4. All devices offline / cascade exhausted → that host re-issues the message to the server as a `push` notify carrying the text and a deep-link. Voicemail.

Step 4 hands back to the server rather than that host reaching Expo's push API itself, so one machine holds the account's push tokens and one machine records the outcome.

`speakers` is one-way only — speak and end. No listening window after; if the user wants to reply, they wake-word the device or pick up a separate voice session.

The Speakers thread's agent is not in the delivery loop. Host calls TTS directly. The agent only gets involved when the user replies via voice — see Broadcast context.

Failures (Expo push rejected, a speakers voicemail whose push the provider then refused) are logged to `/data/undelivered.jsonl` and surfaced via `patch doctor`. Every channel either delivers on the server or comes back to it as a further notify, so that log has a single writer.

## Broadcast context

This is the mechanism that lets the Speakers thread make sense of a user reply ("snooze for 10 min" only means anything if the agent knows what was just announced).

### The broadcast log

For the thread that mediates a channel (Speakers), the server keeps an append-only broadcast log outside the agent session JSONL:

```
/data/broadcasts/speakers.jsonl
```

Each entry: `{ ts, sourceChatName, message }`. The server appends one as it routes a notify on that channel, whichever machine goes on to deliver it. Never read by the agent directly.

The log lives on the server because delivery is spread across machines while the thread that reads it is on one: the bot post happens on the server, a speakers announcement on the machine those devices are paired with, and the thread runs on the home machine (`06-threads-manager-speakers.md` § Where special threads run). The server is on the path of every notify (`03-wire-protocol.md` § Notifications), so it is the one machine that can record them all, and an announcement made while the home machine is offline is still context when that machine returns.

A record is written as the notify is routed rather than on a machine's confirmation that it spoke or posted: an announcement that fell through to voicemail reached the user too, and a reply to it needs the same context.

### Injection on user reply

When the user sends a real reply into the Speakers thread (transcribed voice utterance), the home machine's host asks the server for that thread's pending broadcasts (`GET /api/broadcasts/:thread`, authed with its `daemonKey`) and constructs the SDK `query()` prompt by prepending a `<system-reminder>` block containing them:

```
<system-reminder>
Recent broadcasts delivered on this thread (newest last):
- 5 min ago: "washing machine done" (from chat: washing-machine-watcher)
- 1 min ago: "bus arriving in 8 min" (from chat: bus-watch)
</system-reminder>

snooze for 10 minutes
```

The model treats `<system-reminder>` tags as authoritative harness messages, interprets the user's reply against the broadcast list, and asks for clarification if it's still ambiguous.

Timestamps are relative (`5 min ago`) so the agent can judge whether a broadcast is still relevant — a reply 2h later may be unrelated.

### Persistence

The `<system-reminder>` block lands in the session JSONL as part of the user turn. On resume the agent sees prior reminders in its history, with the `min/h ago` timestamps making them clearly stale.

### Flush

After the agent commits a response to the user's reply, the host clears what it consumed (`DELETE /api/broadcasts/:thread?through=<ts>`, naming the newest entry it was given). Next reply only sees broadcasts that arrived since.

If the agent invocation fails (network drop, SDK error), no flush is sent — the broadcasts are still pending and will inject on the next attempt.

### Mid-turn arrivals

A broadcast that fires while the agent is processing a user reply lands in the log but is deferred to the next turn. The agent's current turn doesn't see it, and the `through` cutoff on the flush leaves it pending. Reading happens once at turn-start.

### Cap

Broadcast text injected into a turn is capped at 10k chars; the server returns the newest entries that fit, and the flush that follows clears the older ones along with them.

## Chat completion

When a chat's turn settles — its activity goes from running to idle — the server notifies the user without any agent asking it to. This, § A turn that failed, § Waiting on you and § Batch check-in are the four notifications Patch raises on its own; everything else on this page starts with a `patch_notify` call.

- Desktop fires on every desktop surface except one that already has this exact chat open — it is already in front of the user, so the toast would only repeat what the screen already shows. If Patch is open on the computer at all the toast appears there; if it isn't, the notification is simply not delivered anywhere.
- Push fires only when no computer surface is active — the user is somewhere other than the machine Patch is on. A live phone surface does not suppress it, since being on the phone is exactly when the push is the point.
- Archived, deleted and snoozed chats are skipped, as are the special threads — Manager and Speakers each already reach the user through their own channel, and a Manager sweep ending is caused by other chats finishing rather than being news of its own.
- A chat a job created is skipped when that job's action sets `notifyOnComplete: false` (`08-triggers-and-jobs.md` § Action). Absent — the default — the job's chats notify like any other.
- A chat that is a member of the currently-running batch (`14-design-web.md` § Batch mode) is skipped, and so is § A turn that failed below for the same chat — that is the suppression the feature is for. It applies for as long as the batch is running, check-in included: the one check-in notification already said what there was to say, and a member finishing afterwards must not go back to pinging one at a time. § Waiting on you is unaffected — a permission ask is not a finish, and stays live.

It goes out at normal priority, so overnight silence is Do Not Disturb's job as it is for every other notification here.

### What the message says

The message is `<name> finished`, and where possible `<name> finished: <what it did>`.

The name is the chat's own — its title, or a snippet of its first message when it has never been titled.

The trailing half is the best account of **this turn** available on the frame that settled it, in order:

| Source                              | What it is                                                                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `turnSummary` on the settling frame | The agent's own closing words — the last thing it said before the turn settled, flattened to one line and cut to notification length. |
| The chat's current status summary   | A model's after-the-fact reading of the settled thread (`04-chats-and-folders.md` § Current status).                                  |
| nothing                             | `<name> finished` alone.                                                                                                              |

The agent's own words come first because nothing else here was written by the thing that did the work. The status summary is second because it is second-hand and, more practically, because it is generated by a separate call that lands on a LATER `chat.state` than the settling one — so at the moment the doorbell rings it is usually the previous turn's line, or nothing at all. That is why this notification used to read as little more than the chat's opening message played back.

The chat's first-message preview is not in that list at any level. It says what was asked for once, not what just happened. It still resolves the name, where being a durable label for the chat is exactly the job.

`turnSummary` is read off the settling frame and not off the server's mirror of the chat, for the same reason `turnOrigin` and `turnStopped` are: the mirror is the fold of every frame so far and still holds the last turn's summary until this turn's arrives, while the frame is the one thing that speaks for the turn that just ended. The host clears it as the next turn goes running (`03-wire-protocol.md`), so a settling frame never quotes the turn before it.

It is optional on the wire, and its absence changes nothing: a host too old to send it leaves the message reading exactly as it did before the field existed. `null` is read the same way, and means the turn genuinely ended with nothing said — it finished on a tool call — in which case no line is invented to cover it.

### Whose turn it was

A chat finishing is only news if the user is the one waiting on it. Every turn therefore carries an origin — `user` or `machine` — and only a `user` turn rings the doorbell.

A turn is `machine` when the host started it for the chat rather than a person did:

| Machine-started turn                            | Why it is silent                                                                                                 |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| A self-wake firing (`02-daemon.md` § Self-wake) | This is the loop that checks something every few minutes. It is the whole reason the rule exists.                |
| The todo list advancing to its next item        | One request the user made becomes many turns; they would get a notification per item rather than per request.    |
| Another agent's `patch_send_to` landing         | The destination of a `send_to` is an agent, not a human (§ `notify` vs `send_to`). Nobody is waiting on the tap. |

Everything else is `user`: a composer turn from any surface, a voice turn, a fork or a side thread. Origin is a property of the turn, not of the chat — a watcher chat that loops silently all day still notifies the moment the user types into it themselves.

A retry inherits the origin of the turn it retries, and survives a host restart carrying it, so a user turn that had to go round the SDK-error or rate-limit ladder still notifies exactly once when it finally settles — and a self-wake that went round the same ladder still says nothing.

A chat draining a queue settles once, when the queue is empty (`04-chats-and-folders.md` § Message queueing), and that settle carries `user` if the user sent anything into the drain — a self-wake or a `send_to` that queued in behind their message and ran last does not swallow the notification they were waiting for.

The origin rides on `chat.state` as `turnOrigin` (`03-wire-protocol.md`). It is optional on the wire, and a host too old to send it is read as `user` — the value that preserves the behaviour that host already had.

The rule deliberately does not judge whether a turn's _content_ was interesting. An automated run with something worth saying says it with `patch_notify`, which none of this affects.

### A turn the user stopped

Stopping a chat (`04-chats-and-folders.md` § Stopping) is silent. The turn did not finish, the user is the one who ended it, and they already know where it got to. The Manager sweep (`06-threads-manager-speakers.md` § The sweep) leaves it out of its gate for the same reason — its `settled` edge means "finished its turn".

The fact rides on `chat.state` as `turnStopped` (`03-wire-protocol.md`), stamped when the stop aborts the turn and cleared as the next turn goes running. It cannot be inferred from `chat.stopped` instead: the two are emitted independently and their order differs by case — a bare stop settles idle before the stop is announced, while a stop with turns queued behind it announces the stop first and the next idle belongs to the promoted turn, which really did complete and must notify. Optional on the wire, and absent reads as not stopped — the value that preserves the behaviour a host too old to send it already had.

Only the stopped turn is silenced. A chat that is stopped and then given a fresh turn notifies when that turn settles, as does the promoted turn a stop exists to start.

## A turn that failed

A turn that errors out is the same news as one that finishes — the thing the user was waiting on is not coming — so it rings the same doorbell. It fires on the edge into `errored` (from `running`, or from `idle` for a pre-flight failure such as a missing folder), reads `<name> failed: <error>`, and is delivered exactly as § Chat completion is, to the same audience: a `user` turn, not stopped, on a chat that is not archived, deleted, snoozed, hidden, a special thread, or a job's with `notifyOnComplete: false`. The error is the chat's `lastError` message, flattened to one line and cut to 200 characters.

`errored` is not always the end of a turn, and only the end rings:

- A rung of the SDK-error retry ladder (`12-error-and-offline.md`) errors the chat and then runs the turn again. The frame that flips the chat `errored` says whether a rung is armed, as `turnRetrying` (`03-wire-protocol.md`), because the server decides on that frame and the retry is armed after it. The ladder's last rung carries `false` and rings; a rung that then succeeds rings as a completion instead.
- `daemon_unavailable` is the server's own stand-in for a link that dropped mid-turn, which the host resolves when it reconnects. It is transient (`TRANSIENT_CHAT_ERROR_CODES`) and never rings.

A usage limit nobody parked is a failure here — the turn is owed but nothing will run it until the user acts — while a limit with auto-resume armed is not, because the chat parks `idle` and runs again by itself.

`turnRetrying` is optional on the wire. A host too old to send it has every rung read as final: one notification per rung, never a failure missed.

## Waiting on you

A turn that stops rather than finishes is the other thing the server notifies on unasked. When a chat's activity goes from running to `awaiting-permission` — a permission decision, or a question asked with `AskUserQuestion` (`02-daemon.md` § Permission mode) — the turn is parked until a person answers it, and never reaches idle, so § Chat completion never covers it.

Delivery is identical to chat completion: desktop always, push only when no computer surface is active, at normal priority.

It fires on the transition into `awaiting-permission`, so a re-sent state frame is silent while a chat that blocks a second time in the same turn rings again. Deleted and snoozed chats are skipped, as are the special threads. Archived is not a case that arises: a chat blocking on the user leaves Archived as it does so (`04-chats-and-folders.md` § Lifecycle).

Origin is deliberately not consulted here. A machine turn is silent when it finishes because nobody was waiting on it; a machine turn that stops to ask is the opposite — it is the run nobody is watching, and it stays stopped until a human answers. This is the same judgement that unarchives such a chat.

The message names the chat and what is being asked: the question text itself for `AskUserQuestion`, otherwise the tool being requested and the description carried with it.

## Batch check-in

A running batch's check-in (`14-design-web.md` § Batch mode) fires exactly one notification, `Batch ready: N done, M still running`, on the time elapsing or (for `When all done`) every member finishing — whichever comes first. Delivery is the same desktop/push split as § Chat completion, and it opens the batch view rather than a chat. Pressing `Check in now` reaches the same checked-in state without firing it — the user is already looking at the view.

## Presence heuristic

Implemented in the server (see `01-server.md`). The question is whether the user is at a computer, and only input answers it: a Patch window can be open on a desk nobody is sitting at.

- Web and desktop surfaces send `surface.input { idleMs, scope }` every 15s, whether or not their window is visible. The desktop app reports the whole machine's input idle time (`scope: 'system'`), so typing in any app counts. A browser tab can only see its own page (`scope: 'page'`).
- `isComputerActive(account)`: some web or desktop surface reported within the last 45s, and its last input was within 2 minutes. A visible window with no recent input does not count. A terminal surface never reports.
- Phones still use `surface.heartbeat`, sent every 10s while the app is in the foreground. `isActive(account)` is `isComputerActive` or a phone heartbeat within 30s.
- Push routing reads one or the other before dispatching: `patch_notify` uses `isActive`, and the notifications the server raises itself use `isComputerActive`. At the computer, a notification is a desktop toast and the phone stays quiet; away from it, it's a push. Urgent follows the same rule.

## Delivery failure

If Expo's push API returns an error, log to `/data/undelivered.jsonl` and surface via `patch doctor`. There is no retry queue. `push` has no server-side credential to check: Expo's push API takes none, so a server with no push configured is not a state that exists — the FCM V1 credentials that actually reach the device are a one-time upload to the EAS project, made by the app publisher, never read from this server's env.

## Cross-refs

- Tool invocation path: `03-wire-protocol.md` (`notify` event)
- Presence mechanics: `05-surfaces.md`
- Voice surface mechanics: `07-voice-app.md`, `16-voice-device.md`
- Special threads: `06-threads-manager-speakers.md`
- `patch_send_to` semantics: `06-threads-manager-speakers.md` § Cross-chat toolset
