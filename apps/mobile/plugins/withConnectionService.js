// Expo config plugin: wire react-native-callkeep's Android ConnectionService
// into the prebuild. Per spec/15 ## Manager incoming-call UX:
//   - Phone shows the native incoming-call UI via Android ConnectionService.
//   - Foreground service starts; AUDIOFOCUS_GAIN requested.
//
// Also installs (per spec/15):
//   - The VoiceAudioService foreground service + its PatchVoiceAudioService
//     RN native module (## Native specifics — "Foreground service while voice
//     is active"; ## Mobile equivalent of the menu bar — persistent shade
//     notification). Without the module, src/lib/voiceAudioService.ts throws
//     "native module missing" at runtime and background voice silently dies.
//   - Android launcher long-press shortcuts: "Manager voice note", "New chat",
//     "Open Speakers" (## Mobile equivalent of the menu bar).
//
// Permissions are declared in app.config.ts. NO FALLBACK: if AndroidManifest
// is missing the relevant nodes we throw.
//
// Written as plain JS so Expo's plugin resolver can require it without a
// TypeScript loader.

const fs = require('fs');
const path = require('path');
const {
  withAndroidManifest,
  withDangerousMod,
  withMainApplication,
  withStringsXml,
  AndroidConfig,
} = require('expo/config-plugins');

const PKG = 'io.github.tomchambers2.patch';
const PKG_PATH = PKG.split('.').join('/');

// ---------------------------------------------------------------------------
// 1. Manifest services (ConnectionService + VoiceAudioService) + shortcuts
//    meta-data on the launcher activity.
// ---------------------------------------------------------------------------
const withManifestNodes = (config) =>
  withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application && cfg.modResults.manifest.application[0];
    if (!app) {
      throw new Error(
        'withConnectionService: AndroidManifest has no <application> node. ' +
          'Did expo prebuild run successfully first?',
      );
    }
    // Point the app at our loopback-only cleartext network security config so
    // a release build can reach a local http dev/self-hosted stack (the
    // res/xml file is written by withNativeFiles below).
    app.$['android:networkSecurityConfig'] = '@xml/network_security_config';

    // EAS requires a channel on every update request and returns HTTP 400
    // without one, so an APK built here with no channel can never receive an
    // OTA. `eas build` injects this meta-data automatically; a local
    // `gradlew assembleRelease` (how this repo actually builds, per the
    // mobile README) does not — so without codifying it here, a bare
    // `expo prebuild` silently wipes it and OTA breaks with no error, only a
    // client that quietly never updates. Keep in lockstep with eas.json's
    // preview profile channel.
    app['meta-data'] = app['meta-data'] || [];
    if (
      !app['meta-data'].some(
        (m) =>
          m.$ && m.$['android:name'] === 'expo.modules.updates.UPDATES_CONFIGURATION_REQUEST_HEADERS_KEY',
      )
    ) {
      app['meta-data'].push({
        $: {
          'android:name': 'expo.modules.updates.UPDATES_CONFIGURATION_REQUEST_HEADERS_KEY',
          'android:value': '{"expo-channel-name":"preview"}',
        },
      });
    }

    app.service = app.service || [];

    if (
      !app.service.some(
        (s) => s.$ && s.$['android:name'] === 'io.wazo.callkeep.VoiceConnectionService',
      )
    ) {
      app.service.push({
        $: {
          'android:name': 'io.wazo.callkeep.VoiceConnectionService',
          'android:label': 'Patch',
          'android:permission': 'android.permission.BIND_TELECOM_CONNECTION_SERVICE',
          'android:foregroundServiceType': 'phoneCall|microphone',
          'android:exported': 'true',
        },
        'intent-filter': [
          { action: [{ $: { 'android:name': 'android.telecom.ConnectionService' } }] },
        ],
      });
    }

    if (!app.service.some((s) => s.$ && s.$['android:name'] === `${PKG}.VoiceAudioService`)) {
      app.service.push({
        $: {
          'android:name': `${PKG}.VoiceAudioService`,
          'android:foregroundServiceType': 'microphone',
          'android:exported': 'false',
        },
      });
    }

    // Launcher shortcuts meta-data on the MAIN/LAUNCHER activity.
    const mainActivity = AndroidConfig.Manifest.getMainActivityOrThrow(cfg.modResults);
    mainActivity['meta-data'] = mainActivity['meta-data'] || [];
    if (
      !mainActivity['meta-data'].some(
        (m) => m.$ && m.$['android:name'] === 'android.app.shortcuts',
      )
    ) {
      mainActivity['meta-data'].push({
        $: { 'android:name': 'android.app.shortcuts', 'android:resource': '@xml/shortcuts' },
      });
    }

    return cfg;
  });

// ---------------------------------------------------------------------------
// 2. Shortcut labels (strings.xml).
// ---------------------------------------------------------------------------
const withShortcutStrings = (config) =>
  withStringsXml(config, (cfg) => {
    const want = {
      shortcut_manager_voice_note: 'Manager voice note',
      shortcut_new_chat: 'New chat',
      shortcut_open_speakers: 'Open Speakers',
    };
    for (const [name, value] of Object.entries(want)) {
      cfg.modResults = AndroidConfig.Strings.setStringItem(
        [{ _: value, $: { name, translatable: 'false' } }],
        cfg.modResults,
      );
    }
    return cfg;
  });

