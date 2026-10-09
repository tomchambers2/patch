// Host file editor (spec/15 § Host files and terminal): explicit Save, a dirty
// marker, a save that never overwrites a file changed on disk, and a back that
// asks before dropping edits.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ReactTestRenderer } from 'react-test-renderer';
import {
  renderRN,
  findHost,
  byTestId,
  hasText,
  flush,
  actSync,
  actAsync,
} from './testUtils/render';
import HostFileEditor from '../app/hosts/[daemonId]/edit';
import { routerMock, __resetRouterMock, __setLocalSearchParams } from './stubs/expo-router';
import {
  __clearLastAlert,
  __getLastAlert,
  __pressBack,
  __backListenerCount,
} from './stubs/react-native';
import { ApiError } from '../src/api/rest';
import { usePresenceStore } from '../src/stores/presenceStore';

const { readSpy, writeSpy } = vi.hoisted(() => ({ readSpy: vi.fn(), writeSpy: vi.fn() }));
vi.mock('../src/api/rest', async (orig) => ({
  ...(await orig<typeof import('../src/api/rest')>()),
  api: { hostFileRead: readSpy, hostFileWrite: writeSpy },
}));

const PATH = '/home/tom/.claude/skills/plant/SKILL.md';

const mounted: ReactTestRenderer[] = [];
async function open(): Promise<ReactTestRenderer> {
  const r = renderRN(<HostFileEditor />);
  mounted.push(r);
  await flush();
  return r;
}

const input = (r: ReactTestRenderer) => findHost(r.root, byTestId('editor-text'));
const type = (r: ReactTestRenderer, text: string): void =>
  actSync(() => {
    (input(r).props.onChangeText as (t: string) => void)(text);
  });
const saveButton = (r: ReactTestRenderer) => findHost(r.root, byTestId('editor-save'));
const pressSave = (r: ReactTestRenderer) =>
  actAsync(async () => {
    (saveButton(r).props.onPress as () => void)();
  });

