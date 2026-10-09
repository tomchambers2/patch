// Host files REST (spec/03 § Host files).
//
// The server's half is a gate and a relay: authenticate the surface, refuse a
// machine that is not registered or not online, round-trip exactly one
// `patch.host_files.request` to THAT machine, and turn its answer (or its
// silence) into an HTTP status. The host half is tested against real files in
// packages/daemon/test/hostFiles.test.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import type { WireEvent } from '@patch/wire';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';
import { HOST_FILES_TIMEOUT_MS } from '../src/host-files-routes.js';

type Req = Extract<WireEvent, { type: 'patch.host_files.request' }>;
type Res = Extract<WireEvent, { type: 'patch.host_files.response' }>;

/** A host link whose machine answers host-files requests with `respond`. */
class FakeHostDaemon extends InProcessDaemonLink {
  readonly asked: Array<{ daemonId?: string; event: Req }> = [];
  constructor(
    private readonly respond: (event: Req) => Omit<Res, 'type' | 'requestId' | 'daemonId'> | null,
    private readonly answerAs?: string,
  ) {
    super();
  }
  override sendTo(daemonId: string, surfaceId: string, event: WireEvent): void {
    super.sendTo(daemonId, surfaceId, event);
    if (event.type !== 'patch.host_files.request') return;
    this.asked.push({ daemonId, event });
    const r = this.respond(event);
    if (r === null) return; // never answers
    const from = this.answerAs ?? daemonId;
    this.emit(
      { type: 'patch.host_files.response', requestId: event.requestId, daemonId: from, ...r },
      from,
    );
  }
}

