// WebUpdateBanner — the SPA's mirror of DesktopUpdateBanner. What these pin is
// the same promise: nothing here ever reloads the tab on its own, the nag gets
// louder rather than more forceful, and reloadNow is the only path in.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { WebUpdateBanner } from '../components/WebUpdateBanner.js';
import { useWebUpdateStore } from '../stores/webUpdateStore.js';
import * as liveUpdate from '../lib/liveUpdate.js';
import type { DesktopUpdaterState } from '../lib/desktopBridge.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function installBridge(s: DesktopUpdaterState | null): void {
  (window as unknown as { patch?: unknown }).patch = s
    ? { getUpdaterState: () => Promise.resolve(s), onUpdaterState: () => () => {} }
    : undefined;
}

beforeEach(() => {
  useWebUpdateStore.getState().clear();
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { patch?: unknown }).patch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('WebUpdateBanner', () => {
  it('renders nothing when no update is staged', () => {
    render(<WebUpdateBanner />);
    expect(screen.queryByTestId('web-update-banner')).toBeNull();
  });

  it('appears the moment an update is staged', () => {
    useWebUpdateStore.getState().setAvailable('assets/index-BBBB.js');
    render(<WebUpdateBanner />);
    expect(screen.getByTestId('web-update-banner')).toBeInTheDocument();
  });

  it('carries the urgency so the colour can escalate', () => {
    useWebUpdateStore
      .getState()
      .setAvailable('assets/index-BBBB.js', new Date(Date.now() - 4 * DAY).toISOString());
    render(<WebUpdateBanner />);
    const banner = screen.getByTestId('web-update-banner');
    expect(banner).toHaveAttribute('data-urgency', 'overdue');
    expect(banner.className).toContain('overdue');
  });

  it('is a status, not an alert — it may be on screen for days', () => {
    useWebUpdateStore.getState().setAvailable('assets/index-BBBB.js');
    render(<WebUpdateBanner />);
    expect(screen.getByTestId('web-update-banner')).toHaveAttribute('role', 'status');
  });

  it('reloads only when the user presses Reload', () => {
    const reloadNow = vi.spyOn(liveUpdate, 'reloadNow').mockImplementation(() => {});
    useWebUpdateStore.getState().setAvailable('assets/index-BBBB.js');
    render(<WebUpdateBanner />);
    expect(reloadNow).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('web-update-reload'));
    expect(reloadNow).toHaveBeenCalledTimes(1);
  });

  it('never reloads on its own, however long it is ignored', async () => {
    vi.useFakeTimers();
    const reloadNow = vi.spyOn(liveUpdate, 'reloadNow').mockImplementation(() => {});
    useWebUpdateStore
      .getState()
      .setAvailable('assets/index-BBBB.js', new Date(Date.now() - DAY).toISOString());
    render(<WebUpdateBanner />);
    await vi.advanceTimersByTimeAsync(7 * DAY);
    expect(reloadNow).not.toHaveBeenCalled();
    expect(screen.queryByTestId('web-update-banner')).not.toBeNull();
  });

  it('has no dismiss control', () => {
    useWebUpdateStore.getState().setAvailable('assets/index-BBBB.js');
    render(<WebUpdateBanner />);
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAttribute('data-testid', 'web-update-reload');
  });

  // Regression: on the desktop shell, one deploy used to stage BOTH this
  // banner and the shell's own download — so once the shell finished
  // downloading, "Patch has updated — Reload" and "Patch x.y.z is ready —
  // Restart now" sat stacked in the same slot for the same event.
  it('steps aside once the desktop shell has its own restart ready — Restart supersedes Reload', async () => {
    installBridge({
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
    });
    useWebUpdateStore.getState().setAvailable('assets/index-BBBB.js');
    render(<WebUpdateBanner />);
    await act(async () => {});
    expect(screen.queryByTestId('web-update-banner')).toBeNull();
  });

  it('still shows while the desktop shell is only checking or downloading, not yet ready to restart', async () => {
    installBridge({
      currentVersion: '0.1.900',
      gitSha: 'abc1234',
      builtAt: '2026-09-10T09:00:00Z',
      feedUrl: 'https://patch.example/api/desktop/latest-mac.yml',
      disabledReason: null,
      lastCheckedAt: '2026-09-17T09:00:00Z',
      lastResult: 'update-available',
      lastError: null,
      availableVersion: '0.1.971',
      downloaded: false,
      checking: false,
      staleSince: new Date(Date.now() - HOUR).toISOString(),
    });
    useWebUpdateStore.getState().setAvailable('assets/index-BBBB.js');
    render(<WebUpdateBanner />);
    await act(async () => {});
    expect(screen.queryByTestId('web-update-banner')).not.toBeNull();
  });

  it('uses the same wording as the desktop restart prompt — one prompt, not two kinds', () => {
    useWebUpdateStore.getState().setAvailable('assets/index-BBBB.js');
    render(<WebUpdateBanner />);
    expect(screen.getByTestId('web-update-banner')).toHaveTextContent('Patch has updated');
    expect(screen.getByTestId('web-update-reload')).toHaveTextContent('Update Patch');
  });
});
