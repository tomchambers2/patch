// Whether an OTA can reach the phone at all (spec/11 § Mobile OTA).
//
// A phone was found running JS three days older than the APK it was carrying.
// expo-updates asks EAS with three headers and EAS requires all three; the
// locally-built APK sends no `expo-channel-name`, so every request was refused
// and the phone kept its embedded bundle — while `pnpm ship ota` published
// happily and reported success.
//
// The check that was supposed to catch this looked for both values in the
// AndroidManifest with a regex that could not match either: the runtime is a
// `@string/…` reference into strings.xml, and the channel is not in the
// manifest at all when a local gradle build made the APK. It then "verified"
// delivery by sending a channel header the APK never sends — proving something
// no phone would ever do — and it ran AFTER publishing.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apkUpdateIdentity } from '../../../scripts/apk-update-identity.mjs';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patch-apk-id-'));
  mkdirSync(join(dir, 'app/src/main/res/values'), { recursive: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeManifest(body: string): void {
  writeFileSync(join(dir, 'app/src/main/AndroidManifest.xml'), `<manifest>${body}</manifest>`);
}
function writeStrings(body: string): void {
  writeFileSync(join(dir, 'app/src/main/res/values/strings.xml'), `<resources>${body}</resources>`);
}

const URL_META =
  '<meta-data android:name="expo.modules.updates.EXPO_UPDATE_URL" android:value="https://u.expo.dev/p1"/>';

describe('what an installed APK asks EAS for', () => {
  it('follows a @string reference for the runtime version', () => {
    // The value that mattered was never in the manifest — this is the read that
    // silently returned undefined and made the whole check throw.
    writeManifest(
      `<meta-data android:name="expo.modules.updates.EXPO_RUNTIME_VERSION" android:value="@string/expo_runtime_version"/>
       <meta-data android:name="expo.modules.updates.EXPO_UPDATES_REQUEST_HEADERS" android:value="{&quot;expo-channel-name&quot;:&quot;preview&quot;}"/>
       ${URL_META}`,
    );
    writeStrings('<string name="expo_runtime_version">0.1.0</string>');

    const id = apkUpdateIdentity(dir);
    expect(id).toMatchObject({ deliverable: true, runtime: '0.1.0', channel: 'preview' });
  });

  it('reads a literal runtime version too', () => {
    writeManifest(
      `<meta-data android:name="expo.modules.updates.EXPO_RUNTIME_VERSION" android:value="1.2.3"/>
       <meta-data android:name="expo.modules.updates.EXPO_UPDATES_REQUEST_HEADERS" android:value="{&quot;expo-channel-name&quot;:&quot;production&quot;}"/>
       ${URL_META}`,
    );
    expect(apkUpdateIdentity(dir)).toMatchObject({ runtime: '1.2.3', channel: 'production' });
  });

  it('says an APK with NO channel cannot receive updates, and why', () => {
    // Exactly what `gradlew assembleRelease` produces. EAS refuses every
    // request from it, so publishing an OTA for this APK is a no-op that
    // LOOKS like a delivery.
    writeManifest(
      `<meta-data android:name="expo.modules.updates.EXPO_RUNTIME_VERSION" android:value="@string/expo_runtime_version"/>
       ${URL_META}`,
    );
    writeStrings('<string name="expo_runtime_version">0.1.0</string>');

    const id = apkUpdateIdentity(dir);
    expect(id.deliverable).toBe(false);
    expect(id.why).toMatch(/channel/);
    expect(id.why).toMatch(/eas build/);
    // It still reports what it DID find, so the message can be specific.
    expect(id.runtime).toBe('0.1.0');
  });

  it('says so when there is no update URL', () => {
    writeManifest(
      '<meta-data android:name="expo.modules.updates.EXPO_RUNTIME_VERSION" android:value="0.1.0"/>',
    );
    expect(apkUpdateIdentity(dir).why).toMatch(/update URL/);
  });

  it('does not throw when the project is not there', () => {
    const id = apkUpdateIdentity(join(dir, 'nope'));
    expect(id.deliverable).toBe(false);
    expect(id.why).toMatch(/AndroidManifest/);
  });

  it('reports the real project as it stands', () => {
    // Not a fixture: the committed Android project. If this ever becomes
    // deliverable (an `eas build` APK), the ship path can start trusting OTA.
    const real = apkUpdateIdentity(
      join(new URL('../../../apps/mobile/android', import.meta.url).pathname),
    );
    expect(typeof real.deliverable).toBe('boolean');
    if (!real.deliverable) expect(real.why).toMatch(/channel|runtime|URL|AndroidManifest/);
  });
});
