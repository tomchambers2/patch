// `/` redirects to /chats/<manager-chat-id> if a Manager chat exists,
// otherwise renders a no-chat empty state.

import type { JSX } from 'react';
import { Navigate } from 'react-router-dom';
import { SPECIAL_THREAD_IDS } from '@patch/wire';
import { useChatStore } from '../stores/chatStore.js';

export function IndexRedirect(): JSX.Element {
  const chats = useChatStore((s) => s.chats);
  // Look the Manager thread up by its canonical id — the store is keyed by
  // chatId. The old name/folder heuristic never matched the real chat (name is
  // lowercase "manager", folder is the full thread path), so `/` wrongly fell
  // through to the empty state even when Manager existed.
  const manager = chats[SPECIAL_THREAD_IDS.manager];
  if (manager) return <Navigate to={`/chats/${manager.chatId}`} replace />;
  return (
    <main className="empty-state" data-testid="no-chat">
      <h1 className="display">No chat open</h1>
    </main>
  );
}
