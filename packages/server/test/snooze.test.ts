// Snooze (spec/04 § Snooze) — server side: the registry hides a chat whose
// `snoozedUntil` is still in the future from the active list (and exposes a
// snoozed-only view), and `POST /api/chats/:id/snooze` forwards the request to
// the host.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';
import { ChatRegistry } from '../src/chat-registry.js';

const T0 = 1_700_000_000_000;

function silentLogger() {
  return { warn: () => undefined };
}

function seeded(now: () => number): ChatRegistry {
  const reg = new ChatRegistry({ logger: silentLogger(), now });
  reg.observe({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '/x' });
  reg.observe({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c2', folder: '/y' });
  reg.observe({
    type: 'chat.state',
    permissionMode: 'bypassPermissions',
    chatId: 'c2',
    activity: 'idle',
    lastUpdated: 2,
    status: 'active',
    folder: '/y',
  });
  return reg;
}

describe('ChatRegistry snooze filtering', () => {
  it('hides a chat snoozed into the future and lists it under snoozedOnly', () => {
    const reg = seeded(() => T0);
    reg.observe({
      type: 'chat.state',
      permissionMode: 'bypassPermissions',
      chatId: 'c1',
      activity: 'idle',
      lastUpdated: 1,
      status: 'active',
      folder: '/x',
      snoozedUntil: T0 + 60_000,
    });
    expect(reg.get('c1')?.snoozedUntil).toBe(T0 + 60_000);
    expect(reg.list().map((c) => c.chatId)).toEqual(['c2']);
    expect(reg.list({ snoozedOnly: true }).map((c) => c.chatId)).toEqual(['c1']);
  });

  it('a snooze that has LAPSED is listed as active again, with no event needed', () => {
    let now = T0;
    const reg = seeded(() => now);
    reg.observe({
      type: 'chat.state',
      permissionMode: 'bypassPermissions',
      chatId: 'c1',
      activity: 'idle',
      lastUpdated: 1,
      status: 'active',
      folder: '/x',
      snoozedUntil: T0 + 60_000,
    });
    expect(reg.list().map((c) => c.chatId)).toEqual(['c2']);
    now = T0 + 60_001;
    expect(reg.list().map((c) => c.chatId)).toContain('c1');
    expect(reg.list({ snoozedOnly: true })).toEqual([]);
  });

  it('a null snoozedUntil on a later chat.state clears the snooze', () => {
    const reg = seeded(() => T0);
    reg.observe({
      type: 'chat.state',
      permissionMode: 'bypassPermissions',
      chatId: 'c1',
      activity: 'idle',
      lastUpdated: 1,
      status: 'active',
      folder: '/x',
      snoozedUntil: T0 + 60_000,
    });
    reg.observe({
      type: 'chat.state',
      permissionMode: 'bypassPermissions',
      chatId: 'c1',
      activity: 'idle',
      lastUpdated: 3,
      status: 'active',
      folder: '/x',
      snoozedUntil: null,
    });
    expect(reg.get('c1')?.snoozedUntil).toBe(null);
    expect(reg.list().map((c) => c.chatId)).toContain('c1');
  });

  it('an ABSENT snoozedUntil field never wipes a known snooze (back-compat)', () => {
    const reg = seeded(() => T0);
    reg.observe({
      type: 'chat.state',
      permissionMode: 'bypassPermissions',
      chatId: 'c1',
      activity: 'idle',
      lastUpdated: 1,
      status: 'active',
      folder: '/x',
      snoozedUntil: T0 + 60_000,
    });
    reg.observe({
      type: 'chat.state',
      permissionMode: 'bypassPermissions',
      chatId: 'c1',
      activity: 'running',
      lastUpdated: 4,
      status: 'active',
      folder: '/x',
    });
    expect(reg.get('c1')?.snoozedUntil).toBe(T0 + 60_000);
  });
});

describe('POST /api/chats/:id/snooze', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-snooze-routes-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function bootstrap() {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(21));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({
      surfaceId: 'srf-snooze',
      surfaceKind: 'terminal',
      label: 'cli',
      issuedAt: 1,
    });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-snooze',
      surfaceKind: 'terminal',
      label: 'cli',
    });
    return { registry, jwt };
  }

  async function withApp(
    fn: (ctx: {
      app: Awaited<ReturnType<typeof buildAll>>['app'];
      daemonLink: InProcessDaemonLink;
      jwt: string;
    }) => Promise<void>,
  ): Promise<void> {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await buildAll({ logger: false, registry, daemonLink, spawnErrorWaitMs: 50 });
    try {
      daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '/x' });
      await fn({ app: built.app, daemonLink, jwt });
    } finally {
      await built.app.close();
    }
  }

  it('forwards chat.snooze_request to the host', async () => {
    await withApp(async ({ app, daemonLink, jwt }) => {
      const until = Date.now() + 60_000;
      const res = await app.inject({
        method: 'POST',
        url: '/api/chats/c1/snooze',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { snoozedUntil: until },
      });
      expect(res.statusCode).toBe(200);
      const sent = daemonLink.sent.find((s) => s.event.type === 'chat.snooze_request');
      expect(sent?.event).toMatchObject({ chatId: 'c1', snoozedUntil: until });
    });
  });

  it('accepts null (unsnooze)', async () => {
    await withApp(async ({ app, daemonLink, jwt }) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/chats/c1/snooze',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { snoozedUntil: null },
      });
      expect(res.statusCode).toBe(200);
      const sent = daemonLink.sent.find((s) => s.event.type === 'chat.snooze_request');
      expect(sent?.event).toMatchObject({ chatId: 'c1', snoozedUntil: null });
    });
  });

  it('rejects a snoozedUntil in the past with 400 (NO FALLBACK)', async () => {
    await withApp(async ({ app, daemonLink, jwt }) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/chats/c1/snooze',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { snoozedUntil: Date.now() - 1000 },
      });
      expect(res.statusCode).toBe(400);
      expect(daemonLink.sent.some((s) => s.event.type === 'chat.snooze_request')).toBe(false);
    });
  });

  it('404s for an unknown chat', async () => {
    await withApp(async ({ app, jwt }) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/chats/nope/snooze',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { snoozedUntil: Date.now() + 60_000 },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  it('GET /api/chats?snoozed=only returns only snoozed chats; a bogus value is 400', async () => {
    await withApp(async ({ app, daemonLink, jwt }) => {
      const until = Date.now() + 60_000;
      daemonLink.emit({
        type: 'chat.state',
        permissionMode: 'bypassPermissions',
        chatId: 'c1',
        activity: 'idle',
        lastUpdated: 1,
        status: 'active',
        folder: '/x',
        snoozedUntil: until,
      });
      daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c2', folder: '/y' });
      const only = await app.inject({
        method: 'GET',
        url: '/api/chats?snoozed=only',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect((only.json() as { chats: { chatId: string }[] }).chats.map((c) => c.chatId)).toEqual([
        'c1',
      ]);
      const active = await app.inject({
        method: 'GET',
        url: '/api/chats',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(
        (active.json() as { chats: { chatId: string }[] }).chats.map((c) => c.chatId),
      ).not.toContain('c1');
      const bogus = await app.inject({
        method: 'GET',
        url: '/api/chats?snoozed=yes',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(bogus.statusCode).toBe(400);
    });
  });

  // The phone's cold start (spec/15 ## Chats tab §5): it DRAWS snoozed chats in
  // their own section rather than hiding them, so it asks for one roster
  // holding both, and needs `snoozedUntil` on the entry to tell them apart and
  // to name the wake time.
  it('GET /api/chats?snoozed=include returns active + snoozed, each carrying snoozedUntil', async () => {
    await withApp(async ({ app, daemonLink, jwt }) => {
      const until = Date.now() + 60_000;
      daemonLink.emit({
        type: 'chat.state',
        permissionMode: 'bypassPermissions',
        chatId: 'c1',
        activity: 'idle',
        lastUpdated: 1,
        status: 'active',
        folder: '/x',
        snoozedUntil: until,
      });
      daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c2', folder: '/y' });

      const res = await app.inject({
        method: 'GET',
        url: '/api/chats?snoozed=include',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
      const chats = (res.json() as { chats: { chatId: string; snoozedUntil: number | null }[] })
        .chats;
      expect(chats.map((c) => c.chatId).sort()).toEqual(['c1', 'c2']);
      expect(chats.find((c) => c.chatId === 'c1')?.snoozedUntil).toBe(until);
      expect(chats.find((c) => c.chatId === 'c2')?.snoozedUntil).toBeNull();
    });
  });
});
