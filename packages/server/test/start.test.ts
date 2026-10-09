// Starting from a config (src/start.ts): listening, and reachable through a relay
// when one is configured — the sequence that broke once on Fastify refusing a
// hook on a server already listening.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelayServer, type RelayServerHandle } from '@patch/relay/server';
import { startServer } from '../src/start.js';

let dir: string;
let relay: RelayServerHandle;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'patch-start-'));
  relay = await createRelayServer({ port: 0, host: '127.0.0.1' });
});
afterEach(async () => {
  await relay.close();
  rmSync(dir, { recursive: true, force: true });
});

const config = (over: object = {}) => ({
  port: 0,
  host: '127.0.0.1',
  internalToken: 'x'.repeat(32),
  dataDir: dir,
  ...over,
});

async function until(pick: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!pick()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('startServer', () => {
  it('listens and answers without a relay', async () => {
    const { app, port, relay: r } = await startServer(config(), false);
    try {
      expect(r).toBeUndefined();
      expect((await fetch(`http://127.0.0.1:${port}/api/healthz`)).status).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('with a relay configured, holds its channel once listening, and lets go of it when closed', async () => {
    const { app, relay: r } = await startServer(
      config({ relayUrl: `ws://127.0.0.1:${relay.port}` }),
      false,
    );
    try {
      await until(() => r?.status().connected === true);
      expect(relay.stats().servers).toBe(1);
    } finally {
      await app.close();
    }
    await until(() => relay.stats().servers === 0);
  });
});
