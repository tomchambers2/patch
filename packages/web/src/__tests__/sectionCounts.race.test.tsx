// Reproduction for "hidden badge shows 0 while the section actually has
// chats" (Todoist patch admin task 6hfRqCm94xv76hqc): a lifecycle event that
// lands while the mount-time `/api/chats/counts` fetch is still in flight.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { JSX } from 'react';
import { useSectionCounts } from '../lib/sectionCounts.js';
import { useChatStore } from '../stores/chatStore.js';
import { api } from '../api/rest.js';

function Host(): JSX.Element {
  useSectionCounts();
  return <></>;
}

function renderHost(qc: QueryClient): void {
  render(
    <QueryClientProvider client={qc}>
      <Host />
    </QueryClientProvider>,
  );
}

describe('useSectionCounts — race with an in-flight mount fetch', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reflects a hidden chat that spawns before the first counts fetch resolves', async () => {
    let resolveFirst!: (v: {
      hidden: number;
      archived: number;
      snoozed: number;
      deleted: number;
      automations: number;
    }) => void;
    let calls = 0;
    vi.spyOn(api, 'chatSectionCounts').mockImplementation(() => {
      calls++;
      if (calls === 1) {
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
      }
      // Every call after the first reflects live server truth: the host
      // told the registry about the hidden chat as soon as it spawned it.
      return Promise.resolve({ hidden: 1, archived: 0, snoozed: 0, deleted: 0, automations: 0 });
    });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHost(qc);

    // A job spawns a chat hidden from birth (spec/08 § Action `startHidden`)
    // WHILE the mount's own counts fetch is still outstanding.
    useChatStore.getState().applyEvent({
      type: 'chat.state',
      chatId: 'job-1',
      folder: '~/proj',
      activity: 'idle',
      status: 'active',
      permissionMode: 'auto',
      hidden: true,
      lastUpdated: 1,
    });

    // The FIRST request — issued before the chat existed — finally lands,
    // carrying the stale count it actually observed.
    resolveFirst({ hidden: 0, archived: 0, snoozed: 0, deleted: 0, automations: 0 });

    await waitFor(() => expect(useChatStore.getState().sectionCounts?.hidden).toBe(1));
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});
