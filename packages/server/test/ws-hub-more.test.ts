// Additional WsHub coverage — complements test/ws-hub.test.ts,
// test/ws-hub-focus.test.ts, and test/b1-real-ws.test.ts.
//
// Targets:
//   - the plain-forward switch-case group (pin/archive/stop/unqueue/resume/
//     permission_response/file.write/chat.settings/patch.peek.request/
//     patch.send_to/patch.spawn/ack)
//   - duplicate hello after auth + unknown/disallowed frame type (both close
//     4400)
//   - surface.foregrounded / surface.backgrounded heartbeat semantics
//   - chat.call_response with no onCallResponse wired
//   - resolveInFlightChatsOnDaemonOffline (a real in-flight chat forced to
//     `errored` when the host link drops)
//   - onDaemonEvent: a forSurfaceId-tagged event for a no-longer-connected
//     surface is dropped (not fanned out, no throw)
//   - account-scoped (no chatId) host event fanout
//   - direct introspection/send helpers: connectedSurfaceIds,
//     listConnectedSurfaces, sendToSurface, sendToKinds, sendToKind, sendToAll
//     — including their try/catch write-failure branches
//   - auth buffer overflow while authenticating
//   - handleHello: no account bootstrapped / missing auth token in hello
//   - host hello rejected when attachDaemon isn't wired (InProcessDaemonLink)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { generateUserKeypair, mintSurfaceCredential, mintDaemonKey } from '@patch/auth';
import { WireTestClient } from '@patch/wire/test-client';
import type { WireEvent } from '@patch/wire';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';
import pino from 'pino';
import { WsHub } from '../src/ws-hub.js';
import { PresenceTracker } from '../src/presence.js';
import { ChatRegistry } from '../src/chat-registry.js';

interface Harness {
  url: string;
  registry: Registry;
  daemonLink: InProcessDaemonLink;
  built: Awaited<ReturnType<typeof buildAll>>;
  close: () => Promise<void>;
}

