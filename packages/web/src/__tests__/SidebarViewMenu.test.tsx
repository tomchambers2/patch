// SidebarViewMenu — the sidebar's one view dropdown (spec/14 § Sidebar §1b),
// replacing the old Chats/Batch tabs, state-filter select and Needs attention
// toggle (three controls for one job).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SidebarViewMenu } from '../components/SidebarViewMenu.js';
import { BatchPanel } from '../components/BatchPanel.js';
import { useBatchStore } from '../stores/batchStore.js';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import type { ChatRow } from '../stores/types.js';

function row(chatId: string, badge: 'working' | 'done', name = chatId): ChatRow {
  const base: ChatRow = {
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
    lastSeq: 5,
    jobId: null,
    model: null,
    rateLimitResumingAt: null,
    resumeKind: null,
  };
  return badge === 'working'
    ? { ...base, activity: 'running' }
    : { ...base, lastSeq: 9, lastReadSeq: 5 };
}

function seedChats(...rows: ChatRow[]): void {
  useChatStore.setState({ chats: Object.fromEntries(rows.map((r) => [r.chatId, r])) });
}

function renderMenu(): void {
  render(
    <MemoryRouter>
      <SidebarViewMenu />
    </MemoryRouter>,
  );
}

function open(): void {
  fireEvent.click(screen.getByTestId('sidebar-view-trigger'));
}

function choose(value: string): void {
  open();
  fireEvent.click(screen.getByTestId(`sidebar-view-option-${value}`));
}

