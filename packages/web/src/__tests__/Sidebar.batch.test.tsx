// Sidebar batch-mode integration (spec/14 § Batch mode, § Sidebar §1b).
//
// The sidebar's view dropdown sits at the top of the sidebar; picking Batch
// swaps the chat list for the batch panel. Membership is server-driven
// (spec/14 § Batch mode — auto-membership), so there is no per-row control
// here any more; `BatchPanel.test.tsx` covers the panel's own behaviour.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Sidebar } from '../components/Sidebar.js';
import { useChatStore } from '../stores/chatStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useVoiceStore } from '../stores/voiceStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { useBatchStore } from '../stores/batchStore.js';
import { api } from '../api/rest.js';
import type { ChatRow } from '../stores/types.js';

function seedChat(chatId: string, name: string): void {
  const row: ChatRow = {
    pendingWake: null,
    todos: [],
    snoozedUntil: null,
    chatId,
    daemonId: 'd1',
    permissionMode: 'bypassPermissions' as const,
    name,
    folder: '~/proj',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 0,
    lastUserActivity: 0,
    awaitingPermission: false,
    lastReadSeq: 5,
    preview: null,
    goal: null,
    goalProgress: null,
    lastGoal: null,
    reminder: null,
    statusSummary: null,
    statusKind: null,
    statusDeclared: null,
    pendingPermissions: [],
    lastSeq: 9, // done — unseen activity
    jobId: null,
    model: null,
    rateLimitResumingAt: null,
    resumeKind: null,
  };
  useChatStore.setState((s) => ({ chats: { ...s.chats, [chatId]: row } }));
}

function renderSidebar(): void {
  render(
    <MemoryRouter>
      <Sidebar />
    </MemoryRouter>,
  );
}

describe('Sidebar batch mode', () => {
  beforeEach(() => {
    localStorage.clear();
    useChatStore.getState()._reset();
    useBatchStore.getState()._reset();
    usePresenceStore.getState().setConnection('connected');
    useVoiceStore.setState({ activeDevices: {} });
    useUiStore.getState().setAttentionOnly(false);
    vi.spyOn(api, 'listChatsArchived').mockResolvedValue({ chats: [], nextOffset: null });
    vi.spyOn(api, 'listChatsDeleted').mockResolvedValue({ chats: [], nextOffset: null });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  function selectBatch(): void {
    fireEvent.click(screen.getByTestId('sidebar-view-trigger'));
    fireEvent.click(screen.getByTestId('sidebar-view-option-batch'));
  }

  it('renders the sidebar view dropdown at the top', () => {
    renderSidebar();
    expect(screen.getByTestId('sidebar-view-menu')).toBeTruthy();
    expect(screen.getByTestId('sidebar-view-trigger')).toBeTruthy();
  });

  it('a regular chat row carries no batch toggle', () => {
    seedChat('c1', 'first chat');
    renderSidebar();
    expect(screen.queryByTestId('batch-toggle-c1')).toBeNull();
  });

  it('picking Batch in the view dropdown shows the batch panel with the current members', () => {
    seedChat('c1', 'first chat');
    useBatchStore.setState({
      batch: {
        id: 'b1',
        startedAt: 0,
        checkIn: { type: 'time', minutes: 20 },
        checkInAt: 20 * 60_000,
        members: ['c1'],
        checkedIn: false,
        openedMemberIds: [],
      },
      loaded: true,
    });
    renderSidebar();
    // Regular mode: the batch panel is not shown.
    expect(screen.queryByTestId('batch-panel')).toBeNull();
    selectBatch();
    expect(screen.getByTestId('batch-panel')).toBeTruthy();
    expect(screen.getByTestId('batch-row-c1')).toBeTruthy();
  });
});
