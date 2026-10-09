// Regression: ONE surface, MORE THAN ONE socket (spec/12 § Guaranteed input
// delivery).
//
// The desktop app opens extra windows (`/app/sidebar-window`, the tray
// popover) that auth with the SAME surface credential. The hub used to hold
// `surfaceId → conn`, last-writer-wins: the second window evicted the first
// from the routing table, and when the second window CLOSED its handler
// deleted the entry outright — leaving the first window's socket open but
// unaddressable. Its uplink still worked (inputs kept arriving) and the
// heartbeat still pong'd on the socket itself, so neither side noticed, while
// every addressed downstream event — `chat.input_ack` included — was dropped.
// A chat sat on "Sending…" forever. Seen in production 2026-08-15.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import { WireTestClient } from '@patch/wire/test-client';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';

const SURFACE = 'srf-desktop-multiwindow';

async function start(registry: Registry) {
  const daemonLink = new InProcessDaemonLink();
  const built = await buildAll({ logger: false, registry, daemonLink });
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = built.app.server.address() as AddressInfo;
  return { url: `ws://127.0.0.1:${addr.port}/ws`, daemonLink, built };
}

describe('WS hub — two windows of the same surface', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-wshub-multiwindow-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps routing to the first window after a second window connects and closes', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(91));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({
      surfaceId: SURFACE,
      surfaceKind: 'desktop',
      label: 'desktop',
      issuedAt: 1,
    });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: SURFACE,
      surfaceKind: 'desktop',
      label: 'desktop',
    });
    const h = await start(registry);
    const hub = h.built.wsHub;
    try {
      // Main window.
      const main = new WireTestClient({ url: h.url, auth: jwt });
      await main.connect();
      await main.waitFor('daemon.online');

      // Sidebar window — same credential, same surfaceId.
      const sidebar = new WireTestClient({ url: h.url, auth: jwt });
      await sidebar.connect();
      await sidebar.waitFor('daemon.online');

      // Both windows are addressable; the surface is listed exactly once.
      expect(hub.connectedSurfaceIds()).toEqual([SURFACE]);
      expect(hub.listConnectedSurfaces()).toHaveLength(1);

      // Sidebar closes. The main window must survive it.
      await sidebar.close();
      await new Promise((r) => setTimeout(r, 50));
      expect(hub.connectedSurfaceIds()).toEqual([SURFACE]);

      // The ack the composer is waiting on is addressed with `forSurfaceId`.
      h.daemonLink.emit({
        type: 'chat.input_ack',
        chatId: 'chat-1',
        localId: 'L1',
        forSurfaceId: SURFACE,
      } as never);
      const ack = await main.waitFor('chat.input_ack');
      expect(ack).toMatchObject({ chatId: 'chat-1', localId: 'L1' });
      // The routing tag is stripped on the way out.
      expect((ack as { forSurfaceId?: string }).forSurfaceId).toBeUndefined();
      expect(hub.sendToSurface(SURFACE, { type: 'surface.heartbeat_ack' })).toBe(true);

      await main.close();
      await new Promise((r) => setTimeout(r, 50));
      // Last window gone → surface really is offline now.
      expect(hub.connectedSurfaceIds()).toEqual([]);
      expect(hub.sendToSurface(SURFACE, { type: 'surface.heartbeat_ack' })).toBe(false);
    } finally {
      await h.built.app.close();
    }
  });

  it('delivers an addressed event to EVERY open window of the surface', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(92));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({
      surfaceId: SURFACE,
      surfaceKind: 'desktop',
      label: 'desktop',
      issuedAt: 1,
    });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: SURFACE,
      surfaceKind: 'desktop',
      label: 'desktop',
    });
    const h = await start(registry);
    try {
      const main = new WireTestClient({ url: h.url, auth: jwt });
      await main.connect();
      await main.waitFor('daemon.online');
      const sidebar = new WireTestClient({ url: h.url, auth: jwt });
      await sidebar.connect();
      await sidebar.waitFor('daemon.online');

      // Both waiters are armed BEFORE the emit: a frame that arrives while only
      // one of them is subscribed is dropped by the client, which would fail
      // this test for a reason that has nothing to do with the hub.
      const onMain = main.waitFor('chat.input_ack');
      const onSidebar = sidebar.waitFor('chat.input_ack');
      h.daemonLink.emit({
        type: 'chat.input_ack',
        chatId: 'chat-2',
        localId: 'L2',
        forSurfaceId: SURFACE,
      } as never);

      expect(await onMain).toMatchObject({ localId: 'L2' });
      expect(await onSidebar).toMatchObject({ localId: 'L2' });

      await main.close();
      await sidebar.close();
    } finally {
      await h.built.app.close();
    }
  });
});
