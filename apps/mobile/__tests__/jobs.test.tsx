// Jobs list screen (spec/15 § Settings tab — Jobs). Standalone
// screen with its own header (Back / title / New), loading text, empty
// state, and job rows with enable/disable toggles — mirrors JobList's
// logic (normalise/toggle) but is a SEPARATE component under
// app/(tabs)/jobs.tsx, so its own render tree needs its own coverage.
// Re-fetches on focus (useFocusEffect fires once on mount under the
// expo-router stub).

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Jobs from '../app/(tabs)/jobs';
import {
  renderRN,
  findHost,
  findAllHost,
  byTestId,
  byType,
  hasText,
  actAsync,
  flush,
} from './testUtils/render';
import { api } from '../src/api/rest';
import { __getLastAlert, __clearLastAlert } from './stubs/react-native';
import { routerMock, __resetRouterMock } from './stubs/expo-router';

vi.mock('../src/api/rest', () => ({
  api: {
    listJobs: vi.fn(),
    enableJob: vi.fn(),
    disableJob: vi.fn(),
  },
}));

/** A promise the test can resolve/reject on demand, to pin the loading state. */
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

beforeEach(() => {
  vi.mocked(api.listJobs).mockReset();
  vi.mocked(api.enableJob).mockReset().mockResolvedValue(undefined);
  vi.mocked(api.disableJob).mockReset().mockResolvedValue(undefined);
  __clearLastAlert();
  __resetRouterMock();
});

describe('Jobs — header', () => {
  // Jobs is a tab root now, not a screen pushed from Settings, so a back
  // control would pop to whatever tab you came from — a dead end, not a parent.
  it('has no Back control: it is a tab root, not a pushed sub-screen', async () => {
    vi.mocked(api.listJobs).mockResolvedValue({ jobs: [] });
    const r = renderRN(<Jobs />);
    await flush();
    expect(findAllHost(r.root, byLabel('Back'))).toHaveLength(0);
  });

  it('New opens the editor in create mode (no id in the path)', async () => {
    vi.mocked(api.listJobs).mockResolvedValue({ jobs: [] });
    const r = renderRN(<Jobs />);
    await flush();
    findHost(r.root, byTestId('job-new')).props.onPress();
    expect(routerMock.push).toHaveBeenCalledWith('/settings/job-editor');
  });

  it('renders the "Jobs" title', async () => {
    vi.mocked(api.listJobs).mockResolvedValue({ jobs: [] });
    const r = renderRN(<Jobs />);
    await flush();
    expect(hasText(r.root, 'Jobs')).toBe(true);
  });
});

function byLabel(label: string): (i: ReturnType<typeof findHost>) => boolean {
  return (i) => i.props['accessibilityLabel'] === label;
}

describe('Jobs — loading + failure', () => {
  it('shows "Loading…" until listJobs settles', async () => {
    const d = deferred<{ jobs: unknown[] }>();
    vi.mocked(api.listJobs).mockReturnValue(d.promise);
    const r = renderRN(<Jobs />);
    expect(hasText(r.root, 'Loading…')).toBe(true);
    await actAsync(async () => {
      d.resolve({ jobs: [] });
      await flush();
    });
    expect(hasText(r.root, 'Loading…')).toBe(false);
  });

  it('surfaces an Alert and stops loading when listJobs rejects', async () => {
    const d = deferred<{ jobs: unknown[] }>();
    vi.mocked(api.listJobs).mockReturnValue(d.promise);
    const r = renderRN(<Jobs />);
    d.promise.catch(() => undefined);
    await actAsync(async () => {
      d.reject(new Error('network down'));
      await flush();
    });
    expect(hasText(r.root, 'Loading…')).toBe(false);
    expect(__getLastAlert()).toEqual({
      title: 'Failed to load jobs',
      message: 'network down',
      buttons: undefined,
    });
  });
});

describe('Jobs — empty state', () => {
  it('renders the jobs EmptyState when there are no jobs', async () => {
    vi.mocked(api.listJobs).mockResolvedValue({ jobs: [] });
    const r = renderRN(<Jobs />);
    await flush();
    expect(findHost(r.root, byTestId('empty-state'))).toBeDefined();
    expect(hasText(r.root, 'No jobs yet')).toBe(true);
  });
});

