// A cross-machine `patch_spawn` resolves on the TARGET machine's own answer
// (spec/03 § Cross-chat tools).
//
// The defect: `/internal/spawn` returned `{host, folder, created:'remote'}` the
// instant the `patch.spawn` frame left this machine. A target that refused the
// spawn — "has never read a model catalogue, so it has no last-used model" —
// created nothing, and the calling agent was told it had succeeded. Every case
// here asserts the tool call ends in the real outcome.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { buildControl, RemoteSpawnError } from '../src/control.js';
import { MemoryJobsStore } from '../src/jobs-interface.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';

const LOCAL_KEY = 'local-secret';
const AUTH = { authorization: `Bearer ${LOCAL_KEY}` };
const silent = pino({ level: 'silent' });

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'patch-xhost-'));
  const folder = mkdtempSync(join(tmpdir(), 'patch-xhost-folder-'));
  mkdirSync(folder, { recursive: true });
  const events: WireEvent[] = [];
  const daemon = new Daemon({
    daemonId: 'host-a',
    metaStore: createMetaStore(home),
    sdkBackend: createMockSdkBackend(),
    oauthAccessToken: 'x',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
  });
  return { daemon, jobs: new MemoryJobsStore({ now: () => 1_700_000_000_000 }), folder };
}

