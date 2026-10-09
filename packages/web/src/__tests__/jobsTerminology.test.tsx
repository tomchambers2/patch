// Guard: the automation feature is called "Jobs" in the web UI.
//
// The backend, the wire types and the `patch_job_*` tools have always called it
// a Job (spec/08 — "A job is a persistent automation"); only the web shell still
// said "Schedules". This test pins the user-facing term so the old label cannot
// creep back in via a copy/paste of the old markup.
//
// Deliberately NARROW: it checks the two surfaces that name the FEATURE — the
// sidebar bottom nav and the jobs list route. The job editor's natural-language
// "Schedule" field is a real cron schedule (spec/14 § Jobs view: "a single
// natural-language Schedule field") and is NOT asserted against here.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Sidebar } from '../components/Sidebar.js';
import { JobsRoute } from '../routes/JobsRoute.js';
import { useChatStore } from '../stores/chatStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';

/** Matches "Schedule"/"Schedules" as a standalone word, case-insensitively. */
const SCHEDULE_WORD = /\bschedules?\b/i;

describe('jobs terminology', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    usePresenceStore.getState().setConnection('connected');
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
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('the sidebar bottom nav says Jobs and links to /jobs', () => {
    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );
    const nav = screen.getByTestId('bottom-nav');
    expect(nav.querySelector('a[href="/jobs"]')).toBeTruthy();
    expect(nav.querySelector('a[href="/schedules"]')).toBeNull();
    expect(nav.textContent ?? '').not.toMatch(SCHEDULE_WORD);
    expect(nav.textContent ?? '').toContain('Jobs');
  });

  it('the jobs route never renders the word "schedule" to the user', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <JobsRoute />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    // Empty state: heading, art and the New job action are all on screen.
    await waitFor(() => expect(screen.getByTestId('jobs-empty')).toBeInTheDocument());
    expect(screen.getByTestId('jobs-route')).toBeInTheDocument();
    expect(container.textContent ?? '').not.toMatch(SCHEDULE_WORD);
    // …including in the accessible names and the links it points at.
    for (const el of container.querySelectorAll('[aria-label]')) {
      expect(el.getAttribute('aria-label') ?? '').not.toMatch(SCHEDULE_WORD);
    }
    for (const a of container.querySelectorAll('a[href]')) {
      expect(a.getAttribute('href') ?? '').not.toContain('/schedules');
    }
  });
});
