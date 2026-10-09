// Expo push registration. NO FALLBACK: a denied permission or empty token
// rejects; we surface the failure rather than silently running without push.
//
// Notifications:
//   - kind: 'message' → standard system notification, tap → focus chat.
//   - kind: 'call'    → trigger the ConnectionService incoming-call UI.
//
// Suppression while foregrounded is handled server-side (heartbeat-based).
// Local UX: when the app is foregrounded, expo-notifications still routes
// the data through addNotificationReceivedListener so we can deep-link.

import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { AppState } from 'react-native';
import { api } from '../api/rest';
import { showIncomingCall } from './callkeep';
import { parseActionsPayload } from './notificationActions';
import {
  initNotificationCategories,
  registerDynamicCategoryIfNeeded,
  registerNotificationResponseListener,
} from './notificationResponses';

let _registered = false;

/** The EAS project id `eas init` writes to `app.config.ts`'s `extra.eas.projectId` — required to mint an Expo push token. */
function easProjectId(): string {
  const id = Constants.expoConfig?.extra?.['eas']?.['projectId'];
  if (typeof id !== 'string' || !id) {
    throw new Error('initPush: no EAS project id at expoConfig.extra.eas.projectId');
  }
  return id;
}

export async function initPush(): Promise<void> {
  if (_registered) return;
  // Foreground policy: don't auto-show banners — we render the
  // chat detail / overlays ourselves. Banner only when backgrounded.
  Notifications.setNotificationHandler({
    handleNotification: async (): Promise<{
      shouldShowAlert: boolean;
      shouldPlaySound: boolean;
      shouldSetBadge: boolean;
    }> => ({
      shouldShowAlert: AppState.currentState !== 'active',
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });

  // Channel for chat messages (default importance).
  await Notifications.setNotificationChannelAsync('patch_messages', {
    name: 'Messages',
    importance: Notifications.AndroidImportance.HIGH,
  });
  // Channel for anything sent at priority='silent' — it should be waiting when
  // he next picks the phone up, and never before.
  await Notifications.setNotificationChannelAsync('patch_quiet', {
    name: 'Quiet',
    importance: Notifications.AndroidImportance.LOW,
    sound: null,
    vibrationPattern: null,
    enableVibrate: false,
  });
  // Channel for anything sent at priority='urgent' — an ordinary notification
  // with a more urgent sound (spec/09 § Reaching the user). The sound is a raw
  // resource bundled by the expo-notifications plugin (app.config.ts `sounds`).
  //
  // Android fixes a channel's sound when it is first created, so the id carries
  // a suffix: `patch_urgent` shipped once with the sound missing from the APK,
  // took the default sound, and could never be corrected. It is deleted here.
  await Notifications.deleteNotificationChannelAsync('patch_urgent');
  await Notifications.setNotificationChannelAsync('patch_urgent_alert', {
    name: 'Urgent',
    importance: Notifications.AndroidImportance.HIGH,
    sound: 'patch_urgent.wav',
  });
  // Channel for Manager calls — high importance + heads-up.
  await Notifications.setNotificationChannelAsync('patch_call', {
    name: 'Manager calls',
    importance: Notifications.AndroidImportance.MAX,
    sound: 'default',
    vibrationPattern: [0, 500, 250, 500],
  });

  // spec/09 § Notification actions — Reply + Approve/Deny are pre-registered
  // once here so they're ready even for a notification shown while this
  // app's JS has only just woken up to a backgrounded push.
  await initNotificationCategories();
  registerNotificationResponseListener();

  const perm = await Notifications.requestPermissionsAsync();
  if (!perm.granted) {
    throw new Error('initPush: notification permission denied');
  }
  // Expo push token — the server posts to Expo's push API with this
  // (spec/09), never touching FCM directly. google-services.json stays in
  // the build only so the one-time FCM V1 credentials uploaded to the EAS
  // project can actually deliver to this app.
  const tok = await Notifications.getExpoPushTokenAsync({ projectId: easProjectId() });
  if (!tok.data) {
    throw new Error('initPush: empty Expo push token');
  }
  await api.pushRegister(tok.data);

  Notifications.addNotificationReceivedListener((n) => {
    const data = n.request.content.data ?? {};
    // spec/09 § Notification actions — a question's own option text or
    // patch_notify's quickReplies can't be pre-registered (the labels aren't
    // known ahead of time), so rebuild the one dynamic category fresh,
    // right as the push arrives. Best-effort: this is a no-op for the common
    // Reply/Approve-Deny case, which the static categories above already
    // cover regardless of timing.
    void registerDynamicCategoryIfNeeded(parseActionsPayload(data['actions']));
    if (data['kind'] === 'call') {
      const callId = String(data['callId'] ?? '');
      const chatId = String(data['chatId'] ?? '');
      if (callId && chatId) {
        showIncomingCall(callId, chatId, String(data['callerLabel'] ?? 'Manager'));
      }
    }
  });

  // Re-register on token rotation (spec/11 item 11). `addPushTokenListener`
  // fires with the underlying NATIVE device token, not the Expo one — Expo
  // push tokens are derived from it, so a rotation there invalidates the
  // Expo token too and it must be re-minted, not forwarded as-is. NO
  // FALLBACK: if re-register throws, we surface it via the listener's caller
  // (handler is best-effort but errors are propagated for the next call).
  Notifications.addPushTokenListener(() => {
    void Notifications.getExpoPushTokenAsync({ projectId: easProjectId() }).then((t) => {
      if (!t.data) return;
      void api.pushRegister(t.data);
    });
  });

  _registered = true;
}