describe('SidebarViewMenu', () => {
  beforeEach(() => {
    localStorage.clear();
    useBatchStore.getState()._reset();
    useChatStore.setState({ chats: {} });
    useUiStore.getState().setAttentionOnly(false);
    useUiStore.getState().setStateFilter('all');
  });
  afterEach(cleanup);

  it('defaults to "All chats" and lists every option when opened', () => {
    renderMenu();
    expect(screen.getByTestId('sidebar-view-trigger').textContent).toContain('All chats');
    open();
    for (const v of ['all', 'unread', 'working', 'waiting', 'failed', 'batch']) {
      expect(screen.getByTestId(`sidebar-view-option-${v}`)).toBeTruthy();
    }
  });

  it('the old Chats/Batch tabs, state filter and Needs attention toggle are gone', () => {
    renderMenu();
    expect(screen.queryByTestId('batch-tabs')).toBeNull();
    expect(screen.queryByTestId('batch-tab-regular')).toBeNull();
    expect(screen.queryByTestId('batch-tab-batch')).toBeNull();
    expect(screen.queryByTestId('state-filter')).toBeNull();
    expect(screen.queryByTestId('attention-toggle')).toBeNull();
  });

  it('picking Unread sets attentionOnly and clears batch mode and the state filter', () => {
    useUiStore.getState().setStateFilter('working');
    renderMenu();
    choose('unread');
    expect(useUiStore.getState().attentionOnly).toBe(true);
    expect(useUiStore.getState().stateFilter).toBe('all');
    expect(useBatchStore.getState().mode).toBe('regular');
    expect(screen.getByTestId('sidebar-view-trigger').textContent).toContain('Unread');
  });

  it.each([
    ['working', 'working'],
    ['waiting', 'waiting'],
    ['failed', 'failed'],
  ] as const)('picking %s sets the state filter and clears Unread/batch', (optionValue, filter) => {
    useUiStore.getState().setAttentionOnly(true);
    renderMenu();
    choose(optionValue);
    expect(useUiStore.getState().stateFilter).toBe(filter);
    expect(useUiStore.getState().attentionOnly).toBe(false);
    expect(useBatchStore.getState().mode).toBe('regular');
  });

  it('picking Batch switches batch mode and clears Unread/the state filter', () => {
    useUiStore.getState().setAttentionOnly(true);
    renderMenu();
    choose('batch');
    expect(useBatchStore.getState().mode).toBe('batch');
    expect(useUiStore.getState().attentionOnly).toBe(false);
    expect(useUiStore.getState().stateFilter).toBe('all');
    expect(screen.getByTestId('sidebar-view-trigger').textContent).toContain('Batch');
  });

  it('picking All clears every filter', () => {
    useUiStore.getState().setAttentionOnly(true);
    renderMenu();
    choose('all');
    expect(useUiStore.getState().attentionOnly).toBe(false);
    expect(useUiStore.getState().stateFilter).toBe('all');
    expect(useBatchStore.getState().mode).toBe('regular');
  });

  it('marks the current option with a check and reflects a batch switched from elsewhere', () => {
    useBatchStore.getState().setMode('batch');
    renderMenu();
    expect(screen.getByTestId('sidebar-view-trigger').textContent).toContain('Batch');
    open();
    const selected = screen.getByTestId('sidebar-view-option-batch');
    expect(selected.getAttribute('aria-selected')).toBe('true');
    expect(within(selected).getByText('✓')).toBeTruthy();
  });

  it('shows the batch member count on the Batch option, matching the batch view', () => {
    seedChats(row('a', 'done'), row('b', 'working'), row('c', 'done'));
    useBatchStore.setState({
      batch: {
        id: 'b1',
        startedAt: 0,
        checkIn: { type: 'time', minutes: 20 },
        checkInAt: 20 * 60_000,
        members: ['a', 'b'],
        checkedIn: false,
        openedMemberIds: [],
      },
      loaded: true,
    });
    renderMenu();
    open();
    expect(screen.getByTestId('sidebar-view-batch-count').textContent).toBe('2');
  });

  it('draws no count badge when the batch is empty', () => {
    renderMenu();
    open();
    expect(screen.queryByTestId('sidebar-view-batch-count')).toBeNull();
  });

  it('closes on an outside click and on Escape', () => {
    renderMenu();
    open();
    expect(screen.getByTestId('sidebar-view-popup')).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId('sidebar-view-popup')).toBeNull();
    open();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('sidebar-view-popup')).toBeNull();
  });

  it('picking the already-selected option just closes the menu', () => {
    renderMenu();
    choose('all');
    expect(screen.queryByTestId('sidebar-view-popup')).toBeNull();
    expect(useUiStore.getState().attentionOnly).toBe(false);
  });

  it('persists the choice across a reload', () => {
    renderMenu();
    choose('failed');
    expect(localStorage.getItem('patch.sidebar.stateFilter')).toBe('failed');

    cleanup();
    renderMenu();
    expect(screen.getByTestId('sidebar-view-trigger').textContent).toContain('Failed');
  });

  it('shows the batch view when Batch is chosen, beside BatchPanel', () => {
    seedChats(row('a', 'done'));
    useBatchStore.setState({
      batch: {
        id: 'b1',
        startedAt: 0,
        checkIn: { type: 'time', minutes: 20 },
        checkInAt: 20 * 60_000,
        members: ['a'],
        checkedIn: false,
        openedMemberIds: [],
      },
      loaded: true,
    });
    render(
      <MemoryRouter>
        <SidebarViewMenu />
        {useBatchStore.getState().mode === 'batch' ? <BatchPanel /> : null}
      </MemoryRouter>,
    );
    choose('batch');
    // The store flipped; re-render with BatchPanel now mounted (mirrors how
    // Sidebar.tsx conditionally renders BatchPanel off `batchStore.mode`).
    cleanup();
    render(
      <MemoryRouter>
        <SidebarViewMenu />
        <BatchPanel />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('batch-row-a')).toBeTruthy();
  });
});

describe('SidebarViewMenu sort controls', () => {
  beforeEach(() => {
    localStorage.clear();
    useUiStore.setState({ chatSort: 'last-action', groupSort: 'last-action' });
  });
  afterEach(() => cleanup());
  it('picks and persists chat and project sorts independently', () => {
    render(
      <MemoryRouter>
        <SidebarViewMenu />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId('sidebar-view-trigger'));
    fireEvent.click(screen.getByTestId('sidebar-chat-sort-name'));
    fireEvent.click(screen.getByTestId('sidebar-group-sort-last-update'));
    expect(useUiStore.getState().chatSort).toBe('name');
    expect(useUiStore.getState().groupSort).toBe('last-update');
    expect(localStorage.getItem('patch.sidebar.chatSort')).toBe('name');
    expect(localStorage.getItem('patch.sidebar.groupSort')).toBe('last-update');
  });
});
