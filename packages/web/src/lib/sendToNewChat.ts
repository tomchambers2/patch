// "Send to new chat" (spec/14 § Message context menu) — for breaking a chat up.
// Quotes a message, or the part of it the user selected, into an UNSENT new-chat
// draft on the same host and in the same folder as the source chat, and returns
// the route that opens it. The user writes the instruction and sends it.
import { useChatStore } from '../stores/chatStore.js';
import { useDraftStore } from '../stores/draftStore.js';
import { withQuotedSelection } from './quoteSelection.js';

export function sendToNewChat(chatId: string, text: string): string {
  const chat = useChatStore.getState().chats[chatId];
  if (!chat) throw new Error(`sendToNewChat: unknown chat ${chatId}`);
  const drafts = useDraftStore.getState();
  drafts.pruneBlank();
  const id = drafts.create(chat.folder);
  drafts.update(id, {
    text: withQuotedSelection('', text),
    ...(chat.daemonId ? { daemonId: chat.daemonId } : {}),
  });
  return `/chats/new?draft=${encodeURIComponent(id)}`;
}

/** The text selected inside `el`, or '' when the selection is empty or elsewhere. */
export function selectionWithin(el: Element): string {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return '';
  const range = sel.getRangeAt(0);
  if (!el.contains(range.commonAncestorContainer)) return '';
  return sel.toString().trim();
}
