// Coverage for app.ts's own wiring/branches not exercised by the feature-area
// test files (auth-routes.test.ts, jobs-*.test.ts, notifications.test.ts,
// etc.): the pino logger-option ternary, the unified setErrorHandler safety
// net, the APK download route, /api/daemon/healthz's auth edge cases, the
// jobsDataDir / jobsStore branches, the PATCH_JOBS_DIAG gate, the Expo push
// real-backend construction branch, the patch.call startCall failure path,
// and the /app SPA mount (wildcard route + root redirect).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import { build, buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';
import { JobStore } from '../src/jobs/store.js';
import pino from 'pino';

async function authFor(registry: Registry): Promise<string> {
  const user = generateUserKeypair(() => new Uint8Array(32).fill(20));
  registry.bootstrapAccount({ keypair: user });
  registry.upsertSurface({
    surfaceId: 'srf-web-1',
    surfaceKind: 'web',
    label: 'browser',
    issuedAt: 1,
  });
  return mintSurfaceCredential({
    userPrivateKey: user.privateKey,
    surfaceId: 'srf-web-1',
    surfaceKind: 'web',
    label: 'browser',
  });
}

/** Mint a surface JWT for an ALREADY-bootstrapped account + keypair. */
async function mintFor(
  registry: Registry,
  user: { publicKey: string; privateKey: string },
  surfaceId: string,
): Promise<string> {
  registry.upsertSurface({ surfaceId, surfaceKind: 'web', label: 'browser', issuedAt: 1 });
  return mintSurfaceCredential({
    userPrivateKey: user.privateKey,
    surfaceId,
    surfaceKind: 'web',
    label: 'browser',
  });
}

describe('app.ts — logger option branches', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-app-logger-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('accepts logger: true (attaches pino redaction, boots fine)', async () => {
    const registry = Registry.load(dir);
    const app = await build({ logger: true, registry, daemonLink: new InProcessDaemonLink() });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/healthz' });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('accepts an explicit logger object (merges redact config)', async () => {
    const registry = Registry.load(dir);
    const app = await build({
      logger: { level: 'silent' },
      registry,
      daemonLink: new InProcessDaemonLink(),
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/healthz' });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe('app.ts — build() requires registry or dataDir', () => {
  it('throws when neither registry nor dataDir is provided', async () => {
    await expect(
      buildAll({ logger: false, daemonLink: new InProcessDaemonLink() }),
    ).rejects.toThrow(/either registry or dataDir is required/);
  });
});

describe('app.ts — unified error envelope (setErrorHandler safety net)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-app-errh-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function buildWithTestRoutes(): Promise<Awaited<ReturnType<typeof build>>> {
    const registry = Registry.load(dir);
    const app = await build({ logger: false, registry, daemonLink: new InProcessDaemonLink() });
    // Synthetic throwing routes registered on the SAME already-built app
    // instance — this exercises app.ts's globally-registered setErrorHandler
    // (a genuine cross-cutting concern) without depending on any one
    // production route happening to leave an error uncaught. Every real
    // route already handles its own typed errors (per the comment in
    // app.ts), so this is the only way to drive the safety net honestly.
    const { AccountConflictError } = await import('../src/registry.js');
    const { FilterError } = await import('../src/jobs/filter.js');
    const { InvalidJobIdError } = await import('../src/jobs/logs.js');
    app.get('/__test/throw/validation', async () => {
      const err = new Error('bad body') as Error & { validation: unknown[] };
      err.validation = [{ message: 'must be string' }];
      throw err;
    });
    app.get('/__test/throw/account-conflict', async () => {
      throw new AccountConflictError();
    });
    app.get('/__test/throw/filter-error', async () => {
      throw new FilterError('bad jsonata', new Error('parse fail'));
    });
    app.get('/__test/throw/invalid-job-id', async () => {
      throw new InvalidJobIdError('../evil');
    });
    app.get('/__test/throw/statusCode-4xx', async () => {
      const err = new Error('teapot') as Error & { statusCode: number };
      err.statusCode = 418;
      throw err;
    });
    app.get('/__test/throw/generic', async () => {
      throw new Error('something truly unexpected');
    });
    app.get('/__test/throw/statusCode-4xx-no-message', async () => {
      // A 4xx-tagged error with NO .message — hits the `err.message ?? 'request
      // error'` fallback branch specifically (an empty string is NOT ??'s
      // fallback trigger; this must be a genuinely absent message).
      const err = { statusCode: 429 } as unknown as Error;
      throw err;
    });
    return app;
  }

  it('err.validation → 400 { error: "invalid body", issues }', async () => {
    const app = await buildWithTestRoutes();
    try {
      const res = await app.inject({ method: 'GET', url: '/__test/throw/validation' });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'invalid body' });
    } finally {
      await app.close();
    }
  });

  it('AccountConflictError → 409 { error: "account_conflict" }', async () => {
    const app = await buildWithTestRoutes();
    try {
      const res = await app.inject({ method: 'GET', url: '/__test/throw/account-conflict' });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'account_conflict' });
    } finally {
      await app.close();
    }
  });

  it('FilterError → 400 { error: "filter_error" }', async () => {
    const app = await buildWithTestRoutes();
    try {
      const res = await app.inject({ method: 'GET', url: '/__test/throw/filter-error' });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'filter_error' });
    } finally {
      await app.close();
    }
  });

  it('InvalidJobIdError → 400 { error: "invalid jobId" }', async () => {
    const app = await buildWithTestRoutes();
    try {
      const res = await app.inject({ method: 'GET', url: '/__test/throw/invalid-job-id' });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'invalid jobId' });
    } finally {
      await app.close();
    }
  });

  it('a generic 4xx-tagged error preserves its statusCode + message', async () => {
    const app = await buildWithTestRoutes();
    try {
      const res = await app.inject({ method: 'GET', url: '/__test/throw/statusCode-4xx' });
      expect(res.statusCode).toBe(418);
      expect(res.json()).toMatchObject({ error: 'teapot' });
    } finally {
      await app.close();
    }
  });

  it('a 4xx-tagged error with no .message falls back to "request error"', async () => {
    const app = await buildWithTestRoutes();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/__test/throw/statusCode-4xx-no-message',
      });
      expect(res.statusCode).toBe(429);
      expect(res.json()).toEqual({ error: 'request error' });
    } finally {
      await app.close();
    }
  });

  it('an unmapped error falls through to 500 { error: "internal" } (no stack/message leak)', async () => {
    const app = await buildWithTestRoutes();
    try {
      const res = await app.inject({ method: 'GET', url: '/__test/throw/generic' });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: 'internal' });
    } finally {
      await app.close();
    }
  });
});

