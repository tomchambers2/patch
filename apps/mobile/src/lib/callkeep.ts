// react-native-callkeep wrapper. Per spec/15 ## Manager incoming-call UX:
// - chat.call_request arrives via FCM data message OR live WS.
// - We trigger the native ConnectionService UI (full-screen incoming call).
// - On accept → emit chat.call_response { decision: 'accept' } and open the
//   voice-call overlay.
// - On decline / 30s timeout → fall through to the in-app inbox (push).
//
// NO FALLBACK: setup() throws if the native module is missing — that means
// the prebuild didn't include the ConnectionService and a release build
// would silently lose Manager calls.

import RNCallKeep from 'react-native-callkeep';
import { getWs } from '../api/ws';
import { useUiStore } from '../stores/uiStore';
import { useVoiceStore } from '../stores/voiceStore';
import { startVoiceCall } from './voiceCall';

let _initialised = false;
let _activeCallUuid: string | null = null;
let _activeChatId: string | null = null;
let _activeCallId: string | null = null;

export async function initCallKeep(): Promise<void> {
  if (_initialised) return;
  await RNCallKeep.setup({
    ios: {
      // iOS is out of scope per spec/15, but the callkeep type forces a
      // value here. Empty appName is harmless on Android-only builds.
      appName: 'Patch',
    },
    android: {
      alertTitle: 'Patch needs phone-call permission',
      alertDescription: 'So Manager can ring you for urgent decisions.',
      cancelButton: 'Not now',
      okButton: 'OK',
      additionalPermissions: [],
      // SELF-MANAGED ConnectionService (spec/15 § First-launch permission
      // priming). A system-managed phone account throws the user into the
      // Android "Calling accounts" settings screen to enable Patch — the "wrong
      // page" the runtime permission request appeared to open. A self-managed
      // account registers with CAPABILITY_SELF_MANAGED: it does NOT appear in
      // that settings screen and needs no manual enablement, so setup() at
      // startup asks for the runtime grant via the normal dialog only.
      selfManaged: true,
      foregroundService: {
        channelId: 'patch_call_fg',
        channelName: 'Patch voice call',
        notificationTitle: 'Patch is on a call',
      },
    },
  });
  RNCallKeep.setAvailable(true);

  RNCallKeep.addEventListener('answerCall', ({ callUUID }) => {
    if (callUUID !== _activeCallUuid || !_activeChatId || !_activeCallId) return;
    try {
      getWs().send({
        type: 'chat.call_response',
        callId: _activeCallId,
        response: 'accept',
      });
    } catch (e) {
      // Surface the failure: cold-start FCM woke the native UI before WS
      // reconnected. The server reaper times out after 30s; the UI banner
      // tells the user we couldn't ack.
      useUiStore
        .getState()
        .pushError(`failed to send call response — retry: ${(e as Error).message}`);
    }
    startVoiceCall(_activeChatId);
    useVoiceStore.getState().setIncoming(null);
  });

  RNCallKeep.addEventListener('endCall', ({ callUUID }) => {
    if (callUUID !== _activeCallUuid) return;
    try {
      if (_activeCallId) {
        getWs().send({
          type: 'chat.call_response',
          callId: _activeCallId,
          response: 'decline',
        });
      }
    } catch (e) {
      useUiStore
        .getState()
        .pushError(`failed to send call response — retry: ${(e as Error).message}`);
    }
    _activeCallUuid = null;
    _activeChatId = null;
    _activeCallId = null;
    useVoiceStore.getState().setIncoming(null);
  });

  _initialised = true;
}

/** Display the incoming-call UI for a chat.call_request. */
export function showIncomingCall(callId: string, chatId: string, callerLabel: string): void {
  if (!_initialised) {
    throw new Error('callkeep: not initialised — call initCallKeep() at app start');
  }
  const uuid = makeUuid();
  _activeCallUuid = uuid;
  _activeChatId = chatId;
  _activeCallId = callId;
  RNCallKeep.displayIncomingCall(uuid, chatId, callerLabel, 'generic', false);
}

export function endActiveCall(): void {
  if (_activeCallUuid) RNCallKeep.endCall(_activeCallUuid);
  _activeCallUuid = null;
  _activeChatId = null;
  _activeCallId = null;
}

function makeUuid(): string {
  // RFC4122 v4-ish — good enough for a per-call identifier; avoids pulling
  // in a uuid runtime dep on the native side.
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 32; i++) {
    if (i === 8 || i === 12 || i === 16 || i === 20) out += '-';
    const r = Math.floor(Math.random() * 16);
    if (i === 12) {
      out += '4';
    } else if (i === 16) {
      // `(r & 0x3) | 0x8` is always in [8,11], a valid `hex` index by
      // construction — the `?? fallback` only satisfies TypeScript's
      // noUncheckedIndexedAccess, never a real path.
      /* v8 ignore next */
      out += hex[(r & 0x3) | 0x8] ?? '8';
    } else {
      // `r` is always in [0,15], a valid `hex` index by construction — same
      // TypeScript-only fallback as above.
      /* v8 ignore next */
      out += hex[r] ?? '0';
    }
  }
  return out;
}
