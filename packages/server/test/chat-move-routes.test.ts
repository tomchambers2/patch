// Moving a chat between hosts (spec/04 § Moving a chat to another host) — the
// server half: it drives export → import → retire across two machines, points
// its mirror at the new one, and stops loudly at whichever step fails. The
// host half is tested between two real hosts in
// packages/daemon/test/chat-move.test.ts.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import type { ChatMoveOp, WireEvent } from '@patch/wire';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';

type Req = Extract<WireEvent, { type: 'patch.chat_move.request' }>;
type Res = Extract<WireEvent, { type: 'patch.chat_move.response' }>;
type Answer = Pick<Res, 'ok'> & Partial<Pick<Res, 'bundle' | 'error'>>;

const BUNDLE = {
  chatId: 'c1',
  sourceFolder: '/Users/tom/Unite',
  files: [{ path: 'chat/meta.json', data: 'e30=' }],
  attachments: {},
};

/** Two machines, each answering move steps with whatever the test says. */
class FakeHosts extends InProcessDaemonLink {
  readonly steps: Array<{ daemonId: string; op: ChatMoveOp; event: Req }> = [];
  constructor(private readonly answer: (daemonId: string, e: Req) => Answer | null) {
    super();
    this.addOnlineHost('d2');
  }
  override sendTo(daemonId: string, surfaceId: string, event: WireEvent): void {
    super.sendTo(daemonId, surfaceId, event);
    if (event.type !== 'patch.chat_move.request') return;
    this.steps.push({ daemonId, op: event.op, event });
    const a = this.answer(daemonId, event);
    if (a === null) return;
    queueMicrotask(() =>
      this.emit(
        {
          type: 'patch.chat_move.response',
          requestId: event.requestId,
          daemonId,
          chatId: event.chatId,
          op: event.op,
          ...a,
        },
        daemonId,
      ),
    );
  }
}

const happy = (_d: string, e: Req): Answer =>
  e.op === 'export' ? { ok: true, bundle: BUNDLE } : { ok: true };

describe('POST /api/chats/:id/move', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-chat-move-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function boot(link: FakeHosts) {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(41));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({ surfaceId: 's1', surfaceKind: 'mobile', label: 'p', issuedAt: 1 });
    registry.setDaemonKey({ daemonId: 'd1', publicKey: user.publicKey, issuedAt: 1 });
    registry.setDaemonKey({ daemonId: 'd2', publicKey: user.publicKey, issuedAt: 1 });
    registry.setHostName('d1', 'Mac');
    registry.setHostName('d2', 'Hetzner');
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 's1',
      surfaceKind: 'mobile',
      label: 'p',
    });
    const built = await buildAll({ logger: false, registry, daemonLink: link });
    link.emit(
      { type: 'chat.spawned', chatId: 'c1', daemonId: 'd1', folder: '/Users/tom/Unite' },
      'd1',
    );
    const headers = { authorization: `Bearer ${jwt}` };
    const move = (body: unknown) =>
      built.app.inject({
        method: 'POST',
        url: '/api/chats/c1/move',
        headers,
        payload: body as object,
      });
    const host = async () => {
      const res = await built.app.inject({ method: 'GET', url: '/api/chats', headers });
      const chats = (
        res.json() as { chats: Array<{ chatId: string; daemonId: string; folder: string }> }
      ).chats;
      return chats.find((c) => c.chatId === 'c1');
    };
    return { built, move, host };
  }

  it('exports from the old host, imports on the new one with the bundle, retires the old copy', async () => {
    const link = new FakeHosts(happy);
    const { built, move, host } = await boot(link);
    try {
      const res = await move({ daemonId: 'd2', folder: '/home/tom/Unite' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        ok: true,
        chatId: 'c1',
        daemonId: 'd2',
        folder: '/home/tom/Unite',
      });
      expect(link.steps.map((s) => [s.daemonId, s.op])).toEqual([
        ['d1', 'export'],
        ['d2', 'import'],
        ['d1', 'retire'],
      ]);
      expect(link.steps[1]!.event).toMatchObject({ folder: '/home/tom/Unite', bundle: BUNDLE });
      expect(await host()).toMatchObject({ daemonId: 'd2', folder: '/home/tom/Unite' });
    } finally {
      await built.app.close();
    }
  });

  it('a busy chat is refused at export, with the host named, and stays put', async () => {
    const link = new FakeHosts((_d, e) =>
      e.op === 'export'
        ? { ok: false, error: { code: 'busy', message: 'this chat is mid-turn' } }
        : { ok: true },
    );
    const { built, move, host } = await boot(link);
    try {
      const res = await move({ daemonId: 'd2', folder: '/home/tom/Unite' });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'busy', message: 'Mac: this chat is mid-turn' });
      expect(link.steps.map((s) => s.op)).toEqual(['export']);
      expect((await host())?.daemonId).toBe('d1');
    } finally {
      await built.app.close();
    }
  });

  it('a failed import releases the chat on the old host and leaves it there', async () => {
    const link = new FakeHosts((_d, e) =>
      e.op === 'export'
        ? { ok: true, bundle: BUNDLE }
        : e.op === 'import'
          ? {
              ok: false,
              error: { code: 'folder_not_found', message: '/home/tom/Unite is not a folder' },
            }
          : { ok: true },
    );
    const { built, move, host } = await boot(link);
    try {
      const res = await move({ daemonId: 'd2', folder: '/home/tom/Unite' });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toBe('Hetzner: /home/tom/Unite is not a folder');
      expect(link.steps.map((s) => [s.daemonId, s.op])).toEqual([
        ['d1', 'export'],
        ['d2', 'import'],
        ['d1', 'release'],
      ]);
      expect((await host())?.daemonId).toBe('d1');
    } finally {
      await built.app.close();
    }
  });

  it('a retire that fails still counts as moved, and says the old copy is still there', async () => {
    const link = new FakeHosts((_d, e) =>
      e.op === 'retire'
        ? { ok: false, error: { code: 'internal', message: 'EACCES' } }
        : happy(_d, e),
    );
    const { built, move, host } = await boot(link);
    try {
      const res = await move({ daemonId: 'd2', folder: '/home/tom/Unite' });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toMatchObject({ error: 'retire_failed', daemonId: 'd2' });
      expect(res.json().message).toContain('Moved to Hetzner, but Mac kept its copy');
      expect((await host())?.daemonId).toBe('d2');
    } finally {
      await built.app.close();
    }
  });

  it('refuses a move to the host it is already on, an offline host, or no folder', async () => {
    const link = new FakeHosts(happy);
    const { built, move } = await boot(link);
    try {
      expect((await move({ daemonId: 'd1', folder: '/x' })).json().error).toBe('same_host');
      expect((await move({ daemonId: 'd2' })).json().error).toBe('folder_required');
      expect((await move({ daemonId: 'd2', folder: 'relative/path' })).statusCode).toBe(400);
      expect((await move({ daemonId: 'nope', folder: '/x' })).statusCode).toBe(404);
      link.forget('d2');
      const off = await move({ daemonId: 'd2', folder: '/x' });
      expect(off.statusCode).toBe(503);
      expect(off.json().message).toBe('Hetzner is offline');
      expect(link.steps).toEqual([]);
    } finally {
      await built.app.close();
    }
  });
});
