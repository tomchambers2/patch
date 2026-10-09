# Voice Device

A standalone voice surface for patch — the Home Assistant Voice Preview Edition (ESP32-S3 hardware, ~£60) re-flashed with patch's custom firmware. Provides bidirectional voice in/out anywhere in the home.

The device is a surface. It captures audio and plays audio. All STT, TTS, and intelligence happen on the host and its agent backend; the device can't run STT or TTS locally so the host does both.

## Hardware target

- HA Voice Preview Edition — ESP32-S3, 16 MB flash, 8 MB PSRAM, INMP441 I2S mic, MAX98357A I2S speaker, capacitive touch button, WS2812 LED ring, hardware mic mute switch. User already owns one.
- Power: mains via USB-C. Always-on, no deep sleep.
- Network: 2.4 GHz Wi-Fi.
- Multiple devices supported. A house can have several (kitchen, living room, bedroom). Each has a unique `deviceId`.

## Hardware kit

Patch ships with at least one flashed HA Voice PE unit. The Speakers thread and the `speakers` channel on `patch_notify` both depend on the hardware being present; smart-home control needs nothing device-specific — it's Manager dispatching like any other command (§ Loss of HA Assist).

Adding more devices: flash the firmware, pair it to a host (§ Connection model — audio relayed via host), drop it in the kitchen / bedroom / wherever.

The web, mobile, and terminal surfaces work standalone. Without a voice device the Speakers row in the Channels box stays empty and the `speakers` notify channel falls through to `push`.

## Wake word

"Hey Patch" — a custom `microWakeWord` (TFLite-Micro) model, trained the same way the reference "Hey Jarvis" model was (synthetic TTS-generated samples + training run). On-device, no network call, no per-invocation cost — this is the always-on gate that makes the device "available" at zero cost for as long as it's unmuted, whatever else it's doing.

## Firmware responsibilities

1. Run the wake-word model on-device. A successful detection opens a session using the same turn semantics as `hands-free` mode (`07-voice-app.md` § Session modes) rather than a single bounded exchange — see § Two flows below for the session's own lifecycle.
2. Hold a persistent control WSS to the paired host for non-audio messages (rings, mute, lifecycle).
3. On wake-word fire (or accepted ring), open an audio WSS to the host. Streams PCM16 mic audio out, plays PCM16 audio coming in.
4. Show state via LED ring. Idle / wake-detecting / listening / agent-speaking / ringing / muted / disconnected.
5. Handle button input. Push-to-talk override, accept/dismiss for incoming rings.
6. Respect the hardware mute switch. When muted: no wake word, no audio session, LED shows muted, host informed.
7. Reconnect on Wi-Fi drop with exponential backoff.
8. OTA updates via the ESPHome OTA path.

The device talks only to its paired host, with no call to any cloud service and no audio API key on the device. The audio WSS is per-session — opens on wake-word or accepted ring, closes on session end. The control WSS is persistent.

## Connection model — audio relayed via host

```
device  ──control WSS──▶  patch host  (persistent, low-bandwidth)
        ──audio WSS────▶                (per-session, PCM16 streaming both directions)
                              │
                              ├── NATIVE tier: relayed through to a hosted
                              │   speech-to-speech session (Gemini Live) — the
                              │   proxy, § The fast voice and the chat's agent
                              │   in 07-voice-app.md
                              │
                              │   FALLBACK tier: streaming Whisper STT on the
                              │   daemon's host → proxy model → Kokoro TTS
                              │   streaming — same fallback stack as the app
                              │   surfaces (`07-voice-app.md`)
                              │
                              ├── dispatch to the heavy Patch agent (voice-device
                              │   chat) when the proxy needs Patch-specific
                              │   data or action, either tier
                              ▼
                          daemon sends audio frames to device → speaker
```

- Device is locked to `backend: local` for now (07-voice-app.md § Voice is a config matrix — `gemini`/`openai` on device is an accepted config cell with no implementation yet, refused loudly rather than silently downgraded). Whisper STT (default Groq hosted `large-v3-turbo`; local `faster-whisper medium.en` via Settings → Voice), Kokoro for TTS, both streaming.
- Audio latency, `backend: local` (Groq path): device → host WAN ~80ms each way + STT (~50–100ms) + light-layer response + TTS first-byte (~200ms) → device. Total time-to-first-audio: ~600ms – 1s. Local Whisper adds ~400ms (total ~1–1.5s). `gemini`/`openai` have no separate STT/TTS stage to add latency, so the same floor applies without local-Whisper's penalty — its cost is per-minute API spend rather than compute, per `07-voice-app.md` § `local`-backend engines. Device currently only supports `backend: local` — see `07-voice-app.md` § Voice is a config matrix.
- Either tier, a turn that needs Manager (Todoist, transit times, anything Patch-specific) adds Manager's own response time on top, off the proxy's conversational thread — the proxy speaks a bridge and stays live rather than going silent while it waits.

