// Auth + pairing REST endpoint tests (via fastify.inject — no port binding).
//
// Server-as-credential-authority model (spec/10-auth.md):
//   - POST /api/auth/account: SERVER generates the account keypair and mints
//     the caller's first surface credential. Body = {clientType, devicePublicKey}.
//   - POST /api/auth/pair/start: authed linked surface opens a nonce window.
//   - POST /api/auth/pair/complete: new surface submits {nonce, devicePublicKey,
//     clientType}; the SERVER mints its credential with the account private key.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateUserKeypair,
  mintSurfaceCredential,
  InMemoryPairingNonceStore,
  type PairingNonceStore,
  type UserKeypair,
} from '@patch/auth';
import { buildAll, type BuildOptions } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';

/**
 * Bootstrap the singleton account with a deterministic keypair (test seam) so
 * tests can mint surface credentials with the account private key. Mirrors what
 * the server does internally with a server-generated keypair.
 */
function bootstrap(registry: Registry, kp: UserKeypair): void {
  registry.bootstrapAccount({ keypair: kp });
}

/** Mint a bearer credential for an existing surface, as the server would. */
async function surfaceBearer(
  kp: UserKeypair,
  surfaceId: string,
  surfaceKind: 'web' | 'mobile' | 'desktop' | 'terminal' = 'web',
  label = 'browser',
): Promise<string> {
  return mintSurfaceCredential({
    userPrivateKey: kp.privateKey,
    surfaceId,
    surfaceKind,
    label,
  });
}

/**
 * Wrap a real `Registry` instance, overriding specific method(s) while
 * delegating everything else to the real instance. Used to force otherwise
 * unreachable-via-HTTP internal-error paths (e.g. an internal invariant that
 * "just bootstrapped, so the private key must be present" briefly false) so
 * their NO-FALLBACK rethrow-as-500 behavior is exercised for real.
 */
/**
 * A machine's own Ed25519 public key, base64url. spec/10 § Host registration
 * step 2 — "The host on the new host submits the nonce and its public key" —
 * so `publicKey` is a REQUIRED field of `POST /api/auth/daemon/register/complete`.
 */
function daemonPublicKey(seedByte: number): string {
  return generateUserKeypair(() => new Uint8Array(32).fill(seedByte)).publicKey;
}

function overrideRegistry(real: Registry, overrides: Partial<Registry>): Registry {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && prop in overrides) {
        return (overrides as Record<string, unknown>)[prop];
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Registry;
}

