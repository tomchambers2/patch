// Device-keypair generation for QR pairing (spec/10-auth.md § Surface
// linking). The unpaired phone generates its OWN Ed25519 keypair, keeps the
// private seed local (MMKV, never sent anywhere), and submits only the public
// key to the server.
//
// Crypto: @noble/ed25519 (zero-dep) seeded by expo-crypto's CSPRNG. We wire
// @noble/hashes sha512 into ed25519 so the synchronous getPublicKey codepath
// works in React Native (no node:crypto). The public key is encoded as raw
// 32-byte base64url WITHOUT padding to match the server's
// isValidEd25519PublicKey (packages/server auth-routes.ts) and the auth
// package's bytesToBase64Url (packages/auth base64url.ts).
//
// NO FALLBACK: if the CSPRNG returns the wrong number of bytes we throw rather
// than minting a weak key. The private key is generated once and reused.

import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import * as Crypto from 'expo-crypto';
import { store } from './credential';

// Wire @noble/hashes sha512 into ed25519 so the synchronous getPublicKey works
// (mirrors packages/auth/src/identity.ts — RN has no node:crypto Ed25519).
ed.etc.sha512Sync = (...m: Uint8Array[]): Uint8Array => sha512(ed.etc.concatBytes(...m));

const DEVICE_PRIVATE_KEY = 'patch.devicePrivateKey.v1';
const SEED_BYTES = 32;

export interface DeviceKeypair {
  /** Ed25519 public key, raw 32 bytes, base64url (no padding). Sent to server. */
  publicKey: string;
  /** Ed25519 32-byte private seed, base64url. NEVER leaves the device. */
  privateKey: string;
}

/** Encode raw bytes as base64url (RFC 4648 §5, no padding). */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let b64: string;
  if (typeof btoa === 'function') {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i] as number);
    }
    b64 = btoa(binary);
  } else {
    // Node test environment — Buffer is available.
    b64 = Buffer.from(bytes).toString('base64');
  }
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decode base64url (no padding) to raw bytes. */
export function base64UrlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  if (typeof atob === 'function') {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }
  const buf = Buffer.from(b64, 'base64');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function derivePublicKey(seed: Uint8Array): string {
  if (seed.length !== SEED_BYTES) {
    throw new Error(`deviceKey: expected ${SEED_BYTES}-byte seed, got ${seed.length}`);
  }
  const pub = ed.getPublicKey(seed);
  return bytesToBase64Url(pub);
}

/**
 * Return the device's Ed25519 keypair, generating + persisting it on first
 * call and reusing the stored private seed thereafter. The public key is the
 * stable device identifier sent during pairing.
 */
export function getOrCreateDeviceKeypair(): DeviceKeypair {
  const existing = store().getString(DEVICE_PRIVATE_KEY);
  if (existing && existing.length > 0) {
    const seed = base64UrlToBytes(existing);
    return { publicKey: derivePublicKey(seed), privateKey: existing };
  }
  const seed = Crypto.getRandomBytes(SEED_BYTES);
  if (seed.length !== SEED_BYTES) {
    throw new Error(
      `deviceKey: CSPRNG returned ${seed.length} bytes, expected ${SEED_BYTES} — refusing to mint a weak key`,
    );
  }
  const privateKey = bytesToBase64Url(seed);
  const publicKey = derivePublicKey(seed);
  store().set(DEVICE_PRIVATE_KEY, privateKey);
  return { publicKey, privateKey };
}
