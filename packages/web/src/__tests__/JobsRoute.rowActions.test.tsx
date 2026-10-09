// The Jobs list's per-row archive and delete controls (spec/14 § Jobs view).
//
// Archive is the reversible "get it out of my way" action — one PATCH, no
// confirmation. Delete is permanent and goes through the app's own confirm
// modal first, the same one the editor's Delete uses.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { JobsRoute } from '../routes/JobsRoute.js';
import { useUiStore } from '../stores/uiStore.js';

const LIVE = {
  id: 'bus',
  name: 'bus-watch',
  enabled: true,
  trigger: { type: 'cron', expression: '57 8 * * 1-5' },
  filter: null,
  action: { type: 'spawn', daemonId: 'd1', folder: '~/p', skill: 'bus-watch' },
  createdAt: 1,
  updatedAt: 1,
};
const ARCHIVED = { ...LIVE, id: 'old', name: 'old watcher', archived: true };

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function makeFetch(jobs: unknown[], calls: Call[], fail = false) {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    if (u.includes('/runs?limit=')) {
      return new Response(JSON.stringify({ runs: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (method !== 'GET') {
      calls.push({
        url: u,
        method,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      });
      if (fail) return new Response(JSON.stringify({ error: 'db locked' }), { status: 500 });
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ jobs }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

function renderJobs() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <JobsRoute />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('JobsRoute row actions', () => {
  beforeEach(() => {
    useUiStore.getState().clearToasts();
    useUiStore.getState().setArchivedJobsOpen(false);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('archives a live job with one PATCH, without asking first', async () => {
    const calls: Call[] = [];
    vi.stubGlobal('fetch', makeFetch([LIVE], calls));
    renderJobs();
    await waitFor(() => expect(screen.getByTestId('job-bus')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('job-archive-bus'));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.method).toBe('PATCH');
    expect(calls[0]?.url).toContain('/api/jobs/bus');
    expect(calls[0]?.body).toEqual({ archived: true });
    // No confirmation stood between the click and the write.
    expect(useUiStore.getState().confirmDialog).toBeNull();
  });

  it('un-archives from the archived section — the same control, reversed', async () => {
    const calls: Call[] = [];
    vi.stubGlobal('fetch', makeFetch([ARCHIVED], calls));
    renderJobs();
    await waitFor(() => expect(screen.getByTestId('jobs-archived-toggle')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('jobs-archived-toggle'));

    const control = screen.getByTestId('job-archive-old');
    expect(control).toHaveTextContent(/unarchive/i);
    fireEvent.click(control);

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toEqual({ archived: false });
  });

  it('surfaces a toast when archiving fails', async () => {
    vi.stubGlobal('fetch', makeFetch([LIVE], [], true));
    renderJobs();
    await waitFor(() => expect(screen.getByTestId('job-bus')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('job-archive-bus'));
    await waitFor(() => {
      expect(useUiStore.getState().errors[0]?.message).toContain('Archive failed');
    });
  });

  it('deletes only after the confirmation is accepted', async () => {
    const calls: Call[] = [];
    vi.stubGlobal('fetch', makeFetch([LIVE], calls));
    renderJobs();
    await waitFor(() => expect(screen.getByTestId('job-bus')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('job-delete-bus'));
    await waitFor(() => expect(useUiStore.getState().confirmDialog).not.toBeNull());
    expect(calls).toHaveLength(0);

    useUiStore.getState().resolveConfirm(true);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.url).toContain('/api/jobs/bus');
  });

  it('cancelling the confirmation deletes nothing', async () => {
    const calls: Call[] = [];
    vi.stubGlobal('fetch', makeFetch([LIVE], calls));
    renderJobs();
    await waitFor(() => expect(screen.getByTestId('job-bus')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('job-delete-bus'));
    await waitFor(() => expect(useUiStore.getState().confirmDialog).not.toBeNull());
    useUiStore.getState().resolveConfirm(false);

    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(0);
  });

  it('surfaces a toast when the delete fails', async () => {
    vi.stubGlobal('fetch', makeFetch([LIVE], [], true));
    renderJobs();
    await waitFor(() => expect(screen.getByTestId('job-bus')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('job-delete-bus'));
    await waitFor(() => expect(useUiStore.getState().confirmDialog).not.toBeNull());
    useUiStore.getState().resolveConfirm(true);
    await waitFor(() => {
      expect(useUiStore.getState().errors[0]?.message).toContain('Delete failed');
    });
  });
});

describe('JobsRoute archived section', () => {
  beforeEach(() => {
    useUiStore.getState().setArchivedJobsOpen(false);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('an archived job is folded away behind a counted header, not in the main list', async () => {
    vi.stubGlobal('fetch', makeFetch([LIVE, ARCHIVED], []));
    renderJobs();
    await waitFor(() => expect(screen.getByTestId('job-bus')).toBeInTheDocument());

    expect(screen.queryByTestId('job-old')).toBeNull();
    expect(screen.getByTestId('jobs-archived-count')).toHaveTextContent('1');
    expect(screen.getByTestId('jobs-archived-toggle')).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(screen.getByTestId('jobs-archived-toggle'));
    expect(screen.getByTestId('job-old')).toBeInTheDocument();
  });

  it("an archived row is muted and its enable switch is dead — it doesn't fire", async () => {
    vi.stubGlobal('fetch', makeFetch([LIVE, ARCHIVED], []));
    renderJobs();
    await waitFor(() => expect(screen.getByTestId('job-bus')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('jobs-archived-toggle'));

    expect(screen.getByTestId('job-old')).toHaveClass('archived');
    expect(screen.getByTestId('job-toggle-old')).toBeDisabled();
    expect(screen.getByTestId('job-toggle-bus')).toBeEnabled();
  });

  it('no archived jobs means no archived section at all', async () => {
    vi.stubGlobal('fetch', makeFetch([LIVE], []));
    renderJobs();
    await waitFor(() => expect(screen.getByTestId('job-bus')).toBeInTheDocument());
    expect(screen.queryByTestId('jobs-section-archived')).toBeNull();
    expect(document.querySelectorAll('.jobs-section-head')).toHaveLength(0);
  });
});
