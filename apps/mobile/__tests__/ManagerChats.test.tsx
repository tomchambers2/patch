// The Manager chat's Chats tab and its Conversation | Chats switch (spec/15
// § Voice tab (Manager)). Pins: needs-you-first ordering (the shared `threadRows` rule),
// inline Approve for a pending permission, Stop for a running turn, tap to
// open, the status summary, the empty state, and that a dropped link still
// resolves the permission and holds it for redelivery (permissionDeliveryTracker.ts)
// rather than a tap that silently did nothing.

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FlatList as RNFlatList } from 'react-native';
import {
  renderRN,
  findHost,
  queryHost,
  byLabel,
  byTestId,
  hasText,
  actSync,
} from './testUtils/render';
import { useChatStore } from '../src/stores/chatStore';
import { useUiStore } from '../src/stores/uiStore';
import { routerMock, __resetRouterMock } from './stubs/expo-router';
import type { ChatListRow } from '../src/stores/types';

const wsMock = { send: vi.fn(), safeSend: vi.fn(), requestReplay: vi.fn() };
vi.mock('../src/api/ws', () => ({ getWs: () => wsMock }));

import { ManagerChatsList, ManagerSegments } from '../src/components/ManagerChats';
import { permissionDeliveryTracker } from '../src/lib/permissionDeliveryTracker';

function listRow(chatId: string, over: Partial<ChatListRow> = {}): ChatListRow {
  return {
    chatId,
    name: `Chat ${chatId}`,
    daemonId: 'd1',
    folder: '~/proj',
    activity: 'idle',
    permissionMode: 'default',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    lastUpdated: 1,
    ...over,
  };
}

function askPermission(chatId: string, requestId: string, tool = 'Bash'): void {
  useChatStore.getState().applyEvent({
    type: 'chat.permission_request',
    chatId,
    seq: 3,
    requestId,
    request: { tool, description: 'run it', args: { command: 'ls' } },
  });
}

function renderedIds(r: ReturnType<typeof renderRN>): string[] {
  const list = r.root.findByType(RNFlatList as unknown as React.ComponentType);
  return (list.props.data as { chatId: string }[]).map((c) => c.chatId);
}

beforeEach(() => {
  vi.clearAllMocks();
  wsMock.send.mockImplementation(() => undefined);
  useChatStore.getState()._reset();
  useUiStore.setState({ errors: [] });
  __resetRouterMock();
  permissionDeliveryTracker.reset();
});

