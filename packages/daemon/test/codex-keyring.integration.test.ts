import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { CodexClient } from '../src/codexClient.js';

// A sentinel is stored locally; no upstream generation or real API key is used.
it('persists credentials in the native keyring across process restarts without auth.json', async () => {
  const home = mkdtempSync(join(tmpdir(), 'patch-codex-keyring-'));
  let client = new CodexClient({ home });
  try {
    await client.start();
    await client.request('account/login/start', {
      type: 'apiKey',
      apiKey: 'patch-test-sentinel-not-a-real-api-key',
    });
    expect(existsSync(join(home, 'auth.json'))).toBe(false);
    expect((await client.request('account/read')).account.type).toBe('apiKey');
    await client.close();
    client = new CodexClient({ home });
    await client.start();
    expect((await client.request('account/read')).account.type).toBe('apiKey');
    await client.request('account/logout');
    expect((await client.request('account/read')).account).toBeNull();
    expect(existsSync(join(home, 'auth.json'))).toBe(false);
  } finally {
    await client.close();
    rmSync(home, { recursive: true, force: true });
  }
}, 30000);
