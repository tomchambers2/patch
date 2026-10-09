// `patch_activity` host-side wiring (GET /internal/activity): entirely
// server-held, so this endpoint has no local fallback — every call goes
// through `opts.getActivity`, which here is a configurable test double
// standing in for the real cross-host WS round-trip (index.ts's
// `requestActivity`). See mcp-tools.test.ts for the MCP-tool-level round trip
// and server/test/activity.test.ts for the dwell-time/paging logic itself.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { Daemon } from '../src/chatRunner.js';
import { buildControl } from '../src/control.js';
import { MemoryJobsStore } from '../src/jobs-interface.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });
const LOCAL_KEY = 'local-secret';
const AUTH = { authorization: `Bearer ${LOCAL_KEY}` };

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'patch-activity-ctl-'));
  const folder = mkdtempSync(join(tmpdir(), 'patch-activity-ctl-folder-'));
  mkdirSync(folder, { recursive: true });
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: createMockSdkBackend(),
    oauthAccessToken: 'tok',
    emit: () => undefined,
    logger: silent,
  });
  const jobs = new MemoryJobsStore();
  return { daemon, jobs };
}

const EMPTY_RESULT = {
  messages: [],
  messagesTruncated: false,
};

describe('GET /internal/activity', () => {
  it('requires auth', async () => {
    const { daemon, jobs } = setup();
    const app = await buildControl({ daemon, jobs, localKey: LOCAL_KEY });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/internal/activity?since=0&until=1000&callerChatId=c1',
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('rejects a missing since/until/callerChatId as invalid_input', async () => {
    const { daemon, jobs } = setup();
    const app = await buildControl({
      daemon,
      jobs,
      localKey: LOCAL_KEY,
      getActivity: async () => EMPTY_RESULT,
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/internal/activity', headers: AUTH });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'invalid_input' });
    } finally {
      await app.close();
    }
  });

  it('503s when activity is not configured', async () => {
    const { daemon, jobs } = setup();
    const app = await buildControl({ daemon, jobs, localKey: LOCAL_KEY });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/internal/activity?since=0&until=1000&callerChatId=c1',
        headers: AUTH,
      });
      expect(res.statusCode).toBe(503);
    } finally {
      await app.close();
    }
  });

  it('forwards since/until/cursors/limit to getActivity and returns its result verbatim', async () => {
    const { daemon, jobs } = setup();
    const calls: unknown[] = [];
    const app = await buildControl({
      daemon,
      jobs,
      localKey: LOCAL_KEY,
      getActivity: async (callerChatId, since, until, messagesCursor, limit) => {
        calls.push({ callerChatId, since, until, messagesCursor, limit });
        return {
          messages: [
            {
              chatId: 'c2',
              chatName: 'bus watch',
              daemonId: 'd1',
              folder: '/tmp/x',
              text: 'hi',
              ts: 1_500,
            },
          ],
          messagesTruncated: true,
          nextMessagesCursor: 1_501,
        };
      },
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/internal/activity?since=100&until=5000&messagesCursor=300&limit=10&callerChatId=caller-9',
        headers: AUTH,
      });
      expect(res.statusCode).toBe(200);
      expect(calls).toEqual([
        {
          callerChatId: 'caller-9',
          since: 100,
          until: 5000,
          messagesCursor: 300,
          limit: 10,
        },
      ]);
      const body = res.json();
      expect(body.chatSessions).toBeUndefined();
      expect(body.messages).toEqual([
        {
          chatId: 'c2',
          chatName: 'bus watch',
          daemonId: 'd1',
          folder: '/tmp/x',
          text: 'hi',
          ts: 1_500,
        },
      ]);
      expect(body.messagesTruncated).toBe(true);
      expect(body.nextMessagesCursor).toBe(1_501);
    } finally {
      await app.close();
    }
  });

  it('502s naming the problem when getActivity rejects (e.g. link offline)', async () => {
    const { daemon, jobs } = setup();
    const app = await buildControl({
      daemon,
      jobs,
      localKey: LOCAL_KEY,
      getActivity: async () => {
        throw new Error('patch_activity: the server link is offline; cannot read activity');
      },
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/internal/activity?since=0&until=1000&callerChatId=c1',
        headers: AUTH,
      });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toMatchObject({
        error: 'activity_unavailable',
        message: expect.stringContaining('link is offline'),
      });
    } finally {
      await app.close();
    }
  });
});
