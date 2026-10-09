// The banner that replaced the shell restarting itself.
//
// What these pin is the promise the change makes: nothing here ever restarts
// the app on its own, the nag gets louder rather than more forceful, and a
// browser — which has no shell to update — sees nothing at all.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import {
  DesktopUpdateBanner,
  updateUrgency,
  waitedWords,
} from '../components/DesktopUpdateBanner.js';
import type { DesktopUpdaterState } from '../lib/desktopBridge.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function state(over: Partial<DesktopUpdaterState> = {}): DesktopUpdaterState {
  return {
    currentVersion: '0.1.900',
    gitSha: 'abc1234',
    builtAt: '2026-09-10T09:00:00Z',
    feedUrl: 'https://patch.example/api/desktop/latest-mac.yml',
    disabledReason: null,
    lastCheckedAt: '2026-09-17T09:00:00Z',
    lastResult: 'downloaded',
    lastError: null,
    availableVersion: '0.1.971',
    downloaded: true,
    checking: false,
    staleSince: new Date(Date.now() - HOUR).toISOString(),
    ...over,
  };
}

function installBridge(
  s: DesktopUpdaterState | null,
  installUpdate = vi.fn(),
): typeof installUpdate {
  (window as unknown as { patch?: unknown }).patch = s
    ? {
        getUpdaterState: () => Promise.resolve(s),
        onUpdaterState: () => () => {},
        installUpdate,
      }
    : undefined;
  return installUpdate;
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { patch?: unknown }).patch;
  vi.useRealTimers();
});

describe('updateUrgency', () => {
  it('is none when the shell is current', () => {
    expect(updateUrgency(null, Date.now())).toBe('none');
  });

  it('escalates quiet → due → overdue with age, and only with age', () => {
    const now = Date.parse('2026-09-17T12:00:00Z');
    expect(updateUrgency(new Date(now - HOUR).toISOString(), now)).toBe('ready');
    expect(updateUrgency(new Date(now - 9 * HOUR).toISOString(), now)).toBe('due');
    expect(updateUrgency(new Date(now - 4 * DAY).toISOString(), now)).toBe('overdue');
  });

  it('shows the banner at its quietest rather than hiding an unparseable date', () => {
    expect(updateUrgency('nonsense', Date.now())).toBe('ready');
  });
});

describe('waitedWords', () => {
  it('says nothing under an hour — that phase is meant to be quiet', () => {
    const now = Date.parse('2026-09-17T12:00:00Z');
    expect(waitedWords(new Date(now - 10 * 60_000).toISOString(), now)).toBeNull();
  });

  it('counts hours, then days', () => {
    const now = Date.parse('2026-09-17T12:00:00Z');
    expect(waitedWords(new Date(now - 3 * HOUR).toISOString(), now)).toBe('for 3 hours');
    expect(waitedWords(new Date(now - 1 * HOUR).toISOString(), now)).toBe('for 1 hour');
    expect(waitedWords(new Date(now - 1 * DAY).toISOString(), now)).toBe('since yesterday');
    expect(waitedWords(new Date(now - 5 * DAY).toISOString(), now)).toBe('for 5 days');
  });
});

describe('DesktopUpdateBanner', () => {
  it('renders nothing in a browser — there is no shell to update', async () => {
    installBridge(null);
    render(<DesktopUpdateBanner />);
    await act(async () => {});
    expect(screen.queryByTestId('desktop-update-banner')).toBeNull();
  });

  it('renders nothing when the shell is up to date', async () => {
    installBridge(state({ downloaded: false, availableVersion: null, staleSince: null }));
    render(<DesktopUpdateBanner />);
    await act(async () => {});
    expect(screen.queryByTestId('desktop-update-banner')).toBeNull();
  });

  it('stays silent while an update is merely AVAILABLE but not yet on disk', async () => {
    // Offering Restart before the bytes are down would be a lie: pressing it
    // could not install anything.
    installBridge(state({ downloaded: false, lastResult: 'update-available' }));
    render(<DesktopUpdateBanner />);
    await act(async () => {});
    expect(screen.queryByTestId('desktop-update-banner')).toBeNull();
  });

  it('records the waiting version once it is staged', async () => {
    installBridge(state());
    render(<DesktopUpdateBanner />);
    await act(async () => {});
    expect(await screen.findByTestId('desktop-update-restart')).toHaveAttribute(
      'data-version',
      '0.1.971',
    );
  });

  it('carries the urgency so the colour can escalate', async () => {
    installBridge(state({ staleSince: new Date(Date.now() - 4 * DAY).toISOString() }));
    render(<DesktopUpdateBanner />);
    const banner = await screen.findByTestId('desktop-update-banner');
    expect(banner).toHaveAttribute('data-urgency', 'overdue');
    expect(banner.className).toContain('overdue');
  });

  it('is a status, not an alert — it is on screen for days', async () => {
    installBridge(state());
    render(<DesktopUpdateBanner />);
    expect(await screen.findByTestId('desktop-update-banner')).toHaveAttribute('role', 'status');
  });

  it('restarts only when the user presses Restart', async () => {
    const install = installBridge(state());
    render(<DesktopUpdateBanner />);
    await screen.findByTestId('desktop-update-banner');
    expect(install).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('desktop-update-restart'));
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('never installs on its own, however long it is ignored', async () => {
    // The regression guard for the whole change: no timer in here may reach
    // installUpdate. Sit a week of fake time out and nothing should fire.
    vi.useFakeTimers();
    const install = installBridge(state({ staleSince: new Date(Date.now() - DAY).toISOString() }));
    render(<DesktopUpdateBanner />);
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7 * DAY);
    });
    expect(install).not.toHaveBeenCalled();
    expect(screen.queryByTestId('desktop-update-banner')).not.toBeNull();
  });

  it('has no dismiss control — a thing you can dismiss is one you dismiss daily', async () => {
    installBridge(state());
    render(<DesktopUpdateBanner />);
    await screen.findByTestId('desktop-update-banner');
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAttribute('data-testid', 'desktop-update-restart');
  });
});
