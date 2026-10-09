// Chats tab — the Snoozed section (spec/15 ## Chats tab §6, spec/04 § Snooze).
//
// A snoozed chat is drawn in the Snoozed section and NOWHERE else: it leaves
// the Pinned and folder sections until its wake time passes, then returns on
// its own with no event needed — every check here is against the clock, which
// is what a phone that was asleep through the wake time depends on.
//
// The section is collapsed by default (chats.sections.test.tsx); these tests
// store it open first, as a user who had opened it would find it.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderRN, findHost, findAllHost, byType, byTestId, hasText } from './testUtils/render';
import ChatsScreen from '../app/(tabs)/chats';
import { useChatStore } from '../src/stores/chatStore';
import { usePresenceStore } from '../src/stores/presenceStore';
import { __resetRouterMock } from './stubs/expo-router';
import { __clearAllMmkv } from './stubs/mmkv';
import { setSectionOpen } from '../src/lib/sectionCollapse';
import { formatWakeTimeCompact } from '../src/lib/snooze';

vi.mock('../src/lib/voiceNote', () => ({
  startVoiceNote: vi.fn(),
  releaseVoiceNoteIfHeld: vi.fn(),
}));
const { snoozeChatSpy } = vi.hoisted(() => ({
  snoozeChatSpy: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/api/rest', () => ({
  api: {
    snoozeChat: snoozeChatSpy,
    chatSectionCounts: vi
      .fn()
      .mockResolvedValue({ archived: 0, snoozed: 0, hidden: 0, deleted: 0, automations: 0 }),
    listArchivedChats: vi.fn().mockResolvedValue({ chats: [] }),
    listHiddenChats: vi.fn().mockResolvedValue({ chats: [] }),
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

const NOW = new Date('2026-08-25T10:00:00Z').getTime();
const IN_AN_HOUR = NOW + 60 * 60_000;
const AN_HOUR_AGO = NOW - 60 * 60_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  __clearAllMmkv();
  setSectionOpen('snoozed', true);
  useChatStore.getState()._reset();
  usePresenceStore.setState({
    connection: 'connected',
    daemon: 'online',
    accountId: null,
    surfaceId: null,
  });
  __resetRouterMock();
  snoozeChatSpy.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Snoozed section — membership', () => {
  it('draws a snoozed chat under Snoozed and takes it out of its folder', () => {
    useChatStore
      .getState()
      .hydrate([
        row({ chatId: 'c1', name: 'Sleeping chat', folder: '/work', snoozedUntil: IN_AN_HOUR }),
        row({ chatId: 'c2', name: 'Awake chat', folder: '/work' }),
      ]);
    const r = renderRN(<ChatsScreen />);

    expect(hasText(r.root, 'Snoozed')).toBe(true);
    const section = findHost(r.root, byTestId('snoozed-section'));
    expect(hasText(section, 'Sleeping chat')).toBe(true);
    // Drawn exactly once overall — not in the folder as well.
    const titles = findAllHost(r.root, byType('Text'))
      .map((t) => (typeof t.children[0] === 'string' ? t.children[0] : ''))
      .filter((t) => t === 'Sleeping chat');
    expect(titles).toHaveLength(1);
    expect(hasText(section, 'Awake chat')).toBe(false);
  });

  it('takes a snoozed chat out of the Pinned section too', () => {
    useChatStore
      .getState()
      .hydrate([
        row({ chatId: 'p1', name: 'Sleepy favourite', pinned: true, snoozedUntil: IN_AN_HOUR }),
      ]);
    const r = renderRN(<ChatsScreen />);
    // The Pinned header is gone entirely: its only member is asleep.
    expect(hasText(r.root, 'Pinned')).toBe(false);
    expect(hasText(findHost(r.root, byTestId('snoozed-section')), 'Sleepy favourite')).toBe(true);
  });

  it('a lapsed snoozedUntil puts the chat straight back in its folder, with no event', () => {
    useChatStore
      .getState()
      .hydrate([
        row({ chatId: 'c1', name: 'Woken chat', folder: '/work', snoozedUntil: AN_HOUR_AGO }),
      ]);
    const r = renderRN(<ChatsScreen />);
    expect(hasText(findHost(r.root, byTestId('snoozed-section')), 'Woken chat')).toBe(false);
    expect(hasText(r.root, '/work')).toBe(true);
    expect(hasText(r.root, 'Woken chat')).toBe(true);
  });

  it('shows the snooze empty state when nothing is snoozed', () => {
    useChatStore.getState().hydrate([row({ chatId: 'c1', name: 'Awake chat', folder: '/work' })]);
    const r = renderRN(<ChatsScreen />);
    expect(hasText(r.root, 'Nothing snoozed')).toBe(true);
  });
});

describe('Snoozed section — row controls', () => {
  it('shows the wake time compactly in the row, with no extra line under it', () => {
    useChatStore
      .getState()
      .hydrate([row({ chatId: 'c1', name: 'Sleeping chat', snoozedUntil: IN_AN_HOUR })]);
    const r = renderRN(<ChatsScreen />);
    const section = findHost(r.root, byTestId('snoozed-section'));
    const slot = findHost(section, byTestId('wake-time-c1'));
    expect(hasText(slot, formatWakeTimeCompact(IN_AN_HOUR))).toBe(true);
    // The old second line ("Snoozed until …" + an inline Unsnooze) is gone.
    expect(hasText(section, 'Snoozed until')).toBe(false);
    expect(hasText(section, 'Unsnooze')).toBe(false);
  });

  it("Unsnooze stays on the row's swipe tray, and clears the snooze locally and on the server", () => {
    useChatStore
      .getState()
      .hydrate([
        row({ chatId: 'c1', name: 'Sleeping chat', folder: '/work', snoozedUntil: IN_AN_HOUR }),
      ]);
    const r = renderRN(<ChatsScreen />);
    const tray = findHost(r.root, byTestId('swipe-tray-left'));
    findHost(tray, (i) => i.props['accessibilityLabel'] === 'Unsnooze chat').props['onPress']();

    expect(snoozeChatSpy).toHaveBeenCalledWith('c1', null);
    expect(useChatStore.getState().chats['c1']?.snoozedUntil).toBeNull();
  });
});