describe('auth REST routes', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-auth-rest-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function makeApp(registry: Registry, extra: Partial<BuildOptions> = {}) {
    const built = await buildAll({
      logger: false,
      registry,
      daemonLink: new InProcessDaemonLink(),
      ...extra,
    });
    return built;
  }

  it('POST /api/auth/account bootstraps + enrols the first surface (server mints)', async () => {
    const device = generateUserKeypair(() => new Uint8Array(32).fill(20));
    const registry = Registry.load(dir);
    const { app } = await makeApp(registry);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/account',
        payload: { clientType: 'surface-web', devicePublicKey: device.publicKey, label: 'mac' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        account: { accountId: string; userPublicKey: string; createdAt: number };
        credential: string;
        surfaceId: string;
      };
      // The account public key is server-generated (NOT the device key).
      expect(body.account.userPublicKey).not.toBe(device.publicKey);
      expect(body.account.accountId).toBe(body.account.userPublicKey);
      expect(body.credential.length).toBeGreaterThan(0);
      expect(body.surfaceId.length).toBeGreaterThan(0);
      // The private key must NEVER appear in the response.
      const priv = registry.getAccountPrivateKey()!;
      expect(JSON.stringify(body)).not.toContain(priv);
      // The minted credential authenticates the surface (round-trips via /me).
      const me = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${body.credential}` },
      });
      expect(me.statusCode).toBe(200);
      expect((me.json() as { surface: { surfaceId: string } }).surface.surfaceId).toBe(
        body.surfaceId,
      );
    } finally {
      await app.close();
    }
  });

  it('pair start → complete round-trip stores the new surface (server mints)', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(21));
    const device = generateUserKeypair(() => new Uint8Array(32).fill(22));
    const registry = Registry.load(dir);
    bootstrap(registry, user);
    registry.upsertSurface({ surfaceId: 'srf-web', surfaceKind: 'web', label: 'mac', issuedAt: 1 });
    const { app } = await makeApp(registry);
    try {
      // 1. start — authed by an existing linked surface
      const startRes = await app.inject({
        method: 'POST',
        url: '/api/auth/pair/start',
        headers: { authorization: `Bearer ${await surfaceBearer(user, 'srf-web')}` },
      });
      expect(startRes.statusCode).toBe(200);
      const { nonce } = startRes.json() as { nonce: string; expiresAt: number };
      expect(nonce.length).toBeGreaterThan(0);

      // 2. the new surface completes with its own device key
      const completeRes = await app.inject({
        method: 'POST',
        url: '/api/auth/pair/complete',
        payload: { nonce, devicePublicKey: device.publicKey, clientType: 'surface-mobile' },
      });
      expect(completeRes.statusCode).toBe(200);
      const completeBody = completeRes.json() as {
        credential: string;
        accountId: string;
        surfaceId: string;
      };
      expect(completeBody.credential.length).toBeGreaterThan(0);
      expect(completeBody.accountId).toBe(user.publicKey);

      // Surface must now be in registry with mobile kind.
      const surface = registry.getSurface(completeBody.surfaceId);
      expect(surface).toBeDefined();
      expect(surface?.surfaceKind).toBe('mobile');

      // The minted credential authenticates against the account key.
      const me = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${completeBody.credential}` },
      });
      expect(me.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('pair/start requires an authenticated linked surface (401 anonymously)', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(23));
    const registry = Registry.load(dir);
    bootstrap(registry, user);
    const { app } = await makeApp(registry);
    try {
      const res = await app.inject({ method: 'POST', url: '/api/auth/pair/start' });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('GET /api/auth/me requires a valid bearer token', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(25));
    const registry = Registry.load(dir);
    bootstrap(registry, user);
    registry.upsertSurface({
      surfaceId: 'srf-1',
      surfaceKind: 'web',
      label: 'browser',
      issuedAt: 1,
    });
    const { app } = await makeApp(registry);
    try {
      const noAuth = await app.inject({ method: 'GET', url: '/api/auth/me' });
      expect(noAuth.statusCode).toBe(401);

      const jwt = await surfaceBearer(user, 'srf-1');
      const ok = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(ok.statusCode).toBe(200);
      const body = ok.json() as { surface: { surfaceId: string } };
      expect(body.surface.surfaceId).toBe('srf-1');
    } finally {
      await app.close();
    }
  });

  it('GET /api/settings aggregates account, devices, push, integration + host status', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(40));
    const registry = Registry.load(dir);
    bootstrap(registry, user);
    registry.upsertSurface({
      surfaceId: 'srf-web',
      surfaceKind: 'web',
      label: 'this Mac',
      issuedAt: 1,
    });
    registry.upsertSurface({
      surfaceId: 'srf-mob',
      surfaceKind: 'mobile',
      label: 'Pixel',
      issuedAt: 2,
    });
    registry.upsertSurface({
      surfaceId: 'srf-old',
      surfaceKind: 'web',
      label: 'old Mac',
      issuedAt: 3,
    });
    registry.revoke('srf-old');
    registry.registerPushToken({
      surfaceId: 'srf-mob',
      accountId: registry.getAccount()!.accountId,
      token: 'fcm-xyz',
      registeredAt: 10,
    });
    const { app } = await makeApp(registry);
    try {
      const noAuth = await app.inject({ method: 'GET', url: '/api/settings' });
      expect(noAuth.statusCode).toBe(401);

      const jwt = await surfaceBearer(user, 'srf-web', 'web', 'this Mac');
      const res = await app.inject({
        method: 'GET',
        url: '/api/settings',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        devices: Array<{ surfaceId: string; isCurrent: boolean }>;
        push: { tokenCount: number };
        daemon: { status: string };
      };
      const ids = body.devices.map((d) => d.surfaceId).sort();
      expect(ids).toEqual(['srf-mob', 'srf-web']); // revoked srf-old excluded
      expect(body.devices.find((d) => d.surfaceId === 'srf-web')?.isCurrent).toBe(true);
      expect(body.devices.find((d) => d.surfaceId === 'srf-mob')?.isCurrent).toBe(false);
      expect(body.push.tokenCount).toBe(1);
      expect(body.daemon.status).toBe('online');
    } finally {
      await app.close();
    }
  });

  it('PUT /api/auth/folders sets the launch folders; GET /api/settings reports them (spec/04 § Folders)', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(40));
    const registry = Registry.load(dir);
    bootstrap(registry, user);
    registry.upsertSurface({
      surfaceId: 'srf-web',
      surfaceKind: 'web',
      label: 'this Mac',
      issuedAt: 1,
    });

    const { app } = await makeApp(registry);
    try {
      const jwt = await surfaceBearer(user, 'srf-web', 'web', 'this Mac');
      const auth = { authorization: `Bearer ${jwt}` };

      // Unauthenticated is rejected.
      const noAuth = await app.inject({
        method: 'PUT',
        url: '/api/auth/folders',
        payload: { folders: ['/x'] },
      });
      expect(noAuth.statusCode).toBe(401);

      // Bad body → 400 (NO FALLBACK — not silently coerced).
      const bad = await app.inject({
        method: 'PUT',
        url: '/api/auth/folders',
        headers: auth,
        payload: { folders: 'nope' },
      });
      expect(bad.statusCode).toBe(400);

      // Happy path: dupes + blanks are trimmed; round-trips through settings.
      const put = await app.inject({
        method: 'PUT',
        url: '/api/auth/folders',
        headers: auth,
        payload: {
          folders: ['/home/tom/projects/patch', ' ', '/home/tom/projects/patch', '/home/tom/x'],
        },
      });
      expect(put.statusCode).toBe(200);
      expect((put.json() as { folders: string[] }).folders).toEqual([
        '/home/tom/projects/patch',
        '/home/tom/x',
      ]);

      const settings = await app.inject({ method: 'GET', url: '/api/settings', headers: auth });
      expect((settings.json() as { projectFolders: string[] }).projectFolders).toEqual([
        '/home/tom/projects/patch',
        '/home/tom/x',
      ]);
    } finally {
      await app.close();
    }
  });

  it('POST /api/webhooks/:jobId returns 404 for an unknown (well-formed) job (group 9 task B)', async () => {
    const registry = Registry.load(dir);
    const { app } = await makeApp(registry);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/webhooks/j_01H0000000000000000000000Z',
        payload: {},
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'job not found' });
    } finally {
      await app.close();
    }
  });

  it('POST /api/webhooks/:jobId rejects path traversal with 400 (CRITICAL C1)', async () => {
    const registry = Registry.load(dir);
    const { app } = await makeApp(registry);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/webhooks/..%2F..%2Ftmp%2Fattacker',
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid jobId' });
    } finally {
      await app.close();
    }
  });

  it('POST /api/auth/account returns 400 on garbage devicePublicKey', async () => {
    const registry = Registry.load(dir);
    const { app } = await makeApp(registry);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/account',
        payload: { clientType: 'surface-web', devicePublicKey: 'not-a-real-ed25519-key' },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json() as { error: string };
      expect(body.error).toBe('invalid devicePublicKey');
    } finally {
      await app.close();
    }
  });

  it('POST /api/auth/account returns 409 when an account already exists', async () => {
    const device = generateUserKeypair(() => new Uint8Array(32).fill(60));
    const device2 = generateUserKeypair(() => new Uint8Array(32).fill(61));
    const registry = Registry.load(dir);
    const { app } = await makeApp(registry);
    try {
      const r1 = await app.inject({
        method: 'POST',
        url: '/api/auth/account',
        payload: { clientType: 'surface-web', devicePublicKey: device.publicKey },
      });
      expect(r1.statusCode).toBe(200);
      const acctKey = (r1.json() as { account: { userPublicKey: string } }).account.userPublicKey;

      const r2 = await app.inject({
        method: 'POST',
        url: '/api/auth/account',
        payload: { clientType: 'surface-mobile', devicePublicKey: device2.publicKey },
      });
      expect(r2.statusCode).toBe(409);
      const body = r2.json() as { error: string };
      expect(body.error).toBe('account already bootstrapped');
      // Must NOT leak the existing account key or private key.
      expect(JSON.stringify(body)).not.toContain(acctKey);
      expect(JSON.stringify(body)).not.toContain(registry.getAccountPrivateKey()!);
    } finally {
      await app.close();
    }
  });

  it('presence snapshot ages to stale via the server-owned sweeper (no manual sweep) (Fix 2)', async () => {
    vi.useFakeTimers();
    try {
      const user = generateUserKeypair(() => new Uint8Array(32).fill(90));
      const registry = Registry.load(dir);
      bootstrap(registry, user);
      const built = await makeApp(registry);
      try {
        built.presence.online(user.publicKey, 'srf-silent', 'web');
        expect(built.presence.snapshot()[0]?.status).toBe('online');

        await vi.advanceTimersByTimeAsync(35_000);
        expect(built.presence.snapshot()[0]?.status).toBe('stale');
      } finally {
        await built.app.close();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('POST /api/auth/revoke marks target revoked; unauthenticated is 401 (spec/10)', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(72));
    const registry = Registry.load(dir);
    bootstrap(registry, user);
    registry.upsertSurface({
      surfaceId: 'srf-revoker',
      surfaceKind: 'web',
      label: 'browser',
      issuedAt: 1,
    });
    registry.upsertSurface({
      surfaceId: 'srf-target',
      surfaceKind: 'mobile',
      label: 'pixel',
      issuedAt: 1,
    });
    const { app } = await makeApp(registry);
    try {
      const noAuth = await app.inject({
        method: 'POST',
        url: '/api/auth/revoke',
        payload: { id: 'srf-target' },
      });
      expect(noAuth.statusCode).toBe(401);
      expect(registry.isRevoked('srf-target')).toBe(false);

      const jwt = await surfaceBearer(user, 'srf-revoker');
      const ok = await app.inject({
        method: 'POST',
        url: '/api/auth/revoke',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { id: 'srf-target' },
      });
      expect(ok.statusCode).toBe(200);
      expect(registry.isRevoked('srf-target')).toBe(true);

      const missing = await app.inject({
        method: 'POST',
        url: '/api/auth/revoke',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { id: 'srf-does-not-exist' },
      });
      expect(missing.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('pair/complete: known bad-input → 400 {error}, happy path still 200 (no-fallback)', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(80));
    const device = generateUserKeypair(() => new Uint8Array(32).fill(81));
    const registry = Registry.load(dir);
    bootstrap(registry, user);
    registry.upsertSurface({ surfaceId: 'srf-web', surfaceKind: 'web', label: 'mac', issuedAt: 1 });
    const { app } = await makeApp(registry);
    try {
      // Bad input: an unknown nonce → PairingNonceUnknownError → 400.
      const bad = await app.inject({
        method: 'POST',
        url: '/api/auth/pair/complete',
        payload: {
          nonce: 'no-such-nonce',
          devicePublicKey: device.publicKey,
          clientType: 'surface-mobile',
        },
      });
      expect(bad.statusCode).toBe(400);
      const badBody = bad.json() as { error: string };
      expect(typeof badBody.error).toBe('string');
      expect(badBody.error.length).toBeGreaterThan(0);

      // Happy path: a fresh nonce + valid device key → 200.
      const startRes = await app.inject({
        method: 'POST',
        url: '/api/auth/pair/start',
        headers: { authorization: `Bearer ${await surfaceBearer(user, 'srf-web')}` },
      });
      const { nonce } = startRes.json() as { nonce: string };
      const ok = await app.inject({
        method: 'POST',
        url: '/api/auth/pair/complete',
        payload: { nonce, devicePublicKey: device.publicKey, clientType: 'surface-mobile' },
      });
      expect(ok.statusCode).toBe(200);
      expect((ok.json() as { credential: string }).credential.length).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it('pair/complete: an unexpected (non-client) error surfaces as 500 {error}, NOT 400 (no-fallback)', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(82));
    const device = generateUserKeypair(() => new Uint8Array(32).fill(83));
    const registry = Registry.load(dir);
    bootstrap(registry, user);
    registry.upsertSurface({ surfaceId: 'srf-web', surfaceKind: 'web', label: 'mac', issuedAt: 1 });

    // A nonce store that records the issued nonce on put() but throws an
    // unexpected I/O-style error on get() — simulating backing-store failure.
    const inner = new InMemoryPairingNonceStore();
    const explodingStore: PairingNonceStore = {
      put: (r) => inner.put(r),
      get: () => {
        throw new Error('simulated nonce-store I/O failure');
      },
      consume: (n) => inner.consume(n),
    };

    const { app } = await makeApp(registry, { pairingNonceStore: explodingStore });
    try {
      const startRes = await app.inject({
        method: 'POST',
        url: '/api/auth/pair/start',
        headers: { authorization: `Bearer ${await surfaceBearer(user, 'srf-web')}` },
      });
      const { nonce } = startRes.json() as { nonce: string };
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/pair/complete',
        payload: { nonce, devicePublicKey: device.publicKey, clientType: 'surface-mobile' },
      });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: 'internal' });
    } finally {
      await app.close();
    }
  });

  it('POST /api/auth/pair/complete returns 400 when no account is bootstrapped', async () => {
    const device = generateUserKeypair(() => new Uint8Array(32).fill(71));
    const registry = Registry.load(dir);
    const { app } = await makeApp(registry);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/pair/complete',
        payload: { nonce: 'x', devicePublicKey: device.publicKey, clientType: 'surface-mobile' },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json() as { error: string };
      expect(body.error).toBe('no account bootstrapped');
    } finally {
      await app.close();
    }
  });

  it('requireAuth: a malformed bearer token is rejected with 401 (verify throws)', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(100));
    const registry = Registry.load(dir);
    bootstrap(registry, user);
    const { app } = await makeApp(registry);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: 'Bearer not-a-real-jwt' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('requireAuth: a revoked surface is rejected with 401 even with a valid signature', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(101));
    const registry = Registry.load(dir);
    bootstrap(registry, user);
    registry.upsertSurface({
      surfaceId: 'srf-revoked',
      surfaceKind: 'web',
      label: 'browser',
      issuedAt: 1,
    });
    registry.revoke('srf-revoked');
    const jwt = await surfaceBearer(user, 'srf-revoked');
    const { app } = await makeApp(registry);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('POST /api/auth/account returns 400 on a malformed body (safeParse failure)', async () => {
    const registry = Registry.load(dir);
    const { app } = await makeApp(registry);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/account',
        // Missing required devicePublicKey + an unknown field (.strict()).
        payload: { clientType: 'surface-web', extraField: 'nope' },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json() as { error: string; issues: unknown };
      expect(body.error).toBe('invalid body');
      expect(body.issues).toBeDefined();
    } finally {
      await app.close();
    }
  });

  it('POST /api/auth/account: a raced AccountConflictError from bootstrapAccount() maps to 409', async () => {
    const device = generateUserKeypair(() => new Uint8Array(32).fill(102));
    const existingUser = generateUserKeypair(() => new Uint8Array(32).fill(103));
    const registry = Registry.load(dir);
    bootstrap(registry, existingUser);
    // getAccount() is faked to null for the route's own pre-check (simulating
    // a race where another request bootstraps between the check and the
    // call), but bootstrapAccount() itself runs for real against a registry
    // that already has an account — genuinely throwing AccountConflictError.
    const raced = overrideRegistry(registry, { getAccount: () => null });
    const { app } = await makeApp(raced);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/account',
        payload: { clientType: 'surface-web', devicePublicKey: device.publicKey },
      });
      expect(res.statusCode).toBe(409);
      expect((res.json() as { error: string }).error).toBe('account already bootstrapped');
    } finally {
      await app.close();
    }
  });

  it('POST /api/auth/account: a non-conflict bootstrapAccount() failure rethrows as 500 (NO FALLBACK)', async () => {
    const device = generateUserKeypair(() => new Uint8Array(32).fill(104));
    const registry = Registry.load(dir);
    const { app } = await makeApp(registry);
    try {
      // Remove the backing directory out from under the (already-loaded)
      // registry so bootstrapAccount()'s flush() throws a plain ENOENT — not
      // an AccountConflictError — exercising the route's rethrow path.
      rmSync(dir, { recursive: true, force: true });
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/account',
        payload: { clientType: 'surface-web', devicePublicKey: device.publicKey },
      });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: 'internal' });
    } finally {
      await app.close();
      // The shared afterEach's rmSync(dir, { force: true }) tolerates the
      // directory already being gone.
    }
  });

  it('POST /api/auth/account: a missing private key right after bootstrap rethrows as 500 (NO FALLBACK)', async () => {
    const device = generateUserKeypair(() => new Uint8Array(32).fill(105));
    const registry = Registry.load(dir);
    const broken = overrideRegistry(registry, { getAccountPrivateKey: () => null });
    const { app } = await makeApp(broken);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/account',
        payload: { clientType: 'surface-web', devicePublicKey: device.publicKey },
      });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: 'internal' });
    } finally {
      await app.close();
    }
  });

  it('POST /api/auth/pair/complete returns 400 on a malformed body (safeParse failure)', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(106));
    const registry = Registry.load(dir);
    bootstrap(registry, user);
    const { app } = await makeApp(registry);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/pair/complete',
        // Missing devicePublicKey/clientType entirely.
        payload: { nonce: 'x' },
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toBe('invalid body');
    } finally {
      await app.close();
    }
  });

  it('POST /api/auth/pair/complete returns 400 on a garbage devicePublicKey', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(107));
    const registry = Registry.load(dir);
    bootstrap(registry, user);
    const { app } = await makeApp(registry);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/pair/complete',
        payload: {
          nonce: 'x',
          devicePublicKey: 'not-a-real-ed25519-key',
          clientType: 'surface-mobile',
        },
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toBe('invalid devicePublicKey');
    } finally {
      await app.close();
    }
  });

  it('POST /api/auth/pair/complete: a missing private key rethrows as 500 (NO FALLBACK)', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(108));
    const device = generateUserKeypair(() => new Uint8Array(32).fill(109));
    const registry = Registry.load(dir);
    bootstrap(registry, user);
    registry.upsertSurface({ surfaceId: 'srf-web', surfaceKind: 'web', label: 'mac', issuedAt: 1 });
    const broken = overrideRegistry(registry, { getAccountPrivateKey: () => null });
    const { app } = await makeApp(broken);
    try {
      const startRes = await app.inject({
        method: 'POST',
        url: '/api/auth/pair/start',
        headers: { authorization: `Bearer ${await surfaceBearer(user, 'srf-web')}` },
      });
      expect(startRes.statusCode).toBe(200);
      const { nonce } = startRes.json() as { nonce: string };
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/pair/complete',
        payload: { nonce, devicePublicKey: device.publicKey, clientType: 'surface-mobile' },
      });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: 'internal' });
    } finally {
      await app.close();
    }
  });

  it('POST /api/auth/revoke returns 400 on a malformed body (safeParse failure)', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(110));
    const registry = Registry.load(dir);
    bootstrap(registry, user);
    registry.upsertSurface({
      surfaceId: 'srf-revoker',
      surfaceKind: 'web',
      label: 'browser',
      issuedAt: 1,
    });
    const jwt = await surfaceBearer(user, 'srf-revoker');
    const { app } = await makeApp(registry);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/revoke',
        headers: { authorization: `Bearer ${jwt}` },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toBe('invalid body');
    } finally {
      await app.close();
    }
  });

  it('POST /api/auth/revoke can revoke the HOST id (not just a surface)', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(111));
    const registry = Registry.load(dir);
    bootstrap(registry, user);
    registry.upsertSurface({
      surfaceId: 'srf-revoker',
      surfaceKind: 'web',
      label: 'browser',
      issuedAt: 1,
    });
    registry.setDaemonKey({ daemonId: 'daemon-1', publicKey: user.publicKey, issuedAt: 1 });
    const jwt = await surfaceBearer(user, 'srf-revoker');
    // buildAll only wires `terminateDaemon` for a real InboundDaemonLink
    // (see app.ts); with the InProcessDaemonLink test double it stays
    // undefined, so `terminated = deps.terminateDaemon ? ... : false`
    // exercises its `false` arm here — the daemon-id-match branch itself
    // (rather than the surface branch) is what this test targets.
    const { app } = await makeApp(registry);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/revoke',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { id: 'daemon-1' },
      });
      expect(res.statusCode).toBe(200);
      expect(registry.isRevoked('daemon-1')).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('GET /api/auth/me falls back to the JWT claims when the surface is not yet in the registry', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(112));
    const registry = Registry.load(dir);
    bootstrap(registry, user);
    // Mint a credential for a surfaceId that was never upserted into the
    // registry (simulates a freshly-paired surface racing the mirror).
    const jwt = await surfaceBearer(user, 'srf-not-yet-registered', 'desktop', 'new mac');
    const { app } = await makeApp(registry);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        surface: { surfaceId: string; surfaceKind: string; label: string };
      };
      expect(body.surface).toEqual({
        surfaceId: 'srf-not-yet-registered',
        surfaceKind: 'desktop',
        label: 'new mac',
        issuedAt: expect.any(Number),
      });
    } finally {
      await app.close();
    }
  });

  it('GET /api/presence requires auth and returns the presence snapshot', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(115));
    const registry = Registry.load(dir);
    bootstrap(registry, user);
    registry.upsertSurface({ surfaceId: 'srf-web', surfaceKind: 'web', label: 'mac', issuedAt: 1 });
    const { app, presence } = await makeApp(registry);
    try {
      const noAuth = await app.inject({ method: 'GET', url: '/api/presence' });
      expect(noAuth.statusCode).toBe(401);

      presence.online(user.publicKey, 'srf-web', 'web');
      const jwt = await surfaceBearer(user, 'srf-web');
      const res = await app.inject({
        method: 'GET',
        url: '/api/presence',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { presence: Array<{ surfaceId: string; status: string }> };
      expect(body.presence.some((p) => p.surfaceId === 'srf-web' && p.status === 'online')).toBe(
        true,
      );
    } finally {
      await app.close();
    }
  });

  it('requireAuth: 401 when NO account has been bootstrapped at all (not just a bad token)', async () => {
    const registry = Registry.load(dir);
    const { app } = await makeApp(registry);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/auth/me' });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('POST /api/auth/account: devicePublicKey validation rejects >100 chars and invalid characters', async () => {
    const registry = Registry.load(dir);
    const { app } = await makeApp(registry);
    try {
      // Passes zod's min(1) but fails isValidEd25519PublicKey's own length>100
      // guard (before ever reaching the base64url decode).
      const tooLong = await app.inject({
        method: 'POST',
        url: '/api/auth/account',
        payload: { clientType: 'surface-web', devicePublicKey: 'A'.repeat(101) },
      });
      expect(tooLong.statusCode).toBe(400);
      expect((tooLong.json() as { error: string }).error).toBe('invalid devicePublicKey');

      // Non-empty, <=100 chars, but contains characters outside the
      // base64url alphabet — fails the regex check, not the length checks.
      const badChars = await app.inject({
        method: 'POST',
        url: '/api/auth/account',
        payload: { clientType: 'surface-web', devicePublicKey: 'not+valid/base64=' },
      });
      expect(badChars.statusCode).toBe(400);
      expect((badChars.json() as { error: string }).error).toBe('invalid devicePublicKey');
    } finally {
      await app.close();
    }
  });

  it('GET /api/settings: a device WITH a live presence record reports its real status/lastHeartbeat', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(116));
    const registry = Registry.load(dir);
    bootstrap(registry, user);
    registry.upsertSurface({ surfaceId: 'srf-web', surfaceKind: 'web', label: 'mac', issuedAt: 1 });
    const { app, presence } = await makeApp(registry);
    try {
      presence.online(user.publicKey, 'srf-web', 'web', 12345);
      const jwt = await surfaceBearer(user, 'srf-web');
      const res = await app.inject({
        method: 'GET',
        url: '/api/settings',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        devices: Array<{ surfaceId: string; status: string; lastHeartbeat: number | null }>;
      };
      const device = body.devices.find((d) => d.surfaceId === 'srf-web');
      expect(device?.status).toBe('online');
      expect(device?.lastHeartbeat).toBe(12345);
    } finally {
      await app.close();
    }
  });

  it('GET /api/settings: reports daemon.registered=true when a (non-revoked) host key exists', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(117));
    const registry = Registry.load(dir);
    bootstrap(registry, user);
    registry.upsertSurface({ surfaceId: 'srf-web', surfaceKind: 'web', label: 'mac', issuedAt: 1 });
    registry.setDaemonKey({ daemonId: 'daemon-1', publicKey: user.publicKey, issuedAt: 1 });
    const { app } = await makeApp(registry);
    try {
      const jwt = await surfaceBearer(user, 'srf-web');
      const res = await app.inject({
        method: 'GET',
        url: '/api/settings',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { daemon: { registered: boolean } }).daemon.registered).toBe(true);
    } finally {
      await app.close();
    }
  });
});

