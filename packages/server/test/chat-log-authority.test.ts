// The server is the log of record for a chat's transcript (spec/01 § Message
// log): a finished event is committed before it is broadcast, a resend is not
// broadcast twice, a contradiction is refused, and the host is told how far the
// server's log reaches.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import { WireTestClient } from '@patch/wire/test-client';
import type { WireEvent } from '@patch/wire';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';

const wait = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('the server as the log of record', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-authority-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function start() {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(51));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    const link = new InProcessDaemonLink();
    const built = await buildAll({
      logger: false,
      registry,
      daemonLink: link,
      logSyncDelayMs: 30,
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
    link.emit({ type: 'chat.spawned', chatId: 'c1', daemonId: 'd1', folder: '/w' });
    // Watching the chat is what makes a surface receive its transcript events live.
    client.replay('c1', -1);
    await wait(30);
    const say = (seq: number, content = `m${seq}`): WireEvent =>
      ({ type: 'chat.message', chatId: 'c1', role: 'assistant', content, seq }) as WireEvent;
    const state = (lastSeq: number): WireEvent =>
      ({
        type: 'chat.state',
        chatId: 'c1',
        daemonId: 'd1',
        activity: 'idle',
        permissionMode: 'auto',
        folder: '/w',
        lastUpdated: 1,
        lastSeq,
      }) as WireEvent;
    return { built, link, client, say, state };
  }

  it('commits an event before the surface sees it', async () => {
    const t = await start();
    try {
      const heldWhenSeen: boolean[] = [];
      t.client.on('chat.message', (e) =>
        heldWhenSeen.push(
          t.built.chatLogStore
            .read('c1', e.seq - 1)
            .some((h) => (h as { seq: number }).seq === e.seq),
        ),
      );
      t.link.emit(t.say(1));
      t.link.emit(t.say(2));
      await wait();
      expect(heldWhenSeen).toEqual([true, true]);
    } finally {
      await t.client.close();
      await t.built.app.close();
    }
  });

  it('does not broadcast a resend of an event it already holds, and still broadcasts an update', async () => {
    const t = await start();
    try {
      const seen: string[] = [];
      t.client.on('chat.message', (e) => seen.push(`${e.seq}:${e.content}`));
      t.link.emit(t.say(1));
      t.link.emit(t.say(1)); // the host resends after a dropped link
      t.link.emit(t.say(1, 'filled in later'));
      await wait();
      expect(seen).toEqual(['1:m1', '1:filled in later']);
    } finally {
      await t.client.close();
      await t.built.app.close();
    }
  });

  it('refuses an event that contradicts the log, and says so', async () => {
    const t = await start();
    try {
      const seen: number[] = [];
      t.client.on('chat.tool_call', (e) => seen.push(e.seq));
      t.link.emit(t.say(1));
      t.link.emit({
        type: 'chat.tool_call',
        chatId: 'c1',
        seq: 1,
        tool: 'Bash',
        args: {},
        callId: 'k',
      } as WireEvent);
      await wait();
      expect(seen).toEqual([]);
      expect(t.built.chatLogStore.read('c1', -1)).toHaveLength(1);
    } finally {
      await t.client.close();
      await t.built.app.close();
    }
  });

  it('still routes a replay to the surface that asked, and keeps it', async () => {
    const t = await start();
    try {
      const got: number[] = [];
      t.client.on('chat.message', (e) => got.push(e.seq));
      t.link.emit({ ...t.say(7), forSurfaceId: 'srf-1' } as WireEvent);
      await wait();
      expect(got).toEqual([7]);
      expect(t.built.chatLogStore.highWater('c1')).toBe(7);
    } finally {
      await t.client.close();
      await t.built.app.close();
    }
  });

  it('tells the host how far the log reaches, once for a burst', async () => {
    const t = await start();
    try {
      for (let seq = 1; seq <= 5; seq++) t.link.emit(t.say(seq));
      await wait(250);
      const acks = t.link.sent.filter((s) => s.event.type === 'chat.committed');
      expect(acks).toHaveLength(1);
      expect(acks[0]!.daemonId).toBe('d1');
      expect(acks[0]!.event).toEqual({ type: 'chat.committed', chatId: 'c1', through: 5 });
    } finally {
      await t.client.close();
      await t.built.app.close();
    }
  });

  it('does not acknowledge a resend', async () => {
    const t = await start();
    try {
      t.link.emit(t.say(1));
      await wait(250);
      t.link.sent.length = 0;
      t.link.emit(t.say(1));
      await wait(250);
      expect(t.link.sent.filter((s) => s.event.type === 'chat.committed')).toEqual([]);
    } finally {
      await t.client.close();
      await t.built.app.close();
    }
  });

  it('recovers what it missed from a host whose log reaches further, and shows it to the surface', async () => {
    const t = await start();
    try {
      const seen: number[] = [];
      t.client.on('chat.message', (e) => seen.push(e.seq));
      t.link.emit(t.say(1));
      t.link.emit(t.say(2));
      await wait();
      expect(seen).toEqual([1, 2]);

      // The host says its log reaches 5: the link dropped and its buffer lost 3 to 5.
      t.link.emit(t.state(5));
      await wait(200);
      const asked = t.link.sent.find((s) => s.event.type === 'patch.log_sync.request');
      expect(asked?.event).toEqual({ type: 'patch.log_sync.request', chatId: 'c1', afterSeq: 2 });

      // The host answers from its own log.
      t.link.emit({
        type: 'patch.log_sync.batch',
        chatId: 'c1',
        events: [t.say(3), t.say(4), t.say(5)],
        done: true,
      } as WireEvent);
      await wait();
      expect(seen).toEqual([1, 2, 3, 4, 5]);
      expect(t.built.chatLogStore.highWater('c1')).toBe(5);
    } finally {
      await t.client.close();
      await t.built.app.close();
    }
  });

  it('does not show a surface the sync answer as a frame of its own', async () => {
    const t = await start();
    try {
      const types: string[] = [];
      t.client.on('patch.log_sync.batch' as never, () => types.push('batch'));
      t.link.emit(t.say(1));
      t.link.emit({
        type: 'patch.log_sync.batch',
        chatId: 'c1',
        events: [t.say(2)],
        done: true,
      } as WireEvent);
      await wait();
      expect(types).toEqual([]);
    } finally {
      await t.client.close();
      await t.built.app.close();
    }
  });

  it("rebuilds a host whose log is behind the server's", async () => {
    const t = await start();
    try {
      for (let seq = 1; seq <= 4; seq++) t.link.emit(t.say(seq));
      await wait();
      t.link.sent.length = 0;
      t.link.emit(t.state(1));
      await wait(200);
      const restore = t.link.sent.find((s) => s.event.type === 'patch.log_restore');
      expect(restore?.daemonId).toBe('d1');
      expect(
        (restore!.event as { events: Array<{ seq: number }> }).events.map((e) => e.seq),
      ).toEqual([2, 3, 4]);
    } finally {
      await t.client.close();
      await t.built.app.close();
    }
  });

  it('streams live text without ever writing it to the log', async () => {
    const t = await start();
    try {
      const deltas: string[] = [];
      t.client.on('chat.message_delta', (e) => deltas.push(e.delta));
      t.link.emit({
        type: 'chat.message_delta',
        chatId: 'c1',
        messageSeq: 1,
        delta: 'hel',
      } as WireEvent);
      t.link.emit({
        type: 'chat.message_delta',
        chatId: 'c1',
        messageSeq: 1,
        delta: 'lo',
      } as WireEvent);
      await wait();
      expect(deltas).toEqual(['hel', 'lo']);
      expect(t.built.chatLogStore.has('c1')).toBe(false);
    } finally {
      await t.client.close();
      await t.built.app.close();
    }
  });
});
