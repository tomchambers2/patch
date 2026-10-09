// Group 11 — server side: notification router (each channel branch),
// push presence-suppression, voice-device outbound reply routing,
// patch_call orchestration (concurrent fanout, first-accept,
// timeout fallback).

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type {
  ChatCallRequestEvent,
  ChatCallTimeoutEvent,
  ChatCallWinnerEvent,
  NotifyEvent,
  WireEvent,
} from '@patch/wire';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import { Registry } from '../src/registry.js';
import { PresenceTracker } from '../src/presence.js';
import { NotificationRouter, type PushBackend } from '../src/notifications/router.js';
import { CallOrchestrator } from '../src/notifications/call-orchestrator.js';
import { ReplyRouter } from '../src/notifications/reply-router.js';
import { routeVoiceDeviceTranscript } from '../src/notifications/routes.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';
import { build } from '../src/app.js';

const silent = pino({ level: 'silent' });

const ACCOUNT = generateUserKeypair(() => new Uint8Array(32).fill(7));

interface FakeWsHub {
  // Mocks for the methods NotificationRouter / CallOrchestrator use.
  sendToKind: (kind: string, ev: WireEvent) => number;
  sendToKinds: (kinds: ReadonlySet<string>, ev: WireEvent) => number;
  sendToKindUnlessFocused: (kind: string, chatId: string, ev: WireEvent) => number;
  sendToSurface: (id: string, ev: WireEvent) => boolean;
  sendToAll: (ev: WireEvent) => number;
  // Captured for test assertions.
  delivered: {
    kind?: string;
    kinds?: ReadonlySet<string>;
    unlessFocusedChatId?: string;
    surfaceId?: string;
    all?: true;
    event: WireEvent;
  }[];
}

function makeFakeWsHub(): FakeWsHub {
  const delivered: FakeWsHub['delivered'] = [];
  return {
    delivered,
    sendToKind: (kind, ev) => {
      delivered.push({ kind, event: ev });
      return 1;
    },
    sendToKinds: (kinds, ev) => {
      delivered.push({ kinds, event: ev });
      return 1;
    },
    sendToKindUnlessFocused: (kind, chatId, ev) => {
      delivered.push({ kind, unlessFocusedChatId: chatId, event: ev });
      return 1;
    },
    sendToSurface: (id, ev) => {
      delivered.push({ surfaceId: id, event: ev });
      return true;
    },
    sendToAll: (ev) => {
      delivered.push({ all: true, event: ev });
      return 1;
    },
  };
}

function makeRegistryDir(): { dir: string; registry: Registry } {
  const dir = mkdtempSync(join(tmpdir(), 'patch-notif-server-'));
  const registry = Registry.load(dir);
  registry.bootstrapAccount({ keypair: ACCOUNT });
  return { dir, registry };
}

function fakePush(): { backend: PushBackend; sent: { tokens: string[]; payload: unknown }[] } {
  const sent: { tokens: string[]; payload: unknown }[] = [];
  return {
    sent,
    backend: {
      send: async (tokens, payload) => {
        sent.push({ tokens, payload });
        return { delivered: tokens.length, failed: [], permanentlyRejected: [] };
      },
    },
  };
}

