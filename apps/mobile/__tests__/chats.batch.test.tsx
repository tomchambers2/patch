// Chats tab — the view dropdown (spec/15 § Chats tab; mirrors web's
// `SidebarViewMenu`), the Batch view, and the Unread option (spec/15 § Needs
// attention; § Batch view). Exercises the UI end-to-end through the real
// ChatsScreen: picking a view, starting/removing a batch member, and the
// Unread filter's FIFO ordering + the "held row" release-on-navigate rule.

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  renderRN,
  update,
  findHost,
  findAllHost,
  byType,
  byTestId,
  hasText,
  actSync,
} from './testUtils/render';
import ChatsScreen from '../app/(tabs)/chats';
import { useChatStore } from '../src/stores/chatStore';
import { useBatchStore } from '../src/stores/batchStore';
import { useUiStore } from '../src/stores/uiStore';
import { usePresenceStore } from '../src/stores/presenceStore';
import { __resetRouterMock } from './stubs/expo-router';
import { __clearAllMmkv } from './stubs/mmkv';
import type { BatchResponse } from '../src/api/rest';

vi.mock('../src/lib/voiceNote', () => ({
  startVoiceNote: vi.fn(),
  releaseVoiceNoteIfHeld: vi.fn(),
}));
vi.mock('../src/lib/voiceCall', () => ({ startVoiceCall: vi.fn() }));
const {
  archiveChatSpy,
  pinChatSpy,
  deleteChatSpy,
  snoozeChatSpy,
  startBatchSpy,
  removeBatchMemberSpy,
} = vi.hoisted(() => ({
  archiveChatSpy: vi.fn().mockResolvedValue(undefined),
  pinChatSpy: vi.fn().mockResolvedValue(undefined),
  deleteChatSpy: vi.fn().mockResolvedValue(undefined),
  snoozeChatSpy: vi.fn().mockResolvedValue(undefined),
  startBatchSpy: vi.fn().mockResolvedValue({ batch: null, carryover: [] }),
  removeBatchMemberSpy: vi.fn().mockResolvedValue({ batch: null, carryover: [] }),
}));
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
    archiveChat: archiveChatSpy,
    pinChat: pinChatSpy,
    deleteChat: deleteChatSpy,
    snoozeChat: snoozeChatSpy,
    getBatch: vi.fn().mockResolvedValue({ batch: null, carryover: [] }),
    startBatch: startBatchSpy,
    removeBatchMember: removeBatchMemberSpy,
    checkInBatchNow: vi.fn(),
    markBatchOpened: vi.fn(),
  },
}));

function batchRecord(
  over: Partial<BatchResponse['batch']> = {},
): NonNullable<BatchResponse['batch']> {
  return {
    id: 'b1',
    startedAt: 0,
    checkIn: { type: 'time', minutes: 20 },
    checkInAt: 20 * 60_000,
    members: [],
    checkedIn: false,
    openedMemberIds: [],
    ...over,
  };
}

type HydrateRow = Parameters<ReturnType<typeof useChatStore.getState>['hydrate']>[0][number];

function row(overrides: Partial<HydrateRow> & { chatId: string }): HydrateRow {
  return {
    name: overrides.chatId,
    folder: 'work',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    lastUpdated: 0,
    ...overrides,
  };
}

// The view dropdown is an OptionPicker: closed by default, showing only the
// current selection's label. A test opens it by pressing the trigger pill,
// then presses the option it wants — the same two-step interaction a real tap
// does (mirrors the job editor's own OptionPicker-driving tests).
function openViewMenu(r: ReturnType<typeof renderRN>): void {
  findHost(r.root, byTestId('chats-view-menu')).props['onPress']();
}
function selectView(r: ReturnType<typeof renderRN>, value: string): void {
  openViewMenu(r);
  findHost(r.root, byTestId(`chats-view-menu-option-${value}`)).props['onPress']();
}

