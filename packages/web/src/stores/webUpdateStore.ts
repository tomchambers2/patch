// webUpdateStore — a newer SPA bundle has been reported over the WS
// (liveUpdate.ts's onServerVersion), waiting for the user to press Reload
// (components/WebUpdateBanner.tsx). Mirrors the desktop shell's own
// `staleSince` (packages/desktop/src/updater.ts): the moment the FIRST report
// landed, not the latest one — a deploy that lands again before the user
// reloads must not reset the clock and start the escalation over.

import { create } from 'zustand';

interface WebUpdateState {
  /** The most recently reported bundle hash, or null if none is staged. */
  bundle: string | null;
  /** When a newer bundle was FIRST seen — survives repeat reports; cleared only
   *  by `clear()` (a reload actually happening). */
  staleSince: string | null;
  setAvailable: (bundle: string, at?: string) => void;
  clear: () => void;
}

export const useWebUpdateStore = create<WebUpdateState>((set, get) => ({
  bundle: null,
  staleSince: null,
  setAvailable: (bundle, at = new Date().toISOString()) =>
    set({ bundle, staleSince: get().staleSince ?? at }),
  clear: () => set({ bundle: null, staleSince: null }),
}));
