// Global chat search (spec/03 § Chat search, spec/14 § Sidebar) — the pure
// half of the sidebar's search: highlight segmentation, the instant local
// filter that stands in while the server is answering, and the copy for a
// result's meta line and for a host that was not searched.

import {
  CHAT_SEARCH_MIN_QUERY,
  parseSearchQuery,
  SPECIAL_THREAD_IDS,
  type ChatSearchHit,
  type ChatSearchHostResult,
  type ChatSearchRange,
  type ChatSearchSection,
} from '@patch/wire';
import type { ChatRow } from '../stores/types.js';
import { isHidden, isSnoozed } from '../stores/types.js';

/** The trimmed query, or null when it is too short to send. */
export function searchableQuery(raw: string): string | null {
  const q = raw.trim();
  return q.length >= CHAT_SEARCH_MIN_QUERY ? q : null;
}

export interface HighlightSegment {
  text: string;
  marked: boolean;
}

/**
 * Split `text` into alternating plain / marked runs from `[start, end)` ranges.
 * The ranges come off the wire, so they are treated defensively: clamped to the
 * string, empty or inverted ones dropped, and overlapping or touching ones
 * merged — a result never draws a mark inside a mark, or throws.
 */
export function highlightSegments(
  text: string,
  ranges: readonly ChatSearchRange[] | readonly (readonly [number, number])[],
): HighlightSegment[] {
  const clamped = ranges
    .map(([s, e]): [number, number] => [
      Math.max(0, Math.min(text.length, Math.floor(s))),
      Math.max(0, Math.min(text.length, Math.floor(e))),
    ])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const r of clamped) {
    const last = merged[merged.length - 1];
    if (last !== undefined && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  const out: HighlightSegment[] = [];
  let at = 0;
  for (const [s, e] of merged) {
    if (s > at) out.push({ text: text.slice(at, s), marked: false });
    out.push({ text: text.slice(s, e), marked: true });
    at = e;
  }
  if (at < text.length || out.length === 0) out.push({ text: text.slice(at), marked: false });
  return out;
}

/** Every case-insensitive occurrence of `query` in `text`, as ranges. */
export function findRanges(text: string, query: string): [number, number][] {
  const q = query.toLowerCase();
  if (q.length === 0) return [];
  const hay = text.toLowerCase();
  const out: [number, number][] = [];
  let i = hay.indexOf(q);
  while (i !== -1) {
    out.push([i, i + q.length]);
    i = hay.indexOf(q, i + q.length);
  }
  return out;
}

/**
 * Ranges of every term in `text` when ALL of them occur in it, else none —
 * the server's rule that a chat matches only when every term is present.
 */
function termRanges(text: string, terms: readonly string[]): [number, number][] {
  const flat = text.toLowerCase();
  if (!terms.every((t) => flat.includes(t))) return [];
  return terms.flatMap((t) => findRanges(text, t));
}

function sectionOf(row: ChatRow): ChatSearchSection {
  if (row.chatId === SPECIAL_THREAD_IDS.manager) return 'manager';
  if (row.chatId === SPECIAL_THREAD_IDS.speakers) {
    return 'channels';
  }
  if (row.status === 'archived') return 'archived';
  if (isHidden(row)) return 'hidden';
  if (isSnoozed(row)) return 'snoozed';
  if (row.pinned) return 'pinned';
  return 'folders';
}

/**
 * The instant stand-in shown while the server has not answered the current
 * query: the chats this surface already holds whose name or preview contains
 * every term of the query (case-insensitive; a "quoted run" is one exact
 * phrase), shaped as hits so one row renders both. With `fullText` false only
 * the name counts. Only what is loaded — the server's answer replaces it
 * wholesale.
 */
export function localSearchHits(
  rows: readonly ChatRow[],
  query: string,
  fullText = true,
): ChatSearchHit[] {
  const terms = parseSearchQuery(query);
  if (terms.length === 0) return [];
  const out: ChatSearchHit[] = [];
  for (const row of rows) {
    if (row.status === 'deleted') continue;
    const nameHighlights = row.name === null ? [] : termRanges(row.name, terms);
    const previewHighlights =
      !fullText || row.preview === null ? [] : termRanges(row.preview, terms);
    if (nameHighlights.length === 0 && previewHighlights.length === 0) continue;
    out.push({
      chatId: row.chatId,
      daemonId: row.daemonId,
      name: row.name,
      preview: row.preview,
      folder: row.folder,
      status: row.status,
      section: sectionOf(row),
      pinned: row.pinned,
      snoozedUntil: row.snoozedUntil,
      lastUpdated: row.lastUpdated,
      jobId: row.jobId,
      nameMatch: nameHighlights.length > 0,
      nameHighlights,
      messageMatches: 0,
      snippet:
        previewHighlights.length > 0 && row.preview !== null
          ? {
              text: row.preview,
              highlights: previewHighlights,
              role: 'user',
              seq: null,
              createdAt: null,
            }
          : null,
    });
  }
  // The server's ordering: most recently active first.
  return out.sort((a, b) => b.lastUpdated - a.lastUpdated);
}

function basename(folder: string): string {
  const segs = folder.split('/').filter(Boolean);
  return segs.length > 0 ? segs[segs.length - 1]! : folder;
}

/** Where the hit lives in the chat list, as the meta line names it. */
export function sectionLabel(hit: Pick<ChatSearchHit, 'section' | 'folder'>): string {
  switch (hit.section) {
    case 'manager':
      return 'Manager';
    case 'channels':
      return 'Channels';
    case 'pinned':
      return 'Pinned';
    case 'snoozed':
      return 'Snoozed';
    case 'hidden':
      return 'Hidden';
    case 'archived':
      return 'Archived';
    case 'folders':
      return basename(hit.folder);
  }
}

/** The route a hit opens: the chat, scrolled to the matched message if known. */
export function searchHitPath(hit: Pick<ChatSearchHit, 'chatId' | 'snippet'>): string {
  const seq = hit.snippet?.seq;
  return typeof seq === 'number' ? `/chats/${hit.chatId}?seq=${seq}` : `/chats/${hit.chatId}`;
}

/**
 * The line naming a host whose chats are NOT in the results, or null for one
 * that was searched. Every unsearched host is named — a missing machine must
 * never read as "nothing there".
 */
export function hostMarkerText(host: ChatSearchHostResult, name: string): string | null {
  switch (host.state) {
    case 'searched':
      return null;
    case 'offline':
      return `${name} offline — not searched`;
    case 'timeout':
      return `${name} didn't answer — not searched`;
    case 'error':
      return host.message !== undefined && host.message !== ''
        ? `${name}: ${host.message}`
        : `${name}: search failed`;
  }
}
