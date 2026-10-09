// The whole path, for real: a relay, a host terminating on a real local HTTP and
// WebSocket server, and a device using the client. What the relay held on the way
// is recorded, to prove it holds nothing readable.

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { RelayClient, RelayConnection, RelayError, type WebSocketCtor } from '../src/client.js';
import {
  channelFor,
  generateServerIdentity,
  toBase64Url,
  type ServerIdentity,
} from '../src/crypto.js';
import { RelayHost } from '../src/host.js';
import { createRelayServer, type RelayServerHandle } from '../src/server.js';

const SECRET = 'sk-live-THE-SECRET-the-relay-must-never-read-0123456789';

let relay: RelayServerHandle;
let relayUrl: string;
let target: Server;
let targetUrl: string;
let wss: WebSocketServer;
let identity: ServerIdentity;
let host: RelayHost;
let seen: Buffer[];
let targetSockets: WebSocket[];

const readBody = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => resolve(Buffer.concat(parts)));
  });

beforeEach(async () => {
  seen = [];
  targetSockets = [];
  relay = await createRelayServer({
    port: 0,
    host: '127.0.0.1',
    onFrame: (f) => seen.push(Buffer.from(f.bytes)),
  });
  relayUrl = `ws://127.0.0.1:${relay.port}`;
  target = createServer(async (req, res) => {
    const body = await readBody(req);
    const pathname = new URL(req.url ?? '/', 'http://x').pathname;
    if (pathname === '/echo') {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'x-seen-auth': String(req.headers.authorization),
      });
      res.end(body);
    } else if (pathname === '/json') {
      res.writeHead(201, { 'content-type': 'application/json', 'set-cookie': 'a=b' });
      res.end(
        JSON.stringify({
          method: req.method,
          auth: req.headers.authorization ?? null,
          got: body.toString(),
        }),
      );
    } else if (pathname === '/big') {
      res.writeHead(200);
      res.end(Buffer.alloc(300_000, 7));
    } else if (pathname === '/redirect') {
      res.writeHead(302, { location: '/json' });
      res.end();
    } else if (pathname === '/slow') {
      const t = setTimeout(() => res.end('late'), 5_000);
      res.on('close', () => clearTimeout(t));
    } else {
      res.writeHead(404).end('nope');
    }
  });
  wss = new WebSocketServer({ server: target, path: '/ws' });
  wss.on('connection', (sock, req) => {
    targetSockets.push(sock);
    sock.send(`welcome ${req.headers['sec-websocket-protocol'] ?? ''}`.trim());
    sock.on('message', (data, isBinary) =>
      sock.send(
        isBinary ? Buffer.concat([Buffer.from('bin:'), data as Buffer]) : `echo:${data.toString()}`,
      ),
    );
  });
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
  targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;
  identity = generateServerIdentity();
  host = new RelayHost({ relayUrl, identity, target: targetUrl, backoffMs: { min: 20, max: 100 } });
  host.start();
  await until(() => host.status().connected);
});

afterEach(async () => {
  host.stop();
  for (const s of targetSockets) s.terminate();
  wss.close();
  await new Promise<void>((r) => target.close(() => r()));
  await relay.close();
});

