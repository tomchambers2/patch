// The phone's way through a relay (spec/10 § Relay): a global `fetch` and
// `WebSocket` that carry anything addressed to the relay placeholder through the
// encrypted session. Against a REAL relay and a REAL tunnel end, with a plain
// HTTP/WebSocket server standing in for the Patch server behind it.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { channelFor, generateServerIdentity, toBase64Url } from '@patch/relay';
import { RelayHost } from '@patch/relay/host';
import { createRelayServer, type RelayServerHandle } from '@patch/relay/server';

let relay: RelayServerHandle;
let target: Server;
let wss: WebSocketServer;
let host: RelayHost;
let nativeFetch: ReturnType<typeof vi.fn>;
/** The platform's own fetch: the tunnel's far end uses it to reach the server next door. */
const realFetch = globalThis.fetch;
let NativeSocket: ReturnType<typeof vi.fn>;
let route: { kind: 'relay'; relay: { url: string; channel: string; serverKey: string } };

async function until(pick: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!pick()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeEach(async () => {
  vi.resetModules();
  relay = await createRelayServer({ port: 0, host: '127.0.0.1' });
  target = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => {
      const body = Buffer.concat(parts);
      if (req.url === '/none') {
        res.writeHead(204).end();
      } else if (req.url === '/bin') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(Buffer.from([0, 255, 1, 254]));
      } else {
        res.writeHead(200, { 'content-type': req.headers['content-type'] ?? 'application/json' });
        res.end(
          req.headers['content-type']?.startsWith('multipart/')
            ? body
            : JSON.stringify({
                url: req.url,
                method: req.method,
                auth: req.headers.authorization ?? null,
                body: body.toString(),
              }),
        );
      }
    });
  });
  wss = new WebSocketServer({ server: target, path: '/ws' });
  wss.on('connection', (s) => s.on('message', (d) => s.send(`echo:${d.toString()}`)));
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
  const identity = generateServerIdentity();
  host = new RelayHost({
    relayUrl: `ws://127.0.0.1:${relay.port}`,
    identity,
    target: `http://127.0.0.1:${(target.address() as AddressInfo).port}`,
  });
  host.start();
  await until(() => host.status().connected);
  route = {
    kind: 'relay',
    relay: {
      url: `ws://127.0.0.1:${relay.port}`,
      channel: channelFor(identity.publicKey),
      serverKey: toBase64Url(identity.publicKey),
    },
  };
  nativeFetch = vi.fn((input: unknown, init?: RequestInit) => realFetch(input as string, init));
  NativeSocket = vi.fn();
  (globalThis as unknown as Record<string, unknown>).fetch = nativeFetch;
  (globalThis as unknown as Record<string, unknown>).WebSocket = NativeSocket;
});

afterEach(async () => {
  host.stop();
  wss.close();
  await new Promise<void>((r) => target.close(() => r()));
  await relay.close();
  const { __clearAllMmkv } = await import('./stubs/mmkv');
  __clearAllMmkv();
});

async function install(): Promise<typeof import('../src/lib/relayTransport')> {
  const config = await import('../src/config');
  config.setRoute(route);
  const t = await import('../src/lib/relayTransport');
  t.installRelayTransport({ WebSocket: WebSocket as never });
  return t;
}