The device pairs with one host at setup: the machine whose host does its STT and TTS, which carries the voice components (`02-daemon.md` § Optional components). The device belongs to that host, and re-pairing moves it to another.

Pairing runs between the device and that host, which is the only party that admits anything: `patch hosts pair-device` (`17-cli.md` § Commands), run on that host over its local control socket, opens a five-minute window there, and the host records the `deviceId` of the first device to announce itself inside it and accepts that device's control WSS from then on. An announcement outside a window is refused, so a device flashed with a host's address is still adopted deliberately rather than by arriving on the network. The server issues nothing here, because the device holds no account credential and reaches no cloud service.

## Wire protocol

Two WSS connections, both terminating at the host.

### Control WSS (persistent)

JSON frames:

```
device → daemon
  { type: "hello", deviceId, fwVersion, muted: bool }
  { type: "wake_detected" }                                 → daemon prepares an audio session
  { type: "session_end", reason: "vad-timeout"
                                | "user-button"
                                | "agent-finished" }
  { type: "ring_accepted" }                                 → reply to a ring frame
  { type: "ring_dismissed" }
  { type: "mute_changed", muted: bool }                     → hardware switch flipped

daemon → device
  { type: "session_start", sessionId, voiceToken,
                  accountId, chatId, conversational: bool }  → device opens audio WSS
  { type: "ring", chatId, message?: string,
                  conversational: bool }                    → patch wants this device to ring
  { type: "led", state: "idle" | "listening"
                       | "agent-speaking" | "ringing" }     → optional UI hint
```

Voice-token delivery. Voice tokens are minted by the server for every surface (`POST /api/voice/token`), so for a device the host fetches one on its behalf, bound to `{accountId, surfaceId=deviceId, chatId}`, and pushes it to the device in the `session_start` control frame. The device then opens the audio WSS using the token as the `audio.session_start` event's `voiceToken` field. The `session_start` frame also carries `accountId` + `chatId`, and the audio server rejects a session whose declared `accountId`/`chatId` don't match the token's claims, so the device declares its identity without decoding the opaque token. `surfaceKind` for device sessions is `"device"`.

### Audio WSS (per-session)

Binary PCM16 mono. The two directions run at different rates: mic (device → host) is 16 kHz; TTS playback (host → device) is 48 kHz. The host resamples Kokoro's 24 kHz output up to 48 kHz before sending (see Device audio path). Frame size ~20ms typical.

- Device → host: mic audio.
- Host → device: synthesised TTS audio.

