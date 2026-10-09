// /lifecycle/:kind — the main-window view of a cold-storage section (App
// Updates: "can also open in main window"). Reuses the exact section
// components the sidebar renders inline, so this file only pins the route's
// own concerns: which kind renders which heading/section, and the unknown-kind
// fallback. The section bodies themselves (fetch-on-mount, row rendering,
// Show/Unsnooze/Restore) are Sidebar.test.tsx's job.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { LifecycleRoute } from '../routes/LifecycleRoute.js';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { api } from '../api/rest.js';

function renderAt(kind: string): void {
  render(
    <MemoryRouter initialEntries={[`/lifecycle/${kind}`]}>
      <Routes>
        <Route path="/lifecycle/:kind" element={<LifecycleRoute />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('LifecycleRoute', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    vi.spyOn(api, 'listChatsArchived').mockResolvedValue({ chats: [], nextOffset: null });
    vi.spyOn(api, 'listChatsDeleted').mockResolvedValue({ chats: [], nextOffset: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it('renders the Archived heading and section for /lifecycle/archived', () => {
    renderAt('archived');
    expect(screen.getByRole('heading', { name: 'Archived' })).toBeInTheDocument();
    expect(screen.getByTestId('lifecycle-route-archived')).toBeInTheDocument();
    expect(screen.getByTestId('archived-section')).toBeInTheDocument();
  });

  it('renders the Hidden heading and section for /lifecycle/hidden', () => {
    renderAt('hidden');
    expect(screen.getByRole('heading', { name: 'Hidden' })).toBeInTheDocument();
    expect(screen.getByTestId('lifecycle-route-hidden')).toBeInTheDocument();
    expect(screen.getByTestId('hidden-section')).toBeInTheDocument();
  });

  it('reports an unknown kind rather than rendering a blank page', () => {
    renderAt('bogus');
    expect(screen.getByTestId('lifecycle-route-error')).toHaveTextContent('bogus');
  });

  it('shows the rows already in the store for the section it renders', () => {
    useChatStore.getState().hydrate([
      {
        chatId: 'a1',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions',
        name: 'an archived chat',
        folder: '~/proj',
        activity: 'idle',
        status: 'archived',
        pinned: false,
        pinnedAt: null,
        disabled: false,
        lastUpdated: 1,
      },
    ]);
    renderAt('archived');
    expect(screen.getByTestId('chat-row-a1')).toBeInTheDocument();
  });

  // spec/14 § Sidebar item 6: "load a limited number... then load more on
  // scroll" holds in this main-window view too, not just the sidebar's own
  // capped band — same section component, same pagination hook.
  it('loads the next page when its own scroll region nears the bottom', async () => {
    useUiStore.setState({ lifecycleScrollTick: 0 });
    const listChatsHidden = vi
      .spyOn(api, 'listChatsHidden')
      .mockResolvedValueOnce({
        chats: [
          {
            chatId: 'h1',
            name: 'h1',
            preview: null,
            folder: '~/proj',
            activity: 'running',
            status: 'active',
            pinned: false,
            pinnedAt: null,
            snoozedUntil: null,
            hidden: true,
            lastUpdated: 1,
            daemonId: 'd1',
            permissionMode: 'auto',
            jobId: 'j1',
            statusSummary: null,
            statusKind: null,
          },
        ],
        nextOffset: 1,
      })
      .mockResolvedValueOnce({
        chats: [
          {
            chatId: 'h2',
            name: 'h2',
            preview: null,
            folder: '~/proj',
            activity: 'running',
            status: 'active',
            pinned: false,
            pinnedAt: null,
            snoozedUntil: null,
            hidden: true,
            lastUpdated: 2,
            daemonId: 'd1',
            permissionMode: 'auto',
            jobId: 'j1',
            statusSummary: null,
            statusKind: null,
          },
        ],
        nextOffset: null,
      });
    renderAt('hidden');
    await screen.findByTestId('chat-row-h1');
    expect(listChatsHidden).toHaveBeenCalledTimes(1);

    const route = screen.getByTestId('lifecycle-route');
    Object.defineProperty(route, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(route, 'clientHeight', { value: 300, configurable: true });
    Object.defineProperty(route, 'scrollTop', { value: 650, configurable: true });
    fireEvent.scroll(route);

    await waitFor(() => expect(listChatsHidden).toHaveBeenCalledTimes(2));
    expect(listChatsHidden).toHaveBeenLastCalledWith({ limit: 30, offset: 1 });
    await screen.findByTestId('chat-row-h2');
  });
});