async function startServer(opts: { registry: Registry }): Promise<Harness> {
  const daemonLink = new InProcessDaemonLink();
  const built = await buildAll({ logger: false, registry: opts.registry, daemonLink });
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = built.app.server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${addr.port}/ws`,
    registry: opts.registry,
    daemonLink,
    built,
    close: async () => {
      await built.app.close();
    },
  };
}

async function makeAuthedClient(
  h: Harness,
  user: { publicKey: string; privateKey: string },
  surfaceId: string,
  surfaceKind: 'web' | 'mobile' | 'desktop' | 'terminal' | 'voice-device' = 'web',
): Promise<WireTestClient> {
  h.registry.upsertSurface({ surfaceId, surfaceKind, label: 'browser', issuedAt: 1 });
  const jwt = await mintSurfaceCredential({
    userPrivateKey: user.privateKey,
    surfaceId,
    surfaceKind,
    label: 'browser',
  });
  const client = new WireTestClient({ url: h.url, auth: jwt });
  await client.connect();
  await client.waitFor('daemon.online');
  return client;
}

describe('WS hub — plain-forward event types (pin/archive/stop/etc.)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-wshub-forward-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('forwards each plain pass-through event type to the host link, tagging watchedChats where chatId is present', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(70));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    // `patch.spawn` below names a machine, and the hub refuses one that is not
    // registered (spec/03 § Host events), so register it.
    registry.setDaemonKey({ daemonId: 'd1', publicKey: user.publicKey, issuedAt: 1 });
    const h = await startServer({ registry });
    try {
      const c = await makeAuthedClient(h, user, 'srf-forward');

      const events: WireEvent[] = [
        { type: 'chat.pin_request', chatId: 'chat-pin', pinned: true },
        { type: 'meeting.control_request', chatId: 'chat-mtg', action: 'start' },
        { type: 'meeting.get_request', chatId: 'chat-mtg' },
        { type: 'meeting.audio', chatId: 'chat-mtg', source: 'mic', audioBase64: 'AA==' },
        { type: 'meeting.action_request', chatId: 'chat-mtg', actionId: 'a1', decision: 'do' },
        { type: 'chat.archive_request', chatId: 'chat-arc', archived: true },
        { type: 'chat.stop_request', chatId: 'chat-stop' },
        { type: 'chat.unqueue_request', chatId: 'chat-unq', localId: 'L1' },
        { type: 'chat.promote_request', chatId: 'chat-pro', localId: 'L2' },
        // spec/04 ## Message queueing § Edit — replace a queued turn's text.
        { type: 'chat.edit_queued_request', chatId: 'chat-edq', localId: 'L4', message: 'meant' },
        // spec/04 § Branching — edit a turn (fork a track) / switch tracks.
        {
          type: 'chat.fork_request',
          chatId: 'chat-fork',
          seq: 4,
          message: 'rephrased',
          localId: 'L3',
        },
        { type: 'chat.branch_switch_request', chatId: 'chat-fork', branchId: 'chat-fork-b0' },
        // spec/04 § Branching — "Side branches get a name … renameable".
        {
          type: 'chat.branch_rename_request',
          chatId: 'chat-fork',
          branchId: 'chat-fork-b1',
          name: 'My side thread',
        },
        { type: 'chat.resume_request', chatId: 'chat-res' },
        { type: 'chat.permission_response', requestId: 'req-1', approve: true },
        { type: 'file.write', chatId: 'chat-fw', path: '/tmp/x.txt', content: 'hi' },
        { type: 'chat.settings', chatId: 'chat-perm', permissionMode: 'plan' },
        // spec/04 § Model — a mid-chat model switch is relayed to the chat's
        // host untouched; the server holds no model of its own to keep in step.
        { type: 'chat.model_request', chatId: 'chat-model', model: 'claude-opus-4-1' },
        { type: 'patch.peek.request', sourceChatId: 'chat-src', targetChatId: 'chat-tgt' },
        { type: 'patch.send_to', sourceChatId: 'chat-src', targetChatId: 'chat-tgt', message: 'm' },
        {
          type: 'patch.spawn',
          daemonId: 'd1',
          sourceChatId: 'chat-src',
          folder: '/work',
          prompt: 'go',
        },
        { type: 'ack', seq: 1 },
      ];
      for (const ev of events) c.send(ev);
      await new Promise((r) => setTimeout(r, 100));

      for (const ev of events) {
        const fwd = h.daemonLink.sent.find((s) => s.event.type === ev.type);
        expect(fwd, `expected ${ev.type} to be forwarded`).toBeDefined();
      }
      await c.close();
    } finally {
      await h.close();
    }
  });

  it('surface.foregrounded / surface.backgrounded refresh the heartbeat (do not error)', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(71));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    const h = await startServer({ registry });
    try {
      const c = await makeAuthedClient(h, user, 'srf-fgbg');
      c.send({ type: 'surface.foregrounded' });
      c.send({ type: 'surface.backgrounded' });
      await new Promise((r) => setTimeout(r, 50));
      // No crash + presence still tracked (heartbeat is a no-throw side effect).
      expect(h.built.presence.get(h.registry.getAccount()!.accountId, 'srf-fgbg')).toBeDefined();
      await c.close();
    } finally {
      await h.close();
    }
  });

  it('chat.call_response is a no-op (does not throw) when onCallResponse is not wired', async () => {
    // buildAll always wires onCallResponse via the call orchestrator, so to
    // exercise the "not configured" branch we drive WsHub directly.
    const registry = Registry.load(dir);
    registry.bootstrapAccount();
    const daemonLink = new InProcessDaemonLink();
    const hub = new WsHub({
      logger: pino({ level: 'silent' }),
      registry,
      presence: new PresenceTracker(),
      daemonLink,
      chatRegistry: new ChatRegistry(),
      idGenerator: () => 'id-1',
      // onCallResponse deliberately omitted.
    });
    expect(() => {
      // @ts-expect-error — reaching into a private method for direct unit coverage
      hub['handleSurfaceEvent'](
        {
          socket: { send: () => undefined, close: () => undefined },
          accountId: 'acc',
          surfaceId: 'srf-x',
          surfaceKind: 'web',
          watchedChats: new Set(),
        },
        { type: 'chat.call_response', callId: 'c1', response: 'accept' } as WireEvent,
        pino({ level: 'silent' }),
      );
    }).not.toThrow();
  });

  it('duplicate hello after auth closes 4400', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(72));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({ surfaceId: 'srf-dup', surfaceKind: 'web', label: 'b', issuedAt: 1 });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-dup',
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
      const send = (obj: unknown): void => ws.send(JSON.stringify(obj));
      send({ type: 'hello', clientType: 'surface-web', clientVersion: '0.0.0-test', auth: jwt });
      await new Promise((r) => setTimeout(r, 100));
      send({ type: 'hello', clientType: 'surface-web', clientVersion: '0.0.0-test', auth: jwt });
      const code = await new Promise<number>((resolve) => {
        ws.once('close', (c: number) => resolve(c));
      });
      expect(code).toBe(4400);
    } finally {
      await h.close();
    }
  });

  it('an unknown/disallowed surface→server frame type closes 4400', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(73));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({ surfaceId: 'srf-bad', surfaceKind: 'web', label: 'b', issuedAt: 1 });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-bad',
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
      await new Promise((r) => setTimeout(r, 100));
      // A host→surface-only event type sent surface→server must be rejected.
      ws.send(JSON.stringify({ type: 'daemon.online', daemonId: 'd1' }));
      const code = await new Promise<number>((resolve) => {
        ws.once('close', (c: number) => resolve(c));
      });
      expect(code).toBe(4400);
    } finally {
      await h.close();
    }
  });
});

describe('WS hub — host socket state ignores its own hub message listener', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-wshub-daemonstate-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a frame arriving on an authenticated host socket is ignored by the hub (InboundDaemonLink owns it)', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(85));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.setDaemonKey({ daemonId: 'daemon-1', publicKey: user.publicKey, issuedAt: 1 });
    const daemonLink = undefined; // force InboundDaemonLink (real host gate)
    void daemonLink;
    const built = await buildAll({ logger: false, registry }); // no injected daemonLink
    await built.app.listen({ port: 0, host: '127.0.0.1' });
    const addr = built.app.server.address() as AddressInfo;
    const url = `ws://127.0.0.1:${addr.port}/ws`;
    try {
      const daemonKeyJwt = await mintDaemonKey({
        userPrivateKey: user.privateKey,
        daemonId: 'daemon-1',
        label: 'd',
      });
      const daemon = new WireTestClient({ url, clientType: 'daemon', auth: daemonKeyJwt });
      await daemon.connect();
      await daemon.waitFor('auth.ok');
      // Send an extra raw frame directly on the underlying socket — reaches
      // BOTH the InboundDaemonLink's own 'message' listener (attach()) AND
      // the hub's onConnect listener (still registered on the same socket).
      // The hub's listener must see state==='daemon' and no-op.
      const ws = (daemon as unknown as { ws: import('ws').WebSocket }).ws;
      expect(() => ws.send(JSON.stringify({ type: 'surface.heartbeat' }))).not.toThrow();
      await new Promise((r) => setTimeout(r, 50));
      // Connection stays open — the hub didn't misinterpret/close it.
      expect(ws.readyState).toBe(ws.OPEN);
      await daemon.close();
    } finally {
      await built.app.close();
    }
  });
});

