// Sidebar multi-select — patch/todo.md "shift click should select multiple",
// spec/14 § Sidebar → Selecting multiple rows (shift-click).
//
// Shift-click range-selects the rows between the last plainly-clicked row (the
// anchor) and the clicked one, in DRAWN order, and a selection bar offers the
// bulk archive / delete. Shift never navigates and never reloads the window —
// that guard (lib/shiftClickGuard.ts) is what freed shift for this.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SPECIAL_THREAD_IDS } from '@patch/wire';
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

/** Four rows in one folder, drawn newest-first: r1, r2, r3, r4. */
function seedFour(): void {
  useChatStore.getState().hydrate([
    rowFixture({
      chatId: 'r1',
      daemonId: 'd1',
      permissionMode: 'bypassPermissions' as const,
      name: 'one',
      folder: '~/proj',
      lastUpdated: 400,
    }),
    rowFixture({
      chatId: 'r2',
      daemonId: 'd1',
      permissionMode: 'bypassPermissions' as const,
      name: 'two',
      folder: '~/proj',
      lastUpdated: 300,
    }),
    rowFixture({
      chatId: 'r3',
      daemonId: 'd1',
      permissionMode: 'bypassPermissions' as const,
      name: 'three',
      folder: '~/proj',
      lastUpdated: 200,
    }),
    rowFixture({
      chatId: 'r4',
      daemonId: 'd1',
      permissionMode: 'bypassPermissions' as const,
      name: 'four',
      folder: '~/proj',
      lastUpdated: 100,
    }),
  ]);
}

function renderInRouter(): void {
  render(
    <MemoryRouter>
      <Sidebar />
      <ConfirmModal />
    </MemoryRouter>,
  );
}

function shiftClick(testId: string): boolean {
  return fireEvent.click(screen.getByTestId(testId), { shiftKey: true, button: 0 });
}

