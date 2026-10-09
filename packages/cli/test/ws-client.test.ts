// PatchWsClient integration tests against a minimal local WS server.
//
// Focus: the attach path (G1-15 regression). attachChat must (a) track the
// chat for reconnect replay and (b) immediately emit a `chat.replay` frame
// when already connected, so a surface joining a pre-existing chat renders the
// existing wire stream rather than an empty pane.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { decode, encode, type WireEvent } from '@patch/wire';
import { PatchWsClient } from '../src/transport/ws.js';

interface Harness {
  url: string;
  received: WireEvent[];
  /** Push a wire event to every connected client socket. */
  push: (event: WireEvent) => void;
  /** Close the most-recently-connected client socket (simulate a server drop). */
  dropClient: () => void;
  close: () => Promise<void>;
}

async function startServer(): Promise<Harness> {
  const http: Server = createServer();
  const wss = new WebSocketServer({ server: http });
  const received: WireEvent[] = [];
  const sockets = new Set<WebSocket>();
  wss.on('connection', (sock: WebSocket) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('message', (data) => {
      const buf = Array.isArray(data) ? Buffer.concat(data) : (data as Buffer);
      received.push(decode(buf as Buffer));
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const addr = http.address();
  if (addr === null || typeof addr === 'string') throw new Error('no server address');
  const url = `ws://127.0.0.1:${addr.port}/ws`;
  return {
    url,
    received,
    push: (event: WireEvent): void => {
      const wire = encode(event);
      for (const sock of sockets) sock.send(wire);
    },
    dropClient: (): void => {
      for (const sock of sockets) sock.terminate();
    },
    close: async (): Promise<void> => {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

async function waitFor(pred: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('attachChat emits a chat.replay frame when connected (attach path renders existing stream)', async () => {
  const h = await startServer();
  const client = new PatchWsClient({ url: h.url, bearer: null, noAutoReconnect: true });
  try {
    await client.connect();
    // The hello frame is sent on connect.
    await waitFor(() => h.received.some((e) => e.type === 'hello'));

    client.attachChat('c_pre_existing');

    // Attaching a pre-existing chat must produce a chat.replay request so the
    // server re-streams the chat's history to this surface.
    await waitFor(() =>
      h.received.some((e) => e.type === 'chat.replay' && e.chatId === 'c_pre_existing'),
    );
    const replay = h.received.find(
      (e) => e.type === 'chat.replay' && e.chatId === 'c_pre_existing',
    );
    assert.ok(replay && replay.type === 'chat.replay');
    // Never seen any seq for this chat → replay from -1 (all events incl. seq 0).
    assert.equal(replay.fromSeq, -1);
  } finally {
    await client.close();
    await h.close();
  }
});

test('attachChat before connect defers the replay until the socket opens', async () => {
  const h = await startServer();
  const client = new PatchWsClient({ url: h.url, bearer: null, noAutoReconnect: true });
  try {
    // Track the chat while still offline — no frame can be sent yet.
    client.attachChat('c_early');
    assert.equal(
      h.received.some((e) => e.type === 'chat.replay'),
      false,
    );
    // On connect, openOnce replays every tracked chat.
    await client.connect();
    await waitFor(() => h.received.some((e) => e.type === 'chat.replay' && e.chatId === 'c_early'));
  } finally {
    await client.close();
    await h.close();
  }
});

// G1-15 root cause: the TUI mounts ChatView and subscribes to event types
// AFTER `connect()` is invoked but typically BEFORE it resolves (state is still
// `connecting`). Before the fix, neither the post-connect branch in `on()` nor
// `openOnce`'s one-shot forwarder loop wired those types, so inbound (replayed
// or live) events never dispatched and the event pane stayed empty. This test
// subscribes mid-connect and asserts the listener still receives a pushed event.
test('listeners registered while connecting still receive events (connect-race)', async () => {
  const h = await startServer();
  const client = new PatchWsClient({ url: h.url, bearer: null, noAutoReconnect: true });
  const got: WireEvent[] = [];
  try {
    // Kick off connect but DO NOT await — mimic launchTui firing connect() then
    // App/ChatView mounting and subscribing while the socket is still opening.
    const connecting = client.connect();
    client.on('chat.message', (e) => got.push(e));
    client.attachChat('c_race');
    await connecting;
    // Server pushes a chat.message for the attached chat.
    h.push({
      type: 'chat.message',
      chatId: 'c_race',
      role: 'assistant',
      content: 'hello from the agent',
      seq: 0,
    });
    await waitFor(() => got.length > 0);
    assert.equal(got.length, 1);
    assert.equal(got[0]?.type, 'chat.message');
  } finally {
    await client.close();
    await h.close();
  }
});

// The long-lived TUI socket must survive a post-connect error/drop. Before the
// fix, WireTestClient's connect promise consumed its only `error` listener, so a
// later socket error emitted an unhandled 'error' and CRASHED the process. Now
// PatchWsClient registers persistent error/close handlers and reconnects.
test('a post-connect socket drop does not crash; client reconnects', async () => {
  const h = await startServer();
  const client = new PatchWsClient({
    url: h.url,
    bearer: null,
    initialBackoffMs: 20,
    maxBackoffMs: 40,
  });
  try {
    await client.connect();
    await waitFor(() => h.received.some((e) => e.type === 'hello'));
    const helloCountBefore = h.received.filter((e) => e.type === 'hello').length;
    // Simulate a server-side drop of the live socket.
    h.dropClient();
    // The client should auto-reconnect (a fresh hello arrives) rather than die.
    await waitFor(
      () => h.received.filter((e) => e.type === 'hello').length > helloCountBefore,
      2000,
    );
    assert.equal(client.getState(), 'connected');
  } finally {
    await client.close();
    await h.close();
  }
});
