// WireTestClient unit tests using a vanilla `ws` server fixture (no Fastify
// dependency from @patch/wire — it would create a circular dep). The fixture
// just speaks the wire protocol over a raw WS, which is exactly the contract.

import { describe, test, expect } from 'vitest';
import net from 'node:net';
import { WebSocketServer, type WebSocket as WSConn } from 'ws';
import { WireTestClient } from '../src/test-client.js';
import { decode, encode, type WireEvent } from '../src/index.js';

interface Fixture {
  url: string;
  received: WireEvent[];
  // Fires whenever the server gets a frame.
  onMessage: ((event: WireEvent, conn: WSConn) => void) | null;
  close: () => Promise<void>;
}

async function startFixture(): Promise<Fixture> {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  const addr = wss.address();
  if (typeof addr !== 'object' || addr === null) throw new Error('no address');
  const url = `ws://127.0.0.1:${addr.port}`;
  const fixture: Fixture = {
    url,
    received: [],
    onMessage: null,
    close: () =>
      new Promise<void>((resolve) => {
        wss.close(() => resolve());
        for (const c of wss.clients) c.terminate();
      }),
  };
  wss.on('connection', (conn) => {
    conn.on('message', (raw) => {
      const event = decode(raw as Buffer);
      fixture.received.push(event);
      fixture.onMessage?.(event, conn);
    });
  });
  return fixture;
}

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('WireTestClient', () => {
  test('sends hello on connect', async () => {
    const fx = await startFixture();
    try {
      const client = new WireTestClient({
        url: fx.url,
        clientType: 'surface-web',
        clientVersion: '0.1.0',
        auth: 'tok',
      });
      await client.connect();
      await waitFor(() => fx.received.length >= 1, 1000);
      expect(fx.received.length).toBe(1);
      const hello = fx.received[0];
      expect(hello?.type).toBe('hello');
      if (hello?.type === 'hello') {
        expect(hello.clientType).toBe('surface-web');
        expect(hello.clientVersion).toBe('0.1.0');
        expect(hello.auth).toBe('tok');
      }
      await client.close();
    } finally {
      await fx.close();
    }
  });

  test('on receives typed events from the server', async () => {
    const fx = await startFixture();
    try {
      fx.onMessage = (_event, conn) => {
        const msg: WireEvent = {
          type: 'chat.message',
          chatId: 'c1',
          role: 'assistant',
          content: 'hi from server',
          seq: 5,
        };
        conn.send(encode(msg));
      };
      const client = new WireTestClient({ url: fx.url });
      await client.connect();
      const received = await client.waitFor('chat.message');
      expect(received.chatId).toBe('c1');
      expect(received.seq).toBe(5);
      expect(client.lastSeq('c1')).toBe(5);
      await client.close();
    } finally {
      await fx.close();
    }
  });

  test('sendInput emits chat.input with explicit localId', async () => {
    const fx = await startFixture();
    try {
      const client = new WireTestClient({ url: fx.url });
      await client.connect();
      client.sendInput({ chatId: 'c1', message: 'hello', localId: 'lid-7' });
      await waitFor(() => fx.received.length >= 2, 1000);
      const input = fx.received[1];
      expect(input?.type).toBe('chat.input');
      if (input?.type === 'chat.input') {
        expect(input.chatId).toBe('c1');
        expect(input.message).toBe('hello');
        expect(input.localId).toBe('lid-7');
      }
      await client.close();
    } finally {
      await fx.close();
    }
  });

  test('sendInput synthesises a localId via crypto.randomUUID when omitted', async () => {
    const fx = await startFixture();
    try {
      const client = new WireTestClient({ url: fx.url });
      await client.connect();
      client.sendInput({ chatId: 'c1', message: 'hello' });
      await waitFor(() => fx.received.length >= 2, 1000);
      const input = fx.received[1];
      expect(input?.type).toBe('chat.input');
      if (input?.type === 'chat.input') {
        // RFC4122 v4 UUID — exactly 36 chars with dashes in the right places.
        expect(input.localId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
      }
      await client.close();
    } finally {
      await fx.close();
    }
  });

  test('replay emits chat.replay with fromSeq', async () => {
    const fx = await startFixture();
    try {
      const client = new WireTestClient({ url: fx.url });
      await client.connect();
      client.replay('c1', 12);
      await waitFor(() => fx.received.length >= 2, 1000);
      const replay = fx.received[1];
      expect(replay?.type).toBe('chat.replay');
      if (replay?.type === 'chat.replay') {
        expect(replay.chatId).toBe('c1');
        expect(replay.fromSeq).toBe(12);
      }
      await client.close();
    } finally {
      await fx.close();
    }
  });

  test('replayFromLastSeen sends fromSeq=-1 when nothing has been seen', async () => {
    const fx = await startFixture();
    try {
      const client = new WireTestClient({ url: fx.url });
      await client.connect();
      expect(client.lastSeq('c1')).toBeUndefined();
      client.replayFromLastSeen('c1');
      await waitFor(() => fx.received.length >= 2, 1000);
      const replay = fx.received[1];
      expect(replay?.type).toBe('chat.replay');
      if (replay?.type === 'chat.replay') {
        // Replay is exclusive (seq > fromSeq); a never-seen client uses -1 so
        // the host includes seq 0.
        expect(replay.fromSeq).toBe(-1);
      }
      await client.close();
    } finally {
      await fx.close();
    }
  });

  test('replayFromLastSeen uses the highest seq seen', async () => {
    const fx = await startFixture();
    try {
      fx.onMessage = (event, conn) => {
        if (event.type !== 'hello') return;
        conn.send(
          encode({
            type: 'chat.message',
            chatId: 'c1',
            role: 'assistant',
            content: 'm',
            seq: 7,
          }),
        );
      };
      const client = new WireTestClient({ url: fx.url });
      await client.connect();
      await client.waitFor('chat.message', (e) => e.seq === 7);
      client.replayFromLastSeen('c1');
      await waitFor(() => fx.received.length >= 2, 1000);
      const replay = fx.received[1];
      expect(replay?.type).toBe('chat.replay');
      if (replay?.type === 'chat.replay') {
        expect(replay.fromSeq).toBe(7);
      }
      await client.close();
    } finally {
      await fx.close();
    }
  });

  test('buffers seq monotonically per chat; lastSeq is undefined for unseen chats', async () => {
    const fx = await startFixture();
    try {
      fx.onMessage = (event, conn) => {
        if (event.type !== 'hello') return;
        for (const seq of [0, 1, 2, 5]) {
          conn.send(
            encode({
              type: 'chat.message',
              chatId: 'c1',
              role: 'assistant',
              content: `m${seq}`,
              seq,
            }),
          );
        }
      };
      const client = new WireTestClient({ url: fx.url });
      await client.connect();
      await client.waitFor('chat.message', (e) => e.seq === 5);
      expect(client.lastSeq('c1')).toBe(5);
      expect(client.lastSeq('other')).toBeUndefined();
      await client.close();
    } finally {
      await fx.close();
    }
  });

  test('connect rejects on connection error (nothing listening)', async () => {
    // Bind a server just to learn a free port, then close it immediately so
    // nothing is listening there — the ws client should emit a real 'error'
    // (ECONNREFUSED) and connect() should reject with it.
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, resolve));
    const addr = probe.address();
    if (typeof addr !== 'object' || addr === null) throw new Error('no address');
    const port = addr.port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const client = new WireTestClient({ url: `ws://127.0.0.1:${port}`, connectTimeoutMs: 2000 });
    await expect(client.connect()).rejects.toThrow();
  });

  test('connect rejects with a timeout error when the handshake never completes', async () => {
    // A raw TCP server that accepts the connection but never speaks HTTP/WS —
    // the ws client hangs in CONNECTING until our short timeout fires.
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      // Accept and do nothing; never upgrade.
      sockets.add(socket);
      socket.on('error', () => {
        /* ignore ECONNRESET from the client-side terminate() on timeout */
      });
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address();
    if (typeof addr !== 'object' || addr === null) throw new Error('no address');
    const port = addr.port;
    try {
      const client = new WireTestClient({ url: `ws://127.0.0.1:${port}`, connectTimeoutMs: 50 });
      await expect(client.connect()).rejects.toThrow(/connect timeout after 50ms/);
    } finally {
      // The accepted socket never had a reader attached (we never spoke
      // HTTP), so it stays paused and its 'end' never fires on its own —
      // destroy it explicitly or server.close()'s callback would hang
      // waiting for a connection that will never fully close itself.
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('onError forwards post-connect socket errors, and the unsubscribe works', async () => {
    const fx = await startFixture();
    try {
      const client = new WireTestClient({ url: fx.url });
      await client.connect();
      const errors: Error[] = [];
      const unsub = client.onError((err) => errors.push(err));
      // Reach into the private socket to simulate a real post-connect error
      // (e.g. a mid-session reset) without an actual network fault.
      const raw = (client as unknown as { ws: import('ws').WebSocket }).ws;
      raw.emit('error', new Error('simulated socket error'));
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toBe('simulated socket error');

      unsub();
      raw.emit('error', new Error('should not be forwarded'));
      expect(errors).toHaveLength(1);

      await client.close();
    } finally {
      await fx.close();
    }
  });

  test('onClose forwards the close code/reason, and the unsubscribe works', async () => {
    const fx = await startFixture();
    try {
      const client = new WireTestClient({ url: fx.url });
      await client.connect();
      const closes: Array<{ code: number; reason: string }> = [];
      const unsub = client.onClose((code, reason) => closes.push({ code, reason }));
      unsub(); // unsubscribe before it ever fires — proves the returned fn works
      await client.close();
      expect(closes).toHaveLength(0);
    } finally {
      await fx.close();
    }
  });

  test('onClose handler receives the close event when left subscribed', async () => {
    const fx = await startFixture();
    try {
      const client = new WireTestClient({ url: fx.url });
      await client.connect();
      const closes: Array<{ code: number; reason: string }> = [];
      client.onClose((code, reason) => closes.push({ code, reason }));
      await client.close();
      expect(closes).toHaveLength(1);
    } finally {
      await fx.close();
    }
  });

  test('waitFor rejects with a timeout error when the event never arrives', async () => {
    const fx = await startFixture();
    try {
      const client = new WireTestClient({ url: fx.url });
      await client.connect();
      await expect(client.waitFor('chat.message', undefined, 20)).rejects.toThrow(
        /WireTestClient.waitFor\(chat.message\): timed out after 20ms/,
      );
      await client.close();
    } finally {
      await fx.close();
    }
  });

  test('send throws when the socket exists but is not open', async () => {
    const fx = await startFixture();
    try {
      const client = new WireTestClient({ url: fx.url });
      await client.connect();
      // Terminate the underlying socket directly (bypassing client.close(),
      // which would null out the private `ws` field) so `this.ws` is still
      // set but its readyState is no longer OPEN.
      const raw = (client as unknown as { ws: import('ws').WebSocket }).ws;
      raw.terminate();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(() => client.send({ type: 'surface.heartbeat' })).toThrow(/socket not open/);
    } finally {
      await fx.close();
    }
  });

  test('send throws when not connected', () => {
    const client = new WireTestClient({ url: 'ws://127.0.0.1:1' });
    expect(() => client.send({ type: 'surface.heartbeat' })).toThrow(
      'WireTestClient: not connected',
    );
  });

  test('connect throws if called twice on the same client', async () => {
    const fx = await startFixture();
    try {
      const client = new WireTestClient({ url: fx.url });
      await client.connect();
      await expect(client.connect()).rejects.toThrow('WireTestClient already connected');
      await client.close();
    } finally {
      await fx.close();
    }
  });

  test('close() is a no-op when never connected', async () => {
    const client = new WireTestClient({ url: 'ws://127.0.0.1:1' });
    await expect(client.close()).resolves.toBeUndefined();
  });

  test('close() returns immediately when the socket is already CLOSED', async () => {
    const fx = await startFixture();
    try {
      const client = new WireTestClient({ url: fx.url });
      await client.connect();
      // Terminate the raw socket directly (bypassing our own close(), which
      // would null out the private `ws` field) and wait for it to fully
      // settle to CLOSED, so `this.ws` is still set but already closed when
      // we call close() below — exercising the readyState===CLOSED shortcut.
      const raw = (client as unknown as { ws: import('ws').WebSocket }).ws;
      await new Promise<void>((resolve) => {
        raw.once('close', () => resolve());
        raw.terminate();
      });
      expect(raw.readyState).toBe(raw.CLOSED);
      await expect(client.close()).resolves.toBeUndefined();
    } finally {
      await fx.close();
    }
  });

  test('dispatch silently no-ops for an event type with no subscribers', async () => {
    const fx = await startFixture();
    try {
      fx.onMessage = (event, conn) => {
        if (event.type !== 'hello') return;
        // Client never subscribes to 'daemon.online' — dispatch must find no
        // handler set and return without error — followed by a type it DOES
        // wait for, proving the connection is still healthy afterwards.
        conn.send(encode({ type: 'daemon.online', daemonId: 'host-a' }));
        conn.send(
          encode({ type: 'chat.message', chatId: 'c1', role: 'assistant', content: 'ok', seq: 0 }),
        );
      };
      const client = new WireTestClient({ url: fx.url });
      await client.connect();
      const received = await client.waitFor('chat.message');
      expect(received.content).toBe('ok');
      await client.close();
    } finally {
      await fx.close();
    }
  });

  test('decode handles an array-of-Buffer-fragments message (binaryType: "fragments")', async () => {
    const fx = await startFixture();
    try {
      const client = new WireTestClient({ url: fx.url });
      await client.connect();
      // Force the underlying ws to hand `on('message')` an ARRAY of Buffer
      // fragments (RawData's third union member) instead of a consolidated
      // Buffer — only happens for binary frames when binaryType is set to
      // the non-default 'fragments'.
      const raw = (client as unknown as { ws: import('ws').WebSocket }).ws;
      raw.binaryType = 'fragments' as unknown as typeof raw.binaryType;
      const event: WireEvent = {
        type: 'chat.message',
        chatId: 'c1',
        role: 'assistant',
        content: 'via fragments',
        seq: 9,
      };
      fx.onMessage = (msg, conn) => {
        if (msg.type !== 'hello') return;
        conn.send(Buffer.from(encode(event), 'utf8'), { binary: true });
      };
      const received = await client.waitFor('chat.message', (e) => e.seq === 9);
      expect(received).toEqual(event);
      await client.close();
    } finally {
      await fx.close();
    }
  });
});
