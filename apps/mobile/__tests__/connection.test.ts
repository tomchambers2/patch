// Items 2 / 9 / 20 — connection + daemon-presence state model (spec/12
// § Surface connection state model, § Daemon-offline UX; spec/15 § Offline /
// error states). The two failure modes (WS-down vs daemon-down) are tracked
// separately and must never collapse into one indicator, and the app must
// never show an offline/reconnecting treatment before it has ever connected.

import { describe, it, expect } from 'vitest';
import { usePresenceStore } from '../src/stores/presenceStore';
import {
  connectionDotColor,
  offlineBannerText,
  daemonOfflineBannerText,
  daemonControlsDisabled,
  daemonControlDisabledReason,
  DAEMON_OFFLINE_BANNER,
} from '../src/lib/connection';
import { lightColors as colors } from '../src/lib/theme';

describe('presenceStore defaults', () => {
  it("initialises connection to 'connecting', not 'offline'", () => {
    expect(usePresenceStore.getState().connection).toBe('connecting');
  });

  it("host presence defaults to 'unknown', not offline", () => {
    expect(usePresenceStore.getState().daemon).toBe('unknown');
  });
});

describe('offlineBannerText — no offline flash on load', () => {
  it('renders nothing before a connection has ever been made', () => {
    expect(offlineBannerText('connecting', true)).toBeNull();
  });
  it('renders nothing while connected', () => {
    expect(offlineBannerText('connected', true)).toBeNull();
  });
  it('banners only once we know we dropped / are offline', () => {
    expect(offlineBannerText('reconnecting', true)).toBe('Reconnecting…');
    expect(offlineBannerText('offline', true)).toBe('Offline');
  });
  it('renders nothing while the outage is still inside its grace period', () => {
    expect(offlineBannerText('reconnecting', false)).toBeNull();
    expect(offlineBannerText('offline', false)).toBeNull();
  });
});

describe('connectionDotColor — WS link only', () => {
  it('no dot while connecting (no offline treatment before first connect)', () => {
    expect(connectionDotColor('connecting', colors)).toBeNull();
  });
  it('green when connected', () => {
    expect(connectionDotColor('connected', colors)).toBe(colors.leaf);
  });
  it('amber while reconnecting after a drop', () => {
    expect(connectionDotColor('reconnecting', colors)).toBe(colors.amber);
  });
  it('red once a connect attempt has failed, or the credential was refused', () => {
    expect(connectionDotColor('offline', colors)).toBe(colors.red);
    expect(connectionDotColor('unauthenticated', colors)).toBe(colors.red);
  });
});

describe('daemon-offline is a distinct, explained state', () => {
  it('shows the app-level banner only when the host is known-offline', () => {
    expect(daemonOfflineBannerText('unknown')).toBeNull();
    expect(daemonOfflineBannerText('online')).toBeNull();
    expect(daemonOfflineBannerText('offline')).toBe(DAEMON_OFFLINE_BANNER);
  });
  it('explains that messages are queued and delivered on reconnect (spec/12)', () => {
    const text = DAEMON_OFFLINE_BANNER.toLowerCase();
    // The daemon-offline state must read as "queued, not lost" — not silent
    // degradation. It names queueing + reconnect, and that voice is paused.
    expect(text).toContain('queued');
    expect(text).toContain('reconnect');
    expect(text).toContain('voice');
  });
});

describe('daemon-dependent controls disable with an attributed reason', () => {
  it('enabled only when WS connected AND host online', () => {
    expect(daemonControlsDisabled('connected', 'online')).toBe(false);
    expect(daemonControlsDisabled('connected', 'offline')).toBe(true);
    expect(daemonControlsDisabled('reconnecting', 'online')).toBe(true);
    expect(daemonControlsDisabled('connecting', 'unknown')).toBe(true);
  });

  it('names the host as the reason when the WS is up but the host is down', () => {
    const reason = daemonControlDisabledReason('connected', 'offline');
    expect(reason).not.toBeNull();
    expect(reason!.toLowerCase()).toContain('host');
  });

  it('names the connection as the reason when the WS itself is down', () => {
    expect(daemonControlDisabledReason('reconnecting', 'online')).toMatch(/reconnect/i);
    expect(daemonControlDisabledReason('offline', 'online')).toMatch(/offline|connection/i);
  });

  it('returns null (enabled, no reason) when connected + host online', () => {
    expect(daemonControlDisabledReason('connected', 'online')).toBeNull();
  });

  it('names "Connecting…" while the WS itself is still in its initial connect', () => {
    expect(daemonControlDisabledReason('connecting', 'unknown')).toBe('Connecting…');
  });

  it('names the host as "connecting" when the WS is up but host presence is not yet known', () => {
    expect(daemonControlDisabledReason('connected', 'unknown')).toBe('Connecting to host…');
  });
});
