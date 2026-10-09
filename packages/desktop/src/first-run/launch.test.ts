import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { channelFor, generateServerIdentity, toBase64Url } from '@patch/relay';
import { RelayHost } from '@patch/relay/host';
import { createRelayServer, type RelayServerHandle } from '@patch/relay/server';
import { encodePairingUri } from '@patch/wire';
import { readSaved, writeSaved } from './connection.js';
import { launchPatch, type Launch, type SetupUi } from './launch.js';

let server: Server;
let origin: string;
let scratch: string;

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'patch-launch-'));
  server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/auth/pair/complete')
      res.end(JSON.stringify({ credential: 'cred.jwt.value' }));
    else res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

function ui(choices: Array<{ kind: 'local' } | { kind: 'remote'; input: string }>) {
  const log: string[] = [];
  const impl: SetupUi = {
    choose: async () => {
      const next = choices.shift();
      if (!next) throw new Error('asked to choose again');
      return next;
    },
    progress: (m) => void log.push(`progress:${m}`),
    fail: (m) => void log.push(`fail:${m}`),
  };
  return { impl, log };
}

const base = () => ({
  file: join(scratch, 'connection.json'),
  label: 'Test Mac',
  startLocal: async () => assert.fail('no local server expected'),
});

test('with a connection remembered it goes straight to the server, asking nothing', async () => {
  const file = join(scratch, 'connection.json');
  writeSaved(file, { connection: { mode: 'remote', server: origin }, credential: 'a.b.c' });
  const asked = ui([]);
  const launch = await launchPatch({ ...base(), ui: asked.impl });
  assert.equal(launch.appUrl, `${origin}/app/#credential=a.b.c`);
  assert.deepEqual(asked.log, []);
  await launch.stop();
});

test('a first run asks, and "on my server" pairs with the code, remembers the answer, and opens it', async () => {
  const asked = ui([{ kind: 'remote', input: encodePairingUri({ nonce: 'n1', server: origin }) }]);
  const launch = await launchPatch({ ...base(), ui: asked.impl });
  assert.equal(launch.appUrl, `${origin}/app/#credential=cred.jwt.value`);
  assert.deepEqual(readSaved(join(scratch, 'connection.json')), {
    connection: { mode: 'remote', server: origin },
    credential: 'cred.jwt.value',
  });
  await launch.stop();
});

test('a code that does not work is reported on the page and the question is asked again', async () => {
  const asked = ui([
    { kind: 'remote', input: 'not a code' },
    { kind: 'remote', input: encodePairingUri({ nonce: 'n1', server: origin }) },
  ]);
  const launch = await launchPatch({ ...base(), ui: asked.impl });
  assert.equal(asked.log.filter((l) => l.startsWith('fail:')).length, 1);
  assert.match(asked.log.find((l) => l.startsWith('fail:')) ?? '', /patch-pair/);
  assert.ok(launch.appUrl.includes('cred.jwt.value'));
  await launch.stop();
});

test('nothing is remembered from an attempt that failed', async () => {
  const asked = ui([{ kind: 'remote', input: 'nope' }]);
  await assert.rejects(launchPatch({ ...base(), ui: asked.impl }), /asked to choose again/);
  assert.equal(existsSync(join(scratch, 'connection.json')), false);
});

test('"on this Mac" brings up the local server and host, and opens the server on loopback', async () => {
  const stopped: string[] = [];
  const asked = ui([{ kind: 'local' }]);
  const launch = await launchPatch({
    ...base(),
    ui: asked.impl,
    startLocal: async (existing, progress) => {
      progress('Starting the server…');
      const saved = {
        connection: { mode: 'local' as const, port: 41999 },
        credential: 'local.jwt.value',
      };
      assert.equal(existing, null);
      writeSaved(join(scratch, 'connection.json'), saved);
      return {
        saved,
        server: { origin: 'http://127.0.0.1:41999', stop: async () => void stopped.push('server') },
      };
    },
  });
  assert.equal(launch.appUrl, 'http://127.0.0.1:41999/app/#credential=local.jwt.value');
  assert.deepEqual(asked.log, ['progress:Starting the server…']);
  await launch.stop();
  assert.deepEqual(stopped, ['server']);
});

