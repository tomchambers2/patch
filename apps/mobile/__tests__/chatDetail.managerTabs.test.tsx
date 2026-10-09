// app/chats/[chatId].tsx — the Manager chat's Conversation | Chats switch
// (spec/15 § Voice tab (Manager)). The Chats tab's own rows are covered in
// ManagerChats.test.tsx; this pins how the screen hosts it: only on Manager,
// conversation by default, and the conversation hidden (not unmounted) while
// Chats shows, so its draft and scroll position survive the round trip.

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SPECIAL_THREAD_IDS } from '@patch/wire';
import { renderRN, findHost, queryHost, byLabel, byTestId, actSync } from './testUtils/render';
import { useChatStore } from '../src/stores/chatStore';
import { usePresenceStore } from '../src/stores/presenceStore';
import { __setLocalSearchParams } from './stubs/expo-router';

vi.mock('../src/api/rest', () => ({
  api: {
    markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
  },
}));
const wsMock = { send: vi.fn(), safeSend: vi.fn(), requestReplay: vi.fn() };
vi.mock('../src/api/ws', () => ({ getWs: () => wsMock }));
vi.mock('../src/lib/voiceCall', () => ({ startVoiceCall: vi.fn() }));

let ChatDetailScreen: React.ComponentType;

beforeEach(async () => {
  vi.clearAllMocks();
  useChatStore.getState()._reset();
  usePresenceStore.getState().setConnection('connected');
  usePresenceStore.getState().setDaemon('online');
  ChatDetailScreen = (await import('../app/chats/[chatId]')).default;
});

function seed(chatId: string): void {
  useChatStore.getState().hydrate([
    {
      chatId,
      name: 'Chat',
      daemonId: 'd1',
      folder: '~/p',
      activity: 'idle',
      permissionMode: 'default',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      lastUpdated: 1,
    },
  ]);
}

const kav = (r: ReturnType<typeof renderRN>) =>
  findHost(r.root, (i) => i.type === 'KeyboardAvoidingView');

describe('chat-detail — Manager Conversation | Chats', () => {
  it('a regular chat has no switch and no Chats list', () => {
    seed('c1');
    __setLocalSearchParams({ chatId: 'c1' });
    const r = renderRN(<ChatDetailScreen />);
    expect(queryHost(r.root, byTestId('manager-segments'))).toBeNull();
    expect(queryHost(r.root, byTestId('manager-chats'))).toBeNull();
  });

  it('Manager opens on the conversation, with the switch above it', () => {
    seed(SPECIAL_THREAD_IDS.manager);
    __setLocalSearchParams({ chatId: SPECIAL_THREAD_IDS.manager });
    const r = renderRN(<ChatDetailScreen />);
    expect(findHost(r.root, byTestId('manager-segments'))).toBeDefined();
    expect((kav(r).props.style as { display: string }).display).toBe('flex');
    expect(queryHost(r.root, byTestId('manager-chats'))).toBeNull();
  });

  it('Chats hides the conversation (still mounted) and shows the list; Conversation brings it back', () => {
    seed(SPECIAL_THREAD_IDS.manager);
    __setLocalSearchParams({ chatId: SPECIAL_THREAD_IDS.manager });
    const r = renderRN(<ChatDetailScreen />);
    actSync(() => findHost(r.root, byLabel('Chats')).props.onPress());
    expect((kav(r).props.style as { display: string }).display).toBe('none');
    expect(findHost(r.root, byTestId('manager-chats'))).toBeDefined();
    actSync(() => findHost(r.root, byLabel('Conversation')).props.onPress());
    expect((kav(r).props.style as { display: string }).display).toBe('flex');
    expect(queryHost(r.root, byTestId('manager-chats'))).toBeNull();
  });
});
