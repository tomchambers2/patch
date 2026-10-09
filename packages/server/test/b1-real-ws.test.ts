// B1 real end-to-end: boot the REAL server over a real TCP/WS listener and
// connect REAL `ws` client sockets — no in-process fakes for the transport.
//
// Covers the B1 (server core) behaviours against a running instance:
//   1. Real host registers (Ed25519 key in registry.json) and connects to
//      GET /ws with a genuine EdDSA-JWT hello frame, verified via the stored
//      public key (jose); a forged-key daemonKey is rejected (close 4401).
//   2. daemon.online fans out to a connected surface; daemon.offline fans out
//      when the host socket drops.
//   3. A surface with a valid JWT connects and receives events; an invalid
//      JWT is rejected immediately after the hello frame.
//   4. Presence collapses (isActive→false) after 30s of no heartbeat; a fresh
//      heartbeat keeps it active.
//   5. GET /api/healthz returns 200.
//
// Anti-cheat: auth is the real @patch/auth EdDSA-JWT mint/verify against the
// real registered Ed25519 key — no dev bypass, no hardcoded accept.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { generateUserKeypair, mintSurfaceCredential, mintDaemonKey } from '@patch/auth';
import { decode, encode, type WireEvent } from '@patch/wire';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { PresenceTracker } from '../src/presence.js';

interface Harness {
  url: string;
  port: number;
  close: () => Promise<void>;
}

/** Open a real ws client, send a hello, collect frames. */
function connect(url: string): WebSocket {
  return new WebSocket(`${url}/ws`);
}

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
}

/** Wait until a frame of `type` arrives, or reject on close/timeout. */
function waitFrame(ws: WebSocket, type: WireEvent['type'], timeoutMs = 3000): Promise<WireEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
    const onMsg = (raw: WebSocket.RawData): void => {
      let ev: WireEvent;
      try {
        ev = decode(Array.isArray(raw) ? Buffer.concat(raw) : (raw as Buffer));
      } catch {
        return;
      }
      if (ev.type === type) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        resolve(ev);
      }
    };
    ws.on('message', onMsg);
  });
}

/**
 * Persistent frame recorder + an awaiter that resolves on the NEXT frame of a
 * given type recorded AFTER `since` frames (avoids the race where a greeting
 * arrives in the same tick a prior waitFrame listener is torn down).
 */
