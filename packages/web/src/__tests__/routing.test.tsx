// Routing smoke — navigating to /jobs renders the jobs route.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { JobsRoute } from '../routes/JobsRoute.js';

describe('routing', () => {
  beforeEach(() => {
    // Mock fetch — return an empty job list.
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

  it('renders the JobsRoute at /jobs', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/jobs']}>
          <Routes>
            <Route path="/jobs" element={<JobsRoute />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('jobs-route')).toBeInTheDocument();
    });
    expect(screen.getByText('Jobs')).toBeInTheDocument();
  });
});
