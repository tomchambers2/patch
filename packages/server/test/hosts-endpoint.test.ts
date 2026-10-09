// GET /api/hosts — the host registry (spec/01 § Endpoints).
//
// The endpoint was listed in the spec and did not exist at all: the server
// answered `route not found`, so nothing could enumerate the account's machines
// over REST, and a host had no way to answer `patch_list_hosts` for its chats.
//
// It is authed by a daemonKey AS WELL AS a surface credential precisely because
// the host is a legitimate caller with no surface credential to present.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair, mintSurfaceCredential, mintDaemonKey } from '@patch/auth';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';

describe('GET /api/hosts', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-hosts-ep-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function bootstrap() {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(7));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({
      surfaceId: 'srf-hosts',
      surfaceKind: 'web',
      label: 'browser',
      issuedAt: 1,
    });
    registry.setDaemonKey({ daemonId: 'host-a', publicKey: user.publicKey, issuedAt: 1 });
    registry.setDaemonKey({ daemonId: 'host-b', publicKey: user.publicKey, issuedAt: 1 });
    const surfaceJwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-hosts',
      surfaceKind: 'web',
      label: 'browser',
    });
    const daemonJwt = await mintDaemonKey({
      userPrivateKey: user.privateKey,
      daemonId: 'host-a',
      label: 'host-a',
    });
    return { registry, surfaceJwt, daemonJwt };
  }

  async function boot() {
    const { registry, surfaceJwt, daemonJwt } = await bootstrap();
    const built = await buildAll({
      dataDir: dir,
      registry,
      daemonLink: new InProcessDaemonLink(),
      jobsWatch: false,
    });
    return { app: built.app, surfaceJwt, daemonJwt };
  }

  it('lists every registered machine for a surface credential', async () => {
    const { app, surfaceJwt } = await boot();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/hosts',
        headers: { authorization: `Bearer ${surfaceJwt}` },
      });
      expect(res.statusCode).toBe(200);
      const ids = res.json().hosts.map((h: { daemonId: string }) => h.daemonId);
      expect(ids).toContain('host-a');
      expect(ids).toContain('host-b');
    } finally {
      await app.close();
    }
  });

  it('accepts a daemonKey too — a host has no surface credential to present', async () => {
    const { app, daemonJwt } = await boot();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/hosts',
        headers: { authorization: `Bearer ${daemonJwt}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().hosts.length).toBeGreaterThanOrEqual(2);
    } finally {
      await app.close();
    }
  });

  it('refuses an unauthenticated caller and a garbage credential', async () => {
    const { app } = await boot();
    try {
      expect((await app.inject({ method: 'GET', url: '/api/hosts' })).statusCode).toBe(401);
      const bad = await app.inject({
        method: 'GET',
        url: '/api/hosts',
        headers: { authorization: 'Bearer not-a-jwt' },
      });
      expect(bad.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('says what it knows about a machine that has never connected, and invents nothing', async () => {
    const { app, surfaceJwt } = await boot();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/hosts',
        headers: { authorization: `Bearer ${surfaceJwt}` },
      });
      const hostA = res.json().hosts.find((h: { daemonId: string }) => h.daemonId === 'host-a');
      // Never spoken: no self-description, so no name and not online — rather
      // than a fabricated label or the other machine's description.
      expect(hostA.hostName).toBeNull();
      expect(hostA.online).toBe(false);
      expect(hostA.isHomeHost).toBe(false);
    } finally {
      await app.close();
    }
  });
});

// spec/11 § Host installation: the SERVER is the single source of the
// one-line install command. A surface that composes it from its own idea of the
// server's address gives a phone and a desktop two different commands, and both
// can be wrong.
describe('GET /api/daemon/install-command', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-installcmd-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env['PATCH_PUBLIC_URL'];
  });

  async function boot() {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(9));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({
      surfaceId: 'srf-i',
      surfaceKind: 'web',
      label: 'browser',
      issuedAt: 1,
    });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-i',
      surfaceKind: 'web',
      label: 'browser',
    });
    const built = await buildAll({
      dataDir: dir,
      registry,
      daemonLink: new InProcessDaemonLink(),
      jobsWatch: false,
    });
    return { app: built.app, jwt };
  }

  it('refuses before anything has been published, rather than inventing a command', async () => {
    process.env['PATCH_PUBLIC_URL'] = 'https://patch.example';
    const { app, jwt } = await boot();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/daemon/install-command?os=macos',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('nothing_published');
    } finally {
      await app.close();
    }
  });

  it('rejects an operating system it does not build for, naming the value', async () => {
    process.env['PATCH_PUBLIC_URL'] = 'https://patch.example';
    const { app, jwt } = await boot();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/daemon/install-command?os=windows',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('windows');
    } finally {
      await app.close();
    }
  });

  it('requires a credential', async () => {
    const { app } = await boot();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/daemon/install-command?os=macos' });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

// spec/17 § Hosts and the CLI: rename and set-home are SERVER-owned even when
// the command naming them runs on that very machine, because the registry holds
// both. The routes did not exist, so the CLI's own commands would have 404'd.
describe('server-owned host controls', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-hostctl-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function boot() {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(11));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({ surfaceId: 'srf-c', surfaceKind: 'web', label: 'b', issuedAt: 1 });
    registry.setDaemonKey({ daemonId: 'host-a', publicKey: user.publicKey, issuedAt: 1 });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-c',
      surfaceKind: 'web',
      label: 'b',
    });
    const built = await buildAll({
      dataDir: dir,
      registry,
      daemonLink: new InProcessDaemonLink(),
      jobsWatch: false,
    });
    return { app: built.app, jwt, registry };
  }

  it('renames a machine and the registry keeps it', async () => {
    const { app, jwt, registry } = await boot();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/hosts/rename',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { daemonId: 'host-a', hostName: 'laptop' },
      });
      expect(res.statusCode).toBe(200);
      expect(registry.hostName('host-a')).toBe('laptop');
    } finally {
      await app.close();
    }
  });

  it('refuses an empty rename rather than leaving a nameless machine', async () => {
    const { app, jwt } = await boot();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/hosts/rename',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { daemonId: 'host-a', hostName: '   ' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_name');
    } finally {
      await app.close();
    }
  });

  it('refuses a machine that is not registered, naming it', async () => {
    const { app, jwt } = await boot();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/hosts/set-home',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { daemonId: 'host-zzz' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().daemonId).toBe('host-zzz');
    } finally {
      await app.close();
    }
  });

  it('marks a machine the home machine', async () => {
    const { app, jwt, registry } = await boot();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/hosts/set-home',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { daemonId: 'host-a' },
      });
      expect(res.statusCode).toBe(200);
      expect(registry.homeDaemonId()).toBe('host-a');
    } finally {
      await app.close();
    }
  });

  it('requires a credential', async () => {
    const { app } = await boot();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/hosts/rename',
        payload: { daemonId: 'host-a', hostName: 'x' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
