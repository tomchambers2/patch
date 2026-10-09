import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODEX_LOGIN_DEADLINE_MS, CodexAccounts } from '../src/codexAccounts.js';

// A stand-in `codex app-server --stdio`: device-code sign-in that the "user"
// approves FAKE_CODEX_APPROVE_MS after it starts.
const FAKE_CODEX = `#!/usr/bin/env node
const rl = require('node:readline').createInterface({ input: process.stdin });
let signedIn = false;
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === 'account/login/start') {
    send({ id: m.id, result: { type: 'chatgptDeviceCode', loginId: 'L1', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' } });
    // Real Codex order (app-server account_processor.rs): login/completed goes
    // out BEFORE the auth manager reloads; account/updated follows the reload.
    setTimeout(() => {
      send({ method: 'account/login/completed', params: { loginId: 'L1', success: true, error: null } });
      setTimeout(() => {
        signedIn = true;
        // A file-store Codex writes the login where CODEX_HOME points.
        require('node:fs').writeFileSync(require('node:path').join(process.env.CODEX_HOME, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'fake' } }));
        send({ method: 'account/updated', params: { authMode: 'chatgpt', planType: 'plus' } });
      }, 100);
    }, Number(process.env.FAKE_CODEX_APPROVE_MS));
    return;
  }
  // Slow enough that the host can close Codex before it answers.
  if (m.method === 'account/login/cancel')
    return setTimeout(() => send({ id: m.id, result: {} }), 2000);
  if (m.method === 'account/read')
    return send({ id: m.id, result: { account: signedIn ? { type: 'chatgpt', email: 'tom@example.com' } : null } });
  send({ id: m.id, result: {} });
});
`;

describe('ChatGPT device-code sign-in deadline', () => {
  const dirs: string[] = [];
  afterEach(() => {
    delete process.env['FAKE_CODEX_APPROVE_MS'];
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const signedIn: Array<{ requestId: string; authJson: string | null }> = [];
  function boot(loginDeadlineMs: number): CodexAccounts {
    const dir = mkdtempSync(join(tmpdir(), 'patch-codex-login-'));
    dirs.push(dir);
    const executable = join(dir, 'codex');
    writeFileSync(executable, FAKE_CODEX);
    chmodSync(executable, 0o755);
    return new CodexAccounts({
      root: join(dir, 'openai'),
      daemonId: 'd1',
      onChange: () => {},
      executable,
      loginDeadlineMs,
      onSignedIn: (requestId, account) => signedIn.push({ requestId, authJson: account.authJson }),
    });
  }
  async function settle(accounts: CodexAccounts): Promise<string | undefined> {
    for (let i = 0; i < 100 && accounts.report().login?.status === 'pending'; i++)
      await new Promise((r) => setTimeout(r, 50));
    return accounts.report().login?.status;
  }

  it('outlives the 15 minutes Codex gives the user to approve the code', () => {
    expect(CODEX_LOGIN_DEADLINE_MS).toBeGreaterThan(15 * 60_000);
  });

  it('connects the account when approval lands before the deadline', async () => {
    process.env['FAKE_CODEX_APPROVE_MS'] = '300';
    const accounts = boot(2000);
    try {
      await accounts.add({
        type: 'host.backend_add_account',
        daemonId: 'd1',
        backendId: 'codex',
        authMethod: 'device',
      });
      expect(accounts.report().login).toMatchObject({ status: 'pending', code: 'ABCD-1234' });
      expect(await settle(accounts)).toBe('complete');
      expect(accounts.report().accounts).toMatchObject([
        { kind: 'chatgpt', connected: true, accountEmail: 'tom@example.com' },
      ]);
      // The login is the account's, so it goes to the server (spec/01 § Settings).
      expect(signedIn.at(-1)?.authJson).toContain('"access_token":"fake"');
    } finally {
      await accounts.close();
    }
  });

  it('reports expiry, and connects nothing, when approval lands after it', async () => {
    process.env['FAKE_CODEX_APPROVE_MS'] = '800';
    const accounts = boot(200);
    try {
      await accounts.add({
        type: 'host.backend_add_account',
        daemonId: 'd1',
        backendId: 'codex',
        authMethod: 'device',
      });
      expect(await settle(accounts)).toBe('failed');
      expect(accounts.report().login?.error).toBe('Sign-in expired. Start again.');
      expect(accounts.report().accounts).toEqual([]);
    } finally {
      await accounts.close();
    }
  });
});
