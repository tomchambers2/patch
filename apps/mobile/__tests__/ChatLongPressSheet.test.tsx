// ChatLongPressSheet — the row-actions bottom sheet (spec/15 § Row tools):
// Pin/Unpin, Snooze/Unsnooze, Archive/Unarchive, Send voice note, Delete. Opened imperatively
// via showChatLongPressSheet(row) (an internal zustand store, not a prop),
// so these tests drive it the same way a real call site (the row's kebab /
// long-press) would.
//
// api.archiveChat/pinChat/deleteChat are mocked (network); startVoiceNote is
// mocked too so this file only asserts THIS component wires the gesture to
// the right chatId — the recording lifecycle itself is voiceNote.test.ts's job.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ReactTestInstance } from 'react-test-renderer';
import { findHost, findAllHost, byType, hasText, renderRN, update } from './testUtils/render';
import { SPECIAL_THREAD_IDS } from '@patch/wire';
import { lightColors as colors, darkColors } from '../src/lib/theme';
import { __setColorScheme } from './stubs/react-native';
import { useChatStore } from '../src/stores/chatStore';
import { useUiStore } from '../src/stores/uiStore';
import type { ChatRow } from '../src/stores/types';

const { archiveChatSpy, pinChatSpy, deleteChatSpy, snoozeChatSpy, hideChatSpy } = vi.hoisted(
  () => ({
    hideChatSpy: vi.fn().mockResolvedValue(undefined),
    archiveChatSpy: vi.fn().mockResolvedValue(undefined),
    pinChatSpy: vi.fn().mockResolvedValue(undefined),
    deleteChatSpy: vi.fn().mockResolvedValue(undefined),
    snoozeChatSpy: vi.fn().mockResolvedValue(undefined),
  }),
);
vi.mock('../src/api/rest', () => ({
  api: {
    archiveChat: archiveChatSpy,
    pinChat: pinChatSpy,
    deleteChat: deleteChatSpy,
    snoozeChat: snoozeChatSpy,
    hideChat: hideChatSpy,
  },
}));

const { startVoiceNoteSpy } = vi.hoisted(() => ({ startVoiceNoteSpy: vi.fn() }));
vi.mock('../src/lib/voiceNote', () => ({ startVoiceNote: startVoiceNoteSpy }));

import {
  ChatLongPressSheet,
  showChatLongPressSheet,
  showChatSnoozeSheet,
} from '../src/components/ChatLongPressSheet';

function row(overrides: Partial<ChatRow> = {}): ChatRow {
  return {
    chatId: 'c1',
    name: null,
    folder: 'work',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    lastUpdated: 0,
    awaitingPermission: false,
    lastVisitedAt: 0,
    preview: null,
    pendingPermissions: [],
    lastSeq: 0,
    snoozedUntil: null,
    ...overrides,
  };
}

// The sheet container + backdrop are both bare Pressables with no
// accessibilityLabel; distinguish them by their own (plain-object, not
// function-style) `style`, the only thing that differs between them.
function byBackgroundColor(bg: string) {
  return (i: ReactTestInstance): boolean =>
    i.type === 'Pressable' &&
    (i.props['style'] as { backgroundColor?: string } | undefined)?.backgroundColor === bg;
}
const isBackdrop = byBackgroundColor(colors.shade);
const isSheetContainer = byBackgroundColor(colors.paperRaised);

/**
 * One of the 4 menu rows (Item component), found by its own label text.
 * Every ancestor Pressable (backdrop, sheet container) also "contains" every
 * row's text as a descendant, so a naive `hasText` search over ALL Pressables
 * would match the outermost one first. Filtering to LEAF Pressables (no
 * nested Pressable of their own) picks the actual row exactly once.
 */
function menuItem(root: ReactTestInstance, label: string): ReactTestInstance {
  const leaves = findAllHost(root, byType('Pressable')).filter(
    (p) => findAllHost(p, byType('Pressable')).length === 1 && hasText(p, label),
  );
  if (leaves.length !== 1) {
    throw new Error(`menuItem("${label}"): expected 1 match, found ${leaves.length}`);
  }
  return leaves[0]!;
}

