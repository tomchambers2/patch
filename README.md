# Patch

Run and steer Claude Code agents from anywhere: a thin coordination layer over
Claude Code across the terminal, web, phone, desktop and a voice device, with
triggers (cron, webhooks, Todoist) and hosts you run yourself. A host does the
work on a machine you choose; a server connects your devices to your hosts.

The design is written up in `spec/`. Licensed under the MIT licence.

## Install a server

On a fresh Linux box with systemd, one command installs a server with HTTPS
(Node, a service, Caddy and a certificate; `--domain` to use your own name, else
`<ip>.sslip.io`), makes the account and prints a QR to scan with the app:

```bash
curl -fsSL https://github.com/tomchambers2/patch/releases/latest/download/install.sh | sudo sh
patch-server pair            # another QR, whenever you want one
```

The installer checks the download against its published checksum before it
installs anything. The server needs no configuration to start
(`spec/01-server.md` § Starting with no settings). A server on a laptop or behind
a home router has no address of its own; point it at a relay
(`spec/10-auth.md` § Relay) and devices pair through it, end-to-end encrypted.

## Updates

Releases are published on GitHub: tagged `vX.Y.Z` releases are **stable**, and
every build of the main branch is a **dev** prerelease. A server follows one
channel, checks it hourly, and serves what it finds to its own hosts, desktop app
and phone, which update themselves from it:

```bash
patch-server channel            # which channel this server follows
patch-server channel stable     # the default
patch-server channel dev        # every build of main
patch-server channel off        # follow nothing; you update it some other way
```

A release is the server and web app, signed hosts for Linux (x64, arm64) and the
Android app. The macOS host and desktop app are not published yet.

## Build from source

The server is built as a self-contained release and installed into its own home,
never run out of a git checkout. Needs Linux with systemd (or `--no-service`) and
Node 20+:

```bash
pnpm install
pnpm build:server                                  # -> dist/server/patch-server-<release>/ (+ .tar.gz)
dist/server/patch-server-<release>/install         # installs, starts patch-server.service, waits for healthz
~/.patch-server/current/patch-server pair          # the first pairing QR
```

Upgrading is the same command with a newer release; the previous two stay in
`~/.patch-server/versions/` for rollback. State lives in `~/.patch-server/data`;
back that up. See `spec/11-deployment.md` § Server installation.

```bash
pnpm build:desktop   # Mac app (a local, unsigned build)
pnpm build:android   # APK -> apps/mobile/android/app/build/outputs/apk/release/
```

`build:android` bakes in the server the app should talk to from
`EXPO_PUBLIC_PATCH_SERVER_URL`.

## Layout

```
packages/
  wire/             shared wire-protocol types (group 3 fills in)
  server/           Fastify HTTP+WS service (port 3000)
  daemon/           Claude Code SDK lifecycle, UDS + TCP healthz
  cli/              Node + commander + Ink terminal client
  web/              Vite + React 19 + Tailwind v4 SPA (mounts at /app/)
  desktop/          Electron + electron-builder shell (macOS)
  voice-firmware/   ESP-IDF project for the voice device (NOT a pnpm package)
  kokoro-sidecar/   Python (uv) Kokoro TTS sidecar — daemon spawns it; 24 kHz PCM16 over WS
  whisper-sidecar/  Python (uv) faster-whisper STT sidecar (WHISPER_BACKEND=local)
apps/
  mobile/           Expo Android-only app
deploy/backup.sh           Nightly restic backup of /data
deploy/install-backup-cron.sh  Installs the restic cron on the box
scripts/fetch-models.sh    Downloads Kokoro + faster-whisper models to ./models
docker-compose.test.yml    Test stack (HTTP-only on :13000)
Caddyfile                  Reverse proxy config for the TEST STACK ONLY. Prod
                           Caddy lives on the box at /etc/caddy/Caddyfile.
```

## Prerequisites

