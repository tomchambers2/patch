// lib/updateCheck.ts — manual OTA check + "last checked" persistence for the
// Settings → Version panel. `__DEV__` is fixed false under test (vitest.config
// `define`); the disabled path is driven via the expo-updates stub's
// __setEnabled, and MMKV is the in-memory stub (aliased in vitest.config).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { __clearAllMmkv } from './stubs/mmkv';
import type * as Updates from './stubs/expo-updates';

beforeEach(() => {
  vi.resetModules();
  __clearAllMmkv();
});

describe('getLastCheckedAt / recordUpdateCheck', () => {
  it('is null before any check, and returns the stamped instant after one', async () => {
    const { getLastCheckedAt, recordUpdateCheck } = await import('../src/lib/updateCheck');
    expect(getLastCheckedAt()).toBeNull();
    recordUpdateCheck('2026-07-31T09:00:00.000Z');
    expect(getLastCheckedAt()).toBe('2026-07-31T09:00:00.000Z');
  });
});

describe('runUpdateCheck', () => {
  it('returns {disabled} and does NOT record when updates are off (dev / Expo Go)', async () => {
    const Updates = await import('./stubs/expo-updates');
    Updates.__setEnabled(false);
    const checkSpy = vi.spyOn(Updates, 'checkForUpdateAsync');
    const { runUpdateCheck, getLastCheckedAt } = await import('../src/lib/updateCheck');
    expect(await runUpdateCheck()).toEqual({ status: 'disabled' });
    expect(checkSpy).not.toHaveBeenCalled();
    expect(getLastCheckedAt()).toBeNull();
  });

  it('returns {current} and records the check when nothing newer is available', async () => {
    const Updates = await import('./stubs/expo-updates');
    Updates.__setEnabled(true);
    Updates.__setCheckResult({ isAvailable: false });
    const fetchSpy = vi.spyOn(Updates, 'fetchUpdateAsync');
    const { runUpdateCheck, getLastCheckedAt } = await import('../src/lib/updateCheck');
    expect(await runUpdateCheck()).toEqual({ status: 'current' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getLastCheckedAt()).not.toBeNull();
  });

  it('fetches (but does NOT reload) and returns {downloaded} when an update exists', async () => {
    const Updates = await import('./stubs/expo-updates');
    Updates.__setEnabled(true);
    Updates.__setCheckResult({ isAvailable: true });
    const fetchSpy = vi.spyOn(Updates, 'fetchUpdateAsync');
    const reloadSpy = vi.spyOn(Updates, 'reloadAsync');
    const { runUpdateCheck, getLastCheckedAt } = await import('../src/lib/updateCheck');
    expect(await runUpdateCheck()).toEqual({ status: 'downloaded' });
    expect(fetchSpy).toHaveBeenCalled();
    expect(reloadSpy).not.toHaveBeenCalled();
    expect(getLastCheckedAt()).not.toBeNull();
  });

  it('returns {error} (and still records) when the check throws', async () => {
    const Updates = await import('./stubs/expo-updates');
    Updates.__setEnabled(true);
    vi.spyOn(Updates, 'checkForUpdateAsync').mockRejectedValue(new Error('network down'));
    const { runUpdateCheck, getLastCheckedAt } = await import('../src/lib/updateCheck');
    expect(await runUpdateCheck()).toEqual({ status: 'error', message: 'network down' });
    expect(getLastCheckedAt()).not.toBeNull();
  });

  it('returns {error} when the fetch throws after a successful check', async () => {
    const Updates = await import('./stubs/expo-updates');
    Updates.__setEnabled(true);
    Updates.__setCheckResult({ isAvailable: true });
    Updates.__setFetchError(new Error('fetch failed'));
    const { runUpdateCheck } = await import('../src/lib/updateCheck');
    expect(await runUpdateCheck()).toEqual({ status: 'error', message: 'fetch failed' });
  });

  // Module-wide invariant, not one branch of it: the ONLY reload in the app is
  // the "Restart to update" button, so no outcome of a check may reload. An
  // automatic reload is what made the app flash white and load twice
  // (spec/11 § Mobile OTA "NO automatic reload").
  it('never reloads, on any outcome', async () => {
    for (const setup of [
      (U: typeof Updates) => U.__setEnabled(false),
      (U: typeof Updates) => {
        U.__setEnabled(true);
        U.__setCheckResult({ isAvailable: false });
      },
      (U: typeof Updates) => {
        U.__setEnabled(true);
        U.__setCheckResult({ isAvailable: true });
      },
      (U: typeof Updates) => {
        U.__setEnabled(true);
        U.__setCheckResult({ isAvailable: true });
        U.__setFetchError(new Error('fetch failed'));
      },
      (U: typeof Updates) => {
        U.__setEnabled(true);
        U.__setChannel(null);
      },
    ]) {
      vi.resetModules();
      const Updates = await import('./stubs/expo-updates');
      setup(Updates);
      const reloadSpy = vi.spyOn(Updates, 'reloadAsync');
      const { runUpdateCheck } = await import('../src/lib/updateCheck');
      await runUpdateCheck();
      expect(reloadSpy).not.toHaveBeenCalled();
    }
  });

  it('returns a clear {error} — and records the check, without ever calling the network — when the build has no channel', async () => {
    const Updates = await import('./stubs/expo-updates');
    Updates.__setEnabled(true);
    Updates.__setChannel(null);
    const checkSpy = vi.spyOn(Updates, 'checkForUpdateAsync');
    const { runUpdateCheck, getLastCheckedAt } = await import('../src/lib/updateCheck');
    expect(await runUpdateCheck()).toEqual({
      status: 'error',
      message:
        'This build has no update channel (built locally, not via EAS) — it can never receive an OTA update.',
    });
    expect(checkSpy).not.toHaveBeenCalled();
    expect(getLastCheckedAt()).not.toBeNull();
  });
});

// The published-APK check answers the question OTA cannot: "is there a native
// build I don't have?" It matters most exactly when OTA is broken (an APK with
// no channel), so it must not depend on the OTA path working.
describe('fetchPublishedApk', () => {
  const sidecar = {
    version: '0.1.540',
    gitSha: 'abc1234',
    builtAt: '2026-08-17T10:00:00.000Z',
    file: 'patch-abc1234.apk',
  };

  it('returns null when the box publishes no APK sidecar', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 404, ok: false })),
    );
    const { fetchPublishedApk } = await import('../src/lib/updateCheck');
    expect(await fetchPublishedApk()).toBeNull();
  });

  it('flags a published build this phone is not running, with a download URL', async () => {
    vi.doMock('../src/lib/buildInfo', () => ({
      mobileBuildInfo: () => ({ version: '0.1.500', gitSha: 'old9999' }),
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 200, ok: true, json: async () => sidecar })),
    );
    const { fetchPublishedApk } = await import('../src/lib/updateCheck');
    const apk = await fetchPublishedApk();
    expect(apk).toMatchObject({ version: '0.1.540', gitSha: 'abc1234', newer: true });
    expect(apk?.url).toContain('/api/download/patch-abc1234.apk');
    vi.doUnmock('../src/lib/buildInfo');
  });

  it('does NOT flag a build whose commit is already running', async () => {
    // The running sha comes from an EXPO_PUBLIC_* literal Metro inlines at build
    // time, which is absent under vitest — so stub buildInfo to stand in for a
    // phone already running this exact APK.
    vi.doMock('../src/lib/buildInfo', () => ({
      mobileBuildInfo: () => ({ version: '0.1.540', gitSha: 'abc1234' }),
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 200, ok: true, json: async () => sidecar })),
    );
    const { fetchPublishedApk } = await import('../src/lib/updateCheck');
    expect((await fetchPublishedApk())?.newer).toBe(false);
    vi.doUnmock('../src/lib/buildInfo');
  });

  // The healthy, ordinary case: an OTA has moved this phone's JS ahead of the
  // native shell it launched under, so the running commit legitimately differs
  // from — and postdates — the last APK build. A bare sha comparison would
  // wrongly flag this as "something to install"; the build-time comparison
  // does not.
  it('does NOT flag a build this phone has already moved past via OTA, even with a different commit', async () => {
    vi.doMock('../src/lib/buildInfo', () => ({
      mobileBuildInfo: () => ({
        version: '0.1.600',
        gitSha: 'running9',
        builtAt: '2026-08-20T00:00:00.000Z', // after sidecar.builtAt
      }),
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 200, ok: true, json: async () => sidecar })),
    );
    const { fetchPublishedApk } = await import('../src/lib/updateCheck');
    expect((await fetchPublishedApk())?.newer).toBe(false);
    vi.doUnmock('../src/lib/buildInfo');
  });

  // The bug this comparison exists to catch: a phone stuck on an old native
  // runtime, where OTA has gone silent — the published APK is genuinely more
  // recent than what this phone last built, so it must be flagged even though
  // this phone's own OTA path reports nothing wrong.
  it('flags a build genuinely more recent than this phone has ever run', async () => {
    vi.doMock('../src/lib/buildInfo', () => ({
      mobileBuildInfo: () => ({
        version: '0.1.500',
        gitSha: 'stale999',
        builtAt: '2026-08-10T00:00:00.000Z', // before sidecar.builtAt
      }),
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 200, ok: true, json: async () => sidecar })),
    );
    const { fetchPublishedApk } = await import('../src/lib/updateCheck');
    expect((await fetchPublishedApk())?.newer).toBe(true);
    vi.doUnmock('../src/lib/buildInfo');
  });

  // NO FALLBACK: a server error must not read as "up to date".
  it('throws on a non-404 error rather than reporting no update', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 500, ok: false })),
    );
    const { fetchPublishedApk } = await import('../src/lib/updateCheck');
    await expect(fetchPublishedApk()).rejects.toThrow('HTTP 500');
  });
});
