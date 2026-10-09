// `patch auth bootstrap` — the first-run account + credential (spec/10 § Auth).
//
// This was broken outright: it POSTed `{userPublicKey}` from a locally
// generated ACCOUNT keypair, but the server owns the account keypair itself
// (`generateUserKeypair()` server-side) and its schema is strict — so every
// bootstrap failed with `{"error":"invalid body"}`. The documented first step
// of bringing an account up could not work for anyone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'commands', 'auth.ts'),
  'utf8',
);

test('bootstrap sends the shape the server actually accepts', () => {
  // AccountBootstrapBody is `.strict()` — an extra or renamed key is a 400.
  assert.match(SRC, /clientType: 'surface-cli'/, 'names its client type');
  assert.match(SRC, /devicePublicKey: kp\.publicKey/, 'sends the DEVICE public key');
  assert.ok(
    !/post<[^>]*>\('\/api\/auth\/account', \{ userPublicKey/.test(SRC),
    'no longer sends userPublicKey, which the strict schema rejects',
  );
});

test('bootstrap uses the credential the SERVER issued, not one it minted itself', () => {
  assert.match(SRC, /const jwt = resp\.credential/, 'takes the server-issued credential');
  assert.match(
    SRC,
    /userPublicKey: resp\.account\.userPublicKey/,
    'verifies against the account key the server holds',
  );
});

test('bootstrap reports the account id, not this device key', () => {
  assert.match(SRC, /accountId: resp\.account\.accountId/);
});
