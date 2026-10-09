// The mobile COLD LAUNCH, end to end through the real root layout and the real
// OTA module (spec/11 § Mobile OTA "NO automatic reload").
//
// Todoist: "Patch when loading mobile it loads flashes white then loads again".
// The launch effect in app/_layout.tsx used to call an otaUpdates.ts that
// finished with `Updates.reloadAsync()`, so the first launch after any OTA
// publish painted the old bundle, tore the whole JS context down and started
// over — one white frame and a second load.
//
// otaUpdates.test.ts pins that unit's behaviour in isolation. This file pins the
// WIRING, which is where the bug actually lived: the root layout is mounted for
// real, `../src/lib/otaUpdates` is NOT mocked, an update IS available on the
// channel, and the launch must still paint once and stay on the running bundle.
// Only bootstrap is doubled, so no socket or network work happens.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderRN, flush, findHost, byType } from './testUtils/render';
import { __resetRouterMock, __setRootNavigationReady } from './stubs/expo-router';
import { __setColorScheme, __emitAppStateChange } from './stubs/react-native';
import { __setLastNotificationResponse } from './stubs/expo-notifications';
import { __setFontsLoaded, __setFontsError } from './stubs/google-fonts';
import { __setInitialURL } from './stubs/expo-linking';
import { __setEnabled, __setCheckResult, __setChannel } from './stubs/expo-updates';
import * as Updates from 'expo-updates';
import { useUiStore } from '../src/stores/uiStore';

const { bootstrapSpy } = vi.hoisted(() => ({ bootstrapSpy: vi.fn(async () => undefined) }));
vi.mock('../src/lib/bootstrap', () => ({ bootstrap: bootstrapSpy }));

import RootLayout from '../app/_layout';

beforeEach(() => {
  __resetRouterMock();
  __setColorScheme('light');
  __setLastNotificationResponse(null);
  __setInitialURL(null);
  __setFontsLoaded(true);
  __setFontsError(null);
  __setRootNavigationReady(true);
  useUiStore.setState({ errors: [] });
  bootstrapSpy.mockClear();
  // A real release build with a newer bundle waiting on the channel — the exact
  // situation that produced the double load.
  __setEnabled(true);
  __setChannel('preview');
  __setCheckResult({ isAvailable: true });
  vi.spyOn(Updates, 'fetchUpdateAsync').mockResolvedValue();
  vi.spyOn(Updates, 'reloadAsync').mockResolvedValue();
});

afterEach(() => {
  vi.restoreAllMocks();
  __setCheckResult({ isAvailable: false });
});

describe('cold launch with an OTA update waiting', () => {
  it('downloads the update and never reloads, so the launch paints once', async () => {
    const r = renderRN(<RootLayout />);
    // Painted on the first commit, before any OTA work resolves.
    const firstStack = findHost(r.root, byType('Stack'));
    expect(firstStack).toBeTruthy();

    await flush();

    // The update is on the device, ready for the next natural launch...
    expect(Updates.fetchUpdateAsync).toHaveBeenCalled();
    // ...and the running bundle was left alone. This is THE assertion.
    expect(Updates.reloadAsync).not.toHaveBeenCalled();
    // Same tree, still painted: no restart, no blank frame, no remount.
    expect(findHost(r.root, byType('Stack'))).toBe(firstStack);
    // And a deliberate no-reload is not a swallowed error: nothing was queued.
    expect(useUiStore.getState().errors).toEqual([]);
  });

  it('returning to the foreground downloads without restarting the app', async () => {
    const r = renderRN(<RootLayout />);
    await flush();
    vi.mocked(Updates.fetchUpdateAsync).mockClear();

    __emitAppStateChange('background');
    __emitAppStateChange('active');
    await flush();

    expect(Updates.fetchUpdateAsync).toHaveBeenCalled();
    expect(Updates.reloadAsync).not.toHaveBeenCalled();
    expect(findHost(r.root, byType('Stack'))).toBeTruthy();
  });
});
