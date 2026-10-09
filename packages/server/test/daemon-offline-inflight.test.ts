// Regression: an in-flight chat must NOT be left spinning forever when the
// host↔server link drops (host restart, network blip, deploy churn).
//
// The bug: chat activity is driven entirely by events relayed from the host.
// If the link drops while a chat is `running`, the host never emits the
// turn-completion / activity event, so the chat stays `running` FOREVER — a
// silent failure (the spinner sits there doing nothing).
//
// The fix: on `daemon.offline`, the server resolves every in-flight chat to a
// visible `errored` state for subscribed surfaces (chat.error toast + a
// chat.state that flips the spinner off), mirroring the host's own SDK-error
// pair. NO FALLBACK — the failure is made LOUD.
//
// This exercises the REAL socket-close path (mirrors b1-real-ws.test.ts): a
// genuine host `ws` socket authenticates, drives a chat to `running`, then
// its socket is dropped — which is exactly the production failure.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { generateUserKeypair, mintSurfaceCredential, mintDaemonKey } from '@patch/auth';
import {
  decode,
  encode,
  type WireEvent,
  type ChatStateEvent,
  type ChatErrorEvent,
} from '@patch/wire';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { PresenceTracker } from '../src/presence.js';

/** Persistent frame recorder + awaiter (same shape as b1-real-ws.test.ts). */
class FrameLog {
  readonly frames: WireEvent[] = [];
  constructor(ws: WebSocket) {
    ws.on('message', (raw: WebSocket.RawData) => {
      try {
        this.frames.push(decode(Array.isArray(raw) ? Buffer.concat(raw) : (raw as Buffer)));
      } catch {
        // ignore non-wire frames
      }
    });
  }
  count(type: WireEvent['type']): number {
    return this.frames.filter((f) => f.type === type).length;
  }
  async waitForCount(type: WireEvent['type'], n: number, timeoutMs = 3000): Promise<void> {
    const start = Date.now();
    while (this.count(type) < n) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`timeout waiting for ${n}× ${type} (saw ${this.count(type)})`);
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  find<T extends WireEvent['type']>(
    type: T,
    pred: (f: Extract<WireEvent, { type: T }>) => boolean,
  ): Extract<WireEvent, { type: T }> | undefined {
    return this.frames.filter((f) => f.type === type).find(pred as never) as never;
  }
}

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
}

