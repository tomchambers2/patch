# Deployment and installation

The server is deployed once by the operator. A host is installed on each host
machine, from a signed binary artifact, onto a machine that has only an OS on it.
§ Reference deployment covers the server; § Host installation covers the
daemon.

## Host sizing

≈4 dedicated cores, 16 GB RAM with hosted STT.

The voice configuration is Groq for Whisper STT + Kokoro local for TTS. Whisper's CPU load is offloaded to Groq for ~$3–5/month; Kokoro TTS runs on the host using ~1–2 cores during synthesis.

Resource budget on that sizing under typical load:

| Component                 | RAM                      | CPU peak                   | CPU sustained     |
| ------------------------- | ------------------------ | -------------------------- | ----------------- |
| patch-daemon (Node)       | ~500 MB                  | 1–2 cores                  | low               |
| patch-server (Node)       | ~200 MB                  | <1 core                    | low               |
| Agent backend + tools     | ~1 GB per active session | bursty                     | low between turns |
| Kokoro TTS                | ~600 MB                  | 1–2 cores during synthesis | idle              |
| Silero VAD (for barge-in) | <100 MB                  | <1%                        | <1%               |

Whisper STT runs on Groq (no local CPU cost). 4 cores easily handle the rest with headroom for concurrent voice sessions.

### Self-hosting Whisper

Set `WHISPER_BACKEND=local` and size the host at ≈8 dedicated cores, 32 GB RAM. `faster-whisper medium.en` runs real-time on 8 cores, ~1 GB RAM, 4–6 cores during transcription. Total time-to-first-audio is ~400ms slower than Groq.

That sizing covers a host running voice. A host on remote STT with no TTS
components installed needs headroom for Node and the agent's own work.

## Topology

One server; one host per host machine. The server and a host commonly share a
machine, and deploy and update independently.

```
   ┌─────────────────────────────────────┐
   │  patch-server (deployed)     :443   │  Caddy → :3000
   │  relay · registry · webhooks        │  the only public component
   └───────▲──────────────────────▲──────┘
           │ outbound WS          │ outbound WS
  ┌────────┴─────────┐   ┌────────┴──────────────┐
  │ HOST: rented box │   │ HOST: laptop (behind  │
  │ (often the same  │   │ NAT — no inbound      │
  │  machine as the  │   │ address needed)       │
  │  server)         │   │                       │
  │  patch-daemon    │   │  patch-daemon         │
  │   agent backend  │   │   agent backend       │
  │   Silero VAD     │   │   Silero VAD          │
  │   Kokoro (TTS)   │   │   (Kokoro/Whisper     │
  │   FULL HOST      │   │    optional per host) │
  │   ACCESS         │   │   FULL HOST ACCESS    │
  └────────┬─────────┘   └───────────────────────┘
           │ HTTP streaming
           ▼
     ┌─────────────────┐
     │   Groq cloud    │  Whisper large-v3-turbo
     │   (STT only)    │  ~$0.04/hour, ~50–100ms latency
     └─────────────────┘
```

Hosts dial out to the server, so a host behind NAT and without a fixed address
runs one as well as a rented box does. A server without a public address of its
own is reached by surfaces through a relay (§ Relay).

## Server installation

The server requires one long-lived process, a persistent data directory, TLS
termination, and a publicly reachable URL for webhook and push ingress. It is
built as a **release** and installed, the same way on every host — Tom's box and
anyone self-hosting Patch alike. The running server is never a git checkout:
nothing done to source (a build, `git stash -u`, `git clean`) can reach what is
live.

Pads (`14-design-web.md` § Pads) draw pictures of changes and card thumbnails in a headless Chromium on the server host, so the host needs one installed for the server's user (`npx playwright install chromium`). A Send or a thumbnail on a host without it fails with that reason; nothing else depends on it.

`pnpm build:server` (`scripts/build-server.mjs`) builds one directory and a
tarball of it:

```
patch-server-<release>/
  patch-server        launcher — what the systemd unit runs
  install             installer
  server.env.example  config template
  server/             the server's dist + production node_modules (pure JS)
  web/                the SPA it serves at /app
  build-info.json     release, version, gitSha, builtAt, serverSha, web
```

The server and the SPA it serves are one release, so they cannot drift apart.
It is pure JavaScript and runs on any OS/arch with Node 20 or newer.

`<release>/install [--home DIR]` lays out the install home (default
`~/.patch-server`):

