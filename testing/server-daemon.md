# Server + host test harness

The server and host run together in `docker-compose.test.yml`, mirroring production but with:

- No public TLS (Caddy listens HTTP-only at `localhost:3000`)
- A scratch `/data` volume reset between runs
- Whisper backend forced to `groq` (with a fixture-injected key) — local Whisper takes too long to spin up for unit tests
- A scriptable Claude Code SDK shim (`SDK_BACKEND=mock` env var) that replays canned event streams instead of calling Claude. Real-Claude tests run with `SDK_BACKEND=real` and pull `CLAUDE_OAUTH_TOKEN` from the secrets file.

## Bring it up

```bash
cd projects/patch
docker compose -f docker-compose.test.yml up -d --build
docker compose -f docker-compose.test.yml ps
```

Wait for healthchecks:

```bash
until curl -sf http://localhost:3000/api/healthz >/dev/null; do sleep 0.5; done
until curl -sf http://localhost:3000/api/daemon/healthz >/dev/null; do sleep 0.5; done
```

## Reset between runs

```bash
docker compose -f docker-compose.test.yml down -v
```

`-v` wipes the `/data` volume so registry, jobs, pending, and run logs start clean.

## Vitest

Per-package suites live in `packages/<name>/test/`. Run a focused subset:

```bash
pnpm --filter @patch/server test --watch <pattern>
pnpm --filter @patch/daemon test --watch <pattern>
pnpm --filter @patch/wire test --watch
```

Cross-component tests (server + host together) live in `tests/integration/` at the repo root and run against the compose stack.

## Driving WebSocket events

Use `packages/wire/test/client.ts` — a tiny test client that handshakes, replays missed events on reconnect, and exposes a typed event emitter. Use it in integration tests instead of a raw `ws` client.

## Fixtures

- **Audio**: `tests/fixtures/audio/` — short PCM clips with known transcripts.
- **SDK transcripts**: `tests/fixtures/sdk-transcripts/` — Claude Code event streams replayed by the mock SDK shim.
- **Webhook payloads**: `tests/fixtures/webhooks/` — GitHub, Stripe, Todoist. Pre-signed where signature verification matters.
- **Cron**: tests use `node-cron`'s `tz` parameter and override `Date.now()` via vitest fake timers — no waiting on real wall-clock.

## Live-stack verification recipes

The behaviours below need a _running_ server+host with a real account. The
authoritative, no-mock-double versions live in
`packages/server/test/integration-lifecycle.test.ts` (they wire the real
`Daemon` class to the real server over a real `/ws` socket with a bootstrapped
registry). Run them with:

```bash
pnpm --filter @patch/server test integration-lifecycle
```

When poking a live stack by hand, the gotchas the harness encodes:

### 1. Seed an account before the host link will come up

A fresh `~/.patch/server-data/registry.json` has `{account:null,daemonKey:null}`.
The host WS closes `4401 'no account'` until an account exists. In tests:
`Registry.load(dataDir).bootstrapAccount(userPublicKey)`. In production the
account is created by QR pairing (`testing/qr-pairing.md`). A stale
`~/.patch/daemon.key` whose `sub` is absent from the registry will _always_
4401 — delete it and re-pair.

### 2. Surface WS happy-path: the `hello` frame shape

The first frame a surface sends on `/ws` is a `hello` event. Its shape is the
`HelloEvent` schema (`packages/wire/src/events.ts`), NOT an ad-hoc envelope:

```jsonc
{ "type": "hello", "clientType": "web", "clientVersion": "1.0.0", "auth": "<surface JWT>" }
```

Omitting `clientType`/`clientVersion`, or wrapping it in a different envelope,
closes the socket with `4400 'malformed frame'`. Always drive `/ws` with
`WireTestClient` from `@patch/wire/test-client` — it builds the correct hello
and handles replay/reconnect. A valid hello is accepted and the socket kept
alive (`integration-lifecycle.test.ts` asserts this via `daemon.online`).

### 3. Spawn-time errors surface as `chat.error` (out-of-band seq)

A `chat.spawn_request` for a non-existent folder emits a `chat.error`
`{code:'folder_not_found'}` with `seq = OUT_OF_BAND_SEQ` (`-1`) — the chat was
never registered, so there is no per-chat seq. The wire `chat.error.seq` schema
admits this sentinel; it is the only event whose seq may be negative. The
`integration-lifecycle.test.ts` "spawn-time folder_not_found" case proves it
round-trips to the surface (it used to be silently dropped on decode).

### 4. `chat.replay` works under `SDK_BACKEND=mock`

Replay serves from the host's in-memory `recentEvents` tail merged with the
persisted JSONL — so it works even though the mock backend never writes a
Claude Code JSONL. A fresh surface (seen nothing) replays from `fromSeq = -1`
to include `seq 0`; `replayFromLastSeen` does this automatically. See the
"resyncs from the in-memory tail under the mock SDK backend" case.

## Latency budgets

`pnpm --filter @patch/daemon test:latency` measures end-to-end voice round-trip against a fixture clip. Thresholds (CI runner, `WHISPER_BACKEND=groq`):

- STT: < 800 ms
- Kokoro first audio frame: < 600 ms
- WSS round-trip (loopback): < 50 ms

Any test that exceeds the threshold fails — there's no soft warning. Per portfolio convention: no fallbacks, no fakes.
