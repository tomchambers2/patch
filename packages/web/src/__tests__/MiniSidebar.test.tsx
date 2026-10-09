// MiniSidebar — the status-dot rail the sidebar becomes when dragged narrow
// (Todoist, Patch Updates: "patch mini sidebar … just shows status dots … so
// you can go up and down without having the whole thing open").

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { MiniSidebar } from '../components/MiniSidebar.js';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import type { ChatRow } from '../stores/types.js';

function row(chatId: string, over: Partial<ChatRow> = {}): ChatRow {
  const now = Date.now();
  return {
    chatId,
    name: `Chat ${chatId}`,
    daemonId: 'd1',
    folder: '/home/x/proj',
    activity: 'idle',
    permissionMode: 'bypassPermissions',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: now,
    lastUserActivity: now,
    awaitingPermission: false,
    pendingPermissions: [],
    pendingWake: null,
    todos: [],
    snoozedUntil: null,
    jobId: null,
    model: null,
    rateLimitResumingAt: null,
    resumeKind: null,
    lastSeq: 0,
    lastReadSeq: 0,
    preview: null,
    goal: null,
    goalProgress: null,
    lastGoal: null,
    reminder: null,
    statusSummary: null,
    statusKind: null,
    statusDeclared: false,
    ...over,
  } as ChatRow;
}

function Where(): JSX.Element {
  return <span data-testid="where">{useLocation().pathname}</span>;
}

function mount(): void {
  render(
    <MemoryRouter initialEntries={['/chats/a']}>
      <MiniSidebar />
      <Routes>
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('MiniSidebar', () => {
  beforeEach(() => {
    useUiStore.setState({ sidebarMini: true });
    useChatStore.setState({
      chats: {
        a: row('a', { activity: 'running' }),
        b: row('b'),
      },
      folderRoster: [],
      activeChatId: 'a',
    } as never);
  });
  afterEach(cleanup);

  it('draws one status dot per chat, named by the chat as its tooltip', () => {
    mount();
    expect(screen.getByTestId('mini-row-a')).toHaveAttribute('title', 'Chat a');
    expect(
      screen.getByTestId('mini-row-a').querySelector('[data-testid="badge-working"]'),
    ).not.toBeNull();
    expect(screen.getByTestId('mini-row-b')).toBeInTheDocument();
    expect(screen.queryByText('Chat a')).not.toBeInTheDocument();
  });

  it('marks the open chat and navigates when another is clicked', () => {
    mount();
    expect(screen.getByTestId('mini-row-a')).toHaveClass('active');
    fireEvent.click(screen.getByTestId('mini-row-b'));
    expect(screen.getByTestId('where')).toHaveTextContent('/chats/b');
  });

  it('the expand control restores the full sidebar', () => {
    mount();
    fireEvent.click(screen.getByTestId('mini-expand'));
    expect(useUiStore.getState().sidebarMini).toBe(false);
  });
});
