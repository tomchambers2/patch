// Global chat search in the sidebar (spec/03 § Chat search, spec/14 § Sidebar).
//
// One field in the sidebar's fixed top band searches every chat on every host —
// names and everything that was said — through `GET /api/chats/search`. While
// the trimmed query is long enough to send, the scrolling band shows the results
// in place of the chat list. The request is debounced, and only the latest
// query's answer may render: an earlier one landing late is dropped. Until the
// server answers, the chats this surface already holds are filtered locally so
// the band is never blank; the server's answer then replaces that wholesale.
// A host that could not be searched is always named under the results.

import type { JSX } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ChatSearchHit, ChatSearchHostResult } from '@patch/wire';
import { api } from '../api/rest.js';
import { useChatStore } from '../stores/chatStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useUiStore } from '../stores/uiStore.js';
import {
  highlightSegments,
  hostMarkerText,
  localSearchHits,
  searchHitPath,
  sectionLabel,
} from '../lib/chatSearch.js';
import { relativeTime } from '../lib/relativeTime.js';

/** How long typing has to pause before the query is sent. */
export const SEARCH_DEBOUNCE_MS = 250;
/** Results per page. */
const PAGE = 20;

/**
 * The sidebar's search field. The query lives in `uiStore.searchQuery` —
 * pressing a result clears it (`SearchHitRow`'s `onClick`), so opening a chat
 * from search always lands back on the ordinary list rather than leaving the
 * sidebar stuck on a stale query. Carries `data-search-input`, so ⌘K lands
 * here (lib/searchTarget.ts); and `data-search-global`, so ⌘F does not — over
 * a transcript that chord is the browser's find bar (spec/14 § Reserved OS
 * chords).
 */
export function ChatSearchField(): JSX.Element {
  const query = useUiStore((s) => s.searchQuery);
  const setQuery = useUiStore((s) => s.setSearchQuery);
  return (
    <div className="chat-search-wrap">
      <input
        type="search"
        className="chat-search"
        data-testid="chat-search"
        data-search-input
        data-search-global
        placeholder="Search chats…"
        aria-label="Search chats"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && query !== '') {
            e.preventDefault();
            e.stopPropagation();
            setQuery('');
          }
        }}
      />
      <button
        type="button"
        className="chat-search-clear"
        data-testid="chat-search-clear"
        aria-label="Clear search"
        onClick={() => setQuery('')}
      >
        ×
      </button>
    </div>
  );
}

interface Loaded {
  query: string;
  fullText: boolean;
  hits: ChatSearchHit[];
  hosts: ChatSearchHostResult[];
  nextOffset: number | null;
}

interface Failure {
  query: string;
  message: string;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Append a page, dropping any chat already listed (a chat whose rank moved). */
function appendHits(prev: ChatSearchHit[], next: ChatSearchHit[]): ChatSearchHit[] {
  const seen = new Set(prev.map((h) => h.chatId));
  return [...prev, ...next.filter((h) => !seen.has(h.chatId))];
}

/**
 * The results band. `query` is already trimmed and at least
 * `CHAT_SEARCH_MIN_QUERY` long — the caller decides when search is on.
 */
export function ChatSearchResults({
  query,
  activeChatId,
}: {
  query: string;
  activeChatId: string | null;
}): JSX.Element {
  const fullText = useUiStore((s) => s.searchFullText);
  const setFullText = useUiStore((s) => s.setSearchFullText);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  // The query a "More results" fetch is running for — keyed by query so a new
  // query never inherits a busy button.
  const [moreFor, setMoreFor] = useState<string | null>(null);
  // Bumped for every query; a response only lands if it still matches.
  const genRef = useRef(0);

  useEffect(() => {
    const gen = ++genRef.current;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      setFailure(null);
      api.searchChats(query, { limit: PAGE, fullText, signal: ctrl.signal }).then(
        (r) => {
          if (genRef.current !== gen) return;
          setLoaded({ query, fullText, hits: r.hits, hosts: r.hosts, nextOffset: r.nextOffset });
        },
        (e: unknown) => {
          if (genRef.current !== gen) return;
          setFailure({ query, message: messageOf(e) });
        },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [query, fullText]);

  // A result set is for one query AND one scope; flipping the box orphans it.
  const settled =
    loaded !== null && loaded.query === query && loaded.fullText === fullText ? loaded : null;
  const failed = failure !== null && failure.query === query ? failure : null;

  function loadMore(): void {
    if (settled === null || settled.nextOffset === null) return;
    const gen = genRef.current;
    const q = settled.query;
    setMoreFor(q);
    api.searchChats(q, { limit: PAGE, offset: settled.nextOffset, fullText }).then(
      (r) => {
        if (genRef.current !== gen) return;
        setLoaded((prev) =>
          prev !== null && prev.query === q
            ? {
                query: q,
                fullText,
                hits: appendHits(prev.hits, r.hits),
                hosts: r.hosts,
                nextOffset: r.nextOffset,
              }
            : prev,
        );
        setMoreFor(null);
      },
      (e: unknown) => {
        if (genRef.current !== gen) return;
        setFailure({ query: q, message: messageOf(e) });
        setMoreFor(null);
      },
    );
  }

  const chats = useChatStore((s) => s.chats);
  const waiting = settled === null && failed === null;
  const local = useMemo(
    () => (waiting ? localSearchHits(Object.values(chats), query, fullText) : []),
    [waiting, chats, query, fullText],
  );

  // A host is named by what the surface already calls it (its self-reported
  // hostName, the same label the chat header and banners use), then by the
  // name the server returned, then by its id.
  const presence = usePresenceStore((s) => s.hosts);
  const serverNames = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const h of settled?.hosts ?? []) m.set(h.daemonId, h.hostName);
    return m;
  }, [settled]);
  const hostName = (daemonId: string): string =>
    presence[daemonId]?.host?.hostName ?? serverNames.get(daemonId) ?? daemonId;

