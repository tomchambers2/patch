// padsStore — the Pads list as the sidebar's count and the Pads page read it
// (spec/14 § Pads). One poll source for both, so a count and a page can never
// disagree. A failed refresh is kept as `error` and shown where the list is —
// never swallowed into an empty list.

import { create } from 'zustand';
import { api, type PadView } from '../api/rest.js';

interface PadsState {
  /** null until the first refresh lands. */
  pads: PadView[] | null;
  error: string | null;
  refresh(): Promise<void>;
}

export const usePadsStore = create<PadsState>((set) => ({
  pads: null,
  error: null,
  async refresh() {
    try {
      const { pads } = await api.listPads();
      set({ pads, error: null });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },
}));

/** Keep the store fresh while a component is mounted. */
export function startPadsPolling(intervalMs: number): () => void {
  void usePadsStore.getState().refresh();
  const t = setInterval(() => void usePadsStore.getState().refresh(), intervalMs);
  return () => clearInterval(t);
}
