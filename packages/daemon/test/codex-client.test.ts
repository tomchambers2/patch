import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodexClient } from '../src/codexClient.js';

// Real app-server endpoint, no paid generation and no ambient user credentials.
describe('Codex app-server transport', () => {
  it('initializes an isolated real server and reads its unauthenticated account', async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-codex-'));
    const client = new CodexClient({ home });
    try {
      await client.start();
      const result = await client.request('account/read', { refreshToken: false });
      expect(result.account).toBeNull();
      expect(existsSync(join(home, 'auth.json'))).toBe(false);
      await expect(client.request('patch/nonexistent', {})).rejects.toThrow();
      const next = await client.request('account/read', { refreshToken: false });
      expect(next.account).toBeNull();
    } finally {
      await client.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 30000);

  it('reports a missing runtime without hanging', async () => {
    const client = new CodexClient({ home: '/tmp', executable: '/missing/patch-codex' });
    await expect(client.start()).rejects.toThrow();
    await client.close();
  });
});

describe('Codex failure isolation', () => {
  it('rejects outstanding requests when its real process is stopped and can use a new process', async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-codex-stop-'));
    const first = new CodexClient({ home });
    try {
      await first.start();
      await first.close();
      await expect(first.request('account/read')).rejects.toThrow(/not running/);
      const second = new CodexClient({ home });
      try {
        await second.start();
        expect((await second.request('account/read')).account).toBeNull();
      } finally {
        await second.close();
      }
    } finally {
      await first.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

it('bounds a hung real process request and ignores its late reply', async () => {
  const home = mkdtempSync(join(tmpdir(), 'patch-codex-hang-'));
  const client = new CodexClient({ home });
  try {
    await client.start();
    process.kill(-client.processId!, 'SIGSTOP');
    await expect(client.request('account/read', {}, 500)).rejects.toThrow(/timed out/);
    process.kill(-client.processId!, 'SIGCONT');
    expect((await client.request('account/read')).account).toBeNull();
  } finally {
    if (client.alive) process.kill(-client.processId!, 'SIGCONT');
    await client.close();
    rmSync(home, { recursive: true, force: true });
  }
}, 30000);