// registerAuthRoutes called directly against a bare Fastify instance (NOT via
// buildAll) — exercises AuthRoutesDeps fields that buildAll's own production
// wiring never leaves at their "unset" default: `terminateDaemon` (buildAll
// only wires it for a real InboundDaemonLink, never the test's
// InProcessDaemonLink), `terminateSurface` omitted entirely, and
// `daemonLink` omitted entirely (both documented in auth-routes.ts as
// "optional only so unit tests can exercise the registry side in isolation").
describe('registerAuthRoutes: direct deps injection (branches buildAll never exercises)', () => {
  let dir: string;
  let Fastify: typeof import('fastify').default;
  let registerAuthRoutes: typeof import('../src/auth-routes.js').registerAuthRoutes;
  let PresenceTracker: typeof import('../src/presence.js').PresenceTracker;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'patch-auth-direct-'));
    Fastify = (await import('fastify')).default;
    ({ registerAuthRoutes } = await import('../src/auth-routes.js'));
    ({ PresenceTracker } = await import('../src/presence.js'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('POST /api/auth/revoke: terminateDaemon IS called when revoking a host id', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(140));
    const registry = Registry.load(dir);
    bootstrap(registry, user);
    registry.upsertSurface({ surfaceId: 'srf-web', surfaceKind: 'web', label: 'mac', issuedAt: 1 });
    registry.setDaemonKey({ daemonId: 'daemon-1', publicKey: user.publicKey, issuedAt: 1 });
    const jwt = await surfaceBearer(user, 'srf-web');

    const app = Fastify();
    let terminateDaemonCalls = 0;
    registerAuthRoutes(app, {
      logger: app.log,
      registry,
      presence: new PresenceTracker(),
      terminateDaemon: () => {
        terminateDaemonCalls += 1;
        return true;
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/revoke',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { id: 'daemon-1' },
      });
      expect(res.statusCode).toBe(200);
      expect(terminateDaemonCalls).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('POST /api/auth/revoke: terminateSurface omitted → terminated defaults to false, still 200', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(141));
    const registry = Registry.load(dir);
    bootstrap(registry, user);
    registry.upsertSurface({ surfaceId: 'srf-web', surfaceKind: 'web', label: 'mac', issuedAt: 1 });
    registry.upsertSurface({
      surfaceId: 'srf-target',
      surfaceKind: 'mobile',
      label: 'pixel',
      issuedAt: 1,
    });
    const jwt = await surfaceBearer(user, 'srf-web');

    const app = Fastify();
    // No terminateSurface / terminateDaemon in deps at all.
    registerAuthRoutes(app, { logger: app.log, registry, presence: new PresenceTracker() });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/revoke',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { id: 'srf-target' },
      });
      expect(res.statusCode).toBe(200);
      expect(registry.isRevoked('srf-target')).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('GET /api/settings: daemonLink omitted → daemon.status defaults to offline, lastConnectedAt null', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(142));
    const registry = Registry.load(dir);
    bootstrap(registry, user);
    registry.upsertSurface({ surfaceId: 'srf-web', surfaceKind: 'web', label: 'mac', issuedAt: 1 });
    const jwt = await surfaceBearer(user, 'srf-web');

    const app = Fastify();
    // No daemonLink in deps at all.
    registerAuthRoutes(app, { logger: app.log, registry, presence: new PresenceTracker() });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/settings',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { daemon: { status: string; lastConnectedAt: number | null } };
      expect(body.daemon.status).toBe('offline');
      expect(body.daemon.lastConnectedAt).toBeNull();
    } finally {
      await app.close();
    }
  });
});

