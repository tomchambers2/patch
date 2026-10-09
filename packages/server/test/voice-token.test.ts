// Voice token mint + verify tests (group 13).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import Fastify from 'fastify';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';
import { ChatRegistry } from '../src/chat-registry.js';
import {
  mintVoiceToken,
  verifyVoiceToken,
  VoiceTokenError,
  registerVoiceTokenRoute,
} from '../src/voice/token.js';

const SECRET = 'test-internal-token-not-for-prod-aaaa';

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

/** Hand-build a syntactically-valid-looking token with arbitrary claims bytes,
 * signed correctly, so we can drive verifyVoiceToken's claims-parsing branches
 * independent of mintVoiceToken (which always produces well-formed JSON). */
function signRawClaims(secret: string, claimsBytes: Buffer): string {
  const claimsB64 = b64url(claimsBytes);
  const sig = createHmac('sha256', secret).update(claimsB64).digest();
  return `${claimsB64}.${b64url(sig)}`;
}

describe('mintVoiceToken / verifyVoiceToken', () => {
  it('round-trips a freshly minted token', () => {
    const { token, claims } = mintVoiceToken({
      secret: SECRET,
      accountId: 'acct',
      surfaceId: 'surf',
      sessionId: 'sess',
      chatId: 'chat',
    });
    const verified = verifyVoiceToken({ secret: SECRET, token });
    expect(verified.accountId).toBe('acct');
    expect(verified.sessionId).toBe('sess');
    expect(verified.chatId).toBe('chat');
    expect(verified.exp).toBe(claims.exp);
  });

  it('rejects expired tokens', () => {
    const { token } = mintVoiceToken({
      secret: SECRET,
      accountId: 'a',
      surfaceId: 's',
      sessionId: 'x',
      chatId: 'c',
      nowMs: Date.now() - 10 * 60_000,
    });
    expect(() => verifyVoiceToken({ secret: SECRET, token })).toThrow(VoiceTokenError);
  });

  it('rejects tokens minted with a different secret', () => {
    const { token } = mintVoiceToken({
      secret: 'other-secret-xxxxxxxxxx',
      accountId: 'a',
      surfaceId: 's',
      sessionId: 'x',
      chatId: 'c',
    });
    try {
      verifyVoiceToken({ secret: SECRET, token });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(VoiceTokenError);
      expect((e as VoiceTokenError).code).toBe('bad_signature');
    }
  });

  it('JTI uniqueness — two mints have distinct jti', () => {
    const a = mintVoiceToken({
      secret: SECRET,
      accountId: 'a',
      surfaceId: 's',
      sessionId: '1',
      chatId: 'c',
    });
    const b = mintVoiceToken({
      secret: SECRET,
      accountId: 'a',
      surfaceId: 's',
      sessionId: '2',
      chatId: 'c',
    });
    expect(a.claims.jti).not.toBe(b.claims.jti);
  });

  it('rejects a token with no separator at all', () => {
    try {
      verifyVoiceToken({ secret: SECRET, token: 'nodothere' });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(VoiceTokenError);
      expect((e as VoiceTokenError).code).toBe('malformed');
    }
  });

  it('rejects a token whose separator is the very last character', () => {
    try {
      verifyVoiceToken({ secret: SECRET, token: 'claimsblob.' });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(VoiceTokenError);
      expect((e as VoiceTokenError).code).toBe('malformed');
    }
  });

  it('rejects a token whose separator is the very first character', () => {
    try {
      verifyVoiceToken({ secret: SECRET, token: '.sigblob' });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(VoiceTokenError);
      expect((e as VoiceTokenError).code).toBe('malformed');
    }
  });

  it('rejects claims bytes that are not valid JSON', () => {
    const token = signRawClaims(SECRET, Buffer.from('not-json-at-all', 'utf8'));
    try {
      verifyVoiceToken({ secret: SECRET, token });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(VoiceTokenError);
      expect((e as VoiceTokenError).code).toBe('malformed');
      expect((e as VoiceTokenError).message).toContain('claims not JSON');
    }
  });

  it('rejects valid JSON claims that fail the claim-shape schema', () => {
    // Valid JSON, but missing every required field.
    const token = signRawClaims(SECRET, Buffer.from(JSON.stringify({ nope: true }), 'utf8'));
    try {
      verifyVoiceToken({ secret: SECRET, token });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(VoiceTokenError);
      expect((e as VoiceTokenError).code).toBe('invalid_claims');
    }
  });
});

