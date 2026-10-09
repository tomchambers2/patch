import { describe, it, expect } from 'vitest';
import { generateUserKeypair, loadUserIdentity, getAccountId } from '../src/index.js';

describe('user identity', () => {
  it('generates a keypair with base64url public + private fields', () => {
    const kp = generateUserKeypair();
    expect(typeof kp.publicKey).toBe('string');
    expect(typeof kp.privateKey).toBe('string');
    // base64url of 32 bytes is 43 chars (no padding)
    expect(kp.privateKey.length).toBe(43);
    expect(kp.publicKey.length).toBe(43);
  });

  it('is deterministic given fixed entropy', () => {
    const fixed = new Uint8Array(32).fill(7);
    const a = generateUserKeypair(() => fixed);
    const b = generateUserKeypair(() => fixed);
    expect(a).toEqual(b);
  });

  it('publicKey is deterministic from privateKey', () => {
    const fixed = new Uint8Array(32).fill(11);
    const a = generateUserKeypair(() => fixed);
    const b = loadUserIdentity(a.privateKey);
    expect(b.publicKey).toBe(a.publicKey);
  });

  it('throws if randomBytes returns wrong length', () => {
    expect(() => generateUserKeypair(() => new Uint8Array(16))).toThrow(/32/);
  });

  it('getAccountId returns the public key verbatim', () => {
    const kp = generateUserKeypair();
    expect(getAccountId(kp.publicKey)).toBe(kp.publicKey);
  });

  it('loadUserIdentity rejects wrong-length seed', () => {
    expect(() => loadUserIdentity('AAAA')).toThrow(/32-byte/);
  });
});