describe('fetch', () => {
  it('carries a request addressed to the relay placeholder through the tunnel', async () => {
    await install();
    const { apiUrl } = await import('../src/config');
    const res = await fetch(apiUrl('/api/x?y=1'), {
      method: 'POST',
      headers: { Authorization: 'Bearer abc', 'Content-Type': 'application/json' },
      body: '{"a":1}',
    });
    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    expect(await res.json()).toEqual({
      url: '/api/x?y=1',
      method: 'POST',
      auth: 'Bearer abc',
      body: '{"a":1}',
    });
  });

  it('leaves every other address to the network', async () => {
    await install();
    nativeFetch.mockImplementation(async () => new Response('native'));
    expect(await (await fetch('https://example.com/thing')).text()).toBe('native');
    expect(nativeFetch).toHaveBeenCalledWith('https://example.com/thing', undefined);
  });

  it('answers binary bodies byte for byte and a bodyless status without a body', async () => {
    await install();
    const { apiUrl } = await import('../src/config');
    const bin = await fetch(apiUrl('/bin'));
    expect(Array.from(new Uint8Array(await bin.arrayBuffer()))).toEqual([0, 255, 1, 254]);
    const none = await fetch(apiUrl('/none'));
    expect(none.status).toBe(204);
  });

  it('sends bytes, array buffers and form data as the body', async () => {
    await install();
    const { apiUrl } = await import('../src/config');
    const buf = await fetch(apiUrl('/echo'), { method: 'PUT', body: new Uint8Array([104, 105]) });
    expect((await buf.json()).body).toBe('hi');
    const ab = await fetch(apiUrl('/echo'), {
      method: 'PUT',
      body: new TextEncoder().encode('yo').buffer,
    });
    expect((await ab.json()).body).toBe('yo');
    const form = new FormData();
    form.append('field', 'value');
    form.append('file', new Blob(['file-bytes'], { type: 'text/plain' }), 'a.txt');
    const sent = await fetch(apiUrl('/upload'), { method: 'POST', body: form });
    const text = await sent.text();
    expect(text).toContain('name="field"');
    expect(text).toContain('value');
    expect(text).toContain('filename="a.txt"');
    expect(text).toContain('file-bytes');
  });

  it('sends React Native form data: parts with a uri are read off the device', async () => {
    const { apiUrl } = await install().then(async (t) => ({
      ...t,
      ...(await import('../src/config')),
    }));
    nativeFetch.mockImplementation(async (u: string, init?: RequestInit) =>
      u === 'file:///audio.m4a' ? new Response(new Uint8Array([1, 2, 3])) : realFetch(u, init),
    );
    const parts = [
      { fieldName: 'note', string: 'hello', headers: {} },
      {
        fieldName: 'audio',
        uri: 'file:///audio.m4a',
        name: 'audio.m4a',
        type: 'audio/mp4',
        headers: {},
      },
    ];
    const rnForm = { getParts: () => parts } as unknown as FormData;
    const res = await fetch(apiUrl('/upload'), { method: 'POST', body: rnForm });
    const sent = Buffer.from(await res.arrayBuffer());
    expect(sent.toString('latin1')).toContain('name="note"');
    expect(sent.toString('latin1')).toContain('filename="audio.m4a"');
    expect(sent.includes(Buffer.from([1, 2, 3]))).toBe(true);
    expect(nativeFetch).toHaveBeenCalledWith('file:///audio.m4a');
  });

  it('takes a Request as well as a url', async () => {
    await install();
    const { apiUrl } = await import('../src/config');
    const res = await fetch(
      new Request(apiUrl('/api/r'), { method: 'POST', body: 'rb', headers: { 'x-a': '1' } }),
    );
    expect((await res.json()).body).toBe('rb');
  });

  it('abandons a request when asked to', async () => {
    await install();
    const { apiUrl } = await import('../src/config');
    const ctl = new AbortController();
    const p = fetch(apiUrl('/api/x'), { signal: ctl.signal });
    ctl.abort();
    await expect(p).rejects.toThrow();
  });

  it('refuses to carry anything when the device has no relay route', async () => {
    const config = await import('../src/config');
    config.setRoute({ kind: 'direct', url: 'https://patch.example.com' });
    const t = await import('../src/lib/relayTransport');
    t.installRelayTransport({ WebSocket: WebSocket as never });
    await expect(fetch('https://relay.patch.invalid/api/x')).rejects.toThrow(
      /not paired through a relay/,
    );
    expect(
      () =>
        new (globalThis.WebSocket as never as new (u: string) => unknown)(
          'wss://relay.patch.invalid/ws',
        ),
    ).toThrow(/not paired through a relay/);
  });
});

describe('WebSocket', () => {
  it('opens a tunnelled socket for the relay placeholder', async () => {
    await install();
    const { wsUrl } = await import('../src/config');
    const Routed = globalThis.WebSocket as unknown as new (u: string) => unknown;
    const sock = new Routed(wsUrl()) as unknown as {
      readyState: number;
      onmessage: ((e: { data: unknown }) => void) | null;
      send(d: string): void;
      close(): void;
    };
    const got: unknown[] = [];
    sock.onmessage = (e) => got.push(e.data);
    await until(() => sock.readyState === 1);
    sock.send('hi');
    await until(() => got.length === 1);
    expect(got[0]).toBe('echo:hi');
    sock.close();
    expect(NativeSocket).not.toHaveBeenCalled();
  });

  it('leaves every other address to the platform socket, and keeps its constants', async () => {
    await install();
    new (globalThis.WebSocket as never as new (u: string, p?: string[]) => unknown)(
      'wss://example.com/x',
      ['p'],
    );
    expect(NativeSocket).toHaveBeenCalledWith('wss://example.com/x', ['p']);
    expect((globalThis.WebSocket as unknown as { OPEN: number }).OPEN).toBe(1);
  });
});

describe('the session', () => {
  it('reports its state for the connection banner', async () => {
    const t = await install();
    const { apiUrl } = await import('../src/config');
    expect(t.relayStatus().state).toBe('idle');
    await fetch(apiUrl('/api/x'));
    expect(t.relayStatus().state).toBe('connected');
  });

  it('picks up a new route: pairing with another server makes a new session', async () => {
    const t = await install();
    const { apiUrl, setRoute } = await import('../src/config');
    await fetch(apiUrl('/api/x'));
    const other = generateServerIdentity();
    setRoute({
      kind: 'relay',
      relay: {
        url: route.relay.url,
        channel: channelFor(other.publicKey),
        serverKey: toBase64Url(other.publicKey),
      },
    });
    await expect(fetch(apiUrl('/api/x'))).rejects.toThrow(/offline/);
    expect(t.relayStatus().state).toBe('offline');
  });

  it('gives the CSPRNG the crypto needs when the engine has none', async () => {
    const saved = (globalThis as { crypto?: unknown }).crypto;
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    try {
      const t = await install();
      expect(
        typeof (globalThis as unknown as { crypto: { getRandomValues: unknown } }).crypto
          .getRandomValues,
      ).toBe('function');
      void t;
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: saved, configurable: true });
    }
  });
});
