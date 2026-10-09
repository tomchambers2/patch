// Outbound host -> patch-server WebSocket client.
//
// Covers: well-formed host hello (clientType 'daemon', auth = stored
// daemonKey); auth.ok transition + onAuthed; reconnect with backoff after a
// drop; offline buffering (drop-oldest, cap) + flush on reconnect.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import pino from 'pino';
import WS, { WebSocketServer, type WebSocket } from 'ws';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { WireEvent } from '@patch/wire';
import {
  createServerLink,
  BACKOFF_SCHEDULE_MS,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  type ServerLink,
} from '../src/serverLink.js';

const silent = pino({ level: 'silent' });

/**
 * A fully-controllable fake WebSocket (EventEmitter-based), substituted via
 * `wsFactory`. Lets tests drive serverLink's low-level `message`/`error`
 * handler branches (fragmented/ArrayBuffer frames, a non-WireDecodeError
 * thrown mid-parse, the socket error handler) and `dropLink`'s readyState
 * branches directly — none of which are reachable through the real fake-server
 * harness above, which only ever sends well-formed JSON text frames.
 */
class FakeSocket extends EventEmitter {
  readyState: number = WS.CONNECTING;
  sent: string[] = [];
  pings = 0;
  terminated = false;
  send(data: string): void {
    this.sent.push(data);
  }
  ping(): void {
    this.pings += 1;
  }
  /** Real `ws` sockets `terminate()` a dead connection rather than `close()`
   * it — no close handshake to wait out. The heartbeat's `close` side effect
   * (marking offline, scheduling reconnect) is exercised via the same
   * 'close' emit either way. */
  terminate(): void {
    this.terminated = true;
    this.close();
  }
  close(): void {
    if (this.readyState === WS.CLOSED) return;
    this.readyState = WS.CLOSED;
    this.emit('close', 1000, Buffer.from(''));
  }
}

interface FakeServer {
  url: string;
  /** Resolves with the first hello frame the next client sends. */
  nextHello(): Promise<Record<string, unknown>>;
  /** Drop the currently-connected client socket. */
  dropClient(): void;
  /** Every decoded JSON frame received from clients (post-hello). */
  received: Record<string, unknown>[];
  close(): Promise<void>;
}

/**
 * Fake patch-server `/ws`: on each connection, waits for the host `hello`,
 * then replies `auth.ok` + `daemon.online` (the pinned contract). All later
 * frames are collected in `received`.
 */
function startFakeServer(): Promise<FakeServer> {
  const wss = new WebSocketServer({ port: 0 });
  const received: Record<string, unknown>[] = [];
  let current: WebSocket | undefined;
  const helloWaiters: ((h: Record<string, unknown>) => void)[] = [];
  const pendingHellos: Record<string, unknown>[] = [];

  wss.on('connection', (ws) => {
    current = ws;
    let saidHello = false;
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
      if (!saidHello && msg['type'] === 'hello') {
        saidHello = true;
        const w = helloWaiters.shift();
        if (w) w(msg);
        else pendingHellos.push(msg);
        ws.send(
          JSON.stringify({
            type: 'auth.ok',
            hosts: [],
            accountId: 'acct-1',
            surfaceId: 'daemon-1',
          }),
        );
        ws.send(JSON.stringify({ type: 'daemon.online', daemonId: 'd1' }));
        return;
      }
      received.push(msg);
    });
  });

  return new Promise((resolve) => {
    wss.on('listening', () => {
      const port = (wss.address() as AddressInfo).port;
      resolve({
        url: `ws://127.0.0.1:${port}/ws`,
        received,
        nextHello: () =>
          new Promise((res) => {
            const buffered = pendingHellos.shift();
            if (buffered) res(buffered);
            else helloWaiters.push(res);
          }),
        dropClient: () => current?.close(),
        close: () =>
          new Promise<void>((res) => {
            wss.close(() => res());
          }),
      });
    });
  });
}

