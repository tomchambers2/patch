// app/chats/[chatId].tsx — the call lives INSIDE the chat (spec/15 § Voice
// states — Voice call). With a call on this chat the screen docks the call
// bar above its composer (the stream above is the transcript); with a call on
// another chat it shows the on-call pill instead; with no call, neither.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { actSync, byTestId, queryHost, renderRN } from './testUtils/render';
import { useChatStore } from '../src/stores/chatStore';
import { usePresenceStore } from '../src/stores/presenceStore';
import { useVoiceStore } from '../src/stores/voiceStore';
import { __setLocalSearchParams } from './stubs/expo-router';

vi.mock('../src/api/rest', () => ({
  api: {
    markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
  },
}));
vi.mock('../src/api/ws', () => ({
  getWs: () => ({ send: vi.fn(), safeSend: vi.fn(), requestReplay: vi.fn() }),
}));
vi.mock('../src/lib/voiceCall', () => ({
  startVoiceCall: vi.fn(),
  endVoiceCall: vi.fn(),
  retryVoiceCall: vi.fn(),
  setCallMode: vi.fn(),
  setCallMuted: vi.fn(),
}));

let ChatDetailScreen: React.ComponentType;
const mounted: ReturnType<typeof renderRN>[] = [];

beforeEach(async () => {
  useChatStore.getState()._reset();
  usePresenceStore.getState().setConnection('connected');
  usePresenceStore.getState().setDaemon('online');
  useChatStore.getState().hydrate([
    {
      chatId: 'c1',
      name: 'My Chat',
      folder: '~/project',
      activity: 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      lastUpdated: 1,
    },
  ]);
  __setLocalSearchParams({ chatId: 'c1' });
  useVoiceStore.setState({ activeSession: null, callError: null });
  const mod = await import('../app/chats/[chatId]');
  ChatDetailScreen = mod.default;
});

afterEach(() => {
  for (const r of mounted.splice(0)) actSync(() => r.unmount());
  useVoiceStore.setState({ activeSession: null });
});

function open(): ReturnType<typeof renderRN> {
  const r = renderRN(<ChatDetailScreen />);
  mounted.push(r);
  return r;
}

function callOn(chatId: string): void {
  useVoiceStore.setState({
    activeSession: { sessionId: 's', chatId, audioUrl: '/a', startedAt: 0 },
    callPhase: 'listening',
    callMode: 'call',
    callConnectedAt: 0,
  });
}

describe('chat detail — call dock', () => {
  it('no call: no bar, no pill, the composer as usual', () => {
    const r = open();
    expect(queryHost(r.root, byTestId('call-bar'))).toBeNull();
    expect(queryHost(r.root, byTestId('call-pill'))).toBeNull();
  });

  it('a call on this chat docks the call bar — and there is no full-screen overlay', () => {
    callOn('c1');
    const r = open();
    expect(queryHost(r.root, byTestId('call-bar'))).not.toBeNull();
    expect(queryHost(r.root, byTestId('call-pill'))).toBeNull();
  });

  it('a call on another chat shows the on-call pill instead', () => {
    callOn('thread_manager');
    const r = open();
    expect(queryHost(r.root, byTestId('call-bar'))).toBeNull();
    expect(queryHost(r.root, byTestId('call-pill'))).not.toBeNull();
  });
});
