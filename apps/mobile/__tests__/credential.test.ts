import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadCredential,
  saveCredential,
  clearCredential,
  setIdentity,
  loadAccountId,
  decodeSurfaceClaims,
} from '../src/lib/credential';

beforeEach(() => {
  clearCredential();
});

// Build a fake JWT (header.payload.signature) with a base64url-encoded payload,
// exactly as the real surface credential is shaped. The signature is never
// checked by decodeSurfaceClaims (the server verifies on every request), so a
// throwaway value is fine.
function b64url(obj: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(obj), 'utf8')
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function jwt(payload: Record<string, unknown>): string {
  return `${b64url({ alg: 'EdDSA' })}.${b64url(payload)}.sig`;
}

describe('credential', () => {
  it('round-trips a JWT', () => {
    expect(loadCredential()).toBeNull();
    saveCredential('eyJhbGciOiJFZERTQSJ9.test.sig');
    expect(loadCredential()).toBe('eyJhbGciOiJFZERTQSJ9.test.sig');
  });

  it('refuses to persist empty', () => {
    expect(() => saveCredential('')).toThrow();
  });

  it('clearCredential wipes identity', () => {
    saveCredential('jwt');
    setIdentity('acct-1', 'surf-1');
    expect(loadAccountId()).toBe('acct-1');
    clearCredential();
    expect(loadCredential()).toBeNull();
    expect(loadAccountId()).toBeNull();
  });
});

// The surface credential is the always-present, INSTANT source of this device's
// identity — decoded locally with no network round-trip (spec/15 § Settings →
// Account). Regression guard: identity must paint on first render from the JWT
// claims, and garbage must decode to null (never a partial/guessed identity).
describe('decodeSurfaceClaims', () => {
  it('returns null when no credential is stored', () => {
    expect(decodeSurfaceClaims()).toBeNull();
  });

  it('decodes surface_id / surface_kind / label and maps sub -> accountId', () => {
    saveCredential(
      jwt({
        sub: 'acct-pubkey-123',
        surface_id: 'surf-abc',
        surface_kind: 'desktop',
        label: 'Studio Mac',
      }),
    );
    expect(decodeSurfaceClaims()).toEqual({
      accountId: 'acct-pubkey-123',
      surfaceId: 'surf-abc',
      surfaceKind: 'desktop',
      label: 'Studio Mac',
    });
  });

  it('defaults surfaceKind to "mobile" and label to "" when those claims are absent', () => {
    saveCredential(jwt({ sub: 'acct-1', surface_id: 'surf-1' }));
    expect(decodeSurfaceClaims()).toEqual({
      accountId: 'acct-1',
      surfaceId: 'surf-1',
      surfaceKind: 'mobile',
      label: '',
    });
  });

  it('returns null when the required surface_id / sub claims are missing or wrong-typed', () => {
    saveCredential(jwt({ sub: 'acct-1' })); // no surface_id
    expect(decodeSurfaceClaims()).toBeNull();
    clearCredential();
    saveCredential(jwt({ surface_id: 'surf-1' })); // no sub
    expect(decodeSurfaceClaims()).toBeNull();
    clearCredential();
    saveCredential(jwt({ sub: 123, surface_id: 'surf-1' })); // sub not a string
    expect(decodeSurfaceClaims()).toBeNull();
  });

  it('returns null on garbage — not a 3-part JWT / undecodable payload', () => {
    saveCredential('not-a-jwt');
    expect(decodeSurfaceClaims()).toBeNull();
    clearCredential();
    saveCredential('only.two');
    expect(decodeSurfaceClaims()).toBeNull();
    clearCredential();
    saveCredential('aaa.!!!not-base64!!!.sig');
    expect(decodeSurfaceClaims()).toBeNull();
  });
});
