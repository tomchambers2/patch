// Chats tab — search (spec/15 ## Chats tab § Search, spec/03 § Chat search).
// The header's search button opens a field. Pins:
//   - a query too short to send (one character) filters every section locally,
//     instantly, and sends nothing
//   - a longer one is sent to `GET /api/chats/search`, debounced; only the
//     latest query's answer renders — an earlier one landing late is dropped
//   - until the server answers, the loaded chats filtered locally stand in
//     under a "Searching…" line; the server's answer then IS the list
//   - a failure is a visible row; zero hits is the chat-search empty state
//   - every host that was not searched is named under the results
//   - "More results" fetches and appends the next page
//   - tapping a hit opens the chat with the matched message's seq
//   - clearing the text or closing the search restores the normal list
//   - opening search fetches the archived list so it can be matched locally

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ChatSearchHit, ChatSearchHostResult, ChatSearchResponse } from '@patch/wire';
import {
  renderRN,
  findHost,
  findAllHost,
  queryHost,
  byLabel,
  byType,
  byTestId,
  hasText,
  textOf,
  actSync,
  actAsync,
} from './testUtils/render';
import ChatsScreen from '../app/(tabs)/chats';
import { useChatStore } from '../src/stores/chatStore';
import { usePresenceStore } from '../src/stores/presenceStore';
import { useUiStore } from '../src/stores/uiStore';
import { __resetRouterMock, routerMock } from './stubs/expo-router';
import { __clearAllMmkv } from './stubs/mmkv';

vi.mock('../src/lib/voiceNote', () => ({
  startVoiceNote: vi.fn(),
  releaseVoiceNoteIfHeld: vi.fn(),
}));
const { listArchivedSpy, listHiddenSpy, searchSpy } = vi.hoisted(() => ({
  listArchivedSpy: vi.fn(),
  listHiddenSpy: vi.fn(),
  searchSpy: vi.fn(),
}));
vi.mock('../src/api/rest', () => ({
  api: {
    markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
    chatSectionCounts: vi
      .fn()
      .mockResolvedValue({ archived: 0, snoozed: 0, hidden: 0, deleted: 0, automations: 0 }),
    listArchivedChats: listArchivedSpy,
    listHiddenChats: listHiddenSpy,
    searchChats: searchSpy,
  },
}));

type HydrateRow = Parameters<ReturnType<typeof useChatStore.getState>['hydrate']>[0][number];

function row(overrides: Partial<HydrateRow> & { chatId: string }): HydrateRow {
  return {
    name: null,
    folder: '',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    lastUpdated: 0,
    snoozedUntil: null,
    ...overrides,
  };
}

function hit(overrides: Partial<ChatSearchHit> & { chatId: string }): ChatSearchHit {
  return {
    daemonId: 'd1',
    name: null,
    preview: null,
    folder: '/home/tom/work',
    status: 'active',
    section: 'folders',
    pinned: false,
    snoozedUntil: null,
    lastUpdated: Date.now(),
    jobId: null,
    nameMatch: false,
    nameHighlights: [],
    messageMatches: 0,
    snippet: null,
    ...overrides,
  };
}

const SEARCHED: ChatSearchHostResult = { daemonId: 'd1', hostName: 'box', state: 'searched' };

function answer(
  hits: ChatSearchHit[],
  opts: { hosts?: ChatSearchHostResult[]; nextOffset?: number | null } = {},
): ChatSearchResponse {
  return {
    query: 'q',
    hits,
    total: hits.length,
    nextOffset: opts.nextOffset ?? null,
    hosts: opts.hosts ?? [SEARCHED],
  };
}

/** A promise the test settles by hand — for answers that land out of order. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const IN_AN_HOUR = Date.now() + 60 * 60_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  __clearAllMmkv();
  listArchivedSpy.mockReset().mockResolvedValue({ chats: [] });
  listHiddenSpy.mockReset().mockResolvedValue({ chats: [] });
  searchSpy.mockReset().mockResolvedValue(answer([]));
  useChatStore.getState()._reset();
  usePresenceStore.setState({
    connection: 'connected',
    daemon: 'online',
    accountId: null,
    surfaceId: null,
    hosts: {},
  });
  useUiStore.setState({ errors: [] });
  __resetRouterMock();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Every section, each with one chat named "<section> pancakes" and one other. */
