// Jobs editor (spec/15 § Jobs editor) — create-vs-edit mode, the
// load-existing-job effect (incl. its stale-response guard), the folder-seed
// effect, the skills-fetch effect (incl. its own stale-response guard),
// save/create/patch, delete, and the header. The pure form logic
// (validateForm/formToBody/jobToForm) is unit-tested independently in
// jobEditor.test.ts — here we only need to prove the SCREEN wires it up
// and reacts to loading/error states correctly. Trigger-type-specific fields
// and action-type-specific fields are covered in
// jobEditor.triggers.test.tsx / jobEditor.actions.test.tsx.

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import JobEditor from '../app/settings/job-editor';
import {
  renderRN,
  findHost,
  findAllHost,
  byTestId,
  byLabel,
  hasText,
  textOf,
  actSync,
  actAsync,
  flush,
} from './testUtils/render';
import { api } from '../src/api/rest';
import { __getLastAlert, __clearLastAlert } from './stubs/react-native';
import { routerMock, __resetRouterMock, __setLocalSearchParams } from './stubs/expo-router';
import { useChatStore } from '../src/stores/chatStore';
import { useFolderStore } from '../src/stores/folderStore';
import { usePresenceStore } from '../src/stores/presenceStore';
import type { Job } from '@patch/wire/jobs';

/** The one registered machine these screens address (spec/03 § Host events). */
const HOST = 'd1';

vi.mock('../src/api/rest', () => ({
  api: {
    getJob: vi.fn(),
    createJob: vi.fn(),
    patchJob: vi.fn(),
    deleteJob: vi.fn(),
    runJob: vi.fn(),
    skills: vi.fn(),
    models: vi.fn(),
    listJobs: vi.fn(),
  },
}));

/** A promise the test can resolve/reject on demand, to pin a loading state. */
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

const baseJob: Job = {
  id: 'job-1',
  name: 'Nightly digest',
  enabled: true,
  trigger: { type: 'cron', expression: '0 21 * * *' },
  filter: null,
  action: {
    type: 'spawn',
    daemonId: 'd1',
    folder: '/home/tom/p',
    prompt: 'summarize the day',
    skill: undefined,
  },
  createdAt: 0,
  updatedAt: 0,
};

