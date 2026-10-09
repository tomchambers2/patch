// What the box's downloads prune keeps (scripts/prune-downloads.mjs).
//
// The dangerous direction is deleting something an updater still fetches, so
// most of these are about what must SURVIVE: whatever a live manifest names,
// the build before it (the rollback), and anything the prune cannot classify.
//
// Run: node --test scripts/prune-downloads.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planPrune } from './prune-downloads.mjs';

/** A downloads dir: `files` maps name → age in hours (older = published earlier). */
function downloads(files) {
  const dir = mkdtempSync(join(tmpdir(), 'prune-downloads-'));
  const now = Date.now() / 1000;
  for (const [name, content] of Object.entries(files)) {
    const [body, hoursOld] = Array.isArray(content) ? content : [content, 0];
    writeFileSync(join(dir, name), body);
    utimesSync(join(dir, name), now - hoursOld * 3600, now - hoursOld * 3600);
  }
  return dir;
}

const apkManifest = (file) => JSON.stringify({ version: '0.1.3', gitSha: 'abc1234', file });
const daemonManifest = (...files) =>
  JSON.stringify({ version: '0.1.9', artifacts: files.map((file) => ({ file })) });

test('keeps what android-latest.json names, and the APK published before it', () => {
  const dir = downloads({
    'android-latest.json': apkManifest('patch-ccccccc.apk'),
    'patch.apk': 'x',
    'patch-ccccccc.apk': ['x', 1],
    'patch-bbbbbbb.apk': ['x', 5],
    'patch-aaaaaaa.apk': ['x', 9],
  });
  const { remove, keep } = planPrune(dir);
  assert.deepEqual(remove, ['patch-aaaaaaa.apk']);
  assert.ok(keep.includes('patch-bbbbbbb.apk'), 'the previous APK is the rollback');
  assert.ok(keep.includes('patch.apk'));
});

test('the rollback is the newest superseded build, not the highest-sorting name', () => {
  const dir = downloads({
    'android-latest.json': apkManifest('patch-5555555.apk'),
    'patch-5555555.apk': ['x', 1],
    'patch-9999999.apk': ['x', 30],
    'patch-1111111.apk': ['x', 2],
  });
  assert.deepEqual(planPrune(dir).remove, ['patch-9999999.apk']);
});

test('the host keeps a previous build per target, with its signature', () => {
  const dir = downloads({
    'daemon-latest.json': daemonManifest(
      'patch-daemon-0.1.9-linux-x64.tar.gz',
      'patch-daemon-0.1.9-darwin-arm64.tar.gz',
    ),
    'patch-daemon-0.1.9-linux-x64.tar.gz': ['x', 1],
    'patch-daemon-0.1.9-linux-x64.tar.gz.sig': ['x', 1],
    'patch-daemon-0.1.9-darwin-arm64.tar.gz': ['x', 1],
    'patch-daemon-0.1.8-linux-x64.tar.gz': ['x', 5],
    'patch-daemon-0.1.8-linux-x64.tar.gz.sig': ['x', 5],
    'patch-daemon-0.1.7-linux-x64.tar.gz': ['x', 9],
    'patch-daemon-0.1.7-linux-x64.tar.gz.sig': ['x', 9],
    'patch-daemon-0.1.7-darwin-arm64.tar.gz': ['x', 9],
  });
  assert.deepEqual(planPrune(dir).remove.sort(), [
    'patch-daemon-0.1.7-linux-x64.tar.gz',
    'patch-daemon-0.1.7-linux-x64.tar.gz.sig',
  ]);
});

test('keepPrevious: 0 is back to the current build only', () => {
  const dir = downloads({
    'android-latest.json': apkManifest('patch-ccccccc.apk'),
    'patch-ccccccc.apk': ['x', 1],
    'patch-bbbbbbb.apk': ['x', 5],
  });
  assert.deepEqual(planPrune(dir, { keepPrevious: 0 }).remove, ['patch-bbbbbbb.apk']);
});

test('no manifest, nothing of that family goes — refuse rather than guess', () => {
  const dir = downloads({
    'patch-ccccccc.apk': ['x', 1],
    'patch-bbbbbbb.apk': ['x', 5],
    'patch-aaaaaaa.apk': ['x', 9],
  });
  assert.deepEqual(planPrune(dir).remove, []);
});

test('an unreadable manifest is no manifest', () => {
  const dir = downloads({
    'android-latest.json': '{"file": "patch-cc',
    'patch-bbbbbbb.apk': ['x', 5],
    'patch-aaaaaaa.apk': ['x', 9],
  });
  assert.deepEqual(planPrune(dir).remove, []);
});

test('files it does not recognise are never touched', () => {
  const dir = downloads({
    'android-latest.json': apkManifest('patch-ccccccc.apk'),
    'patch-ccccccc.apk': ['x', 1],
    'install.sh': ['x', 900],
    'notes.txt': ['x', 900],
  });
  assert.deepEqual(planPrune(dir).remove, []);
});
