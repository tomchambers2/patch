// Integration tests for the WebSocket hub and surface auth gate.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { generateUserKeypair, mintSurfaceCredential, mintDaemonKey } from '@patch/auth';
import { WireTestClient } from '@patch/wire/test-client';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';
import type { Job } from '../src/jobs/types.js';

interface Harness {
  url: string;
  registry: Registry;
  daemonLink: InProcessDaemonLink;
  app: Awaited<ReturnType<typeof buildAll>>['app'];
  built: Awaited<ReturnType<typeof buildAll>>;
  close: () => Promise<void>;
}

async function startServer(opts: {
  registry: Registry;
  daemonLink?: InProcessDaemonLink;
  helloTimeoutMs?: number;
  webDistDir?: string;
  /** Pass a pino config to CAPTURE what the hub logs (default: silent). */
  logger?: unknown;
}): Promise<Harness> {
  const daemonLink = opts.daemonLink ?? new InProcessDaemonLink();
  const built = await buildAll({
    logger: (opts.logger ?? false) as never,
    registry: opts.registry,
    daemonLink,
    ...(opts.helloTimeoutMs !== undefined ? { helloTimeoutMs: opts.helloTimeoutMs } : {}),
    ...(opts.webDistDir !== undefined ? { webDistDir: opts.webDistDir } : {}),
  });
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = built.app.server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${addr.port}/ws`,
    registry: opts.registry,
    daemonLink,
    app: built.app,
    built,
    close: async () => {
      await built.app.close();
    },
  };
}

describe('WS hub auth gate', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-wshub-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('accepts hello with a valid JWT', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(7));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({
      surfaceId: 'srf-good',
      surfaceKind: 'web',
      label: 'browser',
      issuedAt: 1,
    });

    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-good',
      surfaceKind: 'web',
      label: 'browser',
    });

    const h = await startServer({ registry });
    try {
      const client = new WireTestClient({ url: h.url, auth: jwt });
      await client.connect();
      // We expect a daemon.online (the InProcessDaemonLink defaults to online).
      const greet = await client.waitFor('daemon.online');
      expect(greet.type).toBe('daemon.online');
      await client.close();
    } finally {
      await h.close();
    }
  });

  it('rejects hello with expired JWT (closes 4401, emits auth.expired NOT auth.revoked) (B2-d2)', async () => {
    // An expired-but-otherwise-valid, non-revoked credential is TRANSIENT.
    // The server must close 4401 but distinguish it from a genuine revocation:
    // auth.revoked is the destructive "wipe credential + re-pair" signal, so an
    // expired token must NOT emit it (that would force a needless re-pair loop).
    const user = generateUserKeypair(() => new Uint8Array(32).fill(8));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });

    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-expired',
      surfaceKind: 'web',
      label: 'browser',
      now: 1000,
      expiresAt: 1100, // expired vs real now()
    });

    const h = await startServer({ registry });
    try {
      // Collect every pre-close frame so we can assert auth.revoked is absent.
      const WebSocketCtor = (await import('ws')).default;
      const ws = new WebSocketCtor(h.url);
      const frames: string[] = [];
      ws.on('message', (data: Buffer) => frames.push(data.toString('utf8')));
      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve());
        ws.on('error', reject);
      });
      ws.send(
        JSON.stringify({
          type: 'hello',
          clientType: 'surface-web',
          clientVersion: '1.0.0',
          auth: jwt,
        }),
      );
      const code = await new Promise<number>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('no close in time')), 3000);
        ws.on('close', (c: number) => {
          clearTimeout(t);
          resolve(c);
        });
        ws.on('error', () => {});
      });
      expect(code).toBe(4401);
      expect(frames.some((f) => f.includes('"auth.revoked"'))).toBe(false);
      const expired = frames.find((f) => f.includes('"auth.expired"'));
      expect(expired).toBeDefined();
      expect(JSON.parse(expired as string).reason).toMatch(/expired/);
    } finally {
      await h.close();
    }
  });

  // Diagnosing a retry storm in the live log meant guessing WHICH surface was
  // holding a dead credential — the phone, the desktop app, a stale browser tab
  // — because the rejection recorded only the crypto error. It was the desktop,
  // after an hour spent on the phone. The hello names its client; log it.
  it('names the client it refused, so a retry storm can be traced to a surface', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(9));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    const foreign = generateUserKeypair(() => new Uint8Array(32).fill(11));
    const jwt = await mintSurfaceCredential({
      userPrivateKey: foreign.privateKey,
      surfaceId: 'srf-who',
      surfaceKind: 'mobile',
      label: 'phone',
    });

    const lines: Array<Record<string, unknown>> = [];
    const h = await startServer({
      registry,
      logger: {
        level: 'warn',
        hooks: {
          logMethod(args: unknown[], method: (...a: unknown[]) => void) {
            if (typeof args[0] === 'object' && args[0] !== null) {
              lines.push(args[0] as Record<string, unknown>);
            }
            method.apply(this, args as never);
          },
        },
      },
    });
    try {
      const client = new WireTestClient({ url: h.url, auth: jwt, clientType: 'surface-mobile' });
      await client.connect().catch(() => undefined);
      await client.waitFor('auth.revoked').catch(() => undefined);
      const rejection = lines.find((l) => typeof l['clientType'] === 'string');
      expect(rejection?.['clientType']).toBe('surface-mobile');
      await client.close();
    } finally {
      await h.close();
    }
  });

  it('still emits auth.revoked for a genuinely revoked (non-expired) surface (B2-d2 control)', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(7));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({
      surfaceId: 'srf-revoked-control',
      surfaceKind: 'web',
      label: 'browser',
      issuedAt: 1,
    });
    registry.revoke('srf-revoked-control');

    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-revoked-control',
      surfaceKind: 'web',
      label: 'browser',
    });

    const h = await startServer({ registry });
    try {
      const client = new WireTestClient({ url: h.url, auth: jwt });
      await client.connect();
      const revoked = await client.waitFor('auth.revoked');
      expect(revoked.reason).toMatch(/revoked/);
      await client.close();
    } finally {
      await h.close();
    }
  });

  it('rejects hello when surface is revoked', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(9));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({
      surfaceId: 'srf-revoked',
      surfaceKind: 'web',
      label: 'browser',
      issuedAt: 1,
    });
    registry.revoke('srf-revoked');

    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-revoked',
      surfaceKind: 'web',
      label: 'browser',
    });

    const h = await startServer({ registry });
    try {
      const client = new WireTestClient({ url: h.url, auth: jwt });
      await client.connect();
      const revoked = await client.waitFor('auth.revoked');
      expect(revoked.reason).toMatch(/revoked/);
      await client.close();
    } finally {
      await h.close();
    }
  });

  it('closes 4408 when no hello arrives within timeout', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(10));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });

    const h = await startServer({ registry, helloTimeoutMs: 200 });
    try {
      // Connect raw — never send hello.
      const WebSocketCtor = (await import('ws')).default;
      const ws = new WebSocketCtor(h.url);
      // Fix 3 (TB1): collect every frame the server sends. A hello timeout is
      // transient, NOT a revocation — the server must NOT emit auth.revoked
      // (which would make a real client wipe its credential + re-pair).
      const frames: string[] = [];
      ws.on('message', (data: Buffer) => frames.push(data.toString('utf8')));
      const code = await new Promise<number>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('no close in time')), 3000);
        ws.on('close', (c: number) => {
          clearTimeout(t);
          resolve(c);
        });
        ws.on('error', () => {
          // ignore — close handles it
        });
      });
      expect(code).toBe(4408);
      expect(frames.some((f) => f.includes('auth.revoked'))).toBe(false);
    } finally {
      await h.close();
    }
  });

  it('rejects hello with a JWT signed by a foreign user key (closes 4401, no auth.revoked) (Fix 5)', async () => {
    // Fix 5 (TB1): a credential minted by an unknown/foreign user private key
    // must be rejected — verifySurfaceCredential throws because `sub` won't
    // match the registry's user public key. The connection closes 4401.
    const user = generateUserKeypair(() => new Uint8Array(32).fill(50));
    const foreign = generateUserKeypair(() => new Uint8Array(32).fill(51));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({
      surfaceId: 'srf-foreign',
      surfaceKind: 'web',
      label: 'browser',
      issuedAt: 1,
    });

    // JWT signed by the FOREIGN key — not the bootstrapped account key.
    const jwt = await mintSurfaceCredential({
      userPrivateKey: foreign.privateKey,
      surfaceId: 'srf-foreign',
      surfaceKind: 'web',
      label: 'browser',
    });

    const h = await startServer({ registry });
    try {
      const WebSocketCtor = (await import('ws')).default;
      const ws = new WebSocketCtor(h.url);
      await new Promise<void>((res, rej) => {
        ws.once('open', () => res());
        ws.once('error', rej);
      });
      ws.send(
        JSON.stringify({
          type: 'hello',
          clientType: 'surface-web',
          clientVersion: '0.0.0-test',
          auth: jwt,
        }),
      );
      const code = await new Promise<number>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('no close in time')), 3000);
        ws.on('close', (c: number) => {
          clearTimeout(t);
          resolve(c);
        });
        ws.on('error', () => {
          // ignore
        });
      });
      expect(code).toBe(4401);
    } finally {
      await h.close();
    }
  });
});

describe('WS hub relay', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-wshub-relay-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function makeAuthedClient(
    h: Harness,
    user: { publicKey: string; privateKey: string },
    surfaceId: string,
  ): Promise<WireTestClient> {
    h.registry.upsertSurface({
      surfaceId,
      surfaceKind: 'web',
      label: 'browser',
      issuedAt: 1,
    });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId,
      surfaceKind: 'web',
      label: 'browser',
    });
    const client = new WireTestClient({ url: h.url, auth: jwt });
    await client.connect();
    await client.waitFor('daemon.online');
    return client;
  }

  it('pongs a surface.heartbeat with surface.heartbeat_ack (liveness for zombie-socket detection)', async () => {
    // patch/todo.md "Test with slow, unreliable train internet": a half-open
    // socket on flaky mobile data never fires `close`, so the surface needs an
    // application-level pong to notice the link is dead. The server must answer
    // every surface.heartbeat with a surface.heartbeat_ack on the same socket.
    const user = generateUserKeypair(() => new Uint8Array(32).fill(55));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    const h = await startServer({ registry });
    try {
      const client = await makeAuthedClient(h, user, 'srf-hb');
      const ackP = client.waitFor('surface.heartbeat_ack');
      client.send({ type: 'surface.heartbeat' });
      const ack = await ackP;
      expect(ack.type).toBe('surface.heartbeat_ack');
      await client.close();
    } finally {
      await h.close();
    }
  });

  it('strips chat.input.source on surface ingress (group 12 HIGH-1)', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(33));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    const h = await startServer({ registry });
    try {
      const client = await makeAuthedClient(h, user, 'srf-attacker');
      // Surface attempts to spoof a voice-device source on a *regular* chat.
      // ws-hub MUST strip it before forwarding to the host link /
      // reply-router (only the server's own ingress hooks may set `source`).
      client.send({
        type: 'chat.input',
        chatId: 'chat_regular_1',
        message: 'spoof',
        localId: 'sp-1',
        source: { kind: 'voice-device', deviceId: 'kitchen' },
      });
      await new Promise((r) => setTimeout(r, 100));
      const inputs = h.daemonLink.sent.filter((s) => s.event.type === 'chat.input');
      expect(inputs).toHaveLength(1);
      const ev = inputs[0]!.event as { source?: unknown };
      expect(ev.source).toBeUndefined();
      await client.close();
    } finally {
      await h.close();
    }
  });

  it('rejects surface chat.input to read-only mirror threads (speakers)', async () => {
    // spec/06 ## Composer policy: Speakers is a read-only mirror.
    // A surface must not be able to inject a user turn there — the only valid
    // ingress is the voice device (which bypasses this hub).
    const user = generateUserKeypair(() => new Uint8Array(32).fill(44));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    const h = await startServer({ registry });
    try {
      const client = await makeAuthedClient(h, user, 'srf-ro');
      client.send({
        type: 'chat.input',
        chatId: 'thread_speakers',
        message: 'typed from a desk',
        localId: 'ro-2',
      });
      await new Promise((r) => setTimeout(r, 100));
      const inputs = h.daemonLink.sent.filter((s) => s.event.type === 'chat.input');
      expect(inputs).toHaveLength(0);
      await client.close();
    } finally {
      await h.close();
    }
  });

  it('forwards chat.input to the host link, INCLUDING redeliveries (host is the dedup authority)', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(11));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    const h = await startServer({ registry });
    try {
      const client = await makeAuthedClient(h, user, 'srf-1');
      client.sendInput({ chatId: 'chat-1', message: 'hello', localId: 'local-1' });
      client.sendInput({ chatId: 'chat-1', message: 'hello', localId: 'local-1' }); // redelivery

      // Wait a tick for both messages to flow.
      await new Promise((r) => setTimeout(r, 100));
      // spec/12 § Guaranteed input delivery: the server no longer DROPS a
      // duplicate localId — it forwards it so the host (the single
      // idempotency authority on `(chatId, localId)`) dedups it and re-emits
      // `chat.input_ack`. A server-side drop would strand a flap/restart
      // redelivery forever. So BOTH sends reach the host link.
      const inputs = h.daemonLink.sent.filter((s) => s.event.type === 'chat.input');
      expect(inputs).toHaveLength(2);
      expect(inputs.every((s) => (s.event as { localId?: string }).localId === 'local-1')).toBe(
        true,
      );
      await client.close();
    } finally {
      await h.close();
    }
  });

  it('relays chat.input_ack from the host down to the surface (spec/12 delivery receipt)', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(13));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    const h = await startServer({ registry });
    try {
      const client = await makeAuthedClient(h, user, 'srf-1');
      // Surface sends an input, establishing interest in the chat.
      client.sendInput({ chatId: 'chat-1', message: 'hello', localId: 'local-1' });
      await new Promise((r) => setTimeout(r, 30));

      const ackP = client.waitFor('chat.input_ack');
      // The host accepts the input and emits its receipt upstream.
      h.daemonLink.emit({ type: 'chat.input_ack', chatId: 'chat-1', localId: 'local-1' });
      const ack = await ackP;
      expect(ack).toMatchObject({ type: 'chat.input_ack', chatId: 'chat-1', localId: 'local-1' });
      // The out-of-band routing field must be stripped before it reaches the surface.
      expect('forSurfaceId' in (ack as object)).toBe(false);
      await client.close();
    } finally {
      await h.close();
    }
  });

  it('tells a surface that asks for a replay what the chat is still holding in its queue', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(13));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    const h = await startServer({ registry });
    try {
      // The host queues two messages while no second surface is connected.
      for (const [localId, queueSeq] of [
        ['L2', 1],
        ['L3', 2],
      ] as const) {
        h.daemonLink.emit({
          type: 'chat.queued',
          chatId: 'chat-1',
          localId,
          message: `text ${localId}`,
          queueSeq,
        });
      }
      h.daemonLink.emit({
        type: 'chat.dequeued',
        chatId: 'chat-1',
        localId: 'L2',
        reason: 'running',
        delivered: true,
      });

      const late = await makeAuthedClient(h, user, 'srf-late');
      const seen: string[] = [];
      late.on('chat.queued', (e) => seen.push(`${e.localId}:${e.message}:${e.queueSeq}`));
      late.replay('chat-1', -1);
      await new Promise((r) => setTimeout(r, 50));

      expect(seen).toEqual(['L3:text L3:2']);
      await late.close();
    } finally {
      await h.close();
    }
  });

  it("answers a replay itself, from what passed through it, while the chat's host is offline", async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(14));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    const h = await startServer({ registry });
    try {
      h.daemonLink.emit({ type: 'chat.spawned', chatId: 'chat-1', daemonId: 'd1', folder: '/w' });
      for (let seq = 1; seq <= 3; seq++) {
        h.daemonLink.emit({
          type: 'chat.message',
          chatId: 'chat-1',
          role: 'assistant',
          content: `m${seq}`,
          seq,
        });
      }

      // Host online: the host answers, the server adds nothing of its own.
      const online = await makeAuthedClient(h, user, 'srf-online');
      const fromOnline: number[] = [];
      online.on('chat.message', (e) => fromOnline.push(e.seq));
      online.replay('chat-1', -1);
      await new Promise((r) => setTimeout(r, 50));
      expect(fromOnline).toEqual([]);

      // Host offline: the server answers from its own copy, after the seq asked for.
      const offline = await makeAuthedClient(h, user, 'srf-offline');
      h.daemonLink.setStatus('offline');
      const fromOffline: number[] = [];
      offline.on('chat.message', (e) => fromOffline.push(e.seq));
      offline.replay('chat-1', 1);
      await new Promise((r) => setTimeout(r, 50));
      expect(fromOffline).toEqual([2, 3]);

      await online.close();
      await offline.close();
    } finally {
      await h.close();
    }
  });

  it('replays daemon-emitted chat events to subscribed surfaces (replay flow)', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(12));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    const h = await startServer({ registry });
    try {
      const c1 = await makeAuthedClient(h, user, 'srf-1');
      // First surface fires off an input — establishes interest in chat-1.
      c1.sendInput({ chatId: 'chat-1', message: 'foo', localId: 'L1' });
      await new Promise((r) => setTimeout(r, 50));

      // Host publishes 5 chat.message events.
      for (let seq = 1; seq <= 5; seq++) {
        h.daemonLink.emit({
          type: 'chat.message',
          chatId: 'chat-1',
          role: 'assistant',
          content: `m${seq}`,
          seq,
        });
      }

      // Connect a second surface, request replay from seq=2 — host should
      // see the replay request relayed upstream.
      const c2 = await makeAuthedClient(h, user, 'srf-2');
      c2.replay('chat-1', 2);
      await new Promise((r) => setTimeout(r, 50));

      const replayRequests = h.daemonLink.sent.filter((s) => s.event.type === 'chat.replay');
      expect(replayRequests).toHaveLength(1);
      const replayEvent = replayRequests[0]?.event;
      expect(replayEvent?.type).toBe('chat.replay');
      if (replayEvent && replayEvent.type === 'chat.replay') {
        expect(replayEvent.chatId).toBe('chat-1');
        expect(replayEvent.fromSeq).toBe(2);
      }

      // Host replays events 3,4,5 — the hub should fan those out to c2.
      const got: number[] = [];
      const unsub = c2.on('chat.message', (e) => got.push(e.seq));
      // A replay is addressed to the surface that asked for it; a live resend of
      // what the server already holds is not broadcast again.
      for (const seq of [3, 4, 5]) {
        h.daemonLink.emit({
          type: 'chat.message',
          chatId: 'chat-1',
          role: 'assistant',
          content: `m${seq}`,
          seq,
          forSurfaceId: 'srf-2',
        });
      }
      await new Promise((r) => setTimeout(r, 50));
      unsub();
      expect(got).toEqual([3, 4, 5]);

      await c1.close();
      await c2.close();
    } finally {
      await h.close();
    }
  });

  it('relays chat.spawned enriched with jobId for a job-spawned chat (spec/14 § Sidebar — Automations)', async () => {
    // The Automations sidebar group must go `working` the instant a job's
    // spawn round-trips — that means the LIVE `chat.spawned` frame, not just
    // a later REST refetch, needs to carry the jobId.
    const user = generateUserKeypair(() => new Uint8Array(32).fill(77));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.setDaemonKey({ daemonId: 'd1', publicKey: 'pk-d1', issuedAt: 1 });
    const h = await startServer({ registry });
    try {
      const client = await makeAuthedClient(h, user, 'srf-automations');

      const job: Job = {
        id: 'j_00000000000000000000000099',
        name: 'test-automation',
        enabled: true,
        trigger: { type: 'cron', expression: '* * * * *' },
        filter: null,
        action: { type: 'spawn', daemonId: 'd1', folder: '/work', prompt: 'go' },
        createdAt: 1,
        updatedAt: 1,
      };
      const result = h.built.jobDispatcher.dispatch(job, {}, 'cron');
      const chatId = result.event.chatId;

      const spawnedP = client.waitFor('chat.spawned');
      h.daemonLink.emit({
        type: 'chat.spawned',
        chatId,
        daemonId: 'd1',
        folder: '/work',
      });
      const spawned = await spawnedP;
      expect(spawned).toMatchObject({ type: 'chat.spawned', chatId, jobId: job.id });

      await client.close();
    } finally {
      await h.close();
    }
  });

  it('emits daemon.offline to all surfaces when upstream link drops', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(13));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    const h = await startServer({ registry });
    try {
      const client = await makeAuthedClient(h, user, 'srf-1');
      const offlinePromise = client.waitFor('daemon.offline');
      h.daemonLink.setStatus('offline');
      const ev = await offlinePromise;
      expect(ev.type).toBe('daemon.offline');
      // Fix 4 (TB1): wire spec documents daemon.offline as `{}` — no `reason`.
      expect((ev as { reason?: unknown }).reason).toBeUndefined();
      // Presence names the machine it describes — an anonymous offline frame
      // tells a surface nothing about WHICH host went away.
      expect(Object.keys(ev).sort()).toEqual(['daemonId', 'type']);
      expect(ev).toMatchObject({ daemonId: 'd1' });
      await client.close();
    } finally {
      await h.close();
    }
  });

  it('the greeting carries an offline registered host — in the auth.ok roster and as daemon.offline', async () => {
    // spec/03 § Control → `auth.ok`: the greeting is `{surfaceId, hosts[],
    // webBundleHash}` where `hosts[]` is `{daemonId, online, lastSeenAt, host,
    // accounts[]}` per REGISTERED host. That roster is the authoritative
    // presence carrier — a surface renders the whole Hosts list from the
    // greeting alone, including machines that are down.
    //
    // The roster is keyed off the REGISTRY, so a host only appears once it is
    // actually registered against the account. An offline link contributes no
    // id of its own (it is not in `onlineDaemonIds()`), which is exactly right:
    // an unregistered, offline machine is not a host of this account.
    const user = generateUserKeypair(() => new Uint8Array(32).fill(34));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.setDaemonKey({ daemonId: 'd1', publicKey: 'pk-d1', issuedAt: 1 });
    const daemonLink = new InProcessDaemonLink();
    daemonLink.setStatus('offline');
    const h = await startServer({ registry, daemonLink });
    try {
      h.registry.upsertSurface({
        surfaceId: 'srf-greet',
        surfaceKind: 'web',
        label: 'browser',
        issuedAt: 1,
      });
      const jwt = await mintSurfaceCredential({
        userPrivateKey: user.privateKey,
        surfaceId: 'srf-greet',
        surfaceKind: 'web',
        label: 'browser',
      });
      const client = new WireTestClient({ url: h.url, auth: jwt });
      await client.connect();
      // Both waiters are armed BEFORE the greeting can land: `waitFor` is not
      // buffered, and the whole greeting arrives as one burst — arming the
      // second one only after awaiting the first races the frame away.
      const okPromise = client.waitFor('auth.ok');
      const offlinePromise = client.waitFor('daemon.offline');

      // 1. The auth.ok roster names the machine and says it is down. The server
      //    invents no description for a machine it has never heard from.
      const ok = await okPromise;
      expect(ok.hosts).toEqual([
        { daemonId: 'd1', online: false, lastSeenAt: null, host: null, accounts: [] },
      ]);

      // 2. The standalone presence frame agrees, and names the machine it
      //    describes — an anonymous offline frame tells a surface nothing about
      //    WHICH host went away. No `reason`: spec/03 documents no such field.
      const ev = await offlinePromise;
      expect(Object.keys(ev).sort()).toEqual(['daemonId', 'type']);
      expect(ev).toMatchObject({ daemonId: 'd1' });
      await client.close();
    } finally {
      await h.close();
    }
  });

  it('buffers post-hello frames sent before auth completes; drains them on success', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(15));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({
      surfaceId: 'srf-pipeline',
      surfaceKind: 'web',
      label: 'browser',
      issuedAt: 1,
    });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-pipeline',
      surfaceKind: 'web',
      label: 'browser',
    });
    const h = await startServer({ registry });
    try {
      const WebSocketCtor = (await import('ws')).default;
      const ws = new WebSocketCtor(h.url);
      await new Promise<void>((res, rej) => {
        ws.once('open', () => res());
        ws.once('error', rej);
      });
      // Pipeline hello + heartbeat + chat.input back-to-back in one tick.
      ws.send(
        JSON.stringify({
          type: 'hello',
          clientType: 'surface-web',
          clientVersion: '0.0.0-test',
          auth: jwt,
        }),
      );
      ws.send(JSON.stringify({ type: 'surface.heartbeat' }));
      ws.send(
        JSON.stringify({
          type: 'chat.input',
          chatId: 'chat-1',
          message: 'hi',
          localId: 'L-pipeline',
        }),
      );

      // Wait for auth to complete + frames to drain.
      await new Promise((r) => setTimeout(r, 150));
      const inputs = h.daemonLink.sent.filter((s) => s.event.type === 'chat.input');
      expect(inputs).toHaveLength(1);
      // Socket must still be open (not closed 4401).
      expect(ws.readyState).toBe(WebSocketCtor.OPEN);
      ws.close();
    } finally {
      await h.close();
    }
  });

  it('terminates a revoked surface live WS (spec/10 revocation)', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(40));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    const h = await startServer({ registry });
    try {
      // An already-linked surface (the revoker) and the victim surface both
      // connect live.
      const revoker = await makeAuthedClient(h, user, 'srf-revoker');
      const victim = await makeAuthedClient(h, user, 'srf-victim');

      const revokerJwt = await mintSurfaceCredential({
        userPrivateKey: user.privateKey,
        surfaceId: 'srf-revoker',
        surfaceKind: 'web',
        label: 'browser',
      });

      const revokedEvent = victim.waitFor('auth.revoked');

      const res = await h.app.inject({
        method: 'POST',
        url: '/api/auth/revoke',
        headers: { authorization: `Bearer ${revokerJwt}` },
        payload: { id: 'srf-victim' },
      });
      expect(res.statusCode).toBe(200);

      // Victim must receive auth.revoked and the registry must mark it revoked.
      const ev = await revokedEvent;
      expect(ev.type).toBe('auth.revoked');
      expect(h.registry.isRevoked('srf-victim')).toBe(true);

      // And the live socket must be torn down — no longer in the hub.
      await new Promise((r) => setTimeout(r, 50));
      await revoker.close();
      await victim.close();
    } finally {
      await h.close();
    }
  });

  it('emits auth.ok after a successful hello', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(16));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({
      surfaceId: 'srf-ok',
      surfaceKind: 'web',
      label: 'browser',
      issuedAt: 1,
    });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-ok',
      surfaceKind: 'web',
      label: 'browser',
    });
    const h = await startServer({ registry });
    try {
      const client = new WireTestClient({ url: h.url, auth: jwt });
      await client.connect();
      const ok = await client.waitFor('auth.ok');
      expect(ok.surfaceId).toBe('srf-ok');
      expect(ok.accountId).toBe(user.publicKey);
      await client.close();
    } finally {
      await h.close();
    }
  });

  it('auth.ok carries the served web-bundle hash for live updates (spec/14)', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(17));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({ surfaceId: 'srf-ver', surfaceKind: 'web', label: 'b', issuedAt: 1 });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-ver',
      surfaceKind: 'web',
      label: 'browser',
    });
    // A mounted SPA whose index.html references a content-hashed bundle.
    const webDir = mkdtempSync(join(tmpdir(), 'patch-wshub-web-'));
    writeFileSync(
      join(webDir, 'index.html'),
      '<!doctype html><script type="module" src="/app/assets/index-DEADBEEF.js"></script>',
    );
    const h = await startServer({ registry, webDistDir: webDir });
    try {
      const client = new WireTestClient({ url: h.url, auth: jwt });
      await client.connect();
      const ok = await client.waitFor('auth.ok');
      expect(ok.webBundleHash).toBe('assets/index-DEADBEEF.js');
      await client.close();
    } finally {
      await h.close();
      rmSync(webDir, { recursive: true, force: true });
    }
  });

  it('closes connection (4400) on a malformed inbound frame', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(14));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({
      surfaceId: 'srf-1',
      surfaceKind: 'web',
      label: 'browser',
      issuedAt: 1,
    });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-1',
      surfaceKind: 'web',
      label: 'browser',
    });
    const h = await startServer({ registry });
    try {
      const WebSocketCtor = (await import('ws')).default;
      const ws = new WebSocketCtor(h.url);
      await new Promise<void>((res, rej) => {
        ws.once('open', () => res());
        ws.once('error', rej);
      });
      // Send hello first
      ws.send(
        JSON.stringify({
          type: 'hello',
          clientType: 'surface-web',
          clientVersion: '0.0.0-test',
          auth: jwt,
        }),
      );
      // Then garbage
      ws.send('not-json');
      const code = await new Promise<number>((resolve) => {
        ws.once('close', (c: number) => resolve(c));
      });
      expect(code).toBe(4400);
    } finally {
      await h.close();
    }
  });
});

