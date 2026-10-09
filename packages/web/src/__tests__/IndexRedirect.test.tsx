import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { SPECIAL_THREAD_IDS } from '@patch/wire';
import { IndexRedirect } from '../routes/IndexRedirect.js';
import { useChatStore } from '../stores/chatStore.js';
import type { ChatRow } from '../stores/types.js';

function makeRow(chatId: string, overrides: Partial<ChatRow> = {}): ChatRow {
  return {
    pendingWake: null,
    todos: [],
    snoozedUntil: null,
    chatId,
    daemonId: 'd1',
    permissionMode: 'bypassPermissions' as const,
    name: null,
    folder: '/tmp',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: Date.now(),
    lastUserActivity: Date.now(),
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

afterEach(() => {
  cleanup();
  useChatStore.setState({ chats: {} });
});

describe('IndexRedirect', () => {
  it('renders the no-chat empty state when there is no Manager chat', () => {
    useChatStore.setState({ chats: {} });
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<IndexRedirect />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('no-chat')).toBeTruthy();
    expect(screen.getByText('No chat open')).toBeTruthy();
  });

  it('redirects to /chats/<id> when the Manager chat exists', async () => {
    useChatStore.setState({
      chats: { [SPECIAL_THREAD_IDS.manager]: makeRow(SPECIAL_THREAD_IDS.manager) },
    });
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<IndexRedirect />} />
          <Route path="/chats/:chatId" element={<div data-testid="chat-page" />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('chat-page')).toBeTruthy();
    });
  });
});
