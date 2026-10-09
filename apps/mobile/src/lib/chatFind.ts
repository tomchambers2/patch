// Find in this chat (spec/15 § Find in chat): which messages hold the query.
// The transcript is a virtualised list, so matching is over the data, not the
// rendered text; the screen scrolls to each hit with the search-jump path.

import type { ChatEventEntry } from '../stores/chatStore';

/** Seqs of the messages whose text contains `query` (case-insensitive,
 *  trimmed), in chronological order. */
export function findMessageSeqs(timeline: readonly ChatEventEntry[], query: string): number[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [];
  const out: number[] = [];
  for (const e of timeline) {
    if (e.kind !== 'message' || typeof e.content !== 'string') continue;
    if (e.content.toLowerCase().includes(q)) out.push(e.seq);
  }
  return out;
}

/** Index after stepping `delta` from `current`, wrapping. -1 when empty. */
export function stepIndex(current: number, delta: 1 | -1, count: number): number {
  if (count === 0) return -1;
  return (current + delta + count) % count;
}
