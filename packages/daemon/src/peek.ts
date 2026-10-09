// The `patch_peek` result shape (spec/06 § Cross-chat toolset), factored out
// so the LOCAL endpoint (control.ts `/internal/peek/:id`) and a host
// answering ANOTHER host's cross-host relay (index.ts, on an inbound
// `patch.peek.request`) build the exact same object rather than two
// hand-maintained copies drifting apart.

import type { Daemon } from './chatRunner.js';

export interface PeekResult {
  chat_state: {
    chatId: string;
    name: string | null | undefined;
    folder: string;
    activity: unknown;
    status: unknown;
    pinned: unknown;
    pinnedAt: unknown;
    lastMessages: unknown;
    lastUpdated: number;
    lastMessage: string | undefined;
    lastError: unknown;
    eventCount: number;
    hasClaudeSession: boolean;
  };
  events: unknown[];
  truncated: boolean;
}

/** `undefined` iff `chatId` is not one of THIS host's own chats. */
export function buildPeekResult(
  daemon: Daemon,
  chatId: string,
  limit: number,
): PeekResult | undefined {
  const state = daemon.chatState.get(chatId);
  if (!state) return undefined;
  const lastMsg =
    state.lastMessages.length > 0
      ? state.lastMessages[state.lastMessages.length - 1]?.content
      : undefined;
  const chat_state: PeekResult['chat_state'] = {
    chatId: state.chatId,
    name: state.name,
    folder: state.folder,
    activity: state.activity,
    status: state.status,
    pinned: state.pinned,
    pinnedAt: state.pinnedAt,
    lastMessages: state.lastMessages,
    lastUpdated: state.lastUpdated,
    lastMessage: lastMsg,
    lastError: state.lastError,
    eventCount: state.nextSeq,
    hasClaudeSession: state.claudeSessionId !== undefined && state.claudeSessionId !== '',
  };
  const { events, truncated } = daemon.getRecentEvents(state.chatId, limit);
  return { chat_state, events, truncated };
}