beforeEach(() => {
  archiveChatSpy.mockClear();
  pinChatSpy.mockClear();
  deleteChatSpy.mockClear();
  snoozeChatSpy.mockClear();
  startVoiceNoteSpy.mockClear();
  useChatStore.getState()._reset();
  useChatStore.getState().hydrate([row(), row({ chatId: 'c2', pinned: true, status: 'archived' })]);
});

// The sheet's open row lives in a module-level store, so a test that opens it
// closes it again (via its own backdrop) rather than leak an open sheet into
// the next test.
function closeSheet(r: ReturnType<typeof renderRN>, shade: string): void {
  findHost(r.root, byBackgroundColor(shade)).props['onPress']();
}

afterEach(() => {
  __setColorScheme('light');
});

describe('ChatLongPressSheet — item order', () => {
  // Pin/Snooze/Archive in the swipe tray's order, then the voice note, with
  // Delete last — furthest from a thumb landing on the top of the sheet.
  // Batch membership is automatic (spec/15 § Batch view) — no row toggle.
  const LABELS = [
    'Pin chat',
    'Unpin chat',
    'Snooze chat',
    'Unsnooze chat',
    'Archive chat',
    'Unarchive chat',
    'Send voice note',
    'Delete chat',
  ];
  function itemOrder(root: ReactTestInstance): string[] {
    return findAllHost(root, byType('Text'))
      .map((t) => (typeof t.children[0] === 'string' ? t.children[0] : ''))
      .filter((t) => LABELS.includes(t));
  }

  it('reads Pin, Snooze, Archive, Send voice note, Delete', () => {
    const r = renderRN(<ChatLongPressSheet />);
    showChatLongPressSheet(row({ chatId: 'c1' }));
    update(r, <ChatLongPressSheet />);
    expect(itemOrder(r.root)).toEqual([
      'Pin chat',
      'Snooze chat',
      'Archive chat',
      'Send voice note',
      'Delete chat',
    ]);
    closeSheet(r, colors.shade);
  });

  it('keeps the order when every toggle reads its undo', () => {
    const r = renderRN(<ChatLongPressSheet />);
    showChatLongPressSheet(
      row({ chatId: 'c1', pinned: true, status: 'archived', snoozedUntil: Date.now() + 60_000 }),
    );
    update(r, <ChatLongPressSheet />);
    expect(itemOrder(r.root)).toEqual([
      'Unpin chat',
      'Unsnooze chat',
      'Unarchive chat',
      'Send voice note',
      'Delete chat',
    ]);
    closeSheet(r, colors.shade);
  });
});

describe('ChatLongPressSheet — dark mode', () => {
  it('draws the sheet and its items from the dark palette', () => {
    __setColorScheme('dark');
    const r = renderRN(<ChatLongPressSheet />);
    showChatLongPressSheet(row({ chatId: 'c1', name: 'Night chat' }));
    update(r, <ChatLongPressSheet />);
    expect(() => findHost(r.root, byBackgroundColor(darkColors.paperRaised))).not.toThrow();
    expect(() => findHost(r.root, byBackgroundColor(darkColors.shade))).not.toThrow();
    const title = findHost(r.root, (i) => i.type === 'Text' && i.children[0] === 'Night chat');
    expect((title.props['style'] as { color: string }).color).toBe(darkColors.ink);
    closeSheet(r, darkColors.shade);
  });
});

describe('ChatLongPressSheet — closed state', () => {
  it('renders an invisible Modal (no content) until a row is shown', () => {
    const r = renderRN(<ChatLongPressSheet />);
    // Modal stub renders nothing while `visible` is false.
    expect(r.toJSON()).toBeNull();
  });
});

