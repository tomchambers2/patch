// src/lib/chatSearch.ts — the pure half of the Chats-tab search (spec/03 §
// Chat search): highlight segmentation over wire ranges, the local stand-in,
// the meta/host copy, the hit route, and the debounce + stale-answer
// controller (driven with fake timers and hand-settled promises).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ChatSearchHit, ChatSearchResponse } from '@patch/wire';
import {
  ChatSearchController,
  findRanges,
  highlightSegments,
  hitMetaLine,
  hostMarkerText,
  localSearchHits,
  relativeAge,
  searchHitRoute,
  searchableQuery,
  sectionLabel,
  sectionOf,
  type ChatSearchFn,
  type ChatSearchState,
} from '../src/lib/chatSearch';
import { useChatStore } from '../src/stores/chatStore';
import type { ChatRow } from '../src/stores/types';

function hit(overrides: Partial<ChatSearchHit> & { chatId: string }): ChatSearchHit {
  return {
    daemonId: 'd1',
    name: null,
    preview: null,
    folder: '/w',
    status: 'active',
    section: 'folders',
    pinned: false,
    snoozedUntil: null,
    lastUpdated: 0,
    jobId: null,
    nameMatch: false,
    nameHighlights: [],
    messageMatches: 0,
    snippet: null,
    ...overrides,
  };
}

/** A full store row (the store's own defaults) with the fields a test names. */
function chat(overrides: Partial<ChatRow> & { chatId: string }): ChatRow {
  useChatStore.getState()._reset();
  useChatStore.getState().ensureChat(overrides.chatId, '/w');
  return { ...useChatStore.getState().chats[overrides.chatId]!, ...overrides };
}

describe('searchableQuery', () => {
  it('trims, and refuses anything under the minimum length', () => {
    expect(searchableQuery('  ab  ')).toBe('ab');
    expect(searchableQuery(' a ')).toBeNull();
    expect(searchableQuery('')).toBeNull();
  });
});

describe('highlightSegments', () => {
  it('splits text into plain and marked runs', () => {
    expect(highlightSegments('hello world', [[6, 11]])).toEqual([
      { text: 'hello ', marked: false },
      { text: 'world', marked: true },
    ]);
  });

  it('clamps out-of-range ends, drops empty/inverted ranges, and merges overlaps', () => {
    expect(
      highlightSegments('abcdef', [
        [4, 99],
        [-3, 1],
        [3, 3],
        [5, 2],
        [0, 2],
        [1.7, 2.2],
      ]),
    ).toEqual([
      { text: 'ab', marked: true },
      { text: 'cd', marked: false },
      { text: 'ef', marked: true },
    ]);
  });

  it('merges touching ranges into one mark', () => {
    expect(
      highlightSegments('abcd', [
        [2, 4],
        [0, 2],
      ]),
    ).toEqual([{ text: 'abcd', marked: true }]);
  });

  it('returns the whole text unmarked with no ranges, and one empty run for empty text', () => {
    expect(highlightSegments('abc', [])).toEqual([{ text: 'abc', marked: false }]);
    expect(highlightSegments('', [[0, 3]])).toEqual([{ text: '', marked: false }]);
  });
});

describe('findRanges', () => {
  it('finds every case-insensitive occurrence, non-overlapping', () => {
    expect(findRanges('Pan pan PAN', 'pan')).toEqual([
      [0, 3],
      [4, 7],
      [8, 11],
    ]);
    expect(findRanges('aaa', 'aa')).toEqual([[0, 2]]);
    expect(findRanges('abc', '')).toEqual([]);
  });
});

