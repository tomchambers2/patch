// patch/todo.md: "Archived state does not show in chat. Need a way to show it
// and unarchive it (archive should still allow sending messages)."
//
// When a chat is archived it still opens in the main panel (spec/04 §
// Lifecycle — history is never deleted; archive is sticky, so sending keeps it
// archived rather than un-archiving). But the panel gave NO indication the chat
// was archived and NO way to bring it back.
// These tests lock in: (1) an archived chat shows an "Archived" banner in the
// panel, (2) the banner's Unarchive control flips it back to active via the
// API (optimistic, reverting + surfacing a toast on failure), and (3) the
// composer stays available so the user can still send — an active chat shows
// no banner.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ChatRoute } from '../routes/ChatRoute.js';
import { api } from '../api/rest.js';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { deliveryTracker } from '../lib/deliveryTracker.js';
import { setActiveWs } from '../api/ws.js';

vi.mock('../api/rest.js', () => ({
  api: {
    markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
    getFileContent: vi.fn(async () => ({ path: '', content: '', size: 0 })),
    getFileContentAtHead: vi.fn(async () => ({ path: '', content: '', size: 0 })),
    archiveChat: vi.fn(async () => undefined),
  },
}));

function seed(status: 'active' | 'archived'): void {
  useChatStore.getState().hydrate([
    {
      chatId: 'c1',
      daemonId: 'd1',
      permissionMode: 'bypassPermissions' as const,
      name: 'fix layout',
      folder: 'foo',
      activity: 'idle',
      status,
      pinned: false,
      pinnedAt: null,
      disabled: false,
      lastUpdated: 0,
    },
  ]);
}

function renderChat(): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={['/chats/c1']}>
      <Routes>
        <Route path="/chats/:chatId" element={<ChatRoute ws={null} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ChatRoute — archived chat panel', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    useUiStore.getState().clearToasts();
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    setActiveWs(null);
    vi.mocked(api.archiveChat)
      .mockReset()
      .mockResolvedValue(undefined as never);
  });
  afterEach(() => {
    cleanup();
    deliveryTracker.reset();
    setActiveWs(null);
  });

  it('shows an Archived banner + Unarchive control for an archived chat', () => {
    seed('archived');
    renderChat();
    expect(screen.getByTestId('archived-banner')).toBeInTheDocument();
    const btn = screen.getByTestId('unarchive-btn');
    expect(btn).toBeInTheDocument();
    // An open box for the way back, not the closed Archive glyph.
    expect(btn.querySelector('svg')?.getAttribute('class')).toContain('lucide-package-open');
  });

  it('does NOT show the Archived banner for an active chat', () => {
    seed('active');
    renderChat();
    expect(screen.queryByTestId('archived-banner')).not.toBeInTheDocument();
  });

  it('keeps the composer for an archived chat (archive still allows sending)', () => {
    seed('archived');
    renderChat();
    // The chat is archived but NOT a read-only mirror — the composer stays so
    // the user can send. Per spec/04 archive is sticky: sending does NOT
    // un-archive; only the banner's Unarchive control does.
    expect(screen.getByTestId('composer')).toBeInTheDocument();
    expect(screen.queryByTestId('composer-readonly')).not.toBeInTheDocument();
  });

  it('Unarchive optimistically flips to active and persists via the API', async () => {
    seed('archived');
    renderChat();
    fireEvent.click(screen.getByTestId('unarchive-btn'));
    // Optimistic: status is now active, so the banner is gone.
    expect(useChatStore.getState().chats['c1']?.status).toBe('active');
    await waitFor(() => {
      expect(api.archiveChat).toHaveBeenCalledWith('c1', false);
    });
    expect(screen.queryByTestId('archived-banner')).not.toBeInTheDocument();
  });

  it('Unarchive reverts to archived + surfaces a toast on API failure (NO FALLBACK)', async () => {
    vi.mocked(api.archiveChat).mockRejectedValueOnce(new Error('network down'));
    seed('archived');
    renderChat();
    fireEvent.click(screen.getByTestId('unarchive-btn'));
    // Optimistic flip first.
    expect(useChatStore.getState().chats['c1']?.status).toBe('active');
    // Then reverts on failure and the error is surfaced.
    await waitFor(() => {
      expect(useChatStore.getState().chats['c1']?.status).toBe('archived');
    });
    expect(useUiStore.getState().errors[0]?.message).toContain('Unarchive failed');
  });
});
