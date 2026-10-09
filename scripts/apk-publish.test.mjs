// What publishing an APK decides (scripts/apk-publish.mjs) and how the Mac
// builds one (scripts/build-apk-local.mjs).
//
// Each of these is a way a published APK silently never reaches the phone: an
// overwritten filename, a different signing key, a quota refusal read as
// something else, a local build recorded so the next deploy queues it again.
//
// Run: node scripts/apk-publish.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  apkBadging,
  apkBuildDecision,
  apkBuilder,
  apkFileName,
  builtApkPath,
  easQuotaExhausted,
  signerCheck,
  signerDigests,
} from './apk-publish.mjs';
import {
  BOX_CAPS,
  boxBuildCommand,
  gradleArgs,
  gradleEnv,
  parseArgs,
  signingFromCredentials,
} from './build-apk-local.mjs';

const KEY_A = '06000dae69216a1963fcd00eac9194b3ad838f88ef918bf7f3dac34f6fac2161';
const KEY_B = 'b'.repeat(64);
const certs = (digest) =>
  `Signer #1 certificate DN: CN=Patch, OU=Personal\n` +
  `Signer #1 certificate SHA-256 digest: ${digest}\n` +
  `Signer #1 certificate SHA-1 digest: ${'1'.repeat(40)}\n`;

test('an APK is named after its commit, and never reuses a published name', () => {
  assert.equal(
    apkFileName('01595b6b', () => false),
    'patch-01595b6.apk',
  );
  const taken = new Set(['patch-01595b6.apk', 'patch-01595b6-2.apk']);
  assert.equal(
    apkFileName('01595b6b', (n) => taken.has(n)),
    'patch-01595b6-3.apk',
  );
});

test('an APK name refuses anything that is not a sha', () => {
  assert.throws(() => apkFileName('', () => false), /not a commit sha/);
  assert.throws(() => apkFileName('v0.1.2', () => false), /not a commit sha/);
});

test('signer digests are read from every scheme apksigner prints', () => {
  const out = `V2 Signer: certificate SHA-256 digest: ${KEY_A}\nV3 Signer: certificate SHA-256 digest: ${KEY_A.toUpperCase()}\n`;
  assert.deepEqual([...signerDigests(out)], [KEY_A]);
});

test('an APK signed with the live key passes', () => {
  const res = signerCheck({ candidate: certs(KEY_A), live: certs(KEY_A) });
  assert.equal(res.ok, true);
});

test('an APK signed with a different key is refused — the phone would reject it', () => {
  const res = signerCheck({ candidate: certs(KEY_B), live: certs(KEY_A) });
  assert.equal(res.ok, false);
  assert.match(res.why, /different key/);
});

test('an unsigned APK, or an unreadable live one, is refused rather than waved through', () => {
  assert.equal(signerCheck({ candidate: 'nothing here', live: certs(KEY_A) }).ok, false);
  assert.equal(signerCheck({ candidate: certs(KEY_A), live: 'garbage' }).ok, false);
});

test('the very first APK has nothing to match, and says so', () => {
  const res = signerCheck({ candidate: certs(KEY_A), live: null });
  assert.equal(res.ok, true);
  assert.match(res.why, /no live APK/);
});

test('version and package come out of the APK itself', () => {
  const out =
    "package: name='io.github.tomchambers2.patch' versionCode='1' versionName='0.1.2' platformBuildVersionName='15'\nsdkVersion:'24'\n";
  assert.deepEqual(apkBadging(out), {
    packageName: 'io.github.tomchambers2.patch',
    versionName: '0.1.2',
    versionCode: 1,
  });
  assert.throws(() => apkBadging('not an apk'), /no package line/);
});

test('the EAS free-plan refusal is recognised, and nothing else is', () => {
  const said =
    'This account has used its Android builds from the Free plan this month, which will reset in 6 days (on Thu Oct 01 2026).';
  assert.equal(easQuotaExhausted(said), true);
  assert.equal(easQuotaExhausted('Build failed: Gradle task assembleRelease failed'), false);
  assert.equal(easQuotaExhausted(undefined), false);
});

