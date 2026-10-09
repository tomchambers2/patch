// spec/15 § Side threads screen — shared send actions for the trigger (long-
// press menu / branch-again inside the screen) and the screen's own
// composer/controls. Mirrors web's `lib/sideThreadActions.ts`.

import type { WireEvent } from '@patch/wire';
import { getWs } from '../api/ws';
import { useUiStore } from '../stores/uiStore';
import { useSideThreadsStore } from '../stores/sideThreadsStore';

function makeLocalId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** The long-press TRIGGER: opens the draft, cursor in its composer. Nothing
 * sent to the host yet. */
export function openSideThreadDraft(
  chatId: string,
  seq: number,
  quotedMessage: string,
  fromBranchId?: string,
): void {
  useSideThreadsStore.getState().openDraft(chatId, {
    seq,
    quotedMessage,
    ...(fromBranchId !== undefined ? { fromBranchId } : {}),
  });
}

/** spec/15 § "IN THE MAIN CHAT" marker: opens the screen on an EXISTING side
 * thread's tab (not a draft). */
export function openExistingSideThread(chatId: string, branchId: string): void {
  useSideThreadsStore.getState().openThread(chatId, branchId);
}

function send(event: WireEvent): void {
  try {
    getWs().send(event);
  } catch (e) {
    useUiStore.getState().pushError((e as Error).message);
  }
}

export function startSideThread(
  chatId: string,
  seq: number,
  message: string,
  fromBranchId?: string,
): void {
  useSideThreadsStore.getState().expectNewTab(chatId);
  send({
    type: 'chat.side_request',
    chatId,
    seq,
    message,
    localId: makeLocalId('side'),
    ...(fromBranchId !== undefined ? { branchId: fromBranchId } : {}),
  });
}

export function sendToBranch(chatId: string, branchId: string, message: string): void {
  send({ type: 'chat.input', chatId, branchId, message, localId: makeLocalId('branch-input') });
}

export function stopBranch(chatId: string, branchId: string): void {
  send({ type: 'chat.stop_request', chatId, branchId });
}

export function sendBackToChat(chatId: string, branchId: string): void {
  send({ type: 'chat.send_back_request', chatId, branchId });
}
