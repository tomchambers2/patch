// Chats tab — the Hidden section (spec/15 ## Chats tab, spec/04 § Hidden).
//
// A hidden chat is running but out of the active list: drawn in Hidden and
// nowhere else. Like Archived, it is left out of the cold-start roster, so the
// header's count is the server's total and opening the section fetches the
// list (`?hidden=only`); `chat.state` keeps it live from there. Show moves a
// chat back into the active list.

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
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
import { useUiStore } from '../src/stores/uiStore';
import { __resetRouterMock } from './stubs/expo-router';
import { __clearAllMmkv } from './stubs/mmkv';
import { getSectionOpen, setSectionOpen } from '../src/lib/sectionCollapse';

vi.mock('../src/lib/voiceNote', () => ({
  startVoiceNote: vi.fn(),
  releaseVoiceNoteIfHeld: vi.fn(),
}));
const { countsSpy, listHiddenSpy, hideChatSpy } = vi.hoisted(() => ({
  countsSpy: vi.fn(),
  listHiddenSpy: vi.fn(),
  hideChatSpy: vi.fn(),
}));
vi.mock('../src/api/rest', () => ({
  api: {
    chatSectionCounts: countsSpy,
    listArchivedChats: vi.fn().mockResolvedValue({ chats: [] }),
    listHiddenChats: listHiddenSpy,
    hideChat: hideChatSpy,
  },
}));

type HydrateRow = Parameters<ReturnType<typeof useChatStore.getState>['hydrate']>[0][number];

function row(overrides: Partial<HydrateRow> & { chatId: string }): HydrateRow {
  return {
    name: null,
    folder: '',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    lastUpdated: 0,
    snoozedUntil: null,
    ...overrides,
  };
}

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

function titleCount(r: ReturnType<typeof renderRN>, title: string): number {
  return findAllHost(r.root, byType('Text')).filter((t) => t.children[0] === title).length;
}

/** Index of the first Text reading exactly `text`, for ordering checks. */
function indexOfText(r: ReturnType<typeof renderRN>, text: string): number {
  return findAllHost(r.root, byType('Text')).findIndex((t) => t.children[0] === text);
}

const SERVER_HIDDEN = {
  chatId: 'h9',
  name: 'Background run',
  daemonId: 'd1',
  folder: '/jobs',
  activity: 'running',
  permissionMode: 'default',
  status: 'active',
  pinned: false,
  pinnedAt: null,
  lastUpdated: 5,
  pendingWake: null,
  snoozedUntil: null,
  hidden: true,
} as const;

beforeEach(() => {
  __clearAllMmkv();
  countsSpy.mockReset().mockResolvedValue({
    archived: 0,
    snoozed: 0,
    hidden: 4,
    deleted: 0,
    automations: 0,
  });
  listHiddenSpy.mockReset().mockResolvedValue({ chats: [] });
  hideChatSpy.mockReset().mockResolvedValue({ ok: true });
  useChatStore.getState()._reset();
  useUiStore.setState({ errors: [] });
  usePresenceStore.setState({
    connection: 'connected',
    daemon: 'online',
    accountId: null,
    surfaceId: null,
  });
  __resetRouterMock();
});

describe('Hidden section — header', () => {
  it('sits between Channels and Snoozed, collapsed by default, with the server count', async () => {
    const r = renderRN(<ChatsScreen />);
    await actAsync(async () => {});
    expect(hasText(r.root, 'Hidden ▸')).toBe(true);
    const channels = indexOfText(r, 'Channels ▾');
    const hidden = indexOfText(r, 'Hidden ▸');
    const snoozed = indexOfText(r, 'Snoozed ▸');
    expect(channels).toBeLessThan(hidden);
    expect(hidden).toBeLessThan(snoozed);
    expect(findHost(r.root, byTestId('hidden-count')).children[0]).toBe('4');
  });

  it('draws no count until the server has answered', () => {
    countsSpy.mockReturnValue(new Promise(() => {}));
    const r = renderRN(<ChatsScreen />);
    expect(findAllHost(r.root, byTestId('hidden-count'))).toHaveLength(0);
  });

  it('a counts answer without `hidden` is an error, not a zero', async () => {
    countsSpy.mockResolvedValue({ archived: 1, snoozed: 0, deleted: 0, automations: 0 });
    const r = renderRN(<ChatsScreen />);
    await actAsync(async () => {});
    expect(findAllHost(r.root, byTestId('hidden-count'))).toHaveLength(0);
    expect(
      useUiStore.getState().errors.some((e) => e.message.startsWith('failed to load section')),
    ).toBe(true);
  });

  it('remembers being opened across launches', () => {
    const first = renderRN(<ChatsScreen />);
    actSync(() => headerPressable(first, 'Hidden').props.onPress());
    expect(getSectionOpen('hidden', false)).toBe(true);
    first.unmount();
    const second = renderRN(<ChatsScreen />);
    expect(hasText(second.root, 'Hidden ▾')).toBe(true);
  });
});