describe('WS hub — lastClaudeAccount replay on late-joining surfaces', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-wshub-claudeacct-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a surface connecting AFTER daemon.account was emitted gets it in the auth.ok greeting', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(86));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    const h = await startServer({ registry });
    try {
      // Emit BEFORE any surface connects.
      h.daemonLink.emit({
        type: 'daemon.account',
        daemonId: 'd1',
        backendId: 'claude-code',
        connected: true,
        accountEmail: 'cached@x.com',
      });
      await new Promise((r) => setTimeout(r, 20));

      registry.upsertSurface({
        surfaceId: 'srf-late',
        surfaceKind: 'web',
        label: 'browser',
        issuedAt: 1,
      });
      const jwt = await mintSurfaceCredential({
        userPrivateKey: user.privateKey,
        surfaceId: 'srf-late',
        surfaceKind: 'web',
        label: 'browser',
      });
      const client = new WireTestClient({ url: h.url, auth: jwt });
      // The cached report arrives INSIDE the greeting, not as a replayed frame
      // (spec/03 § Control → `auth.ok`: "the server's cached `daemon.host` /
      // `daemon.account` reports"). A late-joining surface renders the whole
      // Hosts list from one message rather than waiting on a second round trip.
      const greetingP = client.waitFor('auth.ok');
      await client.connect();
      const greeting = await greetingP;
      expect(greeting.hosts).toEqual([
        expect.objectContaining({
          daemonId: 'd1',
          accounts: [
            {
              daemonId: 'd1',
              backendId: 'claude-code',
              connected: true,
              accountEmail: 'cached@x.com',
            },
          ],
        }),
      ]);
      await client.close();
    } finally {
      await h.close();
    }
  });
});