async function until(pick: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!pick()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const connect = (
  over: Partial<{ serverKey: string; channel: string }> = {},
): Promise<RelayClient> =>
  RelayClient.connect(
    {
      url: relayUrl,
      channel: over.channel ?? channelFor(identity.publicKey),
      serverKey: over.serverKey ?? toBase64Url(identity.publicKey),
    },
    { WebSocket: WebSocket as unknown as WebSocketCtor },
  );

describe('HTTP through the tunnel', () => {
  it('makes the request on the server’s own address and brings the answer back', async () => {
    const client = await connect();
    const res = await client.fetch('/json', {
      method: 'POST',
      headers: { Authorization: 'Bearer abc', 'Content-Type': 'application/json' },
      body: '{"hello":"world"}',
    });
    expect(res.status).toBe(201);
    expect(res.headers['content-type']).toBe('application/json');
    expect(JSON.parse(new TextDecoder().decode(res.body))).toEqual({
      method: 'POST',
      auth: 'Bearer abc',
      got: '{"hello":"world"}',
    });
    client.close();
  });

  it('carries a body larger than one frame each way, byte for byte', async () => {
    const client = await connect();
    const up = new Uint8Array(200_000).map((_, i) => i % 251);
    const echoed = await client.fetch('/echo', { method: 'PUT', body: up });
    expect(echoed.body.length).toBe(200_000);
    expect(Buffer.from(echoed.body).equals(Buffer.from(up))).toBe(true);
    const big = await client.fetch('/big');
    expect(big.body.length).toBe(300_000);
    client.close();
  });

  it('passes a redirect through instead of following it', async () => {
    const client = await connect();
    const res = await client.fetch('/redirect');
    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe('/json');
    client.close();
  });

  it('answers 404 as 404', async () => {
    const client = await connect();
    expect((await client.fetch('/missing')).status).toBe(404);
    client.close();
  });

  it('runs requests side by side on one session', async () => {
    const client = await connect();
    const all = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        client.fetch('/echo', { method: 'POST', body: `n${i}` }),
      ),
    );
    expect(all.map((r) => new TextDecoder().decode(r.body))).toEqual(
      Array.from({ length: 20 }, (_, i) => `n${i}`),
    );
    client.close();
  });

  it('cancels an abandoned request without ending the session', async () => {
    const client = await connect();
    let abort: () => void = () => undefined;
    const signal = {
      aborted: false,
      addEventListener: (_: 'abort', cb: () => void) => (abort = cb),
    };
    const slow = client.fetch('/slow', { signal });
    await new Promise((r) => setTimeout(r, 30));
    abort();
    await expect(slow).rejects.toThrow(/aborted/);
    expect((await client.fetch('/missing')).status).toBe(404);
    client.close();
  });

  it('says so when the server behind the relay is not answering', async () => {
    const down = new RelayHost({
      relayUrl,
      identity: generateServerIdentity(),
      target: 'http://127.0.0.1:1',
      backoffMs: { min: 20, max: 100 },
    });
    down.start();
    await until(() => down.status().connected);
    const client = await RelayClient.connect(
      {
        url: relayUrl,
        channel: down.channel,
        serverKey: toBase64Url(
          (down as unknown as { opts: { identity: ServerIdentity } }).opts.identity.publicKey,
        ),
      },
      { WebSocket: WebSocket as unknown as WebSocketCtor },
    );
    await expect(client.fetch('/anything')).rejects.toThrow(/did not answer/);
    client.close();
    down.stop();
  });
});

describe('WebSockets through the tunnel', () => {
  it('opens a socket on the server and carries text and binary both ways', async () => {
    const client = await connect();
    const sock = client.openSocket('/ws', ['patch.v1']);
    const got: (string | ArrayBuffer)[] = [];
    sock.onmessage = (e) => got.push(e.data);
    await until(() => sock.readyState === 1);
    await until(() => got.length === 1);
    expect(got[0]).toBe('welcome patch.v1');
    sock.send('hi');
    sock.send(Uint8Array.of(1, 2, 3));
    await until(() => got.length === 3);
    expect(got[1]).toBe('echo:hi');
    expect(Array.from(new Uint8Array(got[2] as ArrayBuffer))).toEqual([
      ...Buffer.from('bin:'),
      1,
      2,
      3,
    ]);
    client.close();
  });

  it('reports a close from either end', async () => {
    const client = await connect();
    const a = client.openSocket('/ws');
    const closed: number[] = [];
    a.onclose = (e) => closed.push(e.code);
    await until(() => a.readyState === 1);
    a.close(1000, 'bye');
    await until(() => closed.length === 1);
    expect(closed).toEqual([1000]);

    const b = client.openSocket('/ws');
    const bClosed: number[] = [];
    b.onclose = (e) => bClosed.push(e.code);
    await until(() => b.readyState === 1);
    targetSockets.at(-1)!.close(4001, 'server says no');
    await until(() => bClosed.length === 1);
    expect(bClosed).toEqual([4001]);
    client.close();
  });

  it('errors when the path has no socket behind it', async () => {
    const client = await connect();
    const s = client.openSocket('/not-a-socket');
    const errors: string[] = [];
    s.onerror = (e) => errors.push(e.message);
    await until(() => s.readyState === 3);
    expect(errors[0]).toMatch(/could not open the socket/);
    client.close();
  });

  it('refuses to send on a socket that is not open', async () => {
    const client = await connect();
    const s = client.openSocket('/not-a-socket');
    expect(() => s.send('x')).toThrow(/not open/);
    await until(() => s.readyState === 3);
    client.close();
  });
});

describe('what the relay can see', () => {
  it('holds nothing readable: not the path, the header, the body, the answer or a socket message', async () => {
    const client = await connect();
    const secretBytes = Buffer.from(SECRET);
    const res = await client.fetch(`/echo?token=${SECRET}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SECRET}` },
      body: SECRET,
    });
    expect(new TextDecoder().decode(res.body)).toBe(SECRET);
    const sock = client.openSocket('/ws');
    const got: unknown[] = [];
    sock.onmessage = (e) => got.push(e.data);
    await until(() => got.length === 1);
    sock.send(SECRET);
    await until(() => got.length === 2);
    expect(got[1]).toBe(`echo:${SECRET}`);

    expect(seen.length).toBeGreaterThan(5);
    for (const frame of seen) {
      expect(frame.includes(secretBytes)).toBe(false);
      expect(frame.includes(Buffer.from('/echo'))).toBe(false);
      expect(frame.includes(Buffer.from('Bearer'))).toBe(false);
      expect(frame.includes(Buffer.from(toBase64Url(Buffer.from(SECRET))))).toBe(false);
    }
    client.close();
  });
});

