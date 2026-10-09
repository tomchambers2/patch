// Settings → Updates.
//
// It replaces a Settings line that read "server <sha>" — accurate about the server
// and silent about the UI, which is how prod served an 8-day-old SPA for a week
// with nothing in the product able to say so. So these tests are mostly about the
// page refusing to look healthy when it isn't: drift is shown with a remedy, a
// machine with a newer host waiting is listed with an Update button, a shell
// that cannot self-update says why, and a failed check never reads as fine.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { VersionReport } from '@patch/wire';
import { UpdatesPage } from '../routes/settings/UpdatesPage.js';
import { SettingsRoute } from '../routes/SettingsRoute.js';
import { useSettingsHostStore } from '../routes/settings/hostScope.js';
import { ErrorToasts } from '../components/ErrorToasts.js';
import { BUILD_INFO } from '../lib/buildInfo.js';
import type { DesktopUpdaterState } from '../lib/desktopBridge.js';
import { setActiveWs, type PatchWs } from '../api/ws.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { clearHosts, reportHost } from './presenceHelpers.js';

const REPORT: VersionReport = {
  checkedAt: '2026-07-28T12:00:00.000Z',
  server: {
    version: '0.1.317',
    gitSha: '9b8635f',
    builtAt: '2026-07-28T10:00:00.000Z',
    startedAt: '2026-07-28T11:00:00.000Z',
    serverSha: '9b8635f',
  },
  web: {
    version: '0.1.317',
    gitSha: '9b8635f',
    builtAt: '2026-07-28T10:00:00.000Z',
    bundle: 'assets/index-CtWBatg1.js',
    expectedServerSha: '9b8635f',
    deployedAt: '2026-07-28T10:05:00.000Z',
  },
  daemon: { version: '0.1.317', gitSha: '9b8635f', builtAt: null, online: true },
  desktop: {
    version: '0.1.317',
    gitSha: '9b8635f',
    builtAt: null,
    publishedAt: '2026-07-28T10:10:00.000Z',
    url: '/api/desktop/Patch-0.1.317-arm64-mac.zip',
  },
  android: {
    version: '0.1.317',
    gitSha: '9b8635f',
    builtAt: null,
    publishedAt: '2026-07-28T10:20:00.000Z',
    url: '/api/download/patch-9b8635f.apk',
  },
  clients: [],
  hosts: [
    {
      daemonId: 'host-a',
      hostName: 'host-a',
      online: true,
      version: '0.1.300',
      gitSha: 'abc1234',
      builtAt: '2026-07-25T09:00:00.000Z',
    },
  ],
  drift: [],
};

const DRIFT: VersionReport['drift'] = [
  {
    kind: 'web-server-mismatch',
    detail: 'the deployed SPA (0.1.305 / f6a6326) is OLDER than the server (0.1.317 / 9b8635f)',
    remedy: 'ship both together: pnpm ship all',
  },
];

const SETTINGS_PAYLOAD = {
  account: { accountId: 'acct-123', userPublicKey: 'acct-123', createdAt: 1 },
  devices: [],
  push: { tokenCount: 0 },
  daemon: { registered: true, status: 'online', lastConnectedAt: 1700000000000 },
  projectFolders: [],
};

