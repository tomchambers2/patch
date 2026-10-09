# `@patch/daemon`

The Patch host is the single background process that owns Claude Code SDK
sessions for one user on one Hetzner box. It maintains live `chat_state`,
streams SDK output as `@patch/wire` events, and exposes three control
surfaces:

| Surface             | Bind                                                                                  | Auth                                                                                      | Used by                                        |
| ------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Loopback HTTP (UDS) | `~/.patch/daemon.sock`                                                                | `Bearer <PATCH_DAEMON_LOCAL_KEY>` (same-host CLI)                                         | `patch list` / `patch stop`                    |
| Healthz (TCP)       | `:3001/healthz`                                                                       | none — public to the local network only                                                   | docker compose healthcheck                     |
| Server WS (TCP)     | `:3002/control` (HMAC-SHA256 over WS)                                                 | `PATCH_INTERNAL_TOKEN`                                                                    | `@patch/server` upstream link                  |
| Audio WSS (TCP)     | `ws://daemon:3003/audio/<sessionId>` inside the box; `wss://...` externally via Caddy | one-shot voice token (HMAC over `PATCH_INTERNAL_TOKEN`, 5-min expiry, JTI replay-guarded) | surface voice overlays + voice-device firmware |

See `spec/02-daemon.md` and `spec/03-wire-protocol.md` for the protocol
contract; the audio WSS frame catalogue lives in `@patch/wire/audio` (see
`spec/07-voice-app.md`).

## The installable artifact

The host ships as a signed, installable artifact per OS/arch — not a container
(`spec/02-daemon.md` § Installation, `spec/11-deployment.md` § Host
installation). Build them all with:

```sh
PATCH_BUILD_VENDOR=/path/to/vendor \
PATCH_ARTIFACT_SIGNING_KEY=/path/to/artifact-signing.key \
PATCH_CODESIGN_IDENTITY="Patch Self-Signed Test" \
pnpm build:daemon
```

Targets are **macOS arm64, Linux x64, Linux arm64**. macOS x64 is not a target:
`onnxruntime-node` ships no darwin-x64 binary and every artifact carries VAD.

`PATCH_BUILD_VENDOR` names a directory holding the third-party binaries a build
needs, which are deliberately not in the repo:

```
node/node-v<version>-<os>-<arch>/bin/node    pinned Node (major line from .nvmrc)
onnxruntime-node/package.json, dist/         the package's own JS
onnxruntime-node/<os>-<arch>/                the prebuilt addon + its shared library
models/silero_vad.onnx                       the VAD weights (~2 MB)
```

`PATCH_ARTIFACT_SIGNING_KEY` is the project's Ed25519 signing identity (a
base64url 32-byte seed). Every artifact gets a detached `.tar.gz.sig` over its
sha256 and the public half goes into `daemon-latest.json`; that is what the
self-update path verifies against. On macOS every Mach-O is additionally
codesigned with hardened runtime against `installer/daemon-entitlements.plist`
(override with `PATCH_CODESIGN_ENTITLEMENTS`) — **the entitlements are mandatory**
(`allow-jit`, `allow-unsigned-executable-memory`, `disable-library-validation`),
because a hardened Node without them passes `codesign --verify` and then dies at
startup with "Failed to reserve virtual memory for CodeRange".

Output (`dist/daemon/`, or `PATCH_BUILD_OUT`) is what the server publishes from
its downloads directory and serves at `/api/daemon/:name`:

```
patch-daemon-<version>-<os>-<arch>/     the artifact
patch-daemon-<version>-<os>-<arch>.tar.gz(.sig)
daemon-latest.json                      the manifest (version, sha256, signature, public key)
install.sh                              the curl | sh bootstrap
```

### Installing

Two routes, both running the same installer:

```sh
# 1. one shell command on any machine with a shell
curl -fsSL https://<server>/api/daemon/install.sh | sh -s -- --code <pairing code> \
    --internal-token <token>

# 2. from an unpacked artifact (what a surface runs)
./install --non-interactive --code <pairing code> --server <url> --internal-token <token>
```

The pairing code comes from an already-linked surface (Settings → Hosts → Add
host, or `patch hosts add`). The installer only ever redeems it; it mints
nothing. It states what the host will be able to do on the machine before it
registers anything, installs under the invoking user's own `~/.patch`, writes
the `patch-cli` skill into `~/.claude/skills/patch-cli/`, registers the service
(launchd on macOS, a systemd user unit on Linux, restart-on-failure +
start-at-boot, no working directory), then pairs and starts.

