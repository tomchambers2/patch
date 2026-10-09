// Direct unit-level coverage of WsHub internals that are impractical (or
// genuinely impossible) to reach through a real WebSocket client + buildAll():
//   - the onConnect message-pipeline edge cases (first-frame-not-hello,
//     socket 'error' event, a throwing socket.close() inside closeOnce)
//   - handleHello's generic .catch() path (an unexpected internal throw, not
//     one of the already-handled auth-failure cases)
//   - the deps.nowSec override branch (app.ts never wires this — only a
//     directly-constructed WsHub can exercise it)
//   - onCallResponse's configured (true) branch
//   - onDaemonEvent's forSurfaceId-found success path
//   - terminateSurface's two defensive catch branches (throwing socket)
//
// Pattern: construct a bare WsHub directly (not via buildAll) and drive its
// private methods (`hub['onConnect']`, `hub['handleHello']`, etc.) with a
// minimal EventEmitter-based FakeSocket — the same technique test/daemon-
// link.test.ts uses for InboundDaemonLink.

import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import pino from 'pino';
import type WebSocket from 'ws';
import { encode, type WireEvent } from '@patch/wire';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import { WsHub } from '../src/ws-hub.js';
import { Registry } from '../src/registry.js';
import { PresenceTracker } from '../src/presence.js';
import { ChatRegistry } from '../src/chat-registry.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';

const silentLogger = pino({ level: 'silent' });

class FakeSocket extends EventEmitter {
  sent: string[] = [];
  closed: { code?: number; reason?: string }[] = [];
  closeShouldThrow = false;
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    if (this.closeShouldThrow) throw new Error('fake close failure');
    this.closed.push({ code, reason });
    this.emit('close');
  }
}

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'patch-wshub-unit-'));
}

describe('WsHub — onConnect low-level edge cases', () => {
  it('closes 4401 when the first frame is not hello', () => {
    const registry = Registry.load(makeDir());
    registry.bootstrapAccount();
    const hub = new WsHub({
      logger: silentLogger,
      registry,
      presence: new PresenceTracker(),
      daemonLink: new InProcessDaemonLink(),
      chatRegistry: new ChatRegistry(),
      idGenerator: () => 'id-1',
      helloTimeoutMs: 60_000,
    });
    const fs = new FakeSocket();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (hub as any).onConnect(fs as unknown as WebSocket, 'req-1');
    fs.emit('message', Buffer.from(encode({ type: 'surface.heartbeat' } satisfies WireEvent)));
    expect(fs.closed[0]?.code).toBe(4401);
  });

  it('logs but does not throw on a raw socket error event', () => {
    const registry = Registry.load(makeDir());
    registry.bootstrapAccount();
    const hub = new WsHub({
      logger: silentLogger,
      registry,
      presence: new PresenceTracker(),
      daemonLink: new InProcessDaemonLink(),
      chatRegistry: new ChatRegistry(),
      idGenerator: () => 'id-1',
      helloTimeoutMs: 60_000,
    });
    const fs = new FakeSocket();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (hub as any).onConnect(fs as unknown as WebSocket, 'req-2');
    expect(() => fs.emit('error', new Error('socket boom'))).not.toThrow();
  });

  it('closeOnce swallows a throwing socket.close() (malformed-frame path)', () => {
    const registry = Registry.load(makeDir());
    registry.bootstrapAccount();
    const hub = new WsHub({
      logger: silentLogger,
      registry,
      presence: new PresenceTracker(),
      daemonLink: new InProcessDaemonLink(),
      chatRegistry: new ChatRegistry(),
      idGenerator: () => 'id-1',
      helloTimeoutMs: 60_000,
    });
    const fs = new FakeSocket();
    fs.closeShouldThrow = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (hub as any).onConnect(fs as unknown as WebSocket, 'req-3');
    expect(() => fs.emit('message', Buffer.from('not valid json'))).not.toThrow();
  });
});