- Node ≥ 20 (LTS pinned in `.nvmrc` to 22).
- pnpm 10.29.3 (auto-managed by Corepack via `packageManager` in
  `package.json`).
- Docker + buildx for the compose stacks and image builds.
- (Mac, optional) Xcode + ESP-IDF + Android SDK only when building the
  desktop / firmware / mobile surfaces.

## Day-to-day

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
```

`pnpm test` runs each package's `test` script through Turborepo. The
scaffold-level smoke tests are:

- `packages/server` — `GET /api/healthz` returns ok+version+gitSha; host
  proxy returns 503 when unconfigured.
- `packages/daemon` — `GET /healthz` (loopback fastify) returns
  ok+version+gitSha.
- `packages/cli` — `healthz` client parses JSON from a real HTTP server.
- `packages/web` — Vitest sanity smoke on the placeholder component.

## Local dev (no Docker)

```bash
SDK_BACKEND=real pnpm --filter @patch/daemon dev   # UDS at ~/.patch/daemon.sock + TCP :3001 (real Claude via `claude login`; SDK_BACKEND has no default)
pnpm --filter @patch/server dev   # http://localhost:3000 (PORT env override-able)
pnpm --filter @patch/web dev      # http://localhost:5173 (proxies /api, /ws)
```

`DAEMON_HEALTHZ_URL=http://127.0.0.1:3001/healthz` lets the dev server's
`/api/daemon/healthz` proxy reach the dev host.

### Authenticating the web UI in local dev / UI tests

The web SPA is gated behind a surface-credential pairing screen (`spec/10-auth.md`).
There is no paired surface in local dev or in an automated browser test, so the
app sits on the pairing screen and every `/api` call 401s. To drive the real UI
(sidebar, composer, Monaco, schedules, …) you need a valid `web` surface
credential. Bring the stack up directly — each service with its **real** backend,
reading its credentials from `.env` (no mock convenience wrapper exists; agents
must boot the genuine stack):

1. Pick a writable dataDir (`.dev-data/`, git-ignored) and mint a real `web`
   credential into it — this also bootstraps the singleton account on first run:

   ```bash
   PATCH_DATA_DIR=.dev-data pnpm --filter @patch/server fixtures:mint-surface-jwt
   ```

2. Start the server on that dataDir with its real backends (env from `.env`):

   ```bash
   PATCH_DATA_DIR=.dev-data pnpm --filter @patch/server dev
   ```

