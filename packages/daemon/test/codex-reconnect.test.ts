import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAccounts } from '../src/codexAccounts.js';

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
it('reconnects a disconnected credit pool, preserves its ID and priority, and exposes models', async () => {
  const root = mkdtempSync(join(tmpdir(), 'patch-reconnect-'));
  dirs.push(root);
  const home = join(root, 'login');
  mkdirSync(home);
  writeFileSync(join(home, 'auth.json'), JSON.stringify({ tokens: { account_id: 'pool' } }));
  vi.stubEnv('CODEX_HOME', home);
  const executable = join(root, 'codex');
  writeFileSync(
    executable,
    `#!/usr/bin/env node
const rl = require('node:readline').createInterface({input:process.stdin});
rl.on('line', line => {
 const m = JSON.parse(line); if (m.id === undefined) return;
 let result = {};
 if (m.method === 'account/login/start') {
 require('node:fs').writeFileSync(require('node:path').join(process.env.CODEX_HOME,'auth.json'), JSON.stringify({tokens:{account_id:'pool'}}));
 process.stdout.write(JSON.stringify({id:m.id,result:{loginId:'login'}})+'\\n');
 process.stdout.write(JSON.stringify({method:'account/login/completed',params:{success:true}})+'\\n');
 process.stdout.write(JSON.stringify({method:'account/updated',params:{authMode:'chatgpt'}})+'\\n');
 return;
}
 if (m.method === 'account/read') result = {account:{type:'chatgpt', email:'tom@example.com'}};
 if (m.method === 'model/list') result = {data:[{model:'test-model', displayName:'Test model'}]};
 process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');
});`,
    { mode: 0o755 },
  );
  const file = join(root, 'accounts.json');
  writeFileSync(
    file,
    JSON.stringify([
      {
        id: 'original',
        label: 'My subscription',
        home: join(root, 'expired'),
        adopted: false,
        kind: 'chatgpt',
        identity: 'pool',
      },
      {
        id: 'other',
        label: 'Other',
        home: join(root, 'other'),
        adopted: false,
        kind: 'chatgpt',
        identity: 'other-pool',
      },
    ]),
  );
  const accounts = new CodexAccounts({ root, daemonId: 'd', executable, onChange: () => {} });
  try {
    await accounts.add({
      type: 'host.backend_add_account',
      daemonId: 'd',
      backendId: 'codex',
      authMethod: 'device',
    });
    await expect.poll(() => accounts.report().login?.status).toBe('complete');
    expect(accounts.report().accounts?.map((a) => a.id)).toEqual(['original', 'other']);
    expect(accounts.report().accounts?.[0]).toMatchObject({
      label: 'My subscription',
      connected: true,
    });
    expect(JSON.parse(readFileSync(file, 'utf8'))[0]).toMatchObject({
      id: 'original',
      adopted: false,
    });
    expect(await accounts.models()).toEqual([
      { id: 'openai/test-model', label: 'Test model · ChatGPT' },
    ]);
    expect((await accounts.resolve({ preferred: 'original' })).client.alive).toBe(true);
  } finally {
    await accounts.close();
  }
});
