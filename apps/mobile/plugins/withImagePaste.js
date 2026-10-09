// Expo config plugin: image paste into the composer (spec/15 § Composer —
// "Paste"). Long-press → Paste with an image on the clipboard, and a
// keyboard's image insertion (Gboard GIFs / stickers), both arrive through
// one androidx OnReceiveContentListener that PatchPasteModule installs on the
// composer's EditText (src/lib/nativePaste.ts asks for it by React tag).
//
// Nothing in the manifest changes; this only writes the module + package and
// registers the package (not autolinked), same pattern as withShareIntent.js.
// Written as plain JS so Expo's plugin resolver can require it without a
// TypeScript loader.

const fs = require('fs');
const path = require('path');
const { withDangerousMod, withMainApplication } = require('expo/config-plugins');

const PKG_PATH = 'io/github/tomchambers2/patch';
const FILES = ['PatchPasteModule.kt', 'PatchPastePackage.kt'];

const withNativeFiles = (config) =>
  withDangerousMod(config, [
    'android',
    (cfg) => {
      const javaDir = path.join(cfg.modRequest.platformProjectRoot, 'app/src/main/java', PKG_PATH);
      fs.mkdirSync(javaDir, { recursive: true });
      for (const f of FILES) {
        fs.writeFileSync(path.join(javaDir, f), fs.readFileSync(path.join(__dirname, 'native', f)));
      }
      return cfg;
    },
  ]);

const withPackageRegistration = (config) =>
  withMainApplication(config, (cfg) => {
    let src = cfg.modResults.contents;
    if (!src.includes('PatchPastePackage()')) {
      src = src.replace(
        /val packages = PackageList\(this\)\.packages\n/,
        'val packages = PackageList(this).packages\n' +
          '            // Image paste into the composer (not autolinked) — see\n' +
          '            // plugins/withImagePaste.js.\n' +
          '            packages.add(PatchPastePackage())\n',
      );
      if (!src.includes('PatchPastePackage()')) {
        throw new Error(
          'withImagePaste: could not register PatchPastePackage in MainApplication.kt — ' +
            'the getPackages() anchor changed.',
        );
      }
      cfg.modResults.contents = src;
    }
    return cfg;
  });

module.exports = (config) => withPackageRegistration(withNativeFiles(config));
