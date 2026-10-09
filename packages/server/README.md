# @patch/server

Patch server — Fastify relay, account registry, presence tracker, and WebSocket
hub. Runs once on Hetzner; the only component that's internet-reachable.

The server is a **dumb pipe + auth gate**: it authenticates surfaces, fans
events between them and the host, and persists the singleton account +
surface registry. SDK lifecycle, chat history, and chat_state live in
`@patch/daemon`.

## Routes

### Health

- `GET /api/healthz` → `{ ok, version, gitSha }`
- `GET /api/daemon/healthz` → `{ ok: true }` (200) when the host WS is connected, else `{ ok: false, reason }` (503)

### WebSocket hub

- `GET /ws` (websocket) — surface relay
  - First inbound frame must be a `hello { auth: <EdDSA-JWT> }` within 5s
  - Auth failure → close 4401 (with an `auth.revoked` event)
  - Hello timeout → close 4408
  - Malformed frame → close 4400
  - Subsequent frames are decoded with `@patch/wire` and routed to the
    host; daemon-emitted events are fanned out to subscribed surfaces.

### Chat lifecycle (REST)

- `POST /api/chats` `{ folder, prompt?, name?, parentChatId?, localId? }`
  (authed) — server allocates a ULID `chatId`, forwards a synthetic
  `chat.spawn_request` to the host over the daemon-link. The handler
  then waits up to 5s for either:
  - a host `chat.error { chatId }` (returns
    `400 { error: <code>, message, chatId }` synchronously — common
    `code` values: `folder_not_found`, `claude_oauth_missing`,
    `sdk_error`); or
  - a host `chat.spawned { chatId }` (returns
    `202 { chatId, folder, status: 'pending' }` immediately).
    If neither arrives inside the window we still return 202 — the spawn
    is genuinely pending and the eventual outcome arrives over WS.
    **Folder semantics**: `folder` is a path on the **host** (Hetzner
    / host container), not the surface. The host checks
    `existsSync(folder) && isDirectory` and emits a `chat.error
{ code: 'folder_not_found' }` if not.
- `GET /api/chats?archived=<only|include>` (authed) — list chats from the
  in-memory chat registry (populated by host `chat.spawned` + `chat.state`
  events). Default omitted = active only. `archived=only` returns only
  archived; `archived=include` returns active + archived. Anything else
  (including the legacy `archived=true` / `archived=all`) → 400.
  Sorted: pinned first (most-recent-pinned at top by `pinnedAt` desc),
  then non-pinned by `lastUpdated` desc.
- `GET /api/chats/:id` (authed) — single chat summary; 404 if unknown.
- `GET /api/chats/:id/history?fromSeq=N` (authed) — **501 Not Implemented**.
  Realtime history streaming is via WebSocket `chat.replay` (per-surface).
  Dedicated REST endpoint deferred to a later group (CLI / web SPA
  cold-start).

### Two ways to spawn a chat

Both go to the same host `spawnChat` action:

| Path                    | When                                                                                                                                            | Notes                                                                                                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| REST `POST /api/chats`  | HTTP-only surfaces / cold-start (CLI list, mobile pull-to-refresh, web first-load). The server allocates the ULID and returns it synchronously. | Folds the common fast-fail (`folder_not_found`) into a synchronous 400 inside a 5s window; otherwise 202 + WS `chat.spawned` arrives later. The spawning surface is NOT auto-subscribed. |
| WS `chat.spawn_request` | Surfaces with a live WebSocket — the spawning surface is auto-subscribed to detail events for the new chatId.                                   | Server still allocates the ULID server-side and stamps it onto the upstream frame.                                                                                                       |

### Auth + pairing (REST)

- `POST /api/auth/account` `{ userPublicKey }` — bootstrap singleton account
- `POST /api/auth/pair/start` `{ surfacePublicKey }` → `pairing.nonce` event
- `POST /api/auth/pair/complete` `<pairing.signed_credential payload>` →
  `{ credential }`. Stores the new surface in the registry.