describe('sectionOf / sectionLabel', () => {
  it('places a row in the section the list draws it under', () => {
    const now = 1000;
    expect(sectionOf(chat({ chatId: 'thread_manager' }), now)).toBe('manager');
    expect(sectionOf(chat({ chatId: 'thread_speakers' }), now)).toBe('channels');
    expect(sectionOf(chat({ chatId: 'a', status: 'archived', pinned: true }), now)).toBe(
      'archived',
    );
    expect(sectionOf(chat({ chatId: 's', snoozedUntil: 2000, pinned: true }), now)).toBe('snoozed');
    // Hidden outranks snooze and pin (spec/04 § Hidden), but an archived chat
    // that keeps the flag is archived.
    expect(
      sectionOf(chat({ chatId: 'h', hidden: true, pinned: true, snoozedUntil: 2000 }), now),
    ).toBe('hidden');
    expect(sectionOf(chat({ chatId: 'ha', hidden: true, status: 'archived' }), now)).toBe(
      'archived',
    );
    expect(sectionOf(chat({ chatId: 'p', pinned: true, snoozedUntil: 500 }), now)).toBe('pinned');
    expect(sectionOf(chat({ chatId: 'f' }), now)).toBe('folders');
    expect(sectionOf(chat({ chatId: 'f' }))).toBe('folders');
  });

  it('labels each section, a folder by its basename', () => {
    expect(sectionLabel({ section: 'manager', folder: '' })).toBe('Manager');
    expect(sectionLabel({ section: 'channels', folder: '' })).toBe('Channels');
    expect(sectionLabel({ section: 'pinned', folder: '' })).toBe('Pinned');
    expect(sectionLabel({ section: 'snoozed', folder: '' })).toBe('Snoozed');
    expect(sectionLabel({ section: 'hidden', folder: '' })).toBe('Hidden');
    expect(sectionLabel({ section: 'archived', folder: '' })).toBe('Archived');
    expect(sectionLabel({ section: 'folders', folder: '/home/tom/proj/' })).toBe('proj');
    expect(sectionLabel({ section: 'folders', folder: '/' })).toBe('/');
  });
});

describe('localSearchHits', () => {
  it('shapes local name/preview matches as hits, name matches first then newest', () => {
    const rows = [
      chat({ chatId: 'a', name: 'Other', preview: 'about pancakes', lastUpdated: 9 }),
      chat({ chatId: 'b', name: 'Pancakes', lastUpdated: 1 }),
      chat({ chatId: 'c', name: 'Pancakes too', lastUpdated: 5 }),
      chat({ chatId: 'd', name: 'pancakes gone', status: 'deleted' }),
      chat({ chatId: 'e', name: 'nothing', preview: null }),
      chat({ chatId: 'f', name: null, preview: 'old pancakes', lastUpdated: 2 }),
    ];
    const out = localSearchHits(rows, ' pancakes ');
    expect(out.map((h) => h.chatId)).toEqual(['c', 'b', 'a', 'f']);
    expect(out[0]!.nameHighlights).toEqual([[0, 8]]);
    expect(out[2]!.nameMatch).toBe(false);
    expect(out[2]!.snippet).toEqual({
      text: 'about pancakes',
      highlights: [[6, 14]],
      role: 'user',
      seq: null,
      createdAt: null,
    });
    expect(out[0]!.snippet).toBeNull();
    expect(out[0]!.jobId).toBeNull();
  });

  it('returns nothing for an empty query', () => {
    expect(localSearchHits([chat({ chatId: 'a', name: 'x' })], '  ')).toEqual([]);
  });
});