Exit codes: `64` bad usage, `65` wrong platform / incomplete artifact, `69`
the service manager refused, `70` no pairing code, `75` the code could not be
submitted (the service IS registered — re-run with a fresh code), `78` no HOME.

Re-running on a machine that is already registered re-uses the stored
`daemon.key` and the stored machine settings rather than creating a second
machine; a machine whose registration was revoked pairs again from scratch with
a fresh code.

On macOS the host runs through logout only when it can be installed as a
system launchd job running as that user, which needs root. Where that is not
available the installer registers an ordinary LaunchAgent in `gui/<uid>`, says
out loud that it will stop at logout, and prints the command that changes it.

## Voice infrastructure (group 13)

```
surface ──── POST /api/voice/token ──▶ patch server
            (JWT auth, returns one-shot token + sessionId)
        ◀── { token, sessionId, audioUrl }

surface ──── WSS /audio/<sessionId> ────▶ patch host
              audio.session_start (json, with token)
              audio.pcm16 (json) + binary PCM16 mic frame  ─▶ Whisper
                                                          ◀── audio.transcript_final
                                                              chat.input → SDK
                                                          ◀── audio.tts_chunk + binary PCM (Kokoro)
              audio.barge_in (when VAD fires during speaking)
              audio.session_end
```

### Env vars

| Var                         | Purpose                                                                                                | Default   |
| --------------------------- | ------------------------------------------------------------------------------------------------------ | --------- |
| `PATCH_DAEMON_AUDIO_PORT`   | TCP port for the audio WSS                                                                             | `3003`    |
| `PATCH_DAEMON_AUDIO_HOST`   | Bind host                                                                                              | `0.0.0.0` |
| `WHISPER_BACKEND`           | `groq` \| `local` \| `mock`                                                                            | `groq`    |
| `GROQ_API_KEY`              | Required when `WHISPER_BACKEND=groq` — **lazy-checked**: missing-key fails the first session, not boot | _unset_   |
| `WHISPER_LOCAL_SIDECAR_URL` | faster-whisper Python sidecar WS URL (when backend=local)                                              | _unset_   |
| `KOKORO_BACKEND`            | `real` \| `mock`                                                                                       | `real`    |
| `KOKORO_SIDECAR_URL`        | Kokoro Python sidecar WS URL (real backend)                                                            | _unset_   |
| `KOKORO_MODEL_PATH`         | Path to the kokoro-onnx model dir on disk                                                              | _unset_   |
| `PATCH_VOICE_MAX_SESSIONS`  | Concurrency cap (4 on Groq, 3 on local Whisper per spec/07)                                            | `4` / `3` |

### Sidecar lifecycle (Python)

`@patch/daemon` spawns two Python sidecars at runtime when the matching
backend is selected:

- **faster-whisper** (`WHISPER_BACKEND=local`) — model `medium.en`, served
  via WS. Spawn command: `uv run python -m patch_whisper_sidecar`. Host
  restarts on death.
- **Kokoro TTS** (`KOKORO_BACKEND=real`) — `uv run python -m patch_kokoro_sidecar`.
  Streams 24 kHz PCM16 mono. Host restarts on death.

Use `uv` (not `pip`) for reproducibility — both sidecars ship a
`pyproject.toml` with pinned wheels. The host container's `Dockerfile`
provisions `uv` and bootstraps the model files on first run; the model
artefacts (Silero VAD ONNX, Kokoro voices) cache to `/models` (volume).

### VAD

**Silero VAD via `onnxruntime-node` is mandatory** for the real audio path
(`createSileroVad`). The ONNX session is constructed when the host
spawns audio sessions; if `onnxruntime-node` isn't installed or the
model file at `SILERO_MODEL_PATH` is unreadable, the constructor throws
and audio sessions reject at start. Per the project's NO-FALLBACKS rule
there is no RMS / energy-threshold fallback — the host fails loudly
rather than degrading silently. Unit tests use `MockVad` (a deterministic
RMS-driven shim that exercises the state machine without pulling
onnxruntime into vitest).

