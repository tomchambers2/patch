import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateServerIdentity, channelFor, toBase64Url } from '@patch/relay';
import { RelayHost } from '@patch/relay/host';
import { createRelayServer, type RelayServerHandle } from '@patch/relay/server';
import { encodePairingUri } from '@patch/wire';
import { joinServer } from './join.js';

let server: Server;
let origin: string;
let seen: { path?: string; body?: Record<string, unknown> };
let answer: { status: number; body: unknown };

beforeEach(async () => {
  seen = {};
  answer = { status: 200, body: { credential: 'cred.jwt.value', accountId: 'a', surfaceId: 's' } };
  server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => {
      seen = { path: req.url, body: JSON.parse(Buffer.concat(parts).toString() || '{}') };
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

test('a code naming a server pairs with it directly and remembers its address', async () => {
  const joined = await joinServer(encodePairingUri({ nonce: 'N0nce', server: origin }), {
    label: 'Tom’s Mac',
  });
  assert.deepEqual(joined, {
    connection: { mode: 'remote', server: origin },
    credential: 'cred.jwt.value',
  });
  assert.equal(seen.path, '/api/auth/pair/complete');
  assert.equal(seen.body?.['nonce'], 'N0nce');
  assert.equal(seen.body?.['clientType'], 'surface-desktop');
  assert.equal(seen.body?.['label'], 'Tom’s Mac');
  assert.match(String(seen.body?.['devicePublicKey']), /^[A-Za-z0-9_-]{43}$/);
});

test('pasting the code with the whitespace a terminal puts round it is fine', async () => {
  const joined = await joinServer(`\n  ${encodePairingUri({ nonce: 'n', server: origin })}  \n`, {
    label: 'x',
  });
  assert.equal(joined.connection.mode, 'remote');
});

test('says why when the server refuses the code', async () => {
  answer = { status: 400, body: { error: 'pairing nonce expired' } };
  await assert.rejects(
    joinServer(encodePairingUri({ nonce: 'old', server: origin }), { label: 'x' }),
    /pairing nonce expired/,
  );
});

test('says so when the server cannot be reached', async () => {
  await assert.rejects(
    joinServer(encodePairingUri({ nonce: 'n', server: 'http://127.0.0.1:1' }), { label: 'x' }),
    /Could not reach http:\/\/127\.0\.0\.1:1/,
  );
});

test('says so when what came back is not a credential', async () => {
  answer = { status: 200, body: { nope: true } };
  await assert.rejects(
    joinServer(encodePairingUri({ nonce: 'n', server: origin }), { label: 'x' }),
    /no credential/,
  );
});

test('refuses what is not a pairing code, naming the thing it wanted', async () => {
  await assert.rejects(joinServer('https://patch.example.com', { label: 'x' }), /patch-pair/);
  await assert.rejects(joinServer('', { label: 'x' }), /patch-pair/);
});

test('a code naming a relay pairs through it, end to end, and keeps the bridge port to listen on', async () => {
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
  try {
    const code = encodePairingUri({
      nonce: 'viaRelay',
      relay: {
        url: `ws://127.0.0.1:${relay.port}`,
        channel: channelFor(identity.publicKey),
        serverKey: toBase64Url(identity.publicKey),
      },
    });
    const joined = await joinServer(code, { label: 'x', bridgePort: async () => 45678 });
    assert.equal(joined.credential, 'cred.jwt.value');
    assert.equal(joined.connection.mode, 'relay');
    assert.equal((joined.connection as { port: number }).port, 45678);
    assert.equal(seen.body?.['nonce'], 'viaRelay');
  } finally {
    host.stop();
    await relay.close();
  }
});

test('says so when the server behind a relay is not there', async () => {
  const relay = await createRelayServer({ port: 0, host: '127.0.0.1' });
  try {
    const id = generateServerIdentity();
    const code = encodePairingUri({
      nonce: 'n',
      relay: {
        url: `ws://127.0.0.1:${relay.port}`,
        channel: channelFor(id.publicKey),
        serverKey: toBase64Url(id.publicKey),
      },
    });
    await assert.rejects(joinServer(code, { label: 'x', bridgePort: async () => 1 }), /offline/);
  } finally {
    await relay.close();
  }
});
