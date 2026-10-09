// Render coverage for the reusable job list (spec/15 § Settings tab —
// Jobs: inline list, tap-a-row → onOpen(jobId), an add affordance
// ALWAYS present even with zero jobs). Loads via useFocusEffect (fires once
// on mount under the expo-router stub) — api is mocked so the test controls
// exactly when the listJobs promise resolves, letting us also pin the
// "Loading…" state itself, not just the settled result.

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
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
import { JobList } from '../src/components/JobList';
import { api } from '../src/api/rest';
import { __getLastAlert, __clearLastAlert } from './stubs/react-native';

vi.mock('../src/api/rest', () => ({
  api: {
    listJobs: vi.fn(),
    enableJob: vi.fn(),
    disableJob: vi.fn(),
  },
}));

beforeEach(() => {
  vi.mocked(api.listJobs).mockReset();
  vi.mocked(api.enableJob).mockReset().mockResolvedValue(undefined);
  vi.mocked(api.disableJob).mockReset().mockResolvedValue(undefined);
  __clearLastAlert();
});

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

describe('JobList — loading state', () => {
  it('shows "Loading…" until listJobs settles', async () => {
    const d = deferred<{ jobs: unknown[] }>();
    vi.mocked(api.listJobs).mockReturnValue(d.promise);
    const r = renderRN(<JobList onOpen={() => {}} />);
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
    const r = renderRN(<JobList onOpen={() => {}} />);
    d.promise.catch(() => undefined); // avoid an unhandled-rejection warning racing the assertion below
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

describe('JobList — empty state', () => {
  it('renders the jobs EmptyState AND the add affordance (never a dead end)', async () => {
    vi.mocked(api.listJobs).mockResolvedValue({ jobs: [] });
    const r = renderRN(<JobList onOpen={() => {}} />);
    await flush();
    expect(findHost(r.root, byTestId('empty-state'))).toBeDefined();
    expect(hasText(r.root, 'No jobs yet')).toBe(true);
    expect(findHost(r.root, byTestId('job-new'))).toBeDefined();
  });

  it('the add button calls onOpen with no jobId (create mode)', async () => {
    vi.mocked(api.listJobs).mockResolvedValue({ jobs: [] });
    const onOpen = vi.fn();
    const r = renderRN(<JobList onOpen={onOpen} />);
    await flush();
    findHost(r.root, byTestId('job-new')).props.onPress();
    expect(onOpen).toHaveBeenCalledWith();
    expect(onOpen.mock.calls[0]!.length).toBe(0);
  });
});

describe('JobList — job rows', () => {
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
    // Appended LAST on purpose: the Switch tests below index rows positionally.
    // A cron job in a zone that is NOT this box's (UTC) — the row has to say so.
    {
      id: 'job-5',
      name: 'Timesheet',
      trigger: { type: 'cron', expression: '0 9 * * 5', timezone: 'Europe/London' },
      enabled: true,
    },
  ];

  it('renders every row with its resolved name/subtitle and the add button after the list', async () => {
    vi.mocked(api.listJobs).mockResolvedValue({ jobs });
    const r = renderRN(<JobList onOpen={() => {}} />);
    await flush();

    expect(hasText(r.root, 'Morning digest')).toBe(true);
    // describeCron('0 9 * * *') → 'every day at 9am'.
    expect(hasText(r.root, 'every day at 9am')).toBe(true);

    // job-2 has no 'name' → shows its id; describeCron('not a cron') → '' so
    // falls back to the raw cron string itself.
    expect(hasText(r.root, 'job-2')).toBe(true);
    expect(hasText(r.root, 'not a cron')).toBe(true);

    // job-5: a job in another zone names it, so "9am" can't be misread as
    // this reader's 9am (spec/08 § Cron).
    expect(hasText(r.root, 'Fridays at 9am · Europe/London')).toBe(true);
    // job-1 carries no zone and this box is UTC, so its row stays unqualified.
    expect(hasText(r.root, 'every day at 9am')).toBe(true);

    // job-3: non-cron trigger type shown verbatim as the subtitle.
    expect(hasText(r.root, 'Manual one')).toBe(true);
    expect(hasText(r.root, 'manual')).toBe(true);

    // job-4: no trigger at all → subtitle falls back to the literal 'trigger'.
    expect(hasText(r.root, 'No trigger')).toBe(true);

    // The nameless, id-less job: normalise() falls all the way through
    // `String(j['id'] ?? j['jobId'] ?? '')` to an empty id.
    expect(hasText(r.root, 'Nameless job')).toBe(true);
    expect(findHost(r.root, byTestId('job-row-'))).toBeDefined();

    expect(findHost(r.root, byTestId('job-row-job-1'))).toBeDefined();
    expect(findHost(r.root, byTestId('job-new'))).toBeDefined();
  });

  it('tapping a row calls onOpen with that job id', async () => {
    vi.mocked(api.listJobs).mockResolvedValue({ jobs });
    const onOpen = vi.fn();
    const r = renderRN(<JobList onOpen={onOpen} />);
    await flush();
    findHost(r.root, byTestId('job-row-job-1')).props.onPress();
    expect(onOpen).toHaveBeenCalledWith('job-1');
  });

  it("toggling ONE row's Switch OFF optimistically flips only that row, and commits via api.disableJob", async () => {
    // A multi-job list so the setJobs map's per-row ternary is exercised on
    // BOTH branches: the toggled row (match) AND every other row (no-op pass-through).
    vi.mocked(api.listJobs).mockResolvedValue({ jobs });
    const r = renderRN(<JobList onOpen={() => {}} />);
    await flush();
    const row1Switch = (): ReturnType<typeof findHost> => findAllHost(r.root, byType('Switch'))[0]!;
    expect(row1Switch().props.value).toBe(true); // job-1 starts enabled
    const otherSwitchesBefore = findAllHost(r.root, byType('Switch'))
      .slice(1)
      .map((s) => s.props.value);
    await actAsync(async () => {
      row1Switch().props.onValueChange(false);
      await flush();
    });
    const switchesAfter = findAllHost(r.root, byType('Switch'));
    expect(switchesAfter[0]!.props.value).toBe(false); // job-1 flipped off
    // Every OTHER row's value is untouched — pins the map's "no match" branch.
    expect(switchesAfter.slice(1).map((s) => s.props.value)).toEqual(otherSwitchesBefore);
    expect(api.disableJob).toHaveBeenCalledWith('job-1');
  });

  it("toggling a disabled row's Switch ON commits via api.enableJob (the other half of the on/off ternary)", async () => {
    vi.mocked(api.listJobs).mockResolvedValue({ jobs });
    const r = renderRN(<JobList onOpen={() => {}} />);
    await flush();
    // job-4 starts disabled; it's the 4th row (index 3).
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
    const r = renderRN(<JobList onOpen={() => {}} />);
    await flush();
    const otherSwitchesBefore = findAllHost(r.root, byType('Switch'))
      .slice(1)
      .map((s) => s.props.value);
    await actAsync(async () => {
      findAllHost(r.root, byType('Switch'))[0]!.props.onValueChange(false);
      await flush();
    });
    const switchesAfter = findAllHost(r.root, byType('Switch'));
    // Reverted back to enabled after the rejected disableJob call.
    expect(switchesAfter[0]!.props.value).toBe(true);
    // The revert map also only touches the matching row.
    expect(switchesAfter.slice(1).map((s) => s.props.value)).toEqual(otherSwitchesBefore);
    expect(__getLastAlert()).toEqual({
      title: 'Toggle failed',
      message: 'server rejected',
      buttons: undefined,
    });
  });

  it('multiple rows each render their own Switch bound to their own job', async () => {
    vi.mocked(api.listJobs).mockResolvedValue({ jobs });
    const r = renderRN(<JobList onOpen={() => {}} />);
    await flush();
    const switches = findAllHost(r.root, byType('Switch'));
    expect(switches.length).toBe(jobs.length);
  });
});
