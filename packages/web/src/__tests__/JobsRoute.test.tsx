// JobsRoute (G4): the job list shows trigger as natural language and
// action as a two-axis verb + target, with a per-job last-fired cell and an
// expandable inline runs panel (spec/14 ## Jobs view).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { JobsRoute } from '../routes/JobsRoute.js';
import { useUiStore } from '../stores/uiStore.js';
import { reportHost, clearHosts } from './presenceHelpers.js';

const JOBS = {
  jobs: [
    {
      id: 'bus',
      name: 'bus-watch',
      enabled: true,
      trigger: { type: 'cron', expression: '57 8 * * 1-5' },
      filter: null,
      action: { type: 'spawn', daemonId: 'd1', folder: '~/p', skill: 'bus-watch' },
      createdAt: 1,
      updatedAt: 1,
      // The list reports each job's most recent fire; the row reads it from
      // here rather than fetching its own (spec/14 § Jobs view).
      latestRun: { ts: Date.now() - 3_600_000, status: 'ok' },
    },
    {
      id: 'gh',
      name: 'github merge alerts',
      enabled: false,
      trigger: { type: 'webhook', scheme: 'github' },
      filter: null,
      action: { type: 'message', chatId: 'thread_manager', prompt: 'summarise the merge' },
      createdAt: 2,
      updatedAt: 2,
      latestRun: null,
    },
  ],
};

const RUNS_PANEL = {
  runs: [
    { ts: Date.now() - 3_600_000, jobId: 'job-bus', status: 'ok', trigger: 'cron' },
    {
      ts: Date.now() - 7_200_000,
      jobId: 'job-bus',
      status: 'dispatch-error',
      trigger: 'cron',
      error: 'boom',
    },
  ],
};