describe('host offline resolves in-flight chats to errored', () => {
  let dataDir: string;
  let user: { publicKey: string; privateKey: string };
  let close: () => Promise<void>;
  let url: string;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'patch-offline-'));
    user = generateUserKeypair();

    const registry = Registry.load(dataDir);
    registry.bootstrapAccount({ keypair: user });
    registry.setDaemonKey({
      daemonId: 'daemon-1',
      publicKey: user.publicKey,
      issuedAt: Math.floor(Date.now() / 1000),
    });
    // A second registered machine — spec/12 § Hosts fail independently: one
    // host going down must not resolve another host's turns.
    registry.setDaemonKey({
      daemonId: 'daemon-2',
      publicKey: user.publicKey,
      issuedAt: Math.floor(Date.now() / 1000),
    });
    registry.upsertSurface({
      surfaceId: 'srf-1',
      surfaceKind: 'web',
      label: 'browser',
      issuedAt: Math.floor(Date.now() / 1000),
    });

    const { app } = await buildAll({ registry, presence: new PresenceTracker(), logger: false });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address() as AddressInfo;
    url = `ws://127.0.0.1:${addr.port}`;
    close = async () => {
      await app.close();
    };
  });

  afterEach(async () => {
    await close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('a chat left running when the host socket drops becomes errored on the surface', async () => {
    // 1. Surface connects.
    const surfaceJwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-1',
      surfaceKind: 'web',
      label: 'browser',
    });
    const surface = new WebSocket(`${url}/ws`);
    const surfaceLog = new FrameLog(surface);
    await waitOpen(surface);
    surface.send(
      encode({ type: 'hello', clientType: 'surface-web', clientVersion: '1', auth: surfaceJwt }),
    );
    await surfaceLog.waitForCount('auth.ok', 1);

    // 2. Host connects with a genuine EdDSA-JWT.
    const daemonKey = await mintDaemonKey({
      userPrivateKey: user.privateKey,
      daemonId: 'daemon-1',
      label: 'hetzner',
    });
    const daemon = new WebSocket(`${url}/ws`);
    await waitOpen(daemon);
    daemon.send(
      encode({ type: 'hello', clientType: 'daemon', clientVersion: '1', auth: daemonKey }),
    );
    await surfaceLog.waitForCount('daemon.online', 1);

    // 3. Drive a chat to `running`: the host emits chat.spawned then a
    //    chat.state with activity 'running' — exactly what a live turn looks
    //    like. Both fan out to the surface (state-level events).
    //    `chat.spawned.daemonId` is the host the chat is pinned to (spec/03 §
    //    Session events), and a real host declares its OWN registered id —
    //    verified on the live rig: host-b's host emits
    //    `{"type":"chat.spawned","chatId":"01KZ8YW0199M33AW8WVQ63X59Z","daemonId":"host-b"}`.
    //    So it must match the id this socket authenticated as, or the chat is
    //    filed against a host that does not exist.
    const chatId = 'chat-inflight-1';
    daemon.send(
      encode({ type: 'chat.spawned', daemonId: 'daemon-1', chatId, folder: '/tmp/proj' }),
    );
    daemon.send(
      encode({
        type: 'chat.state',
        permissionMode: 'bypassPermissions',
        chatId,
        activity: 'running',
        lastUpdated: Date.now(),
      }),
    );
    await surfaceLog.waitForCount('chat.state', 1);
    const running = surfaceLog.find('chat.state', (f) => f.chatId === chatId);
    expect(running?.activity).toBe('running');

    // 4. DROP the host socket — the production failure (host restart etc.).
    daemon.close();

    // 5. The surface must receive a resolution for the stuck chat: a chat.error
    //    toast + a chat.state flipping activity to 'errored'. Without the fix
    //    only `daemon.offline` fans out and this times out (chat stays running).
    await surfaceLog.waitForCount('daemon.offline', 1);
    await surfaceLog.waitForCount('chat.error', 1);
    await surfaceLog.waitForCount('chat.state', 2);

    const errEvent = surfaceLog.find('chat.error', (f) => f.chatId === chatId) as
      | ChatErrorEvent
      | undefined;
    expect(errEvent).toBeDefined();
    expect(errEvent?.error.code).toBe('daemon_unavailable');
    // spec/04 § Activity: the copy is exact, and it must not tell the user to
    // resend — the host re-sends an interrupted turn itself on restart, and a
    // turn that outlived the blip carries on. Asking for a manual resend would
    // be describing behaviour the system does not have.
    expect(errEvent?.error.message).toBe('Connection to the host was lost. Message will resend.');
    expect(errEvent?.error.message).not.toMatch(/resend your message/i);

    const erroredState = surfaceLog.find(
      'chat.state',
      (f) => f.chatId === chatId && f.activity === 'errored',
    ) as ChatStateEvent | undefined;
    expect(erroredState).toBeDefined();
    expect(erroredState?.activity).toBe('errored');
    expect(erroredState?.lastError?.code).toBe('daemon_unavailable');

    // The chat is NOT left silently running.
    expect(erroredState?.activity).not.toBe('running');

    surface.close();
  });

  it('resolves ONLY the dropped host’s turns — another host keeps running', async () => {
    // spec/12 § Hosts fail independently: "Chats on reachable hosts stay usable
    // while another host is down." Resolving every in-flight chat on any drop
    // would kill live turns on machines that never went away.
    const surfaceJwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-1',
      surfaceKind: 'web',
      label: 'browser',
    });
    const surface = new WebSocket(`${url}/ws`);
    const surfaceLog = new FrameLog(surface);
    await waitOpen(surface);
    surface.send(
      encode({ type: 'hello', clientType: 'surface-web', clientVersion: '1', auth: surfaceJwt }),
    );
    await surfaceLog.waitForCount('auth.ok', 1);

    async function connectDaemon(daemonId: string): Promise<WebSocket> {
      const key = await mintDaemonKey({
        userPrivateKey: user.privateKey,
        daemonId,
        label: daemonId,
      });
      const ws = new WebSocket(`${url}/ws`);
      await waitOpen(ws);
      ws.send(encode({ type: 'hello', clientType: 'daemon', clientVersion: '1', auth: key }));
      return ws;
    }

    const d1 = await connectDaemon('daemon-1');
    const d2 = await connectDaemon('daemon-2');
    await surfaceLog.waitForCount('daemon.online', 2);

    // A chat mid-turn on EACH machine.
    for (const [ws, daemonId, chatId] of [
      [d1, 'daemon-1', 'chat-on-1'],
      [d2, 'daemon-2', 'chat-on-2'],
    ] as const) {
      ws.send(encode({ type: 'chat.spawned', daemonId, chatId, folder: '/tmp/proj' }));
      ws.send(
        encode({
          type: 'chat.state',
          permissionMode: 'bypassPermissions',
          chatId,
          activity: 'running',
          lastUpdated: Date.now(),
        }),
      );
    }
    await surfaceLog.waitForCount('chat.state', 2);

    // Only machine 1 goes away.
    d1.close();
    await surfaceLog.waitForCount('chat.error', 1);

    const errored = surfaceLog.find('chat.error', (f) => f.chatId === 'chat-on-1') as
      | ChatErrorEvent
      | undefined;
    expect(errored?.error.code).toBe('daemon_unavailable');

    // Give the hub a beat to prove it does NOT also error the other machine.
    await new Promise((r) => setTimeout(r, 150));
    expect(surfaceLog.find('chat.error', (f) => f.chatId === 'chat-on-2')).toBeUndefined();
    expect(
      surfaceLog.find('chat.state', (f) => f.chatId === 'chat-on-2' && f.activity === 'errored'),
    ).toBeUndefined();

    d2.close();
    surface.close();
  });

  it('the same surface is told the chat recovered — a non-errored chat.state after the blip', async () => {
    // spec/04 § Activity — `daemon_unavailable` is a passing condition of the
    // LINK, not the outcome of a turn, and the card says so ("Message will
    // resend."). The host keeps that promise: it re-sends the interrupted
    // turn on hydrate and the chat goes back to `running`. This asserts the
    // RESOLUTION SIGNAL the surfaces clear the notice on actually reaches them
    // over the same socket, for the same chatId, after the errored pair — the
    // whole client-side fix rests on it, and it is invisible from the store's
    // own unit tests.
    const surfaceJwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-1',
      surfaceKind: 'web',
      label: 'browser',
    });
    const surface = new WebSocket(`${url}/ws`);
    const surfaceLog = new FrameLog(surface);
    await waitOpen(surface);
    surface.send(
      encode({ type: 'hello', clientType: 'surface-web', clientVersion: '1', auth: surfaceJwt }),
    );
    await surfaceLog.waitForCount('auth.ok', 1);

    async function connectDaemon(): Promise<WebSocket> {
      const key = await mintDaemonKey({
        userPrivateKey: user.privateKey,
        daemonId: 'daemon-1',
        label: 'daemon-1',
      });
      const ws = new WebSocket(`${url}/ws`);
      await waitOpen(ws);
      ws.send(encode({ type: 'hello', clientType: 'daemon', clientVersion: '1', auth: key }));
      return ws;
    }

    const chatId = 'chat-recovers';
    const d1 = await connectDaemon();
    await surfaceLog.waitForCount('daemon.online', 1);
    d1.send(encode({ type: 'chat.spawned', daemonId: 'daemon-1', chatId, folder: '/tmp/proj' }));
    d1.send(
      encode({
        type: 'chat.state',
        permissionMode: 'bypassPermissions',
        chatId,
        activity: 'running',
        lastUpdated: Date.now(),
      }),
    );
    await surfaceLog.waitForCount('chat.state', 1);

    // The blip.
    d1.close();
    await surfaceLog.waitForCount('chat.error', 1);
    await surfaceLog.waitForCount('chat.state', 2);
    expect(
      surfaceLog.find('chat.state', (f) => f.chatId === chatId && f.activity === 'errored'),
    ).toBeDefined();

    // The host comes back and re-sends the interrupted turn
    // (`resumeInterruptedTurns`), which drives the chat to `running` again.
    const d1b = await connectDaemon();
    await surfaceLog.waitForCount('daemon.online', 2);
    d1b.send(
      encode({
        type: 'chat.state',
        permissionMode: 'bypassPermissions',
        chatId,
        activity: 'running',
        lastUpdated: Date.now(),
      }),
    );
    await surfaceLog.waitForCount('chat.state', 3);

    // The recovery frame is the LAST chat.state for this chat, and it is not
    // `errored` — which is exactly the condition a surface clears the transient
    // notice on.
    const forChat = surfaceLog.frames.filter(
      (f): f is ChatStateEvent => f.type === 'chat.state' && f.chatId === chatId,
    );
    expect(forChat.map((f) => f.activity)).toEqual(['running', 'errored', 'running']);
    expect(forChat.at(-1)?.activity).not.toBe('errored');

    // And the server's own mirror agrees, so a surface cold-starting off REST
    // after the blip never sees the resolved failure either.
    const restRes = await fetch(`${url.replace('ws://', 'http://')}/api/chats`, {
      headers: { authorization: `Bearer ${surfaceJwt}` },
    });
    expect(restRes.status).toBe(200);
    const body = (await restRes.json()) as { chats: { chatId: string; activity: string }[] };
    expect(body.chats.find((c) => c.chatId === chatId)?.activity).toBe('running');

    d1b.close();
    surface.close();
  });

  it('a fast reconnect (same daemonId, new socket) resolves a running chat WITHOUT the old socket ever closing', async () => {
    // The specific gap this closes: when a host process crashes and a NEW
    // process for the SAME daemonId reconnects before the old TCP socket's
    // own `close` event ever fires (exactly what pid 900214 -> 3674589 in
    // the daemon.log looked like), the resolution must come from the
    // re-attach itself — not from a natural socket-close event, which this
    // test never gives the chance to fire (the first host socket is
    // simply abandoned, never `.close()`d from either end).
    const surfaceJwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-1',
      surfaceKind: 'web',
      label: 'browser',
    });
    const surface = new WebSocket(`${url}/ws`);
    const surfaceLog = new FrameLog(surface);
    await waitOpen(surface);
    surface.send(
      encode({ type: 'hello', clientType: 'surface-web', clientVersion: '1', auth: surfaceJwt }),
    );
    await surfaceLog.waitForCount('auth.ok', 1);

    async function connectDaemon(): Promise<WebSocket> {
      const key = await mintDaemonKey({
        userPrivateKey: user.privateKey,
        daemonId: 'daemon-1',
        label: 'daemon-1',
      });
      const ws = new WebSocket(`${url}/ws`);
      await waitOpen(ws);
      ws.send(encode({ type: 'hello', clientType: 'daemon', clientVersion: '1', auth: key }));
      return ws;
    }

    const chatId = 'chat-fast-reconnect';
    const d1 = await connectDaemon();
    await surfaceLog.waitForCount('daemon.online', 1);
    d1.send(encode({ type: 'chat.spawned', daemonId: 'daemon-1', chatId, folder: '/tmp/proj' }));
    d1.send(
      encode({
        type: 'chat.state',
        permissionMode: 'bypassPermissions',
        chatId,
        activity: 'running',
        lastUpdated: Date.now(),
      }),
    );
    await surfaceLog.waitForCount('chat.state', 1);
    const running = surfaceLog.find('chat.state', (f) => f.chatId === chatId);
    expect(running?.activity).toBe('running');

    // The crash + fast reconnect: a NEW socket authenticates as the SAME
    // daemonId. `d1` is never closed by either side.
    const d1b = await connectDaemon();

    // The reattach itself must resolve the stuck chat — a chat.error toast
    // plus a chat.state flipping activity to 'errored' — with no natural
    // close event on `d1` involved.
    await surfaceLog.waitForCount('chat.error', 1);
    await surfaceLog.waitForCount('chat.state', 2);

    const errEvent = surfaceLog.find('chat.error', (f) => f.chatId === chatId) as
      | ChatErrorEvent
      | undefined;
    expect(errEvent).toBeDefined();
    expect(errEvent?.error.code).toBe('daemon_unavailable');

    const erroredState = surfaceLog.find(
      'chat.state',
      (f) => f.chatId === chatId && f.activity === 'errored',
    ) as ChatStateEvent | undefined;
    expect(erroredState).toBeDefined();

    // The new process's own presence is genuinely reported online too — the
    // reattach must also complete a real offline->online cycle, not just an
    // offline half.
    await surfaceLog.waitForCount('daemon.online', 2);

    d1b.close();
    surface.close();
  });
});
