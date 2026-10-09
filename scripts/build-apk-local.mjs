#!/usr/bin/env node
// Build the release APK HERE, with gradle, instead of on EAS.
//
//   node scripts/build-apk-local.mjs --version <v> --sha <gitSha> --built-at <iso> [--box]
//
// Run by `pnpm run deploy --only=apk --apk-local` on the Mac, over ssh, inside a
// worktree pinned to the shipped commit (scripts/build-tree.mjs) — the same way
// the desktop and smoke lanes run there. Releases are built on the Mac, not the
// box: an uncapped React Native build takes the box, and
// everything it serves, off the network.
//
// `--apk-here` is the one exception, and only when asked: the deploy runs this
// same script on the box, in the pinned build tree, wrapped in `boxBuildCommand`
// below — a systemd scope with a memory and CPU ceiling, at nice 19 / idle IO,
// with gradle held to a 3g heap and two workers (the caps bin/publish uses on
// Hetzner). `--box` makes gradle run without a daemon, so the build cannot be
// handed to an already-running daemon OUTSIDE that scope, where no cap applies.
//
// Why it exists: EAS's free plan runs out of Android builds partway through a
// month, and a native change (a runtimeVersion bump) then has no way to reach a
// phone — the OTA is published under a runtime no installed APK asks for. The
// Android project is committed (bare workflow), so a plain `assembleRelease`
// builds exactly what EAS would, for free.
//
// What it has to get right, each of which has bitten before:
//
//   * the SAME release key as every APK already installed, or Android refuses
//     the update. It comes from ~/.patch-mobile-credentials, outside the repo.
//   * the EXPO_PUBLIC_* stamps, or the JS reports itself as `dev`. The tree is
//     cleaned per build (build-tree.mjs), so gradle cannot reuse a stale bundle.
//   * the workspace libs' dist, which Metro resolves @patch/wire through and a
//     fresh worktree does not have.
//
// Prints `##apk <absolute path>` as its last line; the box copies that file back
// and publishes it (ship.mjs publishApk). It publishes nothing itself.

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './lib/is-main.mjs';

export const APK_OUTPUT = 'apps/mobile/android/app/build/outputs/apk/release/app-release.apk';

/**
 * The keystore's passwords and alias out of credentials.json (EAS's format —
 * the same file `eas build` signs with). Throws on anything missing: a release
 * build that silently falls back to the gradle defaults is signed with whatever
 * those happen to be.
 */
export function signingFromCredentials(json) {
  const ks = json?.android?.keystore;
  const missing = ['keystorePassword', 'keyAlias', 'keyPassword'].filter((k) => !ks?.[k]);
  if (missing.length > 0) {
    throw new Error(`credentials.json has no android.keystore.${missing.join(', ')}`);
  }
  return { storePassword: ks.keystorePassword, keyAlias: ks.keyAlias, keyPassword: ks.keyPassword };
}

/**
 * The environment gradle runs with.
 *
 * Signing goes in as ORG_GRADLE_PROJECT_* — gradle reads those as `-P`
 * properties, which android/app/build.gradle's release signingConfig looks up,
 * and unlike `-P` on the command line they are not in `ps` for the whole build.
 */
export function gradleEnv({ base, info, signing, home, platform }) {
  const mac = platform === 'darwin';
  const androidHome =
    base.ANDROID_HOME ?? (mac ? `${home}/Library/Android/sdk` : `${home}/Android/sdk`);
  return {
    ...base,
    JAVA_HOME:
      base.JAVA_HOME ??
      (mac ? '/opt/homebrew/opt/openjdk@17' : '/usr/lib/jvm/java-17-openjdk-amd64'),
    ANDROID_HOME: androidHome,
    ANDROID_SDK_ROOT: androidHome,
    NODE_ENV: 'production',
    EXPO_PUBLIC_PATCH_VERSION: info.version,
    EXPO_PUBLIC_PATCH_GIT_SHA: info.gitSha,
    EXPO_PUBLIC_PATCH_BUILT_AT: info.builtAt,
    ORG_GRADLE_PROJECT_PATCH_RELEASE_STORE_PASSWORD: signing.storePassword,
    ORG_GRADLE_PROJECT_PATCH_RELEASE_KEY_ALIAS: signing.keyAlias,
    ORG_GRADLE_PROJECT_PATCH_RELEASE_KEY_PASSWORD: signing.keyPassword,
  };
}

/**
 * The ceiling a box build (`--apk-here`) runs under. Patch, the bridges and the
 * APK downloads all serve from that box; an uncapped React Native build took all
 * of them off the network for half an hour on 21 Sep 2026.
 */
export const BOX_CAPS = {
  memoryMax: '5G',
  cpuQuota: '300%',
  // Same as bin/publish's GRADLE_LIMITS. No spaces inside one -D: GRADLE_OPTS is
  // split on them.
  gradleOpts: '-Dorg.gradle.jvmargs=-Xmx3g -Dorg.gradle.workers.max=2 -Dorg.gradle.parallel=false',
};

/**
 * The command that runs THIS script on the box, capped. The whole script goes in
 * the scope — the workspace-lib build and Metro as well as gradle — so nothing
 * the build spawns escapes the ceiling.
 *
 * `{ cmd, args, env }`; `env` is merged over the caller's environment. The
 * scope is named so the caller can stop it afterwards, taking with it anything
 * the build left running (a Kotlin daemon idles for hours otherwise).
 */
