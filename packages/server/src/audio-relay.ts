// Cross-host audio relay (spec/07 § Voice is a per-host capability, spec/03 §
// Audio relay over the host link).
//
// A chat's voice runs on its own host, but a host is never itself internet-
// reachable — it only dials OUT to the server (spec/01 § WebSocket hub, spec/10
// § Host registration) — so a surface reaching the server for a chat that
// lives on any other host has nowhere to send its audio WSS directly, UNLESS
// that host has separately declared a reachable address
// (`daemon.host.audioRelayHost`). Two paths out of here, in priority order:
//
//   1. DIRECT (optimisation): the host declared an `audioRelayHost` — true by
//      default only for a host co-located with the server (loopback), or
//      any host an operator has explicitly pointed at a reachable address
//      (e.g. a Tailscale name). Dial it and pipe bytes both ways verbatim.
//   2. TUNNELLED (default for everyone else, needs nothing declared): carry
//      every frame over the SAME outbound link the host already holds to
//      this server, multiplexed by `sessionId`
//      (`patch.audio_relay.*` — see events.ts for the full lifecycle). The
//      host on the other end bridges those frames to its own LOCAL audio
//      WSS, so `audio/server.ts` runs completely unmodified regardless of
//      which path carried the bytes to it.
//
// NO FALLBACK: a session this server never minted a route for, or a host that
// is offline, is refused with a specific `audio.error` before any audio is
// accepted — never silently pointed at the wrong machine's pipeline (E1-d3's
// own `session_not_found` discipline, extended one hop). A tunnelled bridge
// that fails to connect on the host's own end is refused the same way,
// carried back as `patch.audio_relay.error`.

import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import WebSocket from 'ws';
import { CLOSE_MALFORMED_FRAME } from '@patch/wire';
import type { PatchAudioRelayCloseEvent, PatchAudioRelayFrameEvent, WireEvent } from '@patch/wire';
import type { DaemonLink } from './daemon-link.js';

/** Matches `voice/token.ts`'s VOICE_TOKEN_TTL_MS — a route outlives the token that named it, never the other way round. */
export const AUDIO_SESSION_ROUTE_TTL_MS = 5 * 60_000;

/**
 * `sessionId → daemonId`, recorded when `POST /api/voice/token` mints a
 * session and consulted when that session's WSS actually connects. Mirrors
 * `cross-host.ts`'s `relayRoutes` map: the only place that knows where a bare
 * id belongs is whoever resolved it in the first place.
 */
export class AudioSessionRouter {
  private readonly routes = new Map<string, { daemonId: string; timer: NodeJS.Timeout }>();

  record(sessionId: string, daemonId: string): void {
    const timer = setTimeout(() => this.routes.delete(sessionId), AUDIO_SESSION_ROUTE_TTL_MS);
    timer.unref();
    this.routes.set(sessionId, { daemonId, timer });
  }

  /** The host a session was minted for, or undefined for an id this server never minted (or has since expired). */
  daemonFor(sessionId: string): string | undefined {
    return this.routes.get(sessionId)?.daemonId;
  }

  /** Test/shutdown cleanup. */
  clear(): void {
    for (const route of this.routes.values()) clearTimeout(route.timer);
    this.routes.clear();
  }
}

export interface AudioRelayDeps {
  logger: Logger;
  router: AudioSessionRouter;
  daemonLink: Pick<DaemonLink, 'isOnline' | 'sendTo' | 'onEvent' | 'onHostStatus'>;
  /** `WsHub.audioRelayHost` — where the server can reach a host's own audio WSS DIRECTLY, if it has declared one. Absent is normal; the tunnelled path needs nothing declared. */
  audioRelayHostFor: (daemonId: string) => string | undefined;
  /** Test seam: substitute the upstream WebSocket client (direct-dial path only). */
  wsCtor?: new (url: string) => WebSocket;
}

/** Surface id this relay uses when addressing frames through `daemonLink.sendTo` — it is not a real surface, just the bridge's own identity for buffering. */
const AUDIO_RELAY_BRIDGE_SURFACE_ID = 'audio-relay-bridge';

/** Minimal shape both a real `ws` socket and Fastify's wrapped one satisfy. */
interface RelaySocket {
  readyState: number;
  send(data: string | Buffer, cb?: (err?: Error) => void): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', handler: (data: Buffer, isBinary: boolean) => void): void;
  on(event: 'close', handler: () => void): void;
  on(event: 'error', handler: (err: Error) => void): void;
  on(event: 'open', handler: () => void): void;
}

function sendAudioError(socket: RelaySocket, code: string, message: string): void {
  try {
    socket.send(JSON.stringify({ type: 'audio.error', code, message }));
  } catch {
    /* socket already gone — the close() right after is what actually matters */
  }
  socket.close(CLOSE_MALFORMED_FRAME, message.slice(0, 123));
}

/** Pipe every frame from `a` to `b` verbatim (binary stays binary, text stays text) once `b` is open. */
function pipeOnceOpen(a: RelaySocket, b: RelaySocket): void {
  // The surface sends `audio.session_start` the instant its own WSS opens
  // (`audioSession.ts`) — before this relay's own upstream leg has finished
  // its own handshake to the host, which is now a real network hop rather
  // than the same box. Dropping frames that arrive during that gap would
  // silently lose the one frame the whole session depends on, so anything
  // that arrives before `b` is open is queued and flushed in order once it is.
  const pending: Array<{ data: Buffer | string; isBinary: boolean }> = [];
  let open = b.readyState === WebSocket.OPEN;
  if (!open) {
    b.on('open', () => {
      open = true;
      for (const m of pending) b.send(m.isBinary ? m.data : m.data.toString('utf8'));
      pending.length = 0;
    });
  }
  a.on('message', (data, isBinary) => {
    if (!open) {
      pending.push({ data, isBinary });
      return;
    }
    if (b.readyState !== WebSocket.OPEN) return;
    b.send(isBinary ? data : data.toString('utf8'));
  });
}