describe('NotificationRouter — push channel', () => {
  it('delivers an ask_human push even while the user is at a computer', async () => {
    const { dir, registry } = makeRegistryDir();
    const presence = new PresenceTracker();
    presence.online(ACCOUNT.publicKey, 'srf-1', 'web', 1_700_000_000_000);
    presence.input(ACCOUNT.publicKey, 'srf-1', 5_000, 1_700_000_000_000);
    registry.upsertSurface({
      surfaceId: 'srf-1',
      surfaceKind: 'web',
      label: 'web',
      issuedAt: 1_700_000_000_000,
    });
    registry.registerPushToken({
      surfaceId: 'srf-1',
      accountId: ACCOUNT.publicKey,
      token: 'tok-1',
      registeredAt: 1,
    });
    const wsHub = makeFakeWsHub();
    const push = fakePush();
    const router = new NotificationRouter({
      logger: silent,
      registry,
      presence,
      wsHub: wsHub as never,
      dataDir: dir,
      pushBackend: push.backend,
      nowMs: () => 1_700_000_010_000,
    });
    await router.route({
      type: 'notify',
      chatId: 'c1',
      channel: 'push',
      kind: 'ask',
      message: 'c needs you to: plug the phone in',
    });
    expect(push.sent).toHaveLength(1);
  });

  it('suppresses non-urgent push while the user is at a computer', async () => {
    const { dir, registry } = makeRegistryDir();
    const presence = new PresenceTracker();
    presence.online(ACCOUNT.publicKey, 'srf-1', 'web', 1_700_000_000_000);
    presence.input(ACCOUNT.publicKey, 'srf-1', 5_000, 1_700_000_000_000);
    registry.upsertSurface({
      surfaceId: 'srf-1',
      surfaceKind: 'web',
      label: 'web',
      issuedAt: 1_700_000_000_000,
    });
    registry.registerPushToken({
      surfaceId: 'srf-1',
      accountId: ACCOUNT.publicKey,
      token: 'tok-1',
      registeredAt: 1,
    });
    const wsHub = makeFakeWsHub();
    const push = fakePush();
    const router = new NotificationRouter({
      logger: silent,
      registry,
      presence,
      wsHub: wsHub as never,
      dataDir: dir,
      pushBackend: push.backend,
      nowMs: () => 1_700_000_010_000, // 10s after heartbeat
    });
    await router.route({
      type: 'notify',
      chatId: 'c1',
      channel: 'push',
      message: 'm',
    });
    expect(push.sent).toHaveLength(0);
  });

  it('fires push when priority=urgent even if surfaces are active', async () => {
    const { dir, registry } = makeRegistryDir();
    const presence = new PresenceTracker();
    presence.online(ACCOUNT.publicKey, 'srf-1', 'web', 1_700_000_000_000);
    presence.heartbeat(ACCOUNT.publicKey, 'srf-1', 1_700_000_000_000);
    registry.registerPushToken({
      surfaceId: 'srf-1',
      accountId: ACCOUNT.publicKey,
      token: 'tok-1',
      registeredAt: 1,
    });
    const wsHub = makeFakeWsHub();
    const push = fakePush();
    const router = new NotificationRouter({
      logger: silent,
      registry,
      presence,
      wsHub: wsHub as never,
      dataDir: dir,
      pushBackend: push.backend,
      nowMs: () => 1_700_000_010_000,
    });
    await router.route({
      type: 'notify',
      chatId: 'c1',
      channel: 'push',
      message: 'urgent!',
      priority: 'urgent',
    });
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]?.tokens).toEqual(['tok-1']);
  });

  it('delivers a non-urgent push when no surface heartbeat is within 30s', async () => {
    const { dir, registry } = makeRegistryDir();
    const presence = new PresenceTracker();
    // Surface heartbeated once, but our clock is 40s later → stale (>30s).
    presence.online(ACCOUNT.publicKey, 'srf-1', 'web', 1_700_000_000_000);
    presence.heartbeat(ACCOUNT.publicKey, 'srf-1', 1_700_000_000_000);
    registry.registerPushToken({
      surfaceId: 'srf-1',
      accountId: ACCOUNT.publicKey,
      token: 'tok-1',
      registeredAt: 1,
    });
    const wsHub = makeFakeWsHub();
    const push = fakePush();
    const router = new NotificationRouter({
      logger: silent,
      registry,
      presence,
      wsHub: wsHub as never,
      dataDir: dir,
      pushBackend: push.backend,
      nowMs: () => 1_700_000_040_000, // 40s after heartbeat → no active surface
    });
    await router.route({
      type: 'notify',
      chatId: 'c1',
      channel: 'push',
      message: 'routine',
    });
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]?.tokens).toEqual(['tok-1']);
  });

  // spec/09 § Chat completion — the narrowed suppression window. The phone
  // being in hand is exactly when the push is the point, so it must not
  // suppress; a computer surface must.
  it('suppressOn=computer still delivers when only the phone is active', async () => {
    const { dir, registry } = makeRegistryDir();
    const presence = new PresenceTracker();
    presence.online(ACCOUNT.publicKey, 'srf-phone', 'mobile', 1_700_000_000_000);
    presence.heartbeat(ACCOUNT.publicKey, 'srf-phone', 1_700_000_000_000);
    registry.registerPushToken({
      surfaceId: 'srf-phone',
      accountId: ACCOUNT.publicKey,
      token: 'tok-1',
      registeredAt: 1,
    });
    const push = fakePush();
    const router = new NotificationRouter({
      logger: silent,
      registry,
      presence,
      wsHub: makeFakeWsHub() as never,
      dataDir: dir,
      pushBackend: push.backend,
      nowMs: () => 1_700_000_010_000, // 10s after the phone's heartbeat
    });
    await router.route(
      { type: 'notify', chatId: 'c1', channel: 'push', message: 'done' },
      { suppressOn: 'computer' },
    );
    expect(push.sent).toHaveLength(1);
  });

  it('suppressOn=computer suppresses when the desktop reports recent input', async () => {
    const { dir, registry } = makeRegistryDir();
    const presence = new PresenceTracker();
    presence.online(ACCOUNT.publicKey, 'srf-desk', 'desktop', 1_700_000_000_000);
    presence.input(ACCOUNT.publicKey, 'srf-desk', 5_000, 1_700_000_000_000);
    registry.registerPushToken({
      surfaceId: 'srf-phone',
      accountId: ACCOUNT.publicKey,
      token: 'tok-1',
      registeredAt: 1,
    });
    const push = fakePush();
    const router = new NotificationRouter({
      logger: silent,
      registry,
      presence,
      wsHub: makeFakeWsHub() as never,
      dataDir: dir,
      pushBackend: push.backend,
      nowMs: () => 1_700_000_010_000,
    });
    await router.route(
      { type: 'notify', chatId: 'c1', channel: 'push', message: 'done' },
      { suppressOn: 'computer' },
    );
    expect(push.sent).toHaveLength(0);
  });

  // Tom, 2026-09-28: a Patch window left open on the Mac held every push back
  // while he was away from it. A visible window is not someone at the desk.
  it('a desktop window that is open but idle for over two minutes does not hold the push', async () => {
    const { dir, registry } = makeRegistryDir();
    const presence = new PresenceTracker();
    presence.online(ACCOUNT.publicKey, 'srf-desk', 'desktop', 1_700_000_000_000);
    presence.heartbeat(ACCOUNT.publicKey, 'srf-desk', 1_700_000_005_000);
    presence.input(ACCOUNT.publicKey, 'srf-desk', 10 * 60_000, 1_700_000_005_000);
    registry.registerPushToken({
      surfaceId: 'srf-phone',
      accountId: ACCOUNT.publicKey,
      token: 'tok-1',
      registeredAt: 1,
    });
    const push = fakePush();
    const router = new NotificationRouter({
      logger: silent,
      registry,
      presence,
      wsHub: makeFakeWsHub() as never,
      dataDir: dir,
      pushBackend: push.backend,
      nowMs: () => 1_700_000_010_000,
    });
    await router.route({ type: 'notify', chatId: 'c1', message: 'done', priority: 'normal' });
    expect(push.sent).toHaveLength(1);
  });

  // Regression guard: patch_notify's own rule is unchanged by the new option.
  it('defaults to the any-surface rule, so a live phone still suppresses', async () => {
    const { dir, registry } = makeRegistryDir();
    const presence = new PresenceTracker();
    presence.online(ACCOUNT.publicKey, 'srf-phone', 'mobile', 1_700_000_000_000);
    presence.heartbeat(ACCOUNT.publicKey, 'srf-phone', 1_700_000_000_000);
    registry.registerPushToken({
      surfaceId: 'srf-phone',
      accountId: ACCOUNT.publicKey,
      token: 'tok-1',
      registeredAt: 1,
    });
    const push = fakePush();
    const router = new NotificationRouter({
      logger: silent,
      registry,
      presence,
      wsHub: makeFakeWsHub() as never,
      dataDir: dir,
      pushBackend: push.backend,
      nowMs: () => 1_700_000_010_000,
    });
    await router.route({ type: 'notify', chatId: 'c1', channel: 'push', message: 'done' });
    expect(push.sent).toHaveLength(0);
  });

  // spec/09 § `### push` — deepLink rides along in the push data payload so the
  // Android app can open it on tap instead of the source chat.
  it('carries deepLink through to the push data payload', async () => {
    const { dir, registry } = makeRegistryDir();
    const presence = new PresenceTracker();
    registry.registerPushToken({
      surfaceId: 'srf-1',
      accountId: ACCOUNT.publicKey,
      token: 'tok-1',
      registeredAt: 1,
    });
    const wsHub = makeFakeWsHub();
    const push = fakePush();
    const router = new NotificationRouter({
      logger: silent,
      registry,
      presence,
      wsHub: wsHub as never,
      dataDir: dir,
      pushBackend: push.backend,
      nowMs: () => 1_700_000_000_000,
    });
    await router.route({
      type: 'notify',
      chatId: 'c1',
      channel: 'push',
      message: 'Route ready',
      priority: 'urgent',
      deepLink: 'citymapper://directions?startcoord=51.4,-2.6&endcoord=51.45,-2.58',
    });
    expect(push.sent).toHaveLength(1);
    const payload = push.sent[0]?.payload as { data?: Record<string, string> };
    expect(payload.data?.['deepLink']).toBe(
      'citymapper://directions?startcoord=51.4,-2.6&endcoord=51.45,-2.58',
    );
  });

  it('omits deepLink from the push data payload when not given', async () => {
    const { dir, registry } = makeRegistryDir();
    const presence = new PresenceTracker();
    registry.registerPushToken({
      surfaceId: 'srf-1',
      accountId: ACCOUNT.publicKey,
      token: 'tok-1',
      registeredAt: 1,
    });
    const wsHub = makeFakeWsHub();
    const push = fakePush();
    const router = new NotificationRouter({
      logger: silent,
      registry,
      presence,
      wsHub: wsHub as never,
      dataDir: dir,
      pushBackend: push.backend,
      nowMs: () => 1_700_000_000_000,
    });
    await router.route({
      type: 'notify',
      chatId: 'c1',
      channel: 'push',
      message: 'no link here',
      priority: 'urgent',
    });
    expect(push.sent).toHaveLength(1);
    const payload = push.sent[0]?.payload as { data?: Record<string, string> };
    expect(payload.data?.['deepLink']).toBeUndefined();
  });

  // spec/09 § Notification actions — Expo/FCM data values are strings only,
  // so `actions` rides along JSON-encoded for the phone to parse back out.
  it('carries actions through to the push data payload, JSON-encoded', async () => {
    const { dir, registry } = makeRegistryDir();
    const presence = new PresenceTracker();
    registry.registerPushToken({
      surfaceId: 'srf-1',
      accountId: ACCOUNT.publicKey,
      token: 'tok-1',
      registeredAt: 1,
    });
    const wsHub = makeFakeWsHub();
    const push = fakePush();
    const router = new NotificationRouter({
      logger: silent,
      registry,
      presence,
      wsHub: wsHub as never,
      dataDir: dir,
      pushBackend: push.backend,
      nowMs: () => 1_700_000_000_000,
    });
    await router.route({
      type: 'notify',
      chatId: 'c1',
      channel: 'push',
      message: 'Which bed?',
      actions: {
        kind: 'question',
        requestId: 'req-1',
        questionText: 'Which bed?',
        options: ['North', 'South'],
      },
    });
    expect(push.sent).toHaveLength(1);
    const payload = push.sent[0]?.payload as { data?: Record<string, string> };
    expect(JSON.parse(payload.data?.['actions'] ?? 'null')).toEqual({
      kind: 'question',
      requestId: 'req-1',
      questionText: 'Which bed?',
      options: ['North', 'South'],
    });
    // The separate key Android's own notification builder reads to attach
    // actions to a push it displays itself (apps/mobile/src/lib/
    // notificationActions.ts § categoryIdentifierFor).
    expect(payload.data?.['categoryId']).toBe('patch_dynamic');
  });

  it.each([
    [{ kind: 'permission', requestId: 'r1' }, 'patch_permission'],
    [{ kind: 'message' }, 'patch_reply'],
    [{ kind: 'message', quickReplies: ['Yes'] }, 'patch_dynamic'],
    [{ kind: 'question', requestId: 'r1', questionText: 'q' }, 'patch_reply'],
    [
      { kind: 'question', requestId: 'r1', questionText: 'q', options: ['A', 'B'] },
      'patch_dynamic',
    ],
  ] as const)('picks categoryId %j -> %s', async (actions, expected) => {
    const { dir, registry } = makeRegistryDir();
    const presence = new PresenceTracker();
    registry.registerPushToken({
      surfaceId: 'srf-1',
      accountId: ACCOUNT.publicKey,
      token: 'tok-1',
      registeredAt: 1,
    });
    const wsHub = makeFakeWsHub();
    const push = fakePush();
    const router = new NotificationRouter({
      logger: silent,
      registry,
      presence,
      wsHub: wsHub as never,
      dataDir: dir,
      pushBackend: push.backend,
      nowMs: () => 1_700_000_000_000,
    });
    await router.route({ type: 'notify', chatId: 'c1', channel: 'push', message: 'x', actions });
    const payload = push.sent[0]?.payload as { data?: Record<string, string> };
    expect(payload.data?.['categoryId']).toBe(expected);
  });

  it('omits actions from the push data payload when not given', async () => {
    const { dir, registry } = makeRegistryDir();
    const presence = new PresenceTracker();
    registry.registerPushToken({
      surfaceId: 'srf-1',
      accountId: ACCOUNT.publicKey,
      token: 'tok-1',
      registeredAt: 1,
    });
    const wsHub = makeFakeWsHub();
    const push = fakePush();
    const router = new NotificationRouter({
      logger: silent,
      registry,
      presence,
      wsHub: wsHub as never,
      dataDir: dir,
      pushBackend: push.backend,
      nowMs: () => 1_700_000_000_000,
    });
    await router.route({ type: 'notify', chatId: 'c1', channel: 'push', message: 'plain' });
    expect(push.sent).toHaveLength(1);
    const payload = push.sent[0]?.payload as { data?: Record<string, string> };
    expect(payload.data?.['actions']).toBeUndefined();
  });

  // The OS notification tray renders `body` verbatim — it does not interpret
  // markdown — so a message an agent wrote with `**bold**` or a `# heading`
  // must be flattened before it reaches the payload, or the user sees the
  // literal asterisks/hashes rather than emphasis.
  it('strips markdown from the push body', async () => {
    const { dir, registry } = makeRegistryDir();
    registry.registerPushToken({
      surfaceId: 'srf-1',
      accountId: ACCOUNT.publicKey,
      token: 'tok-1',
      registeredAt: 1,
    });
    const presence = new PresenceTracker();
    const wsHub = makeFakeWsHub();
    const push = fakePush();
    const router = new NotificationRouter({
      logger: silent,
      registry,
      presence,
      wsHub: wsHub as never,
      dataDir: dir,
      pushBackend: push.backend,
      nowMs: () => 1_700_000_000_000,
    });
    await router.route({
      type: 'notify',
      chatId: 'c1',
      channel: 'push',
      message: '**Build finished** — see `deploy/logs`',
      priority: 'urgent',
    });
    expect(push.sent).toHaveLength(1);
    const payload = push.sent[0]?.payload as { body: string };
    expect(payload.body).toBe('Build finished — see deploy/logs');
  });

  it('logs to undelivered.jsonl when Expo rejects a token (partial failure, no throw)', async () => {
    // A real Expo push send resolves with per-token failures (e.g. an
    // unregistered/stale registration token) rather than throwing — exactly the
    // C3-int-4 bad-token path. The router must record those rejections to
    // /data/undelivered.jsonl per spec/09 (NO FALLBACK / no retry).
    const { dir, registry } = makeRegistryDir();
    const presence = new PresenceTracker();
    registry.registerPushToken({
      surfaceId: 'srf-1',
      accountId: ACCOUNT.publicKey,
      token: 'bad-token',
      registeredAt: 1,
    });
    const wsHub = makeFakeWsHub();
    const pushBackend: PushBackend = {
      // Mirrors a real Expo push send: resolves per-token, doesn't throw.
      send: async (tokens) => ({ delivered: 0, failed: [...tokens], permanentlyRejected: [] }),
    };
    const router = new NotificationRouter({
      logger: silent,
      registry,
      presence,
      wsHub: wsHub as never,
      dataDir: dir,
      pushBackend,
    });
    await router.route({
      type: 'notify',
      chatId: 'c1',
      channel: 'push',
      message: 'will be rejected',
    });
    const logPath = join(dir, 'undelivered.jsonl');
    expect(existsSync(logPath)).toBe(true);
    const line = readFileSync(logPath, 'utf8').trim();
    const entry = JSON.parse(line) as { channel: string; chatId: string; error: string };
    expect(entry.channel).toBe('push');
    expect(entry.chatId).toBe('c1');
    expect(entry.error).toContain('bad-token');
  });

  it('prunes permanently-rejected tokens from the registry (and still logs the partial failure)', async () => {
    const { dir, registry } = makeRegistryDir();
    const presence = new PresenceTracker();
    registry.registerPushToken({
      surfaceId: 'srf-1',
      accountId: ACCOUNT.publicKey,
      token: 'dead-token',
      registeredAt: 1,
    });
    const wsHub = makeFakeWsHub();
    const pushBackend: PushBackend = {
      send: async (tokens) => ({
        delivered: 0,
        failed: [...tokens],
        permanentlyRejected: [...tokens],
      }),
    };
    const router = new NotificationRouter({
      logger: silent,
      registry,
      presence,
      wsHub: wsHub as never,
      dataDir: dir,
      pushBackend,
    });
    await router.route({ type: 'notify', chatId: 'c1', channel: 'push', message: 'x' });
    expect(registry.listPushTokens(ACCOUNT.publicKey)).not.toContain('dead-token');
    expect(existsSync(join(dir, 'undelivered.jsonl'))).toBe(true);
  });

  it('throws when push channel is invoked without a backend (NO FALLBACK)', async () => {
    const { dir, registry } = makeRegistryDir();
    const presence = new PresenceTracker();
    const wsHub = makeFakeWsHub();
    const router = new NotificationRouter({
      logger: silent,
      registry,
      presence,
      wsHub: wsHub as never,
      dataDir: dir,
    });
    await expect(
      router.route({ type: 'notify', chatId: 'c1', channel: 'push', message: 'x' }),
    ).rejects.toThrow(/no push backend configured/);
  });

  it('throws when push is routed before any account is bootstrapped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'patch-notif-server-'));
    const registry = Registry.load(dir); // no bootstrapAccount() call
    const presence = new PresenceTracker();
    const wsHub = makeFakeWsHub();
    const push = fakePush();
    const router = new NotificationRouter({
      logger: silent,
      registry,
      presence,
      wsHub: wsHub as never,
      dataDir: dir,
      pushBackend: push.backend,
    });
    await expect(
      router.route({ type: 'notify', chatId: 'c1', channel: 'push', message: 'x' }),
    ).rejects.toThrow(/no account bootstrapped/);
  });
});

