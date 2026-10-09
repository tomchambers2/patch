# Voice — App Surfaces (Phone + Web)

## Voice is a config matrix, not a fixed architecture

Every voice interaction is fundamentally the same shape — a two-way exchange with Manager — whatever triggers it. What varies is only the ENTRY (how a session opens) and, independently, which engine handles it. Four surfaces, each configured separately (spec/01 § Account settings → `voiceConfig`):

| Surface        | Entry                                                     | Layer axis applies?                   |
| -------------- | --------------------------------------------------------- | ------------------------------------- |
| **Dictation**  | Composer mic / gesture-bounded voice note                 | No — STT only, no agent turn to front |
| **Device**     | The physical voice device's on-device wake word (spec/16) | Yes                                   |
| **Hands-free** | An explicit toggle on phone/web/desktop                   | Yes                                   |
| **Call**       | An explicit call button                                   | Yes                                   |

Each surface independently picks a `backend` (`local` / `gemini` / `openai`) and, for the three conversational surfaces, a `layer` (`direct` / `light` / `heavy`). Nobody has used this long enough to know the right answer for any of the four, including whether they should even be different from each other — this is deliberately a matrix to test against, not a decision baked into the architecture. See `packages/server/src/settings.ts` for the exact schema and current defaults (everything starts on `local`/`direct` — no surface defaults to a paid backend or an unbuilt front layer). Settings presents each cell as one choice of engine rather than two axes: `Local`, `Gemini Flash` (`gemini`/`light`), `Gemini Thinking` (`gemini`/`heavy`), `OpenAI mini` (`openai`/`light`), `OpenAI` (`openai`/`heavy`); dictation, which has no layer, offers `Local`, `Gemini`, `OpenAI`.

- **`backend: local`** — the self-hosted pipeline: Whisper → (see `layer` below) → Kokoro, all on the host. Free beyond Groq's few-dollars-a-month STT cost.
- **`backend: gemini` / `openai`** — on hands-free and call, a hosted realtime speech-to-speech session (Gemini Live / OpenAI Realtime) IS the fast voice end to end: it hears and speaks directly, no separate STT/TTS steps. On dictation, which is STT only, the hosted backend is the transcriber in Whisper's place (§ Dictation into the composer). Real per-minute spend; see § The fast voice and the chat's agent.
- **`layer: direct`** — the turn talks straight to Manager, unfronted. Manager stays exactly as configured elsewhere (`defaultModel`, folder, tools) — this axis never changes what Manager is, only whether something sits in front of it. Only meaningful for `backend: local`: `gemini`/`openai` are hosted speech-to-speech sessions, so choosing one already means routing through their model first — there is no "direct" bypass of it, and `direct` on a hosted backend runs as `light` (Settings says so on that cell).
- **`layer: light` / `heavy`** — a front model fields the turn and hands off to the chat's agent (§ The fast voice and the chat's agent) when it needs real data or action. For `gemini`/`openai` this selects the model in that provider's realtime family: OpenAI's mini realtime model vs. its flagship realtime model; Gemini's default Live model vs. its extended-thinking Live model. Each is overridable per host. For `local`, `light`/`heavy` name a front-model shape this account hasn't built — a fast-but-weak model (Haiku) fronting Manager was tried and rejected: Haiku isn't capable enough at anything meaningful to be worth the extra hop, so it would just be a barrier the turn steps over almost every time. What `heavy` might mean for `local` — Manager's own model handling the live turn directly, escalating to a stronger model or an async job only for what's genuinely slow — is unresolved and untested. Selecting `light`/`heavy` for `local` is accepted by the settings schema but refused at connection time (`audio.error {code: 'voice_config_not_implemented'}`) until a front model exists.