- `POST /api/auth/revoke` `{ id }` (authed) — revoke a surfaceId or host id
- `GET /api/auth/me` (authed) — caller's account + surface info
- `GET /api/presence` (authed) — snapshot of presence records

Auth = `Authorization: Bearer <EdDSA-JWT>`. Verified by `@patch/auth.verifySurfaceCredential`
against the registry's user public key + revocation list.

### Stubs (filled in later groups)

- `POST /api/webhooks/:jobId` → 503 (group 9)
- `node-cron` scheduler — (group 9)
- Expo push — (group 11)

### SPA

- `GET /` → 302 `/app/`
- `GET /app/*` — built web SPA (resolved from `PATCH_WEB_DIST` or sibling
  `packages/web/dist`)

## Environment variables

| Name                              | Required            | Purpose                                                                |
| --------------------------------- | ------------------- | ---------------------------------------------------------------------- |
| `PORT`                            | default `3000`      | HTTP listen port                                                       |
| `HOST`                            | default `0.0.0.0`   | HTTP listen host                                                       |
| `PATCH_DATA_DIR`                  | **required (prod)** | Directory containing `registry.json`. Crashes if env set + dir absent. |
| `PATCH_INTERNAL_TOKEN`            | **required (prod)** | HMAC secret for voice session tokens (spec/13), ≥16 chars.             |
| `LOG_LEVEL`                       | default `info`      | pino level.                                                            |
| `PATCH_WEB_DIST`                  | optional            | Override web SPA build directory.                                      |
| `PATCH_VERSION` / `PATCH_GIT_SHA` | required (prod)     | Surfaced via `/api/healthz`.                                           |

NO FALLBACKS: missing required env in production crashes at boot.

## Host link convention (inbound)

Per spec/10 the host authenticates INTO the server: it dials `/ws` and
presents its EdDSA-JWT `daemonKey` in the `hello` frame (`clientType:'daemon'`),
exactly like a surface. The server no longer dials out to the host. The
`InboundDaemonLink` (`src/daemon-link.ts`) owns the single live host socket
once the WS hello gate hands it over; it presents the same `DaemonLink`
interface (`send`/`onEvent`/`onStatus`/`status`/`close`) the rest of the server
consumes, so surface fan-out is unchanged.

Host registration is a QR flow over three REST endpoints —
`POST /api/auth/daemon/register/start` → an already-linked surface signs a
daemonKey → `POST /api/auth/daemon/register/complete` → the host long-polls
`GET /api/auth/daemon/register/await?nonce=…` to collect the credential, then
authenticates on `/ws` with it.

The on-the-wire protocol is exactly `@patch/wire` events, encoded as JSON-text
frames — same codec as the surface ↔ server link, no extra envelope. Server
forwards surface events upstream; host emits chat events downstream which
the server fans out by chat-interest.

For tests, `InProcessDaemonLink` from `src/daemon-link.ts` is dropped in
where the real link would go, so integration tests can drive both sides
without a real host process.

## Persistence

`registry.json` lives at `<PATCH_DATA_DIR>/registry.json`. Atomic writes
(temp → fsync → rename). Schema validated by zod on load — a malformed
file crashes the server (NO FALLBACK).

The `Registry` class implements `RevocationStoreInterface` from
`@patch/auth` and is the single source of truth for "who can connect".

## Logging

pino structured JSON. Every chat-scoped log line includes `accountId`,
`surfaceId`, and (where relevant) `chatId`. Components are tagged with
`component=ws-hub`, `component=daemon-link`, `component=auth-routes`.

## Tests