function hydrateEverySection(): void {
  useChatStore
    .getState()
    .hydrate([
      row({ chatId: 'thread_manager', name: 'Manager pancakes' }),
      row({ chatId: 'thread_speakers', name: 'Speakers pancakes' }),
      row({ chatId: 'p1', name: 'Pinned pancakes', pinned: true, pinnedAt: 1 }),
      row({ chatId: 'p2', name: 'Pinned other', pinned: true, pinnedAt: 2 }),
      row({ chatId: 'f1', name: 'Folder pancakes', folder: '/work' }),
      row({ chatId: 'f2', name: 'Folder other', folder: '/work' }),
      row({ chatId: 's1', name: 'Snoozed pancakes', snoozedUntil: IN_AN_HOUR }),
      row({ chatId: 's2', name: 'Snoozed other', snoozedUntil: IN_AN_HOUR }),
      row({ chatId: 'a1', name: 'Archived pancakes', status: 'archived', lastUpdated: 1 }),
      row({ chatId: 'a2', name: 'Archived other', status: 'archived', lastUpdated: 2 }),
    ]);
}

function openSearch(r: ReturnType<typeof renderRN>): void {
  actSync(() => findHost(r.root, byLabel('Search chats')).props.onPress());
}
function type(r: ReturnType<typeof renderRN>, q: string): void {
  actSync(() => findHost(r.root, byLabel('chats-search')).props.onChangeText(q));
}
/** Let the debounce run out and the (mocked) request settle. */
async function settle(ms = 300): Promise<void> {
  await actAsync(async () => {
    vi.advanceTimersByTime(ms);
  });
  await actAsync(async () => {});
}
function hits(r: ReturnType<typeof renderRN>, id = 'chat-search-hit'): string[] {
  return findAllHost(r.root, byTestId(id)).map((h) => textOf(h));
}

describe('one character — the instant local filter', () => {
  it('filters every section locally and sends nothing', async () => {
    hydrateEverySection();
    useChatStore.getState().hydrate([row({ chatId: 'z1', name: 'Zebra', folder: '/zoo' })]);
    const r = renderRN(<ChatsScreen />);
    openSearch(r);
    type(r, 'z');
    expect(hasText(r.root, 'Zebra')).toBe(true);
    expect(hasText(r.root, '/zoo')).toBe(true);
    expect(hasText(r.root, 'Folder other')).toBe(false);
    await settle(1000);
    expect(searchSpy).not.toHaveBeenCalled();
    expect(queryHost(r.root, byTestId('chat-search-searching'))).toBeNull();
    expect(useUiStore.getState().errors).toEqual([]);
  });

  it('a whitespace-only query shows the normal list', () => {
    hydrateEverySection();
    const r = renderRN(<ChatsScreen />);
    openSearch(r);
    type(r, '   ');
    expect(hasText(r.root, 'Folder other')).toBe(true);
    expect(hasText(r.root, 'Snoozed ▸')).toBe(true);
  });

  it('one character that matches nothing shows the chat-search empty state', () => {
    hydrateEverySection();
    const r = renderRN(<ChatsScreen />);
    openSearch(r);
    type(r, 'q');
    expect(hasText(r.root, 'No matches')).toBe(true);
    expect(hasText(r.root, 'Folder other')).toBe(false);
  });
});

