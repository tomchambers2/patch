// Browser tunnel (spec/02 § Browser — Route through, spec/03 § Browser
// tunnel): lets this host's agent browser egress through another of the
// user's hosts instead of its own network, with no open port on either
// machine — only the host↔server WS links either already has.
//
// Two independent roles, each usable on its own (a host can be both at once —
// routing another host's browser while its own routes through a third):
//
//   BrowserTunnelClient — the BROWSING host. Owns a loopback-only SOCKS5
//   listener per routing target (`browser.ts` points Chromium's `proxy` at
//   it). Each CONNECT that listener accepts becomes one tunnel stream: mint a
//   streamId, ask the routing host to open it, hold the local TCP connection
//   until the answer comes back, then pump bytes both ways as
//   `patch.browser_tunnel.data` frames.
//
//   BrowserTunnelRelay — the ROUTING host. For each `open` addressed to it,
//   makes the REAL outbound `net.connect` and pumps that socket's bytes back
//   as the same frames.
//
// Both are pure: no knowledge of the server relay, the host, or chatRunner
// — just a `sender` callback out and a `handleEvent`/`handleOpen` call in,
// which is what makes both sides independently unit-testable, and what lets
// `browser-tunnel-bridge.test.ts` (the server relay) and the two-sided
// integration test in `browser-tunnel.test.ts` cover genuinely different
// things.
//
// SOCKS: a minimal SOCKS5 server, no auth, CONNECT only (the only command a
// browser's proxy config ever issues). One assumption kept deliberately
// simple, same discipline as `browser.ts`'s plain-DOM snapshot: the greeting
// and the request each arrive as one TCP read. True for every real client
// (Chromium sends each as a single small write, and loopback never
// fragments a write that small) — not a general-purpose SOCKS server.

import { randomUUID } from 'node:crypto';
import net, { type Socket } from 'node:net';
import type { Logger } from 'pino';
import type {
  PatchBrowserTunnelCloseEvent,
  PatchBrowserTunnelDataEvent,
  PatchBrowserTunnelErrorEvent,
  PatchBrowserTunnelOpenEvent,
  PatchBrowserTunnelReadyEvent,
} from '@patch/wire';

export type OutboundFromRelay =
  | PatchBrowserTunnelReadyEvent
  | PatchBrowserTunnelDataEvent
  | PatchBrowserTunnelCloseEvent
  | PatchBrowserTunnelErrorEvent;

export type InboundToClient = OutboundFromRelay;

const SOCKS_VERSION = 0x05;
const SOCKS_REPLY = {
  succeeded: 0x00,
  generalFailure: 0x01,
  connectionRefused: 0x05,
  commandNotSupported: 0x07,
  addressTypeNotSupported: 0x08,
} as const;

