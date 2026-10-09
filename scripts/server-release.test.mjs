// The server release's installer and launcher (packages/server/release/), run
// for real against a fake release in a scratch install home.
//
// The point of the release is that the running app lives in its own home and
// never in a git checkout: on 2026-09-30 an agent's `git stash -u` in the box's
// checkout swept the live SPA (deploy/web-dist) and the update channel
// (deploy/downloads) into a stash, and prod served "route not found" for 14
// hours while /api/healthz said ok.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(here, '..', 'packages/server/release');

/** A release directory like build-server.mjs makes, whose server prints its env. */
function fakeRelease(root, release, gitSha = `sha${release.replace(/\./g, '')}`) {
  const dir = join(root, `patch-server-${release}`);
  mkdirSync(join(dir, 'server/dist'), { recursive: true });
  mkdirSync(join(dir, 'web'), { recursive: true });
  for (const f of ['patch-server', 'install', 'server.env.example']) {
    cpSync(join(TEMPLATE, f), join(dir, f));
  }
  writeFileSync(
    join(dir, 'server/dist/index.js'),
    "const k=['PATCH_DATA_DIR','PATCH_DOWNLOADS_DIR','PATCH_WEB_DIST','PATCH_VERSION','PATCH_GIT_SHA','PATCH_BUILT_AT','PATCH_SERVER_SHA','NODE_ENV'];" +
      'console.log(JSON.stringify(Object.fromEntries(k.map((n)=>[n,process.env[n]]))));\n',
  );
  writeFileSync(join(dir, 'web/index.html'), '<script src="assets/index-abc.js"></script>');
  writeFileSync(
    join(dir, 'build-info.json'),
    JSON.stringify({
      release,
      version: release,
      gitSha,
      builtAt: '2026-10-01T00:00:00Z',
      serverSha: gitSha,
      web: { gitSha, bundle: 'assets/index-abc.js' },
    }),
  );
  return dir;
}

const install = (rel, home) =>
  spawnSync('sh', [join(rel, 'install'), '--home', home, '--no-service'], { encoding: 'utf8' });

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'patch-server-release-'));
  return { root, home: join(root, 'home') };
}

test('a first install needs no configuration: it writes server.env and carries on', () => {
  const { root, home } = scratch();
  const r = install(fakeRelease(root, '0.1.1'), home);
  assert.equal(r.status, 0, r.stderr);
  const env = readFileSync(join(home, 'server.env'), 'utf8');
  assert.doesNotMatch(env, /PATCH_INTERNAL_TOKEN=./, 'the server makes its own token (spec/01)');
  assert.doesNotMatch(env, /TELEGRAM/);
  assert.match(env, /^PORT=3000$/m);
  assert.match(env, /^HOST=127\.0\.0\.1$/m);
  assert.equal(statSync(join(home, 'server.env')).mode & 0o777, 0o600);
  assert.equal(basename(readlinkSync(join(home, 'current'))), '0.1.1');
});

test('--public-url and --host are written to a first install only', () => {
  const { root, home } = scratch();
  const rel = fakeRelease(root, '0.1.1');
  const r = spawnSync(
    'sh',
    [join(rel, 'install'), '--home', home, '--no-service', '--public-url', 'https://patch.example', '--host', '0.0.0.0'],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 0, r.stderr);
  const env = readFileSync(join(home, 'server.env'), 'utf8');
  assert.match(env, /^PATCH_PUBLIC_URL=https:\/\/patch\.example$/m);
  assert.match(env, /^HOST=0\.0\.0\.0$/m);
  // A later install does not rewrite what a person may have edited.
  spawnSync('sh', [join(fakeRelease(root, '0.1.2'), 'install'), '--home', home, '--no-service', '--public-url', 'https://other.example'], { encoding: 'utf8' });
  assert.match(readFileSync(join(home, 'server.env'), 'utf8'), /^PATCH_PUBLIC_URL=https:\/\/patch\.example$/m);
});

test('an emptied PORT is refused, loudly', () => {
  const { root, home } = scratch();
  const rel = fakeRelease(root, '0.1.1');
  install(rel, home);
  writeFileSync(join(home, 'server.env'), 'PORT=\n');
  const r = install(rel, home);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /PORT is empty/);
});

test('--system is refused to anyone but root', { skip: process.getuid?.() === 0 }, () => {
  const { root, home } = scratch();
  const r = spawnSync('sh', [join(fakeRelease(root, '0.1.1'), 'install'), '--home', home, '--system'], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--system needs root/);
});

test('`patch-server pair` runs the pair script against the install, with server.env loaded', () => {
  const { root, home } = scratch();
  const rel = fakeRelease(root, '0.1.1');
  mkdirSync(join(rel, 'server/dist/scripts'), { recursive: true });
  writeFileSync(
    join(rel, 'server/dist/scripts/pair.js'),
    "console.log(JSON.stringify({ args: process.argv.slice(2), home: process.env.PATCH_SERVER_HOME, data: process.env.PATCH_DATA_DIR, url: process.env.PATCH_PUBLIC_URL }));\n",
  );
  spawnSync('sh', [join(rel, 'install'), '--home', home, '--no-service', '--public-url', 'https://patch.example'], { encoding: 'utf8' });
  const r = spawnSync(join(home, 'current/patch-server'), ['pair', '--json'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
  });
  assert.equal(r.status, 0, r.stderr);
  const seen = JSON.parse(r.stdout);
  assert.deepEqual(seen.args, ['--json']);
  assert.equal(seen.url, 'https://patch.example');
  assert.ok(seen.data.endsWith('/home/data'));
  assert.ok(seen.home.endsWith('/home'));
});

