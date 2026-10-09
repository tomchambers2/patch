// App-wide bootstrap: handles deep-link credential acceptance, opens the
// WS, registers push, sets up CallKeep. Called from the root layout AFTER
// the user has been paired (or via the dev `?credential=…` deep link).
//
// NO FALLBACK: if any required init step fails, we throw — caller logs to
// the UI store and the user sees a banner. We do NOT continue half-set-up.

import * as Linking from 'expo-linking';
import Constants from 'expo-constants';
import { saveCredential, loadCredential } from './credential';
import { getRoute, setRoute } from '../config';
import { getWs, resetWs } from '../api/ws';
import { initPush } from './push';
import { runPermissionPriming } from './permissionPriming';
import { useUiStore } from '../stores/uiStore';
import { useChatStore } from '../stores/chatStore';
import { useFolderStore } from '../stores/folderStore';
import { api } from '../api/rest';
import { toChatListRow } from './chatListRow';
import { useVoiceStore } from '../stores/voiceStore';
import { showIncomingCall, initCallKeep } from './callkeep';
import { loadPreferences } from './preferences';

let _booted = false;

/**
 * Accept `patch://?credential=<jwt>[&server=<origin>]` deep links (dev
 * convenience + tests). No server address is built into the app, so a link that
 * is to yield a usable device must name the server too; a credential alone
 * leaves the route unset and every screen that talks to the server throws.
 */
export function maybeAcceptDevCredential(initialUrl: string | null): boolean {
  if (!initialUrl) return false;
  const parsed = Linking.parse(initialUrl);
  const cred = parsed.queryParams?.['credential'];
  if (typeof cred === 'string' && cred.length > 0) {
    saveCredential(cred);
    const server = parsed.queryParams?.['server'];
    if (typeof server === 'string' && server.length > 0) setRoute({ kind: 'direct', url: server });
    return true;
  }
  return false;
}

export function expoExtra<T = unknown>(key: string): T | undefined {
  const extra = Constants.expoConfig?.extra ?? {};
  return extra[key] as T | undefined;
}

export async function bootstrap(): Promise<void> {
  if (_booted) return;
  // Pull deep-linked credential (dev/test). Doesn't replace the pair flow.
  const initial = await Linking.getInitialURL();
  maybeAcceptDevCredential(initial);

  if (!loadCredential() || getRoute() === null) {
    // The auth gate in app/index.tsx will redirect to /pair.
    return;
  }

  // Open the live WS FIRST. It carries host presence, and the server greets a
  // newly-authed surface with the current daemon.online/offline immediately
  // (ws-hub). Opening it up front — before permission priming and the
  // cold-start fetches below — means the host reads as connected effectively
  // instantly, instead of only after the user taps through the first-launch
  // permission dialogs (spec/12 § connection state). connect() is non-blocking.
  getWs().connect();

  // First-launch permission priming (spec/15 § First-launch permission
  // priming): request microphone + notifications + camera UP FRONT, once, so
  // no feature ever hits a cold permission prompt mid-use. Gated on a local
  // "primed" flag so it does not re-nag on later launches. A priming failure
  // is surfaced but must not abort bootstrap.
  await runPermissionPriming().catch((e: Error) => {
    useUiStore.getState().pushError(`permission priming failed: ${e.message}`);
  });

  // CallKeep + push set up the native notification/incoming-call path.
  // Their failure is surfaced LOUDLY as a UI banner (no silent fallback),
  // but it must NOT abort bootstrap: the chat surface and the live WS link
  // are independent of FCM/Telecom and have to come up regardless (e.g. on
  // a device where Google-Play FCM token retrieval is unavailable). The
  // user still sees chats and can work; the banner tells them push/calls
  // are degraded. Awaiting these sequentially before the WS connect also
  // serialised a (potentially slow/failing) FCM round-trip in front of the
  // whole app — kick them off but don't gate the core surface on them.
  void initPush().catch((e: Error) => {
    useUiStore.getState().pushError(`push init failed: ${e.message}`);
  });

  // Initialise CallKeep at launch so the phone-call permission is requested UP
  // FRONT with the other first-launch permissions (spec/15 § First-launch
  // permission priming). It is now SELF-MANAGED (see callkeep.ts), so setup()
  // asks for the runtime grant via the normal permission dialog and does NOT
  // route the user to the Android "Calling accounts" settings screen. Failure
  // is surfaced as a banner (no silent fallback) but must not abort bootstrap —
  // the chat surface is independent of the Telecom path.
  void initCallKeep().catch((e: Error) => {
    useUiStore.getState().pushError(`call setup failed: ${e.message}`);
  });

  // The account preferences a quiet call needs without a round-trip — the
  // address word it gates utterances on (spec/07 § Session modes). Surfaced on
  // failure but never aborts bootstrap: a call opened before they load simply
  // carries no address word, which the host reports rather than guessing.
  void loadPreferences().catch((e: Error) => {
    useUiStore.getState().pushError(`settings load failed: ${e.message}`);
  });

  // Roster catch-up. This is NOT what paints the Chats tab — the store is
  // already populated from the on-device cache at construction (spec/15 §
  // Instant open (read cache)), so the list is on screen before this call is
  // even made. `hydrate` REPLACES that cached roster with the server's answer
  // and rewrites the cache, which is how a chat deleted or renamed elsewhere
  // stops being shown.
  try {
    const list = await api.listChats();
    useChatStore.getState().hydrate(list.chats.map(toChatListRow));
  } catch (e) {
    useUiStore.getState().pushError(`failed to fetch chats: ${(e as Error).message}`);
  }

  // Cold-start the host-owned folder list (spec/04 § Folders) so the new-chat
  // + job-editor pickers are populated before the WS delivers live
  // `folders.list` / `folders.updated`. A failure is surfaced but must not
  // abort bootstrap — the picker still works via the custom-path field and the
  // WS snapshot on connect.
  try {
    const { hosts } = await api.folders();
    useFolderStore.getState().setAllFolders(hosts);
  } catch (e) {
    useUiStore.getState().pushError(`failed to fetch folders: ${(e as Error).message}`);
  }

  // Bridge incoming calls into the native UI. The WS dispatcher writes
  // them into the voice store; we observe and trigger CallKeep.
  useVoiceStore.subscribe((state, prev) => {
    if (state.incomingCall && state.incomingCall !== prev.incomingCall) {
      try {
        showIncomingCall(state.incomingCall.callId, state.incomingCall.chatId, 'Manager');
      } catch (e) {
        useUiStore.getState().pushError(`incoming call: ${(e as Error).message}`);
      }
    }
  });

  _booted = true;
}

export function teardown(): void {
  resetWs();
  _booted = false;
}
