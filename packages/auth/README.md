# @patch/auth

Auth primitives for Patch. Owns the crypto + JWT shapes consumed by the
server, host, and surfaces. Pure library — no I/O beyond the read-only
Claude OAuth loader. Wire-transport agnostic.

See `spec/10-auth.md` for the canonical model.

## Trust model

| Actor                     | Trusted?  | How trust is established                                                                             | How revoked                                                              |
| ------------------------- | --------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| User (Ed25519 master key) | Trusted   | First surface generates the keypair; public key IS the account ID; private key never leaves primary. | Out of scope — equivalent to losing the account.                         |
| Primary surface           | Trusted   | Holds the master private key directly.                                                               | Re-pair: generate a new account; old key is abandoned.                   |
| Subordinate surface       | Trusted   | Linked via QR pairing; receives an EdDSA-JWT signed by the master key.                               | Server adds `surface_id` to the revocation registry; WS torn down.       |
| Host                      | Trusted   | First-run QR pairing; stores `~/.patch/daemon.key` (signed JWT, `kind: "daemon"`).                   | Same as a surface — registry entry + WS termination = decommissioning.   |
| Claude Code OAuth         | Trusted   | User runs `claude login`; SDK reads `~/.claude.json` directly. Patch never writes the file.          | `claude logout` / delete `~/.claude.json`. Host emits `unauthenticated`. |
| Patch server              | Trusted   | You run it. No E2E encryption — server sees plaintext.                                               | Out of scope.                                                            |
| Webhook callers           | Untrusted | Rate-limited, JSONata-filtered, no code exec. Per-webhook tokens baked into URL.                     | Rotate webhook URL.                                                      |

## What this package exposes

### User identity (`identity.ts`)

- `generateUserKeypair(randomBytes?)` — Ed25519 keypair, 32-byte seed encoded base64url.
- `loadUserIdentity(privateKey)` — re-derive `publicKey` from a stored seed.
- `getAccountId(publicKey)` — explicit alias; the public key IS the account ID.

### Surface credentials (`jwt.ts`)

EdDSA-JWT (RFC 8037). Claims: `sub` (= account ID), `surface_id`, `surface_kind`, `label`, `iat`, `exp`. Optional pairing-flow claims: `pairing_nonce`, `surface_pubkey`.

- `mintSurfaceCredential({ userPrivateKey, surfaceId, surfaceKind, label, expiresAt?, now? })` — `expiresAt` is REQUIRED for every surface kind except `voice-device`; if omitted, defaults to `now + 90 days` (`SURFACE_CREDENTIAL_DEFAULT_TTL_SECONDS`).
- `verifySurfaceCredential(jwt, { userPublicKey, expectedSurfaceKind?, now?, expectAnyExp? })` — fails if `exp` is missing (set `expectAnyExp: true` for voice-device tokens) and if `iat` is more than 60s in the future.

`SurfaceKind = 'terminal' | 'web' | 'desktop' | 'mobile' | 'voice-device'`.

### Host registration (`daemon-key.ts`)

- `mintDaemonKey({ userPrivateKey, daemonId, label })` — same shape as a surface JWT, claim `kind: 'daemon'`.
- `verifyDaemonKey(credential, { userPublicKey })`

This package returns the credential string. The host (group 5) writes it to `~/.patch/daemon.key`.

### QR pairing (`pairing.ts`)

- `createPairingNonce({ nowMs? })` — 256-bit base64url nonce, 5-min TTL (constant `PAIRING_NONCE_TTL_MS`).
- `signPairingCredential({ userPrivateKey, nonce, newSurfacePublicKey, newSurface, expiresAt?, nowSec? })` → `pairing.signed_credential` event from `@patch/wire`. The minted JWT is bound to BOTH the pairing nonce and the new surface's public key via `pairing_nonce` / `surface_pubkey` claims.
- `acceptPairingCredential(payload, { userPublicKey, nonceStore, nowMs? })` — `nonceStore` is REQUIRED. Validates nonce existence + expiry + single-use, then verifies signature and the pairing-binding claims. Throws `CredentialBindingError` if the credential was minted for a different nonce or surface key.
- `verifySignedPairingCredential(payload, { userPublicKey, nowSec? })` — inspection-only helper. Verifies the signature + binding claims WITHOUT consuming a nonce. Use this for debug / replay-safe inspection; never substitute it for the real accept path.
- `InMemoryPairingNonceStore` — Map-backed; persistence is the server's job.
- `buildPairingNonceEvent(created, surfacePublicKey)` — convenience.

