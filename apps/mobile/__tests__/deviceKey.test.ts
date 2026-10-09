import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getOrCreateDeviceKeypair, bytesToBase64Url, base64UrlToBytes } from '../src/lib/deviceKey';
import { store } from '../src/lib/credential';
import * as Crypto from 'expo-crypto';

// Mirror the server's packages/server/src/auth-routes.ts isValidEd25519PublicKey:
// base64url alphabet, no padding, decodes to exactly 32 bytes.
function isValidEd25519PublicKey(s: string): boolean {
  if (typeof s !== 'string' || s.length === 0 || s.length > 100) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return false;
  const bytes = Buffer.from(s, 'base64url');
  return bytes.length === 32;
}

beforeEach(() => {
  store().delete('patch.devicePrivateKey.v1');
});

describe('deviceKey', () => {
  it('base64url round-trips arbitrary bytes (no padding)', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const encoded = bytesToBase64Url(bytes);
    expect(encoded).not.toContain('=');
    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('/');
    expect(Array.from(base64UrlToBytes(encoded))).toEqual(Array.from(bytes));
  });

  it('encodes the public key the way the server validates it', () => {
    const { publicKey } = getOrCreateDeviceKeypair();
    expect(isValidEd25519PublicKey(publicKey)).toBe(true);
    // 32 raw bytes.
    expect(base64UrlToBytes(publicKey).length).toBe(32);
  });

  it('private seed is a 32-byte base64url value, distinct from the public key', () => {
    const { publicKey, privateKey } = getOrCreateDeviceKeypair();
    expect(base64UrlToBytes(privateKey).length).toBe(32);
    expect(privateKey).not.toBe(publicKey);
  });

  it('is stable across calls — generates once, reuses thereafter', () => {
    const a = getOrCreateDeviceKeypair();
    const b = getOrCreateDeviceKeypair();
    expect(b.publicKey).toBe(a.publicKey);
    expect(b.privateKey).toBe(a.privateKey);
  });

  it('generates a fresh key after the stored seed is cleared', () => {
    const a = getOrCreateDeviceKeypair();
    store().delete('patch.devicePrivateKey.v1');
    const b = getOrCreateDeviceKeypair();
    expect(b.publicKey).not.toBe(a.publicKey);
  });

  it('persists the private seed in MMKV under patch.devicePrivateKey.v1', () => {
    const { privateKey } = getOrCreateDeviceKeypair();
    expect(store().getString('patch.devicePrivateKey.v1')).toBe(privateKey);
  });

  it('throws (NO FALLBACK) when the CSPRNG returns the wrong number of bytes', () => {
    vi.spyOn(Crypto, 'getRandomBytes').mockReturnValueOnce(new Uint8Array(16));
    expect(() => getOrCreateDeviceKeypair()).toThrow(/CSPRNG returned 16 bytes/);
  });

  it('throws when a corrupted stored seed decodes to the wrong length', () => {
    // A valid base64url string that is NOT 32 bytes once decoded — simulates
    // on-disk corruption of the persisted seed.
    store().set('patch.devicePrivateKey.v1', bytesToBase64Url(new Uint8Array(10)));
    expect(() => getOrCreateDeviceKeypair()).toThrow(/expected 32-byte seed, got 10/);
  });

  describe('base64 encode/decode — Buffer fallback (no global atob/btoa)', () => {
    let prevBtoa: typeof btoa | undefined;
    let prevAtob: typeof atob | undefined;
    beforeEach(() => {
      prevBtoa = globalThis.btoa;
      prevAtob = globalThis.atob;
      // @ts-expect-error — simulating a Hermes/RN runtime with no atob/btoa.
      delete globalThis.btoa;
      // @ts-expect-error — simulating a Hermes/RN runtime with no atob/btoa.
      delete globalThis.atob;
    });
    afterEach(() => {
      globalThis.btoa = prevBtoa!;
      globalThis.atob = prevAtob!;
    });

    it('bytesToBase64Url falls back to Buffer', () => {
      const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
      expect(bytesToBase64Url(bytes)).toBe(Buffer.from(bytes).toString('base64url'));
    });

    it('base64UrlToBytes falls back to Buffer', () => {
      const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
      const encoded = bytesToBase64Url(bytes);
      expect(Array.from(base64UrlToBytes(encoded))).toEqual(Array.from(bytes));
    });
  });
});