describe('app.ts — /api/daemon/:name (the host install + artifact channel)', () => {
  // spec/11 § Deploy guide: the host artifacts are published to the server,
  // which serves them with a version manifest — the one channel that feeds a
  // new machine's install command. Unauthenticated by design: a machine with
  // nothing on it has no credential yet, and the pairing code is what gates
  // joining the account.
  let dir: string;
  let downloadsDir: string;
  const originalEnv = process.env.PATCH_DOWNLOADS_DIR;
  const originalPublic = process.env.PATCH_PUBLIC_URL;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-app-daemon-'));
    downloadsDir = mkdtempSync(join(tmpdir(), 'patch-app-daemon-dl-'));
    process.env.PATCH_DOWNLOADS_DIR = downloadsDir;
    process.env.PATCH_PUBLIC_URL = 'https://patch.example.com';
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(downloadsDir, { recursive: true, force: true });
    if (originalEnv === undefined) delete process.env.PATCH_DOWNLOADS_DIR;
    else process.env.PATCH_DOWNLOADS_DIR = originalEnv;
    if (originalPublic === undefined) delete process.env.PATCH_PUBLIC_URL;
    else process.env.PATCH_PUBLIC_URL = originalPublic;
  });

  it('serves install.sh with this server’s own address substituted in', async () => {
    writeFileSync(
      join(downloadsDir, 'install.sh'),
      '#!/bin/sh\nSERVER_URL="${PATCH_SERVER_URL:-@@PATCH_SERVER_URL@@}"\n',
    );
    const registry = Registry.load(dir);
    const app = await build({ logger: false, registry, daemonLink: new InProcessDaemonLink() });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/daemon/install.sh' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/x-shellscript');
      expect(res.body).toContain('https://patch.example.com');
      expect(res.body).not.toContain('@@PATCH_SERVER_URL@@');
    } finally {
      await app.close();
    }
  });

  it('serves the manifest and the per-platform artifacts', async () => {
    writeFileSync(join(downloadsDir, 'daemon-latest.json'), '{"version":"0.1.1"}');
    writeFileSync(join(downloadsDir, 'patch-daemon-0.1.1-linux-x64.tar.gz'), 'tarball');
    writeFileSync(join(downloadsDir, 'patch-daemon-0.1.1-linux-x64.tar.gz.sig'), 'sig');
    const registry = Registry.load(dir);
    const app = await build({ logger: false, registry, daemonLink: new InProcessDaemonLink() });
    try {
      const manifest = await app.inject({ method: 'GET', url: '/api/daemon/daemon-latest.json' });
      expect(manifest.statusCode).toBe(200);
      expect(manifest.json()).toEqual({ version: '0.1.1' });
      const art = await app.inject({
        method: 'GET',
        url: '/api/daemon/patch-daemon-0.1.1-linux-x64.tar.gz',
      });
      expect(art.statusCode).toBe(200);
      expect(art.headers['content-type']).toBe('application/gzip');
      expect(art.body).toBe('tarball');
      const sig = await app.inject({
        method: 'GET',
        url: '/api/daemon/patch-daemon-0.1.1-linux-x64.tar.gz.sig',
      });
      expect(sig.statusCode).toBe(200);
      expect(sig.body).toBe('sig');
    } finally {
      await app.close();
    }
  });

  it('404s on anything outside the published shapes, and when nothing is published', async () => {
    const registry = Registry.load(dir);
    const app = await build({ logger: false, registry, daemonLink: new InProcessDaemonLink() });
    try {
      const bad = await app.inject({ method: 'GET', url: '/api/daemon/registry.json' });
      expect(bad.statusCode).toBe(404);
      expect(bad.json()).toEqual({ error: 'not found' });
      const missing = await app.inject({ method: 'GET', url: '/api/daemon/daemon-latest.json' });
      expect(missing.statusCode).toBe(404);
      expect(missing.json().error).toMatch(/no such host artifact published/);
    } finally {
      await app.close();
    }
  });
});

