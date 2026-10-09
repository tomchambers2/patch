// spec/14 § Sidebar §1, § New windows — /sidebar-window: the sidebar
// detached into its own window. No chat panel, no editor rail — just the
// chat list filling the window, wired to the same live state as the docked
// sidebar.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SidebarWindowRoute } from '../routes/SidebarWindowRoute.js';
import { useChatStore } from '../stores/chatStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { api } from '../api/rest.js';

describe('SidebarWindowRoute', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    usePresenceStore.getState().setConnection('connected');
    vi.spyOn(api, 'listChatsArchived').mockResolvedValue({ chats: [], nextOffset: null });
    vi.spyOn(api, 'listChatsDeleted').mockResolvedValue({ chats: [], nextOffset: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it('renders a standalone sidebar filling a .three-col wrapper', () => {
    render(
      <MemoryRouter>
        <SidebarWindowRoute />
      </MemoryRouter>,
    );
    const wrapper = screen.getByTestId('sidebar-window');
    expect(wrapper.className).toContain('three-col');
    const sidebar = screen.getByTestId('sidebar');
    expect(wrapper.contains(sidebar)).toBe(true);
    expect(sidebar.style.width).toBe('100%');
  });

  it('hides the collapse + open-in-new-window controls (nothing to collapse/open into from here)', () => {
    render(
      <MemoryRouter>
        <SidebarWindowRoute />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('sidebar-collapse')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sidebar-open-window')).not.toBeInTheDocument();
  });

  it('still shows both New chat buttons, wired to live state', () => {
    render(
      <MemoryRouter>
        <SidebarWindowRoute />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('new-chat-fab')).toBeInTheDocument();
    expect(screen.getByTestId('new-chat-split-toggle')).toBeInTheDocument();
  });

  it('reflects the live chat store (e.g. a hydrated chat row)', () => {
    useChatStore.getState().hydrate([
      {
        chatId: 'sw1',
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
      },
    ]);
    render(
      <MemoryRouter>
        <SidebarWindowRoute />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('chat-row-sw1')).toBeInTheDocument();
  });
});
