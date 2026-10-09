import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appUrl, originOf, readSaved, writeSaved, type SavedConnection } from './connection.js';

const dir = () => mkdtempSync(join(tmpdir(), 'patch-conn-'));
const RELAY = { url: 'wss://relay.example.com', channel: 'c', serverKey: 'k' };

test('a first run has nothing saved', () => {
  assert.equal(readSaved(join(dir(), 'connection.json')), null);
});

for (const saved of [
  { connection: { mode: 'local', port: 41234 }, credential: 'a.b.c' },
  { connection: { mode: 'remote', server: 'https://patch.example.com' }, credential: 'a.b.c' },
  { connection: { mode: 'relay', relay: RELAY, port: 41235 }, credential: 'a.b.c' },
] as SavedConnection[]) {
  test(`${saved.connection.mode}: written 0600 and read back as it was`, () => {
    const file = join(dir(), 'connection.json');
    writeSaved(file, saved);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(readSaved(file), saved);
  });
}

test('a file that is not a connection is an error naming the file, never a silent fresh start', () => {
  const file = join(dir(), 'connection.json');
  writeFileSync(file, '{"connection":{"mode":"wat"},"credential":"x"}');
  assert.throws(() => readSaved(file), /connection\.json/);
  writeFileSync(file, 'not json');
  assert.throws(() => readSaved(file), /connection\.json/);
  writeFileSync(file, '{"connection":{"mode":"local","port":0},"credential":"x"}');
  assert.throws(() => readSaved(file), /connection\.json/);
  writeFileSync(file, '{"connection":{"mode":"remote","server":"ftp://x"},"credential":"x"}');
  assert.throws(() => readSaved(file), /connection\.json/);
  writeFileSync(file, '{"connection":{"mode":"local","port":1234},"credential":""}');
  assert.throws(() => readSaved(file), /connection\.json/);
});

test('the origin the window loads: this machine for local and relayed, the server for remote', () => {
  assert.equal(originOf({ mode: 'local', port: 41234 }), 'http://127.0.0.1:41234');
  assert.equal(originOf({ mode: 'relay', relay: RELAY, port: 41235 }), 'http://127.0.0.1:41235');
  assert.equal(
    originOf({ mode: 'remote', server: 'https://patch.example.com/' }),
    'https://patch.example.com',
  );
});

test('the app url carries the credential in the fragment, which is never sent anywhere', () => {
  const url = appUrl('https://patch.example.com', 'a.b-c_d');
  assert.equal(url, 'https://patch.example.com/app/#credential=a.b-c_d');
  assert.equal(new URL(url).search, '');
});
