// Chat search REST (spec/03 § Chat search).
//
// The server's half is a gate, a fan-out and a merge: authenticate the surface,
// ask every ONLINE host for its top hits, merge them under the one shared
// ordering — most recently active first — page the result, and name every host
// it could not search. The
// host half is tested against real transcripts in
// packages/daemon/test/chat-search.test.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import { ChatSearchResponse, type ChatSearchHit, type WireEvent } from '@patch/wire';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';
import { CHAT_SEARCH_TIMEOUT_MS } from '../src/chat-search-routes.js';

type Req = Extract<WireEvent, { type: 'patch.chat_search.request' }>;
type Res = Extract<WireEvent, { type: 'patch.chat_search.response' }>;
type Answer = Omit<Res, 'type' | 'requestId' | 'daemonId'> | null;

/** A host link whose machines answer search requests with `respond`. */
class FakeSearchHosts extends InProcessDaemonLink {
  readonly asked: Array<{ daemonId: string; event: Req }> = [];
  constructor(
    private readonly respond: (daemonId: string, event: Req) => Answer,
    private readonly answerAs?: string,
  ) {
    super();
  }
  override sendTo(daemonId: string, surfaceId: string, event: WireEvent): void {
    super.sendTo(daemonId, surfaceId, event);
    if (event.type !== 'patch.chat_search.request') return;
    this.asked.push({ daemonId, event });
    const r = this.respond(daemonId, event);
    if (r === null) return; // never answers
    const from = this.answerAs ?? daemonId;
    this.emit(
      { type: 'patch.chat_search.response', requestId: event.requestId, daemonId: from, ...r },
      from,
    );
  }
}

function hit(chatId: string, daemonId: string, over: Partial<ChatSearchHit> = {}): ChatSearchHit {
  return {
    chatId,
    daemonId,
    name: `chat ${chatId}`,
    preview: null,
    folder: '/home/tom',
    status: 'active',
    section: 'folders',
    pinned: false,
    snoozedUntil: null,
    lastUpdated: 100,
    jobId: null,
    nameMatch: false,
    nameHighlights: [],
    messageMatches: 1,
    snippet: { text: 'the boiler', highlights: [[4, 10]], role: 'user', seq: 3, createdAt: 1 },
    ...over,
  };
}

