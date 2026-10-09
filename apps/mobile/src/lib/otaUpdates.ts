// OTA update check-and-FETCH (spec/11 § Mobile OTA).
//
// JS-only changes ship via EAS Update without a new APK. Nothing here ever
// reloads: the automatic paths DOWNLOAD a newer bundle and leave the running
// one alone, and expo-updates launches the downloaded bundle by itself on the
// next cold start.
//
// That is deliberate, not a fallback. This used to call `Updates.reloadAsync()`
// as soon as a fetch completed, which meant the first launch after any publish
// painted the OLD bundle, tore the whole JS context down and started again —
// the white flash and second load Tom reported. On an already-open app it was
// worse: the 30-minute timer and every background -> foreground transition
// could restart the app under him mid-use.
//
// The native layer already does the right thing without our help
// (`app.config.ts`: `checkAutomatically: 'ON_LOAD'`, `fallbackToCacheTimeout:
// 0`; AndroidManifest `EXPO_UPDATES_CHECK_ON_LAUNCH=ALWAYS`,
// `EXPO_UPDATES_LAUNCH_WAIT_MS=0`), so a fetched update costs the user nothing
// and applies at the next natural start. The only reload left in the app is the
// one Tom presses himself — Settings -> Version -> "Restart to update", which
// also names the pending update so a downloaded-but-not-running bundle is never
// invisible.
//
// An update is delivered ONLY to a build whose `runtimeVersion` matches the
// published branch (see spec/11 § Mobile OTA), so a native change cannot be
// shipped as a broken OTA — it needs a fresh APK.

import { AppState, type NativeEventSubscription } from 'react-native';
import * as Updates from 'expo-updates';
import { recordUpdateCheck } from './updateCheck';

/**
 * Check for an OTA update and, if one is available, fetch it — and stop there.
 * The download takes effect on the next launch; we never reload into it (see
 * the file header).
 *
 * Best-effort and non-blocking: a no-op in dev / Expo Go (where updates are
 * disabled) and when offline. Errors are logged, not thrown — a failed update
 * check must never crash or block app launch (this is NOT a hidden fallback:
 * the app is already running the last-good bundle; we surface the failure in
 * logs and simply try again next launch).
 */
export async function checkForOtaUpdate(): Promise<void> {
  // `isEnabled` is false in Expo Go and in dev builds — nothing to do.
  if (__DEV__ || !Updates.isEnabled) return;
  try {
    const result = await Updates.checkForUpdateAsync();
    // Record the check so Settings → Version shows an accurate "Last checked",
    // whether or not an update was found.
    recordUpdateCheck(new Date().toISOString());
    if (!result.isAvailable) return;
    // Download only. `useUpdates().isUpdatePending` flips once this resolves,
    // which is what puts "An update is downloaded and ready to install." and
    // the "Restart to update" button in Settings → Version.
    await Updates.fetchUpdateAsync();
  } catch (err) {
    console.warn('[ota] update check failed', err);
  }
}

/** How often a foregrounded app re-checks the channel. */
const POLL_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Keep checking after launch, not just at it.
 *
 * A launch-only check means a phone left open for days runs whatever JS it
 * started with — and because the app is long-lived (it holds a WS and takes
 * calls), "next launch" can be a very long time away. Re-check on an interval
 * and whenever the app returns to the foreground, which is when a check is both
 * cheap and most likely to find something new. Each check only downloads, so
 * finding an update mid-session is invisible until the next start.
 *
 * Returns a teardown function.
 */
export function startOtaUpdatePolling(): () => void {
  if (__DEV__ || !Updates.isEnabled) return () => {};
  const timer = setInterval(() => void checkForOtaUpdate(), POLL_INTERVAL_MS);
  let previous = AppState.currentState;
  const sub: NativeEventSubscription = AppState.addEventListener('change', (next) => {
    if (previous.match(/inactive|background/) && next === 'active') void checkForOtaUpdate();
    previous = next;
  });
  return () => {
    clearInterval(timer);
    sub.remove();
  };
}
