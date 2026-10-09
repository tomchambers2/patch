// Jobs tab — full parity with web's /jobs page (spec/15 § Jobs screen):
// sort + filter controls, the four status sections, last-fired/queued/chat
// link, and per-row Archive/Delete. `jobs.test.tsx` covers the base
// list/toggle behaviour; this file covers everything added for parity.

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
import { __getLastAlert, __clearLastAlert } from './stubs/react-native';
import { __resetRouterMock, routerMock } from './stubs/expo-router';
import { __clearAllMmkv } from './stubs/mmkv';
import { usePresenceStore } from '../src/stores/presenceStore';

vi.mock('../src/api/rest', () => ({
  api: {
    listJobs: vi.fn(),
    enableJob: vi.fn(),
    disableJob: vi.fn(),
    patchJob: vi.fn(),
    deleteJob: vi.fn(),
  },
}));

function openPicker(r: ReturnType<typeof renderRN>, pickerTestId: string): void {
  findHost(r.root, byTestId(pickerTestId)).props.onPress();
}
function pickOption(r: ReturnType<typeof renderRN>, pickerTestId: string, optionId: string): void {
  openPicker(r, pickerTestId);
  findHost(r.root, byTestId(`${pickerTestId}-option-${optionId}`)).props.onPress();
}
function visibleRowIds(r: ReturnType<typeof renderRN>): string[] {
  return findAllHost(r.root, (i) => String(i.props['testID'] ?? '').startsWith('job-row-')).map(
    (i) => String(i.props['testID']).replace('job-row-', ''),
  );
}

beforeEach(() => {
  vi.mocked(api.listJobs).mockReset();
  vi.mocked(api.enableJob).mockReset().mockResolvedValue(undefined);
  vi.mocked(api.disableJob).mockReset().mockResolvedValue(undefined);
  vi.mocked(api.patchJob).mockReset().mockResolvedValue({});
  vi.mocked(api.deleteJob).mockReset().mockResolvedValue(undefined);
  __clearLastAlert();
  __resetRouterMock();
  __clearAllMmkv();
  usePresenceStore.setState({ hosts: {} });
});

describe('Jobs tab — sections', () => {
  const JOBS = [
    {
      id: 'r1',
      name: 'Plain job',
      enabled: true,
      trigger: { type: 'cron', expression: '0 9 * * *' },
    },
    {
      id: 'o1',
      name: 'First fire pending',
      enabled: true,
      oneOff: true,
      trigger: { type: 'cron', expression: '0 9 * * *' },
    },
    {
      id: 'e1',
      name: 'Retired job',
      enabled: true,
      expiredAt: 1000,
      trigger: { type: 'cron', expression: '0 9 * * *' },
    },
    {
      id: 'a1',
      name: 'Stored job',
      enabled: true,
      archived: true,
      trigger: { type: 'cron', expression: '0 9 * * *' },
    },
  ];

  it('draws no section headers when only recurring jobs exist', async () => {
    vi.mocked(api.listJobs).mockResolvedValue({ jobs: [JOBS[0]] });
    const r = renderRN(<Jobs />);
    await flush();
    expect(hasText(r.root, 'Recurring')).toBe(false);
    expect(visibleRowIds(r)).toEqual(['r1']);
  });

  it('splits into four sections, Expired/Archived collapsed behind a count', async () => {
    vi.mocked(api.listJobs).mockResolvedValue({ jobs: JOBS });
    const r = renderRN(<Jobs />);
    await flush();
    expect(hasText(r.root, 'Recurring')).toBe(true);
    expect(hasText(r.root, 'One-off')).toBe(true);
    expect(hasText(r.root, 'Expired')).toBe(true);
    expect(hasText(r.root, 'Archived')).toBe(true);
    // Recurring + one-off are always open; expired/archived start closed.
    expect(visibleRowIds(r)).toEqual(['r1', 'o1']);
    expect(findHost(r.root, byTestId('jobs-jobsExpired-count')).props.children).toBe(1);
    expect(findHost(r.root, byTestId('jobs-jobsArchived-count')).props.children).toBe(1);
  });

  it('tapping the Expired header opens it, revealing its row with a disabled switch', async () => {
    vi.mocked(api.listJobs).mockResolvedValue({ jobs: JOBS });
    const r = renderRN(<Jobs />);
    await flush();
    findHost(r.root, byTestId('jobs-jobsExpired-toggle')).props.onPress();
    await flush();
    expect(visibleRowIds(r)).toEqual(['r1', 'o1', 'e1']);
    expect(findHost(r.root, byTestId('job-toggle-e1')).props.disabled).toBe(true);
  });

  it('tapping the Archived header opens it, revealing its row with a disabled switch', async () => {
    vi.mocked(api.listJobs).mockResolvedValue({ jobs: JOBS });
    const r = renderRN(<Jobs />);
    await flush();
    findHost(r.root, byTestId('jobs-jobsArchived-toggle')).props.onPress();
    await flush();
    expect(visibleRowIds(r)).toEqual(['r1', 'o1', 'a1']);
    expect(findHost(r.root, byTestId('job-toggle-a1')).props.disabled).toBe(true);
  });
});

