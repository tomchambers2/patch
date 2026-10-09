// New-chat navigation target (spec/15 § New chat flow). Tapping + opens a
// brand-new chat pinned to a chosen folder; the flow ALWAYS lands on the
// freshly-created chat's detail and NEVER on Manager or any existing thread.
// Kept pure so the "never Manager" guarantee is unit-testable.

import { SPECIAL_THREAD_IDS } from '@patch/wire';

/** The route to navigate to after a new chat is created. Carries
 * `justCreated=1` (Todoist 6hfFww7fH7JQFWj4: "no flickering" — the detail
 * screen reads this to skip its usual reveal delay, since a chat arriving
 * this way has nothing behind it worth hiding: its one message is already in
 * the store, synchronously, from the optimistic echo this same send just
 * did). Only this navigation should ever carry it — a chat opened normally
 * from the list has real history that gate still needs to hide. */
export function newChatRoute(newChatId: string): string {
  if (!newChatId || newChatId.length === 0) {
    throw new Error('newChatRoute: empty chatId — a new chat must have an id');
  }
  if (newChatId === SPECIAL_THREAD_IDS.manager) {
    // A brand-new chat can never be the Manager thread; guard against a
    // server/response mix-up routing the user to Manager (item 16).
    throw new Error('newChatRoute: refusing to route a new chat to Manager');
  }
  return `/chats/${newChatId}?justCreated=1`;
}

/**
 * The draft key the new-chat screen's composer types into (spec/15 § New chat
 * flow). Nothing exists server-side until the first send, so the unsent text
 * and attachments need a home that is not a chatId: this key, in the same
 * per-key stores every chat's composer uses (lib/composerDraft.ts,
 * stores/composerAttachmentStore.ts). It is also where the share sheet drops a
 * share bound for a new chat. Not a valid chatId (ids are `chat_…`/`thread_…`),
 * so it can never collide with a real chat's draft.
 */
export const NEW_CHAT_DRAFT_KEY = 'new';
