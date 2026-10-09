// This host's half of the cross-host audio relay (audio-relay-bridge.ts,
// spec/07 § Voice is a per-host capability, spec/03 § Audio relay over the
// host link) — driven against a REAL local `ws` server standing in for
// this host's own audio WSS, exactly as opaque to the bridge as the real
// thing (it only pipes bytes; `audio/server.ts`'s own protocol is covered
// elsewhere).

import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import type { AudioRelayBridgeOutbound } from '../src/audio-relay-bridge.js';
import { AudioRelayBridge } from '../src/audio-relay-bridge.js';
import pino from 'pino';

const silent = pino({ level: 'silent' });

/**
 * Collects every message from the moment the socket is handed to it, not
 * from whenever a test gets around to `await`ing its way here — the bridge
 * flushes its queued frames the instant its own local socket opens, which can
 * land before a test's own microtask resumes and attaches a listener late
 * (same pitfall the server-side `audio-relay.test.ts`'s own `MessageLog`
 * documents).
 */
class MessageLog {
  private readonly received: Array<{ data: Buffer; isBinary: boolean }> = [];
  constructor(private readonly ws: WsSocket) {
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      this.received.push({ data, isBinary });
    });
  }
  send(data: Buffer): void {
    this.ws.send(data);
  }
  async next(timeoutMs = 3000): Promise<{ data: Buffer; isBinary: boolean }> {
    const start = Date.now();
    while (this.received.length === 0) {
      if (Date.now() - start > timeoutMs) throw new Error('timeout waiting for message');
      await new Promise((r) => setTimeout(r, 10));
    }
    return this.received.shift()!;
  }
}

/** This host's own local audio WSS, stood in by a bare `ws` server that logs connections AND their messages from the moment each connects. */
function startLocalAudioServer(): Promise<{
  wss: WebSocketServer;
  port: number;
  connections: MessageLog[];
}> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const connections: MessageLog[] = [];
  wss.on('connection', (ws: WsSocket) => connections.push(new MessageLog(ws)));
  return new Promise((resolve) => {
    wss.once('listening', () =>
      resolve({ wss, port: (wss.address() as AddressInfo).port, connections }),
    );
  });
}

function waitForCount<T>(arr: T[], count: number, timeoutMs = 3000): Promise<T[]> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (arr.length >= count) {
        resolve(arr);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`waitForCount: only ${arr.length}/${count} after ${timeoutMs}ms`));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

