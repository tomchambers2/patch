// The desktop's way in to a relayed server: a loopback HTTP/WebSocket listener
// whose every request is carried through the encrypted session. The page loads
// from it as though the server were on this machine.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { startBridge, type Bridge } from '../src/bridge.js';
import { RelayClient, type WebSocketCtor } from '../src/client.js';
import { channelFor, generateServerIdentity, toBase64Url } from '../src/crypto.js';
import { RelayHost } from '../src/host.js';
import { createRelayServer, type RelayServerHandle } from '../src/server.js';

let relay: RelayServerHandle;
let target: Server;
let wss: WebSocketServer;
let host: RelayHost;
let bridge: Bridge;
let connects: number;

async function until(pick: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!pick()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeEach(async () => {
  connects = 0;
  relay = await createRelayServer({ port: 0, host: '127.0.0.1' });
  target = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => {
      if (req.url === '/app/') {
        res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'a=1' });
        res.end('<h1>patch</h1>');
      } else if (req.url === '/gone') {
        res.writeHead(204).end();
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            method: req.method,
            url: req.url,
            auth: req.headers.authorization ?? null,
            body: Buffer.concat(parts).toString(),
          }),
        );
      }
    });
  });
  wss = new WebSocketServer({ server: target, path: '/ws' });
  wss.on('connection', (s) =>
    s.on('message', (d, bin) => s.send(bin ? d : `echo:${d.toString()}`)),
  );
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
  const identity = generateServerIdentity();
  host = new RelayHost({
    relayUrl: `ws://127.0.0.1:${relay.port}`,
    identity,
    target: `http://127.0.0.1:${(target.address() as AddressInfo).port}`,
  });
  host.start();
  await until(() => host.status().connected);
  bridge = await startBridge({
    connect: () => {
      connects++;
      return RelayClient.connect(
        {
          url: `ws://127.0.0.1:${relay.port}`,
          channel: channelFor(identity.publicKey),
          serverKey: toBase64Url(identity.publicKey),
        },
        { WebSocket: WebSocket as unknown as WebSocketCtor },
      );
    },
  });
});
afterEach(async () => {
  await bridge.close();
  host.stop();
  wss.close();
  await new Promise<void>((r) => target.close(() => r()));
  await relay.close();
});

describe('the bridge', () => {
  it('serves a page from the far server on a loopback address', async () => {
    expect(bridge.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const res = await fetch(`${bridge.origin}/app/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html');
    expect(await res.text()).toBe('<h1>patch</h1>');
  });

  it('passes method, headers and a body through, and a bodyless status as it is', async () => {
    const res = await fetch(`${bridge.origin}/api/x?y=1`, {
      method: 'POST',
      headers: { authorization: 'Bearer t' },
      body: 'payload',
    });
    expect(await res.json()).toEqual({
      method: 'POST',
      url: '/api/x?y=1',
      auth: 'Bearer t',
      body: 'payload',
    });
    expect((await fetch(`${bridge.origin}/gone`)).status).toBe(204);
  });

  it('carries a WebSocket both ways', async () => {
    const ws = new WebSocket(`${bridge.origin.replace('http', 'ws')}/ws`);
    const got: string[] = [];
    ws.on('message', (d) => got.push(d.toString()));
    await new Promise((r) => ws.on('open', r));
    ws.send('hi');
    await until(() => got.length === 1);
    expect(got[0]).toBe('echo:hi');
    ws.close();
  });

  it('makes one session for many requests, and a new one after the server drops it', async () => {
    await fetch(`${bridge.origin}/a`);
    await fetch(`${bridge.origin}/b`);
    expect(connects).toBe(1);
    host.stop();
    host.start();
    await until(() => host.status().connected);
    await until(() => connects === 1 && relay.stats().clients === 0);
    const res = await fetch(`${bridge.origin}/c`);
    expect(res.status).toBe(200);
    expect(connects).toBe(2);
  });

  it('answers 502 and says why when the relay cannot be reached', async () => {
    host.stop();
    await until(() => relay.stats().servers === 0);
    const res = await fetch(`${bridge.origin}/anything`);
    expect(res.status).toBe(502);
    expect(await res.text()).toMatch(/offline/);
  });
});