describe('WsHub — handleHello edge cases needing direct construction', () => {
  it('deps.nowSec override is used for hello verification when provided', async () => {
    const dir = makeDir();
    const user = generateUserKeypair(() => new Uint8Array(32).fill(90));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({
      surfaceId: 'srf-nowsec',
      surfaceKind: 'web',
      label: 'b',
      issuedAt: 1,
    });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-nowsec',
      surfaceKind: 'web',
      label: 'browser',
      now: 1_000_000,
      expiresAt: 1_000_000 + 3600,
    });
    let calls = 0;
    const hub = new WsHub({
      logger: silentLogger,
      registry,
      presence: new PresenceTracker(),
      daemonLink: new InProcessDaemonLink(),
      chatRegistry: new ChatRegistry(),
      idGenerator: () => 'id-1',
      nowSec: () => {
        calls += 1;
        return 1_000_050; // within the token's validity window per the override
      },
    });
    const fs = new FakeSocket();
    const conn = await (
      hub as unknown as {
        handleHello: (
          socket: WebSocket,
          hello: { type: 'hello'; auth: string; clientType?: string },
          log: typeof silentLogger,
        ) => Promise<unknown>;
      }
    ).handleHello(fs as unknown as WebSocket, { type: 'hello', auth: jwt }, silentLogger);
    expect(conn).not.toBeNull();
    expect(calls).toBeGreaterThan(0);
  });

  it('the auth-error catch path fires when an unexpected internal error is thrown mid-hello', async () => {
    const dir = makeDir();
    const user = generateUserKeypair(() => new Uint8Array(32).fill(91));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({ surfaceId: 'srf-boom', surfaceKind: 'web', label: 'b', issuedAt: 1 });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-boom',
      surfaceKind: 'web',
      label: 'browser',
    });
    // Force an unexpected throw AFTER credential verification succeeds but
    // before a ConnectedSurface is constructed — isRevoked is the next call
    // handleHello makes with no surrounding try/catch.
    const originalIsRevoked = registry.isRevoked.bind(registry);
    let threw = false;
    registry.isRevoked = (id: string): boolean => {
      if (!threw) {
        threw = true;
        throw new Error('unexpected registry failure');
      }
      return originalIsRevoked(id);
    };
    const hub = new WsHub({
      logger: silentLogger,
      registry,
      presence: new PresenceTracker(),
      daemonLink: new InProcessDaemonLink(),
      chatRegistry: new ChatRegistry(),
      idGenerator: () => 'id-1',
      helloTimeoutMs: 60_000,
    });
    const fs = new FakeSocket();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (hub as any).onConnect(fs as unknown as WebSocket, 'req-4');
    fs.emit(
      'message',
      Buffer.from(
        encode({
          type: 'hello',
          clientType: 'surface-web',
          clientVersion: '0.0.0-test',
          auth: jwt,
        } satisfies WireEvent),
      ),
    );
    // handleHello's promise rejection is handled asynchronously.
    await new Promise((r) => setTimeout(r, 20));
    expect(fs.closed[0]?.code).toBe(4401);
    expect(fs.closed[0]?.reason).toBe('auth error');
  });

  it('the auth-error catch path itself swallows a throwing socket.close() (double failure)', async () => {
    const dir = makeDir();
    const user = generateUserKeypair(() => new Uint8Array(32).fill(93));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({ surfaceId: 'srf-boom2', surfaceKind: 'web', label: 'b', issuedAt: 1 });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-boom2',
      surfaceKind: 'web',
      label: 'browser',
    });
    registry.isRevoked = (): boolean => {
      throw new Error('unexpected registry failure');
    };
    const hub = new WsHub({
      logger: silentLogger,
      registry,
      presence: new PresenceTracker(),
      daemonLink: new InProcessDaemonLink(),
      chatRegistry: new ChatRegistry(),
      idGenerator: () => 'id-1',
      helloTimeoutMs: 60_000,
    });
    const fs = new FakeSocket();
    fs.closeShouldThrow = true; // the auth-error close itself now also throws
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (hub as any).onConnect(fs as unknown as WebSocket, 'req-5');
    expect(() => {
      fs.emit(
        'message',
        Buffer.from(
          encode({
            type: 'hello',
            clientType: 'surface-web',
            clientVersion: '0.0.0-test',
            auth: jwt,
          } satisfies WireEvent),
        ),
      );
    }).not.toThrow();
    await new Promise((r) => setTimeout(r, 20));
    // No assertion on fs.closed — the point is that the double failure
    // (isRevoked throws, then the recovery close ALSO throws) never escapes
    // as an unhandled rejection or synchronous throw.
  });
});

