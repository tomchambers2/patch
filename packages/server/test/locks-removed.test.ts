// The lock system has been removed. It was a coordination scheme nobody could
// actually use: acquiring required a surface JWT, no CLI or UI ever exposed it,
// and the host-side barrier therefore denied port commands permanently rather
// than occasionally. These tests pin the removal — if anyone reintroduces the
// REST surface, they fail.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair } from '@patch/auth';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';

describe('lock system removed', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-locks-removed-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function build() {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(41));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    const daemonLink = new InProcessDaemonLink();
    return await buildAll({ logger: false, registry, daemonLink });
  }

  // 404, not 401: the routes are gone entirely, not merely gated. A 401 would
  // mean the surface still exists and is just refusing this caller.
  it.each([
    ['GET', '/api/locks'],
    ['POST', '/api/locks/acquire'],
    ['POST', '/api/locks/release'],
    ['POST', '/api/locks/note'],
  ])('%s %s is no longer served', async (method, url) => {
    const built = await build();
    try {
      const res = await built.app.inject({
        method: method as 'GET' | 'POST',
        url,
        payload: method === 'POST' ? {} : undefined,
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await built.app.close();
    }
  });
});