describe('Jobs tab — sort', () => {
  const JOBS = [
    {
      id: 'b',
      name: 'Bravo',
      enabled: true,
      createdAt: 10,
      trigger: { type: 'cron', expression: '0 9 * * *' },
    },
    {
      id: 'a',
      name: 'Alpha',
      enabled: true,
      createdAt: 30,
      trigger: { type: 'cron', expression: '0 9 * * *' },
    },
    {
      id: 'c',
      name: 'Charlie',
      enabled: true,
      createdAt: 20,
      trigger: { type: 'cron', expression: '0 9 * * *' },
    },
  ];

  it('defaults to Last fired, and offers Name / Created', async () => {
    vi.mocked(api.listJobs).mockResolvedValue({ jobs: JOBS });
    const r = renderRN(<Jobs />);
    await flush();
    expect(hasText(findHost(r.root, byTestId('jobs-sort')), 'Last fired')).toBe(true);
  });

  it('Name orders case-insensitively', async () => {
    vi.mocked(api.listJobs).mockResolvedValue({ jobs: JOBS });
    const r = renderRN(<Jobs />);
    await flush();
    pickOption(r, 'jobs-sort', 'name');
    expect(visibleRowIds(r)).toEqual(['a', 'b', 'c']);
  });

  it('Created orders newest first', async () => {
    vi.mocked(api.listJobs).mockResolvedValue({ jobs: JOBS });
    const r = renderRN(<Jobs />);
    await flush();
    pickOption(r, 'jobs-sort', 'created');
    expect(visibleRowIds(r)).toEqual(['a', 'c', 'b']);
  });
});

describe('Jobs tab — filters', () => {
  const JOBS = [
    { id: 'on', name: 'On', enabled: true, trigger: { type: 'cron', expression: '0 9 * * *' } },
    { id: 'off', name: 'Off', enabled: false, trigger: { type: 'webhook', scheme: 'none' } },
  ];

  it('narrows by status', async () => {
    vi.mocked(api.listJobs).mockResolvedValue({ jobs: JOBS });
    const r = renderRN(<Jobs />);
    await flush();
    pickOption(r, 'jobs-filter-status', 'disabled');
    expect(visibleRowIds(r)).toEqual(['off']);
  });

  it('narrows by trigger type', async () => {
    vi.mocked(api.listJobs).mockResolvedValue({ jobs: JOBS });
    const r = renderRN(<Jobs />);
    await flush();
    pickOption(r, 'jobs-filter-trigger', 'webhook');
    expect(visibleRowIds(r)).toEqual(['off']);
  });

  it('composes with search', async () => {
    vi.mocked(api.listJobs).mockResolvedValue({ jobs: JOBS });
    const r = renderRN(<Jobs />);
    await flush();
    pickOption(r, 'jobs-filter-status', 'enabled');
    findHost(r.root, byTestId('jobs-search')).props.onChangeText('off');
    expect(visibleRowIds(r)).toEqual([]);
  });
});

describe('Jobs tab — last-fired, queued, chat link', () => {
  const JOB = {
    id: 'j1',
    name: 'Digest',
    enabled: true,
    queued: 3,
    trigger: { type: 'cron', expression: '0 9 * * *' },
    action: { type: 'continue', daemonId: 'd1', folder: '/p', skill: 'digest' },
  };

  it('shows "never" with no latestRun, and the queued count', async () => {
    vi.mocked(api.listJobs).mockResolvedValue({ jobs: [JOB] });
    const r = renderRN(<Jobs />);
    await flush();
    expect(hasText(findHost(r.root, byTestId('job-last-fired-j1')), 'never')).toBe(true);
    expect(hasText(findHost(r.root, byTestId('job-queued-j1')), '3 queued')).toBe(true);
  });

  it('an unkeyed persistent chat action always has an open-chat link, which navigates', async () => {
    vi.mocked(api.listJobs).mockResolvedValue({ jobs: [JOB] });
    const r = renderRN(<Jobs />);
    await flush();
    findHost(r.root, byTestId('job-chat-j1')).props.onPress();
    expect(routerMock.push).toHaveBeenCalledWith('/chats/jobchat-j1');
  });

  it('a spawn job with no run yet has no chat link', async () => {
    vi.mocked(api.listJobs).mockResolvedValue({
      jobs: [{ ...JOB, action: { type: 'spawn', daemonId: 'd1', folder: '/p', skill: 'digest' } }],
    });
    const r = renderRN(<Jobs />);
    await flush();
    expect(queryHost(r.root, byTestId('job-chat-j1'))).toBeNull();
  });

  it('a spawn job that has fired links to the latest run’s chat', async () => {
    vi.mocked(api.listJobs).mockResolvedValue({
      jobs: [
        {
          ...JOB,
          action: { type: 'spawn', daemonId: 'd1', folder: '/p', skill: 'digest' },
          latestRun: { ts: Date.now(), status: 'ok', chatId: 'chat-77' },
        },
      ],
    });
    const r = renderRN(<Jobs />);
    await flush();
    findHost(r.root, byTestId('job-chat-j1')).props.onPress();
    expect(routerMock.push).toHaveBeenCalledWith('/chats/chat-77');
  });
});

