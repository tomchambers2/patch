// spec/14 § Side threads panel — shared send actions for the trigger (hover
// button / context menu, main chat or inside the panel) and the panel's own
// composer/controls. Kept here, not in ChatRoute or the panel component, so
// both call the exact same wire shape.

import type { PatchWs } from '../api/ws.js';
import { useSideThreadsStore } from '../stores/sideThreadsStore.js';

function makeLocalId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** The hover button / context menu TRIGGER (spec/14 § Side threads panel):
 * opens the panel on an empty draft, cursor in its composer. Nothing is sent
 * to the host yet — `startSideThread` does that once the user actually
 * types something. */
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

/**
 * Start a side thread off the message at `seq`, and arm the panel to open on
 * whichever new branch this grows the chat's graph by. Call site owns whether
 * this is "off the main chat" (no `fromBranchId`) or "branching again from
 * inside another side thread's own tab" (`fromBranchId` names that tab) —
 * spec/04 § Side threads / "branching again from inside the panel". The new
 * branch's id isn't known yet (the host mints it) — `SideThreadsPanel`'s own
 * reconciler consumes `pendingNewTab` the moment `chat.branches` reports it.
 */
export function startSideThread(
  ws: PatchWs | null,
  chatId: string,
  seq: number,
  message: string,
  fromBranchId?: string,
): void {
  if (!ws) return;
  useSideThreadsStore.getState().expectNewTab(chatId);
  ws.send({
    type: 'chat.side_request',
    chatId,
    seq,
    message,
    localId: makeLocalId('side'),
    ...(fromBranchId !== undefined ? { branchId: fromBranchId } : {}),
  });
}

export function sendToBranch(
  ws: PatchWs | null,
  chatId: string,
  branchId: string,
  message: string,
): void {
  if (!ws) return;
  ws.send({
    type: 'chat.input',
    chatId,
    branchId,
    message,
    localId: makeLocalId('branch-input'),
  });
}

/** spec/14 § Side threads panel — "IN THE MAIN CHAT" marker: opens the panel
 * on an EXISTING side thread's tab (not a draft). */
export function openExistingSideThread(chatId: string, branchId: string): void {
  useSideThreadsStore.getState().openThread(chatId, branchId);
}

export function stopBranch(ws: PatchWs | null, chatId: string, branchId: string): void {
  ws?.send({ type: 'chat.stop_request', chatId, branchId });
}

export function sendBackToChat(ws: PatchWs | null, chatId: string, branchId: string): void {
  ws?.send({ type: 'chat.send_back_request', chatId, branchId });
}
