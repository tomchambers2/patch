// batchNotifier (spec/15 § Batch view). The server decides when to check in
// and sends the one push notification (`09-notifications.md` § Batch
// check-in, handled by app/_layout.tsx's existing tap-through path); this
// file is just the client's live poll of GET /api/batch.

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderRN } from './testUtils/render';
import { useBatchStore } from '../src/stores/batchStore';
import type { BatchResponse } from '../src/api/rest';

const { getBatch } = vi.hoisted(() => ({ getBatch: vi.fn<[], Promise<BatchResponse>>() }));

vi.mock('../src/api/rest', () => ({
  api: {
    getBatch,
    startBatch: vi.fn(),
    removeBatchMember: vi.fn(),
    checkInBatchNow: vi.fn(),
    markBatchOpened: vi.fn(),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  useBatchStore.getState()._reset();
});

describe('useBatchWatcher', () => {
  it('fetches on mount and again on each poll tick', async () => {
    vi.useFakeTimers();
    getBatch.mockResolvedValue({ batch: null, carryover: [] });
    const { useBatchWatcher, BATCH_POLL_MS } = await import('../src/lib/batchNotifier');
    function Mount(): null {
      useBatchWatcher();
      return null;
    }
    await act(async () => {
      renderRN(React.createElement(Mount));
    });
    expect(getBatch).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BATCH_POLL_MS);
    });
    expect(getBatch).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
