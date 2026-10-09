import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bringUpLocal, type LocalDeps } from './setup-local.js';

function deps(over: Partial<LocalDeps> = {}) {
  const calls: string[] = [];
  const saved: unknown[] = [];
  const d: LocalDeps = {
    freePort: async () => 40123,
    startServer: async ({ port }) => {
      calls.push(`start:${port}`);
      return { origin: `http://127.0.0.1:${port}`, stop: async () => undefined };
    },
    call: async (origin, path, body, bearer) => {
      calls.push(`${path}${bearer ? ' (authed)' : ''}`);
      if (path === '/api/auth/account') {
        assert.equal((body as { clientType: string }).clientType, 'surface-desktop');
        return { status: 200, json: { credential: 'cred.jwt.value' } };
      }
      assert.equal(origin, 'http://127.0.0.1:40123');
      assert.equal(bearer, 'cred.jwt.value');
      return { status: 200, json: { nonce: 'hostCode0123456789hostCode0123456789' } };
    },
    hostInstalled: () => false,
    installHost: async (origin, code) => {
      calls.push(`install:${origin}:${code}`);
      return { ok: true, exitCode: 0, output: '' };
    },
    save: (s) => void saved.push(s),
    recover: () => null,
    progress: (m) => void calls.push(`say:${m}`),
    label: 'Tom’s Mac',
    ...over,
  };
  return { d, calls, saved };
}

test('a first run starts the server, makes the account, remembers it, then sets up the host', async () => {
  const { d, calls, saved } = deps();
  const up = await bringUpLocal(null, d);
  assert.deepEqual(up.saved, {
    connection: { mode: 'local', port: 40123 },
    credential: 'cred.jwt.value',
  });
  assert.deepEqual(saved, [up.saved]);
  assert.deepEqual(
    calls.filter((c) => !c.startsWith('say:')),
    [
      'start:40123',
      '/api/auth/account',
      '/api/auth/daemon/pair/start (authed)',
      'install:http://127.0.0.1:40123:hostCode0123456789hostCode0123456789',
    ],
  );
  assert.ok(
    calls.some((c) => c.startsWith('say:')),
    'it tells the page what it is doing',
  );
});

test('the connection is saved BEFORE the host is installed, so a failed install can be retried', async () => {
  const order: string[] = [];
  const { d } = deps({
    save: () => void order.push('save'),
    installHost: async () => {
      order.push('install');
      return { ok: false, exitCode: 1, output: 'curl: (7) Failed to connect' };
    },
  });
  await assert.rejects(bringUpLocal(null, d), /curl: \(7\) Failed to connect/);
  assert.deepEqual(order, ['save', 'install']);
});

test('a retry after a saved connection reuses the port and the account', async () => {
  const { d, calls } = deps({ freePort: async () => assert.fail('must not choose a new port') });
  const up = await bringUpLocal(
    { connection: { mode: 'local', port: 40123 }, credential: 'cred.jwt.value' },
    d,
  );
  assert.equal(up.saved.credential, 'cred.jwt.value');
  assert.ok(!calls.includes('/api/auth/account'));
});

test('does not install a host that is already there', async () => {
  const { d, calls } = deps({ hostInstalled: () => true });
  await bringUpLocal(null, d);
  assert.ok(!calls.some((c) => c.startsWith('install:')));
  assert.ok(!calls.some((c) => c.startsWith('/api/auth/daemon')));
});

test('an account that already exists but is not ours is reported with what to do', async () => {
  const { d } = deps({
    call: async () => ({ status: 409, json: { error: 'account already bootstrapped' } }),
  });
  await assert.rejects(bringUpLocal(null, d), /already has an account.*start over/s);
});

test('a refusal from the server is reported in its own words', async () => {
  const { d } = deps({ call: async () => ({ status: 500, json: { error: 'disk full' } }) });
  await assert.rejects(bringUpLocal(null, d), /disk full/);
});

test('a host code that does not come is an error', async () => {
  let n = 0;
  const { d } = deps({
    call: async () =>
      n++ === 0 ? { status: 200, json: { credential: 'c.j.t' } } : { status: 200, json: {} },
  });
  await assert.rejects(bringUpLocal(null, d), /no pairing code/);
});

test('stops the server it started if setting up fails, so the next try finds the port free', async () => {
  let stopped = false;
  const { d } = deps({
    startServer: async ({ port }) => ({
      origin: `http://127.0.0.1:${port}`,
      stop: async () => void (stopped = true),
    }),
    call: async () => ({ status: 500, json: { error: 'boom' } }),
  });
  await assert.rejects(bringUpLocal(null, d), /boom/);
  assert.equal(stopped, true);
});

test('choosing "on this Mac" again after a switch picks the account up instead of asking for a second', async () => {
  const { d, calls } = deps({
    freePort: async () => assert.fail('must not choose a new port'),
    recover: () => ({ connection: { mode: 'local', port: 40123 }, credential: 'cred.jwt.value' }),
  });
  const up = await bringUpLocal(null, d);
  assert.equal(up.saved.credential, 'cred.jwt.value');
  assert.ok(!calls.includes('/api/auth/account'));
});
