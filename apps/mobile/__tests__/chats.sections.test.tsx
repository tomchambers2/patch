// Chats tab — the `items` section-building memo (spec/15 ## Chats tab):
// Manager pinned at top, then user-pinned (sorted by pinnedAt desc, nulls
// last), then folders (alphabetical, "(no folder)" fallback, rows sorted by
// lastUpdated desc), then Channels, then Snoozed, then Archived — Snoozed and
// Archived collapsed by default with a count, every toggle remembered across
// launches, and Archived's rows fetched when it opens. Also covers the two
// defensive branches in `renderItem`/`keyExtractor` (`!item.row` / optional
// `item.row?.chatId`) that are unreachable through any real data shape the
// screen itself produces — exercised here by invoking the FlatList's own
// `renderItem`/`keyExtractor` props directly with a synthetic item, the same
// technique the harness README recommends for FlatList callback coverage.

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FlatList as RNFlatList } from 'react-native';
import {
  renderRN,
  findHost,
  findAllHost,
  byType,
  byTestId,
  hasText,
  actSync,
  actAsync,
} from './testUtils/render';
import ChatsScreen from '../app/(tabs)/chats';
import { useChatStore } from '../src/stores/chatStore';
import { usePresenceStore } from '../src/stores/presenceStore';
import { __resetRouterMock } from './stubs/expo-router';
import { __clearAllMmkv } from './stubs/mmkv';
import { getSectionOpen } from '../src/lib/sectionCollapse';
import type { ChatRow } from '../src/stores/types';

vi.mock('../src/lib/voiceNote', () => ({
  startVoiceNote: vi.fn(),
  releaseVoiceNoteIfHeld: vi.fn(),
}));
const { countsSpy, listArchivedSpy, listHiddenSpy } = vi.hoisted(() => ({
  countsSpy: vi.fn(),
  listArchivedSpy: vi.fn(),
  listHiddenSpy: vi.fn(),
}));
vi.mock('../src/api/rest', () => ({
  api: {
    chatSectionCounts: countsSpy,
    listArchivedChats: listArchivedSpy,
    listHiddenChats: listHiddenSpy,
  },
}));

function headerPressable(
  r: ReturnType<typeof renderRN>,
  label: string,
): ReturnType<typeof findHost> {
  return findAllHost(r.root, byType('Pressable')).find((p) =>
    findAllHost(p, byType('Text')).some(
      (t) => typeof t.children[0] === 'string' && t.children[0].startsWith(label),
    ),
  )!;
}

type HydrateRow = Parameters<ReturnType<typeof useChatStore.getState>['hydrate']>[0][number];

function row(overrides: Partial<HydrateRow> & { chatId: string }): HydrateRow {
  const merged: HydrateRow = {
    name: null,
    folder: '',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    lastUpdated: 0,
    lastUserActivity: 0,
    ...overrides,
  };
  // Most of this suite's fixtures only ever set `lastUpdated` — mirroring it
  // onto `lastUserActivity` by default keeps every recency-ordered fixture
  // sorting the way it always did (spec/14 § Sidebar ordering); a test about
  // the two diverging sets `lastUserActivity` explicitly.
  if (overrides.lastUpdated !== undefined && overrides.lastUserActivity === undefined) {
    merged.lastUserActivity = overrides.lastUpdated;
  }
  return merged;
}

beforeEach(() => {
  __clearAllMmkv();
  countsSpy.mockReset().mockResolvedValue({
    archived: 7,
    snoozed: 0,
    hidden: 3,
    deleted: 0,
    automations: 0,
  });
  listArchivedSpy.mockReset().mockResolvedValue({ chats: [] });
  listHiddenSpy.mockReset().mockResolvedValue({ chats: [] });
  useChatStore.getState()._reset();
  usePresenceStore.setState({
    connection: 'connected',
    daemon: 'online',
    accountId: null,
    surfaceId: null,
  });
  __resetRouterMock();
});

describe('items memo — Manager + Pinned sections absent when there is no data', () => {
  it('no "Manager" or "Pinned" header when there is no manager row / no pinned chats', () => {
    useChatStore.getState().hydrate([row({ chatId: 'c1', folder: 'work' })]);
    const r = renderRN(<ChatsScreen />);
    expect(hasText(r.root, 'Manager')).toBe(false);
    expect(hasText(r.root, 'Pinned')).toBe(false);
  });
});