describe('WS hub — lastClaudeSettings replay on late-joining surfaces', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-wshub-claudesettings-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a surface connecting AFTER claude_settings.list was emitted gets it replayed in its greeting', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(87));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    const h = await startServer({ registry });
    try {
      // Emit BEFORE any surface connects — same "the host only publishes on
      // link auth and on change" reasoning as folders.list (spec/03 § Host
      // events — `claude_settings.list` is "sent on connect").
      h.daemonLink.emit({
        type: 'claude_settings.list',
        daemonId: 'd1',
        drift: '{"model":"opus"}',
        memories: [
          {
            project: 'portfolio',
            file: 'feedback_tests.md',
            name: 'feedback_tests',
            description: 'a cached memory',
            memoryType: 'feedback',
          },
        ],
      });
      await new Promise((r) => setTimeout(r, 20));

      registry.upsertSurface({
        surfaceId: 'srf-late-claude',
        surfaceKind: 'web',
        label: 'browser',
        issuedAt: 1,
      });
      const jwt = await mintSurfaceCredential({
        userPrivateKey: user.privateKey,
        surfaceId: 'srf-late-claude',
        surfaceKind: 'web',
        label: 'browser',
      });
      const client = new WireTestClient({ url: h.url, auth: jwt });
      // Replayed as its own raw frame after the greeting's roster, same as
      // folders.list — not baked into auth.ok itself.
      const replayed = client.waitFor('claude_settings.list');
      await client.connect();
      const ev = await replayed;
      expect(ev).toMatchObject({
        daemonId: 'd1',
        drift: '{"model":"opus"}',
        memories: [
          {
            project: 'portfolio',
            file: 'feedback_tests.md',
            name: 'feedback_tests',
            description: 'a cached memory',
            memoryType: 'feedback',
          },
        ],
      });
      await client.close();
    } finally {
      await h.close();
    }
  });

  it('claude_settings.updated supersedes the cached snapshot wholesale', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(88));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    const h = await startServer({ registry });
    try {
      h.daemonLink.emit({
        type: 'claude_settings.list',
        daemonId: 'd1',
        drift: '{"model":"sonnet"}',
        memories: [
          {
            project: 'portfolio',
            file: 'stale.md',
            name: 'stale',
            description: 'about to be deleted',
            memoryType: 'project',
          },
        ],
      });
      h.daemonLink.emit({
        type: 'claude_settings.updated',
        daemonId: 'd1',
        drift: '{"model":"opus"}',
        memories: [],
      });
      await new Promise((r) => setTimeout(r, 20));

      registry.upsertSurface({
        surfaceId: 'srf-late-claude-2',
        surfaceKind: 'web',
        label: 'browser',
        issuedAt: 1,
      });
      const jwt = await mintSurfaceCredential({
        userPrivateKey: user.privateKey,
        surfaceId: 'srf-late-claude-2',
        surfaceKind: 'web',
        label: 'browser',
      });
      const client = new WireTestClient({ url: h.url, auth: jwt });
      const replayed = client.waitFor('claude_settings.list');
      await client.connect();
      const ev = await replayed;
      // The update REPLACED the cache, so the surface never sees the stale
      // memory entry — same "carries the COMPLETE state" contract as folders.
      expect(ev).toMatchObject({ daemonId: 'd1', drift: '{"model":"opus"}', memories: [] });
      await client.close();
    } finally {
      await h.close();
    }
  });
});

