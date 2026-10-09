// `patch_activity` reads through the chats' own logs on every online machine
// (spec/06 § Cross-chat toolset): GET /api/activity and the daemon-facing
// `patch.activity.request` both fan out `patch.activity.read.request` frames,
// merge the answers and join them against the chat mirror.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import type { PatchActivityReadRequestEvent, WireEvent } from '@patch/wire';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';

// `d1` is the stand-in link's own machine; the two added hosts join it.
const ONLINE_HOSTS = ['d1', 'host-a', 'host-b'];

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patch-activity-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function setup() {
  const user = generateUserKeypair(() => new Uint8Array(32).fill(77));
  const registry = Registry.load(dir);
  registry.bootstrapAccount({ keypair: user });
  registry.upsertSurface({ surfaceId: 'srf-a', surfaceKind: 'web', label: 'web', issuedAt: 1 });
  const jwt = await mintSurfaceCredential({
    userPrivateKey: user.privateKey,
    surfaceId: 'srf-a',
    surfaceKind: 'web',
    label: 'web',
  });
  const daemonLink = new InProcessDaemonLink();
  daemonLink.addOnlineHost('host-a');
  daemonLink.addOnlineHost('host-b');
  const built = await buildAll({
    logger: false as never,
    registry,
    daemonLink,
    jobsWatch: false,
    gcalSubscriptions: false,
  });
  for (const [chatId, daemonId] of [
    ['c-a', 'host-a'],
    ['c-b', 'host-b'],
  ] as const) {
    built.chatRegistry.observe({
      type: 'chat.spawned',
      chatId,
      daemonId,
      folder: `/work/${chatId}`,
    } as never);
  }
  const get = (qs: string) =>
    built.app.inject({
      method: 'GET',
      url: `/api/activity?${qs}`,
      headers: { authorization: `Bearer ${jwt}` },
    });
  const readRequests = (): Array<{ daemonId?: string; event: PatchActivityReadRequestEvent }> =>
    daemonLink.sent.filter(
      (s): s is { surfaceId: string; daemonId?: string; event: PatchActivityReadRequestEvent } =>
        s.event.type === 'patch.activity.read.request',
    );
  const answerAll = async (
    byHost: Record<string, Array<{ chatId: string; text: string; ts: number }>>,
  ) => {
    for (let i = 0; i < 100 && readRequests().length < ONLINE_HOSTS.length; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    for (const r of readRequests()) {
      daemonLink.injectDaemonEvent({
        type: 'patch.activity.read.response',
        requestId: r.event.requestId,
        messages: byHost[r.daemonId!] ?? [],
      } as WireEvent);
    }
  };
  return { built, daemonLink, get, readRequests, answerAll };
}

describe('GET /api/activity', () => {
  it('merges every online machine’s user messages, oldest first, enriched from the mirror, with no chatSessions', async () => {
    const { built, get, answerAll, readRequests } = await setup();
    try {
      const pending = get('since=1000&until=9000');
      await answerAll({
        'host-a': [{ chatId: 'c-a', text: 'second', ts: 3000 }],
        'host-b': [{ chatId: 'c-b', text: 'first', ts: 2000 }],
      });
      const res = await pending;
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        messages: [
          {
            chatId: 'c-b',
            chatName: null,
            daemonId: 'host-b',
            folder: '/work/c-b',
            text: 'first',
            ts: 2000,
          },
          {
            chatId: 'c-a',
            chatName: null,
            daemonId: 'host-a',
            folder: '/work/c-a',
            text: 'second',
            ts: 3000,
          },
        ],
        messagesTruncated: false,
      });
      expect(
        readRequests()
          .map((r) => r.daemonId)
          .sort(),
      ).toEqual(ONLINE_HOSTS.slice().sort());
    } finally {
      await built.app.close();
    }
  });

  it('truncates at limit and resumes from the cursor; drops chats the mirror does not know', async () => {
    const { built, get, answerAll } = await setup();
    try {
      const pending = get('since=0&until=9000&limit=2');
      await answerAll({
        'host-a': [
          { chatId: 'c-a', text: 'one', ts: 1000 },
          { chatId: 'gone', text: 'ghost', ts: 1500 },
          { chatId: 'c-a', text: 'three', ts: 3000 },
        ],
      });
      const body = (await pending).json() as {
        messages: Array<{ text: string }>;
        messagesTruncated: boolean;
        nextMessagesCursor: number;
      };
      expect(body.messages.map((m) => m.text)).toEqual(['one']);
      expect(body.messagesTruncated).toBe(true);
      expect(body.nextMessagesCursor).toBe(1501);
    } finally {
      await built.app.close();
    }
  });

  it('clamps the window to 30 days and asks each machine for limit+1 rows', async () => {
    const { built, get, answerAll, readRequests } = await setup();
    try {
      const until = Date.now();
      const pending = get(`since=0&until=${until}&limit=10`);
      await answerAll({});
      await pending;
      const req = readRequests()[0]!.event;
      expect(req.until - req.since).toBe(30 * 24 * 60 * 60 * 1000);
      expect(req.limit).toBe(11);
    } finally {
      await built.app.close();
    }
  });

  it('rejects non-numeric input and unauthenticated callers', async () => {
    const { built, get } = await setup();
    try {
      expect((await get('since=abc')).statusCode).toBe(400);
      const res = await built.app.inject({ method: 'GET', url: '/api/activity' });
      expect(res.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });
});

describe('patch.activity.request (a host’s patch_activity)', () => {
  it('answers the asking machine with a patch.activity.response', async () => {
    const { built, daemonLink, answerAll } = await setup();
    try {
      daemonLink.injectDaemonEvent({
        type: 'patch.activity.request',
        sourceChatId: 'caller',
        since: 1000,
        until: 9000,
      } as WireEvent);
      await answerAll({ 'host-a': [{ chatId: 'c-a', text: 'hi', ts: 2000 }] });
      for (
        let i = 0;
        i < 100 && !daemonLink.sent.some((s) => s.event.type === 'patch.activity.response');
        i++
      ) {
        await new Promise((r) => setTimeout(r, 5));
      }
      const reply = daemonLink.sent.find((s) => s.event.type === 'patch.activity.response')!.event;
      expect(reply).toMatchObject({
        type: 'patch.activity.response',
        sourceChatId: 'caller',
        messagesTruncated: false,
        messages: [{ chatId: 'c-a', text: 'hi', ts: 2000 }],
      });
      expect('chatSessions' in reply).toBe(false);
    } finally {
      await built.app.close();
    }
  });
});
