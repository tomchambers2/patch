// Needs-attention filter + FIFO queue (spec/15-design-mobile.md § Needs
// attention; spec/14-design-web.md § Chat lifecycle → Needs attention
// toggle). Mirrors packages/web/src/lib/chatGroups.ts's `needsAttention` /
// `sortAttentionQueue` exactly, so the phone and the sidebar can never
// disagree about what "needs you" means or what order the queue works
// through.

import { deriveBadge } from '../stores/types';
import type { ChatRow } from '../stores/types';

/**
 * A chat needs attention when its badge is `done` (finished, unread),
 * `permission` (paused, needs a yes/no), or `errored` (the last turn failed —
 * dropping it out here would take a failed chat OUT of the queue, the exact
 * opposite of the point), or when the agent left it on a declared `question`
 * (paused on the user and needs an answer even once seen) or elected to
 * `report` it (the one state the agent chooses for itself). `working` (still
 * going) and `background` / `monitoring` (not yet a result to look at) are
 * deliberately excluded — none of them is a result yet.
 */
export function needsAttention(row: ChatRow): boolean {
  const badge = deriveBadge(row);
  return (
    badge === 'done' ||
    badge === 'permission' ||
    badge === 'errored' ||
    (row.statusKind === 'question' && row.statusDeclared === true) ||
    row.statusKind === 'report'
  );
}

/**
 * Re-orders an already-filtered needs-attention list into a FIFO queue:
 * oldest-waiting first, most-recently-updated LAST — the opposite of the
 * Chats tab's own recency order, because the queue is worked through front to
 * back and a row that updates again while still in it should rejoin the BACK
 * of the queue rather than cut back to the front. `permission` rows still
 * come first within the queue — a paused yes/no is a stronger signal than a
 * finished-and-unread chat — but two permission rows (or two done rows)
 * between themselves queue oldest first, same as the rest.
 */
export function sortAttentionQueue(rows: readonly ChatRow[]): ChatRow[] {
  return [...rows].sort(
    (a, b) => attentionRank(a) - attentionRank(b) || a.lastUpdated - b.lastUpdated || cmpId(a, b),
  );
}

function attentionRank(row: ChatRow): number {
  return deriveBadge(row) === 'permission' ? 0 : 1;
}

/** Stable, data-only tiebreaker so ties never resolve to insertion order. */
function cmpId(a: ChatRow, b: ChatRow): number {
  return a.chatId < b.chatId ? -1 : a.chatId > b.chatId ? 1 : 0;
}
