#!/usr/bin/env node
// What an installed APK actually asks EAS for — and therefore whether an OTA
// can ever reach it.
//
//   node scripts/apk-update-identity.mjs [androidDir]
//
// expo-updates sends three things: `expo-runtime-version`, `expo-platform` and
// `expo-channel-name`. EAS REQUIRES all three; omit the channel and every
// request is refused, so the phone silently keeps whatever JS it already has.
//
// A local `gradlew assembleRelease` does not write a channel into the manifest
// (only `eas build` does), so an APK built that way can never take an update —
// and `pnpm ship ota` will happily publish one and report success while the
// phone ignores it for ever. That is exactly how a phone came to be running JS
// three days older than the APK it was carrying.
//
// The values live in two files, which is why reading only the manifest missed
// them: `EXPO_RUNTIME_VERSION` is usually a `@string/…` reference into
// `res/values/strings.xml`, and the channel is an HTML-entity-encoded JSON blob
// inside `EXPO_UPDATES_REQUEST_HEADERS`.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './lib/is-main.mjs';

const MANIFEST = 'app/src/main/AndroidManifest.xml';
const STRINGS = 'app/src/main/res/values/strings.xml';

/** Resolve `@string/name` against strings.xml; pass a literal straight through. */
function resolveStringRef(value, stringsXml) {
  const ref = /^@string\/(.+)$/.exec(value);
  if (!ref) return value;
  if (stringsXml === null) return undefined;
  const found = new RegExp(`<string name="${ref[1]}">([^<]*)</string>`).exec(stringsXml);
  return found?.[1];
}

/**
 * What this APK will request, read from the committed Android project.
 *
 * `channel` is `undefined` when the APK declares none — NOT an error here, but
 * the fact that decides whether an OTA is deliverable at all. `deliverable`
 * says so directly, with `why` naming what is missing.
 */
export function apkUpdateIdentity(androidDir) {
  const manifestPath = join(androidDir, MANIFEST);
  if (!existsSync(manifestPath)) {
    return { deliverable: false, why: `no AndroidManifest at ${manifestPath}` };
  }
  const manifest = readFileSync(manifestPath, 'utf8');
  const stringsPath = join(androidDir, STRINGS);
  const strings = existsSync(stringsPath) ? readFileSync(stringsPath, 'utf8') : null;

  const rawRuntime = /EXPO_RUNTIME_VERSION"\s+android:value="([^"]+)"/.exec(manifest)?.[1];
  const runtime = rawRuntime === undefined ? undefined : resolveStringRef(rawRuntime, strings);
  // …android:value="{&quot;expo-channel-name&quot;:&quot;preview&quot;}"
  const rawHeaders = /EXPO_UPDATES_REQUEST_HEADERS"\s+android:value="([^"]*)"/.exec(manifest)?.[1];
  const channel =
    /expo-channel-name&quot;:\s*&quot;([^&]+)&quot;/.exec(manifest)?.[1] ??
    (rawHeaders === undefined
      ? undefined
      : /"expo-channel-name":\s*"([^"]+)"/.exec(rawHeaders.replace(/&quot;/g, '"'))?.[1]);
  const url = /EXPO_UPDATE_URL"\s+android:value="([^"]+)"/.exec(manifest)?.[1];

  const missing = [];
  if (runtime === undefined) missing.push('runtime version');
  if (url === undefined) missing.push('update URL');
  if (channel === undefined) {
    missing.push(
      'channel (a local gradle build does not write one; only `eas build` does, so EAS refuses every update request from this APK)',
    );
  }
  return missing.length === 0
    ? { deliverable: true, runtime, channel, url }
    : {
        deliverable: false,
        why: `this APK cannot receive OTA updates — missing ${missing.join('; ')}`,
        ...(runtime !== undefined ? { runtime } : {}),
        ...(channel !== undefined ? { channel } : {}),
        ...(url !== undefined ? { url } : {}),
      };
}

if (isMain(import.meta.url)) {
  const dir = resolve(
    process.argv[2] ??
      join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'mobile', 'android'),
  );
  const id = apkUpdateIdentity(dir);
  if (id.deliverable) {
    process.stdout.write(`apk-update-identity: runtime ${id.runtime}, channel ${id.channel}\n`);
  } else {
    process.stdout.write(`apk-update-identity: NOT DELIVERABLE — ${id.why}\n`);
    process.exitCode = 1;
  }
}
