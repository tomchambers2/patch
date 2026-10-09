// EdDSA-JWT mint/verify per spec/10-auth.md "Tokens on the wire".
// Library: jose. Algorithm: EdDSA (RFC 8037) with Ed25519 keys.

import { SignJWT, jwtVerify, importJWK, type JWK } from 'jose';
import { loadUserIdentity, privateKeyBytes, publicKeyBytes } from './identity.js';
import { bytesToBase64Url } from './base64url.js';
import {
  CredentialVerificationError,
  CredentialExpiredError,
  CredentialMissingExpError,
  CredentialFutureIatError,
} from './errors.js';

/**
 * Default ceiling for surface credential lifetimes when a caller doesn't
 * provide an explicit `expiresAt`. 90 days, in seconds.
 */
export const SURFACE_CREDENTIAL_DEFAULT_TTL_SECONDS = 90 * 24 * 60 * 60;

/** Allow 60s of clock skew when checking that `iat` isn't in the future. */
const IAT_FUTURE_TOLERANCE_SECONDS = 60;

export const SURFACE_KINDS = ['terminal', 'web', 'desktop', 'mobile', 'voice-device'] as const;
export type SurfaceKind = (typeof SURFACE_KINDS)[number];

export interface SurfaceCredentialClaims {
  sub: string;
  surface_id: string;
  surface_kind: SurfaceKind;
  label: string;
  iat: number;
  exp?: number;
  /** Optional pairing-flow bindings; present iff minted via the QR pairing flow (completePairing). */
  pairing_nonce?: string;
  surface_pubkey?: string;
}

export interface MintSurfaceCredentialOptions {
  userPrivateKey: string;
  surfaceId: string;
  surfaceKind: SurfaceKind;
  label: string;
  /**
   * Unix seconds. REQUIRED for every surfaceKind except `voice-device`
   * (voice devices want long-lived, hardware-bound credentials).
   * If omitted for non-voice surfaces, defaults to `nowSec + 90 days`.
   */
  expiresAt?: number;
  /** Override `iat` (test hook). Unix seconds. */
  now?: number;
  /**
   * Pairing-flow bindings: when minting a credential as part of a QR pairing
   * handshake, both must be set so the server can verify the credential is
   * bound to the pairing nonce + the new surface's public key.
   */
  pairingNonce?: string;
  /** Base64url Ed25519 public key of the new surface. */
  surfacePubkey?: string;
}

export interface VerifySurfaceCredentialOptions {
  userPublicKey: string;
  expectedSurfaceKind?: SurfaceKind;
  /** Unix seconds — override clock for testing. */
  now?: number;
  /**
   * Opt out of the "exp is required" check. Host credentials and other
   * deliberately long-lived tokens can pass this. Default: false (exp required).
   */
  expectAnyExp?: boolean;
}

function privateJwk(privateKey: string, publicKey: string): JWK {
  return {
    kty: 'OKP',
    crv: 'Ed25519',
    d: bytesToBase64Url(privateKeyBytes(privateKey)),
    x: bytesToBase64Url(publicKeyBytes(publicKey)),
  };
}

function publicJwk(publicKey: string): JWK {
  return {
    kty: 'OKP',
    crv: 'Ed25519',
    x: bytesToBase64Url(publicKeyBytes(publicKey)),
  };
}

export async function mintSurfaceCredential(opts: MintSurfaceCredentialOptions): Promise<string> {
  const { publicKey } = loadUserIdentity(opts.userPrivateKey);
  const key = await importJWK(privateJwk(opts.userPrivateKey, publicKey), 'EdDSA');

  const iat = opts.now ?? Math.floor(Date.now() / 1000);

  // Surface JWTs are bearer tokens — they MUST expire. Voice-device
  // credentials are the one exception (long-lived hardware-bound). For every
  // other surface kind we require an explicit expiresAt, or default to a
  // 90-day ceiling so a missed call site doesn't accidentally mint a
  // permanent token.
  let exp: number | undefined;
  if (opts.expiresAt !== undefined) {
    exp = opts.expiresAt;
  } else if (opts.surfaceKind !== 'voice-device') {
    exp = iat + SURFACE_CREDENTIAL_DEFAULT_TTL_SECONDS;
  }

  const claims: Record<string, unknown> = {
    surface_id: opts.surfaceId,
    surface_kind: opts.surfaceKind,
    label: opts.label,
  };
  if (opts.pairingNonce !== undefined) claims['pairing_nonce'] = opts.pairingNonce;
  if (opts.surfacePubkey !== undefined) claims['surface_pubkey'] = opts.surfacePubkey;

  const builder = new SignJWT(claims)
    .setProtectedHeader({ alg: 'EdDSA' })
    .setSubject(publicKey)
    .setIssuedAt(iat);

  if (exp !== undefined) {
    builder.setExpirationTime(exp);
  }

  return builder.sign(key);
}

