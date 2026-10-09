// Mobile runtime config. NO server address is built into the app: where this
// device talks to is whatever the pairing code it scanned said (spec/05 §
// Canonical QR payload), kept as its route. Until one is scanned there is no
// server, and asking for one throws rather than quietly aiming at somewhere.
//
// A route is either a server reached directly, or one reached through a relay
// (spec/10 § Relay). For a relayed route every request is made against a
// placeholder origin that `lib/relayTransport.ts` recognises and carries through
// the encrypted session instead of the network; nothing else in the app knows.

import type { PairingRelay } from '@patch/wire';
import { store } from './lib/credential';

const ROUTE_KEY = 'patch.route.v1';

/** The origin a relayed route's requests are addressed to. It never resolves; the transport intercepts it. */
export const RELAY_ORIGIN = 'https://relay.patch.invalid';

export type ServerRoute = { kind: 'direct'; url: string } | { kind: 'relay'; relay: PairingRelay };

export function getRoute(): ServerRoute | null {
  const raw = store().getString(ROUTE_KEY);
  if (!raw) return null;
  return JSON.parse(raw) as ServerRoute;
}

/**
 * Where this device talks to from now on. NO FALLBACK on the address: anything
 * that is not an http(s) origin throws instead of producing dead URLs.
 */
export function setRoute(route: ServerRoute): void {
  if (route.kind === 'direct') {
    const trimmed = route.url.trim().replace(/\/$/, '');
    if (!trimmed.startsWith('https://') && !trimmed.startsWith('http://')) {
      throw new Error(`Server address must start with http:// or https://, got: ${trimmed}`);
    }
    store().set(ROUTE_KEY, JSON.stringify({ kind: 'direct', url: trimmed }));
    return;
  }
  store().set(ROUTE_KEY, JSON.stringify(route));
}

export function clearRoute(): void {
  store().delete(ROUTE_KEY);
}

/** The origin requests are addressed to: the server itself, or the relay placeholder. */
export function getServerUrl(): string {
  const route = getRoute();
  if (route === null) throw new Error('This device is not paired to a server yet');
  return route.kind === 'direct' ? route.url : RELAY_ORIGIN;
}

export function wsUrl(): string {
  // Flip http→ws / https→wss. Server WS is at /ws.
  const base = getServerUrl();
  if (base.startsWith('https://')) return `wss://${base.slice('https://'.length)}/ws`;
  if (base.startsWith('http://')) return `ws://${base.slice('http://'.length)}/ws`;
  throw new Error(`Server address has unknown scheme: ${base}`);
}

export function apiUrl(path: string): string {
  if (!path.startsWith('/')) throw new Error(`apiUrl path must start with /, got: ${path}`);
  return `${getServerUrl().replace(/\/$/, '')}${path}`;
}

// Base for the host audio plane (the per-session `/audio/<sessionId>` WSS).
//
// In production the host audio plane is reached SAME-ORIGIN through Caddy
// (which proxies `/audio` to the host), so the default derives from the
// current server URL. In local dev the audio plane is a DIRECT host port
// (3013) that Caddy/the server do NOT proxy, so EXPO_PUBLIC_PATCH_AUDIO_URL can
// point straight at it (e.g. http://localhost:3013 reached via adb-reverse).
// NO FALLBACK on scheme: an unknown scheme throws rather than silently
// producing a dead ws URL.
function audioBase(): string {
  return (
    (typeof process !== 'undefined' ? process.env['EXPO_PUBLIC_PATCH_AUDIO_URL'] : undefined) ??
    getServerUrl()
  );
}

/** Resolve a server-returned relative `/audio/<sessionId>` path to an absolute ws(s) URL. */
export function audioWsUrl(path: string): string {
  if (!path.startsWith('/')) throw new Error(`audioWsUrl path must start with /, got: ${path}`);
  const base = audioBase().replace(/\/$/, '');
  if (base.startsWith('https://')) return `wss://${base.slice('https://'.length)}${path}`;
  if (base.startsWith('http://')) return `ws://${base.slice('http://'.length)}${path}`;
  throw new Error(`AUDIO_BASE has unknown scheme: ${base}`);
}

/** How this device reaches its server, for people: the host, or the relay it goes through. */
export function routeLabel(): string {
  const route = getRoute();
  if (route === null) return 'not paired';
  if (route.kind === 'direct') return route.url.replace(/^https?:\/\//, '');
  return `through ${route.relay.url.replace(/^wss?:\/\//, '')}`;
}
