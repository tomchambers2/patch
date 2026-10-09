// app/chats/[chatId].tsx — queued messages (spec/04 ## Message queueing,
// spec/15 § Chat detail): chip with place in line, always-visible promote (↑)
// and remove (×), tap-to-edit, and the queued block below the working indicator.

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
import { useUiStore } from '../src/stores/uiStore';
import { getComposerDraft, clearComposerDraft } from '../src/lib/composerDraft';
import { __setLocalSearchParams } from './stubs/expo-router';

vi.mock('../src/api/rest', () => ({
  api: {
    markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
    deleteChat: vi.fn(),
    pinChat: vi.fn(),
  },
}));
const sendMock = vi.fn();
vi.mock('../src/api/ws', () => ({
  getWs: () => ({ send: sendMock, safeSend: vi.fn(), requestReplay: vi.fn() }),
}));
vi.mock('../src/lib/voiceCall', () => ({ startVoiceCall: vi.fn() }));

let ChatDetailScreen: React.ComponentType;
const apply = (e: Parameters<ReturnType<typeof useChatStore.getState>['applyEvent']>[0]): void =>
  actSync(() => useChatStore.getState().applyEvent(e));
const queue = (localId: string, message: string): void =>
  apply({ type: 'chat.queued', chatId: 'c1', localId, message, queueSeq: 1 });

beforeEach(async () => {
  vi.clearAllMocks();
  useChatStore.getState()._reset();
  useUiStore.setState({ errors: [] });
  clearComposerDraft('c1');
  usePresenceStore.getState().setConnection('connected');
  usePresenceStore.getState().setDaemon('online');
  ChatDetailScreen = (await import('../app/chats/[chatId]')).default;
  useChatStore.getState().hydrate([
    {
      chatId: 'c1',
      name: 'My Chat',
      folder: '~/p',
      activity: 'running',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      lastUpdated: 1,
    },
  ]);
  apply({ type: 'chat.message', chatId: 'c1', seq: 1, role: 'user', content: 'running turn' });
  __setLocalSearchParams({ chatId: 'c1' });
});

describe('queued messages on the chat screen', () => {
  it('shows each queued turn with its place in the line', () => {
    queue('A', 'first queued');
    queue('B', 'second queued');
    const r = renderRN(<ChatDetailScreen />);
    const badges = findAllHost(r.root, byTestId('queued-badge')).map((b) => b.props.children);
    expect(badges).toEqual(['Queued', '2nd in queue']);
  });

  it('renumbers when the head is removed', () => {
    queue('A', 'first queued');
    queue('B', 'second queued');
    const r = renderRN(<ChatDetailScreen />);
    actSync(() => findAllHost(r.root, byTestId('queued-remove'))[0]!.props.onPress());
    expect(findAllHost(r.root, byTestId('queued-badge')).map((b) => b.props.children)).toEqual([
      'Queued',
    ]);
    expect(sendMock).toHaveBeenCalledWith({
      type: 'chat.unqueue_request',
      chatId: 'c1',
      localId: 'A',
    });
  });

  it('↑ sends chat.promote_request without touching the queue', () => {
    queue('A', 'first queued');
    queue('B', 'second queued');
    const r = renderRN(<ChatDetailScreen />);
    actSync(() => findAllHost(r.root, byTestId('queued-promote'))[1]!.props.onPress());
    expect(sendMock).toHaveBeenCalledWith({
      type: 'chat.promote_request',
      chatId: 'c1',
      localId: 'B',
    });
    expect(findAllHost(r.root, byTestId('queued-badge'))).toHaveLength(2);
  });

  it('keeps the live turn out of the queued block', () => {
    apply({ type: 'chat.message', chatId: 'c1', seq: 2, role: 'assistant', content: 'reply' });
    queue('A', 'queued');
    const r = renderRN(<ChatDetailScreen />);
    expect(findAllHost(r.root, byTestId('queued-tools'))).toHaveLength(1);
    expect(hasText(r.root, 'reply')).toBe(true);
    // the reply landed, so no working indicator despite the queued user turn after it
    expect(working(r)).toHaveLength(0);
  });

  it('draws the queued block below the working indicator', () => {
    queue('A', 'queued');
    const r = renderRN(<ChatDetailScreen />);
    const order = findAllHost(
      r.root,
      (i) =>
        i.props['accessibilityLabel'] === 'Claude is working' || i.props.testID === 'queued-tools',
    ).map((n) => n.props.testID ?? n.props.accessibilityLabel);
    expect(order).toEqual(['Claude is working', 'queued-tools']);
  });

  it('a queued turn dequeued as running loses its chip', () => {
    queue('A', 'queued');
    const r = renderRN(<ChatDetailScreen />);
    apply({ type: 'chat.dequeued', chatId: 'c1', localId: 'A', reason: 'running' });
    expect(queryHost(r.root, byTestId('queued-tools'))).toBeNull();
  });
});

