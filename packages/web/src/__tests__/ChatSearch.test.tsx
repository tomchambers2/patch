// The sidebar's global chat search (spec/03 § Chat search): one field in the
// top band, debounced server search, only the latest query's answer renders,
// a local stand-in while waiting, and every unsearched host named.

import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { ChatSearchHit, ChatSearchResponse } from '@patch/wire';
import { Sidebar } from '../components/Sidebar.js';
import { SEARCH_DEBOUNCE_MS } from '../components/ChatSearch.js';
import { useChatStore } from '../stores/chatStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { api } from '../api/rest.js';
import type { ChatRow } from '../stores/types.js';

function chat(
  over: Partial<ChatRow>,
): Parameters<ReturnType<typeof useChatStore.getState>['hydrate']>[0][number] {
  return {
    chatId: 'c1',
    daemonId: 'd1',
    permissionMode: 'auto',
    name: 'a chat',
    preview: null,
    folder: '/home/tom/projects/patch',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: Date.now(),
    jobId: null,
    snoozedUntil: null,
    pendingWake: null,
    todos: [],
    ...over,
  } as never;
}

function hit(over: Partial<ChatSearchHit>): ChatSearchHit {
  return {
    chatId: 'h1',
    daemonId: 'd1',
    name: 'bus watch',
    preview: null,
    folder: '/home/tom/projects/bus',
    status: 'active',
    section: 'folders',
    pinned: false,
    snoozedUntil: null,
    lastUpdated: Date.now() - 3 * 3_600_000,
    jobId: null,
    nameMatch: true,
    nameHighlights: [[0, 3]],
    messageMatches: 0,
    snippet: null,
    ...over,
  };
}

function response(over: Partial<ChatSearchResponse> = {}): ChatSearchResponse {
  return {
    query: 'bus',
    hits: [],
    total: 0,
    nextOffset: null,
    hosts: [{ daemonId: 'd1', hostName: 'hetzner', state: 'searched' }],
    ...over,
  };
}

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

function LocationProbe(): JSX.Element {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname + loc.search}</div>;
}

function renderSidebar(): void {
  render(
    <MemoryRouter initialEntries={['/']}>
      <Sidebar />
      <LocationProbe />
    </MemoryRouter>,
  );
}

function type(value: string): void {
  fireEvent.change(screen.getByTestId('chat-search'), { target: { value } });
}

