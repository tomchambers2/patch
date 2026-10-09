// A loopback listener that is the far server (spec/05 § Desktop). The desktop
// shell cannot load a page from a server it can only reach through a relay, so
// it loads it from here: every request and every WebSocket this listener
// receives is carried through the encrypted session and made again on the
// server, and the answer carried back. The page cannot tell the difference, and
// nothing in it knows there is a relay.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { RelayConnection, type RelayClient } from './client.js';

export interface BridgeOptions {
  /** Open a session to the far server. Called again after one ends. */
  connect: () => Promise<RelayClient>;
  port?: number;
}

export interface Bridge {
  /** `http://127.0.0.1:<port>` — what the shell loads. */
  origin: string;
  close(): Promise<void>;
}

const readBody = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });

export async function startBridge(opts: BridgeOptions): Promise<Bridge> {
  const connection = new RelayConnection(opts.connect);
  const session = (): Promise<RelayClient> => connection.session();

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const client = await session();
      const body = req.method === 'GET' || req.method === 'HEAD' ? null : await readBody(req);
      const out = await client.fetch(req.url ?? '/', {
        method: req.method ?? 'GET',
        headers: Object.entries(req.headers).flatMap(([k, v]) =>
          typeof v === 'string' ? [[k, v] as [string, string]] : [],
        ),
        ...(body && body.length > 0 ? { body: new Uint8Array(body) } : {}),
      });
      res.writeHead(out.status, out.statusText, out.headers);
      res.end(out.status === 204 || out.status === 304 ? undefined : Buffer.from(out.body));
    } catch (e) {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(
        `Could not reach the server through the relay: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    session().then(
      (client) =>
        wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
          const protocols = String(req.headers['sec-websocket-protocol'] ?? '')
            .split(',')
            .map((p) => p.trim())
            .filter(Boolean);
          const far = client.openSocket(req.url ?? '/', protocols);
          const queued: Array<{ data: Buffer; isBinary: boolean }> = [];
          ws.on('message', (data: Buffer, isBinary: boolean) => {
            if (far.readyState === 1) far.send(isBinary ? new Uint8Array(data) : data.toString());
            else queued.push({ data, isBinary });
          });
          far.onopen = () => {
            for (const m of queued.splice(0))
              far.send(m.isBinary ? new Uint8Array(m.data) : m.data.toString());
          };
          far.onmessage = (ev) =>
            ws.send(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data));
          far.onclose = (ev) =>
            ws.close(
              ev.code >= 1000 && ev.code <= 4999 && ev.code !== 1005 && ev.code !== 1006
                ? ev.code
                : 1011,
              ev.reason.slice(0, 120),
            );
          far.onerror = () => ws.close(1011, 'could not open the socket');
          ws.on('close', () => far.close());
          ws.on('error', () => far.close());
        }),
      () => socket.destroy(),
    );
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    async close() {
      for (const ws of wss.clients) ws.terminate();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      connection.close();
    },
  };
}
