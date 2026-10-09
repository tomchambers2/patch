# Patch — testing strategy

Read by `/e2e-test-run patch` (and any other test-loop tooling). Defines how each surface is exercised, what's used for the fix-and-rerun loop, and where the trade-offs sit. Per-platform tooling references (specific adb commands, AppleScript snippets, Electron remote-debugging) live in `testing/` next to this file.

**`spec/19-testing.md` decides WHICH layer a test belongs in, and is the authority.** This file is the map from those layers onto the actual paths and commands in this repo. If the two disagree, the spec wins and this file is stale.

| Layer       | Lives in                                                                         | Run by                                            |
| ----------- | -------------------------------------------------------------------------------- | ------------------------------------------------- |
| Unit        | `*.test.ts(x)` beside the code, or the package's `test/`                         | `pnpm --filter <pkg> test`                        |
| Contract    | `packages/wire/src/*.test.ts`                                                    | `pnpm --filter @patch/wire test`                  |
| Integration | `packages/server/test/e2e/`, `packages/web/src/__tests__/*.integration.test.tsx` | `pnpm test:e2e`, `pnpm test:integration`          |
| Browser     | `packages/web/e2e/*.spec.ts`                                                     | `pnpm --filter @patch/web test:ui`                |
| Surface     | this file's per-surface sections, plus `testing/`                                | by hand, on a machine with the emulator or device |

`pnpm verify` runs every layer above except Surface, and `pnpm deploy` runs `pnpm verify` first. Nothing else is a gate.

Two environment facts about the browser layer, both of which look like a broken app when you hit them:

- Playwright needs `npx playwright install chromium chromium-headless-shell` after any version bump, and `@patch/wire` must be built. Without the browsers every test fails identically on browser launch; the suite is not telling you anything about the app.
- On Hetzner it must run with `--workers=2` or fewer. At the default worker count the box starves its own dev server and tests fail en masse with `ERR_CONNECTION_REFUSED`, which reads exactly like a broken app and isn't.

## Surface targets and tooling

| Surface               | Where                                                               | What drives interaction                                                                                                                                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| server + host         | `https://patch.tomchambers.me/api`, `wss://patch.tomchambers.me/ws` | Vitest + Playwright API suites talk to the deployed Hetzner stack OR a local `docker compose -f docker-compose.test.yml up` mirror. Host control surface is reachable through the server-proxied `/api/daemon/*` routes.                                                                     |
| web (deployed)        | `https://patch.tomchambers.me/app/`                                 | Chrome DevTools MCP (`mcp__chrome-devtools__*`) — `select_page` before every action, `take_snapshot` for the a11y tree. Playwright MCP is also available; pick one and stay on it for a run.                                                                                                 |
| desktop (Electron)    | `/Applications/Patch.app`                                           | Launch with `--remote-debugging-port=9222`, then drive web content via Chrome DevTools MCP against `http://localhost:9222`. Drive the _native shell_ (tray, menu bar, window controls, ⌃Space hotkey) via `mcp__computer-use__*` and AppleScript batch scripts (`testing/macos-desktop.md`). |
| mobile-android        | Pixel_7 AVD on this Mac                                             | `adb` (`~/Library/Android/sdk/platform-tools/adb`) for install/launch/screenshot/tap/intent. `adb shell uiautomator dump` for accessibility-aware element finding. Package id `io.github.tomchambers2.patch`. See `testing/android-emulator.md`.                                             |
| voice device firmware | physical ESP32-S3 in the corner                                     | OTA flash + control-WSS injected commands via `patch logs --surface <deviceId>` and a host-side Python harness that fakes mic input. See `testing/voice-device.md`.                                                                                                                          |
| terminal CLI          | this shell                                                          | Spawn `node packages/cli/dist/index.js ...` against the test compose stack; assert on stdout/exit code.                                                                                                                                                                                      |

## In-process end-to-end integration suite (`test:e2e`)

The rest of this doc drives the _deployed / containerised_ stack surface-by-surface. That is deliberately heavyweight and skips the one failure mode that keeps biting in production: **a chat turn that gets "stuck with no response and no error".** Every unit test mocks the network or host seam, so a turn that never completes — or a host link that drops mid-turn — is structurally invisible to them.

