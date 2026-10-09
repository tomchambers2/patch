// Outbound host -> patch-server WebSocket client.
//
// Spec: spec/10-auth.md ("host ... thereafter authenticates to server with
// it"), spec/02-daemon.md ("Connects to server via WebSocket. Reconnects with
// exponential backoff; buffers outbound events during disconnect."),
// spec/03-wire-protocol.md ## Auth (EdDSA-JWT in the `hello` frame).
//
// The host DIALS INTO the patch-server's /ws endpoint. On open it sends a
// `hello { clientType:'daemon', clientVersion, auth:<daemonKey JWT> }`. The
// server replies `auth.ok` then `daemon.online`; thereafter both ends speak
// `@patch/wire` frames.
//
// Reconnect: the FIRST retry is deliberately short (250ms) so a transient miss
// on boot — e.g. the host dialing before the server has finished binding /ws
// on the shared Hetzner box — recovers within about a second rather than
// leaving surfaces stuck in `connecting`/daemon-unknown for a full second
// (spec/12 ## Surface connection state model: "its first reconnect backoff step
// is short (≤1s)"). Thereafter it backs off 1s -> 2s -> 5s -> 10s, capped 30s.
// Offline buffering (spec/12): outbound events queue in an EventBuffer while
// disconnected (cap 10k, drop-oldest with a logged warn) and flush on
// reconnect. NO FALLBACK: a bad daemonKey -> the server closes the socket; we
// surface the close code and keep retrying (a revoked key never silently
// succeeds).
//
// Heartbeat (ws ping/pong): a laptop that sleeps, switches Wi-Fi networks, or
// sits behind a NAT that reaps idle connections can leave this socket reading
// readyState OPEN long after the peer has actually gone - TCP alone does not
// notice a half-open connection without traffic. Without a liveness check,
// `online` (and therefore `isLinkOnline()`, which the artifact-publish and
// jobs RPCs gate on) stays true, so a request gets "sent" into a socket that
// will never answer, and the CALLER's own timeout is the only thing that ever
// notices - reported as a bare `artifact_publish_failed: timed out after
// 15000ms` 502, with no reconnect in sight (2026-09-30, Tom's Mac:
// `patch_artifact` failed twice in a row this way). Pinging every
// `heartbeatIntervalMs` and terminating the socket if a pong hasn't landed
// since the last ping turns that silent hang into a prompt, visible
// disconnect plus the normal backoff reconnect.

import WebSocket from 'ws';
import type { Logger } from 'pino';
import {
  decodeCompat,
  encode,
  type AuthOkEvent,
  type WireEvent,
  WireDecodeError,
} from '@patch/wire';
import { EventBuffer, DEFAULT_BUFFER_PER_CHAT } from './eventBuffer.js';

/**
 * Backoff schedule in ms. First step is short (250ms) so a transient boot-time
 * miss recovers within ~a second (spec/12 ## Surface connection state model);
 * the tail then backs off 1s -> 2s -> 5s -> 10s. Last value is the steady-state
 * cap.
 */
export const BACKOFF_SCHEDULE_MS = [250, 1_000, 2_000, 5_000, 10_000, 30_000] as const;

/** Default `heartbeatIntervalMs` (see heartbeat note above). */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Event types this host has already reported as unknown (spec/03 § Forward
 * compatibility). One line the first time is the useful signal — "this host is
 * behind the server"; a line per frame is just volume.
 */
const compatSeen = new Set<string>();