describe('Sidebar — shift-click multi-select', () => {
  beforeEach(() => {
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

  it('shift-clicking a second row selects the whole run between it and the anchor', () => {
    seedFour();
    renderInRouter();
    fireEvent.click(screen.getByTestId('chat-row-r2'), { button: 0 });
    shiftClick('chat-row-r4');
    expect(useSelectionStore.getState().selected).toEqual(['r2', 'r3', 'r4']);
    expect(screen.getByTestId('chat-row-r3')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('chat-row-r1')).toHaveAttribute('aria-selected', 'false');
  });

  it('the selection bar reports the count and clears on ×', () => {
    seedFour();
    renderInRouter();
    expect(screen.queryByTestId('selection-bar')).toBeNull();
    fireEvent.click(screen.getByTestId('chat-row-r1'), { button: 0 });
    shiftClick('chat-row-r3');
    expect(screen.getByTestId('selection-count')).toHaveTextContent('3 selected');
    fireEvent.click(screen.getByTestId('selection-clear'));
    expect(useSelectionStore.getState().selected).toEqual([]);
    expect(screen.queryByTestId('selection-bar')).toBeNull();
  });

  it('a shift-click selects without navigating, and the browser never gets the click', () => {
    seedFour();
    renderInRouter();
    fireEvent.click(screen.getByTestId('chat-row-r1'), { button: 0 });
    // fireEvent returns false when the event was cancelled — the window can
    // never do its own same-origin page load off a shift-click.
    expect(shiftClick('chat-row-r3')).toBe(false);
    expect(useSelectionStore.getState().selected).toEqual(['r1', 'r2', 'r3']);
  });

  it('a plain click clears the selection and re-anchors', () => {
    seedFour();
    renderInRouter();
    fireEvent.click(screen.getByTestId('chat-row-r1'), { button: 0 });
    shiftClick('chat-row-r3');
    fireEvent.click(screen.getByTestId('chat-row-r4'), { button: 0 });
    expect(useSelectionStore.getState().selected).toEqual([]);
    expect(useSelectionStore.getState().anchor).toBe('r4');
  });

  it('Esc clears the selection', () => {
    seedFour();
    renderInRouter();
    fireEvent.click(screen.getByTestId('chat-row-r1'), { button: 0 });
    shiftClick('chat-row-r2');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useSelectionStore.getState().selected).toEqual([]);
  });

  it('bulk archive confirms in the app modal first, naming the count', async () => {
    seedFour();
    const archiveSpy = vi.spyOn(api, 'archiveChat').mockResolvedValue(undefined as never);
    const nativeConfirm = vi.spyOn(window, 'confirm');
    renderInRouter();
    fireEvent.click(screen.getByTestId('chat-row-r2'), { button: 0 });
    shiftClick('chat-row-r3');
    fireEvent.click(screen.getByTestId('selection-archive'));
    // Nothing moves until the user answers, and it is never the OS dialog.
    expect(nativeConfirm).not.toHaveBeenCalled();
    expect(await screen.findByTestId('confirm-ok')).toBeInTheDocument();
    expect(useUiStore.getState().confirmDialog?.message).toContain('2');
    expect(archiveSpy).not.toHaveBeenCalled();
    expect(useChatStore.getState().chats['r2']?.status).toBe('active');
  });

  it('cancelling the archive confirm archives nothing and keeps the selection', async () => {
    seedFour();
    const archiveSpy = vi.spyOn(api, 'archiveChat').mockResolvedValue(undefined as never);
    renderInRouter();
    fireEvent.click(screen.getByTestId('chat-row-r2'), { button: 0 });
    shiftClick('chat-row-r3');
    fireEvent.click(screen.getByTestId('selection-archive'));
    fireEvent.click(await screen.findByTestId('confirm-cancel'));
    await waitFor(() => {
      expect(archiveSpy).not.toHaveBeenCalled();
    });
    expect(useChatStore.getState().chats['r2']?.status).toBe('active');
    expect(useSelectionStore.getState().selected).toEqual(['r2', 'r3']);
  });

  it('bulk archive archives every selected chat and clears the selection', async () => {
    seedFour();
    const archiveSpy = vi.spyOn(api, 'archiveChat').mockResolvedValue(undefined as never);
    renderInRouter();
    fireEvent.click(screen.getByTestId('chat-row-r2'), { button: 0 });
    shiftClick('chat-row-r3');
    fireEvent.click(screen.getByTestId('selection-archive'));
    fireEvent.click(await screen.findByTestId('confirm-ok'));
    await waitFor(() => {
      expect(useChatStore.getState().chats['r2']?.status).toBe('archived');
    });
    expect(useChatStore.getState().chats['r3']?.status).toBe('archived');
    expect(useChatStore.getState().chats['r1']?.status).toBe('active');
    expect(archiveSpy).toHaveBeenCalledWith('r2', true);
    expect(archiveSpy).toHaveBeenCalledWith('r3', true);
    expect(useSelectionStore.getState().selected).toEqual([]);
  });

  it('a failed bulk archive reverts that row and toasts (no silent failure)', async () => {
    seedFour();
    vi.spyOn(api, 'archiveChat').mockRejectedValue(new Error('offline'));
    renderInRouter();
    fireEvent.click(screen.getByTestId('chat-row-r2'), { button: 0 });
    shiftClick('chat-row-r3');
    fireEvent.click(screen.getByTestId('selection-archive'));
    fireEvent.click(await screen.findByTestId('confirm-ok'));
    await waitFor(() => {
      expect(useChatStore.getState().chats['r2']?.status).toBe('active');
    });
    expect(useUiStore.getState().errors[0]?.message).toContain('Archive failed');
  });

  it('bulk delete confirms in the app modal first, then soft-deletes each chat', async () => {
    seedFour();
    const deleteSpy = vi.spyOn(api, 'deleteChat').mockResolvedValue(undefined as never);
    const nativeConfirm = vi.spyOn(window, 'confirm');
    renderInRouter();
    fireEvent.click(screen.getByTestId('chat-row-r1'), { button: 0 });
    shiftClick('chat-row-r2');
    fireEvent.click(screen.getByTestId('selection-delete'));
    expect(nativeConfirm).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId('confirm-ok'));
    await waitFor(() => {
      expect(deleteSpy).toHaveBeenCalledWith('r1');
    });
    expect(deleteSpy).toHaveBeenCalledWith('r2');
    expect(useSelectionStore.getState().selected).toEqual([]);
  });

  it('cancelling the delete confirm deletes nothing', async () => {
    seedFour();
    const deleteSpy = vi.spyOn(api, 'deleteChat').mockResolvedValue(undefined as never);
    renderInRouter();
    fireEvent.click(screen.getByTestId('chat-row-r1'), { button: 0 });
    shiftClick('chat-row-r2');
    fireEvent.click(screen.getByTestId('selection-delete'));
    fireEvent.click(await screen.findByTestId('confirm-cancel'));
    await waitFor(() => {
      expect(deleteSpy).not.toHaveBeenCalled();
    });
    expect(useSelectionStore.getState().selected).toEqual(['r1', 'r2']);
  });

  it('the Manager row is not selectable — shift-clicking it selects nothing', () => {
    useChatStore.getState().hydrate([
      rowFixture({ chatId: 'r1', folder: '~/proj', lastUpdated: 400 }),
      // The Manager special thread lives in its own top slot, not the list.
      rowFixture({
        chatId: SPECIAL_THREAD_IDS.manager,
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: 'manager',
        folder: '~/manager',
        lastUpdated: 500,
      }),
    ]);
    renderInRouter();
    fireEvent.click(screen.getByTestId('chat-row-r1'), { button: 0 });
    const manager = screen.queryByTestId(`chat-row-${SPECIAL_THREAD_IDS.manager}`);
    if (manager) fireEvent.click(manager, { shiftKey: true, button: 0 });
    expect(useSelectionStore.getState().selected).toEqual([]);
  });
});