/** Unlike `waitForCount`, re-evaluates `pred` against the LIVE array every tick — a snapshot like `arr.filter(...)` taken once never grows. */
function waitUntil<T>(arr: T[], pred: (e: T) => boolean, timeoutMs = 3000): Promise<T> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      const found = arr.find(pred);
      if (found !== undefined) {
        resolve(found);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`waitUntil: no match after ${timeoutMs}ms`));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe('AudioRelayBridge', () => {
  let wss: WebSocketServer;

  afterEach(() => {
    wss?.close();
  });

  it('opens a local connection, flushes queued frames in order once open, and pipes both ways with the right text/binary tag', async () => {
    const started = await startLocalAudioServer();
    wss = started.wss;

    const sent: AudioRelayBridgeOutbound[] = [];
    const bridge = new AudioRelayBridge({
      logger: silent,
      localAudioUrl: `ws://127.0.0.1:${started.port}`,
      sender: (e) => sent.push(e),
    });

    bridge.handleOpen({ type: 'patch.audio_relay.open', sessionId: 'sess-1' });
    // Frames arriving before the local socket is open are queued, not dropped.
    bridge.handleFrame({
      type: 'patch.audio_relay.frame',
      sessionId: 'sess-1',
      data: Buffer.from('audio.session_start', 'utf8').toString('base64'),
      binary: false,
    });
    bridge.handleFrame({
      type: 'patch.audio_relay.frame',
      sessionId: 'sess-1',
      data: Buffer.from([1, 2, 3, 4]).toString('base64'),
      binary: true,
    });

    await waitForCount(started.connections, 1);
    const serverSide = started.connections[0]!;
    const up1 = await serverSide.next();
    expect(up1.isBinary).toBe(false);
    expect(up1.data.toString('utf8')).toBe('audio.session_start');
    const up2 = await serverSide.next();
    expect(up2.isBinary).toBe(true);
    expect(Buffer.compare(up2.data, Buffer.from([1, 2, 3, 4]))).toBe(0);

    // `ready` was sent once the local socket opened.
    expect(sent.some((e) => e.type === 'patch.audio_relay.ready' && e.sessionId === 'sess-1')).toBe(
      true,
    );

    // Down leg: the local server's own bytes are forwarded up, tagged correctly.
    serverSide.send(Buffer.from([9, 9]));
    const frame = (await waitUntil(sent, (e) => e.type === 'patch.audio_relay.frame')) as {
      data: string;
      binary: boolean;
    };
    expect(frame.binary).toBe(true);
    expect(Buffer.from(frame.data, 'base64')).toEqual(Buffer.from([9, 9]));

    bridge.dispose();
  });

  it('a duplicate open for the same sessionId is a no-op (one local connection, not two)', async () => {
    const started = await startLocalAudioServer();
    wss = started.wss;
    const bridge = new AudioRelayBridge({
      logger: silent,
      localAudioUrl: `ws://127.0.0.1:${started.port}`,
      sender: () => undefined,
    });
    bridge.handleOpen({ type: 'patch.audio_relay.open', sessionId: 'sess-dup' });
    bridge.handleOpen({ type: 'patch.audio_relay.open', sessionId: 'sess-dup' });
    await waitForCount(started.connections, 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(started.connections).toHaveLength(1);
    bridge.dispose();
  });

  it('close tears down the local socket and forgets the session', async () => {
    const started = await startLocalAudioServer();
    wss = started.wss;
    const bridge = new AudioRelayBridge({
      logger: silent,
      localAudioUrl: `ws://127.0.0.1:${started.port}`,
      sender: () => undefined,
    });
    bridge.handleOpen({ type: 'patch.audio_relay.open', sessionId: 'sess-close' });
    await waitForCount(started.connections, 1);
    expect(bridge.hasSession('sess-close')).toBe(true);
    bridge.handleClose({ type: 'patch.audio_relay.close', sessionId: 'sess-close' });
    await new Promise((r) => setTimeout(r, 50));
    expect(bridge.hasSession('sess-close')).toBe(false);
  });

  it('reports connect_failed (NO FALLBACK) when the local audio WSS refuses the connection', async () => {
    const sent: AudioRelayBridgeOutbound[] = [];
    const bridge = new AudioRelayBridge({
      logger: silent,
      // Nothing listens here — a closed port refuses immediately.
      localAudioUrl: 'ws://127.0.0.1:1',
      sender: (e) => sent.push(e),
    });
    bridge.handleOpen({ type: 'patch.audio_relay.open', sessionId: 'sess-fail' });
    await waitForCount(sent, 1);
    expect(sent[0]).toMatchObject({
      type: 'patch.audio_relay.error',
      sessionId: 'sess-fail',
      code: 'connect_failed',
    });
    expect(bridge.hasSession('sess-fail')).toBe(false);
  });

  it('a frame for a session with no open bridge is dropped, never sent anywhere', () => {
    const sent: AudioRelayBridgeOutbound[] = [];
    const bridge = new AudioRelayBridge({
      logger: silent,
      localAudioUrl: 'ws://127.0.0.1:1',
      sender: (e) => sent.push(e),
    });
    bridge.handleFrame({
      type: 'patch.audio_relay.frame',
      sessionId: 'never-opened',
      data: 'AAA=',
      binary: false,
    });
    expect(sent).toHaveLength(0);
  });
});
