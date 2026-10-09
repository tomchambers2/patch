#!/usr/bin/env node
// Prove an APK's JS bundle is the build it claims to be, BEFORE publishing it.
//
//   node scripts/verify-apk-bundle.mjs <apk> <version> <gitSha>
//
// `EXPO_PUBLIC_*` vars are inlined into the bundle by Metro at build time, so a
// correctly-built release carries its own version and sha as literals. A build
// run WITHOUT those vars produces a bundle that reports itself as `dev` — and
// Gradle does not treat environment variables as task inputs, so a stale
// bundle from an earlier env-less `assembleRelease` is reused as "up to date"
// and shipped under a commit it does not contain.
//
// That is not a theoretical failure: a phone showed `App: dev` while the box
// published a correctly-named APK for the current commit, and every fix in it
// was absent. Naming an APK after a commit is not evidence; this is.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isMain } from './lib/is-main.mjs';

const BUNDLE = 'assets/index.android.bundle';

/** Read the APK's JS bundle as text (unzip to stdout — no temp files). */
function bundleText(apkPath) {
  return execFileSync('unzip', ['-p', apkPath, BUNDLE], {
    encoding: 'latin1',
    maxBuffer: 256 * 1024 * 1024,
  });
}

/**
 * What the bundle says about itself, and whether that matches the build.
 * `reader` is injectable so this is testable without building an APK.
 */
export function verifyApkBundle(apkPath, expected, reader = bundleText) {
  if (!existsSync(apkPath)) return { ok: false, why: `no APK at ${apkPath}` };
  let text;
  try {
    text = reader(apkPath);
  } catch (err) {
    return { ok: false, why: `could not read ${BUNDLE} from the APK: ${err.message}` };
  }
  const missing = [];
  if (!text.includes(expected.version)) missing.push(`version ${expected.version}`);
  if (!text.includes(expected.gitSha)) missing.push(`gitSha ${expected.gitSha}`);
  if (missing.length > 0) {
    return {
      ok: false,
      why:
        `the APK's JS bundle does not contain ${missing.join(' or ')} — it was built without the ` +
        'EXPO_PUBLIC_* stamps, so it is a stale bundle Gradle reused (env vars are not task ' +
        'inputs). Force a rebuild of the JS: `cd apps/mobile/android && ./gradlew clean` or ' +
        'delete app/build/generated/assets, then ship again.',
    };
  }
  return { ok: true };
}

if (isMain(import.meta.url)) {
  const [apk, version, gitSha] = process.argv.slice(2);
  if (!apk || !version || !gitSha) {
    process.stderr.write('usage: verify-apk-bundle.mjs <apk> <version> <gitSha>\n');
    process.exit(2);
  }
  const res = verifyApkBundle(apk, { version, gitSha });
  if (!res.ok) {
    process.stderr.write(`verify-apk-bundle: ${res.why}\n`);
    process.exit(1);
  }
  process.stdout.write(`verify-apk-bundle: bundle carries ${version} / ${gitSha}\n`);
}
