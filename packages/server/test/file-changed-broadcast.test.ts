// spec/14 § File browser — live updates: `patch.file_changed` (host →
// surfaces) is a DETAIL-level event — WsHub's `onDaemonEvent` fans it out only
// to connections that have `chat.focus_change`'d onto that chat, exactly like
// `chat.artifact` (see artifacts.test.ts's "sends the slim chat.artifact to a
// watching surface" test, which this mirrors). A surface that never focused
// the chat has no file browser open on it and gets nothing.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import { WireTestClient } from '@patch/wire/test-client';
import type { WireEvent } from '@patch/wire';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';

describe('patch.file_changed broadcast', () => {
  it('reaches a surface watching the chat, and never a surface that never focused it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'patch-filechanged-'));
    try {
      const user = generateUserKeypair(() => new Uint8Array(32).fill(11));
      const registry = Registry.load(dir);
      registry.bootstrapAccount({ keypair: user });
      registry.upsertSurface({
        surfaceId: 'srf-watch',
        surfaceKind: 'web',
        label: 'a',
        issuedAt: 1,
      });
      registry.upsertSurface({
        surfaceId: 'srf-idle',
        surfaceKind: 'web',
        label: 'b',
        issuedAt: 1,
      });
      const daemonLink = new InProcessDaemonLink();
      const built = await buildAll({ logger: false, registry, daemonLink });
      await built.app.listen({ port: 0, host: '127.0.0.1' });
      const addr = built.app.server.address() as AddressInfo;
      daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '/tmp/chat' });

      const jwtWatch = await mintSurfaceCredential({
        userPrivateKey: user.privateKey,
        surfaceId: 'srf-watch',
        surfaceKind: 'web',
        label: 'a',
      });
      const jwtIdle = await mintSurfaceCredential({
        userPrivateKey: user.privateKey,
        surfaceId: 'srf-idle',
        surfaceKind: 'web',
        label: 'b',
      });
      const watching = new WireTestClient({
        url: `ws://127.0.0.1:${addr.port}/ws`,
        auth: jwtWatch,
      });
      const idle = new WireTestClient({ url: `ws://127.0.0.1:${addr.port}/ws`, auth: jwtIdle });
      // The hub greets each surface with `daemon.online` as it connects, so the
      // waits must be listening before the connects — otherwise `watching`'s
      // greeting can land while `idle` is still connecting, and is missed.
      const watchingOnline = watching.waitFor('daemon.online');
      const idleOnline = idle.waitFor('daemon.online');
      await watching.connect();
      await idle.connect();
      await watchingOnline;
      await idleOnline;
      try {
        // Only `watching` ever asks to see this chat's detail events.
        watching.send({ type: 'chat.focus_change', chatId: 'c1' });
        await new Promise((r) => setTimeout(r, 50));

        const idleGot: WireEvent[] = [];
        idle.on('patch.file_changed', (e) => idleGot.push(e));

        daemonLink.emit({ type: 'patch.file_changed', chatId: 'c1', path: 'src/a.ts' });

        const got = await watching.waitFor('patch.file_changed');
        expect(got).toEqual({ type: 'patch.file_changed', chatId: 'c1', path: 'src/a.ts' });

        // Give the (non-)delivery to the idle surface time to have happened.
        await new Promise((r) => setTimeout(r, 50));
        expect(idleGot).toEqual([]);
      } finally {
        await watching.close();
        await idle.close();
      }
      await built.app.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