export function boxBuildCommand({ node, script, info, unit, baseGradleOpts }) {
  return {
    cmd: 'systemd-run',
    args: [
      '--user',
      '--scope',
      '--quiet',
      `--unit=${unit}`,
      '-p',
      `MemoryMax=${BOX_CAPS.memoryMax}`,
      '-p',
      `CPUQuota=${BOX_CAPS.cpuQuota}`,
      'nice',
      '-n',
      '19',
      'ionice',
      '-c3',
      node,
      script,
      '--version',
      info.version,
      '--sha',
      info.gitSha,
      '--built-at',
      info.builtAt,
      '--box',
    ],
    env: { GRADLE_OPTS: [baseGradleOpts, BOX_CAPS.gradleOpts].filter(Boolean).join(' ') },
  };
}

/**
 * gradle's argv. On the box (`box`), no daemon — a client happily hands its
 * build to any compatible idle daemon, including one started outside the capped
 * scope — and Kotlin compiles inside that single-use daemon for the same reason.
 * On the Mac a warm daemon is the point.
 */
export function gradleArgs({ box }) {
  const args = ['assembleRelease', '--console=plain'];
  if (!box) return [...args, '-q'];
  return [...args, '--no-daemon', '-Pkotlin.compiler.execution.strategy=in-process'];
}

/** `--name value` pairs; every one of version, sha and built-at is required. */
export function parseArgs(argv) {
  const get = (n) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const info = { version: get('version'), gitSha: get('sha'), builtAt: get('built-at') };
  const missing = Object.entries({
    version: info.version,
    sha: info.gitSha,
    'built-at': info.builtAt,
  })
    .filter(([, v]) => !v || v.startsWith('--'))
    .map(([k]) => `--${k}`);
  if (missing.length > 0) throw new Error(`build-apk-local: missing ${missing.join(', ')}`);
  return info;
}

function build(info, { box }) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const home = process.env.HOME;
  const creds = `${home}/.patch-mobile-credentials`;
  for (const f of ['patch-upload.keystore', 'credentials.json']) {
    if (!existsSync(`${creds}/${f}`)) {
      throw new Error(
        `no ${creds}/${f} — the release key lives outside the repo. Copy it from the box ` +
          `(same key the live APK is signed with):\n  scp -p hetzner:.patch-mobile-credentials/* ${creds}/`,
      );
    }
  }
  const signing = signingFromCredentials(
    JSON.parse(readFileSync(`${creds}/credentials.json`, 'utf8')),
  );
  // build.gradle reads the keystore from apps/mobile/credentials/ (gitignored).
  mkdirSync(`${repo}/apps/mobile/credentials`, { recursive: true });
  copyFileSync(
    `${creds}/patch-upload.keystore`,
    `${repo}/apps/mobile/credentials/patch-upload.keystore`,
  );

  const run = (cmd, args, opts = {}) =>
    execFileSync(cmd, args, { stdio: 'inherit', cwd: repo, ...opts });
  // @patch/relay too: the app's relay transport imports it, and a clean checkout
  // has no dist for Metro to resolve (a machine that had built it once never saw this).
  console.log('==> rebuilding @patch/wire + @patch/auth + @patch/relay (Metro bundles their dist)');
  run('corepack', [
    'pnpm',
    '--filter',
    '@patch/wire',
    '--filter',
    '@patch/auth',
    '--filter',
    '@patch/relay',
    'build',
  ]);

  const env = gradleEnv({ base: process.env, info, signing, home, platform: process.platform });
  if (!existsSync(`${env.JAVA_HOME}/bin/java`)) throw new Error(`no JDK at ${env.JAVA_HOME}`);
  if (!existsSync(`${env.ANDROID_HOME}/platform-tools`))
    throw new Error(`no Android SDK at ${env.ANDROID_HOME}`);
  console.log(`==> gradle assembleRelease (${info.version} / ${info.gitSha})`);
  if (box && !String(env.GRADLE_OPTS ?? '').includes(BOX_CAPS.gradleOpts)) {
    throw new Error(
      '--box without the gradle caps in GRADLE_OPTS — run it through boxBuildCommand',
    );
  }
  try {
    run('./gradlew', gradleArgs({ box }), {
      cwd: `${repo}/apps/mobile/android`,
      env,
    });
  } finally {
    // The Mac's build runs in a gradle daemon (that is the point of a warm
    // one), and it and the Kotlin daemon it starts idle for hours holding
    // gigabytes after the deploy is over. Stop it: the Kotlin daemon exits on
    // its own once no gradle client is left. The box build has no daemon
    // (--no-daemon, inside a scope the deploy stops), so nothing to do there.
    if (!box) {
      try {
        run('./gradlew', ['--stop', '-q'], { cwd: `${repo}/apps/mobile/android`, env });
      } catch (err) {
        console.error(`build-apk-local: could not stop the gradle daemon (${err.message})`);
      }
    }
  }
  const apk = `${repo}/${APK_OUTPUT}`;
  if (!existsSync(apk)) throw new Error(`gradle finished but there is no ${apk}`);
  console.log(`##apk ${apk}`);
}

if (isMain(import.meta.url)) {
  try {
    const argv = process.argv.slice(2);
    build(parseArgs(argv), { box: argv.includes('--box') });
  } catch (err) {
    console.error(`build-apk-local FAILED: ${err.message}`);
    process.exit(1);
  }
}
