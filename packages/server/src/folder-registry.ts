// Server-side mirror of the host-owned folder list (spec/04 § Folders).
//
// The host owns the folder registry and publishes it over the host link:
// `folders.list` (snapshot on connect) and `folders.updated` (push on change).
// The ws-hub fans those account-scoped events straight out to every live
// surface; this mirror caches the latest list so the cold-start REST endpoint
// (`GET /api/folders`) can serve a surface that connected AFTER the host's
// snapshot — exactly how `ChatRegistry` backs `GET /api/chats`.
//
// Purely in-memory: on server restart the mirror is empty until the host
// reconnects and re-publishes its `folders.list`. NO FALLBACK — an empty list
// means the host has not published yet, never a fabricated set.

import type { WireEvent } from '@patch/wire';

/** One host's published registry: its designated roots and its recents. */
export interface HostFolders {
  daemonId: string;
  roots: string[];
  recent: string[];
}

/**
 * The mirror is keyed BY HOST. Two hosts can publish the same path string
 * meaning two different directories, so a single flat list would collapse them
 * into one entry and the picker would offer a folder that does not exist on the
 * host it is about to spawn on (spec/04 § Folders).
 */
export class FolderRegistry {
  private readonly byHost = new Map<string, HostFolders>();

  /** Update the mirror from a host folder event. Ignores everything else. */
  observe(event: WireEvent): void {
    if (event.type === 'folders.list' || event.type === 'folders.updated') {
      this.byHost.set(event.daemonId, {
        daemonId: event.daemonId,
        roots: [...event.roots],
        recent: [...event.recent],
      });
    }
  }

  /** Every host that has published, in first-published order. */
  list(): HostFolders[] {
    return [...this.byHost.values()].map((h) => ({
      daemonId: h.daemonId,
      roots: [...h.roots],
      recent: [...h.recent],
    }));
  }

  /** One host's registry, or null when it has never published. */
  forHost(daemonId: string): HostFolders | null {
    const h = this.byHost.get(daemonId);
    return h ? { daemonId, roots: [...h.roots], recent: [...h.recent] } : null;
  }
}
