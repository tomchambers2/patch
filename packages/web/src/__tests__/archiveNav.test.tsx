// Archiving the chat you are reading moves you on to the next chat in the list
// (spec/04 § Lifecycle) — from whichever control did the archiving.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { JSX } from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { ChatHeader } from '../components/ChatHeader.js';
import { Sidebar } from '../components/Sidebar.js';
import { ConfirmModal } from '../components/ConfirmModal.js';
import { useChatStore } from '../stores/chatStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useVoiceStore } from '../stores/voiceStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { useSelectionStore } from '../stores/selectionStore.js';
import { api } from '../api/rest.js';
import type { ChatRow } from '../stores/types.js';

vi.mock('../lib/voiceController.js', () => ({
  startVoiceCall: vi.fn(async () => {}),
  startVoiceNote: vi.fn(async () => {}),
  sendVoiceNote: vi.fn(),
  promoteNoteToToggle: vi.fn(),
}));

function row(overrides: Partial<ChatRow> = {}): ChatRow {
  return {
    chatId: 'r1',
    daemonId: 'd1',
    permissionMode: 'bypassPermissions',
    name: 'a chat',
    folder: '~/proj',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 0,
    awaitingPermission: false,
    lastReadSeq: 0,
    lastSeq: 0,
    preview: null,
    goal: null,
    goalProgress: null,
    lastGoal: null,
    reminder: null,
    statusSummary: null,
    statusKind: null,
    statusDeclared: null,
    pendingPermissions: [],
    pendingWake: null,
    todos: [],
    snoozedUntil: null,
    ...overrides,
  } as ChatRow;
}

/** Three rows in one folder, drawn newest-first: r1, r2, r3. */
function seedThree(): void {
  useChatStore
    .getState()
    .hydrate([
      row({ chatId: 'r1', lastUpdated: 300 }),
      row({ chatId: 'r2', lastUpdated: 200 }),
      row({ chatId: 'r3', lastUpdated: 100 }),
    ]);
}

let loc = { pathname: '/', search: '' };

function LocationProbe(): null {
  const l = useLocation();
  loc = { pathname: l.pathname, search: l.search };
  return null;
}

function renderAt(chatId: string, ui: JSX.Element): void {
  useChatStore.getState().setActiveChat(chatId);
  render(
    <MemoryRouter initialEntries={[`/chats/${chatId}`]}>
      <LocationProbe />
      <Routes>
        <Route path="*" element={ui} />
      </Routes>
      <ConfirmModal />
    </MemoryRouter>,
  );
}

describe('archiving the open chat moves you on', () => {
  beforeEach(() => {
    loc = { pathname: '/', search: '' };
    useChatStore.getState()._reset();
    usePresenceStore.getState().setConnection('connected');
    useVoiceStore.setState({ activeDevices: {} });
    useUiStore.getState().setChannelsOpen(false);
    useUiStore.getState().setArchivedOpen(false);
    useUiStore.getState().setDeletedOpen(false);
    useUiStore.getState().setAttentionOnly(false);
    useUiStore.setState({ forgottenFolders: [], errors: [] });
    useUiStore.getState().setSearchQuery('');
    useSelectionStore.setState({ order: [], anchor: null, selected: [] });
    vi.spyOn(api, 'archiveChat').mockResolvedValue(undefined as never);
    vi.spyOn(api, 'listChatsArchived').mockResolvedValue({ chats: [], nextOffset: null });
    vi.spyOn(api, 'listChatsDeleted').mockResolvedValue({ chats: [], nextOffset: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it('the header archive icon opens the next chat down the list', () => {
    seedThree();
    renderAt('r2', <ChatHeader row={row({ chatId: 'r2', lastUpdated: 200 })} />);
    fireEvent.click(screen.getByTestId('action-archive'));
    expect(loc.pathname).toBe('/chats/r3');
    expect(useChatStore.getState().chats['r2']?.status).toBe('archived');
  });

  it('archiving the last chat in the list goes back up to the one above', () => {
    seedThree();
    renderAt('r3', <ChatHeader row={row({ chatId: 'r3', lastUpdated: 100 })} />);
    fireEvent.click(screen.getByTestId('action-archive'));
    expect(loc.pathname).toBe('/chats/r2');
  });

  it('archiving the only chat leaves you on a new chat', () => {
    useChatStore.getState().hydrate([row({ chatId: 'r1' })]);
    renderAt('r1', <ChatHeader row={row({ chatId: 'r1' })} />);
    fireEvent.click(screen.getByTestId('action-archive'));
    expect(loc.pathname).toBe('/chats/new');
  });

  it('unarchiving stays put', () => {
    useChatStore
      .getState()
      .hydrate([row({ chatId: 'r1', status: 'archived' }), row({ chatId: 'r2' })]);
    renderAt('r1', <ChatHeader row={row({ chatId: 'r1', status: 'archived' })} />);
    fireEvent.click(screen.getByTestId('action-archive'));
    expect(loc.pathname).toBe('/chats/r1');
  });

  it('the sidebar row archive button moves you on when it is the open chat', () => {
    seedThree();
    renderAt('r1', <Sidebar />);
    fireEvent.click(screen.getByTestId('archive-btn-r1'));
    expect(loc.pathname).toBe('/chats/r2');
  });

  it('archiving some OTHER chat from its sidebar row leaves you where you are', () => {
    seedThree();
    renderAt('r1', <Sidebar />);
    fireEvent.click(screen.getByTestId('archive-btn-r3'));
    expect(loc.pathname).toBe('/chats/r1');
    expect(useChatStore.getState().chats['r3']?.status).toBe('archived');
  });

  it('a bulk archive skips past every chat it is archiving', async () => {
    seedThree();
    renderAt('r1', <Sidebar />);
    fireEvent.click(screen.getByTestId('chat-row-r1'), { button: 0 });
    fireEvent.click(screen.getByTestId('chat-row-r2'), { shiftKey: true, button: 0 });
    fireEvent.click(screen.getByTestId('selection-archive'));
    fireEvent.click(await screen.findByTestId('confirm-ok'));
    // The confirm defers the archive by a microtask, so the router update
    // lands a render after the store flip — wait on the destination itself.
    await waitFor(() => {
      expect(loc.pathname).toBe('/chats/r3');
    });
    expect(useChatStore.getState().chats['r2']?.status).toBe('archived');
  });
});
