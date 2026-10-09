// Voice-token verifier — host side (group 13).
//
// Mirror of the verify logic in `@patch/server/src/voice/token.ts`. We
// intentionally duplicate rather than cross-import: the host does not
// (and should not) take a runtime dep on @patch/server. The token format
// is small + stable; the spec hardens it as the source of truth.
//
// Format: `<b64url(claimsJson)>.<b64url(hmac)>` where hmac =
// HMAC-SHA256(internalToken, claimsB64). NO FALLBACK on bad signature
// or expiry.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/** Voice-token TTL — 5 minutes, matching the server's mint (spec/16). */
export const VOICE_TOKEN_TTL_MS = 5 * 60_000;

export const VoiceTokenClaims = z
  .object({
    accountId: z.string().min(1),
    surfaceId: z.string().min(1),
    sessionId: z.string().min(1),
    /** Chat the token was minted for — the audio server binds the session to it. */
    chatId: z.string().min(1),
    exp: z.number().int().positive(),
    jti: z.string().min(1),
  })
  .strict();
export type VoiceTokenClaims = z.infer<typeof VoiceTokenClaims>;

/**
 * Mint a voice token host-side (spec/16 §Wire protocol "Voice-token
 * delivery"): for a `device` session the host mints the per-session HMAC
 * token itself and pushes it in the control-plane `session_start` frame —
 * the device never calls the server's `POST /api/voice/token`. Byte-identical
 * format to `@patch/server`'s `mintVoiceToken` (same shared HMAC secret =
 * PATCH_INTERNAL_TOKEN), so `verifyVoiceToken` accepts it on the audio WSS.
 *
 * Signature is over the exact `claimsB64` bytes (not a re-serialised copy) so
 * the verifier checks the same bytes it received.
 */
export function mintVoiceToken(args: {
  secret: string;
  accountId: string;
  surfaceId: string;
  sessionId: string;
  chatId: string;
  nowMs?: number;
  jti?: string;
  ttlMs?: number;
}): { token: string; claims: VoiceTokenClaims } {
  const now = args.nowMs ?? Date.now();
  const ttl = args.ttlMs ?? VOICE_TOKEN_TTL_MS;
  const jti = args.jti ?? randomBytes(16).toString('hex');
  const claims: VoiceTokenClaims = {
    accountId: args.accountId,
    surfaceId: args.surfaceId,
    sessionId: args.sessionId,
    chatId: args.chatId,
    exp: now + ttl,
    jti,
  };
  const claimsB64 = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const sig = createHmac('sha256', args.secret).update(claimsB64).digest();
  return { token: `${claimsB64}.${sig.toString('base64url')}`, claims };
}

export class VoiceTokenError extends Error {
  constructor(
    public readonly code: 'malformed' | 'bad_signature' | 'expired' | 'invalid_claims',
    message: string,
  ) {
    super(message);
    this.name = 'VoiceTokenError';
  }
}

/**
 * Verification precedence (group 14, DX m7):
 *   1. presence/structural — token non-empty AND has a `.` separator
 *   2. signature — HMAC matches expected
 *   3. claim shape — VoiceTokenClaims zod
 *   4. expiry — `exp > now`
 *   5. (caller's job) sessionId-binding, identity-binding, JTI consume
 *
 * The host's audio server enforces 5; this function only handles 1-4.
 */
export function verifyVoiceToken(args: {
  secret: string;
  token: string;
  nowMs?: number;
}): VoiceTokenClaims {
  const now = args.nowMs ?? Date.now();
  if (args.token.length === 0) {
    throw new VoiceTokenError('malformed', 'voice token: missing');
  }
  const dot = args.token.indexOf('.');
  if (dot <= 0 || dot === args.token.length - 1) {
    throw new VoiceTokenError('malformed', 'voice token: missing separator');
  }
  const claimsB64 = args.token.slice(0, dot);
  const sigB64 = args.token.slice(dot + 1);
  const expectedSig = createHmac('sha256', args.secret).update(claimsB64).digest();
  let providedSig: Buffer;
  try {
    providedSig = Buffer.from(sigB64, 'base64url');
    /* v8 ignore next 3 -- Buffer.from(str, 'base64url') never throws for string input (invalid chars are skipped, not rejected); unreachable defensive guard. */
  } catch {
    throw new VoiceTokenError('malformed', 'voice token: bad signature encoding');
  }
  if (providedSig.length !== expectedSig.length || !timingSafeEqual(providedSig, expectedSig)) {
    throw new VoiceTokenError('bad_signature', 'voice token: signature mismatch');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(claimsB64, 'base64url').toString('utf8'));
  } catch {
    throw new VoiceTokenError('malformed', 'voice token: claims not JSON');
  }
  const result = VoiceTokenClaims.safeParse(parsed);
  if (!result.success) {
    throw new VoiceTokenError('invalid_claims', 'voice token: claim shape rejected');
  }
  if (result.data.exp <= now) {
    throw new VoiceTokenError('expired', 'voice token: expired');
  }
  return result.data;
}