// New (current, surface-JWT-gated) daemon-registration flow edge cases not
// covered by the happy-path tests in the "surface-initiated add-daemon
// pairing" describe block below.
describe('host registration REST routes: edge cases (current flow)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-daemon-reg-edge-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function makeApp(registry: Registry, extra: Partial<BuildOptions> = {}) {
    return buildAll({ logger: false, registry, daemonLink: new InProcessDaemonLink(), ...extra });
  }

  async function bootstrapWithSurface(seedByte: number): Promise<{
    registry: Registry;
    user: UserKeypair;
    jwt: string;
  }> {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(seedByte));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({
      surfaceId: 'srf-web',
      surfaceKind: 'web',
      label: 'browser',
      issuedAt: 1,
    });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-web',
      surfaceKind: 'web',
      label: 'browser',
    });
    return { registry, user, jwt };
  }

  it('register/complete returns 400 when no account is bootstrapped', async () => {
    const registry = Registry.load(dir);
    const { app } = await makeApp(registry);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/daemon/register/complete',
        payload: { nonce: 'x', daemonId: 'd1', label: 'l', publicKey: daemonPublicKey(19) },
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toBe('no account bootstrapped');
    } finally {
      await app.close();
    }
  });

  it('register/complete returns 400 on a malformed body (safeParse failure)', async () => {
    const { registry } = await bootstrapWithSurface(120);
    const { app } = await makeApp(registry);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/daemon/register/complete',
        // Missing required `label`.
        payload: { nonce: 'x', daemonId: 'd1', publicKey: daemonPublicKey(19) },
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toBe('invalid body');
    } finally {
      await app.close();
    }
  });

  it('register/complete rejects a body with no publicKey', async () => {
    // spec/10 § Host registration step 2 — the host submits the nonce AND
    // its public key. A body without one is not a registration.
    const { registry } = await bootstrapWithSurface(119);
    const { app } = await makeApp(registry);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/daemon/register/complete',
        payload: { nonce: 'x', daemonId: 'd1', label: 'l' },
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toBe('invalid body');
    } finally {
      await app.close();
    }
  });

  it('register/complete rejects a publicKey that is not a 32-byte Ed25519 key', async () => {
    const { registry, jwt } = await bootstrapWithSurface(118);
    const { app } = await makeApp(registry);
    try {
      const startRes = await app.inject({
        method: 'POST',
        url: '/api/auth/daemon/pair/start',
        headers: { authorization: `Bearer ${jwt}` },
      });
      const { nonce } = startRes.json() as { nonce: string };
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/daemon/register/complete',
        payload: { nonce, daemonId: 'd1', label: 'l', publicKey: 'not-a-real-ed25519-key' },
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toBe('invalid publicKey');
      expect(registry.getDaemonKey('d1')).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('registers a SECOND machine, and refuses re-registering a live one', async () => {
    // spec/01 — an account has any number of machines, so an existing
    // registration is not a reason to refuse a new one. Re-registering an id
    // that is already live IS refused: it would decommission a running machine
    // nobody asked to replace.
    const { registry, jwt } = await bootstrapWithSurface(121);
    registry.setDaemonKey({ daemonId: 'existing-daemon', publicKey: 'pk', issuedAt: 1 });
    const { app } = await makeApp(registry);
    async function completeWith(daemonId: string) {
      const startRes = await app.inject({
        method: 'POST',
        url: '/api/auth/daemon/pair/start',
        headers: { authorization: `Bearer ${jwt}` },
      });
      const { nonce } = startRes.json() as { nonce: string };
      return app.inject({
        method: 'POST',
        url: '/api/auth/daemon/register/complete',
        payload: { nonce, daemonId, label: daemonId, publicKey: daemonPublicKey(21) },
      });
    }
    try {
      const added = await completeWith('new-daemon');
      expect(added.statusCode).toBe(200);
      expect(registry.registeredDaemonIds().sort()).toEqual(['existing-daemon', 'new-daemon']);

      const dupe = await completeWith('new-daemon');
      expect(dupe.statusCode).toBe(409);
      expect((dupe.json() as { error: string }).error).toContain('new-daemon');
    } finally {
      await app.close();
    }
  });

  it('a code that has already registered a machine is refused as USED, not as unknown', async () => {
    // spec/11 unhappy paths — the installer reports "expired" and "already
    // used" as exactly that, so the server has to tell them apart. A spent slot
    // is kept (the host long-polls it for its credential), so without this it
    // would happily register a SECOND machine on one code.
    const { registry, jwt } = await bootstrapWithSurface(129);
    const { app } = await makeApp(registry);
    try {
      const startRes = await app.inject({
        method: 'POST',
        url: '/api/auth/daemon/pair/start',
        headers: { authorization: `Bearer ${jwt}` },
      });
      const { nonce } = startRes.json() as { nonce: string };
      const first = await app.inject({
        method: 'POST',
        url: '/api/auth/daemon/register/complete',
        payload: { nonce, daemonId: 'machine-1', label: 'm1', publicKey: daemonPublicKey(29) },
      });
      expect(first.statusCode).toBe(200);

      const second = await app.inject({
        method: 'POST',
        url: '/api/auth/daemon/register/complete',
        payload: { nonce, daemonId: 'machine-2', label: 'm2', publicKey: daemonPublicKey(30) },
      });
      expect(second.statusCode).toBe(400);
      expect(second.json()).toMatchObject({ error: 'code already used', code: 'nonce_used' });
      // The second machine was never registered.
      expect(registry.getDaemonKey('machine-2')).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('register/complete returns 400 for an unknown nonce', async () => {
    const { registry } = await bootstrapWithSurface(122);
    const { app } = await makeApp(registry);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/daemon/register/complete',
        payload: {
          nonce: 'never-issued',
          daemonId: 'd1',
          label: 'l',
          publicKey: daemonPublicKey(22),
        },
      });
      expect(res.statusCode).toBe(400);
      // The installer surfaces this verbatim, so it names the cause in the
      // user's vocabulary ("code" — what they typed/scanned), not "nonce".
      expect(res.json()).toMatchObject({ error: 'unknown code', code: 'nonce_unknown' });
    } finally {
      await app.close();
    }
  });

  it('register/complete returns 400 for an expired nonce', async () => {
    const { registry, jwt } = await bootstrapWithSurface(123);
    let clock = 0;
    const built = await buildAll({
      logger: false,
      registry,
      daemonLink: new InProcessDaemonLink(),
      nowMs: () => clock,
    });
    const app = built.app;
    try {
      const startRes = await app.inject({
        method: 'POST',
        url: '/api/auth/daemon/pair/start',
        headers: { authorization: `Bearer ${jwt}` },
      });
      const { nonce } = startRes.json() as { nonce: string };
      clock = 10 * 60 * 1000; // past the 5-min TTL
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/daemon/register/complete',
        payload: { nonce, daemonId: 'd1', label: 'l', publicKey: daemonPublicKey(23) },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'code expired', code: 'nonce_expired' });
    } finally {
      await app.close();
    }
  });

  it('register/complete: a missing private key rethrows as 500 (NO FALLBACK)', async () => {
    const { registry, jwt } = await bootstrapWithSurface(124);
    const broken = overrideRegistry(registry, { getAccountPrivateKey: () => null });
    const { app } = await makeApp(broken);
    try {
      const startRes = await app.inject({
        method: 'POST',
        url: '/api/auth/daemon/pair/start',
        headers: { authorization: `Bearer ${jwt}` },
      });
      const { nonce } = startRes.json() as { nonce: string };
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/daemon/register/complete',
        payload: { nonce, daemonId: 'd1', label: 'l', publicKey: daemonPublicKey(24) },
      });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: 'internal' });
    } finally {
      await app.close();
    }
  });

  it('register/complete: a mint failure restores the slot (reusable) and rethrows as 500', async () => {
    const { registry, jwt } = await bootstrapWithSurface(125);
    // The daemon-registration nonce store lives inside registerAuthRoutes,
    // scoped per app instance — so the retry must reuse the SAME app for the
    // restored slot to still be there. getAccountPrivateKey() returns a
    // syntactically-nonempty but cryptographically-invalid key on the FIRST
    // call only (mintDaemonKey's loadUserIdentity() throws on the malformed
    // seed), then heals itself so the retry against the restored slot succeeds.
    let calls = 0;
    const flaky = overrideRegistry(registry, {
      getAccountPrivateKey: () => {
        calls += 1;
        return calls === 1 ? 'AA' : registry.getAccountPrivateKey();
      },
    });
    const { app } = await makeApp(flaky);
    try {
      const startRes = await app.inject({
        method: 'POST',
        url: '/api/auth/daemon/pair/start',
        headers: { authorization: `Bearer ${jwt}` },
      });
      const { nonce } = startRes.json() as { nonce: string };
      const failed = await app.inject({
        method: 'POST',
        url: '/api/auth/daemon/register/complete',
        payload: { nonce, daemonId: 'd1', label: 'l', publicKey: daemonPublicKey(25) },
      });
      expect(failed.statusCode).toBe(500);
      expect(failed.json()).toEqual({ error: 'internal' });
      expect(registry.getDaemonKey('d1')).toBeNull();

      // The slot was restored (DoS resistance) — the SAME nonce is still
      // usable now that getAccountPrivateKey() has healed.
      const retry = await app.inject({
        method: 'POST',
        url: '/api/auth/daemon/register/complete',
        payload: { nonce, daemonId: 'd1', label: 'l', publicKey: daemonPublicKey(25) },
      });
      expect(retry.statusCode).toBe(200);
      expect(registry.getDaemonKey('d1')?.daemonId).toBe('d1');
      // The registry recorded WHICH machine took the slot.
      expect(registry.getDaemonKey('d1')?.publicKey).toBe(daemonPublicKey(25));
    } finally {
      await app.close();
    }
  });

  it('register/await: 400 when the nonce query param is missing', async () => {
    const { registry } = await bootstrapWithSurface(126);
    const { app } = await makeApp(registry);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/auth/daemon/register/await' });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toBe('nonce query param required');
    } finally {
      await app.close();
    }
  });

  it('register/await: 404 for a nonce that was never issued', async () => {
    const { registry } = await bootstrapWithSurface(127);
    const { app } = await makeApp(registry);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/daemon/register/await?nonce=never-issued',
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('register/await: long-polls, then resolves once register/complete relays the daemonKey', async () => {
    const { registry, jwt } = await bootstrapWithSurface(128);
    const { app } = await makeApp(registry);
    try {
      const startRes = await app.inject({
        method: 'POST',
        url: '/api/auth/daemon/pair/start',
        headers: { authorization: `Bearer ${jwt}` },
      });
      const { nonce } = startRes.json() as { nonce: string };

      // Start the long-poll but don't await it yet — it must park an awaiter
      // (the entry has no daemonKey yet).
      const awaitPromise = app.inject({
        method: 'GET',
        url: `/api/auth/daemon/register/await?nonce=${encodeURIComponent(nonce)}`,
      });
      // Give the GET handler a tick to reach its addAwaiter() call before we
      // relay the credential.
      await new Promise((resolve) => setTimeout(resolve, 20));

      const completeRes = await app.inject({
        method: 'POST',
        url: '/api/auth/daemon/register/complete',
        payload: { nonce, daemonId: 'd1', label: 'l', publicKey: daemonPublicKey(28) },
      });
      expect(completeRes.statusCode).toBe(200);

      const awaitRes = await awaitPromise;
      expect(awaitRes.statusCode).toBe(200);
      expect((awaitRes.json() as { daemonKey: string }).daemonKey.length).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it('register/await: times out with 408 when complete never arrives', async () => {
    const { registry, jwt } = await bootstrapWithSurface(129);
    let clock = 0;
    const built = await buildAll({
      logger: false,
      registry,
      daemonLink: new InProcessDaemonLink(),
      nowMs: () => clock,
    });
    const app = built.app;
    try {
      const startRes = await app.inject({
        method: 'POST',
        url: '/api/auth/daemon/pair/start',
        headers: { authorization: `Bearer ${jwt}` },
      });
      const { nonce } = startRes.json() as { nonce: string };
      clock = 10 * 60 * 1000; // past the 5-min TTL → waitMs computes to 0
      const res = await app.inject({
        method: 'GET',
        url: `/api/auth/daemon/register/await?nonce=${encodeURIComponent(nonce)}`,
      });
      expect(res.statusCode).toBe(408);
    } finally {
      await app.close();
    }
  }, 8_000);
});

// spec/14 `/settings` "add-daemon QR": the already-linked web surface mints the
// registration nonce (POST /api/auth/daemon/pair/start) and renders it as a QR;
// the host scans it and completes the same way (register/complete), claiming
// its own daemonId against the surface-issued slot — the SERVER mints the key.
describe('surface-initiated add-daemon pairing (G4-9)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-daemon-pair-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function makeApp(registry: Registry, extra: Partial<BuildOptions> = {}) {
    return buildAll({ logger: false, registry, daemonLink: new InProcessDaemonLink(), ...extra });
  }

  it('requires a surface bearer (401 anonymously)', async () => {
    const registry = Registry.load(dir);
    bootstrap(
      registry,
      generateUserKeypair(() => new Uint8Array(32).fill(90)),
    );
    const { app } = await makeApp(registry);
    try {
      const res = await app.inject({ method: 'POST', url: '/api/auth/daemon/pair/start' });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('mints a genuine pairing nonce for an authed surface', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(91));
    const registry = Registry.load(dir);
    bootstrap(registry, user);
    registry.upsertSurface({
      surfaceId: 'srf-web',
      surfaceKind: 'web',
      label: 'browser',
      issuedAt: 1,
    });
    const { app } = await makeApp(registry);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/daemon/pair/start',
        headers: { authorization: `Bearer ${await surfaceBearer(user, 'srf-web')}` },
      });
      expect(res.statusCode).toBe(200);
      const { nonce, expiresAt } = res.json() as { nonce: string; expiresAt: number };
      expect(nonce.length).toBeGreaterThan(8);
      expect(expiresAt).toBeGreaterThan(Date.now());
    } finally {
      await app.close();
    }
  });

  it("register/await hands the new machine the server's voice-session secret with its key", async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(94));
    const registry = Registry.load(dir);
    bootstrap(registry, user);
    registry.upsertSurface({ surfaceId: 'srf-web', surfaceKind: 'web', label: 'b', issuedAt: 1 });
    const { app } = await makeApp(registry, { internalToken: 'voice-secret-0123456789' });
    try {
      const startRes = await app.inject({
        method: 'POST',
        url: '/api/auth/daemon/pair/start',
        headers: { authorization: `Bearer ${await surfaceBearer(user, 'srf-web')}` },
      });
      const { nonce } = startRes.json() as { nonce: string };
      await app.inject({
        method: 'POST',
        url: '/api/auth/daemon/register/complete',
        payload: { nonce, daemonId: 'mac', label: 'mac', publicKey: daemonPublicKey(95) },
      });
      const awaitRes = await app.inject({
        method: 'GET',
        url: `/api/auth/daemon/register/await?nonce=${encodeURIComponent(nonce)}`,
      });
      expect(awaitRes.statusCode).toBe(200);
      expect(awaitRes.json()).toMatchObject({ internalToken: 'voice-secret-0123456789' });
    } finally {
      await app.close();
    }
  });

  it('the host completes against a surface-issued nonce, claiming its own daemonId', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(92));
    const registry = Registry.load(dir);
    bootstrap(registry, user);
    registry.upsertSurface({
      surfaceId: 'srf-web',
      surfaceKind: 'web',
      label: 'browser',
      issuedAt: 1,
    });
    const { app } = await makeApp(registry);
    try {
      const startRes = await app.inject({
        method: 'POST',
        url: '/api/auth/daemon/pair/start',
        headers: { authorization: `Bearer ${await surfaceBearer(user, 'srf-web')}` },
      });
      const { nonce } = startRes.json() as { nonce: string };

      // The host (scanning the QR) posts complete with its own id; SERVER mints.
      const completeRes = await app.inject({
        method: 'POST',
        url: '/api/auth/daemon/register/complete',
        payload: {
          nonce,
          daemonId: 'hetzner-daemon',
          label: 'hetzner',
          publicKey: daemonPublicKey(93),
        },
      });
      expect(completeRes.statusCode).toBe(200);
      expect(registry.getDaemonKey('hetzner-daemon')?.daemonId).toBe('hetzner-daemon');
      expect(registry.getDaemonKey('hetzner-daemon')?.publicKey).toBe(daemonPublicKey(93));

      const awaitRes = await app.inject({
        method: 'GET',
        url: `/api/auth/daemon/register/await?nonce=${encodeURIComponent(nonce)}`,
      });
      expect(awaitRes.statusCode).toBe(200);
      expect((awaitRes.json() as { daemonKey: string }).daemonKey.length).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });
});
