// Host Files browser (spec/15 § Host files and terminal).

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderRN, findHost, byTestId, hasText, flush, actSync } from './testUtils/render';
import HostFiles from '../app/hosts/[daemonId]/files';
import { routerMock, __resetRouterMock, __setLocalSearchParams } from './stubs/expo-router';
import { useFolderStore } from '../src/stores/folderStore';
import { usePresenceStore } from '../src/stores/presenceStore';

const { listSpy } = vi.hoisted(() => ({ listSpy: vi.fn() }));
vi.mock('../src/api/rest', async (orig) => ({
  ...(await orig<typeof import('../src/api/rest')>()),
  api: { hostFilesList: listSpy },
}));

function reportHost(): void {
  usePresenceStore.getState().setHostReport({
    type: 'daemon.host',
    daemonId: 'd1',
    hostName: 'hetzner',
    platform: 'linux',
    arch: 'x64',
    daemonVersion: '0.1.400',
    updateAvailable: false,
    permissionModeDefault: 'default',
    permissionOverrides: 0,
    isHomeHost: true,
    backends: [],
    components: [],
  });
}

const press = (root: Parameters<typeof findHost>[0], id: string): void =>
  actSync(() => {
    (findHost(root, byTestId(id)).props.onPress as () => void)();
  });