describe('server search — request', () => {
  it('debounces typing into ONE request for the settled, trimmed query', async () => {
    const r = renderRN(<ChatsScreen />);
    openSearch(r);
    type(r, 'pa');
    type(r, 'pan');
    type(r, ' panc ');
    await actAsync(async () => {
      vi.advanceTimersByTime(299);
    });
    expect(searchSpy).not.toHaveBeenCalled();
    await settle(1);
    expect(searchSpy).toHaveBeenCalledTimes(1);
    expect(searchSpy.mock.calls[0]![0]).toBe('panc');
    expect(searchSpy.mock.calls[0]![1]).toMatchObject({ limit: 20 });
  });

  it('shows the local matches under "Searching…" until the server answers, then the server hits', async () => {
    hydrateEverySection();
    const d = deferred<ChatSearchResponse>();
    searchSpy.mockReturnValue(d.promise);
    const r = renderRN(<ChatsScreen />);
    openSearch(r);
    type(r, 'pancakes');
    // Interim: every section's loaded match, collapsed ones included.
    expect(findHost(r.root, byTestId('chat-search-searching'))).toBeTruthy();
    const local = hits(r, 'chat-search-local-hit').join('\n');
    for (const name of [
      'Manager pancakes',
      'Speakers pancakes',
      'Pinned pancakes',
      'Folder pancakes',
      'Snoozed pancakes',
      'Archived pancakes',
    ]) {
      expect(local).toContain(name);
    }
    expect(local).not.toContain('other');
    await settle();
    expect(findHost(r.root, byTestId('chat-search-searching'))).toBeTruthy();

    await actAsync(async () => {
      d.resolve(answer([hit({ chatId: 'x1', name: 'Pancake transcript' })]));
    });
    expect(queryHost(r.root, byTestId('chat-search-searching'))).toBeNull();
    expect(findAllHost(r.root, byTestId('chat-search-local-hit'))).toHaveLength(0);
    expect(hits(r)).toHaveLength(1);
    expect(hits(r)[0]).toContain('Pancake transcript');
  });

  it('drops an earlier query answer that lands after a later one, and aborts it', async () => {
    const first = deferred<ChatSearchResponse>();
    const second = deferred<ChatSearchResponse>();
    searchSpy.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const r = renderRN(<ChatsScreen />);
    openSearch(r);
    type(r, 'pan');
    await settle();
    type(r, 'pancake');
    await settle();
    expect(searchSpy).toHaveBeenCalledTimes(2);
    const firstSignal = searchSpy.mock.calls[0]![1].signal as AbortSignal;
    expect(firstSignal.aborted).toBe(true);

    await actAsync(async () => {
      second.resolve(answer([hit({ chatId: 'new', name: 'Latest answer' })]));
    });
    await actAsync(async () => {
      first.resolve(answer([hit({ chatId: 'old', name: 'Stale answer' })]));
    });
    expect(hasText(r.root, 'Latest answer')).toBe(true);
    expect(hasText(r.root, 'Stale answer')).toBe(false);
  });

  it('a failed search is a visible row with the message, not a toast', async () => {
    searchSpy.mockRejectedValue(new Error('internal: index unavailable'));
    const r = renderRN(<ChatsScreen />);
    openSearch(r);
    type(r, 'pancakes');
    await settle();
    expect(textOf(findHost(r.root, byTestId('chat-search-error')))).toBe(
      'Search failed: internal: index unavailable',
    );
    expect(useUiStore.getState().errors).toEqual([]);
    expect(queryHost(r.root, byTestId('chat-search-searching'))).toBeNull();
  });
});