const working = (r: ReturnType<typeof renderRN>) =>
  findAllHost(r.root, (i) => i.props['accessibilityLabel'] === 'Claude is working');

const openEditor = (r: ReturnType<typeof renderRN>): void =>
  actSync(() =>
    findAllHost(r.root, byTestId('message-body-user'))
      .find((n) => typeof n.props.onPress === 'function')!
      .props.onPress(),
  );

describe('editing a queued message', () => {
  it('tap opens the editor; Save sends chat.edit_queued_request', () => {
    queue('A', 'first queued');
    const r = renderRN(<ChatDetailScreen />);
    openEditor(r);
    expect(findHost(r.root, byTestId('queued-edit-input')).props.value).toBe('first queued');
    actSync(() => findHost(r.root, byTestId('queued-edit-input')).props.onChangeText('changed'));
    actSync(() => findHost(r.root, byTestId('queued-edit-save')).props.onPress());
    expect(sendMock).toHaveBeenCalledWith({
      type: 'chat.edit_queued_request',
      chatId: 'c1',
      localId: 'A',
      message: 'changed',
    });
    expect(queryHost(r.root, byTestId('queued-edit-input'))).toBeNull();
  });

  it('Cancel closes the editor and sends nothing', () => {
    queue('A', 'first queued');
    const r = renderRN(<ChatDetailScreen />);
    openEditor(r);
    actSync(() => findHost(r.root, byTestId('queued-edit-cancel')).props.onPress());
    expect(queryHost(r.root, byTestId('queued-edit-input'))).toBeNull();
    expect(sendMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'chat.edit_queued_request' }),
    );
    expect(sendMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'chat.unqueue_request' }),
    );
  });

  it('saving an empty edit removes the message', () => {
    queue('A', 'first queued');
    const r = renderRN(<ChatDetailScreen />);
    openEditor(r);
    actSync(() => findHost(r.root, byTestId('queued-edit-input')).props.onChangeText(''));
    actSync(() => findHost(r.root, byTestId('queued-edit-save')).props.onPress());
    expect(sendMock).toHaveBeenCalledWith({
      type: 'chat.unqueue_request',
      chatId: 'c1',
      localId: 'A',
    });
    expect(queryHost(r.root, byTestId('queued-tools'))).toBeNull();
  });

  it('an edit that loses the race goes to the composer with an error', () => {
    queue('A', 'first queued');
    const r = renderRN(<ChatDetailScreen />);
    openEditor(r);
    actSync(() => findHost(r.root, byTestId('queued-edit-input')).props.onChangeText('my edit'));
    apply({ type: 'chat.dequeued', chatId: 'c1', localId: 'A', reason: 'running' });
    expect(getComposerDraft('c1')).toBe('my edit');
    expect(useUiStore.getState().errors[0]?.message).toMatch(/already been sent/);
    expect(queryHost(r.root, byTestId('queued-edit-input'))).toBeNull();
  });
});
