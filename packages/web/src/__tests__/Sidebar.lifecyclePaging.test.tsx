// spec/14 § Sidebar item 6: the cold-storage icon row shows which section is
// currently open, and each section's list loads a page at a time — the first
// on expand, further pages as the shared scroll band nears its bottom.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Sidebar } from '../components/Sidebar.js';
import { useChatStore } from '../stores/chatStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useVoiceStore } from '../stores/voiceStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { api } from '../api/rest.js';

function hiddenRow(chatId: string, lastUpdated: number) {
  return {
    chatId,
    name: chatId,
    preview: null,
    folder: '~/proj',
    activity: 'running' as const,
    status: 'active' as const,
    pinned: false,
    pinnedAt: null,
    snoozedUntil: null,
    hidden: true,
    lastUpdated,
    daemonId: 'd1',
    permissionMode: 'auto' as const,
    jobId: 'j1',
    statusSummary: null,
    statusKind: null,
  };
}

function renderSidebar(): void {
  render(
    <MemoryRouter>
      <Sidebar />
    </MemoryRouter>,
  );
}

/** Fire a scroll event that reads as "near the bottom" per `isNearScrollBottom`. */
function scrollNearBottom(el: HTMLElement): void {
  Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: 300, configurable: true });
  Object.defineProperty(el, 'scrollTop', { value: 650, configurable: true });
  fireEvent.scroll(el);
}

/** Fire a scroll event nowhere near the bottom. */
function scrollAwayFromBottom(el: HTMLElement): void {
  Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: 300, configurable: true });
  Object.defineProperty(el, 'scrollTop', { value: 0, configurable: true });
  fireEvent.scroll(el);
}

describe('Sidebar — lifecycle icon row: selected state', () => {
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
    useUiStore.setState({ forgottenFolders: [], errors: [], lifecycleScrollTick: 0 });
    useUiStore.getState().setSearchQuery('');
    vi.spyOn(api, 'listChatsArchived').mockResolvedValue({ chats: [], nextOffset: null });
    vi.spyOn(api, 'listChatsDeleted').mockResolvedValue({ chats: [], nextOffset: null });
    vi.spyOn(api, 'listChatsHidden').mockResolvedValue({ chats: [], nextOffset: null });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it('carries no selected state until its section is opened, then carries it while open', () => {
    renderSidebar();
    const toggle = screen.getByTestId('hidden-toggle');
    expect(toggle.className).not.toMatch(/\bactive\b/);
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(toggle);
    expect(toggle.className).toMatch(/\bactive\b/);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(toggle);
    expect(toggle.className).not.toMatch(/\bactive\b/);
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
  });

  it('two panels open together each carry the selected state independently', () => {
    renderSidebar();
    fireEvent.click(screen.getByTestId('hidden-toggle'));
    fireEvent.click(screen.getByTestId('archived-toggle'));
    expect(screen.getByTestId('hidden-toggle').className).toMatch(/\bactive\b/);
    expect(screen.getByTestId('archived-toggle').className).toMatch(/\bactive\b/);
    // Untouched toggles stay unselected.
    expect(screen.getByTestId('deleted-toggle').className).not.toMatch(/\bactive\b/);
  });
});

describe('Sidebar — lifecycle sections: paged, load more on scroll', () => {
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
    useUiStore.setState({ forgottenFolders: [], errors: [], lifecycleScrollTick: 0 });
    useUiStore.getState().setSearchQuery('');
    vi.spyOn(api, 'listChatsArchived').mockResolvedValue({ chats: [], nextOffset: null });
    vi.spyOn(api, 'listChatsDeleted').mockResolvedValue({ chats: [], nextOffset: null });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it('fetches one page (limit 30, offset 0) on expand, not the whole list', async () => {
    const listChatsHidden = vi
      .spyOn(api, 'listChatsHidden')
      .mockResolvedValue({ chats: [hiddenRow('h1', 1)], nextOffset: null });
    renderSidebar();
    fireEvent.click(screen.getByTestId('hidden-toggle'));
    await screen.findByTestId('chat-row-h1');
    expect(listChatsHidden).toHaveBeenCalledTimes(1);
    expect(listChatsHidden).toHaveBeenCalledWith({ limit: 30, offset: 0 });
  });

  it('loads the next page when the shared band scrolls near its bottom, and folds it in', async () => {
    const listChatsHidden = vi
      .spyOn(api, 'listChatsHidden')
      .mockResolvedValueOnce({ chats: [hiddenRow('h1', 1), hiddenRow('h2', 2)], nextOffset: 2 })
      .mockResolvedValueOnce({ chats: [hiddenRow('h3', 3)], nextOffset: null });
    renderSidebar();
    fireEvent.click(screen.getByTestId('hidden-toggle'));
    await screen.findByTestId('chat-row-h1');
    expect(screen.getByTestId('chat-row-h2')).toBeInTheDocument();
    expect(listChatsHidden).toHaveBeenCalledTimes(1);

    scrollNearBottom(screen.getByTestId('sb-lifecycle'));

    await waitFor(() => expect(listChatsHidden).toHaveBeenCalledTimes(2));
    expect(listChatsHidden).toHaveBeenLastCalledWith({ limit: 30, offset: 2 });
    await screen.findByTestId('chat-row-h3');
    // The first page's rows are still there — a page folds in, it doesn't replace.
    expect(screen.getByTestId('chat-row-h1')).toBeInTheDocument();
    expect(screen.getByTestId('chat-row-h2')).toBeInTheDocument();
  });

  it('does not fetch again once the section reports nothing further', async () => {
    const listChatsHidden = vi
      .spyOn(api, 'listChatsHidden')
      .mockResolvedValue({ chats: [hiddenRow('h1', 1)], nextOffset: null });
    renderSidebar();
    fireEvent.click(screen.getByTestId('hidden-toggle'));
    await screen.findByTestId('chat-row-h1');
    expect(listChatsHidden).toHaveBeenCalledTimes(1);

    scrollNearBottom(screen.getByTestId('sb-lifecycle'));
    // Give any (wrongly-fired) fetch a tick to land.
    await new Promise((r) => setTimeout(r, 0));
    expect(listChatsHidden).toHaveBeenCalledTimes(1);
  });

  it('a scroll that is not near the bottom does not trigger a further page', async () => {
    const listChatsHidden = vi
      .spyOn(api, 'listChatsHidden')
      .mockResolvedValueOnce({ chats: [hiddenRow('h1', 1)], nextOffset: 1 });
    renderSidebar();
    fireEvent.click(screen.getByTestId('hidden-toggle'));
    await screen.findByTestId('chat-row-h1');
    expect(listChatsHidden).toHaveBeenCalledTimes(1);

    scrollAwayFromBottom(screen.getByTestId('sb-lifecycle'));
    await new Promise((r) => setTimeout(r, 0));
    expect(listChatsHidden).toHaveBeenCalledTimes(1);
  });
});
