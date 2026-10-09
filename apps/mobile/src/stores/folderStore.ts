// Host-owned folder list (spec/04 § Folders). The host publishes its
// folder registry over the wire (`folders.list` on connect, `folders.updated`
// on change); the server relays both to every surface, and cold-start reads
// `GET /api/folders`. This store holds the latest published list so the
// new-chat and job-editor folder pickers are populated from the SAME
// host source — the user taps a known folder rather than typing a path.
//
// The list is a read-mirror: the host is authoritative and every
// `folders.list` / `folders.updated` replaces it wholesale.

import { create } from 'zustand';

/** One host's published registry (spec/04 § Folders). */
export interface HostFolders {
  daemonId: string;
  roots: string[];
  recent: string[];
}

interface FolderState {
  /**
   * Keyed BY HOST. The picker is one list grouped by host, so two machines
   * that both have a `~/projects/patch` stay two entries — collapsing them
   * would offer a folder that does not exist on the host about to be spawned
   * on.
   */
  byHost: Record<string, HostFolders>;
  /** Replace ONE host's registry (`folders.list` / `folders.updated`). */
  setHostFolders(entry: HostFolders): void;
  /** Replace every host's registry (cold-start `GET /api/folders`). */
  setAllFolders(entries: HostFolders[]): void;
  /** Every folder on one host, roots first then recents — the picker's group. */
  foldersFor(daemonId: string): string[];
  _reset(): void;
}

export const useFolderStore = create<FolderState>((set, get) => ({
  byHost: {},
  setHostFolders(entry) {
    set((s) => ({
      byHost: {
        ...s.byHost,
        [entry.daemonId]: {
          daemonId: entry.daemonId,
          roots: [...entry.roots],
          recent: [...entry.recent],
        },
      },
    }));
  },
  setAllFolders(entries) {
    const byHost: Record<string, HostFolders> = {};
    for (const e of entries) {
      byHost[e.daemonId] = { daemonId: e.daemonId, roots: [...e.roots], recent: [...e.recent] };
    }
    set({ byHost });
  },
  foldersFor(daemonId) {
    const h = get().byHost[daemonId];
    return h ? [...h.roots, ...h.recent] : [];
  },
  _reset() {
    set({ byHost: {} });
  },
}));