describe('relativeAge / hitMetaLine', () => {
  const now = 1_000 * 86_400_000;
  it('steps through minutes, hours, days, weeks, months and years', () => {
    expect(relativeAge(now - 5_000, now)).toBe('just now');
    expect(relativeAge(now + 5_000, now)).toBe('just now');
    expect(relativeAge(now - 5 * 60_000, now)).toBe('5m ago');
    expect(relativeAge(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(relativeAge(now - 2 * 86_400_000, now)).toBe('2d ago');
    expect(relativeAge(now - 14 * 86_400_000, now)).toBe('2w ago');
    expect(relativeAge(now - 90 * 86_400_000, now)).toBe('3mo ago');
    expect(relativeAge(now - 800 * 86_400_000, now)).toBe('2y ago');
    expect(relativeAge(Date.now())).toBe('just now');
  });

  it('joins host, section, Automation and the age of the matched message', () => {
    const snippet = {
      text: 't',
      highlights: [],
      role: 'assistant' as const,
      seq: 1,
      createdAt: now - 3_600_000,
    };
    expect(
      hitMetaLine(hit({ chatId: 'a', jobId: 'j', snippet, lastUpdated: now }), 'Mac', now),
    ).toBe('Mac · w · Automation · 1h ago');
    expect(hitMetaLine(hit({ chatId: 'a', lastUpdated: now - 60_000 }), 'Mac', now)).toBe(
      'Mac · w · 1m ago',
    );
    expect(hitMetaLine(hit({ chatId: 'a', lastUpdated: now }), '', now)).toBe('w · just now');
  });
});

describe('searchHitRoute', () => {
  it('carries the matched seq when the host numbered it', () => {
    const snippet = { text: 't', highlights: [], role: 'user' as const, seq: 0, createdAt: null };
    expect(searchHitRoute({ chatId: 'c', snippet })).toEqual({
      pathname: '/chats/[chatId]',
      params: { chatId: 'c', seq: '0' },
    });
    expect(searchHitRoute({ chatId: 'c', snippet: { ...snippet, seq: null } })).toEqual({
      pathname: '/chats/[chatId]',
      params: { chatId: 'c' },
    });
    expect(searchHitRoute({ chatId: 'c', snippet: null }).params).toEqual({ chatId: 'c' });
  });
});

describe('hostMarkerText', () => {
  it('names every unsearched host, and nothing for a searched one', () => {
    const base = { daemonId: 'd', hostName: null };
    expect(hostMarkerText({ ...base, state: 'searched' }, 'Mac')).toBeNull();
    expect(hostMarkerText({ ...base, state: 'offline' }, 'Mac')).toBe('Mac offline — not searched');
    expect(hostMarkerText({ ...base, state: 'timeout' }, 'Mac')).toBe(
      "Mac didn't answer — not searched",
    );
    expect(hostMarkerText({ ...base, state: 'error', message: 'boom' }, 'Mac')).toBe('Mac: boom');
    expect(hostMarkerText({ ...base, state: 'error', message: '' }, 'Mac')).toBe(
      'Mac: search failed',
    );
    expect(hostMarkerText({ ...base, state: 'error' }, 'Mac')).toBe('Mac: search failed');
  });
});

// ── Controller ──────────────────────────────────────────────────────────────

function answer(hits: ChatSearchHit[], nextOffset: number | null = null): ChatSearchResponse {
  return { query: 'q', hits, total: hits.length, nextOffset, hosts: [] };
}

describe('ChatSearchController', () => {
  let states: ChatSearchState[];
  let search: ReturnType<typeof vi.fn> & ChatSearchFn;
  let ctrl: ChatSearchController;
  const last = (): ChatSearchState => states[states.length - 1]!;
  const flushPromises = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };

  beforeEach(() => {
    vi.useFakeTimers();
    states = [];
    search = vi.fn() as typeof search;
    ctrl = new ChatSearchController(search, (s) => states.push(s), 300);
  });
  afterEach(() => {
    ctrl.dispose();
    vi.useRealTimers();
  });

  it('goes idle for a short query and never calls the server', async () => {
    ctrl.setQuery('a');
    vi.advanceTimersByTime(1000);
    await flushPromises();
    expect(search).not.toHaveBeenCalled();
    expect(ctrl.getState().status).toBe('idle');
  });

  it('waits out the debounce, then loads the answer', async () => {
    search.mockResolvedValue(answer([hit({ chatId: 'a' })], 20));
    ctrl.setQuery('pan');
    expect(last()).toMatchObject({ query: 'pan', status: 'waiting' });
    vi.advanceTimersByTime(299);
    expect(search).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await flushPromises();
    expect(search).toHaveBeenCalledWith('pan', expect.objectContaining({ limit: 20 }));
    expect(last()).toMatchObject({ status: 'loaded', nextOffset: 20 });
    expect(last().hits.map((h) => h.chatId)).toEqual(['a']);
  });

  it('ignores the same query again (a whitespace-only change)', () => {
    ctrl.setQuery('pan');
    const n = states.length;
    ctrl.setQuery(' pan ');
    expect(states.length).toBe(n);
  });

  it('drops a stale answer and aborts its request', async () => {
    let resolveFirst!: (r: ChatSearchResponse) => void;
    search
      .mockReturnValueOnce(new Promise((r) => (resolveFirst = r)))
      .mockResolvedValueOnce(answer([hit({ chatId: 'new' })]));
    ctrl.setQuery('pan');
    vi.advanceTimersByTime(300);
    ctrl.setQuery('pancake');
    expect((search.mock.calls[0]![1] as { signal: AbortSignal }).signal.aborted).toBe(true);
    vi.advanceTimersByTime(300);
    await flushPromises();
    resolveFirst(answer([hit({ chatId: 'old' })]));
    await flushPromises();
    expect(last().query).toBe('pancake');
    expect(last().hits.map((h) => h.chatId)).toEqual(['new']);
  });

  it('drops a stale failure too', async () => {
    let rejectFirst!: (e: unknown) => void;
    search.mockReturnValueOnce(new Promise((_r, j) => (rejectFirst = j)));
    ctrl.setQuery('pan');
    vi.advanceTimersByTime(300);
    ctrl.setQuery('x');
    rejectFirst(new Error('late'));
    await flushPromises();
    expect(last().status).toBe('idle');
  });

  it('reports a failure, including a synchronous throw and a non-Error', async () => {
    search.mockImplementationOnce(() => {
      throw new Error('sync boom');
    });
    ctrl.setQuery('pan');
    vi.advanceTimersByTime(300);
    await flushPromises();
    expect(last()).toMatchObject({ status: 'failed', error: 'sync boom' });
    search.mockRejectedValueOnce('plain');
    ctrl.setQuery('pane');
    vi.advanceTimersByTime(300);
    await flushPromises();
    expect(last()).toMatchObject({ status: 'failed', error: 'plain' });
  });

  it('pages: appends new chats only, and keeps hits when a page fails', async () => {
    search
      .mockResolvedValueOnce(answer([hit({ chatId: 'a' })], 1))
      .mockResolvedValueOnce(answer([hit({ chatId: 'a' }), hit({ chatId: 'b' })], 2))
      .mockRejectedValueOnce(new Error('page failed'))
      .mockResolvedValueOnce(answer([hit({ chatId: 'c' })], null));
    ctrl.setQuery('pan');
    vi.advanceTimersByTime(300);
    await flushPromises();
    ctrl.loadMore();
    expect(last().loadingMore).toBe(true);
    ctrl.loadMore(); // already loading: no second request
    await flushPromises();
    expect(search).toHaveBeenCalledTimes(2);
    expect(search.mock.calls[1]![1]).toMatchObject({ offset: 1 });
    expect(last().hits.map((h) => h.chatId)).toEqual(['a', 'b']);
    ctrl.loadMore();
    await flushPromises();
    expect(last()).toMatchObject({ status: 'loaded', error: 'page failed', loadingMore: false });
    expect(last().hits).toHaveLength(2);
    ctrl.loadMore();
    await flushPromises();
    expect(last()).toMatchObject({ error: null, nextOffset: null });
    expect(last().hits.map((h) => h.chatId)).toEqual(['a', 'b', 'c']);
    ctrl.loadMore(); // no next page: nothing
    expect(search).toHaveBeenCalledTimes(4);
  });

  it('drops a page that lands after the query changed', async () => {
    let resolvePage!: (r: ChatSearchResponse) => void;
    let rejectPage!: (e: unknown) => void;
    search
      .mockResolvedValueOnce(answer([hit({ chatId: 'a' })], 1))
      .mockReturnValueOnce(new Promise((r) => (resolvePage = r)))
      .mockResolvedValueOnce(answer([hit({ chatId: 'z' })], 1))
      .mockReturnValueOnce(new Promise((_r, j) => (rejectPage = j)));
    ctrl.setQuery('pan');
    vi.advanceTimersByTime(300);
    await flushPromises();
    ctrl.loadMore();
    ctrl.setQuery('zed');
    resolvePage(answer([hit({ chatId: 'b' })]));
    await flushPromises();
    expect(last()).toMatchObject({ query: 'zed', status: 'waiting', hits: [] });
    vi.advanceTimersByTime(300);
    await flushPromises();
    ctrl.loadMore();
    ctrl.setQuery('');
    rejectPage(new Error('late'));
    await flushPromises();
    expect(last().status).toBe('idle');
  });

  it('loadMore does nothing before an answer', () => {
    ctrl.loadMore();
    ctrl.setQuery('pan');
    ctrl.loadMore();
    expect(search).not.toHaveBeenCalled();
  });

  it('dispose cancels the pending request and forgets the query', async () => {
    ctrl.setQuery('pan');
    ctrl.dispose();
    vi.advanceTimersByTime(1000);
    await flushPromises();
    expect(search).not.toHaveBeenCalled();
    expect(ctrl.getState().status).toBe('idle');
    search.mockResolvedValue(answer([]));
    ctrl.setQuery('pan');
    vi.advanceTimersByTime(300);
    await flushPromises();
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('defaults to a 300ms debounce', () => {
    const c = new ChatSearchController(search, () => {});
    c.setQuery('pan');
    vi.advanceTimersByTime(299);
    expect(search).not.toHaveBeenCalled();
    search.mockResolvedValue(answer([]));
    vi.advanceTimersByTime(1);
    expect(search).toHaveBeenCalledTimes(1);
    c.dispose();
  });
});
