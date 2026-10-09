import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMPTY_SHARED_SECRETS } from '@patch/wire';
import { hostSecrets } from '../src/provider-refresh.js';
import { SharedSettingsService } from '../src/shared-settings.js';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const token = (exp: number) => `x.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.x`;
const auth = (exp: number, refresh = 'secret-refresh') =>
  JSON.stringify({
    tokens: { account_id: 'pool', access_token: token(exp), refresh_token: refresh },
  });
it('gives hosts access credentials without either provider refresh token', () => {
  const secrets = structuredClone(EMPTY_SHARED_SECRETS);
  secrets.claude.push({
    id: 'c',
    label: 'Claude',
    credential: { accessToken: 'access', refreshToken: 'secret' },
  });
  secrets.codex.push({ id: 'o', label: 'ChatGPT', kind: 'chatgpt', authJson: auth(1) });
  const snapshot = hostSecrets(secrets);
  expect(snapshot.claude[0]!.credential?.refreshToken).toBeUndefined();
  expect(JSON.parse(snapshot.codex[0]!.authJson!).tokens.refresh_token).toBeUndefined();
  expect(JSON.parse(snapshot.codex[0]!.authJson!).auth_mode).toBe('chatgptAuthTokens');
  expect(JSON.parse(secrets.codex[0]!.authJson!).tokens.refresh_token).toBe('secret-refresh');
});
it('serializes renewal, preserves rotated credentials across restart and repairs the same account on sign-in', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'patch-renew-'));
  dirs.push(dir);
  const refresh = vi.fn(async () => auth(Math.floor(Date.now() / 1000) + 3600, 'rotated'));
  const options = {
    dataDir: dir,
    sendToDaemon: () => {},
    onlineDaemonIds: () => [],
    broadcast: () => {},
    refreshOpenAI: refresh,
  };
  const service = new SharedSettingsService(options);
  service.handleDaemonEvent({
    type: 'settings.account_signed_in',
    daemonId: 'd',
    requestId: 'r',
    account: {
      id: 'original',
      label: 'Mine',
      identity: 'pool',
      kind: 'chatgpt',
      authJson: auth(1),
    },
  });
  await Promise.all([service.refreshCredentials(), service.refreshCredentials()]);
  expect(refresh).toHaveBeenCalledTimes(1);
  const restarted = new SharedSettingsService(options);
  await restarted.refreshCredentials();
  expect(refresh).toHaveBeenCalledTimes(1);
  restarted.handleDaemonEvent({
    type: 'settings.account_signed_in',
    daemonId: 'd2',
    requestId: 'r2',
    account: {
      id: 'new',
      label: 'New',
      identity: 'pool',
      kind: 'chatgpt',
      authJson: auth(1, 'new-login'),
    },
  });
  expect(restarted.accountIds('codex')).toEqual(['original']);
  expect(restarted.secretsSummary().codex[0]?.label).toBe('Mine');
  await restarted.refreshCredentials();
  expect(refresh).toHaveBeenLastCalledWith(auth(1, 'new-login'));
});
it('reports renewal failure without losing credentials or allowing an older host to replace them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'patch-renew-'));
  dirs.push(dir);
  const refresh = vi.fn(async () => {
    throw new Error('Sign in again');
  });
  const service = new SharedSettingsService({
    dataDir: dir,
    sendToDaemon: () => {},
    onlineDaemonIds: () => [],
    broadcast: () => {},
    refreshOpenAI: refresh,
  });
  service.handleDaemonEvent({
    type: 'settings.account_signed_in',
    daemonId: 'd',
    requestId: 'r',
    account: { id: 'a', label: 'Mine', identity: 'pool', kind: 'chatgpt', authJson: auth(1) },
  });
  await service.refreshCredentials();
  expect(service.changedEvent().problem).toContain('Sign in again');
  service.handleDaemonEvent({
    type: 'settings.secret_update',
    daemonId: 'd',
    update: { backendId: 'codex', accountId: 'a', authJson: auth(1, 'stale') },
  });
  await service.refreshCredentials();
  expect(refresh).toHaveBeenLastCalledWith(auth(1));
});
