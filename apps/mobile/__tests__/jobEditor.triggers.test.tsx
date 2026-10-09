// Jobs editor (spec/15 § Jobs editor) — the trigger-type switcher
// (cron/webhook/todoist), each revealing its own fields, the
// natural-language schedule text → live cron preview (parseNaturalSchedule /
// describeCron), the "edit cron directly" raw-cron toggle, and the JSONata
// Filter field (shown for every payload-bearing trigger, never for cron).
// Always starts in create mode (isNew) so no getJob round-trip is involved —
// load-existing-job behaviour lives in jobEditor.loadSave.test.tsx.

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import JobEditor from '../app/settings/job-editor';
import {
  renderRN,
  findHost,
  findAllHost,
  byTestId,
  hasText,
  textOf,
  flush,
} from './testUtils/render';
import { api } from '../src/api/rest';
import { __resetRouterMock, __setLocalSearchParams } from './stubs/expo-router';
import { useChatStore } from '../src/stores/chatStore';
import { useFolderStore } from '../src/stores/folderStore';
import { usePresenceStore } from '../src/stores/presenceStore';
import { deviceTimeZone } from '../src/lib/jobEditor';
import { lightColors } from '../src/lib/theme';

/** The one registered machine these screens address (spec/03 § Host events). */
const HOST = 'd1';

vi.mock('../src/api/rest', () => ({
  api: {
    getJob: vi.fn(),
    createJob: vi.fn(),
    patchJob: vi.fn(),
    deleteJob: vi.fn(),
    skills: vi.fn(),
    models: vi.fn(),
    listJobs: vi.fn(),
  },
}));

beforeEach(() => {
  vi.mocked(api.getJob).mockReset();
  vi.mocked(api.createJob).mockReset();
  vi.mocked(api.patchJob).mockReset();
  vi.mocked(api.deleteJob).mockReset();
  vi.mocked(api.skills).mockReset().mockResolvedValue({ skills: [] });
  vi.mocked(api.models).mockReset().mockResolvedValue({ models: [] });
  vi.mocked(api.listJobs).mockReset().mockResolvedValue({ jobs: [] });
  __resetRouterMock();
  __setLocalSearchParams({});
  useChatStore.getState()._reset();
  useFolderStore.getState()._reset();
  // Every folder list and every browse is scoped to ONE machine (spec/04
  // § Folders / § Browsing), so the roster carries the single registered host
  // these screens address. Without it `defaultDaemonId` is null and the screen
  // correctly refuses to guess — which is a different test.
  usePresenceStore.setState({
    hosts: { [HOST]: { daemonId: HOST, online: true, lastSeenAt: 1, host: null, accounts: {} } },
  });
});

/** Select a Pills option by its visible label within a testID'd Pills group. */
function selectPill(r: ReturnType<typeof renderRN>, groupTestId: string, label: string): void {
  const group = findHost(r.root, byTestId(groupTestId));
  const btn = findAllHost(group, (i) => i.type === 'Pressable' && hasText(i, label))[0]!;
  btn.props.onPress();
}

