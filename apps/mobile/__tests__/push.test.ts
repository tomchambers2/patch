// lib/push.ts — Expo push registration (spec/09). NO FALLBACK: a denied
// permission or empty token throws. Exercises the full happy path,
// both throw branches, the foreground/backgrounded notification-handler
// policy, and the received/token-rotation listeners.
//
// push.ts guards on a module-level `_registered` flag, so each test needs a
// FRESH module instance (vi.resetModules) — and, because resetModules also
// gives a fresh instance of every module push.ts imports (the notifications
// stub, the mocked api/rest), each test re-imports those dynamically too and
// asserts against THAT instance, not a stale top-level one.

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/api/rest', () => ({ api: { pushRegister: vi.fn(async () => undefined) } }));

beforeEach(() => {
  vi.resetModules();
});

describe('initPush — happy path', () => {
  it('sets up channels, requests permission, registers the device token, is idempotent', async () => {
    const Notifications = await import('./stubs/expo-notifications');
    const { api } = await import('../src/api/rest');
    const { initPush } = await import('../src/lib/push');
    await initPush();
    expect(Notifications.__getChannel('patch_messages')).toMatchObject({ name: 'Messages' });
    expect(Notifications.__getChannel('patch_call')).toMatchObject({ name: 'Manager calls' });
    // spec/09 § Reaching the user — urgent is normal with the bundled urgent sound.
    expect(Notifications.__getChannel('patch_urgent_alert')).toMatchObject({
      name: 'Urgent',
      sound: 'patch_urgent.wav',
    });
    expect(Notifications.__getChannel('patch_urgent')).toBeUndefined();
    expect(api.pushRegister).toHaveBeenCalledWith('ExponentPushToken[test-token]');
    // Second call is a no-op (already registered).
    await initPush();
    expect(api.pushRegister).toHaveBeenCalledTimes(1);
  });

  it('the notification handler shows an alert only when backgrounded', async () => {
    const Notifications = await import('./stubs/expo-notifications');
    const { AppState } = await import('react-native');
    const { initPush } = await import('../src/lib/push');
    await initPush();
    const handler = Notifications.__getNotificationHandler() as {
      handleNotification: () => Promise<{ shouldShowAlert: boolean }>;
    };
    AppState.currentState = 'active';
    await expect(handler.handleNotification()).resolves.toMatchObject({ shouldShowAlert: false });
    AppState.currentState = 'background';
    await expect(handler.handleNotification()).resolves.toMatchObject({ shouldShowAlert: true });
  });
});

describe('initPush — NO FALLBACK throws', () => {
  it('throws when notification permission is denied', async () => {
    const Notifications = await import('./stubs/expo-notifications');
    Notifications.__setPermission({ granted: false });
    const { initPush } = await import('../src/lib/push');
    await expect(initPush()).rejects.toThrow(/permission denied/);
  });

  it('throws when the Expo push token is empty', async () => {
    const Notifications = await import('./stubs/expo-notifications');
    Notifications.__setExpoPushToken({ data: '' });
    const { initPush } = await import('../src/lib/push');
    await expect(initPush()).rejects.toThrow(/empty Expo push token/);
  });

  it('throws when there is no EAS project id in the app config', async () => {
    vi.doMock('expo-constants', () => ({ default: { expoConfig: { extra: {} } } }));
    try {
      const { initPush } = await import('../src/lib/push');
      await expect(initPush()).rejects.toThrow(/no EAS project id/);
    } finally {
      // vi.doMock outlives vi.resetModules() (it only clears the module
      // cache, not registered mock factories) — undo it so later tests in
      // this file get the real expo-constants stub back.
      vi.doUnmock('expo-constants');
    }
  });
});

