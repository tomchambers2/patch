// Run: node scripts/daemon-apply.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyUpdate, patchCliCommand, updateLine } from './daemon-apply.mjs';

test('no_update_available is the lost race, not a failure', () => {
  assert.equal(classifyUpdate('{"error":"no_update_available"}\n', 1), 'not-newer');
});

test('a clean exit with no error is an applied update', () => {
  assert.equal(classifyUpdate('{"applied":true}', 0), 'applied');
});

test('any other error, garbage or empty output on failure is failed', () => {
  assert.equal(classifyUpdate('{"error":"boom"}', 1), 'failed');
  assert.equal(classifyUpdate('', 1), 'failed');
  assert.equal(classifyUpdate('ECONNRESET', 1), 'failed');
  assert.equal(classifyUpdate(undefined, 1), 'failed');
});

test('a zero exit that still carries an error is not applied', () => {
  assert.equal(classifyUpdate('{"error":"x"}', 0), 'failed');
});

test('a deferred 202 is its own kind, not an applied update', () => {
  assert.equal(
    classifyUpdate('{"ok":true,"deferred":true,"message":"will apply once 3 turns finish"}', 0),
    'deferred',
  );
});

test('log lines never echo the raw no_update_available JSON', () => {
  const line = updateLine('not-newer', '0.1.1405', '{"error":"no_update_available"}');
  assert.ok(!line.includes('{"error"'));
  assert.ok(line.includes('0.1.1405'));
});

test('a deferred line carries the host\'s own reason', () => {
  const line = updateLine(
    'deferred',
    '0.1.1424',
    '{"ok":true,"deferred":true,"message":"update to 0.1.1424 will apply once 3 running turns finish"}',
  );
  assert.ok(line.includes('3 running turns finish'));
});

test('the CLI is run by its built entry point, never a bare `patch` lookup', () => {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const c = patchCliCommand(repo, ['hosts', 'update', '--json']);
  assert.equal(c.cmd, process.execPath);
  assert.equal(c.args[0], join(repo, 'packages/cli/dist/index.js'));
  assert.deepEqual(c.args.slice(1), ['hosts', 'update', '--json']);
  assert.notEqual(c.cmd, 'patch');
});

test('an unbuilt CLI throws rather than falling back to PATH', () => {
  assert.throws(() => patchCliCommand('/nonexistent', ['hosts']), /not built/);
});