export interface ServerLinkOptions {
  /** ws:// or wss:// URL of the patch-server, e.g. ws://server:3000/ws. */
  url: string;
  /** EdDSA-JWT daemonKey read from ~/.patch/daemon.key. */
  daemonKey: string;
  /** Host package version, sent in the hello frame. */
  clientVersion: string;
  /**
   * Short git sha + build instant of this host, sent alongside the version so
   * `GET /api/version` can flag a host built from a different commit to the
   * server it links to (spec/11 § Version reporting). Optional so test harnesses
   * needn't stamp a build.
   */
  clientGitSha?: string;
  clientBuiltAt?: string;
  logger: Logger;
  /** Called for every authenticated inbound wire frame from the server. */
  onFrame?: (event: WireEvent, send: (e: WireEvent) => void) => void;
  /**
   * Called once the server has accepted us (after `auth.ok`). The greeting
   * carries the account's machine roster with presence, which this machine
   * needs so a cross-chat call naming another machine can fail inside the turn
   * when that machine is down (spec/03 § Cross-chat tools).
   */
  onAuthed?: (send: (event: WireEvent) => void, greeting: AuthOkEvent) => void;
  /** Called when the link drops (close or error). */
  onDisconnected?: () => void;
  /**
   * Called when a frame arrives BEFORE `auth.ok` that this host cannot decode
   * — in practice the greeting itself. The server and host ship in lockstep,
   * so a greeting this reader rejects means the server has moved on and this
   * host has not: the caller should go and get the matching build. The link
   * drops the socket and keeps reconnecting on its backoff either way, so it is
   * never left open-but-unauthenticated.
   */
  onGreetingUnreadable?: (err: WireDecodeError) => void;
  /** Test hooks. */
  wsFactory?: (url: string) => WebSocket;
  backoffSchedule?: readonly number[];
  /** Cap for the offline buffer (defaults to EventBuffer's 10k). */
  bufferMaxPerChat?: number;
  bufferMaxGlobal?: number;
  /**
   * How often to `ws.ping()` the socket once it is open, to catch a
   * half-open connection a close event will never report (see heartbeat
   * note above). Defaults to 15s; a missed pong is detected on the NEXT
   * tick, so the worst-case detection time is ~2x this value. Overridable
   * for tests, which use a tiny value rather than waiting out the default.
   */
  heartbeatIntervalMs?: number;
  /**
   * Test-hook gate (TD3 harness). When `true`, `severForTest` /
   * `bufferSizeForTest` become operative. NEVER set in production: the host
   * boot path (index.ts) does not pass it, and the methods throw if called
   * without it. These are HARNESS affordances to drive the spec/12
   * host→server link-drop scenarios (D3-4/D3-5/D3-8) against a live stack —
   * not product fallbacks.
   */
  enableTestHooks?: boolean;
}

/**
 * Live link diagnostics — the production observability readout for the
 * host→server link (spec/12 ## Observability, ## Host → server disconnect).
 * Surfaced over the host control UDS (`patch doctor`) so the offline-buffer
 * and link state are inspectable on the RUNNING host, not only in-process
 * under the test hook. NOT a fallback: it reports real state, never fabricates.
 */
export interface ServerLinkDiagnostics {
  /** Whether the link is currently authed/online. */
  online: boolean;
  /** Total events queued in the offline buffer across all chats. */
  bufferSize: number;
  /** Per-chat configured cap (DEFAULT_BUFFER_PER_CHAT in production). */
  bufferMaxPerChat: number;
}

