// Settings (design/settings-redesign): one page per address, /settings/<page>,
// beside a nav grouped Agents / Setup / System. This file covers the shell —
// the nav, the addresses, the host switcher, what was removed — and the
// Account, Devices, Voice, Agent and Manager pages. Usage (accounts), MCP,
// Memories, Hosts, Keys and Updates each have a file of their own.
//
// Backed by /api/auth/me, /api/settings and the live per-host reports.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, fireEvent, act, within } from '@testing-library/react';
import { DEFAULT_GOAL_EVAL_PROMPT, DEFAULT_SWEEP_PROMPT } from '@patch/wire';
import { useUiStore } from '../stores/uiStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import { useSettingsHostStore } from '../routes/settings/hostScope.js';
import { SETTINGS_PAGES } from '../routes/settings/pages.js';
import { voiceCellStatus } from '../routes/settings/VoicePage.js';
import { DEFAULT_DICTATE_CHORD } from '../lib/dictateChord.js';
import { clearHosts, reportHost } from './presenceHelpers.js';
import { setActiveWs } from '../api/ws.js';
import {
  ME_PAYLOAD,
  SETTINGS_PAYLOAD,
  json,
  makeFetch,
  preferencesServer,
  renderSettings,
  resetSettingsState,
} from './settingsHarness.js';
import { loadShared } from './sharedHelpers.js';
import { PERMISSION_MODES } from '../components/Composer.js';

/** Each page's own testid, so a test can say which page is showing. */
const PAGE_TESTID: Record<string, string> = {
  usage: 'settings-usage',
  agent: 'settings-agent',
  mcp: 'settings-mcp',
  memories: 'settings-memories',
  manager: 'settings-manager-page',
  goals: 'settings-goals-page',
  voice: 'settings-voice',
  hooks: 'settings-hooks-page',
  jobs: 'settings-jobs-page',
  hosts: 'settings-hosts',
  keys: 'settings-keys',
  devices: 'settings-devices',
  updates: 'settings-version',
  account: 'settings-account',
};

const errors = (): string[] => useUiStore.getState().errors.map((e) => e.message);

beforeEach(() => {
  resetSettingsState();
  // One host, online, that has not described itself yet.
  usePresenceStore.getState().setHostOnline('d1', true);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setActiveWs(null);
});

describe('Settings shell — one pane tab, pages as internal state', () => {
  it('lists every page in the nav, in order, under Agents / Setup / System', async () => {
    vi.stubGlobal('fetch', makeFetch());
    renderSettings('/settings');
    const nav = await screen.findByTestId('settings-nav');
    // Scoped to the page links themselves — `within(nav)` now also catches
    // the Back/Forward history buttons sharing this nav's head (App Updates:
    // "back/forward buttons should be on all pages including jobs").
    const buttons = within(nav)
      .getAllByRole('button')
      .filter((b) => b.getAttribute('data-testid')?.startsWith('settings-nav-'));
    expect(buttons.map((a) => a.textContent)).toEqual([
      'Usage',
      'Agent',
      'MCP',
      'Memories',
      'Manager',
      'Goals',
      'Voice',
      'Hooks',
      'Jobs',
      'Hosts',
      'Keys',
      'Devices',
      'Updates',
      'Account',
    ]);
    expect(
      within(nav)
        .getAllByRole('heading', { level: 2 })
        .map((h) => h.textContent),
    ).toEqual(['Agents', 'Setup', 'System']);
  });

  it.each(SETTINGS_PAGES.map((p) => p.id))('the %s link opens that page', async (id) => {
    vi.stubGlobal('fetch', makeFetch());
    renderSettings('/settings');
    fireEvent.click(await screen.findByTestId(`settings-nav-${id}`));
    await waitFor(() => expect(screen.getByTestId(PAGE_TESTID[id]!)).toBeInTheDocument());
    expect(screen.getByTestId('settings-route')).toHaveAttribute('data-page', id);
    // The nav marks where you are, and only there.
    expect(screen.getByTestId(`settings-nav-${id}`)).toHaveAttribute('aria-current', 'page');
    for (const other of SETTINGS_PAGES.filter((p) => p.id !== id)) {
      expect(screen.getByTestId(`settings-nav-${other.id}`)).not.toHaveAttribute('aria-current');
    }
  });

  it('a /settings/<page> deep link opens that page directly (e.g. a banner elsewhere)', async () => {
    vi.stubGlobal('fetch', makeFetch());
    renderSettings('/settings/agent');
    await waitFor(() => expect(screen.getByTestId('settings-agent')).toBeInTheDocument());
    expect(screen.getByTestId('settings-route')).toHaveAttribute('data-page', 'agent');
  });

  it('/settings itself shows Usage beside the nav, and is not an opened page', async () => {
    vi.stubGlobal('fetch', makeFetch());
    renderSettings('/settings');
    await waitFor(() => expect(screen.getByTestId('settings-usage')).toBeInTheDocument());
    const route = screen.getByTestId('settings-route');
    expect(route).toHaveAttribute('data-page', 'index');
    // `.open` is what swaps the nav for the page on a phone; the index is the list.
    expect(route).not.toHaveClass('open');
    // Desktop shows Usage beside the nav even at the bare index — the nav
    // still marks it current.
    expect(screen.getByTestId('settings-nav-usage')).toHaveAttribute('aria-current', 'page');
  });

  it('says so on every page when the server cannot read its stored accounts and keys', async () => {
    vi.stubGlobal('fetch', makeFetch());
    renderSettings('/settings/agent');
    await waitFor(() => expect(screen.getByTestId('settings-agent')).toBeInTheDocument());
    expect(screen.queryByTestId('settings-secrets-problem')).toBeNull();
    const problem =
      "The stored accounts and keys can't be read: /data/secrets.key is missing. Put back the secrets.key that goes with it, or delete /data/secrets.json and add the accounts and keys again.";
    act(() => void loadShared({ problem }));
    expect(screen.getByTestId('settings-secrets-problem')).toHaveTextContent(problem);
  });

  it('a named page is opened, so a phone shows it over the list', async () => {
    vi.stubGlobal('fetch', makeFetch());
    renderSettings('/settings/agent');
    await waitFor(() => expect(screen.getByTestId('settings-agent')).toBeInTheDocument());
    expect(screen.getByTestId('settings-route')).toHaveClass('open');
  });

  it('an unknown page shows the index (Usage) rather than a blank', async () => {
    vi.stubGlobal('fetch', makeFetch());
    renderSettings('/settings/nope');
    await waitFor(() => expect(screen.getByTestId('settings-usage')).toBeInTheDocument());
    expect(screen.getByTestId('settings-route')).not.toHaveClass('open');
  });

  it('the back arrow on a page returns to the list', async () => {
    vi.stubGlobal('fetch', makeFetch());
    renderSettings('/settings/devices');
    await screen.findByTestId('settings-devices');
    fireEvent.click(await screen.findByTestId('settings-back'));
    await waitFor(() => expect(screen.getByTestId('settings-route')).not.toHaveClass('open'));
    expect(screen.getByTestId('settings-usage')).toBeInTheDocument();
  });

  it('shows a route-level error with a working Retry when /api/settings fails', async () => {
    let fail = true;
    vi.stubGlobal(
      'fetch',
      makeFetch({}, (u, init) =>
        u.includes('/api/settings') && (init?.method ?? 'GET') === 'GET' && fail
          ? json({ error: 'boom' }, 500)
          : null,
      ),
    );
    renderSettings('/settings/devices');
    await waitFor(() => expect(screen.getByTestId('settings-error')).toBeInTheDocument());
    expect(screen.getByTestId('settings-error')).toHaveTextContent('Failed to load settings');
    fail = false;
    fireEvent.click(screen.getByText('Retry'));
    await waitFor(() => expect(screen.getByTestId('settings-route')).toBeInTheDocument());
  });

  it('keeps the preferences store in step with what /api/settings serves', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch({
        preferences: { ...usePreferencesStore.getState().preferences, addressWord: 'jeeves' },
      }),
    );
    renderSettings('/settings/manager');
    await waitFor(() => expect(screen.getByTestId('manager-address-word')).toHaveValue('jeeves'));
    expect(usePreferencesStore.getState().preferences.addressWord).toBe('jeeves');
  });

  // spec/14 § Copy — no helper text. The settings pages carry titles and values
  // only; an empty state is the one sanctioned helper line. This was guarded
  // solely by a browser test, so adding a `.hint` cost a whole deploy to find.
  it.each(SETTINGS_PAGES.map((p) => p.id))('%s renders no explainer prose', async (id) => {
    vi.stubGlobal('fetch', makeFetch());
    reportHost('d1');
    const { container } = renderSettings(`/settings/${id}`);
    await waitFor(() => expect(screen.getByTestId(PAGE_TESTID[id]!)).toBeInTheDocument());
    expect(container.querySelectorAll('.settings-route .hint')).toHaveLength(0);
  });
});