describe('JobEditor — trigger type: cron (default)', () => {
  it('shows the Schedule (natural language) field and a live "Runs …" preview by default', async () => {
    const r = renderRN(<JobEditor />);
    await flush();
    expect(findHost(r.root, byTestId('job-schedule-nl'))).toBeDefined();
    // DEFAULT_FORM.cronExpression is '0 9 * * *' → describeCron → 'every day at 9am'.
    expect(hasText(r.root, 'Runs every day at 9am')).toBe(true);
    expect(textOf(findHost(r.root, byTestId('job-cron-value')))).toBe('0 9 * * *');
  });

  it('typing a recognised phrase updates the underlying cron expression and the preview', async () => {
    const r = renderRN(<JobEditor />);
    await flush();
    findHost(r.root, byTestId('job-schedule-nl')).props.onChangeText('every weekday at 8am');
    expect(hasText(r.root, 'Runs weekdays at 8am')).toBe(true);
    expect(textOf(findHost(r.root, byTestId('job-cron-value')))).toBe('0 8 * * 1-5');
  });

  it('typing an unparseable phrase shows the "Couldn\'t read" warning and reveals the raw cron field', async () => {
    const r = renderRN(<JobEditor />);
    await flush();
    findHost(r.root, byTestId('job-schedule-nl')).props.onChangeText('whenever I feel like it');
    expect(hasText(r.root, 'Couldn')).toBe(true);
    expect(
      hasText(r.root, 'whenever i feel like it') || hasText(r.root, 'whenever I feel like it'),
    ).toBe(true);
    // scheduleUnparsed forces the raw cron field open even without toggling.
    expect(findHost(r.root, byTestId('job-cron'))).toBeDefined();
  });

  it('an unparseable phrase leaves the previously-set cronExpression untouched', async () => {
    const r = renderRN(<JobEditor />);
    await flush();
    findHost(r.root, byTestId('job-schedule-nl')).props.onChangeText('every weekday at 8am');
    // 'whenever I feel like it' doesn't match any recognised shape → null →
    // cronExpression is spread conditionally and stays at the last good value.
    // scheduleUnparsed also becomes true, which forces the raw cron field open.
    findHost(r.root, byTestId('job-schedule-nl')).props.onChangeText('whenever I feel like it');
    expect(findHost(r.root, byTestId('job-cron')).props.value).toBe('0 8 * * 1-5');
  });

  it('"edit cron directly" toggles the raw cron field open, and back closed', async () => {
    const r = renderRN(<JobEditor />);
    await flush();
    expect(findAllHost(r.root, byTestId('job-cron')).length).toBe(0);
    findHost(
      r.root,
      (i) => i.type === 'Pressable' && hasText(i, 'edit cron directly'),
    ).props.onPress();
    expect(findHost(r.root, byTestId('job-cron'))).toBeDefined();
    expect(hasText(r.root, 'hide cron')).toBe(true);
    findHost(r.root, (i) => i.type === 'Pressable' && hasText(i, 'hide cron')).props.onPress();
    expect(findAllHost(r.root, byTestId('job-cron')).length).toBe(0);
  });

  it('editing the raw cron field directly updates the value shown', async () => {
    const r = renderRN(<JobEditor />);
    await flush();
    findHost(
      r.root,
      (i) => i.type === 'Pressable' && hasText(i, 'edit cron directly'),
    ).props.onPress();
    findHost(r.root, byTestId('job-cron')).props.onChangeText('*/10 * * * *');
    expect(findHost(r.root, byTestId('job-cron')).props.value).toBe('*/10 * * * *');
  });

  it('the Filter field is NOT shown for a cron trigger', async () => {
    const r = renderRN(<JobEditor />);
    await flush();
    expect(findAllHost(r.root, byTestId('job-filter')).length).toBe(0);
  });

  it('when describeCron cannot render the current cron, the preview falls back to the raw expression', async () => {
    const r = renderRN(<JobEditor />);
    await flush();
    findHost(
      r.root,
      (i) => i.type === 'Pressable' && hasText(i, 'edit cron directly'),
    ).props.onPress();
    // A day-of-month/month-restricted cron isn't one of describeCron's
    // recognised shapes (every branch there requires dom==='*' && mon==='*'),
    // so describeCron('5 5 5 5 5') === '' and `cronPreview || form.cronExpression`
    // falls back to the raw expression itself.
    findHost(r.root, byTestId('job-cron')).props.onChangeText('5 5 5 5 5');
    expect(hasText(r.root, 'Runs 5 5 5 5 5')).toBe(true);
  });

  // spec/08 § Cron — the expression is evaluated in the trigger's own zone, so
  // the editor has to show and let you change it, and the readout has to say
  // which zone the "Runs …" line is talking about.
  it('shows a Timezone field seeded with this device’s zone, echoed in the preview', async () => {
    const r = renderRN(<JobEditor />);
    await flush();
    const tz = findHost(r.root, byTestId('job-cron-timezone'));
    expect(tz.props.value).toBe(deviceTimeZone());
    expect(textOf(findHost(r.root, byTestId('job-cron-timezone-value')))).toBe(deviceTimeZone());
  });

  it('editing the Timezone updates the preview WITHOUT touching the expression', async () => {
    const r = renderRN(<JobEditor />);
    await flush();
    findHost(r.root, byTestId('job-cron-timezone')).props.onChangeText('Europe/London');
    expect(textOf(findHost(r.root, byTestId('job-cron-timezone-value')))).toBe('Europe/London');
    expect(textOf(findHost(r.root, byTestId('job-cron-value')))).toBe('0 9 * * *');
  });
});