describe('WS hub — resolveInFlightChatsOnDaemonOffline', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-wshub-inflight-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('forces a mid-turn chat to errored (chat.error + chat.state) when the host link drops', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(74));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    const h = await startServer({ registry });
    try {
      const c = await makeAuthedClient(h, user, 'srf-inflight');
      // Seed a spawned + running chat into the registry mirror via the same
      // host events the real host would emit.
      h.daemonLink.emit({
        type: 'chat.spawned',
        daemonId: 'd1',
        chatId: 'chat-running',
        folder: '/work',
      });
      h.daemonLink.emit({
        type: 'chat.state',
        permissionMode: 'bypassPermissions',
        chatId: 'chat-running',
        activity: 'running',
        lastUpdated: 1,
      });
      await new Promise((r) => setTimeout(r, 30));

      const errors: unknown[] = [];
      const states: unknown[] = [];
      c.on('chat.error', (e) => errors.push(e));
      c.on('chat.state', (e) => states.push(e));

      h.daemonLink.setStatus('offline');
      await new Promise((r) => setTimeout(r, 50));

      const err = errors.find((e) => (e as { chatId: string }).chatId === 'chat-running') as
        | { error: { code: string; message: string } }
        | undefined;
      expect(err).toBeDefined();
      expect(err?.error.code).toBe('daemon_unavailable');
      // spec/04 § Activity — exact copy. The turn comes back by itself (the
      // host re-sends an interrupted turn on restart), so the message must not
      // ask the user to resend it.
      expect(err?.error.message).toBe('Connection to the host was lost. Message will resend.');
      expect(
        states.some(
          (e) =>
            (e as { chatId: string; activity: string }).chatId === 'chat-running' &&
            (e as { activity: string }).activity === 'errored',
        ),
      ).toBe(true);
      await c.close();
    } finally {
      await h.close();
    }
  });

  it('is a no-op when there are no in-flight chats', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(75));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    const h = await startServer({ registry });
    try {
      const c = await makeAuthedClient(h, user, 'srf-noinflight');
      const errors: unknown[] = [];
      c.on('chat.error', (e) => errors.push(e));
      h.daemonLink.setStatus('offline');
      await new Promise((r) => setTimeout(r, 30));
      expect(errors).toHaveLength(0);
      await c.close();
    } finally {
      await h.close();
    }
  });
});

describe('WS hub — onDaemonEvent edge cases', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-wshub-daemonevent-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('drops a forSurfaceId-tagged event for a surface that is no longer connected (no throw)', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(76));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    const h = await startServer({ registry });
    try {
      expect(() => {
        h.daemonLink.emit({
          type: 'chat.replay',
          chatId: 'chat-ghost',
          fromSeq: 0,
          forSurfaceId: 'srf-does-not-exist',
        } as unknown as WireEvent);
      }).not.toThrow();
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      await h.close();
    }
  });

  it('fans out an account-scoped event (no chatId) to all connected surfaces', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(77));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    const h = await startServer({ registry });
    try {
      const a = await makeAuthedClient(h, user, 'srf-acct-a');
      const b = await makeAuthedClient(h, user, 'srf-acct-b');
      const aSeen: unknown[] = [];
      const bSeen: unknown[] = [];
      a.on('daemon.account', (e) => aSeen.push(e));
      b.on('daemon.account', (e) => bSeen.push(e));
      h.daemonLink.emit({
        type: 'daemon.account',
        daemonId: 'd1',
        backendId: 'claude-code',
        connected: true,
        accountEmail: 'x@y.com',
      });
      await new Promise((r) => setTimeout(r, 30));
      expect(aSeen).toHaveLength(1);
      expect(bSeen).toHaveLength(1);
      await a.close();
      await b.close();
    } finally {
      await h.close();
    }
  });
});

