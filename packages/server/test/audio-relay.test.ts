// Cross-host audio relay (audio-relay.ts, spec/07 § Voice is a per-host
// capability) — real server, real WSS on both legs of `/audio/:sessionId`
// (the surface-facing socket AND a bare `ws` server standing in for the
// host's own :3003 audio WSS, which this relay never talks to in-process —
// it only knows the address a `daemon.host` report names). The host LINK
// itself is `InProcessDaemonLink` (a synchronous test seam already used by
// `voice-token.test.ts`): a real host socket's hello handshake is async and
// its own `daemon.host`/`chat.spawned` frames race the auth completing (b1's
// own daemon-connect test proves the handshake elsewhere), which has nothing
// to do with what this file actually verifies — the relay's routing/piping.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import type { WireEvent } from '@patch/wire';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { PresenceTracker } from '../src/presence.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
}

interface Received {
  data: Buffer;
  isBinary: boolean;
}

/**
 * Collects every message from the moment it's constructed — a refusal frame
 * can arrive the instant the WSS opens (the relay sends it as soon as it can
 * resolve the session, with nothing else to wait on), so attaching a listener
 * only after `await`ing 'open' can lose it: 'open' and 'message' can both be
 * delivered in the same underlying socket read, ahead of the microtask that
 * `await` resumes on. Mirrors `b1-real-ws.test.ts`'s `FrameLog`.
 */
class MessageLog {
  private readonly received: Received[] = [];
  constructor(ws: WebSocket) {
    ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      this.received.push({
        data: Array.isArray(data) ? Buffer.concat(data) : (data as Buffer),
        isBinary,
      });
    });
  }
  async next(timeoutMs = 3000): Promise<Received> {
    const start = Date.now();
    while (this.received.length === 0) {
      if (Date.now() - start > timeoutMs) throw new Error('timeout waiting for message');
      await new Promise((r) => setTimeout(r, 10));
    }
    return this.received.shift() as Received;
  }
}

