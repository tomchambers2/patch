// Chats tab (spec/15 ## Chats tab) — header, ManagerRow and ChannelRow. Pins:
//   - the slim header: wordmark, a connection dot coloured by the WS link
//     (none while first connecting), a search button — one fixed 44dp row
//   - no "Manager" section header over the Manager row
//   - ManagerRow: name fallback, tap → push, long-press → voice note 'hold',
//     onPressOut → release-if-held (mirrors the Voice tab long-press gesture)
//   - ChannelRow: label fallback per chatId (Speakers), read-only
//     badge, tap → push
//   - the Channels section empty state (no channels hydrated) and its
//     collapse/expand toggle
//
// Search + the items-memo section logic (pinned/folders/archived sort,
// collapse defaults and counts) are covered in the sibling chats.search.test.tsx
// / chats.sections.test.tsx files to keep each file focused.

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FlatList as RNFlatList } from 'react-native';
import {
  renderRN,
  findHost,
  findAllHost,
  queryHost,
  byLabel,
  byType,
  hasText,
  actSync,
} from './testUtils/render';
import ChatsScreen from '../app/(tabs)/chats';
import { useChatStore } from '../src/stores/chatStore';
import { usePresenceStore } from '../src/stores/presenceStore';
import { routerMock, __resetRouterMock } from './stubs/expo-router';
import { __clearAllMmkv } from './stubs/mmkv';
import { lightColors } from '../src/lib/theme';

const { startVoiceNoteSpy, releaseVoiceNoteIfHeldSpy } = vi.hoisted(() => ({
  startVoiceNoteSpy: vi.fn(),
  releaseVoiceNoteIfHeldSpy: vi.fn(),
}));
vi.mock('../src/lib/voiceNote', () => ({
  startVoiceNote: startVoiceNoteSpy,
  releaseVoiceNoteIfHeld: releaseVoiceNoteIfHeldSpy,
}));
const { startVoiceCallSpy } = vi.hoisted(() => ({ startVoiceCallSpy: vi.fn() }));
vi.mock('../src/lib/voiceCall', () => ({ startVoiceCall: startVoiceCallSpy }));
vi.mock('../src/api/rest', () => ({
  api: {
    chatSectionCounts: vi.fn().mockResolvedValue({
      archived: 0,
      snoozed: 0,
      hidden: 0,
      deleted: 0,
      automations: 0,
    }),
    listArchivedChats: vi.fn().mockResolvedValue({ chats: [] }),
    listHiddenChats: vi.fn().mockResolvedValue({ chats: [] }),
  },
}));

beforeEach(() => {
  __clearAllMmkv();
  useChatStore.getState()._reset();
  usePresenceStore.setState({
    connection: 'connecting',
    daemon: 'unknown',
    accountId: null,
    surfaceId: null,
  });
  __resetRouterMock();
  startVoiceNoteSpy.mockClear();
  releaseVoiceNoteIfHeldSpy.mockClear();
  startVoiceCallSpy.mockClear();
});

describe('ChatsScreen — header', () => {
  it('is one fixed 44dp row: the wordmark on the left, the search button on the right', () => {
    const r = renderRN(<ChatsScreen />);
    const header = findHost(r.root, (i) => i.props.testID === 'chats-header');
    expect((header.props.style as { height: number }).height).toBe(44);
    expect(hasText(header, 'patch')).toBe(true);
    expect(findHost(header, byLabel('Search chats'))).toBeDefined();
  });

  it('colours the dot by the WS link: green connected, amber reconnecting, red offline', () => {
    const expected = {
      connected: lightColors.leaf,
      reconnecting: lightColors.amber,
      offline: lightColors.red,
    } as const;
    for (const conn of ['connected', 'reconnecting', 'offline'] as const) {
      usePresenceStore.setState({ connection: conn });
      const r = renderRN(<ChatsScreen />);
      const dot = findHost(r.root, byLabel('connection state'));
      expect((dot.props.style as { backgroundColor: string }).backgroundColor).toBe(expected[conn]);
    }
  });

  it('draws no dot at all while the first connect is in flight', () => {
    usePresenceStore.setState({ connection: 'connecting' });
    const r = renderRN(<ChatsScreen />);
    expect(hasText(r.root, 'patch')).toBe(true);
    expect(queryHost(r.root, byLabel('connection state'))).toBeNull();
  });

  it('the search button swaps the wordmark for a search field; closing restores it', () => {
    const r = renderRN(<ChatsScreen />);
    expect(queryHost(r.root, byLabel('chats-search'))).toBeNull();
    actSync(() => findHost(r.root, byLabel('Search chats')).props.onPress());
    expect(findHost(r.root, byLabel('chats-search'))).toBeDefined();
    const header = findHost(r.root, (i) => i.props.testID === 'chats-header');
    expect(hasText(header, 'patch')).toBe(false);
    actSync(() => findHost(r.root, byLabel('Close search')).props.onPress());
    expect(queryHost(r.root, byLabel('chats-search'))).toBeNull();
    expect(hasText(r.root, 'patch')).toBe(true);
  });
});