describe('Settings nav — Updates pip', () => {
  it('shows no pip while nothing is behind', async () => {
    vi.stubGlobal('fetch', makeFetch());
    reportHost('d1');
    renderSettings('/settings/account');
    await waitFor(() => expect(screen.getByTestId('settings-account')).toBeInTheDocument());
    expect(screen.queryByTestId('settings-nav-updates-pip')).toBeNull();
  });

  it('marks Updates from every page while a host has an update waiting', async () => {
    vi.stubGlobal('fetch', makeFetch());
    reportHost('d1', { updateAvailable: true });
    renderSettings('/settings/account');
    await waitFor(() => expect(screen.getByTestId('settings-nav-updates-pip')).toBeInTheDocument());
  });
});

// Only what belongs to one machine is chosen per host now — MCP servers and
// Claude Code's memory entries (spec/01 § Settings). Memories is the page used
// here: which host it shows is said by its unreported/empty line.
describe('Settings host switcher (per-host pages)', () => {
  it('is not drawn while only one host has reported — there is nothing to choose', async () => {
    vi.stubGlobal('fetch', makeFetch());
    reportHost('d1', { hostName: 'mac' });
    renderSettings('/settings/memories');
    await waitFor(() =>
      expect(screen.getByTestId('host-d1-memory-unreported')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('settings-host-switch')).toBeNull();
  });

  it('is drawn with two, defaulting to the home host', async () => {
    vi.stubGlobal('fetch', makeFetch());
    reportHost('d1', { hostName: 'mac', isHomeHost: false });
    reportHost('d2', { hostName: 'hetzner', isHomeHost: true });
    usePresenceStore.getState().setHostOnline('d2', true);
    renderSettings('/settings/memories');
    const sw = await screen.findByTestId('settings-host-switch');
    expect(
      within(sw)
        .getAllByRole('tab')
        .map((t) => t.textContent),
    ).toEqual(['hetzner', 'mac']);
    expect(screen.getByTestId('settings-host-d2')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('host-d2-memory-unreported')).toBeInTheDocument();
    expect(screen.queryByTestId('host-d1-memory-unreported')).toBeNull();
  });

  it('switching hosts changes which machine the page shows, and the choice is shared', async () => {
    vi.stubGlobal('fetch', makeFetch());
    reportHost('d1', { hostName: 'mac', isHomeHost: false });
    reportHost('d2', { hostName: 'hetzner', isHomeHost: true });
    renderSettings('/settings/memories');
    fireEvent.click(await screen.findByTestId('settings-host-d1'));
    await waitFor(() =>
      expect(screen.getByTestId('host-d1-memory-unreported')).toBeInTheDocument(),
    );
    expect(useSettingsHostStore.getState().selected).toBe('d1');
    fireEvent.click(screen.getByTestId('settings-nav-mcp'));
    await waitFor(() =>
      expect(screen.getByTestId('settings-host-d1')).toHaveAttribute('aria-selected', 'true'),
    );
  });

  it('is not drawn on a page of shared settings', async () => {
    vi.stubGlobal('fetch', makeFetch());
    reportHost('d1', { hostName: 'mac', isHomeHost: false });
    reportHost('d2', { hostName: 'hetzner', isHomeHost: true });
    renderSettings('/settings/agent');
    await waitFor(() => expect(screen.getByTestId('permission-default')).toBeInTheDocument());
    expect(screen.queryByTestId('settings-host-switch')).toBeNull();
  });

  it('forgets a chosen host that has gone, falling back to home', async () => {
    vi.stubGlobal('fetch', makeFetch());
    reportHost('d2', { hostName: 'hetzner', isHomeHost: true });
    useSettingsHostStore.setState({ selected: 'gone' });
    renderSettings('/settings/memories');
    await waitFor(() =>
      expect(screen.getByTestId('host-d2-memory-unreported')).toBeInTheDocument(),
    );
  });

  it('says there are no hosts rather than drawing empty controls', async () => {
    vi.stubGlobal('fetch', makeFetch());
    clearHosts();
    renderSettings('/settings/memories');
    await waitFor(() =>
      expect(screen.getByTestId('settings-no-hosts')).toHaveTextContent('No hosts yet'),
    );
  });

  it('says a chosen host has not reported, naming it by id', async () => {
    vi.stubGlobal('fetch', makeFetch());
    renderSettings('/settings/memories');
    await waitFor(() =>
      expect(screen.getByTestId('settings-host-unreported')).toHaveTextContent(
        'd1 hasn’t reported yet',
      ),
    );
  });
});

describe('Settings → Account', () => {
  it('renders account id from /api/auth/me (no "this surface" line)', async () => {
    vi.stubGlobal('fetch', makeFetch());
    renderSettings('/settings/account');
    await waitFor(() => expect(screen.getByTestId('account-id')).toHaveTextContent('acct-123'));
    // The opaque "this surface" id was removed from the UI — it was debug noise.
    expect(screen.queryByTestId('surface-id')).toBeNull();
  });

  it('names the server this surface talks to and the build it runs', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch({}, (u) =>
        u.includes('/api/healthz') ? json({ ok: true, version: '1', gitSha: 'abc1234' }) : null,
      ),
    );
    renderSettings('/settings/account');
    await waitFor(() => expect(screen.getByTestId('build-sha')).toHaveTextContent('abc1234'));
    expect(screen.getByTestId('build-origin')).toHaveTextContent(window.location.origin);
  });

  describe('remote access (spec/10 § Relay)', () => {
    const relayOn = (over: Record<string, unknown>) =>
      makeFetch({}, (u) =>
        u.includes('/api/relay')
          ? json({
              enabled: true,
              url: 'wss://relay.example.com',
              channel: 'chan',
              serverKey: 'key',
              connected: true,
              sessions: 0,
              lastError: null,
              ...over,
            })
          : null,
      );

    it('says nothing when the server has no relay', async () => {
      vi.stubGlobal(
        'fetch',
        makeFetch({}, (u) => (u.includes('/api/relay') ? json({ enabled: false }) : null)),
      );
      renderSettings('/settings/account');
      await waitFor(() => expect(screen.getByTestId('account-id')).toBeInTheDocument());
      expect(screen.queryByTestId('relay-line')).toBeNull();
    });

    it('says the server is reachable through its relay, and how many devices are on it', async () => {
      vi.stubGlobal('fetch', relayOn({ sessions: 2 }));
      renderSettings('/settings/account');
      await waitFor(() =>
        expect(screen.getByTestId('relay-state')).toHaveTextContent(
          'Reachable through relay.example.com · 2 connected',
        ),
      );
    });

    it('says plainly when the relay cannot be reached, and why', async () => {
      vi.stubGlobal('fetch', relayOn({ connected: false, lastError: 'ECONNREFUSED' }));
      renderSettings('/settings/account');
      await waitFor(() =>
        expect(screen.getByTestId('relay-state')).toHaveTextContent(
          'Not reachable through relay.example.com: ECONNREFUSED',
        ),
      );
    });

    it('does not say "connected" when nobody is', async () => {
      vi.stubGlobal('fetch', relayOn({}));
      renderSettings('/settings/account');
      await waitFor(() =>
        expect(screen.getByTestId('relay-state')).toHaveTextContent(
          'Reachable through relay.example.com',
        ),
      );
      expect(screen.getByTestId('relay-state')).not.toHaveTextContent('connected');
    });

    it('says plainly when the relay cannot be reached and gives no reason', async () => {
      vi.stubGlobal('fetch', relayOn({ connected: false }));
      renderSettings('/settings/account');
      await waitFor(() =>
        expect(screen.getByTestId('relay-state')).toHaveTextContent(
          'Not reachable through relay.example.com',
        ),
      );
      expect(screen.getByTestId('relay-state')).not.toHaveTextContent(':');
    });
  });

  it('renders without crashing when /api/auth/me omits the surface field (G4 regression)', async () => {
    // The server OMITS `surface` when the running server hasn't yet reloaded a
    // freshly-minted surface. The page must render the account regardless.
    vi.stubGlobal(
      'fetch',
      makeFetch({}, (u) =>
        u.includes('/api/auth/me') ? json({ account: ME_PAYLOAD.account }) : null,
      ),
    );
    renderSettings('/settings/account');
    await waitFor(() => expect(screen.getByTestId('account-id')).toHaveTextContent('acct-123'));
    expect(screen.queryByTestId('surface-id')).toBeNull();
  });

  describe('Deactivate surface', () => {
    let reloadSpy: ReturnType<typeof vi.fn>;
    let origLocation: Location;
    beforeEach(() => {
      reloadSpy = vi.fn();
      origLocation = window.location;
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: { ...origLocation, origin: origLocation.origin, reload: reloadSpy },
      });
    });
    afterEach(() => {
      Object.defineProperty(window, 'location', { configurable: true, value: origLocation });
    });

    it('revokes this surface then clears credential + reloads', async () => {
      const fetchMock = makeFetch();
      vi.stubGlobal('fetch', fetchMock);
      renderSettings('/settings/account');
      // Wait for `me` (which carries the surfaceId it self-revokes) to load
      // before clicking, or the click races ahead and skips the revoke.
      await waitFor(() => expect(screen.getByTestId('account-id')).toHaveTextContent('acct-123'));
      fireEvent.click(screen.getByTestId('deactivate-surface'));
      fireEvent.click(await screen.findByTestId('confirm-ok'));
      await waitFor(() => {
        const revoked = fetchMock.mock.calls.some(
          (c) =>
            String(c[0]).includes('/api/auth/revoke') &&
            String((c[1] as RequestInit | undefined)?.body).includes('web-dev-1'),
        );
        expect(revoked).toBe(true);
      });
      await waitFor(() => expect(reloadSpy).toHaveBeenCalled());
    });

    it('a revoke failure still clears the credential and reloads (pushes an error first)', async () => {
      vi.stubGlobal(
        'fetch',
        makeFetch({}, (u) =>
          u.includes('/api/auth/revoke') ? json({ error: 'nope' }, 500) : null,
        ),
      );
      renderSettings('/settings/account');
      await waitFor(() => expect(screen.getByTestId('account-id')).toHaveTextContent('acct-123'));
      fireEvent.click(screen.getByTestId('deactivate-surface'));
      fireEvent.click(await screen.findByTestId('confirm-ok'));
      await waitFor(() => expect(errors().some((e) => /revoke failed/i.test(e))).toBe(true));
      await waitFor(() => expect(reloadSpy).toHaveBeenCalled());
    });

    it('with no surfaceId on `me` skips the self-revoke call entirely', async () => {
      const fetchMock = makeFetch({}, (u) =>
        u.includes('/api/auth/me') ? json({ account: ME_PAYLOAD.account }) : null,
      );
      vi.stubGlobal('fetch', fetchMock);
      renderSettings('/settings/account');
      await waitFor(() => expect(screen.getByTestId('account-id')).toHaveTextContent('acct-123'));
      fireEvent.click(screen.getByTestId('deactivate-surface'));
      fireEvent.click(await screen.findByTestId('confirm-ok'));
      await waitFor(() => expect(reloadSpy).toHaveBeenCalled());
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/auth/revoke'))).toBe(
        false,
      );
    });

    // spec/14 § /settings details → "This surface": destructive, so it warns
    // first, and cancelling must be a complete no-op.
    it('cancelling the warning revokes nothing and does not reload', async () => {
      const fetchMock = makeFetch();
      vi.stubGlobal('fetch', fetchMock);
      renderSettings('/settings/account');
      await waitFor(() => expect(screen.getByTestId('account-id')).toHaveTextContent('acct-123'));
      fireEvent.click(screen.getByTestId('deactivate-surface'));
      // The warning names the consequence: the surface must be paired again.
      const dialog = await screen.findByTestId('confirm-modal');
      expect(dialog.textContent ?? '').toMatch(/pair/i);
      expect(screen.getByTestId('confirm-ok')).toHaveTextContent('Deactivate');
      fireEvent.click(screen.getByTestId('confirm-cancel'));
      await waitFor(() => expect(screen.queryByTestId('confirm-modal')).not.toBeInTheDocument());
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/auth/revoke'))).toBe(
        false,
      );
      expect(reloadSpy).not.toHaveBeenCalled();
    });

    it('the control is never labelled log out / sign out', async () => {
      vi.stubGlobal('fetch', makeFetch());
      renderSettings('/settings/account');
      await waitFor(() => expect(screen.getByTestId('deactivate-surface')).toBeInTheDocument());
      expect(screen.getByTestId('deactivate-surface')).toHaveTextContent('Deactivate');
      expect(screen.getByTestId('deactivate-surface').textContent ?? '').not.toMatch(
        /log ?out|sign ?out/i,
      );
    });
  });
});