describe('Hidden section — rows', () => {
  it('does not fetch while collapsed; opening fetches ?hidden=only and lists the rows', async () => {
    listHiddenSpy.mockResolvedValue({ chats: [SERVER_HIDDEN] });
    const r = renderRN(<ChatsScreen />);
    await actAsync(async () => {});
    expect(listHiddenSpy).not.toHaveBeenCalled();
    actSync(() => headerPressable(r, 'Hidden').props.onPress());
    await actAsync(async () => {});
    expect(listHiddenSpy).toHaveBeenCalledTimes(1);
    expect(titleCount(r, 'Background run')).toBe(1);
    // Drawn under Hidden, not under its folder.
    expect(hasText(r.root, '/jobs')).toBe(false);
  });

  it('a failed fetch raises a toast', async () => {
    listHiddenSpy.mockRejectedValue(new Error('boom'));
    setSectionOpen('hidden', true);
    renderRN(<ChatsScreen />);
    await actAsync(async () => {});
    expect(useUiStore.getState().errors.map((e) => e.message)).toContain(
      'failed to load hidden chats: boom',
    );
  });

  it('a hidden chat leaves Pinned, its folder and Snoozed — drawn once, in Hidden', () => {
    setSectionOpen('hidden', true);
    setSectionOpen('snoozed', true);
    useChatStore.getState().hydrate([
      row({
        chatId: 'h1',
        name: 'Quiet job',
        folder: '/work',
        pinned: true,
        pinnedAt: 1,
        snoozedUntil: Date.now() + 3_600_000,
        hidden: true,
      }),
      row({ chatId: 'c1', name: 'Ordinary', folder: '/work' }),
    ]);
    const r = renderRN(<ChatsScreen />);
    expect(hasText(r.root, 'Pinned')).toBe(false);
    expect(titleCount(r, 'Quiet job')).toBe(1);
    expect(hasText(findHost(r.root, byTestId('snoozed-section')), 'Quiet job')).toBe(false);
    expect(indexOfText(r, 'Quiet job')).toBeGreaterThan(indexOfText(r, 'Hidden ▾'));
    expect(indexOfText(r, 'Quiet job')).toBeLessThan(indexOfText(r, 'Snoozed ▾'));
  });

  it('an archived chat that keeps the flag is drawn in Archived, not Hidden', () => {
    setSectionOpen('hidden', true);
    setSectionOpen('archived', true);
    useChatStore
      .getState()
      .mergeRows([row({ chatId: 'a1', name: 'Stopped run', status: 'archived', hidden: true })]);
    const r = renderRN(<ChatsScreen />);
    expect(titleCount(r, 'Stopped run')).toBe(1);
    expect(indexOfText(r, 'Stopped run')).toBeGreaterThan(indexOfText(r, 'Archived ▾'));
  });

  it('chat.state keeps it live: hidden:true moves a chat in, hidden:false moves it out', () => {
    setSectionOpen('hidden', true);
    useChatStore.getState().hydrate([row({ chatId: 'c1', name: 'Job run', folder: '/work' })]);
    const r = renderRN(<ChatsScreen />);
    const state = (hidden: boolean): void =>
      actSync(() =>
        useChatStore.getState().applyEvent({
          type: 'chat.state',
          chatId: 'c1',
          activity: 'running',
          permissionMode: 'default',
          lastUpdated: 10,
          hidden,
        } as never),
      );
    expect(hasText(r.root, '/work')).toBe(true);
    state(true);
    expect(hasText(r.root, '/work')).toBe(false);
    expect(indexOfText(r, 'Job run')).toBeGreaterThan(indexOfText(r, 'Hidden ▾'));
    state(false);
    expect(hasText(r.root, '/work')).toBe(true);
    expect(indexOfText(r, 'Job run')).toBeLessThan(indexOfText(r, 'Hidden ▾'));
  });

  it('a chat.state that omits `hidden` leaves it hidden', () => {
    useChatStore.getState().hydrate([row({ chatId: 'c1', hidden: true })]);
    useChatStore.getState().applyEvent({
      type: 'chat.state',
      chatId: 'c1',
      activity: 'idle',
      permissionMode: 'default',
      lastUpdated: 10,
    } as never);
    expect(useChatStore.getState().chats['c1']?.hidden).toBe(true);
  });
});