describe('chat search route', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-chat-search-'));
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Three registered machines: d1 (home) and mac online, pi offline. */
  async function boot(link: InProcessDaemonLink) {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(44));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({ surfaceId: 'srf-web', surfaceKind: 'web', label: 'web', issuedAt: 1 });
    for (const id of ['d1', 'mac', 'pi']) {
      registry.setDaemonKey({ daemonId: id, publicKey: user.publicKey, issuedAt: 1 });
    }
    registry.setHostName('mac', 'MacBook');
    link.addOnlineHost('mac');
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-web',
      surfaceKind: 'web',
      label: 'web',
    });
    const built = await buildAll({ logger: false, registry, daemonLink: link });
    return { built, auth: { authorization: `Bearer ${jwt}` }, registry };
  }

  const search = (qs: string) => `/api/chats/search?${qs}`;

  it('refuses an unauthenticated caller before asking any host', async () => {
    const link = new FakeSearchHosts(() => ({ ok: true, hits: [], total: 0 }));
    const { built, auth, registry } = await boot(link);
    try {
      const res = await built.app.inject({ method: 'GET', url: search('q=boiler') });
      expect(res.statusCode).toBe(401);
      const forged = await built.app.inject({
        method: 'GET',
        url: search('q=boiler'),
        headers: { authorization: 'Bearer not-a-jwt' },
      });
      expect(forged.statusCode).toBe(401);
      registry.revoke('srf-web');
      const revoked = await built.app.inject({
        method: 'GET',
        url: search('q=boiler'),
        headers: auth,
      });
      expect(revoked.statusCode).toBe(401);
      expect(link.asked).toHaveLength(0);
    } finally {
      await built.app.close();
    }
  });

  it('refuses a query under two characters and out-of-range paging', async () => {
    const link = new FakeSearchHosts(() => ({ ok: true, hits: [], total: 0 }));
    const { built, auth } = await boot(link);
    try {
      for (const qs of [
        'q=',
        'q=%20a%20',
        'q=ab&limit=0',
        'q=ab&limit=51',
        'q=ab&offset=-1',
        'q=ab&offset=200',
        'q=ab&limit=x',
      ]) {
        const res = await built.app.inject({ method: 'GET', url: search(qs), headers: auth });
        expect(res.statusCode, qs).toBe(400);
      }
      expect(link.asked).toHaveLength(0);
    } finally {
      await built.app.close();
    }
  });

  it('forwards fullText to every host, defaulting to full text, and refuses nonsense', async () => {
    const link = new FakeSearchHosts(() => ({ ok: true, hits: [], total: 0 }));
    const { built, auth } = await boot(link);
    try {
      const get = (qs: string) =>
        built.app.inject({ method: 'GET', url: search(qs), headers: auth });
      expect((await get('q=boiler')).statusCode).toBe(200);
      expect((await get('q=boiler&fullText=false')).statusCode).toBe(200);
      expect((await get('q=boiler&fullText=true')).statusCode).toBe(200);
      expect((await get('q=boiler&fullText=0')).statusCode).toBe(200);
      // Every host is asked, once per request, with the same scope.
      const perRequest = link.asked.length / 4;
      expect(Number.isInteger(perRequest) && perRequest > 0).toBe(true);
      const scopes = link.asked.map((a) => a.event.fullText);
      expect(scopes.filter((v) => v === true)).toHaveLength(perRequest * 2);
      expect(scopes.filter((v) => v === false)).toHaveLength(perRequest * 2);
      const before = link.asked.length;
      expect((await get('q=boiler&fullText=maybe')).statusCode).toBe(400);
      expect(link.asked).toHaveLength(before);
    } finally {
      await built.app.close();
    }
  });

  it('asks every online host, merges by recency, and names the offline one', async () => {
    const link = new FakeSearchHosts((daemonId) =>
      daemonId === 'd1'
        ? {
            ok: true,
            hits: [hit('a', 'd1', { lastUpdated: 50 }), hit('b', 'd1', { lastUpdated: 10 })],
            total: 2,
            searchedChats: 30,
            transcriptsMissing: 4,
          }
        : {
            ok: true,
            hits: [
              hit('m', 'mac', { nameMatch: true, lastUpdated: 1 }),
              hit('n', 'mac', { lastUpdated: 20 }),
            ],
            total: 2,
            searchedChats: 12,
            transcriptsMissing: 0,
          },
    );
    const { built, auth } = await boot(link);
    try {
      const res = await built.app.inject({
        method: 'GET',
        url: search('q=%20boiler%20'),
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      const body = ChatSearchResponse.parse(res.json());
      expect(body.query).toBe('boiler');
      // Most recently active first, whatever each hit matched on: `m` matched on
      // its name but was last active before the other three, so it comes last.
      expect(body.hits.map((h) => h.chatId)).toEqual(['a', 'n', 'b', 'm']);
      expect(body.total).toBe(4);
      expect(body.nextOffset).toBeNull();
      expect(body.hosts).toEqual([
        {
          daemonId: 'd1',
          hostName: null,
          state: 'searched',
          searchedChats: 30,
          transcriptsMissing: 4,
        },
        {
          daemonId: 'mac',
          hostName: 'MacBook',
          state: 'searched',
          searchedChats: 12,
          transcriptsMissing: 0,
        },
        { daemonId: 'pi', hostName: null, state: 'offline' },
      ]);
      // Each online host was asked once, for the trimmed query and its top page.
      expect(link.asked.map((a) => a.daemonId).sort()).toEqual(['d1', 'mac']);
      for (const a of link.asked) {
        expect(a.event).toMatchObject({ query: 'boiler', limit: 20, daemonId: a.daemonId });
      }
    } finally {
      await built.app.close();
    }
  });

  it('pages the merged list, asking each host for its top offset+limit', async () => {
    const d1 = Array.from({ length: 5 }, (_, i) =>
      hit(`a${i}`, 'd1', { lastUpdated: 100 - 2 * i }),
    );
    const mac = Array.from({ length: 5 }, (_, i) =>
      hit(`m${i}`, 'mac', { lastUpdated: 99 - 2 * i }),
    );
    const link = new FakeSearchHosts((daemonId, e) => ({
      ok: true,
      hits: (daemonId === 'd1' ? d1 : mac).slice(0, e.limit),
      total: 5,
    }));
    const { built, auth } = await boot(link);
    try {
      const first = ChatSearchResponse.parse(
        (
          await built.app.inject({ method: 'GET', url: search('q=bo&limit=3'), headers: auth })
        ).json(),
      );
      expect(first.hits.map((h) => h.chatId)).toEqual(['a0', 'm0', 'a1']);
      expect(first.nextOffset).toBe(3);
      const second = ChatSearchResponse.parse(
        (
          await built.app.inject({
            method: 'GET',
            url: search('q=bo&limit=3&offset=3'),
            headers: auth,
          })
        ).json(),
      );
      expect(second.hits.map((h) => h.chatId)).toEqual(['m1', 'a2', 'm2']);
      expect(link.asked.slice(-2).map((a) => a.event.limit)).toEqual([6, 6]);
      const last = ChatSearchResponse.parse(
        (
          await built.app.inject({
            method: 'GET',
            url: search('q=bo&limit=5&offset=5'),
            headers: auth,
          })
        ).json(),
      );
      expect(last.hits).toHaveLength(5);
      expect(last.nextOffset).toBeNull();
    } finally {
      await built.app.close();
    }
  });

  it("tags a job-spawned chat with its job from the server's registry", async () => {
    const link = new FakeSearchHosts((daemonId) =>
      daemonId === 'd1'
        ? { ok: true, hits: [hit('job-chat', 'd1')], total: 1 }
        : { ok: true, hits: [], total: 0 },
    );
    const { built, auth } = await boot(link);
    try {
      link.emit(
        { type: 'chat.spawned', chatId: 'job-chat', daemonId: 'd1', folder: '/home/tom' },
        'd1',
      );
      built.chatRegistry.get('job-chat')!.jobId = 'j_nightly';
      const body = ChatSearchResponse.parse(
        (await built.app.inject({ method: 'GET', url: search('q=boiler'), headers: auth })).json(),
      );
      expect(body.hits[0]!.jobId).toBe('j_nightly');
    } finally {
      await built.app.close();
    }
  });

  it('a host that fails or never answers is named, and the rest still come back', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const link = new FakeSearchHosts((daemonId) =>
      daemonId === 'd1'
        ? null
        : { ok: false, error: { code: 'internal', message: 'disk on fire' } },
    );
    const { built, auth } = await boot(link);
    try {
      const pending = built.app.inject({ method: 'GET', url: search('q=boiler'), headers: auth });
      await vi.waitFor(() => expect(link.asked).toHaveLength(2));
      await vi.advanceTimersByTimeAsync(CHAT_SEARCH_TIMEOUT_MS + 1);
      const res = await pending;
      expect(res.statusCode).toBe(200);
      expect(res.json().hosts).toEqual([
        { daemonId: 'd1', hostName: null, state: 'timeout' },
        { daemonId: 'mac', hostName: 'MacBook', state: 'error', message: 'disk on fire' },
        { daemonId: 'pi', hostName: null, state: 'offline' },
      ]);
    } finally {
      vi.useRealTimers();
      await built.app.close();
    }
  });

  it('ignores an answer from a machine that was not asked', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const link = new FakeSearchHosts(() => ({ ok: true, hits: [hit('x', 'pi')], total: 1 }), 'pi');
    const { built, auth } = await boot(link);
    try {
      const pending = built.app.inject({ method: 'GET', url: search('q=boiler'), headers: auth });
      await vi.waitFor(() => expect(link.asked).toHaveLength(2));
      await vi.advanceTimersByTimeAsync(CHAT_SEARCH_TIMEOUT_MS + 1);
      const body = (await pending).json();
      expect(body.hits).toEqual([]);
      expect(body.hosts.map((h: { state: string }) => h.state)).toEqual([
        'timeout',
        'timeout',
        'offline',
      ]);
    } finally {
      vi.useRealTimers();
      await built.app.close();
    }
  });

  it('with every host offline, answers empty and names them all', async () => {
    const link = new FakeSearchHosts(() => ({ ok: true, hits: [], total: 0 }));
    const { built, auth } = await boot(link);
    link.setStatus('offline');
    try {
      const body = ChatSearchResponse.parse(
        (await built.app.inject({ method: 'GET', url: search('q=boiler'), headers: auth })).json(),
      );
      expect(body.hits).toEqual([]);
      expect(body.hosts.map((h) => h.state)).toEqual(['offline', 'offline', 'offline']);
      expect(link.asked).toHaveLength(0);
    } finally {
      await built.app.close();
    }
  });

  it('searches the server mirror for a chat whose host is offline, flagged as mirrored', async () => {
    const link = new FakeSearchHosts(() => ({ ok: true, hits: [], total: 0 }));
    const { built, auth } = await boot(link);
    try {
      // 'pi' is offline; its chat's messages passed through the server earlier.
      link.emit(
        { type: 'chat.spawned', chatId: 'pi-chat', daemonId: 'pi', folder: '/srv' } as WireEvent,
        'pi',
      );
      link.emit(
        {
          type: 'chat.message',
          chatId: 'pi-chat',
          seq: 0,
          role: 'user',
          content: 'rotate the boiler keys',
        } as WireEvent,
        'pi',
      );
      // A chat on an ONLINE host is never answered from the mirror (the host is authoritative).
      link.emit(
        { type: 'chat.spawned', chatId: 'mac-chat', daemonId: 'mac', folder: '/m' } as WireEvent,
        'mac',
      );
      link.emit(
        {
          type: 'chat.message',
          chatId: 'mac-chat',
          seq: 0,
          role: 'user',
          content: 'boiler from the mac',
        } as WireEvent,
        'mac',
      );
      const body = ChatSearchResponse.parse(
        (await built.app.inject({ method: 'GET', url: search('q=boiler'), headers: auth })).json(),
      );
      expect(body.hits.map((h) => [h.chatId, h.mirrored])).toEqual([['pi-chat', true]]);
      expect(body.hits[0]!.snippet).toMatchObject({ role: 'user', seq: 0 });
      expect(body.total).toBe(1);
      expect(body.hosts.find((h) => h.daemonId === 'pi')).toMatchObject({
        state: 'offline',
        mirroredChats: 1,
      });
      expect(body.hosts.find((h) => h.daemonId === 'd1')!.mirroredChats).toBeUndefined();
      // fullText=false skips message text, so the mirror finds nothing by body.
      const names = ChatSearchResponse.parse(
        (
          await built.app.inject({
            method: 'GET',
            url: search('q=boiler&fullText=false'),
            headers: auth,
          })
        ).json(),
      );
      expect(names.hits).toEqual([]);
    } finally {
      await built.app.close();
    }
  });

  it('never relays a search response (it carries message text) to connected surfaces', async () => {
    const link = new InProcessDaemonLink();
    const { built } = await boot(link);
    try {
      const sent: string[] = [];
      // @ts-expect-error — seeding a connected surface without a full handshake
      built.wsHub['surfaces'].set(
        'srf-web',
        new Set([
          {
            socket: { send: (d: string) => sent.push(d), close: () => undefined },
            surfaceId: 'srf-web',
            surfaceKind: 'web',
            watchedChats: new Set(),
          },
        ]),
      );
      link.emit({
        type: 'patch.chat_search.response',
        requestId: 'orphan',
        daemonId: 'd1',
        ok: true,
        hits: [hit('a', 'd1')],
        total: 1,
      });
      expect(sent.filter((d) => d.includes('patch.chat_search.response'))).toEqual([]);
    } finally {
      await built.app.close();
    }
  });
});