- **`handoff: auto` / `always` / `never`** — a third, independent choice on every conversational surface with a hosted backend: who does the work. `auto` (the default): the fast voice answers what it can and hands the rest to the chat's agent (§ The fast voice and the chat's agent). `always`: the fast voice answers nothing itself — every utterance is a hand-off and it only speaks the agent's reply. `never`: the fast voice has no agent and no dispatch tool, and answers everything itself. It is enforced by the voice's instructions and its tool list (`always` also sets OpenAI's `tool_choice` to `required`), not by the host. Settings shows it as its own row under each hosted engine; it does not apply to `local`, where every utterance is the agent's turn. Changing it, like the engine, means a fresh session.

**Implemented:** every backend on dictation, hands-free and call from every app surface (phone, web, desktop), at every layer except the two below. **Refused loudly rather than silently downgraded (NO SILENT FALLBACK):** `gemini`/`openai` on the device surface (the device's audio path runs only on `local`), and `local`/`light` or `local`/`heavy` on any surface (no front model exists) — both `audio.error {code: 'voice_config_not_implemented'}`.

The host relays every backend. A surface opens the same audio WSS with the same `audio.session_start`, streams the same 16 kHz PCM16 up and plays the same 24 kHz PCM16 down whatever the backend; the host reads the surface's cell at session start and runs Whisper/Kokoro, or holds its own server-side connection to the provider and relays audio both ways (resampling where the provider's rate differs). No surface ever talks to a provider or holds a provider key or ephemeral token — so a phone on a hosted backend needs nothing native beyond what `local` already uses. The provider keys (`GEMINI_API_KEY`, `OPENAI_REALTIME_API_KEY`) are shared by every host: set once from Settings → Keys, which fans the write out to every host that's online, and each host stores its own copy (or reads it from its own environment, with the Settings one winning) — `02-daemon.md` § Provider keys. A key set or revoked there applies to the next session on every host, with no restart. `OPENAI_REALTIME_API_KEY` is deliberately not `OPENAI_API_KEY`, which the agent processes a host runs would pick up and bill. A missing key never stops the host — voice is one setting, and every chat on the host would go down with it, and a host that is down cannot be given the key from Settings. Instead:

- **At boot, whenever the voice config changes, and whenever a key is set or revoked**, the host logs an error for each surface whose backend has no key on that host, naming the surface and the key.
- **Every session on such a surface is refused at its start** with `audio.error {code: 'voice_key_missing'}` (the voice-note / transcribe route answers the same code), and the message is one fixed sentence every surface shows as is: _"Dictation is set to gemini, but GEMINI_API_KEY is not set on this host. Switch Dictation to another backend in Settings → Voice."_ — surface name, backend, key, and the fix. Nothing falls back to `local`.
- **Surfaces fail at the press.** A call or hands-free session shows the sentence on the call bar. Dictation and a voice note, which would otherwise only reach the host on release, are refused before recording when the chat's host has already reported that it lacks the key (below); a composer dictation also stops the moment the host refuses its preview session.
- **Each host reports which keys it holds** on `daemon.host.voiceKeys: {gemini, openai}`, re-published whenever one is set or revoked. Settings → Voice (web and mobile) marks a hosted cell _"Not configured on <host>: <KEY> is missing. Sessions there are refused."_ for each host that lacks it, and the line clears as soon as that host reports the key. A host that has not reported `voiceKeys` is not called unconfigured.

A hosted engine's failure (other than a missing key, above) — it could not open, it errored, a reply failed or produced no audio, a transcription failed — reaches the surface as `audio.error {code: 'gemini_unavailable' | 'openai_unavailable'}` naming what went wrong. If the provider's side of the session is gone (never opened, or closed under the host), the host also ends the surface's session, so the surface stops streaming into a dead engine and shows the failure with a retry (§ 2. Voice call). It is never answered by running `local` instead.

A session whose microphone delivers nothing but digital silence for its first 5 seconds of audio is failing, not quiet: no backend can hear a word of it. The host says so on the wire (`audio.error {code: 'mic_silent'}`) and the surface shows it, naming the likely cause — on macOS, an app without microphone permission is handed a silent stream rather than an error — and the place to fix it. Every session's closing log records the loudest sample it received.

A sustained session runs one engine. Its two modes can be configured onto different cells, so a mode switch between two cells that differ in backend or layer cannot happen in place: the phone ends the session and opens a fresh one in the new mode on the same chat, and the host refuses an in-place `audio.mode` that would cross engines (`voice_config_not_implemented`) — which is what web/desktop show when their switch crosses engines.

## The fast voice and the chat's agent

A call is the chat it was started on, spoken. It is never a separate assistant.

On `gemini`/`openai` two models share that one conversation:

- The fast voice — the hosted realtime model (Gemini Live / OpenAI Realtime); `layer: light` picks its small, fast model and `layer: heavy` its flagship. It holds the back-and-forth: anything it can answer from the conversation so far and its own knowledge.
- The chat's agent — the agent the chat already runs on (Claude or Codex, whatever the chat's harness and model are), with its tools, folder and session. The fast voice hands a request to it — a turn on the same chat — whenever it needs something only the agent has: tools, files, the user's data, an action, or real work.

The fast voice is told it is the voice of this conversation, not an assistant with no knowledge of the user. On hand-off the voice says once, in a few words, that it has passed the request on, then carries on talking: anything else the user says gets a normal reply while the agent works. On Gemini the dispatch call is answered at once with "started", so nothing stays pending on Gemini's side (a call left open can be cancelled when the user speaks over the model), and the agent's answer arrives later as a message from the agent. A message interrupts whatever the model is saying, so the host holds the answer until neither the user nor the model is talking, then sends it; answers queue in the order they finish. Speech the model starts on its own while a hand-off is running ("still working on it") is dropped beyond one acknowledgement per hand-off, neither played nor written into the chat; replies to what the user says are never dropped. OpenAI's function call is answered when the result is ready. The hand-off shows in the chat as its own line naming what was asked, followed by the agent's reply, so the user can see what the agent was given.

On `local`/`direct` there is no fast voice: every utterance is a turn for the chat's agent.

On `gemini` the fast voice answers every utterance it hears in both modes: Gemini Live cannot transcribe an utterance without answering it, so hands-free's address rule (§ Session modes) is not applied there and Settings says so on that cell. On `openai` it is: the provider is told not to answer on its own in `hands-free`, each finished transcript is run through the address rule, an addressed one is answered, and an unaddressed one is reported as heard-but-not-sent and removed from the provider's conversation. Barge-in on a hosted backend comes from the provider's own VAD; in `hands-free` on `openai` another voice in the room does not cut a reply off.

### Keeping voice and text as one conversation

The fast voice and the agent are separate models, so neither inherits the other's memory. Patch keeps them on one conversation:

