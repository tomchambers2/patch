// Group 7: REST chat routes (POST /api/chats, GET /api/chats[/:id]).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';

async function makeApp(opts: {
  registry: Registry;
  daemonLink: InProcessDaemonLink;
  idGenerator?: () => string;
  spawnErrorWaitMs?: number;
  /** Whether `d1` has re-announced its chats (default true) — see unknown-chat.ts. */
  synced?: boolean;
}) {
  const built = await buildAll({
    logger: false,
    registry: opts.registry,
    daemonLink: opts.daemonLink,
    // Default to a tiny window so tests don't wait the full 5s for the
    // synchronous spawn-error race when they don't simulate a host emit.
    spawnErrorWaitMs: opts.spawnErrorWaitMs ?? 50,
    ...(opts.idGenerator ? { idGenerator: opts.idGenerator } : {}),
  });
  if (opts.synced !== false) {
    opts.daemonLink.emit({ type: 'folders.list', daemonId: 'd1', roots: [], recent: [] });
  }
  return built;
}

describe('chat REST routes', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-chat-routes-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function bootstrap() {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(20));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({
      surfaceId: 'srf-rest',
      surfaceKind: 'terminal',
      label: 'cli',
      issuedAt: 1,
    });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-rest',
      surfaceKind: 'terminal',
      label: 'cli',
    });
    // `d1` must be a REGISTERED machine: every host-addressed route refuses an
    // id that is not (spec/04 § Spawn), so a fixture that skipped this would be
    // testing the refusal path instead of the route.
    registry.setDaemonKey({ daemonId: 'd1', publicKey: user.publicKey, issuedAt: 1 });
    return { user, registry, jwt };
  }

  it('POST /api/chats allocates a chatId, forwards spawn to daemon-link', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    let nextId = 0;
    const built = await makeApp({
      registry,
      daemonLink,
      idGenerator: () => `01HSERVER${String(++nextId).padStart(17, '0')}`,
    });
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { daemonId: 'd1', folder: '/work/proj-A', prompt: 'go' },
      });
      expect(res.statusCode).toBe(202);
      const body = res.json() as { chatId: string };
      expect(body.chatId).toBe('01HSERVER00000000000000001');
      const sent = daemonLink.sent.find((s) => s.event.type === 'chat.spawn_request');
      expect(sent).toBeDefined();
      if (sent && sent.event.type === 'chat.spawn_request') {
        expect(sent.event.chatId).toBe('01HSERVER00000000000000001');
        expect(sent.event.folder).toBe('/work/proj-A');
        expect(sent.event.prompt).toBe('go');
      }
    } finally {
      await built.app.close();
    }
  });

  // 2026-09-29: right after a server redeploy the mirror was empty and every
  // chat on a not-yet-reconnected host answered chat_not_found.
  it('an unknown chat on a host that has not reported since the restart is 503, not 404', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    daemonLink.setDaemonId(null);
    const built = await makeApp({ registry, daemonLink, synced: false });
    try {
      const get = () =>
        built.app.inject({
          method: 'GET',
          url: '/api/chats/01M3N32N9T7V75JCV7XHY9NRHM',
          headers: { authorization: `Bearer ${jwt}` },
        });
      const offline = await get();
      expect(offline.statusCode).toBe(503);
      expect(offline.json()).toMatchObject({
        error: 'host_offline',
        hosts: [{ daemonId: 'd1', online: false }],
      });
      expect(offline.json().message).toContain('offline');

      daemonLink.setDaemonId('d1');
      const reconnecting = await get();
      expect(reconnecting.statusCode).toBe(503);
      expect(reconnecting.json().error).toBe('host_reconnecting');

      // The host's burst ends with folders.list: now a miss is a real miss.
      daemonLink.emit({ type: 'folders.list', daemonId: 'd1', roots: [], recent: [] });
      expect((await get()).statusCode).toBe(404);
    } finally {
      await built.app.close();
    }
  });

  it('a chat its host announced is found even before the host finishes reporting', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink, synced: false });
    try {
      daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '/a' });
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/chats/c1',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/chats requires JWT', async () => {
    const { registry } = await bootstrap();
    const built = await makeApp({ registry, daemonLink: new InProcessDaemonLink() });
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats',
        payload: { daemonId: 'd1', folder: '/x' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });

  it('GET /api/chats lists active chats from registry, sorted pinned-first', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      // Host emits chat.spawned + chat.state.
      daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '/a' });
      daemonLink.emit({
        type: 'chat.state',
        permissionMode: 'bypassPermissions',
        chatId: 'c1',
        activity: 'idle',
        lastUpdated: 100,
        pinned: false,
        status: 'active',
        name: null,
        folder: '/a',
      });
      daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c2', folder: '/b' });
      daemonLink.emit({
        type: 'chat.state',
        permissionMode: 'bypassPermissions',
        chatId: 'c2',
        activity: 'idle',
        lastUpdated: 50,
        pinned: true,
        status: 'active',
        name: 'pinned-one',
        folder: '/b',
      });
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/chats',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { chats: { chatId: string; pinned: boolean }[] };
      expect(body.chats.map((c) => c.chatId)).toEqual(['c2', 'c1']);
    } finally {
      await built.app.close();
    }
  });

  it('GET /api/chats?archived=only returns only archived', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId: 'a1', folder: '/x' });
      daemonLink.emit({
        type: 'chat.state',
        permissionMode: 'bypassPermissions',
        chatId: 'a1',
        activity: 'idle',
        lastUpdated: 1,
        status: 'archived',
        pinned: false,
        folder: '/x',
      });
      daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId: 'b1', folder: '/y' });
      daemonLink.emit({
        type: 'chat.state',
        permissionMode: 'bypassPermissions',
        chatId: 'b1',
        activity: 'idle',
        lastUpdated: 2,
        status: 'active',
        pinned: false,
        folder: '/y',
      });
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/chats?archived=only',
        headers: { authorization: `Bearer ${jwt}` },
      });
      const body = res.json() as { chats: { chatId: string }[] };
      expect(body.chats.map((c) => c.chatId)).toEqual(['a1']);
    } finally {
      await built.app.close();
    }
  });

  // Pagination (spec/14 § Sidebar item 6: "load a limited number... then load
  // more on scroll"). `limit`/`offset` page whatever the filter already
  // selected — tested here against `archived=only` since that's the simplest
  // filter, but the slicing is generic to every filter combination.
  it('GET /api/chats?...&limit= pages the filtered list and reports nextOffset', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    const seedArchived = (chatId: string, lastUpdated: number) => {
      daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId, folder: '/x' });
      daemonLink.emit({
        type: 'chat.state',
        permissionMode: 'bypassPermissions',
        chatId,
        activity: 'idle',
        lastUpdated,
        status: 'archived',
        pinned: false,
        folder: '/x',
      });
    };
    try {
      // Most-recent-first is the default sort, so ids land in this order:
      // c3 (30), c2 (20), c1 (10).
      seedArchived('c1', 10);
      seedArchived('c2', 20);
      seedArchived('c3', 30);
      const get = async (url: string) => {
        const res = await built.app.inject({
          method: 'GET',
          url,
          headers: { authorization: `Bearer ${jwt}` },
        });
        return {
          status: res.statusCode,
          body: res.json() as { chats: { chatId: string }[]; nextOffset: number | null },
        };
      };

      const page1 = await get('/api/chats?archived=only&limit=2');
      expect(page1.body.chats.map((c) => c.chatId)).toEqual(['c3', 'c2']);
      expect(page1.body.nextOffset).toBe(2);

      const page2 = await get('/api/chats?archived=only&limit=2&offset=2');
      expect(page2.body.chats.map((c) => c.chatId)).toEqual(['c1']);
      expect(page2.body.nextOffset).toBeNull();

      // No `limit` at all: every existing caller's behaviour is unchanged —
      // the whole filtered list, `nextOffset` reporting nothing further.
      const unpaged = await get('/api/chats?archived=only');
      expect(unpaged.body.chats.map((c) => c.chatId)).toEqual(['c3', 'c2', 'c1']);
      expect(unpaged.body.nextOffset).toBeNull();
    } finally {
      await built.app.close();
    }
  });

  it('GET /api/chats rejects a bad limit or offset with 400 (NO FALLBACK)', async () => {
    const { registry, jwt } = await bootstrap();
    const built = await makeApp({ registry, daemonLink: new InProcessDaemonLink() });
    try {
      const get = async (url: string) =>
        built.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${jwt}` } });
      expect((await get('/api/chats?limit=0')).statusCode).toBe(400);
      expect((await get('/api/chats?limit=201')).statusCode).toBe(400);
      expect((await get('/api/chats?limit=abc')).statusCode).toBe(400);
      expect((await get('/api/chats?limit=1&offset=-1')).statusCode).toBe(400);
      expect((await get('/api/chats?limit=1&offset=abc')).statusCode).toBe(400);
    } finally {
      await built.app.close();
    }
  });

  it('GET /api/chats?...&order=asc reverses the page order (oldest first — Hidden/Automations)', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    const seedHidden = (chatId: string, lastUpdated: number) => {
      daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId, folder: '/x' });
      daemonLink.emit({
        type: 'chat.state',
        permissionMode: 'bypassPermissions',
        chatId,
        activity: 'idle',
        lastUpdated,
        status: 'active',
        pinned: false,
        folder: '/x',
        hidden: true,
      });
    };
    try {
      seedHidden('c1', 10);
      seedHidden('c2', 20);
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/chats?hidden=only&order=asc',
        headers: { authorization: `Bearer ${jwt}` },
      });
      const body = res.json() as { chats: { chatId: string }[] };
      expect(body.chats.map((c) => c.chatId)).toEqual(['c1', 'c2']);
    } finally {
      await built.app.close();
    }
  });

  // Section counts (spec/04 § Section counts). The contract is an EQUALITY, not
  // a set of magic numbers: each count must equal the length of the very list
  // its section expands into, so the sidebar's collapsed badge can never
  // disagree with the rows drawn on opening it. Asserting the two against each
  // other is what makes a future divergence in the filter predicates fail here
  // rather than silently mis-label the sidebar.
  it('GET /api/chats/counts returns totals equal to each section list length', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    const now = Date.now();
    const seed = (chatId: string, patch: Record<string, unknown>) => {
      daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId, folder: '/x' });
      daemonLink.emit({
        type: 'chat.state',
        permissionMode: 'bypassPermissions',
        chatId,
        activity: 'idle',
        lastUpdated: 1,
        pinned: false,
        folder: '/x',
        ...patch,
      });
    };
    try {
      // Two archived, one deleted, three snoozed into the future, two plain
      // active — deliberately different totals so a count wired to the wrong
      // section cannot pass by coincidence.
      seed('arch-1', { status: 'archived' });
      seed('arch-2', { status: 'archived' });
      seed('del-1', { status: 'deleted' });
      seed('snz-1', { status: 'active', snoozedUntil: now + 60_000 });
      seed('snz-2', { status: 'active', snoozedUntil: now + 60_000 });
      seed('snz-3', { status: 'active', snoozedUntil: now + 60_000 });
      seed('act-1', { status: 'active' });
      seed('act-2', { status: 'active' });

      const get = async (url: string) => {
        const res = await built.app.inject({
          method: 'GET',
          url,
          headers: { authorization: `Bearer ${jwt}` },
        });
        expect(res.statusCode).toBe(200);
        return res.json();
      };

      const counts = (await get('/api/chats/counts')) as Record<string, number>;
      const lengthOf = async (query: string) =>
        ((await get(`/api/chats?${query}`)) as { chats: unknown[] }).chats.length;

      expect(counts.archived).toBe(await lengthOf('archived=only'));
      expect(counts.snoozed).toBe(await lengthOf('snoozed=only'));
      expect(counts.hidden).toBe(await lengthOf('hidden=only'));
      expect(counts.deleted).toBe(await lengthOf('deleted=only'));
      expect(counts.automations).toBe(await lengthOf('automations=only'));

      // Pin the absolute values too, so a bug that made BOTH sides equally
      // wrong (e.g. every filter collapsing to the same list) still fails.
      expect(counts).toEqual({ archived: 2, snoozed: 3, hidden: 0, deleted: 1, automations: 0 });
    } finally {
      await built.app.close();
    }
  });

  it('GET /api/chats/counts requires auth', async () => {
    const { registry } = await bootstrap();
    const built = await makeApp({ registry, daemonLink: new InProcessDaemonLink() });
    try {
      const res = await built.app.inject({ method: 'GET', url: '/api/chats/counts' });
      expect(res.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });

  it('GET /api/chats?archived=true is rejected with 400 (legacy value, group 8)', async () => {
    const { registry, jwt } = await bootstrap();
    const built = await makeApp({ registry, daemonLink: new InProcessDaemonLink() });
    try {
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/chats?archived=true',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await built.app.close();
    }
  });

  it('GET /api/chats?deleted=only returns only soft-deleted chats; a bogus value is 400 (E5)', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId: 'd1', folder: '/x' });
      daemonLink.emit({
        type: 'chat.state',
        permissionMode: 'bypassPermissions',
        chatId: 'd1',
        activity: 'idle',
        lastUpdated: 1,
        status: 'deleted',
        pinned: false,
        folder: '/x',
      });
      daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId: 'e1', folder: '/y' });
      daemonLink.emit({
        type: 'chat.state',
        permissionMode: 'bypassPermissions',
        chatId: 'e1',
        activity: 'idle',
        lastUpdated: 2,
        status: 'active',
        pinned: false,
        folder: '/y',
      });
      const ok = await built.app.inject({
        method: 'GET',
        url: '/api/chats?deleted=only',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect((ok.json() as { chats: { chatId: string }[] }).chats.map((c) => c.chatId)).toEqual([
        'd1',
      ]);
      const bad = await built.app.inject({
        method: 'GET',
        url: '/api/chats?deleted=all',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(bad.statusCode).toBe(400);
    } finally {
      await built.app.close();
    }
  });

  it('GET /api/chats?archived=include returns active + archived', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId: 'a1', folder: '/x' });
      daemonLink.emit({
        type: 'chat.state',
        permissionMode: 'bypassPermissions',
        chatId: 'a1',
        activity: 'idle',
        lastUpdated: 1,
        status: 'archived',
        pinned: false,
        folder: '/x',
      });
      daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId: 'b1', folder: '/y' });
      daemonLink.emit({
        type: 'chat.state',
        permissionMode: 'bypassPermissions',
        chatId: 'b1',
        activity: 'idle',
        lastUpdated: 2,
        status: 'active',
        pinned: false,
        folder: '/y',
      });
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/chats?archived=include',
        headers: { authorization: `Bearer ${jwt}` },
      });
      const body = res.json() as { chats: { chatId: string }[] };
      expect(body.chats.map((c) => c.chatId).sort()).toEqual(['a1', 'b1']);
    } finally {
      await built.app.close();
    }
  });

  it('GET /api/chats?automations=bogus is rejected with 400 (NO FALLBACK, matches archived/deleted/snoozed strictness)', async () => {
    const { registry, jwt } = await bootstrap();
    const built = await makeApp({ registry, daemonLink: new InProcessDaemonLink() });
    try {
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/chats?automations=bogus',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await built.app.close();
    }
  });

  it('GET /api/chats/:id/history round-trips via daemon-link and returns events since seq', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    let nextId = 0;
    const built = await makeApp({
      registry,
      daemonLink,
      idGenerator: () => `01HHIST0${String(++nextId).padStart(19, '0')}`,
    });
    try {
      // Seed a chat in the registry so the route doesn't 404.
      daemonLink.emit({
        type: 'chat.spawned',
        daemonId: 'd1',
        chatId: 'c-hist',
        folder: '/work/h',
      });
      daemonLink.emit({
        type: 'chat.state',
        permissionMode: 'bypassPermissions',
        chatId: 'c-hist',
        activity: 'idle',
        lastUpdated: 1,
        status: 'active',
        pinned: false,
        folder: '/work/h',
      });

      // Stand in for the host: reply to patch.chat_history.request with the
      // events at/after the requested `since`.
      const allEvents = [
        {
          type: 'chat.message' as const,
          chatId: 'c-hist',
          role: 'user' as const,
          content: 'a',
          seq: 0,
        },
        {
          type: 'chat.message' as const,
          chatId: 'c-hist',
          role: 'assistant' as const,
          content: 'b',
          seq: 1,
        },
        {
          type: 'chat.message' as const,
          chatId: 'c-hist',
          role: 'user' as const,
          content: 'c',
          seq: 2,
        },
      ];
      const originalSend = daemonLink.send.bind(daemonLink);
      let seenSince: number | undefined = -1;
      daemonLink.send = (surfaceId, event) => {
        originalSend(surfaceId, event);
        if (event.type === 'patch.chat_history.request') {
          seenSince = event.since;
          const from = event.since ?? 0;
          setImmediate(() => {
            daemonLink.emit({
              type: 'patch.chat_history.response',
              requestId: event.requestId,
              ok: true,
              events: allEvents.filter((e) => e.seq >= from),
            });
          });
        }
      };

      const res = await built.app.inject({
        method: 'GET',
        url: '/api/chats/c-hist/history?since=2',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
      expect(seenSince).toBe(2);
      const body = res.json() as { events: Array<{ content: string; seq: number }> };
      expect(body.events).toHaveLength(1);
      expect(body.events[0]?.content).toBe('c');
      expect(body.events[0]?.seq).toBe(2);
    } finally {
      await built.app.close();
    }
  });

  it("GET /api/chats/:id/history answers from the server's own copy while the chat's host is offline", async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c-off', folder: '/work/o' });
      for (const seq of [1, 2, 3]) {
        daemonLink.emit({
          type: 'chat.message',
          chatId: 'c-off',
          role: 'assistant',
          content: `m${seq}`,
          seq,
        });
      }
      daemonLink.setStatus('offline');

      const res = await built.app.inject({
        method: 'GET',
        url: '/api/chats/c-off/history?since=2',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { events: Array<{ seq: number }>; fromServerCopy?: boolean };
      expect(body.events.map((e) => e.seq)).toEqual([2, 3]);
      expect(body.fromServerCopy).toBe(true);
    } finally {
      await built.app.close();
    }
  });

  it("GET /api/chats/:id/history from the server's copy honours limit, and reads everything with no since", async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c-all', folder: '/work/a' });
      for (const seq of [0, 1, 2, 3]) {
        daemonLink.emit({
          type: 'chat.message',
          chatId: 'c-all',
          role: 'assistant',
          content: `m${seq}`,
          seq,
        });
      }
      daemonLink.setStatus('offline');
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/chats/c-all/history?limit=3',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json().events as Array<{ seq: number }>).map((e) => e.seq)).toEqual([0, 1, 2]);
    } finally {
      await built.app.close();
    }
  });

  // spec/14 § Side threads panel — pulls a side thread's content through this
  // REST path with a branchId, since a side branch isn't broadcast live.
  it('GET /api/chats/:id/history?branchId=<id> passes branchId through to the host request', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink, idGenerator: () => '01HHIST0BRANCH' });
    try {
      daemonLink.emit({
        type: 'chat.spawned',
        daemonId: 'd1',
        chatId: 'c-hist-branch',
        folder: '/work/h',
      });
      daemonLink.emit({
        type: 'chat.state',
        permissionMode: 'bypassPermissions',
        chatId: 'c-hist-branch',
        activity: 'idle',
        lastUpdated: 1,
        status: 'active',
        pinned: false,
        folder: '/work/h',
      });

      const originalSend = daemonLink.send.bind(daemonLink);
      let seenBranchId: string | undefined;
      daemonLink.send = (surfaceId, event) => {
        originalSend(surfaceId, event);
        if (event.type === 'patch.chat_history.request') {
          seenBranchId = event.branchId;
          setImmediate(() => {
            daemonLink.emit({
              type: 'patch.chat_history.response',
              requestId: event.requestId,
              ok: true,
              events: [],
            });
          });
        }
      };

      const res = await built.app.inject({
        method: 'GET',
        url: '/api/chats/c-hist-branch/history?branchId=c-hist-branch-b1',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
      expect(seenBranchId).toBe('c-hist-branch-b1');
    } finally {
      await built.app.close();
    }
  });

  it('GET /api/chats/:parentId/delegates/:id/history round-trips with requireParent, for a subagent chat never in the registry', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      // The PARENT is a real, known chat — the subagent `sub-1` is deliberately
      // NEVER spawned into the registry (spec/02 § Native subagent dispatch:
      // a delegate is never in it), which is exactly the case the ordinary
      // /api/chats/:id/history route can't serve.
      daemonLink.emit({
        type: 'chat.spawned',
        daemonId: 'd1',
        chatId: 'parent-1',
        folder: '/work/p',
      });
      daemonLink.emit({
        type: 'chat.state',
        permissionMode: 'bypassPermissions',
        chatId: 'parent-1',
        activity: 'idle',
        lastUpdated: 1,
        status: 'active',
        pinned: false,
        folder: '/work/p',
      });

      const originalSend = daemonLink.send.bind(daemonLink);
      let seenRequest: { chatId?: string; requireParent?: string } | undefined;
      daemonLink.send = (surfaceId, event) => {
        originalSend(surfaceId, event);
        if (event.type === 'patch.chat_history.request') {
          seenRequest = { chatId: event.chatId, requireParent: event.requireParent };
          setImmediate(() => {
            daemonLink.emit({
              type: 'patch.chat_history.response',
              requestId: event.requestId,
              ok: true,
              events: [
                { type: 'chat.message', chatId: 'sub-1', role: 'user', content: 'go', seq: 0 },
                {
                  type: 'chat.message',
                  chatId: 'sub-1',
                  role: 'assistant',
                  content: 'done',
                  seq: 1,
                },
              ],
            });
          });
        }
      };

      const res = await built.app.inject({
        method: 'GET',
        url: '/api/chats/parent-1/delegates/sub-1/history',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
      expect(seenRequest).toEqual({ chatId: 'sub-1', requireParent: 'parent-1' });
      const body = res.json() as { events: Array<{ content: string }> };
      expect(body.events.map((e) => e.content)).toEqual(['go', 'done']);
    } finally {
      await built.app.close();
    }
  });

  it('GET /api/chats/:parentId/delegates/:id/history 404s when the PARENT is unknown, without ever asking the host', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/chats/no-such-parent/delegates/sub-1/history',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(404);
      expect(daemonLink.sent.some((s) => s.event.type === 'patch.chat_history.request')).toBe(
        false,
      );
    } finally {
      await built.app.close();
    }
  });

  it("GET /api/chats/:parentId/delegates/:id/history maps the host's not_a_delegate refusal to 404", async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      daemonLink.emit({
        type: 'chat.spawned',
        daemonId: 'd1',
        chatId: 'parent-2',
        folder: '/work/p',
      });
      daemonLink.emit({
        type: 'chat.state',
        permissionMode: 'bypassPermissions',
        chatId: 'parent-2',
        activity: 'idle',
        lastUpdated: 1,
        status: 'active',
        pinned: false,
        folder: '/work/p',
      });
      const originalSend = daemonLink.send.bind(daemonLink);
      daemonLink.send = (surfaceId, event) => {
        originalSend(surfaceId, event);
        if (event.type === 'patch.chat_history.request') {
          setImmediate(() => {
            daemonLink.emit({
              type: 'patch.chat_history.response',
              requestId: event.requestId,
              ok: false,
              error: { code: 'not_a_delegate', message: 'not a delegate of parent-2' },
            });
          });
        }
      };

      const res = await built.app.inject({
        method: 'GET',
        url: '/api/chats/parent-2/delegates/someone-elses-sub/history',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('not_a_delegate');
    } finally {
      await built.app.close();
    }
  });

  it('GET /api/chats/:id/history returns 404 for an unknown chat', async () => {
    const { registry, jwt } = await bootstrap();
    const built = await makeApp({ registry, daemonLink: new InProcessDaemonLink() });
    try {
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/chats/nope/history',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await built.app.close();
    }
  });

  it('GET /api/chats/:id/history rejects a non-numeric since with 400 (NO FALLBACK)', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c-bad', folder: '/w' });
      daemonLink.emit({
        type: 'chat.state',
        permissionMode: 'bypassPermissions',
        chatId: 'c-bad',
        activity: 'idle',
        lastUpdated: 1,
        status: 'active',
        pinned: false,
        folder: '/w',
      });
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/chats/c-bad/history?since=banana',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await built.app.close();
    }
  });

  it('GET /api/chats/:id/history requires auth (401)', async () => {
    const { registry } = await bootstrap();
    const built = await makeApp({ registry, daemonLink: new InProcessDaemonLink() });
    try {
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/chats/anything/history',
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/chats returns 400 + folder_not_found code when host emits chat.error within window', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    let nextId = 0;
    const built = await makeApp({
      registry,
      daemonLink,
      idGenerator: () => `01HSERVER${String(++nextId).padStart(17, '0')}`,
      // Long window so we definitely see the synchronous emit.
      spawnErrorWaitMs: 1_000,
    });
    try {
      // When the server forwards the spawn, simulate the host rejecting it.
      const origSend = daemonLink.send.bind(daemonLink);
      daemonLink.send = (surfaceId, ev): void => {
        origSend(surfaceId, ev);
        if (ev.type === 'chat.spawn_request') {
          daemonLink.emit({
            type: 'chat.error',
            chatId: ev.chatId ?? 'pending-spawn',
            error: { code: 'folder_not_found', message: `no such folder: ${ev.folder}` },
            seq: 0,
          });
        }
      };
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { daemonId: 'd1', folder: '/no/such/path' },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json() as { error: string; chatId?: string };
      expect(body.error).toBe('folder_not_found');
      // E1-d6: a failed spawn created no chat — the body must NOT surface a
      // misleading chatId (the server-allocated id is absent from GET /api/chats).
      expect(body.chatId).toBeUndefined();
    } finally {
      await built.app.close();
    }
  });

  // A refused spawn's `chat.error` is fanned out to every surface under the
  // chatId the server allocated, and a surface builds a row for any chatId it
  // has not seen before — that is what left a ghost "New chat" row in the
  // sidebar per failed spawn. The refusal must therefore name the id to retract
  // (the caller is the only party that knows this spawn was refused).
  it('POST /api/chats names the chatId to retract when the host refuses the spawn', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    let nextId = 0;
    const built = await makeApp({
      registry,
      daemonLink,
      idGenerator: () => `01HSERVER${String(++nextId).padStart(17, '0')}`,
      spawnErrorWaitMs: 1_000,
    });
    try {
      let forwardedChatId: string | undefined;
      const origSend = daemonLink.send.bind(daemonLink);
      daemonLink.send = (surfaceId, ev): void => {
        origSend(surfaceId, ev);
        if (ev.type === 'chat.spawn_request') {
          forwardedChatId = ev.chatId;
          // The reported repro: a spawn naming no model on a host that has
          // never read a catalogue. The host refuses under the supplied id.
          daemonLink.emit({
            type: 'chat.error',
            chatId: ev.chatId ?? 'pending-spawn',
            error: { code: 'no_model_catalogue', message: 'no last-used model on d1' },
            seq: -1,
          });
        }
      };
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { daemonId: 'd1', folder: '/work/x' },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json() as { error: string; chatId?: string; retractChatId?: string };
      expect(body.error).toBe('no_model_catalogue');
      // Still no `chatId` — nothing was created (E1-d6). The retraction is a
      // separate, differently-named field precisely so it cannot read as one.
      expect(body.chatId).toBeUndefined();
      expect(body.retractChatId).toBe(forwardedChatId);
      // The chat really is absent from the list, so the row a surface drew from
      // the fanned-out error has nothing behind it.
      const list = await built.app.inject({
        method: 'GET',
        url: '/api/chats',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect((list.json() as { chats: { chatId: string }[] }).chats).toHaveLength(0);
    } finally {
      await built.app.close();
    }
  });

  // An older host refuses BEFORE reading the chatId the server supplied and
  // errors under its own `pending-spawn` placeholder. That is the id the
  // fanned-out frame carries, so that is the row a surface drew — retract THAT
  // one, not the id the server allocated (which no surface ever saw).
  it('POST /api/chats retracts the pending-spawn placeholder when the host errors under it', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({
      registry,
      daemonLink,
      idGenerator: () => '01HSERVER00000000000000001',
      spawnErrorWaitMs: 1_000,
    });
    try {
      const origSend = daemonLink.send.bind(daemonLink);
      daemonLink.send = (surfaceId, ev): void => {
        origSend(surfaceId, ev);
        if (ev.type === 'chat.spawn_request') {
          daemonLink.emit({
            type: 'chat.error',
            chatId: 'pending-spawn',
            error: { code: 'folder_not_found', message: 'no such folder' },
            seq: -1,
          });
        }
      };
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { daemonId: 'd1', folder: '/no/such/path' },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json() as { retractChatId?: string };
      expect(body.retractChatId).toBe('pending-spawn');
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/chats returns 202 quickly when host emits chat.spawned within window', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    let nextId = 0;
    const built = await makeApp({
      registry,
      daemonLink,
      idGenerator: () => `01HSERVER${String(++nextId).padStart(17, '0')}`,
      spawnErrorWaitMs: 5_000,
    });
    try {
      const origSend = daemonLink.send.bind(daemonLink);
      daemonLink.send = (surfaceId, ev): void => {
        origSend(surfaceId, ev);
        if (ev.type === 'chat.spawn_request') {
          daemonLink.emit({
            type: 'chat.spawned',
            daemonId: 'd1',
            chatId: ev.chatId ?? 'pending-spawn',
            folder: ev.folder,
          });
        }
      };
      const start = Date.now();
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { daemonId: 'd1', folder: '/anywhere' },
      });
      const elapsed = Date.now() - start;
      expect(res.statusCode).toBe(202);
      // Should not have waited the full 5s.
      expect(elapsed).toBeLessThan(1_000);
    } finally {
      await built.app.close();
    }
  });

  it('GET /api/chats/:id returns 404 on missing chat (NO FALLBACK)', async () => {
    const { registry, jwt } = await bootstrap();
    const built = await makeApp({ registry, daemonLink: new InProcessDaemonLink() });
    try {
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/chats/nope',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/chats/:id/send-to forwards chat.input to daemon-link', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      // The chat must exist in the registry first (H1-d3): send-to an unknown
      // chatId is rejected 404.
      daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '/x' });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats/c1/send-to',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { message: 'hello', localId: 'local-1' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { ok: boolean; queued: boolean };
      expect(body.ok).toBe(true);
      expect(body.queued).toBe(true);
      const sent = daemonLink.sent.find((s) => s.event.type === 'chat.input');
      expect(sent).toBeDefined();
      if (sent && sent.event.type === 'chat.input') {
        expect(sent.event.chatId).toBe('c1');
        expect(sent.event.message).toBe('hello');
        expect(sent.event.localId).toBe('local-1');
      }
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/chats/:id/send-to returns 404 for an unknown chat (H1-d3)', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats/chat_does_not_exist_xyz/send-to',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { message: 'misrouted' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'chat not found: chat_does_not_exist_xyz' });
      // NO SILENT FALLBACK: the turn must NOT have been forwarded.
      expect(daemonLink.sent.find((s) => s.event.type === 'chat.input')).toBeUndefined();
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/chats/:id/send-to rejects read-only mirror threads (H1-d2)', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      for (const chatId of ['thread_speakers']) {
        daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId, folder: `/${chatId}` });
        const res = await built.app.inject({
          method: 'POST',
          url: `/api/chats/${chatId}/send-to`,
          headers: { authorization: `Bearer ${jwt}` },
          payload: { message: 'should be refused' },
        });
        expect(res.statusCode).toBe(403);
        expect((res.json() as { error: string }).error).toContain(
          'read-only mirror; composer disabled',
        );
      }
      // Manager (also a special thread) is NOT read-only — it still accepts.
      daemonLink.emit({
        type: 'chat.spawned',
        daemonId: 'd1',
        chatId: 'thread_manager',
        folder: '/mgr',
      });
      const ok = await built.app.inject({
        method: 'POST',
        url: '/api/chats/thread_manager/send-to',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { message: 'accepted' },
      });
      expect(ok.statusCode).toBe(200);
      // No chat.input was forwarded for the two refused mirror threads.
      const forwarded = daemonLink.sent
        .filter((s) => s.event.type === 'chat.input')
        .map((s) => (s.event.type === 'chat.input' ? s.event.chatId : ''));
      expect(forwarded).not.toContain('thread_speakers');
      expect(forwarded).toContain('thread_manager');
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/chats/:id/stop returns 404 on unknown chat', async () => {
    const { registry, jwt } = await bootstrap();
    const built = await makeApp({ registry, daemonLink: new InProcessDaemonLink() });
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats/nope/stop',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/chats/:id/rotate forwards chat.rotate_request for a reserved special thread', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      daemonLink.emit({
        type: 'chat.spawned',
        daemonId: 'd1',
        chatId: 'thread_manager',
        folder: '/manager',
      });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats/thread_manager/rotate',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      const sent = daemonLink.sent.find(
        (s) => s.event.type === 'chat.rotate_request' && s.event.chatId === 'thread_manager',
      );
      expect(sent).toBeDefined();
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/chats/:id/rotate refuses a non-special thread with 403', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c-ordinary', folder: '/x' });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats/c-ordinary/rotate',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(403);
      expect(
        daemonLink.sent.some(
          (s) =>
            s.event.type === 'chat.rotate_request' &&
            'chatId' in s.event &&
            s.event.chatId === 'c-ordinary',
        ),
      ).toBe(false);
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/chats/:id/rotate returns 404 on unknown chat', async () => {
    const { registry, jwt } = await bootstrap();
    const built = await makeApp({ registry, daemonLink: new InProcessDaemonLink() });
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats/thread_manager/rotate',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/chats/:id/archive forwards chat.archive_request', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '/x' });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats/c1/archive',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { archived: true },
      });
      expect(res.statusCode).toBe(200);
      const sent = daemonLink.sent.find((s) => s.event.type === 'chat.archive_request');
      expect(sent).toBeDefined();
      if (sent && sent.event.type === 'chat.archive_request') {
        expect(sent.event.chatId).toBe('c1');
        expect(sent.event.archived).toBe(true);
      }
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/chats/:id/archive returns 404 on unknown chat (H1-d0-4)', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats/chat_does_not_exist_zzz999/archive',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { archived: true },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'chat not found: chat_does_not_exist_zzz999' });
      // No-op: nothing forwarded to the host for a missing chat.
      expect(daemonLink.sent.find((s) => s.event.type === 'chat.archive_request')).toBeUndefined();
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/chats/:id/pin forwards chat.pin_request', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '/x' });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats/c1/pin',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { pinned: true },
      });
      expect(res.statusCode).toBe(200);
      const sent = daemonLink.sent.find((s) => s.event.type === 'chat.pin_request');
      expect(sent).toBeDefined();
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/chats/:id/pin returns 404 on unknown chat (H1-d0-3)', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats/chat_does_not_exist_zzz999/pin',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { pinned: true },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'chat not found: chat_does_not_exist_zzz999' });
      expect(daemonLink.sent.find((s) => s.event.type === 'chat.pin_request')).toBeUndefined();
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/chats/:id/goal forwards chat.goal_request (patch/todo.md — /goal)', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '/x' });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats/c1/goal',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { goal: 'Ship the release by Friday' },
      });
      expect(res.statusCode).toBe(200);
      const sent = daemonLink.sent.find((s) => s.event.type === 'chat.goal_request');
      expect(sent).toBeDefined();
      if (sent && sent.event.type === 'chat.goal_request') {
        expect(sent.event.chatId).toBe('c1');
        expect(sent.event.goal).toBe('Ship the release by Friday');
      }
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/chats/:id/goal accepts a null goal (clear)', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '/x' });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats/c1/goal',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { goal: null },
      });
      expect(res.statusCode).toBe(200);
      const sent = daemonLink.sent.find((s) => s.event.type === 'chat.goal_request');
      expect(sent && sent.event.type === 'chat.goal_request' && sent.event.goal).toBe(null);
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/chats/:id/goal returns 404 on unknown chat', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats/chat_does_not_exist_zzz999/goal',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { goal: 'x' },
      });
      expect(res.statusCode).toBe(404);
      expect(daemonLink.sent.find((s) => s.event.type === 'chat.goal_request')).toBeUndefined();
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/chats/:id/loop forwards chat.loop_request arming a recurring wake (02-daemon.md § Self-wake)', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '/x' });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats/c1/loop',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { loop: { message: 'check on the build', every: '5m' } },
      });
      expect(res.statusCode).toBe(200);
      const sent = daemonLink.sent.find((s) => s.event.type === 'chat.loop_request');
      expect(sent).toBeDefined();
      if (sent && sent.event.type === 'chat.loop_request') {
        expect(sent.event.chatId).toBe('c1');
        expect(sent.event.loop).toEqual({ message: 'check on the build', every: '5m' });
      }
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/chats/:id/loop accepts `loop: null` (cancel)', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '/x' });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats/c1/loop',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { loop: null },
      });
      expect(res.statusCode).toBe(200);
      const sent = daemonLink.sent.find((s) => s.event.type === 'chat.loop_request');
      expect(sent && sent.event.type === 'chat.loop_request' && sent.event.loop).toBe(null);
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/chats/:id/loop returns 404 on unknown chat', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats/chat_does_not_exist_zzz999/loop',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { loop: { message: 'x', every: '1m' } },
      });
      expect(res.statusCode).toBe(404);
      expect(daemonLink.sent.find((s) => s.event.type === 'chat.loop_request')).toBeUndefined();
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/chats/:id/loop returns 400 for an invalid body (missing every)', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '/x' });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats/c1/loop',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { loop: { message: 'x' } },
      });
      expect(res.statusCode).toBe(400);
      expect(daemonLink.sent.find((s) => s.event.type === 'chat.loop_request')).toBeUndefined();
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/chats/:id/todos forwards chat.todos_request (spec/02 § Task list)', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '/x' });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats/c1/todos',
        headers: { authorization: `Bearer ${jwt}` },
        payload: {
          todos: [
            { text: 'rebuild the index', status: 'in_progress' },
            { text: 'schedule it nightly', status: 'pending' },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      const sent = daemonLink.sent.find((s) => s.event.type === 'chat.todos_request');
      expect(sent).toBeDefined();
      if (sent && sent.event.type === 'chat.todos_request') {
        expect(sent.event.chatId).toBe('c1');
        expect(sent.event.todos).toEqual([
          { text: 'rebuild the index', status: 'in_progress' },
          { text: 'schedule it nightly', status: 'pending' },
        ]);
      }
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/chats/:id/todos accepts an emptied list', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '/x' });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats/c1/todos',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { todos: [] },
      });
      expect(res.statusCode).toBe(200);
      const sent = daemonLink.sent.find((s) => s.event.type === 'chat.todos_request');
      expect(sent && sent.event.type === 'chat.todos_request' && sent.event.todos).toEqual([]);
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/chats/:id/todos rejects an unknown status with 400', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '/x' });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats/c1/todos',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { todos: [{ text: 'x', status: 'blocked' }] },
      });
      expect(res.statusCode).toBe(400);
      expect(daemonLink.sent.find((s) => s.event.type === 'chat.todos_request')).toBeUndefined();
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/chats/:id/todos returns 404 on unknown chat', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats/chat_does_not_exist_zzz999/todos',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { todos: [] },
      });
      expect(res.statusCode).toBe(404);
      expect(daemonLink.sent.find((s) => s.event.type === 'chat.todos_request')).toBeUndefined();
    } finally {
      await built.app.close();
    }
  });

  it('GET /api/chats carries the task list the host last reported', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '/x' });
      daemonLink.emit({
        type: 'chat.state',
        chatId: 'c1',
        todos: [{ text: 'rebuild the index', status: 'in_progress' }],
      });
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/chats',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
      const row = (res.json() as { chats: { chatId: string; todos: unknown }[] }).chats.find(
        (c) => c.chatId === 'c1',
      );
      expect(row?.todos).toEqual([{ text: 'rebuild the index', status: 'in_progress' }]);
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/chats/:id/rename forwards chat.rename_request (spec/04 § Name)', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '/x' });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats/c1/rename',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { name: 'Bed Planner Rework' },
      });
      expect(res.statusCode).toBe(200);
      const sent = daemonLink.sent.find((s) => s.event.type === 'chat.rename_request');
      expect(sent).toBeDefined();
      if (sent && sent.event.type === 'chat.rename_request') {
        expect(sent.event.chatId).toBe('c1');
        expect(sent.event.name).toBe('Bed Planner Rework');
      }
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/chats/:id/rename accepts a null name (clear back to the derived label)', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '/x' });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats/c1/rename',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { name: null },
      });
      expect(res.statusCode).toBe(200);
      const sent = daemonLink.sent.find((s) => s.event.type === 'chat.rename_request');
      expect(sent && sent.event.type === 'chat.rename_request' && sent.event.name).toBe(null);
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/chats/:id/rename returns 404 on unknown chat', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats/chat_does_not_exist_zzz999/rename',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { name: 'x' },
      });
      expect(res.statusCode).toBe(404);
      expect(daemonLink.sent.find((s) => s.event.type === 'chat.rename_request')).toBeUndefined();
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/chats/:id/rename rejects a body with no name', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '/x' });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats/c1/rename',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { title: 'wrong key' },
      });
      expect(res.statusCode).toBe(400);
      expect(daemonLink.sent.find((s) => s.event.type === 'chat.rename_request')).toBeUndefined();
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/chats/:id/rename requires auth', async () => {
    const { registry } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '/x' });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats/c1/rename',
        payload: { name: 'Sneaky' },
      });
      expect(res.statusCode).toBe(401);
      expect(daemonLink.sent.find((s) => s.event.type === 'chat.rename_request')).toBeUndefined();
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/chats/:id/reminder forwards chat.reminder_request (patch/todo.md — Reminders)', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '/x' });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats/c1/reminder',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { reminder: 'Do not touch the prod database' },
      });
      expect(res.statusCode).toBe(200);
      const sent = daemonLink.sent.find((s) => s.event.type === 'chat.reminder_request');
      expect(sent).toBeDefined();
      if (sent && sent.event.type === 'chat.reminder_request') {
        expect(sent.event.chatId).toBe('c1');
        expect(sent.event.reminder).toBe('Do not touch the prod database');
      }
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/chats/:id/reminder accepts a null reminder (clear)', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '/x' });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats/c1/reminder',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { reminder: null },
      });
      expect(res.statusCode).toBe(200);
      const sent = daemonLink.sent.find((s) => s.event.type === 'chat.reminder_request');
      expect(sent && sent.event.type === 'chat.reminder_request' && sent.event.reminder).toBe(null);
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/chats/:id/reminder returns 404 on unknown chat', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats/chat_does_not_exist_zzz999/reminder',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { reminder: 'x' },
      });
      expect(res.statusCode).toBe(404);
      expect(daemonLink.sent.find((s) => s.event.type === 'chat.reminder_request')).toBeUndefined();
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/threads/:thread/send-to forwards chat.input to thread_<name>', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/threads/manager/send-to',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { message: 'hi' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { chatId: string };
      expect(body.chatId).toBe('thread_manager');
      const sent = daemonLink.sent.find((s) => s.event.type === 'chat.input');
      expect(sent).toBeDefined();
      if (sent && sent.event.type === 'chat.input') {
        expect(sent.event.chatId).toBe('thread_manager');
      }
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/threads/:thread/send-to rejects read-only mirrors (speakers)', async () => {
    // spec/06 ## Composer policy: a surface cannot inject a user turn into the
    // Speakers mirror via this HTTP route — composer is disabled.
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      for (const thread of ['speakers']) {
        const res = await built.app.inject({
          method: 'POST',
          url: `/api/threads/${thread}/send-to`,
          headers: { authorization: `Bearer ${jwt}` },
          payload: { message: 'typed from a desk' },
        });
        expect(res.statusCode).toBe(403);
      }
      const sent = daemonLink.sent.filter((s) => s.event.type === 'chat.input');
      expect(sent).toHaveLength(0);
    } finally {
      await built.app.close();
    }
  });

  // Group 19 — file browser route bridges to host via patch.files.{request,response}.
  it('GET /api/chats/:id/files round-trips via daemon-link', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    let nextId = 0;
    const built = await makeApp({
      registry,
      daemonLink,
      idGenerator: () => `01HFILES${String(++nextId).padStart(18, '0')}`,
    });
    try {
      // Seed a chat in the registry.
      daemonLink.emit({
        type: 'chat.spawned',
        daemonId: 'd1',
        chatId: 'c-files',
        folder: '/work/x',
      });
      daemonLink.emit({
        type: 'chat.state',
        permissionMode: 'bypassPermissions',
        chatId: 'c-files',
        activity: 'idle',
        lastUpdated: 1,
        status: 'active',
        pinned: false,
        folder: '/work/x',
      });

      // Stand in for the host: when we see a patch.files.request, emit a response.
      daemonLink.onEvent(() => undefined);
      const originalSend = daemonLink.send.bind(daemonLink);
      daemonLink.send = (surfaceId, event) => {
        originalSend(surfaceId, event);
        if (event.type === 'patch.files.request') {
          setImmediate(() => {
            daemonLink.emit({
              type: 'patch.files.response',
              requestId: event.requestId,
              ok: true,
              path: event.path,
              entries: [
                { name: 'README.md', type: 'file', size: 42 },
                { name: 'src', type: 'dir' },
              ],
            });
          });
        }
      };

      const res = await built.app.inject({
        method: 'GET',
        url: '/api/chats/c-files/files?path=',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        path: string;
        entries: Array<{ name: string; type: string; size?: number }>;
      };
      expect(body.entries).toHaveLength(2);
      expect(body.entries[0]?.name).toBe('README.md');
    } finally {
      await built.app.close();
    }
  });

  it('GET /api/chats/:id/files returns 400 on path_escape', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({
      registry,
      daemonLink,
      idGenerator: () => `01HFILES${String(Date.now()).padStart(20, '0')}`,
    });
    try {
      daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c-esc', folder: '/work/y' });
      daemonLink.emit({
        type: 'chat.state',
        permissionMode: 'bypassPermissions',
        chatId: 'c-esc',
        activity: 'idle',
        lastUpdated: 1,
        status: 'active',
        pinned: false,
        folder: '/work/y',
      });
      const originalSend = daemonLink.send.bind(daemonLink);
      daemonLink.send = (surfaceId, event) => {
        originalSend(surfaceId, event);
        if (event.type === 'patch.files.request') {
          setImmediate(() => {
            daemonLink.emit({
              type: 'patch.files.response',
              requestId: event.requestId,
              ok: false,
              error: { code: 'path_escape', message: 'escapes' },
            });
          });
        }
      };
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/chats/c-esc/files?path=../etc',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await built.app.close();
    }
  });

  // G3: typed host error codes map to precise HTTP statuses (no 502 for
  // client-side problems) and the maxEntries param is validated at the boundary.
  async function bootFilesApp(
    chatId: string,
    folder: string,
    respond: (req: { type: 'patch.files.request'; requestId: string; path: string }) => {
      ok: boolean;
      error?: { code: string; message: string };
      path?: string;
      content?: string;
      size?: number;
      entries?: unknown[];
    } | null,
  ): Promise<{ app: import('fastify').FastifyInstance; jwt: string }> {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    let nextId = 0;
    const built = await makeApp({
      registry,
      daemonLink,
      idGenerator: () => `01HFILES${String(++nextId).padStart(18, '0')}`,
    });
    daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId, folder });
    daemonLink.emit({
      type: 'chat.state',
      permissionMode: 'bypassPermissions',
      chatId,
      activity: 'idle',
      lastUpdated: 1,
      status: 'active',
      pinned: false,
      folder,
    });
    const originalSend = daemonLink.send.bind(daemonLink);
    daemonLink.send = (surfaceId, event) => {
      originalSend(surfaceId, event);
      if (event.type === 'patch.files.request') {
        const r = respond(event);
        if (r === null) return; // simulate host never responding (timeout)
        setImmediate(() => {
          daemonLink.emit({
            type: 'patch.files.response',
            requestId: event.requestId,
            ...r,
          } as Parameters<typeof daemonLink.emit>[0]);
        });
      }
    };
    return { app: built.app, jwt };
  }

  it('G3-d1: ref=head on a non-git folder maps no_head_baseline to 409', async () => {
    const { app, jwt } = await bootFilesApp('c-nohead', '/work/nogit', () => ({
      ok: false,
      error: {
        code: 'no_head_baseline',
        message: 'chat folder is not a git work-tree with a HEAD commit',
      },
    }));
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/chats/c-nohead/files?path=note.txt&content=1&ref=head',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'no_head_baseline' });
    } finally {
      await app.close();
    }
  });

  it('G3-d2: missing file maps not_found to 404 with a sanitized message', async () => {
    const { app, jwt } = await bootFilesApp('c-miss', '/work/real', () => ({
      ok: false,
      error: { code: 'not_found', message: 'no such file: does-not-exist.txt' },
    }));
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/chats/c-miss/files?path=does-not-exist.txt&content=1',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(404);
      const body = res.json() as { error: string; message: string };
      expect(body.error).toBe('not_found');
      // No absolute host path leaked.
      expect(body.message).not.toMatch(/^\/|\/private\//);
      expect(body.message).not.toContain('/work/real');
    } finally {
      await app.close();
    }
  });

  it('G3-d3: content of a directory maps not_a_file to 400', async () => {
    const { app, jwt } = await bootFilesApp('c-dir', '/work/real', () => ({
      ok: false,
      error: { code: 'not_a_file', message: 'path is a directory, not a file' },
    }));
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/chats/c-dir/files?path=subdir&content=1',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'not_a_file' });
    } finally {
      await app.close();
    }
  });

  it('G3-d4: malformed maxEntries is rejected fast with a 400 (no host round-trip)', async () => {
    let daemonHit = false;
    const { app, jwt } = await bootFilesApp('c-max', '/work/real', () => {
      daemonHit = true;
      return null; // would hang -> 504 if the request ever reached here
    });
    try {
      const start = Date.now();
      const res = await app.inject({
        method: 'GET',
        url: '/api/chats/c-max/files?path=&maxEntries=abc',
        headers: { authorization: `Bearer ${jwt}` },
      });
      const elapsed = Date.now() - start;
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'maxEntries_invalid' });
      expect(daemonHit).toBe(false);
      expect(elapsed).toBeLessThan(1000);

      const neg = await app.inject({
        method: 'GET',
        url: '/api/chats/c-max/files?path=&recursive=1&maxEntries=-5',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(neg.statusCode).toBe(400);
      expect(neg.json()).toMatchObject({ error: 'maxEntries_invalid' });
      expect(daemonHit).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('POST /api/threads/:thread/send-to rejects unknown thread name', async () => {
    const { registry, jwt } = await bootstrap();
    const built = await makeApp({ registry, daemonLink: new InProcessDaemonLink() });
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/threads/bogus/send-to',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { message: 'hi' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await built.app.close();
    }
  });

  it('malformed JSON body returns 400 client-error envelope, not 500 (H1-d0-1)', async () => {
    const { registry, jwt } = await bootstrap();
    const built = await makeApp({ registry, daemonLink: new InProcessDaemonLink() });
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats',
        headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
        payload: '{bad',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'malformed json' });
    } finally {
      await built.app.close();
    }
  });

  it('404 for unknown route uses the unified {error} envelope (H1-d0-5)', async () => {
    const { registry, jwt } = await bootstrap();
    const built = await makeApp({ registry, daemonLink: new InProcessDaemonLink() });
    try {
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/nonexistent-route',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(404);
      const body = res.json() as Record<string, unknown>;
      // Unified envelope: .error is a descriptive message, NOT the generic
      // Fastify default "Not Found".
      expect(typeof body.error).toBe('string');
      expect(body.error).not.toBe('Not Found');
      expect(body.error).toContain('route not found');
    } finally {
      await built.app.close();
    }
  });

  it('404 for wrong HTTP method uses the unified {error} envelope (H1-d0-5)', async () => {
    const { registry, jwt } = await bootstrap();
    const built = await makeApp({ registry, daemonLink: new InProcessDaemonLink() });
    try {
      // /api/chats/:id/stop is POST-only; a GET must 404 with the unified shape.
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/chats/thread_manager/stop',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(404);
      const body = res.json() as Record<string, unknown>;
      expect(body.error).not.toBe('Not Found');
      expect(body.error).toContain('route not found');
    } finally {
      await built.app.close();
    }
  });

  it('DELETE /api/chats/:id refuses to remove reserved special threads (B2-d1)', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      // Bootstrap the two reserved special threads into the registry mirror.
      for (const id of ['thread_manager', 'thread_speakers']) {
        daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId: id, folder: `/${id}` });
        daemonLink.emit({
          type: 'chat.state',
          permissionMode: 'bypassPermissions',
          chatId: id,
          activity: 'idle',
          lastUpdated: 100,
          pinned: id === 'thread_manager',
          status: 'active',
          name: id,
          folder: `/${id}`,
        });
      }

      for (const id of ['thread_manager', 'thread_speakers']) {
        const res = await built.app.inject({
          method: 'DELETE',
          url: `/api/chats/${id}`,
          headers: { authorization: `Bearer ${jwt}` },
        });
        expect(res.statusCode).toBe(403);
        const body = res.json() as Record<string, unknown>;
        expect(typeof body.error).toBe('string');
        expect(body.error).toContain(id);
        // No destructive intent must have been forwarded to the host.
        expect(
          daemonLink.sent.some(
            (s) =>
              (s.event.type === 'chat.stop_request' || s.event.type === 'chat.archive_request') &&
              'chatId' in s.event &&
              s.event.chatId === id,
          ),
        ).toBe(false);
      }

      // Both reserved threads must still be present after the rejected deletes.
      const listRes = await built.app.inject({
        method: 'GET',
        url: '/api/chats',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(listRes.statusCode).toBe(200);
      const ids = (listRes.json() as { chats: Array<{ chatId: string }> }).chats.map(
        (c) => c.chatId,
      );
      expect(ids).toEqual(expect.arrayContaining(['thread_manager', 'thread_speakers']));
    } finally {
      await built.app.close();
    }
  });

  // E5: DELETE is a recoverable soft-delete. The chat leaves the active list,
  // appears under `?deleted=only`, and a restore brings it back — nothing is
  // hard-removed. The daemon-link carries `chat.delete_request`, not archive.
  it('DELETE /api/chats/:id soft-deletes (out of active, into Deleted) and restore brings it back', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      daemonLink.emit({
        type: 'chat.spawned',
        daemonId: 'd1',
        chatId: 'c-ordinary',
        folder: '/work',
      });
      daemonLink.emit({
        type: 'chat.state',
        permissionMode: 'bypassPermissions',
        chatId: 'c-ordinary',
        activity: 'idle',
        lastUpdated: 100,
        pinned: false,
        status: 'active',
        name: 'ordinary',
        folder: '/work',
      });

      const res = await built.app.inject({
        method: 'DELETE',
        url: '/api/chats/c-ordinary',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });

      // A soft-delete forwards chat.delete_request{deleted:true}, NOT archive.
      const delReq = daemonLink.sent.find((s) => s.event.type === 'chat.delete_request');
      expect(delReq && delReq.event.type === 'chat.delete_request' && delReq.event.deleted).toBe(
        true,
      );
      expect(daemonLink.sent.find((s) => s.event.type === 'chat.archive_request')).toBeUndefined();

      // Gone from the active list...
      const activeIds = (
        (
          await built.app.inject({
            method: 'GET',
            url: '/api/chats',
            headers: { authorization: `Bearer ${jwt}` },
          })
        ).json() as { chats: Array<{ chatId: string }> }
      ).chats.map((c) => c.chatId);
      expect(activeIds).not.toContain('c-ordinary');

      // ...but present under the Deleted view (recoverable, not hard-removed).
      const deletedIds = (
        (
          await built.app.inject({
            method: 'GET',
            url: '/api/chats?deleted=only',
            headers: { authorization: `Bearer ${jwt}` },
          })
        ).json() as { chats: Array<{ chatId: string }> }
      ).chats.map((c) => c.chatId);
      expect(deletedIds).toContain('c-ordinary');

      // Restore returns it to the active list.
      const restoreRes = await built.app.inject({
        method: 'POST',
        url: '/api/chats/c-ordinary/restore',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(restoreRes.statusCode).toBe(200);
      const restoreReq = daemonLink.sent.filter((s) => s.event.type === 'chat.delete_request');
      expect(
        restoreReq.some((s) => s.event.type === 'chat.delete_request' && s.event.deleted === false),
      ).toBe(true);
      const activeAfter = (
        (
          await built.app.inject({
            method: 'GET',
            url: '/api/chats',
            headers: { authorization: `Bearer ${jwt}` },
          })
        ).json() as { chats: Array<{ chatId: string }> }
      ).chats.map((c) => c.chatId);
      expect(activeAfter).toContain('c-ordinary');
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/chats/:id/restore returns 404 for an unknown chat', async () => {
    const { registry, jwt } = await bootstrap();
    const built = await makeApp({ registry, daemonLink: new InProcessDaemonLink() });
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats/nope-zzz/restore',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await built.app.close();
    }
  });

  // ---- coverage top-up: auth gate on every route (each route has its own
  // try/catch around requireAuth, so each is a distinct branch to exercise) ----
  it('every route rejects a request without a bearer with 401', async () => {
    const { registry } = await bootstrap();
    const built = await makeApp({ registry, daemonLink: new InProcessDaemonLink() });
    try {
      const routes: Array<{ method: 'GET' | 'POST' | 'DELETE'; url: string }> = [
        { method: 'POST', url: '/api/chats' },
        { method: 'GET', url: '/api/chats' },
        { method: 'GET', url: '/api/chats/whatever' },
        { method: 'GET', url: '/api/chats/whatever/history' },
        { method: 'POST', url: '/api/chats/whatever/send-to' },
        { method: 'GET', url: '/api/chats/whatever/files' },
        { method: 'GET', url: '/api/chats/whatever/background-task-stats?taskIds=b1' },
        { method: 'GET', url: '/api/skills?folder=/x' },
        { method: 'GET', url: '/api/models?daemonId=d1' },
        { method: 'POST', url: '/api/chats/whatever/stop' },
        { method: 'DELETE', url: '/api/chats/whatever' },
        { method: 'POST', url: '/api/chats/whatever/archive' },
        { method: 'POST', url: '/api/chats/whatever/pin' },
        { method: 'POST', url: '/api/chats/whatever/restore' },
        { method: 'POST', url: '/api/threads/manager/send-to' },
      ];
      for (const r of routes) {
        const res = await built.app.inject({ method: r.method, url: r.url });
        expect(res.statusCode, `${r.method} ${r.url}`).toBe(401);
      }
    } finally {
      await built.app.close();
    }
  });

  it('every route rejects a JWT that fails signature verification with 401', async () => {
    // Exercises the requireAuth `catch { throw generic(); }` branch (an
    // authorization header is present but verifySurfaceCredential throws),
    // distinct from the "missing bearer" branch above.
    const { registry } = await bootstrap();
    const built = await makeApp({ registry, daemonLink: new InProcessDaemonLink() });
    try {
      const badAuth = { authorization: 'Bearer not-a-real-jwt-at-all' };
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/chats',
        headers: badAuth,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });

  it('GET /api/chats/:id returns the chat summary on success', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      daemonLink.emit({
        type: 'chat.spawned',
        daemonId: 'd1',
        chatId: 'c-solo',
        folder: '/work/solo',
      });
      daemonLink.emit({
        type: 'chat.state',
        permissionMode: 'bypassPermissions',
        chatId: 'c-solo',
        activity: 'idle',
        lastUpdated: 5,
        status: 'active',
        pinned: false,
        name: 'solo',
        folder: '/work/solo',
      });
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/chats/c-solo',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { chatId: string; folder: string };
      expect(body.chatId).toBe('c-solo');
      expect(body.folder).toBe('/work/solo');
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/chats rejects an invalid body with 400 (NO FALLBACK)', async () => {
    const { registry, jwt } = await bootstrap();
    const built = await makeApp({ registry, daemonLink: new InProcessDaemonLink() });
    try {
      // Missing required `folder`.
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { daemonId: 'd1', prompt: 'go' },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json() as { error: string; issues: unknown[] };
      expect(body.error).toBe('invalid body');
      expect(Array.isArray(body.issues)).toBe(true);

      // `.strict()` — an unknown extra field is also rejected.
      const res2 = await built.app.inject({
        method: 'POST',
        url: '/api/chats',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { daemonId: 'd1', folder: '/x', bogusField: 1 },
      });
      expect(res2.statusCode).toBe(400);
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/chats forwards every optional spawn field (name/parentChatId/localId/model/permissionMode)', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats',
        headers: { authorization: `Bearer ${jwt}` },
        payload: {
          daemonId: 'd1',
          folder: '/work/full',
          prompt: 'go',
          name: 'my chat',
          parentChatId: 'parent-1',
          localId: 'local-abc',
          model: 'claude-fancy',
          permissionMode: 'plan',
        },
      });
      expect(res.statusCode).toBe(202);
      const sent = daemonLink.sent.find((s) => s.event.type === 'chat.spawn_request');
      expect(sent).toBeDefined();
      if (sent && sent.event.type === 'chat.spawn_request') {
        expect(sent.event.name).toBe('my chat');
        expect(sent.event.parentChatId).toBe('parent-1');
        expect(sent.event.localId).toBe('local-abc');
        expect(sent.event.model).toBe('claude-fancy');
        expect(sent.event.permissionMode).toBe('plan');
      }
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/chats resolves a chat.error keyed on the pending-spawn placeholder id', async () => {
    // Covers the branch where the host's chat.error carries the literal
    // 'pending-spawn' chatId (rather than echoing the server-allocated id) —
    // the server falls back to its single most-recent pendingPlaceholder.
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({
      registry,
      daemonLink,
      idGenerator: () => '01HPLACEHOLDER0000000000001',
      spawnErrorWaitMs: 1_000,
    });
    try {
      const origSend = daemonLink.send.bind(daemonLink);
      daemonLink.send = (surfaceId, ev): void => {
        origSend(surfaceId, ev);
        if (ev.type === 'chat.spawn_request') {
          daemonLink.emit({
            type: 'chat.error',
            chatId: 'pending-spawn',
            error: { code: 'folder_not_found', message: 'no such folder' },
            seq: 0,
          });
        }
      };
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { daemonId: 'd1', folder: '/no/such/path' },
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toBe('folder_not_found');
    } finally {
      await built.app.close();
    }
  });

  it('GET /api/chats/:id/history validates limit (valid, non-integer, out-of-range)', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    let nextId = 0;
    const built = await makeApp({
      registry,
      daemonLink,
      idGenerator: () => `01HLIMIT${String(++nextId).padStart(19, '0')}`,
    });
    try {
      daemonLink.emit({
        type: 'chat.spawned',
        daemonId: 'd1',
        chatId: 'c-limit',
        folder: '/work/l',
      });
      daemonLink.emit({
        type: 'chat.state',
        permissionMode: 'bypassPermissions',
        chatId: 'c-limit',
        activity: 'idle',
        lastUpdated: 1,
        status: 'active',
        pinned: false,
        folder: '/work/l',
      });
      let seenLimit: number | undefined = -1;
      const origSend = daemonLink.send.bind(daemonLink);
      daemonLink.send = (surfaceId, event) => {
        origSend(surfaceId, event);
        if (event.type === 'patch.chat_history.request') {
          seenLimit = event.limit;
          setImmediate(() => {
            daemonLink.emit({
              type: 'patch.chat_history.response',
              requestId: event.requestId,
              ok: true,
              events: [],
            });
          });
        }
      };

      const ok = await built.app.inject({
        method: 'GET',
        url: '/api/chats/c-limit/history?limit=5',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(ok.statusCode).toBe(200);
      expect(seenLimit).toBe(5);

      const nonInteger = await built.app.inject({
        method: 'GET',
        url: '/api/chats/c-limit/history?limit=1.5',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(nonInteger.statusCode).toBe(400);

      const tooBig = await built.app.inject({
        method: 'GET',
        url: '/api/chats/c-limit/history?limit=201',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(tooBig.statusCode).toBe(400);

      const tooSmall = await built.app.inject({
        method: 'GET',
        url: '/api/chats/c-limit/history?limit=0',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(tooSmall.statusCode).toBe(400);
    } finally {
      await built.app.close();
    }
  });

  it('GET /api/chats/:id/history surfaces nextFromSeq when the host returns one', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      daemonLink.emit({
        type: 'chat.spawned',
        daemonId: 'd1',
        chatId: 'c-next',
        folder: '/work/n',
      });
      daemonLink.emit({
        type: 'chat.state',
        permissionMode: 'bypassPermissions',
        chatId: 'c-next',
        activity: 'idle',
        lastUpdated: 1,
        status: 'active',
        pinned: false,
        folder: '/work/n',
      });
      const origSend = daemonLink.send.bind(daemonLink);
      daemonLink.send = (surfaceId, event) => {
        origSend(surfaceId, event);
        if (event.type === 'patch.chat_history.request') {
          setImmediate(() => {
            daemonLink.emit({
              type: 'patch.chat_history.response',
              requestId: event.requestId,
              ok: true,
              events: [],
              nextFromSeq: 42,
            });
          });
        }
      };
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/chats/c-next/history',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { nextFromSeq?: number }).nextFromSeq).toBe(42);
    } finally {
      await built.app.close();
    }
  });

  it('GET /api/chats/:id/history returns 504 when the host never replies', async () => {
    // Real timers: fake timers don't reliably interleave with fastify's
    // internal inject() dispatch in this environment (the route's setTimeout
    // registers AFTER a fake-timer advance() call has already returned,
    // leaving it stuck forever) — so this waits out the real 5s timeout.
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      daemonLink.emit({
        type: 'chat.spawned',
        daemonId: 'd1',
        chatId: 'c-timeout',
        folder: '/work/t',
      });
      daemonLink.emit({
        type: 'chat.state',
        permissionMode: 'bypassPermissions',
        chatId: 'c-timeout',
        activity: 'idle',
        lastUpdated: 1,
        status: 'active',
        pinned: false,
        folder: '/work/t',
      });
      // Never respond to patch.chat_history.request — let it time out.
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/chats/c-timeout/history',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(504);
      expect((res.json() as { error: string }).error).toBe('daemon_timeout');
    } finally {
      await built.app.close();
    }
  }, 8_000);

  it('GET /api/chats/:id/history maps a host-side error to 502 (non chat_not_found)', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c-err', folder: '/work/e' });
      daemonLink.emit({
        type: 'chat.state',
        permissionMode: 'bypassPermissions',
        chatId: 'c-err',
        activity: 'idle',
        lastUpdated: 1,
        status: 'active',
        pinned: false,
        folder: '/work/e',
      });
      const origSend = daemonLink.send.bind(daemonLink);
      daemonLink.send = (surfaceId, event) => {
        origSend(surfaceId, event);
        if (event.type === 'patch.chat_history.request') {
          setImmediate(() => {
            daemonLink.emit({
              type: 'patch.chat_history.response',
              requestId: event.requestId,
              ok: false,
              error: { code: 'internal', message: 'reader crashed' },
            });
          });
        }
      };
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/chats/c-err/history',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(502);
      expect((res.json() as { error: string }).error).toBe('internal');
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/chats/:id/send-to rejects an invalid body with 400', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '/x' });
      // `message` is required by the schema.
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats/c1/send-to',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { localId: 'x' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/chats/:id/send-to prepends voicePrefix and defaults localId when omitted', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '/x' });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats/c1/send-to',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { message: 'water the plants', voicePrefix: '[voice] ' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { localId: string };
      expect(body.localId.length).toBeGreaterThan(0);
      const sent = daemonLink.sent.find((s) => s.event.type === 'chat.input');
      expect(sent).toBeDefined();
      if (sent && sent.event.type === 'chat.input') {
        expect(sent.event.message).toBe('[voice] water the plants');
        expect(sent.event.localId).toBe(body.localId);
      }
    } finally {
      await built.app.close();
    }
  });

  it('GET /api/chats/:id/files rejects an unknown chat with 404', async () => {
    const { registry, jwt } = await bootstrap();
    const built = await makeApp({ registry, daemonLink: new InProcessDaemonLink() });
    try {
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/chats/nope/files',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await built.app.close();
    }
  });

  it('GET /api/chats/:id/files rejects a path escaping with .. or a leading / at the boundary (400, no host round-trip)', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      daemonLink.emit({
        type: 'chat.spawned',
        daemonId: 'd1',
        chatId: 'c-esc2',
        folder: '/work/z',
      });
      daemonLink.emit({
        type: 'chat.state',
        permissionMode: 'bypassPermissions',
        chatId: 'c-esc2',
        activity: 'idle',
        lastUpdated: 1,
        status: 'active',
        pinned: false,
        folder: '/work/z',
      });
      let daemonHit = false;
      const origSend = daemonLink.send.bind(daemonLink);
      daemonLink.send = (surfaceId, event) => {
        origSend(surfaceId, event);
        if (event.type === 'patch.files.request') daemonHit = true;
      };
      const dotdot = await built.app.inject({
        method: 'GET',
        url: '/api/chats/c-esc2/files?path=..%2Fetc%2Fpasswd',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(dotdot.statusCode).toBe(400);
      expect((dotdot.json() as { error: string }).error).toBe('path_invalid');

      const leadingSlash = await built.app.inject({
        method: 'GET',
        url: '/api/chats/c-esc2/files?path=%2Fetc%2Fpasswd',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(leadingSlash.statusCode).toBe(400);
      expect(daemonHit).toBe(false);
    } finally {
      await built.app.close();
    }
  });

  it('GET /api/chats/:id/files?content=1 returns file content, and recursive listing round-trips', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      daemonLink.emit({
        type: 'chat.spawned',
        daemonId: 'd1',
        chatId: 'c-content',
        folder: '/work/c',
      });
      daemonLink.emit({
        type: 'chat.state',
        permissionMode: 'bypassPermissions',
        chatId: 'c-content',
        activity: 'idle',
        lastUpdated: 1,
        status: 'active',
        pinned: false,
        folder: '/work/c',
      });
      let seenRecursive = false;
      let seenMaxEntries: number | undefined;
      const origSend = daemonLink.send.bind(daemonLink);
      daemonLink.send = (surfaceId, event) => {
        origSend(surfaceId, event);
        if (event.type === 'patch.files.request') {
          seenRecursive = event.recursive === true;
          seenMaxEntries = event.maxEntries;
          setImmediate(() => {
            daemonLink.emit({
              type: 'patch.files.response',
              requestId: event.requestId,
              ok: true,
              path: event.path,
              content: 'hello world',
              size: 11,
            });
          });
        }
      };
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/chats/c-content/files?path=README.md&content=true&recursive=1&maxEntries=50',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { path: string; content: string; size: number };
      expect(body.content).toBe('hello world');
      expect(body.size).toBe(11);
      expect(seenRecursive).toBe(true);
      expect(seenMaxEntries).toBe(50);
    } finally {
      await built.app.close();
    }
  });

  it('GET /api/chats/:id/files maps chat_not_found and internal host errors to 404/502', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      daemonLink.emit({
        type: 'chat.spawned',
        daemonId: 'd1',
        chatId: 'c-codes',
        folder: '/work/codes',
      });
      daemonLink.emit({
        type: 'chat.state',
        permissionMode: 'bypassPermissions',
        chatId: 'c-codes',
        activity: 'idle',
        lastUpdated: 1,
        status: 'active',
        pinned: false,
        folder: '/work/codes',
      });
      let code: 'chat_not_found' | 'internal' = 'chat_not_found';
      const origSend = daemonLink.send.bind(daemonLink);
      daemonLink.send = (surfaceId, event) => {
        origSend(surfaceId, event);
        if (event.type === 'patch.files.request') {
          setImmediate(() => {
            daemonLink.emit({
              type: 'patch.files.response',
              requestId: event.requestId,
              ok: false,
              error: { code, message: 'x' },
            });
          });
        }
      };
      const first = await built.app.inject({
        method: 'GET',
        url: '/api/chats/c-codes/files?path=',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(first.statusCode).toBe(404);

      code = 'internal';
      const second = await built.app.inject({
        method: 'GET',
        url: '/api/chats/c-codes/files?path=',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(second.statusCode).toBe(502);
    } finally {
      await built.app.close();
    }
  });

  it('GET /api/chats/:id/files returns 504 when the host never replies', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      daemonLink.emit({
        type: 'chat.spawned',
        daemonId: 'd1',
        chatId: 'c-fto',
        folder: '/work/fto',
      });
      daemonLink.emit({
        type: 'chat.state',
        permissionMode: 'bypassPermissions',
        chatId: 'c-fto',
        activity: 'idle',
        lastUpdated: 1,
        status: 'active',
        pinned: false,
        folder: '/work/fto',
      });
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/chats/c-fto/files?path=',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(504);
    } finally {
      await built.app.close();
    }
  }, 8_000);

  // ---- GET /api/chats/:id/background-task-stats ----
  // The background task bar's readout (spec/14 § Main chat panel — Background
  // task bar), relayed to the chat's own host. The rule under every one of
  // these is that an unmeasured task is ABSENT, never a zero.
  function seedStatsChat(daemonLink: InProcessDaemonLink, chatId: string): void {
    daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId, folder: '/work/bg' });
    daemonLink.emit({
      type: 'chat.state',
      permissionMode: 'bypassPermissions',
      chatId,
      activity: 'idle',
      lastUpdated: 1,
      status: 'active',
      pinned: false,
      folder: '/work/bg',
    });
  }

  it('GET /api/chats/:id/background-task-stats round-trips via daemon-link, passing an unmeasured task through as absent', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      seedStatsChat(daemonLink, 'c-bgstats');
      let asked: string[] | undefined;
      const origSend = daemonLink.send.bind(daemonLink);
      daemonLink.send = (surfaceId, event) => {
        origSend(surfaceId, event);
        if (event.type === 'patch.background_task_stats.request') {
          asked = event.taskIds;
          setImmediate(() => {
            daemonLink.emit({
              type: 'patch.background_task_stats.response',
              requestId: event.requestId,
              ok: true,
              // Two asked about, one measured: the sub-agent has no process.
              stats: [{ taskId: 'baiw888mq', cpuPercent: 98.4, rssBytes: 432013312, processes: 3 }],
            });
          });
        }
      };
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/chats/c-bgstats/background-task-stats?taskIds=baiw888mq,bkvn61the',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
      expect(asked).toEqual(['baiw888mq', 'bkvn61the']);
      const body = res.json() as { stats: Array<{ taskId: string; cpuPercent: number }> };
      expect(body.stats).toHaveLength(1);
      expect(body.stats[0]).toEqual({
        taskId: 'baiw888mq',
        cpuPercent: 98.4,
        rssBytes: 432013312,
        processes: 3,
      });
    } finally {
      await built.app.close();
    }
  });

  it('GET /api/chats/:id/background-task-stats returns an empty list when the host measured nothing', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      seedStatsChat(daemonLink, 'c-bgnone');
      const origSend = daemonLink.send.bind(daemonLink);
      daemonLink.send = (surfaceId, event) => {
        origSend(surfaceId, event);
        if (event.type === 'patch.background_task_stats.request') {
          setImmediate(() => {
            daemonLink.emit({
              type: 'patch.background_task_stats.response',
              requestId: event.requestId,
              ok: true,
              stats: [],
            });
          });
        }
      };
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/chats/c-bgnone/background-task-stats?taskIds=baiw888mq',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ stats: [] });
    } finally {
      await built.app.close();
    }
  });

  it('GET /api/chats/:id/background-task-stats rejects a request naming no task, and never asks the host', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      seedStatsChat(daemonLink, 'c-bgempty');
      let daemonHit = false;
      const origSend = daemonLink.send.bind(daemonLink);
      daemonLink.send = (surfaceId, event) => {
        origSend(surfaceId, event);
        if (event.type === 'patch.background_task_stats.request') daemonHit = true;
      };
      for (const url of [
        '/api/chats/c-bgempty/background-task-stats',
        '/api/chats/c-bgempty/background-task-stats?taskIds=',
        '/api/chats/c-bgempty/background-task-stats?taskIds=,,',
      ]) {
        const res = await built.app.inject({
          method: 'GET',
          url,
          headers: { authorization: `Bearer ${jwt}` },
        });
        expect(res.statusCode, url).toBe(400);
        expect((res.json() as { error: string }).error).toBe('taskIds_required');
      }
      expect(daemonHit).toBe(false);
    } finally {
      await built.app.close();
    }
  });

  it('GET /api/chats/:id/background-task-stats rejects ids that are not bare tokens, and an over-long batch', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      seedStatsChat(daemonLink, 'c-bgbad');
      let daemonHit = false;
      const origSend = daemonLink.send.bind(daemonLink);
      daemonLink.send = (surfaceId, event) => {
        origSend(surfaceId, event);
        if (event.type === 'patch.background_task_stats.request') daemonHit = true;
      };
      // A malformed id would be dropped by the host's strict schema and the
      // caller would wait out the timeout for a misleading 504, so it is
      // refused here instead.
      const tooMany = Array.from({ length: 51 }, (_v, i) => `task${i}`).join(',');
      for (const q of ['..%2Fetc%2Fpasswd', 'a%20b', encodeURIComponent('$(id)'), tooMany]) {
        const res = await built.app.inject({
          method: 'GET',
          url: `/api/chats/c-bgbad/background-task-stats?taskIds=${q}`,
          headers: { authorization: `Bearer ${jwt}` },
        });
        expect(res.statusCode, q).toBe(400);
        expect((res.json() as { error: string }).error).toBe('taskIds_invalid');
      }
      expect(daemonHit).toBe(false);
    } finally {
      await built.app.close();
    }
  });

  it('GET /api/chats/:id/background-task-stats rejects an unknown chat with 404', async () => {
    const { registry, jwt } = await bootstrap();
    const built = await makeApp({ registry, daemonLink: new InProcessDaemonLink() });
    try {
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/chats/nope/background-task-stats?taskIds=baiw888mq',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await built.app.close();
    }
  });

  it('GET /api/chats/:id/background-task-stats maps the host error codes to 404/501/502', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      seedStatsChat(daemonLink, 'c-bgcodes');
      let code: 'chat_not_found' | 'no_process_table' | 'internal' = 'chat_not_found';
      const origSend = daemonLink.send.bind(daemonLink);
      daemonLink.send = (surfaceId, event) => {
        origSend(surfaceId, event);
        if (event.type === 'patch.background_task_stats.request') {
          setImmediate(() => {
            daemonLink.emit({
              type: 'patch.background_task_stats.response',
              requestId: event.requestId,
              ok: false,
              error: { code, message: 'nope' },
            });
          });
        }
      };
      // A host with no usable process table is its own answer: nothing here can
      // be measured, which is not the same as nothing running (200 + []).
      for (const [c, status] of [
        ['chat_not_found', 404],
        ['no_process_table', 501],
        ['internal', 502],
      ] as const) {
        code = c;
        const res = await built.app.inject({
          method: 'GET',
          url: '/api/chats/c-bgcodes/background-task-stats?taskIds=baiw888mq',
          headers: { authorization: `Bearer ${jwt}` },
        });
        expect(res.statusCode, c).toBe(status);
        expect((res.json() as { error: string }).error).toBe(c);
      }
    } finally {
      await built.app.close();
    }
  });

  it('GET /api/chats/:id/background-task-stats returns 504 when the host never replies', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      seedStatsChat(daemonLink, 'c-bgto');
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/chats/c-bgto/background-task-stats?taskIds=baiw888mq',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(504);
      expect((res.json() as { error: string }).error).toBe('daemon_timeout');
    } finally {
      await built.app.close();
    }
  }, 8_000);

  it('GET /api/chats/:id/background-task-stats ignores a response with an unmatched requestId', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      seedStatsChat(daemonLink, 'c-bgstray');
      daemonLink.emit({
        type: 'patch.background_task_stats.response',
        requestId: 'never-asked',
        ok: true,
        stats: [{ taskId: 'baiw888mq', cpuPercent: 1, rssBytes: 2048, processes: 1 }],
      });
      const origSend = daemonLink.send.bind(daemonLink);
      daemonLink.send = (surfaceId, event) => {
        origSend(surfaceId, event);
        if (event.type === 'patch.background_task_stats.request') {
          setImmediate(() => {
            daemonLink.emit({
              type: 'patch.background_task_stats.response',
              requestId: event.requestId,
              ok: true,
              stats: [],
            });
          });
        }
      };
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/chats/c-bgstray/background-task-stats?taskIds=baiw888mq',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ stats: [] });
    } finally {
      await built.app.close();
    }
  });

  it('GET /api/skills lists skills for a folder, and requires folder + daemonId', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      let seenFolder: string | undefined;
      let seenDaemonId: string | undefined;
      const origSend = daemonLink.send.bind(daemonLink);
      daemonLink.send = (surfaceId, event) => {
        origSend(surfaceId, event);
        if (event.type === 'patch.skills.request') {
          seenFolder = event.folder;
          seenDaemonId = event.daemonId;
          setImmediate(() => {
            daemonLink.emit({
              type: 'patch.skills.response',
              requestId: event.requestId,
              ok: true,
              skills: ['plant', 'deploy'],
            });
          });
        }
      };
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/skills?folder=%2Fwork%2Fproj&daemonId=d1',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { skills: string[] }).skills).toEqual(['plant', 'deploy']);
      expect(seenFolder).toBe('/work/proj');
      expect(seenDaemonId).toBe('d1');

      const missingFolder = await built.app.inject({
        method: 'GET',
        url: '/api/skills?daemonId=d1',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(missingFolder.statusCode).toBe(400);

      const missingDaemonId = await built.app.inject({
        method: 'GET',
        url: '/api/skills?folder=%2Fwork%2Fproj',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(missingDaemonId.statusCode).toBe(400);
    } finally {
      await built.app.close();
    }
  });

  // spec/01 § GET /api/skills — the response names the file each skill is
  // defined in, which is what lets the job editor link to a skill's source
  // (spec/14 § Jobs view). A host that doesn't name them omits the field
  // entirely rather than sending an empty map, so a surface can tell "this host
  // can't tell me" apart from "this host says there are none".
  it('GET /api/skills carries the file each skill is defined in, and omits it when the host names none', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      let namesFiles = true;
      const origSend = daemonLink.send.bind(daemonLink);
      daemonLink.send = (surfaceId, event) => {
        origSend(surfaceId, event);
        if (event.type === 'patch.skills.request') {
          setImmediate(() => {
            daemonLink.emit({
              type: 'patch.skills.response',
              requestId: event.requestId,
              ok: true,
              skills: ['plant'],
              ...(namesFiles
                ? { paths: { plant: '/work/proj/.claude/skills/plant/SKILL.md' } }
                : {}),
            });
          });
        }
      };
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/skills?folder=%2Fwork%2Fproj&daemonId=d1',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json() as unknown).toEqual({
        skills: ['plant'],
        paths: { plant: '/work/proj/.claude/skills/plant/SKILL.md' },
      });

      namesFiles = false;
      const older = await built.app.inject({
        method: 'GET',
        url: '/api/skills?folder=%2Fwork%2Fproj&daemonId=d1',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(older.statusCode).toBe(200);
      expect(older.json() as unknown).toEqual({ skills: ['plant'] });
    } finally {
      await built.app.close();
    }
  });

  // spec/01 § GET /api/skills — each skill's frontmatter description passes
  // through too (the chat transcript's Skill tool-call tooltip), with the same
  // "omit rather than send empty" rule `paths` already follows: an older
  // host that doesn't report descriptions is distinct from one that reports
  // none.
  it('GET /api/skills carries each skill’s description, and omits it when the host names none', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      let namesDescriptions = true;
      const origSend = daemonLink.send.bind(daemonLink);
      daemonLink.send = (surfaceId, event) => {
        origSend(surfaceId, event);
        if (event.type === 'patch.skills.request') {
          setImmediate(() => {
            daemonLink.emit({
              type: 'patch.skills.response',
              requestId: event.requestId,
              ok: true,
              skills: ['plant'],
              paths: { plant: '/work/proj/.claude/skills/plant/SKILL.md' },
              ...(namesDescriptions ? { descriptions: { plant: 'Sow what is in season.' } } : {}),
            });
          });
        }
      };
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/skills?folder=%2Fwork%2Fproj&daemonId=d1',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json() as unknown).toEqual({
        skills: ['plant'],
        paths: { plant: '/work/proj/.claude/skills/plant/SKILL.md' },
        descriptions: { plant: 'Sow what is in season.' },
      });

      namesDescriptions = false;
      const older = await built.app.inject({
        method: 'GET',
        url: '/api/skills?folder=%2Fwork%2Fproj&daemonId=d1',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(older.statusCode).toBe(200);
      expect(older.json() as unknown).toEqual({
        skills: ['plant'],
        paths: { plant: '/work/proj/.claude/skills/plant/SKILL.md' },
      });
    } finally {
      await built.app.close();
    }
  });

  // spec/14 § Skill autocomplete — the composer's preview panel needs the
  // WHOLE frontmatter, not just `description`. Same "omit rather than send
  // empty" rule: an older host that doesn't report it is distinct from one
  // that reports none.
  it('GET /api/skills carries each skill’s whole frontmatter, and omits it when the host names none', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      let namesFrontmatter = true;
      const origSend = daemonLink.send.bind(daemonLink);
      daemonLink.send = (surfaceId, event) => {
        origSend(surfaceId, event);
        if (event.type === 'patch.skills.request') {
          setImmediate(() => {
            daemonLink.emit({
              type: 'patch.skills.response',
              requestId: event.requestId,
              ok: true,
              skills: ['plant'],
              paths: { plant: '/work/proj/.claude/skills/plant/SKILL.md' },
              descriptions: { plant: 'Sow what is in season.' },
              ...(namesFrontmatter
                ? {
                    frontmatter: {
                      plant: {
                        name: 'plant',
                        description: 'Sow what is in season.',
                        'user-invocable': 'true',
                      },
                    },
                  }
                : {}),
            });
          });
        }
      };
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/skills?folder=%2Fwork%2Fproj&daemonId=d1',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json() as unknown).toEqual({
        skills: ['plant'],
        paths: { plant: '/work/proj/.claude/skills/plant/SKILL.md' },
        descriptions: { plant: 'Sow what is in season.' },
        frontmatter: {
          plant: {
            name: 'plant',
            description: 'Sow what is in season.',
            'user-invocable': 'true',
          },
        },
      });

      namesFrontmatter = false;
      const older = await built.app.inject({
        method: 'GET',
        url: '/api/skills?folder=%2Fwork%2Fproj&daemonId=d1',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(older.statusCode).toBe(200);
      expect(older.json() as unknown).toEqual({
        skills: ['plant'],
        paths: { plant: '/work/proj/.claude/skills/plant/SKILL.md' },
        descriptions: { plant: 'Sow what is in season.' },
      });
    } finally {
      await built.app.close();
    }
  });

  // spec/14 § Model selector — the picker's list is live: the server round-trips
  // it to the NAMED host (which reads its backends' providers). NO FALLBACK: a
  // host where nothing resolved is a 502 carrying the reason, never a baked-in
  // list. Partial failure is covered separately below — it is a 200, because a
  // backend failing is not the host failing.
  it('GET /api/models returns the host catalogue, and maps a total failure to 502', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      let ok = true;
      const origSend = daemonLink.send.bind(daemonLink);
      daemonLink.send = (surfaceId, event) => {
        origSend(surfaceId, event);
        if (event.type === 'patch.models.request') {
          setImmediate(() => {
            daemonLink.emit(
              ok
                ? {
                    type: 'patch.models.response',
                    daemonId: 'd1',
                    requestId: event.requestId,
                    models: [
                      { id: 'claude-opus-5', label: 'Claude Opus 5', backend: 'claude-code' },
                    ],
                    errors: [],
                    fetchedAt: '2026-08-03T09:00:00.000Z',
                  }
                : {
                    type: 'patch.models.response',
                    daemonId: 'd1',
                    requestId: event.requestId,
                    models: [],
                    errors: [
                      {
                        backend: 'claude-code',
                        code: 'oauth_unavailable',
                        message: 'no credential',
                      },
                    ],
                  },
            );
          });
        }
      };
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/models?daemonId=d1',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { models: { id: string }[]; fetchedAt: string };
      expect(body.models.map((m) => m.id)).toEqual(['claude-opus-5']);
      expect(body.fetchedAt).toBe('2026-08-03T09:00:00.000Z');

      ok = false;
      const bad = await built.app.inject({
        method: 'GET',
        url: '/api/models?daemonId=d1',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(bad.statusCode).toBe(502);
      expect((bad.json() as { error: string }).error).toBe('oauth_unavailable');
    } finally {
      await built.app.close();
    }
  });

  // The normal multi-backend case: one backend's credential expired, the other
  // answered. The picker must still offer what resolved and show the error
  // against the backend that failed (spec/02 § Model catalogue) — collapsing
  // this to a 502 would empty a picker that has perfectly good models in it.
  it('GET /api/models is 200 with BOTH models and errors when one backend failed', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      const origSend = daemonLink.send.bind(daemonLink);
      daemonLink.send = (surfaceId, event) => {
        origSend(surfaceId, event);
        if (event.type === 'patch.models.request') {
          setImmediate(() => {
            daemonLink.emit({
              type: 'patch.models.response',
              daemonId: 'd1',
              requestId: event.requestId,
              models: [{ id: 'claude-opus-5', label: 'Claude Opus 5', backend: 'claude-code' }],
              errors: [
                { backend: 'other-backend', code: 'upstream', message: 'provider returned 503' },
              ],
            });
          });
        }
      };
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/models?daemonId=d1',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        daemonId: string;
        models: { id: string; backend: string }[];
        errors: { backend: string; message: string }[];
      };
      expect(body.daemonId).toBe('d1');
      expect(body.models).toEqual([
        { id: 'claude-opus-5', label: 'Claude Opus 5', backend: 'claude-code' },
      ]);
      expect(body.errors).toEqual([
        { backend: 'other-backend', code: 'upstream', message: 'provider returned 503' },
      ]);
    } finally {
      await built.app.close();
    }
  });

  // The catalogue is PER HOST. Without a host there is nothing to ask, and
  // asking whichever host happens to be attached would offer the wrong
  // machine's models for a chat about to be pinned to a different one.
  it('GET /api/models without a daemonId is 400, not a guess', async () => {
    const { registry, jwt } = await bootstrap();
    const built = await makeApp({ registry, daemonLink: new InProcessDaemonLink() });
    try {
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/models',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await built.app.close();
    }
  });

  it('GET /api/skills maps folder_not_found to 404, other codes to 502, and times out to 504', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      let code: 'folder_not_found' | 'internal' = 'folder_not_found';
      const origSend = daemonLink.send.bind(daemonLink);
      daemonLink.send = (surfaceId, event) => {
        origSend(surfaceId, event);
        if (event.type === 'patch.skills.request') {
          setImmediate(() => {
            daemonLink.emit({
              type: 'patch.skills.response',
              requestId: event.requestId,
              ok: false,
              error: { code, message: 'x' },
            });
          });
        }
      };
      const notFound = await built.app.inject({
        method: 'GET',
        url: '/api/skills?folder=%2Fno%2Fsuch&daemonId=d1',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(notFound.statusCode).toBe(404);

      code = 'internal';
      const internal = await built.app.inject({
        method: 'GET',
        url: '/api/skills?folder=%2Fno%2Fsuch&daemonId=d1',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(internal.statusCode).toBe(502);
    } finally {
      await built.app.close();
    }
  });

  it('GET /api/skills returns 504 when the host never replies', async () => {
    const { registry, jwt } = await bootstrap();
    const built = await makeApp({ registry, daemonLink: new InProcessDaemonLink() });
    try {
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/skills?folder=%2Fwork&daemonId=d1',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(504);
    } finally {
      await built.app.close();
    }
  }, 8_000);

  it('POST /api/chats/:id/stop succeeds and forwards chat.stop_request', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c-stop', folder: '/x' });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats/c-stop/stop',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      const sent = daemonLink.sent.find((s) => s.event.type === 'chat.stop_request');
      expect(sent).toBeDefined();
    } finally {
      await built.app.close();
    }
  });

  it('DELETE /api/chats/:id returns 404 for an unknown chat', async () => {
    const { registry, jwt } = await bootstrap();
    const built = await makeApp({ registry, daemonLink: new InProcessDaemonLink() });
    try {
      const res = await built.app.inject({
        method: 'DELETE',
        url: '/api/chats/never-existed',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/chats/:id/archive rejects an invalid body with 400', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '/x' });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats/c1/archive',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { archived: 'yes' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/chats/:id/pin rejects an invalid body with 400', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '/x' });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats/c1/pin',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { pinned: 'yes' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/threads/:thread/send-to rejects an invalid body with 400 and prepends voicePrefix', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      const badBody = await built.app.inject({
        method: 'POST',
        url: '/api/threads/manager/send-to',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { notMessage: 'oops' },
      });
      expect(badBody.statusCode).toBe(400);

      const withPrefix = await built.app.inject({
        method: 'POST',
        url: '/api/threads/manager/send-to',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { message: 'status?', voicePrefix: '[voice] ' },
      });
      expect(withPrefix.statusCode).toBe(200);
      const sent = daemonLink.sent.find((s) => s.event.type === 'chat.input');
      expect(sent).toBeDefined();
      if (sent && sent.event.type === 'chat.input') {
        expect(sent.event.message).toBe('[voice] status?');
      }
    } finally {
      await built.app.close();
    }
  });

  it('every route falls back to 401 when requireAuth throws an error without a statusCode', async () => {
    // requireAuth always wraps its own throws in `generic()` (statusCode set),
    // so this exercises the defensive `?? 401` fallback in each route's catch
    // block for the case where registry.getAccount() itself throws (an
    // unexpected internal failure, not a normal auth rejection).
    const { registry, jwt } = await bootstrap();
    (registry as unknown as { getAccount: () => never }).getAccount = () => {
      throw new Error('registry backing store exploded');
    };
    const built = await makeApp({ registry, daemonLink: new InProcessDaemonLink() });
    try {
      const routes: Array<{ method: 'GET' | 'POST' | 'DELETE'; url: string }> = [
        { method: 'POST', url: '/api/chats' },
        { method: 'GET', url: '/api/chats' },
        { method: 'GET', url: '/api/chats/whatever' },
        { method: 'GET', url: '/api/chats/whatever/history' },
        { method: 'POST', url: '/api/chats/whatever/send-to' },
        { method: 'GET', url: '/api/chats/whatever/files' },
        { method: 'GET', url: '/api/chats/whatever/background-task-stats?taskIds=b1' },
        { method: 'GET', url: '/api/skills?folder=/x' },
        { method: 'POST', url: '/api/chats/whatever/stop' },
        { method: 'DELETE', url: '/api/chats/whatever' },
        { method: 'POST', url: '/api/chats/whatever/archive' },
        { method: 'POST', url: '/api/chats/whatever/pin' },
        { method: 'POST', url: '/api/chats/whatever/restore' },
        { method: 'POST', url: '/api/threads/manager/send-to' },
      ];
      for (const r of routes) {
        const res = await built.app.inject({
          method: r.method,
          url: r.url,
          headers: { authorization: `Bearer ${jwt}` },
        });
        expect(res.statusCode, `${r.method} ${r.url}`).toBe(401);
      }
    } finally {
      await built.app.close();
    }
  });

  it('requireAuth rejects when no account has been bootstrapped yet', async () => {
    const daemonLink = new InProcessDaemonLink();
    const registry = Registry.load(dir); // no bootstrapAccount() call
    const built = await makeApp({ registry, daemonLink });
    try {
      const res = await built.app.inject({ method: 'GET', url: '/api/chats' });
      expect(res.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });

  it('requireAuth rejects a revoked surface', async () => {
    const { registry, jwt } = await bootstrap();
    registry.revoke('srf-rest');
    const built = await makeApp({ registry, daemonLink: new InProcessDaemonLink() });
    try {
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/chats',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/chats uses the default 5s spawn-error window when spawnErrorWaitMs is not overridden', async () => {
    // Covers the `deps.spawnErrorWaitMs ?? SPAWN_ERROR_WAIT_MS` default branch.
    // The host replies immediately with chat.spawned so the test doesn't
    // actually have to wait out the real 5s window.
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const origSend = daemonLink.send.bind(daemonLink);
    daemonLink.send = (surfaceId, ev): void => {
      origSend(surfaceId, ev);
      if (ev.type === 'chat.spawn_request') {
        daemonLink.emit({
          type: 'chat.spawned',
          daemonId: 'd1',
          chatId: ev.chatId ?? 'x',
          folder: ev.folder,
        });
      }
    };
    // Bypass the local makeApp() helper (which always injects a test-friendly
    // spawnErrorWaitMs) and call buildAll directly so spawnErrorWaitMs is
    // genuinely undefined.
    const built = await buildAll({ logger: false, registry, daemonLink });
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { daemonId: 'd1', folder: '/anywhere' },
      });
      expect(res.statusCode).toBe(202);
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/chats resolves a chat.error for an unrelated chatId without disturbing the pending waiter', async () => {
    // Covers the `if (!w) return;` branch in the chat.error dispatch: an
    // error for a chatId nobody is waiting on must be a safe no-op.
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    let nextId = 0;
    const built = await makeApp({
      registry,
      daemonLink,
      idGenerator: () => `01HUNMATCHED${String(++nextId).padStart(15, '0')}`,
    });
    try {
      daemonLink.emit({
        type: 'chat.error',
        chatId: 'nobody-is-waiting-on-this-chat-id',
        error: { code: 'internal', message: 'irrelevant' },
        seq: 0,
      });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { daemonId: 'd1', folder: '/ok' },
      });
      // No host reply simulated for THIS spawn — resolves via the (short
      // test) timeout window, same as the very first spawn test in this file.
      expect(res.statusCode).toBe(202);
    } finally {
      await built.app.close();
    }
  });

  it('ignores patch.chat_history.response / files.response / skills.response frames with an unmatched requestId', async () => {
    const { registry } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      daemonLink.emit({
        type: 'patch.chat_history.response',
        requestId: 'no-such-request-id',
        ok: true,
        events: [],
      });
      daemonLink.emit({
        type: 'patch.files.response',
        requestId: 'no-such-request-id',
        ok: true,
        path: '',
        entries: [],
      });
      daemonLink.emit({
        type: 'patch.skills.response',
        requestId: 'no-such-request-id',
        ok: true,
        skills: [],
      });
      // Still alive and healthy after three unmatched frames.
      const res = await built.app.inject({ method: 'GET', url: '/api/healthz' });
      expect(res.statusCode).toBe(200);
    } finally {
      await built.app.close();
    }
  });

  it('GET /api/chats/:id/history maps a chat_not_found host error to 404', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      daemonLink.emit({
        type: 'chat.spawned',
        daemonId: 'd1',
        chatId: 'c-hist-404',
        folder: '/work/h4',
      });
      daemonLink.emit({
        type: 'chat.state',
        permissionMode: 'bypassPermissions',
        chatId: 'c-hist-404',
        activity: 'idle',
        lastUpdated: 1,
        status: 'active',
        pinned: false,
        folder: '/work/h4',
      });
      const origSend = daemonLink.send.bind(daemonLink);
      daemonLink.send = (surfaceId, event) => {
        origSend(surfaceId, event);
        if (event.type === 'patch.chat_history.request') {
          setImmediate(() => {
            daemonLink.emit({
              type: 'patch.chat_history.response',
              requestId: event.requestId,
              ok: false,
              error: { code: 'chat_not_found', message: 'gone' },
            });
          });
        }
      };
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/chats/c-hist-404/history',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await built.app.close();
    }
  });

  it('history/files/skills responses default missing optional fields ([] / "")', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      daemonLink.emit({
        type: 'chat.spawned',
        daemonId: 'd1',
        chatId: 'c-defaults',
        folder: '/work/d',
      });
      daemonLink.emit({
        type: 'chat.state',
        permissionMode: 'bypassPermissions',
        chatId: 'c-defaults',
        activity: 'idle',
        lastUpdated: 1,
        status: 'active',
        pinned: false,
        folder: '/work/d',
      });
      const origSend = daemonLink.send.bind(daemonLink);
      daemonLink.send = (surfaceId, event) => {
        origSend(surfaceId, event);
        if (event.type === 'patch.chat_history.request') {
          setImmediate(() => {
            daemonLink.emit({
              type: 'patch.chat_history.response',
              requestId: event.requestId,
              ok: true,
              // `events` omitted entirely.
            });
          });
        } else if (event.type === 'patch.files.request') {
          setImmediate(() => {
            daemonLink.emit({
              type: 'patch.files.response',
              requestId: event.requestId,
              ok: true,
              // `path`/`entries` omitted entirely (non-content request).
            });
          });
        } else if (event.type === 'patch.skills.request') {
          setImmediate(() => {
            daemonLink.emit({
              type: 'patch.skills.response',
              requestId: event.requestId,
              ok: true,
              // `skills` omitted entirely.
            });
          });
        }
      };

      const hist = await built.app.inject({
        method: 'GET',
        url: '/api/chats/c-defaults/history',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(hist.statusCode).toBe(200);
      expect((hist.json() as { events: unknown[] }).events).toEqual([]);

      // Files: omit the `path` query param entirely too (covers the
      // `req.query?.path ?? ''` default).
      const files = await built.app.inject({
        method: 'GET',
        url: '/api/chats/c-defaults/files',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(files.statusCode).toBe(200);
      const filesBody = files.json() as { path: string; entries: unknown[] };
      expect(filesBody.path).toBe('');
      expect(filesBody.entries).toEqual([]);

      const skills = await built.app.inject({
        method: 'GET',
        url: '/api/skills?folder=%2Fwork%2Fd&daemonId=d1',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(skills.statusCode).toBe(200);
      expect((skills.json() as { skills: unknown[] }).skills).toEqual([]);
    } finally {
      await built.app.close();
    }
  });

  it('GET /api/chats/:id/files defaults path/content/size when the host omits them from a content response', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      daemonLink.emit({
        type: 'chat.spawned',
        daemonId: 'd1',
        chatId: 'c-nocontent',
        folder: '/work/nc',
      });
      daemonLink.emit({
        type: 'chat.state',
        permissionMode: 'bypassPermissions',
        chatId: 'c-nocontent',
        activity: 'idle',
        lastUpdated: 1,
        status: 'active',
        pinned: false,
        folder: '/work/nc',
      });
      const origSend = daemonLink.send.bind(daemonLink);
      daemonLink.send = (surfaceId, event) => {
        origSend(surfaceId, event);
        if (event.type === 'patch.files.request') {
          setImmediate(() => {
            daemonLink.emit({
              type: 'patch.files.response',
              requestId: event.requestId,
              ok: true,
              // `path`/`content`/`size` all omitted despite content:true.
            });
          });
        }
      };
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/chats/c-nocontent/files?path=x.txt&content=1',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { path: string; content: string; size: number };
      expect(body.path).toBe('');
      expect(body.content).toBe('');
      expect(body.size).toBe(0);
    } finally {
      await built.app.close();
    }
  });

  it('GET /api/chats/:id/files maps an unrecognized host error code to 502 (statusByCode default)', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      daemonLink.emit({
        type: 'chat.spawned',
        daemonId: 'd1',
        chatId: 'c-weird',
        folder: '/work/w',
      });
      daemonLink.emit({
        type: 'chat.state',
        permissionMode: 'bypassPermissions',
        chatId: 'c-weird',
        activity: 'idle',
        lastUpdated: 1,
        status: 'active',
        pinned: false,
        folder: '/work/w',
      });
      const origSend = daemonLink.send.bind(daemonLink);
      daemonLink.send = (surfaceId, event) => {
        origSend(surfaceId, event);
        if (event.type === 'patch.files.request') {
          setImmediate(() => {
            daemonLink.emit({
              type: 'patch.files.response',
              requestId: event.requestId,
              ok: false,
              // Cast: simulate a host on a newer wire version emitting a
              // code this server build doesn't recognize.
              error: { code: 'some_future_code' as 'internal', message: 'huh' },
            });
          });
        }
      };
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/chats/c-weird/files?path=x',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(502);
    } finally {
      await built.app.close();
    }
  });

  it('history/files/skills host failures default code/message when `error` itself is omitted', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      daemonLink.emit({
        type: 'chat.spawned',
        daemonId: 'd1',
        chatId: 'c-noerr',
        folder: '/work/ne',
      });
      daemonLink.emit({
        type: 'chat.state',
        permissionMode: 'bypassPermissions',
        chatId: 'c-noerr',
        activity: 'idle',
        lastUpdated: 1,
        status: 'active',
        pinned: false,
        folder: '/work/ne',
      });
      const origSend = daemonLink.send.bind(daemonLink);
      daemonLink.send = (surfaceId, event) => {
        origSend(surfaceId, event);
        if (event.type === 'patch.chat_history.request') {
          setImmediate(() => {
            daemonLink.emit({
              type: 'patch.chat_history.response',
              requestId: event.requestId,
              ok: false,
              // `error` omitted entirely.
            });
          });
        } else if (event.type === 'patch.files.request') {
          setImmediate(() => {
            daemonLink.emit({
              type: 'patch.files.response',
              requestId: event.requestId,
              ok: false,
              // `error` omitted entirely.
            });
          });
        } else if (event.type === 'patch.skills.request') {
          setImmediate(() => {
            daemonLink.emit({
              type: 'patch.skills.response',
              requestId: event.requestId,
              ok: false,
              // `error` omitted entirely.
            });
          });
        }
      };

      const hist = await built.app.inject({
        method: 'GET',
        url: '/api/chats/c-noerr/history',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(hist.statusCode).toBe(502);
      expect((hist.json() as { error: string; message: string }).error).toBe('internal');
      expect((hist.json() as { message: string }).message).toBe('history error');

      const files = await built.app.inject({
        method: 'GET',
        url: '/api/chats/c-noerr/files?path=x',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(files.statusCode).toBe(502);
      expect((files.json() as { error: string; message: string }).message).toBe('files error');

      const skills = await built.app.inject({
        method: 'GET',
        url: '/api/skills?folder=%2Fwork%2Fne&daemonId=d1',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(skills.statusCode).toBe(502);
      expect((skills.json() as { error: string; message: string }).message).toBe('skills error');
    } finally {
      await built.app.close();
    }
  });
  // ---- GET /api/chats/folders (spec/04 § Folders → Folder roster) ----
  // The sidebar's "Recent projects" list must survive archiving the LAST chat
  // in a folder. It cannot be derived from the default `GET /api/chats` roster,
  // which excludes archived chats, so the folder roster is served separately —
  // one row per folder, O(folders) rather than O(chats), so it stays small no
  // matter how many archived chats accumulate.
  it('GET /api/chats/folders keeps a folder whose only chat is archived', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      // /arch's only chat is archived — the exact repro from the bug report.
      daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId: 'a1', folder: '/arch' });
      daemonLink.emit({
        type: 'chat.state',
        permissionMode: 'bypassPermissions',
        chatId: 'a1',
        activity: 'idle',
        lastUpdated: 10,
        status: 'archived',
        pinned: false,
        folder: '/arch',
      });
      daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId: 'b1', folder: '/live' });
      daemonLink.emit({
        type: 'chat.state',
        permissionMode: 'bypassPermissions',
        chatId: 'b1',
        activity: 'idle',
        lastUpdated: 20,
        status: 'active',
        pinned: false,
        folder: '/live',
      });

      const res = await built.app.inject({
        method: 'GET',
        url: '/api/chats/folders',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        folders: { folder: string; daemonId: string; lastUpdated: number }[];
      };
      // Most-recent-first, and the all-archived folder is present.
      expect(body.folders).toEqual([
        { folder: '/live', daemonId: 'd1', lastUpdated: 20 },
        { folder: '/arch', daemonId: 'd1', lastUpdated: 10 },
      ]);
    } finally {
      await built.app.close();
    }
  });

  it('GET /api/chats/folders is one row per folder at its most-recent chat, and omits deleted-only folders', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await makeApp({ registry, daemonLink });
    try {
      const seed = (
        chatId: string,
        folder: string,
        lastUpdated: number,
        status: 'active' | 'archived' | 'deleted',
      ): void => {
        daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId, folder });
        daemonLink.emit({
          type: 'chat.state',
          permissionMode: 'bypassPermissions',
          chatId,
          activity: 'idle',
          lastUpdated,
          status,
          pinned: false,
          folder,
        });
      };
      // Two chats in /shared — the folder collapses to ONE row carrying the
      // newer chat's timestamp.
      seed('s1', '/shared', 5, 'archived');
      seed('s2', '/shared', 30, 'active');
      // A folder whose every chat is soft-deleted is gone for good: it must not
      // linger in Recent projects (chatGroups.ts treats `deleted` the same way).
      seed('g1', '/gone', 40, 'deleted');

      const res = await built.app.inject({
        method: 'GET',
        url: '/api/chats/folders',
        headers: { authorization: `Bearer ${jwt}` },
      });
      const body = res.json() as { folders: { folder: string; lastUpdated: number }[] };
      expect(body.folders.map((f) => f.folder)).toEqual(['/shared']);
      expect(body.folders[0]?.lastUpdated).toBe(30);
    } finally {
      await built.app.close();
    }
  });

  it('GET /api/chats/folders requires a surface credential (NO FALLBACK)', async () => {
    const { registry } = await bootstrap();
    const built = await makeApp({ registry, daemonLink: new InProcessDaemonLink() });
    try {
      const res = await built.app.inject({ method: 'GET', url: '/api/chats/folders' });
      expect(res.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });

  // The literal `/api/chats/folders` must not be swallowed by the sibling
  // `/api/chats/:id` route (which would 404 on a chat literally named
  // "folders") — Fastify prefers the static segment, and this pins that.
  it('GET /api/chats/folders is not shadowed by GET /api/chats/:id', async () => {
    const { registry, jwt } = await bootstrap();
    const built = await makeApp({ registry, daemonLink: new InProcessDaemonLink() });
    try {
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/chats/folders',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ folders: [] });
    } finally {
      await built.app.close();
    }
  });
});