describe('Settings → Devices', () => {
  it('lists linked devices, marks the current one, and revokes another', async () => {
    const fetchMock = makeFetch();
    vi.stubGlobal('fetch', fetchMock);
    renderSettings('/settings/devices');
    await waitFor(() => expect(screen.getByTestId('device-web-dev-1')).toBeInTheDocument());
    expect(screen.getByTestId('device-web-dev-1')).toHaveTextContent('This device');
    // current device: no revoke button
    expect(screen.queryByTestId('device-revoke-web-dev-1')).toBeNull();
    // other device: revoke button present
    fireEvent.click(screen.getByTestId('device-revoke-mob-7'));
    await waitFor(() => {
      const called = fetchMock.mock.calls.some(
        (c) =>
          String(c[0]).includes('/api/auth/revoke') &&
          c[1] !== undefined &&
          String((c[1] as RequestInit).body).includes('mob-7'),
      );
      expect(called).toBe(true);
    });
    await waitFor(() => expect(errors()).toContain('Device removed.'));
  });

  it('a failed device revoke surfaces "revoke failed: …"', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch({}, (u) => (u.includes('/api/auth/revoke') ? json({ error: 'nope' }, 500) : null)),
    );
    renderSettings('/settings/devices');
    await waitFor(() => expect(screen.getByTestId('device-revoke-mob-7')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('device-revoke-mob-7'));
    await waitFor(() => expect(errors().some((e) => /revoke failed/i.test(e))).toBe(true));
  });

  // Push registration belongs to the devices it is about, not to a heading of
  // its own stating a bare number.
  it('states the push count on the phone it belongs to, and offers NO register button', async () => {
    vi.stubGlobal('fetch', makeFetch());
    renderSettings('/settings/devices');
    await waitFor(() =>
      expect(screen.getByTestId('device-mob-7')).toHaveTextContent('2 registered for push'),
    );
    expect(screen.getByTestId('device-mob-7')).toHaveTextContent('Android');
    expect(screen.getByTestId('device-web-dev-1')).not.toHaveTextContent('push');
    // Push is an Android-app capability — no dead "Register push" on the web.
    expect(screen.queryByTestId('push-register')).not.toBeInTheDocument();
  });

  it('keeps voice devices out of the linked list — they live under Voice', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch({
        devices: [
          ...SETTINGS_PAYLOAD.devices,
          {
            surfaceId: 'vd-1',
            surfaceKind: 'voice-device',
            label: 'kitchen',
            issuedAt: 4,
            status: 'online',
            lastHeartbeat: 1,
            isCurrent: false,
          },
        ],
      }),
    );
    renderSettings('/settings/devices');
    await waitFor(() => expect(screen.getByTestId('device-mob-7')).toBeInTheDocument());
    expect(screen.queryByTestId('device-vd-1')).toBeNull();
  });

  it('shows "No linked surfaces." when the device list is empty', async () => {
    vi.stubGlobal('fetch', makeFetch({ devices: [] }));
    renderSettings('/settings/devices');
    await waitFor(() => expect(screen.getByText('No linked surfaces.')).toBeInTheDocument());
  });

  it('shows transient loading placeholders before /api/settings resolves', async () => {
    let resolveSettings: ((r: Response) => void) | undefined;
    vi.stubGlobal(
      'fetch',
      makeFetch({}, (u, init) =>
        u.includes('/api/settings') && (init?.method ?? 'GET') === 'GET'
          ? (new Promise<Response>((resolve) => {
              resolveSettings = resolve;
            }) as unknown as Response)
          : null,
      ),
    );
    renderSettings('/settings/devices');
    await waitFor(() => expect(screen.getByText('Loading…')).toBeInTheDocument());
    resolveSettings?.(json(SETTINGS_PAYLOAD));
    await waitFor(() => expect(screen.getByTestId('device-mob-7')).toBeInTheDocument());
  });

  it('mints no pairing code until "Link a device" is pressed, then shows it', async () => {
    const fetchMock = makeFetch();
    vi.stubGlobal('fetch', fetchMock);
    renderSettings('/settings/devices');
    await waitFor(() => expect(screen.getByTestId('device-mob-7')).toBeInTheDocument());
    const minted = (): boolean =>
      fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/auth/pair/start'));
    expect(minted()).toBe(false);
    expect(screen.queryByTestId('link-device')).toBeNull();
    fireEvent.click(screen.getByTestId('link-device-open'));
    await waitFor(() =>
      expect(screen.getByTestId('link-device-nonce')).toHaveTextContent('NONCE-abc123def456'),
    );
    expect(minted()).toBe(true);
    expect(screen.getByTestId('link-device-open')).toBeDisabled();
    fireEvent.click(screen.getByTestId('link-device-close'));
    await waitFor(() => expect(screen.queryByTestId('link-device')).toBeNull());
    expect(screen.getByTestId('link-device-open')).not.toBeDisabled();
  });
});

