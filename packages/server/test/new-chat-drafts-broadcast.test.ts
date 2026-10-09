// Server-owned NEW-CHAT drafts, end to end (spec/14 § New chat drafts) — modelled on composer-drafts-broadcast.
// (original header:) composer drafts (spec/14 § Composer, spec/15 §
// Composer): a surface's `composer_draft.set`/`clear` writes straight to the
// server's store (never the host — a chat's host can be asleep) and the
// change fans out to EVERY connected surface, including a cold-start snapshot
// for one that connects after the draft already exists.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { generateUserKeypair, mintSurfaceCredential, type UserKeypair } from '@patch/auth';
import { WireTestClient } from '@patch/wire/test-client';
import { buildAll, type BuiltApp } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';

interface TestCtx {
  dir: string;
  user: UserKeypair;
  registry: Registry;
  daemonLink: InProcessDaemonLink;
  built: BuiltApp;
  url: string;
  clientFor: (surfaceId: string) => Promise<WireTestClient>;
  restJwt: () => Promise<string>;
}

async function setUp(): Promise<TestCtx> {
  const dir = mkdtempSync(join(tmpdir(), 'patch-new-chat-drafts-e2e-'));
  const user = generateUserKeypair(() => new Uint8Array(32).fill(31));
  const registry = Registry.load(dir);
  registry.bootstrapAccount({ keypair: user });
  registry.upsertSurface({ surfaceId: 'srf-a', surfaceKind: 'web', label: 'a', issuedAt: 1 });
  registry.upsertSurface({ surfaceId: 'srf-b', surfaceKind: 'web', label: 'b', issuedAt: 1 });
  registry.upsertSurface({ surfaceId: 'srf-c', surfaceKind: 'mobile', label: 'c', issuedAt: 1 });
  registry.upsertSurface({
    surfaceId: 'srf-rest',
    surfaceKind: 'terminal',
    label: 'cli',
    issuedAt: 1,
  });
  registry.setDaemonKey({ daemonId: 'd1', publicKey: user.publicKey, issuedAt: 1 });
  const daemonLink = new InProcessDaemonLink();
  const built = await buildAll({ logger: false, registry, daemonLink });
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = built.app.server.address() as AddressInfo;
  const url = `ws://127.0.0.1:${addr.port}/ws`;

  async function clientFor(surfaceId: string): Promise<WireTestClient> {
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId,
      surfaceKind: surfaceId === 'srf-c' ? 'mobile' : 'web',
      label: surfaceId,
    });
    const client = new WireTestClient({ url, auth: jwt });
    const online = client.waitFor('auth.ok');
    await client.connect();
    await online;
    return client;
  }

  async function restJwt(): Promise<string> {
    return mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-rest',
      surfaceKind: 'terminal',
      label: 'cli',
    });
  }

  return { dir, user, registry, daemonLink, built, url, clientFor, restJwt };
}

async function cleanUp(ctx: TestCtx): Promise<void> {
  await ctx.built.app.close();
  rmSync(ctx.dir, { recursive: true, force: true });
}

describe('new-chat drafts — surface → server → every other surface', () => {
  const draft = {
    id: 'draft-1',
    folder: '/home/x/proj',
    daemonId: 'd1',
    text: 'check latest photo',
    model: 'm1',
  };

  it('a set reaches another surface, a late joiner gets it in the list, and a remove clears it everywhere', async () => {
    const ctx = await setUp();
    try {
      const a = await ctx.clientFor('srf-a');
      const b = await ctx.clientFor('srf-b');
      try {
        const gotOnB = b.waitFor('new_chat_draft.updated');
        a.send({ type: 'new_chat_draft.set', draft });
        expect(await gotOnB).toMatchObject({ type: 'new_chat_draft.updated', draft });

        const jwtC = await mintSurfaceCredential({
          userPrivateKey: ctx.user.privateKey,
          surfaceId: 'srf-c',
          surfaceKind: 'mobile',
          label: 'srf-c',
        });
        const c = new WireTestClient({ url: ctx.url, auth: jwtC });
        const listPromise = c.waitFor('new_chat_draft.list');
        await c.connect();
        try {
          expect(await listPromise).toEqual({
            type: 'new_chat_draft.list',
            drafts: [{ ...draft, updatedAt: expect.any(Number) }],
          });
          const gone = c.waitFor('new_chat_draft.removed');
          b.send({ type: 'new_chat_draft.remove', id: 'draft-1' });
          expect(await gone).toMatchObject({ type: 'new_chat_draft.removed', id: 'draft-1' });
        } finally {
          await c.close();
        }
      } finally {
        await a.close();
        await b.close();
      }
    } finally {
      await cleanUp(ctx);
    }
  });

  it('whitespace-only text broadcasts a removal, not an update', async () => {
    const ctx = await setUp();
    try {
      const a = await ctx.clientFor('srf-a');
      const b = await ctx.clientFor('srf-b');
      try {
        a.send({ type: 'new_chat_draft.set', draft });
        await b.waitFor('new_chat_draft.updated');
        const gone = b.waitFor('new_chat_draft.removed');
        a.send({ type: 'new_chat_draft.set', draft: { ...draft, text: '  ' } });
        expect(await gone).toMatchObject({ id: 'draft-1' });
      } finally {
        await a.close();
        await b.close();
      }
    } finally {
      await cleanUp(ctx);
    }
  });
});
