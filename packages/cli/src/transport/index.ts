// Unified transport facade.
//
// Auto-detects environment per spec/17-cli.md "Auth":
//   - if PATCH_DAEMON_SOCKET (or default ~/.patch/daemon.sock) is reachable
//     AND PATCH_DAEMON_LOCAL_KEY is set, prefer UDS for daemon-local ops.
//   - otherwise speak REST against the configured server URL with a JWT
//     bearer.
//
// NO FALLBACK between paths: at instantiation we pick exactly one and stick
// with it. A failing UDS call surfaces; we don't silently retry over REST.

import { RestClient } from './rest.js';
import { UdsClient } from './uds.js';
import type { ResolvedConfig } from '../config.js';
import { bearerToken } from '../auth.js';

export type TransportKind = 'uds' | 'rest';

export interface Transport {
  kind: TransportKind;
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
  put<T>(path: string, body?: unknown): Promise<T>;
  delete<T>(path: string): Promise<T>;
}

export interface BuildTransportOptions {
  /** Force REST mode (e.g. `patch --remote`). */
  forceRest?: boolean;
  /** Force UDS mode for tests or admin. */
  forceUds?: boolean;
  /** Required when REST — used for /api/* lookups. */
  bearer?: string | null;
  /** Override fetch (tests). */
  fetchFn?: typeof fetch;
}

export function buildTransport(
  config: ResolvedConfig,
  opts: BuildTransportOptions = {},
): Transport {
  const useUds = !opts.forceRest && config.daemonSocket !== null && config.daemonLocalKey !== null;

  if (opts.forceUds && (config.daemonSocket === null || config.daemonLocalKey === null)) {
    throw new Error(
      'forceUds: requires PATCH_DAEMON_SOCKET (or ~/.patch/daemon.sock) and PATCH_DAEMON_LOCAL_KEY',
    );
  }

  if (useUds) {
    const uds = new UdsClient({
      socketPath: config.daemonSocket!,
      localKey: config.daemonLocalKey,
    });
    return {
      kind: 'uds',
      get: <T>(p: string): Promise<T> => uds.get<T>(p),
      post: <T>(p: string, b?: unknown): Promise<T> => uds.post<T>(p, b),
      patch: <T>(p: string, b?: unknown): Promise<T> => uds.patch<T>(p, b),
      put: <T>(p: string, b?: unknown): Promise<T> => uds.put<T>(p, b),
      delete: <T>(p: string): Promise<T> => uds.delete<T>(p),
    };
  }

  // NO FALLBACK: bearerToken() throws CredentialMissing/Corrupt/Expired and
  // those propagate to the command runner, which maps them to actionable
  // JSON errors. Tests pass `bearer: null` to skip.
  const bearer = opts.bearer === undefined ? bearerToken() : opts.bearer;
  const rest = new RestClient({
    serverUrl: config.serverUrl,
    bearer,
    ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
  });
  return {
    kind: 'rest',
    get: <T>(p: string): Promise<T> => rest.get<T>(p),
    post: <T>(p: string, b?: unknown): Promise<T> => rest.post<T>(p, b),
    patch: <T>(p: string, b?: unknown): Promise<T> => rest.patch<T>(p, b),
    put: <T>(p: string, b?: unknown): Promise<T> => rest.put<T>(p, b),
    delete: <T>(p: string): Promise<T> => rest.delete<T>(p),
  };
}

export { RestClient, RestError } from './rest.js';
export { UdsClient, UdsError } from './uds.js';
