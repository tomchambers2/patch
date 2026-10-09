// The relay (spec/10 § Relay): a rendezvous that forwards bytes between a Patch
// server and the devices that reach it, and cannot read them. It never holds a
// key. It knows a channel (named by the hash of the server's public key, so only
// the server can hold it), how many devices are on it, and how many bytes move.
//
//   GET /v1/connect?channel=<id>&role=server|client      (WebSocket)
//
//   server  ← {"type":"challenge","nonce":…}
//   server  → {"type":"hello","publicKey":…,"signature":…}   Ed25519 over
//                                  "patch-relay-v1|<channel>|<nonce>"
//   server  ← {"type":"ready"}
//   server  ← {"type":"open","cid":N}          a device arrived
//   server  ↔ binary  [cid u32 BE][opaque bytes]
//   server  ← {"type":"close","cid":N}         a device left
//   server  → {"type":"close","cid":N}         drop that device
//
//   client  ← {"type":"ready"}                 then binary, opaque, both ways
//
// Close codes: 4400 bad request, 4401 server not proven, 4404 server offline,
// 4408 no hello in time, 4409 replaced by a newer connection of the same server,
// 4410 closed by the server, 4429 channel full, 4503 server went away.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ed25519 } from '@noble/curves/ed25519';
import { randomBytes } from '@noble/hashes/utils';
import { WebSocketServer, type WebSocket, type RawData } from 'ws';
import { channelFor, fromBase64Url, toBase64Url } from './crypto.js';

export interface RelayServerOptions {
  port: number;
  host?: string;
  /** Devices allowed on one channel at once. */
  maxClientsPerChannel?: number;
  /** Largest message the relay forwards. A transport frame is at most ~64 KiB. */
  maxMessageBytes?: number;
  /** How long a connecting server has to answer the challenge. */
  helloTimeoutMs?: number;
  /** Ping interval; a socket that misses the next pong is closed. */
  pingIntervalMs?: number;
  /**
   * Told of every frame the relay forwards, exactly as the relay holds it. For
   * metering — and for the test that proves the relay holds nothing readable.
   */
  onFrame?: (frame: {
    channel: string;
    from: 'server' | 'client';
    binary: boolean;
    bytes: Uint8Array;
  }) => void;
}

export interface RelayServerHandle {
  port: number;
  stats(): { servers: number; clients: number };
  close(): Promise<void>;
}

interface Channel {
  server: WebSocket;
  clients: Map<number, WebSocket>;
  nextCid: number;
}

const CHANNEL_RE = /^[A-Za-z0-9_-]{22}$/;

