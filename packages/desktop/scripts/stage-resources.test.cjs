const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, readdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { stage, wanted } = require('./stage-resources.cjs');

function repo(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'patch-stage-'));
  const daemon = path.join(root, 'repo', 'dist', 'daemon');
  mkdirSync(daemon, { recursive: true });
  for (const f of files) writeFileSync(path.join(daemon, f), f);
  return { repoRoot: path.join(root, 'repo'), desktopDir: path.join(root, 'desktop') };
}
const fakeRelease = (out) => {
  const dir = path.join(out, 'patch-server-1');
  mkdirSync(path.join(dir, 'server'), { recursive: true });
  writeFileSync(path.join(dir, 'patch-server'), '#!/bin/sh');
  return dir;
};

test('carries the manifest, the installer and only this Mac’s host build', () => {
  const r = repo([
    'daemon-latest.json',
    'install.sh',
    'patch-daemon-1-darwin-arm64.tar.gz',
    'patch-daemon-1-darwin-arm64.tar.gz.sig',
    'patch-daemon-1-linux-x64.tar.gz',
    'patch-daemon-1-linux-arm64.tar.gz',
  ]);
  const staged = stage({ ...r, buildServer: fakeRelease });
  assert.deepEqual(readdirSync(path.join(staged, 'daemon')).sort(), [
    'daemon-latest.json',
    'install.sh',
    'patch-daemon-1-darwin-arm64.tar.gz',
    'patch-daemon-1-darwin-arm64.tar.gz.sig',
  ]);
  assert.deepEqual(readdirSync(path.join(staged, 'server')).sort(), ['patch-server', 'server']);
  assert.deepEqual(readdirSync(staged).sort(), ['daemon', 'server']);
});

test('refuses to package an app with no host build, naming what to run', () => {
  const r = repo([]);
  assert.throws(() => stage({ ...r, buildServer: fakeRelease }), /pnpm build:daemon/);
});

test('refuses a host directory that has nothing for this Mac', () => {
  const r = repo(['daemon-latest.json', 'patch-daemon-1-linux-x64.tar.gz']);
  assert.throws(() => stage({ ...r, buildServer: fakeRelease }), /no darwin-arm64/);
});

test('wanted() keeps non-tarballs and darwin-arm64 tarballs', () => {
  assert.equal(wanted('install.sh'), true);
  assert.equal(wanted('x-darwin-arm64.tar.gz'), true);
  assert.equal(wanted('x-linux-x64.tar.gz'), false);
});
