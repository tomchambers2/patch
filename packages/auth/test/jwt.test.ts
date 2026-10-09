import { describe, it, expect } from 'vitest';
import {
  generateUserKeypair,
  mintSurfaceCredential,
  verifySurfaceCredential,
  CredentialVerificationError,
  CredentialExpiredError,
  CredentialMissingExpError,
  CredentialFutureIatError,
  SURFACE_CREDENTIAL_DEFAULT_TTL_SECONDS,
} from '../src/index.js';
import { SignJWT, importJWK } from 'jose';

describe('surface credentials (EdDSA-JWT)', () => {
  it('round-trips mint + verify (default 90-day TTL is applied)', async () => {
    const kp = generateUserKeypair(() => new Uint8Array(32).fill(1));
    const iat = 1_000_000;
    const jwt = await mintSurfaceCredential({
      userPrivateKey: kp.privateKey,
      surfaceId: 'srf-1',
      surfaceKind: 'web',
      label: 'browser',
      now: iat,
    });
    const claims = await verifySurfaceCredential(jwt, {
      userPublicKey: kp.publicKey,
      now: iat + 10,
    });
    expect(claims.sub).toBe(kp.publicKey);
    expect(claims.surface_id).toBe('srf-1');
    expect(claims.surface_kind).toBe('web');
    expect(claims.label).toBe('browser');
    expect(claims.iat).toBe(iat);
    expect(claims.exp).toBe(iat + SURFACE_CREDENTIAL_DEFAULT_TTL_SECONDS);
  });

  it('rejects expired tokens with the dedicated CredentialExpiredError (NOT a generic verification error) (B2-d2)', async () => {
    // Expiry is transient and must be distinguishable from a tampered/forged
    // credential so callers don't treat it as a revocation. CredentialExpiredError
    // is a sibling of CredentialVerificationError (both AuthError), not a subclass.
    const kp = generateUserKeypair(() => new Uint8Array(32).fill(2));
    const jwt = await mintSurfaceCredential({
      userPrivateKey: kp.privateKey,
      surfaceId: 'srf-2',
      surfaceKind: 'mobile',
      label: 'phone',
      now: 1_000_000,
      expiresAt: 1_000_100,
    });
    await expect(
      verifySurfaceCredential(jwt, { userPublicKey: kp.publicKey, now: 1_000_200 }),
    ).rejects.toBeInstanceOf(CredentialExpiredError);
    // A tampered/forged credential must NOT surface as expired.
    await expect(
      verifySurfaceCredential(jwt, { userPublicKey: kp.publicKey, now: 1_000_200 }),
    ).rejects.not.toBeInstanceOf(CredentialVerificationError);
  });

  it('rejects a credential whose signature byte has been tampered', async () => {
    const kp = generateUserKeypair(() => new Uint8Array(32).fill(33));
    const jwt = await mintSurfaceCredential({
      userPrivateKey: kp.privateKey,
      surfaceId: 'srf-tamper',
      surfaceKind: 'web',
      label: 'b',
      now: 1_000_000,
      expiresAt: 1_001_000,
    });
    // Flip the trailing chars of the signature segment — payload/header
    // stay valid, but the EdDSA signature no longer verifies.
    const parts = jwt.split('.');
    const sig = parts[2];
    if (!sig) throw new Error('expected 3-part JWT');
    const tamperedSig = sig.slice(0, -2) + (sig.slice(-2) === 'aa' ? 'bb' : 'aa');
    const tampered = `${parts[0]}.${parts[1]}.${tamperedSig}`;
    await expect(
      verifySurfaceCredential(tampered, { userPublicKey: kp.publicKey, now: 1_000_010 }),
    ).rejects.toBeInstanceOf(CredentialVerificationError);
  });

  it('rejects credentials signed by a different key', async () => {
    const a = generateUserKeypair(() => new Uint8Array(32).fill(3));
    const b = generateUserKeypair(() => new Uint8Array(32).fill(4));
    const jwt = await mintSurfaceCredential({
      userPrivateKey: a.privateKey,
      surfaceId: 'srf-3',
      surfaceKind: 'desktop',
      label: 'mac',
      now: 1_000_000,
    });
    await expect(
      verifySurfaceCredential(jwt, { userPublicKey: b.publicKey, now: 1_000_010 }),
    ).rejects.toBeInstanceOf(CredentialVerificationError);
  });

  it('rejects when expectedSurfaceKind filter does not match', async () => {
    const kp = generateUserKeypair(() => new Uint8Array(32).fill(5));
    const jwt = await mintSurfaceCredential({
      userPrivateKey: kp.privateKey,
      surfaceId: 'srf-4',
      surfaceKind: 'terminal',
      label: 'cli',
      now: 1_000_000,
    });
    await expect(
      verifySurfaceCredential(jwt, {
        userPublicKey: kp.publicKey,
        expectedSurfaceKind: 'web',
        now: 1_000_010,
      }),
    ).rejects.toThrow(/surface_kind mismatch/);

    // Same JWT verifies fine with the correct filter.
    const claims = await verifySurfaceCredential(jwt, {
      userPublicKey: kp.publicKey,
      expectedSurfaceKind: 'terminal',
      now: 1_000_010,
    });
    expect(claims.surface_kind).toBe('terminal');
  });

  it('voice-device credentials may omit exp; verifier requires expectAnyExp opt-in to accept', async () => {
    const kp = generateUserKeypair(() => new Uint8Array(32).fill(6));
    const jwt = await mintSurfaceCredential({
      userPrivateKey: kp.privateKey,
      surfaceId: 'srf-vd',
      surfaceKind: 'voice-device',
      label: 'speaker-1',
      now: 1_000_000,
    });
    // No exp claim (voice-device opted out of the default ceiling).
    await expect(
      verifySurfaceCredential(jwt, { userPublicKey: kp.publicKey, now: 1_000_010 }),
    ).rejects.toBeInstanceOf(CredentialMissingExpError);
    // …but with expectAnyExp it verifies.
    const claims = await verifySurfaceCredential(jwt, {
      userPublicKey: kp.publicKey,
      now: 1_000_010,
      expectAnyExp: true,
    });
    expect(claims.exp).toBeUndefined();
  });

  it('rejects future-iat tokens beyond the 60s clock-skew tolerance', async () => {
    const kp = generateUserKeypair(() => new Uint8Array(32).fill(7));
    // Mint with iat far in the future.
    const jwt = await mintSurfaceCredential({
      userPrivateKey: kp.privateKey,
      surfaceId: 'srf-future',
      surfaceKind: 'web',
      label: 'b',
      now: 2_000_000,
      expiresAt: 2_001_000,
    });
    // Verifier "now" is well before mint-iat — should fail.
    await expect(
      verifySurfaceCredential(jwt, { userPublicKey: kp.publicKey, now: 1_000_000 }),
    ).rejects.toBeInstanceOf(CredentialFutureIatError);
  });

  it('accepts iat within the 60s clock-skew window', async () => {
    const kp = generateUserKeypair(() => new Uint8Array(32).fill(8));
    const jwt = await mintSurfaceCredential({
      userPrivateKey: kp.privateKey,
      surfaceId: 'srf-skew',
      surfaceKind: 'web',
      label: 'b',
      now: 1_000_030,
      expiresAt: 1_001_000,
    });
    // Verifier clock is 30s behind mint — within tolerance.
    const claims = await verifySurfaceCredential(jwt, {
      userPublicKey: kp.publicKey,
      now: 1_000_000,
    });
    expect(claims.iat).toBe(1_000_030);
  });

  it('rejects an exp-less credential (manually constructed) without expectAnyExp', async () => {
    const kp = generateUserKeypair(() => new Uint8Array(32).fill(9));
    // Bypass mintSurfaceCredential to simulate a malicious / legacy token
    // that omits exp entirely on a non-voice-device surface.
    const { bytesToBase64Url } = await import('../src/base64url.js');
    const { privateKeyBytes, publicKeyBytes } = await import('../src/identity.js');
    const key = await importJWK(
      {
        kty: 'OKP',
        crv: 'Ed25519',
        d: bytesToBase64Url(privateKeyBytes(kp.privateKey)),
        x: bytesToBase64Url(publicKeyBytes(kp.publicKey)),
      },
      'EdDSA',
    );
    const jwt = await new SignJWT({
      surface_id: 's',
      surface_kind: 'web',
      label: 'b',
    })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setSubject(kp.publicKey)
      .setIssuedAt(1_000_000)
      .sign(key);

    await expect(
      verifySurfaceCredential(jwt, { userPublicKey: kp.publicKey, now: 1_000_010 }),
    ).rejects.toBeInstanceOf(CredentialMissingExpError);
  });

  it('mints + verifies using the real wall clock when `now` is omitted', async () => {
    // Both mintSurfaceCredential's `iat` and verifySurfaceCredential's
    // `currentDate`/`nowSec` fall back to Date.now() when the test hook is
    // not supplied — this is the real production code path.
    const kp = generateUserKeypair(() => new Uint8Array(32).fill(20));
    const jwt = await mintSurfaceCredential({
      userPrivateKey: kp.privateKey,
      surfaceId: 'srf-realtime',
      surfaceKind: 'web',
      label: 'browser',
    });
    const claims = await verifySurfaceCredential(jwt, { userPublicKey: kp.publicKey });
    expect(claims.surface_id).toBe('srf-realtime');
    expect(claims.iat).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
  });

  describe('manually constructed malformed credentials (bypassing mintSurfaceCredential)', () => {
    // Shared helper to sign a raw JWT with arbitrary claims/subject, so we can
    // exercise verifySurfaceCredential's individual field-validation branches
    // that mintSurfaceCredential's own API can never produce.
    async function signRaw(
      kp: { privateKey: string; publicKey: string },
      opts: {
        subject?: string;
        claims?: Record<string, unknown>;
        includeIat?: boolean;
        iat?: number;
      } = {},
    ): Promise<string> {
      const { bytesToBase64Url } = await import('../src/base64url.js');
      const { privateKeyBytes, publicKeyBytes } = await import('../src/identity.js');
      const key = await importJWK(
        {
          kty: 'OKP',
          crv: 'Ed25519',
          d: bytesToBase64Url(privateKeyBytes(kp.privateKey)),
          x: bytesToBase64Url(publicKeyBytes(kp.publicKey)),
        },
        'EdDSA',
      );
      let builder = new SignJWT(opts.claims ?? { surface_id: 's', surface_kind: 'web', label: 'b' })
        .setProtectedHeader({ alg: 'EdDSA' })
        .setSubject(opts.subject ?? kp.publicKey);
      if (opts.includeIat !== false) {
        builder = builder.setIssuedAt(opts.iat ?? 1_000_000);
      }
      return builder.sign(key);
    }

    it('rejects a credential whose sub does not match the verifying public key', async () => {
      const kp = generateUserKeypair(() => new Uint8Array(32).fill(21));
      const other = generateUserKeypair(() => new Uint8Array(32).fill(22));
      // Signed by kp's own key (so the signature verifies against kp.publicKey)
      // but the `sub` claim names a different public key entirely.
      const jwt = await signRaw(kp, { subject: other.publicKey });
      await expect(
        verifySurfaceCredential(jwt, { userPublicKey: kp.publicKey, now: 1_000_010 }),
      ).rejects.toThrow(/sub does not match user public key/);
    });

    it('rejects a credential missing surface_id', async () => {
      const kp = generateUserKeypair(() => new Uint8Array(32).fill(23));
      const jwt = await signRaw(kp, { claims: { surface_kind: 'web', label: 'b' } });
      await expect(
        verifySurfaceCredential(jwt, { userPublicKey: kp.publicKey, now: 1_000_010 }),
      ).rejects.toThrow(/surface_id missing or invalid/);
    });

    it('rejects a credential with an empty-string surface_id', async () => {
      const kp = generateUserKeypair(() => new Uint8Array(32).fill(24));
      const jwt = await signRaw(kp, {
        claims: { surface_id: '', surface_kind: 'web', label: 'b' },
      });
      await expect(
        verifySurfaceCredential(jwt, { userPublicKey: kp.publicKey, now: 1_000_010 }),
      ).rejects.toThrow(/surface_id missing or invalid/);
    });

    it('rejects a credential with a surface_kind outside SURFACE_KINDS', async () => {
      const kp = generateUserKeypair(() => new Uint8Array(32).fill(25));
      const jwt = await signRaw(kp, {
        claims: { surface_id: 's', surface_kind: 'toaster', label: 'b' },
      });
      await expect(
        verifySurfaceCredential(jwt, { userPublicKey: kp.publicKey, now: 1_000_010 }),
      ).rejects.toThrow(/surface_kind missing or invalid/);
    });

    it('rejects a credential missing surface_kind entirely', async () => {
      const kp = generateUserKeypair(() => new Uint8Array(32).fill(26));
      const jwt = await signRaw(kp, { claims: { surface_id: 's', label: 'b' } });
      await expect(
        verifySurfaceCredential(jwt, { userPublicKey: kp.publicKey, now: 1_000_010 }),
      ).rejects.toThrow(/surface_kind missing or invalid/);
    });

    it('rejects a credential missing label', async () => {
      const kp = generateUserKeypair(() => new Uint8Array(32).fill(27));
      const jwt = await signRaw(kp, { claims: { surface_id: 's', surface_kind: 'web' } });
      await expect(
        verifySurfaceCredential(jwt, { userPublicKey: kp.publicKey, now: 1_000_010 }),
      ).rejects.toThrow(/label missing or invalid/);
    });

    it('rejects a credential missing iat', async () => {
      const kp = generateUserKeypair(() => new Uint8Array(32).fill(28));
      const jwt = await signRaw(kp, {
        claims: { surface_id: 's', surface_kind: 'web', label: 'b' },
        includeIat: false,
      });
      await expect(
        verifySurfaceCredential(jwt, { userPublicKey: kp.publicKey, now: 1_000_010 }),
      ).rejects.toThrow(/iat missing/);
    });
  });
});