```
~/.patch-server/
  versions/<release>/   the current release and the two before it (rollback)
  current               -> versions/<release>, swapped atomically
  data/                 the server's state (registry, jobs, attachments, …)
  downloads/            the update channel: daemon artifacts, APK, desktop feed
  server.env            config + secrets, mode 600 — the unit's EnvironmentFile
  logs/server.log
```

A first install writes `server.env` from the template and carries straight on:
nothing in it is required (`01-server.md` § Starting with no settings).
`--public-url` records where devices reach the server, which the pairing code
and the host-install command carry. An install copies the release into
`versions/`, swaps `current`, writes and restarts the `patch-server` systemd
unit, and waits until `/api/healthz` reports the release's commit — failing
loudly, with the log tail, if it does not. `--system` writes a system unit
running as `--user` instead of a user unit; `--no-service` stops after the
layout, for hosts without systemd. The launcher points the server at `data/`,
`downloads/` and the release's own `web/` itself; `server.env` cannot move them.

`<home>/current/patch-server pair` asks the running server for a pairing code
and prints it as a QR and as text. The first run on a fresh server also makes
the account, keeping the credential it was given in `data/admin.credential`
(0600) to open the next pairing window.

### One command

On a fresh Linux box with systemd, `install.sh` — published beside the release
tarball, its checksum and a copy of the tarball under a name that never
changes — installs a server with HTTPS:

```
curl -fsSL https://patch.tomchambers.me/api/server-release/install.sh | sudo sh [-s -- --domain NAME] [--email ADDR]
```

It makes a `patch` user, installs the release into `/var/lib/patch-server` as a
system service, provisions Node 22 into that home when the box has no Node 20+,
and runs Caddy (`patch-caddy.service`, its own binary, nothing shared with a
Caddy the box already has) as the TLS front: a Let's Encrypt certificate for
`--domain`, or with none for `<ip>.sslip.io`, a name that resolves to the box's
own address so there is nothing to register. Ports 80 and 443 must be free and
reachable. It then waits for the certificate, makes the account and prints the
first pairing code, and leaves `patch-server` on the path for the next
(`patch-server pair`). Running it again upgrades.

Every download is checked against its published checksum before anything
installs, and a failure at any step stops it with the reason. `--no-https`
serves plain HTTP on `:3000` for a LAN or an existing proxy; `--user-mode`
installs for the current user with no root and no HTTPS, to try it out.

Put a TLS reverse proxy in front of `PORT` (Caddy, nginx), sending `/device/*`
to the host's port and everything else — `/audio/*` included — to the server, which relays each voice session to the host that owns the chat (`07-voice-app.md` § Reaching a non-home host's audio WSS).

## Relay

`patch-relay` is the relay of `10-auth.md` § Relay: one small Node process with
no state and nothing to configure but `PORT` (default 8787). It is run behind a
TLS reverse proxy that passes WebSocket upgrades (`reverse_proxy 127.0.0.1:8787`
in Caddy), and the address people use is its `wss://` address. A server uses a
relay when `PATCH_RELAY_URL` names one; the desktop app's own server uses the
project's hosted relay unless that is set. Anyone may run their own and point
their servers at it.

## Host installation

The host is built as a per-OS/arch binary artifact and installed; the runtime
model and first-run contract are in `02-daemon.md` § Runtime and installation.

The artifact holds one bundled JS file (the host and its pure-JS dependencies),
a pinned Node runtime, the platform's native addons — currently
`onnxruntime-node` for Silero VAD — and `silero_vad.onnx` itself, the one model
weight inside the artifact, at ~2 MB. Targets are macOS arm64 and Linux
x64/arm64. macOS x64 is not a target: `onnxruntime-node` ships no darwin-x64
binary, and every artifact carries VAD rather than making it an optional
download, so the target cannot be built. Requirements on the result:

- It installs and runs on a machine carrying only an OS.
- It is signed with the project's signing identity, which is what the self-update path verifies against.
- It reports its version, which drives the stale-host indicator in Settings →
  Hosts and the host's self-update against the server's manifest.

The agent backend, the large voice weights (Kokoro TTS, local Whisper) and Python
stay outside the artifact and are provisioned on the host (`02-daemon.md`).
Carrying them would put CPU-torch, a spaCy model and a multi-GB weights set into
every install on every host, ahead of any use of voice. Those two components
install into a host-local components directory, with a Python environment the
host provisions at that point (`18-tech-stack.md`). Silero VAD's weights are
the exception the size test allows in: ~2 MB, needed by every host, so they ride
in the artifact (`02-daemon.md` § Installation).