// ---------------------------------------------------------------------------
// 3. Write res/xml/shortcuts.xml + the VoiceAudioService Kotlin sources.
// ---------------------------------------------------------------------------
// Network security config: Android 9+ blocks cleartext (http://) traffic by
// default in RELEASE builds (Expo only enables `usesCleartextTraffic` in the
// debug manifest). The production server is HTTPS (patch.tomchambers.dev), but
// a release APK pointed at a LOCAL dev/self-hosted stack reaches it over plain
// http on loopback (localhost / 10.0.2.2 emulator host bridge / 127.0.0.1).
// Without this the WS + REST calls silently fail and the app sits forever on
// "Reconnecting…". We permit cleartext ONLY to those loopback dev hosts and
// keep it disabled for every other domain — production HTTPS is unaffected.
const NETWORK_SECURITY_XML = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">localhost</domain>
    <domain includeSubdomains="false">127.0.0.1</domain>
    <domain includeSubdomains="false">10.0.2.2</domain>
  </domain-config>
</network-security-config>
`;

const SHORTCUTS_XML = `<?xml version="1.0" encoding="utf-8"?>
<shortcuts xmlns:android="http://schemas.android.com/apk/res/android">
  <shortcut android:shortcutId="manager_voice_note" android:enabled="true" android:shortcutShortLabel="@string/shortcut_manager_voice_note">
    <intent android:action="android.intent.action.VIEW" android:data="patch://voice-note?chat=thread_manager" android:targetClass="${PKG}.MainActivity" android:targetPackage="${PKG}" />
  </shortcut>
  <shortcut android:shortcutId="new_chat" android:enabled="true" android:shortcutShortLabel="@string/shortcut_new_chat">
    <intent android:action="android.intent.action.VIEW" android:data="patch://new-chat" android:targetClass="${PKG}.MainActivity" android:targetPackage="${PKG}" />
  </shortcut>
  <shortcut android:shortcutId="open_speakers" android:enabled="true" android:shortcutShortLabel="@string/shortcut_open_speakers">
    <intent android:action="android.intent.action.VIEW" android:data="patch://chats/thread_speakers" android:targetClass="${PKG}.MainActivity" android:targetPackage="${PKG}" />
  </shortcut>
</shortcuts>
`;

const VOICE_SERVICE_KT = fs.readFileSync(
  path.join(__dirname, 'native', 'VoiceAudioService.kt'),
  'utf8',
);
const VOICE_MODULE_KT = fs.readFileSync(
  path.join(__dirname, 'native', 'PatchVoiceAudioServiceModule.kt'),
  'utf8',
);
const VOICE_PACKAGE_KT = fs.readFileSync(
  path.join(__dirname, 'native', 'PatchVoiceAudioServicePackage.kt'),
  'utf8',
);
const VOICE_MIC_KT = fs.readFileSync(
  path.join(__dirname, 'native', 'PatchVoiceMicModule.kt'),
  'utf8',
);
const VOICE_TTS_KT = fs.readFileSync(
  path.join(__dirname, 'native', 'PatchVoiceTtsModule.kt'),
  'utf8',
);

const withNativeFiles = (config) =>
  withDangerousMod(config, [
    'android',
    (cfg) => {
      const root = cfg.modRequest.platformProjectRoot; // android/
      const xmlDir = path.join(root, 'app/src/main/res/xml');
      fs.mkdirSync(xmlDir, { recursive: true });
      fs.writeFileSync(path.join(xmlDir, 'shortcuts.xml'), SHORTCUTS_XML);
      fs.writeFileSync(
        path.join(xmlDir, 'network_security_config.xml'),
        NETWORK_SECURITY_XML,
      );

      const javaDir = path.join(root, 'app/src/main/java', PKG_PATH);
      fs.mkdirSync(javaDir, { recursive: true });
      fs.writeFileSync(path.join(javaDir, 'VoiceAudioService.kt'), VOICE_SERVICE_KT);
      fs.writeFileSync(
        path.join(javaDir, 'PatchVoiceAudioServiceModule.kt'),
        VOICE_MODULE_KT,
      );
      fs.writeFileSync(
        path.join(javaDir, 'PatchVoiceAudioServicePackage.kt'),
        VOICE_PACKAGE_KT,
      );
      fs.writeFileSync(path.join(javaDir, 'PatchVoiceMicModule.kt'), VOICE_MIC_KT);
      fs.writeFileSync(path.join(javaDir, 'PatchVoiceTtsModule.kt'), VOICE_TTS_KT);
      return cfg;
    },
  ]);

// ---------------------------------------------------------------------------
// 4. Register the package in MainApplication.kt.
// ---------------------------------------------------------------------------
const withPackageRegistration = (config) =>
  withMainApplication(config, (cfg) => {
    let src = cfg.modResults.contents;
    if (!src.includes('PatchVoiceAudioServicePackage()')) {
      src = src.replace(
        /val packages = PackageList\(this\)\.packages\n/,
        'val packages = PackageList(this).packages\n' +
          '            // Hand-rolled foreground-audio-service module (not autolinked) —\n' +
          '            // keeps the voice session alive while backgrounded (spec/15).\n' +
          '            packages.add(PatchVoiceAudioServicePackage())\n',
      );
      if (!src.includes('PatchVoiceAudioServicePackage()')) {
        throw new Error(
          'withConnectionService: could not register PatchVoiceAudioServicePackage in ' +
            'MainApplication.kt — the getPackages() anchor changed.',
        );
      }
      cfg.modResults.contents = src;
    }
    return cfg;
  });

module.exports = (config) =>
  withPackageRegistration(
    withNativeFiles(withShortcutStrings(withManifestNodes(config))),
  );