  const errorRow =
    failed === null ? null : (
      <div className="empty-hint" data-testid="chat-search-error">
        Search failed: {failed.message}
      </div>
    );

  return (
    <section className="sb-search-results" data-testid="chat-search-results">
      <label className="sb-search-scope">
        <input
          type="checkbox"
          data-testid="chat-search-fulltext"
          checked={fullText}
          onChange={(e) => setFullText(e.target.checked)}
        />
        Full text
      </label>
      {waiting ? (
        <>
          <div className="sb-search-status" data-testid="chat-search-searching">
            Searching…
          </div>
          {local.map((hit) => (
            <SearchHitRow
              key={hit.chatId}
              hit={hit}
              hostName={hostName(hit.daemonId)}
              active={activeChatId}
              testId="chat-search-local-hit"
            />
          ))}
        </>
      ) : null}
      {settled === null ? errorRow : null}
      {settled !== null ? (
        <>
          {settled.hits.length === 0 ? (
            <div className="empty-hint" data-testid="chat-search-empty">
              No chats match “{query}”.
            </div>
          ) : (
            settled.hits.map((hit) => (
              <SearchHitRow
                key={hit.chatId}
                hit={hit}
                hostName={hostName(hit.daemonId)}
                active={activeChatId}
                testId="chat-search-hit"
              />
            ))
          )}
          {settled.nextOffset !== null ? (
            <button
              type="button"
              className="sb-search-more"
              data-testid="chat-search-more"
              disabled={moreFor === query}
              onClick={loadMore}
            >
              More results
            </button>
          ) : null}
          {errorRow}
          {settled.hosts.map((h) => {
            const text = hostMarkerText(h, hostName(h.daemonId));
            return text === null ? null : (
              <div
                key={h.daemonId}
                className="empty-hint sb-search-host"
                data-testid={`chat-search-host-${h.daemonId}`}
                data-state={h.state}
              >
                {text}
              </div>
            );
          })}
        </>
      ) : null}
    </section>
  );
}

function Marked({
  text,
  ranges,
}: {
  text: string;
  ranges: readonly (readonly [number, number])[];
}): JSX.Element {
  return (
    <>
      {highlightSegments(text, ranges).map((seg, i) =>
        seg.marked ? <mark key={i}>{seg.text}</mark> : <span key={i}>{seg.text}</span>,
      )}
    </>
  );
}

function SearchHitRow({
  hit,
  hostName,
  active,
  testId,
}: {
  hit: ChatSearchHit;
  hostName: string;
  active: string | null;
  testId: string;
}): JSX.Element {
  const title = hit.name ?? hit.preview ?? 'New chat';
  const when = hit.snippet?.createdAt ?? hit.lastUpdated;
  const meta = [
    hostName,
    sectionLabel(hit),
    hit.jobId !== null ? 'Automation' : null,
    relativeTime(when, { futureLabel: 'just now' }),
  ]
    .filter((p): p is string => p !== null && p !== '')
    .join(' · ');
  return (
    <Link
      to={searchHitPath(hit)}
      className={`sb-row search-hit${active === hit.chatId ? ' active' : ''}`}
      data-testid={testId}
      data-chat-id={hit.chatId}
      title={title}
      // Pressing a result opens the chat AND clears the search — leaving the
      // sidebar stuck on a stale query and results band after you've already
      // gone where you were looking for is the bug this fixes.
      onClick={() => useUiStore.getState().setSearchQuery('')}
    >
      <span className="name">
        {hit.name !== null ? <Marked text={hit.name} ranges={hit.nameHighlights} /> : title}
      </span>
      {hit.snippet !== null ? (
        <span className="search-snippet" data-testid="chat-search-snippet">
          {hit.snippet.role === 'user' ? <span className="search-role">You: </span> : null}
          <Marked text={hit.snippet.text} ranges={hit.snippet.highlights} />
        </span>
      ) : null}
      <span className="search-meta">
        {meta}
        {hit.messageMatches > 1 ? (
          <span className="search-more-count"> · +{hit.messageMatches - 1} more</span>
        ) : null}
      </span>
    </Link>
  );
}
