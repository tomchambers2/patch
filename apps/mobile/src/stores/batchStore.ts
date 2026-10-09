// batchStore — spec/15 § Batch view. The batch itself is server-owned
// (`BatchStore` on the server, `GET /api/batch`) — the same account-wide
// batch web's own sidebar shows, not a device-local one. This store is a
// thin polling mirror of that REST resource, plus the purely-local "which
// view the Chats column is showing" preference (`mode`), persisted the same
// way the Chats tab's own collapsible sections are (MMKV).

import { create } from 'zustand';
import { store } from '../lib/credential';
import { api, type BatchCheckInChoice, type BatchRecord } from '../api/rest';

export type BatchMode = 'regular' | 'batch';

const MODE_KEY = 'patch.batch.mode';

function loadMode(): BatchMode {
  const m = store().getString(MODE_KEY);
  return m === 'batch' ? m : 'regular';
}

function persistMode(m: BatchMode): void {
  store().set(MODE_KEY, m);
}

interface BatchState {
  mode: BatchMode;
  batch: BatchRecord | null;
  carryover: string[];
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
