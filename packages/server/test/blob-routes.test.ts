// Serving one blob's bytes (spec/04 § History — blobs).
//
// The server's half is a gate and a relay: check the sha's shape, find which
// machine owns the chat, refuse one that is offline, round-trip exactly one
// `patch.blob.request` to THAT machine, and turn its answer (or its silence)
// into an HTTP status with the right caching. The host half — what is
// actually on disk — is covered in packages/daemon/test/chat-log.test.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair } from '@patch/auth';
import type { WireEvent } from '@patch/wire';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';
import { BLOB_TIMEOUT_MS } from '../src/blob-routes.js';

type Req = Extract<WireEvent, { type: 'patch.blob.request' }>;
type Res = Extract<WireEvent, { type: 'patch.blob.response' }>;

const SHA = 'a'.repeat(64);
const PAYLOAD = Buffer.from('tool output nobody has opened yet');

/** A host link whose machine answers blob requests with `respond`. */
class FakeBlobDaemon extends InProcessDaemonLink {
  readonly asked: Req[] = [];
  constructor(
    private readonly respond: (event: Req) => Omit<Res, 'type' | 'requestId' | 'daemonId'> | null,
    private readonly answerAs?: string,
  ) {
    super();
  }
  override sendTo(daemonId: string, surfaceId: string, event: WireEvent): void {
    super.sendTo(daemonId, surfaceId, event);
    if (event.type !== 'patch.blob.request') return;
    this.asked.push(event);
    const r = this.respond(event);
    if (r === null) return; // never answers
    const from = this.answerAs ?? daemonId;
    this.emit(
      { type: 'patch.blob.response', requestId: event.requestId, daemonId: from, ...r },
      from,
    );
  }
}