3. Start the **Vite dev** web server — `import.meta.env.DEV` is `true`, so the
   `?credential=<jwt>` bypass in `packages/web/src/lib/credential.ts` works
   (it's intentionally inert in production bundles). Point its API/WS proxy at the
   dev server with `PATCH_API_PROXY` (explicit `127.0.0.1` — avoids the
   `localhost`→IPv6 trap where a stray `::1` docker listener shadows it):

   ```bash
   PATCH_API_PROXY=http://127.0.0.1:3000 pnpm --filter @patch/web dev
   ```

Open `http://localhost:5173/?credential=<jwt>` — the app loads authenticated (the
param is stripped after the credential is persisted to localStorage). To populate
the Manager/Speakers threads in the sidebar, register and boot a host
the same way (`fixtures:mint-daemon-key` → `<dataDir>/daemon.key` →
`pnpm --filter @patch/daemon dev`). The host runs against its **real** SDK
backend via your `claude login` OAuth (Keychain on macOS,
`~/.claude/.credentials.json` on Linux — NEVER an API key); it aborts loudly if it
can't resolve a credential.

> Note: the docker test stack (`:13000/app/`) serves the **production** bundle,
> where the `?credential=` bypass is deliberately disabled and its `/data` volume
> is read-only — so credentials can't be minted into it. Use the dev bring-up
> above (Vite dev + minted credential) for any browser-driven verification.

## Compose test stack

The DOD for group 1: every health check passes against the test stack —
including `daemon/healthz`, which is 200 only once the host's `/ws` link is
authed (spec/10 derives host liveness from the inbound connection).

```bash
docker compose -f docker-compose.test.yml up --build -d

curl -sf http://localhost:13000/api/healthz | jq
curl -sf http://localhost:13000/api/daemon/healthz | jq   # 200 → daemon linked
curl -sfI http://localhost:13000/app/ | head -1

# Through Caddy (reverse proxy) on host :18080 → container :80:
curl -sf http://localhost:18080/api/healthz | jq
curl -sfI http://localhost:18080/app/ | head -1
# The host port is 13000 because the test stack avoids colliding with the
# common 3000-on-host development server. The container listens on 3000.

docker compose -f docker-compose.test.yml down -v
```

There is no human to scan the daemon-registration QR in the test stack, so a
one-shot `seed` service (built from the server image) bootstraps the account +
mints the host's EdDSA-JWT `daemon.key` into the shared `/data` volume BEFORE
the server boots — the server then recognises the host's `/ws` hello and
`daemon/healthz` goes green. server + host both
`depends_on: seed (service_completed_successfully)`.

## Voice backends (host)

The host hosts the whole voice pipeline (spec/07, spec/16): Whisper STT,
Kokoro TTS, Silero VAD, and a pure-TS NLMS AEC. Backends are selected by env:

| Env var              | Values                      | Default  | Notes                                                                              |
| -------------------- | --------------------------- | -------- | ---------------------------------------------------------------------------------- |
| `WHISPER_BACKEND`    | `groq` \| `local` \| `mock` | `groq`   | `groq` needs `GROQ_API_KEY`; `local` spawns the faster-whisper sidecar.            |
| `WHISPER_MODEL_PATH` | path                        | —        | faster-whisper `medium.en` dir (spawned-sidecar mode).                             |
| `KOKORO_BACKEND`     | `real` \| `mock`            | `real`   | `real` spawns the Kokoro sidecar; needs `KOKORO_MODEL_PATH`.                       |
| `KOKORO_MODEL_PATH`  | path                        | —        | Kokoro v1 model dir (`config.json`, `kokoro-v1_0.pth`, `voices/`).                 |
| `VAD_BACKEND`        | `silero` \| `mock`          | `silero` | `silero` runs the real ONNX VAD; needs `VAD_MODEL_PATH`. `mock` is unit-test-only. |
| `VAD_MODEL_PATH`     | path                        | —        | `silero_vad.onnx`.                                                                 |

All four selectors **fail loudly at host boot** if a real backend is chosen
but its model/credential is absent — no silent fallback to mock (spec
principle). Models are fetched with `scripts/fetch-models.sh` into `./models`.

The two Python sidecars are real `uv` projects:

```bash
# Kokoro (24 kHz PCM16 over WS); the daemon spawns this itself in real mode.
cd packages/kokoro-sidecar && uv venv --python 3.12 && uv pip install -e .
# faster-whisper STT (WHISPER_BACKEND=local):
cd packages/whisper-sidecar && uv venv --python 3.12 && uv pip install -e .
```

The host spawns each with `uv run python -m patch_{kokoro,whisper}_sidecar`
on boot (cwd = the sidecar package, overridable via `KOKORO_SIDECAR_CWD` /
`WHISPER_SIDECAR_CWD`), keeps them alive, and restarts on crash. The production
`patch-daemon` image bakes both venvs in.

## Conventions

- **No fallbacks.** Failures must surface immediately. See
  `CLAUDE.md`.
- **No system-prompt injection.** Prompting belongs to Claude Code and the
  user's `CLAUDE.md` files (see `spec/principles.md`).
- **Strict TypeScript** everywhere on the Node side, plus
  `noUncheckedIndexedAccess`. ESLint flat config + Prettier
  (`singleQuote`, `printWidth: 100`).
