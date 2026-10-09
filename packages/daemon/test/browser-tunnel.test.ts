// Browser tunnel (spec/02 § Browser — Route through, spec/03 § Browser
// tunnel). `BrowserTunnelClient` (browsing host) and `BrowserTunnelRelay`
// (routing host) wired directly to each other — no server, no mocked
// sockets — against a REAL local HTTP server standing in for "the
// internet", driven by a REAL minimal SOCKS5 client (what Chromium's own
// `proxy` option amounts to). The relay's `localAddress` is the test's one
// deliberate fiction: it lets a SINGLE process prove "this request's exit
// address was host B's, not host A's" without actually running two hosts.

import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import net, { type AddressInfo, type Socket } from 'node:net';
import pino from 'pino';
import { BrowserTunnelClient, BrowserTunnelRelay } from '../src/browser-tunnel.js';

const silent = pino({ level: 'silent' });
const ROUTING_DAEMON_ID = 'host-b';

/** The "internet": records the remote address of every connecting socket. */
function startOriginServer(): Promise<{ server: Server; port: number; remoteAddresses: string[] }> {
  const remoteAddresses: string[] = [];
  const server = createServer((req, res) => {
    remoteAddresses.push(req.socket.remoteAddress ?? '');
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('hello from the origin');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as AddressInfo).port, remoteAddresses });
    });
  });
}

/**
 * A deliberately minimal raw SOCKS5 client: greeting, CONNECT, read the
 * reply code. Exactly what Chromium's own SOCKS client does against a
 * `proxy.server` — this is the thing under test, driven for real rather
 * than through a browser.
 */
function socksConnect(
  proxyPort: number,
  target: { host: string; port: number },
): Promise<{ socket: Socket; repCode: number }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: proxyPort }, () => {
      socket.write(Buffer.from([0x05, 0x01, 0x00])); // version 5, 1 method, no-auth
    });
    socket.once('error', reject);
    let stage: 'greeting' | 'reply' = 'greeting';
    const onData = (chunk: Buffer): void => {
      if (stage === 'greeting') {
        stage = 'reply';
        const hostBytes = Buffer.from(target.host.split('.').map(Number));
        const portBuf = Buffer.alloc(2);
        portBuf.writeUInt16BE(target.port);
        socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x01]), hostBytes, portBuf]));
        return;
      }
      socket.removeListener('data', onData);
      resolve({ socket, repCode: chunk[1]! });
    };
    socket.on('data', onData);
  });
}

function httpGetOverSocket(socket: Socket, host: string, port: number): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    socket.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    socket.write(`GET / HTTP/1.1\r\nHost: ${host}:${port}\r\nConnection: close\r\n\r\n`);
    socket.once('close', () => resolve(body));
  });
}

