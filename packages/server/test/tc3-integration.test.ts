// TC3 integration — server-side notification pipeline against a RUNNING server.
//
// This is NOT a unit test of NotificationRouter in isolation. It boots the
// real `buildAll` server (the same entry `pnpm --filter @patch/server dev`
// uses), has it LISTEN on a real TCP port, connects real WebSocket surface
// clients through the real JWT hello handshake, and drives the full C3 path:
//   host → InProcessDaemonLink.emit(notify|patch.call) → server's
//   daemonLink.onEvent wiring → NotificationRouter / CallOrchestrator →
//   real PresenceTracker / Registry (real registry.json file IO) / real WsHub
//   fanout to real connected sockets / real /data/undelivered.jsonl writes.
//
// The push backend is an injected mock — spec/09 + the C3 task line
// "test that the routing resolution logic and fallback chain work correctly
// with mock devices" explicitly permit this for this group.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { generateUserKeypair, mintSurfaceCredential, type UserKeypair } from '@patch/auth';
import { WireTestClient } from '@patch/wire/test-client';
import type { NotifyEvent, PatchCallEvent, ChatCallResponseEvent, SurfaceKind } from '@patch/wire';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';
import type { PushBackend } from '../src/notifications/router.js';

// One account keypair shared by the server account + every surface credential
// (single-account system; the WS auth gate verifies surface creds against the
// stored account public key).
const ACCOUNT_KP: UserKeypair = generateUserKeypair();
const ACCOUNT_PUBKEY = ACCOUNT_KP.publicKey;

function fakePush() {
  const sent: { tokens: string[]; payload: { body: string; urgent?: boolean } }[] = [];
  const backend: PushBackend = {
    send: async (tokens, payload) => {
      sent.push({ tokens, payload: { body: payload.body, urgent: payload.urgent } });
      return { delivered: tokens.length, failed: [], permanentlyRejected: [] };
    },
  };
  return { sent, backend };
}

function fakePushThatThrows() {
  const backend: PushBackend = {
    send: async () => {
      throw new Error('Expo push rejected token');
    },
  };
  return { backend };
}

interface Harness {
  url: string;
  registry: Registry;
  daemonLink: InProcessDaemonLink;
  dataDir: string;
  push: ReturnType<typeof fakePush>;
  presenceOnline: (surfaceId: string, nowMs?: number) => void;
  close: () => Promise<void>;
  app: Awaited<ReturnType<typeof buildAll>>;
}