`packages/server/test/e2e/` closes that gap. It boots the **REAL Fastify server + REAL `Daemon` connected over a REAL WebSocket link** (the host dials in with a genuine Ed25519 daemonKey and the server accepts it via `InboundDaemonLink`, exactly like production `packages/daemon/src/index.ts`). The ONLY mock is the SDK backend (`createMockSdkBackend`), so turns complete deterministically without hitting Anthropic. It is NOT the in-memory `link.emit` shortcut some older integration tests use — frames travel over an actual socket.

Full round trip exercised:

```
surface WS client (WireTestClient)
  → server /ws hub (InboundDaemonLink)
    → server ↔ daemon serverLink WS (real createServerLink)
      → real Daemon (chatRunner) → mock SDK backend
    ← back out to the surface WS
```

**The core invariant:** every "await a reply" is timeout-bounded via `waitReplyOrError` / `expectReply` (`harness.ts`). Each resolves on the first assistant `chat.message` OR `chat.error` for the chat, and REJECTS on timeout with a `[mode N] SILENT HANG …` message. A turn that neither replies nor errors therefore FAILS the suite — a silent hang can no longer hide. (Verified by temporarily dropping the host's `chat.input` routing: mode 3 fails with the SILENT HANG message; restore and it passes.)

### Run it

```bash
# from the monorepo root — runs ONLY this suite
pnpm test:e2e
# or, from the server package
pnpm --filter @patch/server test:e2e
# or directly
pnpm --filter @patch/server exec vitest run test/e2e
```

No docker, no host key on disk, no Anthropic credential — the harness mints its own account/daemon/surface keys and boots everything in-process on an ephemeral port.

### Modes covered (`chat-modes.e2e.test.ts`, one test per mode)

1. new-chat spawn (REST `POST /api/chats`) + first message → reply; `chat.spawned` + `chat.state` fanned out.
2. existing-chat second message → reply.
3. text-only turn → reply.
4. image attachment turn (REST multipart `POST /api/chats/:id/attachment` → host store over WS) → image-only turn replies; on `chat.replay` the ref is reconstructed and the `[Attachments]` block is stripped.
5. voice-note turn (REST `POST /api/voice/note` → transcript → injected turn → reply). Whisper is stubbed; the route + injection are real.
6. special thread (`thread_manager`) message → reply.
7. message queueing — turn B queued behind running turn A (`turnDelayMs`); both reply, in order.
8. stop/interrupt — a running turn is stopped and settles to `idle` (no hang).
9. streaming deltas — `chat.message_delta` chunks then ONE final `chat.message` at the reserved seq.
10. replay / reconnect — a fresh surface replays history seq-correctly.
11. **reliability** — host link dropped mid-turn → `chat.error daemon_unavailable` + `chat.state errored` (not a silent hang).
12. **reliability** — turn submitted while the host link is down → delivered on reconnect (server's per-surface offline buffer) OR a loud `chat.error`; never forever-pending.
13. AI title generation — `chat.state.name` set after the first reply; not regenerated on turn 2.
14. tool call + result — `chat.tool_call` / `chat.tool_result` reach the surface.

The shared harness lives in `packages/server/test/e2e/harness.ts` (`startHarness`, `expectReply`, `waitReplyOrError`, `record`, `until`).

## Render-level chat integration suite (`test:integration`)

The `test:e2e` suite above asserts on **wire events** and never renders the UI. That left a second failure mode invisible: **a turn that is accepted on the wire but never RENDERS in the transcript** — exactly the voice-note bug (the host injects the transcript as a user turn but streams back only the assistant reply, so a client that never optimistically echoes the user's own input shows nothing).

`packages/web/src/__tests__/chatTranscript.integration.test.tsx` closes that gap. It drives the **real web client** — the real `AppShell` + real Zustand stores + the real `PatchWs` dispatch/reducer + the real client controllers (`voiceController` echo path, `deliveryTracker`) — and asserts on the **rendered DOM** (Testing Library). A turn accepted on the wire but missing from the transcript FAILS here.

**Architecture — real client, faked server boundary.** This suite keeps the real client render + stores + controllers and fakes ONLY the server boundary: a scriptable in-memory WebSocket (`FakeWs`, the same seam `ws.test.ts` uses) plus a `fetch` stub for the cold-start `GET /api/chats` plus the audio-session opener test seam (`__setAudioOpenerForTests`). It does **not** boot the real in-process server+host because (a) jsdom ships no real `WebSocket`, and (b) the host **audio plane** that web voice notes stream through is not bootable in-process — the `test/e2e` `harness.ts` explicitly does not boot it ("the audio stack isn't booted"). The real cross-process backend loop is already covered at the wire level by `test:e2e`; this suite adds the missing **render-level** assertions where the voice bug actually lived. The non-negotiable invariant: exercise the real client echo/render path and assert on the rendered transcript — never events alone.

### Scenarios (each asserts the RENDERED transcript)

1. **typed message** — the user bubble renders on send, then the assistant reply, in order.
2. **voice note** — a stubbed-Whisper transcript renders as the user turn AND the reply renders. This test FAILS before the `voiceController.sendVoiceNote → addLocalMessage` echo fix and PASSES after (verified by stashing the fix).
3. **voice call turn** — the spoken `YOU` line renders (regression guard for the path that already echoed).
4. **image attachment** — a user turn carrying an image renders it inline.
5. **multi-turn ordering** — two user turns + two replies interleave in send order.
6. **send-while-running** — a turn sent while running renders `Queued`, drains, and both replies render.
7. **reconnect/replay** — a socket drop + reconnect replays the persisted history; the `[voice • web]`-tagged copy reconciles against the optimistic voice echo by content (no duplicate) and the transcript is rebuilt.
8. **daemon-offline send** — renders "queued — will send when the agent reconnects", then clears and shows the reply once the host returns (same `localId` redelivered).

### Run it

```bash
# from the monorepo root — runs ONLY this suite
pnpm test:integration
# or from the web package
pnpm --filter @patch/web test:integration
```

It is also part of the normal `pnpm --filter @patch/web test` run (it is a `src/**/*.test.tsx` file), so it counts toward the web package's 100% coverage threshold.

## The fix-and-rerun loop

The test/fix loop iterates against a local `docker compose -f docker-compose.test.yml up` stack — NOT the deployed Hetzner stack. The deployed stack is reserved for pre-merge end-to-end verification (one `pnpm health-check` after every deploy). The cloud EAS queue is reserved for the final shippable APK (one credit at the end of a mobile run); iteration uses `npx expo run:android`.

### server + host iteration loop

1. **Bring up the test stack** (idempotent):

   ```bash
   cd projects/patch
   docker compose -f docker-compose.test.yml up -d --build
   ```

2. **Run targeted Vitest** while iterating:

   ```bash
   pnpm --filter @patch/server test --watch <pattern>
   pnpm --filter @patch/daemon test --watch <pattern>
   ```

3. **Run cross-component WS tests** against the compose stack (server URL = `http://localhost:3000`).

4. Server / host code edits do NOT hot-reload inside the compose stack — the Dockerfiles run the compiled `node dist/index.js`. Two iteration paths:
   - **Host-side dev (fast loop)** — run the package directly with `tsx watch`:
     ```bash
     pnpm --filter @patch/server dev   # tsx watch src/index.ts
     pnpm --filter @patch/daemon dev   # tsx watch src/index.ts
     ```
     Point each at the other via env (`PATCH_DAEMON_UPSTREAM_URL`, `PATCH_DAEMON_HEALTHZ_URL`, etc.) and use the compose stack only for a real host dependency or for full integration tests.
   - **Container rebuild (full integration)** — `docker compose -f docker-compose.test.yml up -d --build`. This is the only path that exercises the Caddy front + the real network topology. Use it after substantive changes and before commit.

### web iteration loop

Two paths:

- **Test against `localhost`** (default during iteration). Start `pnpm --filter @patch/web dev` (vite on :5173). Vite proxies `/api` and `/ws` to the test compose stack on :3000.
- **Test against the deployed URL** (final verification). Same Playwright suite, different base URL via `PATCH_TEST_BASE=https://patch.tomchambers.me`.

### desktop iteration loop

Electron shell loads the configured server URL. Two paths:

- **Dev mode** — `pnpm --filter @patch/desktop dev` runs Electron against `http://localhost:5173` (the vite dev server) with DevTools open. JS edits hot-reload.
- **Packaged build** — only needed when testing the wrapper itself (tray, hotkey, auto-update). `pnpm --filter @patch/desktop dist` then install from the dmg.

The web behaviour inside the Electron window is the same code as the web SPA, so for shell-agnostic web tests treat desktop as a thin wrapper and drive via web tests against `http://localhost:5173` (or the deployed URL). Use `testing/electron.md` for the wrapper-specific tests (tray menu, global hotkey, native notifications).

### mobile-android iteration loop

1. **Boot the emulator** (idempotent):

   ```bash
   ~/Library/Android/sdk/platform-tools/adb devices | grep -q "emulator-.*device" \
     || (~/Library/Android/sdk/emulator/emulator -avd Pixel_7 -no-snapshot-load &) \
     && ~/Library/Android/sdk/platform-tools/adb wait-for-device
   ```

2. **First install of the dev build** (~3–5 min cold, ~30 sec incremental):

   ```bash
   cd projects/patch/apps/mobile
   npx expo run:android --device
   ```

   The dev build is functionally equivalent to the EAS preview APK for E2E purposes. Differences (dev menu, log levels) don't affect feature behaviour. Bundle id is the same (`io.github.tomchambers2.patch`).

3. **JS-only fix** — instant, no rebuild, no install. Metro hot-reloads.

4. **Native-config fix** (new permission, new native module, callkeep config change) — `npx expo run:android` again.

5. **Env-var fix that targets EAS specifically** — set in `apps/mobile/.env.local` for local dev, also push to EAS via `eas env:create --environment preview ...` for the eventual shippable APK.

### EAS rebuild — exception, not the default

A full `eas build --platform android --profile preview` is right only when:

- the test cycle has finished and you're shipping the verified APK to Tom's phone (one final build);
- you specifically need to test something that only differs in a release build (Hermes optimisations, ProGuard'd output) — rare.

`eas build --local` exists if you want a release-equivalent APK without the cloud queue (~10–15 min on this Mac).

### voice device iteration loop

1. **Mock harness on host** — `pnpm --filter @patch/voice-firmware mock` spawns a Python script that opens the same control + audio WSS as a real device, emits canned PCM frames, and prints LED-state events. Faster than re-flashing for host-side iteration.

2. **Real device flash** — only needed when changing firmware code. `idf.py build flash monitor`. Subsequent OTA tests upload to `/srv/patch/data/firmware/stable/`.

## Auth, QR pairing

QR pairing flows are tested per surface using the same harness: a primary "linked" surface signs a credential for the new surface, then the new surface negotiates over the server's pairing channel. Per-surface helpers live in `testing/qr-pairing.md`. There's no email / magic-link flow — patch uses Claude OAuth (handled out-of-band) plus device-to-device QR; nothing to extract from Gmail.

## Voice testing

End-to-end voice on phone / web / device is exercised via:

- **Host-side unit tests** for the Whisper, Kokoro, VAD, AEC pipeline using fixture audio.
- **Surface-level smoke** — open the voice overlay, press-and-hold to record a fixture, assert the chat receives a `chat.message` with the expected transcript prefix `[voice • <surface>]`.
- **Latency budgets** — `pnpm --filter @patch/daemon test:latency` measures STT + Kokoro + WSS round-trip against a fixture; should pass on the test compose stack with `WHISPER_BACKEND=groq`.

See `testing/voice.md` for the test fixtures and assertion thresholds.

### Live-stack voice probes (no human, no microphone)

Two probes drive the REAL production voice path with Kokoro-synthesised speech
as the microphone. They exist because voice shipped broken repeatedly while
every mocked test passed — and because the host-side probe then passed on
prod while real calls were broken (2026-08-25: the fake-live-transcript
partials were starving Groq's 20 RPM quota, so the committed STT 429'd and the
turn silently died — an outer-leg failure no loopback test could see).

- `scripts/voice-probe.mjs` — INNER legs. Runs ON the host, mints its
  own HMAC token, talks to the audio WSS on loopback. Proves Whisper → agent →
  Kokoro.
- `scripts/voice-probe-fullpath.mjs` — OUTER legs too. Runs anywhere with a
  surface credential (`~/.patch/credential.jwt`): real `POST /api/voice/token`
  mint, public `wss://…/audio/<id>` via Caddy, a voice-call session exactly as
  the mobile surface opens one, per-leg deadlines so a failure NAMES the first
  silent leg (`mint` / `connect` / `listening` / `transcript` / `addressing` /
  `reply` / `tts_end`). The mic fixture is
  `scripts/fixtures/probe-utterance-16k.wav` ("Patch, say the word banana back
  to me and nothing else"); regenerate against a Kokoro host if the prompt
  changes.
- `scripts/web-voice-call-live.mjs` — REAL SURFACE. Playwright launches
  Chromium with `--use-fake-device-for-media-stream` +
  `--use-file-for-fake-audio-capture` (fixture:
  `scripts/fixtures/probe-fakemic-16k.wav`, the banana clip padded with lead-in
  and tail silence), injects `~/.patch/credential.jwt` into
  `patch.credential.v1`, loads the DEPLOYED app, clicks the chat header's Call
  button, and passes only when ≥1s of reply PCM is actually scheduled through
  `AudioBufferSourceNode` to the speaker — the app's own capture, WSS, and
  playback code, not a headless reimplementation. Runs on the Mac (needs
  Playwright chromium for @patch/web).
- `scripts/electron-voice-call-live.mjs` — the INSTALLED desktop app. Relaunch
  Patch with `--remote-debugging-port=9222` plus the fake-mic flags AND
  `--disable-features=AudioServiceOutOfProcess,AudioServiceSandbox` — without
  that last one Electron's sandboxed audio service silently ignores
  `--use-file-for-fake-audio-capture` and the "mic" is pure silence
  (`vadEvents: 0` at the host; looks exactly like a broken call and isn't).
  Use the 48 kHz fixture (`probe-fakemic-48k.wav`). The script attaches over
  CDP and runs the same click-Call / measure-scheduled-PCM assertion as the web
  test. Quit + `open -a Patch` afterwards to restore a clean launch.
- `scripts/electron-ear-live.mjs` — the EAR (hands-free / working mode) in the
  installed desktop app, both halves of its contract in one session: an
  unaddressed utterance must show greyed (`data-heard-not-sent`) with NO reply
  audio, then a "Patch, …" utterance must get ≥1s of reply PCM. Uses the
  combined fixture `probe-ear-48k.wav` (unaddressed line at ~1.5s, addressed at
  ~12.4s) with the same Electron launch flags as the call test. This test
  caught the exact-match address gate dropping addressed speech whenever
  Whisper misheard "Patch" as "Hatch"/"Catch" (fixed 2026-08-25: the gate now
  tolerates edit distance 1).
- `scripts/voice-watch.sh` — cron wrapper on the Hetzner host (07:30 & 15:30
  UTC, `crontab -l` as claude-dev). Runs the full-path probe with
  `~/.patch/probe-credential.jwt` across three cases — `call` (Talk button
  semantics), `ear-drop` (hands-free must drop an unaddressed utterance,
  `--expect-dropped`), `ear-reply` (hands-free must answer "Patch, …") — logs
  to `~/.patch/logs/voice-probe.log`, and pushes one high-priority ntfy alert
  naming the failed case+leg. Quiet on pass. Each run costs two agent turns on
  `thread_manager` plus three Groq requests.

## Notification fixtures (group 12)

`FIREBASE_SERVICE_ACCOUNT_JSON` is intentionally unset — the server boots
without push (lazy-fail). A test that needs to assert push behaviour injects
a mock `PushBackend` directly via `build({ pushBackend })`.

## Artefacts

Save screenshots and any scratch files to `/tmp/patch-e2e/<surface>/`. Don't write artefacts into the project. Clean up downloaded `.apk` / `.dmg` / `.bin` files when the run finishes.

## What can't be programmatically verified

Documented in `testing/limitations.md` — notification banner appearance on a real phone (vs emulator), audio output quality, haptics, biometric prompts, the actual physical voice device unless one is at this desk. These are honestly-untested by default and called out in any final report rather than silently passed.
