// lib/otaUpdates.ts — the AUTOMATIC OTA path: check + fetch on launch and while
// the app stays open (spec/11 § Mobile OTA). `__DEV__` is fixed to false under
// test (see vitest.config.ts `define`); every branch (disabled, no update,
// update fetched, and each step's failure) is driven via the expo-updates stub.
//
// The load-bearing assertion in this file is a NEGATIVE one: no automatic path
// may call `Updates.reloadAsync()`. Reloading mid-launch is what made the app
// paint the old bundle, go white, and load again; reloading while it is open
// yanks the screen out from under the user. A downloaded bundle waits for the
// next natural launch, which expo-updates does by itself.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('checkForOtaUpdate', () => {
  it('no-ops when Updates.isEnabled is false (dev / Expo Go)', async () => {
    const Updates = await import('./stubs/expo-updates');
    Updates.__setEnabled(false);
    const checkSpy = vi.spyOn(Updates, 'checkForUpdateAsync');
    const { checkForOtaUpdate } = await import('../src/lib/otaUpdates');
    await checkForOtaUpdate();
    expect(checkSpy).not.toHaveBeenCalled();
  });

  it('checks and does nothing when no update is available', async () => {
    const Updates = await import('./stubs/expo-updates');
    Updates.__setEnabled(true);
    Updates.__setCheckResult({ isAvailable: false });
    const fetchSpy = vi.spyOn(Updates, 'fetchUpdateAsync');
    const reloadSpy = vi.spyOn(Updates, 'reloadAsync');
    const { checkForOtaUpdate } = await import('../src/lib/otaUpdates');
    await checkForOtaUpdate();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  // This assertion is deliberately the inverse of what it used to be: the old
  // code reloaded here, and that reload IS the white flash + second load Tom
  // reported. Fetch only; the fetched bundle launches on the next cold start.
  it('fetches an available update but does NOT reload into it', async () => {
    const Updates = await import('./stubs/expo-updates');
    Updates.__setEnabled(true);
    Updates.__setCheckResult({ isAvailable: true });
    const fetchSpy = vi.spyOn(Updates, 'fetchUpdateAsync');
    const reloadSpy = vi.spyOn(Updates, 'reloadAsync');
    const { checkForOtaUpdate } = await import('../src/lib/otaUpdates');
    await checkForOtaUpdate();
    expect(fetchSpy).toHaveBeenCalled();
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('a checkForUpdateAsync failure is caught + logged, never thrown', async () => {
    const Updates = await import('./stubs/expo-updates');
    Updates.__setEnabled(true);
    vi.spyOn(Updates, 'checkForUpdateAsync').mockRejectedValue(new Error('network down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { checkForOtaUpdate } = await import('../src/lib/otaUpdates');
    await expect(checkForOtaUpdate()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('[ota] update check failed', expect.any(Error));
    warn.mockRestore();
  });

  it('a fetchUpdateAsync failure is caught + logged, never thrown', async () => {
    const Updates = await import('./stubs/expo-updates');
    Updates.__setEnabled(true);
    Updates.__setCheckResult({ isAvailable: true });
    Updates.__setFetchError(new Error('fetch failed'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { checkForOtaUpdate } = await import('../src/lib/otaUpdates');
    await expect(checkForOtaUpdate()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('[ota] update check failed', expect.any(Error));
    warn.mockRestore();
  });
});

describe('startOtaUpdatePolling', () => {
  it('no-ops when Updates.isEnabled is false (dev / Expo Go)', async () => {
    vi.useFakeTimers();
    const Updates = await import('./stubs/expo-updates');
    const RN = await import('./stubs/react-native');
    Updates.__setEnabled(false);
    const checkSpy = vi.spyOn(Updates, 'checkForUpdateAsync');
    const { startOtaUpdatePolling } = await import('../src/lib/otaUpdates');
    const stop = startOtaUpdatePolling();
    RN.__emitAppStateChange('background');
    RN.__emitAppStateChange('active');
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
    stop();
    expect(checkSpy).not.toHaveBeenCalled();
  });

  it('re-checks on the interval and fetches without reloading', async () => {
    vi.useFakeTimers();
    const Updates = await import('./stubs/expo-updates');
    Updates.__setEnabled(true);
    Updates.__setCheckResult({ isAvailable: true });
    const fetchSpy = vi.spyOn(Updates, 'fetchUpdateAsync');
    const reloadSpy = vi.spyOn(Updates, 'reloadAsync');
    const { startOtaUpdatePolling } = await import('../src/lib/otaUpdates');
    const stop = startOtaUpdatePolling();
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    stop();
    expect(fetchSpy).toHaveBeenCalled();
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  // Returning to the app is exactly when a reload was most destructive: Tom
  // would swipe back in and watch it flash and start over.
  it('re-checks on background -> foreground and fetches without reloading', async () => {
    const Updates = await import('./stubs/expo-updates');
    const RN = await import('./stubs/react-native');
    Updates.__setEnabled(true);
    Updates.__setCheckResult({ isAvailable: true });
    const fetchSpy = vi.spyOn(Updates, 'fetchUpdateAsync');
    const reloadSpy = vi.spyOn(Updates, 'reloadAsync');
    const { startOtaUpdatePolling } = await import('../src/lib/otaUpdates');
    const stop = startOtaUpdatePolling();
    RN.__emitAppStateChange('background');
    RN.__emitAppStateChange('active');
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    stop();
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('teardown stops the interval and the AppState listener', async () => {
    vi.useFakeTimers();
    const Updates = await import('./stubs/expo-updates');
    const RN = await import('./stubs/react-native');
    Updates.__setEnabled(true);
    Updates.__setCheckResult({ isAvailable: true });
    const checkSpy = vi.spyOn(Updates, 'checkForUpdateAsync');
    const { startOtaUpdatePolling } = await import('../src/lib/otaUpdates');
    startOtaUpdatePolling()();
    RN.__emitAppStateChange('background');
    RN.__emitAppStateChange('active');
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
    expect(checkSpy).not.toHaveBeenCalled();
  });
});
