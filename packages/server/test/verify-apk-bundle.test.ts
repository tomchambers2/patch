// An APK is only the build its NAME claims if its JS says so (spec/11 §
// Version reporting).
//
// Metro inlines `EXPO_PUBLIC_*` into the bundle, so a correct release carries
// its version and sha as literals. Build without them and the bundle reports
// itself as `dev` — and because Gradle does not treat environment variables as
// task inputs, a bundle from an earlier env-less `assembleRelease` is reused as
// "up to date" and published under a commit it does not contain.
//
// A phone showed `App: dev` while the box served a correctly-named APK for the
// current commit, with every fix in that commit absent from the running app.
// Naming an APK after a commit proves nothing; reading its bundle does.

import { describe, it, expect } from 'vitest';
import { verifyApkBundle } from '../../../scripts/verify-apk-bundle.mjs';

const APK = __filename; // any existing path — the reader is injected

describe('verifying a built APK against its commit', () => {
  it('accepts a bundle carrying the expected version and sha', () => {
    const reader = (): string => 'x=1;var V="0.1.411",S="5d63028";';
    expect(verifyApkBundle(APK, { version: '0.1.411', gitSha: '5d63028' }, reader)).toEqual({
      ok: true,
    });
  });

  it('rejects the env-less bundle that reports itself as dev', () => {
    const reader = (): string => 'var V=undefined;/* no stamps inlined */';
    const res = verifyApkBundle(APK, { version: '0.1.411', gitSha: '5d63028' }, reader);
    expect(res.ok).toBe(false);
    expect(res.why).toMatch(/version 0\.1\.411/);
    expect(res.why).toMatch(/EXPO_PUBLIC/);
    // The message has to say how to force the rebuild, or it just reads as flaky.
    expect(res.why).toMatch(/gradlew clean|generated\/assets/);
  });

  it('rejects a bundle stamped with a DIFFERENT commit', () => {
    // The stale-reuse case: right shape, wrong build.
    const reader = (): string => 'var V="0.1.407",S="c1b59bc";';
    const res = verifyApkBundle(APK, { version: '0.1.411', gitSha: '5d63028' }, reader);
    expect(res.ok).toBe(false);
    expect(res.why).toMatch(/0\.1\.411/);
  });

  it('says so when the APK is not there', () => {
    expect(verifyApkBundle('/no/such.apk', { version: '1', gitSha: 'a' }).why).toMatch(/no APK/);
  });

  it('says so when the bundle cannot be read', () => {
    const reader = (): string => {
      throw new Error('not a zip');
    };
    const res = verifyApkBundle(APK, { version: '1', gitSha: 'a' }, reader);
    expect(res.ok).toBe(false);
    expect(res.why).toMatch(/could not read/);
  });
});
