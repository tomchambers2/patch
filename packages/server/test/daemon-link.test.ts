// Tests for the INBOUND host link. The host connects into the server and
// its authenticated socket is handed to the link via `attach`. The link owns
// that socket: frames in → onEvent, attach/detach → online/offline, and
// surface→host events buffer while detached (cap 10k, drop-oldest).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EventEmitter } from 'node:events';
import { WebSocketServer, WebSocket as WsClient, type WebSocket } from 'ws';
import pino from 'pino';
import { encode, decode, type WireEvent } from '@patch/wire';
import { InboundDaemonLink, InProcessDaemonLink } from '../src/daemon-link.js';

const silentLogger = pino({ level: 'silent' });

/**
 * Minimal fake WebSocket — an EventEmitter with `send`/`close`, duck-typed
 * enough for InboundDaemonLink's internal usage (`.on('message'|'close'|
 * 'error')`, `.send()`, `.close()`). Lets us drive edge cases (throwing
 * close(), array-fragmented message payloads, socket error events) that are
 * awkward to force through a real 'ws' socket pair.
 */
class FakeSocket extends EventEmitter {
  sent: unknown[] = [];
  closeShouldThrow = false;
  send(data: unknown): void {
    this.sent.push(data);
  }
  close(): void {
    if (this.closeShouldThrow) throw new Error('fake close failure');
    this.emit('close');
  }
}
function fakeSocket(): FakeSocket {
  return new FakeSocket();
}

/**
 * Spin up a throwaway WS server whose accepted server-side socket we hand to
 * the InboundDaemonLink (simulating what the hello gate does), plus a client
 * socket that stands in for the host process.
 */
interface Pair {
  server: WebSocket; // server-side socket (attached to the link)
  client: WsClient; // host-side socket
}

async function makePair(wss: WebSocketServer, url: string): Promise<Pair> {
  const serverSocketPromise = new Promise<WebSocket>((resolve) => {
    wss.once('connection', (ws) => resolve(ws));
  });
  const client = new WsClient(url);
  await new Promise<void>((resolve, reject) => {
    client.once('open', () => resolve());
    client.once('error', reject);
  });
  const server = await serverSocketPromise;
  return { server, client };
}

