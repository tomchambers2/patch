// A chat row highlight is driven by the store's `activeChatId`, which is also
// set while parked on a non-chat route (the Jobs skill-edit link opens a chat
// in the editor rail without leaving `/jobs/:id`). Left unguarded, the row
// stays lit after navigating to Jobs/Settings — the selected state should
// always show the page the user is actually on (spec/14 § Sidebar §7: the
// bottom nav row for the current page gets `active`).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { JSX } from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Sidebar } from '../components/Sidebar.js';
import { ConfirmModal } from '../components/ConfirmModal.js';
import { useChatStore } from '../stores/chatStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useVoiceStore } from '../stores/voiceStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { useSelectionStore } from '../stores/selectionStore.js';
import { api } from '../api/rest.js';
import type { ChatRow } from '../stores/types.js';

function rowFixture(overrides: Partial<ChatRow> = {}): ChatRow {
  return {
    chatId: 'c1',
    daemonId: 'd1',
    permissionMode: 'bypassPermissions' as const,
    name: 'a chat',
    folder: '~/proj',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: Date.now(),
    ...overrides,
  } as ChatRow;
}

function renderAt(path: string, ui: JSX.Element = <Sidebar />): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      {ui}
      <ConfirmModal />
    </MemoryRouter>,
  );
}

describe('Sidebar selection tracks the page you are actually on', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useChatStore.getState()._reset();
    usePresenceStore.getState().setConnection('connected');
    useVoiceStore.setState({ activeDevices: {} });
    useUiStore.getState().setChannelsOpen(false);
    useUiStore.getState().setArchivedOpen(false);
    useUiStore.getState().setDeletedOpen(false);
    useUiStore.getState().setAttentionOnly(false);
    useUiStore.setState({ forgottenFolders: [], errors: [] });
    useUiStore.getState().setSearchQuery('');
    useUiStore.getState().resolveConfirm(false);
    useSelectionStore.setState({ order: [], anchor: null, selected: [] });
    vi.spyOn(api, 'listChatsArchived').mockResolvedValue({ chats: [], nextOffset: null });
    vi.spyOn(api, 'listChatsDeleted').mockResolvedValue({ chats: [], nextOffset: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it('highlights the open chat row while actually on its /chats/:id route', () => {
    useChatStore.getState().hydrate([rowFixture({ chatId: 'r1' })]);
    useChatStore.getState().setActiveChat('r1');
    renderAt('/chats/r1');
    expect(screen.getByTestId('chat-row-r1')).toHaveClass('active');
  });

  it('drops the chat row highlight once the route is Settings, even with activeChatId still set', () => {
    // Mirrors the Jobs "Edit" skill link: it calls setActiveChat to drive the
    // editor rail without ever putting the router on a /chats/:id route.
    useChatStore.getState().hydrate([rowFixture({ chatId: 'r1' })]);
    useChatStore.getState().setActiveChat('r1');
    renderAt('/settings');
    expect(screen.getByTestId('chat-row-r1')).not.toHaveClass('active');
  });

  it('drops the chat row highlight once the route is Jobs, even with activeChatId still set', () => {
    useChatStore.getState().hydrate([rowFixture({ chatId: 'r1' })]);
    useChatStore.getState().setActiveChat('r1');
    renderAt('/jobs');
    expect(screen.getByTestId('chat-row-r1')).not.toHaveClass('active');
  });

  it('marks the Settings bottom-nav row active while on /settings', () => {
    useChatStore.getState().hydrate([rowFixture({ chatId: 'r1' })]);
    renderAt('/settings');
    expect(screen.getByTestId('nav-settings')).toHaveClass('active');
    expect(screen.getByTestId('nav-jobs')).not.toHaveClass('active');
  });

  it('marks the Jobs bottom-nav row active while on /jobs', () => {
    useChatStore.getState().hydrate([rowFixture({ chatId: 'r1' })]);
    renderAt('/jobs');
    expect(screen.getByTestId('nav-jobs')).toHaveClass('active');
    expect(screen.getByTestId('nav-settings')).not.toHaveClass('active');
  });

  it('marks neither bottom-nav row active while on a chat route', () => {
    useChatStore.getState().hydrate([rowFixture({ chatId: 'r1' })]);
    useChatStore.getState().setActiveChat('r1');
    renderAt('/chats/r1');
    expect(screen.getByTestId('nav-jobs')).not.toHaveClass('active');
    expect(screen.getByTestId('nav-settings')).not.toHaveClass('active');
  });
});
