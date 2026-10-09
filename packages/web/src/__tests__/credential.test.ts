// decodeSurfaceClaims — reads the surface identity from the stored credential
// JWT (the authenticated identity), used by the audio session instead of the
// optional `me.surface` field. G4 regression coverage.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  decodeSurfaceClaims,
  saveCredential,
  clearCredential,
  loadCredential,
  isWellFormedCredential,
  maybeAcceptDevCredential,
  acceptHandedCredential,
} from '../lib/credential.js';

function b64url(o: unknown): string {
  return btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function jwt(payload: Record<string, unknown>): string {
  return `${b64url({ alg: 'EdDSA' })}.${b64url(payload)}.sig`;
}

describe('decodeSurfaceClaims', () => {
  beforeEach(() => clearCredential());

  it('returns null when no credential is stored', () => {
    expect(decodeSurfaceClaims()).toBeNull();
  });

  it('reads surface_id + surface_kind from the credential JWT', () => {
    saveCredential(jwt({ surface_id: 'web-7', surface_kind: 'web', sub: 'acc' }));
    expect(decodeSurfaceClaims()).toEqual({ surfaceId: 'web-7', surfaceKind: 'web' });
  });

  it('defaults surface_kind to "web" when the claim is absent', () => {
    saveCredential(jwt({ surface_id: 'web-7' }));
    expect(decodeSurfaceClaims()).toEqual({ surfaceId: 'web-7', surfaceKind: 'web' });
  });

  it('returns null for a malformed (non-3-part) token', () => {
    saveCredential('not-a-jwt');
    expect(decodeSurfaceClaims()).toBeNull();
  });

  it('returns null when the payload has no surface_id', () => {
    saveCredential(jwt({ sub: 'acc' }));
    expect(decodeSurfaceClaims()).toBeNull();
  });

  it('returns null when the payload segment is not valid base64/JSON', () => {
    // Well-formed enough to pass isWellFormedCredential's shape check is not
    // required here — saveCredential stores raw, decodeSurfaceClaims parses
    // independently and must survive a throw from atob/JSON.parse.
    saveCredential('a.!!!notbase64!!!.c');
    expect(decodeSurfaceClaims()).toBeNull();
  });
});

describe('isWellFormedCredential', () => {
  it('rejects a token with the wrong number of parts', () => {
    expect(isWellFormedCredential('only.two')).toBe(false);
    expect(isWellFormedCredential('one')).toBe(false);
  });

  it('rejects a token with an empty payload segment', () => {
    expect(isWellFormedCredential('a..c')).toBe(false);
  });

  it('rejects a token whose payload is not valid JSON', () => {
    expect(isWellFormedCredential('a.!!!notbase64!!!.c')).toBe(false);
  });

  it('rejects a token whose payload has no surface_id', () => {
    expect(isWellFormedCredential(jwt({ sub: 'acc' }))).toBe(false);
  });

  it('accepts a well-formed token', () => {
    expect(isWellFormedCredential(jwt({ surface_id: 'web-1' }))).toBe(true);
  });
});

describe('loadCredential', () => {
  beforeEach(() => clearCredential());

  it('returns null when nothing is stored', () => {
    expect(loadCredential()).toBeNull();
  });

  it('returns the stored value when well-formed', () => {
    const token = jwt({ surface_id: 'web-1' });
    saveCredential(token);
    expect(loadCredential()).toBe(token);
  });

  it('self-heals: clears + returns null for a malformed stored value', () => {
    window.localStorage.setItem('patch.credential.v1', 'garbage');
    expect(loadCredential()).toBeNull();
    expect(window.localStorage.getItem('patch.credential.v1')).toBeNull();
  });

  it('returns null if localStorage access throws', () => {
    const spy = vi.spyOn(window.localStorage.__proto__, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(loadCredential()).toBeNull();
    spy.mockRestore();
  });
});

describe('maybeAcceptDevCredential', () => {
  const originalHref = window.location.href;

  afterEach(() => {
    clearCredential();
    window.history.replaceState({}, '', originalHref);
  });

  it('in DEV: returns null when no ?credential param is present', () => {
    window.history.replaceState({}, '', '/?foo=bar');
    expect(maybeAcceptDevCredential()).toBeNull();
  });

  it('in DEV: persists + strips the ?credential param and returns the jwt', () => {
    const token = jwt({ surface_id: 'web-9' });
    window.history.replaceState({}, '', `/?credential=${encodeURIComponent(token)}&keep=1`);
    const result = maybeAcceptDevCredential();
    expect(result).toBe(token);
    expect(loadCredential()).toBe(token);
    const url = new URL(window.location.href);
    expect(url.searchParams.has('credential')).toBe(false);
    expect(url.searchParams.get('keep')).toBe('1');
  });

  it('in production: ignores the ?credential param and warns', () => {
    const token = jwt({ surface_id: 'web-9' });
    window.history.replaceState({}, '', `/?credential=${encodeURIComponent(token)}`);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('DEV', false);
    const result = maybeAcceptDevCredential();
    vi.unstubAllEnvs();
    expect(result).toBeNull();
    expect(loadCredential()).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('dev-only'));
    warnSpy.mockRestore();
  });

  it('in production: silently does nothing when no ?credential param is present', () => {
    window.history.replaceState({}, '', '/?foo=bar');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('DEV', false);
    const result = maybeAcceptDevCredential();
    vi.unstubAllEnvs();
    expect(result).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('acceptHandedCredential (the desktop shell hands over its credential, spec/05 § Desktop first run)', () => {
  const originalHref = window.location.href;
  const token = jwt({ surface_id: 'desk-1' });
  const withShell = (): void => {
    (window as unknown as { patch?: unknown }).patch = {};
  };

  afterEach(() => {
    clearCredential();
    delete (window as unknown as { patch?: unknown }).patch;
    window.history.replaceState({}, '', originalHref);
  });

  it('inside the shell: keeps the credential in the fragment and removes it from the address', () => {
    withShell();
    window.history.replaceState({}, '', `/app/?x=1#credential=${token}`);
    expect(acceptHandedCredential()).toBe(token);
    expect(loadCredential()).toBe(token);
    expect(window.location.hash).toBe('');
    expect(window.location.pathname + window.location.search).toBe('/app/?x=1');
  });

  it('in a browser: ignores it — a link must not be able to sign a visitor in as someone else', () => {
    window.history.replaceState({}, '', `/app/#credential=${token}`);
    expect(acceptHandedCredential()).toBeNull();
    expect(loadCredential()).toBeNull();
    expect(window.location.hash).toBe(`#credential=${token}`);
  });

  it('inside the shell with no fragment: nothing happens', () => {
    withShell();
    window.history.replaceState({}, '', '/app/');
    expect(acceptHandedCredential()).toBeNull();
  });

  it('refuses a fragment that is not a credential, loudly', () => {
    withShell();
    window.history.replaceState({}, '', '/app/#credential=abc.def');
    expect(() => acceptHandedCredential()).toThrow(/not a credential/);
    expect(loadCredential()).toBeNull();
  });

  it('ignores any other fragment', () => {
    withShell();
    window.history.replaceState({}, '', '/app/#other=1');
    expect(acceptHandedCredential()).toBeNull();
    expect(window.location.hash).toBe('#other=1');
  });
});
