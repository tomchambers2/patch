// The Archived and Hidden sections' rows (spec/15 ## Chats tab §§5, 7). The
// cold-start roster excludes archived and hidden chats — archived are
// unbounded, and hidden ones live only in their own section — so each section
// fetches its own list (`GET /api/chats?archived=only`, `?hidden=only`) the
// moment it is needed: when the section opens, or when a search starts (search
// covers every section). The rows are merged into the chat store so they behave
// like any other row (swipe tray, long-press sheet, unarchive, Show), and are
// kept live from there by `chat.state`.
//
// A roster `hydrate` replaces the whole store and drops the merged rows, so the
// fetch re-runs on every `rosterGeneration` bump while the list is wanted.
//
// NO FALLBACK: a failed fetch raises a toast; the section shows what the store
// already holds and says nothing it does not know.

import React from 'react';
import { api, type ChatListEntry } from '../api/rest';
import { useChatStore } from '../stores/chatStore';
import { useUiStore } from '../stores/uiStore';
import { toChatListRow } from './chatListRow';

function useLazySection(
  wanted: boolean,
  fetch: () => Promise<{ chats: ChatListEntry[] }>,
  what: string,
): void {
  const generation = useChatStore((s) => s.rosterGeneration);
  React.useEffect(() => {
    if (!wanted) return;
    let live = true;
    fetch()
      .then((r) => {
        if (live) useChatStore.getState().mergeRows(r.chats.map(toChatListRow));
      })
      .catch((e: Error) => {
        useUiStore.getState().pushError(`failed to load ${what} chats: ${e.message}`);
      });
    return () => {
      live = false;
    };
  }, [wanted, generation]);
}

export function useArchivedChats(wanted: boolean): void {
  useLazySection(wanted, () => api.listArchivedChats(), 'archived');
}

export function useHiddenChats(wanted: boolean): void {
  useLazySection(wanted, () => api.listHiddenChats(), 'hidden');
}
