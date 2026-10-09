// app/chats/[chatId].tsx — the per-turn system-reminder disclosure (spec/15 §
// Chat detail, spec/02 § System-reminder disclosure), driven through the real
// chat store and the real screen. A turn that carried captured
// `<system-reminder>` blocks draws one quiet collapsed row per block under its
// own bubble, reading the block's label and tapping open to the raw block.

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  renderRN,
  actSync,
  findHost,
  findAllHost,
  queryHost,
  byTestId,
  hasText,
} from './testUtils/render';
import { useChatStore } from '../src/stores/chatStore';
import { usePresenceStore } from '../src/stores/presenceStore';
import { __setLocalSearchParams } from './stubs/expo-router';

vi.mock('../src/api/rest', () => ({
  api: {
    markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
    deleteChat: vi.fn(),
    pinChat: vi.fn(),
    uploadAttachment: vi.fn(),
  },
}));
vi.mock('../src/api/ws', () => ({
  getWs: () => ({ send: vi.fn(), safeSend: vi.fn(), requestReplay: vi.fn() }),
}));
vi.mock('../src/lib/voiceCall', () => ({ startVoiceCall: vi.fn() }));

const RESTART_TEXT = 'This turn was already running when the host restarted.';

let ChatDetailScreen: React.ComponentType;

beforeEach(async () => {
  useChatStore.getState()._reset();
  usePresenceStore.getState().setConnection('connected');
  usePresenceStore.getState().setDaemon('online');
  ChatDetailScreen = (await import('../app/chats/[chatId]')).default;
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
});

/** A turn, then the host's restart re-send of it, then the reply. */
function restartedTurn(): void {
  const s = useChatStore.getState();
  s.applyEvent({
    type: 'chat.message',
    chatId: 'c1',
    role: 'user',
    content: 'tidy the garden notes',
    seq: 2,
    systemContext: [{ source: 'patch', label: 'Todo list updated', text: 'adopt the list' }],
  });
  s.applyEvent({
    type: 'chat.message',
    chatId: 'c1',
    role: 'user',
    content: 'Carry on',
    seq: 5,
    retryOfSeq: 2,
    systemContext: [{ source: 'patch', label: 'Turn interrupted by restart', text: RESTART_TEXT }],
  });
  s.applyEvent({
    type: 'chat.message',
    chatId: 'c1',
    role: 'assistant',
    content: 'Picking up where I left off.',
    seq: 6,
  });
}

describe('system-reminder disclosure under a turn', () => {
  it('draws one collapsed row per block on the one bubble, labelled, in order', () => {
    restartedTurn();
    const r = renderRN(<ChatDetailScreen />);
    expect(findAllHost(r.root, byTestId('message-body-user'))).toHaveLength(1);
    const summaries = findAllHost(r.root, byTestId('system-context-summary'));
    expect(summaries).toHaveLength(2);
    expect(hasText(summaries[0]!, 'Todo list updated')).toBe(true);
    expect(hasText(summaries[1]!, 'Turn interrupted by restart')).toBe(true);
    // Collapsed by default: the raw block is not on screen.
    expect(queryHost(r.root, byTestId('system-context-detail'))).toBeNull();
    expect(hasText(r.root, RESTART_TEXT)).toBe(false);
    // The restart fold is still one turn, retried once — not a second bubble.
    expect(hasText(r.root, 'Carry on')).toBe(false);
  });

  it('opens to the raw block on tap, and closes again', () => {
    restartedTurn();
    const r = renderRN(<ChatDetailScreen />);
    const restart = findAllHost(r.root, byTestId('system-context-summary'))[1]!;
    expect(restart.props.accessibilityState).toEqual({ expanded: false });
    actSync(() => restart.props.onPress());
    const detail = findHost(r.root, byTestId('system-context-detail'));
    expect(hasText(detail, RESTART_TEXT)).toBe(true);
    actSync(() => findAllHost(r.root, byTestId('system-context-summary'))[1]!.props.onPress());
    expect(queryHost(r.root, byTestId('system-context-detail'))).toBeNull();
  });

  it('draws nothing on an ordinary turn', () => {
    useChatStore
      .getState()
      .applyEvent({ type: 'chat.message', chatId: 'c1', role: 'user', content: 'hi', seq: 1 });
    const r = renderRN(<ChatDetailScreen />);
    expect(queryHost(r.root, byTestId('system-context-summary'))).toBeNull();
  });
});