function shellState(over: Partial<DesktopUpdaterState> = {}): DesktopUpdaterState {
  return {
    currentVersion: '0.1.317',
    gitSha: '9b8635f',
    builtAt: '2026-07-28T10:00:00.000Z',
    feedUrl: 'https://patch.tomchambers.me/api/desktop/',
    disabledReason: null,
    lastCheckedAt: '2026-07-28T11:55:00.000Z',
    lastResult: 'up-to-date',
    lastError: null,
    availableVersion: null,
    downloaded: false,
    checking: false,
    staleSince: null,
    ...over,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** /api/version answers the report (or a failure); everything else a plain OK. */
function stubFetch(report: Partial<VersionReport> | null, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.includes('/api/version')) {
      return status === 200
        ? json({ ...REPORT, ...report })
        : json({ error: 'unauthenticated' }, status);
    }
    if (u.includes('/api/settings')) return json(SETTINGS_PAYLOAD);
    if (u.includes('/api/secrets')) return json({ secrets: [] });
    return json({ ok: true });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function versionCalls(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/version')).length;
}

function renderPage(): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/settings/updates']}>
        <UpdatesPage />
        <ErrorToasts />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return qc;
}

/** Wait for the report itself, not just the page: the server row needs data. */
async function loaded(): Promise<void> {
  await waitFor(() => expect(screen.getByTestId('version-detail-server')).toBeInTheDocument());
}

function fakeWs(): { send: ReturnType<typeof vi.fn> } {
  const ws = { send: vi.fn() };
  setActiveWs(ws as unknown as PatchWs);
  return ws;
}

beforeEach(() => {
  clearHosts();
  useSettingsHostStore.setState({ selected: null });
  useUiStore.getState().clearToasts();
  useUiStore.getState().resolveConfirm(false);
  usePresenceStore.getState().setConnection('connected');
  setActiveWs(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setActiveWs(null);
  delete (window as unknown as { patch?: unknown }).patch;
});

describe('UpdatesPage', () => {
  it('states this window’s build and when the UI was deployed', async () => {
    stubFetch(null);
    renderPage();
    await loaded();
    const row = screen.getByTestId('version-app');
    expect(row).toHaveTextContent('This app');
    expect(row).toHaveTextContent(BUILD_INFO.version);
    expect(row).toHaveTextContent('deployed');
  });

  it('shows server, hosts, feed and APK directly — no Details toggle', async () => {
    stubFetch(null);
    reportHost('host-a', { hostName: 'laptop', daemonVersion: '0.1.300' });
    renderPage();
    await loaded();
    expect(screen.queryByTestId('version-details-toggle')).toBeNull();
    const rows = screen.getByTestId('version-rows');
    for (const id of [
      'version-app',
      'version-detail-server',
      'version-host-host-a',
      'version-detail-feed',
      'version-detail-android',
    ]) {
      expect(within(rows).getByTestId(id)).toBeInTheDocument();
    }
  });

  it('gives every layer its version and sha', async () => {
    // Kept because this is what exposed a stale deploy.
    stubFetch(null);
    reportHost('host-a', { hostName: 'laptop', daemonVersion: '0.1.300' });
    renderPage();
    await loaded();
    expect(screen.getByTestId('version-detail-server')).toHaveTextContent('0.1.317 · 9b8635f');
    expect(screen.getByTestId('version-detail-server')).toHaveTextContent('up');
    expect(screen.getByTestId('version-host-host-a')).toHaveTextContent('laptop host');
    expect(screen.getByTestId('version-host-host-a')).toHaveTextContent('0.1.300');
    expect(screen.getByTestId('version-detail-feed')).toHaveTextContent('0.1.317 · 9b8635f');
    expect(screen.getByTestId('version-detail-feed')).toHaveTextContent('published');
    expect(screen.getByTestId('version-detail-android')).toHaveTextContent('0.1.317 · 9b8635f');
    expect(screen.getByTestId('version-detail-android')).toHaveTextContent('published');
  });

  it('says a host that has not reported is "not reported", not a guessed version', async () => {
    stubFetch(null);
    usePresenceStore.getState().setHostOnline('host-b', true);
    renderPage();
    await loaded();
    expect(screen.getByTestId('version-host-host-b')).toHaveTextContent('host-b host');
    expect(screen.getByTestId('version-host-host-b')).toHaveTextContent('not reported');
  });

  it('omits rows the server has nothing to report for', async () => {
    stubFetch({ web: null, daemon: null, desktop: null, android: null, clients: [], drift: [] });
    renderPage();
    await loaded();
    // This window always knows its own build — only "deployed" goes.
    expect(screen.getByTestId('version-app')).toHaveTextContent(BUILD_INFO.version);
    expect(screen.getByTestId('version-app')).not.toHaveTextContent('deployed');
    expect(screen.queryByTestId('version-detail-feed')).toBeNull();
    expect(screen.queryByTestId('version-detail-android')).toBeNull();
    expect(screen.queryByTestId('version-host-host-a')).toBeNull();
  });

  it('renders a layer with no sha as version-only', async () => {
    stubFetch({
      desktop: {
        version: 'unstamped',
        gitSha: null,
        builtAt: null,
        publishedAt: '2026-07-17T15:29:00.000Z',
        url: '/api/desktop/x.zip',
      },
    });
    renderPage();
    await loaded();
    const row = screen.getByTestId('version-detail-feed');
    expect(row).toHaveTextContent('unstamped');
    expect(row.querySelector('code')?.textContent).toBe('unstamped');
  });

  it('shows Loading… in the version list before the report lands', async () => {
    let release!: () => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = () => resolve(json(REPORT));
          }),
      ),
    );
    renderPage();
    expect(within(screen.getByTestId('version-rows')).getByText('Loading…')).toBeInTheDocument();
    expect(screen.getByTestId('version-checked')).toHaveTextContent('—');
    release();
    await loaded();
    expect(screen.queryByText('Loading…')).toBeNull();
  });

  it('says nothing reassuring — and nothing at all — when nothing is behind', async () => {
    // The old panel printed "All layers agree on <x>", which is a sentence about
    // layers the user was never shown. Silence is the correct normal state.
    stubFetch(null);
    reportHost('host-a', { hostName: 'laptop', updateAvailable: false });
    renderPage();
    await loaded();
    expect(screen.queryByTestId('version-drift')).toBeNull();
  });

  it('promotes a real disagreement to the top, with its remedy', async () => {
    stubFetch({ drift: DRIFT });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('version-drift')).toBeInTheDocument());
    const row = screen.getByTestId('version-drift-web-server-mismatch');
    expect(row).toHaveTextContent('is OLDER than');
    expect(row).toHaveTextContent('pnpm ship all');
    expect(within(screen.getByTestId('version-drift')).getByText('Behind')).toBeInTheDocument();
  });

  it('shows the check time and refetches on Check now', async () => {
    const fetchMock = stubFetch(null);
    renderPage();
    // Wait for DATA: Check now is disabled while a fetch is in flight.
    await loaded();
    expect(screen.getByTestId('version-checked')).toHaveTextContent('Last checked');
    expect(screen.getByTestId('version-checked')).toHaveTextContent('just now');
    const button = screen.getByTestId('version-check-now');
    expect(button).toHaveTextContent('Check now');
    expect(button).toBeEnabled();
    const before = versionCalls(fetchMock);
    fireEvent.click(button);
    await waitFor(() => expect(versionCalls(fetchMock)).toBeGreaterThan(before));
  });

  it('says Checking… and disables Check now while a check is in flight', async () => {
    let release: (() => void) | null = null;
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) return json(REPORT);
        return new Promise<Response>((resolve) => {
          release = () => resolve(json(REPORT));
        });
      }),
    );
    renderPage();
    await loaded();
    fireEvent.click(screen.getByTestId('version-check-now'));
    await waitFor(() => expect(screen.getByTestId('version-check-now')).toBeDisabled());
    expect(screen.getByTestId('version-check-now')).toHaveTextContent('Checking…');
    release!();
    await waitFor(() => expect(screen.getByTestId('version-check-now')).toBeEnabled());
    expect(screen.getByTestId('version-check-now')).toHaveTextContent('Check now');
  });

  it('surfaces a failed read instead of rendering an empty page', async () => {
    stubFetch(null, 401);
    renderPage();
    await waitFor(() => expect(screen.getByTestId('version-error')).toBeInTheDocument());
    const group = screen.getByTestId('version-error').closest('.set-row') as HTMLElement;
    expect(group).toHaveTextContent('Could not read versions');
    expect(group).toHaveTextContent('unauthenticated');
    // A failed check never reads as a time it was checked.
    expect(screen.getByTestId('version-checked')).toHaveTextContent('—');
    expect(within(screen.getByTestId('version-rows')).queryByText('Loading…')).toBeNull();
  });

  it('retries after a failed read', async () => {
    const fetchMock = stubFetch(null, 401);
    renderPage();
    await waitFor(() => expect(screen.getByTestId('version-error')).toBeInTheDocument());
    const before = versionCalls(fetchMock);
    fireEvent.click(screen.getByText('Retry'));
    await waitFor(() => expect(versionCalls(fetchMock)).toBeGreaterThan(before));
  });

  it('omits the desktop row entirely in a plain browser', async () => {
    stubFetch(null);
    renderPage();
    await loaded();
    expect(screen.queryByTestId('version-shell')).toBeNull();
  });

  describe('a host with a newer host waiting', () => {
    it('is listed under Behind with its version and an Update button', async () => {
      stubFetch(null);
      reportHost('host-a', { hostName: 'laptop', daemonVersion: '0.1.300', updateAvailable: true });
      usePresenceStore.getState().setHostOnline('host-a', true);
      reportHost('host-b', { hostName: 'mac', updateAvailable: false });
      renderPage();
      await loaded();
      const behind = screen.getByTestId('version-drift');
      const row = within(behind).getByTestId('version-behind-host-a');
      expect(row).toHaveTextContent('laptop host');
      expect(row).toHaveTextContent('0.1.300');
      expect(row).not.toHaveTextContent('offline');
      expect(within(row).getByTestId('host-host-a-update')).toHaveTextContent('Update');
      expect(within(behind).queryByTestId('version-behind-host-b')).toBeNull();
    });

    it('names the published build it would update to, once the channel is read', async () => {
      const fetchMock = stubFetch(null);
      const inner = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation(async (url: string | URL) =>
        String(url).includes('/api/daemon/daemon-latest.json')
          ? json({ version: '0.1.310', artifacts: [] })
          : inner(url),
      );
      reportHost('host-a', { hostName: 'laptop', daemonVersion: '0.1.300', updateAvailable: true });
      usePresenceStore.getState().setHostOnline('host-a', true);
      renderPage();
      await loaded();
      await waitFor(() =>
        expect(screen.getByTestId('version-behind-host-a')).toHaveTextContent('0.1.300 → 0.1.310'),
      );
    });

    it('Update sends host.update to that host over the live socket', async () => {
      stubFetch(null);
      const ws = fakeWs();
      reportHost('host-a', { hostName: 'laptop', updateAvailable: true });
      usePresenceStore.getState().setHostOnline('host-a', true);
      renderPage();
      await loaded();
      fireEvent.click(screen.getByTestId('host-host-a-update'));
      expect(ws.send).toHaveBeenCalledTimes(1);
      expect(ws.send).toHaveBeenCalledWith({ type: 'host.update', daemonId: 'host-a' });
      expect(screen.queryByTestId('error-toasts')).toBeNull();
    });

    it('an offline host is marked offline, and Update refuses, naming it', async () => {
      stubFetch(null);
      const ws = fakeWs();
      reportHost('host-a', { hostName: 'laptop', daemonVersion: '0.1.300', updateAvailable: true });
      usePresenceStore.getState().setHostOnline('host-a', false);
      renderPage();
      await loaded();
      expect(screen.getByTestId('version-behind-host-a')).toHaveTextContent('0.1.300 · offline');
      fireEvent.click(screen.getByTestId('host-host-a-update'));
      await waitFor(() =>
        expect(screen.getByTestId('error-toasts')).toHaveTextContent(
          'laptop is offline. It cannot be updated until it reconnects.',
        ),
      );
      expect(ws.send).not.toHaveBeenCalled();
    });

    it('with no link to the server, Update says so and sends nothing', async () => {
      stubFetch(null);
      const ws = fakeWs();
      usePresenceStore.getState().setConnection('reconnecting');
      reportHost('host-a', { hostName: 'laptop', updateAvailable: true });
      usePresenceStore.getState().setHostOnline('host-a', true);
      renderPage();
      await loaded();
      fireEvent.click(screen.getByTestId('host-host-a-update'));
      await waitFor(() =>
        expect(screen.getByTestId('error-toasts')).toHaveTextContent(
          'this surface has no link to the server',
        ),
      );
      expect(ws.send).not.toHaveBeenCalled();
    });

    it('is listed alongside drift', async () => {
      stubFetch({ drift: DRIFT });
      reportHost('host-a', { hostName: 'laptop', updateAvailable: true });
      renderPage();
      await waitFor(() =>
        expect(screen.getByTestId('version-drift-web-server-mismatch')).toBeInTheDocument(),
      );
      expect(
        within(screen.getByTestId('version-drift')).getByTestId('version-behind-host-a'),
      ).toBeInTheDocument();
    });
  });

  describe('inside the Electron shell', () => {
    const installBridge = (
      state: DesktopUpdaterState,
      extra: Record<string, unknown> = {},
    ): { check: ReturnType<typeof vi.fn> } => {
      const check = vi.fn(async () => state);
      (window as unknown as { patch: unknown }).patch = {
        getUpdaterState: vi.fn(async () => state),
        checkForUpdates: check,
        onUpdaterState: vi.fn(() => () => {}),
        ...extra,
      };
      return { check };
    };

    it('gets its own line, because it updates on a separate schedule', async () => {
      stubFetch(null);
      installBridge(shellState());
      renderPage();
      await waitFor(() => expect(screen.getByTestId('version-shell')).toBeInTheDocument());
      const row = screen.getByTestId('version-shell');
      expect(row).toHaveTextContent('Desktop app');
      expect(row).toHaveTextContent('0.1.317');
      expect(row).toHaveTextContent('up to date');
      expect(within(screen.getByTestId('version-rows')).getByTestId('version-shell')).toBe(row);
    });

    it('reports a staged update as ready, not as installing', async () => {
      // The update sits staged until the user presses Restart on the banner
      // (DesktopUpdateBanner) or quits Patch normally — so this row must not
      // claim something is underway when nothing is.
      stubFetch(null);
      installBridge(
        shellState({ lastResult: 'downloaded', downloaded: true, availableVersion: '0.1.320' }),
      );
      renderPage();
      await waitFor(() => expect(screen.getByTestId('version-shell')).toBeInTheDocument());
      const row = screen.getByTestId('version-shell').textContent ?? '';
      expect(row).toContain('0.1.320');
      expect(row).toContain('restart to apply');
      expect(row).not.toContain('installing');
    });

    it('shows an in-flight download', async () => {
      stubFetch(null);
      installBridge(shellState({ lastResult: 'update-available', availableVersion: '0.1.320' }));
      renderPage();
      await waitFor(() => expect(screen.getByTestId('version-shell')).toBeInTheDocument());
      expect(screen.getByTestId('version-shell')).toHaveTextContent('downloading 0.1.320');
      expect(screen.queryByTestId('version-shell-install')).toBeNull();
    });

    it('never renders a failed check as up to date', async () => {
      stubFetch(null);
      installBridge(shellState({ lastResult: 'error', lastError: 'ENOTFOUND feed' }));
      renderPage();
      await waitFor(() => expect(screen.getByTestId('version-shell')).toBeInTheDocument());
      expect(screen.getByTestId('version-shell')).toHaveTextContent('check failed');
      expect(screen.getByTestId('version-shell')).not.toHaveTextContent('up to date');
      // And the detail is surfaced verbatim as a problem, under Behind.
      const err = within(screen.getByTestId('version-drift')).getByTestId('version-shell-error');
      expect(err).toHaveTextContent('Last update check failed');
      expect(err).toHaveTextContent('ENOTFOUND feed');
    });

    it('distinguishes "never checked" from "up to date"', async () => {
      stubFetch(null);
      installBridge(shellState({ lastResult: null, lastCheckedAt: null }));
      renderPage();
      await waitFor(() => expect(screen.getByTestId('version-shell')).toBeInTheDocument());
      expect(screen.getByTestId('version-shell')).toHaveTextContent('not checked yet');
    });

    it('shows a check in flight', async () => {
      stubFetch(null);
      installBridge(shellState({ checking: true }));
      renderPage();
      await waitFor(() => expect(screen.getByTestId('version-shell')).toBeInTheDocument());
      expect(screen.getByTestId('version-shell')).toHaveTextContent('checking');
    });

    it('checks the shell too when Check now is pressed', async () => {
      stubFetch(null);
      const { check } = installBridge(shellState());
      renderPage();
      await waitFor(() => expect(screen.getByTestId('version-shell')).toBeInTheDocument());
      await loaded();
      fireEvent.click(screen.getByTestId('version-check-now'));
      await waitFor(() => expect(check).toHaveBeenCalled());
    });

    it('explains WHY the shell cannot self-update rather than looking fine', async () => {
      stubFetch(null);
      installBridge(
        shellState({
          disabledReason: 'this build has no app-update.yml, so it can never check for updates',
        }),
      );
      renderPage();
      await waitFor(() => expect(screen.getByTestId('version-shell-disabled')).toBeInTheDocument());
      const row = within(screen.getByTestId('version-drift')).getByTestId('version-shell-disabled');
      expect(row).toHaveTextContent('Desktop app can’t self-update');
      expect(row).toHaveTextContent('app-update.yml');
    });

    it('tolerates a bridge with no state-push subscription', async () => {
      stubFetch(null);
      (window as unknown as { patch: unknown }).patch = {
        getUpdaterState: vi.fn(async () => shellState()),
        checkForUpdates: vi.fn(async () => shellState()),
      };
      renderPage();
      await waitFor(() => expect(screen.getByTestId('version-shell')).toBeInTheDocument());
    });

    it('does not throw when the bridge exposes no check hook', async () => {
      const fetchMock = stubFetch(null);
      (window as unknown as { patch: unknown }).patch = {
        getUpdaterState: vi.fn(async () =>
          shellState({ downloaded: true, lastResult: 'downloaded', availableVersion: '1' }),
        ),
        onUpdaterState: vi.fn(() => () => {}),
      };
      renderPage();
      await waitFor(() => expect(screen.getByTestId('version-shell')).toBeInTheDocument());
      await loaded();
      const before = versionCalls(fetchMock);
      fireEvent.click(screen.getByTestId('version-check-now'));
      // The server half of the check still runs.
      await waitFor(() => expect(versionCalls(fetchMock)).toBeGreaterThan(before));
    });

    it('follows state pushed by the shell after mount', async () => {
      stubFetch(null);
      let push: ((s: DesktopUpdaterState) => void) | null = null;
      installBridge(shellState(), {
        onUpdaterState: vi.fn((cb: (s: DesktopUpdaterState) => void) => {
          push = cb;
          return () => {};
        }),
      });
      renderPage();
      await waitFor(() =>
        expect(screen.getByTestId('version-shell')).toHaveTextContent('up to date'),
      );
      push!(shellState({ lastResult: 'update-available', availableVersion: '0.1.321' }));
      await waitFor(() =>
        expect(screen.getByTestId('version-shell')).toHaveTextContent('downloading 0.1.321'),
      );
    });
  });
});

