// The server-run queue through the real hub: a surface sends while a turn is
// running, the server holds the message, and releases it when the chat idles.

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

const wait = (ms = 50): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('server-run queue through the hub', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-sqhub-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function start(hostTakesQueue = true) {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(31));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    const daemonLink = new InProcessDaemonLink();
    const built = await buildAll({
      logger: false,
      registry,
      daemonLink,
    });
    await built.app.listen({ port: 0, host: '127.0.0.1' });
    const url = `ws://127.0.0.1:${(built.app.server.address() as AddressInfo).port}/ws`;
    registry.upsertSurface({ surfaceId: 'srf-1', surfaceKind: 'web', label: 'b', issuedAt: 1 });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-1',
      surfaceKind: 'web',
      label: 'b',
    });
    const client = new WireTestClient({ url, auth: jwt });
    await client.connect();
    await client.waitFor('daemon.online');

    // The host: announces itself as able to take queued messages, and a chat.
    daemonLink.emit({
      type: 'daemon.host',
      daemonId: 'd1',
      hostName: 'host',
      platform: 'linux',
      arch: 'x64',
      daemonVersion: '1.0.0',
      updateAvailable: false,
      permissionModeDefault: 'auto',
      permissionOverrides: 0,
      isHomeHost: true,
      ...(hostTakesQueue ? { serverQueue: true } : {}),
      backends: [],
      components: [],
    } as never);
    daemonLink.emit({ type: 'chat.spawned', chatId: 'c1', daemonId: 'd1', folder: '/w' });
    const state = (activity: string) =>
      daemonLink.emit({
        type: 'chat.state',
        chatId: 'c1',
        daemonId: 'd1',
        activity,
        permissionMode: 'auto',
        folder: '/w',
        lastUpdated: 1,
      } as never);
    return { built, daemonLink, client, state };
  }

  it('holds a message sent behind a running turn and releases it when the chat idles', async () => {
    const t = await start();
    try {
      t.state('running');
      const got: string[] = [];
      t.client.on('chat.input_ack', (e) => got.push(`ack:${e.localId}`));
      t.client.on('chat.queued', (e) => got.push(`queued:${e.localId}`));
      t.client.on('chat.dequeued', (e) => got.push(`dequeued:${e.localId}:${e.reason}`));
      const activities: string[] = [];
      t.client.on('chat.state', (e) => activities.push(String(e.activity)));

      t.client.sendInput({ chatId: 'c1', message: 'while you work', localId: 'L1' });
      await wait();
      expect(got).toEqual(['ack:L1', 'queued:L1']);
      expect(t.daemonLink.sent.filter((s) => s.event.type === 'chat.input')).toEqual([]);

      t.state('idle'); // the turn ends
      await wait();
      expect(got).toEqual(['ack:L1', 'queued:L1', 'dequeued:L1:running']);
      expect(t.daemonLink.sent.filter((s) => s.event.type === 'chat.input')).toHaveLength(1);
      // The chat never looked finished to the surface while it still had a message to run.
      expect(activities).not.toContain('idle');
    } finally {
      await t.client.close();
      await t.built.app.close();
    }
  });

  it('hands the waiting messages to the host when it asks at a tool boundary', async () => {
    const t = await start();
    try {
      t.state('running');
      t.client.sendInput({ chatId: 'c1', message: 'one', localId: 'L1' });
      t.client.sendInput({ chatId: 'c1', message: 'two', localId: 'L2' });
      await wait();

      t.daemonLink.emit({ type: 'patch.queue_pull.request', requestId: 'r1', chatId: 'c1' });
      await wait();
      const reply = t.daemonLink.sent.find((s) => s.event.type === 'patch.queue_pull.response')!;
      expect(reply.daemonId).toBe('d1');
      expect(
        (reply.event as { items: Array<{ localId: string }>; requestId: string }).items.map(
          (i) => i.localId,
        ),
      ).toEqual(['L1', 'L2']);

      // Taken once: the chat idling afterwards has nothing left to release.
      t.state('idle');
      await wait();
      expect(t.daemonLink.sent.filter((s) => s.event.type === 'chat.input')).toEqual([]);
    } finally {
      await t.client.close();
      await t.built.app.close();
    }
  });

  it('cancels a message it holds without involving the host', async () => {
    const t = await start();
    try {
      t.state('running');
      t.client.sendInput({ chatId: 'c1', message: 'one', localId: 'L1' });
      await wait();
      const dequeued: string[] = [];
      t.client.on('chat.dequeued', (e) => dequeued.push(`${e.localId}:${e.reason}`));
      t.client.send({ type: 'chat.unqueue_request', chatId: 'c1', localId: 'L1' });
      await wait();
      expect(dequeued).toEqual(['L1:cancelled']);
      expect(t.daemonLink.sent.filter((s) => s.event.type === 'chat.unqueue_request')).toEqual([]);
    } finally {
      await t.client.close();
      await t.built.app.close();
    }
  });

  it('tells a host, as it attaches, that the server is running its queue', async () => {
    const t = await start();
    try {
      t.daemonLink.addOnlineHost('d2');
      await wait();
      const modes = t.daemonLink.sent.filter((s) => s.event.type === 'server.queue_mode');
      expect(modes.map((m) => m.daemonId)).toContain('d2');
      expect((modes[0]!.event as { enabled: boolean }).enabled).toBe(true);
    } finally {
      await t.client.close();
      await t.built.app.close();
    }
  });

  it('leaves everything to the host when the host does not report that it takes queued messages', async () => {
    const t = await start(false);
    try {
      t.state('running');
      t.client.sendInput({ chatId: 'c1', message: 'one', localId: 'L1' });
      await wait();
      expect(t.daemonLink.sent.filter((s) => s.event.type === 'chat.input')).toHaveLength(1);
    } finally {
      await t.client.close();
      await t.built.app.close();
    }
  });

  it('edits a message it holds in place, and tells the surface', async () => {
    const t = await start();
    try {
      t.state('running');
      t.client.sendInput({ chatId: 'c1', message: 'one', localId: 'L1' });
      await wait();
      const queued: string[] = [];
      t.client.on('chat.queued', (e) => queued.push(`${e.localId}:${e.message}:${e.queueSeq}`));
      t.client.send({
        type: 'chat.edit_queued_request',
        chatId: 'c1',
        localId: 'L1',
        message: 'one, changed',
      });
      await wait();
      expect(queued).toEqual(['L1:one, changed:1']);
      expect(t.daemonLink.sent.filter((s) => s.event.type === 'chat.edit_queued_request')).toEqual(
        [],
      );
    } finally {
      await t.client.close();
      await t.built.app.close();
    }
  });

  it('send now stops the running turn through the host and leaves the queue as it is', async () => {
    const t = await start();
    try {
      t.state('running');
      t.client.sendInput({ chatId: 'c1', message: 'one', localId: 'L1' });
      t.client.sendInput({ chatId: 'c1', message: 'two', localId: 'L2' });
      await wait();
      t.client.send({ type: 'chat.promote_request', chatId: 'c1', localId: 'L2' });
      await wait();
      const stops = t.daemonLink.sent.filter((s) => s.event.type === 'chat.stop_request');
      expect(stops).toHaveLength(1);
      expect(t.daemonLink.sent.filter((s) => s.event.type === 'chat.promote_request')).toEqual([]);

      // The turn ends; the queue drains in order, so L1 still goes first.
      t.state('idle');
      await wait();
      const released = t.daemonLink.sent.filter((s) => s.event.type === 'chat.input');
      expect(released.map((s) => (s.event as { localId: string }).localId)).toEqual(['L1']);
    } finally {
      await t.client.close();
      await t.built.app.close();
    }
  });

  it('hands a control for a message the host holds on to the host', async () => {
    const t = await start();
    try {
      t.state('running');
      t.client.send({ type: 'chat.unqueue_request', chatId: 'c1', localId: 'host-held' });
      t.client.send({
        type: 'chat.edit_queued_request',
        chatId: 'c1',
        localId: 'host-held',
        message: 'x',
      });
      t.client.send({ type: 'chat.promote_request', chatId: 'c1', localId: 'host-held' });
      await wait();
      const types = t.daemonLink.sent.map((s) => s.event.type);
      expect(types).toContain('chat.unqueue_request');
      expect(types).toContain('chat.edit_queued_request');
      expect(types).toContain('chat.promote_request');
    } finally {
      await t.client.close();
      await t.built.app.close();
    }
  });
});
