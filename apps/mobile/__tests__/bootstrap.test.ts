// lib/bootstrap.ts — app-wide bootstrap (spec/11/12/15). NO FALLBACK: a
// missing credential short-circuits (the auth gate redirects to /pair);
// permission-priming / push / callkeep failures are surfaced as banners but
// must not abort bootstrap; the cold-start chat/folder fetches are
// independently best-effort.
//
// `_booted` is module-level, so every test needs a fresh module instance —
// each test resetModules()s and re-imports bootstrap.ts AND every module it
// reads mutable state from (credential store, chat/folder/ui/voice stores,
// the mocked api) so assertions land on the same instances bootstrap.ts used.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const apiMocks = {
  me: vi.fn(),
  listChats: vi.fn(async () => ({ chats: [] })),
  folders: vi.fn(async () => ({ hosts: [] })),
};
vi.mock('../src/api/rest', () => ({ api: apiMocks }));

const wsMock = { connect: vi.fn(), send: vi.fn(), safeSend: vi.fn(), requestReplay: vi.fn() };
vi.mock('../src/api/ws', () => ({
  getWs: () => wsMock,
  resetWs: vi.fn(),
}));

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  apiMocks.listChats.mockResolvedValue({ chats: [] });
  apiMocks.folders.mockResolvedValue({ hosts: [] });
  // The MMKV stub persists by id across resetModules() (matching real MMKV's
  // disk-backed persistence) — clear it so each test starts with no saved
  // credential, matching a fresh install.
  const { __clearAllMmkv } = await import('./stubs/mmkv');
  __clearAllMmkv();
});

describe('maybeAcceptDevCredential', () => {
  it('saves the credential from a patch://?credential= deep link', async () => {
    const { maybeAcceptDevCredential } = await import('../src/lib/bootstrap');
    const { loadCredential } = await import('../src/lib/credential');
    expect(maybeAcceptDevCredential('patch://open?credential=abc.def.ghi')).toBe(true);
    expect(loadCredential()).toBe('abc.def.ghi');
  });

  it('aims the device at the server a &server= param names — no server is built in, so a credential alone leaves every chat screen throwing', async () => {
    const { maybeAcceptDevCredential } = await import('../src/lib/bootstrap');
    const { getRoute, getServerUrl, clearRoute } = await import('../src/config');
    clearRoute();
    expect(getRoute()).toBeNull();
    maybeAcceptDevCredential(
      `patch://x?credential=abc.def.ghi&server=${encodeURIComponent('https://patch.example.test/')}`,
    );
    expect(getRoute()).toEqual({ kind: 'direct', url: 'https://patch.example.test' });
    expect(getServerUrl()).toBe('https://patch.example.test');
  });

  it('leaves the route alone when the link carries no server', async () => {
    const { maybeAcceptDevCredential } = await import('../src/lib/bootstrap');
    const { getRoute, clearRoute } = await import('../src/config');
    clearRoute();
    maybeAcceptDevCredential('patch://x?credential=abc.def.ghi');
    expect(getRoute()).toBeNull();
  });

  it('returns false for a null url', async () => {
    const { maybeAcceptDevCredential } = await import('../src/lib/bootstrap');
    expect(maybeAcceptDevCredential(null)).toBe(false);
  });

  it('returns false when there is no credential query param', async () => {
    const { maybeAcceptDevCredential } = await import('../src/lib/bootstrap');
    expect(maybeAcceptDevCredential('patch://open')).toBe(false);
  });
});

describe('expoExtra', () => {
  it('reads a key out of Constants.expoConfig.extra', async () => {
    const { expoExtra } = await import('../src/lib/bootstrap');
    expect(expoExtra('sample')).toBe('value');
  });

  it('returns undefined for a missing key', async () => {
    const { expoExtra } = await import('../src/lib/bootstrap');
    expect(expoExtra('nope')).toBeUndefined();
  });

  it('falls back to {} when expoConfig itself is missing (no crash)', async () => {
    vi.doMock('expo-constants', () => ({ default: {} }));
    const { expoExtra } = await import('../src/lib/bootstrap');
    expect(expoExtra('anything')).toBeUndefined();
  });
});