describe('ChatsScreen — ManagerRow', () => {
  it('has no "Manager" section header above it — the row is the list\'s first item', () => {
    useChatStore.getState().hydrate([
      {
        chatId: 'thread_manager',
        name: 'My manager',
        folder: '',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        lastUpdated: 1,
      },
    ]);
    const r = renderRN(<ChatsScreen />);
    const texts = findAllHost(r.root, byType('Text')).map((t) => t.children[0]);
    expect(texts).not.toContain('Manager');
    const flatList = r.root.findByType(RNFlatList as unknown as React.ComponentType);
    expect((flatList.props.data as { kind: string }[])[0]?.kind).toBe('manager');
  });

  it('shows the row name when set, and falls back to "Manager" when null', () => {
    useChatStore.getState().hydrate([
      {
        chatId: 'thread_manager',
        name: 'My manager',
        folder: '',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        lastUpdated: 1,
      },
    ]);
    const r = renderRN(<ChatsScreen />);
    expect(hasText(r.root, 'My manager')).toBe(true);
  });

  it('falls back to "Manager" when the row has no name', () => {
    useChatStore.getState().hydrate([
      {
        chatId: 'thread_manager',
        name: null,
        folder: '',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        lastUpdated: 1,
      },
    ]);
    const r = renderRN(<ChatsScreen />);
    expect(hasText(r.root, 'Manager')).toBe(true);
  });

  it('tap pushes to the manager chat detail route', () => {
    useChatStore.getState().hydrate([
      {
        chatId: 'thread_manager',
        name: null,
        folder: '',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        lastUpdated: 1,
      },
    ]);
    const r = renderRN(<ChatsScreen />);
    findHost(r.root, byLabel('Open chat manager')).props.onPress();
    expect(routerMock.push).toHaveBeenCalledWith('/chats/thread_manager');
  });

  it('long-press starts a hold voice note targeting Manager, and release-out releases it', () => {
    useChatStore.getState().hydrate([
      {
        chatId: 'thread_manager',
        name: null,
        folder: '',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        lastUpdated: 1,
      },
    ]);
    const r = renderRN(<ChatsScreen />);
    const row = findHost(r.root, byLabel('Open chat manager'));
    actSync(() => row.props.onLongPress());
    expect(startVoiceNoteSpy).toHaveBeenCalledWith('thread_manager', 'hold');
    actSync(() => row.props.onPressOut());
    expect(releaseVoiceNoteIfHeldSpy).toHaveBeenCalledWith('thread_manager');
  });

  function seedManager(activity: 'idle' | 'running' = 'idle'): void {
    useChatStore.getState().hydrate([
      {
        chatId: 'thread_manager',
        name: null,
        folder: '',
        activity,
        status: 'active',
        pinned: false,
        pinnedAt: null,
        lastUpdated: 1,
      },
    ]);
  }

  it('is its own card: an avatar, and no Pin icon', () => {
    seedManager();
    const r = renderRN(<ChatsScreen />);
    const card = findHost(r.root, (i) => i.props.testID === 'manager-card');
    expect(queryHost(card, (i) => i.props.testID === 'manager-avatar')).not.toBeNull();
    expect(queryHost(card, (i) => i.type === 'Icon' && i.props.name === 'Pin')).toBeNull();
  });

  it('shows the Manager status', () => {
    seedManager('running');
    const r = renderRN(<ChatsScreen />);
    const status = findHost(r.root, (i) => i.props.testID === 'manager-status');
    expect(hasText(status, 'Working')).toBe(true);
  });

  it('Call starts a Manager call, and Hands-free a hands-free session', () => {
    seedManager();
    const r = renderRN(<ChatsScreen />);
    actSync(() => findHost(r.root, byLabel('Call Manager')).props.onPress());
    expect(startVoiceCallSpy).toHaveBeenCalledWith('thread_manager');
    actSync(() => findHost(r.root, byLabel('Hands-free with Manager')).props.onPress());
    expect(startVoiceCallSpy).toHaveBeenLastCalledWith('thread_manager', 'hands-free');
    expect(routerMock.push).not.toHaveBeenCalled();
  });

  // Fix (Patch Updates: "Talk sends a voice note to the current chat, not the
  // Manager"): the card's voice note gesture, Call and Hands-free all carry
  // the Manager's own chatId, never whichever chat is open elsewhere in the
  // app — matches the web sidebar's Manager block (spec/14 § Sidebar item 2).
  it('every Manager card voice control targets Manager, whatever chat is open', () => {
    useChatStore.getState().hydrate([
      { chatId: 'thread_manager', name: null, folder: '', activity: 'idle', status: 'active' },
      { chatId: 'other-chat', name: 'other', folder: '/x', activity: 'idle', status: 'active' },
    ]);
    useChatStore.getState().setActiveChat('other-chat');
    const r = renderRN(<ChatsScreen />);
    const card = findHost(r.root, byLabel('Open chat manager'));
    actSync(() => card.props.onLongPress());
    expect(startVoiceNoteSpy).toHaveBeenCalledWith('thread_manager', 'hold');
    actSync(() => findHost(r.root, byLabel('Call Manager')).props.onPress());
    expect(startVoiceCallSpy).toHaveBeenCalledWith('thread_manager');
    actSync(() => findHost(r.root, byLabel('Hands-free with Manager')).props.onPress());
    expect(startVoiceCallSpy).toHaveBeenLastCalledWith('thread_manager', 'hands-free');
  });
});