describe('blob routes', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-blob-routes-'));
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  async function boot(link: InProcessDaemonLink, opts: { withChat?: boolean } = {}) {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(33));
    // A registry per boot: a test that boots twice must not inherit the first
    // account, which `Registry.load` would refuse as a conflict.
    const registry = Registry.load(mkdtempSync(join(dir, 'reg-')));
    registry.bootstrapAccount({ keypair: user });
    registry.setDaemonKey({ daemonId: 'd1', publicKey: user.publicKey, issuedAt: 1 });
    const built = await buildAll({ logger: false, registry, daemonLink: link });
    if (opts.withChat !== false) {
      link.emit({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '/tmp/chat' });
    }
    return built;
  }

  it('serves the bytes with their own type, cached forever because the sha is the content', async () => {
    const link = new FakeBlobDaemon(() => ({
      ok: true,
      mime: 'image/png',
      data: PAYLOAD.toString('base64'),
    }));
    const built = await boot(link);
    const res = await built.app.inject({ method: 'GET', url: `/api/chats/c1/blob/${SHA}` });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(res.rawPayload.equals(PAYLOAD)).toBe(true);
    // Addressed to the machine that owns the chat, carrying the chat it is for.
    expect(link.asked).toHaveLength(1);
    expect(link.asked[0]!.sha).toBe(SHA);
    expect(link.asked[0]!.chatId).toBe('c1');
    expect(link.asked[0]!.daemonId).toBe('d1');
  });

  it('needs no credential, because an <img> cannot send one', async () => {
    // Mirrors the attachment and artifact serve-backs: the id is a content
    // hash, and a browser fetching a picture attaches no bearer header.
    const link = new FakeBlobDaemon(() => ({ ok: true, mime: 'image/png', data: 'AA==' }));
    const built = await boot(link);
    const res = await built.app.inject({ method: 'GET', url: `/api/chats/c1/blob/${SHA}` });
    expect(res.statusCode).toBe(200);
  });

  it('rejects a sha that is not a content hash before touching anything', async () => {
    const link = new FakeBlobDaemon(() => ({ ok: true, data: 'AA==' }));
    const built = await boot(link);
    for (const bad of ['../../etc/passwd', 'zz', 'A'.repeat(64), `${SHA}x`]) {
      const res = await built.app.inject({
        method: 'GET',
        url: `/api/chats/c1/blob/${encodeURIComponent(bad)}`,
      });
      expect(res.statusCode).toBe(400);
    }
    expect(link.asked).toHaveLength(0);
  });

  it('404s a chat this account does not have, without asking any host', async () => {
    const link = new FakeBlobDaemon(() => ({ ok: true, data: 'AA==' }));
    const built = await boot(link, { withChat: false });
    const res = await built.app.inject({ method: 'GET', url: `/api/chats/c1/blob/${SHA}` });
    expect(res.statusCode).toBe(404);
    expect(link.asked).toHaveLength(0);
  });

  it('keeps the host’s own refusal: a missing blob is a 404, never an empty body', async () => {
    const link = new FakeBlobDaemon(() => ({
      ok: false,
      error: { code: 'not_found' as const, message: 'no blob on this host' },
    }));
    const built = await boot(link);
    const res = await built.app.inject({ method: 'GET', url: `/api/chats/c1/blob/${SHA}` });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'not_found' });
  });

  it('maps too_large to 413 and an internal failure to 502', async () => {
    for (const [code, status] of [
      ['too_large', 413],
      ['internal', 502],
    ] as const) {
      const link = new FakeBlobDaemon(() => ({ ok: false, error: { code, message: code } }));
      const built = await boot(link);
      const res = await built.app.inject({ method: 'GET', url: `/api/chats/c1/blob/${SHA}` });
      expect(res.statusCode).toBe(status);
    }
  });

  it('refuses an offline host up front rather than waiting for a timeout', async () => {
    const link = new FakeBlobDaemon(() => ({ ok: true, data: 'AA==' }));
    const built = await boot(link);
    link.setStatus('offline');
    const res = await built.app.inject({ method: 'GET', url: `/api/chats/c1/blob/${SHA}` });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'host_offline' });
    expect(link.asked).toHaveLength(0);
  });

  it('a host that never answers is a 504, not a hung request', async () => {
    vi.useFakeTimers();
    const link = new FakeBlobDaemon(() => null);
    const built = await boot(link);
    const pending = built.app.inject({ method: 'GET', url: `/api/chats/c1/blob/${SHA}` });
    await vi.advanceTimersByTimeAsync(BLOB_TIMEOUT_MS + 1);
    const res = await pending;
    expect(res.statusCode).toBe(504);
    expect(res.json()).toMatchObject({ error: 'host_timeout' });
  });

  it('ignores an answer from a machine that was not asked', async () => {
    vi.useFakeTimers();
    const link = new FakeBlobDaemon(() => ({ ok: true, data: 'AA==' }), 'someone-else');
    const built = await boot(link);
    const pending = built.app.inject({ method: 'GET', url: `/api/chats/c1/blob/${SHA}` });
    await vi.advanceTimersByTimeAsync(BLOB_TIMEOUT_MS + 1);
    const res = await pending;
    expect(res.statusCode).toBe(504);
  });

  it('serves a big result the server kept itself, with the host offline and never asked', async () => {
    const link = new FakeBlobDaemon(() => null);
    const built = await boot(link);
    try {
      const body = [{ type: 'text', text: 'y'.repeat(9_000) }];
      link.emit({
        type: 'chat.tool_result',
        chatId: 'c1',
        callId: 'k1',
        tool: 'Bash',
        result: body,
        seq: 1,
      } as WireEvent);
      const held = built.chatLogStore.read('c1', -1)[0] as { result: { $blob: string } };
      link.setStatus('offline'); // the host goes away

      const res = await built.app.inject({
        method: 'GET',
        url: `/api/chats/c1/blob/${held.result.$blob}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toContain('immutable');
      expect(JSON.parse(res.body)).toEqual(body);
      expect(link.asked).toEqual([]);
    } finally {
      await built.app.close();
    }
  });

  it('still asks the host for a blob the server does not hold', async () => {
    const link = new FakeBlobDaemon(() => ({
      ok: true,
      data: PAYLOAD.toString('base64'),
      mime: 'text/plain',
    }));
    const built = await boot(link);
    try {
      const res = await built.app.inject({ method: 'GET', url: `/api/chats/c1/blob/${SHA}` });
      expect(res.statusCode).toBe(200);
      expect(link.asked).toHaveLength(1);
    } finally {
      await built.app.close();
    }
  });
});