export interface ServerLink {
  /** Begin connecting (and auto-reconnecting). Returns immediately. */
  start(): void;
  /** Queue an outbound event — sent now if authed, buffered otherwise. */
  send(event: WireEvent): void;
  /** Whether the link is currently authed/online. */
  isOnline(): boolean;
  /** Stop reconnecting and close any open socket. */
  close(): Promise<void>;
  /**
   * Live diagnostics readout (always available, never gated). Backs the
   * host control-UDS `/internal/diag/link` route consumed by `patch doctor`
   * and the offline/reconnect e2e checks against the running app (spec/12
   * D3-4/D3-5). Reports the real online flag + offline buffer occupancy.
   */
  diagnostics(): ServerLinkDiagnostics;
  /**
   * Drop the currently-open socket WITHOUT stopping the host or its
   * reconnect loop — the real spec/12 "Host → server disconnect" path where
   * the host process stays alive while the upstream link goes down. Marks
   * the link offline (so subsequent emits buffer), notifies `onDisconnected`,
   * and lets the normal backoff reconnect fire. Available on the live host
   * (control-UDS `/internal/diag/drop-link`) so the link-drop scenario is
   * exercisable end-to-end against the running app, not only in tests. Returns
   * true if a live socket was dropped.
   */
  dropLink(): boolean;
  /**
   * Diagnostic: push `count` synthetic outbound events for a single `chatId`
   * into the offline buffer, exercising the spec/12 bounded-buffer path
   * (10k/chat cap, drop-oldest, logged warn) on the LIVE host. The events are
   * pushed through the exact same `EventBuffer.push` the real outbound emit
   * path uses, so the cap/drop/warn behaviour observed here is the production
   * behaviour — not a simulation. Available on the running host over the
   * control UDS (`/internal/diag/flood-buffer`) so D3-5 is verifiable
   * end-to-end against the running app, where an organic rate-limited event
   * flood is infeasible. Returns the buffer's total size after the push. NOT a
   * fallback: it only writes to the real buffer and reports its real state.
   */
  floodBuffer(chatId: string, count: number): number;
  /**
   * TEST HOOK (gated by `enableTestHooks`). Alias of `dropLink()` retained for
   * the encoded TD3 in-process tests. Throws if the hook gate is not enabled.
   */
  severForTest(): boolean;
  /**
   * TEST HOOK (gated by `enableTestHooks`). Alias of `diagnostics().bufferSize`
   * retained for the encoded TD3 in-process tests. Throws if the hook gate is
   * not enabled.
   */
  bufferSizeForTest(): number;
}

interface ServerLinkHelloFrame {
  type: 'hello';
  clientType: 'daemon';
  clientVersion: string;
  clientGitSha?: string;
  clientBuiltAt?: string;
  auth: string;
}

