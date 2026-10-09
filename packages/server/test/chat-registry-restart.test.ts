// A server restart must not forget archived chats (Todoist 6hhpQ793JmH8RhxF):
// the registry is rebuilt from what hosts re-announce, and an archived job
// chat is not in that roster while its host is away. The saved mirror keeps
// each chat's owner so exact lookup, the archived list and history still work.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';

const CHAT = 'jobchat-j_01TEST-abc';

describe('chat registry across a server restart', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-chat-dir-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function boot() {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(21));
    const registry = Registry.load(dir);
    try {
      registry.bootstrapAccount({ keypair: user });
    } catch (e) {
      if ((e as Error).name !== 'AccountConflictError') throw e; // the restart: already there
    }
    registry.upsertSurface({
      surfaceId: 'srf-dir',
      surfaceKind: 'terminal',
      label: 'cli',
      issuedAt: 1,
    });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-dir',
      surfaceKind: 'terminal',
      label: 'cli',
    });
    registry.setDaemonKey({ daemonId: 'd1', publicKey: user.publicKey, issuedAt: 1 });
    const daemonLink = new InProcessDaemonLink();
    const built = await buildAll({ logger: false, registry, daemonLink });
    return { built, daemonLink, jwt };
  }

  it('get, archived list and history work after a restart with the host still away', async () => {
    const first = await boot();
    first.daemonLink.emit({
      type: 'chat.spawned',
      daemonId: 'd1',
      chatId: CHAT,
      folder: '/work/j',
    });
    first.daemonLink.emit({
      type: 'chat.state',
      permissionMode: 'bypassPermissions',
      chatId: CHAT,
      daemonId: 'd1',
      activity: 'idle',
      lastUpdated: 5,
      status: 'archived',
      pinned: false,
      folder: '/work/j',
    });
    await first.built.app.close(); // flushes the saved mirror

    const { built, daemonLink, jwt } = await boot();
    try {
      // d1 has NOT re-announced: no chat.spawned, no folders.list.
      const headers = { authorization: `Bearer ${jwt}` };
      const get = await built.app.inject({ method: 'GET', url: `/api/chats/${CHAT}`, headers });
      expect(get.statusCode).toBe(200);
      expect(get.json()).toMatchObject({ chatId: CHAT, daemonId: 'd1', status: 'archived' });

      const list = await built.app.inject({
        method: 'GET',
        url: '/api/chats?archived=only',
        headers,
      });
      expect((list.json() as { chats: { chatId: string }[] }).chats.map((c) => c.chatId)).toEqual([
        CHAT,
      ]);
      const active = await built.app.inject({ method: 'GET', url: '/api/chats', headers });
      expect((active.json() as { chats: unknown[] }).chats).toHaveLength(0);

      const originalSend = daemonLink.send.bind(daemonLink);
      daemonLink.send = (surfaceId, event) => {
        originalSend(surfaceId, event);
        if (event.type === 'patch.chat_history.request') {
          setImmediate(() =>
            daemonLink.emit({
              type: 'patch.chat_history.response',
              requestId: event.requestId,
              ok: true,
              events: [{ type: 'chat.message', chatId: CHAT, role: 'user', content: 'hi', seq: 0 }],
            }),
          );
        }
      };
      const hist = await built.app.inject({
        method: 'GET',
        url: `/api/chats/${CHAT}/history`,
        headers,
      });
      expect(hist.statusCode).toBe(200);
      expect((hist.json() as { events: { content: string }[] }).events[0]?.content).toBe('hi');
    } finally {
      await built.app.close();
    }
  });

  it('a corrupt directory file is read as empty and does not stop the server', async () => {
    writeFileSync(join(dir, 'chat-directory.json'), '{not json');
    const { built, jwt } = await boot();
    try {
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/chats?archived=only',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { chats: unknown[] }).chats).toHaveLength(0);
    } finally {
      await built.app.close();
    }
  });
});
