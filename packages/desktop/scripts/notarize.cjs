// Group 20 fix-7 #1: electron-builder afterSign hook. Runs Apple
// notarytool against the produced .app bundle so end users don't see
// "Apple cannot verify this app for malicious software" on first
// launch.
//
// Required env (NO FALLBACK — missing values throw):
//   APPLE_ID                       Apple developer ID (email).
//   APPLE_APP_SPECIFIC_PASSWORD    app-specific password generated at
//                                  appleid.apple.com (NOT the AppleID password).
//   APPLE_TEAM_ID                  10-char team identifier.
//
// notarytool ships with Xcode's command-line tools; this hook shells out
// to it. We skip when CI is missing the env *and* PATCH_SKIP_NOTARIZE=1
// (developer builds). Otherwise the hook errors loudly so a forgotten
// secret in CI never quietly produces an unsigned build.

const path = require('node:path');
const { execFileSync } = require('node:child_process');

module.exports = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const skip = process.env.PATCH_SKIP_NOTARIZE === '1';
  const appleId = process.env.APPLE_ID;
  const password = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;

  if (!appleId || !password || !teamId) {
    if (skip) {
      console.warn(
        '[notarize] APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not set ' +
          'and PATCH_SKIP_NOTARIZE=1 — skipping (dev build).',
      );
      return;
    }
    throw new Error(
      'notarize: APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID required ' +
        '(set PATCH_SKIP_NOTARIZE=1 for unsigned dev builds).',
    );
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  console.log(`[notarize] submitting ${appPath}`);
  // 1. notarytool submit (--wait blocks until ticket assigned).
  execFileSync(
    'xcrun',
    [
      'notarytool',
      'submit',
      appPath,
      '--apple-id',
      appleId,
      '--password',
      password,
      '--team-id',
      teamId,
      '--wait',
    ],
    { stdio: 'inherit' },
  );
  // 2. Staple the ticket so Gatekeeper accepts the app offline.
  execFileSync('xcrun', ['stapler', 'staple', appPath], { stdio: 'inherit' });
  console.log('[notarize] notarized + stapled OK');
};
