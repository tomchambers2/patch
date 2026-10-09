import { describe, it, expect } from 'vitest';
import { SignJWT, importJWK } from 'jose';
import {
  generateUserKeypair,
  mintDaemonKey,
  verifyDaemonKey,
  CredentialVerificationError,
} from '../src/index.js';
import { bytesToBase64Url } from '../src/base64url.js';
import { privateKeyBytes, publicKeyBytes } from '../src/identity.js';

// Sign a raw daemon-key JWT with arbitrary claims/subject, bypassing
// mintDaemonKey, so we can exercise verifyDaemonKey's individual
// field-validation branches that the real mint API can never produce.
async function signRawDaemonKey(
  kp: { privateKey: string; publicKey: string },
  opts: {
    subject?: string;
    claims?: Record<string, unknown>;
    includeIat?: boolean;
    iat?: number;
  } = {},
): Promise<string> {
  const key = await importJWK(
    {
      kty: 'OKP',
      crv: 'Ed25519',
      d: bytesToBase64Url(privateKeyBytes(kp.privateKey)),
      x: bytesToBase64Url(publicKeyBytes(kp.publicKey)),
    },
    'EdDSA',
  );
  let builder = new SignJWT(opts.claims ?? { daemon_id: 'd', label: 'l', kind: 'daemon' })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setSubject(opts.subject ?? kp.publicKey);
  if (opts.includeIat !== false) {
    builder = builder.setIssuedAt(opts.iat ?? 1_000_000);
  }
  return builder.sign(key);
}

describe('host key', () => {
  it('mints + verifies a host credential', async () => {
    const kp = generateUserKeypair(() => new Uint8Array(32).fill(9));
    const cred = await mintDaemonKey({
      userPrivateKey: kp.privateKey,
      daemonId: 'd-1',
      label: 'hetzner-1',
    });
    const claims = await verifyDaemonKey(cred, { userPublicKey: kp.publicKey });
    expect(claims.daemon_id).toBe('d-1');
    expect(claims.kind).toBe('daemon');
    expect(claims.label).toBe('hetzner-1');
    expect(claims.sub).toBe(kp.publicKey);
  });

  it('rejects wrong key', async () => {
    const a = generateUserKeypair(() => new Uint8Array(32).fill(10));
    const b = generateUserKeypair(() => new Uint8Array(32).fill(11));
    const cred = await mintDaemonKey({
      userPrivateKey: a.privateKey,
      daemonId: 'd-2',
      label: 'box',
    });
    await expect(verifyDaemonKey(cred, { userPublicKey: b.publicKey })).rejects.toBeInstanceOf(
      CredentialVerificationError,
    );
  });

  it('rejects a credential whose sub does not match the verifying public key', async () => {
    const kp = generateUserKeypair(() => new Uint8Array(32).fill(12));
    const other = generateUserKeypair(() => new Uint8Array(32).fill(13));
    const jwt = await signRawDaemonKey(kp, { subject: other.publicKey });
    await expect(verifyDaemonKey(jwt, { userPublicKey: kp.publicKey })).rejects.toThrow(
      /sub does not match user public key/,
    );
  });

  it('rejects a credential whose kind is not "daemon"', async () => {
    const kp = generateUserKeypair(() => new Uint8Array(32).fill(14));
    const jwt = await signRawDaemonKey(kp, {
      claims: { daemon_id: 'd', label: 'l', kind: 'surface' },
    });
    await expect(verifyDaemonKey(jwt, { userPublicKey: kp.publicKey })).rejects.toThrow(
      /kind is not "daemon"/,
    );
  });

  it('rejects a credential missing daemon_id', async () => {
    const kp = generateUserKeypair(() => new Uint8Array(32).fill(15));
    const jwt = await signRawDaemonKey(kp, { claims: { label: 'l', kind: 'daemon' } });
    await expect(verifyDaemonKey(jwt, { userPublicKey: kp.publicKey })).rejects.toThrow(
      /daemon_id missing/,
    );
  });

  it('rejects a credential with an empty-string daemon_id', async () => {
    const kp = generateUserKeypair(() => new Uint8Array(32).fill(16));
    const jwt = await signRawDaemonKey(kp, {
      claims: { daemon_id: '', label: 'l', kind: 'daemon' },
    });
    await expect(verifyDaemonKey(jwt, { userPublicKey: kp.publicKey })).rejects.toThrow(
      /daemon_id missing/,
    );
  });

  it('rejects a credential missing label', async () => {
    const kp = generateUserKeypair(() => new Uint8Array(32).fill(17));
    const jwt = await signRawDaemonKey(kp, { claims: { daemon_id: 'd', kind: 'daemon' } });
    await expect(verifyDaemonKey(jwt, { userPublicKey: kp.publicKey })).rejects.toThrow(
      /label missing/,
    );
  });

  it('rejects a credential missing iat', async () => {
    const kp = generateUserKeypair(() => new Uint8Array(32).fill(18));
    const jwt = await signRawDaemonKey(kp, {
      claims: { daemon_id: 'd', label: 'l', kind: 'daemon' },
      includeIat: false,
    });
    await expect(verifyDaemonKey(jwt, { userPublicKey: kp.publicKey })).rejects.toThrow(
      /iat missing/,
    );
  });

  it('mints + verifies using the real wall clock when `now` is omitted', async () => {
    const kp = generateUserKeypair(() => new Uint8Array(32).fill(19));
    const cred = await mintDaemonKey({
      userPrivateKey: kp.privateKey,
      daemonId: 'd-realtime',
      label: 'box',
    });
    const claims = await verifyDaemonKey(cred, { userPublicKey: kp.publicKey });
    expect(claims.daemon_id).toBe('d-realtime');
  });

  it('verifies against an explicit injected `now` (test-clock branch)', async () => {
    const kp = generateUserKeypair(() => new Uint8Array(32).fill(29));
    const cred = await mintDaemonKey({
      userPrivateKey: kp.privateKey,
      daemonId: 'd-clock',
      label: 'box',
      now: 1_000_000,
    });
    const claims = await verifyDaemonKey(cred, { userPublicKey: kp.publicKey, now: 1_000_010 });
    expect(claims.daemon_id).toBe('d-clock');
    expect(claims.iat).toBe(1_000_000);
  });
});