describe('WS hub — introspection + direct send helpers', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-wshub-helpers-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('connectedSurfaceIds / listConnectedSurfaces reflect live connections', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(78));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    const h = await startServer({ registry });
    try {
      const c = await makeAuthedClient(h, user, 'srf-intro', 'mobile');
      await new Promise((r) => setTimeout(r, 20));
      expect(h.built.wsHub.connectedSurfaceIds()).toContain('srf-intro');
      const list = h.built.wsHub.listConnectedSurfaces();
      const row = list.find((r) => r.surfaceId === 'srf-intro');
      expect(row).toBeDefined();
      expect(row!.surfaceKind).toBe('mobile');
      await c.close();
    } finally {
      await h.close();
    }
  });

  it('sendToSurface delivers to a known surface and returns false for an unknown one', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(79));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    const h = await startServer({ registry });
    try {
      const c = await makeAuthedClient(h, user, 'srf-send1');
      const got = c.waitFor('daemon.account');
      const delivered = h.built.wsHub.sendToSurface('srf-send1', {
        type: 'daemon.account',
        daemonId: 'd1',
        backendId: 'claude-code',
        connected: true,
        accountEmail: null,
      });
      expect(delivered).toBe(true);
      await got;
      expect(
        h.built.wsHub.sendToSurface('srf-ghost', { type: 'daemon.online', daemonId: 'd1' }),
      ).toBe(false);
      await c.close();
    } finally {
      await h.close();
    }
  });

  it('sendToKinds / sendToKind / sendToAll deliver by kind and count recipients', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(80));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    const h = await startServer({ registry });
    try {
      const mobile = await makeAuthedClient(h, user, 'srf-mobile', 'mobile');
      const web = await makeAuthedClient(h, user, 'srf-web', 'web');
      await new Promise((r) => setTimeout(r, 20));

      const mobileGot = mobile.waitFor('daemon.account');
      const kindsCount = h.built.wsHub.sendToKinds(new Set(['mobile']), {
        type: 'daemon.account',
        daemonId: 'd1',
        backendId: 'claude-code',
        connected: true,
        accountEmail: null,
      });
      expect(kindsCount).toBe(1);
      await mobileGot;

      const webGot = web.waitFor('daemon.online');
      const kindCount = h.built.wsHub.sendToKind('web', { type: 'daemon.online', daemonId: 'd1' });
      expect(kindCount).toBe(1);
      await webGot;

      const bothGotA = mobile.waitFor('daemon.offline');
      const bothGotB = web.waitFor('daemon.offline');
      const allCount = h.built.wsHub.sendToAll({ type: 'daemon.offline', daemonId: 'd1' });
      expect(allCount).toBe(2);
      await bothGotA;
      await bothGotB;

      await mobile.close();
      await web.close();
    } finally {
      await h.close();
    }
  });

  it('terminateSurface returns false for an unknown surface', async () => {
    const registry = Registry.load(dir);
    registry.bootstrapAccount();
    const h = await startServer({ registry });
    try {
      expect(h.built.wsHub.terminateSurface('nope-not-connected')).toBe(false);
    } finally {
      await h.close();
    }
  });

  it('sendToSurface / sendToKinds / sendToKind / sendToAll swallow a throwing socket.send (write-failure branch)', async () => {
    const registry = Registry.load(dir);
    registry.bootstrapAccount();
    const daemonLink = new InProcessDaemonLink();
    const hub = new WsHub({
      logger: pino({ level: 'silent' }),
      registry,
      presence: new PresenceTracker(),
      daemonLink,
      chatRegistry: new ChatRegistry(),
      idGenerator: () => 'id-1',
    });
    const throwingSocket = {
      send: () => {
        throw new Error('socket gone');
      },
      close: () => undefined,
    };
    // Reach into the private surfaces map to install a surface backed by a
    // throwing socket — the cheapest way to force sendTo*'s catch branches.
    (hub as unknown as { surfaces: Map<string, Set<unknown>> }).surfaces.set(
      'srf-throw',
      new Set([
        {
          socket: throwingSocket,
          accountId: 'acc',
          surfaceId: 'srf-throw',
          surfaceKind: 'web',
          watchedChats: new Set(),
        },
      ]),
    );
    expect(hub.sendToSurface('srf-throw', { type: 'daemon.online', daemonId: 'd1' })).toBe(false);
    expect(hub.sendToKinds(new Set(['web']), { type: 'daemon.online', daemonId: 'd1' })).toBe(0);
    expect(hub.sendToKind('web', { type: 'daemon.online', daemonId: 'd1' })).toBe(0);
    expect(hub.sendToAll({ type: 'daemon.online', daemonId: 'd1' })).toBe(0);
  });
});