describe('server search — results', () => {
  it('zero hits is the empty-search state, with unsearched hosts still named', async () => {
    usePresenceStore.setState({
      hosts: {
        d1: {
          daemonId: 'd1',
          online: false,
          lastSeenAt: null,
          host: { hostName: 'Mac' } as never,
          accounts: {},
        },
      },
    });
    searchSpy.mockResolvedValue(
      answer([], {
        hosts: [
          { daemonId: 'd1', hostName: 'macbook', state: 'offline' },
          { daemonId: 'd2', hostName: 'Box', state: 'timeout' },
          { daemonId: 'd3', hostName: null, state: 'error', message: 'disk full' },
          { daemonId: 'd4', hostName: 'Searched', state: 'searched' },
        ],
      }),
    );
    const r = renderRN(<ChatsScreen />);
    openSearch(r);
    type(r, 'pancakes');
    await settle();
    expect(hasText(r.root, 'No matches')).toBe(true);
    // The app's own name for a host beats the server's.
    expect(textOf(findHost(r.root, byTestId('chat-search-host-d1')))).toBe(
      'Mac offline — not searched',
    );
    expect(textOf(findHost(r.root, byTestId('chat-search-host-d2')))).toBe(
      "Box didn't answer — not searched",
    );
    expect(textOf(findHost(r.root, byTestId('chat-search-host-d3')))).toBe('d3: disk full');
    expect(queryHost(r.root, byTestId('chat-search-host-d4'))).toBeNull();
  });

  it('draws the name and snippet with their matches marked, and the meta line', async () => {
    searchSpy.mockResolvedValue(
      answer([
        hit({
          chatId: 'c1',
          name: 'Pancake recipes',
          nameMatch: true,
          nameHighlights: [[0, 7]],
          section: 'folders',
          folder: '/home/tom/kitchen',
          jobId: 'job-1',
          messageMatches: 3,
          lastUpdated: Date.now() - 2 * 3_600_000,
          snippet: {
            text: 'how thick should pancake batter be',
            highlights: [[17, 24]],
            role: 'user',
            seq: 42,
            createdAt: Date.now() - 3 * 86_400_000,
          },
        }),
      ]),
    );
    const r = renderRN(<ChatsScreen />);
    openSearch(r);
    type(r, 'pancake');
    await settle();
    const row = findHost(r.root, byTestId('chat-search-hit'));
    const marks = findAllHost(row, byTestId('chat-search-mark')).map((m) => textOf(m));
    expect(marks).toEqual(['Pancake', 'pancake']);
    expect(textOf(findHost(row, byTestId('chat-search-snippet')))).toBe(
      'You: how thick should pancake batter be',
    );
    expect(textOf(row)).toContain('box · kitchen · Automation · 3d ago · +2 more');
  });

  it('tapping a hit opens the chat at the matched message', async () => {
    searchSpy.mockResolvedValue(
      answer([
        hit({
          chatId: 'c1',
          name: 'With seq',
          snippet: { text: 'x', highlights: [], role: 'assistant', seq: 42, createdAt: null },
        }),
        hit({ chatId: 'c2', name: 'Name only', section: 'archived', status: 'archived' }),
      ]),
    );
    const r = renderRN(<ChatsScreen />);
    openSearch(r);
    type(r, 'with');
    await settle();
    const [withSeq] = findAllHost(r.root, byTestId('chat-search-hit'));
    actSync(() => withSeq!.props.onPress());
    expect(routerMock.push).toHaveBeenLastCalledWith({
      pathname: '/chats/[chatId]',
      params: { chatId: 'c1', seq: '42' },
    });
    // Pressing a hit closes search (its own test below) — reopen for the second tap.
    openSearch(r);
    type(r, 'with');
    await settle();
    // An archived chat opens like any other; with no seq it opens normally.
    const [, nameOnly] = findAllHost(r.root, byTestId('chat-search-hit'));
    actSync(() => nameOnly!.props.onPress());
    expect(routerMock.push).toHaveBeenLastCalledWith({
      pathname: '/chats/[chatId]',
      params: { chatId: 'c2' },
    });
  });

  it('tapping a hit also closes search, so coming back shows the normal list', async () => {
    hydrateEverySection();
    searchSpy.mockResolvedValue(answer([hit({ chatId: 'c1', name: 'With seq' })]));
    const r = renderRN(<ChatsScreen />);
    openSearch(r);
    type(r, 'with');
    await settle();
    actSync(() => findHost(r.root, byTestId('chat-search-hit')).props.onPress());
    expect(queryHost(r.root, byLabel('chats-search'))).toBeNull();
    expect(queryHost(r.root, byTestId('chat-search-results'))).toBeNull();
    expect(hasText(r.root, 'Folder other')).toBe(true);
  });

  it('"More results" fetches the next page and appends it', async () => {
    searchSpy
      .mockResolvedValueOnce(
        answer([hit({ chatId: 'c1', name: 'First page' })], { nextOffset: 20 }),
      )
      .mockResolvedValueOnce(answer([hit({ chatId: 'c2', name: 'Second page' })]));
    const r = renderRN(<ChatsScreen />);
    openSearch(r);
    type(r, 'page');
    await settle();
    expect(hasText(r.root, 'More results')).toBe(true);
    await actAsync(async () => {
      findHost(r.root, byTestId('chat-search-more')).props.onPress();
    });
    expect(searchSpy.mock.calls[1]![1]).toMatchObject({ offset: 20, limit: 20 });
    expect(hits(r).map((t) => t.split('box')[0])).toEqual(['First page', 'Second page']);
    expect(queryHost(r.root, byTestId('chat-search-more'))).toBeNull();
  });

  it('a failed page keeps the results and shows its failure under them; the row is busy meanwhile', async () => {
    const page = deferred<ChatSearchResponse>();
    searchSpy
      .mockResolvedValueOnce(
        answer([hit({ chatId: 'c1', name: 'First page' })], { nextOffset: 20 }),
      )
      .mockReturnValueOnce(page.promise);
    const r = renderRN(<ChatsScreen />);
    openSearch(r);
    type(r, 'page');
    await settle();
    await actAsync(async () => {
      findHost(r.root, byTestId('chat-search-more')).props.onPress();
    });
    const more = findHost(r.root, byTestId('chat-search-more'));
    expect(more.props.disabled).toBe(true);
    expect(textOf(more)).toBe('Searching…');
    await actAsync(async () => {
      page.reject(new Error('timeout'));
    });
    expect(hasText(r.root, 'First page')).toBe(true);
    expect(textOf(findHost(r.root, byTestId('chat-search-error')))).toBe('Search failed: timeout');
    expect(findHost(r.root, byTestId('chat-search-more')).props.disabled).toBe(false);
  });

  it('titles a hit by its name, else its preview, else "New chat" — never a raw id', async () => {
    searchSpy.mockResolvedValue(
      answer([
        hit({ chatId: 'c1', name: 'chat_01ABC', preview: 'First words' }),
        hit({ chatId: 'c2', daemonId: 'gone' }),
      ]),
    );
    const r = renderRN(<ChatsScreen />);
    openSearch(r);
    type(r, 'words');
    await settle();
    const [a, b] = hits(r);
    expect(a!.startsWith('First words')).toBe(true);
    expect(a).not.toContain('chat_01ABC');
    // A host neither the app nor the server can name is named by its id.
    expect(b!.startsWith('New chatgone · work')).toBe(true);
  });
});