function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (pred()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timeout'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

const stateEvent = (chatId: string): WireEvent => ({
  type: 'chat.state',
  permissionMode: 'bypassPermissions',
  chatId,
  activity: 'idle',
  lastUpdated: 1,
});

describe('serverLink', () => {
  const links: ServerLink[] = [];
  const servers: FakeServer[] = [];
  afterEach(async () => {
    await Promise.all(links.splice(0).map((l) => l.close()));
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  function track(link: ServerLink): ServerLink {
    links.push(link);
    return link;
  }

  it('connects and sends a well-formed host hello with the stored daemonKey', async () => {
    const server = await startFakeServer();
    servers.push(server);
    const link = track(
      createServerLink({
        url: server.url,
        daemonKey: 'the-daemon-jwt',
        clientVersion: '9.9.9',
        logger: silent,
      }),
    );
    link.start();
    const hello = await server.nextHello();
    expect(hello['type']).toBe('hello');
    expect(hello['clientType']).toBe('daemon');
    expect(hello['clientVersion']).toBe('9.9.9');
    expect(hello['auth']).toBe('the-daemon-jwt');
    await waitFor(() => link.isOnline());
  });

  it('calls onAuthed after the server sends auth.ok', async () => {
    const server = await startFakeServer();
    servers.push(server);
    let authedCount = 0;
    const link = track(
      createServerLink({
        url: server.url,
        daemonKey: 'jwt',
        clientVersion: '1.0.0',
        logger: silent,
        onAuthed: () => {
          authedCount += 1;
        },
      }),
    );
    link.start();
    await waitFor(() => authedCount === 1);
    expect(link.isOnline()).toBe(true);
  });

  it('the default first reconnect backoff step is short (spec/12 ≤1s)', () => {
    // spec/12 ## Surface connection state model: "its first reconnect backoff
    // step is short (≤1s) so a transient miss recovers within about a second."
    expect(BACKOFF_SCHEDULE_MS[0]).toBeLessThanOrEqual(1_000);
    // Still backs off on repeated failure and caps at 30s.
    expect(BACKOFF_SCHEDULE_MS[BACKOFF_SCHEDULE_MS.length - 1]).toBe(30_000);
  });

  it('first reconnect fires promptly after an initial dial miss (default schedule)', async () => {
    // A boot-time transient miss (server not yet bound) must recover within
    // about a second — the FIRST retry uses the short leading backoff step, not
    // a full second+. Drive the real default schedule; each connect throws in
    // the wsFactory, and we measure the gap between the first and second dials.
    const dialTimes: number[] = [];
    const link = track(
      createServerLink({
        url: 'ws://127.0.0.1:1/ws',
        daemonKey: 'jwt',
        clientVersion: '1.0.0',
        logger: silent,
        // No backoffSchedule override — assert the production default.
        wsFactory: () => {
          dialTimes.push(Date.now());
          throw new Error('connection refused');
        },
      }),
    );
    link.start();
    await waitFor(() => dialTimes.length >= 2, 2_000);
    const firstBackoff = dialTimes[1]! - dialTimes[0]!;
    // Comfortably under a second (the short leading step), and not instant.
    expect(firstBackoff).toBeLessThan(1_000);
    expect(firstBackoff).toBeGreaterThanOrEqual(150);
  });

  it('reconnects with backoff after a drop and re-sends hello', async () => {
    const server = await startFakeServer();
    servers.push(server);
    const link = track(
      createServerLink({
        url: server.url,
        daemonKey: 'jwt',
        clientVersion: '1.0.0',
        logger: silent,
        backoffSchedule: [10, 10, 10],
      }),
    );
    link.start();
    await server.nextHello();
    await waitFor(() => link.isOnline());
    server.dropClient();
    await waitFor(() => !link.isOnline());
    // Second hello proves a reconnect attempt occurred.
    const hello2 = await server.nextHello();
    expect(hello2['clientType']).toBe('daemon');
    await waitFor(() => link.isOnline());
  });

  it('buffers outbound events while offline and flushes on (re)connect', async () => {
    // Buffer events BEFORE the link is online, then connect.
    const server = await startFakeServer();
    servers.push(server);
    const link = track(
      createServerLink({
        url: server.url,
        daemonKey: 'jwt',
        clientVersion: '1.0.0',
        logger: silent,
        backoffSchedule: [10],
      }),
    );
    // queued before start: pure offline buffering
    link.send(stateEvent('chat-a'));
    link.send(stateEvent('chat-b'));
    link.start();
    await server.nextHello();
    await waitFor(() => server.received.length >= 2);
    const ids = server.received.map((e) => e['chatId']);
    expect(ids).toContain('chat-a');
    expect(ids).toContain('chat-b');
  });

  it('drops oldest when the offline buffer cap is exceeded', async () => {
    const server = await startFakeServer();
    servers.push(server);
    const link = track(
      createServerLink({
        url: server.url,
        daemonKey: 'jwt',
        clientVersion: '1.0.0',
        logger: silent,
        backoffSchedule: [10],
        bufferMaxPerChat: 3,
      }),
    );
    // 5 events for the same chat, cap 3 -> oldest 2 dropped.
    for (let i = 0; i < 5; i += 1) {
      link.send({
        type: 'chat.message',
        chatId: 'cap',
        role: 'assistant',
        content: `m${i}`,
        seq: i,
      });
    }
    link.start();
    await server.nextHello();
    await waitFor(() => server.received.length >= 3);
    const contents = server.received.map((e) => e['content']);
    expect(contents).toEqual(['m2', 'm3', 'm4']);
  });

  it('send() delivers immediately (rawSend) when already online, not buffered', async () => {
    const server = await startFakeServer();
    servers.push(server);
    const link = track(
      createServerLink({
        url: server.url,
        daemonKey: 'jwt',
        clientVersion: '1.0.0',
        logger: silent,
      }),
    );
    link.start();
    await server.nextHello();
    await waitFor(() => link.isOnline());
    link.send(stateEvent('online-chat'));
    await waitFor(() => server.received.some((e) => e['chatId'] === 'online-chat'));
    expect(link.diagnostics().bufferSize).toBe(0);
  });

  it('diagnostics() reports bufferMaxPerChat default when unset, and the override when set', async () => {
    const linkDefault = track(
      createServerLink({
        url: 'ws://127.0.0.1:1/ws',
        daemonKey: 'k',
        clientVersion: '1',
        logger: silent,
      }),
    );
    expect(linkDefault.diagnostics().bufferMaxPerChat).toBe(10_000);
    const linkOverride = track(
      createServerLink({
        url: 'ws://127.0.0.1:1/ws',
        daemonKey: 'k',
        clientVersion: '1',
        logger: silent,
        bufferMaxPerChat: 7,
      }),
    );
    expect(linkOverride.diagnostics().bufferMaxPerChat).toBe(7);
  });

  it('backoffMs falls back to 30000 when the schedule is empty (defensive ?? chain)', async () => {
    const entries: Record<string, unknown>[] = [];
    const capturing = pino({ level: 'info' }, {
      write: (s: string) => entries.push(JSON.parse(s)),
    } as never);
    const link = track(
      createServerLink({
        url: 'ws://127.0.0.1:1/ws',
        daemonKey: 'k',
        clientVersion: '1',
        logger: capturing,
        backoffSchedule: [],
        wsFactory: () => {
          throw new Error('connection refused');
        },
      }),
    );
    link.start();
    await waitFor(() => entries.some((e) => String(e['msg']).includes('scheduling reconnect')));
    const entry = entries.find((e) => String(e['msg']).includes('scheduling reconnect'));
    expect(entry?.['wait']).toBe(30_000);
  });

  describe('dropLink()', () => {
    it('returns false when nothing has ever connected', () => {
      const link = track(
        createServerLink({
          url: 'ws://x',
          daemonKey: 'k',
          clientVersion: '1',
          logger: silent,
          wsFactory: () => new FakeSocket() as unknown as WebSocket,
        }),
      );
      expect(link.dropLink()).toBe(false);
    });

    it('returns false when the socket is already CLOSED (no live socket to drop)', () => {
      const socket = new FakeSocket();
      const link = track(
        createServerLink({
          url: 'ws://x',
          daemonKey: 'k',
          clientVersion: '1',
          logger: silent,
          wsFactory: () => socket as unknown as WebSocket,
        }),
      );
      link.start();
      // Simulate an already-closed socket WITHOUT the 'close' event having run
      // (so `ws` in the closure still points at it) — the readyState branch.
      socket.readyState = WS.CLOSED;
      expect(link.dropLink()).toBe(false);
    });

    it('closes a connected-but-not-yet-authed socket WITHOUT firing onDisconnected', () => {
      const socket = new FakeSocket();
      let disconnected = 0;
      const link = track(
        createServerLink({
          url: 'ws://x',
          daemonKey: 'k',
          clientVersion: '1',
          logger: silent,
          wsFactory: () => socket as unknown as WebSocket,
          onDisconnected: () => {
            disconnected += 1;
          },
        }),
      );
      link.start();
      socket.readyState = WS.OPEN;
      socket.emit('open');
      expect(link.isOnline()).toBe(false); // no auth.ok yet
      expect(link.dropLink()).toBe(true);
      expect(disconnected).toBe(0);
    });

    it('closes an authenticated socket and DOES fire onDisconnected', () => {
      const socket = new FakeSocket();
      let disconnected = 0;
      const link = track(
        createServerLink({
          url: 'ws://x',
          daemonKey: 'k',
          clientVersion: '1',
          logger: silent,
          wsFactory: () => socket as unknown as WebSocket,
          onDisconnected: () => {
            disconnected += 1;
          },
        }),
      );
      link.start();
      socket.readyState = WS.OPEN;
      socket.emit('open');
      socket.emit(
        'message',
        Buffer.from(
          JSON.stringify({
            type: 'auth.ok',
            hosts: [],
            accountId: 'acct-1',
            surfaceId: 'daemon-1',
          }),
        ),
      );
      expect(link.isOnline()).toBe(true);
      expect(link.dropLink()).toBe(true);
      expect(disconnected).toBe(1);
      expect(link.isOnline()).toBe(false);
    });
  });

  describe('severForTest() / bufferSizeForTest() — TD3 harness gate', () => {
    it('throw when enableTestHooks is not set', () => {
      const link = track(
        createServerLink({
          url: 'ws://x',
          daemonKey: 'k',
          clientVersion: '1',
          logger: silent,
          wsFactory: () => new FakeSocket() as unknown as WebSocket,
        }),
      );
      expect(() => link.severForTest()).toThrow(/test hooks not enabled/);
      expect(() => link.bufferSizeForTest()).toThrow(/test hooks not enabled/);
    });

    it('delegate to dropLink()/buffer.size() when enableTestHooks is true', () => {
      const socket = new FakeSocket();
      const link = track(
        createServerLink({
          url: 'ws://x',
          daemonKey: 'k',
          clientVersion: '1',
          logger: silent,
          enableTestHooks: true,
          wsFactory: () => socket as unknown as WebSocket,
        }),
      );
      link.start();
      socket.readyState = WS.OPEN;
      socket.emit('open');
      socket.emit(
        'message',
        Buffer.from(
          JSON.stringify({
            type: 'auth.ok',
            hosts: [],
            accountId: 'acct-1',
            surfaceId: 'daemon-1',
          }),
        ),
      );
      expect(link.bufferSizeForTest()).toBe(0);
      expect(link.severForTest()).toBe(true);
    });
  });

  describe('message handler — frame shapes + decode error branches', () => {
    function linked(
      socket: FakeSocket,
      extra: Partial<Parameters<typeof createServerLink>[0]> = {},
    ) {
      return track(
        createServerLink({
          url: 'ws://x',
          daemonKey: 'k',
          clientVersion: '1',
          logger: silent,
          wsFactory: () => socket as unknown as WebSocket,
          ...extra,
        }),
      );
    }

    it('accepts a fragmented message delivered as Buffer[] (Array.isArray branch)', () => {
      const socket = new FakeSocket();
      const link = linked(socket);
      link.start();
      socket.emit('open');
      const json = JSON.stringify({
        type: 'auth.ok',
        hosts: [],
        accountId: 'acct-1',
        surfaceId: 'daemon-1',
      });
      const half = Math.floor(json.length / 2);
      const parts = [Buffer.from(json.slice(0, half)), Buffer.from(json.slice(half))];
      socket.emit('message', parts);
      expect(link.isOnline()).toBe(true);
    });

    it('accepts a message delivered as a raw ArrayBuffer', () => {
      const socket = new FakeSocket();
      const link = linked(socket);
      link.start();
      socket.emit('open');
      const json = JSON.stringify({
        type: 'auth.ok',
        hosts: [],
        accountId: 'acct-1',
        surfaceId: 'daemon-1',
      });
      const buf = Buffer.from(json, 'utf8');
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      socket.emit('message', ab);
      expect(link.isOnline()).toBe(true);
    });

    it('a WireDecodeError (malformed JSON) is swallowed with a warning, not thrown', () => {
      const socket = new FakeSocket();
      const link = linked(socket);
      link.start();
      socket.emit('open');
      expect(() => socket.emit('message', Buffer.from('{not json'))).not.toThrow();
      expect(link.isOnline()).toBe(false);
    });

    // spec/03 § Forward compatibility. The host is the other reader that is
    // routinely OLDER than its sender: hosts OTA on their own schedule, so a
    // field the server has just started sending must not make this host drop
    // the frame carrying it.
    it('a frame from a NEWER server, carrying an unknown field, still reaches onFrame', () => {
      const socket = new FakeSocket();
      const frames: WireEvent[] = [];
      const link = linked(socket, { onFrame: (event) => frames.push(event) });
      link.start();
      socket.emit('open');
      socket.emit(
        'message',
        Buffer.from(
          JSON.stringify({
            type: 'auth.ok',
            hosts: [],
            accountId: 'acct-1',
            surfaceId: 'daemon-1',
          }),
        ),
      );
      socket.emit(
        'message',
        Buffer.from(
          JSON.stringify({ ...stateEvent('newer-server'), limitResetsAt: 1789000000000 }),
        ),
      );
      expect(frames).toHaveLength(1);
      expect(frames[0]).toEqual(stateEvent('newer-server'));
    });

    it('an event type this host has never heard of is dropped, not thrown', () => {
      const socket = new FakeSocket();
      const frames: WireEvent[] = [];
      const link = linked(socket, { onFrame: (event) => frames.push(event) });
      link.start();
      socket.emit('open');
      expect(() =>
        socket.emit('message', Buffer.from(JSON.stringify({ type: 'chat.vibes', chatId: 'c1' }))),
      ).not.toThrow();
      expect(frames).toHaveLength(0);
      expect(link.isOnline()).toBe(false);
    });

    it('a frame that is genuinely wrong — not merely newer — is still refused', () => {
      const socket = new FakeSocket();
      const frames: WireEvent[] = [];
      const link = linked(socket, { onFrame: (event) => frames.push(event) });
      link.start();
      socket.emit('open');
      socket.emit(
        'message',
        // `activity` is an enum; 'vibing' is not one of its values. An added
        // enum VALUE stays a breaking change, deliberately (spec/03).
        Buffer.from(JSON.stringify({ ...stateEvent('bad'), activity: 'vibing' })),
      );
      expect(frames).toHaveLength(0);
    });

    it('a non-WireDecodeError raised while framing the text (e.g. a malformed raw shape) is rethrown', () => {
      const socket = new FakeSocket();
      const link = linked(socket);
      link.start();
      socket.emit('open');
      // Not a Buffer, not an Array, and not a real ArrayBuffer — Buffer.from()
      // throws a plain TypeError here, exercising the non-WireDecodeError
      // rethrow branch (decode() itself only ever throws WireDecodeError).
      expect(() => socket.emit('message', { not: 'a buffer' })).toThrow();
      expect(link.isOnline()).toBe(false);
    });

    it('calls onFrame for post-auth frames, and NOT for the auth.ok frame itself', () => {
      const socket = new FakeSocket();
      const frames: WireEvent[] = [];
      const link = linked(socket, { onFrame: (event) => frames.push(event) });
      link.start();
      socket.emit('open');
      socket.emit(
        'message',
        Buffer.from(
          JSON.stringify({
            type: 'auth.ok',
            hosts: [],
            accountId: 'acct-1',
            surfaceId: 'daemon-1',
          }),
        ),
      );
      expect(frames).toHaveLength(0); // auth.ok is handled internally, not via onFrame
      socket.emit('message', Buffer.from(JSON.stringify(stateEvent('via-onframe'))));
      expect(frames).toHaveLength(1);
      expect(frames[0]?.type).toBe('chat.state');
    });

    it('a second auth.ok while already online is routed through onFrame, not re-authed', () => {
      const socket = new FakeSocket();
      const frames: WireEvent[] = [];
      let authedCount = 0;
      const link = linked(socket, {
        onFrame: (event) => frames.push(event),
        onAuthed: () => {
          authedCount += 1;
        },
      });
      link.start();
      socket.emit('open');
      socket.emit(
        'message',
        Buffer.from(
          JSON.stringify({
            type: 'auth.ok',
            hosts: [],
            accountId: 'acct-1',
            surfaceId: 'daemon-1',
          }),
        ),
      );
      expect(authedCount).toBe(1);
      socket.emit(
        'message',
        Buffer.from(
          JSON.stringify({
            type: 'auth.ok',
            hosts: [],
            accountId: 'acct-1',
            surfaceId: 'daemon-1',
          }),
        ),
      );
      expect(authedCount).toBe(1); // NOT re-triggered
      expect(frames).toHaveLength(1); // the second auth.ok fell through to onFrame
    });

    it('the socket error handler logs and does not throw or affect reconnect scheduling', () => {
      const socket = new FakeSocket();
      const link = linked(socket, { backoffSchedule: [10] });
      link.start();
      socket.emit('open');
      expect(() => socket.emit('error', new Error('ECONNRESET'))).not.toThrow();
      // 'close' still follows independently and schedules a reconnect.
      expect(() => socket.close()).not.toThrow();
    });

    it('a close BEFORE ever authenticating does NOT fire onDisconnected (wasOnline false)', () => {
      const socket = new FakeSocket();
      let disconnected = 0;
      const link = linked(socket, {
        backoffSchedule: [10],
        onDisconnected: () => {
          disconnected += 1;
        },
      });
      link.start();
      socket.emit('open');
      expect(link.isOnline()).toBe(false);
      socket.close();
      expect(disconnected).toBe(0);
    });

    it('a NATURAL close (not via dropLink) while online DOES fire onDisconnected', () => {
      const socket = new FakeSocket();
      let disconnected = 0;
      const link = linked(socket, {
        backoffSchedule: [10],
        onDisconnected: () => {
          disconnected += 1;
        },
      });
      link.start();
      socket.emit('open');
      socket.emit(
        'message',
        Buffer.from(
          JSON.stringify({
            type: 'auth.ok',
            hosts: [],
            accountId: 'acct-1',
            surfaceId: 'daemon-1',
          }),
        ),
      );
      expect(link.isOnline()).toBe(true);
      // Server-initiated close (e.g. the server dropping the socket) — NOT
      // via dropLink(), which pre-flips `online` itself before closing.
      socket.close();
      expect(disconnected).toBe(1);
      expect(link.isOnline()).toBe(false);
    });

    it('a stale close from an old, already-replaced socket does not clear the current ws', async () => {
      const sockets = [new FakeSocket(), new FakeSocket()];
      let idx = 0;
      const link = track(
        createServerLink({
          url: 'ws://x',
          daemonKey: 'k',
          clientVersion: '1',
          logger: silent,
          backoffSchedule: [1],
          wsFactory: () => sockets[idx++]!,
        }),
      );
      link.start();
      const socket1 = sockets[0]!;
      socket1.readyState = WS.OPEN;
      socket1.emit('open');
      // Real close -> ws cleared, reconnect scheduled almost immediately.
      socket1.emit('close', 1000, Buffer.from(''));
      await waitFor(() => idx === 2);
      const socket2 = sockets[1]!;
      socket2.readyState = WS.OPEN;
      socket2.emit('open');
      // A STALE/duplicate close callback from the OLD socket1 (already
      // superseded by socket2) must NOT clear the CURRENT `ws` (socket2) — the
      // `if (ws === socket)` guard should see them as different and skip it.
      socket1.emit('close', 1000, Buffer.from(''));
      // If `ws` had been wrongly nulled, dropLink() would find no live socket.
      expect(link.dropLink()).toBe(true);
    });
  });

  it('accepts an explicit bufferMaxGlobal override', () => {
    const link = track(
      createServerLink({
        url: 'ws://127.0.0.1:1/ws',
        daemonKey: 'k',
        clientVersion: '1',
        logger: silent,
        bufferMaxGlobal: 5,
      }),
    );
    // No chatId on this synthetic event -> lands in the GLOBAL bucket, which
    // `bufferMaxGlobal` bounds.
    for (let i = 0; i < 8; i++) {
      link.send({ type: 'daemon.online', daemonId: 'd1' } as unknown as WireEvent);
    }
    expect(link.diagnostics().bufferSize).toBe(5);
  });

  describe('a server greeting this host cannot read', () => {
    // The shape that wedged the Mac on 2026-09-30: an `auth.ok` whose host
    // roster fails this build's schema.
    const unreadableGreeting = JSON.stringify({
      type: 'auth.ok',
      accountId: 'acct-1',
      surfaceId: 'daemon-1',
      hosts: [{ host: { type: 'daemon.host' } }],
    });

    it('asks for an update, drops the socket and reconnects instead of sitting unauthenticated', async () => {
      const sockets: FakeSocket[] = [];
      const unreadable: unknown[] = [];
      const link = track(
        createServerLink({
          url: 'ws://x',
          daemonKey: 'k',
          clientVersion: '1',
          logger: silent,
          backoffSchedule: [5],
          wsFactory: () => {
            const s = new FakeSocket();
            sockets.push(s);
            return s as unknown as WebSocket;
          },
          onGreetingUnreadable: (err) => unreadable.push(err),
        }),
      );
      link.start();
      const first = sockets[0]!;
      first.readyState = WS.OPEN;
      first.emit('open');
      first.emit('message', Buffer.from(unreadableGreeting));

      expect(unreadable).toHaveLength(1);
      expect(link.isOnline()).toBe(false);
      expect(first.readyState).toBe(WS.CLOSED);
      await new Promise((r) => setTimeout(r, 30));
      expect(sockets.length).toBeGreaterThanOrEqual(2);
    });

    it('does not treat a bad frame AFTER auth as a stale host', () => {
      const socket = new FakeSocket();
      const unreadable: unknown[] = [];
      const link = track(
        createServerLink({
          url: 'ws://x',
          daemonKey: 'k',
          clientVersion: '1',
          logger: silent,
          wsFactory: () => socket as unknown as WebSocket,
          onGreetingUnreadable: (err) => unreadable.push(err),
        }),
      );
      link.start();
      socket.readyState = WS.OPEN;
      socket.emit('open');
      socket.emit(
        'message',
        Buffer.from(
          JSON.stringify({
            type: 'auth.ok',
            accountId: 'acct-1',
            surfaceId: 'daemon-1',
            hosts: [],
          }),
        ),
      );
      expect(link.isOnline()).toBe(true);
      socket.emit('message', Buffer.from(unreadableGreeting));
      expect(unreadable).toHaveLength(0);
      expect(link.isOnline()).toBe(true);
      expect(socket.readyState).toBe(WS.OPEN);
    });
  });

  // 2026-09-30, Tom's Mac: `patch_artifact` failed twice in a row with
  // `artifact publish timed out after 15000ms` — the host's `linkOnline`
  // flag read true while the actual socket had gone half-open (laptop sleep/
  // network switch), so every RPC sent into it just hung until its OWN
  // timeout, with no reconnect ever triggered. A ws ping/pong heartbeat is
  // what turns that silent hang into a prompt, detectable disconnect.
  describe('heartbeat (ws ping/pong liveness)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('exports a sane production default', () => {
      expect(DEFAULT_HEARTBEAT_INTERVAL_MS).toBe(15_000);
    });

    it('pings on the interval once open, and keeps the socket alive while pongs answer', () => {
      const socket = new FakeSocket();
      const link = track(
        createServerLink({
          url: 'ws://x',
          daemonKey: 'k',
          clientVersion: '1',
          logger: silent,
          heartbeatIntervalMs: 1_000,
          wsFactory: () => socket as unknown as WebSocket,
        }),
      );
      link.start();
      socket.readyState = WS.OPEN;
      socket.emit('open');

      vi.advanceTimersByTime(1_000);
      expect(socket.pings).toBe(1);
      socket.emit('pong');
      vi.advanceTimersByTime(1_000);
      expect(socket.pings).toBe(2);
      expect(socket.terminated).toBe(false);
    });

    it('terminates a socket that stops answering pongs, and the normal backoff reconnect takes over', () => {
      const sockets = [new FakeSocket(), new FakeSocket()];
      let idx = 0;
      let disconnected = 0;
      const link = track(
        createServerLink({
          url: 'ws://x',
          daemonKey: 'k',
          clientVersion: '1',
          logger: silent,
          heartbeatIntervalMs: 1_000,
          backoffSchedule: [10],
          wsFactory: () => sockets[idx++]!,
          onDisconnected: () => {
            disconnected += 1;
          },
        }),
      );
      link.start();
      const first = sockets[0]!;
      first.readyState = WS.OPEN;
      first.emit('open');
      first.emit(
        'message',
        Buffer.from(
          JSON.stringify({
            type: 'auth.ok',
            hosts: [],
            accountId: 'acct-1',
            surfaceId: 'daemon-1',
          }),
        ),
      );
      expect(link.isOnline()).toBe(true);

      // First tick: sends a ping, no pong comes back (the dead-link case).
      vi.advanceTimersByTime(1_000);
      expect(first.pings).toBe(1);
      expect(link.isOnline()).toBe(true);

      // Second tick: nothing answered the previous ping -> terminated, and
      // the ordinary close/backoff path takes over.
      vi.advanceTimersByTime(1_000);
      expect(first.terminated).toBe(true);
      expect(link.isOnline()).toBe(false);
      expect(disconnected).toBe(1);

      vi.advanceTimersByTime(10);
      expect(idx).toBe(2);
    });

    it('does not resurrect a heartbeat for a socket already superseded by a reconnect', () => {
      // Guards the same "stale callback from an old socket" hazard the
      // dropLink/close tests cover for `ws`/`online` — a late pong or close
      // from socket1 must not touch socket2's live heartbeat timer.
      const sockets = [new FakeSocket(), new FakeSocket()];
      let idx = 0;
      const link = track(
        createServerLink({
          url: 'ws://x',
          daemonKey: 'k',
          clientVersion: '1',
          logger: silent,
          heartbeatIntervalMs: 1_000,
          backoffSchedule: [10],
          // The pre-existing "stale close" quirk (also exercised above, under
          // `dropLink()`/the message-handler describe) re-schedules a
          // reconnect even for a close from an already-superseded socket.
          // Clamping here keeps that quirk from needing a THIRD fake socket
          // just to avoid a crash — it is not what this test is about.
          wsFactory: () => sockets[Math.min(idx++, sockets.length - 1)]!,
        }),
      );
      link.start();
      const first = sockets[0]!;
      first.readyState = WS.OPEN;
      first.emit('open');
      first.emit('close', 1000, Buffer.from(''));
      vi.advanceTimersByTime(10);
      const second = sockets[1]!;
      second.readyState = WS.OPEN;
      second.emit('open');

      // Stale close from the superseded socket1.
      first.emit('close', 1000, Buffer.from(''));

      // socket2's heartbeat must still be running.
      vi.advanceTimersByTime(1_000);
      expect(second.pings).toBe(1);
    });
  });
});