describe('InboundDaemonLink', () => {
  let http: HttpServer;
  let wss: WebSocketServer;
  let url: string;
  let link: InboundDaemonLink | undefined;
  const sockets: WsClient[] = [];

  beforeEach(async () => {
    http = createServer();
    wss = new WebSocketServer({ server: http });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', () => resolve()));
    const addr = http.address() as AddressInfo;
    url = `ws://127.0.0.1:${addr.port}`;
    link = undefined;
    sockets.length = 0;
  });

  afterEach(async () => {
    if (link) await link.close();
    for (const s of sockets) {
      if (s.readyState === s.OPEN) s.close();
    }
    wss.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });

  it('onStatus unsubscribe stops further delivery', async () => {
    link = new InboundDaemonLink({ logger: silentLogger });
    const statuses: string[] = [];
    const unsub = link.onStatus((s) => statuses.push(s));
    const { server, client } = await makePair(wss, url);
    sockets.push(client);
    link.attach(server, 'd1');
    unsub();
    client.close();
    await waitFor(() => link!.status() === 'offline', 1000);
    expect(statuses).toEqual(['online']); // offline transition not delivered — unsubscribed
  });

  it('is offline until a socket is attached, then online', async () => {
    link = new InboundDaemonLink({ logger: silentLogger });
    expect(link.status()).toBe('offline');

    const statuses: string[] = [];
    link.onStatus((s) => statuses.push(s));

    const { server, client } = await makePair(wss, url);
    sockets.push(client);
    link.attach(server, 'd1');

    expect(link.status()).toBe('online');
    expect(statuses).toEqual(['online']);
  });

  it('onEvent unsubscribe stops further delivery', () => {
    link = new InboundDaemonLink({ logger: silentLogger });
    const received: WireEvent[] = [];
    const unsub = link.onEvent((e) => received.push(e));
    link.injectDaemonEvent({ type: 'daemon.online', daemonId: 'd1' });
    unsub();
    link.injectDaemonEvent({ type: 'daemon.online', daemonId: 'd1' });
    expect(received).toHaveLength(1);
  });

  it('feeds frames arriving on the host socket to onEvent', async () => {
    link = new InboundDaemonLink({ logger: silentLogger });
    const received: WireEvent[] = [];
    link.onEvent((e) => received.push(e));

    const { server, client } = await makePair(wss, url);
    sockets.push(client);
    link.attach(server, 'd1');

    client.send(encode({ type: 'daemon.online', daemonId: 'd1' } satisfies WireEvent));
    await waitFor(() => received.length === 1, 1000);
    expect(received[0]?.type).toBe('daemon.online');
  });

  it('sends surface→host events directly when online', async () => {
    link = new InboundDaemonLink({ logger: silentLogger });
    const { server, client } = await makePair(wss, url);
    sockets.push(client);

    const got: WireEvent[] = [];
    client.on('message', (raw) => got.push(decode(raw as Buffer)));

    link.attach(server, 'd1');
    link.send('srf-1', { type: 'chat.input', chatId: 'c1', message: 'hi', localId: 'L1' });

    await waitFor(() => got.length === 1, 1000);
    expect(got[0]?.type).toBe('chat.input');
  });

  it('buffers surface→host events while detached and flushes on attach', async () => {
    // The chat's machine is known from the server's registry mirror even while
    // that machine is detached — that is what makes buffering addressable
    // rather than "send it to whichever host turns up".
    link = new InboundDaemonLink({ logger: silentLogger, resolveChatHost: () => 'd1' });
    // Detached: events buffer for THAT machine.
    link.send('srf-1', { type: 'chat.input', chatId: 'c1', message: 'a', localId: 'L1' });
    link.send('srf-1', { type: 'chat.input', chatId: 'c1', message: 'b', localId: 'L2' });

    const { server, client } = await makePair(wss, url);
    sockets.push(client);
    const got: WireEvent[] = [];
    client.on('message', (raw) => got.push(decode(raw as Buffer)));

    link.attach(server, 'd1');
    await waitFor(() => got.length === 2, 1000);
    expect(got.map((e) => (e.type === 'chat.input' ? e.localId : null))).toEqual(['L1', 'L2']);
  });

  // Todoist: "Server says chat_not_found while a host is reconnecting after a
  // server redeploy" — a restart empties the registry mirror; `resolveChatHost`
  // returns null for every chat until each chat's owning host reconnects and
  // resyncs. With more than one machine registered on the account, guessing
  // the home one in that gap can misroute a request for a chat that lives on
  // a DIFFERENT machine, and that machine (correctly, from its own
  // perspective) answers `chat_not_found` for a chat it never owned — a real,
  // live chat reported as gone.
  it('holds a chat-scoped frame (not guess the home machine) while the mirror does not know the chat yet, and routes it once the mirror catches up', async () => {
    let resolved: string | null = null;
    link = new InboundDaemonLink({
      logger: silentLogger,
      resolveChatHost: () => resolved,
      homeDaemonId: () => 'd-home', // registered, but never attached below: offline.
      registeredDaemonIds: () => ['d-home', 'd-real'], // more than one — a guess can be wrong.
      unknownChatHostWaitMs: 200,
      unknownChatHostPollMs: 10,
    });

    // The chat's REAL host, a different machine than home.
    const { server, client } = await makePair(wss, url);
    sockets.push(client);
    const got: WireEvent[] = [];
    client.on('message', (raw) => got.push(decode(raw as Buffer)));
    link.attach(server, 'd-real');

    link.send('srf-1', { type: 'chat.input', chatId: 'c1', message: 'hi', localId: 'L1' });
    // Not sent anywhere yet — the mirror hasn't resolved the chat, and the
    // home machine is offline, so there is nothing safe to guess.
    await new Promise((r) => setTimeout(r, 30));
    expect(got).toHaveLength(0);

    // The registry mirror learns the chat's real host (the owning host
    // reconnected and resynced).
    resolved = 'd-real';
    await waitFor(() => got.length === 1, 1000);
    expect(got[0]).toMatchObject({ type: 'chat.input', localId: 'L1' });
  });

  // Todoist: "question answers for chats on the Mac go to Hetzner and are lost".
  // A `chat.permission_response` is routed by its chatId like any other chat
  // frame; one without it falls to the home machine, which has no such pending
  // request, so the answer to a non-home chat vanished.
  it("routes a chat.permission_response to the chat's host, not home, and only when it names the chat", async () => {
    link = new InboundDaemonLink({
      logger: silentLogger,
      resolveChatHost: (chatId) => (chatId === 'c-mac' ? 'd-mac' : 'd-home'),
      homeDaemonId: () => 'd-home',
      registeredDaemonIds: () => ['d-home', 'd-mac'],
    });
    const mac = await makePair(wss, url);
    const home = await makePair(wss, url);
    sockets.push(mac.client, home.client);
    const gotMac: WireEvent[] = [];
    const gotHome: WireEvent[] = [];
    mac.client.on('message', (raw) => gotMac.push(decode(raw as Buffer)));
    home.client.on('message', (raw) => gotHome.push(decode(raw as Buffer)));
    link.attach(mac.server, 'd-mac');
    link.attach(home.server, 'd-home');

    link.send('srf-1', {
      type: 'chat.permission_response',
      chatId: 'c-mac',
      requestId: 'req-1',
      approve: true,
    });
    await waitFor(() => gotMac.length === 1, 1000);
    expect(gotMac[0]).toMatchObject({ type: 'chat.permission_response', requestId: 'req-1' });
    expect(gotHome).toHaveLength(0);
  });

  it("tells the requesting surface `daemon_unavailable` (not a silent drop, and never a guess) when a chat-scoped frame's host never registers", async () => {
    link = new InboundDaemonLink({
      logger: silentLogger,
      resolveChatHost: () => null,
      homeDaemonId: () => 'd-home', // registered, but never attached: offline throughout.
      registeredDaemonIds: () => ['d-home', 'd-other'], // more than one — a guess can be wrong.
      unknownChatHostWaitMs: 30,
      unknownChatHostPollMs: 10,
    });

    const events: WireEvent[] = [];
    link.onEvent((e) => events.push(e));

    link.send('srf-1', {
      type: 'chat.input',
      chatId: 'unknown-chat',
      message: 'hi',
      localId: 'L1',
    });

    await waitFor(() => events.length === 1, 1000);
    expect(events[0]).toMatchObject({
      type: 'chat.error',
      chatId: 'unknown-chat',
      error: { code: 'daemon_unavailable' },
      forSurfaceId: 'srf-1',
    });
  });

  it('with only ONE registered machine, still guesses home for an unresolved chat and buffers rather than waiting (unchanged single-host behaviour)', async () => {
    link = new InboundDaemonLink({
      logger: silentLogger,
      resolveChatHost: () => null,
      homeDaemonId: () => 'd1',
      registeredDaemonIds: () => ['d1'],
      unknownChatHostWaitMs: 50,
      unknownChatHostPollMs: 10,
    });
    // Guessed home is offline right now — buffers rather than dropping, same
    // as `sendTo` always has.
    link.send('srf-1', { type: 'chat.input', chatId: 'c1', message: 'a', localId: 'L1' });

    const { server, client } = await makePair(wss, url);
    sockets.push(client);
    const got: WireEvent[] = [];
    client.on('message', (raw) => got.push(decode(raw as Buffer)));

    link.attach(server, 'd1');
    await waitFor(() => got.length === 1, 1000);
    expect(got[0]).toMatchObject({ type: 'chat.input', localId: 'L1' });
  });

  it('goes offline when the host socket closes', async () => {
    link = new InboundDaemonLink({ logger: silentLogger });
    const statuses: string[] = [];
    link.onStatus((s) => statuses.push(s));

    const { server, client } = await makePair(wss, url);
    sockets.push(client);
    link.attach(server, 'd1');
    expect(link.status()).toBe('online');

    client.close();
    await waitFor(() => link!.status() === 'offline', 1000);
    expect(statuses).toEqual(['online', 'offline']);
  });

  it('closes the previous socket when the SAME machine re-attaches', async () => {
    link = new InboundDaemonLink({ logger: silentLogger });
    const p1 = await makePair(wss, url);
    const p2 = await makePair(wss, url);
    sockets.push(p1.client, p2.client);

    link.attach(p1.server, 'd1');
    const firstClosed = new Promise<void>((resolve) => p1.client.once('close', () => resolve()));

    link.attach(p2.server, 'd1');
    await firstClosed; // previous host socket was closed
    expect(link.status()).toBe('online');
  });

  it('re-attach with a DIFFERENT socket for the same machine fires a genuine offline->online cycle', () => {
    // The reported bug: a host process crashes and a new process for the
    // SAME daemonId reconnects fast. attach() used to swap `link.socket`
    // in-place without ever calling setStatus('offline'), so the trailing
    // setStatus('online') at the end of attach() was a no-op (already
    // online) and `onHostStatus` handlers never fired for 'offline' — which
    // is exactly what left `resolveInFlightChatsOnDaemonOffline` in
    // ws-hub.ts unfired, stranding any chat that was running on the dead
    // process. A real offline->online cycle must be observable here.
    link = new InboundDaemonLink({ logger: silentLogger });
    const transitions: Array<[string, 'online' | 'offline']> = [];
    link.onHostStatus((daemonId, s) => transitions.push([daemonId, s]));

    const first = fakeSocket();
    link.attach(first as unknown as WebSocket, 'd1');
    expect(transitions).toEqual([['d1', 'online']]);

    const second = fakeSocket();
    link.attach(second as unknown as WebSocket, 'd1'); // simulates crash + fast reconnect

    // A genuine offline->online cycle around the second attach, not silence.
    expect(transitions).toEqual([
      ['d1', 'online'],
      ['d1', 'offline'],
      ['d1', 'online'],
    ]);
    expect(link.status()).toBe('online');
  });

  it('terminateDaemonSocket severs the live socket and goes offline', async () => {
    link = new InboundDaemonLink({ logger: silentLogger });
    const { server, client } = await makePair(wss, url);
    sockets.push(client);
    link.attach(server, 'd1');

    const closed = new Promise<void>((resolve) => client.once('close', () => resolve()));
    expect(link.terminateDaemonSocket()).toBe(true);
    await closed;
    expect(link.status()).toBe('offline');
    expect(link.terminateDaemonSocket()).toBe(false); // nothing live now
  });

  it("forget closes the machine's socket, goes offline, and drops frames buffered for it", async () => {
    link = new InboundDaemonLink({ logger: silentLogger });
    const { server, client } = await makePair(wss, url);
    sockets.push(client);
    link.attach(server, 'd1');
    const statuses: string[] = [];
    link.onHostStatus((id, st) => statuses.push(`${id}:${st}`));

    const closed = new Promise<void>((resolve) => client.once('close', () => resolve()));
    expect(link.forget('d1')).toBe(true);
    await closed;
    expect(statuses).toEqual(['d1:offline']);
    expect(link.onlineDaemonIds()).toEqual([]);
    expect(link.daemonId()).toBeNull();

    // A frame queued for it afterwards, then forgotten again, is never
    // delivered to a machine that later attaches under the same id.
    link.sendTo('d1', 'srf-1', { type: 'chat.stop_request', chatId: 'c1' });
    expect(link.forget('d1')).toBe(false);
    const again = await makePair(wss, url);
    sockets.push(again.client);
    const got: string[] = [];
    again.client.on('message', (raw) => got.push(decode(raw as Buffer).type));
    link.attach(again.server, 'd1');
    await new Promise((r) => setTimeout(r, 50));
    expect(got).not.toContain('chat.stop_request');
  });

  it('drop-oldest at the 10k buffer cap, flushing the survivors on attach', async () => {
    link = new InboundDaemonLink({ logger: silentLogger, resolveChatHost: () => 'd1' });
    // 10_001 events while detached → oldest (L0) dropped, 10k survive (L1..L10000).
    for (let i = 0; i <= 10_000; i++) {
      link.send('srf-1', { type: 'chat.input', chatId: 'c1', message: `m${i}`, localId: `L${i}` });
    }

    const { server, client } = await makePair(wss, url);
    sockets.push(client);
    const got: string[] = [];
    client.on('message', (raw) => {
      const e = decode(raw as Buffer);
      if (e.type === 'chat.input') got.push(e.localId);
    });

    link.attach(server, 'd1');
    await waitFor(() => got.length === 10_000, 3000);
    expect(got.length).toBe(10_000);
    expect(got[0]).toBe('L1'); // L0 dropped as oldest
    expect(got[got.length - 1]).toBe('L10000');
  });

  it('attach() after close() just closes the incoming socket and stays offline', async () => {
    link = new InboundDaemonLink({ logger: silentLogger });
    await link.close();
    const fs = fakeSocket();
    link.attach(fs as unknown as WebSocket, 'd1');
    expect(link.status()).toBe('offline');
    // The fake's close() emits 'close' synchronously when it succeeds — this
    // just proves attach() actually called socket.close() (no throw path here).
  });

  it('attach() after close() swallows a throwing socket.close() (defensive catch)', async () => {
    link = new InboundDaemonLink({ logger: silentLogger });
    await link.close();
    const fs = fakeSocket();
    fs.closeShouldThrow = true;
    expect(() => link!.attach(fs as unknown as WebSocket, 'd1')).not.toThrow();
  });

  it('closing the previous socket on re-attach swallows a throwing close() (defensive catch)', () => {
    link = new InboundDaemonLink({ logger: silentLogger });
    const first = fakeSocket();
    first.closeShouldThrow = true;
    link.attach(first as unknown as WebSocket, 'd1');
    const second = fakeSocket();
    expect(() => link!.attach(second as unknown as WebSocket, 'd1')).not.toThrow();
    expect(link.status()).toBe('online');
  });

  it('drops a malformed frame from the host socket instead of throwing', () => {
    link = new InboundDaemonLink({ logger: silentLogger });
    const fs = fakeSocket();
    link.attach(fs as unknown as WebSocket, 'd1');
    const received: WireEvent[] = [];
    link.onEvent((e) => received.push(e));
    expect(() => fs.emit('message', Buffer.from('not a valid wire frame'))).not.toThrow();
    expect(received).toHaveLength(0);
  });

  it('ignores a message arriving on a socket that is no longer the attached one', () => {
    link = new InboundDaemonLink({ logger: silentLogger });
    const first = fakeSocket();
    link.attach(first as unknown as WebSocket, 'd1');
    const second = fakeSocket();
    link.attach(second as unknown as WebSocket, 'd1'); // first is detached now
    const received: WireEvent[] = [];
    link.onEvent((e) => received.push(e));
    // Stale 'message' on the now-detached first socket must be ignored.
    first.emit('message', encode({ type: 'daemon.online', daemonId: 'd1' } satisfies WireEvent));
    expect(received).toHaveLength(0);
  });

  it('accepts a message payload delivered as an array of Buffer fragments', () => {
    link = new InboundDaemonLink({ logger: silentLogger });
    const fs = fakeSocket();
    link.attach(fs as unknown as WebSocket, 'd1');
    const received: WireEvent[] = [];
    link.onEvent((e) => received.push(e));
    const full = Buffer.from(
      encode({ type: 'daemon.online', daemonId: 'd1' } satisfies WireEvent),
      'utf8',
    );
    const mid = Math.floor(full.length / 2);
    fs.emit('message', [full.subarray(0, mid), full.subarray(mid)]);
    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe('daemon.online');
  });

  it('logs but does not throw on a socket error event (close follows separately)', () => {
    link = new InboundDaemonLink({ logger: silentLogger });
    const fs = fakeSocket();
    link.attach(fs as unknown as WebSocket, 'd1');
    expect(() => fs.emit('error', new Error('boom'))).not.toThrow();
    // Link is unaffected until 'close' actually fires.
    expect(link.status()).toBe('online');
  });

  it('lastConnectedAt() is null before any connection, then an epoch-ms after attach', async () => {
    link = new InboundDaemonLink({ logger: silentLogger });
    expect(link.lastConnectedAt()).toBeNull();
    const { server, client } = await makePair(wss, url);
    sockets.push(client);
    const before = Date.now();
    link.attach(server, 'd1');
    expect(link.lastConnectedAt()).not.toBeNull();
    expect(link.lastConnectedAt()!).toBeGreaterThanOrEqual(before);
  });

  it('injectDaemonEvent() feeds the same onEvent pipeline a real frame would', () => {
    link = new InboundDaemonLink({ logger: silentLogger });
    const received: WireEvent[] = [];
    link.onEvent((e) => received.push(e));
    link.injectDaemonEvent({ type: 'daemon.online', daemonId: 'd1' });
    expect(received).toEqual([{ type: 'daemon.online', daemonId: 'd1' }]);
  });

  it('terminateDaemonSocket swallows a throwing socket.close() (defensive catch)', () => {
    link = new InboundDaemonLink({ logger: silentLogger });
    const fs = fakeSocket();
    fs.closeShouldThrow = true;
    link.attach(fs as unknown as WebSocket, 'd1');
    let result = false;
    expect(() => {
      result = link!.terminateDaemonSocket();
    }).not.toThrow();
    expect(result).toBe(true);
  });

  it('close() swallows a throwing socket.close() (defensive catch) and goes offline', async () => {
    const l = new InboundDaemonLink({ logger: silentLogger });
    const fs = fakeSocket();
    fs.closeShouldThrow = true;
    l.attach(fs as unknown as WebSocket, 'd1');
    await expect(l.close()).resolves.toBeUndefined();
    expect(l.status()).toBe('offline');
  });

  it('close() with no live socket is a no-op that still marks offline', async () => {
    const l = new InboundDaemonLink({ logger: silentLogger });
    await expect(l.close()).resolves.toBeUndefined();
    expect(l.status()).toBe('offline');
  });
});

