import type { ChatRow } from '../stores/types';

/**
 * Chats-tab local filter (spec/15 ## Chats tab § Search; matching rules shared
 * with spec/14 § Archived search). Instant and local, re-run on every keystroke
 * over rows already in the store. It is the whole search for a query too short
 * to send, and the stand-in for a longer one until the server's search
 * (spec/03 § Chat search, lib/chatSearch.ts) answers. A row matches when the trimmed query appears,
 * case-insensitively, in its name or its preview. Matches keep the incoming
 * order — no ranking.
 */
export function filterChats(rows: readonly ChatRow[], query: string): ChatRow[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...rows];
  return rows.filter(
    (r) => (r.name ?? '').toLowerCase().includes(q) || (r.preview ?? '').toLowerCase().includes(q),
  );
}
