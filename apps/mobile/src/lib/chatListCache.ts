// The chat-list read cache (spec/15 § Instant open (read cache)). MMKV — the
// same store the credential uses.
//
// Without it every launch starts from an empty store and the Chats tab shows
// nothing until `GET /api/chats` answers, which on a phone is the whole
// "slow loading" experience: the app is up, the tab is on screen, and it is
// blank for as long as the network takes.
//
// SCOPE: roster rows only. Message timelines are never cached — a transcript is
// always loaded live, so there is no stale-transcript state to reason about.
//
// The cache is a read-mirror, never a source of truth. `chatStore.hydrate()`
// REPLACES the roster wholesale from the server's answer and rewrites the cache
// from that same answer, so a chat deleted or renamed elsewhere cannot survive
// here past the first fetch.

import { store, CHAT_LIST_KEY } from './credential';
import { useUiStore } from '../stores/uiStore';
import type { ChatListRow } from '../stores/types';

/**
 * The cached roster, or an empty list when there is nothing usable on disk.
 *
 * Runs synchronously at store-construction time, so it must not throw: a
 * launch-blocking crash over a disposable read-mirror would be a far worse
 * failure than the empty list it is protecting against. It is NOT silent
 * though (NO SILENT FALLBACK) — unreadable cache content is reported and the
 * bad entry dropped, so the next fetch rewrites a clean one.
 */
export function loadCachedChatList(): ChatListRow[] {
  const raw = store().getString(CHAT_LIST_KEY);
  if (raw === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('cached chat list is not an array');
    return parsed as ChatListRow[];
  } catch (e) {
    store().delete(CHAT_LIST_KEY);
    useUiStore.getState().pushError(`chat list cache unreadable: ${(e as Error).message}`);
    return [];
  }
}

/** Mirror the roster to disk for the next launch's first paint. */
export function saveCachedChatList(rows: ChatListRow[]): void {
  store().set(CHAT_LIST_KEY, JSON.stringify(rows));
}