- At session start the fast voice is given a briefing in its instructions: the chat's name, how it began (the user's first message), and the most recent messages, oldest first, each shortened, within a fixed budget of a few thousand tokens. Tool calls and their output are left out; only what the user and the agent said. It is background the voice answers "what is this chat about" from, not a transcript replayed as turns (a replayed history of hundreds of short messages came back as "this is just a new chat").
- While the session is open, every message that lands in the chat from anywhere else — a typed turn, another surface, an agent reply, a job result — is added to the fast voice's context silently, without prompting it to speak.
- Every spoken exchange is written into the chat's timeline as ordinary messages: the user's utterance as their message, tagged `[voice • <surfaceKind>]`, and the fast voice's reply as an agent message, streamed into the chat as it speaks.
- The agent never ran for exchanges the fast voice answered alone, so they are not in its session. The next turn the agent does run on that chat — a hand-off or a typed message — carries the voice exchanges it has not seen, in order, ahead of the new input.

Open the chat in text later and the whole conversation, including the parts the fast voice handled alone, is there, and the agent knows about them.

Words said in a call read differently from typed ones. On web, the user's spoken words, the fast voice's replies and the agent's answer to a hand-off are drawn in italics with a small call icon leading the text, on the message's own side; a hand-off's request keeps its own quiet line. Everything the voice says is written into the chat, including its words about an agent's answer. A hand-off reaches the agent with a note that the request was spoken, to do only that and not resume other work. Web plays a short rising sound when a call connects and a falling one when it ends.

### Call cost

Every sustained session is costed when it ends, on every backend:

- The engine: backend and model, the session's length, and the tokens it used by kind (text and audio, in and out) as the provider reports them. `local` counts the transcription requests and audio seconds sent to the STT backend.
- A cost in US dollars for the engine, from a fixed per-model price table on the host. The agent turns a call runs (hand-offs, or every turn on `local`) are the chat's own and are not costed: they ride on the subscription, and a call's expense is the voice alone. A model missing from the table shows its tokens and `price unknown` rather than a guess.

The summary lands in the chat as one quiet line when the session ends — `Call 0:52 · Gemini Flash · $0.012`, at the moment the call ends, with nothing to wait for. The host keeps every session's costing on disk and reports this month's and all-time totals per host on `daemon.host.voiceUsage`; Settings → Voice shows them per host under the engine choice.

## `local`-backend engines

The host runs, for any surface on `backend: local`:

- STT — switchable in Settings → Voice: Groq Whisper (`whisper-large-v3-turbo`, cloud, faster, offers partials) or local `faster-whisper medium.en` (no cloud dependency, ~400ms slower, no partials — see § Live transcript for why).
- Agent — Manager, on `layer: direct` (the only implemented `local` layer today — see § Voice is a config matrix above).
- TTS — Kokoro (`hexgrad/Kokoro-82M`), 24 kHz PCM16 output.
- VAD — Silero (`silero_vad.onnx`), for end-of-utterance and barge-in.

The large model files are downloaded per host, on demand, from the app (`02-daemon.md` § Optional components). Kokoro is ~340 MB including voices; a local Whisper model is ~1.5 GB. `silero_vad.onnx` is ~2 MB and sits inside the host artifact instead (`02-daemon.md` § Installation), so VAD and barge-in work on every host with nothing downloaded.

Voice is a per-host capability: a host advertises the components it has, and a chat's voice runs on that chat's own host, so speaking to it needs Kokoro installed there (backend `local`) or a Gemini/OpenAI key configured (`gemini`/`openai`). A surface disables the affordance where a component is missing and names the host and the component; on first use it offers the download or the key prompt in place, in a single prompt naming the size/cost and the host.

**Reaching a non-home host's audio WSS.** A surface only ever reaches the server, and a host is never itself internet-reachable (`01-server.md` § WebSocket hub — it only dials out and holds the connection), so `/audio/:sessionId` cannot simply be Caddy-proxied straight to one host's port the way a single-host deployment's was. `POST /api/voice/token` records which host minted the session (the chat's own host, from the chat registry); `/audio/:sessionId` then carries it over whichever of two paths is available, in priority order:

1. **Direct (optimisation).** If that host has declared `daemon.host.audioRelayHost` — the address it self-reports the server can reach its own audio WSS at directly — the server dials it and relays every frame both ways verbatim. This is only EVER true by default for a host co-located with the server (loopback), since that is the only address a host can know in advance is reachable; `PATCH_DAEMON_AUDIO_RELAY_HOST` remains available to declare a different one explicitly (e.g. a Tailscale name) as a latency optimisation, but nothing requires it.
2. **Tunnelled over the host link (the default for everyone else, no setup).** Lacking a direct address, the server instead carries every frame of the session over the SAME outbound WS the host already holds to the server — `patch.audio_relay.*` frames multiplexed by `sessionId` (`03-wire-protocol.md` § Audio relay over the host link). The host on the other end bridges those frames to its own LOCAL audio WSS, exactly as a co-located surface would reach it, so `audio/server.ts` runs unmodified regardless of which path carried the bytes. This is what makes voice on a non-home host (a Mac, say) work with nothing configured: no Tailscale, no manually-set env var, no address to go stale across a self-update.

A session for a host that is offline is refused with `audio.error {code: 'host_unreachable'}` before any audio is accepted, same discipline as `session_not_found`; so is one whose host-side tunnelled bridge fails to connect locally (voice not installed on that host) — the failure always reads as that host's own, never silently running a different host's pipeline.

### Whisper transcription params

The Groq transcription request pins `language=en` and `temperature=0`.

### Latency