describe('JobEditor — trigger type: webhook', () => {
  it('switching to webhook shows the Scheme pills and Secret field, hides cron fields', async () => {
    const r = renderRN(<JobEditor />);
    await flush();
    selectPill(r, 'job-trigger-type', 'webhook');
    expect(findAllHost(r.root, byTestId('job-schedule-nl')).length).toBe(0);
    expect(hasText(r.root, 'Scheme')).toBe(true);
    expect(hasText(r.root, 'hmac-sha256')).toBe(true);
    expect(hasText(r.root, 'Secret')).toBe(true);
  });

  it('picking a scheme updates the selected pill', async () => {
    const r = renderRN(<JobEditor />);
    await flush();
    selectPill(r, 'job-trigger-type', 'webhook');
    // 'github' text is unique to the Scheme pills on this screen.
    findHost(r.root, (i) => i.type === 'Pressable' && hasText(i, 'github')).props.onPress();
    const activeGithub = findHost(r.root, (i) => i.type === 'Pressable' && hasText(i, 'github'));
    expect(activeGithub.props.style.borderColor).toBe(lightColors.leaf); // active pill
  });

  it('editing the Secret field updates webhookSecret', async () => {
    const r = renderRN(<JobEditor />);
    await flush();
    selectPill(r, 'job-trigger-type', 'webhook');
    const inputs = findAllHost(
      r.root,
      (i) => i.type === 'TextInput' && i.props.testID !== 'job-name',
    );
    const secretField = inputs[0]!; // Secret is the only Input in the webhook branch besides the Scheme pills
    secretField.props.onChangeText('shh-secret');
    expect(secretField.props.value).toBe('shh-secret');
  });

  it('the Filter field IS shown for a webhook trigger (payload-bearing)', async () => {
    const r = renderRN(<JobEditor />);
    await flush();
    selectPill(r, 'job-trigger-type', 'webhook');
    expect(findHost(r.root, byTestId('job-filter'))).toBeDefined();
    findHost(r.root, byTestId('job-filter')).props.onChangeText("payload.x = 'y'");
    expect(findHost(r.root, byTestId('job-filter')).props.value).toBe("payload.x = 'y'");
  });
});

describe('JobEditor — trigger type: todoist', () => {
  it('switching to todoist shows none of the cron/webhook fields, but shows Filter', async () => {
    const r = renderRN(<JobEditor />);
    await flush();
    selectPill(r, 'job-trigger-type', 'todoist');
    expect(findAllHost(r.root, byTestId('job-schedule-nl')).length).toBe(0);
    expect(hasText(r.root, 'Scheme')).toBe(false);
    expect(findHost(r.root, byTestId('job-filter'))).toBeDefined();
  });
});

describe('JobEditor — trigger type: recurrence builder', () => {
  it('builds the RRULE from pills and time, and previews it in English', async () => {
    const r = renderRN(<JobEditor />);
    await flush();
    selectPill(r, 'job-trigger-type', 'recurrence');
    expect(findAllHost(r.root, byTestId('job-recurrence-rule')).length).toBe(0);
    selectPill(r, 'job-recurrence-freq', 'Monthly');
    selectPill(r, 'job-recurrence-nth', '3rd');
    selectPill(r, 'job-recurrence-days', 'Mon');
    findHost(r.root, byTestId('job-recurrence-time')).props.onChangeText('08:30');
    findHost(r.root, byTestId('job-recurrence-raw-toggle')).props.onPress();
    expect(findHost(r.root, byTestId('job-recurrence-rule')).props.value).toBe(
      'FREQ=MONTHLY;BYDAY=MO;BYSETPOS=3;BYHOUR=8;BYMINUTE=30',
    );
    expect(hasText(r.root, 'Runs')).toBe(true);
  });

  it('shows the raw field when the rule is outside the builder shape', async () => {
    const r = renderRN(<JobEditor />);
    await flush();
    selectPill(r, 'job-trigger-type', 'recurrence');
    findHost(r.root, byTestId('job-recurrence-raw-toggle')).props.onPress();
    findHost(r.root, byTestId('job-recurrence-rule')).props.onChangeText('FREQ=DAILY');
    expect(findAllHost(r.root, byTestId('job-recurrence-freq')).length).toBe(0);
    expect(findHost(r.root, byTestId('job-recurrence-rule'))).toBeDefined();
  });
});