test('a later launch of a local setup starts the same server on the same port', async () => {
  writeSaved(join(scratch, 'connection.json'), {
    connection: { mode: 'local', port: 41999 },
    credential: 'l.j.t',
  });
  let given: unknown;
  const launch = await launchPatch({
    ...base(),
    ui: ui([]).impl,
    startLocal: async (existing) => {
      given = existing;
      return {
        saved: existing as never,
        server: { origin: 'http://127.0.0.1:41999', stop: async () => undefined },
      };
    },
  });
  assert.deepEqual(given, { connection: { mode: 'local', port: 41999 }, credential: 'l.j.t' });
  assert.ok(launch.appUrl.startsWith('http://127.0.0.1:41999/app/'));
});

test('a failed local setup is reported on the page and can be tried again', async () => {
  const asked = ui([{ kind: 'local' }, { kind: 'local' }]);
  let tries = 0;
  const launch = await launchPatch({
    ...base(),
    ui: asked.impl,
    startLocal: async () => {
      if (tries++ === 0) throw new Error('curl: (7) Failed to connect');
      return {
        saved: { connection: { mode: 'local', port: 41999 }, credential: 'l.j.t' },
        server: { origin: 'http://127.0.0.1:41999', stop: async () => undefined },
      };
    },
  });
  assert.match(asked.log.find((l) => l.startsWith('fail:')) ?? '', /curl: \(7\)/);
  assert.equal(tries, 2);
  assert.ok(launch.appUrl.includes('41999'));
});

test('a retry carries on from what the failed attempt had already saved, rather than starting the account again', async () => {
  const asked = ui([{ kind: 'local' }, { kind: 'local' }]);
  const given: unknown[] = [];
  const launch = await launchPatch({
    ...base(),
    ui: asked.impl,
    startLocal: async (existing) => {
      given.push(existing);
      if (given.length === 1) {
        // Got as far as making the account, then the host install failed.
        writeSaved(join(scratch, 'connection.json'), {
          connection: { mode: 'local', port: 41999 },
          credential: 'l.j.t',
        });
        throw new Error('host install failed');
      }
      return {
        saved: existing as never,
        server: { origin: 'http://127.0.0.1:41999', stop: async () => undefined },
      };
    },
  });
  assert.equal(given[0], null);
  assert.deepEqual(given[1], { connection: { mode: 'local', port: 41999 }, credential: 'l.j.t' });
  assert.ok(launch.appUrl.includes('41999'));
});

test('a relayed server is opened through a bridge on this Mac, which remembers its port', async () => {
  const relay: RelayServerHandle = await createRelayServer({ port: 0, host: '127.0.0.1' });
  const identity = generateServerIdentity();
  const host = new RelayHost({
    relayUrl: `ws://127.0.0.1:${relay.port}`,
    identity,
    target: origin,
  });
  host.start();
  for (let i = 0; i < 200 && !host.status().connected; i++)
    await new Promise((r) => setTimeout(r, 10));
  let launch: Launch | undefined;
  try {
    const code = encodePairingUri({
      nonce: 'nn',
      relay: {
        url: `ws://127.0.0.1:${relay.port}`,
        channel: channelFor(identity.publicKey),
        serverKey: toBase64Url(identity.publicKey),
      },
    });
    launch = await launchPatch({ ...base(), ui: ui([{ kind: 'remote', input: code }]).impl });
    const bridge = new URL(launch.appUrl);
    assert.equal(bridge.hostname, '127.0.0.1');
    assert.equal(bridge.hash, '#credential=cred.jwt.value');
    const through = await fetch(`${bridge.origin}/anything`);
    assert.deepEqual(await through.json(), { ok: true, path: '/anything' });
    assert.equal(readSaved(join(scratch, 'connection.json'))?.connection.mode, 'relay');
    await launch.stop();
    launch = undefined;

    // The next launch brings the bridge up again on the same port.
    const again = await launchPatch({ ...base(), ui: ui([]).impl });
    assert.equal(new URL(again.appUrl).origin, bridge.origin);
    assert.equal((await fetch(`${bridge.origin}/second`)).status, 200);
    await again.stop();
  } finally {
    await launch?.stop();
    host.stop();
    await relay.close();
  }
});
