// Voice session token mint + verify (group 13).
//
// `POST /api/voice/token` issues a one-shot, 5-minute HMAC-SHA256 token bound
// to (accountId, surfaceId, sessionId). The surface presents this token in
// the audio WSS `audio.session_start` frame; the host verifies it against
// the same HMAC secret (PATCH_INTERNAL_TOKEN — shared between the server and
// the host's audio WSS).
//
// Stateless on the server: nothing is persisted. The host enforces
// one-shot consumption via an in-memory JTI replay set. Replay across host
// restarts is bounded by the 5-minute expiry — short enough that a captured
// token is useless after a normal redeploy. NO FALLBACK on verification:
// any invalid signature, expired exp, or missing field → reject.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { verifySurfaceCredential } from '@patch/auth';
import type { Registry } from '../registry.js';
import type { ChatRegistry } from '../chat-registry.js';
import { z } from 'zod';

export const VOICE_TOKEN_TTL_MS = 5 * 60_000;

export const VoiceTokenClaims = z
  .object({
    accountId: z.string().min(1),
    surfaceId: z.string().min(1),
    sessionId: z.string().min(1),
    /**
     * Chat the token was minted for. The host's audio server rejects a
     * `session_start` whose declared `chatId` does not equal this claim
     * (E1-d2) — the token is bound to the chat, not just the surface, so a
     * captured token cannot be replayed against a different chat.
     */
    chatId: z.string().min(1),
    /** ms-since-epoch. */
    exp: z.number().int().positive(),
    /** Random 128-bit identifier — host enforces one-shot consumption. */
    jti: z.string().min(1),
  })
  .strict();
export type VoiceTokenClaims = z.infer<typeof VoiceTokenClaims>;

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

/**
 * Mint a token. Format: `<b64url(claims)>.<b64url(hmac)>`.
 *
 * The signature is computed over the exact claims JSON bytes (NOT a re-
 * serialised version) — the host verifies the same byte sequence it
 * received, which sidesteps JSON-canonicalisation gotchas.
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
  const claimsJson = JSON.stringify(claims);
  const claimsB64 = b64url(Buffer.from(claimsJson, 'utf8'));
  const sig = createHmac('sha256', args.secret).update(claimsB64).digest();
  const token = `${claimsB64}.${b64url(sig)}`;
  return { token, claims };
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
 * Verify the signature, expiry, and claim shape. Does NOT enforce one-shot
 * consumption — that's the caller's job (the host keeps a JTI set).
 */
