# QR pairing across surfaces

Patch surfaces (web, desktop, mobile, terminal CLI, voice device) link to an account via QR pairing — never password / magic link. A new surface displays a nonce, an already-linked surface scans it and signs a credential, the server relays the signed credential back to the new surface. See `spec/10-auth.md`.

## Bootstrap

The very first surface bootstraps differently — there's no prior linked surface to scan from. The flow:

1. User runs `patch auth init` from a terminal on the Hetzner box (or on this Mac, against the configured server URL).
2. CLI generates the Ed25519 keypair, writes the private key to `~/.patch/identity.key`, registers the public key with the server.
3. Subsequent surfaces scan a QR shown in the CLI / web app to receive a signed credential.

For tests, fixture keypairs live in `tests/fixtures/identities/` and bypass interactive setup.

## Linking a new surface in tests

```ts
import { mintPairingNonce, signCredential } from '@patch/wire/test/auth';

// On the "new" surface
const nonce = await client.requestPairingNonce(); // server replies with a nonce
// On a "linked" surface
const credential = signCredential(linkedKey, nonce, { surfaceKind: 'web', label: 'test browser' });
await linkedClient.submitPairing(credential);
// New surface receives the signed credential and connects with it
const newClient = await connectWithCredential(credential);
```

Both `linkedClient` and `newClient` are real WebSocket clients against the test compose stack; no mocking of the server.

## Per-surface helpers

- **Web** — open the web app at `/app/pair`, dump the QR's encoded payload via `mcp__chrome-devtools__evaluate_script` reading the canvas data attribute.
- **Desktop (Electron)** — same as web, since the QR view is part of the SPA.
- **Mobile** — `apps/mobile` exposes `__DEV__`-only deep link `patch://pair?nonce=<nonce>` for tests; `adb shell am start -d 'patch://pair?nonce=...'` short-circuits the camera scan.
- **Terminal CLI** — `patch auth pair --nonce <nonce>` skips the QR display and accepts the nonce directly.
- **Voice device** — initial pairing happens once via USB-flashed credentials. For tests, the mock harness reads its credential from a fixture file.

## Revocation

Any linked surface can revoke any other:

```bash
patch surfaces list
patch surfaces revoke <surfaceId>
```

Revocation tests assert:

- The revoked surface's WebSocket is closed by the server.
- A reconnect attempt from the revoked surface is rejected with `auth.revoked`.
- Revoking the host key effectively decommissions the install — server stops accepting host traffic.
