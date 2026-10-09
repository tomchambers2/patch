// Cross-host fallback for patch_peek / patch_history / patch_send_to
// (spec/03 § Cross-chat tools, spec/06 § Cross-chat toolset).
//
// The defect this file locks down: these three only ever asked THIS
// host's own local chat state, so a chatId that lives on another
// registered host — one `patch_list_chats` had just named — 404'd as
// `chat_not_found`, indistinguishable from a chat that never existed
// anywhere. `peekRemoteChat`/`historyRemoteChat`/`sendToRemoteChat` are the
// injectable hooks production wires to the host's cross-host relay
// (index.ts); this file exercises the UDS endpoint's use of them directly,
// the same way cross-chat-tools.test.ts exercises the local-hit path.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { buildControl, type BuildOptions } from '../src/control.js';
import { MemoryJobsStore } from '../src/jobs-interface.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';
import { RemoteRelayError } from '../src/remote-relay.js';

const LOCAL_KEY = 'local-secret';
const silent = pino({ level: 'silent' });

function setup(remote: Partial<BuildOptions> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'patch-relay-'));
  const sdk = createMockSdkBackend();
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: sdk,
    oauthAccessToken: 'x',
    emit: () => {},
    logger: silent,
    now: () => 1_700_000_000_000,
  });
  const jobs = new MemoryJobsStore({ now: () => 1_700_000_000_000 });
  return { daemon, jobs, ...remote };
}

describe('patch_peek — falls back to the owning host when not local', () => {
  it('calls peekRemoteChat with the caller + target + limit, and returns its result verbatim', async () => {
    const calls: unknown[] = [];
    const remoteResult = {
      chat_state: { chatId: 'chat-on-host-b', activity: 'idle' },
      events: [{ type: 'chat.message' }],
      truncated: false,
    };
    const { daemon, jobs } = setup({
      peekRemoteChat: async (req) => {
        calls.push(req);
        return remoteResult;
      },
    });
    const app = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs,
      peekRemoteChat: async (req) => {
        calls.push(req);
        return remoteResult;
      },
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/internal/peek/chat-on-host-b?limit=10&callerChatId=mgr',
        headers: { authorization: `Bearer ${LOCAL_KEY}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(remoteResult);
      expect(calls).toEqual([{ sourceChatId: 'mgr', targetChatId: 'chat-on-host-b', limit: 10 }]);
    } finally {
      await app.close();
    }
  });

  it('never calls the remote hook when the chat IS local', async () => {
    const { daemon, jobs, folder } = {
      ...setup(),
      folder: mkdtempSync(join(tmpdir(), 'patch-relay-folder-')),
    };
    mkdirSync(folder, { recursive: true });
    const chatId = await daemon.spawnChat({ folder, prompt: 'hi' });
    let calledRemote = false;
    const app = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs,
      peekRemoteChat: async () => {
        calledRemote = true;
        throw new Error('should not be called');
      },
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/internal/peek/${chatId}?callerChatId=mgr`,
        headers: { authorization: `Bearer ${LOCAL_KEY}` },
      });
      expect(res.statusCode).toBe(200);
      expect(calledRemote).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('a chat_not_found from the remote relay surfaces as a 404, not a 502', async () => {
    const { daemon, jobs } = setup();
    const app = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs,
      peekRemoteChat: async () => {
        throw new RemoteRelayError('chat_not_found', 'no such chat: chat-ghost');
      },
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/internal/peek/chat-ghost?callerChatId=mgr',
        headers: { authorization: `Bearer ${LOCAL_KEY}` },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: 'chat_not_found' });
    } finally {
      await app.close();
    }
  });

  it('an offline-host refusal surfaces as a 502 naming the reason', async () => {
    const { daemon, jobs } = setup();
    const app = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs,
      peekRemoteChat: async () => {
        throw new RemoteRelayError('host_not_registered', 'machine host-b is offline');
      },
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/internal/peek/chat-on-host-b?callerChatId=mgr',
        headers: { authorization: `Bearer ${LOCAL_KEY}` },
      });
      expect(res.statusCode).toBe(502);
      expect(res.json().message).toContain('host-b');
    } finally {
      await app.close();
    }
  });

  it('with no callerChatId, falls back to the plain local 404 (no relay attempted)', async () => {
    const { daemon, jobs } = setup();
    let calledRemote = false;
    const app = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs,
      peekRemoteChat: async () => {
        calledRemote = true;
        return { chat_state: {}, events: [], truncated: false };
      },
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/internal/peek/chat-on-host-b',
        headers: { authorization: `Bearer ${LOCAL_KEY}` },
      });
      expect(res.statusCode).toBe(404);
      expect(calledRemote).toBe(false);
    } finally {
      await app.close();
    }
  });
});

describe('patch_history — falls back to the owning host when not local', () => {
  it('calls historyRemoteChat and returns its result verbatim', async () => {
    const { daemon, jobs } = setup();
    const remoteResult = {
      events: [{ type: 'chat.message' } as unknown as WireEvent],
      nextFromSeq: 5,
    };
    const app = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs,
      historyRemoteChat: async (req) => {
        expect(req).toEqual({
          sourceChatId: 'mgr',
          targetChatId: 'chat-on-host-b',
          fromSeq: 2,
          limit: 20,
        });
        return remoteResult;
      },
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/internal/history/chat-on-host-b?fromSeq=2&limit=20&callerChatId=mgr',
        headers: { authorization: `Bearer ${LOCAL_KEY}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(remoteResult);
    } finally {
      await app.close();
    }
  });

  it('a chat_not_found from the remote relay surfaces as a 404', async () => {
    const { daemon, jobs } = setup();
    const app = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs,
      historyRemoteChat: async () => {
        throw new RemoteRelayError('chat_not_found', 'no such chat: chat-ghost');
      },
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/internal/history/chat-ghost?callerChatId=mgr',
        headers: { authorization: `Bearer ${LOCAL_KEY}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe('patch_send_to — falls back to the owning host when not local', () => {
  it('calls sendToRemoteChat and reports queued on success', async () => {
    const { daemon, jobs } = setup();
    let called: unknown;
    const app = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs,
      sendToRemoteChat: async (req) => {
        called = req;
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/send-to',
        headers: { authorization: `Bearer ${LOCAL_KEY}`, 'content-type': 'application/json' },
        payload: { chatId: 'chat-on-host-b', message: 'hi', callerChatId: 'mgr' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, queued: true });
      expect(called).toEqual({
        sourceChatId: 'mgr',
        targetChatId: 'chat-on-host-b',
        message: 'hi',
      });
    } finally {
      await app.close();
    }
  });

  it('a chat_not_found from the remote relay surfaces as a 404', async () => {
    const { daemon, jobs } = setup();
    const app = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs,
      sendToRemoteChat: async () => {
        throw new RemoteRelayError('chat_not_found', 'no such chat: chat-ghost');
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/send-to',
        headers: { authorization: `Bearer ${LOCAL_KEY}`, 'content-type': 'application/json' },
        payload: { chatId: 'chat-ghost', message: 'hi', callerChatId: 'mgr' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
