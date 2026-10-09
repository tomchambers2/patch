// CredentialBindingError is not thrown from within @patch/auth itself — it's
// a typed error the SERVER constructs (packages/server/src/auth-routes.ts)
// when a pairing-flow credential's bindings don't match the completing
// request. Direct unit test since no in-package code path instantiates it.

import { describe, it, expect } from 'vitest';
import { CredentialBindingError, CredentialExpiredError, AuthError } from '../src/index.js';

describe('CredentialBindingError', () => {
  it('carries the reason in its message and is a named AuthError', () => {
    const err = new CredentialBindingError('surface_pubkey mismatch');
    expect(err).toBeInstanceOf(AuthError);
    expect(err.name).toBe('CredentialBindingError');
    expect(err.message).toBe('Pairing credential binding failed: surface_pubkey mismatch');
  });
});

describe('CredentialExpiredError', () => {
  it('omits the exp value from the message when constructed without one', () => {
    // jwt.ts always supplies jose's reported payload.exp, but the type keeps
    // this optional for callers that only know "it's expired", not by when.
    const err = new CredentialExpiredError(undefined);
    expect(err.message).toBe('Surface credential expired');
    expect(err.exp).toBeUndefined();
  });
});
