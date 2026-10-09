// batchNotifier — spec/14 § Batch mode.
//
// The server decides when to check in and sends the one notification
// (spec/09 § Batch check-in); this file is just the client's live mirror —
// poll `GET /api/batch` so the sidebar count and the batch view stay current
// — plus `showBatch()`, the "take me there" both the sidebar's `Batch` option
// and a clicked notification use.

import { useEffect } from 'react';
import { useBatchStore } from '../stores/batchStore.js';
import { useUiStore } from '../stores/uiStore.js';

/** How often (ms) the watcher polls the server for the live batch state. */
export const BATCH_POLL_MS = 10_000;

/**
 * Put the batch in front of the user. Two moves, because the batch view is
 * not a route — it is the sidebar's own view dropdown set to Batch
 * (`SidebarViewMenu` -> `BatchPanel`), and AppShell renders the sidebar as
 * `{sidebarCollapsed ? null : <Sidebar />}`. So switching the view alone
 * lands on nothing whenever the sidebar is put away, which is both the
 * collapsed desktop column and the narrow-width drawer. Deliberately does NOT
 * touch the router: the chat you were reading stays open beside the batch,
 * which is the whole point of reviewing one.
 */
export function showBatch(): void {
  useUiStore.getState().setSidebarCollapsed(false);
  useBatchStore.getState().setMode('batch');
}

/** A poll failure is transient (a network blip, a cold-start race) and the
 *  next tick retries it — not worth an error toast on every tab. */
function refreshQuietly(): void {
  void useBatchStore
    .getState()
    .refresh()
    .catch(() => undefined);
}

/** Mount the batch watcher: fetch on mount, then poll on a steady interval so
 *  the sidebar count and the batch view stay live without a page reload. */
export function useBatchWatcher(): void {
  useEffect(() => {
    refreshQuietly();
    const id = setInterval(refreshQuietly, BATCH_POLL_MS);
    return () => clearInterval(id);
  }, []);
}