Host performs end-of-utterance detection on the inbound stream (silero-vad on the host, or Whisper's own EOS heuristics) and routes text to the agent on each completed utterance. Streams TTS audio back as the agent responds.

## Two flows: notification vs conversation

### `patch_notify(channel: 'speakers')` — always one-way

Any chat or job calling `patch_notify(channel: 'speakers', message)` produces a one-way announcement. Host picks a device (see Outbound routing), sends a `ring` frame with `conversational: false`, user accepts (or it falls through to voicemail per `07-voice-app.md`), host synthesises the message via Kokoro and streams it to the device — always Kokoro, regardless of the host's tier setting, since a notify is text Manager already produced, not a light-layer conversational turn.

The session does not listen for a reply afterwards. Speak and end.

### Wake-word session — the device's own hands-free

Saying "Hey Patch" (or holding the button) opens an audio WSS to the host and a session using `hands-free` mode's turn semantics (`07-voice-app.md` § Session modes): the wake word itself satisfies the "addressed" requirement for the first utterance, and anything spoken within 30 seconds of Patch last finishing speaking continues the same exchange with no need to say the wake word again — so "Hey Patch, add tomatoes to my shopping list" is a self-contained few seconds, and a real back-and-forth runs for however long it naturally runs, neither one hard-coded.

What's different from the app surfaces' `hands-free` toggle is the session's _lifecycle_, not its turn semantics: there's no button held down on a standalone speaker to keep it open, so the session closes once the exchange lapses past the continuation window (or on user button, an explicit override) rather than staying open until manually ended. The device then drops back to local-only wake-word listening — zero cost, zero network — until "Hey Patch" fires again. This is what makes the device "available" for a three-hour drive without either holding an open mic the whole time or making every command require re-triggering from cold: the wake word gates entry cheaply and locally; the pause in conversation, not a timer, decides when a given exchange is done.

The voice-device chat is persistent — every turn, whichever layer answered it, lands in its real timeline (`07-voice-app.md` § Keeping voice and text as one conversation), so context accumulates within an exchange and is still there in text later:

- "Hey Patch, when's the 73 coming?" → proxy dispatches to Manager (needs live transit data) → "It's at 3:42, six minutes."
- "Remind me to check again in five minutes" → within the continuation window, no wake word needed → dispatches again → "Will do."

Manager has every Patch tool, as today. If the user asks "how are my jobs going", the proxy dispatches and Manager calls `patch_list_chats` and `patch_peek` itself. Small talk and general questions ("what's today's date", "tell me a joke") the proxy answers itself, without ever reaching Manager.

## Outbound routing (which device to ring)

When `patch_notify(channel: 'speakers')` fires and there are multiple devices, the model decides based on context.

- The agent calling `patch_notify` (or Manager, for queued voice events) picks a target device based on time of day, recent activity, what the message is about, the user's CLAUDE.md preferences.
- `patch_list_devices()` returns `[{ deviceId, name, online, muted, lastUsedAt }]`. The agent reasons about it.
- Routing rules live in CLAUDE.md, e.g. "don't ring the living-room device for work notifications."

## Device audio path (TTS playback)

The device plays daemon-relayed TTS through its I2S speaker (MAX98357A-class amp behind the AIC3204 codec, with the on-board XMOS DSP as the I2S clock master) — Kokoro on `backend: local`, the hosted session's own audio on `gemini`/`openai`, resampled to 48 kHz the same way either source. Several firmware/daemon details are load-bearing for clean playback:

- Speaker bus runs at 48 kHz, ESP is the I2S slave. The XMOS DSP masters the speaker bus at 48 kHz (the mic RX bus is a separate 16 kHz bus). The TX `clk_cfg` must declare the true speaker rate (`SPK_RATE` = 48 kHz), not the 16 kHz mic rate — even in slave mode the IDF uses `clk_cfg.sample_rate` to set up the peripheral's sampling, and declaring 16 kHz on the 48 kHz bus injects sampling noise into complex content. The host resamples Kokoro's 24 kHz output up to 48 kHz before sending (one linear-phase windowed-sinc pass); the device plays the raw 48 kHz frames.
- TX `auto_clear = true`. On playback end or any mid-stream gap the TX I2S DMA underruns; with `auto_clear` the peripheral emits zeros instead of repeating the stale last buffer, killing an end-of-playback pop and hardening mid-stream gaps.
- Amp is enable-once-stay-on. The class-D amp (GPIO47) pops intrinsically on turn-off (a hardware transient). The device is mains-powered and the amp is silent at idle, so the firmware enables it on first playback and treats every later disable request as a no-op. A DAC soft-mute helper unmutes before the amp comes up so turn-on is glitch-free.
- DAC in PowerTune PTM_P1, the lowest-distortion Class-AB PowerTune mode of the AIC3204 DAC.
- Host peak-normalizes the device TTS. The host's voice session peak-normalizes each Kokoro utterance up to a safe ceiling (~−0.4 dBFS); it only boosts and clamps, so it can't clip.

## Echo cancellation and barge-in

The HA Voice Preview Edition has no hardware AEC, so echo and barge-in are handled host-side:

- Host-side AEC: receive raw mic audio, subtract a delayed copy of the TTS audio that was just transmitted to the device, feed the cleaned signal to Whisper and Silero-VAD.
- Barge-in: Silero-VAD runs continuously on the AEC-cleaned inbound mic stream, even while Kokoro TTS is streaming out. When VAD fires, the host stops the Kokoro stream, drops in-flight TTS audio, and routes the new utterance to STT.

In a highly reverberant room where echo proves unworkable, push-to-talk mode is the firmware-side mitigation: button-held = mic active, with no continuous mic during TTS.

## Mute switch behaviour

The HA Voice Preview's hardware mute switch cuts the I2S mic line at hardware level. Firmware:

1. Detects the switch state.
2. When muted: stops microWakeWord (saves CPU), drops any in-flight audio session, sends `mute_changed: true`.
3. LED ring goes solid red.
4. When unmuted: resumes microWakeWord, sends `mute_changed: false`.
5. Host must not attempt to ring a muted device. When `patch_notify(channel: 'speakers')` would target this device, host checks mute first and falls through to the next candidate (next device, then phone Manager call).

## LED ring states

| State                         | Colour / pattern     |
| ----------------------------- | -------------------- |
| Idle (available, unmuted)     | Dim static glow      |
| Wake-word detected            | White single pulse   |
| Listening (user speaking)     | Steady blue          |
| Heard you, working on it      | Breathing amber      |
| Agent speaking (TTS playing)  | Breathing green      |
| Ringing (incoming patch call) | Purple rotation      |
| Muted (hardware switch)       | Solid red            |
| Disconnected from host        | Slow red pulse       |
| Pairing in progress           | Blue rotation        |
| Pairing failed                | Magenta double pulse |

Idle is a dim static glow, not off — the device should always visibly show it's alive and listening, not look powered-down. The sequence for an ordinary exchange: wake-word pulse → steady blue while the user talks → the moment the utterance ends, the device plays the pong earcon (§ Acknowledgement, below) and the ring drops to breathing amber — this is the state that covers however long the real work behind it actually takes, from under a second to a background job that finishes minutes later — → breathing green once there's something to say, back to the idle glow when it's done speaking. Amber is deliberately between the idle glow and the active blue/green states: it's the one state that means "heard you, nothing to listen to or watch yet," distinct from both "your turn" (blue) and "my turn" (green).

## Acknowledgement — the pong, not a spoken "got it"

A spoken "got it" on every command is what makes always-on voice annoying to live with. Instead, the moment an utterance's transcript is final, the device plays a short two-tone earcon (~150ms, not a phrase, not synthesised — a fixed clip) and the ring drops to breathing amber. This needs no model call at all — it fires directly off STT completing, before dispatch has even started — so it's the fastest possible acknowledgement, and it works identically whether what follows takes 800ms or ten minutes as a background job.

The spoken reply, when it comes, is a separate event on its own timeline: Kokoro (or whichever tier's TTS) speaks it, the ring goes green, once it's ready — which might be immediately after the pong for a quick answer, or long after the user has moved on to something else for a task handed off as a job. The device does not hold the session open waiting for it the way a call does; a reply arriving well after the pong is delivered the same way a `patch_notify` announcement is (§ Two flows), not as a resumption of an in-progress turn.

## Patch-initiated calls (ringing)

When host decides to ring this device:

1. Host sends `{ type: "ring", chatId, message?, conversational }` over the control WSS.
2. Device plays a chime, LED ring goes purple rotation.
3. User accepts via button-press → device sends `ring_accepted` → host sends `session_start` → device opens audio WSS → host streams Kokoro audio of the queued message; if conversational, leaves the WSS open for the user's response.
4. Or user does nothing for 30 s → device sends `ring_dismissed`, host falls through to voicemail (push notification on phone, per `09-notifications.md`).
5. Or device is muted → host skips the ring frame and falls through immediately.

## Loss of HA Assist

The patch firmware replaces the device's native HA Assist — "turn off the kitchen lights" is a command like any other now, not a special case. An earlier version of this spec had the device recognise smart-home requests as a distinct kind of turn and call Home Assistant's REST API as a dedicated tool step; that assumption is gone. Manager already drives Home Assistant on its own terms (SSH / MCP, not a voice-specific integration), so a smart-home command dispatches exactly the way any other command does (§ Two flows above) — there is nothing here for the device or the proxy to recognise. Bolting HA-specific handling onto the voice path was what made it slow; not having a special case is what makes it fast.

## Multiple devices

- Each device has a `deviceId` and a user-given `name` ("kitchen", "bedroom", etc.) set at QR-link.
- Devices register with the host and advertise online/offline state.
- Voice-device chat receives `deviceId` on every inbound user-turn message — agent knows where the user is.
- For outbound rings, host offers candidate devices to the calling agent; agent picks (per Outbound routing).

## Concurrency with phone Manager call

If a phone Manager call is active and another voice event lands, the device does not ring. The host's voice queue logic (per `07-voice-app.md`) treats each device as another voice surface in the priority list. Default priority: phone-active-call > device-active-session > idle devices > push notification. Configurable via CLAUDE.md guidance to Manager.

## Cross-refs

- App-surface voice (phone + web), shared concepts and tiers: `07-voice-app.md`
- Proxy and Manager, and turn semantics this device's wake-word sessions reuse: `07-voice-app.md` § The fast voice and the chat's agent, § Session modes
- Notification channels and presence: `09-notifications.md`
- Voice-device chat (the chat that handles inbound conversations): `06-threads-manager-speakers.md`
- Host stack and host sizing: `02-daemon.md`, `11-deployment.md`
- Voice-token mint and the surface/host linking flows: `01-server.md`, `10-auth.md`
