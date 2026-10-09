// spec/04 § Folders — server relay + cold-start REST.
//
// The host publishes its folder list over the host link (`folders.list` on
// connect, `folders.updated` on change). These tests assert the server (a)
// serves the mirror at `GET /api/folders` for cold-start and (b) relays the
// host's live folder events to every connected surface.

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

describe('folder routes + relay', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-folder-routes-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function bootstrap() {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(21));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({
      surfaceId: 'srf-folders',
      surfaceKind: 'web',
      label: 'browser',
      issuedAt: 1,
    });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-folders',
      surfaceKind: 'web',
      label: 'browser',
    });
    // `d1` must be a REGISTERED machine: every host-addressed route refuses an
    // id that is not (spec/04 § Spawn), so a fixture that skipped this would be
    // testing the refusal path instead of the route.
    registry.setDaemonKey({ daemonId: 'd1', publicKey: user.publicKey, issuedAt: 1 });
    return { user, registry, jwt };
  }

  it('GET /api/folders is empty before the host publishes', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await buildAll({ logger: false, registry, daemonLink });
    try {
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/folders',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ hosts: [] });
    } finally {
      await built.app.close();
    }
  });

  it('GET /api/folders serves the host-published list (cold start)', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await buildAll({ logger: false, registry, daemonLink });
    try {
      // Host connects and publishes its snapshot.
      daemonLink.emit({
        type: 'folders.list',
        daemonId: 'd1',
        roots: ['/proj/one'],
        recent: ['/proj/two'],
      });
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/folders',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        hosts: [{ daemonId: 'd1', roots: ['/proj/one'], recent: ['/proj/two'] }],
      });

      // A later folders.updated push replaces the mirror.
      daemonLink.emit({
        type: 'folders.updated',
        daemonId: 'd1',
        roots: ['/proj/three'],
        recent: ['/proj/one'],
      });
      const res2 = await built.app.inject({
        method: 'GET',
        url: '/api/folders',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res2.json()).toEqual({
        hosts: [{ daemonId: 'd1', roots: ['/proj/three'], recent: ['/proj/one'] }],
      });
    } finally {
      await built.app.close();
    }
  });

  it('GET /api/folders requires auth', async () => {
    const { registry } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await buildAll({ logger: false, registry, daemonLink });
    try {
      const res = await built.app.inject({ method: 'GET', url: '/api/folders' });
      expect(res.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });

  it('relays folders.updated to a connected surface', async () => {
    const { user, registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await buildAll({ logger: false, registry, daemonLink });
    await built.app.listen({ port: 0, host: '127.0.0.1' });
    const addr = built.app.server.address() as AddressInfo;
    const client = new WireTestClient({ url: `ws://127.0.0.1:${addr.port}/ws`, auth: jwt });
    void user; // keypair only needed for the jwt already minted
    try {
      await client.connect();
      await client.waitFor('daemon.online');
      const received = client.waitFor('folders.updated');
      daemonLink.emit({
        type: 'folders.updated',
        daemonId: 'd1',
        roots: ['/proj/live'],
        recent: [],
      });
      const ev = await received;
      // The push names the machine whose filesystem it describes, so a surface
      // updates that host's picker group and leaves every other host's alone.
      expect(ev).toMatchObject({ daemonId: 'd1', roots: ['/proj/live'], recent: [] });
    } finally {
      await client.close();
      await built.app.close();
    }
  });

  it('GET /api/folders is 401 when no account has been bootstrapped at all', async () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'patch-folder-routes-noaccount-'));
    try {
      const registry = Registry.load(dir2);
      const daemonLink = new InProcessDaemonLink();
      const built = await buildAll({ logger: false, registry, daemonLink });
      try {
        const res = await built.app.inject({ method: 'GET', url: '/api/folders' });
        expect(res.statusCode).toBe(401);
      } finally {
        await built.app.close();
      }
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it('GET /api/folders: a malformed bearer is 401, a revoked surface is 401', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await buildAll({ logger: false, registry, daemonLink });
    try {
      const garbage = await built.app.inject({
        method: 'GET',
        url: '/api/folders',
        headers: { authorization: 'Bearer not-a-real-jwt' },
      });
      expect(garbage.statusCode).toBe(401);

      registry.revoke('srf-folders');
      const revoked = await built.app.inject({
        method: 'GET',
        url: '/api/folders',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(revoked.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });
});

// spec/04 § Browsing (directory listing) — GET /api/folders/browse.
describe('GET /api/folders/browse', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-folder-browse-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function bootstrap() {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(31));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({
      surfaceId: 'srf-browse',
      surfaceKind: 'web',
      label: 'browser',
      issuedAt: 1,
    });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-browse',
      surfaceKind: 'web',
      label: 'browser',
    });
    // Browsing is host-addressed and refuses an unregistered machine, so the
    // fixture registers the machine the tests browse (spec/03 § Host events).
    registry.setDaemonKey({ daemonId: 'd1', publicKey: user.publicKey, issuedAt: 1 });
    return { registry, jwt };
  }

  // A host that answers `patch.folders.browse.request` deterministically,
  // mirroring the host's real handler (mirrors packages/daemon browse RPC).
  class FakeBrowseDaemon extends InProcessDaemonLink {
    constructor(
      private readonly respond: (
        event: Extract<WireEvent, { type: 'patch.folders.browse.request' }>,
      ) => Omit<
        Extract<WireEvent, { type: 'patch.folders.browse.response' }>,
        'type' | 'requestId'
      > | null,
    ) {
      super();
    }
    override send(surfaceId: string, event: WireEvent): void {
      super.send(surfaceId, event);
      if (event.type === 'patch.folders.browse.request') {
        const r = this.respond(event);
        if (r === null) return; // simulate the host never answering (timeout)
        this.emit({
          type: 'patch.folders.browse.response',
          daemonId: 'd1',
          requestId: event.requestId,
          ...r,
        } as Extract<WireEvent, { type: 'patch.folders.browse.response' }>);
      }
    }
  }

  it('requires auth', async () => {
    const { registry } = await bootstrap();
    const daemonLink = new FakeBrowseDaemon(() => ({ ok: true, entries: [] }));
    const built = await buildAll({ logger: false, registry, daemonLink });
    try {
      const res = await built.app.inject({ method: 'GET', url: '/api/folders/browse?daemonId=d1' });
      expect(res.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });

  it('with no `dir` query param, omits dir from the host request and returns the roots', async () => {
    const { registry, jwt } = await bootstrap();
    let sentDir: string | undefined = 'unset';
    const daemonLink = new FakeBrowseDaemon((event) => {
      sentDir = event.dir;
      return {
        ok: true,
        dir: null,
        parent: null,
        entries: [{ name: 'proj', path: '/home/proj' }],
      };
    });
    const built = await buildAll({ logger: false, registry, daemonLink });
    try {
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/folders/browse?daemonId=d1',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
      expect(sentDir).toBeUndefined();
      expect(res.json()).toEqual({
        daemonId: 'd1',
        dir: null,
        parent: null,
        entries: [{ name: 'proj', path: '/home/proj' }],
      });
    } finally {
      await built.app.close();
    }
  });

  it('with a `dir` query param, forwards it to the host and returns the listing', async () => {
    const { registry, jwt } = await bootstrap();
    let sentDir: string | undefined;
    const daemonLink = new FakeBrowseDaemon((event) => {
      sentDir = event.dir;
      return {
        ok: true,
        dir: '/home/proj/sub',
        parent: '/home/proj',
        entries: [{ name: 'inner', path: '/home/proj/sub/inner' }],
      };
    });
    const built = await buildAll({ logger: false, registry, daemonLink });
    try {
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/folders/browse?daemonId=d1&dir=%2Fhome%2Fproj%2Fsub',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
      expect(sentDir).toBe('/home/proj/sub');
      expect(res.json()).toEqual({
        daemonId: 'd1',
        dir: '/home/proj/sub',
        parent: '/home/proj',
        entries: [{ name: 'inner', path: '/home/proj/sub/inner' }],
      });
    } finally {
      await built.app.close();
    }
  });

  it('maps folder_not_found to 404 (a dir escaping the confining roots)', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new FakeBrowseDaemon(() => ({
      ok: false,
      error: { code: 'folder_not_found', message: 'outside project roots' },
    }));
    const built = await buildAll({ logger: false, registry, daemonLink });
    try {
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/folders/browse?daemonId=d1&dir=%2Fetc',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'folder_not_found', message: 'outside project roots' });
    } finally {
      await built.app.close();
    }
  });

  it('maps any other host error code to 502, defaulting code/message when absent', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new FakeBrowseDaemon(() => ({ ok: false }));
    const built = await buildAll({ logger: false, registry, daemonLink });
    try {
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/folders/browse?daemonId=d1',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({ error: 'internal', message: 'browse error' });
    } finally {
      await built.app.close();
    }
  });

  it('defaults dir/parent/entries to null/null/[] when the host omits them on success', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new FakeBrowseDaemon(() => ({ ok: true }));
    const built = await buildAll({ logger: false, registry, daemonLink });
    try {
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/folders/browse?daemonId=d1',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ daemonId: 'd1', dir: null, parent: null, entries: [] });
    } finally {
      await built.app.close();
    }
  });

  it('times out (504 daemon_timeout) when the host never answers', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new FakeBrowseDaemon(() => null);
    const built = await buildAll({ logger: false, registry, daemonLink });
    try {
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/folders/browse?daemonId=d1',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(504);
      expect(res.json()).toEqual({ error: 'daemon_timeout' });
    } finally {
      await built.app.close();
    }
  }, 8_000);

  it('ignores a late/unmatched patch.folders.browse.response (unknown requestId)', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new FakeBrowseDaemon(() => ({ ok: true, entries: [] }));
    const built = await buildAll({ logger: false, registry, daemonLink });
    try {
      daemonLink.emit({
        type: 'patch.folders.browse.response',
        daemonId: 'd1',
        requestId: 'never-requested',
        ok: true,
        entries: [],
      });
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/folders/browse?daemonId=d1',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await built.app.close();
    }
  });
});
