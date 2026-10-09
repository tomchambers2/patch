// First-launch permission priming (spec/15 § First-launch permission priming).
//
// On first launch (after pairing) the app requests all the OS permissions it
// will need UP FRONT — microphone (voice notes + calls), notifications
// (Manager calls, chat activity), and camera (scanning device-pairing QR
// codes) — so no feature ever hits a cold permission prompt mid-use. The
// older in-context requests remain only as a fallback for a user who declined
// at priming. The flow runs ONCE, gated on a "primed" flag in local storage,
// and does not re-nag on subsequent launches.
//
// NO FALLBACK: a declined permission is remembered as "primed" (we do not
// re-nag) but never silently no-ops — the feature that needs it explains the
// need and links to system settings when it is later used.

import { Audio } from 'expo-av';
import * as Notifications from 'expo-notifications';
import { Camera } from 'expo-camera';
import { store } from './credential';

const PRIMED_KEY = 'patch.permissionsPrimed.v1';

export function hasPrimedPermissions(): boolean {
  return store().getBoolean(PRIMED_KEY) === true;
}

/**
 * Request microphone, notifications and camera permissions together, once.
 * Returns true if the priming ran (first launch), false if it was skipped
 * because we have already primed on a previous launch.
 */
export async function runPermissionPriming(): Promise<boolean> {
  if (hasPrimedPermissions()) return false;
  // Request all three. We deliberately await each so any OS dialog is shown
  // in sequence with its own rationale; a denial does not abort the others.
  await Audio.requestPermissionsAsync();
  await Notifications.requestPermissionsAsync();
  await Camera.requestCameraPermissionsAsync();
  // Mark primed regardless of grant/deny so we never re-nag (spec: runs once).
  store().set(PRIMED_KEY, true);
  return true;
}