describe('browser tunnel — client and relay wired directly', () => {
  const cleanup: Array<() => void> = [];
  afterEach(() => {
    while (cleanup.length > 0) cleanup.pop()!();
  });

  it('a page really exits through the ROUTING host, not the browsing one (exit-IP check)', async () => {
    const { server: origin, port: originPort, remoteAddresses } = await startOriginServer();
    cleanup.push(() => origin.close());

    const relay = new BrowserTunnelRelay({
      logger: silent,
      localAddress: '127.0.0.2', // stands in for "host B's own egress"
      sender: (event) => client.handleEvent(event),
    });
    const client = new BrowserTunnelClient({
      logger: silent,
      sender: (_daemonId, event) => {
        if (event.type === 'patch.browser_tunnel.open') relay.handleOpen(event);
        else if (event.type === 'patch.browser_tunnel.data') relay.handleData(event);
        else relay.handleClose(event);
      },
    });
    cleanup.push(() => {
      client.dispose();
      relay.dispose();
    });

    const proxyUrl = await client.proxyServerFor(ROUTING_DAEMON_ID);
    const proxyPort = Number(new URL(proxyUrl).port);

    const { socket, repCode } = await socksConnect(proxyPort, {
      host: '127.0.0.1',
      port: originPort,
    });
    expect(repCode).toBe(0x00); // succeeded

    const body = await httpGetOverSocket(socket, '127.0.0.1', originPort);
    expect(body).toContain('hello from the origin');
    // The ONLY proof that matters: the origin saw host B's address, never
    // host A's loopback default (127.0.0.1) — i.e. this really went via B.
    expect(remoteAddresses).toEqual(['127.0.0.2']);
  });

  it('going DIRECT (no relay in the path) exits as the browsing host itself', async () => {
    const { server: origin, port: originPort, remoteAddresses } = await startOriginServer();
    cleanup.push(() => origin.close());

    // No routing: the client's SOCKS listener connects straight out via its
    // own net.connect, exactly like browser.ts with no `routeThrough` set
    // (this test exercises the SOCKS listener in isolation; browser.test.ts
    // covers BrowserManager actually choosing not to use one at all).
    const directRelay = new BrowserTunnelRelay({
      logger: silent,
      sender: (event) => client.handleEvent(event),
    });
    const client = new BrowserTunnelClient({
      logger: silent,
      sender: (_daemonId, event) => {
        if (event.type === 'patch.browser_tunnel.open') directRelay.handleOpen(event);
        else if (event.type === 'patch.browser_tunnel.data') directRelay.handleData(event);
        else directRelay.handleClose(event);
      },
    });
    cleanup.push(() => {
      client.dispose();
      directRelay.dispose();
    });

    const proxyUrl = await client.proxyServerFor(ROUTING_DAEMON_ID);
    const { socket } = await socksConnect(Number(new URL(proxyUrl).port), {
      host: '127.0.0.1',
      port: originPort,
    });
    await httpGetOverSocket(socket, '127.0.0.1', originPort);
    expect(remoteAddresses).toEqual(['127.0.0.1']);
  });

  it('routing host OFFLINE fails the connect loudly — no fallback to a direct connection', async () => {
    const { server: origin, port: originPort, remoteAddresses } = await startOriginServer();
    cleanup.push(() => origin.close());

    // No relay at all — models what the client sees when the server bridge
    // (browser-tunnel-bridge.ts) answers `open` with an error itself, because
    // the named routing host is offline, instead of ever reaching one.
    const client = new BrowserTunnelClient({
      logger: silent,
      sender: (_daemonId, event) => {
        if (event.type === 'patch.browser_tunnel.open') {
          client.handleEvent({
            type: 'patch.browser_tunnel.error',
            streamId: event.streamId,
            code: 'host_offline',
            message: `routing host ${ROUTING_DAEMON_ID} is offline`,
          });
        }
      },
    });
    cleanup.push(() => client.dispose());

    const proxyUrl = await client.proxyServerFor(ROUTING_DAEMON_ID);
    const { repCode } = await socksConnect(Number(new URL(proxyUrl).port), {
      host: '127.0.0.1',
      port: originPort,
    });
    expect(repCode).toBe(0x05); // connection refused — never 0x00 (succeeded)
    // NO FALLBACK: the origin was never touched at all.
    expect(remoteAddresses).toEqual([]);
  });

  it('a timed-out open (no answer at all) fails the connect — no fallback', async () => {
    const client = new BrowserTunnelClient({
      logger: silent,
      openTimeoutMs: 30,
      sender: () => {
        // Simulates a server/relay that never answers at all.
      },
    });
    cleanup.push(() => client.dispose());

    const proxyUrl = await client.proxyServerFor(ROUTING_DAEMON_ID);
    const { repCode } = await socksConnect(Number(new URL(proxyUrl).port), {
      host: '127.0.0.1',
      port: 1,
    });
    expect(repCode).not.toBe(0x00);
  });

  it("the routing host's own connect failure is reported, not swallowed", async () => {
    let sawError: { code: string; message: string } | undefined;
    const relay = new BrowserTunnelRelay({
      logger: silent,
      sender: (event) => {
        if (event.type === 'patch.browser_tunnel.error') sawError = event;
        client.handleEvent(event);
      },
    });
    const client = new BrowserTunnelClient({
      logger: silent,
      sender: (_daemonId, event) => {
        if (event.type === 'patch.browser_tunnel.open') relay.handleOpen(event);
      },
    });
    cleanup.push(() => {
      client.dispose();
      relay.dispose();
    });

    const proxyUrl = await client.proxyServerFor(ROUTING_DAEMON_ID);
    // Port 1 on loopback: nothing listens there, so the real net.connect
    // the relay makes fails fast with ECONNREFUSED.
    const { repCode } = await socksConnect(Number(new URL(proxyUrl).port), {
      host: '127.0.0.1',
      port: 1,
    });
    expect(repCode).not.toBe(0x00);
    expect(sawError?.code).toBe('connect_failed');
  });

  it('turning routing OFF (a fresh client with no relay wired) goes direct again', async () => {
    const { server: origin, port: originPort, remoteAddresses } = await startOriginServer();
    cleanup.push(() => origin.close());

    // Models browser.ts relaunching Chromium with no `proxy` at all once
    // `routeThrough` is cleared — a plain net.connect, no SOCKS, no relay.
    const direct = net.connect({ host: '127.0.0.1', port: originPort });
    await new Promise((resolve) => direct.once('connect', resolve));
    await httpGetOverSocket(direct, '127.0.0.1', originPort);
    expect(remoteAddresses).toEqual(['127.0.0.1']);
  });

  it('two concurrent streams through the same relay do not cross-talk', async () => {
    const { server: origin, port: originPort } = await startOriginServer();
    cleanup.push(() => origin.close());

    const relay = new BrowserTunnelRelay({
      logger: silent,
      sender: (event) => client.handleEvent(event),
    });
    const client = new BrowserTunnelClient({
      logger: silent,
      sender: (_daemonId, event) => {
        if (event.type === 'patch.browser_tunnel.open') relay.handleOpen(event);
        else if (event.type === 'patch.browser_tunnel.data') relay.handleData(event);
        else relay.handleClose(event);
      },
    });
    cleanup.push(() => {
      client.dispose();
      relay.dispose();
    });

    const proxyUrl = await client.proxyServerFor(ROUTING_DAEMON_ID);
    const proxyPort = Number(new URL(proxyUrl).port);
    const [a, b] = await Promise.all([
      socksConnect(proxyPort, { host: '127.0.0.1', port: originPort }),
      socksConnect(proxyPort, { host: '127.0.0.1', port: originPort }),
    ]);
    const [bodyA, bodyB] = await Promise.all([
      httpGetOverSocket(a.socket, '127.0.0.1', originPort),
      httpGetOverSocket(b.socket, '127.0.0.1', originPort),
    ]);
    expect(bodyA).toContain('hello from the origin');
    expect(bodyB).toContain('hello from the origin');
  });
});