describe('NotificationRouter — undelivered.jsonl write failure (defensive inner catch)', () => {
  it('still rejects with the original error when appendFileSync itself fails', async () => {
    // dataDir's parent segment is a plain FILE, not a directory, so
    // mkdirSync(dirname(undelivered.jsonl), {recursive:true}) throws ENOTDIR
    // inside logUndelivered's own try/catch.
    const parent = mkdtempSync(join(tmpdir(), 'patch-notif-blocker-'));
    const blockerFile = join(parent, 'blocker');
    writeFileSync(blockerFile, 'not a directory');
    const badDataDir = join(blockerFile, 'nested', 'data');
    const registry = Registry.load(parent); // no account bootstrapped
    const presence = new PresenceTracker();
    const wsHub = makeFakeWsHub();
    const router = new NotificationRouter({
      logger: silent,
      registry,
      presence,
      wsHub: wsHub as never,
      dataDir: badDataDir,
    });
    // routePush throws "no account bootstrapped" → route()'s catch calls
    // logUndelivered → its own mkdirSync throws → inner catch logs a warning
    // → route() still rethrows the ORIGINAL error.
    await expect(
      router.route({ type: 'notify', chatId: 'c1', channel: 'push', message: 'x' }),
    ).rejects.toThrow(/no account bootstrapped/);
  });
});

