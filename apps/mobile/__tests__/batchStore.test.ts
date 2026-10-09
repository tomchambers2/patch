// batchStore (spec/15 § Batch view). The batch itself is server-owned; this
// store is a thin poll of GET /api/batch plus the purely-local "which view
// the Chats column is showing" preference (`mode`), persisted via MMKV.

import { describe, it, expect, beforeEach } from 'vitest';
import { vi } from 'vitest';
import type { BatchResponse } from '../src/api/rest';
import { __clearAllMmkv } from './stubs/mmkv';

const { getBatch, startBatch, removeBatchMember, checkInBatchNow, markBatchOpened } = vi.hoisted(
  () => ({
    getBatch: vi.fn<[], Promise<BatchResponse>>(),
    startBatch: vi.fn<[unknown], Promise<BatchResponse>>(),
    removeBatchMember: vi.fn<[string], Promise<BatchResponse>>(),
    checkInBatchNow: vi.fn<[], Promise<BatchResponse>>(),
    markBatchOpened: vi.fn<[string], Promise<BatchResponse>>(),
  }),
);

vi.mock('../src/api/rest', () => ({
  api: { getBatch, startBatch, removeBatchMember, checkInBatchNow, markBatchOpened },
}));

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
  beforeEach(() => {
    vi.clearAllMocks();
    __clearAllMmkv();
  });

  it('starts with no batch and not yet loaded', async () => {
    const { useBatchStore } = await import('../src/stores/batchStore');
    useBatchStore.getState()._reset();
    expect(useBatchStore.getState().batch).toBeNull();
    expect(useBatchStore.getState().loaded).toBe(false);
  });

  it('refresh() fetches and stores the server snapshot', async () => {
    const { useBatchStore } = await import('../src/stores/batchStore');
    useBatchStore.getState()._reset();
    getBatch.mockResolvedValue(running({ members: ['c1'] }));
    await useBatchStore.getState().refresh();
    expect(useBatchStore.getState().batch?.members).toEqual(['c1']);
    expect(useBatchStore.getState().loaded).toBe(true);
  });

  it('start() posts the chosen check-in and applies the response', async () => {
    const { useBatchStore } = await import('../src/stores/batchStore');
    useBatchStore.getState()._reset();
    startBatch.mockResolvedValue(running());
    await useBatchStore.getState().start({ type: 'time', minutes: 20 });
    expect(startBatch).toHaveBeenCalledWith({ type: 'time', minutes: 20 });
    expect(useBatchStore.getState().batch?.checkIn).toEqual({ type: 'time', minutes: 20 });
  });

  it('removeMember() calls the DELETE endpoint and applies the response', async () => {
    const { useBatchStore } = await import('../src/stores/batchStore');
    useBatchStore.getState()._reset();
    removeBatchMember.mockResolvedValue(running({ members: [] }));
    await useBatchStore.getState().removeMember('c1');
    expect(removeBatchMember).toHaveBeenCalledWith('c1');
    expect(useBatchStore.getState().batch?.members).toEqual([]);
  });

  it('checkInNow() applies the checked-in response without a notify of its own', async () => {
    const { useBatchStore } = await import('../src/stores/batchStore');
    useBatchStore.getState()._reset();
    checkInBatchNow.mockResolvedValue(running({ checkedIn: true }));
    await useBatchStore.getState().checkInNow();
    expect(useBatchStore.getState().batch?.checkedIn).toBe(true);
  });

  it('markOpened() applies the response, which may clear the batch entirely', async () => {
    const { useBatchStore } = await import('../src/stores/batchStore');
    useBatchStore.getState()._reset();
    markBatchOpened.mockResolvedValue({ batch: null, carryover: [] });
    await useBatchStore.getState().markOpened('c1');
    expect(markBatchOpened).toHaveBeenCalledWith('c1');
    expect(useBatchStore.getState().batch).toBeNull();
  });

  it('mode persists across instances via MMKV', async () => {
    const { useBatchStore } = await import('../src/stores/batchStore');
    useBatchStore.getState()._reset();
    expect(useBatchStore.getState().mode).toBe('regular');
    useBatchStore.getState().setMode('batch');
    expect(useBatchStore.getState().mode).toBe('batch');
  });
});