test('a changed native fingerprint needs a build', () => {
  const d = apkBuildDecision({
    recorded: { fingerprint: 'aaaa', buildId: 'x' },
    current: 'bbbb',
    statusOf: () => assert.fail('no need to ask EAS'),
  });
  assert.equal(d.build, true);
  assert.match(d.why, /native changed/);
  assert.equal(
    apkBuildDecision({ recorded: null, current: 'bbbb', statusOf: () => null }).build,
    true,
  );
});

test('a Mac build of this fingerprint is done — and EAS is never asked about it', () => {
  // A local build is not on EAS; looking it up would read as UNKNOWN, which is
  // "still in flight", which is how a deploy stops building forever.
  const d = apkBuildDecision({
    recorded: { fingerprint: 'bbbb', local: true, file: 'patch-01595b6.apk' },
    current: 'bbbb',
    statusOf: () => assert.fail('a local build must not be looked up on EAS'),
  });
  assert.equal(d.build, false);
  assert.match(d.why, /built on the Mac.*patch-01595b6\.apk/);
});

test('a queued cloud build of this fingerprint is not duplicated; a dead one is replaced', () => {
  const recorded = { fingerprint: 'bbbb', buildId: 'abcdef12-0000' };
  assert.equal(
    apkBuildDecision({ recorded, current: 'bbbb', statusOf: () => 'IN_QUEUE' }).build,
    false,
  );
  assert.equal(
    apkBuildDecision({ recorded, current: 'bbbb', statusOf: () => 'FINISHED' }).build,
    false,
  );
  assert.equal(
    apkBuildDecision({ recorded, current: 'bbbb', statusOf: () => 'ERRORED' }).build,
    true,
  );
  assert.equal(
    apkBuildDecision({ recorded, current: 'bbbb', statusOf: () => 'CANCELED' }).build,
    true,
  );
});