describe('Host Files screen', () => {
  beforeEach(() => {
    __resetRouterMock();
    listSpy.mockReset();
    // Screens from earlier tests are still mounted and re-render as the stores
    // reset; give their re-run listings something that never settles.
    listSpy.mockReturnValue(new Promise(() => undefined));
    usePresenceStore.setState({ hosts: {} });
    useFolderStore.getState()._reset();
    reportHost();
  });

  it('with no path lists the host`s home, names the host, and draws dirs before files', async () => {
    __setLocalSearchParams({ daemonId: 'd1' });
    listSpy.mockResolvedValue({
      path: '/home/tom',
      parent: '/home',
      entries: [
        { name: '.claude', type: 'dir' },
        { name: 'notes.md', type: 'file', size: 4300 },
        { name: 'broken', type: 'other' },
      ],
    });
    const r = renderRN(<HostFiles />);
    expect(findHost(r.root, byTestId('files-loading'))).toBeTruthy();
    await flush();
    expect(listSpy).toHaveBeenCalledWith('d1', undefined);
    expect(hasText(r.root, 'hetzner')).toBe(true);
    expect(hasText(findHost(r.root, byTestId('files-dir-path')), '/home/tom')).toBe(true);
    expect(hasText(r.root, '4.2 KB')).toBe(true);
    // A dangling link is shown, and cannot be opened.
    expect(findHost(r.root, byTestId('files-entry-broken')).props.disabled).toBe(true);
  });

  it('a folder pushes the next directory; a file opens the editor', async () => {
    __setLocalSearchParams({ daemonId: 'd1', path: '/home/tom' });
    listSpy.mockResolvedValue({
      path: '/home/tom',
      parent: '/home',
      entries: [
        { name: '.claude', type: 'dir' },
        { name: 'notes.md', type: 'file', size: 1 },
      ],
    });
    const r = renderRN(<HostFiles />);
    await flush();
    expect(listSpy).toHaveBeenCalledWith('d1', '/home/tom');
    press(r.root, 'files-entry-.claude');
    expect(routerMock.push).toHaveBeenLastCalledWith({
      pathname: '/hosts/[daemonId]/files',
      params: { daemonId: 'd1', path: '/home/tom/.claude' },
    });
    press(r.root, 'files-entry-notes.md');
    expect(routerMock.push).toHaveBeenLastCalledWith({
      pathname: '/hosts/[daemonId]/edit',
      params: { daemonId: 'd1', path: '/home/tom/notes.md' },
    });
    press(r.root, 'files-up');
    expect(routerMock.push).toHaveBeenLastCalledWith({
      pathname: '/hosts/[daemonId]/files',
      params: { daemonId: 'd1', path: '/home' },
    });
  });

  it('offers Home and the host`s project folders as places, marking the one on screen', async () => {
    useFolderStore.getState().setHostFolders({
      daemonId: 'd1',
      roots: ['/home/tom/projects/patch'],
      recent: ['/home/tom/projects/garden'],
    });
    __setLocalSearchParams({ daemonId: 'd1', path: '/home/tom/projects/patch' });
    listSpy.mockResolvedValue({
      path: '/home/tom/projects/patch',
      parent: '/home/tom/projects',
      entries: [],
    });
    const r = renderRN(<HostFiles />);
    await flush();
    const here = findHost(r.root, byTestId('place-chip-/home/tom/projects/patch'));
    expect(here.props.accessibilityState).toEqual({ selected: true });
    press(r.root, 'place-chip-/home/tom/projects/garden');
    expect(routerMock.push).toHaveBeenLastCalledWith({
      pathname: '/hosts/[daemonId]/files',
      params: { daemonId: 'd1', path: '/home/tom/projects/garden' },
    });
    press(r.root, 'place-chip-home');
    expect(routerMock.push).toHaveBeenLastCalledWith({
      pathname: '/hosts/[daemonId]/files',
      params: { daemonId: 'd1' },
    });
    // An empty directory says so rather than drawing nothing.
    expect(hasText(r.root, 'Empty folder')).toBe(true);
  });

  it('marks Home once the host has said where it is', async () => {
    __setLocalSearchParams({ daemonId: 'd1' });
    listSpy.mockResolvedValue({ path: '/home/tom', parent: '/home', entries: [] });
    const r = renderRN(<HostFiles />);
    await flush();
    expect(findHost(r.root, byTestId('place-chip-home')).props.accessibilityState).toEqual({
      selected: true,
    });
  });

  it('opens a terminal in the directory on screen', async () => {
    __setLocalSearchParams({ daemonId: 'd1', path: '/srv' });
    listSpy.mockResolvedValue({ path: '/srv', parent: '/', entries: [] });
    const r = renderRN(<HostFiles />);
    await flush();
    press(r.root, 'files-terminal-here');
    expect(routerMock.push).toHaveBeenLastCalledWith({
      pathname: '/hosts/[daemonId]/terminal',
      params: { daemonId: 'd1', folder: '/srv' },
    });
  });

  it('shows the root as `/` with no way further up', async () => {
    __setLocalSearchParams({ daemonId: 'd1', path: '/' });
    listSpy.mockResolvedValue({ path: '/', parent: null, entries: [{ name: 'etc', type: 'dir' }] });
    const r = renderRN(<HostFiles />);
    await flush();
    expect(r.root.findAll((n) => n.props?.testID === 'files-up')).toHaveLength(0);
    expect(hasText(findHost(r.root, byTestId('files-dir-name')), '/')).toBe(true);
    press(r.root, 'files-entry-etc');
    expect(routerMock.push).toHaveBeenLastCalledWith({
      pathname: '/hosts/[daemonId]/files',
      params: { daemonId: 'd1', path: '/etc' },
    });
  });

  it('a failed listing says why in place of the list (NO FALLBACK)', async () => {
    __setLocalSearchParams({ daemonId: 'd1', path: '/root' });
    listSpy.mockRejectedValue(new Error('permission_denied: permission denied: /root'));
    const r = renderRN(<HostFiles />);
    await flush();
    expect(hasText(findHost(r.root, byTestId('files-error')), 'permission denied')).toBe(true);
    expect(r.root.findAll((n) => n.props?.testID === 'files-terminal-here')).toHaveLength(0);
  });

  it('back leaves the screen', async () => {
    __setLocalSearchParams({ daemonId: 'd1' });
    listSpy.mockResolvedValue({ path: '/home/tom', parent: '/home', entries: [] });
    const r = renderRN(<HostFiles />);
    await flush();
    press(r.root, 'host-tool-back');
    expect(routerMock.back).toHaveBeenCalled();
  });

  it('names a host that has never reported by its id rather than inventing a name', async () => {
    usePresenceStore.setState({ hosts: {} });
    __setLocalSearchParams({ daemonId: 'd9' });
    listSpy.mockResolvedValue({ path: '/home/x', parent: '/home', entries: [] });
    const r = renderRN(<HostFiles />);
    await flush();
    expect(hasText(r.root, 'd9')).toBe(true);
  });

  it('drops the answer of a listing the user has already navigated away from', async () => {
    __setLocalSearchParams({ daemonId: 'd1' });
    let resolve!: (v: unknown) => void;
    listSpy.mockReturnValue(new Promise((r) => (resolve = r)));
    const r = renderRN(<HostFiles />);
    r.unmount();
    resolve({ path: '/home/tom', parent: '/home', entries: [] });
    await flush();
    let reject!: (e: Error) => void;
    listSpy.mockReturnValue(new Promise((_r, j) => (reject = j)));
    const r2 = renderRN(<HostFiles />);
    r2.unmount();
    reject(new Error('late'));
    await flush();
  });
});
