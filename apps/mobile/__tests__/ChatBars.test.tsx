// The chat-detail status bars (spec/15 § Chat detail → Status bars) — the
// mobile ports of web's GoalBanner, TaskBar, ReminderBanner, BackgroundTaskBar,
// ArchivedBanner and ClaudeDisconnectedBanner. Same data (the chat row and its
// transcript), same REST routes, same optimistic-with-honest-revert contract.
// Each is exercised through the real chat store, so a write is proven to land
// on the row the screen renders from.

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TodoItem } from '@patch/wire';
import {
  renderRN,
  findHost,
  findAllHost,
  queryHost,
  byTestId,
  hasText,
  actSync,
  actAsync,
} from './testUtils/render';
import { useChatStore } from '../src/stores/chatStore';
import { usePresenceStore } from '../src/stores/presenceStore';
import { useUiStore } from '../src/stores/uiStore';
import { routerMock } from './stubs/expo-router';

const apiMocks = {
  setGoal: vi.fn(async () => undefined),
  setReminder: vi.fn(async () => undefined),
  setTodos: vi.fn(async () => undefined),
  archiveChat: vi.fn(async () => undefined),
  hideChat: vi.fn(async (): Promise<unknown> => undefined),
  watchList: vi.fn(async () => ({ tasks: [] })),
};
vi.mock('../src/api/rest', () => ({ api: apiMocks }));

const { ChatBars } = await import('../src/components/ChatBars');

function Harness(): React.ReactElement {
  const row = useChatStore((s) => s.chats['c1']);
  return <ChatBars chatId="c1" row={row} />;
}

function seed(extra: Record<string, unknown> = {}): void {
  useChatStore.getState().hydrate([
    {
      chatId: 'c1',
      name: 'Chat',
      daemonId: 'd1',
      folder: '/home/tom/p',
      activity: 'idle',
      permissionMode: 'auto',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      lastUpdated: 1,
      ...extra,
    },
  ]);
}

const TODOS: TodoItem[] = [
  { text: 'Read the spec', status: 'completed' },
  { text: 'Rebuild the index', status: 'in_progress' },
  { text: 'Ship it', status: 'pending' },
];

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => {
  vi.clearAllMocks();
  useChatStore.getState()._reset();
  useUiStore.setState({ errors: [] });
  usePresenceStore.setState({ hosts: {} });
  usePresenceStore.getState().setConnection('connected');
  usePresenceStore.getState().setDaemon('online');
});

describe('ChatBars — an ordinary chat', () => {
  it('draws none of the bars when there is nothing to say', () => {
    seed();
    const r = renderRN(<Harness />);
    for (const id of [
      'goal-bar',
      'task-bar',
      'reminder-bar',
      'background-task-bar',
      'artifact-bar',
      'hidden-bar',
      'archived-bar',
      'claude-disconnected-bar',
    ]) {
      expect(queryHost(r.root, byTestId(id))).toBeNull();
    }
  });
});

describe('Goal bar', () => {
  it('reads the goal on one line, and opens to the full editable text', () => {
    seed({ goal: 'Get the bus tracker working' });
    const r = renderRN(<Harness />);
    const summary = findHost(r.root, byTestId('goal-bar-summary'));
    expect(hasText(summary, 'Get the bus tracker working')).toBe(true);
    expect(findAllHost(summary, (i) => i.props.numberOfLines === 1)).toHaveLength(1);
    actSync(() => findHost(r.root, byTestId('goal-bar-toggle')).props.onPress());
    expect(queryHost(r.root, byTestId('goal-bar-text'))).not.toBeNull();
  });

  it('editing commits through the same route as web and lands on the row', async () => {
    seed({ goal: 'old goal' });
    const r = renderRN(<Harness />);
    actSync(() => findHost(r.root, byTestId('goal-bar-summary')).props.onPress());
    actSync(() => findHost(r.root, byTestId('goal-bar-text')).props.onPress());
    const input = findHost(r.root, byTestId('goal-bar-text-input'));
    actSync(() => input.props.onChangeText('new goal'));
    actSync(() => findHost(r.root, byTestId('goal-bar-text-input')).props.onSubmitEditing());
    await flush();
    expect(apiMocks.setGoal).toHaveBeenCalledWith('c1', 'new goal');
    expect(useChatStore.getState().chats['c1']!.goal).toBe('new goal');
  });

  it('an unchanged edit writes nothing', async () => {
    seed({ goal: 'same' });
    const r = renderRN(<Harness />);
    actSync(() => findHost(r.root, byTestId('goal-bar-summary')).props.onPress());
    actSync(() => findHost(r.root, byTestId('goal-bar-text')).props.onPress());
    actSync(() => findHost(r.root, byTestId('goal-bar-text-input')).props.onBlur());
    await flush();
    expect(apiMocks.setGoal).not.toHaveBeenCalled();
  });

  it('× clears it; a refused clear puts it back and says so', async () => {
    seed({ goal: 'keep me' });
    apiMocks.setGoal.mockRejectedValueOnce(new Error('host offline'));
    const r = renderRN(<Harness />);
    actSync(() => findHost(r.root, byTestId('goal-clear-btn')).props.onPress());
    await flush();
    expect(apiMocks.setGoal).toHaveBeenCalledWith('c1', null);
    expect(useChatStore.getState().chats['c1']!.goal).toBe('keep me');
    expect(useUiStore.getState().errors.at(-1)?.message).toBe('clearing goal failed: host offline');
  });
});