describe('InProcessDaemonLink', () => {
  it('starts online with a non-null lastConnectedAt', () => {
    const link = new InProcessDaemonLink();
    expect(link.status()).toBe('online');
    expect(link.lastConnectedAt()).not.toBeNull();
  });

  it('setStatus is a no-op when already at the target status (no duplicate notify)', () => {
    const link = new InProcessDaemonLink();
    const statuses: string[] = [];
    link.onStatus((s) => statuses.push(s));
    link.setStatus('online'); // already online — no-op, no handler call
    expect(statuses).toEqual([]);
    link.setStatus('offline');
    expect(statuses).toEqual(['offline']);
  });

  it('setStatus back to online refreshes lastConnectedAt', () => {
    const link = new InProcessDaemonLink();
    link.setStatus('offline');
    const before = Date.now();
    link.setStatus('online');
    expect(link.lastConnectedAt()!).toBeGreaterThanOrEqual(before);
  });

  it('injectDaemonEvent() drives the same handlers as emit()', () => {
    const link = new InProcessDaemonLink();
    const received: WireEvent[] = [];
    const unsub = link.onEvent((e) => received.push(e));
    link.injectDaemonEvent({ type: 'daemon.online', daemonId: 'd1' });
    expect(received).toEqual([{ type: 'daemon.online', daemonId: 'd1' }]);
    unsub();
    link.injectDaemonEvent({ type: 'daemon.online', daemonId: 'd1' });
    expect(received).toHaveLength(1); // unsubscribed — no further delivery
  });

  it('onStatus unsubscribe stops further delivery', () => {
    const link = new InProcessDaemonLink();
    const statuses: string[] = [];
    const unsub = link.onStatus((s) => statuses.push(s));
    link.setStatus('offline');
    unsub();
    link.setStatus('online');
    expect(statuses).toEqual(['offline']);
  });

  it('close() resolves with nothing to tear down', async () => {
    const link = new InProcessDaemonLink();
    await expect(link.close()).resolves.toBeUndefined();
  });

  it('send() records the surface + event for test introspection', () => {
    const link = new InProcessDaemonLink();
    link.send('srf-1', { type: 'daemon.online', daemonId: 'd1' });
    expect(link.sent).toEqual([
      { surfaceId: 'srf-1', event: { type: 'daemon.online', daemonId: 'd1' } },
    ]);
  });
});

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('waitFor: timed out');
}