On `backend: local`, time-to-first-audio for a reply is dominated by the same floor as before — the model's own response latency plus CPU-bound Kokoro synthesis, roughly ~600ms–1s — because the agent's turn is the reply. Two optimisations still apply:

- Kokoro kept warm — a host that has the Kokoro component installed synthesises a throwaway phrase at startup, and again on a slow timer while it is idle, so the model load never lands on a call's critical path. Warming only at startup is not enough: the weights get paged out while the machine does something else, and the first call after a quiet hour then waits out the whole load before it can say anything, which the user experiences as a call that never speaks.
- Warm agent session for the duration of a call (`02-daemon.md` § Per-turn process / warm sessions) — the agent process is opened when the call starts and kept alive across turns instead of being re-spawned every utterance. Barge-in interrupts the current turn without killing it.

On `backend: gemini`/`openai` there is no separate STT/TTS stage to warm — the hosted session is already speech-to-speech — so the same floor applies without needing either optimisation, and a hand-off to the chat's agent is the only thing that can add real latency.

The user's words appear in the chat timeline as they speak, on every backend. On web and desktop that is an in-progress user message at the end of the call's chat, its text the live partial transcript in italics; on mobile it is the call bar docked above that chat's composer (`15-design-mobile.md` § Voice states). It becomes an ordinary user message when the transcript is final, and is replaced by the persisted message when that arrives, with the `[voice • …]` tag stripped for display. An utterance a hands-free session discarded is removed from the timeline rather than kept. The reply streams into the timeline beneath it like any agent reply.

### Live transcript

`backend: local` only — a hosted session (`gemini`/`openai`) streams the user's words as the provider transcribes them, sent as `audio.transcript_partial` with no workaround needed. Hosted dictation offers no partials: each re-transcription pass would be a paid request, so it emits none and its surfaces show the input level instead.

No Whisper backend streams — each answers one whole clip at a time. An interim transcript is therefore produced by re-transcribing the growing utterance prefix about once a second while the user is still speaking, each answer going out as `audio.transcript_partial` (`03-wire-protocol.md`).

Whether that is worth doing is a per-backend decision, because every pass costs a whole extra transcription request. Groq answers a short clip in well under a second; a model running on the host's own CPU (`local`) is slower per pass, but the session keeps only one partial pass in flight and spaces passes by a second of new audio, so the final queues behind at most one pass. Both offer partials. An unconfigured backend has nothing to ask. A backend that offers no partials emits none at all, and its surfaces show the microphone's input level while the user speaks instead of words.

Two rules keep the interim text from costing the user the transcript that matters:

- A quota reserve. A partial is refused once the requests already made in the rolling minute reach the partial budget, which sits below the provider's per-minute limit. A long sentence can spend its whole allowance on the preview and the final — the request that becomes the user's words — still has slots to run in. A final is never refused to make room for a partial.
- A hallucination filter, on partials only. Whisper answers a short or near-silent prefix with a stock phrase ("Thank you.", "you", subtitle credits) rather than with an empty string, and one of those painted into a user's input reads as words they said. A partial whose whole text is one of those phrases is dropped and the next pass gets the chance instead. A final is never filtered: if the user did say "Thank you.", that is the turn.

The interim text is a guess at a half-finished sentence, not a recognition, and each pass is independent of the last — so it rewrites itself as the user talks and a word can change after it has appeared. Every surface therefore renders it as a preview marked as in progress — the greyed placeholder ink on web/desktop; on mobile, where the words are the main thing on screen while the keyboard is away, full reading ink on an accent tint — and discards it outright the moment the authoritative transcript arrives. It is never left as text the user has to notice is wrong and edit.

Partials reach the composer's dictation preview (§ Dictation into the composer) and a sustained session's bar. A voice note gets none: its audio is committed in one upload rather than streamed (§ End-to-end voice transport).

The standalone voice device (`16-voice-device.md`) runs the same two tiers and the same light/heavy split, on ESP32-S3 hardware — its session lifecycle differs (opened by an on-device wake word rather than a gesture) but the turn semantics below are what it reuses for its wake-triggered conversations; see `16-voice-device.md` § Two flows.

## Surfaces covered here

- Web app — voice button in any chat. WSS audio session to host when active.
- Phone app (Android) — tap-to-talk button. Foreground service while voice is active. WSS audio session to host. Manager-call ringing via ConnectionService.

## Architecture

```
phone/web ──audio WSS (PCM16 mic in, PCM16 audio out)──▶ patch host
                                                              │
                                                              ├── streaming Whisper STT
                                                              │     → text per utterance
                                                              │
                                                              ├── text → agent chat (currentChatId)
                                                              │     ← response text (streaming)
                                                              │
                                                              ├── streaming Kokoro TTS
                                                              │     → PCM16 frames
                                                              ▼
                                                          back to surface speaker
```

Cost: ~$3–5/month for Groq Whisper at heavy use, plus the cost of the host running the host + Kokoro.

Latency:

| Stage                                  | Time          |
| -------------------------------------- | ------------- |
| Audio WSS surface → host               | ~50–150 ms    |
| Groq Whisper streaming + EOS           | ~50–100 ms    |
| Agent response (short, no heavy tools) | ~500–800 ms   |
| Kokoro first audio byte                | ~150–200 ms   |
| host → surface speaker                 | ~50–150 ms    |
| Total time-to-first-audio              | ~600 ms – 1 s |

## A call stays on its chat