describe('host files routes', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-host-files-'));
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  async function boot(link: InProcessDaemonLink) {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(33));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({
      surfaceId: 'srf-phone',
      surfaceKind: 'mobile',
      label: 'phone',
      issuedAt: 1,
    });
    registry.setDaemonKey({ daemonId: 'd1', publicKey: user.publicKey, issuedAt: 1 });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-phone',
      surfaceKind: 'mobile',
      label: 'phone',
    });
    const built = await buildAll({ logger: false, registry, daemonLink: link });
    const auth = { authorization: `Bearer ${jwt}` };
    return { built, auth, registry };
  }

  it('lists the home directory when no path is given, addressed to the named machine', async () => {
    const link = new FakeHostDaemon(() => ({
      ok: true,
      path: '/home/tom',
      parent: '/home',
      entries: [{ name: '.claude', type: 'dir' }],
    }));
    const { built, auth } = await boot(link);
    try {
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/hosts/d1/files',
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        path: '/home/tom',
        parent: '/home',
        entries: [{ name: '.claude', type: 'dir' }],
      });
      expect(link.asked).toHaveLength(1);
      expect(link.asked[0]!.daemonId).toBe('d1');
      expect(link.asked[0]!.event).toMatchObject({ op: 'list', daemonId: 'd1' });
      expect(link.asked[0]!.event.path).toBeUndefined();
    } finally {
      await built.app.close();
    }
  });

  it('lists a named directory', async () => {
    const link = new FakeHostDaemon((e) => ({ ok: true, path: e.path, parent: '/', entries: [] }));
    const { built, auth } = await boot(link);
    try {
      const res = await built.app.inject({
        method: 'GET',
        url: `/api/hosts/d1/files?path=${encodeURIComponent('/etc')}`,
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(link.asked[0]!.event).toMatchObject({ op: 'list', path: '/etc' });
    } finally {
      await built.app.close();
    }
  });

  it('reads a file with its version', async () => {
    const link = new FakeHostDaemon((e) => ({
      ok: true,
      path: e.path,
      content: '# skill\n',
      size: 8,
      version: 'v1',
    }));
    const { built, auth } = await boot(link);
    try {
      const res = await built.app.inject({
        method: 'GET',
        url: `/api/hosts/d1/files/content?path=${encodeURIComponent('/home/tom/SKILL.md')}`,
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        path: '/home/tom/SKILL.md',
        content: '# skill\n',
        size: 8,
        version: 'v1',
      });
      expect(link.asked[0]!.event).toMatchObject({ op: 'read', path: '/home/tom/SKILL.md' });
    } finally {
      await built.app.close();
    }
  });

  it('saves with the base version it was opened at', async () => {
    const link = new FakeHostDaemon((e) => ({ ok: true, path: e.path, size: 3, version: 'v2' }));
    const { built, auth } = await boot(link);
    try {
      const res = await built.app.inject({
        method: 'PUT',
        url: '/api/hosts/d1/files/content',
        headers: auth,
        payload: { path: '/home/tom/a.md', content: 'new', baseVersion: 'v1' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ path: '/home/tom/a.md', size: 3, version: 'v2' });
      expect(link.asked[0]!.event).toMatchObject({
        op: 'write',
        path: '/home/tom/a.md',
        content: 'new',
        baseVersion: 'v1',
      });
    } finally {
      await built.app.close();
    }
  });

  it('accepts a save as large as the editor allows (past the server-wide 1 MiB body limit)', async () => {
    const link = new FakeHostDaemon((e) => ({ ok: true, path: e.path, size: 1, version: 'v2' }));
    const { built, auth } = await boot(link);
    try {
      const content = '"\\'.repeat(512 * 1024); // 1 MiB that JSON-escapes to 2 MiB
      const res = await built.app.inject({
        method: 'PUT',
        url: '/api/hosts/d1/files/content',
        headers: auth,
        payload: { path: '/home/tom/a.md', content, baseVersion: 'v1' },
      });
      expect(res.statusCode).toBe(200);
      expect(link.asked[0]!.event.content).toBe(content);
    } finally {
      await built.app.close();
    }
  });

  it('maps each host refusal to its own status', async () => {
    const cases: Array<[NonNullable<Res['error']>['code'], number]> = [
      ['conflict', 409],
      ['not_found', 404],
      ['path_invalid', 400],
      ['not_a_file', 400],
      ['not_a_directory', 400],
      ['too_large', 413],
      ['binary', 415],
      ['permission_denied', 403],
      ['internal', 502],
    ];
    for (const [code, status] of cases) {
      const link = new FakeHostDaemon(() => ({ ok: false, error: { code, message: `m-${code}` } }));
      const { built, auth } = await boot(link);
      try {
        const res = await built.app.inject({
          method: 'PUT',
          url: '/api/hosts/d1/files/content',
          headers: auth,
          payload: { path: '/x', content: 'y', baseVersion: 'v' },
        });
        expect(res.statusCode, code).toBe(status);
        expect(res.json()).toEqual({ error: code, message: `m-${code}` });
      } finally {
        await built.app.close();
      }
      rmSync(dir, { recursive: true, force: true });
      dir = mkdtempSync(join(tmpdir(), 'patch-host-files-'));
    }
  });

  it('requires a surface credential — before it says anything about the body', async () => {
    const link = new FakeHostDaemon(() => ({ ok: true }));
    const { built } = await boot(link);
    try {
      for (const [method, url] of [
        ['GET', '/api/hosts/d1/files'],
        ['GET', '/api/hosts/d1/files/content?path=/x'],
        ['PUT', '/api/hosts/d1/files/content'],
      ] as const) {
        const res = await built.app.inject({
          method,
          url,
          payload: method === 'PUT' ? {} : undefined,
        });
        expect(res.statusCode, url).toBe(401);
      }
      expect(link.asked).toHaveLength(0);
    } finally {
      await built.app.close();
    }
  });

  it('refuses an unregistered machine by name, never falling through to the attached one', async () => {
    const link = new FakeHostDaemon(() => ({ ok: true, entries: [] }));
    const { built, auth } = await boot(link);
    try {
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/hosts/stranger/files',
        headers: auth,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: 'unknown_host', daemonId: 'stranger' });
      expect(link.asked).toHaveLength(0);
    } finally {
      await built.app.close();
    }
  });

  it('refuses an offline machine up front rather than waiting out a timeout', async () => {
    const link = new FakeHostDaemon(() => ({ ok: true, entries: [] }));
    link.setStatus('offline');
    const { built, auth } = await boot(link);
    try {
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/hosts/d1/files',
        headers: auth,
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ error: 'host_offline', daemonId: 'd1' });
      expect(link.asked).toHaveLength(0);
    } finally {
      await built.app.close();
    }
  });

  it('rejects a malformed body or a missing path as 400 without asking the machine', async () => {
    const link = new FakeHostDaemon(() => ({ ok: true }));
    const { built, auth } = await boot(link);
    try {
      for (const payload of [
        { path: '/x', content: 'y' },
        { path: '/x', baseVersion: 'v' },
        { content: 'y', baseVersion: 'v' },
        { path: '', content: 'y', baseVersion: 'v' },
        { path: '/x', content: 1, baseVersion: 'v' },
      ]) {
        const res = await built.app.inject({
          method: 'PUT',
          url: '/api/hosts/d1/files/content',
          headers: auth,
          payload,
        });
        expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      }
      const read = await built.app.inject({
        method: 'GET',
        url: '/api/hosts/d1/files/content',
        headers: auth,
      });
      expect(read.statusCode).toBe(400);
      expect(link.asked).toHaveLength(0);
    } finally {
      await built.app.close();
    }
  });

  it('a machine that never answers is a 504', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const link = new FakeHostDaemon(() => null);
    const { built, auth } = await boot(link);
    try {
      const pending = built.app.inject({
        method: 'GET',
        url: '/api/hosts/d1/files',
        headers: auth,
      });
      await vi.waitFor(() => expect(link.asked).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(HOST_FILES_TIMEOUT_MS + 1);
      const res = await pending;
      expect(res.statusCode).toBe(504);
    } finally {
      vi.useRealTimers();
      await built.app.close();
    }
  });

  it('ignores an answer from a machine that was not asked', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const link = new FakeHostDaemon(() => ({ ok: true, entries: [] }), 'd2');
    const { built, auth } = await boot(link);
    try {
      const pending = built.app.inject({
        method: 'GET',
        url: '/api/hosts/d1/files',
        headers: auth,
      });
      await vi.waitFor(() => expect(link.asked).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(HOST_FILES_TIMEOUT_MS + 1);
      expect((await pending).statusCode).toBe(504);
    } finally {
      vi.useRealTimers();
      await built.app.close();
    }
  });

  it('never relays a host-files response to connected surfaces', async () => {
    const link = new InProcessDaemonLink();
    const { built } = await boot(link);
    try {
      const sent: string[] = [];
      // @ts-expect-error — seeding a connected surface without a full handshake
      built.wsHub['surfaces'].set(
        'srf-phone',
        new Set([
          {
            socket: { send: (d: string) => sent.push(d), close: () => undefined },
            surfaceId: 'srf-phone',
            surfaceKind: 'mobile',
            watchedChats: new Set(),
          },
        ]),
      );
      link.emit({
        type: 'patch.host_files.response',
        requestId: 'orphan',
        daemonId: 'd1',
        ok: true,
        content: 'secret',
      });
      expect(sent.filter((d) => d.includes('patch.host_files.response'))).toEqual([]);
    } finally {
      await built.app.close();
    }
  });
});
