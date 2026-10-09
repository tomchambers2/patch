// Manager sweep REST routes (spec/06 § Sweep — Visible / Check now).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';

describe('manager sweep REST routes', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-sweep-routes-'));
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
    const built = await buildAll({ logger: false, registry, daemonLink });
    return { jwt, built };
  }

  it('GET /api/manager/sweeps starts empty', async () => {
    const { jwt, built } = await bootstrap();
    try {
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/manager/sweeps',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ runs: [] });
    } finally {
      await built.app.close();
    }
  });

  it('rejects an unauthenticated GET', async () => {
    const { built } = await bootstrap();
    try {
      const res = await built.app.inject({ method: 'GET', url: '/api/manager/sweeps' });
      expect(res.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/manager/sweep/check-now reports fired:false with nothing pending (gate: no model call)', async () => {
    const { jwt, built } = await bootstrap();
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/manager/sweep/check-now',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ fired: false });
    } finally {
      await built.app.close();
    }
  });

  it('rejects an unauthenticated check-now', async () => {
    const { built } = await bootstrap();
    try {
      const res = await built.app.inject({ method: 'POST', url: '/api/manager/sweep/check-now' });
      expect(res.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });

  it('a recorded sweep run shows up in the list', async () => {
    const { jwt, built } = await bootstrap();
    try {
      built.managerSweeper.onResult({
        runId: 'run-1',
        actions: [{ chatId: 'c1', action: 'nudge' }],
        tokensUsed: 500,
      });
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/manager/sweeps',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { runs: { runId: string; tokensUsed: number }[] };
      expect(body.runs).toHaveLength(1);
      expect(body.runs[0]).toMatchObject({ runId: 'run-1', tokensUsed: 500 });
    } finally {
      await built.app.close();
    }
  });
});