describe('Task bar', () => {
  it('collapsed: the item in progress and done/total', () => {
    seed({ todos: TODOS });
    const r = renderRN(<Harness />);
    expect(hasText(findHost(r.root, byTestId('task-bar-head')), 'Rebuild the index')).toBe(true);
    expect(hasText(findHost(r.root, byTestId('task-bar-count')), '1/3')).toBe(true);
    expect(queryHost(r.root, byTestId('task-bar-list'))).toBeNull();
  });

  it('reads "All tasks done" once everything is complete', () => {
    seed({ todos: [{ text: 'a', status: 'completed' }] });
    const r = renderRN(<Harness />);
    expect(hasText(findHost(r.root, byTestId('task-bar-head')), 'All tasks done')).toBe(true);
  });

  it('expanded: cycling a status sends the WHOLE list', async () => {
    seed({ todos: TODOS });
    const r = renderRN(<Harness />);
    actSync(() => findHost(r.root, byTestId('task-bar-summary')).props.onPress());
    expect(findAllHost(r.root, byTestId('task-row'))).toHaveLength(3);
    actSync(() => findAllHost(r.root, byTestId('task-status-btn'))[2]!.props.onPress());
    await flush();
    expect(apiMocks.setTodos).toHaveBeenCalledWith('c1', [
      TODOS[0],
      TODOS[1],
      { text: 'Ship it', status: 'in_progress' },
    ]);
  });

  it('expanded: delete, rename and add each write the whole list', async () => {
    seed({ todos: TODOS });
    const r = renderRN(<Harness />);
    actSync(() => findHost(r.root, byTestId('task-bar-summary')).props.onPress());

    actSync(() => findAllHost(r.root, byTestId('task-delete-btn'))[0]!.props.onPress());
    await flush();
    expect(apiMocks.setTodos).toHaveBeenLastCalledWith('c1', [TODOS[1], TODOS[2]]);

    actSync(() => findAllHost(r.root, byTestId('task-text'))[0]!.props.onPress());
    actSync(() => findHost(r.root, byTestId('task-text-input')).props.onChangeText('Rebuild it'));
    actSync(() => findHost(r.root, byTestId('task-text-input')).props.onSubmitEditing());
    await flush();
    expect(apiMocks.setTodos).toHaveBeenLastCalledWith('c1', [
      { text: 'Rebuild it', status: 'in_progress' },
      TODOS[2],
    ]);

    actSync(() => findHost(r.root, byTestId('task-add-input')).props.onChangeText('  Tell Tom '));
    actSync(() => findHost(r.root, byTestId('task-add-input')).props.onSubmitEditing());
    await flush();
    expect(apiMocks.setTodos).toHaveBeenLastCalledWith('c1', [
      { text: 'Rebuild it', status: 'in_progress' },
      TODOS[2],
      { text: 'Tell Tom', status: 'pending' },
    ]);
  });

  it('a refused edit reverts the list and raises a toast', async () => {
    seed({ todos: TODOS });
    apiMocks.setTodos.mockRejectedValueOnce(new Error('nope'));
    const r = renderRN(<Harness />);
    actSync(() => findHost(r.root, byTestId('task-bar-summary')).props.onPress());
    actSync(() => findAllHost(r.root, byTestId('task-delete-btn'))[0]!.props.onPress());
    await flush();
    expect(useChatStore.getState().chats['c1']!.todos).toEqual(TODOS);
    expect(useUiStore.getState().errors.at(-1)?.message).toBe('updating tasks failed: nope');
  });
});

