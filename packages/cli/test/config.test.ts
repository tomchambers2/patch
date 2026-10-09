// Config + env-override tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, configFilePath, configHomeDir } from '../src/config.js';

// Every env var loadConfig reads. The helper clears ALL of them rather than just
// pointing PATCH_HOME at a temp dir: an ambient PATCH_SERVER_URL outranks the
// config file, so on a machine where patch is actually configured — which
// includes the box that deploys it — the temp file under test was ignored and
// these tests failed. Green on a laptop, red where it counts.
const CONFIG_ENV = [
  'PATCH_HOME',
  'PATCH_CONFIG_DIR',
  'PATCH_SERVER_URL',
  'PATCH_DAEMON_SOCKET',
  'PATCH_DAEMON_LOCAL_KEY',
] as const;

function withTempPatchHome(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'patch-cli-test-'));
  const saved = CONFIG_ENV.map((key) => [key, process.env[key]] as const);
  for (const key of CONFIG_ENV) delete process.env[key];
  process.env.PATCH_HOME = dir;
  try {
    fn(dir);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

test('loadConfig: returns defaults when no file', () => {
  withTempPatchHome(() => {
    const c = loadConfig();
    assert.equal(c.serverUrl, 'http://localhost:3000');
    assert.equal(c.daemonSocket, null);
    assert.equal(c.daemonLocalKey, null);
    assert.deepEqual(c.defaultFlags, []);
  });
});

test('loadConfig: reads ~/.patch/config.json', () => {
  withTempPatchHome((dir) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ serverUrl: 'https://example.test', defaultFlags: ['--foo'] }),
    );
    const c = loadConfig();
    assert.equal(c.serverUrl, 'https://example.test');
    assert.deepEqual(c.defaultFlags, ['--foo']);
    assert.equal(configFilePath(), join(dir, 'config.json'));
    assert.equal(configHomeDir(), dir);
  });
});

test('loadConfig: env overrides file', () => {
  withTempPatchHome((dir) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ serverUrl: 'https://from-file' }));
    process.env.PATCH_SERVER_URL = 'https://from-env';
    try {
      const c = loadConfig();
      assert.equal(c.serverUrl, 'https://from-env');
    } finally {
      delete process.env.PATCH_SERVER_URL;
    }
  });
});

test('configHomeDir: PATCH_CONFIG_DIR works as alias for PATCH_HOME', () => {
  const prevHome = process.env.PATCH_HOME;
  const prevCfg = process.env.PATCH_CONFIG_DIR;
  delete process.env.PATCH_HOME;
  process.env.PATCH_CONFIG_DIR = '/tmp/cdir';
  try {
    assert.equal(configHomeDir(), '/tmp/cdir');
  } finally {
    if (prevHome !== undefined) process.env.PATCH_HOME = prevHome;
    if (prevCfg === undefined) delete process.env.PATCH_CONFIG_DIR;
    else process.env.PATCH_CONFIG_DIR = prevCfg;
  }
});

test('configHomeDir: setting both PATCH_HOME and PATCH_CONFIG_DIR (different values) throws', () => {
  const prevHome = process.env.PATCH_HOME;
  const prevCfg = process.env.PATCH_CONFIG_DIR;
  process.env.PATCH_HOME = '/a';
  process.env.PATCH_CONFIG_DIR = '/b';
  try {
    assert.throws(() => configHomeDir(), /set only one/);
  } finally {
    if (prevHome === undefined) delete process.env.PATCH_HOME;
    else process.env.PATCH_HOME = prevHome;
    if (prevCfg === undefined) delete process.env.PATCH_CONFIG_DIR;
    else process.env.PATCH_CONFIG_DIR = prevCfg;
  }
});

test('loadConfig: malformed JSON throws (NO FALLBACK)', () => {
  withTempPatchHome((dir) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), 'not json');
    assert.throws(() => loadConfig());
  });
});