class FrameLog {
  readonly frames: WireEvent[] = [];
  constructor(ws: WebSocket) {
    ws.on('message', (raw: WebSocket.RawData) => {
      try {
        this.frames.push(decode(Array.isArray(raw) ? Buffer.concat(raw) : (raw as Buffer)));
      } catch {
        // ignore non-wire frames
      }
    });
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

/** Wait for the socket to close, resolving with the close code. */
function waitClose(ws: WebSocket, timeoutMs = 3000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for close')), timeoutMs);
    ws.once('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

describe('B1 real WS: host + surface auth, presence, healthz', () => {
  let dataDir: string;
  let harness: Harness;
  // The real user keypair (account identity). publicKey is stored in registry.
  let user: { publicKey: string; privateKey: string };
  let presence: PresenceTracker;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'patch-b1-'));
    user = generateUserKeypair();

    const registry = Registry.load(dataDir);
    registry.bootstrapAccount({ keypair: user });
    // Register the real host identity (Ed25519 key) in registry.json — the
    // server gates the host hello on this stored public key.
    registry.setDaemonKey({
      daemonId: 'daemon-real-1',
      publicKey: user.publicKey,
      issuedAt: Math.floor(Date.now() / 1000),
    });
    // A linked surface so a valid surface JWT is accepted.
    registry.upsertSurface({
      surfaceId: 'srf-real-1',
      surfaceKind: 'web',
      label: 'browser',
      issuedAt: Math.floor(Date.now() / 1000),
    });

    presence = new PresenceTracker();

    const { app } = await buildAll({ registry, presence, logger: false });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address() as AddressInfo;
    const port = addr.port;
    harness = {
      url: `ws://127.0.0.1:${port}`,
      port,
      close: async () => {
        await app.close();
      },
    };
  });

  afterEach(async () => {
    await harness.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('GET /api/healthz returns 200', async () => {
    const res = await fetch(`http://127.0.0.1:${harness.port}/api/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('real host connects with a genuine EdDSA-JWT; daemon.online reaches a surface', async () => {
    // 1. Surface connects first with a valid JWT.
    const surfaceJwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-real-1',
      surfaceKind: 'web',
      label: 'browser',
    });
    const surface = connect(harness.url);
    const surfaceLog = new FrameLog(surface);
    await waitOpen(surface);
    surface.send(
      encode({ type: 'hello', clientType: 'surface-web', clientVersion: '1', auth: surfaceJwt }),
    );
    await surfaceLog.waitForCount('auth.ok', 1);
    // Greeting: host currently offline.
    await surfaceLog.waitForCount('daemon.offline', 1);

    // 2. Real host connects with a genuine EdDSA-JWT daemonKey signed by the
    //    user's private key and verified against the stored public key (jose).
    const daemonKey = await mintDaemonKey({
      userPrivateKey: user.privateKey,
      daemonId: 'daemon-real-1',
      label: 'hetzner',
    });
    const daemon = connect(harness.url);
    await waitOpen(daemon);
    daemon.send(
      encode({ type: 'hello', clientType: 'daemon', clientVersion: '1', auth: daemonKey }),
    );
    // daemon.online fans out to the connected surface — proves the real
    // daemonKey was accepted by jose verification against the registered key.
    await surfaceLog.waitForCount('daemon.online', 1);

    // 3. Drop the host socket → a second daemon.offline fans out.
    daemon.close();
    await surfaceLog.waitForCount('daemon.offline', 2);

    surface.close();
  });

  it('forged-key host JWT is rejected immediately after hello (close 4401)', async () => {
    // A second, UNKNOWN keypair signs a daemonKey for the real daemonId.
    const forger = generateUserKeypair();
    const forgedKey = await mintDaemonKey({
      userPrivateKey: forger.privateKey,
      daemonId: 'daemon-real-1',
      label: 'hetzner',
    });
    const daemon = connect(harness.url);
    await waitOpen(daemon);
    const closePromise = waitClose(daemon);
    daemon.send(
      encode({ type: 'hello', clientType: 'daemon', clientVersion: '1', auth: forgedKey }),
    );
    const code = await closePromise;
    expect(code).toBe(4401);
  });

  it('surface with a valid JWT connects and receives events; invalid JWT is rejected', async () => {
    // Invalid: a JWT signed by an unknown key.
    const forger = generateUserKeypair();
    const badJwt = await mintSurfaceCredential({
      userPrivateKey: forger.privateKey,
      surfaceId: 'srf-real-1',
      surfaceKind: 'web',
      label: 'browser',
    });
    const bad = connect(harness.url);
    await waitOpen(bad);
    const badClose = waitClose(bad);
    bad.send(
      encode({ type: 'hello', clientType: 'surface-web', clientVersion: '1', auth: badJwt }),
    );
    expect(await badClose).toBe(4401);

    // Valid: accepted, receives auth.ok + host status greeting.
    const goodJwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-real-1',
      surfaceKind: 'web',
      label: 'browser',
    });
    const good = connect(harness.url);
    await waitOpen(good);
    good.send(
      encode({ type: 'hello', clientType: 'surface-web', clientVersion: '1', auth: goodJwt }),
    );
    const ok = await waitFrame(good, 'auth.ok');
    expect(ok.type).toBe('auth.ok');
    good.close();
  });

  it("a phone's presence collapses after 30s of no heartbeat; a fresh heartbeat keeps it active", () => {
    const acct = user.publicKey;
    const t0 = 1_000_000;
    presence.online(acct, 'srf-real-1', 'mobile', t0);
    expect(presence.isActive(acct, t0)).toBe(true);
    // Within 30s: still active.
    expect(presence.isActive(acct, t0 + 29_000)).toBe(true);
    // Past 30s with no heartbeat: collapses.
    expect(presence.isActive(acct, t0 + 31_000)).toBe(false);
    // A fresh heartbeat at +25s keeps it active at +40s (within 30s of beat).
    presence.heartbeat(acct, 'srf-real-1', t0 + 25_000);
    expect(presence.isActive(acct, t0 + 40_000)).toBe(true);
    expect(presence.isActive(acct, t0 + 56_000)).toBe(false);
  });
});
