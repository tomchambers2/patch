// spec/04 ## Message queueing — what a surface can do to a still-pending queued
// message: remove it, run it next (interrupting the running turn), or replace
// its text. Mirrors the web ChatRoute handlers, over the same wire frames.

import type { ChatEventEntry } from '../stores/chatStore';
import { useChatStore } from '../stores/chatStore';
import { useUiStore } from '../stores/uiStore';
import { getWs } from '../api/ws';

function send(what: string, event: Parameters<ReturnType<typeof getWs>['send']>[0]): void {
  try {
    getWs().send(event);
  } catch (err) {
    useUiStore.getState().pushError(`${what} failed: ${(err as Error).message}`);
  }
}

/** Cancel a queued turn. Optimistic local removal; the `chat.dequeued` echo then no-ops. */
export function unqueueMessage(chatId: string, localId: string): void {
  useChatStore.getState().removeQueued(chatId, localId);
  send('unqueue', { type: 'chat.unqueue_request', chatId, localId });
}

/**
 * Interrupt the running turn so the queue starts draining now. Never reorders
 * the queue (spec/04 § Promote).
 */
export function promoteMessage(chatId: string, localId: string): void {
  send('promote', { type: 'chat.promote_request', chatId, localId });
}

/** Save an edit to a queued message; emptying one with no attachments removes it. */
export function editQueuedMessage(chatId: string, entry: ChatEventEntry, text: string): void {
  const localId = entry.localId!;
  if (text.length === 0 && !(entry.attachments && entry.attachments.length > 0)) {
    unqueueMessage(chatId, localId);
    return;
  }
  send('editing the queued message', {
    type: 'chat.edit_queued_request',
    chatId,
    localId,
    message: text,
  });
}