Updating never waits unboundedly. Each network step of a host self-update (the
manifest check, the artifact download) is limited to 2 minutes, extraction to 2
minutes and the installer to 5 minutes; a step that overruns ends the attempt
with a message naming what timed out, and the update can be requested again.
The wait for running turns to finish is deliberately not limited. The desktop
shell's update check is likewise limited to 2 minutes and runs one at a time;
overrunning is recorded as a failed check, never as up to date. An attempt that
could stall forever blocks every later request, because requests join the
attempt in flight.

## Env

`~/.patch-server/server.env` on the server host (written by the installer, never
committed). Everything in it is optional (`01-server.md` § Starting with no
settings):

```
# Where devices reach this server, for the addresses it hands out.
PATCH_PUBLIC_URL=https://patch.<your-domain>
# User timezone. The default zone the CLI puts on a cron trigger it creates; a job
# carries its own zone thereafter (see 08-triggers-and-jobs.md).
TZ=Europe/London

# Providers
TODOIST_WEBHOOK_SECRET=...

# Push (Android) — nothing to set here. The server posts to Expo's push API,
# which takes no server-side credential; the FCM V1 credentials that actually
# reach the device are a one-time upload to the EAS project (see § Mobile OTA).

# Voice
WHISPER_BACKEND=groq         # or "local" for self-hosted
GROQ_API_KEY=...             # groq backend; or set it in Settings → Keys
# GEMINI_API_KEY / OPENAI_REALTIME_API_KEY — hosted voice. Optional here:
# provider keys can be set from Settings → Keys instead (shared by every
# host, stored on the server), which wins over the environment
# (02-daemon.md § Provider keys).
# Voice model files are downloaded by the daemon on demand into its own
# host-local components directory, which the daemon resolves itself
# (02-daemon.md § Optional components).

# Agent backend credential (daemon)
# Optional. This machine's own login, like `claude login`: adopted as the first
# shared account when the server holds none, and offered for adoption from
# Settings otherwise. The shared accounts on the server are what turns use.
# See 10-auth.md.
CLAUDE_CODE_OAUTH_TOKEN=...
```

`WHISPER_BACKEND`, `GROQ_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` are read by the
daemon, so they are set in the environment of each host's service rather than in
the server's compose env — or, for the provider keys, from Settings → Hosts →
Keys, which stores them on the host and never on the server. The rest are the
server's.

## Deploy guide

Canonical source is `main`. Deploying the server means building a release and
installing it (§ Server installation):

```sh
pnpm build:server                                   # → dist/server/patch-server-<release>/
dist/server/patch-server-<release>/install          # installs into ~/.patch-server
```

`pnpm run deploy` (`scripts/ship.mjs`, see `deploy.md`) does exactly that on
the reference box, as one of every surface it ships.

The desktop app, the Android app and the host are builds, not
deployments — artifacts a person installs:

```sh
pnpm build:desktop   # Mac app → /Applications (signed release needs Apple creds); carries the server release and this Mac's daemon build
pnpm build:android   # APK — no server address is built in
pnpm build:daemon    # daemon artifacts per OS/arch → published for install + self-update
```

The host artifacts are published to the server, which serves them with a
version manifest: that one channel feeds both a new host's install command and
every existing host's self-update (`02-daemon.md`).

Nothing host-specific is committed. Getting a build to a particular place — a
remote box, a phone — is machine-specific and lives in a git-ignored
`scripts/local/`.

The rules that must hold, wherever it runs:

- a server deploy completes without touching any host. Hosts dial out and
  reconnect with backoff (`12-error-and-offline.md`), so a server restart drops
  every host's link and each host restores itself. Chats in flight during the
  restart surface the drop.
- server and host versions are independent. The wire protocol is the
  compatibility contract: the server states the host version range it supports,
  and a host outside that range is shown as needing an update.
- web is part of the server release, so a server deploy always carries the
  current UI. A UI-only deploy assembles a release around the RUNNING release's
  server (`build-server.mjs --reuse-server`), so it never ships a new server
  version, and restarts the server onto it.
