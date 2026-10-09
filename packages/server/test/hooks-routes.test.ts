// REST CRUD for /api/hooks* + POST /api/hooks/check (spec/20-hooks.md).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';

describe('hooks REST routes', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-hooks-rest-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function bootstrap() {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(21));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({
      surfaceId: 'srf-hooks',
      surfaceKind: 'terminal',
      label: 'cli',
      issuedAt: 1,
    });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-hooks',
      surfaceKind: 'terminal',
      label: 'cli',
    });
    const daemonLink = new InProcessDaemonLink();
    const built = await buildAll({ logger: false, registry, daemonLink });
    return { built, jwt, daemonLink };
  }

  function scriptHookBody(name = 'test') {
    return {
      name,
      when: 'user_message',
      kind: 'script',
      script: { command: 'exit 0' },
    };
  }

  it('requires auth on every route', async () => {
    const { built } = await bootstrap();
    try {
      const res = await built.app.inject({ method: 'GET', url: '/api/hooks' });
      expect(res.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });

  it('creates, lists, gets, patches, enables/disables and deletes a hook', async () => {
    const { built, jwt } = await bootstrap();
    const auth = { authorization: `Bearer ${jwt}` };
    try {
      const create = await built.app.inject({
        method: 'POST',
        url: '/api/hooks',
        headers: auth,
        payload: scriptHookBody('block secrets'),
      });
      expect(create.statusCode).toBe(201);
      const hook = create.json();
      expect(hook.id).toMatch(/^hook_/);

      const list = await built.app.inject({ method: 'GET', url: '/api/hooks', headers: auth });
      expect(list.json().hooks).toHaveLength(1);

      const get = await built.app.inject({
        method: 'GET',
        url: `/api/hooks/${hook.id}`,
        headers: auth,
      });
      expect(get.statusCode).toBe(200);

      const patch = await built.app.inject({
        method: 'PATCH',
        url: `/api/hooks/${hook.id}`,
        headers: auth,
        payload: { name: 'renamed' },
      });
      expect(patch.json().name).toBe('renamed');

      const disable = await built.app.inject({
        method: 'POST',
        url: `/api/hooks/${hook.id}/disable`,
        headers: auth,
      });
      expect(disable.json().enabled).toBe(false);

      const enable = await built.app.inject({
        method: 'POST',
        url: `/api/hooks/${hook.id}/enable`,
        headers: auth,
      });
      expect(enable.json().enabled).toBe(true);

      const del = await built.app.inject({
        method: 'DELETE',
        url: `/api/hooks/${hook.id}`,
        headers: auth,
      });
      expect(del.statusCode).toBe(204);

      const missing = await built.app.inject({
        method: 'GET',
        url: `/api/hooks/${hook.id}`,
        headers: auth,
      });
      expect(missing.statusCode).toBe(404);
    } finally {
      await built.app.close();
    }
  });

  it('rejects a script hook with no command', async () => {
    const { built, jwt } = await bootstrap();
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/hooks',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { name: 'bad', when: 'user_message', kind: 'script' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/hooks/check returns pass with no results for an unknown chat', async () => {
    const { built, jwt } = await bootstrap();
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/hooks/check',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { chatId: 'no-such-chat', message: 'hi' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ decision: 'pass', results: [] });
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/hooks/check dispatches to the chat host and aggregates a block', async () => {
    const { built, jwt, daemonLink } = await bootstrap();
    const auth = { authorization: `Bearer ${jwt}` };
    try {
      built.chatRegistry.observe({
        type: 'chat.spawned',
        daemonId: 'd1',
        chatId: 'c_real',
        folder: '/home/tom/projects/bus',
      });
      await built.app.inject({
        method: 'POST',
        url: '/api/hooks',
        headers: auth,
        payload: scriptHookBody('no secrets'),
      });

      // `sendTo` (server → host) only records into `.sent` — it does not loop
      // back through `onEvent` (host → server) — so the request and its reply
      // have to be driven from the test as two separate steps, not a handler.
      const resPromise = built.app.inject({
        method: 'POST',
        url: '/api/hooks/check',
        headers: auth,
        payload: { chatId: 'c_real', message: 'my password is hunter2' },
      });
      const deadline = Date.now() + 2000;
      // The host is also greeted with the shared settings (spec/01 § Settings),
      // so look only at the hook check.
      const hookChecks = (): typeof daemonLink.sent =>
        daemonLink.sent.filter((x) => (x.event as { type: string }).type === 'hook.check_request');
      while (hookChecks().length === 0) {
        if (Date.now() > deadline) throw new Error('timed out waiting for hook.check_request');
        await new Promise((r) => setTimeout(r, 1));
      }
      const req = hookChecks()[0]?.event as { type: string; requestId: string; hookId: string };
      expect(req.type).toBe('hook.check_request');
      daemonLink.emit({
        type: 'hook.check_result',
        requestId: req.requestId,
        hookId: req.hookId,
        status: 'ok',
        decision: 'block',
        analysis: 'looks like a password',
        durationMs: 5,
      });

      const res = await resPromise;
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.decision).toBe('block');
      expect(body.results).toHaveLength(1);
      expect(body.results[0].analysis).toBe('looks like a password');
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/hooks/check forwards images to a prompt hook only, and rejects a bad type', async () => {
    const { built, jwt, daemonLink } = await bootstrap();
    const auth = { authorization: `Bearer ${jwt}` };
    try {
      built.chatRegistry.observe({
        type: 'chat.spawned',
        daemonId: 'd1',
        chatId: 'c_img',
        folder: '/home/tom/projects/bus',
      });
      for (const body of [
        scriptHookBody('script one'),
        {
          name: 'prompt one',
          when: 'user_message',
          kind: 'prompt',
          prompt: { instructions: 'Is it clear?', model: 'claude-haiku-4-5-20251001' },
        },
      ]) {
        const r = await built.app.inject({
          method: 'POST',
          url: '/api/hooks',
          headers: auth,
          payload: body,
        });
        expect(r.statusCode).toBe(201);
      }
      const images = [{ mediaType: 'image/png', data: 'aGVsbG8=' }];
      void built.app.inject({
        method: 'POST',
        url: '/api/hooks/check',
        headers: auth,
        payload: { chatId: 'c_img', message: 'see screenshot', images },
      });
      const deadline = Date.now() + 2000;
      const hookChecks = (): typeof daemonLink.sent =>
        daemonLink.sent.filter((x) => (x.event as { type: string }).type === 'hook.check_request');
      while (hookChecks().length < 2) {
        if (Date.now() > deadline) throw new Error('timed out waiting for hook.check_request');
        await new Promise((r) => setTimeout(r, 1));
      }
      const reqs = hookChecks().map(
        (x) => x.event as { kind: string; context: { images?: unknown } },
      );
      expect(reqs.find((r) => r.kind === 'prompt')?.context.images).toEqual(images);
      expect(reqs.find((r) => r.kind === 'script')?.context.images).toBeUndefined();

      const bad = await built.app.inject({
        method: 'POST',
        url: '/api/hooks/check',
        headers: auth,
        payload: {
          chatId: 'c_img',
          message: 'x',
          images: [{ mediaType: 'image/bmp', data: 'aGVsbG8=' }],
        },
      });
      expect(bad.statusCode).toBe(400);
    } finally {
      await built.app.close();
    }
  });
});