describe('who is on the other end', () => {
  it('refuses a pairing code whose channel is not its key’s', async () => {
    await expect(
      connect({ channel: channelFor(generateServerIdentity().publicKey) }),
    ).rejects.toThrow(/channel/);
  });

  it('refuses a relay that answers with another server: a channel held by an impostor', async () => {
    // The impostor holds the channel the real key names? It cannot — the relay
    // makes it prove the key. So take the next best: the code names a key whose
    // channel is held by a host that does NOT have that key. Impossible to
    // register; the client sees "server offline".
    const other = generateServerIdentity();
    await expect(
      connect({ serverKey: toBase64Url(other.publicKey), channel: channelFor(other.publicKey) }),
    ).rejects.toThrow(/offline/);
  });

  it('is told when the server is offline', async () => {
    host.stop();
    await until(() => relay.stats().servers === 0);
    const err = await connect().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RelayError);
    expect((err as RelayError).code).toBe(4404);
  });
});

describe('losing the connection', () => {
  it('ends the device’s session and everything on it, and the host reconnects by itself', async () => {
    const client = await connect();
    const sock = client.openSocket('/ws');
    const closes: number[] = [];
    sock.onclose = (e) => closes.push(e.code);
    await until(() => sock.readyState === 1);
    const reasons: string[] = [];
    client.onClose((r) => reasons.push(r));

    // The relay restarts under them.
    const port = relay.port;
    await relay.close();
    await until(() => !host.status().connected);
    await until(() => client.closed);
    expect(closes).toEqual([1006]);
    expect(reasons).toHaveLength(1);
    await expect(client.fetch('/json')).rejects.toThrow(/closed/);

    relay = await createRelayServer({
      port,
      host: '127.0.0.1',
      onFrame: (f) => seen.push(Buffer.from(f.bytes)),
    });
    await until(() => host.status().connected, 5000);
    const again = await connect();
    expect((await again.fetch('/missing')).status).toBe(404);
    again.close();
  });
});

describe('a route that outlives any one session', () => {
  const route = (over: Partial<{ serverKey: string; channel: string }> = {}): RelayConnection =>
    RelayConnection.to(
      {
        url: relayUrl,
        channel: over.channel ?? channelFor(identity.publicKey),
        serverKey: over.serverKey ?? toBase64Url(identity.publicKey),
      },
      { WebSocket: WebSocket as unknown as WebSocketCtor },
    );

  it('dials on first use, shares the session, and says it is connected', async () => {
    const conn = route();
    expect(conn.status.state).toBe('idle');
    const states: string[] = [];
    conn.onStatus(() => states.push(conn.status.state));
    const [a, b] = await Promise.all([conn.fetch('/missing'), conn.fetch('/missing')]);
    expect([a.status, b.status]).toEqual([404, 404]);
    expect(states).toEqual(['connecting', 'connected']);
    expect(relay.stats().clients).toBe(1);
    conn.close();
  });

  it('hands back a socket at once and opens it when the session is up', async () => {
    const conn = route();
    const sock = conn.openSocket('/ws');
    expect(sock.readyState).toBe(0);
    const got: unknown[] = [];
    sock.onmessage = (e) => got.push(e.data);
    await until(() => got.length === 1);
    expect(sock.readyState).toBe(1);
    sock.send('x');
    await until(() => got.length === 2);
    conn.close();
  });

  it('dials a new session after one has ended', async () => {
    const conn = route();
    await conn.fetch('/missing');
    const first = await conn.session();
    first.close();
    expect((await conn.fetch('/missing')).status).toBe(404);
    expect(await conn.session()).not.toBe(first);
    conn.close();
  });

  it('reports offline, with the reason, when the server is not there — and tries again next time', async () => {
    host.stop();
    await until(() => relay.stats().servers === 0);
    const conn = route();
    await expect(conn.fetch('/x')).rejects.toThrow(/offline/);
    expect(conn.status).toEqual({ state: 'offline', error: expect.stringMatching(/offline/) });
    const sock = conn.openSocket('/ws');
    const errors: string[] = [];
    sock.onerror = (e) => errors.push(e.message);
    await until(() => sock.readyState === 3);
    expect(errors[0]).toMatch(/offline/);
    host.start();
    await until(() => host.status().connected);
    expect((await conn.fetch('/missing')).status).toBe(404);
    conn.close();
  });

  it('does not open a socket that was closed before the session arrived', async () => {
    const conn = route();
    const sock = conn.openSocket('/ws');
    sock.close();
    await conn.session();
    await new Promise((r) => setTimeout(r, 50));
    expect(targetSockets).toHaveLength(0);
    conn.close();
  });
});
