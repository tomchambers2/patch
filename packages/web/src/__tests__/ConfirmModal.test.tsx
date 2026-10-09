import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ConfirmModal } from '../components/ConfirmModal.js';
import { ChatHeader } from '../components/ChatHeader.js';
import { useUiStore } from '../stores/uiStore.js';
import { useChatStore } from '../stores/chatStore.js';
import type { ChatRow } from '../stores/types.js';
import { api } from '../api/rest.js';

vi.mock('../api/rest.js', () => ({
  api: { deleteChat: vi.fn(), pinChat: vi.fn(), archiveChat: vi.fn() },
}));

vi.mock('../lib/voiceController.js', () => ({
  startVoiceCall: vi.fn(async () => {}),
}));

function row(overrides: Partial<ChatRow> = {}): ChatRow {
  return {
    pendingWake: null,
    todos: [],
    snoozedUntil: null,
    chatId: 'c1',
    daemonId: 'd1',
    permissionMode: 'bypassPermissions' as const,
    name: 'fix layout',
    folder: '~/projects/foo',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 0,
    lastUserActivity: 0,
    awaitingPermission: false,
    lastReadSeq: -1,
    preview: null,
    goal: null,
    goalProgress: null,
    lastGoal: null,
    reminder: null,
    statusSummary: null,
    statusKind: null,
    statusDeclared: null,
    pendingPermissions: [],
    lastSeq: 0,
    jobId: null,
    model: null,
    rateLimitResumingAt: null,
    resumeKind: null,
    ...overrides,
  };
}

describe('ConfirmModal + uiStore.confirm', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    useUiStore.getState().clearToasts();
    useUiStore.setState({ confirmDialog: null });
    vi.mocked(api.deleteChat)
      .mockReset()
      .mockResolvedValue(undefined as never);
    vi.mocked(api.pinChat)
      .mockReset()
      .mockResolvedValue(undefined as never);
  });
  afterEach(() => {
    cleanup();
  });

  it('renders nothing when there is no pending confirm', () => {
    render(<ConfirmModal />);
    expect(screen.queryByTestId('confirm-modal')).not.toBeInTheDocument();
  });

  it('shows a custom (non-native) modal with the title, message and both buttons', () => {
    render(<ConfirmModal />);
    act(() => {
      void useUiStore.getState().confirm({
        title: 'Delete chat',
        message: 'Really delete this?',
        confirmLabel: 'Delete',
        danger: true,
      });
    });
    const modal = screen.getByTestId('confirm-modal');
    expect(modal).toBeInTheDocument();
    // It is a real accessible dialog element — not the OS native confirm().
    expect(modal).toHaveAttribute('role', 'dialog');
    expect(modal).toHaveAttribute('aria-modal', 'true');
    expect(modal.textContent).toContain('Delete chat');
    expect(modal.textContent).toContain('Really delete this?');
    expect(screen.getByTestId('confirm-ok').textContent).toBe('Delete');
    expect(screen.getByTestId('confirm-cancel')).toBeInTheDocument();
    // Danger confirms get the danger styling.
    expect(screen.getByTestId('confirm-ok').className).toContain('danger');
  });

  it('resolves true and closes when the confirm button is clicked', async () => {
    render(<ConfirmModal />);
    let result: boolean | null = null;
    act(() => {
      void useUiStore
        .getState()
        .confirm({ message: 'go?' })
        .then((r) => {
          result = r;
        });
    });
    fireEvent.click(screen.getByTestId('confirm-ok'));
    await vi.waitFor(() => expect(result).toBe(true));
    expect(useUiStore.getState().confirmDialog).toBeNull();
    expect(screen.queryByTestId('confirm-modal')).not.toBeInTheDocument();
  });

  it('resolves false and closes when the cancel button is clicked', async () => {
    render(<ConfirmModal />);
    let result: boolean | null = null;
    act(() => {
      void useUiStore
        .getState()
        .confirm({ message: 'go?' })
        .then((r) => {
          result = r;
        });
    });
    fireEvent.click(screen.getByTestId('confirm-cancel'));
    await vi.waitFor(() => expect(result).toBe(false));
    expect(useUiStore.getState().confirmDialog).toBeNull();
  });

  it('resolves false when Escape is pressed', async () => {
    render(<ConfirmModal />);
    let result: boolean | null = null;
    act(() => {
      void useUiStore
        .getState()
        .confirm({ message: 'go?' })
        .then((r) => {
          result = r;
        });
    });
    fireEvent.keyDown(window, { key: 'Escape' });
    await vi.waitFor(() => expect(result).toBe(false));
    expect(useUiStore.getState().confirmDialog).toBeNull();
  });

  it('resolves false when the backdrop is clicked', async () => {
    render(<ConfirmModal />);
    let result: boolean | null = null;
    act(() => {
      void useUiStore
        .getState()
        .confirm({ message: 'go?' })
        .then((r) => {
          result = r;
        });
    });
    fireEvent.click(screen.getByTestId('confirm-modal-backdrop'));
    await vi.waitFor(() => expect(result).toBe(false));
  });

  it('does NOT call the native window.confirm', () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    render(<ConfirmModal />);
    act(() => {
      void useUiStore.getState().confirm({ message: 'go?' });
    });
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  // Wiring: the ChatHeader delete action must drive the CUSTOM modal, not the
  // OS-native confirm(), and only delete after the user confirms in it.
  it('ChatHeader delete opens the custom modal and deletes after confirm', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    useChatStore
      .getState()
      .applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    render(
      <MemoryRouter>
        <ChatHeader row={row()} />
        <ConfirmModal />
      </MemoryRouter>,
    );
    // Delete lives behind the header's ⋯ overflow menu (spec/14 § Chat panel header).
    fireEvent.click(screen.getByTestId('action-more'));
    fireEvent.click(screen.getByTestId('action-delete'));
    // Native confirm never fires; the custom modal appears instead.
    expect(confirmSpy).not.toHaveBeenCalled();
    const modal = await screen.findByTestId('confirm-modal');
    expect(modal.textContent).toContain('fix layout');
    fireEvent.click(screen.getByTestId('confirm-ok'));
    await vi.waitFor(() => {
      expect(api.deleteChat).toHaveBeenCalledWith('c1');
    });
    expect(useChatStore.getState().chats['c1']?.status).toBe('deleted');
    confirmSpy.mockRestore();
  });

  it('ChatHeader delete does nothing when the modal is cancelled', async () => {
    render(
      <MemoryRouter>
        <ChatHeader row={row()} />
        <ConfirmModal />
      </MemoryRouter>,
    );
    // Delete lives behind the header's ⋯ overflow menu (spec/14 § Chat panel header).
    fireEvent.click(screen.getByTestId('action-more'));
    fireEvent.click(screen.getByTestId('action-delete'));
    await screen.findByTestId('confirm-modal');
    fireEvent.click(screen.getByTestId('confirm-cancel'));
    await vi.waitFor(() => {
      expect(screen.queryByTestId('confirm-modal')).not.toBeInTheDocument();
    });
    expect(api.deleteChat).not.toHaveBeenCalled();
  });
});
