// An opened lifecycle panel carries a filter box: rows narrow to the ones whose
// name or preview contains the text, and while it is typed the remaining pages
// are fetched so a match further down the list is not silently missing.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Sidebar } from '../components/Sidebar.js';
import { useChatStore } from '../stores/chatStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useVoiceStore } from '../stores/voiceStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { api } from '../api/rest.js';

function archivedRow(chatId: string, name: string, preview: string | null, lastUpdated: number) {
  return {
    chatId,
    name,
    preview,
    folder: '~/proj',
    activity: 'idle' as const,
    status: 'archived' as const,
    pinned: false,
    pinnedAt: null,
    snoozedUntil: null,
    hidden: false,
    lastUpdated,
    daemonId: 'd1',
    permissionMode: 'auto' as const,
    jobId: null,
    statusSummary: null,
    statusKind: null,
  };
}

describe('Sidebar — lifecycle panel filter', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    usePresenceStore.getState().setConnection('connected');
    useVoiceStore.setState({ activeDevices: {} });
    useUiStore.getState().setArchivedOpen(false);
    useUiStore.setState({ forgottenFolders: [], errors: [], lifecycleScrollTick: 0 });
    useUiStore.getState().setSearchQuery('');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  function open(): void {
    useChatStore
      .getState()
      .setSectionCounts({ hidden: 0, archived: 3, snoozed: 0, deleted: 0, automations: 0 });
    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId('archived-toggle'));
  }

  it('narrows rows by name or preview, case-insensitively, and restores them when cleared', async () => {
    vi.spyOn(api, 'listChatsArchived').mockResolvedValue({
      chats: [
        archivedRow('a1', 'Weekly Timesheet', null, 3),
        archivedRow('a2', 'Process Teams', 'teams messages please', 2),
        archivedRow('a3', 'Other', null, 1),
      ],
      nextOffset: null,
    });
    open();
    await screen.findByTestId('chat-row-a1');
    const filter = screen.getByTestId('archived-filter');

    fireEvent.change(filter, { target: { value: 'TIMESHEET' } });
    expect(screen.getByTestId('chat-row-a1')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-row-a2')).toBeNull();
    expect(screen.queryByTestId('chat-row-a3')).toBeNull();

    fireEvent.change(filter, { target: { value: 'teams messages' } });
    expect(screen.getByTestId('chat-row-a2')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-row-a1')).toBeNull();

    fireEvent.keyDown(filter, { key: 'Escape' });
    expect(screen.getByTestId('chat-row-a1')).toBeInTheDocument();
    expect(screen.getByTestId('chat-row-a3')).toBeInTheDocument();
  });

  it('fetches the remaining pages while a filter is typed', async () => {
    const list = vi
      .spyOn(api, 'listChatsArchived')
      .mockResolvedValueOnce({ chats: [archivedRow('a1', 'first', null, 3)], nextOffset: 1 })
      .mockResolvedValueOnce({ chats: [archivedRow('a2', 'needle', null, 2)], nextOffset: null });
    open();
    await screen.findByTestId('chat-row-a1');
    expect(list).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByTestId('archived-filter'), { target: { value: 'needle' } });
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(list).toHaveBeenLastCalledWith({ limit: 30, offset: 1 });
    await screen.findByTestId('chat-row-a2');
    expect(screen.queryByTestId('chat-row-a1')).toBeNull();
  });
});