// ---- Host hello gate + inbound link (spec/10 inversion) ----
// These tests use the REAL InboundDaemonLink (no injected daemonLink) so the
// host authenticates INTO /ws exactly like a surface.

interface RealHarness {
  url: string;
  registry: Registry;
  app: Awaited<ReturnType<typeof buildAll>>['app'];
  close: () => Promise<void>;
}

async function startRealServer(
  registry: Registry,
  opts: { unknownChatHostWaitMs?: number; unknownChatHostPollMs?: number } = {},
): Promise<RealHarness> {
  const built = await buildAll({ logger: false, registry, ...opts }); // no daemonLink → InboundDaemonLink
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = built.app.server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${addr.port}/ws`,
    registry,
    app: built.app,
    close: async () => {
      await built.app.close();
    },
  };
}

describe('WS hub host gate', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-wshub-daemon-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function bootstrappedRegistry(fill: number): {
    registry: Registry;
    user: { publicKey: string; privateKey: string };
  } {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(fill));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    return { registry, user };
  }

  it('host authenticates via hello; daemon.online fans out to surfaces', async () => {
    const { registry, user } = bootstrappedRegistry(60);
    registry.setDaemonKey({ daemonId: 'daemon-1', publicKey: user.publicKey, issuedAt: 1 });
    registry.upsertSurface({ surfaceId: 'srf-1', surfaceKind: 'web', label: 'b', issuedAt: 1 });

    const h = await startRealServer(registry);
    try {
      // A surface is connected first; it should see daemon.online when the
      // host authenticates.
      const surfaceJwt = await mintSurfaceCredential({
        userPrivateKey: user.privateKey,
        surfaceId: 'srf-1',
        surfaceKind: 'web',
        label: 'b',
      });
      const surface = new WireTestClient({ url: h.url, auth: surfaceJwt });
      await surface.connect();
      await surface.waitFor('daemon.offline'); // greeting — host not yet online

      const onlinePromise = surface.waitFor('daemon.online');

      const daemonKey = await mintDaemonKey({
        userPrivateKey: user.privateKey,
        daemonId: 'daemon-1',
        label: 'hetzner',
      });
      const daemon = new WireTestClient({ url: h.url, clientType: 'daemon', auth: daemonKey });
      await daemon.connect();
      await daemon.waitFor('auth.ok');

      const ev = await onlinePromise;
      expect(ev.type).toBe('daemon.online');

      await surface.close();
      await daemon.close();
    } finally {
      await h.close();
    }
  });

  it('rejects a host hello with an invalid/foreign daemonKey (close 4401)', async () => {
    const { registry, user } = bootstrappedRegistry(61);
    const foreign = generateUserKeypair(() => new Uint8Array(32).fill(62));
    registry.setDaemonKey({ daemonId: 'daemon-1', publicKey: user.publicKey, issuedAt: 1 });

    const h = await startRealServer(registry);
    try {
      const daemonKey = await mintDaemonKey({
        userPrivateKey: foreign.privateKey, // signed by the wrong user key
        daemonId: 'daemon-1',
        label: 'attacker',
      });
      const code = await connectExpectClose(h.url, 'daemon', daemonKey);
      expect(code).toBe(4401);
    } finally {
      await h.close();
    }
  });

  it('rejects a host hello for an unregistered daemon_id (close 4401)', async () => {
    const { registry, user } = bootstrappedRegistry(63);
    registry.setDaemonKey({ daemonId: 'daemon-1', publicKey: user.publicKey, issuedAt: 1 });

    const h = await startRealServer(registry);
    try {
      const daemonKey = await mintDaemonKey({
        userPrivateKey: user.privateKey,
        daemonId: 'daemon-OTHER', // not the registered id
        label: 'rogue',
      });
      const code = await connectExpectClose(h.url, 'daemon', daemonKey);
      expect(code).toBe(4401);
    } finally {
      await h.close();
    }
  });

  it('rejects a host hello when no host is registered (close 4401)', async () => {
    const { registry, user } = bootstrappedRegistry(64);
    // No setDaemonKey — registry has no host.
    const h = await startRealServer(registry);
    try {
      const daemonKey = await mintDaemonKey({
        userPrivateKey: user.privateKey,
        daemonId: 'daemon-1',
        label: 'd',
      });
      const code = await connectExpectClose(h.url, 'daemon', daemonKey);
      expect(code).toBe(4401);
    } finally {
      await h.close();
    }
  });

  it('rejects a revoked host and emits auth.revoked', async () => {
    const { registry, user } = bootstrappedRegistry(65);
    registry.setDaemonKey({ daemonId: 'daemon-1', publicKey: user.publicKey, issuedAt: 1 });
    registry.revoke('daemon-1');

    const h = await startRealServer(registry);
    try {
      const daemonKey = await mintDaemonKey({
        userPrivateKey: user.privateKey,
        daemonId: 'daemon-1',
        label: 'd',
      });
      const daemon = new WireTestClient({ url: h.url, clientType: 'daemon', auth: daemonKey });
      await daemon.connect();
      const revoked = await daemon.waitFor('auth.revoked');
      expect(revoked.reason).toMatch(/revoked/);
      await daemon.close();
    } finally {
      await h.close();
    }
  });

  it('host drop → daemon.offline {} fans out; surface→host events buffer and flush on reconnect', async () => {
    const { registry, user } = bootstrappedRegistry(66);
    registry.setDaemonKey({ daemonId: 'daemon-1', publicKey: user.publicKey, issuedAt: 1 });
    registry.upsertSurface({ surfaceId: 'srf-1', surfaceKind: 'web', label: 'b', issuedAt: 1 });

    const h = await startRealServer(registry);
    const daemonKey = await mintDaemonKey({
      userPrivateKey: user.privateKey,
      daemonId: 'daemon-1',
      label: 'd',
    });
    try {
      const surfaceJwt = await mintSurfaceCredential({
        userPrivateKey: user.privateKey,
        surfaceId: 'srf-1',
        surfaceKind: 'web',
        label: 'b',
      });
      const surface = new WireTestClient({ url: h.url, auth: surfaceJwt });
      await surface.connect();
      await surface.waitFor('daemon.offline'); // greeting

      // Host connects.
      const daemon1 = new WireTestClient({ url: h.url, clientType: 'daemon', auth: daemonKey });
      await daemon1.connect();
      await daemon1.waitFor('auth.ok');
      await surface.waitFor('daemon.online');

      // Surface→host event arrives at the host socket.
      const got1 = daemon1.waitFor('chat.input');
      surface.sendInput({ chatId: 'c1', message: 'first', localId: 'L1' });
      const recv1 = await got1;
      expect(recv1.message).toBe('first');

      // Host drops.
      const offlinePromise = surface.waitFor('daemon.offline');
      await daemon1.close();
      const offline = await offlinePromise;
      expect(Object.keys(offline).sort()).toEqual(['daemonId', 'type']); // no `reason`
      // Names the host that dropped — read off the link that changed, not
      // guessed, so it stays right once several hosts are attached.
      expect(offline).toMatchObject({ daemonId: 'daemon-1' });

      // Surface keeps sending while host is gone — these buffer.
      surface.sendInput({ chatId: 'c1', message: 'buffered', localId: 'L2' });
      await new Promise((r) => setTimeout(r, 50));

      // Host reconnects; buffered event flushes.
      const daemon2 = new WireTestClient({ url: h.url, clientType: 'daemon', auth: daemonKey });
      const got2 = daemon2.waitFor('chat.input', (e) => e.localId === 'L2');
      await daemon2.connect();
      await daemon2.waitFor('auth.ok');
      const recv2 = await got2;
      expect(recv2.message).toBe('buffered');

      await surface.close();
      await daemon2.close();
    } finally {
      await h.close();
    }
  });

  // Todoist: "Server says chat_not_found while a host is reconnecting after a
  // server redeploy" — full stack (real WS host + surface sockets, real
  // Registry, real InboundDaemonLink) proof that a chat-scoped frame whose
  // host the registry mirror doesn't know yet is held rather than guessed at
  // an ONLINE-but-wrong registered machine, and that the requesting surface
  // is told plainly (`daemon_unavailable`) rather than left hanging.
  it('a chat-scoped frame whose host is unknown is not misrouted to a different, already-connected registered machine, and the surface is told daemon_unavailable if it never resolves', async () => {
    const { registry, user } = bootstrappedRegistry(69);
    registry.setDaemonKey({ daemonId: 'daemon-1', publicKey: user.publicKey, issuedAt: 1 });
    registry.setDaemonKey({ daemonId: 'daemon-2', publicKey: user.publicKey, issuedAt: 1 });
    registry.upsertSurface({ surfaceId: 'srf-1', surfaceKind: 'web', label: 'b', issuedAt: 1 });

    const h = await startRealServer(registry, {
      unknownChatHostWaitMs: 150,
      unknownChatHostPollMs: 20,
    });
    const daemon1Key = await mintDaemonKey({
      userPrivateKey: user.privateKey,
      daemonId: 'daemon-1',
      label: 'd1',
    });
    try {
      const surfaceJwt = await mintSurfaceCredential({
        userPrivateKey: user.privateKey,
        surfaceId: 'srf-1',
        surfaceKind: 'web',
        label: 'b',
      });
      const surface = new WireTestClient({ url: h.url, auth: surfaceJwt });
      await surface.connect();
      await surface.waitFor('daemon.offline'); // greeting — neither machine connected yet

      // daemon-1 is this account's home/default machine (registered first)
      // and IS connected — but it has never heard of 'c1'; it lives on
      // daemon-2, which stays offline for the whole test.
      const daemon1 = new WireTestClient({ url: h.url, clientType: 'daemon', auth: daemon1Key });
      const daemon1Got: unknown[] = [];
      daemon1.on('chat.input', (e) => daemon1Got.push(e));
      await daemon1.connect();
      await daemon1.waitFor('auth.ok');

      const errorPromise = surface.waitFor('chat.error', undefined, 2000);
      surface.sendInput({ chatId: 'c1', message: 'hi', localId: 'L1' });

      // Not misrouted to the connected-but-wrong home host while the wait
      // is still running.
      await new Promise((r) => setTimeout(r, 80));
      expect(daemon1Got).toHaveLength(0);

      const err = await errorPromise;
      expect(err).toMatchObject({ chatId: 'c1', error: { code: 'daemon_unavailable' } });
      // Still never delivered anywhere, even after giving up.
      expect(daemon1Got).toHaveLength(0);

      await surface.close();
      await daemon1.close();
    } finally {
      await h.close();
    }
  });

  it('revoking the host id terminates the live host socket and rejects future hellos', async () => {
    const { registry, user } = bootstrappedRegistry(67);
    registry.setDaemonKey({ daemonId: 'daemon-1', publicKey: user.publicKey, issuedAt: 1 });
    registry.upsertSurface({
      surfaceId: 'srf-revoker',
      surfaceKind: 'web',
      label: 'b',
      issuedAt: 1,
    });

    const h = await startRealServer(registry);
    const daemonKey = await mintDaemonKey({
      userPrivateKey: user.privateKey,
      daemonId: 'daemon-1',
      label: 'd',
    });
    try {
      const daemon = new WireTestClient({ url: h.url, clientType: 'daemon', auth: daemonKey });
      await daemon.connect();
      await daemon.waitFor('auth.ok');

      const revokerJwt = await mintSurfaceCredential({
        userPrivateKey: user.privateKey,
        surfaceId: 'srf-revoker',
        surfaceKind: 'web',
        label: 'b',
      });
      // Need the revoker connected to pass requireAuth.
      const closed = new Promise<void>((resolve) => {
        // host socket should close once revoked.
        const ws = (daemon as unknown as { ws: import('ws').WebSocket }).ws;
        ws.once('close', () => resolve());
      });

      const res = await h.app.inject({
        method: 'POST',
        url: '/api/auth/revoke',
        headers: { authorization: `Bearer ${revokerJwt}` },
        payload: { id: 'daemon-1' },
      });
      expect(res.statusCode).toBe(200);
      expect(h.registry.isRevoked('daemon-1')).toBe(true);
      await closed; // live socket severed

      // A subsequent host hello is rejected.
      const reconnectCode = await connectExpectClose(h.url, 'daemon', daemonKey);
      expect(reconnectCode).toBe(4401);
    } finally {
      await h.close();
    }
  });

  it('only one host connection: a second host closes the first', async () => {
    const { registry, user } = bootstrappedRegistry(68);
    registry.setDaemonKey({ daemonId: 'daemon-1', publicKey: user.publicKey, issuedAt: 1 });

    const h = await startRealServer(registry);
    const daemonKey = await mintDaemonKey({
      userPrivateKey: user.privateKey,
      daemonId: 'daemon-1',
      label: 'd',
    });
    try {
      const daemon1 = new WireTestClient({ url: h.url, clientType: 'daemon', auth: daemonKey });
      await daemon1.connect();
      await daemon1.waitFor('auth.ok');

      const firstClosed = new Promise<void>((resolve) => {
        const ws = (daemon1 as unknown as { ws: import('ws').WebSocket }).ws;
        ws.once('close', () => resolve());
      });

      const daemon2 = new WireTestClient({ url: h.url, clientType: 'daemon', auth: daemonKey });
      await daemon2.connect();
      await daemon2.waitFor('auth.ok');

      await firstClosed; // older host socket closed
      await daemon2.close();
    } finally {
      await h.close();
    }
  });
});

/** Connect a raw WS, send a hello, and resolve with the close code. */
async function connectExpectClose(
  url: string,
  clientType: 'daemon' | 'surface-web',
  auth: string,
): Promise<number> {
  const WebSocketCtor = (await import('ws')).default;
  const ws = new WebSocketCtor(url);
  await new Promise<void>((res, rej) => {
    ws.once('open', () => res());
    ws.once('error', rej);
  });
  ws.send(JSON.stringify({ type: 'hello', clientType, clientVersion: '0.0.0-test', auth }));
  return new Promise<number>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no close in time')), 3000);
    ws.on('close', (c: number) => {
      clearTimeout(t);
      resolve(c);
    });
    ws.on('error', () => {
      // ignore
    });
  });
}
