// CLI auth: identity loading + QR-pairing bootstrap.
//
// Identity lives at ~/.patch/identity.key (32-byte Ed25519 seed, base64url).
// The signed JWT lives at ~/.patch/credential.jwt and is presented as a
// Bearer token on REST and /ws.
//
// NO FALLBACKS — missing identity, malformed seed, expired/revoked
// credentials all surface immediately.

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { generateUserKeypair, loadUserIdentity, type UserKeypair } from '@patch/auth';
import {
  configHomeDir,
  credentialFilePath,
  identityFilePath,
  type ResolvedConfig,
} from './config.js';

export interface CliIdentity {
  keypair: UserKeypair;
  credential: string | null;
}

export class MissingIdentityError extends Error {
  constructor() {
    super('no identity at ' + identityFilePath() + ' — run `patch auth login` first');
    this.name = 'MissingIdentityError';
  }
}

export class MissingCredentialError extends Error {
  constructor() {
    super('no credential at ' + credentialFilePath() + ' — run `patch auth login`');
    this.name = 'MissingCredentialError';
  }
}

export class CredentialMissingError extends Error {
  constructor() {
    super('no credential at ' + credentialFilePath() + ' — run `patch auth login`');
    this.name = 'CredentialMissingError';
  }
}

export class CredentialCorruptError extends Error {
  constructor(detail: string) {
    super('credential at ' + credentialFilePath() + ' is unreadable/malformed: ' + detail);
    this.name = 'CredentialCorruptError';
  }
}

export class CredentialExpiredError extends Error {
  readonly expiredAtIso: string;
  constructor(expiredAtIso: string) {
    super('credential expired at ' + expiredAtIso + ' — re-run `patch auth login`');
    this.name = 'CredentialExpiredError';
    this.expiredAtIso = expiredAtIso;
  }
}

export function ensureConfigDir(): void {
  const dir = configHomeDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function readIdentity(): UserKeypair {
  const path = identityFilePath();
  if (!existsSync(path)) throw new MissingIdentityError();
  const raw = readFileSync(path, 'utf8').trim();
  return loadUserIdentity(raw);
}

export function writeIdentity(kp: UserKeypair): void {
  ensureConfigDir();
  const path = identityFilePath();
  writeFileSync(path, kp.privateKey + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function readCredential(): string {
  const path = credentialFilePath();
  if (!existsSync(path)) throw new MissingCredentialError();
  return readFileSync(path, 'utf8').trim();
}

export function writeCredential(jwt: string): void {
  ensureConfigDir();
  const path = credentialFilePath();
  writeFileSync(path, jwt + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Load identity (creating if missing) — only for the QR bootstrap flow. */
export function loadOrCreateIdentity(): UserKeypair {
  const path = identityFilePath();
  if (existsSync(path)) return readIdentity();
  ensureConfigDir();
  const fresh = generateUserKeypair();
  // Persist as a file. We persist the private seed (NOT the public key);
  // public key is re-derivable on each load.
  writeFileSync(dirname(path) === '.' ? path : path, fresh.privateKey + '\n', {
    mode: 0o600,
  });
  chmodSync(path, 0o600);
  return fresh;
}

/** Authoritative bearer token for HTTP/WS. NO FALLBACK — missing = throw. */
export function bearerToken(): string {
  const path = credentialFilePath();
  if (!existsSync(path)) throw new CredentialMissingError();
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8').trim();
  } catch (err) {
    throw new CredentialCorruptError((err as Error).message);
  }
  if (raw.length === 0) throw new CredentialCorruptError('empty file');
  // Sanity-check the JWT shape (3 dot-separated base64url segments).
  const parts = raw.split('.');
  if (parts.length !== 3) {
    throw new CredentialCorruptError('not a JWT (expected 3 dot-separated segments)');
  }
  // Parse the payload to check exp.
  let payload: Record<string, unknown>;
  try {
    const seg = parts[1];
    if (seg === undefined) throw new Error('missing payload segment');
    payload = JSON.parse(Buffer.from(seg, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch (err) {
    throw new CredentialCorruptError('payload not valid JSON: ' + (err as Error).message);
  }
  const exp = payload['exp'];
  if (typeof exp === 'number') {
    const nowSec = Math.floor(Date.now() / 1000);
    if (exp < nowSec) {
      throw new CredentialExpiredError(new Date(exp * 1000).toISOString());
    }
  }
  return raw;
}

/** Convenience: pull identity + credential together. */
export function loadCliIdentity(): CliIdentity {
  return {
    keypair: readIdentity(),
    credential: existsSync(credentialFilePath()) ? readCredential() : null,
  };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _typeAnchor(_cfg: ResolvedConfig): void {
  // keep the ResolvedConfig import edge so consumers see the type re-exported.
}
