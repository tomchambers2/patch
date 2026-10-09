// Settings → Devices (spec/14 § Hosts & devices; design/settings-redesign):
// a 'Link a device' header action minting a real single-use QR
// (`POST /api/auth/pair/start`); the Linked group read from web's own list
// (`/api/settings`), each other device revocable (`POST /api/auth/revoke`), with
// the push-registration count. Plus the Voice devices group Settings → Voice
// shows.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactTestRenderer } from 'react-test-renderer';
import {
  DevicesPage,
  LinkedDevicesSection,
  VoiceDevicesSection,
  buildPairingPayload,
  deviceSubtitle,
  qrPath,
} from '../src/components/settings/DevicesSections';
import {
  renderRN,
  findHost,
  queryHost,
  byTestId,
  byLabel,
  hasText,
  textOf,
  actAsync,
  flush,
} from './testUtils/render';
import { api, type LinkedDevice } from '../src/api/rest';
import { __getLastAlert, __clearLastAlert, __setColorScheme } from './stubs/react-native';
import { parsePairingUri } from '@patch/wire';
import { setRoute } from '../src/config';
import { usePresenceStore } from '../src/stores/presenceStore';
import { useSettingsStore } from '../src/stores/settingsStore';
import {
  reportHost,
  resetHosts,
  seedSettings,
  settingsFixture,
} from './testUtils/settingsFixtures';

vi.mock('../src/api/rest', () => ({
  api: {
    settings: vi.fn(),
    revoke: vi.fn(),
    surfacePairStart: vi.fn(),
  },
}));

const NOW = 1_800_000_000_000;

const DEVICES: LinkedDevice[] = [
  {
    surfaceId: 'me',
    surfaceKind: 'mobile',
    label: '',
    issuedAt: 1,
    status: 'online',
    lastHeartbeat: 1,
    isCurrent: true,
  },
  {
    surfaceId: 'desk',
    surfaceKind: 'desktop',
    label: '',
    issuedAt: 1,
    status: 'offline',
    lastHeartbeat: null,
    isCurrent: false,
  },
  {
    surfaceId: 'tab',
    surfaceKind: 'tablet',
    label: 'Kitchen iPad',
    issuedAt: 1,
    status: 'online',
    lastHeartbeat: 1,
    isCurrent: false,
  },
];

beforeEach(() => {
  vi.mocked(api.settings).mockReset().mockResolvedValue(settingsFixture());
  vi.mocked(api.revoke).mockReset().mockResolvedValue({ ok: true });
  vi.mocked(api.surfacePairStart).mockReset().mockResolvedValue({ nonce: 'n0nce', expiresAt: 1 });
  __clearLastAlert();
  useSettingsStore.getState()._reset();
});

afterEach(() => {
  vi.useRealTimers();
  __setColorScheme('light');
});

async function openLink(r: ReactTestRenderer): Promise<void> {
  await actAsync(async () => {
    findHost(r.root, byTestId('link-device')).props.onPress();
    await flush();
  });
}

describe('deviceSubtitle', () => {
  const base = DEVICES[1]!;

  it('says "This device" for the current surface, whatever its state', () => {
    expect(deviceSubtitle({ ...base, isCurrent: true, status: 'offline' }, NOW)).toBe(
      'This device',
    );
  });

  it('is just the kind when the device is online', () => {
    expect(deviceSubtitle({ ...base, status: 'online' }, NOW)).toBe('Desktop');
    // The kind, never the custom label (that is the row title).
    expect(deviceSubtitle({ ...DEVICES[2]! }, NOW)).toBe('Tablet');
  });

  it('adds when it was last seen when it is not online', () => {
    expect(
      deviceSubtitle({ ...base, status: 'offline', lastHeartbeat: NOW - 5 * 60_000 }, NOW),
    ).toBe('Desktop · seen 5m ago');
    expect(deviceSubtitle({ ...base, status: 'stale', lastHeartbeat: NOW - 30_000 }, NOW)).toBe(
      'Desktop · seen 30s ago',
    );
    expect(
      deviceSubtitle({ ...base, status: 'offline', lastHeartbeat: NOW - 7_200_000 }, NOW),
    ).toBe('Desktop · seen 2h ago');
  });

  it('a device that never sent a heartbeat reads "seen never"', () => {
    expect(deviceSubtitle({ ...base, status: 'offline', lastHeartbeat: null }, NOW)).toBe(
      'Desktop · seen never',
    );
  });

  it('an unknown kind reads as "Device"', () => {
    expect(deviceSubtitle({ ...base, surfaceKind: 'toaster', status: 'online' }, NOW)).toBe(
      'Device',
    );
  });
});