beforeEach(() => {
  __clearAllMmkv();
  useChatStore.getState()._reset();
  useBatchStore.getState()._reset();
  useUiStore.setState({ attentionOnly: false, stateFilter: 'all' });
  usePresenceStore.setState({
    connection: 'connected',
    daemon: 'online',
    accountId: null,
    surfaceId: null,
  });
  __resetRouterMock();
});

describe('Chats tab view dropdown', () => {
  it('reads "All chats" by default, and lists every option when opened', () => {
    const r = renderRN(<ChatsScreen />);
    expect(hasText(findHost(r.root, byTestId('chats-view-menu')), 'All chats')).toBe(true);
    openViewMenu(r);
    for (const v of ['all', 'unread', 'working', 'waiting', 'failed', 'batch']) {
      expect(findHost(r.root, byTestId(`chats-view-menu-option-${v}`))).toBeDefined();
    }
  });

  it('the old Chats/Batch tabs and standalone attention toggle are gone', () => {
    const r = renderRN(<ChatsScreen />);
    expect(() => findHost(r.root, byTestId('chats-tab-regular'))).toThrow();
    expect(() => findHost(r.root, byTestId('chats-tab-batch'))).toThrow();
    expect(() => findHost(r.root, byTestId('attention-toggle'))).toThrow();
  });

  it('shows a non-zero count on Batch once the server reports a member', () => {
    useChatStore.getState().hydrate([row({ chatId: 'a' })]);
    useBatchStore.setState({ batch: batchRecord({ members: ['a'] }), loaded: true });
    const r = renderRN(<ChatsScreen />);
    openViewMenu(r);
    expect(hasText(findHost(r.root, byTestId('chats-view-menu-option-batch')), '1')).toBe(true);
  });

  it('picking Batch swaps the column for BatchView; picking All swaps back', () => {
    const r = renderRN(<ChatsScreen />);
    expect(() => findHost(r.root, byTestId('batch-view'))).toThrow();
    selectView(r, 'batch');
    expect(findHost(r.root, byTestId('batch-view'))).toBeDefined();
    expect(useBatchStore.getState().mode).toBe('batch');
    selectView(r, 'all');
    expect(() => findHost(r.root, byTestId('batch-view'))).toThrow();
    expect(useBatchStore.getState().mode).toBe('regular');
  });

  it('picking Unread sets attentionOnly and clears any state filter/batch mode', () => {
    useUiStore.setState({ stateFilter: 'working' });
    const r = renderRN(<ChatsScreen />);
    selectView(r, 'unread');
    expect(useUiStore.getState().attentionOnly).toBe(true);
    expect(useUiStore.getState().stateFilter).toBe('all');
    expect(useBatchStore.getState().mode).toBe('regular');
  });

  it.each(['working', 'waiting', 'failed'] as const)(
    'picking %s sets the state filter and clears Unread/batch',
    (value) => {
      useUiStore.setState({ attentionOnly: true });
      const r = renderRN(<ChatsScreen />);
      selectView(r, value);
      expect(useUiStore.getState().stateFilter).toBe(value);
      expect(useUiStore.getState().attentionOnly).toBe(false);
      expect(useBatchStore.getState().mode).toBe('regular');
    },
  );

  it('persists the choice across a remount', () => {
    const r = renderRN(<ChatsScreen />);
    selectView(r, 'failed');
    update(r, <></>);
    const r2 = renderRN(<ChatsScreen />);
    expect(hasText(findHost(r2.root, byTestId('chats-view-menu')), 'Failed')).toBe(true);
  });
});