describe('bootstrap()', () => {
  it('returns early (no WS connect) when there is no saved credential', async () => {
    const { bootstrap } = await import('../src/lib/bootstrap');
    await bootstrap();
    expect(wsMock.connect).not.toHaveBeenCalled();
  });

  it('connects the WS, primes permissions, hydrates chats + folders when credentialed', async () => {
    const { saveCredential } = await import('../src/lib/credential');
    saveCredential('a.b.c');
    apiMocks.listChats.mockResolvedValue({
      chats: [
        {
          chatId: 'c1',
          name: 'One',
          folder: '~/x',
          activity: 'idle',
          status: 'active',
          pinned: false,
          pinnedAt: null,
          lastUpdated: 1,
        },
      ],
    });
    // `GET /api/folders` is grouped BY HOST (spec/04 § Folders) — a flat
    // union would make two machines' identical paths indistinguishable.
    apiMocks.folders.mockResolvedValue({
      hosts: [{ daemonId: 'd1', roots: ['~/x'], recent: ['~/y'] }],
    });
    const { bootstrap } = await import('../src/lib/bootstrap');
    const { useChatStore } = await import('../src/stores/chatStore');
    const { useFolderStore } = await import('../src/stores/folderStore');
    await bootstrap();
    expect(wsMock.connect).toHaveBeenCalled();
    expect(useChatStore.getState().chats['c1']).toBeDefined();
    expect(useFolderStore.getState().foldersFor('d1')).toEqual(['~/x', '~/y']);
  });

  it('is idempotent — a second call does nothing further', async () => {
    const { saveCredential } = await import('../src/lib/credential');
    saveCredential('a.b.c');
    const { bootstrap } = await import('../src/lib/bootstrap');
    await bootstrap();
    await bootstrap();
    expect(wsMock.connect).toHaveBeenCalledTimes(1);
  });

  it('surfaces a permission-priming failure as a banner but still boots', async () => {
    const { saveCredential } = await import('../src/lib/credential');
    saveCredential('a.b.c');
    vi.doMock('../src/lib/permissionPriming', () => ({
      runPermissionPriming: vi.fn(async () => {
        throw new Error('priming boom');
      }),
    }));
    const { bootstrap } = await import('../src/lib/bootstrap');
    const { useUiStore } = await import('../src/stores/uiStore');
    await bootstrap();
    expect(
      useUiStore.getState().errors.some((e) => e.message.includes('permission priming failed')),
    ).toBe(true);
    expect(wsMock.connect).toHaveBeenCalled();
  });

  it('surfaces a push-init failure as a banner but still boots', async () => {
    const { saveCredential } = await import('../src/lib/credential');
    saveCredential('a.b.c');
    vi.doMock('../src/lib/push', () => ({
      initPush: vi.fn(async () => {
        throw new Error('push boom');
      }),
    }));
    const { bootstrap } = await import('../src/lib/bootstrap');
    const { useUiStore } = await import('../src/stores/uiStore');
    await bootstrap();
    await vi.waitFor(() =>
      expect(useUiStore.getState().errors.some((e) => e.message.includes('push init failed'))).toBe(
        true,
      ),
    );
  });

  it('surfaces a callkeep-init failure as a banner but still boots', async () => {
    const { saveCredential } = await import('../src/lib/credential');
    saveCredential('a.b.c');
    vi.doMock('../src/lib/callkeep', () => ({
      initCallKeep: vi.fn(async () => {
        throw new Error('callkeep boom');
      }),
      showIncomingCall: vi.fn(),
    }));
    const { bootstrap } = await import('../src/lib/bootstrap');
    const { useUiStore } = await import('../src/stores/uiStore');
    await bootstrap();
    await vi.waitFor(() =>
      expect(
        useUiStore.getState().errors.some((e) => e.message.includes('call setup failed')),
      ).toBe(true),
    );
  });

  it('surfaces a listChats failure as a banner but still boots (folders still fetched)', async () => {
    const { saveCredential } = await import('../src/lib/credential');
    saveCredential('a.b.c');
    apiMocks.listChats.mockRejectedValue(new Error('chats boom'));
    const { bootstrap } = await import('../src/lib/bootstrap');
    const { useUiStore } = await import('../src/stores/uiStore');
    const { useFolderStore } = await import('../src/stores/folderStore');
    await bootstrap();
    expect(
      useUiStore.getState().errors.some((e) => e.message.includes('failed to fetch chats')),
    ).toBe(true);
    expect(useFolderStore.getState().byHost).toEqual({});
  });

  it('surfaces a folders failure as a banner but still boots', async () => {
    const { saveCredential } = await import('../src/lib/credential');
    saveCredential('a.b.c');
    apiMocks.folders.mockRejectedValue(new Error('folders boom'));
    const { bootstrap } = await import('../src/lib/bootstrap');
    const { useUiStore } = await import('../src/stores/uiStore');
    await bootstrap();
    expect(
      useUiStore.getState().errors.some((e) => e.message.includes('failed to fetch folders')),
    ).toBe(true);
  });

  it('bridges a new incoming call into CallKeep via the voice-store subscription', async () => {
    const { saveCredential } = await import('../src/lib/credential');
    saveCredential('a.b.c');
    const showIncomingCall = vi.fn();
    vi.doMock('../src/lib/callkeep', () => ({
      initCallKeep: vi.fn(async () => undefined),
      showIncomingCall,
    }));
    const { bootstrap } = await import('../src/lib/bootstrap');
    const { useVoiceStore } = await import('../src/stores/voiceStore');
    await bootstrap();
    useVoiceStore.getState().setIncoming({
      callId: 'call1',
      chatId: 'chat1',
      message: undefined,
      receivedAt: Date.now(),
    });
    expect(showIncomingCall).toHaveBeenCalledWith('call1', 'chat1', 'Manager');
  });

  it('a showIncomingCall failure from the bridge is surfaced as a banner', async () => {
    const { saveCredential } = await import('../src/lib/credential');
    saveCredential('a.b.c');
    vi.doMock('../src/lib/callkeep', () => ({
      initCallKeep: vi.fn(async () => undefined),
      showIncomingCall: vi.fn(() => {
        throw new Error('callkeep not ready');
      }),
    }));
    const { bootstrap } = await import('../src/lib/bootstrap');
    const { useVoiceStore } = await import('../src/stores/voiceStore');
    const { useUiStore } = await import('../src/stores/uiStore');
    await bootstrap();
    useVoiceStore.getState().setIncoming({
      callId: 'call1',
      chatId: 'chat1',
      message: undefined,
      receivedAt: Date.now(),
    });
    expect(useUiStore.getState().errors.some((e) => e.message.includes('incoming call:'))).toBe(
      true,
    );
  });

  it('does not re-trigger the CallKeep bridge when incomingCall is unchanged', async () => {
    const { saveCredential } = await import('../src/lib/credential');
    saveCredential('a.b.c');
    const showIncomingCall = vi.fn();
    vi.doMock('../src/lib/callkeep', () => ({
      initCallKeep: vi.fn(async () => undefined),
      showIncomingCall,
    }));
    const { bootstrap } = await import('../src/lib/bootstrap');
    const { useVoiceStore } = await import('../src/stores/voiceStore');
    await bootstrap();
    const call = { callId: 'call1', chatId: 'chat1', message: undefined, receivedAt: Date.now() };
    useVoiceStore.getState().setIncoming(call);
    expect(showIncomingCall).toHaveBeenCalledTimes(1);
    // Re-set to the exact same object reference (e.g. an unrelated field in
    // the store changes) — must not fire again.
    useVoiceStore.setState({ incomingCall: call });
    expect(showIncomingCall).toHaveBeenCalledTimes(1);
  });
});

describe('teardown()', () => {
  it('resets the WS and allows bootstrap() to run again', async () => {
    const { saveCredential } = await import('../src/lib/credential');
    saveCredential('a.b.c');
    const { bootstrap, teardown } = await import('../src/lib/bootstrap');
    await bootstrap();
    expect(wsMock.connect).toHaveBeenCalledTimes(1);
    teardown();
    await bootstrap();
    expect(wsMock.connect).toHaveBeenCalledTimes(2);
  });
});

it('does not start network services with a saved credential but no server route', async () => {
  const { saveCredential } = await import('../src/lib/credential');
  const { clearRoute } = await import('../src/config');
  const { bootstrap } = await import('../src/lib/bootstrap');
  saveCredential('a.b.c');
  clearRoute();
  await bootstrap();
  expect(wsMock.connect).not.toHaveBeenCalled();
  expect(apiMocks.listChats).not.toHaveBeenCalled();
});
