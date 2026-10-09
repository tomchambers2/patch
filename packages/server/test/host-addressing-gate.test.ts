// A1 — the ingress gate for host-addressed frames and routes.
//
// spec/03 § Host events, spec/04 § Spawn ("A spawn naming an unregistered host
// is an error"). A frame or request naming a machine this account has NOT
// registered must be refused with the offending id named — never relayed to
// whichever host happens to be attached. With one machine online those two
// behaviours are indistinguishable from the outside, which is exactly why the
// check has to be asserted here rather than inferred from a working spawn.

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

const REGISTERED = 'host-a';
const UNREGISTERED = 'host-zzz';

describe('host-addressing gate', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-host-gate-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function bootstrap() {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(41));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({
      surfaceId: 'srf-gate',
      surfaceKind: 'web',
      label: 'browser',
      issuedAt: 1,
    });
    registry.setDaemonKey({ daemonId: REGISTERED, publicKey: user.publicKey, issuedAt: 1 });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-gate',
      surfaceKind: 'web',
      label: 'browser',
    });
    return { registry, jwt };
  }

  describe('Registry', () => {
    it('knows which machines are registered, and drops a revoked one', async () => {
      const { registry } = await bootstrap();
      expect(registry.registeredDaemonIds()).toEqual([REGISTERED]);
      expect(registry.isRegisteredDaemon(REGISTERED)).toBe(true);
      expect(registry.isRegisteredDaemon(UNREGISTERED)).toBe(false);
      registry.revoke(REGISTERED);
      // A revoked machine is no longer addressable — a frame naming it must be
      // refused exactly like one naming a machine that never existed.
      expect(registry.registeredDaemonIds()).toEqual([]);
      expect(registry.isRegisteredDaemon(REGISTERED)).toBe(false);
    });
  });

  describe('REST', () => {
    it('POST /api/chats refuses an unregistered machine, naming it, and forwards nothing', async () => {
      const { registry, jwt } = await bootstrap();
      const daemonLink = new InProcessDaemonLink();
      const built = await buildAll({ logger: false, registry, daemonLink, spawnErrorWaitMs: 50 });
      try {
        const res = await built.app.inject({
          method: 'POST',
          url: '/api/chats',
          headers: { authorization: `Bearer ${jwt}` },
          payload: { daemonId: UNREGISTERED, folder: '/work/proj' },
        });
        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual({
          error: 'unknown_host',
          message: `no machine registered with daemonId: ${UNREGISTERED}`,
          daemonId: UNREGISTERED,
          knownHosts: [REGISTERED],
        });
        // The absence of a side-effect is the point: nothing reached the host,
        // so no chat exists anywhere.
        expect(daemonLink.sent.filter((s) => s.event.type === 'chat.spawn_request')).toEqual([]);
      } finally {
        await built.app.close();
      }
    });

    it('GET /api/models refuses an unregistered machine rather than reading the attached one', async () => {
      const { registry, jwt } = await bootstrap();
      const daemonLink = new InProcessDaemonLink();
      const built = await buildAll({ logger: false, registry, daemonLink });
      try {
        const res = await built.app.inject({
          method: 'GET',
          url: `/api/models?daemonId=${UNREGISTERED}`,
          headers: { authorization: `Bearer ${jwt}` },
        });
        expect(res.statusCode).toBe(404);
        expect(res.json()).toMatchObject({ error: 'unknown_host', daemonId: UNREGISTERED });
        expect(daemonLink.sent.filter((s) => s.event.type === 'patch.models.request')).toEqual([]);
      } finally {
        await built.app.close();
      }
    });

    it('GET /api/skills refuses an unregistered machine rather than reading the attached one', async () => {
      const { registry, jwt } = await bootstrap();
      const daemonLink = new InProcessDaemonLink();
      const built = await buildAll({ logger: false, registry, daemonLink });
      try {
        const res = await built.app.inject({
          method: 'GET',
          url: `/api/skills?folder=%2Fwork%2Fproj&daemonId=${UNREGISTERED}`,
          headers: { authorization: `Bearer ${jwt}` },
        });
        expect(res.statusCode).toBe(404);
        expect(res.json()).toMatchObject({ error: 'unknown_host', daemonId: UNREGISTERED });
        expect(daemonLink.sent.filter((s) => s.event.type === 'patch.skills.request')).toEqual([]);
      } finally {
        await built.app.close();
      }
    });

    it('GET /api/folders/browse refuses an unregistered machine', async () => {
      const { registry, jwt } = await bootstrap();
      const daemonLink = new InProcessDaemonLink();
      const built = await buildAll({ logger: false, registry, daemonLink });
      try {
        const res = await built.app.inject({
          method: 'GET',
          url: `/api/folders/browse?daemonId=${UNREGISTERED}`,
          headers: { authorization: `Bearer ${jwt}` },
        });
        expect(res.statusCode).toBe(404);
        expect(res.json()).toMatchObject({ error: 'unknown_host', daemonId: UNREGISTERED });
        expect(
          daemonLink.sent.filter((s) => s.event.type === 'patch.folders.browse.request'),
        ).toEqual([]);
      } finally {
        await built.app.close();
      }
    });
  });

  describe('WebSocket', () => {
    async function startServer(registry: Registry, daemonLink: InProcessDaemonLink) {
      const built = await buildAll({ logger: false, registry, daemonLink });
      await built.app.listen({ port: 0, host: '127.0.0.1' });
      const addr = built.app.server.address() as AddressInfo;
      return { url: `ws://127.0.0.1:${addr.port}/ws`, app: built.app };
    }

    it.each([
      [
        'chat.spawn_request',
        { type: 'chat.spawn_request', daemonId: UNREGISTERED, folder: '/work/proj' },
      ],
      ['host.rename', { type: 'host.rename', daemonId: UNREGISTERED, hostName: 'nope' }],
      ['host.settings', { type: 'host.settings', daemonId: UNREGISTERED, harnessMcpServers: [] }],
      ['host.folder_add', { type: 'host.folder_add', daemonId: UNREGISTERED, path: '/work/proj' }],
      [
        'host.component_install',
        { type: 'host.component_install', daemonId: UNREGISTERED, componentId: 'kokoro' },
      ],
      [
        'host.backend_usage_refresh',
        { type: 'host.backend_usage_refresh', daemonId: UNREGISTERED, backendId: 'claude-code' },
      ],
      [
        'patch.models.request',
        { type: 'patch.models.request', requestId: 'r1', daemonId: UNREGISTERED },
      ],
      [
        'patch.terminal.open',
        { type: 'patch.terminal.open', sessionId: 's1', daemonId: UNREGISTERED },
      ],
    ])('%s naming an unregistered machine is refused, not relayed', async (_label, frame) => {
      const { registry, jwt } = await bootstrap();
      const daemonLink = new InProcessDaemonLink();
      const h = await startServer(registry, daemonLink);
      try {
        const client = new WireTestClient({ url: h.url, auth: jwt });
        await client.connect();
        const before = daemonLink.sent.length;
        client.send(frame as never);
        const err = await client.waitFor('chat.error');
        expect(err).toMatchObject({
          type: 'chat.error',
          error: {
            code: 'host_not_registered',
            message: `no machine registered with daemonId: ${UNREGISTERED}`,
          },
        });
        expect(daemonLink.sent.length).toBe(before);
        await client.close();
      } finally {
        await h.app.close();
      }
    });

    it('relays the same frame when it names the REGISTERED machine', async () => {
      const { registry, jwt } = await bootstrap();
      const daemonLink = new InProcessDaemonLink();
      const h = await startServer(registry, daemonLink);
      try {
        const client = new WireTestClient({ url: h.url, auth: jwt });
        await client.connect();
        client.send({ type: 'chat.spawn_request', daemonId: REGISTERED, folder: '/work/proj' });
        await expect
          .poll(() => daemonLink.sent.filter((s) => s.event.type === 'chat.spawn_request').length)
          .toBe(1);
        const sent = daemonLink.sent.find((s) => s.event.type === 'chat.spawn_request')!;
        expect(sent.event).toMatchObject({ daemonId: REGISTERED, folder: '/work/proj' });
        await client.close();
      } finally {
        await h.app.close();
      }
    });
  });
});
