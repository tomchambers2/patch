// Token verifier tests (group 13).

import { describe, test, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { mintVoiceToken, verifyVoiceToken, VoiceTokenError } from '../src/audio/token-verifier.js';

const SECRET = 'unit-test-secret-aaaaaaaa';

function mintRaw(claims: Record<string, unknown>, secret = SECRET): string {
  const claimsB64 = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const sig = createHmac('sha256', secret).update(claimsB64).digest().toString('base64url');
  return `${claimsB64}.${sig}`;
}

describe('verifyVoiceToken', () => {
  test('accepts a well-formed token', () => {
    const tok = mintRaw({
      accountId: 'a',
      surfaceId: 's',
      sessionId: 'sess',
      chatId: 'c',
      exp: Date.now() + 60_000,
      jti: 'j',
    });
    const claims = verifyVoiceToken({ secret: SECRET, token: tok });
    expect(claims.sessionId).toBe('sess');
    expect(claims.chatId).toBe('c');
  });

  test('rejects malformed tokens', () => {
    expect(() => verifyVoiceToken({ secret: SECRET, token: 'abc' })).toThrow(VoiceTokenError);
  });

  test('rejects bad signature', () => {
    const tok = mintRaw(
      {
        accountId: 'a',
        surfaceId: 's',
        sessionId: 'sess',
        exp: Date.now() + 60_000,
        jti: 'j',
      },
      'wrong-secret',
    );
    try {
      verifyVoiceToken({ secret: SECRET, token: tok });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(VoiceTokenError);
      expect((e as VoiceTokenError).code).toBe('bad_signature');
    }
  });

  test('rejects expired tokens', () => {
    const tok = mintRaw({
      accountId: 'a',
      surfaceId: 's',
      sessionId: 'sess',
      chatId: 'c',
      exp: Date.now() - 1,
      jti: 'j',
    });
    try {
      verifyVoiceToken({ secret: SECRET, token: tok });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(VoiceTokenError);
      expect((e as VoiceTokenError).code).toBe('expired');
    }
  });

  test('rejects bad claim shape', () => {
    const tok = mintRaw({
      accountId: '',
      surfaceId: 's',
      sessionId: 'sess',
      exp: Date.now() + 1000,
      jti: 'j',
    });
    try {
      verifyVoiceToken({ secret: SECRET, token: tok });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(VoiceTokenError);
      expect((e as VoiceTokenError).code).toBe('invalid_claims');
    }
  });

  test('rejects an empty token', () => {
    try {
      verifyVoiceToken({ secret: SECRET, token: '' });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(VoiceTokenError);
      expect((e as VoiceTokenError).code).toBe('malformed');
      expect((e as VoiceTokenError).message).toMatch(/missing/);
    }
  });

  test('rejects a token whose separator is the first character', () => {
    // dot === 0 → the `dot <= 0` side of the OR.
    try {
      verifyVoiceToken({ secret: SECRET, token: '.sig' });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(VoiceTokenError);
      expect((e as VoiceTokenError).code).toBe('malformed');
      expect((e as VoiceTokenError).message).toMatch(/separator/);
    }
  });

  test('rejects a token whose separator is the last character', () => {
    // dot === token.length - 1 → the other side of the OR, with dot > 0.
    try {
      verifyVoiceToken({ secret: SECRET, token: 'claims.' });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(VoiceTokenError);
      expect((e as VoiceTokenError).code).toBe('malformed');
      expect((e as VoiceTokenError).message).toMatch(/separator/);
    }
  });

  test('rejects claims that decode but are not JSON', () => {
    // A signature-valid token whose claims segment decodes to non-JSON bytes.
    const claimsB64 = Buffer.from('not-json-at-all', 'utf8').toString('base64url');
    const sig = createHmac('sha256', SECRET).update(claimsB64).digest().toString('base64url');
    const tok = `${claimsB64}.${sig}`;
    try {
      verifyVoiceToken({ secret: SECRET, token: tok });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(VoiceTokenError);
      expect((e as VoiceTokenError).code).toBe('malformed');
      expect((e as VoiceTokenError).message).toMatch(/not JSON/);
    }
  });
});

describe('mintVoiceToken', () => {
  test('mints a token that verifyVoiceToken accepts, round-tripping all claims', () => {
    const { token, claims } = mintVoiceToken({
      secret: SECRET,
      accountId: 'acc-1',
      surfaceId: 'surf-1',
      sessionId: 'sess-1',
      chatId: 'chat-1',
    });
    expect(claims.accountId).toBe('acc-1');
    expect(claims.jti).toMatch(/^[0-9a-f]{32}$/); // default: randomBytes(16).toString('hex')
    const verified = verifyVoiceToken({ secret: SECRET, token });
    expect(verified).toEqual(claims);
  });

  test('honours explicit nowMs, ttlMs, and jti overrides', () => {
    const now = 1_000_000;
    const ttl = 42_000;
    const { token, claims } = mintVoiceToken({
      secret: SECRET,
      accountId: 'acc-2',
      surfaceId: 'surf-2',
      sessionId: 'sess-2',
      chatId: 'chat-2',
      nowMs: now,
      ttlMs: ttl,
      jti: 'explicit-jti',
    });
    expect(claims.jti).toBe('explicit-jti');
    expect(claims.exp).toBe(now + ttl);
    // Verifying strictly after `exp` (nowMs > exp) must reject as expired.
    expect(() => verifyVoiceToken({ secret: SECRET, token, nowMs: now + ttl + 1 })).toThrow(
      /expired/,
    );
    // Verifying before `exp` succeeds.
    const verified = verifyVoiceToken({ secret: SECRET, token, nowMs: now + ttl - 1 });
    expect(verified.sessionId).toBe('sess-2');
  });
});
