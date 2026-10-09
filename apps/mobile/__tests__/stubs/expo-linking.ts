// Faithful-enough stub of expo-linking's URL parsing for pure-logic tests.
// Mirrors the real `parse` return shape: { hostname, path, queryParams }.
// For `patch://<host>/<path>?<query>` the scheme is stripped, the first
// authority segment becomes `hostname`, and the remainder becomes `path`.

export function createURL(path: string): string {
  return `patch://${path}`;
}

export function parse(url: string): {
  hostname: string | null;
  path: string | null;
  queryParams: Record<string, string | undefined> | null;
} {
  const [beforeQuery, query] = url.split('?');
  // Strip scheme (`patch://`).
  const withoutScheme = beforeQuery.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
  const slash = withoutScheme.indexOf('/');
  const hostname = slash === -1 ? withoutScheme : withoutScheme.slice(0, slash);
  const path = slash === -1 ? null : withoutScheme.slice(slash + 1);

  let queryParams: Record<string, string> | null = null;
  if (query) {
    queryParams = {};
    for (const pair of query.split('&')) {
      const [k, v] = pair.split('=');
      if (k) queryParams[decodeURIComponent(k)] = decodeURIComponent(v ?? '');
    }
  }
  return { hostname: hostname || null, path, queryParams };
}

const urlListeners = new Set<(e: { url: string }) => void>();
export function addEventListener(
  _event: 'url',
  cb: (e: { url: string }) => void,
): { remove(): void } {
  urlListeners.add(cb);
  return {
    remove(): void {
      urlListeners.delete(cb);
    },
  };
}
/** Test helper: simulate a `url` event (app opened/foregrounded via a deep link). */
export function __emitUrl(url: string): void {
  for (const cb of urlListeners) cb({ url });
}

let _initialURL: string | null = null;
/** Test helper: set what getInitialURL() resolves to (cold-start deep link). */
export function __setInitialURL(url: string | null): void {
  _initialURL = url;
}
export async function getInitialURL(): Promise<string | null> {
  return _initialURL;
}

const _openedUrls: string[] = [];
export async function openURL(url: string): Promise<void> {
  _openedUrls.push(url);
}
/** Test helper: URLs passed to openURL(), in call order. */
export function __getOpenedUrls(): string[] {
  return _openedUrls;
}
/** Test helper: reset the openURL() call log between tests. */
export function __resetOpenedUrls(): void {
  _openedUrls.length = 0;
}