describe('search — clearing and closing', () => {
  it('clearing the text restores the normal list, collapse state and all', () => {
    hydrateEverySection();
    const r = renderRN(<ChatsScreen />);
    openSearch(r);
    type(r, 'pancakes');
    type(r, '');
    expect(hasText(r.root, 'Folder other')).toBe(true);
    expect(hasText(r.root, 'Snoozed ▸')).toBe(true);
    expect(hasText(r.root, 'Archived ▸')).toBe(true);
    expect(hasText(r.root, 'Archived pancakes')).toBe(false);
  });

  it('closing the search drops the query, so reopening starts clean', async () => {
    hydrateEverySection();
    const r = renderRN(<ChatsScreen />);
    openSearch(r);
    type(r, 'pancakes');
    actSync(() => findHost(r.root, byLabel('Close search')).props.onPress());
    expect(hasText(r.root, 'Folder other')).toBe(true);
    // The pending request died with the results.
    await settle();
    expect(searchSpy).not.toHaveBeenCalled();
    openSearch(r);
    expect(findHost(r.root, byLabel('chats-search')).props.value).toBe('');
  });
});

describe('search — archived rows', () => {
  it('opening search fetches the archived list, so chats never loaded match locally', async () => {
    listArchivedSpy.mockResolvedValue({
      chats: [
        {
          chatId: 'a9',
          name: 'Old pancakes',
          daemonId: 'd1',
          folder: '/old',
          activity: 'idle',
          permissionMode: 'default',
          status: 'archived',
          pinned: false,
          pinnedAt: null,
          lastUpdated: 5,
          pendingWake: null,
          snoozedUntil: null,
        },
      ],
    });
    const r = renderRN(<ChatsScreen />);
    await actAsync(async () => {});
    expect(listArchivedSpy).not.toHaveBeenCalled();
    openSearch(r);
    await actAsync(async () => {});
    expect(listArchivedSpy).toHaveBeenCalledTimes(1);
    type(r, 'old pan');
    expect(hits(r, 'chat-search-local-hit').join()).toContain('Old pancakes');
  });

  it('a failed archived fetch raises a toast rather than passing silently', async () => {
    listArchivedSpy.mockRejectedValue(new Error('boom'));
    const r = renderRN(<ChatsScreen />);
    openSearch(r);
    await actAsync(async () => {});
    expect(useUiStore.getState().errors.map((e) => e.message)).toContain(
      'failed to load archived chats: boom',
    );
  });

  it('there is no search box inside the Archived section any more', () => {
    hydrateEverySection();
    const r = renderRN(<ChatsScreen />);
    const archivedHeader = findAllHost(r.root, byType('Pressable')).find((p) =>
      hasText(p, 'Archived ▸'),
    )!;
    actSync(() => archivedHeader.props.onPress());
    expect(hasText(r.root, 'Archived ▾')).toBe(true);
    expect(queryHost(r.root, byLabel('archived-search'))).toBeNull();
    expect(findAllHost(r.root, byType('TextInput'))).toHaveLength(0);
  });
});
