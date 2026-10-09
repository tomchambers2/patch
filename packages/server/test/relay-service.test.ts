// The server reachable through a relay (spec/10 § Relay), end to end: a real
// relay, the real server on a real port, and a device that knows only what the
// pairing code carries.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { RelayClient } from '@patch/relay';
import { createRelayServer as createRelay, type RelayServerHandle } from '@patch/relay/server';
import { generateUserKeypair } from '@patch/auth';
import { decode, encode, parsePairingUri, type WireEvent } from '@patch/wire';
import { buildAll } from '../src/app.js';
import { RelayService } from '../src/relay-service.js';

let dir: string;
let relay: RelayServerHandle;
let service: RelayService;
let close: () => Promise<void>;
let base: string;

async function until(pick: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!pick()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const savedEnv = { ...process.env };

beforeEach(async () => {
  // A server with a public address names that in its pairing codes; this one has none.
  delete process.env['PATCH_PUBLIC_URL'];
  delete process.env['PATCH_SERVER_URL'];
  dir = mkdtempSync(join(tmpdir(), 'patch-relay-svc-'));
  relay = await createRelay({ port: 0, host: '127.0.0.1' });
  service = new RelayService({ dataDir: dir, url: `ws://127.0.0.1:${relay.port}` });
  const { app } = await buildAll({
    logger: false,
    dataDir: dir,
    internalToken: 'x'.repeat(32),
    relay: service,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  service.start(base);
  await until(() => service.status().connected);
  close = async () => {
    service.stop();
    await app.close();
  };
});
afterEach(async () => {
  process.env = { ...savedEnv };
  await close();
  await relay.close();
  rmSync(dir, { recursive: true, force: true });
});

const device = () => {
  const info = service.info();
  return RelayClient.connect(
    { url: info.url, channel: info.channel, serverKey: info.serverKey },
    { WebSocket: WebSocket as never },
  );
};
const json = (b: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(b));

describe('RelayService', () => {
  it('makes its identity once, keeps it 0600, and uses it again', () => {
    const file = join(dir, 'relay.key');
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const again = new RelayService({ dataDir: dir, url: 'ws://x' });
    expect(again.info().serverKey).toBe(service.info().serverKey);
    expect(readFileSync(file, 'utf8').trim().length).toBeGreaterThan(40);
  });

  it('refuses a key file that is not a key, rather than making a new identity under it', () => {
    writeFileSync(join(dir, 'relay.key'), 'nope');
    expect(() => new RelayService({ dataDir: dir, url: 'ws://x' })).toThrow(/relay\.key/);
  });

  it('refuses a relay address that is not a websocket address', () => {
    expect(
      () =>
        new RelayService({
          dataDir: mkdtempSync(join(tmpdir(), 'r-')),
          url: 'https://relay.example',
        }),
    ).toThrow(/ws/);
  });
});

describe('a device with only a pairing code', () => {
  it('pairs through the relay and then uses its credential, over the tunnel', async () => {
    // The owner makes the account and opens a pairing window, as they would on the machine.
    const owner = generateUserKeypair();
    const made = await fetch(`${base}/api/auth/account`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientType: 'surface-cli', devicePublicKey: owner.publicKey }),
    });
    const { credential } = (await made.json()) as { credential: string };
    const started = (await (
      await fetch(`${base}/api/auth/pair/start`, {
        method: 'POST',
        headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
        body: '{}',
      })
    ).json()) as { nonce: string; uri: string };

    // The code says: reach me through the relay (this server has no public URL).
    const code = parsePairingUri(started.uri);
    expect(code.server).toBeNull();
    expect(code.relay).toEqual(service.info());

    // The phone knows nothing but the code.
    const phone = await RelayClient.connect(code.relay!, { WebSocket: WebSocket as never });
    const mine = generateUserKeypair();
    const paired = await phone.fetch('/api/auth/pair/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        nonce: code.nonce,
        devicePublicKey: mine.publicKey,
        clientType: 'surface-mobile',
      }),
    });
    expect(paired.status).toBe(200);
    const phoneCredential = (json(paired.body) as { credential: string }).credential;

    const me = await phone.fetch('/api/auth/me', {
      headers: { authorization: `Bearer ${phoneCredential}` },
    });
    expect(me.status).toBe(200);
    expect((json(me.body) as { surface: { surfaceKind: string } }).surface.surfaceKind).toBe(
      'mobile',
    );

    // And the live socket, authenticated the way a surface does it.
    const sock = phone.openSocket('/ws');
    const seen: WireEvent[] = [];
    sock.onmessage = (e) => {
      const raw = typeof e.data === 'string' ? Buffer.from(e.data) : Buffer.from(e.data);
      seen.push(decode(raw));
    };
    await until(() => sock.readyState === 1);
    sock.send(
      encode({
        type: 'hello',
        clientType: 'surface-mobile',
        clientVersion: '1',
        auth: phoneCredential,
      }),
    );
    await until(() => seen.some((f) => f.type === 'auth.ok'), 5000);
    phone.close();
  });

  it('is turned away from the API when it holds no credential — the tunnel adds no access', async () => {
    const phone = await device();
    const res = await phone.fetch('/api/auth/me');
    expect(res.status).toBe(401);
    phone.close();
  });

  it('can read the relay status only with a credential', async () => {
    const phone = await device();
    expect((await phone.fetch('/api/relay')).status).toBe(401);
    phone.close();
  });
});