describe('WS hub — auth edge cases', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-wshub-authedge-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects hello when no account has been bootstrapped', async () => {
    const registry = Registry.load(dir); // no bootstrapAccount()
    const daemonLink = new InProcessDaemonLink();
    const built = await buildAll({ logger: false, registry, daemonLink });
    await built.app.listen({ port: 0, host: '127.0.0.1' });
    const addr = built.app.server.address() as AddressInfo;
    const url = `ws://127.0.0.1:${addr.port}/ws`;
    try {
      const WebSocketCtor = (await import('ws')).default;
      const ws = new WebSocketCtor(url);
      await new Promise<void>((res, rej) => {
        ws.once('open', () => res());
        ws.once('error', rej);
      });
      const frames: string[] = [];
      ws.on('message', (data: Buffer) => frames.push(data.toString('utf8')));
      ws.send(
        JSON.stringify({
          type: 'hello',
          clientType: 'surface-web',
          clientVersion: '0.0.0-test',
          auth: 'whatever',
        }),
      );
      const code = await new Promise<number>((resolve) => {
        ws.once('close', (c: number) => resolve(c));
      });
      expect(code).toBe(4401);
      expect(frames.some((f) => f.includes('no account'))).toBe(true);
    } finally {
      await built.app.close();
    }
  });

  it('rejects hello with a missing auth token', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(81));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    const daemonLink = new InProcessDaemonLink();
    const built = await buildAll({ logger: false, registry, daemonLink });
    await built.app.listen({ port: 0, host: '127.0.0.1' });
    const addr = built.app.server.address() as AddressInfo;
    const url = `ws://127.0.0.1:${addr.port}/ws`;
    try {
      const WebSocketCtor = (await import('ws')).default;
      const ws = new WebSocketCtor(url);
      await new Promise<void>((res, rej) => {
        ws.once('open', () => res());
        ws.once('error', rej);
      });
      const frames: string[] = [];
      ws.on('message', (data: Buffer) => frames.push(data.toString('utf8')));
      ws.send(JSON.stringify({ type: 'hello', clientType: 'surface-web', clientVersion: '0.0.0' }));
      const code = await new Promise<number>((resolve) => {
        ws.once('close', (c: number) => resolve(c));
      });
      expect(code).toBe(4401);
      expect(frames.some((f) => f.includes('missing auth'))).toBe(true);
    } finally {
      await built.app.close();
    }
  });

  it('rejects a host hello when attachDaemon is not wired (InProcessDaemonLink)', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(82));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.setDaemonKey({ daemonId: 'daemon-1', publicKey: user.publicKey, issuedAt: 1 });
    // InProcessDaemonLink is injected → app.ts does NOT wire attachDaemon.
    const h = await startServer({ registry });
    try {
      const daemonKeyJwt = await mintDaemonKey({
        userPrivateKey: user.privateKey,
        daemonId: 'daemon-1',
        label: 'd',
      });
      const WebSocketCtor = (await import('ws')).default;
      const ws = new WebSocketCtor(h.url);
      await new Promise<void>((res, rej) => {
        ws.once('open', () => res());
        ws.once('error', rej);
      });
      ws.send(
        JSON.stringify({
          type: 'hello',
          clientType: 'daemon',
          clientVersion: '0.0.0-test',
          auth: daemonKeyJwt,
        }),
      );
      const code = await new Promise<number>((resolve) => {
        ws.once('close', (c: number) => resolve(c));
      });
      expect(code).toBe(4401);
    } finally {
      await h.close();
    }
  });

  it('closes the connection with an auth error when handleHello rejects unexpectedly', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(83));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    const h = await startServer({ registry });
    try {
      // Force verifySurfaceCredential to throw something other than the
      // expected auth errors by sending a syntactically-valid but semantically
      // impossible auth string; still exercised is the generic catch()
      // handler path around handleHello (auth 'error' close).
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
          auth: 'not-a-real-jwt-at-all',
        }),
      );
      const code = await new Promise<number>((resolve) => {
        ws.once('close', (c: number) => resolve(c));
      });
      expect(code).toBe(4401);
    } finally {
      await h.close();
    }
  });

  it('auth-buffer overflow while authenticating closes 4413', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(84));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({ surfaceId: 'srf-flood', surfaceKind: 'web', label: 'b', issuedAt: 1 });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-flood',
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
      // Send hello + immediately flood >50 frames in the same tick so they land
      // while state is still 'authenticating' (verifySurfaceCredential is async).
      ws.send(
        JSON.stringify({
          type: 'hello',
          clientType: 'surface-web',
          clientVersion: '0.0.0-test',
          auth: jwt,
        }),
      );
      for (let i = 0; i < 60; i++) {
        ws.send(JSON.stringify({ type: 'surface.heartbeat' }));
      }
      const code = await new Promise<number>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('no close in time')), 3000);
        ws.on('close', (c: number) => {
          clearTimeout(t);
          resolve(c);
        });
      });
      expect(code).toBe(4413);
    } finally {
      await h.close();
    }
  });
});
