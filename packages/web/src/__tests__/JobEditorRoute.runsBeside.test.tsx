// spec/14 § Panes and tabs § Opening things — runs open beside the job: a plain
// click on a run's chat (Recent runs, or the Queue's running fires) opens that
// chat in the pane to the right of the job; ↑/↓ steps through the runs and
// updates that pane; middle-click is a new tab, modified clicks are left alone.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { JobEditorRoute } from '../routes/JobEditorRoute.js';
import { useLayoutStore, countPanes, type PaneNode } from '../stores/layoutStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';

vi.mock('../lib/monaco-loader.js', () => ({ ensureMonacoLoaded: async () => undefined }));

const job = {
  id: 'j1',
  name: 'digest',
  enabled: true,
  trigger: { type: 'cron', expression: '0 9 * * *' },
  filter: null,
  action: { type: 'continue', daemonId: 'd1', folder: '/tmp', skill: 'why' },
  concurrency: 2,
  createdAt: 1,
  updatedAt: 1,
};

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

function renderJob(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/jobs/j1']}>
        <Routes>
          <Route path="/jobs/:id" element={<JobEditorRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function tabKeys(node: PaneNode): string[][] {
  return node.type === 'leaf'
    ? [node.tabs.map((t) => t.id)]
    : node.children.flatMap((c) => tabKeys(c.pane));
}

describe('job page: runs open beside the job', () => {
  beforeEach(() => {
    usePresenceStore
      .getState()
      .setHosts([{ daemonId: 'd1', online: true, lastSeenAt: null, host: null, accounts: [] }]);
    useLayoutStore.getState()._reset();
    useLayoutStore.getState().openTab({ kind: 'page', page: 'job', jobId: 'j1' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes('/runs')) {
          return json({
            runs: ['a', 'b', 'c'].map((c, i) => ({
              ts: 10 - i,
              jobId: 'j1',
              status: 'ok',
              trigger: 'cron',
              action: { type: 'spawn', chatId: `chat-${c}` },
            })),
          });
        }
        if (u.includes('/queue')) {
          return json({
            concurrency: 2,
            inFlight: [{ chatId: 'chat-live', localId: 'l1', startedAt: 5 }],
            queued: [],
          });
        }
        return json(job);
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('a plain click on a run splits a chat pane to the right of the job', async () => {
    renderJob();
    const runLinks = () =>
      Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid="recent-runs"] .run-chat-link'),
      );
    await waitFor(() => expect(runLinks()).toHaveLength(3));
    fireEvent.click(runLinks()[0] as HTMLElement);
    const { root } = useLayoutStore.getState();
    expect(countPanes(root)).toBe(2);
    expect(tabKeys(root)).toEqual([['page:job:j1'], ['chat:chat-a']]);
  });

  it('a second run replaces the chat in the same pane rather than splitting again', async () => {
    renderJob();
    await screen.findAllByText('open chat');
    const runLinks = () =>
      Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid="recent-runs"] .run-chat-link'),
      );
    await waitFor(() => expect(runLinks()).toHaveLength(3));
    fireEvent.click(runLinks()[0] as HTMLElement);
    fireEvent.click(runLinks()[1] as HTMLElement);
    expect(tabKeys(useLayoutStore.getState().root)).toEqual([['page:job:j1'], ['chat:chat-b']]);
  });

  it('arrow keys step through runs, focusing each and updating the pane', async () => {
    renderJob();
    const runLinks = () =>
      Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid="recent-runs"] .run-chat-link'),
      );
    await waitFor(() => expect(runLinks()).toHaveLength(3));
    runLinks()[0]?.focus();
    fireEvent.click(runLinks()[0] as HTMLElement);
    fireEvent.keyDown(runLinks()[0] as HTMLElement, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(runLinks()[1]);
    expect(tabKeys(useLayoutStore.getState().root)).toEqual([['page:job:j1'], ['chat:chat-b']]);
    fireEvent.keyDown(runLinks()[1] as HTMLElement, { key: 'ArrowUp' });
    expect(tabKeys(useLayoutStore.getState().root)).toEqual([['page:job:j1'], ['chat:chat-a']]);
    // Past the first run there is nothing to step to.
    fireEvent.keyDown(runLinks()[0] as HTMLElement, { key: 'ArrowUp' });
    expect(tabKeys(useLayoutStore.getState().root)).toEqual([['page:job:j1'], ['chat:chat-a']]);
  });

  it("the Queue panel's running fire opens beside the job too", async () => {
    renderJob();
    const running = await screen.findByTestId('job-queue-running');
    fireEvent.click(running.querySelector('.run-chat-link') as HTMLElement);
    expect(tabKeys(useLayoutStore.getState().root)).toEqual([['page:job:j1'], ['chat:chat-live']]);
  });

  it('middle-click is a new tab in the active pane; a modified click is left to the browser', async () => {
    renderJob();
    await screen.findByTestId('job-queue-running');
    await waitFor(() =>
      expect(document.querySelector('[data-testid="recent-runs"] .run-chat-link')).not.toBeNull(),
    );
    const link = document.querySelector(
      '[data-testid="recent-runs"] .run-chat-link',
    ) as HTMLElement;
    fireEvent.click(link, { ctrlKey: true });
    expect(countPanes(useLayoutStore.getState().root)).toBe(1);
    expect(tabKeys(useLayoutStore.getState().root)).toEqual([['page:job:j1']]);
    fireEvent(link, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
    expect(tabKeys(useLayoutStore.getState().root)).toEqual([['page:job:j1', 'chat:chat-a']]);
  });
});
