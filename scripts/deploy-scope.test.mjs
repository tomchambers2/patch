// Which surfaces a diff needs (scripts/deploy-scope.mjs).
//
// Getting this wrong is the worst failure this area has: a deploy that reports
// success while silently not shipping the thing you changed. So the interesting
// cases here are all the ones where it must NOT narrow — an unattributed path,
// a shared lib, the deploy script itself.
//
// Run: node scripts/deploy-scope.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_SURFACES,
  LANES,
  laneArgs,
  lanesFor,
  surfacesForChangedFiles,
  withLockstep,
} from './deploy-scope.mjs';

const scope = (files) => surfacesForChangedFiles(files);

test('a server-only diff ships the server and nothing else', () => {
  const { surfaces, unattributed } = scope(['packages/server/src/ws-hub.ts']);
  assert.deepEqual(surfaces, ['server']);
  assert.deepEqual(unattributed, []);
});

test('a host diff also ships the apply step — the restart IS the delivery', () => {
  const { surfaces } = scope(['packages/daemon/src/index.ts']);
  assert.deepEqual(surfaces, ['daemon', 'daemon-mac', 'apply']);
});

test('a web-only diff ships the SPA and nothing else', () => {
  assert.deepEqual(scope(['packages/web/src/routes/SettingsRoute.tsx']).surfaces, ['web']);
});

test('a wire change reaches everything that resolves it', () => {
  // The shared schema is compiled into the SPA and resolved at runtime by both
  // the server and the host, so narrowing here would ship a strict-schema
  // mismatch — the exact failure that makes the server drop valid frames.
  const { surfaces } = scope(['packages/wire/src/events.ts']);
  for (const s of ['web', 'server', 'daemon', 'daemon-mac', 'apply', 'ota', 'apk', 'smoke']) {
    assert.ok(surfaces.includes(s), `wire must ship ${s}`);
  }
  assert.ok(!surfaces.includes('desktop'), 'the desktop shell loads a URL; it embeds no wire code');
});

test('the patch CLI ships with the host that installs it', () => {
  assert.deepEqual(scope(['packages/cli/src/commands/chats.ts']).surfaces, [
    'daemon',
    'daemon-mac',
    'apply',
  ]);
});

test('a mobile diff ships OTA and APK and smokes the result, not the box surfaces', () => {
  assert.deepEqual(scope(['apps/mobile/app/index.tsx']).surfaces, ['ota', 'apk', 'smoke']);
});

test('docs and specs ship nothing', () => {
  const { surfaces, unattributed } = scope(['spec/02-daemon.md', 'docs/google-cloud.md']);
  assert.deepEqual(surfaces, []);
  assert.deepEqual(unattributed, []);
});

test('an UNATTRIBUTED path is reported, so the caller ships everything', () => {
  // A root config, the lockfile, turbo.json — any of these can reach anything.
  for (const file of ['pnpm-lock.yaml', 'turbo.json', 'tsconfig.base.json', 'package.json']) {
    const { unattributed } = scope([file]);
    assert.deepEqual(unattributed, [file], `${file} must not be silently attributed`);
  }
});

test('the deploy script itself is unattributed — it can change every surface', () => {
  assert.deepEqual(scope(['scripts/ship.mjs']).unattributed, ['scripts/ship.mjs']);
});

test('one unattributed path among attributed ones still reports it', () => {
  const { unattributed } = scope(['packages/server/src/app.ts', 'pnpm-lock.yaml']);
  assert.deepEqual(unattributed, ['pnpm-lock.yaml']);
});

test('surfaces come back in deploy order, not match order', () => {
  // web before server before host matters: the SPA is a live bind mount, so
  // publishing it after the server restart serves a new UI against the old one.
  const { surfaces } = scope([
    'packages/daemon/src/index.ts',
    'packages/web/src/main.tsx',
    'packages/server/src/app.ts',
  ]);
  assert.deepEqual(surfaces, ['web', 'server', 'daemon', 'daemon-mac', 'apply']);
  assert.deepEqual(
    surfaces,
    ALL_SURFACES.filter((s) => surfaces.includes(s)),
    'must be a subsequence of ALL_SURFACES',
  );
});

test('a longer prefix wins over a shorter one', () => {
  // packages/web/e2e must not fall through to something broader.
  assert.deepEqual(scope(['packages/web/e2e/job-model.spec.ts']).surfaces, ['web']);
});