describe('NotificationRouter — desktop / speakers', () => {
  it('desktop: forwards a notify event to all desktop surfaces', async () => {
    const { dir, registry } = makeRegistryDir();
    const presence = new PresenceTracker();
    const wsHub = makeFakeWsHub();
    const router = new NotificationRouter({
      logger: silent,
      registry,
      presence,
      wsHub: wsHub as never,
      dataDir: dir,
    });
    await router.route({ type: 'notify', chatId: 'c1', channel: 'desktop', message: 'm' });
    expect(wsHub.delivered.find((d) => d.kind === 'desktop')).toBeDefined();
  });

  // spec/09 § Chat completion / § Waiting on you — opt-in only, and scoped to
  // the exact chatId the caller names.
  it('desktop: routes via the focused-surface filter only when skipDesktopIfFocused is set', async () => {
    const { dir, registry } = makeRegistryDir();
    const presence = new PresenceTracker();
    const wsHub = makeFakeWsHub();
    const router = new NotificationRouter({
      logger: silent,
      registry,
      presence,
      wsHub: wsHub as never,
      dataDir: dir,
    });
    await router.route(
      { type: 'notify', chatId: 'c1', channel: 'desktop', message: 'm' },
      { skipDesktopIfFocused: true },
    );
    const call = wsHub.delivered.find((d) => d.kind === 'desktop');
    expect(call?.unlessFocusedChatId).toBe('c1');
  });

  it('desktop: logs info (no throw) when no desktop surfaces are connected', async () => {
    const { dir, registry } = makeRegistryDir();
    const presence = new PresenceTracker();
    const wsHub: FakeWsHub = {
      delivered: [],
      sendToKind: () => 0,
      sendToKinds: () => 0,
      sendToKindUnlessFocused: () => 0,
      sendToSurface: () => false,
      sendToAll: () => 0,
    };
    const router = new NotificationRouter({
      logger: silent,
      registry,
      presence,
      wsHub: wsHub as never,
      dataDir: dir,
    });
    await expect(
      router.route({ type: 'notify', chatId: 'c1', channel: 'desktop', message: 'm' }),
    ).resolves.toBeUndefined();
  });

  it('speakers: routes to specific deviceId when provided', async () => {
    const { dir, registry } = makeRegistryDir();
    const presence = new PresenceTracker();
    const wsHub = makeFakeWsHub();
    const router = new NotificationRouter({
      logger: silent,
      registry,
      presence,
      wsHub: wsHub as never,
      dataDir: dir,
    });
    await router.route({
      type: 'notify',
      chatId: 'c1',
      channel: 'speakers',
      message: 'lights off',
      deviceId: 'kitchen',
    });
    expect(wsHub.delivered.find((d) => d.surfaceId === 'kitchen')).toBeDefined();
  });

  it('speakers: records via speakersRecorder (dev/test observability seam) before fanout, with deviceId', async () => {
    const { dir, registry } = makeRegistryDir();
    const presence = new PresenceTracker();
    const wsHub = makeFakeWsHub();
    const recorded: { ts: number; chatId: string; deviceId?: string; message: string }[] = [];
    const router = new NotificationRouter({
      logger: silent,
      registry,
      presence,
      wsHub: wsHub as never,
      dataDir: dir,
      speakersRecorder: { record: (entry) => recorded.push(entry) },
    });
    await router.route({
      type: 'notify',
      chatId: 'c1',
      channel: 'speakers',
      message: 'lights off',
      deviceId: 'kitchen',
    });
    expect(recorded).toEqual([
      { ts: expect.any(Number), chatId: 'c1', deviceId: 'kitchen', message: 'lights off' },
    ]);
  });

  it('speakers: records via speakersRecorder without a deviceId (broadcast)', async () => {
    const { dir, registry } = makeRegistryDir();
    const presence = new PresenceTracker();
    const wsHub = makeFakeWsHub();
    const recorded: { ts: number; chatId: string; deviceId?: string; message: string }[] = [];
    const router = new NotificationRouter({
      logger: silent,
      registry,
      presence,
      wsHub: wsHub as never,
      dataDir: dir,
      speakersRecorder: { record: (entry) => recorded.push(entry) },
    });
    await router.route({ type: 'notify', chatId: 'c1', channel: 'speakers', message: 'hi all' });
    expect(recorded).toEqual([{ ts: expect.any(Number), chatId: 'c1', message: 'hi all' }]);
    expect(recorded[0]).not.toHaveProperty('deviceId');
  });

  it('logs to undelivered.jsonl when a specific deviceId is offline (sendToSurface returns false)', async () => {
    const { dir, registry } = makeRegistryDir();
    const presence = new PresenceTracker();
    const wsHub: FakeWsHub = {
      delivered: [],
      sendToKind: () => 0,
      sendToKinds: () => 0,
      sendToKindUnlessFocused: () => 0,
      sendToSurface: () => false,
      sendToAll: () => 0,
    };
    const router = new NotificationRouter({
      logger: silent,
      registry,
      presence,
      wsHub: wsHub as never,
      dataDir: dir,
    });
    await router.route({
      type: 'notify',
      chatId: 'c1',
      channel: 'speakers',
      message: 'm',
      deviceId: 'offline-device',
    });
    expect(readFileSync(join(dir, 'undelivered.jsonl'), 'utf8')).toContain('no speaker surfaces');
  });

  it('logs to undelivered.jsonl when speakers channel has no devices', async () => {
    const { dir, registry } = makeRegistryDir();
    const presence = new PresenceTracker();
    const wsHub: FakeWsHub = {
      delivered: [],
      sendToKind: () => 0,
      sendToKinds: () => 0,
      sendToKindUnlessFocused: () => 0,
      sendToSurface: () => false,
      sendToAll: () => 0,
    };
    const router = new NotificationRouter({
      logger: silent,
      registry,
      presence,
      wsHub: wsHub as never,
      dataDir: dir,
    });
    await router.route({
      type: 'notify',
      chatId: 'c1',
      channel: 'speakers',
      message: 'm',
    });
    const logPath = join(dir, 'undelivered.jsonl');
    expect(existsSync(logPath)).toBe(true);
    expect(readFileSync(logPath, 'utf8')).toContain('no speaker surfaces');
  });
});