/** Run the debounce out and let the resolved request land. */
async function settle(ms = SEARCH_DEBOUNCE_MS): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('sidebar chat search', () => {
  let search: MockInstance<typeof api.searchChats>;

  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
    useChatStore.getState()._reset();
    usePresenceStore.setState({ hosts: {} });
    useUiStore.getState().setSearchQuery('');
    useUiStore.getState().setSearchFullText(false);
    useUiStore.getState().setAttentionOnly(false);
    useUiStore.getState().setArchivedOpen(false);
    vi.spyOn(api, 'listChatsArchived').mockResolvedValue({ chats: [], nextOffset: null });
    search = vi.spyOn(api, 'searchChats');
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    useUiStore.getState().setSearchQuery('');
  });

  it('is one field in its own fixed top-band row, marked for ⌘K/⌘F', () => {
    renderSidebar();
    const field = screen.getByTestId('chat-search');
    expect(field).toHaveAttribute('type', 'search');
    expect(field).toHaveAttribute('data-search-input');
    expect(field).toHaveAttribute('placeholder', 'Search chats…');
    const topRow = screen.getByTestId('sb-top-row');
    expect(topRow).toContainElement(field);
    // Filtering moved to the sidebar's own view dropdown, above this row.
    expect(screen.getByTestId('sidebar-view-menu')).toBeInTheDocument();
    // Not inside the scrolling band, so it never scrolls away.
    expect(screen.getByTestId('sb-scroll')).not.toContainElement(field);
    expect(document.querySelectorAll('[data-search-input]')).toHaveLength(1);
  });

  it('the archived section no longer carries a search field of its own', () => {
    useChatStore.getState().hydrate([chat({ chatId: 'arc', status: 'archived', name: 'old one' })]);
    renderSidebar();
    fireEvent.click(screen.getByTestId('archived-toggle'));
    expect(screen.queryByTestId('archived-search')).toBeNull();
    expect(screen.queryByTestId('archived-no-results')).toBeNull();
    expect(screen.getByTestId('archived-section').querySelector('input')).toBeNull();
    expect(screen.getByTestId('chat-row-arc')).toBeInTheDocument();
  });

  it('a one-character query leaves the normal list alone and sends nothing', async () => {
    useChatStore.getState().hydrate([chat({ chatId: 'c1', name: 'bus watch' })]);
    renderSidebar();
    type('b');
    await settle(1000);
    expect(search).not.toHaveBeenCalled();
    expect(screen.queryByTestId('chat-search-results')).toBeNull();
    expect(screen.getByTestId('chat-row-c1')).toBeInTheDocument();
  });

  it('debounces: one request for the settled query, with a local stand-in meanwhile', async () => {
    search.mockResolvedValue(response({ hits: [hit({ chatId: 'srv' })], total: 1 }));
    useChatStore
      .getState()
      .hydrate([
        chat({ chatId: 'loc', name: 'Bus timetable' }),
        chat({ chatId: 'other', name: 'tea order' }),
      ]);
    renderSidebar();
    type('bu');
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    type('bus');
    await act(async () => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 10);
    });
    expect(search).not.toHaveBeenCalled();
    // Waiting: the chat list is replaced by the local name filter.
    expect(screen.getByTestId('chat-search-searching')).toHaveTextContent('Searching…');
    const local = screen.getAllByTestId('chat-search-local-hit');
    expect(local.map((el) => el.getAttribute('data-chat-id'))).toEqual(['loc']);
    expect(screen.queryByTestId('chat-row-other')).toBeNull();

    await settle(10);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0]![0]).toBe('bus');
    // The server's answer replaces the stand-in.
    expect(screen.queryByTestId('chat-search-searching')).toBeNull();
    expect(screen.queryByTestId('chat-search-local-hit')).toBeNull();
    expect(screen.getAllByTestId('chat-search-hit')).toHaveLength(1);
  });

  it('a Full text box, unticked by default, re-runs the search with message text when ticked', async () => {
    search.mockResolvedValue(response({ hits: [hit({ chatId: 'srv' })], total: 1 }));
    useChatStore
      .getState()
      .hydrate([chat({ chatId: 'loc', name: 'Bus timetable', preview: 'about bus times' })]);
    renderSidebar();
    type('bus');
    await settle();
    const box = screen.getByTestId('chat-search-fulltext');
    expect(box).not.toBeChecked();
    expect(search.mock.calls[0]![1]).toMatchObject({ fullText: false });

    search.mockClear();
    fireEvent.click(box);
    expect(box).toBeChecked();
    // The old scope's answer is not shown for the new scope while it loads.
    expect(screen.queryByTestId('chat-search-hit')).toBeNull();
    await settle();
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0]![0]).toBe('bus');
    expect(search.mock.calls[0]![1]).toMatchObject({ fullText: true });
    expect(screen.getAllByTestId('chat-search-hit')).toHaveLength(1);
  });

  it('only the latest query’s response renders — a late answer to an older one is dropped', async () => {
    const first = deferred<ChatSearchResponse>();
    const second = deferred<ChatSearchResponse>();
    search.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    renderSidebar();

    type('bus');
    await settle();
    type('tea');
    await settle();
    expect(search).toHaveBeenCalledTimes(2);

    await act(async () => {
      second.resolve(response({ query: 'tea', hits: [hit({ chatId: 'tea1', name: 'tea' })] }));
      await Promise.resolve();
    });
    await act(async () => {
      first.resolve(response({ query: 'bus', hits: [hit({ chatId: 'bus1' })] }));
      await Promise.resolve();
    });
    const ids = screen
      .getAllByTestId('chat-search-hit')
      .map((el) => el.getAttribute('data-chat-id'));
    expect(ids).toEqual(['tea1']);
  });

  it('an older response landing while the newer is still out does not render either', async () => {
    const first = deferred<ChatSearchResponse>();
    const second = deferred<ChatSearchResponse>();
    search.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    renderSidebar();
    type('bus');
    await settle();
    type('tea');
    await settle();
    await act(async () => {
      first.resolve(response({ query: 'bus', hits: [hit({ chatId: 'bus1' })] }));
      await Promise.resolve();
    });
    expect(screen.queryByTestId('chat-search-hit')).toBeNull();
    expect(screen.getByTestId('chat-search-searching')).toBeInTheDocument();
  });

  it('shows a failed search as a visible error row with the message', async () => {
    search.mockRejectedValue(new Error('HTTP 502'));
    renderSidebar();
    type('bus');
    await settle();
    expect(screen.getByTestId('chat-search-error')).toHaveTextContent('HTTP 502');
    expect(screen.getByTestId('chat-search-error')).toHaveClass('empty-hint');
    expect(screen.queryByTestId('chat-search-searching')).toBeNull();
  });

  it('zero hits says so, naming the query', async () => {
    search.mockResolvedValue(response({ query: 'quokka' }));
    renderSidebar();
    type('  quokka ');
    await settle();
    expect(search.mock.calls[0]![0]).toBe('quokka');
    expect(screen.getByTestId('chat-search-empty')).toHaveTextContent('No chats match “quokka”.');
  });

  it('names every host that was not searched — under the results and with zero hits', async () => {
    usePresenceStore.setState({
      hosts: {
        mac1: {
          daemonId: 'mac1',
          online: false,
          lastSeenAt: null,
          host: { hostName: 'Mac' } as never,
          accounts: {},
          claudeSettings: null,
          folders: null,
        },
      },
    });
    search.mockResolvedValue(
      response({
        hosts: [
          { daemonId: 'd1', hostName: 'hetzner', state: 'searched' },
          { daemonId: 'mac1', hostName: null, state: 'offline' },
          { daemonId: 'pi', hostName: 'pi', state: 'timeout' },
          { daemonId: 'nuc', hostName: null, state: 'error', message: 'index corrupt' },
        ],
      }),
    );
    renderSidebar();
    type('bus');
    await settle();
    expect(screen.getByTestId('chat-search-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-search-host-d1')).toBeNull();
    expect(screen.getByTestId('chat-search-host-mac1')).toHaveTextContent(
      'Mac offline — not searched',
    );
    expect(screen.getByTestId('chat-search-host-pi')).toHaveTextContent(
      "pi didn't answer — not searched",
    );
    expect(screen.getByTestId('chat-search-host-nuc')).toHaveTextContent('nuc: index corrupt');
  });

  it('draws highlights and meta, and a click opens the chat at the matched message', async () => {
    search.mockResolvedValue(
      response({
        hits: [
          hit({
            chatId: 'c9',
            name: 'Bus watch',
            nameHighlights: [[0, 3]],
            jobId: 'job1',
            messageMatches: 3,
            snippet: {
              text: 'the 57 bus is late',
              highlights: [[7, 10]],
              role: 'user',
              seq: 7,
              createdAt: Date.now() - 2 * 3_600_000,
            },
          }),
        ],
        total: 1,
      }),
    );
    renderSidebar();
    type('bus');
    await settle();
    const row = screen.getByTestId('chat-search-hit');
    const marks = Array.from(row.querySelectorAll('mark')).map((m) => m.textContent);
    expect(marks).toEqual(['Bus', 'bus']);
    expect(row).toHaveTextContent('You: the 57 bus is late');
    expect(row.querySelector('.search-meta')).toHaveTextContent(
      'hetzner · bus · Automation · 2h ago · +2 more',
    );
    fireEvent.click(row);
    expect(screen.getByTestId('loc')).toHaveTextContent('/chats/c9?seq=7');
    // Pressing a result clears the search — the field and the results band
    // are both gone, so the sidebar shows the ordinary chat list again.
    expect(screen.getByTestId('chat-search')).toHaveValue('');
    expect(screen.queryByTestId('chat-search-results')).toBeNull();
  });

  it('a hit without a message seq opens the chat plainly, and also clears search', async () => {
    search.mockResolvedValue(response({ hits: [hit({ chatId: 'c3' })], total: 1 }));
    renderSidebar();
    type('bus');
    await settle();
    fireEvent.click(screen.getByTestId('chat-search-hit'));
    expect(screen.getByTestId('loc')).toHaveTextContent(/^\/chats\/c3$/);
    expect(screen.getByTestId('chat-search')).toHaveValue('');
    expect(screen.queryByTestId('chat-search-results')).toBeNull();
  });

  it('More results fetches the next page and appends it', async () => {
    search
      .mockResolvedValueOnce(response({ hits: [hit({ chatId: 'p1' })], total: 2, nextOffset: 1 }))
      .mockResolvedValueOnce(
        response({ hits: [hit({ chatId: 'p2' })], total: 2, nextOffset: null }),
      );
    renderSidebar();
    type('bus');
    await settle();
    fireEvent.click(screen.getByTestId('chat-search-more'));
    await settle(0);
    expect(search.mock.calls[1]![1]).toMatchObject({ offset: 1 });
    const ids = screen
      .getAllByTestId('chat-search-hit')
      .map((el) => el.getAttribute('data-chat-id'));
    expect(ids).toEqual(['p1', 'p2']);
    expect(screen.queryByTestId('chat-search-more')).toBeNull();
  });

  it('clearing the field brings the chat list back', async () => {
    search.mockResolvedValue(response());
    useChatStore.getState().hydrate([chat({ chatId: 'c1', name: 'kept' })]);
    renderSidebar();
    type('bus');
    await settle();
    expect(screen.queryByTestId('chat-row-c1')).toBeNull();
    fireEvent.keyDown(screen.getByTestId('chat-search'), { key: 'Escape' });
    expect(screen.getByTestId('chat-search')).toHaveValue('');
    expect(screen.getByTestId('chat-row-c1')).toBeInTheDocument();
  });
  it('always shows a clear button, and it empties the field', async () => {
    search.mockResolvedValue(response());
    useChatStore.getState().hydrate([chat({ chatId: 'c1', name: 'kept' })]);
    renderSidebar();
    const clear = screen.getByTestId('chat-search-clear');
    expect(clear).toBeVisible();
    type('bus');
    await settle();
    expect(screen.getByTestId('chat-search-clear')).toBeVisible();
    fireEvent.click(screen.getByTestId('chat-search-clear'));
    expect(screen.getByTestId('chat-search')).toHaveValue('');
    expect(screen.getByTestId('chat-row-c1')).toBeInTheDocument();
  });
});
