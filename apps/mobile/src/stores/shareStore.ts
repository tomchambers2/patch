// Holds a share-sheet payload (src/lib/nativeShare.ts) between the moment it
// arrives and the user picking a destination on app/share.tsx. Deliberately
// tiny and separate from chatStore: a share is a one-shot handoff, not chat
// state, and nothing else needs to react to it.

import { create } from 'zustand';
import type { SharedPayload } from '../lib/shareIntent';

interface ShareState {
  /** The share awaiting a destination, or null once handled/cleared. */
  pending: SharedPayload | null;
  setPending: (payload: SharedPayload) => void;
  clear: () => void;
}

export const useShareStore = create<ShareState>((set) => ({
  pending: null,
  setPending: (payload) => set({ pending: payload }),
  clear: () => set({ pending: null }),
}));
