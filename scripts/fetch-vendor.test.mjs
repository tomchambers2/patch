import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NODE_PIN, assertNodePinMatchesNvmrc, checksumFor } from './fetch-vendor.mjs';

test('the checksum is read from the line naming exactly that file', () => {
  const sums = [
    'aaa111  node-v22.1.0-linux-x64.tar.gz',
    'bbb222  node-v22.1.0-linux-x64.tar.xz',
    'ccc333  node-v22.1.0-darwin-arm64.tar.gz',
  ].join('\n');
  assert.equal(checksumFor(sums, 'node-v22.1.0-linux-x64.tar.gz'), 'aaa111');
  assert.equal(checksumFor(sums, 'node-v22.1.0-darwin-arm64.tar.gz'), 'ccc333');
});

test('a file that is not listed is an error, not an empty checksum', () => {
  assert.throws(() => checksumFor('aaa  other.tar.gz', 'node-v22.1.0-linux-x64.tar.gz'), /not listed/);
});

test('the pinned Node must stay on the major line .nvmrc names', () => {
  assert.doesNotThrow(() => assertNodePinMatchesNvmrc(NODE_PIN, '22\n'));
  assert.doesNotThrow(() => assertNodePinMatchesNvmrc('22.4.0', 'v22'));
  assert.throws(() => assertNodePinMatchesNvmrc(NODE_PIN, '24\n'), /\.nvmrc/);
});
