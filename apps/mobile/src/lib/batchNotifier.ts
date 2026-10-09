// batchNotifier — spec/15 § Batch view. The server decides when to check in
// and sends the one push notification (`09-notifications.md` § Batch
// check-in) — this file is just the client's live mirror, polling
// `GET /api/batch` so the view dropdown's count and the Batch view itself
// stay current without the user having to pull to refresh.

import { useEffect } from 'react';
import { useBatchStore } from '../stores/batchStore';

/** How often (ms) the watcher polls the server for the live batch state. */
export const BATCH_POLL_MS = 10_000;

/** A poll failure is transient and the next tick retries it. */
function refreshQuietly(): void {
  void useBatchStore
    .getState()
    .refresh()
    .catch(() => undefined);
}

/** Mount the batch watcher once, for the app's lifetime: fetch on mount, then
 *  poll on a steady interval. */
export function useBatchWatcher(): void {
  useEffect(() => {
    refreshQuietly();
    const id = setInterval(refreshQuietly, BATCH_POLL_MS);
    return () => clearInterval(id);
  }, []);
}
