// Naming guard: the automation feature is called "Jobs" on every surface
// (spec/08 § "A job is a persistent automation"). The mobile UI used to call
// it "Schedules", which is the ONLY place the product contradicted itself.
// This test fails if that word comes back as a feature label — a screen
// title, a Settings row, an empty state, an add affordance, or a route path.
//
// Deliberately narrow: it inspects the Settings tab and the Jobs list screen
// only. The job EDITOR legitimately has a natural-language "Schedule" field
// (a cron expression genuinely is a schedule — spec/15 § job editor), so the
// editor is out of scope here on purpose.

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import SettingsScreen from '../app/(tabs)/settings';
import Jobs from '../app/(tabs)/jobs';
import { renderRN, findHost, findAllHost, byTestId, textOf, flush } from './testUtils/render';
import { api } from '../src/api/rest';
import { routerMock, __resetRouterMock } from './stubs/expo-router';
import { __clearLastAlert } from './stubs/react-native';
import { clearCredential } from '../src/lib/credential';
import { usePresenceStore } from '../src/stores/presenceStore';
import { settingsFixture } from './testUtils/settingsFixtures';

vi.mock('../src/api/rest', () => ({
  api: {
    me: vi.fn(),
    healthz: vi.fn(async () => ({ ok: true, version: '1', gitSha: 'abc' })),
    version: vi.fn(() => new Promise(() => {})),
    models: vi.fn(async () => ({ models: [] })),
    listSecrets: vi.fn(),
    setSecret: vi.fn(),
    deleteSecret: vi.fn(),
    listJobs: vi.fn(),
    enableJob: vi.fn(),
    disableJob: vi.fn(),
    settings: vi.fn(async () => settingsFixture()),
  },
}));

vi.mock('../src/lib/bootstrap', () => ({ teardown: vi.fn() }));

/**
 * The old feature word as a label, any casing — "Schedules", "schedule". Not
 * "Scheduled": Settings → Manager & Speakers carries web's own
 * "Scheduled session rotation", which names a special-thread setting, not Jobs.
 */
const SCHEDULE_WORD = /\bschedules?\b/i;

beforeEach(() => {
  vi.mocked(api.me)
    .mockReset()
    .mockReturnValue(new Promise(() => {}));
  vi.mocked(api.listSecrets).mockReset().mockResolvedValue({ secrets: [] });
  vi.mocked(api.listJobs).mockReset().mockResolvedValue({ jobs: [] });
  vi.mocked(api.enableJob).mockReset().mockResolvedValue(undefined);
  vi.mocked(api.disableJob).mockReset().mockResolvedValue(undefined);
  __resetRouterMock();
  __clearLastAlert();
  clearCredential();
  usePresenceStore.setState({
    connection: 'connecting',
    daemon: 'online',
    accountId: null,
    surfaceId: null,
  });
});

describe('Jobs naming — no "Schedule(s)" as a feature label', () => {
  // Jobs left Settings for its own bottom tab (spec/15 § Navigation shell), so
  // there is no jobs-row here any more — but the naming guard still applies:
  // the word must not reappear on this page under any spelling.
  it('the Settings tab never says Schedules, and no longer carries a Jobs row', async () => {
    const r = renderRN(<SettingsScreen />);
    await flush();

    expect(textOf(r.root)).not.toMatch(SCHEDULE_WORD);
    expect(findAllHost(r.root, byTestId('jobs-row'))).toHaveLength(0);
    for (const [href] of routerMock.push.mock.calls) {
      expect(String(href)).not.toMatch(SCHEDULE_WORD);
    }
  });

  it('the Jobs screen — title, empty state and add affordance — never says Schedule', async () => {
    const r = renderRN(<Jobs />);
    await flush();

    expect(textOf(r.root)).not.toMatch(SCHEDULE_WORD);
    expect(textOf(r.root)).toContain('Jobs');
    expect(textOf(r.root)).toContain('No jobs yet');

    // The add affordance's own accessibility label is user-facing too.
    const add = findHost(r.root, byTestId('job-new'));
    expect(String(add.props['accessibilityLabel'])).not.toMatch(SCHEDULE_WORD);
  });

  it('a populated Jobs screen routes rows to /settings/job-editor', async () => {
    vi.mocked(api.listJobs).mockResolvedValue({
      jobs: [
        {
          id: 'job-1',
          name: 'Morning digest',
          trigger: { type: 'cron', expression: '0 9 * * *' },
          enabled: true,
        },
      ],
    });
    const r = renderRN(<Jobs />);
    await flush();

    expect(textOf(r.root)).not.toMatch(SCHEDULE_WORD);
    findHost(r.root, byTestId('job-row-job-1')).props.onPress();
    expect(routerMock.push).toHaveBeenCalledWith('/settings/job-editor?id=job-1');
    for (const [href] of routerMock.push.mock.calls) {
      expect(String(href)).not.toMatch(SCHEDULE_WORD);
    }
  });
});