describe('/internal/spawn — cross-machine', () => {
  it('returns the chat the TARGET machine created, not a bare "remote"', async () => {
    const { daemon, jobs, folder } = setup();
    const calls: unknown[] = [];
    const app = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs,
      isHostOnline: () => true,
      spawnOnRemoteHost: async (req) => {
        calls.push(req);
        return { chatId: 'chat-on-b' };
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/spawn',
        headers: AUTH,
        payload: { folder, host: 'host-b', callerChatId: 'mgr', prompt: 'go' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        host: 'host-b',
        folder,
        created: 'remote',
        chatId: 'chat-on-b',
      });
      expect(calls[0]).toMatchObject({
        host: 'host-b',
        sourceChatId: 'mgr',
        folder,
        prompt: 'go',
      });
    } finally {
      await app.close();
    }
  });

  it('passes the named model through, and accepts an answer that names no chat', async () => {
    const { daemon, jobs, folder } = setup();
    const calls: Array<{ model?: string }> = [];
    const app = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs,
      isHostOnline: () => true,
      spawnOnRemoteHost: async (req) => {
        calls.push(req);
        return {};
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/spawn',
        headers: AUTH,
        payload: { folder, host: 'host-b', callerChatId: 'mgr', model: 'claude-opus-5' },
      });
      expect(res.statusCode).toBe(200);
      expect(calls[0]?.model).toBe('claude-opus-5');
      // No invented chatId: the answer said none, so the caller is told none.
      expect(res.json()).toEqual({ host: 'host-b', folder, created: 'remote' });
    } finally {
      await app.close();
    }
  });

  it('turns an unexpected relay failure into a 502, never a success', async () => {
    const { daemon, jobs, folder } = setup();
    const app = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs,
      isHostOnline: () => true,
      spawnOnRemoteHost: async () => {
        throw new Error('the link exploded');
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/spawn',
        headers: AUTH,
        payload: { folder, host: 'host-b', callerChatId: 'mgr' },
      });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toMatchObject({ error: 'sdk_error', message: 'the link exploded' });
    } finally {
      await app.close();
    }
  });

  it('reports a non-Error rejection rather than swallowing it', async () => {
    const { daemon, jobs, folder } = setup();
    const app = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs,
      isHostOnline: () => true,
      spawnOnRemoteHost: async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'relay blew up with a string';
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/spawn',
        headers: AUTH,
        payload: { folder, host: 'host-b', callerChatId: 'mgr' },
      });
      expect(res.statusCode).toBe(502);
      expect(res.json().message).toBe('relay blew up with a string');
    } finally {
      await app.close();
    }
  });

  it('refuses a cross-machine spawn with no calling chat — nothing to answer to', async () => {
    const { daemon, jobs, folder } = setup();
    const app = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs,
      isHostOnline: () => true,
      spawnOnRemoteHost: async () => ({ chatId: 'nope' }),
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/spawn',
        headers: AUTH,
        payload: { folder, host: 'host-b' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_input');
    } finally {
      await app.close();
    }
  });

  it('fails the tool call when the target REFUSED, naming the machine and the reason', async () => {
    const { daemon, jobs, folder } = setup();
    const app = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs,
      isHostOnline: () => true,
      spawnOnRemoteHost: async () => {
        throw new RemoteSpawnError(
          'no_model_catalogue',
          'patch_spawn: machine host-logged-out refused: machine host-logged-out has never read a model catalogue',
        );
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/spawn',
        headers: AUTH,
        payload: { folder, host: 'host-logged-out', callerChatId: 'mgr' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('no_model_catalogue');
      expect(res.json().message).toContain('host-logged-out');
      expect(res.json().message).toContain('model catalogue');
    } finally {
      await app.close();
    }
  });

  it('maps a target folder refusal to 404, so the agent fixes the folder not the model', async () => {
    const { daemon, jobs, folder } = setup();
    const app = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs,
      isHostOnline: () => true,
      spawnOnRemoteHost: async () => {
        throw new RemoteSpawnError(
          'folder_not_found',
          'patch_spawn: machine host-b refused: no such folder',
        );
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/spawn',
        headers: AUTH,
        payload: { folder, host: 'host-b', callerChatId: 'mgr' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('folder_not_found');
    } finally {
      await app.close();
    }
  });

  it('a TIMEOUT is a loud failure naming the machine, never a silent success', async () => {
    const { daemon, jobs, folder } = setup();
    const app = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs,
      isHostOnline: () => true,
      spawnOnRemoteHost: async () => {
        throw new RemoteSpawnError(
          'sdk_error',
          'patch_spawn: machine host-b did not answer within 30s; the chat may or may not have been created there',
        );
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/spawn',
        headers: AUTH,
        payload: { folder, host: 'host-b', callerChatId: 'mgr' },
      });
      expect(res.statusCode).toBe(502);
      expect(res.json().message).toContain('host-b');
      expect(res.json().message).toContain('did not answer');
    } finally {
      await app.close();
    }
  });

  it('503s rather than pretending, when nothing can carry the answer back', async () => {
    const { daemon, jobs, folder } = setup();
    const app = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs,
      isHostOnline: () => true,
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/spawn',
        headers: AUTH,
        payload: { folder, host: 'host-b', callerChatId: 'mgr' },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe('link_offline');
    } finally {
      await app.close();
    }
  });

  it('still refuses an offline machine inside the turn, without going near the wire', async () => {
    const { daemon, jobs, folder } = setup();
    let relayed = false;
    const app = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs,
      isHostOnline: () => false,
      spawnOnRemoteHost: async () => {
        relayed = true;
        return {};
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/spawn',
        headers: AUTH,
        payload: { folder, host: 'host-b', callerChatId: 'mgr' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('host_offline');
      expect(relayed).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("short-circuits a spawn naming the CALLER's own machine, in-process", async () => {
    const { daemon, jobs, folder } = setup();
    let relayed = false;
    const upstream: WireEvent[] = [];
    const app = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs,
      emitWire: (e) => upstream.push(e),
      isHostOnline: () => true,
      spawnOnRemoteHost: async () => {
        relayed = true;
        return {};
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/spawn',
        headers: AUTH,
        payload: { folder, host: 'host-a', callerChatId: 'mgr' },
      });
      expect(res.statusCode).toBe(200);
      expect(typeof res.json().chatId).toBe('string');
      expect(res.json().host).toBe('host-a');
      expect(relayed).toBe(false);
      // The audit frame for a local spawn answers to nobody, so it carries no
      // requestId — nothing is waiting on a response for it.
      const ev = upstream.find((e) => e.type === 'patch.spawn');
      expect(ev).toMatchObject({ type: 'patch.spawn', daemonId: 'host-a' });
      expect(ev && 'requestId' in ev).toBe(false);
    } finally {
      await app.close();
    }
  });
});
