// Expo config plugin: puts Patch on the Android share sheet ("Share" menu of
// any other app — a browser tab, the gallery, a file manager, a note) so text,
// links, images and files — one or several — can be sent straight into a
// Patch chat, existing or new.
//
// Three things have to happen, none of which expo-linking gives you for free
// (it only resolves ACTION_VIEW intents carrying a data URI — see
// src/lib/deepLink.ts):
//   1. MainActivity declares ACTION_SEND + ACTION_SEND_MULTIPLE intent-filters
//      for any MIME type, so Android offers Patch in the share sheet at all.
//   2. A hand-rolled native module (PatchShareModule) reads the share off the
//      launching intent for a cold start, copying any shared files into the
//      app's cache.
//   3. MainActivity.onNewIntent re-delivers a share that arrives while Patch
//      is already running (its launchMode is singleTask, so a running Patch
//      is not restarted — it would otherwise just silently update its own
//      intent and tell JS nothing).
//
// Written as plain JS so Expo's plugin resolver can require it without a
// TypeScript loader (same convention as withConnectionService.js).

const fs = require('fs');
const path = require('path');
const {
  withAndroidManifest,
  withDangerousMod,
  withMainActivity,
  withMainApplication,
  AndroidConfig,
} = require('expo/config-plugins');

const PKG = 'io.github.tomchambers2.patch';
const PKG_PATH = PKG.split('.').join('/');

// ---------------------------------------------------------------------------
// 1. ACTION_SEND + ACTION_SEND_MULTIPLE intent-filters on the main activity.
// ---------------------------------------------------------------------------
// `*/*`, not `text/plain`: Patch takes text, images and any other file, one or
// several at a time (spec/15 § Share into Patch). The filters are REPLACED
// wholesale on every prebuild rather than "added if a SEND filter exists" — the
// committed manifest already carries the old text-only one, and a presence
// check would keep it forever.
const SHARE_ACTIONS = ['android.intent.action.SEND', 'android.intent.action.SEND_MULTIPLE'];

const isShareFilter = (f) =>
  Array.isArray(f.action) &&
  f.action.some((a) => a.$ && SHARE_ACTIONS.includes(a.$['android:name']));

const withShareManifest = (config) =>
  withAndroidManifest(config, (cfg) => {
    const mainActivity = AndroidConfig.Manifest.getMainActivityOrThrow(cfg.modResults);
    const filters = (mainActivity['intent-filter'] || []).filter((f) => !isShareFilter(f));
    for (const action of SHARE_ACTIONS) {
      filters.push({
        action: [{ $: { 'android:name': action } }],
        category: [{ $: { 'android:name': 'android.intent.category.DEFAULT' } }],
        data: [{ $: { 'android:mimeType': '*/*' } }],
      });
    }
    mainActivity['intent-filter'] = filters;
    return cfg;
  });

// ---------------------------------------------------------------------------
// 2. Write PatchShareModule.kt + PatchSharePackage.kt.
// ---------------------------------------------------------------------------
const SHARE_MODULE_KT = fs.readFileSync(
  path.join(__dirname, 'native', 'PatchShareModule.kt'),
  'utf8',
);
const SHARE_PACKAGE_KT = fs.readFileSync(
  path.join(__dirname, 'native', 'PatchSharePackage.kt'),
  'utf8',
);

const withNativeFiles = (config) =>
  withDangerousMod(config, [
    'android',
    (cfg) => {
      const javaDir = path.join(cfg.modRequest.platformProjectRoot, 'app/src/main/java', PKG_PATH);
      fs.mkdirSync(javaDir, { recursive: true });
      fs.writeFileSync(path.join(javaDir, 'PatchShareModule.kt'), SHARE_MODULE_KT);
      fs.writeFileSync(path.join(javaDir, 'PatchSharePackage.kt'), SHARE_PACKAGE_KT);
      return cfg;
    },
  ]);

// ---------------------------------------------------------------------------
// 3. Register PatchSharePackage in MainApplication.kt.
// ---------------------------------------------------------------------------
const withPackageRegistration = (config) =>
  withMainApplication(config, (cfg) => {
    let src = cfg.modResults.contents;
    if (!src.includes('PatchSharePackage()')) {
      src = src.replace(
        /val packages = PackageList\(this\)\.packages\n/,
        'val packages = PackageList(this).packages\n' +
          '            // Android share-sheet bridge (not autolinked) — see\n' +
          '            // plugins/withShareIntent.js.\n' +
          '            packages.add(PatchSharePackage())\n',
      );
      if (!src.includes('PatchSharePackage()')) {
        throw new Error(
          'withShareIntent: could not register PatchSharePackage in MainApplication.kt — ' +
            'the getPackages() anchor changed.',
        );
      }
      cfg.modResults.contents = src;
    }
    return cfg;
  });

// ---------------------------------------------------------------------------
// 4. MainActivity.onNewIntent — re-deliver a share to an already-running app.
// ---------------------------------------------------------------------------
const withShareActivity = (config) =>
  withMainActivity(config, (cfg) => {
    let src = cfg.modResults.contents;
    if (!src.includes('PatchShareModule.notifyNewIntent')) {
      if (!src.includes('import android.content.Intent')) {
        src = src.replace(
          'import android.os.Bundle',
          'import android.content.Intent\nimport android.os.Bundle',
        );
      }
      src = src.replace(
        'class MainActivity : ReactActivity() {',
        'class MainActivity : ReactActivity() {\n' +
          '  // Re-deliver a share-sheet intent arriving while Patch is already\n' +
          '  // running (launchMode singleTask means onCreate does not fire again) —\n' +
          '  // see plugins/withShareIntent.js / PatchShareModule.\n' +
          '  override fun onNewIntent(intent: Intent) {\n' +
          '    super.onNewIntent(intent)\n' +
          '    setIntent(intent)\n' +
          '    PatchShareModule.notifyNewIntent(intent)\n' +
          '  }\n\n',
      );
      if (!src.includes('PatchShareModule.notifyNewIntent')) {
        throw new Error(
          'withShareIntent: could not inject onNewIntent into MainActivity.kt — the class-' +
            'declaration anchor changed.',
        );
      }
      cfg.modResults.contents = src;
    }
    return cfg;
  });

module.exports = (config) =>
  withShareActivity(withPackageRegistration(withNativeFiles(withShareManifest(config))));