/** `05 <rep> 00 01 0.0.0.0:0` — BND.ADDR/PORT are meaningless for a proxy that never binds a listener, so they're always zero. */
function socksReply(rep: number): Buffer {
  return Buffer.from([SOCKS_VERSION, rep, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
}

function parseConnectRequest(chunk: Buffer): { host: string; port: number } | undefined {
  if (chunk.length < 7 || chunk[0] !== SOCKS_VERSION || chunk[1] !== 0x01 /* CONNECT */) {
    return undefined;
  }
  const atyp = chunk[3];
  if (atyp === 0x01) {
    // IPv4: 4 octets then a 2-byte port.
    if (chunk.length < 10) return undefined;
    const host = `${chunk[4]}.${chunk[5]}.${chunk[6]}.${chunk[7]}`;
    return { host, port: chunk.readUInt16BE(8) };
  }
  if (atyp === 0x03) {
    // Domain name: 1-byte length, then the name, then a 2-byte port.
    const len = chunk[4]!;
    if (chunk.length < 5 + len + 2) return undefined;
    const host = chunk.subarray(5, 5 + len).toString('ascii');
    return { host, port: chunk.readUInt16BE(5 + len) };
  }
  if (atyp === 0x04) {
    // IPv6: 16 octets then a 2-byte port.
    if (chunk.length < 22) return undefined;
    const groups: string[] = [];
    for (let i = 0; i < 8; i++) groups.push(chunk.readUInt16BE(4 + i * 2).toString(16));
    return { host: groups.join(':'), port: chunk.readUInt16BE(20) };
  }
  return undefined;
}

interface PendingStream {
  socket: Socket;
  daemonId: string;
  established: boolean;
  timer: NodeJS.Timeout;
}

export interface BrowserTunnelClientOptions {
  logger: Logger;
  /** Push a frame up to the server, addressed to the named routing host. */
  sender: (
    daemonId: string,
    event: PatchBrowserTunnelOpenEvent | PatchBrowserTunnelDataEvent | PatchBrowserTunnelCloseEvent,
  ) => void;
  /** How long to hold a CONNECT open waiting for `ready`/`error`. Default 15s. */
  openTimeoutMs?: number;
}

/**
 * The BROWSING host's half. One instance serves every routing target this
 * host has ever used — each gets its OWN loopback listener (and so its own
 * port), lazily started on first use and kept for the host's life, because
 * Chromium's `proxy` option is fixed for a launched context's whole life
 * (`browser.ts` relaunches on a changed `routeThrough`, not this).
 */
export class BrowserTunnelClient {
  private readonly listeners = new Map<string, net.Server>();
  private readonly ports = new Map<string, number>();
  private readonly streams = new Map<string, PendingStream>();

  constructor(private readonly opts: BrowserTunnelClientOptions) {}

  /** The `socks5://127.0.0.1:<port>` Playwright's `proxy.server` should point at for this routing host. */
  async proxyServerFor(daemonId: string): Promise<string> {
    const existingPort = this.ports.get(daemonId);
    if (existingPort !== undefined) return `socks5://127.0.0.1:${existingPort}`;
    const server = net.createServer((socket) => this.handleConnection(daemonId, socket));
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('browser tunnel: SOCKS listener reported no port'));
          return;
        }
        resolve(address.port);
      });
    });
    this.listeners.set(daemonId, server);
    this.ports.set(daemonId, port);
    this.opts.logger.info({ daemonId, port }, 'browser tunnel: SOCKS listener started');
    return `socks5://127.0.0.1:${port}`;
  }

  private handleConnection(daemonId: string, socket: Socket): void {
    let awaitingGreeting = true;
    const onHandshakeData = (chunk: Buffer): void => {
      if (awaitingGreeting) {
        if (chunk.length < 2 || chunk[0] !== SOCKS_VERSION) {
          socket.destroy();
          return;
        }
        socket.write(Buffer.from([SOCKS_VERSION, 0x00])); // no-auth, always
        awaitingGreeting = false;
        return;
      }
      const request = parseConnectRequest(chunk);
      if (!request) {
        socket.write(socksReply(SOCKS_REPLY.commandNotSupported));
        socket.end();
        return;
      }
      socket.removeListener('data', onHandshakeData);
      this.openStream(daemonId, socket, request.host, request.port);
    };
    socket.on('data', onHandshakeData);
    socket.once('error', (err) =>
      this.opts.logger.warn({ err }, 'browser tunnel: SOCKS client socket error'),
    );
  }

  private openStream(daemonId: string, socket: Socket, host: string, port: number): void {
    const streamId = randomUUID();
    const timer = setTimeout(() => {
      this.streams.delete(streamId);
      socket.write(socksReply(SOCKS_REPLY.generalFailure));
      socket.destroy();
      this.opts.logger.warn(
        { daemonId, streamId, host, port },
        'browser tunnel: open timed out, no fallback',
      );
    }, this.opts.openTimeoutMs ?? 15_000);
    this.streams.set(streamId, { socket, daemonId, established: false, timer });

    socket.on('data', (chunk: Buffer) => {
      const stream = this.streams.get(streamId);
      if (!stream?.established) return;
      this.opts.sender(daemonId, {
        type: 'patch.browser_tunnel.data',
        streamId,
        data: chunk.toString('base64'),
      });
    });
    socket.once('close', () => {
      const stream = this.streams.get(streamId);
      if (!stream) return; // already torn down by handleEvent below
      this.streams.delete(streamId);
      clearTimeout(stream.timer);
      this.opts.sender(daemonId, { type: 'patch.browser_tunnel.close', streamId });
    });

    this.opts.sender(daemonId, {
      type: 'patch.browser_tunnel.open',
      streamId,
      daemonId,
      host,
      port,
    });
  }

  /** Feed in a `ready` / `data` / `close` / `error` frame relayed from the routing host. */
  /**
   * Is `streamId` one THIS instance is browsing (as opposed to one this host
   * is routing for someone else) — a `data`/`close` frame carries no role
   * marker of its own, so the caller (index.ts) uses this to tell the two
   * apart on a host that is doing both at once.
   */
  hasStream(streamId: string): boolean {
    return this.streams.has(streamId);
  }

  handleEvent(event: InboundToClient): void {
    const stream = this.streams.get(event.streamId);
    if (!stream) return; // this stream was already closed on this end
    if (event.type === 'patch.browser_tunnel.ready') {
      clearTimeout(stream.timer);
      stream.established = true;
      stream.socket.write(socksReply(SOCKS_REPLY.succeeded));
      return;
    }
    if (event.type === 'patch.browser_tunnel.data') {
      stream.socket.write(Buffer.from(event.data, 'base64'));
      return;
    }
    if (event.type === 'patch.browser_tunnel.close') {
      this.streams.delete(event.streamId);
      clearTimeout(stream.timer);
      stream.socket.destroy();
      return;
    }
    // error — NO FALLBACK: never try the destination directly from here.
    this.streams.delete(event.streamId);
    clearTimeout(stream.timer);
    if (!stream.established) stream.socket.write(socksReply(SOCKS_REPLY.connectionRefused));
    this.opts.logger.warn(
      { streamId: event.streamId, code: event.code, message: event.message },
      'browser tunnel: stream refused',
    );
    stream.socket.destroy();
  }

  /** Close every listener and stream (host shutdown). */
  dispose(): void {
    for (const server of this.listeners.values()) server.close();
    for (const stream of this.streams.values()) {
      clearTimeout(stream.timer);
      stream.socket.destroy();
    }
    this.listeners.clear();
    this.ports.clear();
    this.streams.clear();
  }
}