async function startServer(opts: {
  dir: string;
  push?: { backend: PushBackend; sent?: unknown[] };
  callTimeoutMs?: number;
}): Promise<Harness> {
  const registry = Registry.load(opts.dir);
  registry.bootstrapAccount({ keypair: ACCOUNT_KP });
  const daemonLink = new InProcessDaemonLink();
  const push = (opts.push as ReturnType<typeof fakePush>) ?? fakePush();
  const built = await buildAll({
    logger: false,
    registry,
    daemonLink,
    pushBackend: push.backend,
    ...(opts.callTimeoutMs !== undefined ? { callTimeoutMs: opts.callTimeoutMs } : {}),
  });
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = built.app.server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${addr.port}/ws`,
    registry,
    daemonLink,
    dataDir: opts.dir,
    push,
    // A web surface the user is using right now: online, and input just now.
    presenceOnline: (surfaceId, nowMs) => {
      built.presence.online(ACCOUNT_PUBKEY, surfaceId, 'web', nowMs);
      built.presence.input(ACCOUNT_PUBKEY, surfaceId, 0, nowMs);
    },
    app: built,
    close: async () => {
      built.callOrchestrator.shutdown();
      built.wsHub.shutdown();
      await built.app.close();
    },
  };
}

// Connect a real authed surface WS client through the real hello handshake.
async function connectSurface(
  url: string,
  registry: Registry,
  surfaceId: string,
  surfaceKind: SurfaceKind,
): Promise<WireTestClient> {
  // Register the surface so the server's auth gate accepts the credential.
  registry.upsertSurface({ surfaceId, surfaceKind, label: surfaceId, issuedAt: Date.now() });
  // Sign with the shared account keypair so verifySurfaceCredential succeeds
  // against the stored account public key.
  const cred = await mintSurfaceCredential({
    userPrivateKey: ACCOUNT_KP.privateKey,
    surfaceId,
    surfaceKind,
    label: surfaceId,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  });
  const client = new WireTestClient({
    url,
    clientType: surfaceKind === 'desktop' ? 'surface-desktop' : 'surface-mobile',
    auth: cred,
  });
  const authed = client.waitFor('auth.ok', undefined, 4000);
  await client.connect();
  // Block until the server confirms registration so fanout can find the surface.
  await authed;
  return client;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tc3-srv-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('TC3 [test-runner] push channel — suppression / urgent override (running server)', () => {
  it('B1 push fires when NO surface heartbeat in last 30s', async () => {
    const h = await startServer({ dir });
    h.registry.registerPushToken({
      surfaceId: 'phone',
      accountId: ACCOUNT_PUBKEY,
      token: 'expo-token-aaa',
      registeredAt: Date.now(),
    });
    try {
      const notify: NotifyEvent = {
        type: 'notify',
        chatId: 'chat-1',
        channel: 'push',
        message: 'build done',
      };
      h.daemonLink.emit(notify);
      await waitUntil(() => h.push.sent.length === 1);
      expect(h.push.sent[0]?.payload.body).toBe('build done');
    } finally {
      await h.close();
    }
  });

  it('B2 push SUPPRESSED while the user is at a computer (non-urgent)', async () => {
    const h = await startServer({ dir });
    h.registry.registerPushToken({
      surfaceId: 'phone',
      accountId: ACCOUNT_PUBKEY,
      token: 'expo-token-aaa',
      registeredAt: Date.now(),
    });
    h.presenceOnline('web-surface'); // input just now ⇒ isActive() true
    try {
      h.daemonLink.emit({ type: 'notify', chatId: 'c', channel: 'push', message: 'quiet' });
      await sleep(150);
      expect(h.push.sent.length).toBe(0); // suppressed
    } finally {
      await h.close();
    }
  });

  it('B3 urgent is suppressed like normal — it differs only in its sound', async () => {
    const h = await startServer({ dir });
    h.registry.registerPushToken({
      surfaceId: 'phone',
      accountId: ACCOUNT_PUBKEY,
      token: 'expo-token-aaa',
      registeredAt: Date.now(),
    });
    h.presenceOnline('web-surface');
    try {
      h.daemonLink.emit({
        type: 'notify',
        chatId: 'c',
        channel: 'push',
        message: 'LEAVE NOW',
        priority: 'urgent',
      });
      await sleep(150);
      expect(h.push.sent).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it('B11 push backend failure is logged to /data/undelivered.jsonl', async () => {
    const h = await startServer({ dir, push: fakePushThatThrows() });
    h.registry.registerPushToken({
      surfaceId: 'phone',
      accountId: ACCOUNT_PUBKEY,
      token: 'expo-token-aaa',
      registeredAt: Date.now(),
    });
    try {
      h.daemonLink.emit({ type: 'notify', chatId: 'c', channel: 'push', message: 'oops' });
      const path = join(h.dataDir, 'undelivered.jsonl');
      await waitUntil(() => existsSync(path) && readFileSync(path, 'utf8').includes('oops'));
      const entry = JSON.parse(readFileSync(path, 'utf8').trim().split('\n').pop() as string);
      expect(entry).toMatchObject({ channel: 'push', message: 'oops' });
      expect(entry.error).toContain('Expo push rejected');
    } finally {
      await h.close();
    }
  });

  it('C3-d1 a permanently-rejected Expo push token is pruned and not re-attempted on the next push', async () => {
    // A push backend that permanently rejects the dead token (Expo's
    // DeviceNotRegistered code) and accepts the good one.
    const sent: { tokens: string[] }[] = [];
    const backend: PushBackend = {
      send: async (tokens) => {
        sent.push({ tokens });
        const failed = tokens.filter((t) => t === 'dead-token');
        return {
          delivered: tokens.length - failed.length,
          failed,
          permanentlyRejected: failed,
        };
      },
    };
    const h = await startServer({ dir, push: { backend } });
    h.registry.registerPushToken({
      surfaceId: 'phone-good',
      accountId: ACCOUNT_PUBKEY,
      token: 'good-token',
      registeredAt: Date.now(),
    });
    h.registry.registerPushToken({
      surfaceId: 'phone-dead',
      accountId: ACCOUNT_PUBKEY,
      token: 'dead-token',
      registeredAt: Date.now(),
    });
    const path = join(h.dataDir, 'undelivered.jsonl');
    try {
      // First urgent push: dead token rejected + logged + pruned.
      h.daemonLink.emit({
        type: 'notify',
        chatId: 'c',
        channel: 'push',
        message: 'first',
        priority: 'urgent',
      });
      await waitUntil(() => sent.length === 1);
      await waitUntil(() => existsSync(path) && readFileSync(path, 'utf8').includes('dead-token'));
      // The dead token is gone from the registry; the good one remains.
      await waitUntil(() => h.registry.listPushTokens(ACCOUNT_PUBKEY).length === 1);
      expect(h.registry.listPushTokens(ACCOUNT_PUBKEY)).toEqual(['good-token']);

      const linesAfterFirst = readFileSync(path, 'utf8').trim().split('\n').length;

      // Second urgent push: must NOT re-attempt the dead token and must NOT
      // append another 'Expo push rejected' line for it.
      h.daemonLink.emit({
        type: 'notify',
        chatId: 'c',
        channel: 'push',
        message: 'second',
        priority: 'urgent',
      });
      await waitUntil(() => sent.length === 2);
      await sleep(150);
      expect(sent[1]?.tokens).toEqual(['good-token']);
      const linesAfterSecond = readFileSync(path, 'utf8').trim().split('\n').length;
      expect(linesAfterSecond).toBe(linesAfterFirst); // no new undelivered line
    } finally {
      await h.close();
    }
  });
});

describe('TC3 [test-runner] desktop channel — always fires (running server + real WS surface)', () => {
  it('B4 desktop notify fans out to a connected desktop surface regardless of presence', async () => {
    const h = await startServer({ dir });
    const desktop = await connectSurface(h.url, h.registry, 'desk-1', 'desktop');
    // Make a phone surface active too — desktop must STILL fire (always-on).
    h.presenceOnline('phone-surface');
    try {
      const got = desktop.waitFor('notify', undefined, 3000);
      h.daemonLink.emit({
        type: 'notify',
        chatId: 'chat-x',
        channel: 'desktop',
        message: 'toast me',
      });
      const ev = await got;
      expect(ev).toMatchObject({ channel: 'desktop', message: 'toast me' });
    } finally {
      await desktop.close();
      await h.close();
    }
  });
});

describe('TC3 [test-runner] speakers channel server fanout — undelivered on no devices', () => {
  it('B6 speakers notify with no voice-device surfaces online logs undelivered', async () => {
    const h = await startServer({ dir });
    try {
      h.daemonLink.emit({ type: 'notify', chatId: 'c', channel: 'speakers', message: 'spoke' });
      const path = join(h.dataDir, 'undelivered.jsonl');
      await waitUntil(() => existsSync(path) && readFileSync(path, 'utf8').includes('spoke'));
      const entry = JSON.parse(readFileSync(path, 'utf8').trim().split('\n').pop() as string);
      expect(entry.channel).toBe('speakers');
      expect(entry.error).toContain('no speaker surfaces');
    } finally {
      await h.close();
    }
  });
});

describe('TC3 [test-runner] patch_call — concurrent ring, first-accept-wins, 30s push fallback', () => {
  it('B7 patch.call rings ringer surfaces + fires urgent push concurrently', async () => {
    const h = await startServer({ dir, callTimeoutMs: 60_000 });
    h.registry.registerPushToken({
      surfaceId: 'phone',
      accountId: ACCOUNT_PUBKEY,
      token: 'expo-token-aaa',
      registeredAt: Date.now(),
    });
    const mobile = await connectSurface(h.url, h.registry, 'phone-srf', 'mobile');
    try {
      const ring = mobile.waitFor('chat.call_request', undefined, 3000);
      const call: PatchCallEvent = {
        type: 'patch.call',
        chatId: 'project-chat',
        message: 'I need a decision',
      };
      h.daemonLink.emit(call);
      const ringEv = await ring;
      expect(ringEv).toMatchObject({ type: 'chat.call_request', chatId: 'project-chat' });
      // Concurrent urgent push also fired.
      await waitUntil(() => h.push.sent.some((p) => p.payload.urgent === true));
    } finally {
      await mobile.close();
      await h.close();
    }
  });

  it('B8 first accept wins: winner broadcast, call resolves', async () => {
    const h = await startServer({ dir, callTimeoutMs: 60_000 });
    const mobile = await connectSurface(h.url, h.registry, 'phone-srf', 'mobile');
    try {
      const ring = mobile.waitFor('chat.call_request', undefined, 3000);
      h.daemonLink.emit({ type: 'patch.call', chatId: 'c', message: 'pick up' });
      const ringEv = (await ring) as { callId: string };
      const winner = mobile.waitFor('chat.call_winner', undefined, 3000);
      const resp: ChatCallResponseEvent = {
        type: 'chat.call_response',
        callId: ringEv.callId,
        response: 'accept',
      };
      mobile.send(resp);
      const win = await winner;
      expect(win).toMatchObject({ type: 'chat.call_winner' });
      expect(h.app.callOrchestrator.getCall(ringEv.callId)?.status).toBe('accepted');
    } finally {
      await mobile.close();
      await h.close();
    }
  });

  it('B9 30s timeout (no accept) → chat.call_timeout + fallback push with reason text', async () => {
    const h = await startServer({ dir, callTimeoutMs: 200 }); // shrink the 30s timer
    h.registry.registerPushToken({
      surfaceId: 'phone',
      accountId: ACCOUNT_PUBKEY,
      token: 'expo-token-aaa',
      registeredAt: Date.now(),
    });
    const mobile = await connectSurface(h.url, h.registry, 'phone-srf', 'mobile');
    try {
      const timeout = mobile.waitFor('chat.call_timeout', undefined, 3000);
      h.daemonLink.emit({ type: 'patch.call', chatId: 'c', message: 'urgent reason text' });
      await timeout;
      await waitUntil(() => h.push.sent.some((p) => p.payload.body === 'urgent reason text'));
      const fb = h.push.sent.find((p) => p.payload.body === 'urgent reason text');
      expect(fb?.payload.urgent).toBe(true);
    } finally {
      await mobile.close();
      await h.close();
    }
  });
});

// ---- helpers ----
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
async function waitUntil(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out');
    await sleep(20);
  }
}