describe('Jobs tab — archive', () => {
  const JOB = {
    id: 'j1',
    name: 'Digest',
    enabled: true,
    trigger: { type: 'cron', expression: '0 9 * * *' },
  };

  it('archiving moves the row into the Archived section, no confirmation asked', async () => {
    vi.mocked(api.listJobs).mockResolvedValue({ jobs: [JOB] });
    const r = renderRN(<Jobs />);
    await flush();
    findHost(r.root, byTestId('job-archive-j1')).props.onPress();
    await flush();
    expect(api.patchJob).toHaveBeenCalledWith('j1', { archived: true });
    expect(__getLastAlert()).toBeNull();
    expect(hasText(r.root, 'Archived')).toBe(true);
  });

  it('a failed archive reverts and alerts', async () => {
    vi.mocked(api.listJobs).mockResolvedValue({ jobs: [JOB] });
    vi.mocked(api.patchJob).mockRejectedValue(new Error('offline'));
    const r = renderRN(<Jobs />);
    await flush();
    await actAsync(async () => {
      findHost(r.root, byTestId('job-archive-j1')).props.onPress();
      await flush();
    });
    expect(__getLastAlert()).toEqual({
      title: 'Archive failed',
      message: 'offline',
      buttons: undefined,
    });
    // Reverted: still in the plain (ungrouped) list, not Archived.
    expect(hasText(r.root, 'Archived')).toBe(false);
  });

  it('unarchiving an archived row brings it back', async () => {
    vi.mocked(api.listJobs).mockResolvedValue({ jobs: [{ ...JOB, archived: true }] });
    const r = renderRN(<Jobs />);
    await flush();
    findHost(r.root, byTestId('jobs-jobsArchived-toggle')).props.onPress();
    await flush();
    findHost(r.root, byTestId('job-archive-j1')).props.onPress();
    await flush();
    expect(api.patchJob).toHaveBeenCalledWith('j1', { archived: false });
  });
});

describe('Jobs tab — delete', () => {
  const JOB = {
    id: 'j1',
    name: 'Digest',
    enabled: true,
    trigger: { type: 'cron', expression: '0 9 * * *' },
  };

  it('asks for confirmation before deleting', async () => {
    vi.mocked(api.listJobs).mockResolvedValue({ jobs: [JOB] });
    const r = renderRN(<Jobs />);
    await flush();
    findHost(r.root, byTestId('job-delete-j1')).props.onPress();
    const alert = __getLastAlert();
    expect(alert?.title).toBe('Delete job?');
    expect(alert?.buttons?.map((b) => b.text)).toEqual(['Cancel', 'Delete']);
    expect(api.deleteJob).not.toHaveBeenCalled();
  });

  it('confirming removes the row and calls deleteJob', async () => {
    vi.mocked(api.listJobs).mockResolvedValue({ jobs: [JOB] });
    const r = renderRN(<Jobs />);
    await flush();
    findHost(r.root, byTestId('job-delete-j1')).props.onPress();
    const alert = __getLastAlert();
    await actAsync(async () => {
      alert!.buttons!.find((b) => b.text === 'Delete')!.onPress!();
      await flush();
    });
    expect(api.deleteJob).toHaveBeenCalledWith('j1');
    expect(visibleRowIds(r)).toEqual([]);
  });

  it('cancelling does nothing', async () => {
    vi.mocked(api.listJobs).mockResolvedValue({ jobs: [JOB] });
    const r = renderRN(<Jobs />);
    await flush();
    findHost(r.root, byTestId('job-delete-j1')).props.onPress();
    const alert = __getLastAlert();
    expect(alert?.buttons?.find((b) => b.text === 'Cancel')?.onPress).toBeUndefined();
    expect(visibleRowIds(r)).toEqual(['j1']);
  });
});

describe('Jobs tab — search matches the action label too', () => {
  it('finds a job by the skill it runs, resolving the host name it shows', async () => {
    usePresenceStore.setState({
      hosts: {
        d1: {
          daemonId: 'd1',
          online: true,
          lastSeenAt: 1,
          host: { hostName: 'Mac mini' },
          accounts: {},
        },
      },
    });
    vi.mocked(api.listJobs).mockResolvedValue({
      jobs: [
        {
          id: 'j1',
          name: 'Weekly check-in',
          enabled: true,
          trigger: { type: 'cron', expression: '0 9 * * *' },
          action: { type: 'spawn', daemonId: 'd1', folder: '/home/tom/p', skill: 'life-coach' },
        },
      ],
    });
    const r = renderRN(<Jobs />);
    await flush();
    expect(hasText(r.root, 'life-coach · Mac mini · /home/tom/p')).toBe(true);
    findHost(r.root, byTestId('jobs-search')).props.onChangeText('life-coach');
    expect(visibleRowIds(r)).toEqual(['j1']);
  });
});
