// fileEditorSend — the send path a file tab's Approve/Deny/Save takes
// (spec/14 § Diff editor, § File browser). Was inline in `AppShell`'s single
// `onSendEvent` closure handed to the one docked `EditorRail`; now every
// `FileEditorTab` is its own instance (one per open file), so the logic moves
// here to stay in exactly one place rather than copy-pasted per tab.

import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { permissionDeliveryTracker } from './permissionDeliveryTracker.js';
import type { PatchWs } from '../api/ws.js';
import { failed } from './errorCopy.js';

export type FileEditorEvent =
  | {
      type: 'chat.permission_response';
      requestId: string;
      approve: boolean;
      decision: 'approve' | 'deny' | 'approve_with_edits';
      editedNewString?: string;
    }
  | { type: 'file.write'; chatId: string; path: string; content: string };

/**
 * `chatId` is the diff's own chat (the tab's `chatId` prop) — not some
 * separately-tracked "active chat for diff" singleton, since a file tab
 * already knows exactly which chat it belongs to.
 */
export function sendFileEditorEvent(ws: PatchWs | null, chatId: string, ev: FileEditorEvent): void {
  const pushError = useUiStore.getState().pushError;
  const pushNotice = useUiStore.getState().pushNotice;
  try {
    if (ev.type === 'chat.permission_response') {
      permissionDeliveryTracker.send({ ...ev, chatId }, (event) => ws?.send(event));
      // G2-d3/d4: resolving from a file tab's DiffPanel must also resolve the
      // matching INLINE card so the two controls never desync.
      useChatStore
        .getState()
        .resolvePermission(chatId, ev.requestId, ev.approve ? 'approve' : 'deny');
      useUiStore.getState().clearPendingDiffForChat(chatId, ev.requestId);
    } else {
      ws?.send(ev);
      // G3-d4: `file.write` carries no host success-ack frame — surface an
      // explicit success notice on dispatch; a host rejection still raises
      // its own error toast over the top.
      pushNotice(`Saved ${ev.path}`);
    }
  } catch (e) {
    pushError(failed('send'), undefined, (e as Error).message);
  }
}
