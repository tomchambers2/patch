// Credential persistence. The web SPA stores its EdDSA-JWT bearer in
// localStorage under a fixed key. NO FALLBACK: if the key is absent we show
// the pairing screen — we never silently render the app without auth.
//
// DEV-only: a `?credential=<jwt>` query param immediately persists the
// credential. Useful for the test stack. Gated behind import.meta.env.DEV.

const STORAGE_KEY = 'patch.credential.v1';

/**
 * A credential must be a 3-part JWT whose payload carries a `surface_id` claim.
 * Anything else — most commonly a host *pairing code* pasted into the
 * credential box by mistake — is NOT a credential. We check the shape (not the
 * signature; the server verifies that) so we can reject garbage up front instead
 * of storing it, mounting the app, and looping forever on "invalid credential".
 */
export function isWellFormedCredential(jwt: string): boolean {
  const parts = jwt.trim().split('.');
  const rawPayload = parts[1];
  if (parts.length !== 3 || rawPayload === undefined || rawPayload.length === 0) return false;
  try {
    const payload = rawPayload.replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(atob(payload)) as { surface_id?: unknown };
    return typeof json.surface_id === 'string';
  } catch {
    return false;
  }
}

export function loadCredential(): string | null {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v === null || v.length === 0) return null;
    // Self-heal: a malformed stored value (e.g. a pasted pairing code) would
    // otherwise mount the app and flicker-loop on auth rejection. Drop it and
    // fall back to the pairing screen.
    if (!isWellFormedCredential(v)) {
      window.localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return v;
  } catch {
    return null;
  }
}

export function saveCredential(jwt: string): void {
  window.localStorage.setItem(STORAGE_KEY, jwt);
}

export function clearCredential(): void {
  window.localStorage.removeItem(STORAGE_KEY);
}

/**
 * Decode the surface identity claims carried in the stored credential JWT.
 *
 * The surface credential is the authenticated identity — the server's own
 * `requireAuth` trusts the `surface_id` claim — so the credential is the
 * canonical, always-present source of this surface's id/kind. We read it from
 * the JWT rather than `/api/auth/me`'s `surface` field, which the server only
 * populates when its in-memory registry already knows the surface and is
 * therefore not guaranteed present (Fastify omits an `undefined` value).
 *
 * No signature verification here — the server verifies on every request; this
 * is purely to read our own already-trusted claims. Returns null if no
 * credential is stored or the JWT can't be parsed.
 */
export function decodeSurfaceClaims(): {
  surfaceId: string;
  surfaceKind: string;
} | null {
  const jwt = loadCredential();
  if (!jwt) return null;
  const parts = jwt.split('.');
  const rawPayload = parts[1];
  /* v8 ignore next -- defensive only: `jwt` came from loadCredential(), which already ran isWellFormedCredential's identical 3-part-with-payload shape check and only returns non-null on success, so this guard's true branch can't be reached via the public API. */
  if (parts.length !== 3 || rawPayload === undefined) return null;
  try {
    const payload = rawPayload.replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(atob(payload)) as {
      surface_id?: unknown;
      surface_kind?: unknown;
    };
    /* v8 ignore next -- defensive only: isWellFormedCredential (run inside loadCredential() above) already required `typeof surface_id === 'string'` over this same parsed payload, so this guard's true branch can't be reached via the public API. */
    if (typeof json.surface_id !== 'string') return null;
    return {
      surfaceId: json.surface_id,
      surfaceKind: typeof json.surface_kind === 'string' ? json.surface_kind : 'web',
    };
    /* v8 ignore next 3 -- defensive only: this catch re-runs the exact atob+JSON.parse isWellFormedCredential already ran successfully over the same payload inside loadCredential() above, so it can't throw via the public API. */
  } catch {
    return null;
  }
}

/**
 * Honour `?credential=<jwt>` ONLY in dev. Strips the param from the URL after
 * persisting so a refresh doesn't replay it.
 */
export function maybeAcceptDevCredential(): string | null {
  if (!import.meta.env.DEV) {
    // Production bundles must never accept the credential query param. Make
    // the silent ignore loud so anyone testing in prod sees the warning.
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      if (url.searchParams.has('credential')) {
        console.warn(
          '[patch] ?credential= query param is dev-only and IGNORED in this production bundle. ' +
            'Pair this surface via the pairing flow instead.',
        );
      }
    }
    return null;
  }
  const url = new URL(window.location.href);
  const jwt = url.searchParams.get('credential');
  if (!jwt) return null;
  saveCredential(jwt);
  url.searchParams.delete('credential');
  window.history.replaceState({}, '', url.toString());
  return jwt;
}

/**
 * The desktop shell hands the page its credential in the URL fragment
 * (`/app/#credential=<jwt>`, spec/05 § Desktop first run): it has just made or
 * been given one and the page has nowhere else to receive it. A fragment never
 * leaves the machine, and it is taken ONLY inside the shell (`window.patch`),
 * never in a browser, where a link carrying one would sign a visitor in as
 * someone else. The fragment is removed once taken.
 */
export function acceptHandedCredential(): string | null {
  if (typeof window === 'undefined' || (window as { patch?: unknown }).patch === undefined)
    return null;
  const match = /^#credential=([A-Za-z0-9._-]+)$/.exec(window.location.hash);
  const jwt = match?.[1];
  if (!jwt) return null;
  if (!isWellFormedCredential(jwt)) {
    throw new Error('The desktop app handed over something that is not a credential');
  }
  saveCredential(jwt);
  window.history.replaceState({}, '', window.location.pathname + window.location.search);
  return jwt;
}