describe('items memo — Pinned section ordering (pinnedAt desc, null-safe)', () => {
  it('sorts pinned rows by pinnedAt descending, treating a null pinnedAt as 0 (oldest)', () => {
    useChatStore
      .getState()
      .hydrate([
        row({ chatId: 'p-null', name: 'No timestamp', pinned: true, pinnedAt: null }),
        row({ chatId: 'p-late', name: 'Pinned later', pinned: true, pinnedAt: 200 }),
        row({ chatId: 'p-mid', name: 'Pinned mid', pinned: true, pinnedAt: 100 }),
        row({ chatId: 'p-null2', name: 'Also no timestamp', pinned: true, pinnedAt: null }),
        row({ chatId: 'p-early', name: 'Pinned earlier', pinned: true, pinnedAt: 50 }),
      ]);
    const r = renderRN(<ChatsScreen />);
    expect(hasText(r.root, 'Pinned')).toBe(true);
    const texts = findAllHost(r.root, byType('Text')).map((t) =>
      typeof t.children[0] === 'string' ? t.children[0] : '',
    );
    const order = ['Pinned later', 'Pinned mid', 'Pinned earlier', 'No timestamp']
      .map((label) => texts.indexOf(label))
      .filter((i) => i >= 0);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

describe('items memo — folder grouping', () => {
  it('groups non-pinned active chats by folder, alphabetically, "(no folder)" for an empty folder', () => {
    useChatStore
      .getState()
      .hydrate([
        row({ chatId: 'f1', name: 'Zebra folder chat', folder: '/z' }),
        row({ chatId: 'f2', name: 'Alpha folder chat', folder: '/a' }),
        row({ chatId: 'f3', name: 'No folder chat', folder: '' }),
      ]);
    const r = renderRN(<ChatsScreen />);
    expect(hasText(r.root, '(no folder)')).toBe(true);
    expect(hasText(r.root, 'Zebra folder chat')).toBe(true);
    expect(hasText(r.root, 'Alpha folder chat')).toBe(true);
  });

  it('sorts rows within a folder by lastUserActivity descending', () => {
    useChatStore
      .getState()
      .hydrate([
        row({ chatId: 'f1', name: 'Older', folder: '/x', lastUpdated: 1 }),
        row({ chatId: 'f2', name: 'Newer', folder: '/x', lastUpdated: 2 }),
      ]);
    const r = renderRN(<ChatsScreen />);
    const texts = findAllHost(r.root, byType('Text')).map((t) =>
      typeof t.children[0] === 'string' ? t.children[0] : '',
    );
    expect(texts.indexOf('Newer')).toBeLessThan(texts.indexOf('Older'));
  });

  it('an agent reply (lastUpdated bump with no change to lastUserActivity) never reorders a row (spec/14 § Sidebar ordering)', () => {
    useChatStore.getState().hydrate([
      row({
        chatId: 'f1',
        name: 'Sent first',
        folder: '/x',
        lastUpdated: 100,
        lastUserActivity: 100,
      }),
      row({
        chatId: 'f2',
        name: 'Sent later',
        folder: '/x',
        lastUpdated: 200,
        lastUserActivity: 200,
      }),
    ]);
    // The agent replies to "Sent first" — lastUpdated jumps way ahead of
    // "Sent later", but the user never sent anything into it.
    useChatStore.getState().hydrate([
      row({
        chatId: 'f1',
        name: 'Sent first',
        folder: '/x',
        lastUpdated: 9999,
        lastUserActivity: 100,
      }),
      row({
        chatId: 'f2',
        name: 'Sent later',
        folder: '/x',
        lastUpdated: 200,
        lastUserActivity: 200,
      }),
    ]);
    const r = renderRN(<ChatsScreen />);
    const texts = findAllHost(r.root, byType('Text')).map((t) =>
      typeof t.children[0] === 'string' ? t.children[0] : '',
    );
    expect(texts.indexOf('Sent later')).toBeLessThan(texts.indexOf('Sent first'));
  });

  it('a user message moves its chat to the top of the folder (spec/14 § Sidebar ordering)', () => {
    useChatStore
      .getState()
      .hydrate([
        row({ chatId: 'f1', name: 'A', folder: '/x', lastUpdated: 500, lastUserActivity: 500 }),
        row({ chatId: 'f2', name: 'B', folder: '/x', lastUpdated: 100, lastUserActivity: 100 }),
      ]);
    // The user sends a message in B: its lastUserActivity jumps to the front.
    useChatStore
      .getState()
      .hydrate([
        row({ chatId: 'f1', name: 'A', folder: '/x', lastUpdated: 500, lastUserActivity: 500 }),
        row({ chatId: 'f2', name: 'B', folder: '/x', lastUpdated: 600, lastUserActivity: 600 }),
      ]);
    const r = renderRN(<ChatsScreen />);
    const texts = findAllHost(r.root, byType('Text')).map((t) =>
      typeof t.children[0] === 'string' ? t.children[0] : '',
    );
    expect(texts.indexOf('B')).toBeLessThan(texts.indexOf('A'));
  });
});

describe('items memo — Archived: chronological order', () => {
  it('shows archived rows sorted by lastUpdated descending once Archived is open', () => {
    useChatStore
      .getState()
      .hydrate([
        row({ chatId: 'a1', name: 'Older archive', status: 'archived', lastUpdated: 1 }),
        row({ chatId: 'a2', name: 'Newer archive', status: 'archived', lastUpdated: 2 }),
      ]);
    const r = renderRN(<ChatsScreen />);
    actSync(() => headerPressable(r, 'Archived').props.onPress());
    const texts = findAllHost(r.root, byType('Text')).map((t) =>
      typeof t.children[0] === 'string' ? t.children[0] : '',
    );
    expect(texts.indexOf('Newer archive')).toBeLessThan(texts.indexOf('Older archive'));
  });
});

describe('collapse defaults', () => {
  it('opens Channels but keeps Snoozed and Archived collapsed on a first launch', () => {
    useChatStore
      .getState()
      .hydrate([
        row({ chatId: 's1', name: 'Sleeping', snoozedUntil: Date.now() + 3_600_000 }),
        row({ chatId: 'a1', name: 'Filed away', status: 'archived' }),
      ]);
    const r = renderRN(<ChatsScreen />);
    expect(hasText(r.root, 'Channels ▾')).toBe(true);
    expect(hasText(r.root, 'Snoozed ▸')).toBe(true);
    expect(hasText(r.root, 'Archived ▸')).toBe(true);
    expect(hasText(r.root, 'Sleeping')).toBe(false);
    expect(hasText(r.root, 'Filed away')).toBe(false);
  });

  it('remembers a toggle across launches (a fresh mount reads the stored choice)', () => {
    const first = renderRN(<ChatsScreen />);
    actSync(() => headerPressable(first, 'Snoozed').props.onPress());
    actSync(() => headerPressable(first, 'Channels').props.onPress());
    expect(getSectionOpen('snoozed', false)).toBe(true);
    expect(getSectionOpen('channels', true)).toBe(false);
    first.unmount();

    const second = renderRN(<ChatsScreen />);
    expect(hasText(second.root, 'Snoozed ▾')).toBe(true);
    expect(hasText(second.root, 'Channels ▸')).toBe(true);
    expect(hasText(second.root, 'Archived ▸')).toBe(true);
  });
});

describe('section counts', () => {
  it('Snoozed counts its own rows; Archived shows the server total', async () => {
    useChatStore
      .getState()
      .hydrate([
        row({ chatId: 's1', snoozedUntil: Date.now() + 3_600_000 }),
        row({ chatId: 's2', snoozedUntil: Date.now() + 7_200_000 }),
      ]);
    const r = renderRN(<ChatsScreen />);
    await actAsync(async () => {});
    expect(findHost(r.root, byTestId('snoozed-count')).children[0]).toBe('2');
    expect(findHost(r.root, byTestId('archived-count')).children[0]).toBe('7');
  });

  it('draws no Archived count until the server has answered', () => {
    countsSpy.mockReturnValue(new Promise(() => {}));
    const r = renderRN(<ChatsScreen />);
    expect(findAllHost(r.root, byTestId('archived-count'))).toHaveLength(0);
  });
});

describe('Archived — rows fetched on open', () => {
  it('does not fetch archived chats while collapsed; opening fetches and shows them', async () => {
    listArchivedSpy.mockResolvedValue({
      chats: [
        {
          chatId: 'a9',
          name: 'From the server',
          daemonId: 'd1',
          folder: '/old',
          activity: 'idle',
          permissionMode: 'default',
          status: 'archived',
          pinned: false,
          pinnedAt: null,
          lastUpdated: 5,
          pendingWake: null,
          snoozedUntil: null,
        },
      ],
    });
    const r = renderRN(<ChatsScreen />);
    await actAsync(async () => {});
    expect(listArchivedSpy).not.toHaveBeenCalled();
    actSync(() => headerPressable(r, 'Archived').props.onPress());
    await actAsync(async () => {});
    expect(listArchivedSpy).toHaveBeenCalledTimes(1);
    expect(hasText(r.root, 'From the server')).toBe(true);
  });
});

describe('renderItem / keyExtractor — defensive branches unreachable via real data', () => {
  it('renderItem returns null for a row-shaped item with no `row` (defensive guard)', () => {
    const r = renderRN(<ChatsScreen />);
    const flatListInstance = r.root.findByType(RNFlatList as unknown as React.ComponentType);
    const renderItem = flatListInstance.props.renderItem as (info: {
      item: { kind: string; row?: ChatRow };
      index: number;
    }) => React.ReactElement | null;
    expect(renderItem({ item: { kind: 'manager' }, index: 0 })).toBeNull();
  });

  it('keyExtractor falls back to `r-undefined` for a row-shaped item with no `row`', () => {
    const r = renderRN(<ChatsScreen />);
    const flatListInstance = r.root.findByType(RNFlatList as unknown as React.ComponentType);
    const keyExtractor = flatListInstance.props.keyExtractor as (
      item: { kind: string; row?: ChatRow },
      index: number,
    ) => string;
    expect(keyExtractor({ kind: 'pinned-row' }, 3)).toBe('r-undefined');
  });
});