describe('Settings → Voice', () => {
  describe('Dictate shortcut', () => {
    beforeEach(() => {
      localStorage.clear();
      useUiStore.setState({ dictateChord: DEFAULT_DICTATE_CHORD });
    });

    it('shows ⌘⇧D until changed (Ctrl+Shift+D off a Mac, as jsdom is)', async () => {
      vi.stubGlobal('fetch', makeFetch());
      renderSettings('/settings/voice');
      expect(await screen.findByTestId('dictate-chord')).toHaveTextContent('Ctrl+Shift+D');
    });

    it('Change records the next chord with ⌘ in it, and keeps it for this machine', async () => {
      vi.stubGlobal('fetch', makeFetch());
      renderSettings('/settings/voice');
      fireEvent.click(await screen.findByTestId('dictate-chord-change'));
      expect(screen.getByTestId('dictate-chord')).toHaveTextContent('Press keys…');
      // A key with no ⌘ is not a chord: still listening.
      fireEvent.keyDown(window, { key: 'm', code: 'KeyM' });
      expect(screen.getByTestId('dictate-chord')).toHaveTextContent('Press keys…');
      // Nor is ⌘ on its own.
      fireEvent.keyDown(window, { key: 'Meta', code: 'MetaLeft', metaKey: true });
      expect(screen.getByTestId('dictate-chord')).toHaveTextContent('Press keys…');
      fireEvent.keyDown(window, { key: 'µ', code: 'KeyM', metaKey: true, altKey: true });
      expect(screen.getByTestId('dictate-chord')).toHaveTextContent('Ctrl+Alt+M');
      expect(useUiStore.getState().dictateChord).toEqual({ alt: true, shift: false, code: 'KeyM' });
      expect(JSON.parse(localStorage.getItem('patch.voice.dictateChord')!)).toEqual({
        alt: true,
        shift: false,
        code: 'KeyM',
      });
    });

    it('Esc leaves the old chord', async () => {
      vi.stubGlobal('fetch', makeFetch());
      renderSettings('/settings/voice');
      fireEvent.click(await screen.findByTestId('dictate-chord-change'));
      fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' });
      expect(screen.getByTestId('dictate-chord')).toHaveTextContent('Ctrl+Shift+D');
      expect(useUiStore.getState().dictateChord).toEqual(DEFAULT_DICTATE_CHORD);
    });
  });

  // spec/07 § Voice — a config matrix: a hosted cell whose key a host lacks is
  // shown as not configured on that host, from `daemon.host.voiceKeys`.
  describe('a backend with no key on a host', () => {
    it('names the missing key per host on each hosted cell, and nothing on a local one', async () => {
      usePreferencesStore.setState({
        preferences: {
          ...usePreferencesStore.getState().preferences,
          // Tom's live config, 2026-09-24.
          voiceConfig: {
            dictation: { backend: 'gemini' },
            device: { backend: 'openai', layer: 'light', handoff: 'auto' },
            handsFree: { backend: 'local', layer: 'direct', handoff: 'auto' },
            call: { backend: 'local', layer: 'direct', handoff: 'auto' },
          },
        },
        loaded: true,
      });
      vi.stubGlobal('fetch', makeFetch());
      reportHost('d1', { hostName: 'hetzner', voiceKeys: { gemini: false, openai: false } });
      reportHost('d2', {
        hostName: 'mac',
        isHomeHost: false,
        voiceKeys: { gemini: true, openai: false },
      });
      reportHost('d3', { hostName: 'old-daemon', isHomeHost: false });
      renderSettings('/settings/voice');
      await waitFor(() => expect(screen.getByTestId('voice-dictation-keys')).toBeInTheDocument());
      expect(screen.getByTestId('voice-dictation-keys')).toHaveTextContent(
        'Not configured on hetzner: GEMINI_API_KEY is missing. Sessions there are refused.',
      );
      expect(screen.getByTestId('voice-device-keys')).toHaveTextContent(
        'Not configured on hetzner, mac: OPENAI_REALTIME_API_KEY is missing. Sessions there are refused.',
      );
      expect(screen.queryByTestId('voice-handsFree-keys')).toBeNull();
      expect(screen.queryByTestId('voice-call-keys')).toBeNull();
    });

    // spec/02 § Provider keys: a key set from Settings → Keys takes effect with
    // no restart, and the host's next report is what clears the line.
    it('clears the line live when the host reports the key has been set', async () => {
      usePreferencesStore.setState({
        preferences: {
          ...usePreferencesStore.getState().preferences,
          voiceConfig: {
            dictation: { backend: 'gemini' },
            device: { backend: 'local', layer: 'direct', handoff: 'auto' },
            handsFree: { backend: 'local', layer: 'direct', handoff: 'auto' },
            call: { backend: 'local', layer: 'direct', handoff: 'auto' },
          },
        },
        loaded: true,
      });
      vi.stubGlobal('fetch', makeFetch());
      reportHost('d1', { hostName: 'hetzner', voiceKeys: { gemini: false, openai: false } });
      renderSettings('/settings/voice');
      await waitFor(() => expect(screen.getByTestId('voice-dictation-keys')).toBeInTheDocument());
      act(() =>
        reportHost('d1', { hostName: 'hetzner', voiceKeys: { gemini: true, openai: false } }),
      );
      await waitFor(() => expect(screen.queryByTestId('voice-dictation-keys')).toBeNull());
    });
  });

  describe('Engine', () => {
    it('shows each surface as one engine choice, with no layer axis', async () => {
      vi.stubGlobal('fetch', makeFetch());
      renderSettings('/settings/voice');
      await waitFor(() => expect(screen.getByTestId('voice-dictation')).toBeInTheDocument());
      expect(screen.getByTestId('voice-dictation-engine-local')).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      expect(screen.getByTestId('voice-call-engine-local')).toHaveAttribute('aria-pressed', 'true');
      expect(screen.queryByTestId('voice-call-layer')).toBeNull();
      expect(screen.getByTestId('voice-call-engine-gemini-thinking')).toHaveTextContent(
        'Gemini Thinking',
      );
    });

    it('picking an engine writes the backend and layer it stands for', async () => {
      const server = preferencesServer(() => ({ ...usePreferencesStore.getState().preferences }));
      vi.stubGlobal('fetch', makeFetch({}, server.handler));
      renderSettings('/settings/voice');
      fireEvent.click(await screen.findByTestId('voice-call-engine-openai-mini'));
      await waitFor(() => expect(server.writes).toHaveLength(1));
      const cfg = server.writes[0]!.voiceConfig as Record<string, unknown>;
      expect(cfg.call).toEqual({ backend: 'openai', layer: 'light', handoff: 'auto' });
      expect(cfg.dictation).toEqual({ backend: 'local' });
      await waitFor(() =>
        expect(screen.getByTestId('voice-call-engine-openai-mini')).toHaveAttribute(
          'aria-pressed',
          'true',
        ),
      );
    });

    it('pressing the engine already chosen writes nothing', async () => {
      const server = preferencesServer(() => ({ ...usePreferencesStore.getState().preferences }));
      vi.stubGlobal('fetch', makeFetch({}, server.handler));
      renderSettings('/settings/voice');
      fireEvent.click(await screen.findByTestId('voice-handsFree-engine-local'));
      fireEvent.click(screen.getByTestId('voice-handsFree-engine-gemini-thinking'));
      await waitFor(() => expect(server.writes).toHaveLength(1));
      expect((server.writes[0]!.voiceConfig as Record<string, unknown>).handsFree).toEqual({
        backend: 'gemini',
        layer: 'heavy',
        handoff: 'auto',
      });
    });

    it('the hand-off row appears only on a hosted engine, and writes just that choice', async () => {
      const server = preferencesServer(() => ({ ...usePreferencesStore.getState().preferences }));
      vi.stubGlobal('fetch', makeFetch({}, server.handler));
      renderSettings('/settings/voice');
      await screen.findByTestId('voice-call-engine-local');
      expect(screen.queryByTestId('voice-call-handoff')).toBeNull();
      fireEvent.click(screen.getByTestId('voice-call-engine-gemini-flash'));
      fireEvent.click(await screen.findByTestId('voice-call-handoff-always'));
      await waitFor(() => expect(server.writes).toHaveLength(2));
      expect((server.writes[1]!.voiceConfig as Record<string, unknown>).call).toEqual({
        backend: 'gemini',
        layer: 'light',
        handoff: 'always',
      });
    });

    it('changing the engine keeps the hand-off choice', async () => {
      const server = preferencesServer(() => ({ ...usePreferencesStore.getState().preferences }));
      vi.stubGlobal('fetch', makeFetch({}, server.handler));
      renderSettings('/settings/voice');
      fireEvent.click(await screen.findByTestId('voice-call-engine-gemini-flash'));
      fireEvent.click(await screen.findByTestId('voice-call-handoff-never'));
      await waitFor(() =>
        expect(screen.getByTestId('voice-call-handoff-never')).toHaveAttribute(
          'aria-pressed',
          'true',
        ),
      );
      fireEvent.click(screen.getByTestId('voice-call-engine-gemini-thinking'));
      await waitFor(() => expect(server.writes).toHaveLength(3));
      expect((server.writes[2]!.voiceConfig as Record<string, unknown>).call).toEqual({
        backend: 'gemini',
        layer: 'heavy',
        handoff: 'never',
      });
    });

    it('says honestly what an unbuilt combination does', async () => {
      vi.stubGlobal('fetch', makeFetch());
      usePreferencesStore.setState({
        preferences: {
          ...usePreferencesStore.getState().preferences,
          voiceConfig: {
            dictation: { backend: 'local' },
            device: { backend: 'gemini', layer: 'light', handoff: 'auto' },
            handsFree: { backend: 'local', layer: 'direct', handoff: 'auto' },
            call: { backend: 'local', layer: 'direct', handoff: 'auto' },
          },
        },
        loaded: true,
      });
      renderSettings('/settings/voice');
      await waitFor(() =>
        expect(screen.getByTestId('voice-device-status')).toHaveTextContent(
          voiceCellStatus('device', 'gemini', 'light')!,
        ),
      );
      expect(screen.queryByTestId('voice-call-status')).toBeNull();
    });

    it('a failed write is said', async () => {
      vi.stubGlobal(
        'fetch',
        makeFetch({}, (u, init) =>
          u.includes('/api/settings') && init?.method === 'PATCH'
            ? json({ error: 'nope' }, 500)
            : null,
        ),
      );
      renderSettings('/settings/voice');
      fireEvent.click(await screen.findByTestId('voice-dictation-engine-gemini'));
      await waitFor(() => expect(errors()).toContain('Settings failed. Try again.'));
    });
  });

  it('voiceCellStatus mirrors the host’s branching', () => {
    expect(voiceCellStatus('device', 'openai', 'light')).toMatch(
      /Not implemented yet for this surface/,
    );
    expect(voiceCellStatus('call', 'local', 'light')).toMatch(/no front model built for local/);
    expect(voiceCellStatus('handsFree', 'gemini', 'light')).toMatch(/address word is not enforced/);
    expect(voiceCellStatus('call', 'local', 'direct')).toBeNull();
    expect(voiceCellStatus('dictation', 'openai')).toBeNull();
  });

  describe('Speaking (shared by every host)', () => {
    it('writes the chosen Kokoro voice to the account', async () => {
      const server = preferencesServer(() => usePreferencesStore.getState().preferences as never);
      vi.stubGlobal('fetch', makeFetch({}, server.handler));
      loadShared({ settings: { kokoroVoice: 'af_heart' } });
      renderSettings('/settings/voice');
      const select = (await screen.findByTestId('kokoro-voice')) as HTMLSelectElement;
      expect(select.value).toBe('af_heart');
      fireEvent.change(select, { target: { value: 'bm_george' } });
      await waitFor(() => expect(server.writes).toContainEqual({ kokoroVoice: 'bm_george' }));
    });

    it('says each host uses its own default until a voice is chosen', async () => {
      vi.stubGlobal('fetch', makeFetch());
      loadShared();
      renderSettings('/settings/voice');
      const select = (await screen.findByTestId('kokoro-voice')) as HTMLSelectElement;
      expect(select.value).toBe('');
      expect(screen.getByTestId('voice-speaking')).toHaveTextContent('Each host’s Kokoro default');
    });

    it('writes a new chat-name interval on blur and on Enter, and refuses a negative one', async () => {
      const server = preferencesServer(() => usePreferencesStore.getState().preferences as never);
      vi.stubGlobal('fetch', makeFetch({}, server.handler));
      loadShared({ settings: { chatNameInterval: 3 } });
      renderSettings('/settings/voice');
      const input = (await screen.findByTestId('chat-name-interval')) as HTMLInputElement;
      expect(input.value).toBe('3');
      fireEvent.blur(input);
      fireEvent.change(input, { target: { value: '5' } });
      fireEvent.blur(input);
      await waitFor(() => expect(server.writes).toContainEqual({ chatNameInterval: 5 }));
      fireEvent.change(screen.getByTestId('chat-name-interval'), { target: { value: '-1' } });
      fireEvent.blur(screen.getByTestId('chat-name-interval'));
      expect(server.writes).toHaveLength(1);
      await waitFor(() =>
        expect(errors()).toContain('Chat name interval must be a non-negative integer'),
      );
    });
  });

  describe('Voice devices', () => {
    const withVoiceDevice = {
      devices: [
        ...SETTINGS_PAYLOAD.devices,
        {
          surfaceId: 'vd-1',
          surfaceKind: 'voice-device',
          label: 'kitchen',
          issuedAt: 4,
          status: 'online',
          lastHeartbeat: 1,
          isCurrent: false,
        },
      ],
    };

    it('says none are paired, and mints no code until Pair is pressed', async () => {
      const fetchMock = makeFetch();
      vi.stubGlobal('fetch', fetchMock);
      renderSettings('/settings/voice');
      await waitFor(() => expect(screen.getByTestId('voice-devices-empty')).toBeInTheDocument());
      // Linked phones and browsers are not voice devices.
      expect(screen.queryByTestId('device-mob-7')).toBeNull();
      const minted = (): boolean =>
        fetchMock.mock.calls.some((c) => String(c[0]).includes('/pair/start'));
      expect(minted()).toBe(false);
      fireEvent.click(screen.getByTestId('pair-voice-device-open'));
      await waitFor(() =>
        expect(screen.getByTestId('pair-voice-device-code')).toHaveTextContent(
          'NONCE-abc123def456',
        ),
      );
      expect(minted()).toBe(true);
      // While open there is no second Pair button.
      expect(screen.queryByTestId('pair-voice-device-open')).toBeNull();
      fireEvent.click(screen.getByTestId('pair-voice-device-close'));
      await waitFor(() => expect(screen.queryByTestId('pair-voice-device-panel')).toBeNull());
      expect(screen.getByTestId('pair-voice-device-open')).toBeInTheDocument();
    });

    it('lists paired voice devices, each revocable, with Pair another', async () => {
      const fetchMock = makeFetch(withVoiceDevice);
      vi.stubGlobal('fetch', fetchMock);
      renderSettings('/settings/voice');
      await waitFor(() => expect(screen.getByTestId('device-vd-1')).toHaveTextContent('kitchen'));
      expect(screen.getByTestId('device-vd-1')).toHaveTextContent('Voice device');
      expect(screen.getByTestId('pair-voice-device-open')).toBeInTheDocument();
      fireEvent.click(screen.getByTestId('device-revoke-vd-1'));
      await waitFor(() =>
        expect(
          fetchMock.mock.calls.some(
            (c) =>
              String(c[0]).includes('/api/auth/revoke') &&
              String((c[1] as RequestInit).body).includes('vd-1'),
          ),
        ).toBe(true),
      );
    });
  });
});