describe('Host file editor', () => {
  beforeEach(() => {
    __resetRouterMock();
    __clearLastAlert();
    readSpy.mockReset();
    writeSpy.mockReset();
    usePresenceStore.setState({ hosts: {} });
    __setLocalSearchParams({ daemonId: 'd1', path: PATH });
    readSpy.mockResolvedValue({ path: PATH, content: '# plant\n', size: 8, version: 'v1' });
  });
  afterEach(() => {
    actSync(() => {
      for (const r of mounted.splice(0)) r.unmount();
    });
  });

  it('opens the file into a monospace, no-autocorrect editor', async () => {
    const r = renderRN(<HostFileEditor />);
    mounted.push(r);
    expect(findHost(r.root, byTestId('editor-loading'))).toBeTruthy();
    await flush();
    expect(readSpy).toHaveBeenCalledWith('d1', PATH);
    const props = input(r).props;
    expect(props.value).toBe('# plant\n');
    expect(props.autoCorrect).toBe(false);
    expect(props.autoCapitalize).toBe('none');
    expect(props.multiline).toBe(true);
    expect(hasText(r.root, 'SKILL.md')).toBe(true);
    expect(hasText(r.root, PATH)).toBe(true);
  });

  it('Save is off until something changes; an edit marks the file dirty', async () => {
    const r = await open();
    expect(saveButton(r).props.disabled).toBe(true);
    expect(hasText(r.root, '●')).toBe(false);
    type(r, '# plant\nwater weekly\n');
    expect(saveButton(r).props.disabled).toBe(false);
    expect(hasText(r.root, 'SKILL.md ●')).toBe(true);
    // Typing it back to what is on disk is not a change.
    type(r, '# plant\n');
    expect(saveButton(r).props.disabled).toBe(true);
  });

  it('saves over the version it opened, then is clean at the new version', async () => {
    writeSpy.mockResolvedValueOnce({ path: PATH, size: 20, version: 'v2' });
    writeSpy.mockResolvedValueOnce({ path: PATH, size: 25, version: 'v3' });
    const r = await open();
    type(r, '# plant\nwater weekly\n');
    await pressSave(r);
    expect(writeSpy).toHaveBeenCalledWith('d1', {
      path: PATH,
      content: '# plant\nwater weekly\n',
      baseVersion: 'v1',
    });
    expect(saveButton(r).props.disabled).toBe(true);
    expect(hasText(r.root, '●')).toBe(false);
    // The next save builds on the version the last one produced.
    type(r, '# plant\nwater weekly\nfeed\n');
    await pressSave(r);
    expect(writeSpy).toHaveBeenLastCalledWith('d1', expect.objectContaining({ baseVersion: 'v2' }));
  });

  it('a file changed on disk is NOT overwritten: the editor says so and offers Reload', async () => {
    writeSpy.mockRejectedValue(new ApiError(409, 'conflict: changed on disk', null));
    const r = await open();
    type(r, 'my edit');
    await pressSave(r);
    const alert = __getLastAlert();
    expect(alert?.title).toBe('Changed on disk');
    // Still dirty — nothing was written.
    expect(hasText(r.root, 'SKILL.md ●')).toBe(true);
    readSpy.mockResolvedValue({ path: PATH, content: 'agent edit', size: 10, version: 'v9' });
    await actAsync(async () => {
      alert?.buttons?.find((b) => b.text === 'Reload')?.onPress?.();
    });
    await flush();
    expect(input(r).props.value).toBe('agent edit');
    expect(saveButton(r).props.disabled).toBe(true);
  });

  it('any other save failure is reported with its reason, edits kept', async () => {
    writeSpy.mockRejectedValue(new ApiError(503, 'host_offline: d1 is offline', null));
    const r = await open();
    type(r, 'my edit');
    await pressSave(r);
    expect(__getLastAlert()).toMatchObject({
      title: 'Save failed',
      message: 'host_offline: d1 is offline',
    });
    expect(input(r).props.value).toBe('my edit');
  });

  it('a file that cannot be opened says why (NO FALLBACK)', async () => {
    readSpy.mockRejectedValue(new ApiError(415, 'binary: not UTF-8 text', null));
    const r = await open();
    expect(hasText(findHost(r.root, byTestId('editor-error')), 'binary: not UTF-8 text')).toBe(
      true,
    );
    expect(r.root.findAll((n) => n.props?.testID === 'editor-text')).toHaveLength(0);
  });

  it('back with nothing unsaved just leaves', async () => {
    const r = await open();
    actSync(() => {
      (findHost(r.root, byTestId('host-tool-back')).props.onPress as () => void)();
    });
    expect(routerMock.back).toHaveBeenCalledTimes(1);
    expect(__getLastAlert()).toBeNull();
  });

  it('back with unsaved edits asks first — from the header and from the system back', async () => {
    const r = await open();
    type(r, 'unsaved');
    actSync(() => {
      (findHost(r.root, byTestId('host-tool-back')).props.onPress as () => void)();
    });
    expect(routerMock.back).not.toHaveBeenCalled();
    expect(__getLastAlert()?.title).toBe('Discard changes?');
    __clearLastAlert();
    let consumed = false;
    actSync(() => {
      consumed = __pressBack();
    });
    expect(consumed).toBe(true);
    expect(routerMock.back).not.toHaveBeenCalled();
    const alert = __getLastAlert();
    expect(alert?.title).toBe('Discard changes?');
    actSync(() => alert?.buttons?.find((b) => b.text === 'Discard')?.onPress?.());
    expect(routerMock.back).toHaveBeenCalledTimes(1);
  });

  it('lets go of the system back when it leaves', async () => {
    const before = __backListenerCount();
    const r = await open();
    expect(__backListenerCount()).toBe(before + 1);
    mounted.splice(mounted.indexOf(r), 1);
    actSync(() => r.unmount());
    expect(__backListenerCount()).toBe(before);
  });
});