describe('initPush — listeners', () => {
  it('a call notification triggers showIncomingCall via callkeep', async () => {
    const showIncomingCall = vi.fn();
    vi.doMock('../src/lib/callkeep', () => ({ showIncomingCall }));
    const Notifications = await import('./stubs/expo-notifications');
    const { initPush } = await import('../src/lib/push');
    await initPush();
    Notifications.__emitNotificationReceived({
      request: {
        content: {
          data: { kind: 'call', callId: 'call1', chatId: 'chat1', callerLabel: 'Manager' },
        },
      },
    });
    expect(showIncomingCall).toHaveBeenCalledWith('call1', 'chat1', 'Manager');
  });

  it('a call notification with no data at all is ignored (data ?? {} branch)', async () => {
    const showIncomingCall = vi.fn();
    vi.doMock('../src/lib/callkeep', () => ({ showIncomingCall }));
    const Notifications = await import('./stubs/expo-notifications');
    const { initPush } = await import('../src/lib/push');
    await initPush();
    expect(() =>
      Notifications.__emitNotificationReceived({ request: { content: {} } }),
    ).not.toThrow();
    expect(showIncomingCall).not.toHaveBeenCalled();
  });

  it('a call notification with no callerLabel defaults to "Manager"', async () => {
    const showIncomingCall = vi.fn();
    vi.doMock('../src/lib/callkeep', () => ({ showIncomingCall }));
    const Notifications = await import('./stubs/expo-notifications');
    const { initPush } = await import('../src/lib/push');
    await initPush();
    Notifications.__emitNotificationReceived({
      request: { content: { data: { kind: 'call', callId: 'call1', chatId: 'chat1' } } },
    });
    expect(showIncomingCall).toHaveBeenCalledWith('call1', 'chat1', 'Manager');
  });

  it('a call notification missing callId/chatId is ignored', async () => {
    const showIncomingCall = vi.fn();
    vi.doMock('../src/lib/callkeep', () => ({ showIncomingCall }));
    const Notifications = await import('./stubs/expo-notifications');
    const { initPush } = await import('../src/lib/push');
    await initPush();
    Notifications.__emitNotificationReceived({
      request: { content: { data: { kind: 'call' } } },
    });
    expect(showIncomingCall).not.toHaveBeenCalled();
  });

  it('a non-call notification does not trigger showIncomingCall', async () => {
    const showIncomingCall = vi.fn();
    vi.doMock('../src/lib/callkeep', () => ({ showIncomingCall }));
    const Notifications = await import('./stubs/expo-notifications');
    const { initPush } = await import('../src/lib/push');
    await initPush();
    Notifications.__emitNotificationReceived({
      request: { content: { data: { kind: 'message' } } },
    });
    expect(showIncomingCall).not.toHaveBeenCalled();
  });

  it('re-registers with the freshly-minted Expo push token on native token rotation', async () => {
    const Notifications = await import('./stubs/expo-notifications');
    const { api } = await import('../src/api/rest');
    const { initPush } = await import('../src/lib/push');
    await initPush();
    vi.mocked(api.pushRegister).mockClear();
    // addPushTokenListener fires with the NATIVE device token, not the Expo
    // one — push.ts must re-derive the Expo token rather than forward this.
    Notifications.__setExpoPushToken({ data: 'ExponentPushToken[rotated]' });
    Notifications.__emitPushToken({ data: 'native-rotated-token' });
    await Promise.resolve();
    await Promise.resolve();
    expect(api.pushRegister).toHaveBeenCalledWith('ExponentPushToken[rotated]');
  });

  it('a token-rotation event that re-derives an empty Expo token does nothing', async () => {
    const Notifications = await import('./stubs/expo-notifications');
    const { api } = await import('../src/api/rest');
    const { initPush } = await import('../src/lib/push');
    await initPush();
    vi.mocked(api.pushRegister).mockClear();
    Notifications.__setExpoPushToken({ data: '' });
    Notifications.__emitPushToken({ data: 'native-rotated-token' });
    await Promise.resolve();
    await Promise.resolve();
    expect(api.pushRegister).not.toHaveBeenCalled();
  });
});