describe('Batch view', () => {
  function openBatch(r: ReturnType<typeof renderRN>): void {
    selectView(r, 'batch');
  }

  it('with no batch running, offers the Batch start options naming the way in', () => {
    const r = renderRN(<ChatsScreen />);
    openBatch(r);
    expect(hasText(r.root, 'Nothing batched')).toBe(true);
    expect(hasText(r.root, 'Press Batch to start one.')).toBe(true);
    expect(findHost(r.root, byTestId('batch-start-20'))).toBeDefined();
  });

  it('starting a batch calls the server with the chosen check-in', () => {
    const r = renderRN(<ChatsScreen />);
    openBatch(r);
    actSync(() => findHost(r.root, byTestId('batch-start-20')).props['onPress']());
    expect(startBatchSpy).toHaveBeenCalledWith({ type: 'time', minutes: 20 });
  });

  it('before check-in, lists members marked only "waiting"', () => {
    useChatStore.getState().hydrate([row({ chatId: 'a', name: 'Garden plan' })]);
    useBatchStore.setState({ batch: batchRecord({ members: ['a'] }), loaded: true });
    const r = renderRN(<ChatsScreen />);
    openBatch(r);
    expect(hasText(r.root, 'Garden plan')).toBe(true);
    expect(hasText(r.root, 'waiting')).toBe(true);
  });

  it('removing a member calls the server and the row drops out', () => {
    useChatStore.getState().hydrate([row({ chatId: 'a', name: 'Garden plan' })]);
    useBatchStore.setState({ batch: batchRecord({ members: ['a'] }), loaded: true });
    removeBatchMemberSpy.mockResolvedValue({ batch: batchRecord({ members: [] }), carryover: [] });
    const r = renderRN(<ChatsScreen />);
    openBatch(r);

    actSync(() => findHost(r.root, byTestId('batch-remove-a')).props['onPress']());
    expect(removeBatchMemberSpy).toHaveBeenCalledWith('a');
  });

  it('after check-in, shows no "waiting" label and a Check in now control is absent', () => {
    useChatStore.getState().hydrate([row({ chatId: 'a', activity: 'running' })]);
    useBatchStore.setState({
      batch: batchRecord({ members: ['a'], checkedIn: true }),
      loaded: true,
    });
    const r = renderRN(<ChatsScreen />);
    openBatch(r);
    expect(hasText(r.root, 'waiting')).toBe(false);
    expect(() => findHost(r.root, byTestId('batch-checkin-now'))).toThrow();
  });
});