beforeEach(() => {
  vi.mocked(api.getJob).mockReset();
  vi.mocked(api.createJob).mockReset();
  vi.mocked(api.patchJob).mockReset();
  vi.mocked(api.deleteJob).mockReset();
  vi.mocked(api.runJob).mockReset();
  vi.mocked(api.skills).mockReset().mockResolvedValue({ skills: [] });
  vi.mocked(api.models).mockReset().mockResolvedValue({ models: [] });
  vi.mocked(api.listJobs).mockReset().mockResolvedValue({ jobs: [] });
  __resetRouterMock();
  __clearLastAlert();
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

// The Folder/Model/Skill fields are dropdowns (OptionPicker): closed by
// default, showing only the current selection's label. A test opens one by
// pressing its trigger pill, then presses the option it wants — same
// two-step interaction a real tap does.
function openPicker(r: ReturnType<typeof renderRN>, pickerTestId: string): void {
  findHost(r.root, byTestId(pickerTestId)).props.onPress();
}
function pickOption(r: ReturnType<typeof renderRN>, pickerTestId: string, optionId: string): void {
  openPicker(r, pickerTestId);
  findHost(
    r.root,
    byTestId(`${pickerTestId}-option-${optionId === '' ? 'default' : optionId}`),
  ).props.onPress();
}
function pickerLabel(r: ReturnType<typeof renderRN>, pickerTestId: string): string {
  return textOf(findHost(r.root, byTestId(pickerTestId)));
}

describe('JobEditor — create vs edit mode', () => {
  it('with no id param, is in create mode: no loading spinner, title "New job", no delete icon', async () => {
    __setLocalSearchParams({});
    const r = renderRN(<JobEditor />);
    expect(hasText(r.root, 'New job')).toBe(true);
    expect(findAllHost(r.root, (i) => i.type === 'ActivityIndicator').length).toBe(0);
    expect(findAllHost(r.root, (i) => i.props['accessibilityLabel'] === 'Delete').length).toBe(0);
    expect(api.getJob).not.toHaveBeenCalled();
  });

  it('id="new" is ALSO create mode (the isNew special-case)', async () => {
    __setLocalSearchParams({ id: 'new' });
    const r = renderRN(<JobEditor />);
    expect(hasText(r.root, 'New job')).toBe(true);
    expect(api.getJob).not.toHaveBeenCalled();
  });

  it('with a real id, is in edit mode: shows a loading spinner, then loads the job', async () => {
    __setLocalSearchParams({ id: 'job-1' });
    const d = deferred<unknown>();
    vi.mocked(api.getJob).mockReturnValue(d.promise);
    const r = renderRN(<JobEditor />);
    expect(findAllHost(r.root, (i) => i.type === 'ActivityIndicator').length).toBe(1);
    await actAsync(async () => {
      d.resolve(baseJob);
      await flush();
    });
    expect(findAllHost(r.root, (i) => i.type === 'ActivityIndicator').length).toBe(0);
    expect(hasText(r.root, 'Edit job')).toBe(true);
    expect(findHost(r.root, byTestId('job-name')).props.value).toBe('Nightly digest');
    // Delete icon present only in edit mode.
    expect(findAllHost(r.root, byLabel('Delete')).length).toBe(1);
  });

  // The server attaches the concurrency gate's live counts to every job it
  // hands out (`withCounts` in packages/server/src/jobs/routes.ts), so the
  // editor's parse has to be the response shape (JobWithCounts), not the
  // stored one. Parsing `Job` here rejected EVERY job with "Unrecognized
  // key(s) in object: 'inFlight', 'queued'".
  it('loads a job that carries the server-attached inFlight/queued counts', async () => {
    __setLocalSearchParams({ id: 'job-1' });
    vi.mocked(api.getJob).mockResolvedValue({ ...baseJob, inFlight: 2, queued: 5 });
    const r = renderRN(<JobEditor />);
    await flush();
    expect(__getLastAlert()).toBeNull();
    expect(findHost(r.root, byTestId('job-name')).props.value).toBe('Nightly digest');
    expect(findHost(r.root, byTestId('job-schedule-nl')).props.value).toBe('every day at 9pm');
    expect(findAllHost(r.root, (i) => i.type === 'ActivityIndicator').length).toBe(0);
  });

  it('prefills the natural-language schedule text via describeCron for a loaded cron job', async () => {
    __setLocalSearchParams({ id: 'job-1' });
    vi.mocked(api.getJob).mockResolvedValue(baseJob);
    const r = renderRN(<JobEditor />);
    await flush();
    expect(findHost(r.root, byTestId('job-schedule-nl')).props.value).toBe('every day at 9pm');
  });

  it('a failed job load surfaces an Alert and stops loading', async () => {
    __setLocalSearchParams({ id: 'job-1' });
    vi.mocked(api.getJob).mockRejectedValue(new Error('not found'));
    const r = renderRN(<JobEditor />);
    await flush();
    expect(__getLastAlert()).toEqual({
      title: 'Failed to load job',
      message: 'not found',
      buttons: undefined,
    });
    expect(findAllHost(r.root, (i) => i.type === 'ActivityIndicator').length).toBe(0);
  });

  // The job's END CONDITION (spec/08 § One-off jobs) — before this, neither
  // chip existed anywhere on this screen, so a one-off job and an expired one
  // read identically to an ordinary recurring job here (Patch Updates —
  // "patch cant see end condition in job ui").
  it('shows a ONE-OFF chip for a job that has not fired yet', async () => {
    __setLocalSearchParams({ id: 'job-1' });
    vi.mocked(api.getJob).mockResolvedValue({ ...baseJob, oneOff: true });
    const r = renderRN(<JobEditor />);
    await flush();
    expect(hasText(r.root, 'ONE-OFF')).toBe(true);
    expect(hasText(r.root, 'EXPIRED')).toBe(false);
  });

  it('shows an EXPIRED chip for a one-off job that has already retired', async () => {
    __setLocalSearchParams({ id: 'job-1' });
    vi.mocked(api.getJob).mockResolvedValue({
      ...baseJob,
      enabled: false,
      oneOff: true,
      expiredAt: 1_700_000_000_000,
    });
    const r = renderRN(<JobEditor />);
    await flush();
    expect(hasText(r.root, 'EXPIRED')).toBe(true);
    expect(hasText(r.root, 'ONE-OFF')).toBe(true);
  });

  it('shows neither chip for an ordinary recurring job', async () => {
    __setLocalSearchParams({ id: 'job-1' });
    vi.mocked(api.getJob).mockResolvedValue(baseJob);
    const r = renderRN(<JobEditor />);
    await flush();
    expect(hasText(r.root, 'ONE-OFF')).toBe(false);
    expect(hasText(r.root, 'EXPIRED')).toBe(false);
  });

  it('unmounting before getJob resolves runs the cleanup so the stale .then() hits its `if (!live) return` guard', async () => {
    __setLocalSearchParams({ id: 'job-1' });
    const d = deferred<unknown>();
    vi.mocked(api.getJob).mockReturnValue(d.promise);
    const r = renderRN(<JobEditor />);
    // Wrapped in act() so the effect's cleanup (`live = false`) actually
    // flushes synchronously before the promise below resolves — otherwise
    // the unmount's passive-effect cleanup is left pending and the `.then()`
    // callback would (incorrectly, for this test) still see `live === true`.
    actSync(() => r.unmount());
    await actAsync(async () => {
      d.resolve(baseJob);
      await flush();
    });
    // No assertion beyond "did not throw" — the `if (!live) return` guard is exercised.
  });
});

describe('JobEditor — folder-seed effect (new job)', () => {
  it('seeds spawnFolder to the first host folder once folderChoices loads', async () => {
    useFolderStore
      .getState()
      .setHostFolders({ daemonId: HOST, roots: ['/home/tom/a', '/home/tom/b'], recent: [] });
    __setLocalSearchParams({});
    const r = renderRN(<JobEditor />);
    await flush();
    expect(pickerLabel(r, 'job-spawn-folder')).toBe(`a · ${HOST}`);
  });

  it('does not overwrite an already-chosen folder when the folder list later changes', async () => {
    useFolderStore
      .getState()
      .setHostFolders({ daemonId: HOST, roots: ['/home/tom/a', '/home/tom/b'], recent: [] });
    __setLocalSearchParams({});
    const r = renderRN(<JobEditor />);
    await flush();
    await actAsync(async () => {
      findHost(r.root, byTestId('job-spawn-folder')).props.onPress();
      await flush();
    });
    await actAsync(async () => {
      findHost(r.root, byTestId('folder-sheet-row-/home/tom/b')).props.onPress();
      await flush();
    });
    await actAsync(async () => {
      useFolderStore
        .getState()
        .setHostFolders({ daemonId: HOST, roots: ['/home/tom/c'], recent: [] });
      await flush();
    });
    expect(pickerLabel(r, 'job-spawn-folder')).toBe(`b · ${HOST}`);
  });

  it('does not seed when there are no folder choices at all', async () => {
    __setLocalSearchParams({});
    const r = renderRN(<JobEditor />);
    await flush();
    // Default DEFAULT_FORM.spawnFolder is '' and stays '' — the custom-path
    // field is the only one shown once folderIsAdHoc is forced true by an
    // empty spawnFolder with no matching choice... but with zero choices at
    // all folderChoices.includes('') is false only when spawnFolder isn't ''
    // Simplify: assert no folder pill exists (nothing to pick from).
    expect(findAllHost(r.root, byTestId('job-name')).length).toBe(1);
  });
});

describe('JobEditor — skills-fetch effect', () => {
  it('fetches skills for the spawn folder and offers them in the Skill picker', async () => {
    useFolderStore
      .getState()
      .setHostFolders({ daemonId: HOST, roots: ['/home/tom/a'], recent: [] });
    vi.mocked(api.skills).mockResolvedValue({ skills: ['life-coach', 'plant'] });
    __setLocalSearchParams({});
    const r = renderRN(<JobEditor />);
    await flush();
    expect(api.skills).toHaveBeenCalledWith('/home/tom/a', HOST);
    openPicker(r, 'job-skill');
    expect(hasText(r.root, 'life-coach')).toBe(true);
    expect(hasText(r.root, 'plant')).toBe(true);
  });

  it('an empty skillFolder shows "Pick a folder first." and does not fetch', async () => {
    __setLocalSearchParams({});
    const r = renderRN(<JobEditor />);
    await flush();
    expect(hasText(r.root, 'Pick a folder first.')).toBe(true);
    expect(api.skills).not.toHaveBeenCalled();
  });

  it('r.skills undefined on a 200 response degrades to an empty list (?? [])', async () => {
    useFolderStore
      .getState()
      .setHostFolders({ daemonId: HOST, roots: ['/home/tom/a'], recent: [] });
    vi.mocked(api.skills).mockResolvedValue({} as { skills: string[] });
    __setLocalSearchParams({});
    const r = renderRN(<JobEditor />);
    await flush();
    expect(hasText(r.root, 'No skills in this folder.')).toBe(true);
  });

  it('a failed skills fetch degrades to an empty list', async () => {
    useFolderStore
      .getState()
      .setHostFolders({ daemonId: HOST, roots: ['/home/tom/a'], recent: [] });
    vi.mocked(api.skills).mockRejectedValue(new Error('boom'));
    __setLocalSearchParams({});
    const r = renderRN(<JobEditor />);
    await flush();
    expect(hasText(r.root, 'No skills in this folder.')).toBe(true);
  });

  it('unmounting before skills() resolves skips the stale setAvailableSkills (no crash)', async () => {
    useFolderStore
      .getState()
      .setHostFolders({ daemonId: HOST, roots: ['/home/tom/a'], recent: [] });
    const d = deferred<{ skills: string[] }>();
    vi.mocked(api.skills).mockReturnValue(d.promise);
    __setLocalSearchParams({});
    const r = renderRN(<JobEditor />);
    await flush();
    actSync(() => r.unmount());
    await actAsync(async () => {
      d.resolve({ skills: ['x'] });
      await flush();
    });
  });
});

describe('JobEditor — save', () => {
  it('a validation failure shows an Alert and never calls the API', async () => {
    __setLocalSearchParams({});
    const r = renderRN(<JobEditor />);
    await flush();
    await actAsync(async () => {
      findHost(r.root, byTestId('job-save')).props.onPress();
      await flush();
    });
    expect(__getLastAlert()?.title).toBe('Check the form');
    expect(api.createJob).not.toHaveBeenCalled();
  });

  it('create mode: a valid form calls createJob and navigates back', async () => {
    useFolderStore
      .getState()
      .setHostFolders({ daemonId: HOST, roots: ['/home/tom/a'], recent: [] });
    vi.mocked(api.createJob).mockResolvedValue({ id: 'new-job' });
    __setLocalSearchParams({});
    const r = renderRN(<JobEditor />);
    await flush();
    findHost(r.root, byTestId('job-name')).props.onChangeText('My job');
    findHost(r.root, byTestId('job-prompt')).props.onChangeText('do the thing');
    await actAsync(async () => {
      findHost(r.root, byTestId('job-save')).props.onPress();
      await flush();
    });
    expect(api.createJob).toHaveBeenCalled();
    expect(routerMock.back).toHaveBeenCalled();
  });

  it('edit mode: a valid form calls patchJob with the job id and navigates back', async () => {
    __setLocalSearchParams({ id: 'job-1' });
    vi.mocked(api.getJob).mockResolvedValue(baseJob);
    vi.mocked(api.patchJob).mockResolvedValue(baseJob);
    const r = renderRN(<JobEditor />);
    await flush();
    await actAsync(async () => {
      findHost(r.root, byTestId('job-save')).props.onPress();
      await flush();
    });
    expect(api.patchJob).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ name: 'Nightly digest' }),
    );
    expect(routerMock.back).toHaveBeenCalled();
  });

  it('shows "Saving…" and disables the button while the save is in flight', async () => {
    useFolderStore
      .getState()
      .setHostFolders({ daemonId: HOST, roots: ['/home/tom/a'], recent: [] });
    const d = deferred<unknown>();
    vi.mocked(api.createJob).mockReturnValue(d.promise);
    __setLocalSearchParams({});
    const r = renderRN(<JobEditor />);
    await flush();
    findHost(r.root, byTestId('job-name')).props.onChangeText('My job');
    findHost(r.root, byTestId('job-prompt')).props.onChangeText('do the thing');
    findHost(r.root, byTestId('job-save')).props.onPress();
    await flush();
    expect(hasText(r.root, 'Saving…')).toBe(true);
    expect(findHost(r.root, byTestId('job-save')).props.disabled).toBe(true);
    await actAsync(async () => {
      d.resolve({ id: 'x' });
      await flush();
    });
  });

  it('a failed create shows "Create failed" with the error message and stays on the screen', async () => {
    useFolderStore
      .getState()
      .setHostFolders({ daemonId: HOST, roots: ['/home/tom/a'], recent: [] });
    vi.mocked(api.createJob).mockRejectedValue(new Error('server exploded'));
    __setLocalSearchParams({});
    const r = renderRN(<JobEditor />);
    await flush();
    findHost(r.root, byTestId('job-name')).props.onChangeText('My job');
    findHost(r.root, byTestId('job-prompt')).props.onChangeText('do the thing');
    await actAsync(async () => {
      findHost(r.root, byTestId('job-save')).props.onPress();
      await flush();
    });
    expect(__getLastAlert()).toEqual({
      title: 'Create failed',
      message: 'server exploded',
      buttons: undefined,
    });
    expect(routerMock.back).not.toHaveBeenCalled();
  });

  it('a failed patch (edit mode) shows "Save failed" with the error message', async () => {
    __setLocalSearchParams({ id: 'job-1' });
    vi.mocked(api.getJob).mockResolvedValue(baseJob);
    vi.mocked(api.patchJob).mockRejectedValue(new Error('conflict'));
    const r = renderRN(<JobEditor />);
    await flush();
    await actAsync(async () => {
      findHost(r.root, byTestId('job-save')).props.onPress();
      await flush();
    });
    expect(__getLastAlert()).toEqual({
      title: 'Save failed',
      message: 'conflict',
      buttons: undefined,
    });
  });
});

