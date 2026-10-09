// lib/chatListCache.ts + its wiring into chatStore (spec/15 § Instant open
// (read cache)).
//
// THE bug this covers: no mobile store persisted anything, so every launch
// started from an empty store and the Chats tab was blank until
// `GET /api/chats` answered. On a phone that reads as the app being slow to
// load. The roster is now mirrored to MMKV and the store is built from it
// synchronously at construction.
//
// The store is constructed at module import, so a test that needs a specific
// cache state on disk must seed MMKV, `vi.resetModules()`, and re-import.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ChatListRow } from '../src/stores/types';

function row(chatId: string, over: Partial<ChatListRow> = {}): ChatListRow {
  return {
    chatId,
    name: chatId.toUpperCase(),
    daemonId: 'd1',
    folder: '/w',
    activity: 'idle',
    permissionMode: 'auto',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    lastUpdated: 10,
    pendingWake: null,
    snoozedUntil: null,
    ...over,
  };
}

beforeEach(async () => {
  vi.resetModules();
  const { __clearAllMmkv: clear } = await import('./stubs/mmkv');
  clear();
});

describe('chatListCache', () => {
  it('round-trips the roster through MMKV', async () => {
    const { saveCachedChatList, loadCachedChatList } = await import('../src/lib/chatListCache');
    saveCachedChatList([row('c1'), row('c2', { pinned: true })]);
    const back = loadCachedChatList();
    expect(back.map((r) => r.chatId)).toEqual(['c1', 'c2']);
    expect(back[1]!.pinned).toBe(true);
  });

  it('returns an empty roster on a fresh install (nothing cached yet)', async () => {
    const { loadCachedChatList } = await import('../src/lib/chatListCache');
    expect(loadCachedChatList()).toEqual([]);
  });

  // NO SILENT FALLBACK. An unreadable cache must not crash the launch (it is a
  // disposable read-mirror) but it must not be swallowed either: it is reported
  // and the bad entry dropped so the next fetch writes a clean one.
  it('reports unreadable cache content and drops it, rather than throwing or hiding it', async () => {
    const { store, CHAT_LIST_KEY } = await import('../src/lib/credential');
    store().set(CHAT_LIST_KEY, '{not json');
    const { loadCachedChatList } = await import('../src/lib/chatListCache');
    const { useUiStore } = await import('../src/stores/uiStore');
    useUiStore.setState({ errors: [] });

    expect(loadCachedChatList()).toEqual([]);
    expect(useUiStore.getState().errors.map((e) => e.message)[0]).toContain(
      'chat list cache unreadable',
    );
    // Dropped, so a later read is a clean miss rather than a repeat error.
    expect(store().getString(CHAT_LIST_KEY)).toBeUndefined();
  });

  it('reports valid JSON that is not a roster array', async () => {
    const { store, CHAT_LIST_KEY } = await import('../src/lib/credential');
    store().set(CHAT_LIST_KEY, '{"chats":[]}');
    const { loadCachedChatList } = await import('../src/lib/chatListCache');
    const { useUiStore } = await import('../src/stores/uiStore');
    useUiStore.setState({ errors: [] });

    expect(loadCachedChatList()).toEqual([]);
    expect(useUiStore.getState().errors.map((e) => e.message)[0]).toContain('not an array');
  });

  // Deactivating a surface must not leave the previous account's chat titles on
  // disk to be painted on the next launch.
  it('clearCredential() clears the cached roster', async () => {
    const { saveCachedChatList, loadCachedChatList } = await import('../src/lib/chatListCache');
    const { saveCredential, clearCredential } = await import('../src/lib/credential');
    saveCredential('a.b.c');
    saveCachedChatList([row('c1')]);
    clearCredential();
    expect(loadCachedChatList()).toEqual([]);
  });
});

describe('chatStore — first paint comes from the cache, not the network', () => {
  it('is already populated at construction when a roster was cached', async () => {
    // Seed disk exactly as a previous launch would have left it...
    const { saveCachedChatList } = await import('../src/lib/chatListCache');
    saveCachedChatList([row('c1', { name: 'Alpha' }), row('c2', { name: 'Beta' })]);

    // ...then start the app fresh. MMKV persists across resetModules() the way
    // the real disk-backed store persists across a process restart.
    vi.resetModules();
    const { useChatStore } = await import('../src/stores/chatStore');

    // No hydrate() call, no api.listChats() — the rows are simply there.
    const chats = useChatStore.getState().chats;
    expect(Object.keys(chats).sort()).toEqual(['c1', 'c2']);
    expect(chats['c1']!.name).toBe('Alpha');
    // Expanded into full store rows, with the local/derived fields defaulted.
    expect(chats['c1']!.pendingPermissions).toEqual([]);
    expect(chats['c1']!.lastSeq).toBe(0);
    expect(chats['c1']!.preview).toBeNull();
  });

  it('starts empty on a fresh install', async () => {
    const { useChatStore } = await import('../src/stores/chatStore');
    expect(useChatStore.getState().chats).toEqual({});
  });

  // Timelines are deliberately NOT cached — a transcript is always loaded live,
  // so there is no stale-transcript failure mode.
  it('caches roster rows only, never message timelines', async () => {
    const { useChatStore } = await import('../src/stores/chatStore');
    useChatStore.getState().hydrate([row('c1')]);
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      seq: 1,
      role: 'assistant',
      content: 'a secret transcript line',
    } as never);
    expect(useChatStore.getState().timelines['c1']).toHaveLength(1);

    const { store, CHAT_LIST_KEY } = await import('../src/lib/credential');
    const raw = store().getString(CHAT_LIST_KEY)!;
    expect(raw).not.toContain('a secret transcript line');

    vi.resetModules();
    const { useChatStore: restarted } = await import('../src/stores/chatStore');
    expect(restarted.getState().chats['c1']).toBeTruthy();
    expect(restarted.getState().timelines).toEqual({});
  });
});