describe('ChatLongPressSheet — opened via showChatLongPressSheet(row)', () => {
  it('shows the chat name when set, else falls back to the chatId', () => {
    const r = renderRN(<ChatLongPressSheet />);
    showChatLongPressSheet(row({ name: 'Kitchen remodel' }));
    update(r, <ChatLongPressSheet />);
    expect(hasText(r.root, 'Kitchen remodel')).toBe(true);

    showChatLongPressSheet(row({ chatId: 'no-name-chat', name: null }));
    update(r, <ChatLongPressSheet />);
    expect(hasText(r.root, 'no-name-chat')).toBe(true);
  });

  it('an active chat offers "Archive chat"; pressing closes the sheet and archives', () => {
    const r = renderRN(<ChatLongPressSheet />);
    showChatLongPressSheet(row({ chatId: 'c1', status: 'active' }));
    update(r, <ChatLongPressSheet />);
    expect(hasText(r.root, 'Archive chat')).toBe(true);

    menuItem(r.root, 'Archive chat').props['onPress']();

    expect(useChatStore.getState().chats['c1']?.status).toBe('archived');
    expect(archiveChatSpy).toHaveBeenCalledWith('c1', true);
    // Pressing an item closes the sheet (row goes back to null).
    update(r, <ChatLongPressSheet />);
    expect(r.toJSON()).toBeNull();
  });

  it('an archived chat offers "Unarchive chat"; pressing unarchives', () => {
    const r = renderRN(<ChatLongPressSheet />);
    showChatLongPressSheet(row({ chatId: 'c2', status: 'archived' }));
    update(r, <ChatLongPressSheet />);
    expect(hasText(r.root, 'Unarchive chat')).toBe(true);
    // The icon flips too — an open box for the way back, not the closed
    // Archive glyph used to put a chat away.
    expect(() =>
      findHost(menuItem(r.root, 'Unarchive chat'), (i) => i.props.name === 'PackageOpen'),
    ).not.toThrow();

    menuItem(r.root, 'Unarchive chat').props['onPress']();
    expect(useChatStore.getState().chats['c2']?.status).toBe('active');
    expect(archiveChatSpy).toHaveBeenCalledWith('c2', false);
  });

  it('"Send voice note" closes the sheet and starts a note for this chat', () => {
    const r = renderRN(<ChatLongPressSheet />);
    showChatLongPressSheet(row({ chatId: 'c1' }));
    update(r, <ChatLongPressSheet />);
    menuItem(r.root, 'Send voice note').props['onPress']();
    expect(startVoiceNoteSpy).toHaveBeenCalledWith('c1');
    update(r, <ChatLongPressSheet />);
    expect(r.toJSON()).toBeNull();
  });

  it('an unpinned chat offers "Pin chat"; pressing pins', () => {
    const r = renderRN(<ChatLongPressSheet />);
    showChatLongPressSheet(row({ chatId: 'c1', pinned: false }));
    update(r, <ChatLongPressSheet />);
    menuItem(r.root, 'Pin chat').props['onPress']();
    expect(useChatStore.getState().chats['c1']?.pinned).toBe(true);
    expect(pinChatSpy).toHaveBeenCalledWith('c1', true);
  });

  it('a pinned chat offers "Unpin chat"; pressing unpins', () => {
    const r = renderRN(<ChatLongPressSheet />);
    showChatLongPressSheet(row({ chatId: 'c2', pinned: true }));
    update(r, <ChatLongPressSheet />);
    menuItem(r.root, 'Unpin chat').props['onPress']();
    expect(useChatStore.getState().chats['c2']?.pinned).toBe(false);
    expect(pinChatSpy).toHaveBeenCalledWith('c2', false);
  });

  it('"Delete chat" (destructive) closes the sheet, deletes remotely and removes the row', () => {
    const r = renderRN(<ChatLongPressSheet />);
    showChatLongPressSheet(row({ chatId: 'c1' }));
    update(r, <ChatLongPressSheet />);
    menuItem(r.root, 'Delete chat').props['onPress']();
    expect(deleteChatSpy).toHaveBeenCalledWith('c1');
    expect(useChatStore.getState().chats['c1']).toBeUndefined();
  });

  it('pressing the backdrop closes the sheet without side effects', () => {
    const r = renderRN(<ChatLongPressSheet />);
    showChatLongPressSheet(row({ chatId: 'c1' }));
    update(r, <ChatLongPressSheet />);
    const backdrop = findHost(r.root, isBackdrop);
    backdrop.props['onPress']();
    update(r, <ChatLongPressSheet />);
    expect(r.toJSON()).toBeNull();
    expect(archiveChatSpy).not.toHaveBeenCalled();
  });

  it('pressing the sheet container itself is a no-op (does not bubble to the backdrop close)', () => {
    const r = renderRN(<ChatLongPressSheet />);
    showChatLongPressSheet(row({ chatId: 'c1' }));
    update(r, <ChatLongPressSheet />);
    const container = findHost(r.root, isSheetContainer);
    // Exercises the `onPress={() => {}}` no-op directly (function coverage);
    // the stub does not simulate real bubbling, so this proves the handler
    // itself does nothing rather than proving bubbling is blocked.
    expect(() => container.props['onPress']()).not.toThrow();
    update(r, <ChatLongPressSheet />);
    // Still open — no close() was triggered by this no-op handler.
    expect(r.toJSON()).not.toBeNull();
  });

  it('an active chat offers "Hide chat"; pressing hides it and closes the sheet (spec/04 § Hidden)', () => {
    const r = renderRN(<ChatLongPressSheet />);
    showChatLongPressSheet(row({ chatId: 'c1', status: 'active' }));
    update(r, <ChatLongPressSheet />);

    menuItem(r.root, 'Hide chat').props['onPress']();

    expect(useChatStore.getState().chats['c1']?.hidden).toBe(true);
    expect(hideChatSpy).toHaveBeenCalledWith('c1', true);
    update(r, <ChatLongPressSheet />);
    expect(r.toJSON()).toBeNull();
  });

  it('"Hide chat" is not offered for a hidden chat, an archived chat or a special thread', () => {
    const r = renderRN(<ChatLongPressSheet />);
    for (const overrides of [
      { chatId: 'c1', hidden: true },
      { chatId: 'c1', status: 'archived' as const },
      { chatId: SPECIAL_THREAD_IDS.manager },
    ]) {
      showChatLongPressSheet(row(overrides));
      update(r, <ChatLongPressSheet />);
      expect(hasText(r.root, 'Hide chat')).toBe(false);
    }
  });

  it('a failed hide REVERTS the optimistic flip and surfaces the error', async () => {
    hideChatSpy.mockRejectedValueOnce(new Error('nope'));
    const r = renderRN(<ChatLongPressSheet />);
    showChatLongPressSheet(row({ chatId: 'c1' }));
    update(r, <ChatLongPressSheet />);
    menuItem(r.root, 'Hide chat').props['onPress']();
    await vi.waitFor(() => expect(useChatStore.getState().chats['c1']?.hidden).toBeFalsy());
    expect(useUiStore.getState().errors.some((e) => /hide failed: nope/.test(e.message))).toBe(
      true,
    );
  });

  it('a snoozable chat offers "Snooze chat"; a special thread does not (spec/04 § Snooze)', () => {
    const r = renderRN(<ChatLongPressSheet />);
    showChatLongPressSheet(row({ chatId: 'c1' }));
    update(r, <ChatLongPressSheet />);
    expect(hasText(r.root, 'Snooze chat')).toBe(true);

    showChatLongPressSheet(row({ chatId: SPECIAL_THREAD_IDS.manager }));
    update(r, <ChatLongPressSheet />);
    expect(hasText(r.root, 'Snooze chat')).toBe(false);
    // The rest of the sheet is unaffected.
    expect(hasText(r.root, 'Delete chat')).toBe(true);
  });

  it('an Item row exercises both pressed-style branches via onPressIn/onPressOut', () => {
    const r = renderRN(<ChatLongPressSheet />);
    showChatLongPressSheet(row({ chatId: 'c1' }));
    update(r, <ChatLongPressSheet />);
    const item = menuItem(r.root, 'Pin chat');
    expect((item.props['style'] as { backgroundColor: string }).backgroundColor).toBe(
      'transparent',
    );
    item.props['onPressIn']();
    // Re-read: Pressable resolves style fresh against ITS OWN pressed state.
    const pressedItem = menuItem(r.root, 'Pin chat');
    expect((pressedItem.props['style'] as { backgroundColor: string }).backgroundColor).toBe(
      colors.divider,
    );
    pressedItem.props['onPressOut']();
  });
});

