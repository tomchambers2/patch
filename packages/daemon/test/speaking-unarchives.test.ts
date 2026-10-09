// What takes a hidden chat OUT of Archived, and what deliberately does not
// (spec/04 § Current status, § Lifecycle).
//
// Four things put a chat in the sidebar and nothing else does: a permission
// prompt (`unarchiveForPermission`), a `question` — the chat is blocked on the
// user, whether that is an answer or a thing only they can do in the world —
// and a `report`, the one an agent elects for itself.
//
// A notification is the fourth way in: a chat that rang the user must be in the
// list when they follow it. It sets no status, though — it is a way into the
// list, not a claim that the chat is blocked.
//
// One-way, like the permission case: having declared, the chat stays on the
// active list until someone archives it by hand.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';
import { MemoryJobsStore } from '../src/jobs-interface.js';
import { buildControl } from '../src/control.js';

const LOCAL_KEY = 'k'.repeat(64);
const AUTH = { authorization: `Bearer ${LOCAL_KEY}` };
const silent = pino({ level: 'silent' });

async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'patch-speak-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-speak-folder-')));
  mkdirSync(folder, { recursive: true });
  const events: WireEvent[] = [];
  let id = 0;
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: createMockSdkBackend(),
    oauthAccessToken: 'tok',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${++id}`,
  });
  const jobs = new MemoryJobsStore({ now: () => 1_700_000_000_000 });
  // A hidden job's chat: spawned straight into Archived because its runs are
  // ordinarily noise.
  const chatId = await daemon.spawnChat({ folder });
  await daemon.setArchived(chatId, true);
  const app = await buildControl({
    daemon,
    jobs,
    localKey: LOCAL_KEY,
    emitWire: (e: WireEvent) => events.push(e),
  });
  return { daemon, app, chatId, events };
}

describe('a chat that reaches for the user leaves Archived', () => {
  it('patch_notify un-archives, one-way, without declaring a status', async () => {
    const { daemon, app, chatId } = await setup();
    try {
      expect(daemon.chatState.get(chatId)?.status).toBe('archived');
      const res = await app.inject({
        method: 'POST',
        url: '/internal/notify',
        headers: AUTH,
        payload: { channel: 'push', message: 'done', callerChatId: chatId },
      });
      expect(res.statusCode).toBe(200);
      const state = daemon.chatState.get(chatId);
      expect(state?.status).toBe('active');
      expect(state?.declaredStatus).toBeNull();
      await daemon.setArchived(chatId, true);
      expect(daemon.chatState.get(chatId)?.status).toBe('archived');
    } finally {
      await app.close();
    }
  });

  it('patch_notify un-hides a hidden chat', async () => {
    const { daemon, app, chatId } = await setup();
    try {
      await daemon.setArchived(chatId, false);
      await daemon.setHidden(chatId, true);
      expect(daemon.chatState.get(chatId)?.hidden).toBe(true);
      const res = await app.inject({
        method: 'POST',
        url: '/internal/notify',
        headers: AUTH,
        payload: { channel: 'push', message: 'done', callerChatId: chatId },
      });
      expect(res.statusCode).toBe(200);
      expect(daemon.chatState.get(chatId)?.hidden).toBeFalsy();
    } finally {
      await app.close();
    }
  });

  it('patch_report un-archives and leaves the line on the row, silently', async () => {
    const { daemon, app, chatId, events } = await setup();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/report',
        headers: AUTH,
        payload: {
          summary: 'the backup has been failing silently since Tuesday',
          callerChatId: chatId,
        },
      });
      expect(res.statusCode).toBe(200);
      const state = daemon.chatState.get(chatId);
      expect(state?.status).toBe('active');
      expect(state?.statusKind).toBe('report');
      expect(state?.statusSummary).toBe('the backup has been failing silently since Tuesday');
      expect(state?.declaredStatus).toMatchObject({ kind: 'report' });
      expect(
        events.find((e) => e.type === 'notify'),
        'a report is seen later, not announced now',
      ).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('rejects a report from a chat that does not exist', async () => {
    const { app } = await setup();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/report',
        headers: AUTH,
        payload: { summary: 'something', callerChatId: 'chat-nope' },
      });
      expect(res.statusCode).toBe(404);
      expect((res.json() as { error: string }).error).toBe('chat_not_found');
    } finally {
      await app.close();
    }
  });

  it('patch_ask_human un-archives and pushes what it needs done', async () => {
    const { daemon, app, chatId, events } = await setup();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/ask_human',
        headers: AUTH,
        payload: {
          task: 'grant Screen Recording to Foreman Observer',
          why: 'until then I am judging your day from window titles alone',
          callerChatId: chatId,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(daemon.chatState.get(chatId)?.status).toBe('active');
      const notify = events.find((e) => e.type === 'notify');
      expect(notify, 'blocked on a human must leave the machine').toBeDefined();
      expect(notify).toMatchObject({ channel: 'push', kind: 'ask', priority: 'normal' });
      expect((notify as { message: string }).message).toContain(
        'grant Screen Recording to Foreman Observer',
      );
      // And the task OUTLIVES the push. This is the half that did not exist:
      // the request lived only inside a notification that had already gone, so
      // missing it lost the ask entirely and the row read as merely finished.
      const state = daemon.chatState.get(chatId);
      expect(state?.statusKind).toBe('question');
      expect(state?.statusSummary).toBe('grant Screen Recording to Foreman Observer');
      expect(state?.declaredStatus).toMatchObject({
        kind: 'question',
        text: 'grant Screen Recording to Foreman Observer',
      });
    } finally {
      await app.close();
    }
  });

  it('rejects an ask from a chat that does not exist', async () => {
    const { app } = await setup();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/ask_human',
        headers: AUTH,
        payload: { task: 'do the thing', callerChatId: 'chat-nope' },
      });
      expect(res.statusCode).toBe(404);
      expect((res.json() as { error: string }).error).toBe('chat_not_found');
    } finally {
      await app.close();
    }
  });
});
