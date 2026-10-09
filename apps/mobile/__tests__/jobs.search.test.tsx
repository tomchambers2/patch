// Jobs tab — search (spec/15 § Jobs screen). Same idiom as the archived-chats
// search on the Chats tab: one plain box, instant local filtering, an empty
// state when nothing matches.

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Jobs from '../app/(tabs)/jobs';
import {
  renderRN,
  findHost,
  findAllHost,
  queryHost,
  byTestId,
  hasText,
  actAsync,
  flush,
} from './testUtils/render';
import { api } from '../src/api/rest';
import { __clearLastAlert } from './stubs/react-native';
import { __resetRouterMock } from './stubs/expo-router';
import { EMPTY_STATES } from '../src/lib/emptyStates';
import { JOBS_SEARCH_PLACEHOLDER } from '../src/lib/labels';

vi.mock('../src/api/rest', () => ({
  api: {
    listJobs: vi.fn(),
    enableJob: vi.fn(),
    disableJob: vi.fn(),
  },
}));

const JOBS = [
  {
    id: 'job_morning',
    name: 'Morning brief',
    enabled: true,
    trigger: { type: 'cron', expression: '0 7 * * *' },
  },
  {
    id: 'job_deploy',
    name: 'Deploy pending',
    enabled: true,
    trigger: { type: 'cron', expression: '*/5 * * * *' },
  },
  { id: 'job_hook', name: 'Todoist inbox', enabled: false, trigger: { type: 'webhook' } },
];

beforeEach(() => {
  vi.mocked(api.listJobs).mockReset().mockResolvedValue({ jobs: JOBS });
  vi.mocked(api.enableJob).mockReset().mockResolvedValue(undefined);
  vi.mocked(api.disableJob).mockReset().mockResolvedValue(undefined);
  __clearLastAlert();
  __resetRouterMock();
});

/** Ids of the job rows currently on screen. */
function visibleRowIds(root: Parameters<typeof findAllHost>[0]): string[] {
  return findAllHost(root, (i) => String(i.props['testID'] ?? '').startsWith('job-row-')).map((i) =>
    String(i.props['testID']).replace('job-row-', ''),
  );
}

async function type(r: ReturnType<typeof renderRN>, text: string): Promise<void> {
  const box = findHost(r.root, byTestId('jobs-search'));
  await actAsync(() => {
    (box.props['onChangeText'] as (t: string) => void)(text);
  });
}

describe('Jobs — search', () => {
  it('shows a search box above the list, labelled "Search jobs"', async () => {
    const r = renderRN(<Jobs />);
    await flush();
    const box = findHost(r.root, byTestId('jobs-search'));
    expect(box.props['placeholder']).toBe(JOBS_SEARCH_PLACEHOLDER);
    expect(box.props['accessibilityLabel']).toBe('jobs-search');
    expect(visibleRowIds(r.root)).toEqual(['job_morning', 'job_deploy', 'job_hook']);
  });

  it('filters the list by job name as you type', async () => {
    const r = renderRN(<Jobs />);
    await flush();
    await type(r, 'deploy');
    expect(visibleRowIds(r.root)).toEqual(['job_deploy']);
  });

  it('ignores case and matches a substring', async () => {
    const r = renderRN(<Jobs />);
    await flush();
    await type(r, 'TODOIST');
    expect(visibleRowIds(r.root)).toEqual(['job_hook']);
  });

  it('matches the trigger summary, not just the name', async () => {
    const r = renderRN(<Jobs />);
    await flush();
    await type(r, 'webhook');
    expect(visibleRowIds(r.root)).toEqual(['job_hook']);
  });

  it('shows the no-matches empty state when nothing matches, and restores on clear', async () => {
    const r = renderRN(<Jobs />);
    await flush();
    await type(r, 'zzzz');
    expect(visibleRowIds(r.root)).toEqual([]);
    expect(hasText(r.root, EMPTY_STATES.jobSearch.title)).toBe(true);

    await type(r, '');
    expect(visibleRowIds(r.root)).toEqual(['job_morning', 'job_deploy', 'job_hook']);
  });

  it('keeps the New action reachable while a search is narrowing the list', async () => {
    const r = renderRN(<Jobs />);
    await flush();
    await type(r, 'zzzz');
    expect(queryHost(r.root, byTestId('job-new'))).not.toBeNull();
  });

  it('shows no search box at all when there are no jobs to search', async () => {
    vi.mocked(api.listJobs).mockResolvedValue({ jobs: [] });
    const r = renderRN(<Jobs />);
    await flush();
    expect(queryHost(r.root, byTestId('jobs-search'))).toBeNull();
    expect(hasText(r.root, EMPTY_STATES.jobs.title)).toBe(true);
  });

  // Search is a view over the list, not a different list: toggling a filtered
  // row must still reach the real job.
  it('a toggle on a filtered row still hits the right job', async () => {
    const r = renderRN(<Jobs />);
    await flush();
    await type(r, 'hook');
    const sw = findHost(r.root, (i) => i.type === 'Switch');
    await actAsync(() => {
      (sw.props['onValueChange'] as (v: boolean) => void)(true);
    });
    expect(vi.mocked(api.enableJob)).toHaveBeenCalledWith('job_hook');
  });
});
