import { describe, it, expect } from 'vitest';
import { RevocationStore } from '../src/index.js';

describe('RevocationStore', () => {
  it('marks a surface revoked', () => {
    const s = new RevocationStore();
    expect(s.isRevoked('srf-1')).toBe(false);
    s.revoke('srf-1');
    expect(s.isRevoked('srf-1')).toBe(true);
  });

  it('is idempotent', () => {
    const s = new RevocationStore();
    s.revoke('srf-1');
    s.revoke('srf-1');
    expect(s.size()).toBe(1);
  });

  it('does not affect other surfaces', () => {
    const s = new RevocationStore();
    s.revoke('a');
    expect(s.isRevoked('a')).toBe(true);
    expect(s.isRevoked('b')).toBe(false);
  });

  it('rejects empty surfaceId', () => {
    const s = new RevocationStore();
    expect(() => s.revoke('')).toThrow();
  });

  it('clear() wipes all revoked state', () => {
    const s = new RevocationStore();
    s.revoke('a');
    s.revoke('b');
    expect(s.size()).toBe(2);
    s.clear();
    expect(s.size()).toBe(0);
    expect(s.isRevoked('a')).toBe(false);
    expect(s.isRevoked('b')).toBe(false);
  });
});
