// The sidebar side of hidden (spec/04 § Hidden, spec/14 § Sidebar item 6): a
// hidden chat is running but out of the active list. It lives in the collapsed
// Hidden section — first of the cold-storage rows — with a Show control, and
// the chat panel's Hidden banner carries the same Show. An archived chat that
// keeps the flag is drawn as archived.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Sidebar } from '../components/Sidebar.js';
import { HiddenBanner } from '../components/HiddenBanner.js';
import { useChatStore } from '../stores/chatStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useVoiceStore } from '../stores/voiceStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { api } from '../api/rest.js';

function seed(hidden: boolean | undefined, status: 'active' | 'archived' = 'active'): void {
  useChatStore.getState().hydrate([
    {
      chatId: 'c1',
      daemonId: 'd1',
      permissionMode: 'bypassPermissions' as const,
      name: 'a chat',
      folder: '~/proj',
      activity: 'idle',
      status,
      pinned: false,
      pinnedAt: null,
      disabled: false,
      lastUpdated: 1,
      ...(hidden !== undefined ? { hidden } : {}),
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
      lastUpdated: 1,
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

describe('Sidebar — hidden chats', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    usePresenceStore.getState().setConnection('connected');
    useVoiceStore.setState({ activeDevices: {} });
    useUiStore.getState().setChannelsOpen(false);
    useUiStore.getState().setHiddenOpen(false);
    useUiStore.getState().setArchivedOpen(false);
    useUiStore.getState().setDeletedOpen(false);
    useUiStore.getState().setSnoozedOpen(false);
    useUiStore.getState().setAttentionOnly(false);
    useUiStore.setState({ forgottenFolders: [], errors: [] });
    useUiStore.getState().setSearchQuery('');
    vi.spyOn(api, 'listChatsArchived').mockResolvedValue({ chats: [], nextOffset: null });
    vi.spyOn(api, 'listChatsHidden').mockResolvedValue({ chats: [], nextOffset: null });
    vi.spyOn(api, 'hideChat').mockResolvedValue(undefined as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it('keeps a hidden chat out of the active list', () => {
    seed(true);
    renderSidebar();
    expect(screen.queryByTestId('chat-row-c1')).toBeNull();
    expect(screen.getByTestId('chat-row-c2')).toBeInTheDocument();
  });

  it('is the first cold-storage row, collapsed, loading its list only on expand', async () => {
    seed(true);
    renderSidebar();
    const toggles = screen.getByTestId('sb-lifecycle').querySelectorAll('.arch-toggle');
    expect(toggles[0]).toBe(screen.getByTestId('hidden-toggle'));
    expect(screen.queryByTestId('hidden-section')).toBeNull();
    expect(api.listChatsHidden).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('hidden-toggle'));
    await screen.findByTestId('hidden-section');
    await waitFor(() => expect(api.listChatsHidden).toHaveBeenCalledTimes(1));
  });

  it('lists it under Hidden with a Show that POSTs hidden:false', async () => {
    seed(true);
    renderSidebar();
    fireEvent.click(screen.getByTestId('hidden-toggle'));
    const section = await screen.findByTestId('hidden-section');
    expect(section).toContainElement(screen.getByTestId('chat-row-c1'));
    expect(screen.getByTestId('show-btn-c1')).toHaveAttribute('aria-label', 'Unhide chat');
    expect(screen.getByTestId('show-btn-c1')).toHaveAttribute('title', 'Unhide');
    fireEvent.click(screen.getByTestId('show-btn-c1'));
    await waitFor(() => expect(api.hideChat).toHaveBeenCalledWith('c1', false));
    expect(useChatStore.getState().chats['c1']?.hidden).toBe(false);
    // Back in the active list, out of the section.
    expect(section).not.toContainElement(screen.getByTestId('chat-row-c1'));
  });

  it('a failed Show reverts and surfaces the error', async () => {
    vi.mocked(api.hideChat).mockRejectedValue(new Error('boom'));
    seed(true);
    renderSidebar();
    fireEvent.click(screen.getByTestId('hidden-toggle'));
    await screen.findByTestId('hidden-section');
    fireEvent.click(screen.getByTestId('show-btn-c1'));
    await waitFor(() => expect(useUiStore.getState().errors.length).toBe(1));
    expect(useUiStore.getState().errors[0]?.message).toContain('Show failed');
    expect(useChatStore.getState().chats['c1']?.hidden).toBe(true);
  });

  it('folds the rows the server returns into the section', async () => {
    seed(undefined);
    vi.mocked(api.listChatsHidden).mockResolvedValue({
      chats: [
        {
          chatId: 'h1',
          name: 'background run',
          preview: null,
          folder: '~/proj',
          activity: 'running',
          status: 'active',
          pinned: false,
          pinnedAt: null,
          snoozedUntil: null,
          hidden: true,
          lastUpdated: 5,
          daemonId: 'd1',
          permissionMode: 'auto',
          jobId: 'j1',
          statusSummary: null,
          statusKind: null,
        },
      ],
      nextOffset: null,
    });
    renderSidebar();
    fireEvent.click(screen.getByTestId('hidden-toggle'));
    const section = await screen.findByTestId('hidden-section');
    await waitFor(() => expect(section).toContainElement(screen.getByTestId('chat-row-h1')));
    expect(screen.getByTestId('chat-row-h1').querySelector('.badge')).not.toBeNull();
  });

  it('a load failure reports itself below the row', async () => {
    vi.mocked(api.listChatsHidden).mockRejectedValue(new Error('offline'));
    seed(undefined);
    renderSidebar();
    fireEvent.click(screen.getByTestId('hidden-toggle'));
    expect(await screen.findByTestId('hidden-load-error')).toHaveTextContent('offline');
  });

  it('an archived chat that keeps the flag is drawn as archived, not hidden', async () => {
    seed(true, 'archived');
    renderSidebar();
    fireEvent.click(screen.getByTestId('hidden-toggle'));
    const section = await screen.findByTestId('hidden-section');
    expect(section).toBeEmptyDOMElement();
  });
});

describe('HiddenBanner', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    useUiStore.setState({ errors: [] });
    vi.spyOn(api, 'hideChat').mockResolvedValue(undefined as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it('draws for a hidden chat and Show un-hides it', async () => {
    seed(true);
    const { rerender } = render(<HiddenBanner row={useChatStore.getState().chats['c1']!} />);
    expect(screen.getByTestId('hidden-banner')).toHaveTextContent('Hidden');
    expect(screen.getByTestId('show-banner-btn')).toHaveTextContent('Unhide');
    fireEvent.click(screen.getByTestId('show-banner-btn'));
    await waitFor(() => expect(api.hideChat).toHaveBeenCalledWith('c1', false));
    expect(useChatStore.getState().chats['c1']?.hidden).toBe(false);
    rerender(<HiddenBanner row={useChatStore.getState().chats['c1']!} />);
    expect(screen.queryByTestId('hidden-banner')).toBeNull();
  });

  it('reverts and surfaces the error when Show fails', async () => {
    vi.mocked(api.hideChat).mockRejectedValue(new Error('boom'));
    seed(true);
    render(<HiddenBanner row={useChatStore.getState().chats['c1']!} />);
    expect(screen.getByTestId('show-banner-btn')).toHaveTextContent('Unhide');
    fireEvent.click(screen.getByTestId('show-banner-btn'));
    await waitFor(() => expect(useUiStore.getState().errors.length).toBe(1));
    expect(useChatStore.getState().chats['c1']?.hidden).toBe(true);
  });

  it('draws nothing for a shown chat or an archived one keeping the flag', () => {
    seed(false);
    render(<HiddenBanner row={useChatStore.getState().chats['c1']!} />);
    expect(screen.queryByTestId('hidden-banner')).toBeNull();
    cleanup();
    seed(true, 'archived');
    render(<HiddenBanner row={useChatStore.getState().chats['c1']!} />);
    expect(screen.queryByTestId('hidden-banner')).toBeNull();
  });
});

describe('chatStore — hidden', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
  });

  it('applies hidden from chat.state, treating false as meaningful and absent as unchanged', () => {
    seed(undefined);
    const base = {
      type: 'chat.state' as const,
      permissionMode: 'bypassPermissions' as const,
      chatId: 'c1',
      activity: 'idle' as const,
      status: 'active' as const,
      folder: '~/proj',
    };
    expect(useChatStore.getState().chats['c1']?.hidden).toBe(false);
    useChatStore.getState().applyEvent({ ...base, lastUpdated: 2, hidden: true });
    expect(useChatStore.getState().chats['c1']?.hidden).toBe(true);
    useChatStore.getState().applyEvent({ ...base, lastUpdated: 3 });
    expect(useChatStore.getState().chats['c1']?.hidden).toBe(true);
    useChatStore.getState().applyEvent({ ...base, lastUpdated: 4, hidden: false });
    expect(useChatStore.getState().chats['c1']?.hidden).toBe(false);
  });
});
