# Tech stack

Decisions made upfront so every group builds on the same ground. Anything not listed here defaults to "whatever is idiomatic for the chosen tool." Pin versions in `package.json` / `Cargo.toml` / `platformio.ini`; bump in dedicated PRs, not feature work.

## Languages

| Layer                                         | Language                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------- |
| Server, host, CLI, web, mobile, desktop shell | TypeScript (strict mode, `noUncheckedIndexedAccess`)                                  |
| Voice device firmware                         | C / C++ on ESP-IDF                                                                    |
| Whisper local backend, Kokoro TTS             | Python sidecar processes (the upstream projects are Python — wrap, don't reimplement) |

No JavaScript files. No Rust on the Node side.

## Runtime / packaging

- Node.js LTS (current LTS at start of build; pinned in `.nvmrc`, in the server's Docker base image, and shipped inside the host artifact).
- pnpm workspaces for the monorepo.
- Turborepo for task orchestration and caching across packages.
- TypeScript project references so cross-package types resolve without rebuilds.

### Two shipping shapes

- Server → container. Built from this repo, deployed by the operator (`11-deployment.md`).
- Host → native binary artifact per OS/arch. esbuild bundles the host to a single JS file, shipped alongside a pinned Node runtime and the platform's prebuilt native addons, installing on a machine with no toolchain (`11-deployment.md` § Host installation).
  - Native addon: `onnxruntime-node` (Silero VAD), shipped per platform alongside the `silero_vad.onnx` weights it runs (~2 MB — the one model file in the artifact, so VAD works on every host with nothing downloaded). The host's native surface stays at this one addon; each additional native dependency multiplies the build matrix.
  - The agent backend, the large voice weights (Kokoro, local Whisper) and Python are provisioned on the host after install (`02-daemon.md`).
  - Signed with the project's signing identity; installs an OS service (launchd / systemd user unit).

## Server

- Fastify (HTTP + WebSocket via `@fastify/websocket`).
- pino for logging, JSON output, no pretty-print in production.
- zod for runtime schema validation at all external boundaries (HTTP, webhooks, WS frames). Schemas live in `packages/wire`.
- node-cron for the in-process cron scheduler — UTC only, TZ applied at parse/display.
- jose for EdDSA-JWT mint/verify; @noble/ed25519 for keypair operations.
- Expo's push API (`https://exp.host/--/api/v2/push/send`) for Android push fanout — a plain HTTP POST, no SDK dependency.
- @doist/todoist-api-typescript for Todoist.
- jsonata for filter evaluation.
- chokidar for the `/data/jobs/*.json` filesystem watch. `/data` is the server's volume, so the server owns this watch and pushes changes to the hosts (`01-server.md`).

## Host

- @anthropic-ai/claude-agent-sdk loaded in-process, pointed at the host's own Claude Code install via `pathToClaudeCodeExecutable`, so a host runs the same `claude` the user runs (`02-daemon.md` § Agent backends).
- Loopback control HTTP via Fastify on a Unix domain socket at `~/.patch/daemon.sock`.
- MCP server (`patch-tools-server`) implemented with @modelcontextprotocol/sdk, launched per SDK query, communicates over UDS.
- Silero VAD via onnxruntime-node, reading `silero_vad.onnx` out of the host's own install directory (§ Two shipping shapes).
- AEC: NLMS pure-TS canceller in the host; ~12-18 dB attenuation; voice device firmware does the heavy lifting via hardware AEC.
- Kokoro and local Whisper are provisioned after install, per host (`02-daemon.md` § Optional components). The host creates the Python environment (uv) and downloads those weights on demand.
- Whisper backend is pluggable per `WHISPER_BACKEND` env var:
  - `groq` (default): direct REST call to Groq's Whisper endpoint. Nothing to install.
  - `local`: spawn faster-whisper as a long-running Python sidecar (`uv run` → FastAPI, PCM in via WS, transcript out). Model: `medium.en`.
- Kokoro TTS as a long-running Python sidecar (same shape as faster-whisper). Streams 24 kHz mono.

## Wire protocol package (`packages/wire`)

- Pure TypeScript. No runtime dependencies beyond `zod`.
- Discriminated-union event types, encoded as JSON over WebSocket text frames.
- Per-chat monotonic `seq`, idempotency key on inbound user input, replay via `chat.replay { fromSeq }`.
- Adopt happy-wire shapes where direct copy works; diverge where patch's needs differ (cross-chat tools, voice events, special-thread routing).

## Storage

Stays "flat files" per spec, but with explicit shape:

- `/data/registry.json` — accounts and host keys. Single file. Atomic write via temp + rename.
- `/data/jobs/*.json` — one file per job. Watched.
- `/data/pending/<daemonId>/*.jsonl` — buffered actions, per host, for a host that is offline.
- `/data/runs/<jobId>.jsonl` — per-job run log.
- `/data/webhooks/<jobId>.jsonl` — per-job inbound webhook log.
- `/data/undelivered.jsonl` — failed notifications.
- `/data/broadcasts/<thread>.jsonl` — broadcast log per channel-mediating thread, written as the server routes each notify and read by the home host when the user replies (`09-notifications.md` § The broadcast log).
- `~/.patch/chats/<chatId>/` — daemon-managed per-chat state (NOT under `/data` — daemon-local): `meta.json` (chat metadata), `seq` (the persisted sequence counter) and `wake.json` (a pending self-wake), per `02-daemon.md`.

A daemon-local file is written and read by the same machine. Anything one machine writes and another reads is server state under `/data`.

Chat history itself stays in Claude Code's native `~/.claude/projects/`; we read it in place.

No SQLite. If we hit limits, that's a separate spec change.

## Web SPA (`packages/web`)

- Vite + React 19 + TypeScript.
- React Router v7 (SPA mode, no SSR).
- Zustand for state. One store per concern (chats, presence, voice, ui).
- TanStack Query for server-state caching where REST is involved (history pagination, jobs CRUD). WebSocket events update the cache directly.
- Tailwind CSS v4 for styling. Design tokens from `design/hi-fi-tokens.css` lifted into `tailwind.config.ts`.
- @monaco-editor/react for the embedded editor.
- Fraunces, Figtree (with Inter as the metrics-compatible fallback) and JetBrains Mono via `@fontsource` packages, self-hosted.
- Vitest for unit tests, Playwright for e2e.

## Desktop shell (`packages/desktop`)

- Electron + electron-builder.
- Loads the web SPA build directly (file:// in production, dev-server URL in dev).
- Native menu-bar / tray via Electron's `Tray` API.
- Global hotkey (⌃Space) via Electron's `globalShortcut`.
- Native OS notifications via Electron's `Notification`.
- electron-updater against the server's `generic` feed for self-update; builds are signed with a self-signed identity, which is what makes that update path work (`11-deployment.md` § Desktop code signing). Notarisation stays off.
- macOS only.

## Terminal CLI (`packages/cli`)

- Node.js, single binary via pkg (chosen for maturity and ws/onnxruntime-node binding compatibility; bun-compile output is larger and has worse native-module support for our deps).
- Ink for the TUI rendering (React for terminal — same mental model as the web SPA).
- commander for subcommand parsing.
- ws for the WebSocket client.

## Mobile (`apps/mobile`)

- Expo SDK (current at start of build), React Native, TypeScript.
- Android only.
- expo-router for navigation.
- Zustand for state (same as web).
- react-native-mmkv for local persistence.
- expo-notifications for the Expo push token, local notification channels, and call/message handling.
- react-native-callkeep + a custom Expo config plugin for Android `ConnectionService` (Manager incoming-call UI). TBD: confirm callkeep covers the foreground-service + audio-focus story before group 21 — fallback is a hand-rolled native module.
- expo-av for audio I/O; react-native-webrtc if we need lower-level access for voice.
- expo-updates for JS-only over-the-air delivery via EAS Update (`11-deployment.md` § Mobile OTA).
- Build with `expo prebuild && cd android && ./gradlew assembleRelease`. The APK is installed via `adb install` or sideload; no Play Store distribution.

## Voice device firmware

- ESP-IDF (Espressif's official C/C++ framework). Not Arduino, not ESPHome — we need direct control of the audio pipeline and WSS.
- microWakeWord as the on-device wake-word engine (it's the same one Home Assistant uses; ships as TFLite Micro models).
- esp_websocket_client for the control + audio WSS.
- esp_codec_dev for the I2S audio path (INMP441 mic, MAX98357A speaker).
- OTA via esp_https_ota pulling signed images from the patch server.
- Build + flash via ESP-IDF + idf.py (no PlatformIO — keep the toolchain official).

## Auth crypto

- Ed25519 keypair as the user identity (private key on first surface, public key as account ID).
- EdDSA-JWT (RFC 8037) for surface credentials.
- HMAC-SHA256 for webhook signature schemes (custom + GitHub + Stripe variants).
- All crypto via @noble/ed25519 + @noble/hashes + jose. No `node:crypto` Ed25519 (less portable).

## Deployment

- Docker Compose as the reference deployment (host sizing in `11-deployment.md`).
- Two services: `server`, `caddy`. The host is not a container — it installs on each host as an OS service (§ Two shipping shapes, `02-daemon.md` § Runtime and installation).
- Caddy as the reverse proxy (auto-TLS via Let's Encrypt). Terminates TLS and reverse-proxies everything to the server, which itself serves the web SPA at `/app` and the desktop feed at `/api/desktop/...`.
- `pnpm deploy` runs the server via docker compose (`up -d --build`); the server image builds + serves the web SPA. No CI publish, no image registry. The host builds separately as an installable artifact (`pnpm build:daemon`), published for install and self-update (`11-deployment.md`). Machine-specific delivery (to a remote box / phone) lives in git-ignored `scripts/local/`.
- Backups: restic nightly cron on `/data` to off-host object storage.

## Testing

Which layer a test belongs to is decided by `19-testing.md`. This section is only the tools each layer uses.

- Vitest for every package that can carry its dependency footprint: server, host, wire, auth, web, mobile. A root config with project-per-package config.
- The Node runtime's own test runner for the CLI and the desktop shell, with coverage from the runtime's own coverage flags. Both discover tests by pattern.
- Playwright for the browser layer, driven against the component dev harness rather than a booted stack, so a layout regression is caught without a server in the picture.
- Maestro for the Android surface layer. It drives a plain debug or release build with no native instrumentation and no separate instrumented build, grants permissions on launch, emits JUnit XML, and exits non-zero on failure. It drives the whole device, so it can see the notification shade and the native incoming-call screen, which is what the voice surface needs and what a grey-box driver scoped to the app's own view tree cannot reach.
- The Android emulator needs hardware virtualisation, so the surface layer runs only on a machine exposing a KVM device. The deployment box does not.

## Tooling

- eslint (flat config) + @typescript-eslint + eslint-plugin-react + eslint-plugin-react-hooks.
- prettier (zero-config, defaults except `singleQuote: true`, `printWidth: 100`).
- simple-git-hooks + lint-staged for pre-commit.
- changesets for versioning across the monorepo.

## Open TBDs (resolve before the relevant group runs)

1. ~~pkg vs `bun build --compile` for CLI single-binary (group 15).~~ RESOLVED — pkg (see Terminal CLI above).
2. react-native-callkeep coverage for ConnectionService (group 21).