describe('Settings — Devices page', () => {
  it('is titled Devices, with Link a device in the header and Linked below', () => {
    seedSettings({ devices: DEVICES });
    const r = renderRN(<DevicesPage />);
    expect(textOf(findHost(r.root, byTestId('settings-page-title')))).toBe('Devices');
    expect(textOf(findHost(r.root, byTestId('link-device')))).toBe('Link a device');
    expect(findHost(r.root, byTestId('settings-devices'))).toBeTruthy();
  });
});

describe('Linked devices', () => {
  it('is titled Linked and states the push-registration count', () => {
    seedSettings({ devices: DEVICES, push: { tokenCount: 2 } });
    const r = renderRN(<LinkedDevicesSection />);
    expect(hasText(r.root, 'Linked')).toBe(true);
    expect(hasText(r.root, 'Push')).toBe(true);
    expect(textOf(findHost(r.root, byTestId('push-count')))).toBe('2 registered');
  });

  it('states a zero push count rather than hiding it', () => {
    seedSettings({ devices: DEVICES, push: { tokenCount: 0 } });
    const r = renderRN(<LinkedDevicesSection />);
    expect(textOf(findHost(r.root, byTestId('push-count')))).toBe('0 registered');
  });

  it('draws each device by name with its subtitle, and offers Revoke only on the others', () => {
    seedSettings({ devices: DEVICES });
    const r = renderRN(<LinkedDevicesSection />);
    expect(textOf(findHost(r.root, byTestId('device-me')))).toBe('PhoneThis device');
    expect(queryHost(r.root, byTestId('device-revoke-me'))).toBeNull();
    expect(textOf(findHost(r.root, byTestId('device-desk')))).toBe(
      'DesktopDesktop · seen neverRevoke',
    );
    expect(textOf(findHost(r.root, byTestId('device-tab')))).toBe('Kitchen iPadTabletRevoke');
    const revoke = findHost(r.root, byTestId('device-revoke-desk'));
    expect(textOf(revoke)).toBe('Revoke');
  });

  it('Revoke calls POST /api/auth/revoke with that id, then re-reads the list', async () => {
    seedSettings({ devices: DEVICES });
    vi.mocked(api.settings).mockResolvedValue(
      settingsFixture({ devices: [DEVICES[0]!, DEVICES[2]!] }),
    );
    const r = renderRN(<LinkedDevicesSection />);
    await actAsync(async () => {
      findHost(r.root, byTestId('device-revoke-desk')).props.onPress();
      await flush();
    });
    expect(api.revoke).toHaveBeenCalledWith('desk');
    expect(api.settings).toHaveBeenCalled();
    expect(queryHost(r.root, byTestId('device-desk'))).toBeNull();
    expect(findHost(r.root, byTestId('device-tab'))).toBeTruthy();
  });

  it('a failed revoke is reported and the row stays', async () => {
    seedSettings({ devices: DEVICES });
    vi.mocked(api.revoke).mockRejectedValue(new Error('HTTP 403'));
    const r = renderRN(<LinkedDevicesSection />);
    await actAsync(async () => {
      findHost(r.root, byTestId('device-revoke-desk')).props.onPress();
      await flush();
    });
    expect(__getLastAlert()).toEqual({
      title: 'Revoke failed',
      message: 'HTTP 403',
      buttons: undefined,
    });
    expect(api.settings).not.toHaveBeenCalled();
    expect(findHost(r.root, byTestId('device-desk'))).toBeTruthy();
  });

  it('with no devices shows "No linked devices" (and still the push count)', () => {
    seedSettings({ devices: [] });
    const r = renderRN(<LinkedDevicesSection />);
    expect(textOf(findHost(r.root, byTestId('devices-empty')))).toBe('No linked devices');
    expect(findHost(r.root, byTestId('push-count'))).toBeTruthy();
  });

  it('before settings load: a spinner; on a failed load, the failure with a Retry', async () => {
    useSettingsStore.setState({ data: null, error: null });
    const r = renderRN(<LinkedDevicesSection />);
    expect(findHost(r.root, byTestId('devices-loading'))).toBeTruthy();
    await actAsync(() => useSettingsStore.setState({ error: 'HTTP 502' }));
    expect(textOf(findHost(r.root, byTestId('devices-error')))).toBe(
      'Couldn’t load settings: HTTP 502',
    );
    vi.mocked(api.settings).mockResolvedValue(settingsFixture({ devices: DEVICES }));
    await actAsync(async () => {
      findHost(r.root, byLabel('Retry')).props.onPress();
      await flush();
    });
    expect(findHost(r.root, byTestId('device-desk'))).toBeTruthy();
  });
});