describe('Settings → Agent', () => {
  describe('Model for new chats (account-wide)', () => {
    it('offers the home host’s catalogue and writes the pick to the account', async () => {
      const server = preferencesServer(() => ({ ...usePreferencesStore.getState().preferences }));
      vi.stubGlobal(
        'fetch',
        makeFetch({}, (u, init) =>
          u.includes('/api/models')
            ? json({
                models: [
                  { id: 'claude-opus-5', label: 'Opus 5' },
                  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
                ],
              })
            : server.handler(u, init),
        ),
      );
      reportHost('d1', { hostName: 'mac' });
      renderSettings('/settings/agent');
      await waitFor(() =>
        expect(screen.getByRole('option', { name: 'Sonnet 5' })).toBeInTheDocument(),
      );
      fireEvent.change(screen.getByTestId('default-model'), {
        target: { value: 'claude-sonnet-5' },
      });
      await waitFor(() => expect(server.writes).toEqual([{ defaultModel: 'claude-sonnet-5' }]));
    });

    it('says there is no home machine to read the list from, keeping the saved value', async () => {
      vi.stubGlobal('fetch', makeFetch());
      clearHosts();
      renderSettings('/settings/agent');
      await waitFor(() =>
        expect(screen.getByTestId('default-model-no-host')).toHaveTextContent(
          'Designate a home machine',
        ),
      );
      expect((screen.getByTestId('default-model') as HTMLSelectElement).value).toBe(
        usePreferencesStore.getState().preferences.defaultModel,
      );
    });
  });

  // spec/02 § Permission mode. The host default was reachable only from the
  // CLI: the settings page never named it, so the mode the next chat would be
  // stamped with was invisible from every surface.
  describe('Default permission mode (shared)', () => {
    it('shows the account’s default and writes a change to the server', async () => {
      const server = preferencesServer(() => usePreferencesStore.getState().preferences as never);
      vi.stubGlobal('fetch', makeFetch({}, server.handler));
      loadShared({ settings: { permissionModeDefault: 'acceptEdits' } });
      renderSettings('/settings/agent');
      const select = (await screen.findByTestId('permission-default')) as HTMLSelectElement;
      expect(select.value).toBe('acceptEdits');
      // The SDK's own mode names, never reworded, in the composer's order.
      expect(Array.from(select.options).map((o) => o.value)).toEqual([...PERMISSION_MODES]);
      fireEvent.change(select, { target: { value: 'bypassPermissions' } });
      await waitFor(() =>
        expect(server.writes).toContainEqual({ permissionModeDefault: 'bypassPermissions' }),
      );
    });

    it('does not depend on any host being online', async () => {
      vi.stubGlobal('fetch', makeFetch());
      loadShared();
      reportHost('d1');
      usePresenceStore.getState().setHostOnline('d1', false);
      renderSettings('/settings/agent');
      await waitFor(() => expect(screen.getByTestId('permission-default')).not.toBeDisabled());
    });
  });

  describe('Layers added to Claude Code (shared)', () => {
    const TOOLS = 'harness-tools-prompt';
    const SYSTEM = 'harness-system-prompt';

    it('shows each layer as a row with its state, and no editor until Edit', async () => {
      vi.stubGlobal('fetch', makeFetch());
      loadShared();
      reportHost('d1', { harnessToolsPromptDefault: '# Patch tools' });
      renderSettings('/settings/agent');
      await waitFor(() => expect(screen.getByTestId('harness-config')).toBeInTheDocument());
      expect(screen.getByTestId(`${TOOLS}-state`)).toHaveTextContent('Built-in default');
      expect(screen.getByTestId(`${SYSTEM}-state`)).toHaveTextContent('None');
      expect(screen.queryByTestId(TOOLS)).toBeNull();
    });

    // principles.md § No system-prompt injection — the editor shows the
    // built-in default rather than sitting empty while it is silently in force.
    it('opens the built-in tools prompt when there is no override, with nothing to reset', async () => {
      vi.stubGlobal('fetch', makeFetch());
      loadShared();
      reportHost('d1', {
        harnessToolsPromptDefault: '# Patch tools\n\nUse view_file to show a file.',
      });
      renderSettings('/settings/agent');
      fireEvent.click(await screen.findByTestId(`${TOOLS}-edit`));
      expect((screen.getByTestId(TOOLS) as HTMLTextAreaElement).value).toContain('Use view_file');
      expect(screen.queryByTestId(`${TOOLS}-reset`)).toBeNull();
    });

    it('an edited tools prompt shows the edit, and Reset restores the default', async () => {
      const server = preferencesServer(() => usePreferencesStore.getState().preferences as never);
      vi.stubGlobal('fetch', makeFetch({}, server.handler));
      loadShared({ settings: { harnessToolsPrompt: 'my own guidance' } });
      reportHost('d1', { harnessToolsPromptDefault: '# Patch tools' });
      renderSettings('/settings/agent');
      await waitFor(() => expect(screen.getByTestId(`${TOOLS}-state`)).toHaveTextContent('Edited'));
      fireEvent.click(screen.getByTestId(`${TOOLS}-edit`));
      fireEvent.click(screen.getByTestId(`${TOOLS}-reset`));
      await waitFor(() => expect(server.writes).toContainEqual({ harnessToolsPrompt: null }));
    });

    it('an emptied tools prompt reads as Off', async () => {
      vi.stubGlobal('fetch', makeFetch());
      loadShared({ settings: { harnessToolsPrompt: '' } });
      renderSettings('/settings/agent');
      await waitFor(() => expect(screen.getByTestId(`${TOOLS}-state`)).toHaveTextContent('Off'));
    });

    it('Save writes the system prompt and closes the editor', async () => {
      const server = preferencesServer(() => usePreferencesStore.getState().preferences as never);
      vi.stubGlobal('fetch', makeFetch({}, server.handler));
      loadShared({ settings: { harnessSystemPrompt: 'Be terse.\nAlways.' } });
      renderSettings('/settings/agent');
      await waitFor(() =>
        expect(screen.getByTestId(`${SYSTEM}-state`)).toHaveTextContent('Be terse.'),
      );
      fireEvent.click(screen.getByTestId(`${SYSTEM}-edit`));
      expect((screen.getByTestId(SYSTEM) as HTMLTextAreaElement).value).toBe('Be terse.\nAlways.');
      fireEvent.change(screen.getByTestId(SYSTEM), { target: { value: 'Be kind.' } });
      fireEvent.click(screen.getByTestId(`${SYSTEM}-save`));
      await waitFor(() =>
        expect(server.writes).toContainEqual({ harnessSystemPrompt: 'Be kind.' }),
      );
      await waitFor(() => expect(screen.queryByTestId(SYSTEM)).toBeNull());
    });

    it('edits the shared settings.json and each OS override, refusing text the server refuses', async () => {
      const server = preferencesServer(() => usePreferencesStore.getState().preferences as never);
      vi.stubGlobal(
        'fetch',
        makeFetch({}, (url, init) => {
          if (url.includes('/api/settings') && init?.method === 'PATCH') {
            const body = JSON.parse(String(init.body)) as { claudeSettings?: { shared: string } };
            if (body.claudeSettings?.shared === '[1]') {
              return json(
                { error: 'invalid_input', message: 'claudeSettings.shared must be a JSON object' },
                400,
              );
            }
          }
          return server.handler(url, init);
        }),
      );
      loadShared();
      renderSettings('/settings/agent');
      fireEvent.click(await screen.findByTestId('claude-settings-shared-edit'));
      fireEvent.change(screen.getByTestId('claude-settings-shared-json'), {
        target: { value: '[1]' },
      });
      fireEvent.click(screen.getByTestId('claude-settings-shared-save'));
      await waitFor(() =>
        expect(errors().some((e) => e.includes('must be a JSON object'))).toBe(true),
      );
      expect(screen.getByTestId('claude-settings-shared-json')).toBeInTheDocument();
      fireEvent.click(screen.getByTestId('claude-settings-shared-cancel'));
      fireEvent.click(screen.getByTestId('claude-settings-darwin-edit'));
      fireEvent.change(screen.getByTestId('claude-settings-darwin-json'), {
        target: { value: '{"hooks":{}}' },
      });
      fireEvent.click(screen.getByTestId('claude-settings-darwin-save'));
      await waitFor(() =>
        expect(server.writes).toContainEqual({
          claudeSettings: { shared: '', darwin: '{"hooks":{}}', linux: '' },
        }),
      );
    });
  });

  // The CLAUDE.md toggle, the Skills field, the Browser tools toggle and the
  // Project folders editor were removed with the redesign: CLAUDE.md is always
  // loaded, skills are the SDK's own, browser tools are two MCP servers (MCP
  // page), and the folder picker browses anywhere. None may creep back.
  describe('removed controls', () => {
    it('offers no CLAUDE.md, Skills, Browser tools or Project folders control', async () => {
      vi.stubGlobal('fetch', makeFetch());
      reportHost('d1', {
        harnessClaudeMdEnabled: true,
        harnessBrowserToolsEnabled: true,
        harnessSkills: 'all',
      });
      const { container } = renderSettings('/settings/agent');
      await waitFor(() => expect(screen.getByTestId('harness-config')).toBeInTheDocument());
      for (const id of [
        'harness-claude-md-enabled',
        'harness-skills',
        'harness-browser-tools-enabled',
        'settings-agent-behavior',
      ]) {
        expect(screen.queryByTestId(id)).toBeNull();
      }
      const text = container.textContent ?? '';
      expect(text).not.toMatch(/CLAUDE\.md|Skills|Browser tools|Project folders/);
    });

    it('draws no old single-page group anywhere in the nav or index', async () => {
      vi.stubGlobal('fetch', makeFetch());
      reportHost('d1');
      const { container } = renderSettings('/settings');
      await waitFor(() => expect(screen.getByTestId('settings-usage')).toBeInTheDocument());
      const headings = Array.from(container.querySelectorAll('h2')).map((h) => h.textContent);
      for (const gone of [
        'Agent behavior',
        'Credit sources',
        'Hosts & devices',
        'Integrations',
        'Special threads',
        'Connection',
        'This surface',
        'Daemons',
      ]) {
        expect(headings).not.toContain(gone);
      }
    });
  });

  describe('Questions — auto-expiry toggle and window (spec/02 § Questions are not approvals)', () => {
    const TOGGLE = 'question-expiry-toggle';
    const SECONDS = 'question-expiry-seconds';

    it('shows both controls reflecting the shared settings', async () => {
      vi.stubGlobal('fetch', makeFetch());
      loadShared({ settings: { questionExpiry: true, questionExpirySeconds: 60 } });
      renderSettings('/settings/agent');
      await waitFor(() => expect(screen.getByTestId(TOGGLE)).toBeInTheDocument());
      expect((screen.getByTestId(TOGGLE) as HTMLInputElement).checked).toBe(true);
      expect((screen.getByTestId(SECONDS) as HTMLInputElement).value).toBe('60');
    });

    it('turning it off writes questionExpiry:false', async () => {
      const server = preferencesServer(() => usePreferencesStore.getState().preferences as never);
      vi.stubGlobal('fetch', makeFetch({}, server.handler));
      loadShared({ settings: { questionExpiry: true } });
      renderSettings('/settings/agent');
      fireEvent.click(await screen.findByTestId(TOGGLE));
      await waitFor(() => expect(server.writes).toContainEqual({ questionExpiry: false }));
    });

    it('writes a window in bounds, and refuses one outside them without writing', async () => {
      const server = preferencesServer(() => usePreferencesStore.getState().preferences as never);
      vi.stubGlobal('fetch', makeFetch({}, server.handler));
      loadShared({ settings: { questionExpirySeconds: 600 } });
      renderSettings('/settings/agent');
      const input = (await screen.findByTestId(SECONDS)) as HTMLInputElement;
      fireEvent.change(input, { target: { value: '4' } });
      fireEvent.blur(input);
      await waitFor(() => expect(errors().some((e) => /between 5 and 3600/.test(e))).toBe(true));
      expect(server.writes).toEqual([]);
      fireEvent.change(screen.getByTestId(SECONDS), { target: { value: '120' } });
      fireEvent.keyDown(screen.getByTestId(SECONDS), { key: 'Enter' });
      await waitFor(() => expect(server.writes).toContainEqual({ questionExpirySeconds: 120 }));
    });
  });

  describe('Chats (account-wide)', () => {
    it('shows the loaded provider-context level and writes the next one', async () => {
      usePreferencesStore.setState({
        preferences: {
          ...usePreferencesStore.getState().preferences,
          providerContextVerbosity: 'summary',
        },
        loaded: true,
      });
      const server = preferencesServer(() => ({ ...usePreferencesStore.getState().preferences }));
      vi.stubGlobal('fetch', makeFetch({}, server.handler));
      renderSettings('/settings/agent');
      await waitFor(() => expect(screen.getByTestId('settings-transcript')).toBeInTheDocument());
      expect(screen.getByTestId('provider-context-verbosity-summary')).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      fireEvent.click(screen.getByTestId('provider-context-verbosity-full'));
      await waitFor(() =>
        expect(server.writes).toContainEqual({ providerContextVerbosity: 'full' }),
      );
      await waitFor(() =>
        expect(screen.getByTestId('provider-context-verbosity-full')).toHaveAttribute(
          'aria-pressed',
          'true',
        ),
      );
    });

    it('starts at Off when the account preference is off', async () => {
      usePreferencesStore.setState({
        preferences: {
          ...usePreferencesStore.getState().preferences,
          providerContextVerbosity: 'off',
        },
        loaded: true,
      });
      vi.stubGlobal('fetch', makeFetch());
      renderSettings('/settings/agent');
      await waitFor(() =>
        expect(screen.getByTestId('provider-context-verbosity-off')).toHaveAttribute(
          'aria-pressed',
          'true',
        ),
      );
      expect(screen.getByTestId('provider-context-verbosity-summary')).toHaveAttribute(
        'aria-pressed',
        'false',
      );
    });

    it('is disabled until the account preferences have loaded', async () => {
      usePreferencesStore.setState({ loaded: false });
      vi.stubGlobal('fetch', makeFetch());
      renderSettings('/settings/agent');
      await waitFor(() =>
        expect(screen.getByTestId('provider-context-verbosity-full')).toBeDisabled(),
      );
      expect(screen.getByTestId('provider-switch-warning')).toBeDisabled();
    });

    it('the provider-switch warning toggle writes its inverse', async () => {
      const server = preferencesServer(() => ({ ...usePreferencesStore.getState().preferences }));
      vi.stubGlobal('fetch', makeFetch({}, server.handler));
      renderSettings('/settings/agent');
      const toggle = (await screen.findByTestId('provider-switch-warning')) as HTMLInputElement;
      expect(toggle.checked).toBe(true);
      fireEvent.click(toggle);
      await waitFor(() => expect(server.writes).toEqual([{ suppressProviderSwitchWarning: true }]));
    });
  });
});