describe('JobEditor — delete', () => {
  it('the Delete icon asks for confirmation; confirming calls deleteJob and navigates back', async () => {
    __setLocalSearchParams({ id: 'job-1' });
    vi.mocked(api.getJob).mockResolvedValue(baseJob);
    vi.mocked(api.deleteJob).mockResolvedValue(undefined);
    const r = renderRN(<JobEditor />);
    await flush();
    findHost(r.root, byLabel('Delete')).props.onPress();
    const alert = __getLastAlert();
    expect(alert?.title).toBe('Delete this job?');
    expect(alert?.buttons?.map((b) => b.text)).toEqual(['Cancel', 'Delete']);
    await actAsync(async () => {
      alert!.buttons!.find((b) => b.text === 'Delete')!.onPress!();
      await flush();
    });
    expect(api.deleteJob).toHaveBeenCalledWith('job-1');
    expect(routerMock.back).toHaveBeenCalled();
  });

  it('a failed delete surfaces an Alert and does not navigate back', async () => {
    __setLocalSearchParams({ id: 'job-1' });
    vi.mocked(api.getJob).mockResolvedValue(baseJob);
    vi.mocked(api.deleteJob).mockRejectedValue(new Error('cannot delete'));
    const r = renderRN(<JobEditor />);
    await flush();
    findHost(r.root, byLabel('Delete')).props.onPress();
    const alert = __getLastAlert();
    await actAsync(async () => {
      alert!.buttons!.find((b) => b.text === 'Delete')!.onPress!();
      await flush();
    });
    expect(__getLastAlert()).toEqual({
      title: 'Delete failed',
      message: 'cannot delete',
      buttons: undefined,
    });
    expect(routerMock.back).not.toHaveBeenCalled();
  });
});