describe('Link a device', () => {
  it('mints a code only when opened, and draws it as a scannable QR plus the nonce', async () => {
    seedSettings();
    const r = renderRN(<DevicesPage />);
    expect(api.surfacePairStart).not.toHaveBeenCalled();
    expect(queryHost(r.root, byTestId('link-device-panel'))).toBeNull();
    await openLink(r);
    expect(api.surfacePairStart).toHaveBeenCalledTimes(1);
    expect(findHost(r.root, byTestId('link-device-panel'))).toBeTruthy();
    // The header action is hidden while the panel is open.
    expect(queryHost(r.root, byTestId('link-device'))).toBeNull();
    const svg = findHost(r.root, byTestId('link-device-qr'));
    const path = svg.findAll((n) => n.type === 'Path')[0]!;
    expect(path.props.d).toBe(qrPath(buildPairingPayload({ nonce: 'n0nce' })).d);
    expect(textOf(findHost(r.root, byTestId('link-device-nonce')))).toBe('n0nce');
    await actAsync(() => findHost(r.root, byTestId('link-device-close')).props.onPress());
    expect(queryHost(r.root, byTestId('link-device-panel'))).toBeNull();
    expect(findHost(r.root, byTestId('link-device'))).toBeTruthy();
  });

  it('draws dark modules on a light ground in either colour scheme', async () => {
    seedSettings();
    const modules = async (): Promise<{ ground: unknown; ink: unknown }> => {
      const r = renderRN(<DevicesPage />);
      await openLink(r);
      const svg = findHost(r.root, byTestId('link-device-qr'));
      return {
        ground: svg.findAll((n) => n.type === 'Rect')[0]!.props.fill,
        ink: svg.findAll((n) => n.type === 'Path')[0]!.props.fill,
      };
    };
    const light = await modules();
    __setColorScheme('dark');
    const dark = await modules();
    // The dark theme swaps paper and ink, so the QR swaps which it takes —
    // leaving the same dark-on-light result a scanner reads.
    expect(dark.ground).not.toBe(light.ground);
    expect(dark.ink).not.toBe(light.ink);
    expect(light.ground).not.toBe(light.ink);
  });

  it('shows a loading line until the code arrives', async () => {
    seedSettings();
    vi.mocked(api.surfacePairStart).mockReturnValue(new Promise(() => {}));
    const r = renderRN(<DevicesPage />);
    await openLink(r);
    expect(textOf(findHost(r.root, byTestId('link-device-loading')))).toBe(
      'Issuing a pairing code…',
    );
    expect(queryHost(r.root, byTestId('link-device-qr'))).toBeNull();
  });

  it('a mint failure is shown with a Retry, never a decorative image', async () => {
    seedSettings();
    vi.mocked(api.surfacePairStart).mockRejectedValueOnce(new Error('HTTP 500'));
    const r = renderRN(<DevicesPage />);
    await openLink(r);
    expect(queryHost(r.root, byTestId('link-device-qr'))).toBeNull();
    expect(textOf(findHost(r.root, byTestId('link-device-error')))).toBe(
      'Could not issue a pairing code: HTTP 500',
    );
    await actAsync(async () => {
      findHost(r.root, byLabel('Retry')).props.onPress();
      await flush();
    });
    expect(queryHost(r.root, byTestId('link-device-error'))).toBeNull();
    expect(findHost(r.root, byTestId('link-device-qr'))).toBeTruthy();
  });

  it('re-mints before the five-minute expiry while open, and stops once closed', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    seedSettings();
    vi.mocked(api.surfacePairStart)
      .mockResolvedValueOnce({ nonce: 'first', expiresAt: 1 })
      .mockResolvedValueOnce({ nonce: 'second', expiresAt: 2 });
    const r = renderRN(<DevicesPage />);
    await openLink(r);
    expect(textOf(findHost(r.root, byTestId('link-device-nonce')))).toBe('first');
    await actAsync(async () => {
      vi.advanceTimersByTime(4.5 * 60 * 1000);
      await flush();
    });
    expect(api.surfacePairStart).toHaveBeenCalledTimes(2);
    expect(textOf(findHost(r.root, byTestId('link-device-nonce')))).toBe('second');
    await actAsync(() => findHost(r.root, byTestId('link-device-close')).props.onPress());
    await actAsync(async () => {
      vi.advanceTimersByTime(10 * 60 * 1000);
      await flush();
    });
    expect(api.surfacePairStart).toHaveBeenCalledTimes(2);
  });

  it('encodes the code the server issued when it issued one', () => {
    expect(buildPairingPayload({ nonce: 'n', uri: 'patch-pair://srv.example.com?nonce=n' })).toBe(
      'patch-pair://srv.example.com?nonce=n',
    );
  });

  it('otherwise gives the way THIS device reaches the server, direct or through a relay', () => {
    setRoute({ kind: 'direct', url: 'https://patch.example.dev/' });
    expect(parsePairingUri(buildPairingPayload({ nonce: 'a b' }))).toEqual({
      nonce: 'a b',
      server: 'https://patch.example.dev',
      relay: null,
    });
    const relay = { url: 'wss://relay.example.com', channel: 'c', serverKey: 'k' };
    setRoute({ kind: 'relay', relay });
    expect(parsePairingUri(buildPairingPayload({ nonce: 'x' })).relay).toEqual(relay);
  });

  it('draws a square module grid', () => {
    const { size, d } = qrPath('patch-pair://h?nonce=1');
    expect(size).toBeGreaterThanOrEqual(21);
    expect(d.startsWith('M')).toBe(true);
  });
});