export async function createRelayServer(opts: RelayServerOptions): Promise<RelayServerHandle> {
  const maxClients = opts.maxClientsPerChannel ?? 16;
  const maxMessage = opts.maxMessageBytes ?? 128 * 1024;
  const helloTimeout = opts.helloTimeoutMs ?? 10_000;
  const pingEvery = opts.pingIntervalMs ?? 30_000;
  const channels = new Map<string, Channel>();

  const http: Server = createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...stats() }));
      return;
    }
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: maxMessage });

  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://relay');
    if (url.pathname !== '/v1/connect') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      // An oversized or malformed frame is the sender's fault; `ws` has already
      // closed with the right code, and an unhandled 'error' would take the relay down.
      ws.on('error', () => undefined);
      const channel = url.searchParams.get('channel') ?? '';
      const role = url.searchParams.get('role');
      if (!CHANNEL_RE.test(channel) || (role !== 'server' && role !== 'client')) {
        ws.close(4400, 'bad request');
        return;
      }
      if (role === 'server') acceptServer(ws, channel);
      else acceptClient(ws, channel);
    });
  });

  function acceptServer(ws: WebSocket, channel: string): void {
    const nonce = toBase64Url(randomBytes(24));
    ws.send(JSON.stringify({ type: 'challenge', nonce }));
    const timer = setTimeout(() => ws.close(4408, 'no hello'), helloTimeout);
    ws.once('close', () => clearTimeout(timer));
    ws.once('message', (data: RawData, isBinary: boolean) => {
      clearTimeout(timer);
      let proven = false;
      try {
        if (isBinary) throw new Error('binary hello');
        const hello = JSON.parse(data.toString()) as { publicKey?: string; signature?: string };
        const pub = fromBase64Url(hello.publicKey ?? '');
        proven =
          channelFor(pub) === channel &&
          ed25519.verify(
            fromBase64Url(hello.signature ?? ''),
            new TextEncoder().encode(`patch-relay-v1|${channel}|${nonce}`),
            pub,
          );
      } catch {
        proven = false;
      }
      if (!proven) {
        ws.close(4401, 'not the server of this channel');
        return;
      }
      const previous = channels.get(channel);
      const entry: Channel = {
        server: ws,
        clients: previous?.clients ?? new Map(),
        nextCid: previous?.nextCid ?? 1,
      };
      channels.set(channel, entry);
      previous?.server.close(4409, 'replaced');
      ws.send(JSON.stringify({ type: 'ready' }));
      // Devices that were on the replaced connection are still here: tell the new one.
      for (const cid of entry.clients.keys()) ws.send(JSON.stringify({ type: 'open', cid }));

      ws.on('message', (frame: RawData, binary: boolean) => {
        opts.onFrame?.({ channel, from: 'server', binary, bytes: new Uint8Array(frame as Buffer) });
        if (binary) {
          const buf = frame as Buffer;
          if (buf.length < 4) return;
          entry.clients.get(buf.readUInt32BE(0))?.send(buf.subarray(4), { binary: true });
          return;
        }
        try {
          const msg = JSON.parse(frame.toString()) as { type?: string; cid?: number };
          if (msg.type === 'close' && typeof msg.cid === 'number') {
            entry.clients.get(msg.cid)?.close(4410, 'closed by the server');
          }
        } catch {
          ws.close(4400, 'bad control message');
        }
      });
      ws.once('close', () => {
        if (channels.get(channel) !== entry) return; // replaced: the clients moved with it
        channels.delete(channel);
        for (const client of entry.clients.values()) client.close(4503, 'server went away');
      });
    });
  }

  function acceptClient(ws: WebSocket, channel: string): void {
    const entry = channels.get(channel);
    if (!entry) {
      ws.close(4404, 'server offline');
      return;
    }
    if (entry.clients.size >= maxClients) {
      ws.close(4429, 'channel full');
      return;
    }
    const cid = entry.nextCid++;
    entry.clients.set(cid, ws);
    entry.server.send(JSON.stringify({ type: 'open', cid }));
    ws.send(JSON.stringify({ type: 'ready' }));
    ws.on('message', (data: RawData, isBinary: boolean) => {
      opts.onFrame?.({
        channel,
        from: 'client',
        binary: isBinary,
        bytes: new Uint8Array(data as Buffer),
      });
      if (!isBinary) {
        // Control is the relay's alone; a device cannot speak to the server in it.
        ws.close(4400, 'binary only');
        return;
      }
      const payload = data as Buffer;
      const framed = Buffer.allocUnsafe(4 + payload.length);
      framed.writeUInt32BE(cid, 0);
      payload.copy(framed, 4);
      const live = channels.get(channel);
      live?.server.send(framed, { binary: true });
    });
    ws.once('close', () => {
      const live = channels.get(channel);
      if (live?.clients.get(cid) !== ws) return;
      live.clients.delete(cid);
      if (live.server.readyState === live.server.OPEN) {
        live.server.send(JSON.stringify({ type: 'close', cid }));
      }
    });
  }

  // Liveness: ping everything; a socket that did not answer the last ping is closed.
  const alive = new WeakMap<WebSocket, boolean>();
  wss.on('connection', (ws) => {
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));
  });
  const pinger = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, pingEvery);
  pinger.unref();

  function stats(): { servers: number; clients: number } {
    let clients = 0;
    for (const c of channels.values()) clients += c.clients.size;
    return { servers: channels.size, clients };
  }

  await new Promise<void>((resolve) => http.listen(opts.port, opts.host ?? '0.0.0.0', resolve));
  return {
    port: (http.address() as AddressInfo).port,
    stats,
    async close() {
      clearInterval(pinger);
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