function waitClose(ws: WebSocket, timeoutMs = 3000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for close')), timeoutMs);
    ws.once('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

describe("audio relay: /audio/:sessionId routes to the session's own host", () => {
  let dataDir: string;
  let serverUrl: string;
  let serverPort: number;
  let closeServer: () => Promise<void>;
  let user: { publicKey: string; privateKey: string };
  let daemonLink: InProcessDaemonLink;
  let fakeUpstream: WebSocketServer;
  let fakeUpstreamPort: number;

  const DAEMON_ID = 'daemon-mac-1';
  const CHAT_ID = 'chat-on-mac-1';

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'patch-audio-relay-'));
    user = generateUserKeypair();

    const registry = Registry.load(dataDir);
    registry.bootstrapAccount({ keypair: user });
    registry.setDaemonKey({
      daemonId: DAEMON_ID,
      publicKey: user.publicKey,
      issuedAt: Math.floor(Date.now() / 1000),
    });
    registry.upsertSurface({
      surfaceId: 'srf-audio-relay-1',
      surfaceKind: 'web',
      label: 'browser',
      issuedAt: Math.floor(Date.now() / 1000),
    });

    // Stand-in for the Mac host's own audio WSS at :3003 — a bare `ws`
    // server, exactly as reachable-but-otherwise-opaque as the real thing is
    // to this relay (it only pipes bytes; it never runs the STT/TTS pipeline).
    fakeUpstream = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => fakeUpstream.once('listening', resolve));
    fakeUpstreamPort = (fakeUpstream.address() as AddressInfo).port;

    daemonLink = new InProcessDaemonLink();
    daemonLink.setDaemonId(DAEMON_ID);

    const { app } = await buildAll({
      registry,
      presence: new PresenceTracker(),
      logger: false,
      internalToken: 'test-internal-token-not-for-prod-aaaa',
      daemonLink,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });

    // The chat's host self-describes with an audioRelayHost pointing at the
    // fake upstream, and spawns the chat this test relays a session for —
    // AFTER buildAll, whose wiring (chatRegistry.observe, wsHub's host cache)
    // is what actually listens for these; emitting earlier is emitting to no
    // one, since `InProcessDaemonLink.emit` delivers synchronously to
    // whatever is subscribed at the moment it is called.
    daemonLink.emit({
      type: 'daemon.host',
      daemonId: DAEMON_ID,
      hostName: 'Mac',
      platform: 'darwin',
      arch: 'arm64',
      daemonVersion: '0.1.0',
      updateAvailable: false,
      permissionModeDefault: 'default',
      permissionOverrides: 0,
      isHomeHost: false,
      audioRelayHost: `127.0.0.1:${fakeUpstreamPort}`,
      backends: [],
      components: [],
    } as unknown as WireEvent);
    daemonLink.emit({
      type: 'chat.spawned',
      chatId: CHAT_ID,
      daemonId: DAEMON_ID,
      folder: '/home/tom/project',
    });
    const addr = app.server.address() as AddressInfo;
    serverPort = addr.port;
    serverUrl = `ws://127.0.0.1:${serverPort}`;
    closeServer = () => app.close();
  });

  afterEach(async () => {
    fakeUpstream.close();
    await closeServer();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function mintToken(): Promise<{ sessionId: string; audioUrl: string }> {
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-audio-relay-1',
      surfaceKind: 'web',
      label: 'browser',
    });
    const res = await fetch(`http://127.0.0.1:${serverPort}/api/voice/token`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: CHAT_ID, role: 'voice-note', surfaceKind: 'web' }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { sessionId: string; audioUrl: string };
  }

  it("relays a text frame up and a binary frame down, to and from the chat's OWN host", async () => {
    const { audioUrl } = await mintToken();

    const upstreamConnected = new Promise<WebSocket>((resolve) => {
      fakeUpstream.once('connection', (ws) => resolve(ws));
    });
    const client = new WebSocket(`${serverUrl}${audioUrl}`);
    const clientLog = new MessageLog(client);
    await waitOpen(client);
    const upstream = await upstreamConnected;
    const upstreamLog = new MessageLog(upstream);

    // Up leg: the surface's `audio.session_start` (a JSON text frame) arrives
    // at the host's own audio WSS unchanged.
    client.send(JSON.stringify({ type: 'audio.session_start', chatId: CHAT_ID }));
    const up = await upstreamLog.next();
    expect(up.isBinary).toBe(false);
    expect(JSON.parse(up.data.toString('utf8'))).toEqual({
      type: 'audio.session_start',
      chatId: CHAT_ID,
    });

    // Down leg: raw PCM16 binary from the "daemon" reaches the surface intact.
    const pcm = Buffer.from(new Int16Array([1, 2, 3, -1]).buffer);
    upstream.send(pcm);
    const down = await clientLog.next();
    expect(down.isBinary).toBe(true);
    expect(Buffer.compare(down.data, pcm)).toBe(0);

    client.close();
  });

  it('queues a frame sent before the upstream leg finishes connecting, and still delivers it in order', async () => {
    const { audioUrl } = await mintToken();
    const upstreamConnected = new Promise<WebSocket>((resolve) => {
      fakeUpstream.once('connection', (ws) => resolve(ws));
    });
    const client = new WebSocket(`${serverUrl}${audioUrl}`);
    // Sent the instant the client's own socket opens — same timing as
    // `audioSession.ts`'s real `audio.session_start`, which races the
    // relay's still-connecting upstream leg (network hop to another host).
    client.once('open', () => client.send('first'));
    const upstream = await upstreamConnected;
    const upstreamLog = new MessageLog(upstream);
    const got = await upstreamLog.next();
    expect(got.data.toString('utf8')).toBe('first');
    client.close();
  });

  it('refuses a sessionId this server never minted a route for (session_not_found, then closes)', async () => {
    const client = new WebSocket(`${serverUrl}/audio/not-a-real-session`);
    const clientLog = new MessageLog(client);
    const closePromise = waitClose(client);
    const got = await clientLog.next();
    expect(JSON.parse(got.data.toString('utf8'))).toMatchObject({
      type: 'audio.error',
      code: 'session_not_found',
    });
    expect(await closePromise).toBe(4400);
  });

  it('refuses a session whose host has gone offline since the token was minted (host_unreachable)', async () => {
    const { audioUrl } = await mintToken();
    daemonLink.forget(DAEMON_ID);
    const client = new WebSocket(`${serverUrl}${audioUrl}`);
    const clientLog = new MessageLog(client);
    const closePromise = waitClose(client);
    const got = await clientLog.next();
    expect(JSON.parse(got.data.toString('utf8'))).toMatchObject({
      type: 'audio.error',
      code: 'host_unreachable',
    });
    await closePromise;
  });
});