describe('POST /api/voice/token', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-voice-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function makeApp(opts: { nowMs?: () => number } = {}) {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(13));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({
      surfaceId: 'srf-web-1',
      surfaceKind: 'web',
      label: 'browser',
      issuedAt: 1,
    });
    const daemonLink = new InProcessDaemonLink();
    const built = await buildAll({
      logger: false,
      registry,
      daemonLink,
      internalToken: SECRET,
      ...(opts.nowMs ? { nowMs: opts.nowMs } : {}),
    });
    // Seed a real chat into the in-process ChatRegistry so the mint route
    // (E1-d1) sees 'c1' as an existing chat. Without this, every mint 404s.
    daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '/tmp/c1' });
    const credential = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-web-1',
      surfaceKind: 'web',
      label: 'browser',
    });
    return { built, credential, daemonLink, registry };
  }

  it('mints a token for an authenticated surface', async () => {
    const { built, credential } = await makeApp();
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/token',
        headers: { authorization: `Bearer ${credential}` },
        payload: { chatId: 'c1', role: 'voice-call', surfaceKind: 'web' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        token: string;
        sessionId: string;
        expiresAt: number;
        audioUrl: string;
      };
      expect(body.audioUrl).toBe(`/audio/${body.sessionId}`);
      const claims = verifyVoiceToken({ secret: SECRET, token: body.token });
      expect(claims.surfaceId).toBe('srf-web-1');
      expect(claims.sessionId).toBe(body.sessionId);
      // E1-d2: the minted token binds to the requested chatId.
      expect(claims.chatId).toBe('c1');
    } finally {
      await built.app.close();
    }
  });

  it('rejects a mint for an unknown chatId with 404 chat_not_found (E1-d1)', async () => {
    const { built, credential } = await makeApp();
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/token',
        headers: { authorization: `Bearer ${credential}` },
        payload: {
          chatId: 'DOES_NOT_EXIST_AT_ALL_XYZ',
          role: 'voice-call',
          surfaceKind: 'web',
        },
      });
      expect(res.statusCode).toBe(404);
      expect((res.json() as { error: string }).error).toBe('chat_not_found');
    } finally {
      await built.app.close();
    }
  });

  it('rejects missing bearer with 401', async () => {
    const { built } = await makeApp();
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/token',
        payload: { chatId: 'c1', role: 'voice-call', surfaceKind: 'web' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });

  it('rejects bad payload with 400', async () => {
    const { built, credential } = await makeApp();
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/token',
        headers: { authorization: `Bearer ${credential}` },
        payload: { chatId: 'c1', role: 'mystery', surfaceKind: 'web' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await built.app.close();
    }
  });

  it("mints a token for surfaceKind: 'device' (B-23 voice device)", async () => {
    const { built, credential } = await makeApp();
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/token',
        headers: { authorization: `Bearer ${credential}` },
        payload: { chatId: 'c1', role: 'voice-device-conv', surfaceKind: 'device' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        token: string;
        sessionId: string;
        expiresAt: number;
        audioUrl: string;
      };
      const claims = verifyVoiceToken({ secret: SECRET, token: body.token });
      expect(claims.surfaceId).toBe('srf-web-1');
      expect(claims.sessionId).toBe(body.sessionId);
    } finally {
      await built.app.close();
    }
  });

  it('rejects an invalid bearer with 401', async () => {
    const { built } = await makeApp();
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/token',
        headers: { authorization: 'Bearer not-a-jwt' },
        payload: { chatId: 'c1', role: 'voice-call', surfaceKind: 'web' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });

  it('rejects with 401 "no account" when no account has been bootstrapped', async () => {
    const registry = Registry.load(dir); // no bootstrapAccount() call
    const daemonLink = new InProcessDaemonLink();
    const built = await buildAll({ logger: false, registry, daemonLink, internalToken: SECRET });
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/token',
        headers: { authorization: 'Bearer whatever' },
        payload: { chatId: 'c1', role: 'voice-call', surfaceKind: 'web' },
      });
      expect(res.statusCode).toBe(401);
      expect((res.json() as { error: string }).error).toBe('no account');
    } finally {
      await built.app.close();
    }
  });

  it('rejects a revoked surface with 401 "surface revoked"', async () => {
    const { built, credential, registry } = await makeApp();
    registry.revoke('srf-web-1');
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/token',
        headers: { authorization: `Bearer ${credential}` },
        payload: { chatId: 'c1', role: 'voice-call', surfaceKind: 'web' },
      });
      expect(res.statusCode).toBe(401);
      expect((res.json() as { error: string }).error).toBe('surface revoked');
    } finally {
      await built.app.close();
    }
  });

  it('mints a token whose expiry reflects the injected clock (nowMs)', async () => {
    // Pinned to the real "now" (not an arbitrary calendar date) so the
    // surface credential's own iat/exp window — validated against this same
    // clock — stays satisfied.
    const fixedNow = Date.now();
    const { built, credential } = await makeApp({ nowMs: () => fixedNow });
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/token',
        headers: { authorization: `Bearer ${credential}` },
        payload: { chatId: 'c1', role: 'voice-call', surfaceKind: 'web' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { expiresAt: number };
      expect(body.expiresAt).toBe(fixedNow + 5 * 60_000);
    } finally {
      await built.app.close();
    }
  });

  it('registerVoiceTokenRoute returns 500 "registry missing isRevoked" for a partial registry stub', async () => {
    // A raw Fastify app + a hand-built registry stub, bypassing buildAll
    // (whose real Registry always has isRevoked) to exercise the defensive
    // type-narrowing guard directly.
    const app = Fastify({ logger: false });
    const stubRegistry = {
      getAccount: () => ({ accountId: 'acct-1', userPublicKey: 'pub', createdAt: 1 }),
      // isRevoked intentionally omitted.
    } as unknown as Registry;
    registerVoiceTokenRoute(app, {
      logger: { warn: () => undefined, info: () => undefined } as unknown as import('pino').Logger,
      registry: stubRegistry,
      chatRegistry: new ChatRegistry(),
      internalToken: SECRET,
      recordSessionHost: () => undefined,
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/voice/token',
        headers: { authorization: 'Bearer anything' },
        payload: { chatId: 'c1', role: 'voice-call', surfaceKind: 'web' },
      });
      expect(res.statusCode).toBe(500);
      expect((res.json() as { error: string }).error).toBe('registry missing isRevoked');
    } finally {
      await app.close();
    }
  });

  it('honors sessionIdFactory / jtiFactory test hooks (registered directly, not via buildAll)', async () => {
    // buildAll doesn't wire these two test-only hooks through, so this drives
    // registerVoiceTokenRoute directly against a raw Fastify app + a real
    // Registry/ChatRegistry, mirroring what buildAll assembles.
    const user = generateUserKeypair(() => new Uint8Array(32).fill(77));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({
      surfaceId: 'srf-hooks',
      surfaceKind: 'web',
      label: 'browser',
      issuedAt: 1,
    });
    const chatRegistry = new ChatRegistry();
    chatRegistry.observe({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '/tmp/c1' });
    const app = Fastify({ logger: false });
    registerVoiceTokenRoute(app, {
      logger: { warn: () => undefined, info: () => undefined } as unknown as import('pino').Logger,
      registry,
      chatRegistry,
      internalToken: SECRET,
      recordSessionHost: () => undefined,
      sessionIdFactory: () => 'fixed-session-id',
      jtiFactory: () => 'fixed-jti',
    });
    const credential = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-hooks',
      surfaceKind: 'web',
      label: 'browser',
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/voice/token',
        headers: { authorization: `Bearer ${credential}` },
        payload: { chatId: 'c1', role: 'voice-call', surfaceKind: 'web' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { token: string; sessionId: string; audioUrl: string };
      expect(body.sessionId).toBe('fixed-session-id');
      expect(body.audioUrl).toBe('/audio/fixed-session-id');
      const claims = verifyVoiceToken({ secret: SECRET, token: body.token });
      expect(claims.jti).toBe('fixed-jti');
      expect(claims.sessionId).toBe('fixed-session-id');
    } finally {
      await app.close();
    }
  });
});