describe('chatStore — the roster fetch genuinely replaces the cache', () => {
  it('a chat deleted server-side does not survive the reconcile', async () => {
    const { saveCachedChatList } = await import('../src/lib/chatListCache');
    saveCachedChatList([row('stays'), row('deleted')]);
    vi.resetModules();
    const { useChatStore } = await import('../src/stores/chatStore');
    expect(Object.keys(useChatStore.getState().chats).sort()).toEqual(['deleted', 'stays']);

    // The roster fetch answers without it.
    useChatStore.getState().hydrate([row('stays')]);
    expect(Object.keys(useChatStore.getState().chats)).toEqual(['stays']);

    // And it must not come back on the NEXT launch either — the reconcile
    // rewrote the cache, it did not merge into it.
    vi.resetModules();
    const { useChatStore: relaunched } = await import('../src/stores/chatStore');
    expect(Object.keys(relaunched.getState().chats)).toEqual(['stays']);
  });

  it('a chat renamed server-side shows the new name after a relaunch', async () => {
    const { saveCachedChatList } = await import('../src/lib/chatListCache');
    saveCachedChatList([row('c1', { name: 'Old name' })]);
    vi.resetModules();
    const { useChatStore } = await import('../src/stores/chatStore');
    expect(useChatStore.getState().chats['c1']!.name).toBe('Old name');

    useChatStore.getState().hydrate([row('c1', { name: 'New name' })]);
    expect(useChatStore.getState().chats['c1']!.name).toBe('New name');

    vi.resetModules();
    const { useChatStore: relaunched } = await import('../src/stores/chatStore');
    expect(relaunched.getState().chats['c1']!.name).toBe('New name');
  });

  it('a chat deleted on THIS device does not reappear on the next launch', async () => {
    const { useChatStore } = await import('../src/stores/chatStore');
    useChatStore.getState().hydrate([row('keep'), row('gone')]);
    useChatStore.getState().removeChat('gone');

    vi.resetModules();
    const { useChatStore: relaunched } = await import('../src/stores/chatStore');
    expect(Object.keys(relaunched.getState().chats)).toEqual(['keep']);
  });

  it('_reset() clears the cached roster too', async () => {
    const { useChatStore } = await import('../src/stores/chatStore');
    useChatStore.getState().hydrate([row('c1')]);
    useChatStore.getState()._reset();

    vi.resetModules();
    const { useChatStore: relaunched } = await import('../src/stores/chatStore');
    expect(relaunched.getState().chats).toEqual({});
  });
});

// A stale cached row must not out-live the live stream either: the roster the
// cache paints is the LAST-SEEN state, and the WS is authoritative over it.
describe('chatStore — the live stream supersedes the cache', () => {
  it('a cached row is updated in place by chat.state, not duplicated', async () => {
    const { saveCachedChatList } = await import('../src/lib/chatListCache');
    saveCachedChatList([row('c1', { activity: 'running', name: 'Stale' })]);
    vi.resetModules();
    const { useChatStore } = await import('../src/stores/chatStore');

    useChatStore.getState().applyEvent({
      type: 'chat.state',
      chatId: 'c1',
      activity: 'idle',
      permissionMode: 'auto',
      folder: '/w',
      name: 'Fresh',
      lastUpdated: 99,
    } as never);

    expect(Object.keys(useChatStore.getState().chats)).toEqual(['c1']);
    expect(useChatStore.getState().chats['c1']!.activity).toBe('idle');
    expect(useChatStore.getState().chats['c1']!.name).toBe('Fresh');
  });
});

// Guard against the obvious perf own-goal: this cache exists to make launch
// faster, so it must not add a JSON.stringify to the hot WS path.
describe('chatListCache — not written on the live event path', () => {
  it('applyEvents does not rewrite the cache', async () => {
    const { useChatStore } = await import('../src/stores/chatStore');
    useChatStore.getState().hydrate([row('c1', { name: 'Cached name' })]);
    const { store, CHAT_LIST_KEY } = await import('../src/lib/credential');
    const before = store().getString(CHAT_LIST_KEY);

    useChatStore.getState().applyEvent({
      type: 'chat.state',
      chatId: 'c1',
      activity: 'running',
      permissionMode: 'auto',
      folder: '/w',
      name: 'Live name',
      lastUpdated: 50,
    } as never);

    expect(store().getString(CHAT_LIST_KEY)).toBe(before);
  });
});
