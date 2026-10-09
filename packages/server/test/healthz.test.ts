import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import { build } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';

/** Bootstrap an account on `registry` and mint a surface JWT for it. */
async function authFor(registry: Registry): Promise<string> {
  const user = generateUserKeypair(() => new Uint8Array(32).fill(13));
  registry.bootstrapAccount({ keypair: user });
  return mintSurfaceCredential({
    userPrivateKey: user.privateKey,
    surfaceId: 'srf-web-1',
    surfaceKind: 'web',
    label: 'browser',
  });
}

describe('healthz', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-healthz-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('GET /api/healthz returns ok + version + gitSha', async () => {
    const registry = Registry.load(dir);
    const app = await build({ logger: false, registry, daemonLink: new InProcessDaemonLink() });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/healthz' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { ok: boolean; version: string; gitSha: string };
      expect(body.ok).toBe(true);
      expect(body.version.length).toBeGreaterThan(0);
      expect(body.gitSha.length).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it('GET /api/daemon/healthz returns 200 ok when the host WS is online (authed)', async () => {
    const registry = Registry.load(dir);
    const credential = await authFor(registry);
    const link = new InProcessDaemonLink(); // defaults to online
    const app = await build({ logger: false, registry, daemonLink: link });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/daemon/healthz',
        headers: { authorization: `Bearer ${credential}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { ok: boolean };
      expect(body.ok).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('GET /api/daemon/healthz returns 503 when the host WS is offline (authed)', async () => {
    const registry = Registry.load(dir);
    const credential = await authFor(registry);
    const link = new InProcessDaemonLink();
    link.setStatus('offline');
    const app = await build({ logger: false, registry, daemonLink: link });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/daemon/healthz',
        headers: { authorization: `Bearer ${credential}` },
      });
      expect(res.statusCode).toBe(503);
      const body = res.json() as { ok: boolean; reason: string };
      expect(body.ok).toBe(false);
      expect(body.reason).toBe('host offline');
    } finally {
      await app.close();
    }
  });

  it('GET /api/daemon/healthz returns 401 without a Bearer token (E1-d5)', async () => {
    const registry = Registry.load(dir);
    await authFor(registry);
    const link = new InProcessDaemonLink(); // online — but no auth header
    const app = await build({ logger: false, registry, daemonLink: link });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/daemon/healthz' });
      expect(res.statusCode).toBe(401);
      expect((res.json() as { error: string }).error).toBe('unauthenticated');
    } finally {
      await app.close();
    }
  });

  it('GET /app/ has CSP, X-Frame-Options, X-Content-Type-Options', async () => {
    const webDir = mkdtempSync(join(tmpdir(), 'patch-spa-'));
    writeFileSync(join(webDir, 'index.html'), '<!doctype html><html><body>ok</body></html>');
    const registry = Registry.load(dir);
    const app = await build({
      logger: false,
      registry,
      daemonLink: new InProcessDaemonLink(),
      webDistDir: webDir,
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/app' });
      expect(res.statusCode).toBe(200);
      const headers = res.headers as Record<string, string | undefined>;
      expect(headers['content-security-policy']).toBeDefined();
      expect(headers['content-security-policy']).toMatch(/default-src 'self'/);
      // Composer attachment previews are shown from blob: object URLs before
      // upload — img-src MUST allow blob: or the thumbnails render broken.
      expect(headers['content-security-policy']).toMatch(/img-src[^;]*blob:/);
      expect(headers['x-frame-options']?.toUpperCase()).toBe('SAMEORIGIN');
      expect(headers['x-content-type-options']?.toLowerCase()).toBe('nosniff');
    } finally {
      await app.close();
      rmSync(webDir, { recursive: true, force: true });
    }
  });
});