export async function verifySurfaceCredential(
  jwt: string,
  opts: VerifySurfaceCredentialOptions,
): Promise<SurfaceCredentialClaims> {
  const key = await importJWK(publicJwk(opts.userPublicKey), 'EdDSA');

  let payload;
  try {
    const result = await jwtVerify(jwt, key, {
      algorithms: ['EdDSA'],
      currentDate: opts.now !== undefined ? new Date(opts.now * 1000) : undefined,
    });
    payload = result.payload;
  } catch (err) {
    // jose raises JWTExpired (code ERR_JWT_EXPIRED) when `exp` is in the past.
    // A signed-but-expired token is a transient condition distinct from a
    // tampered/forged/revoked credential — callers (e.g. ws-hub) must be able
    // to tell them apart so an expired token does NOT trigger the destructive
    // re-pair signal. Surface it as a dedicated error type.
    if ((err as { code?: string }).code === 'ERR_JWT_EXPIRED') {
      throw new CredentialExpiredError((err as { payload?: { exp?: number } }).payload?.exp);
    }
    throw new CredentialVerificationError((err as Error).message);
  }

  if (payload.sub !== opts.userPublicKey) {
    throw new CredentialVerificationError('sub does not match user public key');
  }

  const surfaceId = payload['surface_id'];
  const surfaceKind = payload['surface_kind'];
  const label = payload['label'];
  if (typeof surfaceId !== 'string' || surfaceId.length === 0) {
    throw new CredentialVerificationError('surface_id missing or invalid');
  }
  if (
    typeof surfaceKind !== 'string' ||
    !(SURFACE_KINDS as readonly string[]).includes(surfaceKind)
  ) {
    throw new CredentialVerificationError('surface_kind missing or invalid');
  }
  if (typeof label !== 'string') {
    throw new CredentialVerificationError('label missing or invalid');
  }
  if (typeof payload.iat !== 'number') {
    throw new CredentialVerificationError('iat missing');
  }

  // Surface JWTs are bearer tokens; reject anything without an `exp` unless
  // the caller explicitly opts out (e.g. daemon-key/voice-device flows).
  if (!opts.expectAnyExp && typeof payload.exp !== 'number') {
    throw new CredentialMissingExpError();
  }

  // Future-iat guard: an attacker who briefly holds the master key could
  // mint a future-dated long-lived token to evade incident-window log
  // searches. 60s clock-skew tolerance.
  const nowSec = opts.now ?? Math.floor(Date.now() / 1000);
  if (payload.iat > nowSec + IAT_FUTURE_TOLERANCE_SECONDS) {
    throw new CredentialFutureIatError(payload.iat, nowSec);
  }

  if (opts.expectedSurfaceKind !== undefined && opts.expectedSurfaceKind !== surfaceKind) {
    throw new CredentialVerificationError(
      `surface_kind mismatch: expected ${opts.expectedSurfaceKind}, got ${surfaceKind}`,
    );
  }

  const pairingNonce = payload['pairing_nonce'];
  const surfacePubkey = payload['surface_pubkey'];

  return {
    sub: payload.sub,
    surface_id: surfaceId,
    surface_kind: surfaceKind as SurfaceKind,
    label,
    iat: payload.iat,
    exp: typeof payload.exp === 'number' ? payload.exp : undefined,
    ...(typeof pairingNonce === 'string' ? { pairing_nonce: pairingNonce } : {}),
    ...(typeof surfacePubkey === 'string' ? { surface_pubkey: surfacePubkey } : {}),
  };
}
