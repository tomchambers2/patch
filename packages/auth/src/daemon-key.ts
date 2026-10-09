// Host registration credential. Same EdDSA-JWT shape as a surface
// credential, but with `surface_kind: 'daemon'` (out-of-band of SurfaceKind —
// hosts are not surfaces). Persisted by the host at ~/.patch/daemon.key
// (group 5 owns the file write).

import { SignJWT, jwtVerify, importJWK } from 'jose';
import { loadUserIdentity, privateKeyBytes, publicKeyBytes } from './identity.js';
import { bytesToBase64Url } from './base64url.js';
import { CredentialVerificationError } from './errors.js';

export interface DaemonKeyClaims {
  sub: string;
  daemon_id: string;
  label: string;
  kind: 'daemon';
  iat: number;
}

export interface MintDaemonKeyOptions {
  userPrivateKey: string;
  daemonId: string;
  label: string;
  now?: number;
}

export async function mintDaemonKey(opts: MintDaemonKeyOptions): Promise<string> {
  const { publicKey } = loadUserIdentity(opts.userPrivateKey);
  const key = await importJWK(
    {
      kty: 'OKP',
      crv: 'Ed25519',
      d: bytesToBase64Url(privateKeyBytes(opts.userPrivateKey)),
      x: bytesToBase64Url(publicKeyBytes(publicKey)),
    },
    'EdDSA',
  );

  const iat = opts.now ?? Math.floor(Date.now() / 1000);

  return new SignJWT({
    daemon_id: opts.daemonId,
    label: opts.label,
    kind: 'daemon',
  })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setSubject(publicKey)
    .setIssuedAt(iat)
    .sign(key);
}

export async function verifyDaemonKey(
  credential: string,
  opts: { userPublicKey: string; now?: number },
): Promise<DaemonKeyClaims> {
  const key = await importJWK(
    { kty: 'OKP', crv: 'Ed25519', x: bytesToBase64Url(publicKeyBytes(opts.userPublicKey)) },
    'EdDSA',
  );

  let payload;
  try {
    const result = await jwtVerify(credential, key, {
      algorithms: ['EdDSA'],
      currentDate: opts.now !== undefined ? new Date(opts.now * 1000) : undefined,
    });
    payload = result.payload;
  } catch (err) {
    throw new CredentialVerificationError((err as Error).message);
  }

  if (payload.sub !== opts.userPublicKey) {
    throw new CredentialVerificationError('sub does not match user public key');
  }
  if (payload['kind'] !== 'daemon') {
    throw new CredentialVerificationError('kind is not "daemon"');
  }
  const daemonId = payload['daemon_id'];
  const label = payload['label'];
  if (typeof daemonId !== 'string' || daemonId.length === 0) {
    throw new CredentialVerificationError('daemon_id missing');
  }
  if (typeof label !== 'string') {
    throw new CredentialVerificationError('label missing');
  }
  if (typeof payload.iat !== 'number') {
    throw new CredentialVerificationError('iat missing');
  }

  return {
    sub: payload.sub,
    daemon_id: daemonId,
    label,
    kind: 'daemon',
    iat: payload.iat,
  };
}
