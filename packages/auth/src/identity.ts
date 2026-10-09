// User identity: Ed25519 keypair. Public key IS the stable account ID.
//
// Spec: 10-auth.md "User identity". Crypto via @noble/ed25519 + @noble/hashes
// per 18-tech-stack.md "Auth crypto" — no node:crypto Ed25519.

import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { randomBytes as nobleRandomBytes } from '@noble/hashes/utils';
import { base64UrlToBytes, bytesToBase64Url } from './base64url.js';

// Wire @noble/hashes sha512 into ed25519 so the synchronous codepaths work
// (jose only needs the keys, not the noble sign/verify, but tests rely on it).
ed.etc.sha512Sync = (...m: Uint8Array[]): Uint8Array => sha512(ed.etc.concatBytes(...m));

export type RandomBytesFn = (length: number) => Uint8Array;

export interface UserKeypair {
  /** Ed25519 public key, base64url. The account identifier. */
  publicKey: string;
  /** Ed25519 32-byte private seed, base64url. */
  privateKey: string;
}

/**
 * Generate a fresh Ed25519 keypair. Pass a deterministic `randomBytes`
 * for tests (the function is honoured exactly — no fallback if the seed
 * is the wrong length).
 */
export function generateUserKeypair(randomBytes: RandomBytesFn = nobleRandomBytes): UserKeypair {
  const seed = randomBytes(32);
  if (seed.length !== 32) {
    throw new Error(`generateUserKeypair: randomBytes returned ${seed.length} bytes, expected 32`);
  }
  const pub = ed.getPublicKey(seed);
  return {
    publicKey: bytesToBase64Url(pub),
    privateKey: bytesToBase64Url(seed),
  };
}

/**
 * Re-derive the public key from a stored private seed.
 */
export function loadUserIdentity(privateKey: string): UserKeypair {
  const seed = base64UrlToBytes(privateKey);
  if (seed.length !== 32) {
    throw new Error(`loadUserIdentity: expected 32-byte private seed, got ${seed.length} bytes`);
  }
  const pub = ed.getPublicKey(seed);
  return {
    publicKey: bytesToBase64Url(pub),
    privateKey,
  };
}

/**
 * The account ID IS the public key. Defined as a function so callers
 * can be explicit about intent at the call site.
 */
export function getAccountId(publicKey: string): string {
  return publicKey;
}

/** Internal: get raw bytes from a base64url private seed. */
export function privateKeyBytes(privateKey: string): Uint8Array {
  return base64UrlToBytes(privateKey);
}

/** Internal: get raw bytes from a base64url public key. */
export function publicKeyBytes(publicKey: string): Uint8Array {
  return base64UrlToBytes(publicKey);
}