describe('Settings nav → Updates pip', () => {
  function renderAtUsage(): QueryClient {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/settings/usage']}>
          <Routes>
            <Route path="/settings/*" element={<SettingsRoute />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    return qc;
  }

  /** The pip is decided by the version report, so wait until it has landed. */
  async function reportLanded(qc: QueryClient): Promise<void> {
    await waitFor(() => expect(screen.getByTestId('settings-nav')).toBeInTheDocument());
    await waitFor(() => expect(qc.getQueryData(['version'])).toBeDefined());
  }

  it('is absent when nothing is behind', async () => {
    stubFetch(null);
    reportHost('host-a', { hostName: 'laptop', updateAvailable: false });
    const qc = renderAtUsage();
    await reportLanded(qc);
    expect(screen.getByTestId('settings-usage')).toBeInTheDocument();
    expect(screen.getByTestId('settings-nav-updates')).toBeInTheDocument();
    expect(screen.queryByTestId('settings-nav-updates-pip')).toBeNull();
  });

  it('appears when a host has an update waiting', async () => {
    stubFetch(null);
    reportHost('host-a', { hostName: 'laptop', updateAvailable: true });
    renderAtUsage();
    await waitFor(() =>
      expect(
        within(screen.getByTestId('settings-nav-updates')).getByTestId('settings-nav-updates-pip'),
      ).toBeInTheDocument(),
    );
  });

  it('appears when the version report has drift', async () => {
    stubFetch({ drift: DRIFT });
    renderAtUsage();
    await waitFor(() =>
      expect(
        within(screen.getByTestId('settings-nav-updates')).getByTestId('settings-nav-updates-pip'),
      ).toBeInTheDocument(),
    );
  });

  it('goes when the host catches up', async () => {
    stubFetch(null);
    reportHost('host-a', { hostName: 'laptop', updateAvailable: true });
    const qc = renderAtUsage();
    await reportLanded(qc);
    expect(screen.getByTestId('settings-nav-updates-pip')).toBeInTheDocument();
    reportHost('host-a', { hostName: 'laptop', updateAvailable: false });
    await waitFor(() => expect(screen.queryByTestId('settings-nav-updates-pip')).toBeNull());
  });
});