test('the path the Mac build printed is its last ##apk line', () => {
  const out = 'noise\n##apk /tmp/old.apk\nmore\n##apk /Users/t/tree/app-release.apk\n';
  assert.equal(builtApkPath(out), '/Users/t/tree/app-release.apk');
  assert.throws(() => builtApkPath('BUILD SUCCESSFUL'), /no ##apk line/);
});

test('signing comes from credentials.json, and a missing field is an error', () => {
  const json = {
    android: {
      keystore: { keystorePath: 'k', keystorePassword: 's', keyAlias: 'patch', keyPassword: 'p' },
    },
  };
  assert.deepEqual(signingFromCredentials(json), {
    storePassword: 's',
    keyAlias: 'patch',
    keyPassword: 'p',
  });
  assert.throws(
    () => signingFromCredentials({ android: { keystore: { keystorePassword: 's' } } }),
    /keyAlias, keyPassword/,
  );
});

test('the gradle build is stamped and signed through the environment, not argv', () => {
  const env = gradleEnv({
    base: { PATH: '/bin' },
    info: { version: '0.1.1090', gitSha: 'deadbeef', builtAt: '2026-09-24T12:00:00Z' },
    signing: { storePassword: 's', keyAlias: 'patch', keyPassword: 'p' },
    home: '/Users/t',
    platform: 'darwin',
  });
  assert.equal(env.EXPO_PUBLIC_PATCH_VERSION, '0.1.1090');
  assert.equal(env.EXPO_PUBLIC_PATCH_GIT_SHA, 'deadbeef');
  assert.equal(env.EXPO_PUBLIC_PATCH_SERVER_URL, undefined, 'no server address is built into the app');
  assert.equal(env.ORG_GRADLE_PROJECT_PATCH_RELEASE_STORE_PASSWORD, 's');
  assert.equal(env.ORG_GRADLE_PROJECT_PATCH_RELEASE_KEY_PASSWORD, 'p');
  assert.equal(env.ORG_GRADLE_PROJECT_PATCH_RELEASE_KEY_ALIAS, 'patch');
  assert.equal(env.JAVA_HOME, '/opt/homebrew/opt/openjdk@17');
  assert.equal(env.ANDROID_HOME, '/Users/t/Library/Android/sdk');
  assert.equal(env.PATH, '/bin');
});

test('the Mac build refuses to run without its stamps', () => {
  assert.deepEqual(parseArgs(['--version', '1', '--sha', 'abc', '--built-at', 'now']), {
    version: '1',
    gitSha: 'abc',
    builtAt: 'now',
  });
  assert.throws(() => parseArgs(['--version', '1']), /--sha, --built-at/);
});

test('a box build of this fingerprint is done too, and says where it was built', () => {
  const d = apkBuildDecision({
    recorded: { fingerprint: 'bbbb', local: true, builtOn: 'box', file: 'patch-e6e6d0f.apk' },
    current: 'bbbb',
    statusOf: () => assert.fail('a local build must not be looked up on EAS'),
  });
  assert.equal(d.build, false);
  assert.match(d.why, /built on this box.*patch-e6e6d0f\.apk/);
});

test('the APK is built where the flags say, and nowhere else', () => {
  assert.equal(apkBuilder([]), 'eas');
  assert.equal(apkBuilder(['--only=ota,apk', '--apk-local']), 'mac');
  assert.equal(apkBuilder(['--only=ota,apk', '--apk-here']), 'box');
  assert.throws(() => apkBuilder(['--apk-local', '--apk-here']), /both given/);
});

test('a box build runs capped: scope ceiling, nice/idle IO, gradle heap and workers', () => {
  const info = { version: '0.1.1100', gitSha: 'e6e6d0f2', builtAt: '2026-09-25T07:00:00Z' };
  const { cmd, args, env } = boxBuildCommand({
    node: '/usr/bin/node',
    script: '/tree/scripts/build-apk-local.mjs',
    info,
    unit: 'patch-apk-build-e6e6d0f-1',
    baseGradleOpts: '-Dfoo=bar',
  });
  assert.equal(cmd, 'systemd-run');
  const at = (x) => args.indexOf(x);
  assert.deepEqual(args.slice(0, 3), ['--user', '--scope', '--quiet']);
  assert.ok(args.includes('--unit=patch-apk-build-e6e6d0f-1'));
  assert.equal(args[at('MemoryMax=5G') - 1], '-p');
  assert.equal(args[at('CPUQuota=300%') - 1], '-p');
  // nice and ionice wrap node, and everything before them is systemd-run's.
  assert.deepEqual(args.slice(at('nice'), at('nice') + 5), ['nice', '-n', '19', 'ionice', '-c3']);
  assert.equal(args[at('ionice') + 2], '/usr/bin/node');
  assert.ok(at('CPUQuota=300%') < at('nice'));
  // Same stamps as the Mac build, and --box so gradle runs daemonless.
  assert.deepEqual(args.slice(at('/tree/scripts/build-apk-local.mjs') + 1), [
    '--version',
    '0.1.1100',
    '--sha',
    'e6e6d0f2',
    '--built-at',
    '2026-09-25T07:00:00Z',
    '--box',
  ]);
  assert.equal(
    env.GRADLE_OPTS,
    '-Dfoo=bar -Dorg.gradle.jvmargs=-Xmx3g -Dorg.gradle.workers.max=2 -Dorg.gradle.parallel=false',
  );
  assert.equal(
    boxBuildCommand({ node: 'n', script: 's', info, unit: 'u' }).env.GRADLE_OPTS,
    BOX_CAPS.gradleOpts,
  );
});

test('gradle on the box never hands the build to a daemon outside the capped scope', () => {
  const box = gradleArgs({ box: true });
  assert.equal(box[0], 'assembleRelease');
  assert.ok(box.includes('--no-daemon'));
  assert.ok(box.includes('-Pkotlin.compiler.execution.strategy=in-process'));
  const mac = gradleArgs({ box: false });
  assert.ok(!mac.includes('--no-daemon'));
  assert.deepEqual(mac, ['assembleRelease', '--console=plain', '-q']);
});

test('the box build runs the same stamping as the Mac build', () => {
  const env = gradleEnv({
    base: { PATH: '/bin', GRADLE_OPTS: BOX_CAPS.gradleOpts },
    info: { version: '0.1.1100', gitSha: 'e6e6d0f2', builtAt: 'now' },
    signing: { storePassword: 's', keyAlias: 'patch', keyPassword: 'p' },
    home: '/home/claude-dev',
    platform: 'linux',
  });
  assert.equal(env.ANDROID_HOME, '/home/claude-dev/Android/sdk');
  assert.equal(env.JAVA_HOME, '/usr/lib/jvm/java-17-openjdk-amd64');
  assert.equal(env.EXPO_PUBLIC_PATCH_GIT_SHA, 'e6e6d0f2');
  assert.equal(env.GRADLE_OPTS, BOX_CAPS.gradleOpts);
});
