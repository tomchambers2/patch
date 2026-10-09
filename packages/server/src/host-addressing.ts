// The ingress gate for host-addressed requests (spec/03 § Host events,
// spec/04 § Spawn — "A spawn naming an unregistered host is an error").
//
// Every route and every surface frame that carries a `daemonId` names ONE
// machine. The id is checked against the account's registered machines HERE,
// at the ingress, and a name that is not among them is refused with the
// offending value in the body. It is deliberately not left to the routing
// layer: with a single machine attached, "route to the named host" and "route
// to whatever is connected" are indistinguishable, so a missing check looks
// correct right up until a second machine exists and the work silently runs on
// the wrong filesystem.
//
// NO FALLBACK: never coerced to the only/attached host, never dropped
// silently.

import type { Registry } from './registry.js';

/** The body a refused host-addressed request gets back. */
export interface UnregisteredHostError {
  error: 'unknown_host';
  message: string;
  daemonId: string;
  /** The machines that ARE registered, so a surface can say what to pick. */
  knownHosts: string[];
}

/**
 * `null` when `daemonId` names a registered machine; otherwise the 404 body
 * naming the offending value.
 */
export function checkRegisteredHost(
  registry: Registry,
  daemonId: string,
): UnregisteredHostError | null {
  if (registry.isRegisteredDaemon(daemonId)) return null;
  const knownHosts = registry.registeredDaemonIds();
  return {
    error: 'unknown_host',
    message: `no machine registered with daemonId: ${daemonId}`,
    daemonId,
    knownHosts,
  };
}

/** HTTP status for an unregistered machine — the named resource does not exist. */
export const UNKNOWN_HOST_STATUS = 404;