describe('app.ts — /api/download/:name (APK download)', () => {
  let dir: string;
  let downloadsDir: string;
  const originalEnv = process.env.PATCH_DOWNLOADS_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-app-apk-'));
    downloadsDir = mkdtempSync(join(tmpdir(), 'patch-app-downloads-'));
    process.env.PATCH_DOWNLOADS_DIR = downloadsDir;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(downloadsDir, { recursive: true, force: true });
    if (originalEnv === undefined) delete process.env.PATCH_DOWNLOADS_DIR;
    else process.env.PATCH_DOWNLOADS_DIR = originalEnv;
  });

  it('404s on a name that does not match the patch*.apk whitelist', async () => {
    const registry = Registry.load(dir);
    const app = await build({ logger: false, registry, daemonLink: new InProcessDaemonLink() });
    try {
      // A single path segment (no slashes, so it actually reaches the route
      // handler) that fails the `patch*.apk` regex — e.g. wrong extension.
      const res = await app.inject({ method: 'GET', url: '/api/download/not-patch.apk' });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'not found' });

      const res2 = await app.inject({ method: 'GET', url: '/api/download/patch.exe' });
      expect(res2.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('404s when the whitelisted name has no published file', async () => {
    const registry = Registry.load(dir);
    const app = await build({ logger: false, registry, daemonLink: new InProcessDaemonLink() });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/download/patch.apk' });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toMatch(/no such APK published/);
    } finally {
      await app.close();
    }
  });

  it('200s + streams the APK with the right headers when published', async () => {
    writeFileSync(join(downloadsDir, 'patch-abc123.apk'), 'fake apk bytes');
    const registry = Registry.load(dir);
    const app = await build({ logger: false, registry, daemonLink: new InProcessDaemonLink() });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/download/patch-abc123.apk' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/vnd.android.package-archive');
      expect(res.headers['content-disposition']).toContain('patch-abc123.apk');
      expect(res.body).toBe('fake apk bytes');
    } finally {
      await app.close();
    }
  });

  it('404s (no APK published) for the sidecar when it is not present', async () => {
    const registry = Registry.load(dir);
    const app = await build({ logger: false, registry, daemonLink: new InProcessDaemonLink() });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/download/android-latest.json' });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toMatch(/no APK published/);
    } finally {
      await app.close();
    }
  });

  it('200s + serves android-latest.json as JSON so the delivery step can verify the published commit', async () => {
    const sidecar = {
      version: '0.1.339',
      gitSha: '6dbbd49',
      builtAt: '2026-07-30T00:00:00.000Z',
      file: 'patch-6dbbd49.apk',
    };
    writeFileSync(join(downloadsDir, 'android-latest.json'), JSON.stringify(sidecar));
    const registry = Registry.load(dir);
    const app = await build({ logger: false, registry, daemonLink: new InProcessDaemonLink() });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/download/android-latest.json' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.headers['content-disposition']).toBeUndefined();
      expect(res.json()).toEqual(sidecar);
    } finally {
      await app.close();
    }
  });
});