### Claude OAuth (`claude-oauth.ts`)

- `loadClaudeOAuth({ path?, env?, platform?, readKeychain? })` — resolves the Claude Code OAuth token in order: (1) `$CLAUDE_CODE_OAUTH_TOKEN` env, (2) the credentials file `~/.claude/.credentials.json` (override via `path` / `$CLAUDE_CREDENTIALS_PATH`), (3) the macOS Keychain generic password `Claude Code-credentials`. Throws `ClaudeOAuthMissingError` if no source yields a token, `ClaudeOAuthMalformedError` if a present source has the wrong shape. Optionally attaches the account email from `~/.claude.json` `oauthAccount.emailAddress`. **Never** falls back to a stub or an API key.
- `getClaudeOAuthToken()` — convenience wrapper returning just the token.
- `resolveClaudeConfigPath()` — pure resolver for the credentials-file path, no I/O.

**Canonical field**: `claudeAiOauth.accessToken` (the shape Claude Code persists in `~/.claude/.credentials.json` and the Keychain). We deliberately do not accept any alternative field name — if Claude Code renames it upstream we want to fail loudly, not silently degrade. Note: `~/.claude.json` holds account _metadata_ under `oauthAccount` (email/plan/uuids) but no access token.

### Revocation (`revocation.ts`)

- `RevocationStoreInterface` — interface for the persistent store the server implements (`/data/registry.json`).
- `RevocationStore` — in-memory primitive: `revoke(surfaceId)`, `isRevoked(surfaceId)`. Idempotent.

## NO FALLBACKS

Per portfolio rules: every failure mode is a typed error. Missing OAuth file? `ClaudeOAuthMissingError`. Expired pairing nonce? `PairingNonceExpiredError`. Bad signature? `CredentialVerificationError`. The whole point of pairing is that surfaces without a valid credential cannot connect — silently degrading would defeat that.

## Time units (conventions)

JWT-related times (`mintSurfaceCredential.now`, `mintSurfaceCredential.expiresAt`, `verifySurfaceCredential.now`, `signPairingCredential.nowSec`) are unix **seconds** (jose / RFC 7519 convention). Pairing/nonce times (`createPairingNonce.nowMs`, `acceptPairingCredential.nowMs`, `PairingNonceRecord.expiresAt`) are unix **milliseconds** (`Date.now()` convention). Parameters carry the unit in their name.

## End-to-end example

```ts
import {
  generateUserKeypair,
  mintSurfaceCredential,
  verifySurfaceCredential,
  createPairingNonce,
  signPairingCredential,
  acceptPairingCredential,
  InMemoryPairingNonceStore,
} from '@patch/auth';

// 1. Bootstrap: primary surface generates the user keypair.
const user = generateUserKeypair();

// 2. Primary mints its own surface credential.
const primaryJwt = await mintSurfaceCredential({
  userPrivateKey: user.privateKey,
  surfaceId: 'srf-primary',
  surfaceKind: 'desktop',
  label: 'mac-mini',
});
await verifySurfaceCredential(primaryJwt, { userPublicKey: user.publicKey });

// 3. New surface boots, generates its own keypair, displays a nonce QR.
const newSurface = generateUserKeypair();
const nonce = createPairingNonce();
const store = new InMemoryPairingNonceStore();
store.put({
  nonce: nonce.nonce,
  surfacePublicKey: newSurface.publicKey,
  expiresAt: nonce.expiresAt,
});

// 4. Primary scans QR, signs a pairing credential bound to the nonce + new pubkey.
const pairingEvent = await signPairingCredential({
  userPrivateKey: user.privateKey,
  nonce: nonce.nonce,
  newSurfacePublicKey: newSurface.publicKey,
  newSurface: { kind: 'mobile', label: 'pixel-9', surfaceId: 'srf-mobile' },
});

// 5. Server accepts: validates nonce, signature, and pairing bindings.
const { credential } = await acceptPairingCredential(pairingEvent, {
  userPublicKey: user.publicKey,
  nonceStore: store,
});
```

## Crypto choices

- `@noble/ed25519` + `@noble/hashes` for keypair operations.
- `jose` for EdDSA-JWT mint/verify.
- No `node:crypto` Ed25519 (less portable across Node/browser).
