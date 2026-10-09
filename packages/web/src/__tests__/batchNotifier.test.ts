// batchNotifier — spec/14 § Batch mode. The server decides when to check in
// (spec/09 § Batch check-in); this is just `showBatch()` (the "take me there"
// both the sidebar and a clicked notification use) and the polling watcher.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { BatchResponse } from '../api/rest.js';

const getBatch = vi.fn<() => Promise<BatchResponse>>();

vi.mock('../api/rest.js', () => ({
  api: {
    getBatch,
    startBatch: vi.fn(),
    removeBatchMember: vi.fn(),
    checkInBatchNow: vi.fn(),
    markBatchOpened: vi.fn(),
  },
}));

describe('showBatch', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { useBatchStore } = await import('../stores/batchStore.js');
    const { useUiStore } = await import('../stores/uiStore.js');
    useBatchStore.getState()._reset();
    useUiStore.getState().setSidebarCollapsed(true);
  });

  it('reveals the sidebar and switches its view to Batch', async () => {
    const { showBatch } = await import('../lib/batchNotifier.js');
    const { useBatchStore } = await import('../stores/batchStore.js');
    const { useUiStore } = await import('../stores/uiStore.js');
    showBatch();
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);
    expect(useBatchStore.getState().mode).toBe('batch');
  });
});

describe('useBatchWatcher', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    const { useBatchStore } = await import('../stores/batchStore.js');
    useBatchStore.getState()._reset();
  });

  it('fetches on mount and again on each poll tick', async () => {
    getBatch.mockResolvedValue({ batch: null, carryover: [] });
    const { renderHook } = await import('@testing-library/react');
    const { useBatchWatcher, BATCH_POLL_MS } = await import('../lib/batchNotifier.js');
    const { unmount } = renderHook(() => useBatchWatcher());
    await vi.waitFor(() => expect(getBatch).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(BATCH_POLL_MS);
    expect(getBatch).toHaveBeenCalledTimes(2);
    unmount();
    await vi.advanceTimersByTimeAsync(BATCH_POLL_MS * 2);
    expect(getBatch).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
