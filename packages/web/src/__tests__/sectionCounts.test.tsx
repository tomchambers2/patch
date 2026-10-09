// useSectionCounts — spec/04 § Section counts. Lifecycle changes that land
// together must not start re-ask chains that cancel each other's fetches
// forever: that loop ran entirely in microtasks, froze the desktop window and
// grew the renderer until it crashed out of memory.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type Counts = {
  hidden: number;
  archived: number;
  snoozed: number;
  deleted: number;
  automations: number;
};
const chatSectionCounts = vi.fn<() => Promise<Counts>>();

vi.mock('../api/rest.js', () => ({ api: { chatSectionCounts } }));

const counts = (archived: number): Counts => ({
  hidden: 0,
  archived,
  snoozed: 0,
  deleted: 0,
  automations: 0,
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** A runaway loop never yields, so a test can't time it out — this breaks it from inside. */
const LOOP_GUARD = 50;

describe('useSectionCounts', () => {
  let queryClient: QueryClient;

  beforeEach(async () => {
    vi.clearAllMocks();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { useChatStore } = await import('../stores/chatStore.js');
    useChatStore.setState({ chats: {} });
  });

  it('a burst of lifecycle changes asks the server a bounded number of times, then settles on the newest answer', async () => {
    const { useSectionCounts } = await import('../lib/sectionCounts.js');
    const { useChatStore } = await import('../stores/chatStore.js');

    const pending: ReturnType<typeof deferred<Counts>>[] = [];
    chatSectionCounts.mockImplementation(() => {
      if (chatSectionCounts.mock.calls.length > LOOP_GUARD) queryClient.clear();
      const d = deferred<Counts>();
      pending.push(d);
      return d.promise;
    });

    function Probe(): null {
      useSectionCounts();
      return null;
    }
    render(
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => pending[0]!.resolve(counts(1)));
    await waitFor(() => expect(useChatStore.getState().sectionCounts?.archived).toBe(1));

    // Five chats archived in one go: five distinct lifecycle signatures,
    // each landing while the previous refetch is still in flight.
    const row = (status: string) => ({ status, snoozedUntil: null }) as never;
    await act(async () => {
      const chats: Record<string, never> = {};
      for (const id of ['a', 'b', 'c', 'd', 'e']) {
        chats[id] = row('archived');
        useChatStore.setState({ chats: { ...chats } });
      }
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(chatSectionCounts.mock.calls.length).toBeLessThan(LOOP_GUARD);

    // Answer everything outstanding; the loop takes one more round for the
    // changes that arrived mid-flight and then stops.
    for (let round = 0; round < 5; round++) {
      await act(async () => {
        for (const d of pending.slice(1)) d.resolve(counts(5));
        await new Promise((r) => setTimeout(r, 0));
      });
    }
    await waitFor(() => expect(useChatStore.getState().sectionCounts?.archived).toBe(5));
    const settled = chatSectionCounts.mock.calls.length;
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(chatSectionCounts.mock.calls.length).toBe(settled);
    expect(settled).toBeLessThanOrEqual(4);
  });
});
