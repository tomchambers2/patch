// lib/buildInfo.ts — provenance of the running mobile client (spec/11 §
// Version reporting). The NATIVE_* values are EXPO_PUBLIC_* env, inlined by
// Metro and read once at module load, so each case sets the env and re-imports
// with a fresh module. `builtAt` distinguishes an OTA launch (report the OTA
// bundle's createdAt) from an embedded APK launch (report the APK build time),
// driven via the expo-updates stub.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ENV_KEYS = [
  'EXPO_PUBLIC_PATCH_VERSION',
  'EXPO_PUBLIC_PATCH_GIT_SHA',
  'EXPO_PUBLIC_PATCH_BUILT_AT',
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.resetModules();
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('mobileBuildInfo', () => {
  it('reports "dev" with no sha/builtAt when unstamped (Metro / Expo Go run)', async () => {
    const { mobileBuildInfo } = await import('../src/lib/buildInfo');
    expect(mobileBuildInfo()).toEqual({ version: 'dev' });
  });

  it('reports the injected native version + sha', async () => {
    process.env['EXPO_PUBLIC_PATCH_VERSION'] = '0.1.343';
    process.env['EXPO_PUBLIC_PATCH_GIT_SHA'] = 'a059a40';
    const { mobileBuildInfo } = await import('../src/lib/buildInfo');
    expect(mobileBuildInfo()).toEqual({ version: '0.1.343', gitSha: 'a059a40' });
  });

  it('reports the APK build time when the launch is embedded (no OTA bundle)', async () => {
    process.env['EXPO_PUBLIC_PATCH_VERSION'] = '0.1.343';
    process.env['EXPO_PUBLIC_PATCH_BUILT_AT'] = '2026-07-31T10:00:00.000Z';
    const Updates = await import('./stubs/expo-updates');
    Updates.__setEnabled(true);
    Updates.__setEmbeddedLaunch(true); // embedded → use NATIVE_BUILT_AT
    const { mobileBuildInfo } = await import('../src/lib/buildInfo');
    expect(mobileBuildInfo().builtAt).toBe('2026-07-31T10:00:00.000Z');
  });

  // The regression this pins: `builtAt` used to be taken from
  // `Updates.createdAt` on an OTA launch, which describes the update the runtime
  // has most recently DOWNLOADED — not necessarily the one executing. A phone
  // holding a freshly downloaded bundle then reported the running bundle's
  // version beside the pending bundle's timestamp, which is how one came to show
  // "0.1.658 (fe11bf6)" built at the moment a far later update was published.
  // All three fields come from the same Metro inlining now, so they describe one
  // bundle and cannot drift apart.
  it('describes the RUNNING bundle even when a newer update has been downloaded', async () => {
    process.env['EXPO_PUBLIC_PATCH_VERSION'] = '0.1.343';
    process.env['EXPO_PUBLIC_PATCH_GIT_SHA'] = 'abc1234';
    process.env['EXPO_PUBLIC_PATCH_BUILT_AT'] = '2026-07-31T10:00:00.000Z';
    const Updates = await import('./stubs/expo-updates');
    Updates.__setEnabled(true);
    Updates.__setEmbeddedLaunch(false);
    // A LATER update sitting downloaded on the device.
    Updates.__setCreatedAt(new Date('2026-08-28T12:57:45.000Z'));
    const { mobileBuildInfo } = await import('../src/lib/buildInfo');
    expect(mobileBuildInfo()).toEqual({
      version: '0.1.343',
      gitSha: 'abc1234',
      builtAt: '2026-07-31T10:00:00.000Z',
    });
  });

  it('omits builtAt entirely when nothing describes the running JS', async () => {
    process.env['EXPO_PUBLIC_PATCH_VERSION'] = '0.1.343';
    const { mobileBuildInfo } = await import('../src/lib/buildInfo');
    expect(mobileBuildInfo().builtAt).toBeUndefined();
  });
});
