// priority='silent' (spec/09 § push).
//
// The level exists for things worth knowing but not worth interrupting for --
// an evening summary, a watcher's daily line. Two properties make it that
// rather than just a quieter 'normal', and both are easy to break by tidying:
//
//  1. It is NOT suppressed by an active surface. Every other non-urgent push is,
//     because the user is already looking at somewhere the chat is visible. A
//     silent push asks for nothing now; its whole value is being on the phone
//     later, so suppressing it deletes it instead of deferring it.
//  2. It carries the quiet Android channel and no sound or vibration. On
//     Android the channel is what actually decides whether a notification makes
//     a noise -- message priority only decides how promptly it is delivered --
//     so a silent push that landed on the default channel would buzz.

import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { NotifyEvent } from '@patch/wire';
import { generateUserKeypair } from '@patch/auth';
import { Registry } from '../src/registry.js';
import { PresenceTracker } from '../src/presence.js';
import {
  NotificationRouter,
  type PushBackend,
  type PushPayload,
} from '../src/notifications/router.js';

const ACCOUNT = generateUserKeypair(() => new Uint8Array(32).fill(11));

function harness(): {
  router: NotificationRouter;
  presence: PresenceTracker;
  sent: { tokens: string[]; payload: PushPayload }[];
  accountId: string;
} {
  const dataDir = mkdtempSync(join(tmpdir(), 'silent-push-'));
  const registry = Registry.load(dataDir);
  const account = registry.bootstrapAccount({ keypair: ACCOUNT });
  registry.registerPushToken({
    surfaceId: 'srf-phone',
    accountId: account.accountId,
    token: 'tok-1',
    registeredAt: 1,
  });
  const presence = new PresenceTracker();
  const sent: { tokens: string[]; payload: PushPayload }[] = [];
  const pushBackend: PushBackend = {
    async send(tokens, payload) {
      sent.push({ tokens, payload });
      return { delivered: tokens.length, failed: [], permanentlyRejected: [] };
    },
  };
  const router = new NotificationRouter({
    logger: pino({ level: 'silent' }),
    registry,
    presence,
    wsHub: { broadcast: () => {}, broadcastToClientTypes: () => {} } as never,
    dataDir,
    pushBackend,
  });
  return { router, presence, sent, accountId: account.accountId };
}

const notify = (priority: NotifyEvent['priority']): NotifyEvent => ({
  type: 'notify',
  chatId: 'chat-1',
  channel: 'push',
  message: 'the plastering has moved to tomorrow',
  ...(priority ? { priority } : {}),
});

describe('the server picks the surface, not the agent', () => {
  it('goes to the desktop when he is at a computer, and the phone when he is not', async () => {
    const away = harness();
    await away.router.route({
      type: 'notify',
      chatId: 'chat-1',
      message: 'bins',
      priority: 'normal',
    });
    expect(away.sent, 'nobody at a computer — the phone is the only thing there').toHaveLength(1);

    const atDesk = harness();
    atDesk.presence.online(atDesk.accountId, 'srf-desktop', 'surface-desktop');
    atDesk.presence.heartbeat(atDesk.accountId, 'srf-desktop', Date.now());
    await atDesk.router.route({
      type: 'notify',
      chatId: 'chat-1',
      message: 'bins',
      priority: 'normal',
    });
    expect(
      atDesk.sent,
      'the toast is already in front of him; a push would be a second copy',
    ).toHaveLength(0);
  });

  // spec/09 § Reaching the user — urgent is normal with a more urgent sound.
  it('routes urgent exactly as normal: the desktop when he is at a computer', async () => {
    const h = harness();
    h.presence.online(h.accountId, 'srf-desktop', 'surface-desktop');
    h.presence.heartbeat(h.accountId, 'srf-desktop', Date.now());
    await h.router.route({
      type: 'notify',
      chatId: 'chat-1',
      message: 'the train goes in 6 minutes',
      priority: 'urgent',
    });
    expect(h.sent, 'the toast is in front of him, as it would be for normal').toHaveLength(0);
  });

  it('gives an urgent push the urgent sound, and nothing else does', async () => {
    const urgent = harness();
    await urgent.router.route(notify('urgent'));
    expect(urgent.sent[0]?.payload.urgentSound).toBe(true);

    const normal = harness();
    await normal.router.route(notify('normal'));
    expect(normal.sent[0]?.payload.urgentSound).toBe(false);

    const call = harness();
    await call.router.route({ ...notify('urgent'), kind: 'call', callId: 'call-1' });
    expect(call.sent[0]?.payload.urgentSound, 'a ring keeps its own sound').toBe(false);
  });
});

describe('priority=silent', () => {
  it('is delivered even while a surface is active, where normal is suppressed', async () => {
    const a = harness();
    a.presence.online(a.accountId, 'srf-web', 'surface-web');
    a.presence.heartbeat(a.accountId, 'srf-web', Date.now());
    await a.router.route(notify('normal'));
    expect(a.sent, 'normal should be suppressed by an active surface').toHaveLength(0);

    const b = harness();
    b.presence.online(b.accountId, 'srf-web', 'surface-web');
    b.presence.heartbeat(b.accountId, 'srf-web', Date.now());
    await b.router.route(notify('silent'));
    expect(b.sent, 'silent must still land — it is for later, not for now').toHaveLength(1);
  });

  it('carries the quiet channel, no sound and no vibration', async () => {
    const h = harness();
    await h.router.route(notify('silent'));
    expect(h.sent[0]?.payload.silent).toBe(true);
    expect(h.sent[0]?.payload.urgent).toBe(false);
  });

  it('leaves normal and urgent as they were', async () => {
    const h = harness();
    await h.router.route(notify('normal'));
    await h.router.route(notify('urgent'));
    expect(h.sent[0]?.payload.silent).toBe(false);
    expect(h.sent[0]?.payload.urgent).toBe(false);
    expect(h.sent[1]?.payload.urgent).toBe(true);
    expect(h.sent[1]?.payload.silent).toBe(false);
  });
});
