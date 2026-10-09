// Composer attachment upload + serve-back tests (spec/14 & spec/15 § Composer).
//
// Exercises the real HTTP round-trip: POST multipart → server stores a copy +
// round-trips the bytes to the (mock) host → returns a ref; then GET the
// ref's URL streams the stored file back with its mime type. Plus the NO
// FALLBACK error paths (unknown chat, missing auth, host error).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import type { WireEvent } from '@patch/wire';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const BOUNDARY = '----patchtestboundary';

/** One `name="<field>"` file part of a multipart body. */
function filePart(field: string, filename: string, contentType: string, bytes: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`,
    ),
    bytes,
    Buffer.from('\r\n'),
  ]);
}

/**
 * Build an upload body: the `file` part (the ORIGINAL) plus, optionally, the
 * `model` part (the downscaled copy the agent reads) — spec/15 § Composer.
 */
function multipart(
  fieldFilename: string,
  contentType: string,
  bytes: Buffer,
  model?: { filename: string; contentType: string; bytes: Buffer },
): { payload: Buffer; headers: Record<string, string> } {
  const parts = [filePart('file', fieldFilename, contentType, bytes)];
  if (model) parts.push(filePart('model', model.filename, model.contentType, model.bytes));
  parts.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return {
    payload: Buffer.concat(parts),
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
  };
}

describe('composer attachments', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-attach-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function makeApp(opts: { daemonOk?: boolean; daemonReply?: boolean } = {}) {
    const daemonOk = opts.daemonOk ?? true;
    const daemonReply = opts.daemonReply ?? true;
    const user = generateUserKeypair(() => new Uint8Array(32).fill(13));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({
      surfaceId: 'srf-web-1',
      surfaceKind: 'web',
      label: 'browser',
      issuedAt: 1,
    });
    const daemonLink = new InProcessDaemonLink();
    // Every store_request the server sends — lets a test assert WHICH bytes the
    // host (and so the agent) was handed.
    const storeRequests: Extract<WireEvent, { type: 'patch.attachment.store_request' }>[] = [];
    // Simulate the host: respond to every store_request the server sends.
    const origSend = daemonLink.send.bind(daemonLink);
    daemonLink.send = (surfaceId: string, event: WireEvent): void => {
      origSend(surfaceId, event);
      if (event.type === 'patch.attachment.store_request') storeRequests.push(event);
      if (event.type === 'patch.attachment.store_request' && daemonReply) {
        daemonLink.emit(
          daemonOk
            ? {
                type: 'patch.attachment.store_response',
                requestId: event.requestId,
                ok: true,
                path: `/tmp/chat/.patch/attachments/${event.id}-${event.name}`,
              }
            : {
                type: 'patch.attachment.store_response',
                requestId: event.requestId,
                ok: false,
                error: { code: 'internal', message: 'disk full' },
              },
        );
      }
    };
    const built = await buildAll({ logger: false, registry, daemonLink });
    // Seed a chat so the route sees it as existing.
    daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '/tmp/chat' });
    const credential = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-web-1',
      surfaceKind: 'web',
      label: 'browser',
    });
    return {
      built,
      credential,
      registry,
      daemonLink,
      storeRequests,
      attachmentsDir: join(dir, 'attachments'),
    };
  }

  it('uploads an image, returns a ref, and serves it back inline', async () => {
    const { built, credential } = await makeApp();
    try {
      const mp = multipart('shot.png', 'image/png', PNG);
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats/c1/attachment',
        headers: { authorization: `Bearer ${credential}`, ...mp.headers },
        payload: mp.payload,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        ok: true;
        ref: { id: string; name: string; mimeType: string; kind: string; url: string };
      };
      expect(body.ok).toBe(true);
      expect(body.ref.kind).toBe('image');
      expect(body.ref.name).toBe('shot.png');
      expect(body.ref.mimeType).toBe('image/png');
      expect(body.ref.url).toBe(`/api/chats/c1/attachment/${body.ref.id}`);

      // Serve it back — no auth (like the APK download), correct content-type.
      const get = await built.app.inject({ method: 'GET', url: body.ref.url });
      expect(get.statusCode).toBe(200);
      expect(get.headers['content-type']).toBe('image/png');
      expect(get.rawPayload.equals(PNG)).toBe(true);
    } finally {
      await built.app.close();
    }
  });

  // spec/15 § Composer — "what the agent reads is not what the user sees".
  describe('full-size original vs the agent copy', () => {
    const ORIGINAL = Buffer.from('ORIGINAL-FULL-SIZE-PNG-BYTES');
    const DOWNSCALED = Buffer.from('downscaled-jpeg');

    it('serves the ORIGINAL back while the host gets the MODEL copy', async () => {
      const { built, credential, storeRequests } = await makeApp();
      try {
        const mp = multipart('photo.png', 'image/png', ORIGINAL, {
          filename: 'photo.jpg',
          contentType: 'image/jpeg',
          bytes: DOWNSCALED,
        });
        const res = await built.app.inject({
          method: 'POST',
          url: '/api/chats/c1/attachment',
          headers: { authorization: `Bearer ${credential}`, ...mp.headers },
          payload: mp.payload,
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as { ref: { id: string; name: string; mimeType: string } };

        // The ref + sidecar describe the ORIGINAL — a PNG stays a PNG.
        expect(body.ref.name).toBe('photo.png');
        expect(body.ref.mimeType).toBe('image/png');

        // The agent's copy is the downscaled one.
        expect(storeRequests).toHaveLength(1);
        expect(Buffer.from(storeRequests[0]!.dataBase64, 'base64').equals(DOWNSCALED)).toBe(true);

        // What renders in the stream is the full-size original.
        const get = await built.app.inject({
          method: 'GET',
          url: `/api/chats/c1/attachment/${body.ref.id}`,
        });
        expect(get.statusCode).toBe(200);
        expect(get.headers['content-type']).toBe('image/png');
        expect(get.rawPayload.equals(ORIGINAL)).toBe(true);
      } finally {
        await built.app.close();
      }
    });

    it('with no model part the single upload serves both purposes', async () => {
      const { built, credential, storeRequests } = await makeApp();
      try {
        const mp = multipart('small.png', 'image/png', ORIGINAL);
        const res = await built.app.inject({
          method: 'POST',
          url: '/api/chats/c1/attachment',
          headers: { authorization: `Bearer ${credential}`, ...mp.headers },
          payload: mp.payload,
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as { ref: { id: string } };
        expect(storeRequests).toHaveLength(1);
        expect(Buffer.from(storeRequests[0]!.dataBase64, 'base64').equals(ORIGINAL)).toBe(true);
        const get = await built.app.inject({
          method: 'GET',
          url: `/api/chats/c1/attachment/${body.ref.id}`,
        });
        expect(get.rawPayload.equals(ORIGINAL)).toBe(true);
      } finally {
        await built.app.close();
      }
    });

    it('a model part with no file part is still rejected as a missing file', async () => {
      const { built, credential } = await makeApp();
      try {
        const payload = Buffer.concat([
          filePart('model', 'photo.jpg', 'image/jpeg', DOWNSCALED),
          Buffer.from(`--${BOUNDARY}--\r\n`),
        ]);
        const res = await built.app.inject({
          method: 'POST',
          url: '/api/chats/c1/attachment',
          headers: {
            authorization: `Bearer ${credential}`,
            'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
          },
          payload,
        });
        expect(res.statusCode).toBe(400);
      } finally {
        await built.app.close();
      }
    });
  });

  it('classifies a non-image as kind=file', async () => {
    const { built, credential } = await makeApp();
    try {
      const mp = multipart('notes.txt', 'text/plain', Buffer.from('hello'));
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats/c1/attachment',
        headers: { authorization: `Bearer ${credential}`, ...mp.headers },
        payload: mp.payload,
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { ref: { kind: string } }).ref.kind).toBe('file');
    } finally {
      await built.app.close();
    }
  });

  it('rejects an unknown chat with 404 (NO FALLBACK)', async () => {
    const { built, credential } = await makeApp();
    try {
      const mp = multipart('shot.png', 'image/png', PNG);
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats/NOPE/attachment',
        headers: { authorization: `Bearer ${credential}`, ...mp.headers },
        payload: mp.payload,
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await built.app.close();
    }
  });

  it('rejects a missing bearer with 401', async () => {
    const { built } = await makeApp();
    try {
      const mp = multipart('shot.png', 'image/png', PNG);
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats/c1/attachment',
        headers: mp.headers,
        payload: mp.payload,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });

  it('surfaces a host store failure as 502 (NO FALLBACK)', async () => {
    const { built, credential } = await makeApp({ daemonOk: false });
    try {
      const mp = multipart('shot.png', 'image/png', PNG);
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats/c1/attachment',
        headers: { authorization: `Bearer ${credential}`, ...mp.headers },
        payload: mp.payload,
      });
      expect(res.statusCode).toBe(502);
    } finally {
      await built.app.close();
    }
  });

  it('serves 404 for an unknown attachment id', async () => {
    const { built } = await makeApp();
    try {
      const get = await built.app.inject({
        method: 'GET',
        url: '/api/chats/c1/attachment/DOESNOTEXIST',
      });
      expect(get.statusCode).toBe(404);
    } finally {
      await built.app.close();
    }
  });

  it('rejects a JWT that fails signature verification with 401 (distinct from missing bearer)', async () => {
    const { built } = await makeApp();
    try {
      const mp = multipart('shot.png', 'image/png', PNG);
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats/c1/attachment',
        headers: { authorization: 'Bearer not-a-real-jwt', ...mp.headers },
        payload: mp.payload,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });

  it('rejects when no account has been bootstrapped', async () => {
    const registry = Registry.load(dir); // no bootstrapAccount() call
    const daemonLink = new InProcessDaemonLink();
    const built = await buildAll({ logger: false, registry, daemonLink });
    try {
      const mp = multipart('shot.png', 'image/png', PNG);
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats/c1/attachment',
        headers: { authorization: 'Bearer whatever', ...mp.headers },
        payload: mp.payload,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });

  it('rejects a revoked surface', async () => {
    const { built, credential, registry } = await makeApp();
    registry.revoke('srf-web-1');
    try {
      const mp = multipart('shot.png', 'image/png', PNG);
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats/c1/attachment',
        headers: { authorization: `Bearer ${credential}`, ...mp.headers },
        payload: mp.payload,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });

  it('rejects a non-multipart body with 400', async () => {
    const { built, credential } = await makeApp();
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats/c1/attachment',
        headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
        payload: { not: 'multipart' },
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toBe('expected multipart/form-data');
    } finally {
      await built.app.close();
    }
  });

  it('drains an unexpected file fieldname and still rejects a body with no `file` field', async () => {
    const { built, credential } = await makeApp();
    try {
      const boundary = '----patchtestboundary-wrongfield';
      const head = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="notfile"; filename="x.png"\r\n` +
          `Content-Type: image/png\r\n\r\n`,
      );
      const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
      const payload = Buffer.concat([head, PNG, tail]);
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats/c1/attachment',
        headers: {
          authorization: `Bearer ${credential}`,
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toBe('file is required');
    } finally {
      await built.app.close();
    }
  });

  it('rejects a truncated/malformed multipart body with 400 (busboy parse error)', async () => {
    const { built, credential } = await makeApp();
    try {
      const boundary = '----patchtestboundary-truncated';
      // No terminating boundary at all — busboy raises "Premature close".
      const payload = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.png"\r\n` +
          `Content-Type: image/png\r\n\r\nnot-actually-terminated-properly`,
      );
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats/c1/attachment',
        headers: {
          authorization: `Bearer ${credential}`,
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toContain('invalid multipart body');
    } finally {
      await built.app.close();
    }
  });

  it("rejects an oversized attachment with 400 (caught by @fastify/multipart's own fileSize limit)", async () => {
    // The route has its own MAX_ATTACHMENT_BYTES → 413 check, but
    // @fastify/multipart is registered with the SAME 25MB `fileSize` ceiling
    // (app.ts, shared with /api/voice/note), so busboy always rejects an
    // oversized part first — the app-level 413 branch is unreachable via HTTP
    // (see the v8 ignore comment on it in src/attachments.ts). This still
    // asserts an oversized upload is correctly refused end-to-end.
    const { built, credential } = await makeApp();
    try {
      const big = Buffer.alloc(25 * 1024 * 1024 + 1);
      const mp = multipart('huge.bin', 'application/octet-stream', big);
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats/c1/attachment',
        headers: { authorization: `Bearer ${credential}`, ...mp.headers },
        payload: mp.payload,
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toContain('too large');
    } finally {
      await built.app.close();
    }
  });

  it('surfaces a server-side store failure (fs write error) as 500', async () => {
    const { built, credential } = await makeApp();
    try {
      // 'attachments' exists as a plain FILE, not a directory — mkdirSync(...,
      // { recursive: true }) for `<attachmentsDir>/c1` then fails (ENOTDIR).
      writeFileSync(join(dir, 'attachments'), 'im-a-file-not-a-dir');
      const mp = multipart('shot.png', 'image/png', PNG);
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats/c1/attachment',
        headers: { authorization: `Bearer ${credential}`, ...mp.headers },
        payload: mp.payload,
      });
      expect(res.statusCode).toBe(500);
      expect((res.json() as { error: string }).error).toBe('internal');
    } finally {
      await built.app.close();
    }
  });

  it('returns 504 when the host never replies to the store request', async () => {
    const { built, credential } = await makeApp({ daemonReply: false });
    try {
      const mp = multipart('shot.png', 'image/png', PNG);
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats/c1/attachment',
        headers: { authorization: `Bearer ${credential}`, ...mp.headers },
        payload: mp.payload,
      });
      expect(res.statusCode).toBe(504);
      expect((res.json() as { error: string }).error).toBe('daemon_timeout');
    } finally {
      await built.app.close();
    }
  }, 35_000);

  it('serves 404 for an id containing characters outside the ULID charset', async () => {
    const { built } = await makeApp();
    try {
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/chats/c1/attachment/not$valid!',
      });
      expect(res.statusCode).toBe(404);
      expect((res.json() as { error: string }).error).toBe('not found');
    } finally {
      await built.app.close();
    }
  });

  it('serves 404 for a chatId containing a smuggled slash or embedded ".."', async () => {
    const { built } = await makeApp();
    try {
      // A bare '..' path SEGMENT gets resolved away by the router before it
      // ever reaches our handler (not a real vector), but a single chatId
      // segment can still smuggle a literal '/' (percent-encoded) or contain
      // '..' as a substring — the route's own defence-in-depth check catches
      // both before touching the filesystem.
      const slash = await built.app.inject({
        method: 'GET',
        url: '/api/chats/foo%2Fbar/attachment/VALIDID0000000000000001',
      });
      expect(slash.statusCode).toBe(404);
      expect((slash.json() as { error: string }).error).toBe('not found');

      const dots = await built.app.inject({
        method: 'GET',
        url: '/api/chats/..embedded/attachment/VALIDID0000000000000001',
      });
      expect(dots.statusCode).toBe(404);
      expect((dots.json() as { error: string }).error).toBe('not found');
    } finally {
      await built.app.close();
    }
  });

  it('serves 404 when the sidecar metadata file is corrupt JSON', async () => {
    const { built, credential, attachmentsDir } = await makeApp();
    try {
      const mp = multipart('shot.png', 'image/png', PNG);
      const upload = await built.app.inject({
        method: 'POST',
        url: '/api/chats/c1/attachment',
        headers: { authorization: `Bearer ${credential}`, ...mp.headers },
        payload: mp.payload,
      });
      expect(upload.statusCode).toBe(200);
      const { id } = (upload.json() as { ref: { id: string } }).ref;
      // Corrupt the sidecar after the fact.
      const metaPath = join(attachmentsDir, 'c1', `${id}.json`);
      expect(readFileSync(metaPath, 'utf8').length).toBeGreaterThan(0);
      writeFileSync(metaPath, '{not valid json');
      const get = await built.app.inject({
        method: 'GET',
        url: `/api/chats/c1/attachment/${id}`,
      });
      expect(get.statusCode).toBe(404);
      expect((get.json() as { error: string }).error).toBe('attachment not found');
    } finally {
      await built.app.close();
    }
  });

  it('rejects an empty chatId (double-slash URL) with 400', async () => {
    const { built, credential } = await makeApp();
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats//attachment',
        headers: {
          authorization: `Bearer ${credential}`,
          'content-type': 'multipart/form-data; boundary=x',
        },
        payload: Buffer.from(''),
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toBe('chatId is required');
    } finally {
      await built.app.close();
    }
  });

  it('every route falls back to 401 when requireAuth throws an error without a statusCode', async () => {
    const { built, credential, registry } = await makeApp();
    (registry as unknown as { getAccount: () => never }).getAccount = () => {
      throw new Error('registry backing store exploded');
    };
    try {
      const mp = multipart('shot.png', 'image/png', PNG);
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats/c1/attachment',
        headers: { authorization: `Bearer ${credential}`, ...mp.headers },
        payload: mp.payload,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });

  it('ignores a patch.attachment.store_response frame with an unmatched requestId', async () => {
    const { built, daemonLink } = await makeApp();
    try {
      daemonLink.emit({
        type: 'patch.attachment.store_response',
        requestId: 'no-such-request-id',
        ok: true,
        path: '/nowhere',
      });
      const res = await built.app.inject({ method: 'GET', url: '/api/healthz' });
      expect(res.statusCode).toBe(200);
    } finally {
      await built.app.close();
    }
  });

  it('host store failure defaults code/message to internal when `error` itself is omitted', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(13));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    const daemonLink = new InProcessDaemonLink();
    const origSend = daemonLink.send.bind(daemonLink);
    daemonLink.send = (surfaceId: string, event: WireEvent): void => {
      origSend(surfaceId, event);
      if (event.type === 'patch.attachment.store_request') {
        daemonLink.emit({
          type: 'patch.attachment.store_response',
          requestId: event.requestId,
          ok: false,
          // `error` omitted entirely.
        });
      }
    };
    const built = await buildAll({ logger: false, registry, daemonLink });
    daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '/tmp/chat' });
    const credential = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-web-1',
      surfaceKind: 'web',
      label: 'browser',
    });
    try {
      const mp = multipart('shot.png', 'image/png', PNG);
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats/c1/attachment',
        headers: { authorization: `Bearer ${credential}`, ...mp.headers },
        payload: mp.payload,
      });
      expect(res.statusCode).toBe(502);
      const body = res.json() as { error: string; message: string };
      expect(body.error).toBe('internal');
      expect(body.message).toBe('attachment store failed');
    } finally {
      await built.app.close();
    }
  });

  it('host store failure maps chat_not_found to 404 (distinct from the generic 502)', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(13));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    const daemonLink = new InProcessDaemonLink();
    const origSend = daemonLink.send.bind(daemonLink);
    daemonLink.send = (surfaceId: string, event: WireEvent): void => {
      origSend(surfaceId, event);
      if (event.type === 'patch.attachment.store_request') {
        daemonLink.emit({
          type: 'patch.attachment.store_response',
          requestId: event.requestId,
          ok: false,
          error: { code: 'chat_not_found', message: 'chat vanished mid-upload' },
        });
      }
    };
    const built = await buildAll({ logger: false, registry, daemonLink });
    daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '/tmp/chat' });
    const credential = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-web-1',
      surfaceKind: 'web',
      label: 'browser',
    });
    try {
      const mp = multipart('shot.png', 'image/png', PNG);
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/chats/c1/attachment',
        headers: { authorization: `Bearer ${credential}`, ...mp.headers },
        payload: mp.payload,
      });
      expect(res.statusCode).toBe(404);
      expect((res.json() as { error: string }).error).toBe('chat_not_found');
    } finally {
      await built.app.close();
    }
  });
});
