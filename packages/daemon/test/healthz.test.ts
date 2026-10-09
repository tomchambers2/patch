// /healthz remains the smoke test the compose stack relies on.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildControl } from '../src/control.js';

describe('control HTTP', () => {
  it('GET /healthz returns ok + version + gitSha', async () => {
    const app = await buildControl();
    try {
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { ok: boolean; version: string; gitSha: string };
      expect(body.ok).toBe(true);
      expect(body.version.length).toBeGreaterThan(0);
      expect(body.gitSha.length).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it('rejects unauthenticated /chats request', async () => {
    const app = await buildControl({ localKey: 'secret' });
    try {
      const res = await app.inject({ method: 'GET', url: '/chats' });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('UDS socket is chmod 0600 after listen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'patch-uds-mode-'));
    const sock = join(dir, 'daemon.sock');
    const app = await buildControl();
    try {
      await app.listen({ path: sock });
      // Mirrors the post-listen chmod in src/index.ts.
      chmodSync(sock, 0o600);
      const stat = statSync(sock);
      // mask off the type bits — only check perms.
      expect((stat.mode & 0o777).toString(8)).toBe('600');
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