describe('Settings → Goals (account-wide)', () => {
  it('shows the built-in judge prompt, saves an edit, and Reset restores the default', async () => {
    const server = preferencesServer(() => ({ ...usePreferencesStore.getState().preferences }));
    vi.stubGlobal('fetch', makeFetch({}, server.handler));
    renderSettings('/settings/goals');
    fireEvent.click(await screen.findByTestId('goal-eval-prompt-edit'));
    const box = screen.getByTestId('goal-eval-prompt') as HTMLTextAreaElement;
    expect(box.value).toBe(DEFAULT_GOAL_EVAL_PROMPT);
    fireEvent.change(box, { target: { value: 'Judge harshly.' } });
    fireEvent.click(screen.getByTestId('goal-eval-prompt-save'));
    await waitFor(() => expect(server.writes).toEqual([{ goalEvalPrompt: 'Judge harshly.' }]));
    fireEvent.click(screen.getByTestId('goal-eval-prompt-edit'));
    expect((screen.getByTestId('goal-eval-prompt') as HTMLTextAreaElement).value).toBe(
      'Judge harshly.',
    );
    fireEvent.click(screen.getByTestId('goal-eval-prompt-reset'));
    await waitFor(() =>
      expect(server.writes[1]).toEqual({ goalEvalPrompt: DEFAULT_GOAL_EVAL_PROMPT }),
    );
  });

  it('writes the refusal limit, and ignores a value that is not a positive whole number', async () => {
    const server = preferencesServer(() => ({ ...usePreferencesStore.getState().preferences }));
    vi.stubGlobal('fetch', makeFetch({}, server.handler));
    renderSettings('/settings/goals');
    const input = (await screen.findByTestId('goal-refusal-limit')) as HTMLInputElement;
    expect(input.value).toBe('3');
    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.change(input, { target: { value: '2.5' } });
    fireEvent.change(input, { target: { value: '5' } });
    await waitFor(() => expect(server.writes).toEqual([{ goalRefusalLimit: 5 }]));
  });

  it('shows Sonnet 5.5 as the judge model, kept as an option', async () => {
    const server = preferencesServer(() => ({ ...usePreferencesStore.getState().preferences }));
    vi.stubGlobal('fetch', makeFetch({}, server.handler));
    renderSettings('/settings/goals');
    const select = (await screen.findByTestId('goal-model')) as HTMLSelectElement;
    expect(select.value).toBe('claude-sonnet-5-5');
    expect([...select.options].map((o) => o.value)).toContain('claude-sonnet-5-5');
  });
});