describe('Reminder bar', () => {
  it('one line at rest, the full reminder on tap, × clears', async () => {
    seed({ reminder: 'Do not touch prod' });
    const r = renderRN(<Harness />);
    expect(findHost(r.root, byTestId('reminder-bar-text')).props.numberOfLines).toBe(1);
    actSync(() => findHost(r.root, byTestId('reminder-bar-summary')).props.onPress());
    expect(findHost(r.root, byTestId('reminder-bar-text')).props.numberOfLines).toBeUndefined();
    actSync(() => findHost(r.root, byTestId('reminder-clear-btn')).props.onPress());
    await flush();
    expect(apiMocks.setReminder).toHaveBeenCalledWith('c1', null);
    expect(queryHost(r.root, byTestId('reminder-bar'))).toBeNull();
  });
});

describe('Archived bar', () => {
  it('names the state and Unarchive restores it through the row-tools toggle', async () => {
    seed({ status: 'archived' });
    const r = renderRN(<Harness />);
    expect(hasText(findHost(r.root, byTestId('archived-bar')), 'Archived')).toBe(true);
    actSync(() => findHost(r.root, byTestId('unarchive-bar-btn')).props.onPress());
    await flush();
    expect(apiMocks.archiveChat).toHaveBeenCalledWith('c1', false);
    expect(queryHost(r.root, byTestId('archived-bar'))).toBeNull();
  });
});

describe('Hidden bar', () => {
  it('names the state and Show moves the chat into the active list', async () => {
    seed({ hidden: true });
    const r = renderRN(<Harness />);
    expect(hasText(findHost(r.root, byTestId('hidden-bar')), 'Hidden')).toBe(true);
    actSync(() => findHost(r.root, byTestId('show-bar-btn')).props.onPress());
    await flush();
    expect(apiMocks.hideChat).toHaveBeenCalledWith('c1', false);
    expect(useChatStore.getState().chats['c1']?.hidden).toBe(false);
    expect(queryHost(r.root, byTestId('hidden-bar'))).toBeNull();
  });

  it('a refused Show puts the chat back in Hidden and says so', async () => {
    apiMocks.hideChat.mockRejectedValueOnce(new Error('host offline'));
    seed({ hidden: true });
    const r = renderRN(<Harness />);
    actSync(() => findHost(r.root, byTestId('show-bar-btn')).props.onPress());
    await actAsync(async () => {});
    expect(useChatStore.getState().chats['c1']?.hidden).toBe(true);
    expect(queryHost(r.root, byTestId('hidden-bar'))).not.toBeNull();
    expect(useUiStore.getState().errors.map((e) => e.message)).toContain(
      'show failed: host offline',
    );
  });

  it('an archived chat that keeps the flag draws the Archived bar, not Hidden', () => {
    seed({ hidden: true, status: 'archived' });
    const r = renderRN(<Harness />);
    expect(queryHost(r.root, byTestId('hidden-bar'))).toBeNull();
    expect(queryHost(r.root, byTestId('archived-bar'))).not.toBeNull();
  });
});

describe('Claude disconnected bar', () => {
  function account(connected: boolean): void {
    usePresenceStore.getState().setHostAccount({
      type: 'daemon.account',
      daemonId: 'd1',
      backendId: 'claude-code',
      connected,
    });
  }

  it('shows only on a definite connected:false from THIS chat’s host, and links to Settings', () => {
    seed();
    const r = renderRN(<Harness />);
    expect(queryHost(r.root, byTestId('claude-disconnected-bar'))).toBeNull();
    actSync(() => account(false));
    const bar = findHost(r.root, byTestId('claude-disconnected-bar'));
    expect(hasText(bar, 'isn’t signed in to Claude')).toBe(true);
    findHost(r.root, byTestId('claude-disconnected-signin')).props.onPress();
    expect(routerMock.push).toHaveBeenCalledWith('/(tabs)/settings');
    actSync(() => account(true));
    expect(queryHost(r.root, byTestId('claude-disconnected-bar'))).toBeNull();
  });

  it('a different host being signed out says nothing about this chat', () => {
    seed();
    usePresenceStore.getState().setHostAccount({
      type: 'daemon.account',
      daemonId: 'other',
      backendId: 'claude-code',
      connected: false,
    });
    const r = renderRN(<Harness />);
    expect(queryHost(r.root, byTestId('claude-disconnected-bar'))).toBeNull();
  });
});
