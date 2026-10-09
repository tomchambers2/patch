// Desktop notification actions (spec/09 § Notification actions) — the
// renderer half. Electron's main process shows the native toast and decides
// what a reply/action-button tap MEANS (packages/desktop/src/
// notificationActions.ts), but only this renderer holds the live WS and the
// guaranteed-delivery trackers (`deliveryTracker.ts`, `permissionDeliveryTracker.ts`)
// — a background main process has neither. So main hands the decided intent
// here over the preload bridge's `onNotificationSend`, this module sends it
// exactly the way the composer / QuestionCard already do (same trackers, same
// optimistic store updates — a notification reply shows up in the chat like
// any other), and reports back whether it actually went out so the toast can
// say "Sent" or "Not sent — tap to retry".
//
// "Went out" means handed to a connected socket, not "the host acked it" —
// exactly like the composer's own Send button, which doesn't wait for an ack
// before showing the message either. The guaranteed-delivery trackers take it
// from there, and an eventual real failure still surfaces in the chat
// transcript itself ("tap to retry" there, per their own header comments).
// The one case this reports as failed up front is the one spec/09 calls out
// by name — offline: no live connection to hand anything to at all.

import type { NotificationSendPayload } from './desktopBridge.js';
import { getDesktopBridge } from './desktopBridge.js';
import { getActiveWs } from '../api/ws.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useChatStore } from '../stores/chatStore.js';
import { sendMessage } from './sendQueue.js';
import { permissionDeliveryTracker } from './permissionDeliveryTracker.js';

function isConnected(): boolean {
  return usePresenceStore.getState().connection === 'connected' && getActiveWs() !== null;
}

function handleSend(payload: NotificationSendPayload): boolean {
  const { chatId, intent } = payload;
  if (intent.kind === 'ignore') return true;
  if (!isConnected()) return false;

  if (intent.kind === 'reply') {
    sendMessage(chatId, intent.text, []);
    return true;
  }

  // 'permission' | 'question_answer' — both travel as chat.permission_response,
  // mirroring ChatRoute.tsx's `handlePermission` exactly.
  const ws = getActiveWs();
  if (!ws) return false;
  if (intent.kind === 'permission') {
    permissionDeliveryTracker.send(
      {
        type: 'chat.permission_response',
        chatId,
        requestId: intent.requestId,
        approve: intent.decision === 'approve',
      },
      (event) => ws.send(event),
    );
    useChatStore.getState().resolvePermission(chatId, intent.requestId, intent.decision);
    return true;
  }
  const answers = { [intent.questionText]: intent.answer };
  permissionDeliveryTracker.send(
    {
      type: 'chat.permission_response',
      chatId,
      requestId: intent.requestId,
      approve: true,
      decision: 'approve_with_edits',
      editedNewString: JSON.stringify(answers),
    },
    (event) => ws.send(event),
  );
  useChatStore.getState().resolvePermission(chatId, intent.requestId, 'approve', answers);
  return true;
}

let unsubscribe: (() => void) | null = null;

/** Wires the bridge once, from the app's top-level bootstrap. No-op in a plain browser. */
export function initNotificationActionBridge(): void {
  if (unsubscribe) return;
  const bridge = getDesktopBridge();
  const off = bridge?.onNotificationSend?.((payload) => {
    const ok = handleSend(payload);
    bridge.notificationSendResult?.(payload.requestId, ok);
  });
  unsubscribe = off ?? null;
}

/** Test seam: forget the subscription so a test can re-init against a fresh bridge. */
export function _resetNotificationActionBridge(): void {
  unsubscribe?.();
  unsubscribe = null;
}