- SPA cache headers make new deploys land immediately. The server serves
  `/app/index.html` (and the SPA-fallback routes) with `Cache-Control: no-store`
  — the HTML is NEVER cached, so any load/reload fetches the current document,
  which references the current content-hashed bundles. The hashed build assets
  (`/app/assets/*`) are served `Cache-Control: public, max-age=31536000,
immutable` — safe to cache forever because a rebuild changes their filename.
  This is what lets a surface pick up a deploy on an ordinary reload, with no
  force-reload. See `14-design-web.md` § Live updates for the in-app watcher
  that makes the reload automatic.
- mobile: native vs JS. A native change (new module, permission, icon,
  `app.config` plugin, `version` bump) needs a fresh APK; a JS-only change
  ships over the air (OTA, below) with no reinstall.
- verify, don't trust exit 0. Poll `GET /api/healthz` until `gitSha` matches
  HEAD (fail loudly on timeout); assert the published APK URL returns 200. NO
  FALLBACK — any failed step aborts.

- Single monorepo: `projects/patch/` contains `packages/{server,host,cli,web,wire,auth,desktop}` and `apps/mobile`.
- Built in place on one box — no registry, no CI.

## Mobile OTA (Expo Android)

JS-only changes to the mobile app ship over the air via EAS Update — no new
APK, no reinstall.

- Config. `expo-updates` is installed; `apps/mobile/app.config.ts` sets
  `updates.url = https://u.expo.dev/<easProjectId>`, `updates.checkAutomatically
= 'ON_LOAD'`, and `runtimeVersion: { policy: 'appVersion' }`. The committed
  `android/.../AndroidManifest.xml` carries the matching `expo.modules.updates.*`
  meta-data (ENABLED, EXPO_UPDATE_URL, EXPO_RUNTIME_VERSION, check-on-launch).
- Launch behaviour. The mobile app runs a check → fetch on launch from the
  root layout, and re-checks on a 30-minute timer and on every background →
  foreground transition while it stays open. It is best-effort and non-blocking
  (`fallbackToCacheTimeout: 0`): the app boots on the bundle it already has and
  a newer one downloads behind it. A no-op in dev / Expo Go.
- NO automatic reload. No automatic path reloads into a fetched update —
  `expo-updates` launches the downloaded bundle by itself at the next cold
  start. Reloading on launch made the app paint the old bundle and then restart
  into the new one, which reads as a white flash and a second load; reloading
  while the app is open restarts it mid-use. The only reload in the app is the
  one the user presses: Settings → Version → "Restart to update", which appears
  whenever a bundle is downloaded and pending.
- Runtime-version gate (NO broken OTA). An update is delivered only to a
  build whose `runtimeVersion` matches the published branch. `appVersion` policy
  ties the runtime to the app `version`, so a NATIVE change (new permission /
  native module / callkeep / `version` bump) needs a fresh binary rather than a JS-only
  OTA — it requires a fresh APK.
- First OTA-capable build. Enabling `expo-updates` is itself a native change,
  so the first APK carrying it must be built + installed once. Every JS-only
  change after that ships via EAS Update (`preview` branch) — no new APK. See
  Deploy guide above.
- Push credentials. A one-time upload, made by the app publisher, not a
  deploy step: the Firebase project's FCM V1 service-account key is uploaded
  to the EAS project (`eas credentials`), which is what lets Expo's push API
  actually deliver to the device. `google-services.json` stays committed in
  the mobile app so the native build links to that Firebase project; neither
  credential is ever read by the server.

## Version reporting

Patch ships four independently-deployable layers down unrelated delivery paths:
the server and web SPA (one installed release), the host (a per-OS artifact
each host self-updates to), the desktop shell (a packaged
Electron app on each Mac), and the Android app (APK + OTA). Any of them can be
left behind by a delivery that only touched the others, and the host layer can
differ from host to host.

This bit us: a `deliver server` rebuilt the image and bumped the reported git sha,
while the SPA — served from `deploy/web-dist`, which the image knows nothing about
— stayed at a build from eight days earlier. `/api/healthz` reported the new
commit the whole time, so the product looked current while the UI was a week stale.
Nothing anywhere compared the two.

Rules.

