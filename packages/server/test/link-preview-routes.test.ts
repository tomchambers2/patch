// GET /api/link-preview (spec/14 § Message links) — server-side fetch + parse
// of a linked page's title/description/image for the web surface's inline
// preview icon.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';

describe('GET /api/link-preview', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-link-preview-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  async function boot() {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(13));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({
      surfaceId: 'srf-lp',
      surfaceKind: 'web',
      label: 'browser',
      issuedAt: 1,
    });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-lp',
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

  it('extracts og:title / og:description / og:image from the fetched page', async () => {
    const html = `<!doctype html><html><head>
      <meta property="og:title" content="Example Title">
      <meta property="og:description" content="An example &amp; description">
      <meta property="og:image" content="/thumb.png">
      <title>fallback title</title>
    </head><body></body></html>`;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(html, {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          }),
      ),
    );
    const { app, jwt } = await boot();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/link-preview?url=' + encodeURIComponent('https://example.com/article'),
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        url: 'https://example.com/article',
        title: 'Example Title',
        description: 'An example & description',
        image: 'https://example.com/thumb.png',
      });
    } finally {
      await app.close();
    }
  });

  it('falls back to <title> when there is no og:title', async () => {
    const html = `<!doctype html><html><head><title>Plain Title</title></head><body></body></html>`;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
      ),
    );
    const { app, jwt } = await boot();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/link-preview?url=' + encodeURIComponent('https://example.com/'),
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().title).toBe('Plain Title');
    } finally {
      await app.close();
    }
  });

  it('refuses an unauthenticated caller', async () => {
    const { app } = await boot();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/link-preview?url=' + encodeURIComponent('https://example.com/'),
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('rejects a non-http(s) URL', async () => {
    const { app, jwt } = await boot();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/link-preview?url=' + encodeURIComponent('file:///etc/passwd'),
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_url');
    } finally {
      await app.close();
    }
  });

  it('rejects a request naming a private/loopback host, without fetching it', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { app, jwt } = await boot();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/link-preview?url=' + encodeURIComponent('http://127.0.0.1:8080/secret'),
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('blocked_host');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('surfaces an upstream fetch failure as 502, not a silent empty preview', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network unreachable');
      }),
    );
    const { app, jwt } = await boot();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/link-preview?url=' + encodeURIComponent('https://example.com/'),
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toBe('fetch_failed');
    } finally {
      await app.close();
    }
  });

  it('rejects a non-html response rather than parsing it as one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('{"not":"html"}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    const { app, jwt } = await boot();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/link-preview?url=' + encodeURIComponent('https://example.com/data.json'),
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(415);
    } finally {
      await app.close();
    }
  });
});

describe('GET /api/link-preview/image', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-link-preview-image-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  async function boot() {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(13));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({
      surfaceId: 'srf-lp-img',
      surfaceKind: 'web',
      label: 'browser',
      issuedAt: 1,
    });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-lp-img',
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

  it('proxies the image bytes with the original content-type — no plain <img src> can carry the bearer header, and the CSP blocks a third-party img-src regardless', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(bytes, { status: 200, headers: { 'content-type': 'image/png' } }),
      ),
    );
    const { app, jwt } = await boot();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/link-preview/image?url=' + encodeURIComponent('https://example.com/thumb.png'),
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect(Uint8Array.from(res.rawPayload)).toEqual(bytes);
    } finally {
      await app.close();
    }
  });

  it('refuses an unauthenticated caller', async () => {
    const { app } = await boot();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/link-preview/image?url=' + encodeURIComponent('https://example.com/thumb.png'),
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('rejects a request naming a private/loopback host, without fetching it', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { app, jwt } = await boot();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/link-preview/image?url=' + encodeURIComponent('http://127.0.0.1:8080/thumb.png'),
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('blocked_host');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects a non-image response rather than proxying it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      ),
    );
    const { app, jwt } = await boot();
    try {
      const res = await app.inject({
        method: 'GET',
        url:
          '/api/link-preview/image?url=' + encodeURIComponent('https://example.com/not-an-image'),
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(415);
    } finally {
      await app.close();
    }
  });
});
