// The one-command server installer (packages/server/release/install-server.sh),
// run for real against a fake release tarball served from a file:// URL.
//
// What a laptop cannot do is issue a certificate or write /etc/systemd, so those
// halves are covered by what the script PRODUCES (the Caddyfile it would write,
// the refusals it makes) and by a real run of the rest in --user-mode.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(here, '..', 'packages/server/release');
const SCRIPT = join(TEMPLATE, 'install-server.sh');

function fakeTarball(root, { release = '0.1.1', corrupt = false } = {}) {
  const dir = join(root, 'build', `patch-server-${release}`);
  mkdirSync(join(dir, 'server/dist'), { recursive: true });
  mkdirSync(join(dir, 'web'), { recursive: true });
  for (const f of ['patch-server', 'install', 'server.env.example']) cpSync(join(TEMPLATE, f), join(dir, f));
  writeFileSync(join(dir, 'server/dist/index.js'), 'console.log("up")\n');
  writeFileSync(join(dir, 'web/index.html'), '<script src="assets/index-abc.js"></script>');
  writeFileSync(
    join(dir, 'build-info.json'),
    JSON.stringify({ release, version: release, gitSha: 'abc1234', builtAt: 'x', serverSha: 'abc1234' }),
  );
  const tarball = join(root, 'patch-server.tar.gz');
  const r = spawnSync('tar', ['-czf', tarball, '-C', join(root, 'build'), `patch-server-${release}`]);
  assert.equal(r.status, 0);
  const sum = createHash('sha256').update(readFileSync(tarball)).digest('hex');
  writeFileSync(`${tarball}.sha256`, `${corrupt ? '0'.repeat(64) : sum}  patch-server.tar.gz\n`);
  return `file://${tarball}`;
}

const run = (args, env = {}) =>
  spawnSync('sh', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: env.HOME ?? '/nonexistent', ...env },
  });

test('--print-caddyfile names the domain it was given and proxies to the server', () => {
  const r = run(['--domain', 'patch.example.com', '--email', 'me@example.com', '--print-caddyfile']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /email me@example\.com/);
  assert.match(r.stdout, /^patch\.example\.com \{$/m);
  assert.match(r.stdout, /reverse_proxy 127\.0\.0\.1:3000/);
  assert.match(r.stdout, /@device path \/device\/\*/);
  assert.match(r.stdout, /reverse_proxy @device 127\.0\.0\.1:3003/);
  assert.doesNotMatch(r.stdout, /@audio|\/audio\/\*/);
});

test('with no domain it uses <ip>.sslip.io, a name that already resolves to the box', () => {
  const r = run(['--print-caddyfile'], { PATCH_INSTALL_PUBLIC_IP: '203.0.113.5' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^203-0-113-5\.sslip\.io \{$/m);
});

test('an IP that is not an IPv4 address is refused, not turned into a hostname', () => {
  const r = run(['--print-caddyfile'], { PATCH_INSTALL_PUBLIC_IP: '2001:db8::1' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not an IPv4 address/);
});

test('without root it says how to run it, and installs nothing', { skip: process.getuid?.() === 0 }, () => {
  const r = run(['--release-url', 'file:///nowhere']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /needs root/);
  assert.match(r.stderr, /--user-mode/);
});

test('--user-mode is for a normal user only', { skip: process.getuid?.() !== 0 }, () => {
  const r = run(['--user-mode']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /as root, leave it off/);
});

test('a download that does not match its checksum is not installed', () => {
  const root = mkdtempSync(join(tmpdir(), 'patch-install-'));
  const url = fakeTarball(root, { corrupt: true });
  const home = join(root, 'home');
  const r = run(['--user-mode', '--no-service', '--release-url', url, '--home', home], {
    HOME: root,
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /does not match its published checksum/);
  assert.ok(!existsSync(join(home, 'current')));
});

test('an unsupported CPU is named, not guessed at', () => {
  const r = run(['--user-mode', '--release-url', 'file:///nowhere'], { PATCH_INSTALL_UNAME_M: 'riscv64' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no Node build for/);
});

test('--user-mode --no-service lays the release out and says how to start it', () => {
  const root = mkdtempSync(join(tmpdir(), 'patch-install-'));
  const url = fakeTarball(root);
  const home = join(root, 'home');
  const r = run(['--user-mode', '--no-service', '--release-url', url, '--home', home], { HOME: root });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(home, 'current/patch-server')));
  const env = readFileSync(join(home, 'server.env'), 'utf8');
  assert.match(env, /^PATCH_PUBLIC_URL=http:\/\/.*:3000$/m);
  assert.match(env, /^HOST=0\.0\.0\.0$/m);
  assert.match(r.stdout, /Start it with/);
});

test('the build publishes the tarball under a stable name, its checksum, and the installer', async () => {
  const { writeInstallChannel } = await import('./build-server.mjs');
  const root = mkdtempSync(join(tmpdir(), 'patch-channel-'));
  const out = join(root, 'out');
  mkdirSync(out);
  const tarball = join(out, 'patch-server-0.1.9.tar.gz');
  writeFileSync(tarball, 'tarball bytes');
  const made = writeInstallChannel({ root: join(here, '..'), out, tarball });
  const sum = createHash('sha256').update('tarball bytes').digest('hex');
  assert.equal(made.sum, sum);
  assert.equal(readFileSync(join(out, 'patch-server.tar.gz.sha256'), 'utf8'), `${sum}  patch-server.tar.gz\n`);
  assert.equal(readFileSync(join(out, 'install.sh'), 'utf8'), readFileSync(SCRIPT, 'utf8'));
});
