import { useEffect } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api } from '../api/rest.js';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';

const CHAT_COUNTS_QUERY_KEY = ['chat-counts'];

/**
 * Loads the sidebar's section counts (spec/04 § Section counts) into the chat
 * store and keeps them live.
 *
 * The sidebar's cold-storage rows are collapsed by default and their lists load
 * on expand, so the store cannot measure a section the user has never opened —
 * the cold-start `GET /api/chats` excludes hidden, archived, snoozed and
 * deleted chats entirely, and a locally-derived count would read `0` for a
 * section that is full. The counts come from the server instead, carrying no
 * rows, so they stay cheap however many archived chats accumulate.
 *
 * Shared by AppShell and the dev harness rather than hand-mirrored, so the e2e
 * suite exercises the real refetch path (the harness has no backend; specs stub
 * `/api/chats/counts` with `page.route`).
 */
export function useSectionCounts(): void {
  const queryClient = useQueryClient();
  const { error, refetch } = useQuery({
    queryKey: CHAT_COUNTS_QUERY_KEY,
    queryFn: async () => {
      const r = await api.chatSectionCounts();
      // NO FALLBACK: `0` is a meaningful value here — it is a section's entire
      // empty state — so a missing or non-numeric field must not be coerced to
      // it. A confident `0` on a section that is actually full is worse than no
      // badge at all, because it is what stops the user opening it.
      for (const key of ['hidden', 'archived', 'snoozed', 'deleted', 'automations'] as const) {
        if (typeof r[key] !== 'number' || !Number.isFinite(r[key])) {
          throw new Error(`malformed section counts: ${JSON.stringify(r)}`);
        }
      }
      useChatStore.getState().setSectionCounts({
        hidden: r.hidden,
        archived: r.archived,
        snoozed: r.snoozed,
        deleted: r.deleted,
        automations: r.automations,
      });
      return r;
    },
  });

  useEffect(() => {
    // NO FALLBACK — counts that failed to load leave the badges absent, which
    // reads as "not loaded yet" rather than "empty"; the toast is what names it.
    if (error) {
      useUiStore.getState().pushError(`failed to load section counts: ${(error as Error).message}`);
    }
  }, [error]);

  // Counts go stale the moment a chat changes lifecycle state, and archiving is
  // a constant background action — a count fetched once at boot would drift all
  // session. Rather than invalidate from each of the many call sites that
  // archive/delete/snooze/restore (and the WS echo that confirms them), watch
  // the one place they all land: the store.
  //
  // Subscribed imperatively rather than with a `useChatStore(selector)`, on
  // purpose. A selector runs on EVERY store notification — one per streamed
  // token — and subscribing to `chats` would re-render the caller on every
  // activity tick, which is the cost spec/14 § Sidebar render cost exists to
  // avoid. This listener exits on a reference check instead, and only walks the
  // rows when the map identity actually changed (`applyEvent` is
  // identity-preserving, so an event that changed no row keeps the same map).
  useEffect(() => {
    let lastChats = useChatStore.getState().chats;
    let lastSignature = lifecycleSignature(lastChats);
    const requestFresh = freshRefetcher(queryClient, refetch);
    return useChatStore.subscribe((state) => {
      if (state.chats === lastChats) return;
      lastChats = state.chats;
      const next = lifecycleSignature(lastChats);
      if (next === lastSignature) return;
      lastSignature = next;
      requestFresh();
    });
  }, [queryClient, refetch]);
}

/**
 * A lifecycle change that lands while the query's mount-time fetch is still in
 * flight must not be swallowed. TanStack Query dedupes concurrent fetches of
 * one query when it has no data yet, so calling `refetch()` then just awaits
 * that SAME in-flight fetch — resolving with the answer it already had before
 * the very state change that asked for a fresh one. A chat hidden a moment
 * after boot left the badge on its stale pre-boot count forever this way
 * (Patch admin task 6hfRqCm94xv76hqc).
 *
 * Checked and re-asked, not inferred from the response: nothing on a
 * `refetch()` result says whether it was ridden in on someone else's fetch or
 * started fresh, so the only reliable signal is whether a fetch was already
 * under way the moment it was called.
 *
 * ONE loop per subscription, never one per change. Once the query has data,
 * `refetch()` CANCELS the in-flight fetch and starts its own, so two
 * independent re-ask chains each saw the other's fetch in flight, cancelled
 * it, and re-asked — forever, and inside microtasks, so the page never got
 * back to the event loop. That froze the desktop window solid and grew the
 * renderer to an out-of-memory crash (21 crash reports, 30 Sep – 7 Oct). A
 * change that arrives mid-loop now just marks it dirty for one more round.
 */
function freshRefetcher(queryClient: QueryClient, refetch: () => Promise<unknown>): () => void {
  let running = false;
  let dirty = false;
  return () => {
    dirty = true;
    if (running) return;
    running = true;
    void (async () => {
      try {
        while (dirty) {
          dirty = false;
          const wasAlreadyFetching =
            queryClient.getQueryState(CHAT_COUNTS_QUERY_KEY)?.fetchStatus === 'fetching';
          await refetch();
          // The answer may have been one that started before the change.
          if (wasAlreadyFetching) dirty = true;
        }
      } finally {
        running = false;
      }
    })();
  };
}

/**
 * A chat's lifecycle state, reduced to a string. Covers exactly what moves a
 * chat between sections: which chats exist (a spawn adds an id, and an
 * automation only ever arrives as a new chat — `jobId` is set once at spawn and
 * never changes), each one's `status`, its snooze, and whether it is hidden.
 * Order-independent, because the store re-keys its map on merges and a
 * reordering is not a lifecycle change.
 */
function lifecycleSignature(
  chats: Record<string, { status: string; snoozedUntil: number | null; hidden?: boolean }>,
): string {
  return Object.entries(chats)
    .map(([id, c]) => `${id}:${c.status}:${c.snoozedUntil ?? ''}:${c.hidden === true ? 'h' : ''}`)
    .sort()
    .join('|');
}
