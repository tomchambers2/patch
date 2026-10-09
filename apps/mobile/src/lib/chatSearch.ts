// Chats-tab search (spec/03 § Chat search) — the pure half of the header
// search: highlight segmentation, the instant local stand-in shown while the
// server is answering, the copy for a hit's meta line and for a host that was
// not searched, and the controller that debounces the request and drops any
// answer that is not for the latest query. The screen (app/(tabs)/chats.tsx)
// only renders what `useChatSearch` hands it.

import React from 'react';
import {
  CHAT_SEARCH_MIN_QUERY,
  SPECIAL_THREAD_IDS,
  type ChatSearchHit,
  type ChatSearchHostResult,
  type ChatSearchResponse,
  type ChatSearchSection,
} from '@patch/wire';
import type { ChatRow } from '../stores/types';
import { isHidden, isSnoozed } from '../stores/types';
import { filterChats } from './chatFilter';
import { api } from '../api/rest';

/** How long typing has to pause before the query is sent. */
export const CHAT_SEARCH_DEBOUNCE_MS = 300;
/** Results per page. */
export const CHAT_SEARCH_PAGE = 20;

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
 * merged — a row never draws a mark inside a mark, or throws.
 */
export function highlightSegments(
  text: string,
  ranges: readonly (readonly [number, number])[],
): HighlightSegment[] {
  const clamp = (n: number): number => Math.max(0, Math.min(text.length, Math.floor(n)));
  const clamped = ranges
    .map(([s, e]): [number, number] => [clamp(s), clamp(e)])
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

/** The section a row is drawn under in the normal list. */
export function sectionOf(row: ChatRow, now: number = Date.now()): ChatSearchSection {
  if (row.chatId === SPECIAL_THREAD_IDS.manager) return 'manager';
  if (row.chatId === SPECIAL_THREAD_IDS.speakers) {
    return 'channels';
  }
  if (row.status === 'archived') return 'archived';
  if (isHidden(row)) return 'hidden';
  if (isSnoozed(row, now)) return 'snoozed';
  if (row.pinned) return 'pinned';
  return 'folders';
}

/**
 * The instant stand-in shown until the server answers the current query: the
 * chats this phone already holds that `filterChats` matches (name or preview,
 * case-insensitive), shaped as hits so one row component draws both lists and
 * nothing changes shape when the answer lands. The server's answer replaces
 * this wholesale — it is only what is loaded.
 */
export function localSearchHits(rows: readonly ChatRow[], query: string): ChatSearchHit[] {
  const q = query.trim();
  if (q === '') return [];
  const out: ChatSearchHit[] = filterChats(
    rows.filter((r) => r.status !== 'deleted'),
    q,
  ).map((row) => {
    const nameHighlights = row.name === null ? [] : findRanges(row.name, q);
    const previewHighlights = row.preview === null ? [] : findRanges(row.preview, q);
    return {
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
      jobId: null,
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
    };
  });
  // The server's ranking: name matches first, then the most recent.
  return out.sort((a, b) =>
    a.nameMatch !== b.nameMatch ? (a.nameMatch ? -1 : 1) : b.lastUpdated - a.lastUpdated,
  );
}

function basename(folder: string): string {
  const segs = folder.split('/').filter(Boolean);
  return segs.length > 0 ? segs[segs.length - 1]! : folder;
}

/** Where the hit lives in the chat list, as its meta line names it. */
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

/** `5m ago`, `3d ago`… — the one relative format a hit's meta line uses. */
export function relativeAge(ms: number, now: number = Date.now()): string {
  const delta = now - ms;
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)}d ago`;
  if (delta < 30 * 86_400_000) return `${Math.floor(delta / (7 * 86_400_000))}w ago`;
  if (delta < 365 * 86_400_000) return `${Math.floor(delta / (30 * 86_400_000))}mo ago`;
  return `${Math.floor(delta / (365 * 86_400_000))}y ago`;
}

/** The meta line: host · section · Automation (job-made chats) · age. */
export function hitMetaLine(hit: ChatSearchHit, hostName: string, now?: number): string {
  const when = hit.snippet?.createdAt ?? hit.lastUpdated;
  return [
    hostName,
    sectionLabel(hit),
    hit.jobId !== null ? 'Automation' : null,
    relativeAge(when, now),
  ]
    .filter((p): p is string => p !== null && p !== '')
    .join(' · ');
}

/**
 * The route a hit opens: the chat, with the matched message's seq so the chat
 * opens scrolled to it. No seq (a name-only match, or a message the host never
 * numbered) opens the chat where it normally opens.
 */
export function searchHitRoute(hit: Pick<ChatSearchHit, 'chatId' | 'snippet'>): {
  pathname: '/chats/[chatId]';
  params: { chatId: string; seq?: string };
} {
  const seq = hit.snippet?.seq;
  return {
    pathname: '/chats/[chatId]',
    params:
      typeof seq === 'number' ? { chatId: hit.chatId, seq: String(seq) } : { chatId: hit.chatId },
  };
}

/**
 * The line naming a host whose chats are NOT in the results, or null for one
 * that was searched. Every unsearched host is named — a machine that could not
 * be searched must never read as "nothing there".
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

// ── Controller ──────────────────────────────────────────────────────────────

export interface ChatSearchState {
  /** The searchable query this state describes; null = search is off. */
  query: string | null;
  /**
   * - `idle` — no searchable query.
   * - `waiting` — the current query has not been answered yet.
   * - `loaded` — the server answered the current query.
   * - `failed` — the first page of the current query failed (`error` says why).
   */
  status: 'idle' | 'waiting' | 'loaded' | 'failed';
  hits: ChatSearchHit[];
  hosts: ChatSearchHostResult[];
  nextOffset: number | null;
  /** The last failure for this query — the first page's, or a "More results" page's. */
  error: string | null;
  loadingMore: boolean;
}

export type ChatSearchFn = (
  q: string,
  opts: { limit: number; offset?: number; signal: AbortSignal },
) => Promise<ChatSearchResponse>;

const IDLE: ChatSearchState = {
  query: null,
  status: 'idle',
  hits: [],
  hosts: [],
  nextOffset: null,
  error: null,
  loadingMore: false,
};

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Append a page, dropping any chat already listed (a chat whose rank moved). */
function appendHits(prev: ChatSearchHit[], next: ChatSearchHit[]): ChatSearchHit[] {
  const seen = new Set(prev.map((h) => h.chatId));
  return [...prev, ...next.filter((h) => !seen.has(h.chatId))];
}

/**
 * Debounces the query, runs one request per settled query, and lets only the
 * LATEST query's answer through: every new query bumps a generation and aborts
 * the request in flight, and a response whose generation is stale is dropped
 * however late it lands. Framework-free so it is testable with fake timers.
 */
export class ChatSearchController {
  private state: ChatSearchState = IDLE;
  private gen = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight: AbortController | null = null;

  constructor(
    private readonly search: ChatSearchFn,
    private readonly onChange: (s: ChatSearchState) => void,
    private readonly debounceMs: number = CHAT_SEARCH_DEBOUNCE_MS,
  ) {}

  getState(): ChatSearchState {
    return this.state;
  }

  private set(next: ChatSearchState): void {
    this.state = next;
    this.onChange(next);
  }

  private cancel(): void {
    this.gen++;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.inflight?.abort();
    this.inflight = null;
  }

  /** The search, with a synchronous throw turned into a rejection — shown, not lost. */
  private run(q: string, opts: Parameters<ChatSearchFn>[1]): Promise<ChatSearchResponse> {
    return new Promise((resolve) => resolve(this.search(q, opts)));
  }

  /** Feed the raw field text on every keystroke. */
  setQuery(raw: string): void {
    const q = searchableQuery(raw);
    if (q === this.state.query) return;
    this.cancel();
    if (q === null) {
      this.set(IDLE);
      return;
    }
    const gen = this.gen;
    this.set({ ...IDLE, query: q, status: 'waiting' });
    this.timer = setTimeout(() => {
      this.timer = null;
      const ctrl = new AbortController();
      this.inflight = ctrl;
      this.run(q, { limit: CHAT_SEARCH_PAGE, signal: ctrl.signal }).then(
        (r) => {
          if (this.gen !== gen) return;
          this.inflight = null;
          this.set({
            ...IDLE,
            query: q,
            status: 'loaded',
            hits: r.hits,
            hosts: r.hosts,
            nextOffset: r.nextOffset,
          });
        },
        (e: unknown) => {
          if (this.gen !== gen) return;
          this.inflight = null;
          this.set({ ...IDLE, query: q, status: 'failed', error: messageOf(e) });
        },
      );
    }, this.debounceMs);
  }

  /** Fetch the next page of the current answer and append it. */
  loadMore(): void {
    const s = this.state;
    if (s.status !== 'loaded' || s.nextOffset === null || s.loadingMore || s.query === null) return;
    const gen = this.gen;
    const q = s.query;
    const ctrl = new AbortController();
    this.inflight = ctrl;
    this.set({ ...s, loadingMore: true, error: null });
    this.run(q, { limit: CHAT_SEARCH_PAGE, offset: s.nextOffset, signal: ctrl.signal }).then(
      (r) => {
        if (this.gen !== gen) return;
        this.inflight = null;
        const cur = this.state;
        this.set({
          ...cur,
          hits: appendHits(cur.hits, r.hits),
          hosts: r.hosts,
          nextOffset: r.nextOffset,
          loadingMore: false,
        });
      },
      (e: unknown) => {
        if (this.gen !== gen) return;
        this.inflight = null;
        this.set({ ...this.state, loadingMore: false, error: messageOf(e) });
      },
    );
  }

  /** Stop everything; nothing that lands afterwards is delivered. */
  dispose(): void {
    this.cancel();
    // Forget the query too, so feeding the same text again starts afresh.
    this.state = IDLE;
  }
}

const apiSearch: ChatSearchFn = (q, opts) => api.searchChats(q, opts);

/**
 * The screen's handle on a ChatSearchController: feeds it `rawQuery` on every
 * change and re-renders on every state it reports.
 */
export function useChatSearch(rawQuery: string): ChatSearchState & { loadMore: () => void } {
  const [state, setState] = React.useState<ChatSearchState>(IDLE);
  const ctrlRef = React.useRef<ChatSearchController | null>(null);
  if (ctrlRef.current === null) ctrlRef.current = new ChatSearchController(apiSearch, setState);
  const ctrl = ctrlRef.current;
  React.useEffect(() => {
    ctrl.setQuery(rawQuery);
  }, [ctrl, rawQuery]);
  React.useEffect(() => () => ctrl.dispose(), [ctrl]);
  const loadMore = React.useCallback(() => ctrl.loadMore(), [ctrl]);
  return { ...state, loadMore };
}
