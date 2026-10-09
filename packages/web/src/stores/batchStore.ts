// batchStore — spec/14 § Batch mode. The batch itself is server-owned
// (`BatchStore` on the server, `GET /api/batch`): this store is a thin,
// polling mirror of that REST resource, plus the purely-local "which sidebar
// view is showing" preference (`mode`) every other view keeps the same way.
//
// There is nothing to compute here — no ready/done derivation, no
// notification-firing decision — because the server already decides when to
// check in and already suppresses the per-chat doorbell for a member
// (spec/09 § Chat completion). This store only shows what the server says.

import { create } from 'zustand';
import { api, type BatchCheckInChoice, type BatchRecord } from '../api/rest.js';

export type BatchMode = 'regular' | 'batch';

const MODE_KEY = 'patch.batch.mode';

function loadMode(): BatchMode {
  /* v8 ignore next -- jsdom always defines localStorage; SSR guard unreachable under vitest. */
  if (typeof localStorage === 'undefined') return 'regular';
  const m = localStorage.getItem(MODE_KEY);
  return m === 'batch' ? m : 'regular';
}

function persistMode(m: BatchMode): void {
  /* v8 ignore next -- jsdom always defines localStorage; SSR guard unreachable under vitest. */
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(MODE_KEY, m);
}

interface BatchState {
  mode: BatchMode;
  batch: BatchRecord | null;
  carryover: string[];
  /** True once the first `refresh()` has landed — distinguishes "no batch
   *  running" from "haven't asked the server yet" so the panel doesn't flash
   *  the empty state before the real answer arrives. */
  loaded: boolean;

  setMode(m: BatchMode): void;
  refresh(): Promise<void>;
  start(checkIn: BatchCheckInChoice): Promise<void>;
  removeMember(chatId: string): Promise<void>;
  checkInNow(): Promise<void>;
  markOpened(chatId: string): Promise<void>;

  // Test / lifecycle helper.
  _reset(): void;
}

export const useBatchStore = create<BatchState>((set) => ({
  mode: loadMode(),
  batch: null,
  carryover: [],
  loaded: false,

  setMode(m) {
    persistMode(m);
    set({ mode: m });
  },

  async refresh() {
    const res = await api.getBatch();
    set({ batch: res.batch, carryover: res.carryover, loaded: true });
  },

  async start(checkIn) {
    const res = await api.startBatch(checkIn);
    set({ batch: res.batch, carryover: res.carryover, loaded: true });
  },

  async removeMember(chatId) {
    const res = await api.removeBatchMember(chatId);
    set({ batch: res.batch, carryover: res.carryover, loaded: true });
  },

  async checkInNow() {
    const res = await api.checkInBatchNow();
    set({ batch: res.batch, carryover: res.carryover, loaded: true });
  },

  async markOpened(chatId) {
    const res = await api.markBatchOpened(chatId);
    set({ batch: res.batch, carryover: res.carryover, loaded: true });
  },

  _reset() {
    set({ mode: 'regular', batch: null, carryover: [], loaded: false });
  },
}));
