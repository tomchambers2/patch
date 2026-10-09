// spec/04 § Snooze / spec/14 § Chat lifecycle → Snooze: a snoozed chat still
// OPENS normally (snooze changes only where the chat is listed, not whether it
// works), with a banner naming its wake time and an Unsnooze control.

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
    snoozeChat: vi.fn(async () => undefined),
  },
}));

const NOW = 1_700_000_000_000;

function seed(snoozedUntil: number | null): void {
  useChatStore.getState().hydrate([
    {
      chatId: 'c1',
      daemonId: 'd1',
      permissionMode: 'bypassPermissions' as const,
      name: 'fix layout',
      folder: 'foo',
      activity: 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      disabled: false,
      lastUpdated: 0,
      snoozedUntil,
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

describe('ChatRoute — snoozed chat panel', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    useUiStore.getState().clearToasts();
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    setActiveWs(null);
    vi.mocked(api.snoozeChat)
      .mockReset()
      .mockResolvedValue(undefined as never);
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => {
    cleanup();
    deliveryTracker.reset();
    setActiveWs(null);
    vi.restoreAllMocks();
  });

  it('shows a Snoozed banner naming the wake time, and keeps the composer', () => {
    seed(NOW + 3_600_000);
    renderChat();
    expect(screen.getByTestId('snoozed-banner')).toHaveTextContent(/Snoozed until/);
    // Snoozing is not muting — the chat still sends.
    expect(screen.getByTestId('composer')).toBeInTheDocument();
  });

  it('Unsnooze clears the snooze via the API', async () => {
    seed(NOW + 3_600_000);
    renderChat();
    fireEvent.click(screen.getByTestId('unsnooze-banner-btn'));
    await waitFor(() => expect(api.snoozeChat).toHaveBeenCalledWith('c1', null));
    expect(useChatStore.getState().chats['c1']?.snoozedUntil).toBe(null);
  });

  it('a failed unsnooze reverts and toasts', async () => {
    vi.mocked(api.snoozeChat).mockRejectedValue(new Error('nope') as never);
    seed(NOW + 3_600_000);
    renderChat();
    fireEvent.click(screen.getByTestId('unsnooze-banner-btn'));
    await waitFor(() => expect(useUiStore.getState().errors.length).toBe(1));
    expect(useChatStore.getState().chats['c1']?.snoozedUntil).toBe(NOW + 3_600_000);
  });

  it('a chat whose snooze has lapsed shows no banner', () => {
    seed(NOW - 1);
    renderChat();
    expect(screen.queryByTestId('snoozed-banner')).toBeNull();
  });
});
