// Browser tunnel relay (spec/02 § Browser — Route through, spec/03 § Browser
// tunnel): the server-side half of routing one host's agent browser through
// another host's network.
//
// Unlike `cross-host.ts`'s request/response relays, a tunnel stream is
// symmetric and long-lived: once `patch.browser_tunnel.open` is accepted,
// `ready` / `data` / `error` / `close` can arrive from EITHER side and must
// be relayed to the OTHER side, for as long as the stream is open — there is
// no single caller waiting on a single answer. So the bridge tracks each
// open stream as an unordered pair of machines and, for every later frame
// carrying that `streamId`, sends it to whichever of the two did NOT just
// send it.
//
// NO FALLBACK: `open` naming an unregistered or offline routing host is
// refused immediately with `patch.browser_tunnel.error`, back to the
// browsing host — never silently dropped, and never left for Chromium's own
// SOCKS timeout to surface as something unexplained. A routing host that
// goes offline mid-stream gets the same treatment from the other end: the
// browsing host is told `host_offline` and the stream is dropped, rather than
// left open against a machine that can no longer answer it.

import type { Logger } from 'pino';
import type { WireEvent } from '@patch/wire';
import type { DaemonLink } from './daemon-link.js';
import type { Registry } from './registry.js';

const BRIDGE_SURFACE_ID = 'browser-tunnel-bridge';

export interface BrowserTunnelBridgeDeps {
  logger: Logger;
  daemonLink: DaemonLink;
  registry: Registry;
}

interface Route {
  browsingDaemonId: string;
  routingDaemonId: string;
}

export function registerBrowserTunnelBridge(deps: BrowserTunnelBridgeDeps): () => void {
  const { logger, daemonLink, registry } = deps;

  /** streamId → the two machines carrying this stream, for as long as it's open. */
  const routes = new Map<string, Route>();

  const otherSide = (streamId: string, from: string): string | undefined => {
    const route = routes.get(streamId);
    if (!route) return undefined;
    if (route.browsingDaemonId === from) return route.routingDaemonId;
    if (route.routingDaemonId === from) return route.browsingDaemonId;
    return undefined;
  };

  const refuseOpen = (
    browsingDaemonId: string,
    streamId: string,
    code: 'host_not_registered' | 'host_offline',
    message: string,
  ): void => {
    daemonLink.sendTo(browsingDaemonId, BRIDGE_SURFACE_ID, {
      type: 'patch.browser_tunnel.error',
      streamId,
      code,
      message,
    });
  };

  const unsubEvent = daemonLink.onEvent((event: WireEvent, fromDaemonId: string | null) => {
    if (fromDaemonId === null) return;

    if (event.type === 'patch.browser_tunnel.open') {
      if (!registry.isRegisteredDaemon(event.daemonId)) {
        logger.warn(
          { from: fromDaemonId, target: event.daemonId, streamId: event.streamId },
          'browser tunnel open named an unregistered machine',
        );
        refuseOpen(
          fromDaemonId,
          event.streamId,
          'host_not_registered',
          `no machine registered with daemonId: ${event.daemonId}`,
        );
        return;
      }
      if (!daemonLink.isOnline(event.daemonId)) {
        logger.warn(
          { from: fromDaemonId, target: event.daemonId, streamId: event.streamId },
          'browser tunnel open named an offline machine',
        );
        refuseOpen(
          fromDaemonId,
          event.streamId,
          'host_offline',
          `routing host ${event.daemonId} is offline`,
        );
        return;
      }
      routes.set(event.streamId, {
        browsingDaemonId: fromDaemonId,
        routingDaemonId: event.daemonId,
      });
      logger.info(
        { from: fromDaemonId, target: event.daemonId, streamId: event.streamId, host: event.host },
        'relaying browser tunnel open to the routing machine',
      );
      daemonLink.sendTo(event.daemonId, BRIDGE_SURFACE_ID, event);
      return;
    }

    if (
      event.type === 'patch.browser_tunnel.ready' ||
      event.type === 'patch.browser_tunnel.data' ||
      event.type === 'patch.browser_tunnel.error'
    ) {
      const to = otherSide(event.streamId, fromDaemonId);
      if (!to) {
        logger.warn(
          { type: event.type, from: fromDaemonId, streamId: event.streamId },
          'browser tunnel frame for a stream this server is not carrying; dropping',
        );
        return;
      }
      daemonLink.sendTo(to, BRIDGE_SURFACE_ID, event);
      return;
    }

    if (event.type === 'patch.browser_tunnel.close') {
      const to = otherSide(event.streamId, fromDaemonId);
      routes.delete(event.streamId);
      if (to) daemonLink.sendTo(to, BRIDGE_SURFACE_ID, event);
      return;
    }
  });

  // A machine on either side of an open stream drops: the other side cannot
  // be answered any more, so it is told rather than left hanging against a
  // machine that will never reply.
  const unsubStatus = daemonLink.onHostStatus((daemonId, status) => {
    if (status !== 'offline') return;
    for (const [streamId, route] of routes) {
      if (route.browsingDaemonId !== daemonId && route.routingDaemonId !== daemonId) continue;
      const survivor =
        route.browsingDaemonId === daemonId ? route.routingDaemonId : route.browsingDaemonId;
      routes.delete(streamId);
      daemonLink.sendTo(survivor, BRIDGE_SURFACE_ID, {
        type: 'patch.browser_tunnel.error',
        streamId,
        code: 'host_offline',
        message: `machine ${daemonId} went offline mid-stream`,
      });
    }
  });

  return () => {
    unsubEvent();
    unsubStatus();
    routes.clear();
  };
}