- `packages/server/test/config.test.ts` — env validation (crashes on missing/bad)
- `packages/server/test/registry.test.ts` — atomic write, persistence, revocation
- `packages/server/test/presence.test.ts` — heartbeat, stale sweep
- `packages/server/test/dedupe.test.ts` — sliding-window input dedupe
- `packages/server/test/auth-routes.test.ts` — pairing REST round-trip + tampered nonce
- `packages/server/test/ws-hub.test.ts` — hello auth, replay, host online/offline, malformed-frame close
- `packages/server/test/ws-hub-focus.test.ts` — per-chat subscription routing via `chat.focus_change`
- `packages/server/test/chat-routes.test.ts` — REST `POST/GET /api/chats`
- `packages/server/test/integration-lifecycle.test.ts` — server+host end-to-end (spawn → message → pin → archive → resume → replay)
- `packages/server/test/healthz.test.ts` — health endpoints

## Per-chat subscription routing (group 7)

By default, daemon-emitted _state-level_ events (`chat.spawned`,
`chat.state`, `chat.stopped`, `chat.error`) fan out to every authed
surface on the account — these drive the sidebar.

_Detail-level_ events (`chat.message`, `chat.tool_call`,
`chat.tool_result`, `chat.permission_request`) are gated by an explicit
subscription. The model is **additive**: a surface emits
`chat.focus_change { chatId }` to add the chatId to its watched set
(repeated calls accumulate watched chats); `chat.focus_change
{ chatId: null }` clears the entire set. `chat.input` and `chat.replay`
implicitly add the targeted chatId to the watched set. The wire name
`focus_change` is slightly off (it's effectively _subscribe_) — kept for
backwards compatibility, defer renaming.

`chat.replay` is per-surface: the server tags the upstream
`chat.replay { chatId, fromSeq, forSurfaceId }` so the host can route
the replayed events back through `forSurfaceId` to a single surface
rather than fanning out. `forSurfaceId` is a **server-internal** routing
tag — surfaces never set it.

## Pinned + archived semantics

A chat may be both `pinned: true` and `status: 'archived'`. This represents
a user who explicitly archived a chat they had also pinned (perhaps to
revisit later). It is allowed:

- **Auto-archive sweep** skips pinned chats entirely.
- **Manual archive** (`chat.archive_request`) does NOT silently unpin —
  the user keeps the pin, but the chat lives in the archived bucket
  until manually unarchived (e.g. via resume on next input).

## Chat error codes

`chat.error.error` is `{ code, message }`. Stable codes:

| Code                     | Meaning                                                         |
| ------------------------ | --------------------------------------------------------------- |
| `folder_not_found`       | Host failed `existsSync(folder)` at spawn time.                 |
| `chat_not_found`         | Op (input/pin/archive/stop) targeted an unknown chatId.         |
| `sdk_error`              | Generic Claude Code SDK failure during a query run.             |
| `claude_session_invalid` | Resumed `claudeSessionId` is missing/expired (spec/04 line 46). |
| `claude_oauth_missing`   | OAuth not loaded — the host can't run queries until logged in.  |

## Jobs system (group 9 task B)

Jobs are persistent automations: `trigger + filter + action`. They survive
sessions, host restarts, and arbitrary time. Spec source-of-truth:
`spec/08-triggers-and-jobs.md`.

### Storage

- File-backed at `<dataDir>/jobs/<id>.json`. Atomic writes (temp + fsync +
  rename), zod-validated on load.
- Watched via `chokidar`: external edits (CLI, version-controlled job
  definitions, the cross-chat tool) are picked up live.
- Per-job logs:
  - `<dataDir>/runs/<jobId>.jsonl` — every fire (ok / filter-rejected /
    filter-error / dispatch-error / buffered).
  - `<dataDir>/webhooks/<jobId>.jsonl` — every inbound webhook hit (sig
    OK/FAIL, filter pass/reject/error).

### Trigger types

| Type      | Wire-up                                                                                       |
| --------- | --------------------------------------------------------------------------------------------- |
| `cron`    | UTC, 5-field. Registered with `node-cron` on boot + on store change.                          |
| `webhook` | `POST /api/webhooks/:jobId`. Schemes: `none`, `hmac-sha256`, `github`, `stripe`. Timing-safe. |
| `todoist` | `POST /api/webhooks/todoist/:jobId`. Verifies `X-Todoist-Hmac-SHA256` (base64).               |

### Filter

Optional `JSONata` expression evaluated on the trigger payload. Bad
JSONata → fail-closed (logged, skipped, NEVER silently passed). NULL
filter → always pass.

### Action

Two actions: `spawn` (new chat in `folder`) or `message` (existing
`chatId`). Carries either `prompt` (mustache-substituted with the
payload) or `skill` (rendered as `/<skill>\n\n<json-payload>` per
spec/08).

When the host is offline the action is buffered to
`<dataDir>/pending/<jobId>-<fireId>.jsonl` and flushed in createdAt
order on `daemon.online`. Cap: 100 per job; oldest dropped with WARN
on overflow.

### REST CRUD

All authed (`Authorization: Bearer <surface-jwt>`), rate-limited at
30/min per IP per route.

- `GET /api/jobs` → `{ jobs: Job[] }`
- `GET /api/jobs/:id` → `Job`
- `POST /api/jobs { name, trigger, action, filter? }` → `201 Job`
- `PATCH /api/jobs/:id { ...partial }` → `200 Job`
- `DELETE /api/jobs/:id` → `204`
- `POST /api/jobs/:id/enable` / `/disable` → `200 Job`

### Cross-chat tool integration (task A)

Job DATA lives on the server (persisted under `<dataDir>/jobs/`). The
daemon's `patch_job_*` MCP tools forward over the existing daemon-link
to this server's `JobsInterface` — there is no separate host-side
copy. The interface contract is in `src/jobs/types.ts` and is the
canonical export for both consumers.

Run: `pnpm --filter @patch/server test`

## Group 11 — notification routing, special-thread ingress

Routing happens server-side: the host emits `notify` and `patch.call`
wire events upstream, the server fans out per channel.

### Channels

| Channel    | Backend                                                                                   | Behaviour                                                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `push`     | Expo push API (`https://exp.host/--/api/v2/push/send`, no server credential)              | Suppressed if any surface heartbeat in the last 30s, **unless** `priority='urgent'`. Failures → `<dataDir>/undelivered.jsonl`. |
| `desktop`  | `notify` wire event forwarded to all connected desktop surfaces                           | Always fires when a desktop is connected.                                                                                      |
| `speakers` | `notify` wire event forwarded to voice-device surfaces (specific `deviceId` or broadcast) | Surface-side TTS / firmware handles playback.                                                                                  |

NO FALLBACK on `push` either: invoking the channel without a configured
backend throws.

### `patch_call`

Concurrent push (`priority='urgent'`, `kind='call'`) + desktop notify +
`chat.call_request` fanned out to every connected surface. Surfaces reply
with `chat.call_response { callId, response: 'accept' | 'decline' }`. First
`accept` wins → server emits `chat.call_winner { callId, acceptedSurfaceId }`
to all surfaces (others stop ringing). 30s timeout → `chat.call_timeout`
plus a fallback push.

### Special-thread ingress

- **Voice-device transcripts**: hook `routeVoiceDeviceTranscript({ deviceId,
transcript })` (group 23 will own the WSS) → `chat.input` on
  `thread_speakers` with `source: { kind: 'voice-device', deviceId }`.

### Reply routing

When the host emits a `chat.message` (assistant role) on
`thread_speakers` with a pending source, the server's
ReplyRouter forwards back to the originating channel:

- Voice device: `notify { channel: 'speakers', deviceId: source.deviceId }`

Sources are consumed on first assistant reply.

### REST routes (auth)

- `POST /api/auth/push/register { token }` — JWT-authed; binds an Expo
  push token to the calling surface.
