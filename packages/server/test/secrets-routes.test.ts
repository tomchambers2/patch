// spec/15 § Secrets — server relay + cold-start REST + write endpoints.
//
// The host owns the secret store and publishes it over the host link
// (`secrets.list` on connect, `secrets.updated` on change). Writes are surface-
// originated RPCs the server round-trips to the host (`patch.secrets.*`).
// These tests assert:
//   - GET /api/secrets serves the host-published mirror (cold start) + auth.
//   - PUT /api/secrets/:key upserts through the host and the mirror reflects it.
//   - DELETE /api/secrets/:key removes through the host; unknown key → 404.
//   - an invalid key → 400; every write endpoint is auth-gated.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import type { WireEvent } from '@patch/wire';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';

// A fake host: an in-memory secret store that answers the `patch.secrets.*`
// RPCs the server sends, mirroring packages/daemon/src/index.ts handleSecretsMutation.
// Also re-publishes `secrets.updated` on success so the server's mirror updates.
class FakeSecretsDaemon extends InProcessDaemonLink {
  private store = new Map<string, string>();
  private static readonly KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

  override send(surfaceId: string, event: WireEvent): void {
    super.send(surfaceId, event);
    if (event.type === 'patch.secrets.set_request') {
      if (!FakeSecretsDaemon.KEY_RE.test(event.key)) {
        this.emit({
          type: 'patch.secrets.response',
          requestId: event.requestId,
          ok: false,
          error: { code: 'invalid_key', message: `invalid secret key: ${event.key}` },
        });
        return;
      }
      this.store.set(event.key, event.value);
      this.emit({ type: 'patch.secrets.response', requestId: event.requestId, ok: true });
      this.emit({ type: 'secrets.updated', secrets: this.snapshot() });
    } else if (event.type === 'patch.secrets.delete_request') {
      if (!this.store.has(event.key)) {
        this.emit({
          type: 'patch.secrets.response',
          requestId: event.requestId,
          ok: false,
          error: { code: 'not_found', message: `secret not found: ${event.key}` },
        });
        return;
      }
      this.store.delete(event.key);
      this.emit({ type: 'patch.secrets.response', requestId: event.requestId, ok: true });
      this.emit({ type: 'secrets.updated', secrets: this.snapshot() });
    }
  }

  seed(key: string, value: string): void {
    this.store.set(key, value);
  }

  private snapshot(): Array<{ key: string; value: string }> {
    return [...this.store.keys()].sort().map((key) => ({ key, value: this.store.get(key)! }));
  }
}