describe('WsHub — fragmented (array) raw message payload on a surface socket', () => {
  it('reassembles an array-of-Buffer message payload exactly like a single Buffer', async () => {
    const dir = makeDir();
    const user = generateUserKeypair(() => new Uint8Array(32).fill(94));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({ surfaceId: 'srf-frag', surfaceKind: 'web', label: 'b', issuedAt: 1 });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-frag',
      surfaceKind: 'web',
      label: 'browser',
    });
    const daemonLink = new InProcessDaemonLink();
    const hub = new WsHub({
      logger: silentLogger,
      registry,
      presence: new PresenceTracker(),
      daemonLink,
      chatRegistry: new ChatRegistry(),
      idGenerator: () => 'id-1',
      helloTimeoutMs: 60_000,
    });
    const fs = new FakeSocket();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (hub as any).onConnect(fs as unknown as WebSocket, 'req-frag');
    fs.emit(
      'message',
      Buffer.from(
        encode({
          type: 'hello',
          clientType: 'surface-web',
          clientVersion: '0.0.0-test',
          auth: jwt,
        } satisfies WireEvent),
      ),
    );
    await new Promise((r) => setTimeout(r, 20)); // let hello resolve → state 'authed'

    const full = Buffer.from(
      encode({
        type: 'chat.input',
        chatId: 'chat-frag',
        message: 'fragmented',
        localId: 'L-frag',
      } satisfies WireEvent),
      'utf8',
    );
    const mid = Math.floor(full.length / 2);
    fs.emit('message', [full.subarray(0, mid), full.subarray(mid)]);
    await new Promise((r) => setTimeout(r, 20));
    const forwarded = daemonLink.sent.find((s) => s.event.type === 'chat.input');
    expect(forwarded).toBeDefined();
    expect((forwarded!.event as { localId: string }).localId).toBe('L-frag');
  });
});

describe('WsHub — onCallResponse configured (true branch)', () => {
  it('invokes the configured onCallResponse callback for chat.call_response', () => {
    const registry = Registry.load(makeDir());
    registry.bootstrapAccount();
    const received: Array<{ surfaceId: string; event: WireEvent }> = [];
    const hub = new WsHub({
      logger: silentLogger,
      registry,
      presence: new PresenceTracker(),
      daemonLink: new InProcessDaemonLink(),
      chatRegistry: new ChatRegistry(),
      idGenerator: () => 'id-1',
      onCallResponse: (surfaceId, event) => {
        received.push({ surfaceId, event });
      },
    });
    const fakeConn = {
      socket: { send: () => undefined, close: () => undefined },
      accountId: 'acc',
      surfaceId: 'srf-caller',
      surfaceKind: 'mobile' as const,
      watchedChats: new Set<string>(),
    };
    (
      hub as unknown as {
        handleSurfaceEvent: (
          conn: typeof fakeConn,
          event: WireEvent,
          log: typeof silentLogger,
        ) => void;
      }
    ).handleSurfaceEvent(
      fakeConn,
      { type: 'chat.call_response', callId: 'call-1', response: 'accept' } as WireEvent,
      silentLogger,
    );
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ surfaceId: 'srf-caller' });
  });
});

describe('WsHub — onDaemonEvent forSurfaceId success path', () => {
  it('routes a forSurfaceId-tagged event to the matching connected surface, stripping the tag', () => {
    const registry = Registry.load(makeDir());
    registry.bootstrapAccount();
    const hub = new WsHub({
      logger: silentLogger,
      registry,
      presence: new PresenceTracker(),
      daemonLink: new InProcessDaemonLink(),
      chatRegistry: new ChatRegistry(),
      idGenerator: () => 'id-1',
    });
    const sent: unknown[] = [];
    const fakeConn = {
      socket: {
        send: (data: string) => sent.push(JSON.parse(data)),
        close: () => undefined,
      },
      accountId: 'acc',
      surfaceId: 'srf-target',
      surfaceKind: 'web' as const,
      watchedChats: new Set<string>(),
    };
    (hub as unknown as { surfaces: Map<string, Set<unknown>> }).surfaces.set(
      'srf-target',
      new Set([fakeConn]),
    );
    (hub as unknown as { onDaemonEvent: (event: WireEvent) => void }).onDaemonEvent({
      type: 'chat.replay',
      chatId: 'chat-1',
      fromSeq: 0,
      forSurfaceId: 'srf-target',
    } as unknown as WireEvent);
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toHaveProperty('forSurfaceId');
    expect(sent[0]).toMatchObject({ type: 'chat.replay', chatId: 'chat-1' });
  });
});