function waitFor<T>(pred: () => T | undefined, timeoutMs = 3000): Promise<T> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      const found = pred();
      if (found !== undefined) {
        resolve(found);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`waitFor: no match after ${timeoutMs}ms`));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe('audio relay: tunnelled over the host link (no audioRelayHost declared)', () => {
  let dataDir: string;
  let serverUrl: string;
  let serverPort: number;
  let closeServer: () => Promise<void>;
  let user: { publicKey: string; privateKey: string };
  let daemonLink: InProcessDaemonLink;

  const DAEMON_ID = 'daemon-remote-1';
  const CHAT_ID = 'chat-on-remote-1';

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'patch-audio-relay-tunnel-'));
    user = generateUserKeypair();

    const registry = Registry.load(dataDir);
    registry.bootstrapAccount({ keypair: user });
    registry.setDaemonKey({
      daemonId: DAEMON_ID,
      publicKey: user.publicKey,
      issuedAt: Math.floor(Date.now() / 1000),
    });
    registry.upsertSurface({
      surfaceId: 'srf-audio-relay-tunnel-1',
      surfaceKind: 'web',
      label: 'browser',
      issuedAt: Math.floor(Date.now() / 1000),
    });

    daemonLink = new InProcessDaemonLink();
    daemonLink.setDaemonId(DAEMON_ID);

    const { app } = await buildAll({
      registry,
      presence: new PresenceTracker(),
      logger: false,
      internalToken: 'test-internal-token-not-for-prod-aaaa',
      daemonLink,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });

    // This host reports NO audioRelayHost at all — the real-world default for
    // any host that isn't co-located with the server (config.ts).
    daemonLink.emit({
      type: 'daemon.host',
      daemonId: DAEMON_ID,
      hostName: 'Tom’s MacBook Pro',
      platform: 'darwin',
      arch: 'arm64',
      daemonVersion: '0.1.0',
      updateAvailable: false,
      permissionModeDefault: 'default',
      permissionOverrides: 0,
      isHomeHost: false,
      backends: [],
      components: [],
    } as unknown as WireEvent);
    daemonLink.emit({
      type: 'chat.spawned',
      chatId: CHAT_ID,
      daemonId: DAEMON_ID,
      folder: '/home/tom/project',
    });
    const addr = app.server.address() as AddressInfo;
    serverPort = addr.port;
    serverUrl = `ws://127.0.0.1:${serverPort}`;
    closeServer = () => app.close();
  });

  afterEach(async () => {
    await closeServer();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function mintToken(): Promise<{ sessionId: string; audioUrl: string }> {
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-audio-relay-tunnel-1',
      surfaceKind: 'web',
      label: 'browser',
    });
    const res = await fetch(`http://127.0.0.1:${serverPort}/api/voice/token`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: CHAT_ID, role: 'voice-note', surfaceKind: 'web' }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { sessionId: string; audioUrl: string };
  }

  it('opens the bridge over the host link, then tunnels a text frame up and a binary frame down, tagged by sessionId', async () => {
    const { sessionId, audioUrl } = await mintToken();
    const client = new WebSocket(`${serverUrl}${audioUrl}`);
    const clientLog = new MessageLog(client);
    await waitOpen(client);

    // The server asked THIS host (not a direct dial) to bridge the session.
    const openFrame = await waitFor(() =>
      daemonLink.sent.find(
        (s) => s.event.type === 'patch.audio_relay.open' && s.daemonId === DAEMON_ID,
      ),
    );
    expect((openFrame.event as { sessionId: string }).sessionId).toBe(sessionId);

    // Up leg: the surface's text frame is tunnelled, base64, tagged with this sessionId.
    client.send(JSON.stringify({ type: 'audio.session_start', chatId: CHAT_ID }));
    const upFrame = await waitFor(() =>
      daemonLink.sent.find(
        (s) =>
          s.event.type === 'patch.audio_relay.frame' &&
          (s.event as { sessionId: string }).sessionId === sessionId,
      ),
    );
    const upEvent = upFrame.event as { data: string; binary: boolean };
    expect(upEvent.binary).toBe(false);
    expect(JSON.parse(Buffer.from(upEvent.data, 'base64').toString('utf8'))).toEqual({
      type: 'audio.session_start',
      chatId: CHAT_ID,
    });

    // Down leg: the "daemon" (simulated) tunnels a binary PCM frame back; the
    // surface receives it as a real binary WS frame, not the JSON envelope.
    const pcm = Buffer.from(new Int16Array([1, 2, 3, -1]).buffer);
    daemonLink.emit(
      {
        type: 'patch.audio_relay.frame',
        sessionId,
        data: pcm.toString('base64'),
        binary: true,
      } as unknown as WireEvent,
      DAEMON_ID,
    );
    const down = await clientLog.next();
    expect(down.isBinary).toBe(true);
    expect(Buffer.compare(down.data, pcm)).toBe(0);

    client.close();
  });

  it("tells the surface host_unreachable when the host's local bridge fails (patch.audio_relay.error) — NO FALLBACK", async () => {
    const { sessionId, audioUrl } = await mintToken();
    const client = new WebSocket(`${serverUrl}${audioUrl}`);
    const clientLog = new MessageLog(client);
    const closePromise = waitClose(client);
    await waitOpen(client);
    daemonLink.emit(
      {
        type: 'patch.audio_relay.error',
        sessionId,
        code: 'connect_failed',
        message: 'voice is not installed on this host',
      } as unknown as WireEvent,
      DAEMON_ID,
    );
    const got = await clientLog.next();
    expect(JSON.parse(got.data.toString('utf8'))).toMatchObject({
      type: 'audio.error',
      code: 'host_unreachable',
    });
    await closePromise;
  });

  it('tells the surface host_unreachable, loudly, when the owning host goes offline MID-SESSION', async () => {
    const { audioUrl } = await mintToken();
    const client = new WebSocket(`${serverUrl}${audioUrl}`);
    const clientLog = new MessageLog(client);
    const closePromise = waitClose(client);
    await waitOpen(client);
    daemonLink.forget(DAEMON_ID);
    const got = await clientLog.next();
    expect(JSON.parse(got.data.toString('utf8'))).toMatchObject({
      type: 'audio.error',
      code: 'host_unreachable',
    });
    await closePromise;
  });

  it('closing the surface socket tells the host to close its half of the bridge', async () => {
    const { sessionId, audioUrl } = await mintToken();
    const client = new WebSocket(`${serverUrl}${audioUrl}`);
    await waitOpen(client);
    await waitFor(() => daemonLink.sent.find((s) => s.event.type === 'patch.audio_relay.open'));
    client.close();
    const closeFrame = await waitFor(() =>
      daemonLink.sent.find(
        (s) =>
          s.event.type === 'patch.audio_relay.close' &&
          (s.event as { sessionId: string }).sessionId === sessionId,
      ),
    );
    expect(closeFrame.daemonId).toBe(DAEMON_ID);
  });

  it("a patch.audio_relay.close FROM the host closes the surface's own socket", async () => {
    const { sessionId, audioUrl } = await mintToken();
    const client = new WebSocket(`${serverUrl}${audioUrl}`);
    const closePromise = waitClose(client);
    await waitOpen(client);
    daemonLink.emit(
      { type: 'patch.audio_relay.close', sessionId } as unknown as WireEvent,
      DAEMON_ID,
    );
    await closePromise;
  });
});