describe('ChatsScreen — ChannelRow', () => {
  it('labels a Speakers row "Speakers" when unnamed, with a read-only badge', () => {
    useChatStore.getState().hydrate([
      {
        chatId: 'thread_speakers',
        name: null,
        folder: '',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        lastUpdated: 1,
      },
    ]);
    const r = renderRN(<ChatsScreen />);
    expect(hasText(r.root, 'Speakers')).toBe(true);
    expect(hasText(r.root, 'read-only')).toBe(true);
  });

  it('shows a custom name when set', () => {
    useChatStore.getState().hydrate([
      {
        chatId: 'thread_speakers',
        name: 'Kitchen speaker',
        folder: '',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        lastUpdated: 1,
      },
    ]);
    const r = renderRN(<ChatsScreen />);
    expect(hasText(r.root, 'Kitchen speaker')).toBe(true);
  });

  it('tap pushes to the channel chat detail route', () => {
    useChatStore.getState().hydrate([
      {
        chatId: 'thread_speakers',
        name: null,
        folder: '',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        lastUpdated: 1,
      },
    ]);
    const r = renderRN(<ChatsScreen />);
    findHost(r.root, byLabel('Open channel Speakers')).props.onPress();
    expect(routerMock.push).toHaveBeenCalledWith('/chats/thread_speakers');
  });
});

describe('ChatsScreen — Channels section (empty state + collapse toggle)', () => {
  it('shows the channels empty state when expanded with no channel chats hydrated', () => {
    const r = renderRN(<ChatsScreen />);
    expect(hasText(r.root, 'Channels ▾')).toBe(true);
    expect(hasText(r.root, 'No channels yet')).toBe(true);
  });

  it('collapsing the Channels header hides the empty state, expanding again shows it', () => {
    const r = renderRN(<ChatsScreen />);
    // The header row is a Pressable wrapping the "Channels ▾/▸" Text — pick it
    // out by its text content rather than index (there are several headers).
    const headerPressable = (): ReturnType<typeof findHost> =>
      findAllHost(r.root, byType('Pressable')).find((p) => hasText(p, 'Channels'))!;
    actSync(() => headerPressable().props.onPress());
    expect(hasText(r.root, 'Channels ▸')).toBe(true);
    expect(hasText(r.root, 'No channels yet')).toBe(false);
    actSync(() => headerPressable().props.onPress());
    expect(hasText(r.root, 'Channels ▾')).toBe(true);
    expect(hasText(r.root, 'No channels yet')).toBe(true);
  });
});

describe('ChatsScreen — ListEmptyComponent wiring (never actually reached via FlatList: the section headers always keep `data` non-empty, but the element + its action are still wired for a hypothetical zero-item render)', () => {
  it('the FlatList ListEmptyComponent prop is an EmptyState wired to open /new-chat', () => {
    const r = renderRN(<ChatsScreen />);
    // The FlatList stub destructures ListEmptyComponent off the HOST node's
    // props (it's consumed internally), so it must be read off the composite
    // instance instead — exactly what chats.tsx actually passed in JSX.
    const flatListInstance = r.root.findByType(RNFlatList as unknown as React.ComponentType);
    const emptyEl = flatListInstance.props.ListEmptyComponent as React.ReactElement<{
      action: { onPress: () => void };
    }>;
    expect(emptyEl.props.action.onPress).toBeInstanceOf(Function);
    emptyEl.props.action.onPress();
    expect(routerMock.push).toHaveBeenCalledWith('/new-chat');
  });
});
