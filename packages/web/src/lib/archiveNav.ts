// Archiving the open chat moves you on with it (spec/04 § Lifecycle).
//
// Every archive control shares this — the chat header's icon, the sidebar row's
// icon, ⌘⌥A, and the bulk / project archives — so which one you reached for
// never changes where you end up.

import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { nextChatAfterArchive } from './chatGroups.js';
import { newChatPath } from './newChat.js';

/**
 * Leave the chats in `archivedIds` behind if the open chat is one of them.
 *
 * Call it BEFORE flipping those rows to archived — the destination is read off
 * the list as it still stands. A no-op when the open chat isn't being archived,
 * so an archive aimed at some other row leaves you where you are.
 */
export function navigateAfterArchive(
  navigate: (to: string) => void,
  archivedIds: readonly string[],
): void {
  const activeChatId = useChatStore.getState().activeChatId;
  if (!activeChatId || !archivedIds.includes(activeChatId)) return;
  const next = nextChatAfterArchive(
    Object.values(useChatStore.getState().chats),
    activeChatId,
    archivedIds,
    useUiStore.getState().attentionOnly,
    {
      chatSort: useUiStore.getState().chatSort,
      groupSort: useUiStore.getState().groupSort,
    },
  );
  navigate(next === null ? newChatPath() : `/chats/${next}`);
}