describe('Settings → Manager (account-wide)', () => {
  it('writes each control to the account', async () => {
    const server = preferencesServer(() => ({ ...usePreferencesStore.getState().preferences }));
    vi.stubGlobal('fetch', makeFetch({}, server.handler));
    renderSettings('/settings/manager');
    fireEvent.click(await screen.findByTestId('sweep-enabled'));
    await waitFor(() => expect(server.writes).toHaveLength(1));
    fireEvent.change(screen.getByTestId('manager-quiet-start'), { target: { value: '22:30' } });
    await waitFor(() => expect(server.writes).toHaveLength(2));
    fireEvent.change(screen.getByTestId('manager-quiet-end'), { target: { value: '06:15' } });
    await waitFor(() => expect(server.writes).toHaveLength(3));
    fireEvent.click(screen.getByTestId('rotation-enabled'));
    await waitFor(() => expect(server.writes).toHaveLength(4));
    fireEvent.change(screen.getByTestId('rotation-time'), { target: { value: '03:00' } });
    await waitFor(() => expect(server.writes).toHaveLength(5));
    expect(server.writes).toEqual([
      { sweepEnabled: false },
      { quietHoursStart: '22:30' },
      { quietHoursEnd: '06:15' },
      { rotationEnabled: false },
      { rotationTime: '03:00' },
    ]);
  });

  it('writes a trimmed address word on blur, and restores an empty one', async () => {
    const server = preferencesServer(() => ({ ...usePreferencesStore.getState().preferences }));
    vi.stubGlobal('fetch', makeFetch({}, server.handler));
    renderSettings('/settings/manager');
    const input = (await screen.findByTestId('manager-address-word')) as HTMLInputElement;
    expect(input.value).toBe('patch');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.blur(input);
    expect(input.value).toBe('patch');
    fireEvent.change(input, { target: { value: '  jeeves ' } });
    fireEvent.blur(input);
    await waitFor(() => expect(server.writes).toEqual([{ addressWord: 'jeeves' }]));
  });

  it('sweep prompt: opens the saved override, edits it, and Reset restores the built-in default', async () => {
    const server = preferencesServer(() => ({ ...usePreferencesStore.getState().preferences }));
    vi.stubGlobal('fetch', makeFetch({}, server.handler));
    renderSettings('/settings/manager');
    fireEvent.click(await screen.findByTestId('sweep-prompt-edit'));
    const box = screen.getByTestId('sweep-prompt') as HTMLTextAreaElement;
    expect(box.value).toBe(DEFAULT_SWEEP_PROMPT); // nothing has overridden it yet
    fireEvent.change(box, { target: { value: 'Be extra terse.' } });
    fireEvent.click(screen.getByTestId('sweep-prompt-save'));
    await waitFor(() => expect(server.writes).toEqual([{ sweepPrompt: 'Be extra terse.' }]));
    fireEvent.click(screen.getByTestId('sweep-prompt-edit'));
    expect((screen.getByTestId('sweep-prompt') as HTMLTextAreaElement).value).toBe(
      'Be extra terse.',
    );
    fireEvent.click(screen.getByTestId('sweep-prompt-reset'));
    await waitFor(() => expect(server.writes[1]).toEqual({ sweepPrompt: DEFAULT_SWEEP_PROMPT }));
    expect(screen.queryByTestId('sweep-prompt')).toBeNull(); // editor closes on a successful reset
  });

  it('jobs: the account autonomy prompt is edited once here, and Reset restores the built-in default', async () => {
    const DEFAULT = "You are running autonomously, don't stop to ask the user questions";
    const server = preferencesServer(() => ({ ...usePreferencesStore.getState().preferences }));
    vi.stubGlobal('fetch', makeFetch({}, server.handler));
    renderSettings('/settings/jobs');
    fireEvent.click(await screen.findByTestId('job-autonomy-prompt-default-edit'));
    const box = screen.getByTestId('job-autonomy-prompt-default') as HTMLTextAreaElement;
    expect(box.value).toBe(DEFAULT);
    fireEvent.change(box, { target: { value: 'House rule.' } });
    fireEvent.click(screen.getByTestId('job-autonomy-prompt-default-save'));
    await waitFor(() => expect(server.writes).toEqual([{ jobAutonomyPrompt: 'House rule.' }]));
    fireEvent.click(screen.getByTestId('job-autonomy-prompt-default-edit'));
    expect((screen.getByTestId('job-autonomy-prompt-default') as HTMLTextAreaElement).value).toBe(
      'House rule.',
    );
    fireEvent.click(screen.getByTestId('job-autonomy-prompt-default-reset'));
    await waitFor(() => expect(server.writes[1]).toEqual({ jobAutonomyPrompt: DEFAULT }));
  });

  it('keeps the saved special-thread model as an option and writes a new pick', async () => {
    const server = preferencesServer(() => ({ ...usePreferencesStore.getState().preferences }));
    vi.stubGlobal(
      'fetch',
      makeFetch({}, (u, init) =>
        u.includes('/api/models')
          ? json({ models: [{ id: 'claude-opus-5', label: 'Opus 5' }] })
          : server.handler(u, init),
      ),
    );
    reportHost('d1');
    renderSettings('/settings/manager');
    const select = (await screen.findByTestId('special-thread-model')) as HTMLSelectElement;
    // Scoped to this select: the sweep model picker on the same page reads
    // the same catalogue and lists the same options.
    await waitFor(() =>
      expect(within(select).getByRole('option', { name: 'Opus 5' })).toBeInTheDocument(),
    );
    // The saved value is not in the host's list, and is still offered.
    expect(select.value).toBe('claude-sonnet-5');
    fireEvent.change(select, { target: { value: 'claude-opus-5' } });
    await waitFor(() => expect(server.writes).toEqual([{ specialThreadModel: 'claude-opus-5' }]));
  });
});
