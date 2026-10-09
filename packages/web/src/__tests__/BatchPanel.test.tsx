// BatchPanel — the batch review view (spec/14 § Batch mode), reached from the
// sidebar's view dropdown's Batch option (`SidebarViewMenu`).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { BatchRecord, BatchResponse } from '../api/rest.js';
import type { ChatRow } from '../stores/types.js';

const startBatch = vi.fn<(checkIn: unknown) => Promise<BatchResponse>>();
const removeBatchMember = vi.fn<(chatId: string) => Promise<BatchResponse>>();
const checkInBatchNow = vi.fn<() => Promise<BatchResponse>>();

vi.mock('../api/rest.js', () => ({
  api: {
    getBatch: vi.fn(async () => ({ batch: null, carryover: [] })),
    startBatch,
    removeBatchMember,
    checkInBatchNow,
    markBatchOpened: vi.fn(),
  },
}));

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
  useChatStoreRef.setState({ chats: Object.fromEntries(rows.map((r) => [r.chatId, r])) });
}

function batch(over: Partial<BatchRecord> = {}): BatchRecord {
  return {
    id: 'b1',
    startedAt: 0,
    checkIn: { type: 'time', minutes: 20 },
    checkInAt: 20 * 60_000,
    members: [],
    checkedIn: false,
    openedMemberIds: [],
    ...over,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let useChatStoreRef: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let useBatchStoreRef: any;
let BatchPanel: typeof import('../components/BatchPanel.js').BatchPanel;

describe('BatchPanel', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    localStorage.clear();
    ({ useChatStore: useChatStoreRef } = await import('../stores/chatStore.js'));
    ({ useBatchStore: useBatchStoreRef } = await import('../stores/batchStore.js'));
    ({ BatchPanel } = await import('../components/BatchPanel.js'));
    useBatchStoreRef.getState()._reset();
    useChatStoreRef.setState({ chats: {} });
  });
  afterEach(cleanup);

  function renderPanel(): void {
    render(
      <MemoryRouter>
        <BatchPanel />
      </MemoryRouter>,
    );
  }

  it('shows an empty state with a start option when no batch is running', () => {
    renderPanel();
    expect(screen.getByTestId('batch-empty')).toBeTruthy();
    expect(screen.getByTestId('batch-start-20')).toBeTruthy();
  });

  it('starts a batch with the chosen check-in', () => {
    startBatch.mockResolvedValue({ batch: batch(), carryover: [] });
    renderPanel();
    fireEvent.click(screen.getByTestId('batch-start-20'));
    expect(startBatch).toHaveBeenCalledWith({ type: 'time', minutes: 20 });
  });

  it('starts an "all done" batch', () => {
    startBatch.mockResolvedValue({
      batch: batch({ checkIn: { type: 'all-done' } }),
      carryover: [],
    });
    renderPanel();
    fireEvent.click(screen.getByTestId('batch-start-all-done'));
    expect(startBatch).toHaveBeenCalledWith({ type: 'all-done' });
  });

  it('before check-in, members are marked only "waiting" — no status badge', () => {
    seedChats(row('a', 'done'), row('b', 'working'));
    useBatchStoreRef.setState({ batch: batch({ members: ['a', 'b'] }), loaded: true });
    renderPanel();
    expect(screen.getByTestId('batch-row-a').textContent).toContain('waiting');
    expect(screen.getByTestId('batch-row-b').textContent).toContain('waiting');
    expect(screen.getByTestId('batch-checkin-time')).toBeTruthy();
    expect(screen.getByTestId('batch-checkin-now')).toBeTruthy();
  });

  it('after check-in, members show real status, done first', () => {
    seedChats(row('running1', 'working'), row('done1', 'done'));
    useBatchStoreRef.setState({
      batch: batch({ members: ['running1', 'done1'], checkedIn: true }),
      loaded: true,
    });
    renderPanel();
    expect(screen.getByTestId('batch-row-running1').textContent).not.toContain('waiting');
    expect(screen.queryByTestId('batch-checkin-now')).toBeNull();
    const rows = screen.getAllByTestId(/^batch-row-/);
    expect(rows[0]?.getAttribute('data-testid')).toBe('batch-row-done1');
    expect(rows[1]?.getAttribute('data-testid')).toBe('batch-row-running1');
  });

  it('removes a chat from the batch via its remove control', () => {
    seedChats(row('a', 'done'));
    removeBatchMember.mockResolvedValue({ batch: batch({ members: [] }), carryover: [] });
    useBatchStoreRef.setState({ batch: batch({ members: ['a'] }), loaded: true });
    renderPanel();
    fireEvent.click(screen.getByTestId('batch-remove-a'));
    expect(removeBatchMember).toHaveBeenCalledWith('a');
  });

  it('"Check in now" calls the manual check-in endpoint', () => {
    checkInBatchNow.mockResolvedValue({ batch: batch({ checkedIn: true }), carryover: [] });
    useBatchStoreRef.setState({ batch: batch(), loaded: true });
    renderPanel();
    fireEvent.click(screen.getByTestId('batch-checkin-now'));
    expect(checkInBatchNow).toHaveBeenCalled();
  });
});
