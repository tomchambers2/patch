# @patch/wire

Shared wire-protocol types, zod schemas, and codec for Patch. JSON over WebSocket
text frames. Zero runtime deps beyond `zod`.

> **Live server status.** The real `/ws` relay (chat fan-out, replay, session
> state) is implemented in `@patch/server` (`ws-hub.ts`). The early group-1
> echo-only stub is gone.

> **Health check.** `GET /api/healthz` returns `HealthzResponse`
> (`{ status, version, timestamp }`). The wire package owns the type so
> consumers can assert against it without depending on the server.

The `./test-client` subpath (`@patch/wire/test-client`) requires `ws` to be
available at runtime. `ws` is declared as an _optional peer dependency_ — if
your package uses `WireTestClient`, add `ws` to its own `dependencies`.

Source of truth: [`spec/03-wire-protocol.md`](../../spec/03-wire-protocol.md).
Auth event shapes follow [`spec/10-auth.md`](../../spec/10-auth.md).
Per [`spec/principles.md`](../../spec/principles.md): **no fallbacks** — `decode()`
throws `WireDecodeError` on any malformed frame.

## Usage

```ts
import { encode, decode, WireDecodeError, type WireEvent } from '@patch/wire';

const event: WireEvent = { type: 'surface.heartbeat' };
ws.send(encode(event));

ws.on('message', (raw) => {
  try {
    const evt = decode(raw);
    // narrowed via `evt.type`
  } catch (e) {
    if (e instanceof WireDecodeError) {
      // log + close socket; do NOT fall back
    }
    throw e;
  }
});
```

For tests, `@patch/wire/test-client` exports `WireTestClient` — a small typed
client that handles the `hello` handshake, buffers per-chat `seq`, and provides
`waitFor(eventType)`.

## Idempotency and replay

- Every chat-scoped event carries a per-chat monotonic `seq`.
- `chat.input` requires a client-generated `localId` (UUID). The server dedupes
  on `(chatId, localId)`.
- `chat.replay { chatId, fromSeq }` asks the host for every event with
  `seq > fromSeq`, in order.

## Event catalogue

All schemas are exported from `src/events.ts`. The discriminated union is
exported as both the value `WireEvent` (zod schema) and the type `WireEvent`.

### Session events (server / host → surfaces)

| `type`                    | Source      | Fields (in addition to `type`)                            |
| ------------------------- | ----------- | --------------------------------------------------------- |
| `chat.spawned`            | `events.ts` | `chatId, folder, parentChatId?`                           |
| `chat.message`            | `events.ts` | `chatId, role, content, seq`                              |
| `chat.tool_call`          | `events.ts` | `chatId, tool, args, callId, seq`                         |
| `chat.tool_result`        | `events.ts` | `chatId, tool, callId, result, isError?, seq`             |
| `chat.permission_request` | `events.ts` | `chatId, requestId, request{tool,args,description?}, seq` |
| `chat.state`              | `events.ts` | `chatId, activity, lastUpdated`                           |
| `chat.stopped`            | `events.ts` | `chatId, reason`                                          |
| `chat.error`              | `events.ts` | `chatId, error, seq`                                      |
| `daemon.online`           | `events.ts` | —                                                         |
| `daemon.offline`          | `events.ts` | `reason?`                                                 |
| `daemon.unauthenticated`  | `events.ts` | `reason`                                                  |

### Surface events (surface → server → host)

| `type`                     | Source      | Fields                           |
| -------------------------- | ----------- | -------------------------------- |
| `chat.input`               | `events.ts` | `chatId, message, localId`       |
| `chat.permission_response` | `events.ts` | `requestId, approve`             |
| `chat.spawn_request`       | `events.ts` | `folder, prompt?, parentChatId?` |
| `chat.stop_request`        | `events.ts` | `chatId`                         |
| `chat.resume_request`      | `events.ts` | `chatId`                         |
| `chat.focus_change`        | `events.ts` | `chatId`                         |
| `file.write`               | `events.ts` | `chatId, path, content`          |
| `surface.heartbeat`        | `events.ts` | —                                |
| `surface.foregrounded`     | `events.ts` | —                                |
| `surface.backgrounded`     | `events.ts` | —                                |

### Cross-chat tools (in-daemon, persisted for audit)

| `type`                | Source      | Fields                                |
| --------------------- | ----------- | ------------------------------------- |
| `patch.peek.request`  | `events.ts` | `sourceChatId, targetChatId`          |
| `patch.peek.response` | `events.ts` | `sourceChatId, targetChatId, state`   |
| `patch.send_to`       | `events.ts` | `sourceChatId, targetChatId, message` |
| `patch.spawn`         | `events.ts` | `sourceChatId, folder, prompt`        |

### Notifications

| `type`   | Source      | Fields                                           |
| -------- | ----------- | ------------------------------------------------ |
| `notify` | `events.ts` | `chatId, channel, message, priority?, deviceId?` |

`channel ∈ push | desktop | speakers`. `deviceId` only meaningful
for `speakers` (see `spec/09-notifications.md`).

### Job-trigger events

No dedicated event — the server emits regular surface-style actions
(`chat.spawn_request`, `chat.input`, `notify`) when a cron / webhook /
Todoist trigger fires. The host doesn't distinguish trigger-driven
events from user-driven ones (`spec/03-wire-protocol.md` § _Job-trigger events_).

### Control

| `type`        | Source      | Fields                             |
| ------------- | ----------- | ---------------------------------- |
| `hello`       | `events.ts` | `clientType, clientVersion, auth?` |
| `ack`         | `events.ts` | `chatId?, seq`                     |
| `chat.replay` | `events.ts` | `chatId, fromSeq`                  |

### Auth

| `type`                      | Source      | Fields                                |
| --------------------------- | ----------- | ------------------------------------- |
| `pairing.nonce`             | `events.ts` | `nonce, surfacePublicKey, expiresAt`  |
| `pairing.signed_credential` | `events.ts` | `nonce, surfacePublicKey, credential` |
| `auth.revoked`              | `events.ts` | `reason`                              |

Group 3 task B implements the crypto + business logic; this package owns
only the on-the-wire shapes.

## Tests

```sh
pnpm --filter @patch/wire typecheck
pnpm --filter @patch/wire lint
pnpm --filter @patch/wire test
```

The test suite round-trips every event in `EVENT_SCHEMAS`, asserts rejection
on every required-field omission and on unknown event types, and exercises
`WireTestClient` against an in-process `ws` server fixture.