export interface BrowserTunnelRelayOptions {
  logger: Logger;
  sender: (
    event:
      | PatchBrowserTunnelReadyEvent
      | PatchBrowserTunnelDataEvent
      | PatchBrowserTunnelCloseEvent
      | PatchBrowserTunnelErrorEvent,
  ) => void;
  /**
   * Test-only: bind the outbound socket's local address, so a test can prove
   * which machine's egress actually carried the connection without standing
   * up two real hosts. Production never sets this — the OS picks the
   * routing host's normal default route.
   */
  localAddress?: string;
  /** Injectable for tests. */
  connect?: typeof net.connect;
}

/** The ROUTING host's half: for each `open`, makes the real outbound connection and pumps it. */
export class BrowserTunnelRelay {
  private readonly sockets = new Map<string, Socket>();

  constructor(private readonly opts: BrowserTunnelRelayOptions) {}

  private take(streamId: string): Socket | undefined {
    const socket = this.sockets.get(streamId);
    if (socket) this.sockets.delete(streamId);
    return socket;
  }

  /** Is `streamId` one THIS instance is routing — see `BrowserTunnelClient.hasStream`. */
  hasStream(streamId: string): boolean {
    return this.sockets.has(streamId);
  }

  handleOpen(event: PatchBrowserTunnelOpenEvent): void {
    const connect = this.opts.connect ?? net.connect;
    const socket = connect({
      host: event.host,
      port: event.port,
      ...(this.opts.localAddress !== undefined ? { localAddress: this.opts.localAddress } : {}),
    });
    this.sockets.set(event.streamId, socket);
    socket.once('connect', () => {
      this.opts.sender({ type: 'patch.browser_tunnel.ready', streamId: event.streamId });
    });
    socket.on('data', (chunk: Buffer) => {
      this.opts.sender({
        type: 'patch.browser_tunnel.data',
        streamId: event.streamId,
        data: chunk.toString('base64'),
      });
    });
    socket.once('error', (err) => {
      if (!this.take(event.streamId)) return;
      this.opts.sender({
        type: 'patch.browser_tunnel.error',
        streamId: event.streamId,
        code: 'connect_failed',
        message: err.message,
      });
    });
    socket.once('close', () => {
      if (!this.take(event.streamId)) return;
      this.opts.sender({ type: 'patch.browser_tunnel.close', streamId: event.streamId });
    });
  }

  handleData(event: PatchBrowserTunnelDataEvent): void {
    this.sockets.get(event.streamId)?.write(Buffer.from(event.data, 'base64'));
  }

  handleClose(event: PatchBrowserTunnelCloseEvent): void {
    this.take(event.streamId)?.destroy();
  }

  /** Close every open outbound connection (host shutdown). */
  dispose(): void {
    for (const socket of this.sockets.values()) socket.destroy();
    this.sockets.clear();
  }
}
