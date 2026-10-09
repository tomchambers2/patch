// Local credential persistence using MMKV. Mirrors the web `credential.ts`
// module shape so the rest of the app reads the same way. NO FALLBACK: if
// MMKV fails to initialise we throw — losing the credential silently
// breaks pairing in non-obvious ways.

import { MMKV } from 'react-native-mmkv';

const STORAGE_KEY = 'patch.credential.v1';
const ACCOUNT_KEY = 'patch.accountId.v1';
const SURFACE_KEY = 'patch.surfaceId.v1';
/**
 * The chat-list read cache (`chatListCache.ts`). Declared here, with the other
 * account-scoped keys, so `clearCredential` clears it in the same pass —
 * deactivating a surface must not leave the previous account's chat titles on
 * disk to be painted on the next launch. `chatListCache.ts` imports it rather
 * than re-declaring it; the dependency runs one way only (cache -> credential).
 */
export const CHAT_LIST_KEY = 'patch.chatList.v1';

let _store: MMKV | null = null;

export function store(): MMKV {
  if (!_store) {
    _store = new MMKV({ id: 'patch.mobile' });
  }
  return _store;
}

export function loadCredential(): string | null {
  const v = store().getString(STORAGE_KEY);
  return v && v.length > 0 ? v : null;
}

export function saveCredential(jwt: string): void {
  if (!jwt || jwt.length === 0) {
    throw new Error('saveCredential: refusing to persist empty credential');
  }
  store().set(STORAGE_KEY, jwt);
}

export function clearCredential(): void {
  store().delete(STORAGE_KEY);
  store().delete(ACCOUNT_KEY);
  store().delete(SURFACE_KEY);
  store().delete(CHAT_LIST_KEY);
}

export function setIdentity(accountId: string, surfaceId: string): void {
  store().set(ACCOUNT_KEY, accountId);
  store().set(SURFACE_KEY, surfaceId);
}

export function loadAccountId(): string | null {
  const v = store().getString(ACCOUNT_KEY);
  return v ?? null;
}

export interface SurfaceClaims {
  /** The account id — which IS the account public key (registry.ts: accountId === userPublicKey). */
  accountId: string;
  surfaceId: string;
  surfaceKind: string;
  label: string;
}

/**
 * Decode this surface's identity claims from the stored credential JWT, WITHOUT
 * a network round-trip. The surface credential is the authenticated identity —
 * the server trusts its `surface_id`/`sub` claims — so it is the canonical,
 * always-present, INSTANT source of this device's id/kind/label and the account
 * id (spec/15 § Settings → Account: identity paints on first render, `/api/auth/me`
 * is only a background refresh). No signature check here (the server verifies on
 * every request); this reads our own already-trusted claims. Returns null if no
 * credential is stored or the JWT can't be parsed.
 */
export function decodeSurfaceClaims(): SurfaceClaims | null {
  const jwt = loadCredential();
  if (!jwt) return null;
  const parts = jwt.split('.');
  const rawPayload = parts[1];
  if (parts.length !== 3 || rawPayload === undefined || rawPayload.length === 0) return null;
  try {
    const b64 = rawPayload.replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(atob(b64)) as {
      sub?: unknown;
      surface_id?: unknown;
      surface_kind?: unknown;
      label?: unknown;
    };
    if (typeof json.surface_id !== 'string' || typeof json.sub !== 'string') return null;
    return {
      accountId: json.sub,
      surfaceId: json.surface_id,
      surfaceKind: typeof json.surface_kind === 'string' ? json.surface_kind : 'mobile',
      label: typeof json.label === 'string' ? json.label : '',
    };
  } catch {
    return null;
  }
}