function makeFetch() {
  return vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.includes('/runs?limit=')) {
      return new Response(JSON.stringify(RUNS_PANEL), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (u.includes('/api/jobs')) {
      return new Response(JSON.stringify(JOBS), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

function renderJobs() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Routes>
          <Route path="/jobs/:id" element={<div data-testid="job-page" />} />
          <Route path="*" element={<JobsRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('JobsRoute', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', makeFetch());
    clearHosts();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    clearHosts();
  });

  it('renders trigger as natural language and action as a two-axis verb + target', async () => {
    renderJobs();
    await waitFor(() => expect(screen.getByTestId('job-bus')).toBeInTheDocument());
    expect(screen.getByTestId('job-trigger-bus')).toHaveTextContent('weekdays at 8:57am');
    expect(screen.getByTestId('job-action-bus')).toHaveTextContent('spawn · skill');
    expect(screen.getByTestId('job-action-bus')).toHaveTextContent('bus-watch');
    expect(screen.getByTestId('job-trigger-gh')).toHaveTextContent('github webhook');
    expect(screen.getByTestId('job-action-gh')).toHaveTextContent('message · prompt');
  });

  it('shows a job’s date-range filter on the trigger row itself, without opening the editor (spec/08 § Filter)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes('/api/jobs')) {
          return new Response(
            JSON.stringify({
              jobs: [
                {
                  id: 'ranged',
                  name: 'friday pop-up check',
                  enabled: true,
                  trigger: { type: 'cron', expression: '0 16 * * 5' },
                  filter: 'now >= "2027-05-01T00:00:00.000Z"',
                  action: { type: 'spawn', daemonId: 'd1', folder: '~/p' },
                  createdAt: 1,
                  updatedAt: 1,
                  latestRun: null,
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
    renderJobs();
    await waitFor(() => expect(screen.getByTestId('job-ranged')).toBeInTheDocument());
    const fmt = new Date('2027-05-01T00:00:00.000Z').toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
    expect(screen.getByTestId('job-trigger-ranged')).toHaveTextContent(`from ${fmt}`);
  });

  it('shows the host name alongside the folder on a folder-addressed row, and finds the job by it (spec/14 § Jobs view)', async () => {
    reportHost('d1', { hostName: 'laptop' });
    renderJobs();
    await waitFor(() => expect(screen.getByTestId('job-bus')).toBeInTheDocument());
    // The row itself reads "host name and folder together" (spec/14).
    expect(screen.getByTestId('job-action-bus')).toHaveTextContent('laptop · ~/p');
    // Searching by the host name alone finds the job the search field
    // couldn't previously find any other way (`actionTarget`).
    fireEvent.change(screen.getByTestId('jobs-search'), { target: { value: 'laptop' } });
    expect(screen.getByTestId('job-bus')).toBeInTheDocument();
    expect(screen.queryByTestId('job-gh')).toBeNull();
  });

  it('shows the backlog only on a job holding fires behind its concurrency limit', async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes('/runs?limit='))
          return new Response(JSON.stringify({ runs: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        return new Response(
          JSON.stringify({
            jobs: [
              // Limited and backed up; limited but clear; no limit at all.
              { ...JOBS.jobs[0], id: 'busy', inFlight: 1, queued: 3 },
              { ...JOBS.jobs[0], id: 'clear', inFlight: 1, queued: 0 },
              { ...JOBS.jobs[0], id: 'plain' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    renderJobs();
    await waitFor(() => expect(screen.getByTestId('job-queued-busy')).toBeInTheDocument());
    expect(screen.getByTestId('job-queued-busy')).toHaveTextContent('3 queued');
    // Nothing waiting is nothing to say — the backlog is the only signal.
    expect(screen.queryByTestId('job-queued-clear')).toBeNull();
    expect(screen.queryByTestId('job-queued-plain')).toBeNull();
  });

  it('links each job row to its chat (ensure→jobchat, message→chatId, spawn→latest run chat)', async () => {
    const json = (o: unknown) =>
      new Response(JSON.stringify(o), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    vi.unstubAllGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes('/runs?limit=')) return json({ runs: [] });
        return json({
          jobs: [
            {
              id: 'en',
              name: 'ensure-job',
              enabled: true,
              trigger: { type: 'cron', expression: '* * * * *' },
              filter: null,
              action: { type: 'continue', daemonId: 'd1', folder: '~/p', skill: 'why' },
              createdAt: 1,
              updatedAt: 1,
            },
            {
              id: 'msg',
              name: 'msg-job',
              enabled: true,
              trigger: { type: 'cron', expression: '* * * * *' },
              filter: null,
              action: { type: 'message', chatId: 'thread_manager', prompt: 'go' },
              createdAt: 1,
              updatedAt: 1,
            },
            {
              id: 'sp',
              name: 'spawn-job',
              enabled: true,
              trigger: { type: 'cron', expression: '* * * * *' },
              filter: null,
              action: { type: 'spawn', daemonId: 'd1', folder: '~/p', skill: 'bus' },
              createdAt: 1,
              updatedAt: 1,
              // The spawn job's latest run carries the per-fire chatId.
              latestRun: { ts: Date.now(), status: 'ok', chatId: 'c_spawn_latest' },
            },
          ],
        });
      }),
    );
    renderJobs();
    // ensure → its deterministic persistent chat
    await waitFor(() =>
      expect(screen.getByTestId('job-chat-en')).toHaveAttribute('href', '/chats/jobchat-en'),
    );
    // message → the fixed target chat
    expect(screen.getByTestId('job-chat-msg')).toHaveAttribute('href', '/chats/thread_manager');
    // spawn → the most-recent run's chat
    await waitFor(() =>
      expect(screen.getByTestId('job-chat-sp')).toHaveAttribute('href', '/chats/c_spawn_latest'),
    );
  });

  it('marks a disabled job and renders its toggle as disabled', async () => {
    renderJobs();
    await waitFor(() => expect(screen.getByTestId('job-gh')).toBeInTheDocument());
    expect(screen.getByTestId('job-gh')).toHaveClass('disabled');
    expect(screen.getByTestId('job-toggle-gh')).not.toBeChecked();
  });

  it('shows last-fired and expands an inline runs panel on demand', async () => {
    renderJobs();
    await waitFor(() => expect(screen.getByTestId('job-last-fired-bus')).toHaveTextContent(/ago/));
    // panel not shown until toggled
    expect(screen.queryByTestId('inline-runs-bus')).toBeNull();
    fireEvent.click(screen.getByTestId('job-runs-toggle-bus'));
    await waitFor(() =>
      expect(screen.getByTestId('inline-runs-bus')).toHaveTextContent('dispatch-error'),
    );
  });

  // G2-d8: the "last fired" column must use ONE consistent format for every
  // row — never a mix of relative ("22h ago"), absolute ("06/06/2026") and
  // "never". An old run (> 1 week) must still render relatively, not as an
  // absolute date.
  it('renders the last-fired cell relatively even for old runs, never an absolute date (G2-d8)', async () => {
    const oldTs = Date.now() - 40 * 86_400_000; // ~40 days ago
    vi.unstubAllGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes('/runs?limit=1')) {
          return new Response(
            JSON.stringify({ runs: [{ ts: oldTs, jobId: 'bus', status: 'ok', trigger: 'cron' }] }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          );
        }
        if (u.includes('/runs?limit=')) {
          return new Response(JSON.stringify(RUNS_PANEL), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        // Only the unrun job + the old-run job.
        return new Response(
          JSON.stringify({
            jobs: [
              { ...JOBS.jobs[0], id: 'old', name: 'old-job' },
              { ...JOBS.jobs[0], id: 'unrun', name: 'unrun-job' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    renderJobs();
    await waitFor(() => expect(screen.getByTestId('job-last-fired-old')).toHaveTextContent(/ago$/));
    const text = screen.getByTestId('job-last-fired-old').textContent ?? '';
    // Relative, not an absolute DD/MM/YYYY (no slashes, no year digits as a date).
    expect(text).toMatch(/ago$/);
    expect(text).not.toMatch(/\d{2}\/\d{2}\/\d{4}/);
  });

  it('shows "never" only for jobs with no runs, alongside relative for others (G2-d8)', async () => {
    const recentTs = Date.now() - 3_600_000;
    vi.unstubAllGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes('/runs?limit=')) {
          return new Response(JSON.stringify({ runs: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        // The recent job has a run; the unrun job reports null for never.
        return new Response(
          JSON.stringify({
            jobs: [
              {
                ...JOBS.jobs[0],
                id: 'recent',
                name: 'recent-job',
                latestRun: { ts: recentTs, status: 'ok' },
              },
              { ...JOBS.jobs[0], id: 'unrun', name: 'unrun-job', latestRun: null },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    renderJobs();
    await waitFor(() =>
      expect(screen.getByTestId('job-last-fired-recent')).toHaveTextContent(/ago/),
    );
    expect(screen.getByTestId('job-last-fired-unrun').textContent).toBe('never');
  });

  it('shows a loading state before the jobs list resolves', async () => {
    let resolveFetch!: (r: Response) => void;
    vi.unstubAllGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((r) => {
            resolveFetch = r;
          }),
      ),
    );
    renderJobs();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    resolveFetch(
      new Response(JSON.stringify({ jobs: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
  });

  it('shows an error state with Retry on a load failure', async () => {
    vi.unstubAllGlobals();
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    });
    vi.stubGlobal('fetch', fetchMock);
    renderJobs();
    await waitFor(() => {
      expect(screen.getByTestId('jobs-error')).toHaveTextContent('network down');
    });
    fetchMock.mockClear();
    fireEvent.click(screen.getByText('Retry'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });

  it('G1: shows a graphic empty state, centred, when there are no jobs', async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ jobs: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    renderJobs();
    // The empty state renders under its own testid with an on-brand graphic.
    const empty = await screen.findByTestId('jobs-empty');
    expect(empty).toBeInTheDocument();
    expect(empty.querySelector('svg')).toBeInTheDocument();
    // Centred both axes like the empty-chat state (flex column, centre-aligned).
    // The empty state reuses the shared `.empty-chat` layout primitive, whose
    // rule sets align-items/justify-content: center (asserted structurally here
    // since jsdom doesn't compute the stylesheet).
    expect(empty).toHaveClass('empty-chat');
  });

  it('the New job link points at /jobs/new', async () => {
    renderJobs();
    await waitFor(() => expect(screen.getByTestId('job-bus')).toBeInTheDocument());
    expect(screen.getByTestId('jobs-new')).toHaveAttribute('href', '/jobs/new');
  });

  it('Run now on a row POSTs /api/jobs/:id/run and lands on the job (spec/14 § Jobs view)', async () => {
    renderJobs();
    await waitFor(() => expect(screen.getByTestId('job-gh')).toBeInTheDocument());
    // Works on a disabled job, like the editor's Run now.
    fireEvent.click(screen.getByTestId('job-run-now-gh'));
    await waitFor(() => {
      const hit = vi.mocked(fetch).mock.calls.find(([u]) => String(u).includes('/api/jobs/gh/run'));
      expect(hit).toBeDefined();
      expect((hit?.[1] as RequestInit).method).toBe('POST');
    });
    // Success takes the user to that job's page.
    await waitFor(() => expect(screen.getByTestId('job-page')).toBeInTheDocument());
    expect(useUiStore.getState().errors.length).toBe(0);
  });

  it('Run now failure surfaces "run now failed: …"', async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes('/run') && !u.includes('/runs')) {
          return new Response(JSON.stringify({ error: 'no host' }), { status: 500 });
        }
        return new Response(JSON.stringify(JOBS), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    useUiStore.getState().clearToasts();
    renderJobs();
    await waitFor(() => expect(screen.getByTestId('job-bus')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('job-run-now-bus'));
    await waitFor(() => {
      expect(useUiStore.getState().errors[0]?.message).toContain('Run now failed');
    });
  });

  it('toggling a job calls enable/disable and refetches the list', async () => {
    renderJobs();
    await waitFor(() => expect(screen.getByTestId('job-bus')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('job-toggle-bus'));
    await waitFor(() => {
      const fetchMock = vi.mocked(fetch);
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/disable'))).toBe(true);
    });
  });

  it('toggling a disabled job calls the enable endpoint', async () => {
    renderJobs();
    await waitFor(() => expect(screen.getByTestId('job-gh')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('job-toggle-gh'));
    await waitFor(() => {
      const fetchMock = vi.mocked(fetch);
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/enable'))).toBe(true);
    });
  });

  it('surfaces a toast when the enable/disable mutation fails', async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes('/disable') || u.includes('/enable')) {
          return new Response(JSON.stringify({ error: 'db locked' }), { status: 500 });
        }
        if (u.includes('/runs?limit=')) {
          return new Response(JSON.stringify({ runs: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify(JOBS), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    useUiStore.getState().clearToasts();
    renderJobs();
    await waitFor(() => expect(screen.getByTestId('job-bus')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('job-toggle-bus'));
    await waitFor(() => {
      expect(useUiStore.getState().errors[0]?.message).toContain('Toggle failed');
    });
  });

  it('inline runs: shows an error message when the runs query fails', async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes('/runs?limit=8')) {
          return new Response(JSON.stringify({ error: 'boom' }), { status: 500 });
        }
        if (u.includes('/runs?limit=')) {
          return new Response(JSON.stringify({ runs: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify(JOBS), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    renderJobs();
    await waitFor(() => expect(screen.getByTestId('job-bus')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('job-runs-toggle-bus'));
    await waitFor(() => {
      expect(screen.getByTestId('inline-runs-bus')).toHaveTextContent('failed to load runs');
    });
  });

  it('inline runs: shows "No runs yet." when the panel has none, and toggles closed again', async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes('/runs?limit=')) {
          return new Response(JSON.stringify({ runs: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify(JOBS), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    renderJobs();
    await waitFor(() => expect(screen.getByTestId('job-bus')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('job-runs-toggle-bus'));
    await waitFor(() => {
      expect(screen.getByTestId('inline-runs-bus')).toHaveTextContent('No runs yet.');
    });
    fireEvent.click(screen.getByTestId('job-runs-toggle-bus'));
    expect(screen.queryByTestId('inline-runs-bus')).toBeNull();
  });

  it('inline runs: renders a run-chat-link when a run action carries a chatId, and a run-error when present', async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes('/runs?limit=8')) {
          return new Response(
            JSON.stringify({
              runs: [
                {
                  ts: Date.now(),
                  jobId: 'bus',
                  status: 'dispatch-error',
                  trigger: 'cron',
                  error: 'dispatch failed',
                  action: { type: 'spawn', chatId: 'c-run-1' },
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (u.includes('/runs?limit=')) {
          return new Response(JSON.stringify({ runs: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify(JOBS), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    renderJobs();
    await waitFor(() => expect(screen.getByTestId('job-bus')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('job-runs-toggle-bus'));
    await waitFor(() => {
      expect(screen.getByTestId('inline-runs-bus')).toHaveTextContent('dispatch failed');
    });
    const panel = screen.getByTestId('inline-runs-bus');
    const link = panel.querySelector('.run-chat-link');
    expect(link).toHaveAttribute('href', '/chats/c-run-1');
  });

  it('relativeTime: covers just-now, minutes, hours, weeks, months, years, and future (scheduled)', async () => {
    const now = Date.now();
    vi.unstubAllGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        const tsFor: Record<string, number> = {
          just_now: now - 1000,
          minutes: now - 5 * 60_000,
          hours: now - 5 * 3_600_000,
          days: now - 3 * 86_400_000,
          weeks: now - 10 * 86_400_000,
          months: now - 60 * 86_400_000,
          years: now - 400 * 86_400_000,
          future: now + 3_600_000,
        };
        if (u.includes('/runs?limit=')) {
          return new Response(JSON.stringify({ runs: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(
          JSON.stringify({
            jobs: Object.entries(tsFor).map(([id, ts]) => ({
              ...JOBS.jobs[0],
              id,
              name: id,
              latestRun: { ts, status: 'ok' },
            })),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    renderJobs();
    await waitFor(() =>
      expect(screen.getByTestId('job-last-fired-just_now')).toHaveTextContent('just now'),
    );
    expect(screen.getByTestId('job-last-fired-minutes')).toHaveTextContent(/^\d+m ago$/);
    expect(screen.getByTestId('job-last-fired-hours')).toHaveTextContent(/^\d+h ago$/);
    expect(screen.getByTestId('job-last-fired-days')).toHaveTextContent(/^\d+d ago$/);
    expect(screen.getByTestId('job-last-fired-weeks')).toHaveTextContent(/^\d+w ago$/);
    expect(screen.getByTestId('job-last-fired-months')).toHaveTextContent(/^\d+mo ago$/);
    expect(screen.getByTestId('job-last-fired-years')).toHaveTextContent(/^\d+y ago$/);
    expect(screen.getByTestId('job-last-fired-future')).toHaveTextContent('scheduled');
  });
});

// Search (spec/14 § Jobs view): one field narrows the list as you type, over
// the job name, the natural-language trigger label and the action verb+target.
describe('JobsRoute search', () => {
  beforeEach(() => vi.stubGlobal('fetch', makeFetch()));
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function type(value: string) {
    fireEvent.change(screen.getByTestId('jobs-search'), { target: { value } });
  }

  it('narrows the list by job name', async () => {
    renderJobs();
    await waitFor(() => expect(screen.getByTestId('job-bus')).toBeInTheDocument());
    type('github');
    expect(screen.getByTestId('job-gh')).toBeInTheDocument();
    expect(screen.queryByTestId('job-bus')).toBeNull();
  });

  it('narrows by trigger type via the natural-language trigger label', async () => {
    renderJobs();
    await waitFor(() => expect(screen.getByTestId('job-bus')).toBeInTheDocument());
    // "github webhook" is the rendered trigger label for the gh job.
    type('webhook');
    expect(screen.getByTestId('job-gh')).toBeInTheDocument();
    expect(screen.queryByTestId('job-bus')).toBeNull();
    // "weekdays at 8:57am" is the bus job's cron label.
    type('weekdays');
    expect(screen.getByTestId('job-bus')).toBeInTheDocument();
    expect(screen.queryByTestId('job-gh')).toBeNull();
  });

  it('narrows by the action verb and by the action target', async () => {
    renderJobs();
    await waitFor(() => expect(screen.getByTestId('job-bus')).toBeInTheDocument());
    // verb axis
    type('spawn');
    expect(screen.getByTestId('job-bus')).toBeInTheDocument();
    expect(screen.queryByTestId('job-gh')).toBeNull();
    // target axis — the skill the job runs
    type('bus-watch');
    expect(screen.getByTestId('job-bus')).toBeInTheDocument();
    expect(screen.queryByTestId('job-gh')).toBeNull();
    // target axis — a prompt target
    type('summarise the merge');
    expect(screen.getByTestId('job-gh')).toBeInTheDocument();
    expect(screen.queryByTestId('job-bus')).toBeNull();
  });

  // A spawn/continue action is folder-addressed — the fire always lands in
  // that folder, skill or no skill — so the folder rides alongside the skill
  // on the row (spec/14 § Jobs view) and the search that matches what the row
  // shows finds it too. Matching only what the row shows still holds: this is
  // no longer "hidden" data once the row displays it.
  it('matches on the folder a spawn/continue action runs in', async () => {
    renderJobs();
    await waitFor(() => expect(screen.getByTestId('job-bus')).toBeInTheDocument());
    expect(screen.getByTestId('job-action-bus')).toHaveTextContent('~/p');
    type('~/p');
    expect(screen.getByTestId('job-bus')).toBeInTheDocument();
    expect(screen.queryByTestId('job-gh')).toBeNull();
  });

  it('matches case-insensitively and ignores surrounding whitespace', async () => {
    renderJobs();
    await waitFor(() => expect(screen.getByTestId('job-bus')).toBeInTheDocument());
    type('  GitHub  ');
    expect(screen.getByTestId('job-gh')).toBeInTheDocument();
    expect(screen.queryByTestId('job-bus')).toBeNull();
  });

  it('restores the full list when the query is cleared', async () => {
    renderJobs();
    await waitFor(() => expect(screen.getByTestId('job-bus')).toBeInTheDocument());
    type('github');
    expect(screen.queryByTestId('job-bus')).toBeNull();
    type('');
    expect(screen.getByTestId('job-bus')).toBeInTheDocument();
    expect(screen.getByTestId('job-gh')).toBeInTheDocument();
  });

  it('says a query matched nothing, keeps the field, and does not show the empty-jobs graphic', async () => {
    renderJobs();
    await waitFor(() => expect(screen.getByTestId('job-bus')).toBeInTheDocument());
    type('nothing matches this');
    expect(screen.getByTestId('jobs-no-matches')).toBeInTheDocument();
    // The field must survive so the query can be corrected rather than retyped.
    expect(screen.getByTestId('jobs-search')).toHaveValue('nothing matches this');
    // "No jobs yet" would misreport a filtered list as an empty account.
    expect(screen.queryByTestId('jobs-empty')).toBeNull();
    expect(screen.queryByTestId('jobs-list')).toBeNull();
  });

  it('draws no search field when there are no jobs to search', async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ jobs: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    renderJobs();
    await waitFor(() => expect(screen.getByTestId('jobs-empty')).toBeInTheDocument());
    expect(screen.queryByTestId('jobs-search')).toBeNull();
  });

  it('draws no search field while the list is still loading', async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    );
    renderJobs();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(screen.queryByTestId('jobs-search')).toBeNull();
  });
});

// Sort + filter (spec/14 § Jobs view): three compact controls beside the
// search. Sort orders the rows within each section; the two filter axes narrow
// on status and trigger type; all of them compose with the search by AND.
const SORTABLE = {
  jobs: [
    {
      id: 'alpha',
      name: 'alpha watcher',
      enabled: true,
      trigger: { type: 'cron', expression: '0 9 * * *' },
      filter: null,
      action: { type: 'spawn', daemonId: 'd1', folder: '~/p', skill: 'alpha' },
      createdAt: 100,
      updatedAt: 100,
      latestRun: { ts: 1_000, status: 'ok' },
    },
    {
      id: 'zulu',
      name: 'zulu hook',
      enabled: false,
      trigger: { type: 'webhook', scheme: 'github' },
      filter: null,
      action: { type: 'spawn', daemonId: 'd1', folder: '~/p', skill: 'zulu' },
      createdAt: 300,
      updatedAt: 300,
      latestRun: { ts: 3_000, status: 'ok' },
    },
    {
      id: 'mike',
      name: 'mike todoist',
      enabled: true,
      trigger: { type: 'todoist', filter: null },
      filter: null,
      action: { type: 'spawn', daemonId: 'd1', folder: '~/p', skill: 'mike' },
      createdAt: 200,
      updatedAt: 200,
      latestRun: null,
    },
  ],
};

function stubJobs(jobs: unknown) {
  vi.unstubAllGlobals();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      const body = String(url).includes('/runs?limit=') ? { runs: [] } : jobs;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

/** The rows as drawn, top to bottom, by job id. */
function rowOrder(testid = 'jobs-list'): string[] {
  return Array.from(screen.getByTestId(testid).querySelectorAll('li.job-row')).map((li) =>
    (li.getAttribute('data-testid') ?? '').replace(/^job-/, ''),
  );
}

describe('JobsRoute sort and filter', () => {
  beforeEach(() => {
    // Session state on the store, so it must start from the default in every
    // test rather than inheriting the previous one's choice.
    useUiStore.getState().setJobsSort('last-fired');
    useUiStore.getState().setJobsFilter({ status: 'all', trigger: 'all' });
    stubJobs(SORTABLE);
  });
  afterEach(() => {
    useUiStore.getState().setJobsSort('last-fired');
    useUiStore.getState().setJobsFilter({ status: 'all', trigger: 'all' });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function choose(testid: string, value: string) {
    fireEvent.change(screen.getByTestId(testid), { target: { value } });
  }

  it('draws the three controls beside the search, each labelled without a caption', async () => {
    renderJobs();
    await waitFor(() => expect(screen.getByTestId('jobs-sort')).toBeInTheDocument());
    expect(screen.getByTestId('jobs-filter-status')).toBeInTheDocument();
    expect(screen.getByTestId('jobs-filter-trigger')).toBeInTheDocument();
    // All three sit in the page head, alongside the search field.
    const head = screen.getByTestId('jobs-route').querySelector('.route-head')!;
    for (const id of ['jobs-search', 'jobs-sort', 'jobs-filter-status', 'jobs-filter-trigger']) {
      expect(head.contains(screen.getByTestId(id))).toBe(true);
    }
    // Each names itself through its options; nothing else is written beside it.
    expect(screen.getByTestId('jobs-sort')).toHaveValue('last-fired');
    expect(screen.getByTestId('jobs-filter-status')).toHaveValue('all');
    expect(screen.getByTestId('jobs-filter-trigger')).toHaveValue('all');
    expect(head.textContent).not.toMatch(/Sort by|Filter by|Showing/);
  });

  it('defaults to last fired: newest fire first, never-fired last', async () => {
    renderJobs();
    await waitFor(() => expect(screen.getByTestId('job-alpha')).toBeInTheDocument());
    expect(rowOrder()).toEqual(['zulu', 'alpha', 'mike']);
  });

  it('changing the sort changes the rendered order', async () => {
    renderJobs();
    await waitFor(() => expect(screen.getByTestId('job-alpha')).toBeInTheDocument());
    choose('jobs-sort', 'name');
    expect(rowOrder()).toEqual(['alpha', 'mike', 'zulu']);
    choose('jobs-sort', 'created');
    expect(rowOrder()).toEqual(['zulu', 'mike', 'alpha']);
    choose('jobs-sort', 'last-fired');
    expect(rowOrder()).toEqual(['zulu', 'alpha', 'mike']);
  });

  it('sorts inside a section without moving the sections themselves', async () => {
    // One recurring job and two one-off jobs: the one-off section stays second
    // whichever way its own rows are ordered.
    stubJobs({
      jobs: [
        { ...SORTABLE.jobs[0], id: 'rec', name: 'recurring one' },
        { ...SORTABLE.jobs[1], id: 'one_b', name: 'b one-off', oneOff: true },
        { ...SORTABLE.jobs[2], id: 'one_a', name: 'a one-off', oneOff: true },
      ],
    });
    renderJobs();
    await waitFor(() => expect(screen.getByTestId('job-rec')).toBeInTheDocument());
    const sections = () =>
      Array.from(screen.getByTestId('jobs-route').querySelectorAll('section.jobs-section')).map(
        (s) => s.getAttribute('data-testid'),
      );
    expect(sections()).toEqual(['jobs-section-recurring', 'jobs-section-one-off']);
    expect(rowOrder('jobs-list-one-off')).toEqual(['one_b', 'one_a']);
    choose('jobs-sort', 'name');
    expect(sections()).toEqual(['jobs-section-recurring', 'jobs-section-one-off']);
    expect(rowOrder('jobs-list-one-off')).toEqual(['one_a', 'one_b']);
    expect(rowOrder('jobs-list')).toEqual(['rec']);
  });

  it('narrows to enabled or disabled jobs', async () => {
    renderJobs();
    await waitFor(() => expect(screen.getByTestId('job-alpha')).toBeInTheDocument());
    choose('jobs-filter-status', 'disabled');
    expect(rowOrder()).toEqual(['zulu']);
    choose('jobs-filter-status', 'enabled');
    expect(rowOrder()).toEqual(['alpha', 'mike']);
    choose('jobs-filter-status', 'all');
    expect(rowOrder()).toEqual(['zulu', 'alpha', 'mike']);
  });

  it('narrows to a trigger type', async () => {
    renderJobs();
    await waitFor(() => expect(screen.getByTestId('job-alpha')).toBeInTheDocument());
    choose('jobs-filter-trigger', 'cron');
    expect(rowOrder()).toEqual(['alpha']);
    choose('jobs-filter-trigger', 'webhook');
    expect(rowOrder()).toEqual(['zulu']);
    choose('jobs-filter-trigger', 'todoist');
    expect(rowOrder()).toEqual(['mike']);
  });

  it('narrows on status and trigger type together', async () => {
    renderJobs();
    await waitFor(() => expect(screen.getByTestId('job-alpha')).toBeInTheDocument());
    choose('jobs-filter-status', 'enabled');
    choose('jobs-filter-trigger', 'todoist');
    expect(rowOrder()).toEqual(['mike']);
  });

  it('composes with the search field by AND', async () => {
    renderJobs();
    await waitFor(() => expect(screen.getByTestId('job-alpha')).toBeInTheDocument());
    // The query alone keeps two spawn jobs on cron/todoist triggers...
    fireEvent.change(screen.getByTestId('jobs-search'), { target: { value: 'spawn' } });
    expect(rowOrder()).toEqual(['zulu', 'alpha', 'mike']);
    // ...and the filter cuts that down without widening it back out.
    choose('jobs-filter-status', 'enabled');
    expect(rowOrder()).toEqual(['alpha', 'mike']);
    // A query that excludes the only job the filter would have kept is empty.
    fireEvent.change(screen.getByTestId('jobs-search'), { target: { value: 'zulu' } });
    expect(screen.getByTestId('jobs-no-matches')).toBeInTheDocument();
  });

  it('says the FILTER matched nothing when there is no query, keeping the controls', async () => {
    renderJobs();
    await waitFor(() => expect(screen.getByTestId('job-alpha')).toBeInTheDocument());
    choose('jobs-filter-status', 'disabled');
    choose('jobs-filter-trigger', 'todoist');
    const none = screen.getByTestId('jobs-no-matches');
    expect(none).toHaveTextContent('No jobs match the filter');
    // Not reported as an empty query, and not the empty-account graphic.
    expect(none.textContent).not.toContain('“');
    expect(screen.queryByTestId('jobs-empty')).toBeNull();
    // The controls survive so the narrowing can be undone.
    expect(screen.getByTestId('jobs-filter-status')).toHaveValue('disabled');
    expect(screen.getByTestId('jobs-sort')).toBeInTheDocument();
  });

  it('names both causes when a query AND a filter are narrowing', async () => {
    renderJobs();
    await waitFor(() => expect(screen.getByTestId('job-alpha')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('jobs-search'), { target: { value: 'alpha' } });
    choose('jobs-filter-status', 'disabled');
    expect(screen.getByTestId('jobs-no-matches')).toHaveTextContent('“alpha” and the filter');
  });

  it('keeps sort and filter across a remount, as session state', async () => {
    const first = renderJobs();
    await waitFor(() => expect(screen.getByTestId('job-alpha')).toBeInTheDocument());
    choose('jobs-sort', 'name');
    choose('jobs-filter-trigger', 'cron');
    first.unmount();
    renderJobs();
    await waitFor(() => expect(screen.getByTestId('jobs-sort')).toHaveValue('name'));
    expect(screen.getByTestId('jobs-filter-trigger')).toHaveValue('cron');
    expect(rowOrder()).toEqual(['alpha']);
  });

  it('draws no sort or filter controls when there are no jobs', async () => {
    stubJobs({ jobs: [] });
    renderJobs();
    await waitFor(() => expect(screen.getByTestId('jobs-empty')).toBeInTheDocument());
    expect(screen.queryByTestId('jobs-sort')).toBeNull();
    expect(screen.queryByTestId('jobs-filter-status')).toBeNull();
    expect(screen.queryByTestId('jobs-filter-trigger')).toBeNull();
  });
});

describe('JobsRoute user-defined groups', () => {
  beforeEach(() => clearHosts());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    clearHosts();
  });

  it('draws no group headers when every job in a section shares one group', async () => {
    stubJobs({
      jobs: [
        { ...SORTABLE.jobs[0], id: 'a', group: 'Home' },
        { ...SORTABLE.jobs[2], id: 'b', group: 'Home' },
      ],
    });
    renderJobs();
    await waitFor(() => expect(screen.getByTestId('job-a')).toBeInTheDocument());
    expect(screen.queryByTestId('jobs-user-group-jobs-list-Home')).toBeNull();
  });

  it('draws no group headers when no job in a section has a group', async () => {
    stubJobs({ jobs: [SORTABLE.jobs[0], SORTABLE.jobs[2]] });
    renderJobs();
    await waitFor(() =>
      expect(screen.getByTestId(`job-${SORTABLE.jobs[0]?.id}`)).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('jobs-user-group-jobs-list-ungrouped')).toBeNull();
  });

  it('sub-divides a section into headed buckets by group, ungrouped last', async () => {
    stubJobs({
      jobs: [
        { ...SORTABLE.jobs[0], id: 'a', group: 'Home' }, // name: "alpha watcher"
        { ...SORTABLE.jobs[2], id: 'b' }, // name: "mike todoist"
        { ...SORTABLE.jobs[1], id: 'c', group: 'Finance', enabled: true }, // name: "zulu hook"
      ],
    });
    renderJobs();
    await waitFor(() => expect(screen.getByTestId('job-a')).toBeInTheDocument());
    expect(screen.getByTestId('jobs-user-group-jobs-list-Home')).toHaveTextContent('Home');
    expect(screen.getByTestId('jobs-user-group-jobs-list-Finance')).toHaveTextContent('Finance');
    expect(screen.getByTestId('jobs-user-group-jobs-list-ungrouped')).toHaveTextContent(
      'Ungrouped',
    );
    // Sort name-ascending first, so bucket order (by first appearance: Home,
    // Finance, then ungrouped forced last) is deterministic regardless of
    // whatever this suite's default sort happens to be.
    fireEvent.change(screen.getByTestId('jobs-sort'), { target: { value: 'name' } });
    expect(rowOrder()).toEqual(['a', 'c', 'b']);
  });

  it('groups apply independently within each status section', async () => {
    stubJobs({
      jobs: [
        { ...SORTABLE.jobs[0], id: 'rec1', group: 'Home' },
        { ...SORTABLE.jobs[2], id: 'rec2', group: 'Finance' },
        { ...SORTABLE.jobs[1], id: 'one1', oneOff: true, group: 'Home' },
      ],
    });
    renderJobs();
    await waitFor(() => expect(screen.getByTestId('job-rec1')).toBeInTheDocument());
    // The recurring section has two groups, so it gets headers...
    expect(rowOrder('jobs-list')).toEqual(['rec1', 'rec2']);
    expect(screen.getByTestId('jobs-user-group-jobs-list-Home')).toBeInTheDocument();
    // ...but the one-off section has only one job in only one group, so it
    // draws no header of its own even though "Home" exists elsewhere.
    expect(rowOrder('jobs-list-one-off')).toEqual(['one1']);
    expect(screen.queryByTestId('jobs-user-group-jobs-list-one-off-Home')).toBeNull();
  });
});