describe('ChatLongPressSheet — snooze (spec/04 § Snooze)', () => {
  const NOW = new Date('2026-08-25T10:00:00Z').getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('"Snooze chat" swaps the sheet for the preset list without snoozing anything yet', () => {
    const r = renderRN(<ChatLongPressSheet />);
    showChatLongPressSheet(row({ chatId: 'c1' }));
    update(r, <ChatLongPressSheet />);
    menuItem(r.root, 'Snooze chat').props['onPress']();
    update(r, <ChatLongPressSheet />);

    for (const label of ['2 minutes', '5 minutes', '30 minutes', '1 hour', '1 day', 'Next week']) {
      expect(hasText(r.root, label)).toBe(true);
    }
    // The actions are replaced, not stacked underneath.
    expect(hasText(r.root, 'Delete chat')).toBe(false);
    // Nothing committed by merely opening the list.
    expect(snoozeChatSpy).not.toHaveBeenCalled();
  });

  it('picking a preset resolves "now + delta" to an ABSOLUTE timestamp and closes the sheet', () => {
    const r = renderRN(<ChatLongPressSheet />);
    showChatLongPressSheet(row({ chatId: 'c1' }));
    update(r, <ChatLongPressSheet />);
    menuItem(r.root, 'Snooze chat').props['onPress']();
    update(r, <ChatLongPressSheet />);
    menuItem(r.root, '30 minutes').props['onPress']();

    expect(snoozeChatSpy).toHaveBeenCalledWith('c1', NOW + 30 * 60_000);
    expect(useChatStore.getState().chats['c1']?.snoozedUntil).toBe(NOW + 30 * 60_000);
    update(r, <ChatLongPressSheet />);
    expect(r.toJSON()).toBeNull();
  });

  it('an already-snoozed chat offers "Unsnooze chat", clearing it in one tap (no preset list)', () => {
    const r = renderRN(<ChatLongPressSheet />);
    showChatLongPressSheet(row({ chatId: 'c1', snoozedUntil: NOW + 60_000 }));
    update(r, <ChatLongPressSheet />);
    expect(hasText(r.root, 'Snooze chat')).toBe(false);

    menuItem(r.root, 'Unsnooze chat').props['onPress']();
    expect(snoozeChatSpy).toHaveBeenCalledWith('c1', null);
    expect(useChatStore.getState().chats['c1']?.snoozedUntil).toBeNull();
  });

  it('a chat whose snooze has LAPSED offers Snooze again (derived from the clock)', () => {
    const r = renderRN(<ChatLongPressSheet />);
    showChatLongPressSheet(row({ chatId: 'c1', snoozedUntil: NOW - 1 }));
    update(r, <ChatLongPressSheet />);
    expect(hasText(r.root, 'Snooze chat')).toBe(true);
    expect(hasText(r.root, 'Unsnooze chat')).toBe(false);
  });

  it('showChatSnoozeSheet opens straight into the preset list (the chat-detail kebab route)', () => {
    const r = renderRN(<ChatLongPressSheet />);
    showChatSnoozeSheet(row({ chatId: 'c1' }));
    update(r, <ChatLongPressSheet />);
    expect(hasText(r.root, '1 hour')).toBe(true);
    expect(hasText(r.root, 'Archive chat')).toBe(false);
  });

  it('a failed snooze REVERTS the optimistic flip and surfaces the error (no silent no-op)', async () => {
    snoozeChatSpy.mockRejectedValueOnce(new Error('snoozedUntil is in the past'));
    const r = renderRN(<ChatLongPressSheet />);
    showChatLongPressSheet(row({ chatId: 'c1' }));
    update(r, <ChatLongPressSheet />);
    menuItem(r.root, 'Snooze chat').props['onPress']();
    update(r, <ChatLongPressSheet />);
    menuItem(r.root, '1 hour').props['onPress']();

    await vi.waitFor(() => {
      expect(useChatStore.getState().chats['c1']?.snoozedUntil).toBeNull();
    });
    expect(useUiStore.getState().errors.some((e) => e.message.includes('snooze failed'))).toBe(
      true,
    );
  });
});