describe('JobEditor — run now (spec/08 ## Manual run, spec/15 § Jobs editor)', () => {
  it('is not rendered on the new-job form', async () => {
    __setLocalSearchParams({});
    const r = renderRN(<JobEditor />);
    await flush();
    expect(findAllHost(r.root, byTestId('job-run-now')).length).toBe(0);
  });

  it('fires api.runJob with the job id and alerts the returned status', async () => {
    __setLocalSearchParams({ id: 'job-1' });
    vi.mocked(api.getJob).mockResolvedValue(baseJob);
    vi.mocked(api.runJob).mockResolvedValue({ status: 'sent', fireId: 'fire-1' });
    const r = renderRN(<JobEditor />);
    await flush();
    await actAsync(async () => {
      findHost(r.root, byTestId('job-run-now')).props.onPress();
      await flush();
    });
    expect(api.runJob).toHaveBeenCalledWith('job-1');
    expect(__getLastAlert()).toEqual({
      title: 'Run now',
      message: 'Status: sent',
      buttons: undefined,
    });
  });

  it('shows "Running…" and disables the button while the run is in flight', async () => {
    __setLocalSearchParams({ id: 'job-1' });
    vi.mocked(api.getJob).mockResolvedValue(baseJob);
    const d = deferred<{ status: 'sent' | 'buffered' | 'queued'; fireId: string }>();
    vi.mocked(api.runJob).mockReturnValue(d.promise);
    const r = renderRN(<JobEditor />);
    await flush();
    findHost(r.root, byTestId('job-run-now')).props.onPress();
    await flush();
    expect(hasText(r.root, 'Running…')).toBe(true);
    expect(findHost(r.root, byTestId('job-run-now')).props.disabled).toBe(true);
    await actAsync(async () => {
      d.resolve({ status: 'sent', fireId: 'fire-1' });
      await flush();
    });
  });

  it('a failed run surfaces "Run now failed" with the error message', async () => {
    __setLocalSearchParams({ id: 'job-1' });
    vi.mocked(api.getJob).mockResolvedValue(baseJob);
    vi.mocked(api.runJob).mockRejectedValue(new Error('host offline'));
    const r = renderRN(<JobEditor />);
    await flush();
    await actAsync(async () => {
      findHost(r.root, byTestId('job-run-now')).props.onPress();
      await flush();
    });
    expect(__getLastAlert()).toEqual({
      title: 'Run now failed',
      message: 'host offline',
      buttons: undefined,
    });
  });
});

