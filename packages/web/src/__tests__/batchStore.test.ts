// batchStore — spec/14 § Batch mode. The batch itself is server-owned; this
// store is a thin poll of GET /api/batch plus the purely-local sidebar-view
// preference (`mode`).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { BatchResponse } from '../api/rest.js';

const getBatch = vi.fn<() => Promise<BatchResponse>>();
const startBatch = vi.fn<(checkIn: unknown) => Promise<BatchResponse>>();
const removeBatchMember = vi.fn<(chatId: string) => Promise<BatchResponse>>();
const checkInBatchNow = vi.fn<() => Promise<BatchResponse>>();
const markBatchOpened = vi.fn<(chatId: string) => Promise<BatchResponse>>();

vi.mock('../api/rest.js', () => ({
  api: { getBatch, startBatch, removeBatchMember, checkInBatchNow, markBatchOpened },
}));

const EMPTY: BatchResponse = { batch: null, carryover: [] };

function running(over: Partial<BatchResponse['batch']> = {}): BatchResponse {
  return {
    batch: {
      id: 'b1',
      startedAt: 1000,
      checkIn: { type: 'time', minutes: 20 },
      checkInAt: 1000 + 20 * 60_000,
      members: [],
      checkedIn: false,
      openedMemberIds: [],
      ...over,
    },
    carryover: [],
  };
}

describe('batchStore', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { useBatchStore } = await import('../stores/batchStore.js');
    useBatchStore.getState()._reset();
  });

  it('starts with no batch and not yet loaded', async () => {
    const { useBatchStore } = await import('../stores/batchStore.js');
    expect(useBatchStore.getState().batch).toBeNull();
    expect(useBatchStore.getState().loaded).toBe(false);
  });

  it('refresh() fetches and stores the server snapshot', async () => {
    const { useBatchStore } = await import('../stores/batchStore.js');
    getBatch.mockResolvedValue(running({ members: ['c1'] }));
    await useBatchStore.getState().refresh();
    expect(useBatchStore.getState().batch?.members).toEqual(['c1']);
    expect(useBatchStore.getState().loaded).toBe(true);
  });

  it('start() posts the chosen check-in and applies the response', async () => {
    const { useBatchStore } = await import('../stores/batchStore.js');
    startBatch.mockResolvedValue(running());
    await useBatchStore.getState().start({ type: 'time', minutes: 20 });
    expect(startBatch).toHaveBeenCalledWith({ type: 'time', minutes: 20 });
    expect(useBatchStore.getState().batch?.checkIn).toEqual({ type: 'time', minutes: 20 });
  });

  it('removeMember() calls the DELETE endpoint and applies the response', async () => {
    const { useBatchStore } = await import('../stores/batchStore.js');
    removeBatchMember.mockResolvedValue(running({ members: [] }));
    await useBatchStore.getState().removeMember('c1');
    expect(removeBatchMember).toHaveBeenCalledWith('c1');
    expect(useBatchStore.getState().batch?.members).toEqual([]);
  });

  it('checkInNow() applies the checked-in response without a notify of its own', async () => {
    const { useBatchStore } = await import('../stores/batchStore.js');
    checkInBatchNow.mockResolvedValue(running({ checkedIn: true }));
    await useBatchStore.getState().checkInNow();
    expect(useBatchStore.getState().batch?.checkedIn).toBe(true);
  });

  it('markOpened() applies the response, which may clear the batch entirely', async () => {
    const { useBatchStore } = await import('../stores/batchStore.js');
    markBatchOpened.mockResolvedValue(EMPTY);
    await useBatchStore.getState().markOpened('c1');
    expect(markBatchOpened).toHaveBeenCalledWith('c1');
    expect(useBatchStore.getState().batch).toBeNull();
  });

  it('mode persists and defaults to regular', async () => {
    const { useBatchStore } = await import('../stores/batchStore.js');
    expect(useBatchStore.getState().mode).toBe('regular');
    useBatchStore.getState().setMode('batch');
    expect(useBatchStore.getState().mode).toBe('batch');
  });
});
