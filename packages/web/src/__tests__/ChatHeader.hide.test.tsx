// Hide from the chat header (spec/04 § Hidden, spec/14 § Chat panel header): a running
// chat can be moved out of the list from its ⋯ menu. Optimistic, reverting and
// toasting on failure (NO FALLBACK). Hidden, archived and special chats are not offered it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { JSX } from 'react';
import { render as rtlRender, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ChatHeader } from '../components/ChatHeader.js';
import type { ChatRow } from '../stores/types.js';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { api } from '../api/rest.js';

vi.mock('../api/rest.js', () => ({
  api: { deleteChat: vi.fn(), pinChat: vi.fn(), hideChat: vi.fn(async () => undefined) },
}));

vi.mock('../lib/voiceController.js', () => ({
  startVoiceCall: vi.fn(async () => {}),
}));

function render(ui: JSX.Element): ReturnType<typeof rtlRender> {
  return rtlRender(
    <MemoryRouter initialEntries={['/chats/c1']}>
      <Routes>
        <Route path="*" element={ui} />
      </Routes>
    </MemoryRouter>,
  );
}

function row(overrides: Partial<ChatRow> = {}): ChatRow {
  return {
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
    pendingWake: null,
    todos: [],
    statusSummary: null,
    statusKind: null,
    statusDeclared: null,
    pendingPermissions: [],
    lastSeq: 0,
    jobId: null,
    model: null,
    rateLimitResumingAt: null,
    resumeKind: null,
    snoozedUntil: null,
    ...overrides,
  };
}

function seed(r: ChatRow): void {
  useChatStore.setState({ chats: { [r.chatId]: r } });
}

describe('ChatHeader — hide', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    useUiStore.getState().clearToasts();
    vi.mocked(api.hideChat)
      .mockReset()
      .mockResolvedValue(undefined as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it('hides a running chat: posts hidden:true and flips the row optimistically', async () => {
    const r = row({ activity: 'running' });
    seed(r);
    render(<ChatHeader row={r} />);
    fireEvent.click(screen.getByTestId('action-more'));
    fireEvent.click(screen.getByTestId('action-hide'));
    await waitFor(() => expect(api.hideChat).toHaveBeenCalledWith('c1', true));
    expect(useChatStore.getState().chats['c1']?.hidden).toBe(true);
    expect(screen.queryByTestId('action-hide')).toBeNull();
  });

  it('reverts and toasts when the host refuses', async () => {
    vi.mocked(api.hideChat).mockRejectedValue(new Error('boom'));
    const r = row();
    seed(r);
    render(<ChatHeader row={r} />);
    fireEvent.click(screen.getByTestId('action-more'));
    fireEvent.click(screen.getByTestId('action-hide'));
    await waitFor(() => expect(useChatStore.getState().chats['c1']?.hidden).toBeFalsy());
    expect(
      useUiStore
        .getState()
        .errors.some((t) => /Hide failed. Try again. boom/.test(`${t.message} ${t.detail}`)),
    ).toBe(true);
  });

  it('is not offered for a chat that is already hidden or archived', () => {
    for (const overrides of [{ hidden: true }, { status: 'archived' as const }]) {
      const r = row(overrides);
      seed(r);
      render(<ChatHeader row={r} />);
      fireEvent.click(screen.getByTestId('action-more'));
      expect(screen.queryByTestId('action-hide')).toBeNull();
      cleanup();
    }
  });
});
