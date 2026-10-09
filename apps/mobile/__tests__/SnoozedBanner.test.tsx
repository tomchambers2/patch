// SnoozedBanner — the chat-detail bar naming the wake time (spec/15 § Chat
// detail → Snoozed banner; spec/04 § Snooze).
//
// A snoozed chat still OPENS normally — from its Snoozed row, a deep link or a
// push tap — so the banner is what tells the user why the chat is missing from
// the active list, and offers the way out.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderRN, findHost, byTestId, hasText, queryHost } from './testUtils/render';
import { useChatStore } from '../src/stores/chatStore';
import { useUiStore } from '../src/stores/uiStore';
import type { ChatRow } from '../src/stores/types';

const { snoozeChatSpy } = vi.hoisted(() => ({
  snoozeChatSpy: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/api/rest', () => ({ api: { snoozeChat: snoozeChatSpy } }));

import { SnoozedBanner } from '../src/components/SnoozedBanner';

const NOW = new Date('2026-08-25T10:00:00Z').getTime();

function row(overrides: Partial<ChatRow> = {}): ChatRow {
  return {
    chatId: 'c1',
    name: null,
    daemonId: 'd1',
    folder: 'work',
    activity: 'idle',
    permissionMode: 'auto',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    lastUpdated: 0,
    awaitingPermission: false,
    lastVisitedAt: 0,
    preview: null,
    pendingPermissions: [],
    lastSeq: 0,
    pendingWake: null,
    snoozedUntil: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  snoozeChatSpy.mockClear();
  useChatStore.getState()._reset();
  useUiStore.setState({ errors: [] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('SnoozedBanner', () => {
  it('renders nothing when the chat is not snoozed', () => {
    const r = renderRN(<SnoozedBanner row={row()} />);
    expect(r.toJSON()).toBeNull();
  });

  it('renders nothing once the wake time has passed, with no event needed', () => {
    const r = renderRN(<SnoozedBanner row={row({ snoozedUntil: NOW - 1 })} />);
    expect(r.toJSON()).toBeNull();
  });

  it('renders nothing for an undefined row (chat not loaded yet)', () => {
    const r = renderRN(<SnoozedBanner row={undefined} />);
    expect(r.toJSON()).toBeNull();
  });

  it('names the wake time while the chat is snoozed', () => {
    const r = renderRN(<SnoozedBanner row={row({ snoozedUntil: NOW + 60 * 60_000 })} />);
    expect(hasText(findHost(r.root, byTestId('snoozed-banner')), 'Snoozed until')).toBe(true);
  });

  it('Unsnooze clears the snooze locally and on the server', () => {
    useChatStore.getState().hydrate([
      {
        chatId: 'c1',
        name: null,
        daemonId: 'd1',
        folder: 'work',
        activity: 'idle',
        permissionMode: 'auto',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        lastUpdated: 0,
        snoozedUntil: NOW + 60_000,
      },
    ]);
    const r = renderRN(<SnoozedBanner row={row({ snoozedUntil: NOW + 60_000 })} />);
    findHost(r.root, byTestId('unsnooze-banner-btn')).props['onPress']();

    expect(snoozeChatSpy).toHaveBeenCalledWith('c1', null);
    expect(useChatStore.getState().chats['c1']?.snoozedUntil).toBeNull();
  });

  it('a failed unsnooze restores the wake time and surfaces the error (no silent no-op)', async () => {
    snoozeChatSpy.mockRejectedValueOnce(new Error('boom'));
    const wake = NOW + 60_000;
    useChatStore.getState().hydrate([
      {
        chatId: 'c1',
        name: null,
        daemonId: 'd1',
        folder: 'work',
        activity: 'idle',
        permissionMode: 'auto',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        lastUpdated: 0,
        snoozedUntil: wake,
      },
    ]);
    const r = renderRN(<SnoozedBanner row={row({ snoozedUntil: wake })} />);
    findHost(r.root, byTestId('unsnooze-banner-btn')).props['onPress']();

    await vi.waitFor(() => {
      expect(useChatStore.getState().chats['c1']?.snoozedUntil).toBe(wake);
    });
    expect(useUiStore.getState().errors.some((e) => e.message.includes('unsnooze failed'))).toBe(
      true,
    );
    expect(queryHost(r.root, byTestId('snoozed-banner'))).not.toBeNull();
  });
});
