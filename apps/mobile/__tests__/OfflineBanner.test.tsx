// Render coverage for the amber WS banner (spec/15 § Offline / error states).
// Pins the "no offline flash on load" guarantee: shown ONLY for
// reconnecting/offline, never for the initial `connecting` state and never
// while connected.

import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { renderRN, hasText, findHost, byTestId } from './testUtils/render';
import { OfflineBanner } from '../src/components/OfflineBanner';
import { usePresenceStore } from '../src/stores/presenceStore';
import { useUiStore } from '../src/stores/uiStore';

afterEach(() => {
  usePresenceStore.setState({ connection: 'connecting', outageVisible: false });
});

describe('OfflineBanner — quiet states render nothing', () => {
  it('renders nothing while connecting (NO offline flash on load)', () => {
    usePresenceStore.setState({ connection: 'connecting' });
    const r = renderRN(<OfflineBanner />);
    expect(r.toJSON()).toBeNull();
  });

  it('renders nothing while connected', () => {
    usePresenceStore.setState({ connection: 'connected' });
    const r = renderRN(<OfflineBanner />);
    expect(r.toJSON()).toBeNull();
  });
});

describe('OfflineBanner — degraded states render the banner', () => {
  it('renders nothing while a drop is inside its grace period (resume reconnect)', () => {
    usePresenceStore.setState({ connection: 'reconnecting', outageVisible: false });
    const r = renderRN(<OfflineBanner />);
    expect(r.toJSON()).toBeNull();
  });

  it('shows "Reconnecting…" while reconnecting', () => {
    usePresenceStore.setState({ connection: 'reconnecting', outageVisible: true });
    const r = renderRN(<OfflineBanner />);
    expect(hasText(r.root, 'Reconnecting…')).toBe(true);
  });

  it('shows "Offline" once a connect attempt has failed', () => {
    usePresenceStore.setState({ connection: 'offline', outageVisible: true });
    const r = renderRN(<OfflineBanner />);
    expect(hasText(r.root, 'Offline')).toBe(true);
  });

  // spec/12 § Connection diagnostics screen: 'Reconnecting…' on its own is a
  // dead end — the banner must open the diagnostics screen.
  it('Diagnose opens the connection diagnostics screen', () => {
    useUiStore.setState({ diagnosticsOpen: false });
    usePresenceStore.setState({ connection: 'reconnecting', outageVisible: true });
    const r = renderRN(<OfflineBanner />);
    findHost(r.root, byTestId('offline-diagnose')).props.onPress();
    expect(useUiStore.getState().diagnosticsOpen).toBe(true);
    useUiStore.setState({ diagnosticsOpen: false });
  });
});
