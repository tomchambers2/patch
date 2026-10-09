// Chat completion end-to-end through the real server (spec/09 § Chat
// completion): a real TCP/WS listener, a real desktop surface socket with a
// genuine EdDSA-JWT, the real notification router, and a real `chat.state`
// running → idle on the host link.
//
// Only the push transport is injected — there is no way to assert against
// Expo's push API from a test.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import { decode, encode, type WireEvent } from '@patch/wire';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { PresenceTracker } from '../src/presence.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';
import type { PushBackend } from '../src/notifications/router.js';

class FrameLog {
  readonly frames: WireEvent[] = [];
  constructor(private readonly ws: WebSocket) {
    ws.on('message', (raw: WebSocket.RawData) => {
      try {
        this.frames.push(decode(Array.isArray(raw) ? Buffer.concat(raw) : (raw as Buffer)));
      } catch {
        // ignore non-wire frames
      }
    });
  }
  /** Send a surface→server frame over this socket (e.g. `chat.focus_change`). */
  send(event: WireEvent): void {
    this.ws.send(encode(event));
  }
  count(type: WireEvent['type']): number {
    return this.frames.filter((f) => f.type === type).length;
  }
  async waitForCount(type: WireEvent['type'], n: number, timeoutMs = 3000): Promise<void> {
    const start = Date.now();
    while (this.count(type) < n) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`timeout waiting for ${n}× ${type} (saw ${this.count(type)})`);
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}

