// Move page (spec/04 § Moving a chat to another host, spec/15 § Chat detail →
// Move to…): the other machines, the same-named folder offered, and a refusal
// kept on screen with the server's reason.

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderRN, findHost, byTestId, hasText, flush, actSync } from './testUtils/render';
import ChatMove from '../app/chats/[chatId]/move';
import { __resetRouterMock, __setLocalSearchParams, routerMock } from './stubs/expo-router';
import { useChatStore } from '../src/stores/chatStore';
import { useFolderStore } from '../src/stores/folderStore';
import { usePresenceStore } from '../src/stores/presenceStore';
import { ApiError } from '../src/api/rest';

const { moveSpy } = vi.hoisted(() => ({ moveSpy: vi.fn() }));
vi.mock('../src/api/rest', async (orig) => ({
  ...(await orig<typeof import('../src/api/rest')>()),
  api: {
    markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
    moveChat: moveSpy,
  },
}));

function report(daemonId: string, hostName: string): void {
  usePresenceStore.getState().setHostReport({
    type: 'daemon.host',
    daemonId,
    hostName,
    platform: 'linux',
    arch: 'x64',
    daemonVersion: '0.1.400',
    updateAvailable: false,
    permissionModeDefault: 'default',
    permissionOverrides: 0,
    isHomeHost: false,
    backends: [],
    components: [],
  });
  usePresenceStore.getState().setHostOnline(daemonId, true);
}

const press = (root: Parameters<typeof findHost>[0], id: string): void =>
  actSync(() => {
    (findHost(root, byTestId(id)).props.onPress as () => void)();
  });

describe('Chat Move screen', () => {
  beforeEach(() => {
    __resetRouterMock();
    moveSpy.mockReset();
    usePresenceStore.setState({ hosts: {} });
    useFolderStore.getState()._reset();
    useChatStore.getState()._reset();
    report('mac', 'Mac');
    report('box', 'Hetzner');
    useFolderStore.getState().setAllFolders([
      { daemonId: 'mac', roots: ['/Users/tom/wpp/Unite'], recent: [] },
      { daemonId: 'box', roots: [], recent: ['/home/tom/projects', '/home/tom/Unite'] },
    ]);
    useChatStore
      .getState()
      .applyEvents([
        { type: 'chat.spawned', chatId: 'c1', daemonId: 'mac', folder: '/Users/tom/wpp/Unite' },
      ]);
    __setLocalSearchParams({ chatId: 'c1' });
  });

  it('offers the other machine with its same-named folder filled in', () => {
    const r = renderRN(<ChatMove />);
    expect(hasText(findHost(r.root, byTestId('move-from')), 'Mac · /Users/tom/wpp/Unite')).toBe(
      true,
    );
    expect(() => findHost(r.root, byTestId('move-host-mac'))).toThrow();
    expect(findHost(r.root, byTestId('move-folder')).props.value).toBe('/home/tom/Unite');
  });

  it('moves, then goes back to the chat', async () => {
    moveSpy.mockResolvedValue({
      ok: true,
      chatId: 'c1',
      daemonId: 'box',
      folder: '/home/tom/Unite',
    });
    const r = renderRN(<ChatMove />);
    press(r.root, 'move-confirm');
    await flush();
    expect(moveSpy).toHaveBeenCalledWith('c1', 'box', '/home/tom/Unite');
    expect(
      routerMock.back.mock.calls.length + routerMock.replace.mock.calls.length,
    ).toBeGreaterThan(0);
  });

  it('a refusal stays on the page and says why', async () => {
    moveSpy.mockRejectedValue(
      new ApiError(409, 'busy', { error: 'busy', message: 'Mac: this chat is mid-turn' }),
    );
    const r = renderRN(<ChatMove />);
    press(r.root, 'move-confirm');
    await flush();
    expect(hasText(findHost(r.root, byTestId('move-error')), 'Mac: this chat is mid-turn')).toBe(
      true,
    );
  });

  it('a folder from the list can be picked instead', () => {
    const r = renderRN(<ChatMove />);
    press(r.root, 'move-folder-option-/home/tom/projects');
    expect(findHost(r.root, byTestId('move-folder')).props.value).toBe('/home/tom/projects');
  });

  it('with no same-named folder, the first folder the machine offers is selected', () => {
    useFolderStore.getState().setAllFolders([
      { daemonId: 'mac', roots: ['/Users/tom/wpp/Unite'], recent: [] },
      { daemonId: 'box', roots: [], recent: ['/home/tom/projects', '/home/tom/other'] },
    ]);
    const r = renderRN(<ChatMove />);
    expect(findHost(r.root, byTestId('move-folder')).props.value).toBe('/home/tom/projects');
  });
});