describe('Hidden section — Show', () => {
  function renderWithHidden(): ReturnType<typeof renderRN> {
    setSectionOpen('hidden', true);
    useChatStore
      .getState()
      .hydrate([row({ chatId: 'h1', name: 'Quiet job', folder: '/work', hidden: true })]);
    return renderRN(<ChatsScreen />);
  }

  it("Show is on the hidden row's swipe tray in Pin's place, and moves the chat into its folder", async () => {
    const r = renderWithHidden();
    const tray = findHost(r.root, byTestId('swipe-tray-left'));
    expect(findAllHost(tray, (i) => i.props['accessibilityLabel'] === 'Pin chat').length).toBe(0);
    actSync(() =>
      findHost(tray, (i) => i.props['accessibilityLabel'] === 'Show chat').props['onPress'](),
    );
    await actAsync(async () => {});
    expect(hideChatSpy).toHaveBeenCalledWith('h1', false);
    expect(useChatStore.getState().chats['h1']?.hidden).toBe(false);
    expect(hasText(r.root, '/work')).toBe(true);
  });

  it('a refused Show puts the chat back in Hidden and raises a toast', async () => {
    hideChatSpy.mockRejectedValue(new Error('no such chat'));
    const r = renderWithHidden();
    const tray = findHost(r.root, byTestId('swipe-tray-left'));
    actSync(() =>
      findHost(tray, (i) => i.props['accessibilityLabel'] === 'Show chat').props['onPress'](),
    );
    await actAsync(async () => {});
    expect(useChatStore.getState().chats['h1']?.hidden).toBe(true);
    expect(hasText(r.root, '/work')).toBe(false);
    expect(useUiStore.getState().errors.map((e) => e.message)).toContain(
      'show failed: no such chat',
    );
  });

  it("an ordinary row's tray keeps Pin and offers no Show", () => {
    useChatStore.getState().hydrate([row({ chatId: 'c1', name: 'Ordinary', folder: '/work' })]);
    const r = renderRN(<ChatsScreen />);
    const tray = findHost(r.root, byTestId('swipe-tray-left'));
    expect(
      findAllHost(tray, (i) => i.props['accessibilityLabel'] === 'Pin chat').length,
    ).toBeGreaterThan(0);
    expect(findAllHost(tray, (i) => i.props['accessibilityLabel'] === 'Show chat')).toHaveLength(0);
  });
});

describe('Hidden section — search', () => {
  it('a one-character query searches the hidden rows too, under a plain Hidden label', async () => {
    listHiddenSpy.mockResolvedValue({ chats: [SERVER_HIDDEN] });
    const r = renderRN(<ChatsScreen />);
    await actAsync(async () => {});
    actSync(() =>
      findHost(r.root, (i) => i.props['accessibilityLabel'] === 'Search chats').props['onPress'](),
    );
    await actAsync(async () => {});
    expect(listHiddenSpy).toHaveBeenCalledTimes(1);
    actSync(() => findHost(r.root, byType('TextInput')).props.onChangeText('B'));
    expect(hasText(r.root, 'Hidden')).toBe(true);
    expect(hasText(r.root, 'Background run')).toBe(true);
  });
});