- Every layer is stamped. One source of truth yields
  `<major>.<minor>.<commit count>` plus a short git sha and build instant. The
  patch component is the commit count, so versions increase monotonically without
  manual bookkeeping — a hard requirement for electron-updater, which compares
  semver, not shas. The web build emits `dist/version.json`; the desktop build
  emits `dist/build-info.json`; the server takes `PATCH_VERSION` /
  `PATCH_GIT_SHA` / `PATCH_BUILT_AT` from the Docker build; the host carries the
  same three stamped into its artifact and reports them on `daemon.host`; the APK
  inlines `EXPO_PUBLIC_PATCH_*`.
- Clients report themselves. The WS `hello` carries `clientVersion` plus
  optional `clientGitSha` / `clientBuiltAt`, recorded into presence. This is the
  only way to answer "what is my phone actually running?" — a published APK says
  nothing about whether a device installed it. For an OTA launch the mobile client
  reports the OTA bundle's creation time, not the APK's, so JS-only drift is
  visible too.
- `GET /api/version` (authed) reports every layer, each linked device, and any
  drift between them, with a remedy per item. It re-reads the mounted web-dist
  and downloads dir per request, so a check reflects the box as it is now.
  `/api/healthz` stays the public, minimal LB probe.
- Unknown reads as unknown. An unstamped, missing or unreadable layer is
  reported as such. A malformed report is rejected at the client boundary
  (`assertVersionReport`) so a partial response reaches the panel's error state
  instead of rendering as "all layers agree".
- A delivery that leaves prod inconsistent FAILS. `deliver server` now ships
  the SPA with it, and every path that changes what prod serves ends by asserting
  the box's own `/api/healthz` and `/app/version.json` report the same commit.
- The shell's updater must be able to explain itself. `diagnoseUpdater`
  names each condition that makes updates
  impossible — unpackaged build, no `app-update.yml` (a `--dir` build), a `0.0.0`
  version that always compares as newer, an adhoc signature macOS won't let
  Squirrel apply — and the panel shows it. Every check outcome, failures included,
  is recorded with a timestamp and persisted, so "nothing new" and "couldn't
  check" read as distinct states.
- A downloaded update installs itself. Downloading IS the decision: every
  downloaded build — boot check, hourly check, or the check a landed deploy
  triggers — quits and comes back on the new build without asking. Patch deploys
  ~20 times a day, so a per-download "restart to install" prompt was ~20
  interruptions a day for an answer that was always yes; there is no such
  control and no such prompt. The close gesture that merely hides the main
  window (`05-surfaces.md` § Window chrome) must not absorb that quit, or the
  install reads as the window closing while the old build keeps running.
- A refused install is reported, never swallowed. With no prompt left, the
  panel's error line is the only way a shell that cannot install (a signature
  Squirrel won't apply) reaches the user, so an install that throws is recorded
  as a check failure verbatim and leaves the app running rather than half-quit.

Surface. Settings → Version & updates,
also reachable from the tray's right-click menu. Shows per-layer version/sha/time,
drift with remedies, last-checked, a Check now button, and — in the desktop shell —
the shell's own version and what its updater is doing. It REPORTS the shell's
update state; it never asks for a restart, because updates install themselves.

Desktop update feed. `electron-builder.yml` publishes with the `generic`
provider to `<public-url>/api/desktop/`; the delivery script rsyncs
`latest-mac.yml` + the `.zip` (+ `.blockmap`) and a `desktop-latest.json`
provenance sidecar into the box's downloads dir, served by the server's public
`/api/desktop/:name` route.

## Desktop code signing

The shell is signed with the project's signing identity rather than an Apple
Developer ID. Signing is what makes the update path work: the updater refuses to
apply an update to an adhoc-signed app, and it requires only that an update carry
the same certificate. Notarisation stays off, and builds are installed by direct
copy so nothing is quarantined. A publish refuses to proceed when the identity is
missing or the built bundle is adhoc.

Certificate setup and the failure modes around it are in `docs/desktop-packaging.md`.

## Backup

- `secrets.key` in the data directory is the key to `secrets.json`. The server makes it on first start and nothing needs setting; the two must travel together, so restore them as a pair (01-server.md § Settings).
- `~/.patch-server/data` is the server's only stateful directory — the registry, job definitions, run/webhook logs, pending queues and the broadcast log. Snapshot it off-host nightly (the reference deployment uses restic).
- Chat history and per-chat metadata live on each host, under that user's `~/.claude/projects/` and `~/.patch/` (`04-chats-and-folders.md` § History). Each host is backed up on its own; a server snapshot does not carry them.

## Cross-refs

- Server config knobs: `01-server.md`
- Host commands: `02-daemon.md`
