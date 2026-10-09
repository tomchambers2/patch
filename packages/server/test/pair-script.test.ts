// `patch-server pair` (spec/11 § Pairing the first device): the server's own
// administrator asks the RUNNING server for a pairing code. The first run also
// makes the account, so a fresh install needs no other tool.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { parsePairingUri } from '@patch/wire';
import { generateUserKeypair } from '@patch/auth';
import { buildAll } from '../src/app.js';
import { pairNewSurface } from '../src/pair-admin.js';

describe('pairNewSurface', () => {
  let dir: string;
  let base: string;
  let close: () => Promise<void>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'patch-pair-'));
    const { app } = await buildAll({ logger: false, dataDir: dir, internalToken: 'x'.repeat(32) });
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    close = () => app.close();
  });
  afterEach(async () => {
    await close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('on a fresh server makes the account and a code the new surface can redeem', async () => {
    const out = await pairNewSurface({
      baseUrl: base,
      dataDir: dir,
      publicUrl: 'https://patch.example.com',
    });
    expect(out.createdAccount).toBe(true);
    const payload = parsePairingUri(out.uri);
    expect(payload.server).toBe('https://patch.example.com');
    expect(out.expiresAt).toBeGreaterThan(Date.now());

    const kp = generateUserKeypair();
    const res = await fetch(`${base}/api/auth/pair/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        nonce: payload.nonce,
        devicePublicKey: kp.publicKey,
        clientType: 'surface-mobile',
      }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { credential: string }).credential).toMatch(/^eyJ/);
  });

  it('keeps its own credential, mode 600, and uses it for the next code', async () => {
    await pairNewSurface({ baseUrl: base, dataDir: dir, publicUrl: 'https://patch.example.com' });
    const file = join(dir, 'admin.credential');
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const again = await pairNewSurface({
      baseUrl: base,
      dataDir: dir,
      publicUrl: 'https://patch.example.com',
    });
    expect(again.createdAccount).toBe(false);
    expect(parsePairingUri(again.uri).nonce).toBeTruthy();
  });

  it('says plainly when the server already has an owner this machine is not', async () => {
    await pairNewSurface({ baseUrl: base, dataDir: dir, publicUrl: 'https://patch.example.com' });
    rmSync(join(dir, 'admin.credential'));
    await expect(
      pairNewSurface({ baseUrl: base, dataDir: dir, publicUrl: 'https://patch.example.com' }),
    ).rejects.toThrow(/already has an owner/);
  });

  it('refuses a stale credential rather than making a second account', async () => {
    await pairNewSurface({ baseUrl: base, dataDir: dir, publicUrl: 'https://patch.example.com' });
    const file = join(dir, 'admin.credential');
    const jwt = readFileSync(file, 'utf8');
    await fetch(`${base}/api/auth/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt.trim()}` },
      body: JSON.stringify({
        id: JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString()).surface_id,
      }),
    });
    await expect(
      pairNewSurface({ baseUrl: base, dataDir: dir, publicUrl: 'https://patch.example.com' }),
    ).rejects.toThrow(/credential/);
  });

  it('writes http origins as such so a scanner does not assume https', async () => {
    const out = await pairNewSurface({
      baseUrl: base,
      dataDir: dir,
      publicUrl: 'http://192.168.1.20:3000',
    });
    expect(out.uri).toBe(
      `patch-pair://192.168.1.20:3000?nonce=${encodeURIComponent(parsePairingUri(out.uri).nonce)}&s=http`,
    );
  });
});
