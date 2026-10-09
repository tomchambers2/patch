import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, startLocalServer } from './local-server.js';

const here = dirname(fileURLToPath(import.meta.url));
const LAUNCHER = join(here, '..', '..', '..', 'server', 'release', 'patch-server');

/** A release whose server answers /api/healthz and records the env it was given. */
function fakeRelease(root: string, gitSha = 'abc1234', server?: string): string {
  const dir = join(root, 'server-release');
  mkdirSync(join(dir, 'server/dist'), { recursive: true });
  mkdirSync(join(dir, 'web'), { recursive: true });
  cpSync(LAUNCHER, join(dir, 'patch-server'));
  writeFileSync(join(dir, 'web/index.html'), '<html></html>');
  writeFileSync(
    join(dir, 'build-info.json'),
    JSON.stringify({ release: '0.1.1', version: '0.1.1', gitSha, builtAt: 'x', serverSha: gitSha }),
  );
  writeFileSync(
    join(dir, 'server/dist/index.js'),
    server ??
      `const http = require('node:http');
require('node:fs').writeFileSync(process.env.PATCH_DATA_DIR + '/env.json', JSON.stringify({
  port: process.env.PORT, host: process.env.HOST, relay: process.env.PATCH_RELAY_URL ?? null,
  downloads: process.env.PATCH_DOWNLOADS_DIR, web: process.env.PATCH_WEB_DIST, asNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
}));
http.createServer((req, res) => { res.setHeader('content-type','application/json'); res.end(JSON.stringify({ ok: true, version: '0.1.1', gitSha: ${JSON.stringify(gitSha)} })); }).listen(Number(process.env.PORT), process.env.HOST);
process.on('SIGTERM', () => process.exit(0));`,
  );
  return dir;
}

const scratch = () => mkdtempSync(join(tmpdir(), 'patch-local-'));
const opts = (root: string, over: { releaseDir?: string } = {}) => ({
  home: join(root, 'server'),
  node: { execPath: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } },
  ...over,
  releaseDir: over.releaseDir ?? fakeRelease(root),
});

test('freePort hands out a port nothing is listening on', async () => {
  const port = await freePort();
  assert.ok(port > 1023);
  await new Promise<void>((resolve, reject) => {
    const s = createServer()
      .once('error', reject)
      .listen(port, '127.0.0.1', () => s.close(() => resolve()));
  });
});

test('starts the release against its own home, on loopback, and answers on its port', async () => {
  const root = scratch();
  const port = await freePort();
  const server = await startLocalServer({
    ...opts(root),
    port,
    relayUrl: 'wss://relay.example.com',
  });
  try {
    assert.equal(server.origin, `http://127.0.0.1:${port}`);
    const res = await fetch(`${server.origin}/api/healthz`);
    assert.equal(res.status, 200);
    const env = JSON.parse(readFileSync(join(root, 'server/data/env.json'), 'utf8'));
    assert.deepEqual(env, {
      port: String(port),
      host: '127.0.0.1',
      relay: 'wss://relay.example.com',
      downloads: join(root, 'server/downloads'),
      web: join(root, 'server-release/web'),
      asNode: '1',
    });
    assert.ok(existsSync(join(root, 'server/logs/server.log')));
  } finally {
    await server.stop();
  }
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/healthz`));
});

test('without a relay it sets none', async () => {
  const root = scratch();
  const server = await startLocalServer({ ...opts(root), port: await freePort() });
  try {
    assert.equal(JSON.parse(readFileSync(join(root, 'server/data/env.json'), 'utf8')).relay, null);
  } finally {
    await server.stop();
  }
});

test('seeds the downloads directory with the host builds the app carries', async () => {
  const root = scratch();
  const daemon = join(root, 'daemon');
  mkdirSync(daemon);
  writeFileSync(join(daemon, 'daemon-latest.json'), '{"version":"1"}');
  writeFileSync(join(daemon, 'patch-daemon-darwin-arm64.tar.gz'), 'artifact');
  const server = await startLocalServer({
    ...opts(root),
    port: await freePort(),
    daemonArtifacts: daemon,
  });
  try {
    assert.deepEqual(readdirSync(join(root, 'server/downloads')).sort(), [
      'daemon-latest.json',
      'patch-daemon-darwin-arm64.tar.gz',
    ]);
    assert.equal(
      readFileSync(join(root, 'server/downloads/daemon-latest.json'), 'utf8'),
      '{"version":"1"}',
    );
  } finally {
    await server.stop();
  }
});

test('says which directory is missing when the app was built without its host', async () => {
  const root = scratch();
  await assert.rejects(
    startLocalServer({
      ...opts(root),
      port: await freePort(),
      daemonArtifacts: join(root, 'nope'),
    }),
    /host builds.*nope/,
  );
});

test('a release that is not there is an error naming the path', async () => {
  const root = scratch();
  await assert.rejects(
    startLocalServer({
      ...opts(root, { releaseDir: join(root, 'missing') }),
      port: await freePort(),
    }),
    /missing/,
  );
});

test('a server that dies on start is reported with the end of its log', async () => {
  const root = scratch();
  const releaseDir = fakeRelease(
    root,
    'abc1234',
    "console.error('boom: cannot start'); process.exit(3);",
  );
  await assert.rejects(
    startLocalServer({
      ...opts(root, { releaseDir }),
      port: await freePort(),
      startTimeoutMs: 5000,
    }),
    /exited.*boom: cannot start/s,
  );
});

test('a server that never answers is stopped and reported, not waited on for ever', async () => {
  const root = scratch();
  const releaseDir = fakeRelease(root, 'abc1234', 'setInterval(() => {}, 1000);');
  await assert.rejects(
    startLocalServer({
      ...opts(root, { releaseDir }),
      port: await freePort(),
      startTimeoutMs: 600,
    }),
    /did not answer/,
  );
});

test('picks up a server of this same release that is already running on its port', async () => {
  const root = scratch();
  const port = await freePort();
  const first = await startLocalServer({ ...opts(root), port });
  try {
    const second = await startLocalServer({ ...opts(root), port });
    assert.equal(second.origin, first.origin);
    await second.stop(); // does not own it: the first keeps running
    assert.equal((await fetch(`${first.origin}/api/healthz`)).status, 200);
  } finally {
    await first.stop();
  }
});

test('refuses a port held by a different build, rather than talking to it', async () => {
  const root = scratch();
  const port = await freePort();
  const other = await startLocalServer({
    ...opts(root, { releaseDir: fakeRelease(scratch(), 'other999') }),
    port,
  });
  try {
    await assert.rejects(startLocalServer({ ...opts(root), port }), /already answering.*other999/s);
  } finally {
    await other.stop();
  }
});