describe('app.ts — /api/daemon/healthz auth edge cases', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-app-daemonhz-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('401s when no account has been bootstrapped', async () => {
    const registry = Registry.load(dir); // no bootstrapAccount()
    const app = await build({ logger: false, registry, daemonLink: new InProcessDaemonLink() });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/daemon/healthz',
        headers: { authorization: 'Bearer whatever' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('401s for a revoked surface JWT', async () => {
    const registry = Registry.load(dir);
    const jwt = await authFor(registry);
    registry.revoke('srf-web-1');
    const app = await build({ logger: false, registry, daemonLink: new InProcessDaemonLink() });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/daemon/healthz',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('401s for a garbage/invalid JWT (catch branch)', async () => {
    const registry = Registry.load(dir);
    await authFor(registry);
    const app = await build({ logger: false, registry, daemonLink: new InProcessDaemonLink() });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/daemon/healthz',
        headers: { authorization: 'Bearer not-a-real-jwt' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

describe('app.ts — jobsDataDir / jobsStore branches', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-app-jobsdd-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('throws when neither opts.dataDir nor registry.dataDir is available', async () => {
    const registry = Registry.load(dir);
    registry.bootstrapAccount();
    // Registry.load always sets a real dataDir string; force the fallback
    // empty case app.ts explicitly guards against (readonly is compile-time
    // only — this does not disturb the registry's own internal file path,
    // which is captured separately at construction time).
    (registry as unknown as { dataDir: string }).dataDir = '';
    await expect(
      buildAll({ logger: false, registry, daemonLink: new InProcessDaemonLink() }),
    ).rejects.toThrow(/dataDir required for jobs/);
  });

  it('uses an injected jobsStore instead of constructing its own JobStore', async () => {
    const registry = Registry.load(dir);
    registry.bootstrapAccount();
    const injectedStore = new JobStore({
      dataDir: dir,
      logger: pino({ level: 'silent' }),
      watch: false,
    });
    injectedStore.create({
      name: 'preseeded',
      trigger: { type: 'cron', expression: '0 9 * * *' },
      action: { type: 'spawn', daemonId: 'd1', folder: '/work', prompt: 'go' },
    });
    const built = await buildAll({
      logger: false,
      registry,
      daemonLink: new InProcessDaemonLink(),
      jobsStore: injectedStore,
    });
    try {
      expect(built.jobs).toBe(injectedStore);
      expect(built.jobs.list().some((j) => j.name === 'preseeded')).toBe(true);
    } finally {
      built.cronScheduler.stop();
      built.jobDispatcher.close();
      await injectedStore.close();
      await built.app.close();
    }
  });
});

describe('app.ts — PATCH_JOBS_DIAG gate + chatExists (ensure-action) coverage', () => {
  let dir: string;
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = ['NODE_ENV', 'PATCH_JOBS_DIAG'] as const;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-app-jobsdiag-'));
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    delete process.env.NODE_ENV;
    process.env.PATCH_JOBS_DIAG = '1';
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it('mounts /internal/diag/jobs/fire-cron when PATCH_JOBS_DIAG=1 + a valid internalToken; firing an "continue" action exercises chatExists', async () => {
    const registry = Registry.load(dir);
    const user = generateUserKeypair(() => new Uint8Array(32).fill(21));
    registry.bootstrapAccount({ keypair: user });
    const jwt = await mintFor(registry, user, 'srf-diag-1');
    const internalToken = 'diag-internal-token-0123456789ab';
    const built = await buildAll({
      logger: false,
      registry,
      daemonLink: new InProcessDaemonLink(),
      internalToken,
      jobsWatch: false,
    });
    try {
      const create = await built.app.inject({
        method: 'POST',
        url: '/api/jobs',
        headers: { authorization: `Bearer ${jwt}` },
        payload: {
          name: 'ensure-durable-chat',
          trigger: { type: 'cron', expression: '0 9 * * *' },
          action: { type: 'continue', daemonId: 'd1', folder: '/persist', prompt: 'tick' },
        },
      });
      expect(create.statusCode).toBe(201);
      const jobId = (create.json() as { id: string }).id;

      const fire = await built.app.inject({
        method: 'POST',
        url: '/internal/diag/jobs/fire-cron',
        headers: { 'x-patch-internal-token': internalToken },
        payload: { jobId },
      });
      expect(fire.statusCode).toBe(202);
      expect(fire.json()).toMatchObject({ fired: true, jobId });
    } finally {
      await built.app.close();
    }
  });

  it('does NOT mount the jobs-diag route when NODE_ENV=production, even with the flag set', async () => {
    process.env.NODE_ENV = 'production';
    process.env.PATCH_VERSION = '1.0.0-test';
    process.env.PATCH_GIT_SHA = 'deadbee';
    const registry = Registry.load(dir);
    registry.bootstrapAccount();
    const built = await buildAll({
      logger: false,
      registry,
      daemonLink: new InProcessDaemonLink(),
      internalToken: 'diag-internal-token-0123456789ab',
      jobsWatch: false,
      pushBackend: { send: async () => ({ delivered: 0, failed: [], permanentlyRejected: [] }) },
    });
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/internal/diag/jobs/fire-cron',
        headers: { 'x-patch-internal-token': 'diag-internal-token-0123456789ab' },
        payload: { jobId: 'whatever' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await built.app.close();
      delete process.env.PATCH_VERSION;
      delete process.env.PATCH_GIT_SHA;
    }
  });
});

describe('app.ts — Expo push real backend construction (no injected pushBackend)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-app-push-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('constructs a real ExpoPushBackend with no env configured when no pushBackend is injected', async () => {
    const registry = Registry.load(dir);
    registry.bootstrapAccount();
    // No pushBackend injected, and nothing push-related in the environment —
    // buildAll must still construct a working ExpoPushBackend and start:
    // Expo's push API takes no server credential (spec/09 § Channel
    // credentials), so "no push configured" is not a state that exists.
    const built = await buildAll({
      logger: false,
      registry,
      daemonLink: new InProcessDaemonLink(),
      jobsWatch: false,
    });
    try {
      const res = await built.app.inject({ method: 'GET', url: '/api/healthz' });
      expect(res.statusCode).toBe(200);
    } finally {
      await built.app.close();
    }
  });
});

describe('app.ts — patch.call host event whose startCall rejects', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-app-callfail-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('logs a warning and does not crash the server when callOrchestrator.startCall rejects', async () => {
    const registry = Registry.load(dir);
    registry.bootstrapAccount();
    const daemonLink = new InProcessDaemonLink();
    const built = await buildAll({
      logger: false,
      registry,
      daemonLink,
      jobsWatch: false,
      // A throwing idGenerator makes CallOrchestrator.startCall's synchronous
      // id-allocation step throw, rejecting the promise app.ts's daemon-link
      // handler wraps in .catch(...) for the 'patch.call' branch.
      idGenerator: () => {
        throw new Error('id gen boom');
      },
    });
    try {
      expect(() => {
        daemonLink.emit({ type: 'patch.call', chatId: 'thread_manager', message: 'ring ring' });
      }).not.toThrow();
      await new Promise((r) => setTimeout(r, 30));
      // Server is still alive and responsive after the rejection.
      const res = await built.app.inject({ method: 'GET', url: '/api/healthz' });
      expect(res.statusCode).toBe(200);
    } finally {
      await built.app.close();
    }
  });
});

describe('app.ts — /app SPA mount: wildcard route + root redirect', () => {
  let dir: string;
  let webDir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-app-spa-'));
    webDir = mkdtempSync(join(tmpdir(), 'patch-app-spa-web-'));
    writeFileSync(join(webDir, 'index.html'), '<!doctype html><html><body>spa</body></html>');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(webDir, { recursive: true, force: true });
  });

  it('GET /app/some/deep/route serves the SPA index.html (client-side router fallback)', async () => {
    const registry = Registry.load(dir);
    const app = await build({
      logger: false,
      registry,
      daemonLink: new InProcessDaemonLink(),
      webDistDir: webDir,
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/app/some/deep/route' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('spa');
    } finally {
      await app.close();
    }
  });

  it('GET /app/assets/present.js (an existing static file under webRoot) still resolves via the fallback', async () => {
    mkdirSync(join(webDir, 'assets'), { recursive: true });
    writeFileSync(join(webDir, 'assets', 'present.js'), 'console.log(1)');
    const registry = Registry.load(dir);
    const app = await build({
      logger: false,
      registry,
      daemonLink: new InProcessDaemonLink(),
      webDistDir: webDir,
    });
    try {
      // The @fastify/static plugin serves the real file directly (before the
      // wildcard fallback even runs) since it's registered first in scope.
      const res = await app.inject({ method: 'GET', url: '/app/assets/present.js' });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('SPA cache headers: index.html no-store, hashed assets immutable (spec/11)', async () => {
    mkdirSync(join(webDir, 'assets'), { recursive: true });
    writeFileSync(join(webDir, 'assets', 'index-ABC123.js'), 'console.log(1)');
    const registry = Registry.load(dir);
    const app = await build({
      logger: false,
      registry,
      daemonLink: new InProcessDaemonLink(),
      webDistDir: webDir,
    });
    try {
      // A client route → the SPA shell HTML, never cached.
      const route = await app.inject({ method: 'GET', url: '/app/chats/x' });
      expect(route.headers['cache-control']).toBe('no-store');
      // The directory root also serves index.html → no-store.
      const rootHtml = await app.inject({ method: 'GET', url: '/app/' });
      expect(rootHtml.headers['cache-control']).toBe('no-store');
      // A content-hashed build asset → immutable, cache forever.
      const asset = await app.inject({ method: 'GET', url: '/app/assets/index-ABC123.js' });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers['cache-control']).toContain('immutable');
    } finally {
      await app.close();
    }
  });

  it('GET / redirects (302) to /app/', async () => {
    const registry = Registry.load(dir);
    const app = await build({ logger: false, registry, daemonLink: new InProcessDaemonLink() });
    try {
      const res = await app.inject({ method: 'GET', url: '/' });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/app/');
    } finally {
      await app.close();
    }
  });

  // ---- Regression: the 2026-08-16 blank-window outage ----
  //
  // `deploy/web-dist` is a LIVE bind-mount. A deploy that rsynced a new build
  // into it without restarting the container left @fastify/static (wildcard:
  // false, route table snapshotted at boot) with no route for the new
  // `index-<hash>.js`, so the request fell through to the SPA catch-all and was
  // answered 200 text/html. The browser got HTML where it asked for a module,
  // executed nothing, and rendered a blank window — while /api/healthz, the
  // container health check and the index.html bundle-name check all said fine.
  //
  // Two properties keep that from recurring: a file that appears after boot is
  // SERVED, and a build asset that is genuinely missing 404s instead of being
  // papered over with the shell.

  // 2026-09-30: the SPA dir vanished from under a configured server, so /app was
  // never mounted and every surface got JSON "route not found" while healthz
  // said ok. A configured SPA that is missing must stop the boot.
  it('refuses to start when PATCH_WEB_DIST names a directory with no SPA in it', async () => {
    const prev = process.env.PATCH_WEB_DIST;
    process.env.PATCH_WEB_DIST = join(dir, 'no-such-web');
    try {
      await expect(
        build({
          logger: false,
          registry: Registry.load(dir),
          daemonLink: new InProcessDaemonLink(),
        }),
      ).rejects.toThrow(/refusing to start without the SPA/);
    } finally {
      if (prev === undefined) delete process.env.PATCH_WEB_DIST;
      else process.env.PATCH_WEB_DIST = prev;
    }
  });

  it('GET /app/assets/<hash>.js added AFTER boot (a live-mount deploy) is served as JS, not the SPA shell', async () => {
    const registry = Registry.load(dir);
    const app = await build({
      logger: false,
      registry,
      daemonLink: new InProcessDaemonLink(),
      webDistDir: webDir,
    });
    try {
      // Exactly what `ship web` does under a running server: a new build lands
      // in the mounted dist, after @fastify/static snapshotted its route table.
      mkdirSync(join(webDir, 'assets'), { recursive: true });
      writeFileSync(join(webDir, 'assets', 'index-LATE123.js'), 'console.log("late build")');
      const res = await app.inject({ method: 'GET', url: '/app/assets/index-LATE123.js' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('javascript');
      expect(res.body).toContain('late build');
      expect(res.body).not.toContain('spa'); // NOT the HTML shell
    } finally {
      await app.close();
    }
  });

  it('GET /app/assets/<missing>.js 404s — a broken deploy must not be masked by the SPA shell', async () => {
    const registry = Registry.load(dir);
    const app = await build({
      logger: false,
      registry,
      daemonLink: new InProcessDaemonLink(),
      webDistDir: webDir,
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/app/assets/index-GONE99.js' });
      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).not.toContain('html');
    } finally {
      await app.close();
    }
  });

  it('the shell is re-read per request, so a post-boot deploy points at its own bundle', async () => {
    writeFileSync(
      join(webDir, 'index.html'),
      '<!doctype html><html><body>spa<script src="/app/assets/index-OLD111.js"></script></body></html>',
    );
    const registry = Registry.load(dir);
    const app = await build({
      logger: false,
      registry,
      daemonLink: new InProcessDaemonLink(),
      webDistDir: webDir,
    });
    try {
      // A new build replaces both the shell and its hashed entry bundle.
      mkdirSync(join(webDir, 'assets'), { recursive: true });
      writeFileSync(join(webDir, 'assets', 'index-NEW222.js'), 'console.log("new build")');
      writeFileSync(
        join(webDir, 'index.html'),
        '<!doctype html><html><body>spa<script src="/app/assets/index-NEW222.js"></script></body></html>',
      );
      const shell = await app.inject({ method: 'GET', url: '/app/chats/x' });
      expect(shell.body).toContain('index-NEW222.js');
      expect(shell.body).not.toContain('index-OLD111.js');
      // …and the bundle that shell names actually loads.
      const bundle = await app.inject({ method: 'GET', url: '/app/assets/index-NEW222.js' });
      expect(bundle.statusCode).toBe(200);
      expect(bundle.headers['content-type']).toContain('javascript');
    } finally {
      await app.close();
    }
  });

  it('a traversal path under /app/ cannot escape the dist root', async () => {
    const registry = Registry.load(dir);
    const app = await build({
      logger: false,
      registry,
      daemonLink: new InProcessDaemonLink(),
      webDistDir: webDir,
    });
    try {
      writeFileSync(join(dir, 'secret.txt'), 'top secret');
      const res = await app.inject({ method: 'GET', url: '/app/..%2f..%2fsecret.txt' });
      expect(res.body).not.toContain('top secret');
    } finally {
      await app.close();
    }
  });
});

describe('app.ts — opts.dataDir path (Registry.load internally, no injected registry)', () => {
  it('builds a registry from opts.dataDir when no registry is injected', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'patch-app-optsdatadir-'));
    try {
      const app = await build({
        logger: false,
        dataDir: dir,
        daemonLink: new InProcessDaemonLink(),
        internalToken: 'a'.repeat(20),
      });
      try {
        const res = await app.inject({ method: 'GET', url: '/api/healthz' });
        expect(res.statusCode).toBe(200);
      } finally {
        await app.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('app.ts — opts.nowMs threaded through notification/call/voice-token/auth-routes wiring', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-app-nowms-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('boots cleanly with an injected nowMs clock and serves requests', async () => {
    const registry = Registry.load(dir);
    let clock = 1_700_000_000_000;
    const built = await buildAll({
      logger: false,
      registry,
      daemonLink: new InProcessDaemonLink(),
      jobsWatch: false,
      internalToken: 'a'.repeat(20),
      nowMs: () => clock,
    });
    try {
      const res = await built.app.inject({ method: 'GET', url: '/api/healthz' });
      expect(res.statusCode).toBe(200);
      clock += 1000;
      const res2 = await built.app.inject({ method: 'GET', url: '/api/healthz' });
      expect(res2.statusCode).toBe(200);
    } finally {
      await built.app.close();
    }
  });
});

describe('app.ts — presence sweep uses opts.nowMs when provided', () => {
  it('the sweep interval calls the injected nowMs clock (not just Date.now())', async () => {
    const { vi } = await import('vitest');
    vi.useFakeTimers();
    try {
      const dir = mkdtempSync(join(tmpdir(), 'patch-app-sweep-'));
      const registry = Registry.load(dir);
      let calls = 0;
      const built = await buildAll({
        logger: false,
        registry,
        daemonLink: new InProcessDaemonLink(),
        jobsWatch: false,
        nowMs: () => {
          calls += 1;
          return 1_000_000;
        },
      });
      try {
        // Sweep runs every 5s; advance past a couple of ticks.
        await vi.advanceTimersByTimeAsync(11_000);
        expect(calls).toBeGreaterThan(0);
      } finally {
        await built.app.close();
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('app.ts — dev-diag mounted when speakersRecorder is enabled', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = ['NODE_ENV', 'PATCH_SPEAKERS_MOCK'] as const;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-app-onemock-'));
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    delete process.env.NODE_ENV;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it('speakersRecorder mounts dev-diag routes', async () => {
    process.env.PATCH_SPEAKERS_MOCK = '1';
    const registry = Registry.load(dir);
    const built = await buildAll({
      logger: false,
      registry,
      daemonLink: new InProcessDaemonLink(),
      jobsWatch: false,
      internalToken: 'a'.repeat(20),
    });
    try {
      const res = await built.app.inject({
        method: 'GET',
        url: '/internal/diag/speakers/sent',
        headers: { 'x-patch-internal-token': 'a'.repeat(20) },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await built.app.close();
    }
  });
});

describe('app.ts — attachmentsDir falls back to /tmp when registry.dataDir is falsy', () => {
  it('still boots and serves via the /tmp fallback attachments dir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'patch-app-attachfallback-'));
    try {
      const registry = Registry.load(dir);
      registry.bootstrapAccount();
      // Force registry.dataDir to undefined for the ONE line under test
      // (`attachmentsDir: ... ?? join(registry.dataDir ?? '/tmp', ...)`) — `??`
      // only falls back on null/undefined, NOT on an empty string, so this
      // must be genuinely undefined, not ''. Still satisfy the separate
      // `jobsDataDir` requirement via an explicit opts.dataDir (a different,
      // real directory) since that check uses a plain falsy `!jobsDataDir`.
      (registry as unknown as { dataDir: string | undefined }).dataDir = undefined;
      const built = await buildAll({
        logger: false,
        registry,
        dataDir: dir,
        daemonLink: new InProcessDaemonLink(),
        jobsWatch: false,
      });
      try {
        const res = await built.app.inject({ method: 'GET', url: '/api/healthz' });
        expect(res.statusCode).toBe(200);
      } finally {
        await built.app.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('app.ts — Telegram, Google OAuth and Calendar routes are gone', () => {
  it('404s on every removed route: no third-party app registration is needed to install Patch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'patch-app-noregistration-'));
    try {
      const registry = Registry.load(dir);
      registry.bootstrapAccount();
      const built = await buildAll({
        logger: false,
        registry,
        daemonLink: new InProcessDaemonLink(),
        jobsWatch: false,
      });
      try {
        const removed: { method: 'GET' | 'POST'; url: string }[] = [
          { method: 'POST', url: '/api/telegram/webhook' },
          { method: 'POST', url: '/api/auth/telegram/pair' },
          { method: 'POST', url: '/api/auth/telegram/unpair' },
          { method: 'GET', url: '/api/oauth/google/start' },
          { method: 'GET', url: '/api/oauth/google/callback' },
          { method: 'POST', url: '/api/webhooks/gcal/j_whatever' },
        ];
        for (const { method, url } of removed) {
          const res = await built.app.inject({ method, url });
          expect(res.statusCode).toBe(404);
        }
      } finally {
        await built.app.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