describe('secrets routes', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-secrets-routes-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function bootstrap() {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(22));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({
      surfaceId: 'srf-secrets',
      surfaceKind: 'mobile',
      label: 'phone',
      issuedAt: 1,
    });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-secrets',
      surfaceKind: 'mobile',
      label: 'phone',
    });
    return { registry, jwt };
  }

  const authed = (jwt: string) => ({ authorization: `Bearer ${jwt}` });

  it('GET /api/secrets is empty before the host publishes', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new FakeSecretsDaemon();
    const built = await buildAll({ logger: false, registry, daemonLink });
    try {
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/secrets',
        headers: authed(jwt),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ secrets: [] });
    } finally {
      await built.app.close();
    }
  });

  it('GET /api/secrets serves the host-published set (cold start)', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new FakeSecretsDaemon();
    const built = await buildAll({ logger: false, registry, daemonLink });
    try {
      daemonLink.emit({
        type: 'secrets.list',
        secrets: [
          { key: 'OPENAI_API_KEY', value: 'sk-1' },
          { key: 'TODOIST_TOKEN', value: 'td-2' },
        ],
      });
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/secrets',
        headers: authed(jwt),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        secrets: [
          { key: 'OPENAI_API_KEY', value: 'sk-1' },
          { key: 'TODOIST_TOKEN', value: 'td-2' },
        ],
      });
    } finally {
      await built.app.close();
    }
  });

  it('GET /api/secrets requires auth', async () => {
    const { registry } = await bootstrap();
    const daemonLink = new FakeSecretsDaemon();
    const built = await buildAll({ logger: false, registry, daemonLink });
    try {
      const res = await built.app.inject({ method: 'GET', url: '/api/secrets' });
      expect(res.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });

  it('PUT /api/secrets/:key upserts through the host and the mirror reflects it', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new FakeSecretsDaemon();
    const built = await buildAll({ logger: false, registry, daemonLink });
    try {
      const put = await built.app.inject({
        method: 'PUT',
        url: '/api/secrets/OPENAI_API_KEY',
        headers: authed(jwt),
        payload: { value: 'sk-live' },
      });
      expect(put.statusCode).toBe(200);
      expect(put.json()).toEqual({ ok: true });
      // The host actually received the set request.
      expect(
        daemonLink.sent.some(
          (s) =>
            s.event.type === 'patch.secrets.set_request' &&
            s.event.key === 'OPENAI_API_KEY' &&
            s.event.value === 'sk-live',
        ),
      ).toBe(true);
      // secrets.updated propagated to the mirror → GET reflects the write.
      const get = await built.app.inject({
        method: 'GET',
        url: '/api/secrets',
        headers: authed(jwt),
      });
      expect(get.json()).toEqual({ secrets: [{ key: 'OPENAI_API_KEY', value: 'sk-live' }] });
    } finally {
      await built.app.close();
    }
  });

  it('PUT with a non-string value is a 400', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new FakeSecretsDaemon();
    const built = await buildAll({ logger: false, registry, daemonLink });
    try {
      const res = await built.app.inject({
        method: 'PUT',
        url: '/api/secrets/TOKEN',
        headers: authed(jwt),
        payload: { value: 123 },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await built.app.close();
    }
  });

  it('PUT with an invalid key is rejected by the host (400)', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new FakeSecretsDaemon();
    const built = await buildAll({ logger: false, registry, daemonLink });
    try {
      const res = await built.app.inject({
        method: 'PUT',
        url: '/api/secrets/bad%20key',
        headers: authed(jwt),
        payload: { value: 'x' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_key');
    } finally {
      await built.app.close();
    }
  });

  it('DELETE /api/secrets/:key removes through the host', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new FakeSecretsDaemon();
    daemonLink.seed('TOKEN', 'v');
    const built = await buildAll({ logger: false, registry, daemonLink });
    try {
      daemonLink.emit({ type: 'secrets.list', secrets: [{ key: 'TOKEN', value: 'v' }] });
      const del = await built.app.inject({
        method: 'DELETE',
        url: '/api/secrets/TOKEN',
        headers: authed(jwt),
      });
      expect(del.statusCode).toBe(200);
      expect(del.json()).toEqual({ ok: true });
      const get = await built.app.inject({
        method: 'GET',
        url: '/api/secrets',
        headers: authed(jwt),
      });
      expect(get.json()).toEqual({ secrets: [] });
    } finally {
      await built.app.close();
    }
  });

  it('DELETE of an unknown key is a 404', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new FakeSecretsDaemon();
    const built = await buildAll({ logger: false, registry, daemonLink });
    try {
      const res = await built.app.inject({
        method: 'DELETE',
        url: '/api/secrets/NOPE',
        headers: authed(jwt),
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('not_found');
    } finally {
      await built.app.close();
    }
  });

  it('write endpoints require auth', async () => {
    const { registry } = await bootstrap();
    const daemonLink = new FakeSecretsDaemon();
    const built = await buildAll({ logger: false, registry, daemonLink });
    try {
      const put = await built.app.inject({
        method: 'PUT',
        url: '/api/secrets/TOKEN',
        payload: { value: 'x' },
      });
      expect(put.statusCode).toBe(401);
      const del = await built.app.inject({ method: 'DELETE', url: '/api/secrets/TOKEN' });
      expect(del.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });

  it('GET /api/secrets is 401 when no account has been bootstrapped at all', async () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'patch-secrets-noaccount-'));
    try {
      const registry = Registry.load(dir2);
      const daemonLink = new FakeSecretsDaemon();
      const built = await buildAll({ logger: false, registry, daemonLink });
      try {
        const res = await built.app.inject({ method: 'GET', url: '/api/secrets' });
        expect(res.statusCode).toBe(401);
      } finally {
        await built.app.close();
      }
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it('a malformed bearer token is rejected with 401 (verify throws)', async () => {
    const { registry } = await bootstrap();
    const daemonLink = new FakeSecretsDaemon();
    const built = await buildAll({ logger: false, registry, daemonLink });
    try {
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/secrets',
        headers: authed('not-a-real-jwt'),
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });

  it('a revoked surface is rejected with 401', async () => {
    const { registry, jwt } = await bootstrap();
    registry.revoke('srf-secrets');
    const daemonLink = new FakeSecretsDaemon();
    const built = await buildAll({ logger: false, registry, daemonLink });
    try {
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/secrets',
        headers: authed(jwt),
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });

  it('PUT with a blank (whitespace-only) key is 400 key_required', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new FakeSecretsDaemon();
    const built = await buildAll({ logger: false, registry, daemonLink });
    try {
      const res = await built.app.inject({
        method: 'PUT',
        url: '/api/secrets/%20',
        headers: authed(jwt),
        payload: { value: 'x' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'key_required', message: 'key is required' });
    } finally {
      await built.app.close();
    }
  });

  it('DELETE with a blank (whitespace-only) key is 400 key_required', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new FakeSecretsDaemon();
    const built = await buildAll({ logger: false, registry, daemonLink });
    try {
      const res = await built.app.inject({
        method: 'DELETE',
        url: '/api/secrets/%20',
        headers: authed(jwt),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'key_required', message: 'key is required' });
    } finally {
      await built.app.close();
    }
  });

  it('PUT times out (504 daemon_timeout) when the host never answers', async () => {
    const { registry, jwt } = await bootstrap();
    // A host link whose `send` is a black hole — never emits a response.
    const daemonLink = new InProcessDaemonLink();
    const built = await buildAll({ logger: false, registry, daemonLink });
    try {
      // SECRETS_REQUEST_TIMEOUT_MS (5s) is a hardcoded constant (not
      // clock-injectable), so this exercises the real setTimeout with a
      // real wait rather than fake timers (which don't reliably drive
      // fastify's own internal inject() scheduling).
      const res = await built.app.inject({
        method: 'PUT',
        url: '/api/secrets/TOKEN',
        headers: authed(jwt),
        payload: { value: 'x' },
      });
      expect(res.statusCode).toBe(504);
      expect(res.json()).toEqual({ error: 'daemon_timeout' });
    } finally {
      await built.app.close();
    }
  }, 8_000);

  it('an unrecognised host error code (no error object) maps to 502 with default code/message', async () => {
    const { registry, jwt } = await bootstrap();
    // A host that answers ok:false with NO `error` field at all — exercises
    // the `error?.code ?? 'internal'` and `error?.message ?? '...'` fallbacks,
    // and the "anything else" 502 branch of the status ternary.
    class BareFailureDaemon extends InProcessDaemonLink {
      override send(surfaceId: string, event: WireEvent): void {
        super.send(surfaceId, event);
        if (event.type === 'patch.secrets.set_request') {
          this.emit({ type: 'patch.secrets.response', requestId: event.requestId, ok: false });
        }
      }
    }
    const daemonLink = new BareFailureDaemon();
    const built = await buildAll({ logger: false, registry, daemonLink });
    try {
      const res = await built.app.inject({
        method: 'PUT',
        url: '/api/secrets/TOKEN',
        headers: authed(jwt),
        payload: { value: 'x' },
      });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({ error: 'internal', message: 'secret write failed' });
    } finally {
      await built.app.close();
    }
  });

  it('a late/unmatched patch.secrets.response (unknown requestId) is ignored, not a crash', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new FakeSecretsDaemon();
    const built = await buildAll({ logger: false, registry, daemonLink });
    try {
      // No PUT/DELETE is in flight — this requestId was never registered.
      daemonLink.emit({
        type: 'patch.secrets.response',
        requestId: 'never-requested',
        ok: true,
      });
      // The server is still healthy afterwards.
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/secrets',
        headers: authed(jwt),
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await built.app.close();
    }
  });
});
