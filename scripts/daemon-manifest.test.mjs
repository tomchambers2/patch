// Merging the Mac's darwin build into the box's host manifest
// (scripts/daemon-manifest.mjs).
//
// Run: node scripts/daemon-manifest.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeDaemonArtifact } from './daemon-manifest.mjs';

const linux = { target: 'linux-x64', file: 'patch-daemon-0.1.9-linux-x64.tar.gz', sha256: 'aa' };
const darwin = {
  target: 'darwin-arm64',
  file: 'patch-daemon-0.1.9-darwin-arm64.tar.gz',
  sha256: 'bb',
};
const box = { version: '0.1.9', gitSha: 'abc1234', signingPublicKey: 'K', artifacts: [linux] };
const mac = { version: '0.1.9', gitSha: 'abc1234', signingPublicKey: 'K', artifacts: [darwin] };

test("adds the Mac's artifact beside the box's", () => {
  const merged = mergeDaemonArtifact(box, mac, 'darwin-arm64');
  assert.deepEqual(merged.artifacts, [linux, darwin]);
  assert.equal(merged.version, '0.1.9');
});

test('replaces an earlier darwin entry rather than listing two', () => {
  const stale = { ...darwin, sha256: 'old' };
  const merged = mergeDaemonArtifact({ ...box, artifacts: [linux, stale] }, mac, 'darwin-arm64');
  assert.deepEqual(merged.artifacts, [linux, darwin]);
});

test('refuses a Mac build of another commit', () => {
  assert.throws(
    () => mergeDaemonArtifact(box, { ...mac, version: '0.1.8', gitSha: 'fff0000' }, 'darwin-arm64'),
    /refusing to mix two builds/,
  );
});

test('refuses a Mac build signed with another artifact key', () => {
  assert.throws(
    () => mergeDaemonArtifact(box, { ...mac, signingPublicKey: 'other' }, 'darwin-arm64'),
    /different artifact key/,
  );
});

test('refuses a Mac manifest without the target it claims to have built', () => {
  assert.throws(
    () => mergeDaemonArtifact(box, { ...mac, artifacts: [] }, 'darwin-arm64'),
    /no darwin-arm64/,
  );
});