export function createServerLink(opts: ServerLinkOptions): ServerLink {
  const log = opts.logger;
  const schedule = opts.backoffSchedule ?? BACKOFF_SCHEDULE_MS;
  // The host side of permessage-deflate. A replay leaves THIS end, so
  // compressing here is what actually shrinks what crosses the wire; the
  // server's own option only governs the server->surface hop. `ws` offers
  // the extension by default from a client, but spelling it out pins the
  // same thresholds and keeps the memory bounded on both ends.
  const wsFactory =
    opts.wsFactory ??
    ((url: string) =>
      new WebSocket(url, {
        perMessageDeflate: {
          threshold: 8 * 1024,
          concurrencyLimit: 10,
          zlibDeflateOptions: { level: 6, memLevel: 7, windowBits: 14 },
          clientNoContextTakeover: true,
          serverNoContextTakeover: true,
        },
      }));
  const buffer = new EventBuffer({
    ...(opts.bufferMaxPerChat !== undefined ? { maxPerChat: opts.bufferMaxPerChat } : {}),
    ...(opts.bufferMaxGlobal !== undefined ? { maxGlobal: opts.bufferMaxGlobal } : {}),
    onDrop: (drop) => {
      log.warn(drop, 'server-link: dropped oldest events (buffer cap reached)');
    },
  });

  const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;

  let ws: WebSocket | undefined;
  let online = false;
  let stopped = false;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  function backoffMs(): number {
    const idx = Math.min(attempt, schedule.length - 1);
    return schedule[idx] ?? schedule[schedule.length - 1] ?? 30_000;
  }

  function rawSend(event: WireEvent): void {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(encode(event));
    }
  }

  function flushBuffer(): void {
    for (const ev of buffer.drain()) rawSend(ev);
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
  }

  /**
   * Standard `ws` liveness pattern: a pong (even one the library answers
   * automatically on the OTHER end) flips `isAlive` back to true; each tick
   * that finds it still false means nothing has been heard since the PREVIOUS
   * ping, so the socket is terminated rather than merely closed — `terminate`
   * drops the connection immediately instead of attempting the close
   * handshake a half-open socket will never complete. The existing 'close'
   * handler does the rest (marks offline, fires `onDisconnected`, schedules
   * the normal backoff reconnect).
   */
  function startHeartbeat(socket: WebSocket): void {
    stopHeartbeat();
    let isAlive = true;
    socket.on('pong', () => {
      isAlive = true;
    });
    heartbeatTimer = setInterval(() => {
      if (!isAlive) {
        log.warn('server-link: no pong since the last ping; terminating stale socket');
        socket.terminate();
        return;
      }
      isAlive = false;
      socket.ping();
    }, heartbeatIntervalMs);
    heartbeatTimer.unref?.();
  }

  function scheduleReconnect(): void {
    if (stopped) return;
    const wait = backoffMs();
    attempt += 1;
    log.info({ wait, attempt }, 'server-link: scheduling reconnect');
    reconnectTimer = setTimeout(connect, wait);
  }

  function connect(): void {
    // Unreachable in practice: `connect` is only invoked from `start()`
    // (which just set `stopped = false`) or as a `scheduleReconnect` timer
    // callback, and `close()` always `clearTimeout`s any pending reconnect
    // timer before setting `stopped = true` — so a scheduled `connect` can
    // never actually fire with `stopped` true. Kept as a defensive guard in
    // case a future refactor drops that invariant.
    /* v8 ignore next */
    if (stopped) return;
    reconnectTimer = undefined;
    let socket: WebSocket;
    try {
      socket = wsFactory(opts.url);
    } catch (err) {
      log.error({ err }, 'server-link: failed to construct WebSocket');
      scheduleReconnect();
      return;
    }
    ws = socket;

    socket.on('open', () => {
      const hello: ServerLinkHelloFrame = {
        type: 'hello',
        clientType: 'daemon',
        clientVersion: opts.clientVersion,
        ...(opts.clientGitSha ? { clientGitSha: opts.clientGitSha } : {}),
        ...(opts.clientBuiltAt ? { clientBuiltAt: opts.clientBuiltAt } : {}),
        auth: opts.daemonKey,
      };
      socket.send(JSON.stringify(hello));
      log.info('server-link: sent host hello, awaiting auth.ok');
      startHeartbeat(socket);
    });

    socket.on('message', (raw: WebSocket.RawData) => {
      let event: WireEvent;
      try {
        const text = Buffer.isBuffer(raw)
          ? raw.toString('utf8')
          : Array.isArray(raw)
            ? Buffer.concat(raw).toString('utf8')
            : Buffer.from(raw as ArrayBuffer).toString('utf8');
        // `decodeCompat`, not `decode`: hosts OTA their host on their own
        // schedule and routinely lag the server, so this reader can be OLDER
        // than its sender (spec/03 § Forward compatibility). A field the server
        // added must not make the host drop the frame carrying it. Genuine
        // malformation still throws and is still logged and dropped.
        const result = decodeCompat(text);
        if (!result.ok) {
          if (!compatSeen.has(result.type)) {
            compatSeen.add(result.type);
            log.warn(
              { type: result.type },
              'server-link: dropping an event type this host does not know — it is behind the server',
            );
          }
          return;
        }
        if (result.tolerated.length > 0) {
          log.debug(
            { fields: result.tolerated },
            'server-link: ignored fields from a newer server',
          );
        }
        event = result.event;
      } catch (err) {
        if (err instanceof WireDecodeError) {
          if (!online) {
            // Nothing after this can authenticate the link: without `auth.ok`
            // the socket stays open, never online, and never reconnects —
            // which is how the Mac host sat unreachable for twenty minutes on
            // 2026-09-30 while its chats read as `daemon_unavailable`.
            log.error(
              { err },
              'server-link: cannot read the server greeting — this host is behind the server',
            );
            opts.onGreetingUnreadable?.(err);
            socket.close();
            return;
          }
          log.warn({ err }, 'server-link: decode failed');
          return;
        }
        throw err;
      }

      // The server confirms the hello with `auth.ok`. That transitions us
      // online: reset backoff, flush the offline buffer, notify the host.
      if (!online && event.type === 'auth.ok') {
        online = true;
        attempt = 0;
        log.info('server-link: authenticated (auth.ok)');
        flushBuffer();
        opts.onAuthed?.(rawSend, event);
        return;
      }
      // `daemon.online` is server-emitted bookkeeping; nothing to do here.
      opts.onFrame?.(event, rawSend);
    });

    socket.on('close', (code: number, reason: Buffer) => {
      const wasOnline = online;
      online = false;
      // Guard matches the `ws` clear just below: a STALE close from a socket
      // already superseded by a newer one must not tear down the newer
      // socket's own heartbeat timer.
      if (ws === socket) stopHeartbeat();
      if (ws === socket) ws = undefined;
      log.warn({ code, reason: reason.toString('utf8') }, 'server-link: socket closed');
      if (wasOnline) opts.onDisconnected?.();
      scheduleReconnect();
    });

    socket.on('error', (err: Error) => {
      log.warn({ err: err.message }, 'server-link: socket error');
      // 'close' fires after 'error'; reconnect is scheduled there.
    });
  }

  return {
    start(): void {
      stopped = false;
      attempt = 0;
      connect();
    },
    send(event: WireEvent): void {
      if (online) {
        rawSend(event);
      } else {
        buffer.push(event);
      }
    },
    isOnline(): boolean {
      return online;
    },
    diagnostics(): ServerLinkDiagnostics {
      return {
        online,
        bufferSize: buffer.size(),
        bufferMaxPerChat: opts.bufferMaxPerChat ?? DEFAULT_BUFFER_PER_CHAT,
      };
    },
    dropLink(): boolean {
      const socket = ws;
      if (!socket || socket.readyState === WebSocket.CLOSED) return false;
      // The real spec/12 "Host → server disconnect" path: mark offline +
      // notify, but DO NOT set `stopped`, so the existing 'close' handler
      // schedules a reconnect. The host stays alive; subsequent emits buffer
      // until reconnect.
      const wasOnline = online;
      online = false;
      if (wasOnline) opts.onDisconnected?.();
      socket.close();
      return true;
    },
    floodBuffer(chatId: string, count: number): number {
      // Push synthetic events for `chatId` through the SAME EventBuffer.push
      // the live outbound path uses, so the 10k cap / drop-oldest / warn fires
      // exactly as in production. These never reach the wire (they're dropped
      // on flush like any buffered event would be once the cap is hit), and the
      // synthetic shape carries `chatId` so per-chat bounding applies.
      for (let i = 0; i < count; i++) {
        buffer.push({
          type: 'chat.message',
          chatId,
          role: 'assistant',
          content: `diag-flood-${i}`,
          seq: i,
        } as WireEvent);
      }
      return buffer.size();
    },
    severForTest(): boolean {
      if (!opts.enableTestHooks) {
        throw new Error('severForTest: test hooks not enabled (enableTestHooks is false)');
      }
      return this.dropLink();
    },
    bufferSizeForTest(): number {
      if (!opts.enableTestHooks) {
        throw new Error('bufferSizeForTest: test hooks not enabled (enableTestHooks is false)');
      }
      return buffer.size();
    },
    async close(): Promise<void> {
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      stopHeartbeat();
      online = false;
      const socket = ws;
      ws = undefined;
      if (socket && socket.readyState !== WebSocket.CLOSED) {
        await new Promise<void>((resolve) => {
          socket.once('close', () => resolve());
          socket.close();
        });
      }
    },
  };
}