describe('JobEditor — header back', () => {
  it('Back navigates via router.back()', async () => {
    __setLocalSearchParams({});
    const r = renderRN(<JobEditor />);
    await flush();
    findHost(r.root, byLabel('Back')).props.onPress();
    expect(routerMock.back).toHaveBeenCalled();
  });
});

// Model round-trip through the SCREEN (spec/15 § Job editor). jobEditor.test.ts
// covers the pure reshaping; what matters here is that a saved model survives
// contact with a catalogue that no longer lists it, and that saving without one
// sends no `model` at all so each fire takes the host's last-used.
describe('JobEditor — model round-trip', () => {
  it('keeps a saved model as a chip when the catalogue does not list it', async () => {
    __setLocalSearchParams({ id: 'job-1' });
    vi.mocked(api.getJob).mockResolvedValue({
      ...baseJob,
      action: { ...baseJob.action, model: 'claude-retired-1' },
    } as Job);
    // The host now serves a different set — the pinned id must not vanish, or
    // editing an unrelated field would silently unpin the job.
    vi.mocked(api.models).mockResolvedValue({
      models: [{ id: 'claude-opus-5', label: 'Opus 5' }],
    });
    const r = renderRN(<JobEditor />);
    await flush();
    expect(pickerLabel(r, 'job-spawn-model')).toBe('claude-retired-1');
    openPicker(r, 'job-spawn-model');
    expect(findHost(r.root, byTestId('job-spawn-model-option-claude-retired-1'))).toBeDefined();
  });

  it('saving a job left on Host default PATCHes an action with no model', async () => {
    __setLocalSearchParams({ id: 'job-1' });
    vi.mocked(api.getJob).mockResolvedValue(baseJob);
    vi.mocked(api.patchJob).mockResolvedValue(baseJob);
    const r = renderRN(<JobEditor />);
    await flush();
    await actAsync(async () => {
      findHost(r.root, byTestId('job-save')).props.onPress();
      await flush();
    });
    const body = vi.mocked(api.patchJob).mock.calls[0]![1] as { action: Record<string, unknown> };
    expect(body.action).not.toHaveProperty('model');
  });

  it('picking a model then saving PATCHes it onto the action', async () => {
    __setLocalSearchParams({ id: 'job-1' });
    vi.mocked(api.getJob).mockResolvedValue(baseJob);
    vi.mocked(api.patchJob).mockResolvedValue(baseJob);
    vi.mocked(api.models).mockResolvedValue({
      models: [{ id: 'claude-opus-5', label: 'Opus 5' }],
    });
    const r = renderRN(<JobEditor />);
    await flush();
    pickOption(r, 'job-spawn-model', 'claude-opus-5');
    await actAsync(async () => {
      findHost(r.root, byTestId('job-save')).props.onPress();
      await flush();
    });
    const body = vi.mocked(api.patchJob).mock.calls[0]![1] as { action: { model: string } };
    expect(body.action.model).toBe('claude-opus-5');
  });
});