export function registerAudioRelayRoute(app: FastifyInstance, deps: AudioRelayDeps): void {
  const WsCtor = deps.wsCtor ?? WebSocket;

  /** sessionId → the tunnelled session's surface-facing socket + owning host, for as long as the bridge is open. */
  const tunnelled = new Map<string, { socket: RelaySocket; daemonId: string }>();

  const sendToDaemon = (daemonId: string, event: WireEvent): void =>
    deps.daemonLink.sendTo(daemonId, AUDIO_RELAY_BRIDGE_SURFACE_ID, event);

  const unsubEvent = deps.daemonLink.onEvent((event, fromDaemonId) => {
    if (fromDaemonId === null) return;
    if (
      event.type !== 'patch.audio_relay.ready' &&
      event.type !== 'patch.audio_relay.frame' &&
      event.type !== 'patch.audio_relay.close' &&
      event.type !== 'patch.audio_relay.error'
    ) {
      return;
    }
    const entry = tunnelled.get(event.sessionId);
    if (!entry || entry.daemonId !== fromDaemonId) return;
    if (event.type === 'patch.audio_relay.ready') return; // informational only
    if (event.type === 'patch.audio_relay.frame') {
      const data = Buffer.from(event.data, 'base64');
      entry.socket.send(event.binary ? data : data.toString('utf8'));
      return;
    }
    tunnelled.delete(event.sessionId);
    if (event.type === 'patch.audio_relay.error') {
      deps.logger.warn(
        { sessionId: event.sessionId, daemonId: fromDaemonId, message: event.message },
        'audio relay: tunnelled bridge failed on the host end',
      );
      sendAudioError(
        entry.socket,
        'host_unreachable',
        `could not reach ${fromDaemonId}'s audio WSS`,
      );
      return;
    }
    entry.socket.close();
  });

  // A host carrying one or more tunnelled sessions drops: each is refused
  // loudly rather than left open against a host that will never answer it —
  // same discipline as the pre-connection isOnline() check, for mid-session.
  const unsubStatus = deps.daemonLink.onHostStatus((daemonId, status) => {
    if (status !== 'offline') return;
    for (const [sessionId, entry] of tunnelled) {
      if (entry.daemonId !== daemonId) continue;
      tunnelled.delete(sessionId);
      sendAudioError(entry.socket, 'host_unreachable', `${daemonId} went offline mid-session`);
    }
  });

  app.addHook('onClose', async () => {
    unsubEvent();
    unsubStatus();
    tunnelled.clear();
  });

  function relayTunnelled(socket: RelaySocket, sessionId: string, daemonId: string): void {
    tunnelled.set(sessionId, { socket, daemonId });
    socket.on('message', (data, isBinary) => {
      sendToDaemon(daemonId, {
        type: 'patch.audio_relay.frame',
        sessionId,
        data: data.toString('base64'),
        binary: isBinary,
      } as PatchAudioRelayFrameEvent);
    });
    const closeTunnel = (): void => {
      if (!tunnelled.delete(sessionId)) return;
      sendToDaemon(daemonId, {
        type: 'patch.audio_relay.close',
        sessionId,
      } as PatchAudioRelayCloseEvent);
    };
    socket.on('close', closeTunnel);
    socket.on('error', closeTunnel);
    sendToDaemon(daemonId, { type: 'patch.audio_relay.open', sessionId });
  }

  app.get<{ Params: { sessionId: string } }>(
    '/audio/:sessionId',
    { websocket: true },
    (socket: RelaySocket, req) => {
      const sessionId = req.params.sessionId;
      const daemonId = deps.router.daemonFor(sessionId);
      if (!daemonId) {
        deps.logger.warn({ sessionId }, 'audio relay: no route for this session; refusing');
        sendAudioError(socket, 'session_not_found', `no voice session: ${sessionId}`);
        return;
      }
      if (!deps.daemonLink.isOnline(daemonId)) {
        deps.logger.warn({ sessionId, daemonId }, 'audio relay: owning host is offline; refusing');
        sendAudioError(socket, 'host_unreachable', `${daemonId} is offline`);
        return;
      }
      const relayHost = deps.audioRelayHostFor(daemonId);
      if (!relayHost) {
        // No direct address declared (the common case — see the module
        // comment's path 2): tunnel the session over this host's existing
        // outbound link instead of refusing it.
        relayTunnelled(socket, sessionId, daemonId);
        return;
      }
      const upstream = new WsCtor(`ws://${relayHost}/audio/${sessionId}`) as unknown as RelaySocket;
      let upstreamOpen = false;
      upstream.on('open', () => {
        upstreamOpen = true;
      });
      upstream.on('error', (err) => {
        deps.logger.warn(
          { sessionId, daemonId, relayHost, err: err.message },
          'audio relay: upstream connection failed',
        );
        if (!upstreamOpen) {
          sendAudioError(socket, 'host_unreachable', `could not reach ${daemonId}'s audio WSS`);
        } else {
          socket.close(CLOSE_MALFORMED_FRAME, 'upstream audio connection failed');
        }
      });
      upstream.on('close', () => socket.close());
      socket.on('close', () => upstream.close());
      socket.on('error', () => upstream.close());
      pipeOnceOpen(socket, upstream);
      pipeOnceOpen(upstream, socket);
    },
  );
}