KNOWN GAP (group 14 H3): the recurrent-state tensor names follow Silero
v5 (`state` / `stateN`); a v4 model file would throw at the first
`run()`. The wrapper is one-frame-behind on the prob output (each
`feed()` dispatches the inference asynchronously and uses the previous
frame's probability) — adequate for the 30 ms tick budget. Group 23
tightens this alongside the voice-device firmware.

### AEC choice

The host ships a **pure-TS NLMS canceller**
(`packages/daemon/src/audio/aec.ts`, `NlmsAec`) — ~12-18 dB attenuation
once converged (~250 ms). Chosen over WebRTC AEC3 (no maintained N-API
binding) and speexdsp (also a native build) for the v1 cut. The
voice-device's hardware AEC reference path (group 23) does most of the
work; the host-side filter is the second line of defence. Phone/web/
desktop surfaces set `surfaceHasAec: true` on `audio.session_start` and
the host switches to `PassThroughAec`.

AEC3 is deferred to a future revision if NLMS proves insufficient on
real rooms with the shipped voice device. The choice is isolated at
the `AecProcessor` interface so the swap is mechanical.

### Audio error codes

The host emits `audio.error { code, message, sessionId? }` over the WSS
on any session-level failure. Codes are defined in `@patch/wire/audio`
`AudioErrorCode`:

| Code                  | Meaning                                                                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `auth_failed`         | Token signature mismatch, missing/empty token, or token does not bind to the declared (accountId, surfaceId, sessionId).                                                                                     |
| `token_expired`       | Token's `exp` has passed (5-min TTL).                                                                                                                                                                        |
| `token_replayed`      | Token's JTI was already consumed by an earlier session.                                                                                                                                                      |
| `concurrency_cap`     | Voice-session concurrency cap reached (`PATCH_VOICE_MAX_SESSIONS`).                                                                                                                                          |
| `whisper_unavailable` | STT failed (Groq returned non-2xx, local sidecar dropped, etc).                                                                                                                                              |
| `kokoro_unavailable`  | TTS sidecar failed during `synthesize()`.                                                                                                                                                                    |
| `sdk_error`           | The Claude SDK turn failed AFTER the transcript had already been emitted. STT itself succeeded — distinguishing this from `whisper_unavailable` lets the surface route the user to retry vs. report a crash. |
| `invalid_frame`       | Wire-level: malformed JSON, wrong first frame, sessionId mismatch, odd-length binary PCM.                                                                                                                    |
| `session_not_found`   | (reserved) — not currently emitted.                                                                                                                                                                          |

### Composing the audio URL on the surface

`POST /api/voice/token` returns `{ token, sessionId, audioUrl, expiresAt }`
where `audioUrl` is a relative path (e.g. `/audio/abc123`). Surfaces
prepend the host's external WSS origin to compose the full URL — the
relative path keeps the server side free of environment-specific URL
construction.

```ts
// surface (web/desktop/mobile) — group 14 DX m3 example
const { token, sessionId, audioUrl } = await tokenRes.json();
const wsUrl = `${WSS_ORIGIN}${audioUrl}`; // e.g. wss://patch.example.com/audio/abc123
const sock = new WebSocket(wsUrl);
sock.onopen = () => {
  sock.send(
    JSON.stringify({
      type: 'audio.session_start',
      sessionId,
      accountId,
      surfaceId,
      surfaceKind: 'web',
      chatId,
      role: 'voice-call',
      token,
      surfaceHasAec: true,
    }),
  );
};
```

Note: `accountId` / `surfaceId` / `sessionId` on the `audio.session_start`
frame are CHECKED against the token claims (which are the source of
truth) but NOT trusted on their own — the surface-supplied values exist
for client-side debug only. A mismatch yields `audio.error { code:
'auth_failed' }`.

### Voice-token mint flow

Surfaces don't speak directly to the host's HMAC secret — they hit
`POST /api/voice/token` on the server (JWT-authed bearer = the surface's
EdDSA credential). The server signs a `<b64url(claims)>.<b64url(hmac)>`
token using the same `PATCH_INTERNAL_TOKEN` the host already shares,
binding (accountId, surfaceId, sessionId) for 5 minutes. The host
verifies the HMAC, enforces JTI one-shot consumption (in-memory replay
guard), and only then promotes the WS to `listening`.

## Public action interface

`Daemon` (in `src/chatRunner.ts`) exposes:

| Method                                                     | Purpose                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spawnChat({ folder, name?, prompt?, chatId?, localId? })` | Create a new chat. `folder` is a path on **the host** (Hetzner / host container), NOT the surface. Throws `FolderNotFoundError` if `existsSync(folder) && isDirectory` is false (NO FALLBACK). `chatId` is honoured if supplied (server pre-allocates the ULID); otherwise the host generates one. Idempotent on `localId`. |
| `sendInput({ chatId, message, localId, voicePrefix? })`    | Append a turn — idempotent on `(chatId, localId)`. Un-archives an archived chat before running the turn, regardless of origin. Resumes via stored `claudeSessionId` after restart.                                                                                                                                          |
| `stopChat(chatId)`                                         | Abort the in-flight `query()` and mark `idle`.                                                                                                                                                                                                                                                                              |
| `resumeChat(chatId)`                                       | Ensure chat is loaded into chat_state (hydrating from disk if needed). Un-archives. Does NOT auto-spawn the SDK — waits for next user input (per spec/04).                                                                                                                                                                  |
| `setPinned(chatId, pinned)`                                | Pin/unpin. Persists `pinned` + `pinnedAt`, emits `chat.state`.                                                                                                                                                                                                                                                              |
| `setArchived(chatId, archived)`                            | Archive/unarchive. Persists `status` + `archivedAt`, emits `chat.state`.                                                                                                                                                                                                                                                    |
| `replayChat(chatId, fromSeq, emitToSurface)`               | Read JSONL history and stream `chat.message` events with `seq > fromSeq` to a per-surface emitter (not fanout).                                                                                                                                                                                                             |
| `runArchiveSweep()`                                        | Auto-archive sweep: flips idle non-pinned chats older than 3h to `archived`. Started on construct when `startAutoArchiveSweep: true`.                                                                                                                                                                                       |
| `list()`                                                   | Snapshot of `chat_state`.                                                                                                                                                                                                                                                                                                   |
| `chatState`                                                | The `Map<chatId, ChatState>` itself (used by `patch_peek` and the control HTTP).                                                                                                                                                                                                                                            |

The server-daemon WS upstream link can call these on behalf of any surface
event it receives (group 7 wires the protocol mapping; group 5 only ships
the action layer).

## File layout (daemon-local)

```
~/.patch/
  daemon.sock              # UDS for control HTTP
  daemon.key               # signed daemon credential, mode 0600
  chats/
    <chatId>/
      meta.json            # { chatId, folder, name, claudeSessionId, nextSeq, … }
~/.claude/projects/<encoded-folder>/<sessionId>.jsonl
                           # Claude Code's native history — daemon reads, never writes
```

`nextSeq` is persisted with every emit (atomic write via temp+rename), so
`seq` is non-decreasing across host crashes.

## Server-daemon WS handshake

```
client → ws://daemon:3002/control     (TCP upgrade)
server (daemon) → { type: 'challenge', nonce: <hex> }
client (server) → { type: 'challenge_response', mac: HMAC-SHA256(token, nonce) }
server → { type: 'challenge_ok' }   on success
server → close 4401 'bad token'     on failure
```

After the handshake both ends speak `@patch/wire` JSON frames.
`buildChallengeResponse(token, nonce)` is exported for the server task to
implement the client side without re-deriving the construction.

## Environment

| Var                         | Required                    | Purpose                                                                                                                      |
| --------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `PATCH_INTERNAL_TOKEN`      | yes                         | Shared HMAC secret for the server-daemon WS link.                                                                            |
| `PATCH_DAEMON_LOCAL_KEY`    | yes                         | Bearer for the UDS HTTP `/chats*` endpoints.                                                                                 |
| `PATCH_DAEMON_SOCKET`       | no (`~/.patch/daemon.sock`) | UDS path.                                                                                                                    |
| `PATCH_HOME`                | no (`~/.patch`)             | Override daemon-local state root (test hook).                                                                                |
| `PATCH_DAEMON_HEALTHZ_PORT` | no (`3001`)                 | TCP /healthz port.                                                                                                           |
| `PATCH_DAEMON_HEALTHZ_HOST` | no (`0.0.0.0`)              | TCP /healthz host.                                                                                                           |
| `PATCH_DAEMON_WS_PORT`      | no (`3002`)                 | TCP server-daemon WS port.                                                                                                   |
| `PATCH_DAEMON_WS_HOST`      | no (`0.0.0.0`)              | TCP server-daemon WS host.                                                                                                   |
| `SDK_BACKEND`               | **yes** (no default)        | `mock` (unit tests / normal build rounds) or `real` (dev + integration round). No silent default — boot fails loud if unset. |
| `CLAUDE_CREDENTIALS_PATH`   | no                          | Override path to the Claude OAuth credentials file (`~/.claude/.credentials.json`; test/headless hook).                      |
| `CLAUDE_CODE_OAUTH_TOKEN`   | no                          | Explicit OAuth token (headless/CI); takes precedence over the file/Keychain.                                                 |
| `LOG_LEVEL`                 | no (`info`)                 | pino log level.                                                                                                              |

## Claude OAuth

The host never writes the Claude Code credential. It loads
`claudeAiOauth.accessToken` via `@patch/auth.loadClaudeOAuth()`, which resolves
`$CLAUDE_CODE_OAUTH_TOKEN` → `~/.claude/.credentials.json` → the macOS Keychain
(`Claude Code-credentials`), in that order. (It is NOT in `~/.claude.json`, which
holds only account metadata.) Under `SDK_BACKEND=real` the host passes the
resolved token to the SDK as `CLAUDE_CODE_OAUTH_TOKEN` and strips
`ANTHROPIC_API_KEY` — never an API key. If no credential resolves, the host
still boots `/healthz` + the WS link, but every `query()` is refused and the
host emits `daemon.unauthenticated` upstream so a surface can prompt the user
to run `claude login` on the host. (`SDK_BACKEND=mock` — unit-test / normal
build rounds only — skips the credential entirely and echoes deterministically;
it is never the default and dev/integration must run `SDK_BACKEND=real`.)

## MCP server (`patch-tools-server`)

A stdio MCP server is launched as a child process by the SDK on every
`query()` (per `spec/02-daemon.md`). It connects back to the host over
the UDS HTTP `/internal/*` endpoints — same-host, mode-0600 socket, no
auth (per spec/02 "Daemon, MCP child, and `claude` query all run as the
same user on the same host").

The bin entry is `dist/bin/patch-tools-server.js`. The SDK launches it
with `PATCH_CHAT_ID` and `PATCH_DAEMON_SOCKET` baked into env so the
child knows its identity at boot — no header parsing per spec.

`node patch-tools-server.js --probe` lists registered tools and exits
without contacting the host — used by the docker compose smoke check.

### Cross-chat tool catalogue (group 9 task A)

| MCP tool            | UDS endpoint                               | Purpose                                                     |
| ------------------- | ------------------------------------------ | ----------------------------------------------------------- | ------------------------------------------------------------ |
| `patch_peek`        | `GET  /internal/peek/:id`                  | Full chat_state snapshot.                                   |
| `patch_send_to`     | `POST /internal/send-to`                   | Deliver a user-turn message into another chat (idempotent). |
| `patch_spawn`       | `POST /internal/spawn`                     | Create a new chat in `folder`. Returns `{ chatId }`.        |
| `patch_history`     | `GET  /internal/history/:id?fromSeq&limit` | Paginated history. `limit` defaults 50, max 200.            |
| `patch_list_chats`  | `GET /internal/chats?archived=only         | include`                                                    | Chat listing matching server REST `/api/chats` filter rules. |
| `patch_stop`        | `POST /internal/stop/:id`                  | Stop a chat (aborts the SDK query). Idempotent.             |
| `patch_job_list`    | `GET  /internal/jobs`                      | List user jobs.                                             |
| `patch_job_create`  | `POST /internal/jobs`                      | Create a job (cron/webhook/todoist + spawn/message).        |
| `patch_job_update`  | `PATCH /internal/jobs/:id`                 | Partial update.                                             |
| `patch_job_delete`  | `DELETE /internal/jobs/:id`                | Delete a job.                                               |
| `patch_job_enable`  | `POST /internal/jobs/:id/enable`           | Re-enable a paused job.                                     |
| `patch_job_disable` | `POST /internal/jobs/:id/disable`          | Pause a job without deleting it.                            |

**Rate limits.** `patch_send_to` / `patch_spawn` / `patch_stop` /
`patch_notify` / `patch_call` are sliding-window rate-limited at 60 calls
/ 60s per `callerChatId` (the identity baked into the MCP child's
`PATCH_CHAT_ID`). Read-only tools (`patch_peek`, `patch_history`,
`patch_list_chats`, `patch_job_list`) are not rate-limited.

`patch_call` additionally has a per-chat concurrency note (group 12 m4): a
single chat can accumulate concurrent calls until they resolve — no in-process
lock today, but the rate limit (60/min) caps the worst case. If multi-call
fan-out becomes a problem, add a per-`callerChatId` "active call" lock here.

**Validation.** Tool args are zod-validated at the MCP boundary AND the
host UDS endpoint validates again — defence in depth. NO FALLBACKS:
invalid input returns 400, missing chat 404, missing job 404.

**Audit.** Each cross-chat tool call is logged with structured fields
`{tool, callerChatId?, targetChatId?, durationMs, ok, err?}`. When a
caller is identifiable, `patch.send_to` / `patch.spawn` / `patch.stop`
events are emitted upstream over the server WS for observability.

### Jobs interface

`packages/daemon/src/jobs-interface.ts` defines the `JobsInterface`
contract the cross-chat tools forward into. The host constructs a
`MemoryJobsStore` at boot today; group 9 task B replaces it with the
server-backed file store at the marked future-wiring line in
`src/index.ts`.

## Testing

Unit tests (`packages/daemon/test/`) cover:

- `chat_state` hydration from disk
- atomic `meta.json` write + non-decreasing `nextSeq`
- JSONL → wire history reader with `fromSeq` filter
- HMAC handshake: valid / wrong-token / malformed / missing-mac
- SDK lifecycle via mock backend (assistant / tool / result / abort)
- `patch_peek` round-trip over UDS
- daemon.key written atomically with mode 0600
- OAuth bootstrap typed errors
- group 7 chat lifecycle: ULID allocation, server-allocated chatId, spawn-localId
  dedupe, pin / unpin / archive / unarchive, auto-archive sweep, resume after
  restart (claudeSessionId hydrate), replay from JSONL.

## Spawn idempotency keys

`chat.spawn_request.localId` and `chat.input.localId` live in **separate
dedupe spaces**. The server keys them as:

| Wire field                   | Dedupe key                      |
| ---------------------------- | ------------------------------- |
| `chat.spawn_request.localId` | `(accountId, 'spawn', localId)` |
| `chat.input.localId`         | `(accountId, chatId, localId)`  |

A surface can therefore reuse the same string across spawn vs input
without collision: at spawn time there is no chatId yet, so the dedupe
namespace is keyed on the literal `'spawn'` placeholder.

## chat.error envelope

The host emits `chat.error { chatId, error: { code, message }, seq }`
upstream for every failed action. Codes are stable (`folder_not_found`,
`chat_not_found`, `sdk_error`, `claude_session_invalid`,
`claude_oauth_missing`). The server fans `chat.error` out to every
account surface (state-level), and the REST `POST /api/chats` waiter
pairs `chat.error` with the synchronously-allocated chatId so a fast
spawn-time failure becomes a 400 instead of a hung 202.

## Auto-archive sweep

Per spec/04: chats with no activity for 3h are auto-archived (status flips to
`archived`, `chat.state` emitted). Pinned chats are exempt. The sweep runs every
60s when `startAutoArchiveSweep: true` is passed to the `Daemon` constructor;
unit tests opt out and call `runArchiveSweep()` directly with a controlled clock.

`SDK_BACKEND` has no default and must be set explicitly. The real SDK is loaded
only when `SDK_BACKEND=real`; `SDK_BACKEND=mock` (unit tests / normal build
rounds) keeps those tests free of the `@anthropic-ai/claude-agent-sdk` native
binary install. Dev and the integration round run `SDK_BACKEND=real`.

## Group 11 — notifications, special threads

Two new MCP tools registered alongside the cross-chat catalogue:

| Tool           | Behaviour                                                                                                                                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `patch_notify` | `{ channel, message, priority?, deviceId? }` — channel is `push`/`desktop`/`speakers`. Host emits a `notify` wire event upstream; server fans out. `priority='urgent'` overrides phone-presence suppression.   |
| `patch_call`   | `{ chatId?, message? }` — emits `patch.call` upstream; server orchestrates concurrent push (urgent) + desktop ring; first-accept wins via `chat.call_response`; 30s timeout falls back to a push notification. |

Both tools wrap dedicated UDS endpoints (`/internal/notify`, `/internal/call`).

### Special threads (spec/06)

On boot the host ensures two folders + chat_state entries exist:

- `<daemon-cwd>/.patch/threads/manager/CLAUDE.md` (user-editable; pinned)
- `<daemon-cwd>/.patch/threads/speakers/CLAUDE.md`

An empty `CLAUDE.md` is created at first boot (only when missing) and is
**never overwritten** afterwards — patch defines role via the user's own
`CLAUDE.md` content, not a runtime system prompt or shipped default. The
user populates it; subsequent host restarts leave their edits intact.

### Broadcast sidecar

When a chat fires `patch_notify(channel='speakers')`, the host
appends a JSONL line to `<thread folder>/broadcasts.jsonl`. On the **next user
reply** to that thread, the host prepends a `<system-reminder>` block listing
recent broadcasts (relative timestamps) before invoking the SDK. After the
agent commits its response, the sidecar is flushed.
