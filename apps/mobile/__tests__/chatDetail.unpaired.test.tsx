// app/chats/[chatId].tsx on a device with no stored route. apiUrl() throws
// there, and the screen called it during render (ViewFileCard, attachment
// URLs) — so a chat holding a view_file result or an attachment crashed the
// whole app and it restart-looped. No screen that needs a server renders
// before a route exists: it goes to pairing instead.

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderRN, findHost, byTestId } from './testUtils/render';
import { useChatStore } from '../src/stores/chatStore';
import { usePresenceStore } from '../src/stores/presenceStore';
import { __setLocalSearchParams } from './stubs/expo-router';
import { clearRoute } from '../src/config';

vi.mock('../src/api/rest', () => ({
  api: {
    deleteChat: vi.fn(),
    pinChat: vi.fn(),
    markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
  },
}));
vi.mock('../src/api/ws', () => ({
  getWs: () => ({ send: vi.fn(), safeSend: vi.fn(), requestReplay: vi.fn() }),
}));
vi.mock('../src/lib/voiceCall', () => ({ startVoiceCall: vi.fn() }));

let ChatDetailScreen: React.ComponentType;

beforeEach(async () => {
  useChatStore.getState()._reset();
  usePresenceStore.getState().setConnection('connected');
  usePresenceStore.getState().setDaemon('online');
  ChatDetailScreen = (await import('../app/chats/[chatId]')).default;
  useChatStore
    .getState()
    .hydrate([
      {
        chatId: 'c1',
        name: 'My Chat',
        folder: '~/p',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        lastUpdated: 1,
      },
    ]);
  useChatStore.getState().applyEvent({
    type: 'chat.tool_call',
    chatId: 'c1',
    seq: 1,
    tool: 'view_file',
    args: {},
    callId: 'v1',
  });
  useChatStore.getState().applyEvent({
    type: 'chat.tool_result',
    chatId: 'c1',
    seq: 2,
    callId: 'v1',
    result: { url: '/files/a.png', name: 'a.png' },
  } as never);
  __setLocalSearchParams({ chatId: 'c1' });
});

describe('chat detail on an unpaired device', () => {
  it('redirects to pairing instead of throwing from render', () => {
    clearRoute();
    const r = renderRN(<ChatDetailScreen />);
    expect(findHost(r.root, (i) => i.type === 'Redirect').props.href).toBe('/pair');
    expect(() => findHost(r.root, byTestId('view-file'))).toThrow();
  });
});