describe('chat completion — real server, real desktop socket', () => {
  let dataDir: string;
  let user: { publicKey: string; privateKey: string };
  let link: InProcessDaemonLink;
  let pushed: { tokens: string[]; payload: { body: string } }[];
  let pushBackend: PushBackend;
  let close: () => Promise<void>;
  let port: number;
  /**
   * The server's clock, moved forward by a test to make the connected desktop
   * surface look stale. It starts at real wall-clock rather than a pinned
   * constant because the presence tracker is stamped by the real WS handshake,
   * so an injected clock in the past would make every heartbeat look like it
   * happened in the future and no surface would ever go stale.
   */
  let now: number;

  async function boot(): Promise<void> {
    dataDir = mkdtempSync(join(tmpdir(), 'patch-chat-complete-'));
    user = generateUserKeypair();
    const registry = Registry.load(dataDir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({
      surfaceId: 'srf-desktop',
      surfaceKind: 'desktop',
      label: "Tom's Mac (desktop)",
      issuedAt: Math.floor(now / 1000),
    });
    // A second desktop surface — e.g. Tom's other machine, or a second window —
    // used by the focused-chat suppression tests to prove the toast is withheld
    // from the ONE surface that has the chat open, not every desktop surface.
    registry.upsertSurface({
      surfaceId: 'srf-desktop-2',
      surfaceKind: 'desktop',
      label: "Tom's other desktop",
      issuedAt: Math.floor(now / 1000),
    });
    // The phone's registered Expo push token — what a push would actually go to.
    registry.registerPushToken({
      surfaceId: 'srf-phone',
      accountId: user.publicKey,
      token: 'tok-phone',
      registeredAt: now,
    });

    pushed = [];
    pushBackend = {
      send: async (tokens, payload) => {
        pushed.push({ tokens, payload: payload as { body: string } });
        return { delivered: tokens.length, failed: [], permanentlyRejected: [] };
      },
    };

    link = new InProcessDaemonLink();
    const { app } = await buildAll({
      registry,
      presence: new PresenceTracker(),
      daemonLink: link,
      pushBackend,
      jobsWatch: false,
      logger: false,
      nowMs: () => now,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as AddressInfo).port;
    close = async () => {
      await app.close();
    };
  }

  /** A surface credential for the REST calls a job's CRUD needs. */
  async function mintJwt(): Promise<string> {
    return mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-desktop',
      surfaceKind: 'desktop',
      label: "Tom's Mac (desktop)",
    });
  }

  /* eslint-disable @typescript-eslint/no-explicit-any */
  async function api(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { authorization: `Bearer ${await mintJwt()}`, 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
    return text ? JSON.parse(text) : null;
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  /** Connect the desktop surface and wait until the server has greeted it. */
  /**
   * Connect the Mac's desktop surface. `idleMs` is the `surface.input` it
   * reports — how long since Tom last touched the machine — or null for a
   * shell that has reported nothing yet.
   */
  async function connectDesktop(
    idleMs: number | null = 0,
    surfaceId = 'srf-desktop',
  ): Promise<FrameLog> {
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId,
      surfaceKind: 'desktop',
      label: "Tom's Mac (desktop)",
    });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const log = new FrameLog(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    ws.send(encode({ type: 'hello', clientType: 'surface-web', clientVersion: '1', auth: jwt }));
    await log.waitForCount('auth.ok', 1);
    if (idleMs !== null) {
      ws.send(encode({ type: 'surface.input', idleMs, scope: 'system' }));
      // Nothing acks an input report; give the hub its turn of the event loop.
      await new Promise((r) => setTimeout(r, 50));
    }
    return log;
  }

  /**
   * Run a chat through spawn → running → idle on the real host link.
   *
   * `settle` is merged into the settling frame, so a test can send the turn's
   * own closing text the way a host does (spec/09 § What the message says).
   */
  function completeATurn(chatId: string, settle: Record<string, unknown> = {}): void {
    link.emit({
      type: 'chat.spawned',
      chatId,
      daemonId: 'd1',
      folder: '/home/tom/projects/bed-planner',
      seq: 1,
      ts: 0,
    } as WireEvent);
    const base = {
      type: 'chat.state',
      chatId,
      daemonId: 'd1',
      permissionMode: 'auto',
      folder: '/home/tom/projects/bed-planner',
      lastUpdated: 0,
      ts: 0,
    };
    link.emit({ ...base, activity: 'running', seq: 2, name: 'bed planner' } as WireEvent);
    link.emit({
      ...base,
      activity: 'idle',
      seq: 3,
      name: 'bed planner',
      statusSummary: 'planted the beds',
      ...settle,
    } as WireEvent);
  }

  beforeEach(async () => {
    now = Date.now();
    await boot();
  });

  afterEach(async () => {
    await close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('toasts the desktop and holds the push back while the computer is in use', async () => {
    const log = await connectDesktop();
    completeATurn('c1');

    await log.waitForCount('notify', 1);
    const notify = log.frames.find((f) => f.type === 'notify') as Extract<
      WireEvent,
      { type: 'notify' }
    >;
    expect(notify.channel).toBe('desktop');
    expect(notify.chatId).toBe('c1');
    expect(notify.message).toBe('bed planner finished: planted the beds');

    // The Mac reported input a moment ago, so Tom is at the computer and the
    // phone is left alone.
    expect(pushed).toHaveLength(0);
  });

  it('pushes the phone when the Mac is connected but nobody has touched it for ten minutes', async () => {
    const log = await connectDesktop(10 * 60_000);
    completeATurn('c9');
    await log.waitForCount('notify', 1);
    for (let i = 0; i < 50 && pushed.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(pushed).toHaveLength(1);
  });

  it('pushes the phone once the computer surface goes quiet, and still toasts', async () => {
    const log = await connectDesktop();
    // The socket is still up, but the last input report is five minutes old —
    // nobody is at the machine.
    now += 5 * 60_000;
    completeATurn('c2');

    await log.waitForCount('notify', 1);
    expect((log.frames.find((f) => f.type === 'notify') as { channel: string }).channel).toBe(
      'desktop',
    );

    // Give the push its turn of the event loop.
    for (let i = 0; i < 50 && pushed.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.tokens).toEqual(['tok-phone']);
    expect(pushed[0]?.payload.body).toBe('bed planner finished: planted the beds');
  });

  // spec/09 § What the message says — Tom: "patch notify needs to take specific
  // text from the agent and use it. not just the starting message". The whole
  // path, through the real router: the agent's own closing words on the
  // settling frame reach both the desktop toast and the phone's push body,
  // outranking the status summary the same frame carries.
  it("carries the turn's own closing text to both channels, over the status summary", async () => {
    const log = await connectDesktop();
    // Nobody at the machine, so the push fires too and both bodies can be read.
    now += 5 * 60_000;
    completeATurn('c3', { turnSummary: 'Dug over the top bed and sowed rocket.' });

    await log.waitForCount('notify', 1);
    const notify = log.frames.find((f) => f.type === 'notify') as Extract<
      WireEvent,
      { type: 'notify' }
    >;
    expect(notify.channel).toBe('desktop');
    expect(notify.message).toBe('bed planner finished: Dug over the top bed and sowed rocket.');

    for (let i = 0; i < 50 && pushed.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.payload.body).toBe(
      'bed planner finished: Dug over the top bed and sowed rocket.',
    );
  });

  // spec/09 § Chat completion — a surface already looking at the chat that
  // just finished does not need a toast telling it so. Proven against a REAL
  // second desktop surface, not just an assertion on the suppressed one: the
  // feature is "withheld from the surface that has it open", not "withheld
  // from every desktop surface whenever any of them has it open".
  it('withholds the desktop toast from a surface with the chat already focused, but still toasts another', async () => {
    const focused = await connectDesktop(0, 'srf-desktop');
    const other = await connectDesktop(0, 'srf-desktop-2');
    focused.send({ type: 'chat.focus_change', chatId: 'c-focused' });
    // Nothing acks a focus_change; give the hub its turn of the event loop.
    await new Promise((r) => setTimeout(r, 50));

    completeATurn('c-focused');

    await other.waitForCount('notify', 1);
    const notify = other.frames.find((f) => f.type === 'notify') as Extract<
      WireEvent,
      { type: 'notify' }
    >;
    expect(notify.channel).toBe('desktop');
    expect(notify.chatId).toBe('c-focused');

    // Give the focused surface every turn of the event loop it would need.
    for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 20));
    expect(focused.count('notify')).toBe(0);
  });

  // The same suppression must not leak onto a DIFFERENT chat settling — only
  // the exact chat the surface has open is withheld.
  it('still toasts a focused surface when a DIFFERENT chat settles', async () => {
    const focused = await connectDesktop(0, 'srf-desktop');
    focused.send({ type: 'chat.focus_change', chatId: 'c-focused' });
    await new Promise((r) => setTimeout(r, 50));

    completeATurn('c-elsewhere');

    await focused.waitForCount('notify', 1);
    expect((focused.frames.find((f) => f.type === 'notify') as { chatId: string }).chatId).toBe(
      'c-elsewhere',
    );
  });

  // spec/08 § Action — `notifyOnComplete`. THE WIRING TEST: the gate reads two
  // pieces of state the unit test injects (the chatId → jobId link and the job
  // store), and `buildAll` builds them at very different points in its body.
  // This drives the whole path for real — a job created over REST, fired
  // through the real dispatcher, its chat settled on the real host link.
  describe('a job that has turned its doorbell off', () => {
    const base = {
      type: 'spawn',
      daemonId: 'd1',
      folder: '/home/tom/projects/bed-planner',
      prompt: 'go',
    };

    /** Create a job, fire it once, and return the chatId the fire allocated. */
    async function fireJob(action: Record<string, unknown>): Promise<string> {
      const created = await api('POST', '/api/jobs', {
        name: 'five-minute tick',
        trigger: { type: 'cron', expression: '0 9 * * *' },
        action,
      });
      const before = link.sent.length;
      await api('POST', `/api/jobs/${created.id}/run`);
      const spawn = link.sent
        .slice(before)
        .map((s) => s.event)
        .find((e) => e.type === 'chat.spawn_request');
      if (spawn === undefined || spawn.type !== 'chat.spawn_request') {
        throw new Error('the manual run dispatched no chat.spawn_request');
      }
      if (spawn.chatId === undefined) throw new Error('the spawn frame carries no chatId');
      return spawn.chatId;
    }

    it('stays silent on both channels when its chat settles', async () => {
      const log = await connectDesktop();
      // Nobody at the machine, so an unsilenced job would push as well as
      // toast — both have to stay quiet.
      now += 5 * 60_000;
      const chatId = await fireJob({ ...base, notifyOnComplete: false });
      completeATurn(chatId);

      // Give both channels every turn of the event loop they would need.
      for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 20));
      expect(log.count('notify')).toBe(0);
      expect(pushed).toHaveLength(0);
    });

    it('a job that never set the flag still rings, through the same path', async () => {
      const log = await connectDesktop();
      const chatId = await fireJob(base);
      completeATurn(chatId);

      await log.waitForCount('notify', 1);
      expect((log.frames.find((f) => f.type === 'notify') as { channel: string }).channel).toBe(
        'desktop',
      );
    });

    // The gate must not leak past the job's own chats: a chat nobody's job
    // created behaves exactly as it did before any of this existed.
    it('a chat no job created still rings while a silenced job exists', async () => {
      const log = await connectDesktop();
      await fireJob({ ...base, notifyOnComplete: false });
      completeATurn('c-hand-started');

      await log.waitForCount('notify', 1);
      expect((log.frames.find((f) => f.type === 'notify') as { chatId: string }).chatId).toBe(
        'c-hand-started',
      );
    });
  });
});