describe('Voice devices', () => {
  it('asks for a host first when none has reported', () => {
    resetHosts();
    const r = renderRN(<VoiceDevicesSection />);
    expect(hasText(r.root, 'Voice devices')).toBe(true);
    expect(textOf(findHost(r.root, byTestId('voice-devices-no-machines')))).toBe(
      'Add a host first',
    );
    expect(queryHost(r.root, byTestId('voice-devices-empty'))).toBeNull();
  });

  it('a registered host that has not reported yet does not count', () => {
    resetHosts();
    usePresenceStore.getState().setHostOnline('silent', true);
    const r = renderRN(<VoiceDevicesSection />);
    expect(findHost(r.root, byTestId('voice-devices-no-machines'))).toBeTruthy();
  });

  it('says how a device is adopted once a machine exists — no code or QR', () => {
    resetHosts();
    reportHost('d1');
    const r = renderRN(<VoiceDevicesSection />);
    expect(queryHost(r.root, byTestId('voice-devices-no-machines'))).toBeNull();
    expect(hasText(findHost(r.root, byTestId('voice-devices-empty')), 'None paired')).toBe(true);
    expect(textOf(findHost(r.root, byTestId('voice-devices-how')))).toBe('patch hosts pair-device');
    expect(queryHost(r.root, byTestId('link-device-qr'))).toBeNull();
  });
});