A call or hands-free session is aimed at the chat it was started on and stays there, whatever the surface goes on to look at. Every surface still emits `chat.focus_change {chatId}` on every navigation (`03-wire-protocol.md`; read by `09-notifications.md` § Chat completion), but the host does not use it to re-target a voice session: navigating to chat B mid-call leaves the call on chat A, and starting a call from another chat while one is live does nothing. To talk to another chat, end the call and start one there. The call bar names the chat the call is on.

## Turn semantics

| Event                 | Direction            | Handling                                                                                            |
| --------------------- | -------------------- | --------------------------------------------------------------------------------------------------- |
| User speech           | surface → host (PCM) | Whisper transcribes streaming; host emits user-turn message to `currentChatId` on end-of-utterance. |
| End-of-utterance      | host-side            | Silero VAD or Whisper EOS heuristics. Surface keeps WSS open.                                       |
| Agent response tokens | agent → host         | Streamed; host splits complete sentences off the growing reply and hands each to Kokoro.            |
| Kokoro audio          | host → surface (PCM) | Streaming, plays via surface speaker.                                                               |

Streaming end-to-end: Kokoro starts speaking on the first sentence boundary while the agent is still generating later tokens. The host accumulates streamed reply text, splits it at sentence boundaries (`.`/`!`/`?` + whitespace, or a newline), strips markdown before synthesis (headings, emphasis, list markers, rules, table pipes, fenced code and decorative emoji are not read aloud), and synthesises sentences in order — one `audio.tts_end` closes the whole reply. A barge-in cancels the in-flight sentence and drops the rest of the queue. If the model backend doesn't stream partial text, the host speaks the full (stripped) reply once the turn completes.

## Permission prompts during voice

If the agent enters `awaiting-permission` mid-voice-session, the host emits `chat.permission_request` over the WSS. Surface UI:

- Phone / Web: a banner with Approve / Deny + a "say yes / no" voice prompt. The user's spoken response goes through the same Whisper path; host parses "yes" / "no" and emits `chat.permission_response`.

The permission round-trip is text-only on the wire, but the user can answer it either by tap or by speaking.

## Agent-initiated voice

### Mechanism

- Any chat or job calling `patch_call({ reason })` (`09-notifications.md` § `patch_call`) adds an entry to the per-user voice event queue on the server. The call routes directly to the user's active voice surfaces — it does not delegate through the Manager thread.
- Active session present → host synthesises the message via Kokoro and streams it on the active audio WSS at the next pause in agent output.
- No active session → server sends a high-priority push data message to the Android device via Expo's push API → app raises a `ConnectionService` incoming call (see `15-design-mobile.md`). On desktop: window raise + audible chime + accept/dismiss UI (see `14-design-web.md`).
- On user accept → voice session opens, host streams Kokoro audio for the queued events in order. Queue clears.
- Decline / no answer (30s) → each queued event becomes its own push notification with text + deep-link to the originating chat. Voicemail.

Manager initiates a voice call by exercising the same `patch_call` path any chat has.

### Other chats during a focused-chat voice session

Events from non-focused chats during a voice session are dropped from the audio path. Visual indicators (badges, banner, sidebar) still update. To hear those events spoken, the user switches focus to Manager voice; Manager's queue handling reads them aloud.

## Voice-mode hint to the agent

Patch tags the user-turn message with a `[voice • <surfaceKind>]` (or `[voice • device:<id>]`) prefix before forwarding to the agent, marking the input as spoken. Same metadata pattern as the voice device (`16-voice-device.md`).

Patch injects no system prompts at runtime (`principles.md` § No system-prompt injection) — the prefix is metadata-as-data, not a directive. For spoken-friendly replies, the user puts that instruction in the CLAUDE.md of the chat's folder, which the agent reads itself. Absent that, the model's default style stands.

## Concurrency on the host

Multiple voice surfaces can have audio sessions open at the same time (phone + voice device, e.g. partner using kitchen device while user is on phone Manager call). With Groq doing STT remotely, only Kokoro and the AEC pipeline run on the host — the baseline host sizing (`11-deployment.md`) has headroom for ~3 concurrent sessions. Beyond that, size up. With local Whisper the larger sizing handles ~2–3 concurrent.

## Barge-in

The user can interrupt a streaming agent response by speaking. Mechanism (host-side):

- Continue feeding mic audio to Silero-VAD even while Kokoro is streaming TTS to the surface.
- When VAD fires (user is speaking), host stops the Kokoro stream, drops in-flight TTS audio, and routes the new utterance to Whisper.
- Phone and web speakers have hardware/OS-level AEC, so the agent's own TTS playback isn't picked up as user speech. Voice device needs host-side AEC (see `16-voice-device.md`).

## Voice-input modes — four gestures

Voice into a chat happens in one of four ways. They share the host's STT pipeline but differ in user-facing gesture and overlay UI.

### 1. Voice note (single turn) — press-and-hold OR toggle

Sends a single audio utterance as one user turn into a target chat. Two equivalent gestures:

- Press-and-hold the chat row's mic button (sidebar) or the menu-bar global hotkey, speak, release → sends.
- Tap the same control to start a Superwhisper-style toggle session, speak, `⏎` to send (or tap the control again).

Either gesture, `esc` cancels without sending.