export function verifyVoiceToken(args: {
  secret: string;
  token: string;
  nowMs?: number;
}): VoiceTokenClaims {
  const now = args.nowMs ?? Date.now();
  const dot = args.token.indexOf('.');
  if (dot <= 0 || dot === args.token.length - 1) {
    throw new VoiceTokenError('malformed', 'voice token: missing separator');
  }
  const claimsB64 = args.token.slice(0, dot);
  const sigB64 = args.token.slice(dot + 1);
  const expectedSig = createHmac('sha256', args.secret).update(claimsB64).digest();
  // `catch` below: defensive only. `Buffer.from(s, 'base64url')` does not
  // throw for any string input in Node (invalid characters are silently
  // skipped), so a malformed sigB64 always yields SOME buffer — it just
  // fails the length/timingSafeEqual check right after, not this decode.
  let providedSig: Buffer;
  try {
    providedSig = b64urlDecode(sigB64);
    /* v8 ignore next 3 */
  } catch {
    throw new VoiceTokenError('malformed', 'voice token: bad signature encoding');
  }
  if (providedSig.length !== expectedSig.length || !timingSafeEqual(providedSig, expectedSig)) {
    throw new VoiceTokenError('bad_signature', 'voice token: signature mismatch');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(b64urlDecode(claimsB64).toString('utf8'));
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

// ----- HTTP route ----------------------------------------------------------

export interface VoiceTokenRouteOpts {
  logger: Logger;
  registry: Registry;
  /**
   * In-process chat mirror, used to validate that the requested `chatId`
   * actually exists under this account BEFORE a token is minted (E1-d1).
   * Minting a usable token for a garbage/foreign chatId is a security hole:
   * the surface could open an audio session bound to a chat it does not own.
   */
  chatRegistry: ChatRegistry;
  internalToken: string;
  /**
   * Records which host this session belongs to, so the `/audio/:sessionId`
   * relay (`audio-relay.ts`) knows where to send it — the chat's OWN host,
   * which a surface reaching only the server otherwise has no way to name
   * (spec/07 § Voice is a per-host capability).
   */
  recordSessionHost: (sessionId: string, daemonId: string) => void;
  /** Test hook: deterministic clock. */
  nowMs?: () => number;
  /** Test hook: deterministic sessionId factory (group 14, DX m2). */
  sessionIdFactory?: () => string;
  /** Test hook: deterministic JTI factory (group 14, DX m2). */
  jtiFactory?: () => string;
  /** Test hook: stub credential verifier (defaults to @patch/auth). */
  verifyCredential?: typeof verifySurfaceCredential;
}

const MintRequestBody = z
  .object({
    chatId: z.string().min(1),
    role: z.enum(['voice-note', 'voice-call', 'voice-device-conv']),
    surfaceKind: z.enum(['web', 'desktop', 'mobile', 'device']),
  })
  .strict();

export function registerVoiceTokenRoute(app: FastifyInstance, opts: VoiceTokenRouteOpts): void {
  app.post('/api/voice/token', async (req, reply) => {
    // Auth: presence-tracked WS sessions surface their (accountId, surfaceId)
    // via the Authorization Bearer header (the EdDSA-JWT). For group 13 we
    // accept the same header the WS hub does: the registry exposes
    // verifySurfaceJwt — but to stay decoupled here, we lean on the
    // presence layer's "is this surface authed?" lookup, which the WS hub
    // populates after `auth.ok`. NO FALLBACK: missing/invalid → 401.
    const authHeader = req.headers['authorization'];
    if (!authHeader || typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'missing bearer' });
    }
    const jwt = authHeader.slice('Bearer '.length).trim();
    const account = opts.registry.getAccount();
    if (!account) {
      return reply.code(401).send({ error: 'no account' });
    }
    if (opts.registry.isRevoked === undefined) {
      // Defensive: shouldn't happen with the real Registry, but keeps the
      // type narrowing honest under tests that inject a partial stub.
      return reply.code(500).send({ error: 'registry missing isRevoked' });
    }
    const verify = opts.verifyCredential ?? verifySurfaceCredential;
    const nowSec = Math.floor((opts.nowMs ? opts.nowMs() : Date.now()) / 1000);
    let claims;
    try {
      claims = await verify(jwt, {
        userPublicKey: account.userPublicKey,
        now: nowSec,
      });
    } catch (err) {
      opts.logger.warn({ err: (err as Error).message }, 'voice-token: jwt verify failed');
      return reply.code(401).send({ error: 'invalid bearer' });
    }
    if (opts.registry.isRevoked(claims.surface_id)) {
      return reply.code(401).send({ error: 'surface revoked' });
    }
    const identity = { accountId: account.accountId, surfaceId: claims.surface_id };
    const parsed = MintRequestBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    }
    // E1-d1: validate the chat exists (and therefore belongs to this single-
    // account server) BEFORE minting. The ChatRegistry mirrors the host's
    // chats; an unknown chatId means there is nothing to bind a voice session
    // to. NO FALLBACK — reject with a specific code rather than handing out a
    // usable token for a garbage id.
    const chat = opts.chatRegistry.get(parsed.data.chatId);
    if (!chat) {
      opts.logger.warn(
        { chatId: parsed.data.chatId, surfaceId: identity.surfaceId },
        'voice-token: rejected mint for unknown chatId',
      );
      return reply.code(404).send({ error: 'chat_not_found' });
    }
    const sessionId = opts.sessionIdFactory
      ? opts.sessionIdFactory()
      : randomBytes(12).toString('hex');
    const now = opts.nowMs ? opts.nowMs() : Date.now();
    const minted = mintVoiceToken({
      secret: opts.internalToken,
      accountId: identity.accountId,
      surfaceId: identity.surfaceId,
      sessionId,
      chatId: parsed.data.chatId,
      nowMs: now,
      ...(opts.jtiFactory ? { jti: opts.jtiFactory() } : {}),
    });
    // The chat's own host, so `/audio/:sessionId` (audio-relay.ts) knows where
    // to send this session — a surface reaching only the server has no other
    // way to name it (spec/07 § Voice is a per-host capability).
    opts.recordSessionHost(sessionId, chat.daemonId);
    opts.logger.info(
      {
        accountId: identity.accountId,
        surfaceId: identity.surfaceId,
        sessionId,
        daemonId: chat.daemonId,
      },
      'voice-token minted',
    );
    return reply.code(200).send({
      token: minted.token,
      sessionId,
      expiresAt: minted.claims.exp,
      audioUrl: `/audio/${sessionId}`,
    });
  });
}