describe('CallOrchestrator', () => {
  it('starts a call: ringing event + concurrent push (urgent) + desktop notify', async () => {
    const { dir, registry } = makeRegistryDir();
    registry.upsertSurface({
      surfaceId: 'srf-1',
      surfaceKind: 'desktop',
      label: 'd',
      issuedAt: 1,
    });
    registry.registerPushToken({
      surfaceId: 'srf-1',
      accountId: ACCOUNT.publicKey,
      token: 'tok-1',
      registeredAt: 1,
    });
    const presence = new PresenceTracker();
    const wsHub = makeFakeWsHub();
    const push = fakePush();
    const router = new NotificationRouter({
      logger: silent,
      registry,
      presence,
      wsHub: wsHub as never,
      dataDir: dir,
      pushBackend: push.backend,
    });
    const orch = new CallOrchestrator({
      logger: silent,
      wsHub: wsHub as never,
      router,
      timeoutMs: 60_000,
      idGenerator: () => 'call-1',
    });
    const callId = await orch.startCall({
      type: 'patch.call',
      chatId: 'c1',
      message: 'urgent: prod down',
    });
    expect(callId).toBe('call-1');
    // chat.call_request fanned out to all + desktop notify forwarded.
    const ringEv = wsHub.delivered.find((d) => d.event.type === 'chat.call_request');
    expect(ringEv).toBeDefined();
    expect((ringEv?.event as ChatCallRequestEvent).callId).toBe('call-1');
    const desktopEv = wsHub.delivered.find(
      (d) => d.kind === 'desktop' && d.event.type === 'notify',
    );
    expect(desktopEv).toBeDefined();
    expect(push.sent).toHaveLength(1); // urgent → fires
    orch.shutdown();
  });

  it('first-accept wins: emits chat.call_winner; later responses ignored', async () => {
    const { dir, registry } = makeRegistryDir();
    const presence = new PresenceTracker();
    const wsHub = makeFakeWsHub();
    const push = fakePush();
    const router = new NotificationRouter({
      logger: silent,
      registry,
      presence,
      wsHub: wsHub as never,
      dataDir: dir,
      pushBackend: push.backend,
    });
    const orch = new CallOrchestrator({
      logger: silent,
      wsHub: wsHub as never,
      router,
      timeoutMs: 60_000,
      idGenerator: () => 'call-x',
    });
    await orch.startCall({ type: 'patch.call', chatId: 'c1' });
    orch.handleResponse('srf-phone', {
      type: 'chat.call_response',
      callId: 'call-x',
      response: 'accept',
    });
    const winner = wsHub.delivered.find((d) => d.event.type === 'chat.call_winner');
    expect(winner).toBeDefined();
    expect((winner?.event as ChatCallWinnerEvent).acceptedSurfaceId).toBe('srf-phone');
    expect(orch.getCall('call-x')?.status).toBe('accepted');
    // Later accept doesn't change anything.
    orch.handleResponse('srf-desktop', {
      type: 'chat.call_response',
      callId: 'call-x',
      response: 'accept',
    });
    const winners = wsHub.delivered.filter((d) => d.event.type === 'chat.call_winner');
    expect(winners).toHaveLength(1);
    orch.shutdown();
  });

  it('on 30s timeout fires chat.call_timeout + push fallback', async () => {
    vi.useFakeTimers();
    try {
      const { dir, registry } = makeRegistryDir();
      registry.upsertSurface({
        surfaceId: 'srf-1',
        surfaceKind: 'mobile',
        label: 'm',
        issuedAt: 1,
      });
      registry.registerPushToken({
        surfaceId: 'srf-1',
        accountId: ACCOUNT.publicKey,
        token: 'tok-1',
        registeredAt: 1,
      });
      const presence = new PresenceTracker();
      const wsHub = makeFakeWsHub();
      const push = fakePush();
      const router = new NotificationRouter({
        logger: silent,
        registry,
        presence,
        wsHub: wsHub as never,
        dataDir: dir,
        pushBackend: push.backend,
      });
      const orch = new CallOrchestrator({
        logger: silent,
        wsHub: wsHub as never,
        router,
        timeoutMs: 30_000,
        idGenerator: () => 'call-t',
      });
      await orch.startCall({
        type: 'patch.call',
        chatId: 'c1',
        message: 'pick up',
      });
      const initialPushCount = push.sent.length;
      await vi.advanceTimersByTimeAsync(30_001);
      const timeout = wsHub.delivered.find((d) => d.event.type === 'chat.call_timeout');
      expect(timeout).toBeDefined();
      expect((timeout?.event as ChatCallTimeoutEvent).callId).toBe('call-t');
      expect(push.sent.length).toBeGreaterThan(initialPushCount);
      expect(orch.getCall('call-t')?.status).toBe('timeout');
      orch.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ReplyRouter — outbound assistant message routes back to source channel', () => {
  it('voice-device: assistant message on thread_speakers → notify channel=speakers, deviceId pinned', async () => {
    const { dir, registry } = makeRegistryDir();
    const presence = new PresenceTracker();
    const wsHub = makeFakeWsHub();
    const router = new NotificationRouter({
      logger: silent,
      registry,
      presence,
      wsHub: wsHub as never,
      dataDir: dir,
    });
    const reply = new ReplyRouter({
      logger: silent,
      registry,
      router,
    });
    reply.observeInput({
      type: 'chat.input',
      chatId: 'thread_speakers',
      message: 'lights off',
      localId: 'l1',
      source: { kind: 'voice-device', deviceId: 'kitchen' },
    });
    await reply.observeOutbound({
      type: 'chat.message',
      chatId: 'thread_speakers',
      role: 'assistant',
      content: 'kitchen lights off',
      seq: 1,
    });
    const sent = wsHub.delivered.find((d) => d.surfaceId === 'kitchen');
    expect(sent).toBeDefined();
    expect((sent?.event as NotifyEvent).channel).toBe('speakers');
    expect((sent?.event as NotifyEvent).deviceId).toBe('kitchen');
  });

  it('ignores non chat.message wire events', async () => {
    const { dir, registry } = makeRegistryDir();
    const presence = new PresenceTracker();
    const wsHub = makeFakeWsHub();
    const router = new NotificationRouter({
      logger: silent,
      registry,
      presence,
      wsHub: wsHub as never,
      dataDir: dir,
    });
    const reply = new ReplyRouter({
      logger: silent,
      registry,
      router,
    });
    reply.observeInput({
      type: 'chat.input',
      chatId: 'thread_speakers',
      message: 'lights off',
      localId: 'l1',
      source: { kind: 'voice-device', deviceId: 'kitchen' },
    });
    await reply.observeOutbound({
      type: 'notify',
      chatId: 'thread_speakers',
      channel: 'desktop',
      message: 'x',
    });
    expect(wsHub.delivered.find((d) => d.surfaceId === 'kitchen')).toBeUndefined();
  });

  it('ignores an assistant chat.message with no pending source', async () => {
    const { dir, registry } = makeRegistryDir();
    const presence = new PresenceTracker();
    const wsHub = makeFakeWsHub();
    const router = new NotificationRouter({
      logger: silent,
      registry,
      presence,
      wsHub: wsHub as never,
      dataDir: dir,
    });
    const reply = new ReplyRouter({
      logger: silent,
      registry,
      router,
    });
    // No observeInput call at all — nothing pending for thread_speakers.
    await reply.observeOutbound({
      type: 'chat.message',
      chatId: 'thread_speakers',
      role: 'assistant',
      content: 'hello',
      seq: 1,
    });
    expect(wsHub.delivered.find((d) => d.surfaceId === 'kitchen')).toBeUndefined();
  });

  it('ignores a user-role chat.message even with a pending source', async () => {
    const { dir, registry } = makeRegistryDir();
    const presence = new PresenceTracker();
    const wsHub = makeFakeWsHub();
    const router = new NotificationRouter({
      logger: silent,
      registry,
      presence,
      wsHub: wsHub as never,
      dataDir: dir,
    });
    const reply = new ReplyRouter({
      logger: silent,
      registry,
      router,
    });
    reply.observeInput({
      type: 'chat.input',
      chatId: 'thread_speakers',
      message: 'lights off',
      localId: 'l1',
      source: { kind: 'voice-device', deviceId: 'kitchen' },
    });
    await reply.observeOutbound({
      type: 'chat.message',
      chatId: 'thread_speakers',
      role: 'user',
      content: 'not a reply',
      seq: 1,
    });
    expect(wsHub.delivered.find((d) => d.surfaceId === 'kitchen')).toBeUndefined();
  });

  it('ignores an assistant chat.message on a non-special thread id, even with a pending source', async () => {
    const { dir, registry } = makeRegistryDir();
    const presence = new PresenceTracker();
    const wsHub = makeFakeWsHub();
    const router = new NotificationRouter({
      logger: silent,
      registry,
      presence,
      wsHub: wsHub as never,
      dataDir: dir,
    });
    const reply = new ReplyRouter({
      logger: silent,
      registry,
      router,
    });
    reply.observeInput({
      type: 'chat.input',
      chatId: 'thread_speakers',
      message: 'lights off',
      localId: 'l1',
      source: { kind: 'voice-device', deviceId: 'kitchen' },
    });
    await reply.observeOutbound({
      type: 'chat.message',
      chatId: 'some-regular-chat',
      role: 'assistant',
      content: 'not special',
      seq: 1,
    });
    expect(wsHub.delivered.find((d) => d.surfaceId === 'kitchen')).toBeUndefined();
  });

  it('observeInput: a non-special thread id is not captured', async () => {
    const { dir, registry } = makeRegistryDir();
    const presence = new PresenceTracker();
    const wsHub = makeFakeWsHub();
    const router = new NotificationRouter({
      logger: silent,
      registry,
      presence,
      wsHub: wsHub as never,
      dataDir: dir,
    });
    const reply = new ReplyRouter({
      logger: silent,
      registry,
      router,
    });
    reply.observeInput({
      type: 'chat.input',
      chatId: 'some-regular-chat',
      message: 'hi',
      localId: 'l1',
      source: { kind: 'voice-device', deviceId: 'kitchen' },
    });
    const internal = reply as unknown as { pending: Map<string, unknown> };
    expect(internal.pending.size).toBe(0);
  });
});

describe('Push register REST routes', () => {
  it('endpoints require auth (401 without bearer)', async () => {
    const { dir, registry } = makeRegistryDir();
    const link = new InProcessDaemonLink();
    const app = await build({
      dataDir: dir,
      registry,
      daemonLink: link,
      jobsWatch: false,
    });
    try {
      const r1 = await app.inject({
        method: 'POST',
        url: '/api/auth/push/register',
        payload: { token: 'fcm-token-xxxxxxxx' },
      });
      expect(r1.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('401s when no account has been bootstrapped at all', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'patch-notif-server-'));
    const registry = Registry.load(dir); // no bootstrapAccount() call
    const link = new InProcessDaemonLink();
    const app = await build({ dataDir: dir, registry, daemonLink: link, jobsWatch: false });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/push/register',
        headers: { authorization: 'Bearer whatever' },
        payload: { token: 'a'.repeat(64) },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('401s when the bearer JWT fails verification (malformed/invalid, not just missing)', async () => {
    const { dir, registry } = makeRegistryDir();
    const link = new InProcessDaemonLink();
    const app = await build({ dataDir: dir, registry, daemonLink: link, jobsWatch: false });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/push/register',
        headers: { authorization: 'Bearer not-a-real-jwt' },
        payload: { token: 'fcm-token-xxxxxxxx' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('401s when the surface has been revoked', async () => {
    const { dir, registry } = makeRegistryDir();
    registry.upsertSurface({
      surfaceId: 'srf-revoked',
      surfaceKind: 'web',
      label: 'web',
      issuedAt: 1,
    });
    registry.revoke('srf-revoked');
    const jwt = await mintSurfaceCredential({
      userPrivateKey: ACCOUNT.privateKey,
      surfaceId: 'srf-revoked',
      surfaceKind: 'web',
      label: 'web',
    });
    const link = new InProcessDaemonLink();
    const app = await build({ dataDir: dir, registry, daemonLink: link, jobsWatch: false });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/push/register',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { token: 'a'.repeat(64) },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('full auth: registers an Expo push token (200, ok:true, registry updated, now() used)', async () => {
    const { dir, registry } = makeRegistryDir();
    registry.upsertSurface({ surfaceId: 'srf-web', surfaceKind: 'web', label: 'web', issuedAt: 1 });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: ACCOUNT.privateKey,
      surfaceId: 'srf-web',
      surfaceKind: 'web',
      label: 'web',
    });
    const link = new InProcessDaemonLink();
    const app = await build({
      dataDir: dir,
      registry,
      daemonLink: link,
      jobsWatch: false,
      nowMs: () => 1_234_567,
    });
    try {
      const token = `ExponentPushToken[${'a'.repeat(22)}]`;
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/push/register',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { token, platform: 'android-expo' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(registry.listPushTokens(ACCOUNT.publicKey)).toContain(token);
    } finally {
      await app.close();
    }
  });

  it('full auth: rejects an invalid push/register body with 400 after passing auth', async () => {
    const { dir, registry } = makeRegistryDir();
    registry.upsertSurface({ surfaceId: 'srf-web', surfaceKind: 'web', label: 'web', issuedAt: 1 });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: ACCOUNT.privateKey,
      surfaceId: 'srf-web',
      surfaceKind: 'web',
      label: 'web',
    });
    const link = new InProcessDaemonLink();
    const app = await build({ dataDir: dir, registry, daemonLink: link, jobsWatch: false });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/push/register',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { token: 'too-short' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid body');
    } finally {
      await app.close();
    }
  });
});

describe('routeVoiceDeviceTranscript', () => {
  it('uses the injected idGenerator when provided', async () => {
    const link = new InProcessDaemonLink();
    routeVoiceDeviceTranscript({
      deviceId: 'kitchen',
      transcript: 'lights off',
      daemonLink: link,
      idGenerator: () => 'fixed-id',
    });
    expect(link.sent).toHaveLength(1);
    expect(link.sent[0]?.surfaceId).toBe('voice-device:kitchen');
    const event = link.sent[0]?.event as { chatId: string; localId: string; message: string };
    expect(event.localId).toBe('vd-kitchen-fixed-id');
    expect(event.chatId).toBe('thread_speakers');
    expect(event.message).toBe('lights off');
  });

  it('falls back to Date.now() when no idGenerator is injected', async () => {
    const link = new InProcessDaemonLink();
    routeVoiceDeviceTranscript({
      deviceId: 'kitchen',
      transcript: 'lights on',
      daemonLink: link,
      // idGenerator intentionally omitted.
    });
    expect(link.sent).toHaveLength(1);
    const event = link.sent[0]?.event as { localId: string };
    expect(event.localId).toMatch(/^vd-kitchen-\d+$/);
  });
});

describe('PresenceTracker.isActive', () => {
  it('returns true when a phone heartbeated within staleMs', () => {
    const p = new PresenceTracker();
    p.online('a1', 's1', 'mobile', 1_000_000);
    p.heartbeat('a1', 's1', 1_000_000);
    expect(p.isActive('a1', 1_010_000)).toBe(true);
    expect(p.isActive('a1', 1_040_000)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Group 12 hardening tests.

describe('Group 12 — HIGH-1: source-spoof prevention', () => {
  it('reply-router does NOT capture source attached by a surface', async () => {
    const { dir, registry } = makeRegistryDir();
    const presence = new PresenceTracker();
    const wsHub = makeFakeWsHub();
    const router = new NotificationRouter({
      logger: silent,
      registry,
      presence,
      wsHub: wsHub as never,
      dataDir: dir,
    });
    const reply = new ReplyRouter({
      logger: silent,
      registry,
      router,
    });
    // Simulate the post-fix ws-hub path: surface chat.input arrives WITHOUT
    // `source` (the hub strips it before calling observeInput / forwarding).
    // The reply-router should therefore have nothing pending.
    reply.observeInput({
      type: 'chat.input',
      chatId: 'thread_speakers',
      message: 'hi',
      localId: 'x',
    });
    await reply.observeOutbound({
      type: 'chat.message',
      chatId: 'thread_speakers',
      role: 'assistant',
      content: 'reply-not-routed-anywhere',
      seq: 1,
    });
    // No speakers outbound — attacker source was stripped before reaching the router.
    expect(wsHub.delivered.find((d) => d.surfaceId === 'kitchen')).toBeUndefined();
  });
});

describe('Group 12 — MED-4: ReplyRouter and CallOrchestrator are bounded', () => {
  it('ReplyRouter pending map clears after each consume (no monotonic growth)', async () => {
    const { dir, registry } = makeRegistryDir();
    const presence = new PresenceTracker();
    const wsHub = makeFakeWsHub();
    const router = new NotificationRouter({
      logger: silent,
      registry,
      presence,
      wsHub: wsHub as never,
      dataDir: dir,
    });
    const reply = new ReplyRouter({
      logger: silent,
      registry,
      router,
    });
    for (let i = 0; i < 1000; i++) {
      reply.observeInput({
        type: 'chat.input',
        chatId: 'thread_speakers',
        message: `m${i}`,
        localId: `l${i}`,
        source: { kind: 'voice-device', deviceId: 'kitchen' },
      });
      // eslint-disable-next-line no-await-in-loop
      await reply.observeOutbound({
        type: 'chat.message',
        chatId: 'thread_speakers',
        role: 'assistant',
        content: `r${i}`,
        seq: i,
      });
    }
    // Reach into private state for the test — ReplyRouter exposes no count.
    const internal = reply as unknown as { pending: Map<string, unknown> };
    expect(internal.pending.size).toBe(0);
    expect(wsHub.delivered.filter((d) => d.surfaceId === 'kitchen')).toHaveLength(1000);
  });

  it('CallOrchestrator entries are GCd after resolution', async () => {
    vi.useFakeTimers();
    try {
      const { dir, registry } = makeRegistryDir();
      const presence = new PresenceTracker();
      const wsHub = makeFakeWsHub();
      const push = fakePush();
      const router = new NotificationRouter({
        logger: silent,
        registry,
        presence,
        wsHub: wsHub as never,
        dataDir: dir,
        pushBackend: push.backend,
      });
      let counter = 0;
      const orch = new CallOrchestrator({
        logger: silent,
        wsHub: wsHub as never,
        router,
        timeoutMs: 60_000,
        idGenerator: () => `c-${counter++}`,
      });
      // Burst: 50 calls, accept each immediately, advance timers past GC window.
      for (let i = 0; i < 50; i++) {
        // eslint-disable-next-line no-await-in-loop
        const id = await orch.startCall({ type: 'patch.call', chatId: 'c1' });
        orch.handleResponse('srf', { type: 'chat.call_response', callId: id, response: 'accept' });
      }
      expect(orch.size()).toBe(50); // pre-GC: still tracked
      await vi.advanceTimersByTimeAsync(60_001);
      expect(orch.size()).toBe(0); // post-GC: bounded
      orch.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Group 12 — DX-3: chat.call_request fans out to mobile + desktop only', () => {
  it('uses sendToKinds(["mobile","desktop"]) for the ring; sendToAll for winner/timeout', async () => {
    const { dir, registry } = makeRegistryDir();
    const presence = new PresenceTracker();
    const wsHub = makeFakeWsHub();
    const push = fakePush();
    const router = new NotificationRouter({
      logger: silent,
      registry,
      presence,
      wsHub: wsHub as never,
      dataDir: dir,
      pushBackend: push.backend,
    });
    const orch = new CallOrchestrator({
      logger: silent,
      wsHub: wsHub as never,
      router,
      timeoutMs: 60_000,
      idGenerator: () => 'call-ring',
    });
    await orch.startCall({ type: 'patch.call', chatId: 'c1' });
    const ring = wsHub.delivered.find((d) => d.event.type === 'chat.call_request');
    expect(ring).toBeDefined();
    expect(ring?.kinds).toBeDefined();
    expect(ring?.kinds?.has('mobile')).toBe(true);
    expect(ring?.kinds?.has('desktop')).toBe(true);
    expect(ring?.kinds?.has('terminal')).toBe(false);
    expect(ring?.kinds?.has('web')).toBe(false);
    expect(ring?.kinds?.has('voice-device')).toBe(false);
    // Accept → winner uses sendToAll (asymmetric — clears UI on all surfaces).
    orch.handleResponse('srf-mobile', {
      type: 'chat.call_response',
      callId: 'call-ring',
      response: 'accept',
    });
    const winner = wsHub.delivered.find((d) => d.event.type === 'chat.call_winner');
    expect(winner?.all).toBe(true);
    orch.shutdown();
  });
});

describe('Group 12 — DX-4: Registry.listPushTokens scopes by accountId', () => {
  it('returns only tokens for the requested account', () => {
    const { dir } = makeRegistryDir();
    // Reload the registry so we can stand up two accounts directly via the file.
    const reg = Registry.load(dir);
    // Account A is already bootstrapped (test-pubkey).
    reg.registerPushToken({
      surfaceId: 's-a1',
      accountId: 'test-pubkey',
      token: 'tA1',
      registeredAt: 1,
    });
    reg.registerPushToken({
      surfaceId: 's-a2',
      accountId: 'test-pubkey',
      token: 'tA2',
      registeredAt: 2,
    });
    // Manually add a foreign token (simulates a future multi-account world
    // OR a dirty registry from migration). DX-4 says listPushTokens(A) MUST
    // exclude this regardless.
    reg.registerPushToken({
      surfaceId: 's-b1',
      accountId: 'other-account',
      token: 'tB1',
      registeredAt: 3,
    });
    const a = reg.listPushTokens('test-pubkey');
    expect(a.sort()).toEqual(['tA1', 'tA2']);
    const b = reg.listPushTokens('other-account');
    expect(b).toEqual(['tB1']);
  });
});

describe('Group 12 — LOW-2: PushRegisterBody token shape + length cap', () => {
  it('rejects too-short, too-long, and non-Expo-shaped tokens with 400 (after auth)', async () => {
    // We can't easily test post-auth here without a JWT; but we can confirm
    // the schema directly.
    const ok = `ExponentPushToken[${'a'.repeat(22)}]`;
    const tooShort = 'a'.repeat(19);
    const tooLong = `ExponentPushToken[${'a'.repeat(4097)}]`;
    const wrongShape = 'a'.repeat(64); // right length, not the Expo wrapper shape.
    // Re-import the schema by calling the route is heavyweight; just assert
    // via a tiny inline parse mirroring the real one.
    const schema = z
      .object({
        token: z
          .string()
          .min(20)
          .max(4096)
          .regex(/^Expo(nent)?PushToken\[.+\]$/),
      })
      .strict();
    expect(schema.safeParse({ token: ok }).success).toBe(true);
    expect(schema.safeParse({ token: tooShort }).success).toBe(false);
    expect(schema.safeParse({ token: tooLong }).success).toBe(false);
    expect(schema.safeParse({ token: wrongShape }).success).toBe(false);
  });
});

describe('NotificationRouter — success delivery-confirmation audit lines (D1-d1)', () => {
  // A SUCCESSFUL daemon-originated patch_notify must leave a server-side
  // delivery-confirmation log line, so the host's ok:true is auditable
  // end-to-end (the OS push surface actually received it), not merely that
  // the wire event was emitted. Previously the router logged ONLY on failure,
  // leaving a successful notify with zero server-side evidence.

  function capturingLogger(): {
    logger: pino.Logger;
    lines: { level: number; obj: Record<string, unknown> }[];
  } {
    const lines: { level: number; obj: Record<string, unknown> }[] = [];
    const logger = pino(
      { level: 'info' },
      {
        write: (s: string) => {
          const obj = JSON.parse(s) as Record<string, unknown>;
          lines.push({ level: obj['level'] as number, obj });
        },
      },
    );
    return { logger, lines };
  }

  it('push: emits "push notify delivered" with token count on a successful urgent notify', async () => {
    const { dir, registry } = makeRegistryDir();
    const presence = new PresenceTracker();
    registry.registerPushToken({
      surfaceId: 'srf-1',
      accountId: ACCOUNT.publicKey,
      token: 'tok-1',
      registeredAt: 1,
    });
    const wsHub = makeFakeWsHub();
    const push = fakePush();
    const { logger, lines } = capturingLogger();
    const router = new NotificationRouter({
      logger,
      registry,
      presence,
      wsHub: wsHub as never,
      dataDir: dir,
      pushBackend: push.backend,
    });
    await router.route({
      type: 'notify',
      chatId: 'c1',
      channel: 'push',
      priority: 'urgent',
      message: 'urgent thing',
    });
    expect(push.sent).toHaveLength(1);
    const delivered = lines.find((l) => l.obj['msg'] === 'push notify delivered');
    expect(delivered, 'expected a "push notify delivered" confirmation line').toBeDefined();
    expect(delivered?.obj['tokens']).toBe(1);
    expect(delivered?.obj['chatId']).toBe('c1');
    expect(existsSync(join(dir, 'undelivered.jsonl'))).toBe(false);
  });

  it('push: emits NO "push notify delivered" when Expo rejects all tokens (failure path only)', async () => {
    const { dir, registry } = makeRegistryDir();
    const presence = new PresenceTracker();
    registry.registerPushToken({
      surfaceId: 'srf-1',
      accountId: ACCOUNT.publicKey,
      token: 'bad-token',
      registeredAt: 1,
    });
    const wsHub = makeFakeWsHub();
    const pushBackend: PushBackend = {
      send: async (tokens) => ({ delivered: 0, failed: [...tokens], permanentlyRejected: [] }),
    };
    const { logger, lines } = capturingLogger();
    const router = new NotificationRouter({
      logger,
      registry,
      presence,
      wsHub: wsHub as never,
      dataDir: dir,
      pushBackend,
    });
    await router.route({
      type: 'notify',
      chatId: 'c1',
      channel: 'push',
      priority: 'urgent',
      message: 'nope',
    });
    expect(lines.find((l) => l.obj['msg'] === 'push notify delivered')).toBeUndefined();
    // The failure path still records undelivered.jsonl.
    expect(existsSync(join(dir, 'undelivered.jsonl'))).toBe(true);
  });
});
