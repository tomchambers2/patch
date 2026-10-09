// A host that connects on a different version from the server
// (src/daemon-lockstep.ts): the policy, and the live hello path sending
// `host.update` to a host that is behind.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { generateUserKeypair, mintDaemonKey } from '@patch/auth';
import { WireTestClient } from '@patch/wire/test-client';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { daemonLockstep } from '../src/daemon-lockstep.js';
import { VERSION } from '../src/version.js';

describe('daemonLockstep', () => {
  it('a host on the server version is in step', () => {
    expect(
      daemonLockstep({
        serverVersion: '0.1.1310',
        daemonVersion: '0.1.1310',
        publishedVersion: '0.1.1310',
      }),
    ).toEqual({ kind: 'in-step' });
  });

  it('a host behind the server updates when the server version is published', () => {
    expect(
      daemonLockstep({
        serverVersion: '0.1.1310',
        daemonVersion: '0.1.1307',
        publishedVersion: '0.1.1310',
      }),
    ).toEqual({ kind: 'update', to: '0.1.1310' });
  });

  it('does not send a host to a published build that is not the server version', () => {
    // 2026-09-30: server 0.1.1310, published host 0.1.1307. Updating the Mac
    // to 1307 would have changed nothing.
    expect(
      daemonLockstep({
        serverVersion: '0.1.1310',
        daemonVersion: '0.1.1286',
        publishedVersion: '0.1.1307',
      }),
    ).toEqual({ kind: 'unpublished', published: '0.1.1307' });
    expect(
      daemonLockstep({
        serverVersion: '0.1.1310',
        daemonVersion: '0.1.1286',
        publishedVersion: null,
      }),
    ).toEqual({ kind: 'unpublished', published: null });
  });

  it('a host ahead of the server names the server as the stale side', () => {
    expect(
      daemonLockstep({
        serverVersion: '0.1.1307',
        daemonVersion: '0.1.1310',
        publishedVersion: '0.1.1310',
      }),
    ).toEqual({ kind: 'server-behind' });
  });

  it('compares numerically, not as strings', () => {
    expect(
      daemonLockstep({
        serverVersion: '0.1.1000',
        daemonVersion: '0.1.999',
        publishedVersion: '0.1.1000',
      }),
    ).toEqual({ kind: 'update', to: '0.1.1000' });
  });

  it('a version that does not parse is not compared', () => {
    expect(
      daemonLockstep({
        serverVersion: '0.1.1310',
        daemonVersion: 'dev',
        publishedVersion: '0.1.1310',
      }),
    ).toEqual({ kind: 'incomparable' });
  });
});

describe('host hello brings a stale host in step', () => {
  let dir: string;
  let downloads: string;
  let savedDownloads: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-lockstep-'));
    downloads = mkdtempSync(join(tmpdir(), 'patch-lockstep-dl-'));
    savedDownloads = process.env.PATCH_DOWNLOADS_DIR;
    process.env.PATCH_DOWNLOADS_DIR = downloads;
  });
  afterEach(() => {
    if (savedDownloads === undefined) delete process.env.PATCH_DOWNLOADS_DIR;
    else process.env.PATCH_DOWNLOADS_DIR = savedDownloads;
    rmSync(dir, { recursive: true, force: true });
    rmSync(downloads, { recursive: true, force: true });
  });

  function publish(version: string, targets: string[] = ['linux-x64', 'darwin-arm64']): void {
    writeFileSync(
      join(downloads, 'daemon-latest.json'),
      JSON.stringify({
        version,
        gitSha: 'abc',
        builtAt: 'x',
        signingPublicKey: 'k',
        artifacts: targets.map((target) => ({ target })),
      }),
    );
  }

  async function connectDaemon(clientVersion: string): Promise<{
    frames: string[];
    recheck: () => void;
    close: () => Promise<void>;
  }> {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(90));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.setDaemonKey({ daemonId: 'daemon-1', publicKey: user.publicKey, issuedAt: 1 });
    const built = await buildAll({ logger: false, registry });
    await built.app.listen({ port: 0, host: '127.0.0.1' });
    const addr = built.app.server.address() as AddressInfo;
    const daemonKey = await mintDaemonKey({
      userPrivateKey: user.privateKey,
      daemonId: 'daemon-1',
      label: 'mac',
    });
    const daemon = new WireTestClient({
      url: `ws://127.0.0.1:${addr.port}/ws`,
      clientType: 'daemon',
      clientVersion,
      auth: daemonKey,
    });
    const frames: string[] = [];
    daemon.on('host.update', (ev) => frames.push(`host.update:${ev.daemonId}`));
    await daemon.connect();
    await daemon.waitFor('auth.ok');
    // host.update, when sent, follows auth.ok on the same socket immediately.
    await new Promise((r) => setTimeout(r, 150));
    return {
      frames,
      recheck: () => built.wsHub.recheckDaemonVersions(),
      close: async () => {
        await daemon.close();
        await built.app.close();
      },
    };
  }

  it('sends host.update to a host behind the server when the server version is published', async () => {
    publish(VERSION);
    const c = await connectDaemon('0.0.1');
    try {
      expect(c.frames).toEqual(['host.update:daemon-1']);
    } finally {
      await c.close();
    }
  });

  it('sends nothing to a host already on the server version', async () => {
    publish(VERSION);
    const c = await connectDaemon(VERSION);
    try {
      expect(c.frames).toEqual([]);
    } finally {
      await c.close();
    }
  });

  it('does not send a stale host to a published build that is not the server version', async () => {
    publish('0.0.2');
    const c = await connectDaemon('0.0.1');
    try {
      expect(c.frames).toEqual([]);
    } finally {
      await c.close();
    }
  });

  it('updates a host that connected before its build was published, once it is', async () => {
    // A deploy restarts the server first and publishes the host last, so the
    // hosts reconnect while the manifest still names the old build.
    publish('0.0.2');
    const c = await connectDaemon('0.0.1');
    try {
      expect(c.frames).toEqual([]);
      c.recheck();
      publish(VERSION);
      c.recheck();
      await new Promise((r) => setTimeout(r, 150));
      expect(c.frames).toEqual(['host.update:daemon-1']);
      // Unchanged manifest: nothing is re-sent.
      c.recheck();
      await new Promise((r) => setTimeout(r, 150));
      expect(c.frames).toEqual(['host.update:daemon-1']);
    } finally {
      await c.close();
    }
  });

  it('tells a host again when the rest of the platforms land at the same version', async () => {
    // 2026-09-30, 0.1.1312: linux-x64 published at 17:05:18, darwin-arm64 at
    // 17:05:57. The Mac was told to update in between, refused (no darwin
    // artifact yet) and was never told again.
    publish('0.0.2');
    const c = await connectDaemon('0.0.1');
    try {
      c.recheck();
      publish(VERSION, ['linux-x64']);
      c.recheck();
      publish(VERSION, ['linux-x64', 'darwin-arm64']);
      c.recheck();
      await new Promise((r) => setTimeout(r, 150));
      expect(c.frames).toEqual(['host.update:daemon-1', 'host.update:daemon-1']);
    } finally {
      await c.close();
    }
  });
});
