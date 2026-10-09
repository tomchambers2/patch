// spec/14 § Jobs view — the cron trigger's Timezone select.
//
// The editor rebuilds the whole trigger on save, so without carrying the zone
// through form state, opening ANY existing job and pressing Save would strip
// its `timezone` and silently move when it fires. That strip is the regression
// these tests exist to catch, alongside the two defaults: a NEW job takes this
// browser's zone, and an EXISTING job with no zone reads back as UTC (exactly
// how the server evaluates it).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { JobEditorRoute, browserTimeZone, timeZoneOptions } from '../routes/JobEditorRoute.js';
import { useUiStore } from '../stores/uiStore.js';
import { useChatStore } from '../stores/chatStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';

const FOLDERS_BODY = {
  hosts: [{ daemonId: 'd1', roots: ['/Users/tom/projects/portfolio'], recent: [] }],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function defaultRoute(url: string): Response {
  if (String(url).includes('/api/folders')) return jsonResponse(FOLDERS_BODY);
  return jsonResponse({});
}

function pick(daemonId: string, folder: string): string {
  return JSON.stringify([daemonId, folder]);
}

function renderNew(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/jobs/new']}>
        <Routes>
          <Route path="/jobs/new" element={<JobEditorRoute />} />
          <Route path="/jobs" element={<div data-testid="jobs-list" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderEdit(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/jobs/j_tz']}>
        <Routes>
          <Route path="/jobs/:id" element={<JobEditorRoute />} />
          <Route path="/jobs" element={<div data-testid="jobs-list" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function storedJob(trigger: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'j_tz',
    name: 'daily email update',
    enabled: true,
    trigger,
    filter: null,
    action: { type: 'spawn', daemonId: 'd1', folder: '/tmp', prompt: 'hi' },
    createdAt: 1,
    updatedAt: 1,
  };
}

/** Serve `job` for GET, record every PATCH body. */
function editFetch(
  job: Record<string, unknown>,
  patches: Array<Record<string, unknown>>,
): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (String(url).includes('/runs')) return jsonResponse({ runs: [] });
    if (String(url).includes('/api/folders')) return jsonResponse(FOLDERS_BODY);
    if (method === 'PATCH') {
      patches.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return jsonResponse({ ...job, updatedAt: 2 });
    }
    return jsonResponse(job);
  });
}

function makeChatRow(chatId: string, folder: string) {
  return {
    pendingWake: null,
    todos: [],
    snoozedUntil: null,
    chatId,
    daemonId: 'd1',
    permissionMode: 'bypassPermissions' as const,
    name: null,
    folder,
    activity: 'idle' as const,
    status: 'active' as const,
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: Date.now(),
    lastUserActivity: Date.now(),
    awaitingPermission: false,
    lastReadSeq: -1,
    preview: null,
    goal: null,
    goalProgress: null,
    lastGoal: null,
    reminder: null,
    statusSummary: null,
    statusKind: null,
    statusDeclared: null,
    pendingPermissions: [],
    lastSeq: 0,
    jobId: null,
    model: null,
    rateLimitResumingAt: null,
    resumeKind: null,
  };
}

describe('cron timezone in the job editor', () => {
  beforeEach(() => {
    usePresenceStore
      .getState()
      .setHosts([{ daemonId: 'd1', online: true, lastSeenAt: null, host: null, accounts: [] }]);
    useUiStore.getState().clearToasts();
    useUiStore.getState().resolveConfirm(false);
    useChatStore.setState({
      chats: { c_seed: makeChatRow('c_seed', '/Users/tom/projects/portfolio') },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('the option list', () => {
    it('pins UTC first — it is the meaning of a trigger with no zone', () => {
      expect(timeZoneOptions()[0]).toBe('UTC');
    });

    it('offers real IANA zones and never duplicates UTC', () => {
      const opts = timeZoneOptions();
      expect(opts).toContain('Europe/London');
      expect(opts.filter((z) => z === 'UTC')).toHaveLength(1);
    });

    it('always contains this browser’s own zone, so opening a job cannot rewrite it', () => {
      expect(timeZoneOptions()).toContain(browserTimeZone());
    });
  });

  it('a NEW job defaults to this browser’s zone and shows it in the readout', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => defaultRoute(String(url))),
    );
    renderNew();
    const select = screen.getByTestId('job-cron-timezone') as HTMLSelectElement;
    expect(select.value).toBe(browserTimeZone());
    expect(screen.getByTestId('job-cron-timezone-value')).toHaveTextContent(browserTimeZone());
  });

  it('posts the chosen zone alongside the UNCHANGED expression', async () => {
    const calls: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes('/api/jobs') && (init?.method ?? 'GET').toUpperCase() === 'POST') {
          calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return jsonResponse({ id: 'j_new' }, 201);
        }
        return defaultRoute(String(url));
      }),
    );
    renderNew();
    fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'daily email update' } });
    fireEvent.change(screen.getByTestId('job-cron-timezone'), {
      target: { value: 'Europe/London' },
    });
    const folder = screen.getByTestId('job-spawn-folder') as HTMLSelectElement;
    await waitFor(() => {
      expect(
        [...folder.options].some((o) => o.value === pick('d1', '/Users/tom/projects/portfolio')),
      ).toBe(true);
    });
    fireEvent.change(folder, { target: { value: pick('d1', '/Users/tom/projects/portfolio') } });
    fireEvent.change(screen.getByTestId('job-spawn-prompt'), { target: { value: 'go' } });
    fireEvent.click(screen.getByTestId('job-save'));
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]?.['trigger']).toEqual({
      type: 'cron',
      expression: '0 9 * * *',
      timezone: 'Europe/London',
    });
  });

  it('selecting UTC OMITS the field — the body stays byte-identical to a pre-timezone job', async () => {
    const calls: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes('/api/jobs') && (init?.method ?? 'GET').toUpperCase() === 'POST') {
          calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return jsonResponse({ id: 'j_new' }, 201);
        }
        return defaultRoute(String(url));
      }),
    );
    renderNew();
    fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'utc job' } });
    fireEvent.change(screen.getByTestId('job-cron-timezone'), { target: { value: 'UTC' } });
    const folder = screen.getByTestId('job-spawn-folder') as HTMLSelectElement;
    await waitFor(() => {
      expect(
        [...folder.options].some((o) => o.value === pick('d1', '/Users/tom/projects/portfolio')),
      ).toBe(true);
    });
    fireEvent.change(folder, { target: { value: pick('d1', '/Users/tom/projects/portfolio') } });
    fireEvent.change(screen.getByTestId('job-spawn-prompt'), { target: { value: 'go' } });
    fireEvent.click(screen.getByTestId('job-save'));
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]?.['trigger']).toEqual({ type: 'cron', expression: '0 9 * * *' });
  });

  it('an EXISTING zoned job loads its zone into the select', async () => {
    vi.stubGlobal(
      'fetch',
      editFetch(
        storedJob({ type: 'cron', expression: '0 9 * * *', timezone: 'Europe/London' }),
        [],
      ),
    );
    renderEdit();
    await screen.findByTestId('job-name');
    await waitFor(() => {
      expect((screen.getByTestId('job-cron-timezone') as HTMLSelectElement).value).toBe(
        'Europe/London',
      );
    });
  });

  // The strip regression: this is what made every unrelated edit dangerous.
  it('re-saving an untouched zoned job PRESERVES its zone', async () => {
    const patches: Array<Record<string, unknown>> = [];
    const job = storedJob({ type: 'cron', expression: '0 9 * * *', timezone: 'Europe/London' });
    vi.stubGlobal('fetch', editFetch(job, patches));
    renderEdit();
    await screen.findByTestId('job-name');
    await waitFor(() => {
      expect((screen.getByTestId('job-cron-timezone') as HTMLSelectElement).value).toBe(
        'Europe/London',
      );
    });
    // Change something completely unrelated, then save.
    fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'renamed' } });
    fireEvent.click(screen.getByTestId('job-save'));
    await waitFor(() => expect(patches.length).toBe(1));
    expect(patches[0]?.['trigger']).toEqual({
      type: 'cron',
      expression: '0 9 * * *',
      timezone: 'Europe/London',
    });
  });

  it('an EXISTING job with NO zone reads back as UTC and re-saves with no zone', async () => {
    const patches: Array<Record<string, unknown>> = [];
    const job = storedJob({ type: 'cron', expression: '0 9 * * *' });
    vi.stubGlobal('fetch', editFetch(job, patches));
    renderEdit();
    await screen.findByTestId('job-name');
    await waitFor(() => {
      expect((screen.getByTestId('job-cron-timezone') as HTMLSelectElement).value).toBe('UTC');
    });
    fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'renamed' } });
    fireEvent.click(screen.getByTestId('job-save'));
    await waitFor(() => expect(patches.length).toBe(1));
    expect(patches[0]?.['trigger']).toEqual({ type: 'cron', expression: '0 9 * * *' });
  });

  it('changing an existing job’s zone patches the new zone through', async () => {
    const patches: Array<Record<string, unknown>> = [];
    const job = storedJob({ type: 'cron', expression: '0 9 * * *' });
    vi.stubGlobal('fetch', editFetch(job, patches));
    renderEdit();
    await screen.findByTestId('job-name');
    await waitFor(() => {
      expect((screen.getByTestId('job-cron-timezone') as HTMLSelectElement).value).toBe('UTC');
    });
    fireEvent.change(screen.getByTestId('job-cron-timezone'), {
      target: { value: 'Europe/London' },
    });
    fireEvent.click(screen.getByTestId('job-save'));
    await waitFor(() => expect(patches.length).toBe(1));
    expect(patches[0]?.['trigger']).toEqual({
      type: 'cron',
      expression: '0 9 * * *',
      timezone: 'Europe/London',
    });
  });

  it('the Timezone field belongs to cron only — switching trigger type hides it', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => defaultRoute(String(url))),
    );
    renderNew();
    expect(screen.getByTestId('job-cron-timezone')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('job-trigger-type'), { target: { value: 'webhook' } });
    expect(screen.queryByTestId('job-cron-timezone')).toBeNull();
  });
});