describe('Jobs — job rows', () => {
  const jobs = [
    {
      id: 'job-1',
      name: 'Morning digest',
      trigger: { type: 'cron', expression: '0 9 * * *' },
      enabled: true,
    },
    // No 'name' → falls back to id. jobId instead of id.
    { jobId: 'job-2', trigger: { type: 'cron', expression: 'not a cron' }, enabled: false },
    // Non-cron trigger type.
    { id: 'job-3', name: 'Manual one', trigger: { type: 'manual' }, enabled: true },
    // No trigger at all.
    { id: 'job-4', name: 'No trigger', enabled: false },
    // Neither 'id' nor 'jobId' → normalise() falls all the way back to ''.
    { name: 'Nameless job', enabled: true },
    // A cron job in a zone that is NOT this box's (UTC) — the row has to say so.
    {
      id: 'job-5',
      name: 'Timesheet',
      trigger: { type: 'cron', expression: '0 9 * * 5', timezone: 'Europe/London' },
      enabled: true,
    },
  ];

  it('renders every row with its resolved name/subtitle/raw-cron line', async () => {
    vi.mocked(api.listJobs).mockResolvedValue({ jobs });
    const r = renderRN(<Jobs />);
    await flush();

    expect(hasText(r.root, 'Morning digest')).toBe(true);
    // describeCron('0 9 * * *') → 'every day at 9am'.
    expect(hasText(r.root, 'every day at 9am')).toBe(true);
    expect(hasText(r.root, '0 9 * * *')).toBe(true); // raw-cron line only for a cron trigger

    // job-2: no 'name' → shows its id; describeCron('not a cron') → '' so
    // falls back to the raw cron string itself for the subtitle too.
    expect(hasText(r.root, 'job-2')).toBe(true);
    expect(hasText(r.root, 'not a cron')).toBe(true);

    // job-5: a job in another zone names it, so "9am" can't be misread as
    // this reader's 9am (spec/08 § Cron). job-1 carries no zone and this box
    // is UTC, so its row (asserted above) stays unqualified.
    expect(hasText(r.root, 'Fridays at 9am · Europe/London')).toBe(true);

    // job-3: non-cron trigger type shown verbatim as the subtitle, no raw-cron line.
    expect(hasText(r.root, 'Manual one')).toBe(true);
    expect(hasText(r.root, 'manual')).toBe(true);

    // job-4: no trigger at all → subtitle falls back to the literal 'trigger'.
    expect(hasText(r.root, 'No trigger')).toBe(true);
    expect(hasText(r.root, 'trigger')).toBe(true);

    // The nameless, id-less job: normalise() falls all the way through
    // `String(j['id'] ?? j['jobId'] ?? '')` to an empty id.
    expect(hasText(r.root, 'Nameless job')).toBe(true);
    expect(findHost(r.root, byTestId('job-row-'))).toBeDefined();

    expect(findHost(r.root, byTestId('job-row-job-1'))).toBeDefined();
  });

  it('tapping a row opens the editor with that job id in the query string', async () => {
    vi.mocked(api.listJobs).mockResolvedValue({ jobs });
    const r = renderRN(<Jobs />);
    await flush();
    findHost(r.root, byTestId('job-row-job-1')).props.onPress();
    expect(routerMock.push).toHaveBeenCalledWith('/settings/job-editor?id=job-1');
  });

  it("toggling a row's Switch OFF optimistically flips only that row and commits via disableJob", async () => {
    vi.mocked(api.listJobs).mockResolvedValue({ jobs });
    const r = renderRN(<Jobs />);
    await flush();
    const otherSwitchesBefore = findAllHost(r.root, byType('Switch'))
      .slice(1)
      .map((s) => s.props.value);
    await actAsync(async () => {
      findAllHost(r.root, byType('Switch'))[0]!.props.onValueChange(false);
      await flush();
    });
    const switchesAfter = findAllHost(r.root, byType('Switch'));
    expect(switchesAfter[0]!.props.value).toBe(false);
    expect(switchesAfter.slice(1).map((s) => s.props.value)).toEqual(otherSwitchesBefore);
    expect(api.disableJob).toHaveBeenCalledWith('job-1');
  });

  it("toggling a disabled row's Switch ON commits via enableJob", async () => {
    vi.mocked(api.listJobs).mockResolvedValue({ jobs });
    const r = renderRN(<Jobs />);
    await flush();
    const job4Switch = (): ReturnType<typeof findHost> => findAllHost(r.root, byType('Switch'))[3]!;
    expect(job4Switch().props.value).toBe(false);
    await actAsync(async () => {
      job4Switch().props.onValueChange(true);
      await flush();
    });
    expect(job4Switch().props.value).toBe(true);
    expect(api.enableJob).toHaveBeenCalledWith('job-4');
  });

  it('reverts ONLY the toggled row and alerts when the commit rejects', async () => {
    vi.mocked(api.listJobs).mockResolvedValue({ jobs });
    vi.mocked(api.disableJob).mockRejectedValue(new Error('server rejected'));
    const r = renderRN(<Jobs />);
    await flush();
    const otherSwitchesBefore = findAllHost(r.root, byType('Switch'))
      .slice(1)
      .map((s) => s.props.value);
    await actAsync(async () => {
      findAllHost(r.root, byType('Switch'))[0]!.props.onValueChange(false);
      await flush();
    });
    const switchesAfter = findAllHost(r.root, byType('Switch'));
    expect(switchesAfter[0]!.props.value).toBe(true); // reverted
    expect(switchesAfter.slice(1).map((s) => s.props.value)).toEqual(otherSwitchesBefore);
    expect(__getLastAlert()).toEqual({
      title: 'Toggle failed',
      message: 'server rejected',
      buttons: undefined,
    });
  });
});