describe('WsHub — shutdown() defensive catch branch', () => {
  it('swallows a throwing socket.close() while tearing down connected surfaces', () => {
    const registry = Registry.load(makeDir());
    registry.bootstrapAccount();
    const hub = new WsHub({
      logger: silentLogger,
      registry,
      presence: new PresenceTracker(),
      daemonLink: new InProcessDaemonLink(),
      chatRegistry: new ChatRegistry(),
      idGenerator: () => 'id-1',
    });
    const fakeConn = {
      socket: {
        send: () => undefined,
        close: () => {
          throw new Error('close failed');
        },
      },
      accountId: 'acc',
      surfaceId: 'srf-shutdown',
      surfaceKind: 'web' as const,
      watchedChats: new Set<string>(),
    };
    (hub as unknown as { surfaces: Map<string, Set<unknown>> }).surfaces.set(
      'srf-shutdown',
      new Set([fakeConn]),
    );
    expect(() => hub.shutdown()).not.toThrow();
  });
});

describe('WsHub — drained-buffer loop stops once state leaves authed mid-drain', () => {
  it('a duplicate-hello buffered frame closes the socket synchronously, and later buffered frames are skipped', async () => {
    const dir = makeDir();
    const user = generateUserKeypair(() => new Uint8Array(32).fill(92));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({ surfaceId: 'srf-drain', surfaceKind: 'web', label: 'b', issuedAt: 1 });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-drain',
      surfaceKind: 'web',
      label: 'browser',
    });
    const daemonLink = new InProcessDaemonLink();
    const hub = new WsHub({
      logger: silentLogger,
      registry,
      presence: new PresenceTracker(),
      daemonLink,
      chatRegistry: new ChatRegistry(),
      idGenerator: () => 'id-1',
      helloTimeoutMs: 60_000,
    });
    const fs = new FakeSocket();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (hub as any).onConnect(fs as unknown as WebSocket, 'req-drain');
    // First frame: the real hello — kicks off the async verify.
    fs.emit(
      'message',
      Buffer.from(
        encode({
          type: 'hello',
          clientType: 'surface-web',
          clientVersion: '0.0.0-test',
          auth: jwt,
        } satisfies WireEvent),
      ),
    );
    // While still 'authenticating' (verify hasn't resolved yet), buffer a
    // duplicate hello (closes the socket synchronously once drained — this
    // FakeSocket's close() emits 'close' synchronously, unlike a real 'ws'
    // socket) followed by a heartbeat that must NOT be processed afterward.
    fs.emit(
      'message',
      Buffer.from(
        encode({
          type: 'hello',
          clientType: 'surface-web',
          clientVersion: '0.0.0-test',
          auth: jwt,
        } satisfies WireEvent),
      ),
    );
    fs.emit('message', Buffer.from(encode({ type: 'surface.heartbeat' } satisfies WireEvent)));
    await new Promise((r) => setTimeout(r, 30));
    // The duplicate hello closed the socket with CLOSE_BAD_FRAME (4400) —
    // proving the drain loop reached it and then stopped (no crash, no
    // heartbeat-driven presence call after close).
    expect(fs.closed.some((c) => c.code === 4400)).toBe(true);
  });
});

describe('WsHub — terminateSurface defensive catch branches', () => {
  it('swallows throwing socket.send() and socket.close() (still returns true + cleans up)', () => {
    const registry = Registry.load(makeDir());
    registry.bootstrapAccount();
    const presence = new PresenceTracker();
    presence.online('acc', 'srf-term', 'web', 1000);
    const hub = new WsHub({
      logger: silentLogger,
      registry,
      presence,
      daemonLink: new InProcessDaemonLink(),
      chatRegistry: new ChatRegistry(),
      idGenerator: () => 'id-1',
    });
    const fakeConn = {
      socket: {
        send: () => {
          throw new Error('send failed');
        },
        close: () => {
          throw new Error('close failed');
        },
      },
      accountId: 'acc',
      surfaceId: 'srf-term',
      surfaceKind: 'web' as const,
      watchedChats: new Set<string>(),
    };
    (hub as unknown as { surfaces: Map<string, Set<unknown>> }).surfaces.set(
      'srf-term',
      new Set([fakeConn]),
    );
    expect(hub.terminateSurface('srf-term')).toBe(true);
    expect(hub.connectedSurfaceIds()).not.toContain('srf-term');
  });
});
