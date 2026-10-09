// Files the server serves, for the parts of the app that need a URL a native
// component can open (an Image, a WebView, the OS). On a direct route that is
// the server's own URL. On a relayed route (spec/10 § Relay) there is no such
// URL — the server is only reachable through the tunnel `fetch` carries — so the
// file is fetched through it into the cache and the local file is what is shown.

import React from 'react';
import * as FileSystem from 'expo-file-system';
import { toBase64Url } from '@patch/relay';
import { getRoute } from '../config';

/** True when this device reaches its server through a relay. */
export function isRelayed(): boolean {
  return getRoute()?.kind === 'relay';
}

const copies = new Map<string, Promise<string>>();

function standardBase64(bytes: Uint8Array): string {
  const url = toBase64Url(bytes);
  return url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (url.length % 4)) % 4);
}

function cacheName(url: string): string {
  let h = 5381;
  for (let i = 0; i < url.length; i++) h = ((h << 5) + h + url.charCodeAt(i)) | 0;
  const tail = (url.split('?')[0] ?? '').split('/').pop() ?? 'file';
  return `served-${(h >>> 0).toString(36)}-${tail.replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

/**
 * A URL a native component can open for the file served at `url`: the same URL
 * on a direct route, a local copy fetched through the tunnel on a relayed one.
 * NO FALLBACK: a failed fetch rejects with the server's own status.
 */
export function localUriFor(url: string): Promise<string> {
  if (!isRelayed()) return Promise.resolve(url);
  const existing = copies.get(url);
  if (existing) return existing;
  const made = (async (): Promise<string> => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
    const path = `${FileSystem.cacheDirectory}${cacheName(url)}`;
    await FileSystem.writeAsStringAsync(
      path,
      standardBase64(new Uint8Array(await res.arrayBuffer())),
      {
        encoding: FileSystem.EncodingType.Base64,
      },
    );
    return path;
  })();
  copies.set(url, made);
  made.catch(() => copies.delete(url));
  return made;
}

/** Test seam: forget fetched copies. */
export function __resetServedFiles(): void {
  copies.clear();
}

/** `localUriFor` as state: null until it is ready, `error` if it failed. */
export function useLocalUri(url: string | null): { uri: string | null; error: string | null } {
  const relayed = isRelayed();
  const [state, setState] = React.useState<{
    for: string | null;
    uri: string | null;
    error: string | null;
  }>({
    for: null,
    uri: null,
    error: null,
  });
  React.useEffect(() => {
    if (url === null || !relayed) return;
    let live = true;
    localUriFor(url).then(
      (uri) => live && setState({ for: url, uri, error: null }),
      (e: Error) => live && setState({ for: url, uri: null, error: e.message }),
    );
    return () => {
      live = false;
    };
  }, [url, relayed]);
  if (!relayed) return { uri: url, error: null };
  return state.for === url ? { uri: state.uri, error: state.error } : { uri: null, error: null };
}