The keyboard hotkeys (`⌘;` in a focused chat, `⌃Space` for Manager) carry the same two gestures, with the keydown as the press and the keyup as the release. Which one it was is decided by how long the key was held: a press shorter than the tap threshold is a tap and opens the sustained session; only a longer press commits on release. A chord is struck and released far faster than anyone can speak, so without that threshold every hotkey press would commit a clip no longer than the keypress itself and the only possible outcome would be a failed transcription.

On a brand-new chat (the `+ New chat` composer's mic, before any first message), a voice note starts the chat: the surface creates the chat in the chosen folder, opens it, and binds the note to the new chatId so the host routes the transcript in as the first turn. This first note is always a toggle session (`⏎` sends, `esc` cancels) — the new-chat composer unmounts on navigation, so a press-and-hold release can't reach it.

A note started from a composer APPENDS to what is in it; it never replaces it. The text already typed there travels with the note as its prefix, leads the committed turn, and the transcript follows it, joined by a single space — the same join dictation uses (§ Dictation into the composer). It is ONE turn, not two, and the transcript is never sent on its own while the typed half is dropped. An empty composer sends the transcript alone, with no leading space; a clip that transcribes to nothing still delivers the typed text. The turn as injected is what the surface echoes into its timeline, so the persisted copy reconciles against it rather than duplicating.

Because starting the note lifts that text out of the composer, a note that does not deliver has to give it back. On a failed upload, a failed transcription, an `esc`, or a gesture released before the mic ever started, the typed text returns to the target chat's composer — leading anything typed in the meantime — and the failure itself is surfaced. There is no path on which the words are both un-sent and un-returned: losing a half-written message to an error is the failure this whole mechanism exists to prevent.

Overlay on web/desktop is just the transcript — deliberately NOT a call bar. A single bottom-centred line, persistent across alt-tab, showing `…` until the transcript lands. It carries no other chrome:

- No mic glyph or ripple.
- No chat-name / `LISTENING` / `SENDING` label — while the utterance is committing the same line simply dims (`data-sending="true"`).
- No waveform visualiser.
- No `⏎ send · esc cancel` hint (the gesture that started the note is still held/armed; the keys are in `14-design-web.md` § Keyboard).

That one line must still show that the mic is live. A note is uploaded in one go rather than streamed, so no words are recognised until it is committed and an unchanging `…` is indistinguishable from a dead mic. For the note's whole length the line therefore tracks the recorder's input level (`data-level`, bucketed `0`–`4`), so it visibly answers speech. This is the substitute for the waveform, not a waveform: still one line, still no chrome.

A single-turn note must not look like an ongoing session: the timer and mute/end controls belong to mode 2 only, and they live in the top voice bar, not over the page. Frame 2 of `design/web-hi-fi-menubar.html` shows the superseded heavy capsule.

Mobile keeps its controls. With no keyboard there is nowhere else to put send/cancel, so the mobile voice-note overlay retains its send and cancel buttons, and it names its state instead of tracking level: `Recording… 0:05` with a running timer while the mic is live, `Transcribing…` while the clip uploads, then the whole transcript of what was heard (`15-design-mobile.md` § Voice states).

The overlay is pure visual feedback; focus stays with the underlying app so the user can keep typing in it.

An in-flight note owns `⏎` and `esc` wherever focus is — including inside a text field. The overlay carries no controls of its own, so those two keys are the only way to commit or drop it; a handler that bails out when the target is an `<input>`/`<textarea>` leaves the note unendable and uncancellable. The new-chat flow makes that the DEFAULT case: it navigates into the chat it just created, whose composer auto-focuses. So while `voiceStore.note` is set, the composer's own bindings stand down — `⏎` commits the note instead of sending the typed text (which is left untouched in the field), `esc` cancels the note ahead of every other `esc` binding.

For the same reason the composer's mic button ends an in-flight note rather than opening a second, overlapping recording — a note started from the sidebar row, the `⌘;` / `⌃Space` hotkey, or the new-chat composer is still running when the chat composer's mic is the one under the user's cursor.

After send, the audio is committed as a user turn (with the `[voice • <surfaceKind>]` prefix per `principles.md` § No system-prompt injection). The agent's reply routes per the channel-aware rule (see `06-threads-manager-speakers.md` § Reply routing) — typically text in the surface where the gesture happened.

### 2. Voice call (persistent, bidirectional) — sustained session

A continuous voice session, like a phone call. The user opens it by:

- Tapping the phone icon on the Manager row in the menu-bar dropdown.
- Tapping the sustained-voice control — the phone icon in the mobile chat-detail top bar (`15-design-mobile.md` § Chat detail), or the Call button in the web/desktop composer (`14-design-web.md` § Composer). On mobile the composer mic is not a call control: it dictates into the composer only (§ Dictation into the composer), and the call is this separate top-bar phone icon.
- Tapping the hands-free control, which opens the same session on the Manager in `hands-free` (below).
- Accepting an agent-initiated incoming call (see Agent-initiated voice).

The host keeps the WSS audio stream open; the agent speaks via TTS, the user replies, repeated until the user ends the call.

A sustained session is NOT a floating capsule. It is a **voice bar**: a strip in flow at the top of the window, present for as long as the session is, in both modes. A capsule was a call UI, and hands-free is not a call — it is a mode left switched on, in which most of what the mic hears is deliberately dropped. Shown as a floating "on call" pill it read as a call that ignored the user.

The bar carries, left to right:

- `ON CALL` / `HANDS-FREE` · `<chat>`, naming the mode and the target. The target is the chat's title; a chat that has no title yet reads `New chat`, never its id, and the label does not change while the session is open.
- What the line is doing right now, as one short status: `Connecting…`, `Listening` (call at rest) / `Waiting for you to say “<address word>”` (hands-free at rest), `Hearing you`, `Thinking…`, `Speaking`, or `<what it heard> — not addressed, so not sent` greyed for 8s when a hands-free session discarded an utterance. The words themselves are in the chat timeline (§ Latency), not the bar.
- Running session timer (`02:14`).
- A mute-mic button, a mode switch, and an end (red phone) button.

Being in flow, the bar pushes the app down rather than covering the transcript, and it persists across alt-tab. On desktop the bar starts clear of the window controls and is draggable like the title bar it sits in. Its text is high-contrast on its background in every state. Mobile foreground service keeps audio alive when the app backgrounds.

While a session is open on a chat, that chat's call control shows it: lit in the live colour, and pressing it ends the session.

On mobile the session lives inside the chat it is on rather than across the top of the window. The chat's own message stream is the transcript — spoken turns and replies land in it as ordinary messages — and the bar docks above that chat's composer. Away from the chat, a small pill stands in for it (`15-design-mobile.md` § Voice states).

On mobile, until the host has acknowledged the session the line is connecting, not listening, and the bar says so in a neutral colour distinct from the live states. A session not acknowledged within 15 seconds, or whose audio connection closes without the user ending it, has failed: its audio is released and the bar stays up naming the failure, with retry and end.

#### Session modes

A sustained session runs in one of two modes. Both hold the microphone open for as long as the session lasts; they differ only in what a spoken utterance means. The user switches between them mid-session from the bar; nothing is torn down or reopened, because the transport, the chat and the audio plane are identical.

| Mode         | Your speech                           | Its speech            |
| ------------ | ------------------------------------- | --------------------- |
| `call`       | every utterance is a turn             | every reply is spoken |
| `hands-free` | only an addressed utterance is a turn | every reply is spoken |

`call` is the phone call: a continuous conversation with your attention on it. Like any phone call it carries on when the phone goes in a pocket.

`hands-free` is the line left open — for plastering a wall, for a long drive. It never ends itself on silence, so there is nothing to re-open when the user has something to say an hour later, and it does not treat every noise in the room as a turn. Because the mic is open throughout, it cannot share the device with a podcast; the user who wants one plays it under `auto-notify` instead (`09-notifications.md` § Reaching the user).

An utterance in `hands-free` is addressed when it opens with the address word — tolerating a one-character STT mishearing for address words of 4+ characters, since Whisper regularly returns "Patch" as "Hatch" or "Catch" and an exact match silently drops a deliberately addressed utterance — or when it lands within 30 seconds of Patch last finishing speaking, so answering, and continuing that exchange, needs no address word and no gesture. Everything else the mic hears is discarded at the host after transcription and never reaches a chat, which is what makes it safe to leave a headset mic open in a room with other people in it. The address word defaults to `patch` and is set in Settings.

Barge-in, mute and permission prompts behave identically in both, and both hold audio focus and the mobile foreground service for the session's whole length: the session IS what the device is doing.

This addressed-or-continuing rule — what counts as a turn once a session is open — is the piece the voice device (`16-voice-device.md`) reuses for its own wake-triggered conversations. Its session _lifecycle_ is different: there's no toggle to hold it open on a standalone speaker, so a device session opens on the on-device wake word and closes once the exchange lapses past the continuation window, rather than staying open until the user explicitly ends it. A one-line request and a ten-minute conversation both fit the same rule — the length is whatever the pauses in the conversation say it is, never a fixed timeout.

#### Which surface it reaches

A deliberate interrupt goes to the surface the user is actually at. When a sustained session is open, that session is the answer. When several are, it is the one whose surface most recently showed activity — a heartbeat, a keystroke, an utterance — because that is the machine the user is in front of. With no session open at all, what happens is the reach setting's business (`09-notifications.md` § Reaching the user).

#### Speaking with no session open

Under `auto-notify` an interrupt is spoken on a surface that is not in a session at all (`09-notifications.md` § Reaching the user). The surface opens a short audio session for it — role `voice-call`, mic never started — plays the synthesised message, and closes. Because no microphone is held, a podcast can play underneath: the surface takes transient-exclusive audio focus for the length of the message, which pauses it, and releases focus when the message ends, at which point it resumes on its own.

There is no reply path. `auto-notify` is monitoring, not conversation: to answer, the user opens a session.

## Dictation into the composer

The composer's mic, on web/desktop and on mobile, dictates: it puts words into the chat's input for the user to edit and send. It never commits a turn of its own — the composer decides that.

Dictation's configured backend transcribes both the upload and the preview session — Whisper on `local`, the provider's transcription model on `gemini`/`openai` — with no other difference in the flow. The clip is captured locally and the authoritative transcript comes back from a single upload on the gesture end, so nothing the user said depends on a socket having opened in time and a fast tap-and-release cannot lose the recording. Alongside that capture, and fed from the same microphone rather than a second one, the surface opens an audio session purely to receive the interim transcript (§ Live transcript). That session is always ended as cancelled, so the host never treats a dictation as a note.

Nothing but opening the capture itself sits between the press and the first recorded audio, so the speaker's first word is not lost and a brief gesture still records something. On mobile that means the permission check and the audio-mode switch are resolved when the composer appears rather than on the press, since a hold gesture is only recognised after a hold threshold has already elapsed. A hold-to-talk dictation ends when the finger genuinely lifts, or when the system cancels the touch; a finger that drifts off the button while still held does not end it, because on a phone-sized target that happens constantly and would cut the sentence in half.

The interim transcript renders in the input as a preview (§ Live transcript), following whatever the user has already typed and updating as they speak. On the gesture end the preview is dropped and the uploaded transcript lands in its place as ordinary editable text.

On web/desktop the input keeps focus, the caret and every editing gesture throughout. On mobile, starting a dictation dismisses the soft keyboard — there is nothing to type while talking, and the keyboard would take the space the live words need. A listening strip above the input says the mic is live (a pulsing indicator, `Listening`, and the elapsed time), then `Transcribing…` until the words land. The keyboard does not come back on its own when they do; the input stays editable, so a tap on it brings the keyboard back to edit.

While voice is live — a dictation recording or a note in flight — the input shows no placeholder. The preview is drawn in the same box as the input's own placeholder, so on an empty composer the two render on top of each other and the live words are read through `Type a message`. Naming an empty field is pointless while the user is talking into it; the placeholder returns when voice ends.

The preview is the expendable half of that pair. If its session cannot open, or breaks mid-recording, the recording carries on and the transcript still lands — but the failure is surfaced, since a live leg that has quietly stopped working is otherwise indistinguishable from a quiet one. On a backend that offers no partials no preview appears and nothing else about dictation changes.

A dictation that produces no text says which of three things happened: no audio was captured at all, the clip was too short to hold an utterance and was not uploaded, or the clip was transcribed and held no speech. None of the three is silent, because a dictation that appears to do nothing is indistinguishable from a broken microphone.

An in-flight dictation is discarded without transcribing by `esc` on web/desktop, and by a clear control beside the mic on mobile.

## Overlay surfaces — placement summary

The same overlay vocabulary applies wherever voice is initiated:

| Initiated from                                       | Overlay                                                    |
| ---------------------------------------------------- | ---------------------------------------------------------- |
| Sidebar row mic button (web)                         | Voice-note overlay                                         |
| Long-press chat row (mobile)                         | Voice-note overlay                                         |
| Menu-bar global hotkey                               | Voice-note overlay (target = Manager)                      |
| Menu-bar dropdown mic icon on Manager row            | Voice-note overlay (target = Manager)                      |
| Menu-bar dropdown phone icon on Manager row          | Voice bar in `call` (target = Manager)                     |
| Chat-header voice control                            | Voice bar in `call` (target = current chat)                |
| Composer mic (mobile or web/desktop chat)            | None — dictation lands in the composer input               |
| Chat-detail phone icon (mobile)                      | Call bar docked in that chat (target = current chat)       |
| Hands-free control (web sidebar, mobile chat detail) | Voice bar (mobile: call bar) in `hands-free` (Manager)     |
| Long-press the bottom Voice tab (mobile)             | Voice-note overlay (target = Manager)                      |
| Agent-initiated incoming call (Manager)              | Incoming-call banner → on accept, the voice bar / call bar |

## End-to-end voice transport

The host STT/TTS engine above is shared, but the surface→host transport differs by gesture and by surface. Both legs are defined here so the full path is unambiguous.

### Voice note (single utterance)

- Every surface records the clip locally and commits it as ONE upload to `POST /api/voice/note` on the gesture end. The server hands it to the chat's host, which runs Whisper once over the whole clip and injects exactly one user turn tagged `[voice • <surfaceKind>]`; cancelling discards the clip without transcribing it. Nothing is streamed, so no interim transcript exists for a note; the overlay shows input level (web/desktop) or a running timer (mobile) instead (§ 1. Voice note).
- The upload path is chosen over a streamed one because a note must survive the gesture that is hardest to serve: a tap-and-release shorter than a socket takes to open. With the audio buffered locally there is no round trip on the critical path and no way for a fast note to end up empty. A failed record or upload is surfaced to the user, so a dropped note is visible.

### Voice call (sustained)

- All surfaces get a one-shot token from `POST /api/voice/token`, where the server mints it, open the audio WSS, exchange `audio.session_start`, then stream PCM16 both directions (`audio.pcm16` up, `audio.tts_chunk` down) alongside `audio.transcript_*`, `audio.barge_in`, and `audio.session_end`.
- On mobile the PCM transport is native (`expo-av` alone cannot stream PCM): the up leg is `PatchVoiceMic` (an `AudioRecord` PCM16 tap) and the down leg is `PatchVoiceTts` (an `AudioTrack` streaming sink that plays the host's 24 kHz PCM as it arrives, so the user hears the reply — barge-in flushes it). The same two modules carry every backend: a hosted engine's audio arrives as the same 24 kHz PCM on the same socket. If either native module can't init, the call is torn down with a surfaced error. Mobile voice calls also request Android `AUDIOFOCUS_GAIN` (full, not duck), which still awaits a native audio-focus module rather than `expo-av`'s duck-only flag.

## Cross-refs

- Voice device (same engine, different hardware): `16-voice-device.md`
- Notification-via-voice channel routing: `09-notifications.md`
- Manager / speakers thread role: `06-threads-manager-speakers.md`
- Focused-session state (`chat_state`): `04-chats-and-folders.md`
- Host sizing for concurrent voice sessions: `11-deployment.md`
