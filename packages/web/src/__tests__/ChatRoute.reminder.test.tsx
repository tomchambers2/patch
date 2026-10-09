// patch/todo.md — "Reminders — configurable reminder to do / not do something.
// Also at the top as a banner so it's easy for the user to see."
//
// Typing `/remind <text>` in the composer sets the chat's reminder INSTEAD of
// sending a chat turn; the reminder then shows in a banner at the top of the
// chat. A bare `/remind` clears it. These tests lock in: (1) a chat with a
// reminder shows the reminder banner, (2) `/remind <text>` persists via the API
// + shows the banner without sending a message, (3) `/remind` alone clears it,
// and (4) a chat with no reminder shows no banner.

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
    skills: vi.fn(async () => ({ skills: [] })),
    setGoal: vi.fn(async () => undefined),
    setReminder: vi.fn(async () => undefined),
  },
}));

function seed(reminder: string | null): void {
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
      goal: null,
      reminder,
    },
  ]);
}

function renderChat(
  ws: { send: ReturnType<typeof vi.fn>; requestReplay?: ReturnType<typeof vi.fn> } | null = null,
): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={['/chats/c1']}>
      <Routes>
        <Route path="/chats/:chatId" element={<ChatRoute ws={ws as unknown as null} />} />
      </Routes>
    </MemoryRouter>,
  );
}

function typeAndSend(text: string): void {
  const input = screen.getByTestId('composer-input');
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

describe('ChatRoute — /remind command + reminder banner', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    useUiStore.getState().clearToasts();
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    setActiveWs(null);
    vi.mocked(api.setReminder)
      .mockReset()
      .mockResolvedValue(undefined as never);
  });
  afterEach(() => {
    cleanup();
    deliveryTracker.reset();
    setActiveWs(null);
  });

  it('shows the reminder banner with the reminder text when the chat has a reminder', () => {
    seed('Do not touch the prod database');
    renderChat();
    const banner = screen.getByTestId('reminder-banner');
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent('Do not touch the prod database');
  });

  it('does NOT show the reminder banner when the chat has no reminder', () => {
    seed(null);
    renderChat();
    expect(screen.queryByTestId('reminder-banner')).not.toBeInTheDocument();
  });

  it('`/remind <text>` sets the reminder via the API and shows the banner WITHOUT sending a message', async () => {
    seed(null);
    const ws = { send: vi.fn(), requestReplay: vi.fn() };
    renderChat(ws);
    typeAndSend('/remind Do not touch the prod database');

    expect(useChatStore.getState().chats['c1']?.reminder).toBe('Do not touch the prod database');
    await waitFor(() => {
      expect(api.setReminder).toHaveBeenCalledWith('c1', 'Do not touch the prod database');
    });
    expect(screen.getByTestId('reminder-banner')).toHaveTextContent(
      'Do not touch the prod database',
    );

    // It is NOT a chat turn: no user message rendered, nothing sent over the WS.
    expect(screen.queryByTestId('msg')).not.toBeInTheDocument();
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('a bare `/remind` clears the reminder', async () => {
    seed('an old reminder');
    renderChat();
    expect(screen.getByTestId('reminder-banner')).toBeInTheDocument();
    typeAndSend('/remind');

    expect(useChatStore.getState().chats['c1']?.reminder).toBe(null);
    await waitFor(() => {
      expect(api.setReminder).toHaveBeenCalledWith('c1', null);
    });
    expect(screen.queryByTestId('reminder-banner')).not.toBeInTheDocument();
  });

  it('the banner clear (×) control clears the reminder', async () => {
    seed('clear me');
    renderChat();
    expect(screen.getByTestId('reminder-banner')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('reminder-clear-btn'));

    expect(useChatStore.getState().chats['c1']?.reminder).toBe(null);
    await waitFor(() => {
      expect(api.setReminder).toHaveBeenCalledWith('c1', null);
    });
    expect(screen.queryByTestId('reminder-banner')).not.toBeInTheDocument();
  });

  it('reverts the reminder + surfaces a toast on API failure (NO FALLBACK)', async () => {
    vi.mocked(api.setReminder).mockRejectedValueOnce(new Error('network down'));
    seed(null);
    renderChat();
    typeAndSend('/remind try this');

    expect(useChatStore.getState().chats['c1']?.reminder).toBe('try this');
    await waitFor(() => {
      expect(useChatStore.getState().chats['c1']?.reminder).toBe(null);
    });
    expect(useUiStore.getState().errors[0]?.message).toContain('reminder');
  });
});