describe('ManagerChatsList', () => {
  it('lists active chats needs-you first, then running, then by recency; no special threads', () => {
    useChatStore
      .getState()
      .hydrate([
        listRow('idle-new', { lastUpdated: 50 }),
        listRow('idle-old', { lastUpdated: 10 }),
        listRow('running', { activity: 'running', lastUpdated: 5 }),
        listRow('asks', { lastUpdated: 2 }),
        listRow('declared-q', { lastUpdated: 3, statusKind: 'question', statusDeclared: true }),
        listRow('archived', { status: 'archived', lastUpdated: 99 }),
        listRow('snoozed', { snoozedUntil: Date.now() + 60_000, lastUpdated: 99 }),
        listRow('thread_manager', { activity: 'running' }),
        listRow('thread_speakers'),
      ]);
    askPermission('asks', 'r1');
    const r = renderRN(<ManagerChatsList />);
    expect(renderedIds(r)).toEqual(['asks', 'declared-q', 'running', 'idle-new', 'idle-old']);
  });

  it('shows the host, folder, state word and status summary on a row', () => {
    useChatStore
      .getState()
      .hydrate([
        listRow('c1', { statusSummary: 'Needs a yes on the migration', statusKind: 'report' }),
      ]);
    const r = renderRN(<ManagerChatsList />);
    const row = findHost(r.root, byTestId('manager-thread-c1'));
    expect(hasText(row, 'Needs a yes on the migration')).toBe(true);
    expect(hasText(row, 'd1 · ~/proj')).toBe(true);
    expect(hasText(row, 'report')).toBe(true);
  });

  it('Approve answers the pending permission and resolves it locally', () => {
    // A chat owned by a host other than the home one: the response must name
    // the chat so the server relays it there, not to Hetzner where it is lost.
    useChatStore.getState().hydrate([listRow('c1', { daemonId: 'mac' })]);
    askPermission('c1', 'req-1');
    const r = renderRN(<ManagerChatsList />);
    actSync(() => findHost(r.root, byLabel('Approve Chat c1')).props.onPress());
    expect(wsMock.send).toHaveBeenCalledWith({
      type: 'chat.permission_response',
      chatId: 'c1',
      requestId: 'req-1',
      approve: true,
      decision: 'approve',
    });
    expect(useChatStore.getState().chats['c1']?.pendingPermissions).toEqual([]);
  });

  it('does not offer Approve for an AskUserQuestion — that has to be answered in the chat', () => {
    useChatStore.getState().hydrate([listRow('c1')]);
    askPermission('c1', 'req-q', 'AskUserQuestion');
    const r = renderRN(<ManagerChatsList />);
    expect(queryHost(r.root, byLabel('Approve Chat c1'))).toBeNull();
    expect(hasText(r.root, 'needs approval')).toBe(true);
  });

  it('Stop sends a stop request for a running chat, and only a running chat has it', () => {
    useChatStore
      .getState()
      .hydrate([listRow('run', { activity: 'running' }), listRow('idle', { lastUpdated: 9 })]);
    const r = renderRN(<ManagerChatsList />);
    expect(queryHost(r.root, byLabel('Stop Chat idle'))).toBeNull();
    actSync(() => findHost(r.root, byLabel('Stop Chat run')).props.onPress());
    expect(wsMock.send).toHaveBeenCalledWith({ type: 'chat.stop_request', chatId: 'run' });
  });

  it('a dropped link resolves the permission anyway and holds it for redelivery, with no error toast', () => {
    // Tom, Todoist: "questions are timing out after I answer them" — a quick
    // approve from the Manager list is exposed to the same silently-dropped
    // send as the inline card. It now resolves like any other answer and
    // lets `permissionDeliveryTracker` redeliver once the link is good,
    // rather than leaving an approve tap looking like it did nothing.
    wsMock.send.mockImplementation(() => {
      throw new Error('PatchWs: not connected');
    });
    useChatStore.getState().hydrate([listRow('c1')]);
    askPermission('c1', 'req-1');
    const r = renderRN(<ManagerChatsList />);
    actSync(() => findHost(r.root, byLabel('Approve Chat c1')).props.onPress());
    expect(useUiStore.getState().errors).toEqual([]);
    expect(useChatStore.getState().chats['c1']?.pendingPermissions).toHaveLength(0);
    expect(permissionDeliveryTracker.size()).toBe(1);
  });

  it('tapping a row opens that chat', () => {
    useChatStore.getState().hydrate([listRow('c1')]);
    const r = renderRN(<ManagerChatsList />);
    findHost(r.root, byLabel('Open Chat c1')).props.onPress();
    expect(routerMock.push).toHaveBeenCalledWith('/chats/c1');
  });

  it('shows an empty state when nothing is active', () => {
    const r = renderRN(<ManagerChatsList />);
    expect(hasText(r.root, 'Nothing running')).toBe(true);
  });
});

describe('ManagerSegments', () => {
  it('renders nothing on a chat other than Manager', () => {
    const r = renderRN(<ManagerSegments chatId="c1" value="conversation" onChange={() => {}} />);
    expect(r.toJSON()).toBeNull();
  });

  it('offers Conversation and Chats on Manager, marking the selected one', () => {
    const onChange = vi.fn();
    const r = renderRN(
      <ManagerSegments chatId="thread_manager" value="conversation" onChange={onChange} />,
    );
    expect(findHost(r.root, byLabel('Conversation')).props.accessibilityState).toEqual({
      selected: true,
    });
    actSync(() => findHost(r.root, byLabel('Chats')).props.onPress());
    expect(onChange).toHaveBeenCalledWith('chats');
  });
});
