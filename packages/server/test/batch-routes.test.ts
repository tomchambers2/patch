// Batch REST routes (spec/14 § Batch mode).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';

describe('batch REST routes', () => {
  let dir: string;
  let now: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-batch-routes-'));
    now = Date.parse('2026-10-02T10:00:00Z');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function bootstrap() {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(21));
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
    const daemonLink = new InProcessDaemonLink();
    const built = await buildAll({
      logger: false,
      registry,
      daemonLink,
      nowMs: () => now,
    });
    return { jwt, built };
  }

  it('GET /api/batch starts with no batch running', async () => {
    const { jwt, built } = await bootstrap();
    try {
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/batch',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ batch: null, carryover: [] });
    } finally {
      await built.app.close();
    }
  });

  it('rejects an unauthenticated request', async () => {
    const { built } = await bootstrap();
    try {
      const res = await built.app.inject({ method: 'GET', url: '/api/batch' });
      expect(res.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/batch/start creates a running batch with the chosen check-in', async () => {
    const { jwt, built } = await bootstrap();
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/batch/start',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { checkIn: { type: 'time', minutes: 20 } },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { batch: { checkIn: unknown; members: string[] } | null };
      expect(body.batch?.checkIn).toEqual({ type: 'time', minutes: 20 });
      expect(body.batch?.members).toEqual([]);
    } finally {
      await built.app.close();
    }
  });

  it('a second start() while running returns the existing batch unchanged', async () => {
    const { jwt, built } = await bootstrap();
    try {
      await built.app.inject({
        method: 'POST',
        url: '/api/batch/start',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { checkIn: { type: 'time', minutes: 15 } },
      });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/batch/start',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { checkIn: { type: 'time', minutes: 30 } },
      });
      const body = res.json() as { batch: { checkIn: unknown } | null };
      expect(body.batch?.checkIn).toEqual({ type: 'time', minutes: 15 });
    } finally {
      await built.app.close();
    }
  });

  it('DELETE /api/batch/members/:chatId removes a member', async () => {
    const { jwt, built } = await bootstrap();
    try {
      await built.app.inject({
        method: 'POST',
        url: '/api/batch/start',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { checkIn: { type: 'time', minutes: 20 } },
      });
      built.batchStore.ensureMember('c1');
      built.batchStore.ensureMember('c2');
      const res = await built.app.inject({
        method: 'DELETE',
        url: '/api/batch/members/c1',
        headers: { authorization: `Bearer ${jwt}` },
      });
      const body = res.json() as { batch: { members: string[] } | null };
      expect(body.batch?.members).toEqual(['c2']);
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/batch/check-in-now checks in without notifying', async () => {
    const { jwt, built } = await bootstrap();
    const sent: unknown[] = [];
    built.notificationRouter.route = (async (event: unknown) => {
      sent.push(event);
    }) as typeof built.notificationRouter.route;
    try {
      await built.app.inject({
        method: 'POST',
        url: '/api/batch/start',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { checkIn: { type: 'time', minutes: 20 } },
      });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/batch/check-in-now',
        headers: { authorization: `Bearer ${jwt}` },
      });
      const body = res.json() as { batch: { checkedIn: boolean } | null };
      expect(body.batch?.checkedIn).toBe(true);
      expect(sent).toEqual([]);
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/batch/opened ends the batch once every ready member is opened', async () => {
    const { jwt, built } = await bootstrap();
    try {
      await built.app.inject({
        method: 'POST',
        url: '/api/batch/start',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { checkIn: { type: 'time', minutes: 20 } },
      });
      built.batchStore.ensureMember('c1');
      built.batchStore.checkIn();
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/batch/opened',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { chatId: 'c1' },
      });
      const body = res.json() as { batch: unknown };
      // c1 has no chat-registry row at all, so `isReady` reads it as ready —
      // the batch ends the moment it's opened.
      expect(body.batch).toBeNull();
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/batch/start with an invalid body is a 400', async () => {
    const { jwt, built } = await bootstrap();
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/batch/start',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { checkIn: { type: 'time', minutes: 45 } },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await built.app.close();
    }
  });
});
