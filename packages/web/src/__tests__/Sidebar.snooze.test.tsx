// The sidebar side of snooze (spec/14 § Chat lifecycle → Snooze + Snoozed
// section): a chat snoozed into the future leaves the active list and lives in
// the collapsed Snoozed section with its wake time and an Unsnooze control; the
// moment its wake time passes it is simply back in the list — no event needed,
// because "snoozed" is derived from `snoozedUntil > now`.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Sidebar } from '../components/Sidebar.js';
import { useChatStore } from '../stores/chatStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useVoiceStore } from '../stores/voiceStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { api } from '../api/rest.js';

const NOW = 1_700_000_000_000;

function seed(snoozedUntil: number | null): void {
  useChatStore.getState().hydrate([
    {
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
      lastUpdated: NOW,
      ...(snoozedUntil !== null ? { snoozedUntil } : {}),
    },
    {
      chatId: 'c2',
      daemonId: 'd1',
      permissionMode: 'bypassPermissions' as const,
      name: 'another chat',
      folder: '~/proj',
      activity: 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      disabled: false,
      lastUpdated: NOW,
    },
  ]);
}

function renderSidebar(): void {
  render(
    <MemoryRouter>
      <Sidebar />
    </MemoryRouter>,
  );
}

describe('Sidebar — snoozed chats', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    usePresenceStore.getState().setConnection('connected');
    useVoiceStore.setState({ activeDevices: {} });
    useUiStore.getState().setChannelsOpen(false);
    useUiStore.getState().setArchivedOpen(false);
    useUiStore.getState().setDeletedOpen(false);
    useUiStore.getState().setSnoozedOpen(false);
    useUiStore.getState().setAttentionOnly(false);
    useUiStore.setState({ forgottenFolders: [], errors: [] });
    useUiStore.getState().setSearchQuery('');
    vi.spyOn(api, 'listChatsArchived').mockResolvedValue({ chats: [], nextOffset: null });
    vi.spyOn(api, 'listChatsDeleted').mockResolvedValue({ chats: [], nextOffset: null });
    vi.spyOn(api, 'listChatsSnoozed').mockResolvedValue({ chats: [], nextOffset: null });
    vi.spyOn(api, 'snoozeChat').mockResolvedValue(undefined as never);
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it('hides a chat snoozed into the future from the active list', () => {
    seed(NOW + 60_000);
    renderSidebar();
    expect(screen.queryByTestId('chat-row-c1')).toBeNull();
    expect(screen.getByTestId('chat-row-c2')).toBeInTheDocument();
  });

  it('lists it under the Snoozed section, with its wake time and an Unsnooze', async () => {
    seed(NOW + 60_000);
    renderSidebar();
    fireEvent.click(screen.getByTestId('snoozed-toggle'));
    const section = await screen.findByTestId('snoozed-section');
    expect(section).toContainElement(screen.getByTestId('chat-row-c1'));
    expect(screen.getByTestId('snooze-when-c1')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('unsnooze-btn-c1'));
    await waitFor(() => expect(api.snoozeChat).toHaveBeenCalledWith('c1', null));
    expect(useChatStore.getState().chats['c1']?.snoozedUntil).toBe(null);
  });

  it('a snooze whose time has passed is back in the active list', () => {
    seed(NOW - 1);
    renderSidebar();
    expect(screen.getByTestId('chat-row-c1')).toBeInTheDocument();
  });

  it('an un-snoozed chat is not in the Snoozed section', async () => {
    seed(null);
    // The 0 on the toggle is the server's total (spec/04 § Section counts), not
    // a measurement of the rendered list — it is on the row before it is opened.
    useChatStore
      .getState()
      .setSectionCounts({ hidden: 0, archived: 0, snoozed: 0, deleted: 0, automations: 0 });
    renderSidebar();
    // Empty reads as a 0 in the toggle's tooltip, with no body below it
    // (spec/14 §6).
    expect(screen.getByTestId('snoozed-toggle')).toHaveAttribute('title', 'Snoozed · 0');
    fireEvent.click(screen.getByTestId('snoozed-toggle'));
    const section = await screen.findByTestId('snoozed-section');
    expect(screen.getByTestId('snoozed-toggle')).toHaveAttribute('title', 'Snoozed · 0');
    expect(section).toBeEmptyDOMElement();
  });
});

describe('chatStore — snoozedUntil', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
  });

  it('applies snoozedUntil from chat.state, treating null as meaningful and absent as unchanged', () => {
    const store = useChatStore.getState();
    store.hydrate([
      {
        chatId: 'c1',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: null,
        folder: '~/p',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        disabled: false,
        lastUpdated: 1,
      },
    ]);
    store.applyEvent({
      type: 'chat.state',
      permissionMode: 'bypassPermissions' as const,
      chatId: 'c1',
      activity: 'idle',
      lastUpdated: 2,
      status: 'active',
      folder: '~/p',
      snoozedUntil: NOW + 1000,
    });
    expect(useChatStore.getState().chats['c1']?.snoozedUntil).toBe(NOW + 1000);
    // Absent field ⇒ unchanged.
    useChatStore.getState().applyEvent({
      type: 'chat.state',
      permissionMode: 'bypassPermissions' as const,
      chatId: 'c1',
      activity: 'running',
      lastUpdated: 3,
      status: 'active',
      folder: '~/p',
    });
    expect(useChatStore.getState().chats['c1']?.snoozedUntil).toBe(NOW + 1000);
    // Explicit null ⇒ cleared (the host's wake).
    useChatStore.getState().applyEvent({
      type: 'chat.state',
      permissionMode: 'bypassPermissions' as const,
      chatId: 'c1',
      activity: 'idle',
      lastUpdated: 4,
      status: 'active',
      folder: '~/p',
      snoozedUntil: null,
    });
    expect(useChatStore.getState().chats['c1']?.snoozedUntil).toBe(null);
  });
});