test('installs into versions/, points current at it, and lays out the home', () => {
  const { root, home } = scratch();
  const rel = fakeRelease(root, '0.1.1');
  install(rel, home);
  const r = install(rel, home);
  assert.equal(r.status, 0, r.stderr);
  for (const d of ['data', 'downloads', 'logs', 'versions/0.1.1/web']) {
    assert.ok(existsSync(join(home, d)), d);
  }
  assert.equal(basename(readlinkSync(join(home, 'current'))), '0.1.1');
});

test('an upgrade swaps current and keeps only the two releases before it', () => {
  const { root, home } = scratch();
  install(fakeRelease(root, '0.1.1'), home);
  for (const v of ['0.1.1', '0.1.2', '0.1.3', '0.1.4', '0.1.5']) {
    const r = install(fakeRelease(root, v), home);
    assert.equal(r.status, 0, r.stderr);
  }
  assert.equal(basename(readlinkSync(join(home, 'current'))), '0.1.5');
  assert.deepEqual(readdirSync(join(home, 'versions')).sort(), ['0.1.3', '0.1.4', '0.1.5']);
});

const installAsync = (rel, home) =>
  new Promise((resolve) => {
    const c = spawn('sh', [join(rel, 'install'), '--home', home, '--no-service'], { encoding: 'utf8' });
    let err = '';
    c.stderr.on('data', (d) => (err += d));
    c.on('close', (status) => resolve({ status, stderr: err }));
  });

const isComplete = (dir) =>
  ['server/dist/index.js', 'web/index.html', 'build-info.json'].every((f) => existsSync(join(dir, f)));

test('two concurrent installs of the same release leave a complete release behind current', async () => {
  // 7 Oct: two deploys built the same release and installed together; one's
  // rm/mv deleted the other's tree and `current` pointed at half a release.
  for (let round = 0; round < 5; round++) {
    const { root, home } = scratch();
    const a = fakeRelease(join(root, 'a'), '0.1.9');
    const b = fakeRelease(join(root, 'b'), '0.1.9');
    const rs = await Promise.all([installAsync(a, home), installAsync(b, home), installAsync(a, home)]);
    for (const r of rs) assert.equal(r.status, 0, r.stderr);
    assert.ok(isComplete(join(home, 'current')), 'current resolves to a complete release');
    assert.ok(isComplete(join(home, 'versions/0.1.9')));
    assert.deepEqual(readdirSync(join(home, 'versions')), ['0.1.9'], 'no staging dirs left behind');
  }
});

test('an incomplete release is refused before current is touched', () => {
  const { root, home } = scratch();
  install(fakeRelease(root, '0.1.1'), home);
  const bad = fakeRelease(root, '0.1.2');
  rmSync(join(bad, 'web'), { recursive: true });
  const r = install(bad, home);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not a complete release/);
  assert.equal(basename(readlinkSync(join(home, 'current'))), '0.1.1');
  assert.ok(!existsSync(join(home, 'versions/0.1.2')));
});

test('the launcher runs the release against the home, stamped from build-info', () => {
  const { root, home } = scratch();
  install(fakeRelease(root, '0.1.7', 'abc1234'), home);
  install(fakeRelease(root, '0.1.7', 'abc1234'), home);
  const r = spawnSync(join(home, 'current/patch-server'), [], {
    encoding: 'utf8',
    env: { ...process.env, PATCH_SERVER_HOME: home, PATCH_NODE: process.execPath },
  });
  assert.equal(r.status, 0, r.stderr);
  const env = JSON.parse(r.stdout);
  const real = join(dirname(readlinkSync(join(home, 'current'))), '0.1.7');
  assert.ok(env.PATCH_DATA_DIR.endsWith('/home/data'));
  assert.ok(env.PATCH_DOWNLOADS_DIR.endsWith('/home/downloads'));
  assert.ok(env.PATCH_WEB_DIST.endsWith(`${basename(real)}/web`));
  assert.equal(env.PATCH_VERSION, '0.1.7');
  assert.equal(env.PATCH_GIT_SHA, 'abc1234');
  assert.equal(env.NODE_ENV, 'production');
});

test('the launcher refuses to run outside the unit (no home, no node)', () => {
  const { root, home } = scratch();
  install(fakeRelease(root, '0.1.1'), home);
  install(fakeRelease(root, '0.1.1'), home);
  const env = { ...process.env };
  delete env.PATCH_SERVER_HOME;
  delete env.PATCH_NODE;
  const r = spawnSync(join(home, 'current/patch-server'), [], { encoding: 'utf8', env });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /PATCH_SERVER_HOME is not set/);
});
