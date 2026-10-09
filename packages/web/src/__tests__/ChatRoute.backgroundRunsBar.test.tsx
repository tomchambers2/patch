// Regression: the chat panel has NO background-runs bar.
//
// There used to be a bar above the transcript summarising other chats still
// running ("2 others running · bus-watch"). It is gone: spec/14 § Sidebar §6
// already makes background runs visible — "glancing at `▸ Automations` shows
// which background runs are still `working`" — so the bar was a second, noisier
// readout of something the sidebar already carries, taking a strip off the top
// of every transcript to say it.
//
// These lock the removal in: with other chats running, and with one going
// running live mid-session, the panel shows no such bar and no "N others
// running" copy.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ChatRoute } from '../routes/ChatRoute.js';
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

function seedChats(
  others: Array<{ chatId: string; name: string | null; activity: 'idle' | 'running' }>,
): void {
  useChatStore.getState().hydrate([
    {
      chatId: 'current',
      daemonId: 'd1',
      permissionMode: 'auto' as const,
      name: 'open-chat',
      folder: '/home/tom/projects/open',
      activity: 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      disabled: false,
      lastUpdated: 1,
    },
    ...others.map((o) => ({
      chatId: o.chatId,
      daemonId: 'd1',
      permissionMode: 'auto' as const,
      name: o.name,
      folder: `/home/tom/projects/${o.chatId}`,
      activity: o.activity,
      status: 'active' as const,
      pinned: false,
      pinnedAt: null,
      disabled: false,
      lastUpdated: 0,
    })),
  ]);
}

function renderChat(): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={['/chats/current']}>
      <Routes>
        <Route path="/chats/:chatId" element={<ChatRoute ws={null} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ChatRoute — no background runs bar', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    useUiStore.getState().clearToasts();
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    setActiveWs(null);
  });

  afterEach(() => {
    cleanup();
    deliveryTracker.reset();
    setActiveWs(null);
  });

  it('renders no bar when a single other chat is running', () => {
    seedChats([{ chatId: 'c2', name: 'bus-watch', activity: 'running' }]);
    renderChat();
    expect(screen.queryByTestId('bg-runs-bar')).not.toBeInTheDocument();
    expect(screen.queryByText(/other running/i)).not.toBeInTheDocument();
  });

  it('renders no bar when several other chats are running', () => {
    seedChats([
      { chatId: 'c2', name: 'bus-watch', activity: 'running' },
      { chatId: 'c3', name: 'nightly', activity: 'running' },
    ]);
    renderChat();
    expect(screen.queryByTestId('bg-runs-bar')).not.toBeInTheDocument();
    expect(screen.queryByText(/others running/i)).not.toBeInTheDocument();
    expect(screen.queryByText('bus-watch')).not.toBeInTheDocument();
  });

  it('renders no bar when another chat starts running live', () => {
    seedChats([{ chatId: 'c2', name: 'bus-watch', activity: 'idle' }]);
    renderChat();

    act(() => {
      useChatStore.getState().applyEvent({
        type: 'chat.state',
        chatId: 'c2',
        activity: 'running',
        permissionMode: 'auto',
        lastUpdated: 2,
        pendingWake: null,
        todos: [],
      });
    });

    expect(screen.queryByTestId('bg-runs-bar')).not.toBeInTheDocument();
    expect(screen.queryByText(/other running/i)).not.toBeInTheDocument();
  });
});