describe('Unread option (spec/15 § Needs attention)', () => {
  function selectUnread(r: ReturnType<typeof renderRN>): void {
    selectView(r, 'unread');
  }

  it('off by default: pinned/folder rows show regardless of badge', () => {
    useChatStore.getState().hydrate([row({ chatId: 'a', folder: 'work' })]);
    const r = renderRN(<ChatsScreen />);
    expect(hasText(r.root, 'a')).toBe(true);
  });

  it('filters to done/permission rows only, hiding a merely-read row, when selected', () => {
    useChatStore
      .getState()
      .hydrate([
        row({ chatId: 'done-row', folder: 'work', lastUpdated: 100 }),
        row({ chatId: 'read-row', folder: 'work', lastUpdated: 1 }),
      ]);
    // Mark "read-row" as read (visited after its last update) and leave
    // "done-row" unread (lastUpdated stays ahead of the default lastVisitedAt 0).
    useChatStore.getState().setActiveChat('read-row');
    useChatStore.getState().setActiveChat(null);
    const r = renderRN(<ChatsScreen />);
    selectUnread(r);
    expect(hasText(r.root, 'done-row')).toBe(true);
    expect(hasText(r.root, 'read-row')).toBe(false);
  });

  it('hides Channels, Snoozed and Archived sections while filtering', () => {
    useChatStore.getState().hydrate([row({ chatId: 'a', folder: 'work', lastUpdated: 100 })]);
    const r = renderRN(<ChatsScreen />);
    expect(hasText(r.root, 'Channels')).toBe(true);
    selectUnread(r);
    expect(hasText(r.root, 'Channels')).toBe(false);
    expect(hasText(r.root, 'Snoozed')).toBe(false);
    expect(hasText(r.root, 'Archived')).toBe(false);
  });

  it('shows the attention-empty state when nothing needs attention', () => {
    useChatStore.getState().hydrate([row({ chatId: 'read-row', folder: 'work', lastUpdated: 1 })]);
    useChatStore.getState().setActiveChat('read-row');
    useChatStore.getState().setActiveChat(null);
    const r = renderRN(<ChatsScreen />);
    selectUnread(r);
    expect(hasText(r.root, 'Nothing needs attention')).toBe(true);
  });

  it('queues FIFO — oldest-updated first, permission leading — not the normal recency order', () => {
    useChatStore
      .getState()
      .hydrate([
        row({ chatId: 'newest-done', folder: 'work', lastUpdated: 300 }),
        row({ chatId: 'oldest-done', folder: 'work', lastUpdated: 100 }),
        row({ chatId: 'perm', folder: 'work', lastUpdated: 999, activity: 'awaiting-permission' }),
      ]);
    const r = renderRN(<ChatsScreen />);
    selectUnread(r);
    const names = findAllHost(r.root, byType('Text'))
      .map((t) => (typeof t.children[0] === 'string' ? t.children[0] : ''))
      .filter((t) => ['newest-done', 'oldest-done', 'perm'].includes(t));
    expect(names).toEqual(['perm', 'oldest-done', 'newest-done']);
  });

  it('holds the just-opened row (greyed, still listed) until you navigate to a DIFFERENT chat', () => {
    // Distinctive, multi-word names: `hasText` matches anywhere in the
    // rendered tree, and a single letter like "a" would spuriously match
    // "Chats"/"Batch"/etc. elsewhere on screen.
    useChatStore
      .getState()
      .hydrate([
        row({ chatId: 'alpha-chat', name: 'Alpha chat', folder: 'work', lastUpdated: 100 }),
        row({ chatId: 'beta-chat', name: 'Beta chat', folder: 'work', lastUpdated: 200 }),
      ]);
    const r = renderRN(<ChatsScreen />);
    selectUnread(r);
    expect(hasText(r.root, 'Alpha chat')).toBe(true);
    expect(hasText(r.root, 'Beta chat')).toBe(true);

    // Opening Alpha marks it read — held in place rather than vanishing.
    actSync(() => useChatStore.getState().setActiveChat('alpha-chat'));
    update(r, <ChatsScreen />);
    expect(hasText(r.root, 'Alpha chat')).toBe(true);
    expect(hasText(r.root, 'Beta chat')).toBe(true);

    // Navigating to a DIFFERENT chat releases it.
    actSync(() => useChatStore.getState().setActiveChat('beta-chat'));
    update(r, <ChatsScreen />);
    expect(hasText(r.root, 'Alpha chat')).toBe(false);
    expect(hasText(r.root, 'Beta chat')).toBe(true);
  });
});

describe('State filter options (Working / Waiting on you / Failed)', () => {
  it('Working shows only a working chat, leaving Channels visible', () => {
    useChatStore
      .getState()
      .hydrate([
        row({ chatId: 'working-row', folder: 'work', activity: 'running' }),
        row({ chatId: 'idle-row', folder: 'work' }),
      ]);
    const r = renderRN(<ChatsScreen />);
    selectView(r, 'working');
    expect(hasText(r.root, 'working-row')).toBe(true);
    expect(hasText(r.root, 'idle-row')).toBe(false);
    // Unlike Unread, a plain state filter does not hide the other sections.
    expect(hasText(r.root, 'Channels')).toBe(true);
  });

  it('Waiting on you shows only a permission-paused chat', () => {
    useChatStore
      .getState()
      .hydrate([
        row({ chatId: 'waiting-row', folder: 'work', activity: 'awaiting-permission' }),
        row({ chatId: 'idle-row', folder: 'work' }),
      ]);
    const r = renderRN(<ChatsScreen />);
    selectView(r, 'waiting');
    expect(hasText(r.root, 'waiting-row')).toBe(true);
    expect(hasText(r.root, 'idle-row')).toBe(false);
  });

  it('Failed shows only an errored chat', () => {
    useChatStore
      .getState()
      .hydrate([
        row({ chatId: 'failed-row', folder: 'work', status: 'errored' }),
        row({ chatId: 'idle-row', folder: 'work' }),
      ]);
    const r = renderRN(<ChatsScreen />);
    selectView(r, 'failed');
    expect(hasText(r.root, 'failed-row')).toBe(true);
    expect(hasText(r.root, 'idle-row')).toBe(false);
  });
});