test('an empty diff attributes nothing and needs nothing', () => {
  assert.deepEqual(scope([]), { surfaces: [], unattributed: [] });
});

test('every surface belongs to exactly one lane', () => {
  const placed = Object.values(LANES).flat();
  assert.deepEqual(
    [...placed].sort(),
    [...ALL_SURFACES].sort(),
    'a surface in no lane never ships; a surface in two ships twice',
  );
  assert.equal(new Set(placed).size, placed.length);
});

test('the real couplings stay in one lane, in order', () => {
  // web must be able to rsync its bundle before the server restarts to serve it.
  assert.deepEqual(LANES.box, ['web', 'server']);
  // apply restarts the host at the version host just published, and
  // daemon-mac adds its build to that same manifest. It sits in the host lane,
  // which runs last, so it never races the mac lane for the Mac's build tree.
  assert.deepEqual(LANES.daemon, ['daemon', 'daemon-mac', 'apply']);
  // Both ssh the same Mac and each checks out a build tree there.
  assert.deepEqual(LANES.mac, ['desktop', 'smoke']);
});

test('lanes carry only the surfaces asked for, and empty lanes are dropped', () => {
  assert.deepEqual(lanesFor(['web', 'server', 'daemon', 'apply']), [
    ['box', ['web', 'server']],
    ['daemon', ['daemon', 'apply']],
  ]);
  assert.deepEqual(lanesFor(['ota']), [['mobile', ['ota']]]);
  assert.deepEqual(lanesFor([]), []);
});

test('a full deploy fans out to four lanes', () => {
  assert.equal(lanesFor(ALL_SURFACES).length, 4);
});

test('a lane child is told the APK builder the caller asked for — a full deploy honours --apk-local', () => {
  // The bug: `pnpm run deploy --apk-local` fanned out into lanes started with
  // only --only/--foreground/--prepared, so the mobile lane never saw the flag
  // and queued an EAS build (2026-09-25).
  const argv = ['--apk-local'];
  for (const [, surfaces] of lanesFor(ALL_SURFACES)) {
    const args = laneArgs(surfaces, argv);
    assert.ok(args.includes('--apk-local'), `lane ${surfaces} lost --apk-local`);
    assert.ok(args.includes('--prepared'));
    assert.ok(args.includes('--foreground'));
  }
  assert.deepEqual(laneArgs(['ota', 'apk'], ['--apk-here', '--foreground']), [
    '--only=ota,apk',
    '--foreground',
    '--prepared',
    '--apk-here',
  ]);
});

test('a lane child gets no flag the caller did not give, and nothing but the lane flags', () => {
  assert.deepEqual(laneArgs(['ota', 'apk'], []), ['--only=ota,apk', '--foreground', '--prepared']);
  assert.deepEqual(laneArgs(['web'], ['--only=web', '--foreground', '--weird']), [
    '--only=web',
    '--foreground',
    '--prepared',
  ]);
});

test('ship.mjs starts its lane children with laneArgs, not a hand-built argv', async () => {
  // laneArgs being right is no use if the spawn does not call it.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./ship.mjs', import.meta.url), 'utf8');
  assert.match(src, /`\$\{BUILD\}\/scripts\/ship\.mjs`, \.\.\.laneArgs\(surfaces, argv\)/);
  assert.doesNotMatch(src, /'--prepared',\s*\]/);
});

test('lockstep: shipping the server also publishes and applies the host', () => {
  assert.deepEqual(withLockstep(['server']), ['server', 'daemon', 'daemon-mac', 'apply']);
});

test('lockstep: shipping the host also ships the server', () => {
  assert.deepEqual(withLockstep(['daemon', 'daemon-mac', 'apply']), [
    'server',
    'daemon',
    'daemon-mac',
    'apply',
  ]);
});

test('lockstep: a wire diff ships server and host together, in canonical order', () => {
  const { surfaces } = scope(['packages/wire/src/events.ts']);
  assert.deepEqual(withLockstep(surfaces), surfaces);
  assert.ok(['server', 'daemon', 'daemon-mac', 'apply'].every((s) => surfaces.includes(s)));
});

test('lockstep: a diff touching neither leaves the scope alone', () => {
  assert.deepEqual(withLockstep(['web']), ['web']);
  assert.deepEqual(withLockstep(['ota', 'apk', 'smoke']), ['ota', 'apk', 'smoke']);
  assert.deepEqual(withLockstep([]), []);
});
