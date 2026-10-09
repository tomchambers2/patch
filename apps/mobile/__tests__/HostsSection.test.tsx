// Settings → Hosts on mobile (design/settings-redesign; spec/15 § Settings tab,
// spec/02 § Host identity).
//
// Hosts is a page: Add a host in its header, then one row per machine that
// opens that machine's own page (HostDetail) — its name, Make home, Update,
// agent backends with Sign in, optional components, Files and Terminal, and
// Remove this host. Every edit is addressed to that one machine and refused
// up front, naming it, when it cannot hear it.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, type ReactTestRenderer } from 'react-test-renderer';
import {
  renderRN,
  byTestId,
  byLabel,
  findHost,
  queryHost,
  textOf,
  actAsync,
  flush,
} from './testUtils/render';
import {
  HostDetail,
  HostsPage,
  HostsSection,
  hostSubtitle,
  platformLabel,
} from '../src/components/settings/HostsSection';
import HostScreen from '../app/hosts/[daemonId]/index';
import { usePresenceStore, type HostPresence } from '../src/stores/presenceStore';
import { useUiStore } from '../src/stores/uiStore';
import { api, ApiError } from '../src/api/rest';
import { __getLastAlert, __clearLastAlert } from './stubs/react-native';
import { reportHost, resetHosts } from './testUtils/settingsFixtures';
import { routerMock, __resetRouterMock, __setLocalSearchParams } from './stubs/expo-router';

const wsMock = { send: vi.fn(), safeSend: vi.fn(), requestReplay: vi.fn() };
vi.mock('../src/api/ws', () => ({ getWs: () => wsMock }));
const SHARED = {
  version: 2,
  settings: {} as never,
  secrets: { claude: [], codex: [], providerKeys: [] },
  hosts: [],
};
vi.mock('../src/api/rest', () => {
  class ApiError extends Error {
    override readonly name = 'ApiError';
    constructor(
      readonly status: number,
      message: string,
      readonly body: unknown,
    ) {
      super(message);
    }
  }
  return {
    ApiError,
    api: {
      daemonManifest: vi.fn(),
      daemonInstallCommand: vi.fn(),
      daemonPairStart: vi.fn(),
      removeHost: vi.fn(),
      addAccount: vi.fn(async () => SHARED),
      adoptAccount: vi.fn(async () => SHARED),
      adoptClaudeSettings: vi.fn(async () => SHARED),
    },
  };
});

const HOUR = 3600 * 1000;

function pressAlertButton(text: string): Promise<void> {
  const button = __getLastAlert()?.buttons?.find((b) => b.text === text);
  if (!button) throw new Error(`no "${text}" button on the last alert`);
  return actAsync(() => button.onPress?.());
}

function unreported(daemonId: string): HostPresence {
  return { daemonId, online: false, lastSeenAt: null, host: null, accounts: {} };
}

// Every tree is unmounted after its test: a host page left mounted would see
// the next test's store reset as its host vanishing (and navigate).
const mounted: ReactTestRenderer[] = [];
function render(element: React.ReactElement): ReactTestRenderer {
  const r = renderRN(element);
  mounted.push(r);
  return r;
}
afterEach(() => {
  act(() => {
    for (const r of mounted.splice(0)) r.unmount();
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  __clearLastAlert();
  __resetRouterMock();
  resetHosts();
});

// ── the list ────────────────────────────────────────────────────────────────

describe('mobile Settings → Hosts → the list', () => {
  it('lists EVERY registered machine, not just the default one, by name', () => {
    reportHost('host-b', { hostName: 'beta-box' });
    reportHost('host-a', { hostName: 'alpha' });
    const r = render(<HostsSection />);
    expect(textOf(findHost(r.root, byTestId('host-host-a-name')))).toBe('alpha');
    expect(textOf(findHost(r.root, byTestId('host-host-b-name')))).toBe('beta-box');
    // Sorted by name, not by insertion.
    const rows = r.root
      .findAll((i) => typeof i.type === 'string' && /^host-host-[ab]$/.test(i.props.testID ?? ''))
      .map((i) => i.props.testID);
    expect(rows).toEqual(['host-host-a', 'host-host-b']);
  });

  it('says a machine is awaiting its first report rather than naming it falsely', () => {
    usePresenceStore.setState({ hosts: { quiet: unreported('quiet') } });
    const r = render(<HostsSection />);
    expect(textOf(findHost(r.root, byTestId('host-quiet-name')))).toBe('quiet');
    expect(textOf(findHost(r.root, byTestId('host-quiet-status')))).toBe('awaiting first report');
  });

  it('subtitles a row with home, platform, and online or when it was last seen', () => {
    reportHost('mac', { hostName: 'mac', platform: 'darwin' });
    reportHost('box', { hostName: 'box', platform: 'linux', isHomeHost: true }, false);
    usePresenceStore.setState((s) => ({
      hosts: { ...s.hosts, box: { ...s.hosts.box!, lastSeenAt: Date.now() - 3 * HOUR } },
    }));
    const r = render(<HostsSection />);
    expect(textOf(findHost(r.root, byTestId('host-mac-status')))).toBe('macOS · online');
    expect(textOf(findHost(r.root, byTestId('host-box-status')))).toBe(
      'home · Linux · seen 3h ago',
    );
  });

  it('hostSubtitle / platformLabel read the reported platform plainly', () => {
    expect(platformLabel('darwin')).toBe('macOS');
    expect(platformLabel('linux')).toBe('Linux');
    expect(platformLabel('win32')).toBe('Windows');
    expect(platformLabel('freebsd')).toBe('freebsd');
    reportHost('w', { platform: 'win32' }, false);
    const w = usePresenceStore.getState().hosts.w!;
    expect(hostSubtitle({ ...w, lastSeenAt: null }, 0)).toBe('Windows · seen never');
    expect(hostSubtitle(unreported('q'))).toBe('awaiting first report');
  });

  it('offers Update only where a machine has one, and it sends host.update', async () => {
    reportHost('host-a', { hostName: 'laptop', updateAvailable: false });
    reportHost('host-b', { hostName: 'beta', updateAvailable: true });
    const r = render(<HostsSection />);
    expect(queryHost(r.root, byTestId('host-host-a-update'))).toBeNull();
    await actAsync(() => findHost(r.root, byTestId('host-host-b-update')).props.onPress());
    expect(wsMock.send).toHaveBeenCalledWith({ type: 'host.update', daemonId: 'host-b' });
  });

  it('an update aimed at an offline machine is refused, naming it', async () => {
    reportHost('h1', { hostName: 'laptop', updateAvailable: true }, false);
    const r = render(<HostsSection />);
    await actAsync(() => findHost(r.root, byTestId('host-h1-update')).props.onPress());
    expect(wsMock.send).not.toHaveBeenCalled();
    expect(__getLastAlert()?.title).toBe('Update failed');
    expect(__getLastAlert()?.message).toMatch(/^laptop is offline/);
  });

  it('an update with the link to the server down is refused, saying so', async () => {
    reportHost('h1', { hostName: 'laptop', updateAvailable: true });
    usePresenceStore.getState().setConnection('offline');
    const r = render(<HostsSection />);
    await actAsync(() => findHost(r.root, byTestId('host-h1-update')).props.onPress());
    expect(wsMock.send).not.toHaveBeenCalled();
    expect(__getLastAlert()?.message).toMatch(/no link to the server \(offline\)/);
  });

  it('tapping a row opens that host’s own page', () => {
    reportHost('host-a', { hostName: 'laptop' });
    usePresenceStore.setState((s) => ({ hosts: { ...s.hosts, quiet: unreported('quiet') } }));
    const r = render(<HostsSection />);
    findHost(r.root, byTestId('host-host-a')).props.onPress();
    expect(routerMock.push).toHaveBeenLastCalledWith({
      pathname: '/hosts/[daemonId]',
      params: { daemonId: 'host-a' },
    });
    // A machine that has not reported still opens (to be removed, if nothing else).
    findHost(r.root, byTestId('host-quiet')).props.onPress();
    expect(routerMock.push).toHaveBeenLastCalledWith({
      pathname: '/hosts/[daemonId]',
      params: { daemonId: 'quiet' },
    });
  });

  it('states plainly when no machine is registered', () => {
    const r = render(<HostsSection />);
    expect(textOf(findHost(r.root, byTestId('hosts-empty')))).toBe('No hosts yet');
  });
});

// ── Add a host ──────────────────────────────────────────────────────────────

describe('mobile Settings → Hosts → Add a host', () => {
  beforeEach(() => {
    vi.mocked(api.daemonManifest).mockResolvedValue({
      version: '0.1.9',
      artifacts: [{ target: 'linux-x64' }, { target: 'darwin-arm64' }],
    });
    vi.mocked(api.daemonInstallCommand).mockResolvedValue({
      os: 'macos',
      version: '0.1.9',
      targets: [],
      command: 'curl -fsSL https://x/install.sh | sh',
    });
    vi.mocked(api.daemonPairStart).mockResolvedValue({ nonce: 'ABC-123', expiresAt: 1 });
  });

  async function openAddHost(): Promise<ReactTestRenderer> {
    const r = render(<HostsPage />);
    await actAsync(async () => {
      findHost(r.root, byTestId('add-host')).props.onPress();
      await flush();
    });
    await flush();
    return r;
  }

  it('is a page titled Hosts, with the host list under it', () => {
    reportHost('h1', { hostName: 'laptop' });
    const r = render(<HostsPage />);
    expect(textOf(findHost(r.root, byTestId('settings-page-title')))).toBe('Hosts');
    expect(findHost(r.root, byTestId('host-h1'))).toBeTruthy();
  });

  it('opens on demand with the server’s command, published platforms and a pairing code', async () => {
    const r0 = render(<HostsPage />);
    expect(api.daemonManifest).not.toHaveBeenCalled();
    expect(queryHost(r0.root, byTestId('add-host-panel'))).toBeNull();
    r0.unmount();

    const r = await openAddHost();
    // The header button gives way to the panel's own Close.
    expect(queryHost(r.root, byTestId('add-host'))).toBeNull();
    expect(api.daemonInstallCommand).toHaveBeenCalledWith('macos');
    expect(textOf(findHost(r.root, byTestId('add-host-command')))).toBe(
      'curl -fsSL https://x/install.sh | sh',
    );
    expect(textOf(findHost(r.root, byTestId('add-host-platforms')))).toBe('Builds: macOS, Linux');
    expect(textOf(findHost(r.root, byTestId('pairing-code')))).toBe('ABC-123');
    await actAsync(() => findHost(r.root, byTestId('add-host-close')).props.onPress());
    expect(queryHost(r.root, byTestId('add-host-panel'))).toBeNull();
    expect(findHost(r.root, byTestId('add-host'))).toBeTruthy();
  });

  it('offers only the operating systems actually published', async () => {
    vi.mocked(api.daemonManifest).mockResolvedValue({
      version: '0.1.9',
      artifacts: [{ target: 'linux-arm64' }],
    });
    const r = await openAddHost();
    expect(api.daemonInstallCommand).toHaveBeenCalledWith('linux');
    expect(textOf(findHost(r.root, byTestId('add-host-platforms')))).toBe('Builds: Linux');
  });

  it('nothing published: says so and mints no code', async () => {
    vi.mocked(api.daemonManifest).mockResolvedValue({ version: '0', artifacts: [] });
    const r = await openAddHost();
    expect(findHost(r.root, byTestId('add-host-error'))).toBeTruthy();
    expect(api.daemonPairStart).not.toHaveBeenCalled();
    expect(queryHost(r.root, byTestId('pairing-code'))).toBeNull();
  });

  it('a manifest that cannot be fetched is treated as nothing published', async () => {
    vi.mocked(api.daemonManifest).mockRejectedValue(new Error('HTTP 503'));
    const r = await openAddHost();
    expect(findHost(r.root, byTestId('add-host-error'))).toBeTruthy();
    expect(api.daemonPairStart).not.toHaveBeenCalled();
  });

  it('a refused command and a failed code are each said in words, with Retry for the code', async () => {
    vi.mocked(api.daemonInstallCommand).mockRejectedValue(new Error('no_public_url: nope'));
    vi.mocked(api.daemonPairStart).mockRejectedValueOnce(new Error('HTTP 500'));
    const r = await openAddHost();
    expect(textOf(findHost(r.root, byTestId('add-host-command-error')))).toMatch(
      /no public address configured/,
    );
    expect(textOf(findHost(r.root, byTestId('pairing-code-error')))).toBe(
      'Couldn’t issue a pairing code: HTTP 500',
    );
    await actAsync(async () => {
      findHost(r.root, byLabel('Retry')).props.onPress();
      await flush();
    });
    expect(textOf(findHost(r.root, byTestId('pairing-code')))).toBe('ABC-123');
  });

  it('each install-command refusal code is said in words', async () => {
    for (const [code, words] of [
      ['nothing_published', 'No host build has been published yet.'],
      ['no_build_for_os: macos', 'No host build has been published for that operating system yet.'],
      ['something else', 'something else'],
    ] as const) {
      vi.mocked(api.daemonInstallCommand).mockRejectedValueOnce(new Error(code));
      const r = await openAddHost();
      expect(textOf(findHost(r.root, byTestId('add-host-command-error')))).toBe(words);
      r.unmount();
    }
  });
});

// ── one host's page ─────────────────────────────────────────────────────────

describe('mobile Settings → Hosts → a host’s page', () => {
  it('is routed at /hosts/[daemonId], titled with the host’s name', () => {
    reportHost('h1', { hostName: 'laptop' });
    __setLocalSearchParams({ daemonId: 'h1' });
    const r = render(<HostScreen />);
    expect(textOf(findHost(r.root, byTestId('settings-page-title')))).toBe('laptop');
    expect(findHost(r.root, byTestId('host-h1-name-input')).props.value).toBe('laptop');
    __setLocalSearchParams({});
  });

  it('an unknown or removed host says it is gone', () => {
    const r = render(<HostDetail daemonId="nope" />);
    expect(textOf(findHost(r.root, byTestId('host-detail-gone')))).toBe(
      'This host is no longer on the account',
    );
    expect(queryHost(r.root, byTestId('host-nope-remove'))).toBeNull();
    // Not having removed it here, it does not navigate away on its own.
    expect(routerMock.back).not.toHaveBeenCalled();
  });

  it('a host that has not reported shows only that, and can still be removed', () => {
    usePresenceStore.setState({ hosts: { quiet: unreported('quiet') } });
    const r = render(<HostDetail daemonId="quiet" />);
    expect(textOf(findHost(r.root, byTestId('host-quiet-status')))).toBe('awaiting first report');
    expect(queryHost(r.root, byTestId('host-quiet-name-input'))).toBeNull();
    expect(queryHost(r.root, byTestId('host-quiet-files'))).toBeNull();
    expect(findHost(r.root, byTestId('host-quiet-remove'))).toBeTruthy();
  });

  it('states online/offline, platform and host version', () => {
    reportHost('h1', {
      hostName: 'laptop',
      platform: 'linux',
      arch: 'x64',
      daemonVersion: '0.2.0',
    });
    const r = render(<HostDetail daemonId="h1" />);
    expect(textOf(findHost(r.root, byTestId('host-h1-status')))).toBe('Online');
    expect(textOf(findHost(r.root, byTestId('host-h1-platform')))).toBe('Linux x64');
    expect(textOf(r.root)).toContain('Host 0.2.0');
    expect(queryHost(r.root, byTestId('host-h1-update'))).toBeNull();
    reportHost('h1', { hostName: 'laptop' }, false);
    const r2 = render(<HostDetail daemonId="h1" />);
    expect(textOf(findHost(r2.root, byTestId('host-h1-status')))).toBe('Offline');
    expect(textOf(r2.root)).toMatch(/seen \d+s ago/);
  });

  describe('Name', () => {
    it('renames the machine; Save appears only once the name changes', async () => {
      reportHost('h1', { hostName: 'laptop' });
      const r = render(<HostDetail daemonId="h1" />);
      const input = (): ReturnType<typeof findHost> =>
        findHost(r.root, byTestId('host-h1-name-input'));
      expect(input().props.value).toBe('laptop');
      expect(queryHost(r.root, byTestId('host-h1-rename-save'))).toBeNull();
      await actAsync(() => input().props.onChangeText(' studio '));
      await actAsync(() => findHost(r.root, byTestId('host-h1-rename-save')).props.onPress());
      expect(wsMock.send).toHaveBeenCalledWith({
        type: 'host.rename',
        daemonId: 'h1',
        hostName: 'studio',
      });
      // The host's next report settles it.
      await actAsync(() => reportHost('h1', { hostName: 'studio' }));
      expect(input().props.value).toBe('studio');
      expect(queryHost(r.root, byTestId('host-h1-rename-save'))).toBeNull();
    });

    it('an empty name is refused, and the field goes back to the real name', async () => {
      reportHost('h1', { hostName: 'laptop' });
      const r = render(<HostDetail daemonId="h1" />);
      const input = (): ReturnType<typeof findHost> =>
        findHost(r.root, byTestId('host-h1-name-input'));
      await actAsync(() => input().props.onChangeText('  '));
      expect(findHost(r.root, byTestId('host-h1-rename-save')).props.disabled).toBe(true);
      await actAsync(() => input().props.onSubmitEditing());
      expect(__getLastAlert()).toMatchObject({
        title: 'Rename failed',
        message: 'A machine name cannot be empty.',
      });
      expect(input().props.value).toBe('laptop');
      expect(wsMock.send).not.toHaveBeenCalled();
    });

    it('submitting the unchanged name sends nothing', async () => {
      reportHost('h1', { hostName: 'laptop' });
      const r = render(<HostDetail daemonId="h1" />);
      await actAsync(() =>
        findHost(r.root, byTestId('host-h1-name-input')).props.onChangeText('laptop '),
      );
      await actAsync(() =>
        findHost(r.root, byTestId('host-h1-name-input')).props.onSubmitEditing(),
      );
      expect(wsMock.send).not.toHaveBeenCalled();
      expect(__getLastAlert()).toBeNull();
    });

    it('a rename to an offline machine is refused and the field reverts', async () => {
      reportHost('h1', { hostName: 'laptop' }, false);
      const r = render(<HostDetail daemonId="h1" />);
      const input = (): ReturnType<typeof findHost> =>
        findHost(r.root, byTestId('host-h1-name-input'));
      await actAsync(() => input().props.onChangeText('studio'));
      await actAsync(() => input().props.onSubmitEditing());
      expect(wsMock.send).not.toHaveBeenCalled();
      expect(__getLastAlert()?.title).toBe('Rename failed');
      expect(__getLastAlert()?.message).toMatch(/^laptop is offline/);
      expect(input().props.value).toBe('laptop');
    });
  });

  it('Update and Make home send their frames; the home machine says so instead', async () => {
    reportHost('h1', { hostName: 'laptop', updateAvailable: true });
    const r = render(<HostDetail daemonId="h1" />);
    expect(queryHost(r.root, byTestId('host-h1-home'))).toBeNull();
    await actAsync(() => findHost(r.root, byTestId('host-h1-update')).props.onPress());
    await actAsync(() => findHost(r.root, byTestId('host-h1-set-home')).props.onPress());
    expect(wsMock.send.mock.calls.map((c) => c[0])).toEqual([
      { type: 'host.update', daemonId: 'h1' },
      { type: 'host.set_home', daemonId: 'h1' },
    ]);
    await actAsync(() => reportHost('h1', { hostName: 'laptop', isHomeHost: true }));
    expect(queryHost(r.root, byTestId('host-h1-set-home'))).toBeNull();
    expect(textOf(findHost(r.root, byTestId('host-h1-home')))).toBe('This is home');
  });

  it('Make home on an offline machine is refused, naming it', async () => {
    reportHost('h1', { hostName: 'laptop' }, false);
    const r = render(<HostDetail daemonId="h1" />);
    await actAsync(() => findHost(r.root, byTestId('host-h1-set-home')).props.onPress());
    expect(wsMock.send).not.toHaveBeenCalled();
    expect(__getLastAlert()?.title).toBe('Make home failed');
    expect(__getLastAlert()?.message).toMatch(/^laptop is offline/);
  });

  describe('Agents', () => {
    it('is absent when the host reports no backends', () => {
      reportHost('h1', { hostName: 'laptop' });
      const r = render(<HostDetail daemonId="h1" />);
      expect(queryHost(r.root, byTestId('host-h1-backends'))).toBeNull();
    });

    it('states each backend; Sign in only where one is needed', () => {
      reportHost('h1', {
        hostName: 'laptop',
        backends: [
          { id: 'claude-code', label: 'Claude Code', version: '2.1.0', state: 'present' },
          { id: 'codex', label: 'Codex', version: null, state: 'failed', error: 'boom' },
        ],
      });
      const r = render(<HostDetail daemonId="h1" />);
      expect(textOf(findHost(r.root, byTestId('host-h1-backend-claude-code')))).toBe(
        '2.1.0 · present',
      );
      expect(textOf(findHost(r.root, byTestId('host-h1-backend-codex')))).toBe('failed — boom');
      expect(queryHost(r.root, byTestId('host-h1-backend-claude-code-connect'))).toBeNull();
      expect(findHost(r.root, byTestId('host-h1-backend-codex-connect'))).toBeTruthy();
    });

    it('a logged-out Claude backend offers Sign in, adding the token for every host', async () => {
      reportHost('h1', {
        hostName: 'laptop',
        backends: [{ id: 'claude-code', label: 'Claude Code', version: null, state: 'logged-out' }],
      });
      const r = render(<HostDetail daemonId="h1" />);
      expect(queryHost(r.root, byTestId('host-h1-signin-token'))).toBeNull();
      await actAsync(() =>
        findHost(r.root, byTestId('host-h1-backend-claude-code-connect')).props.onPress(),
      );
      const token = findHost(r.root, byTestId('host-h1-signin-token'));
      expect(token.props.secureTextEntry).toBe(true);
      await actAsync(() => token.props.onChangeText(' sk-1 '));
      await actAsync(async () => {
        findHost(r.root, byTestId('host-h1-signin-submit')).props.onPress();
        await flush();
      });
      // A Claude account is shared (spec/01 § Settings): added on the server.
      expect(api.addAccount).toHaveBeenCalledWith('claude-code', { token: 'sk-1' });
      expect(wsMock.send).not.toHaveBeenCalled();
      expect(queryHost(r.root, byTestId('host-h1-signin-token'))).toBeNull();
    });

    it('an empty token uses the machine’s own login; Sign in again closes the form', async () => {
      reportHost('h1', {
        hostName: 'laptop',
        backends: [{ id: 'claude-code', label: 'Claude Code', version: null, state: 'absent' }],
      });
      const r = render(<HostDetail daemonId="h1" />);
      const connect = (): ReturnType<typeof findHost> =>
        findHost(r.root, byTestId('host-h1-backend-claude-code-connect'));
      await actAsync(() => connect().props.onPress());
      await actAsync(() => connect().props.onPress());
      expect(queryHost(r.root, byTestId('host-h1-signin-token'))).toBeNull();
      await actAsync(() => connect().props.onPress());
      await actAsync(async () => {
        findHost(r.root, byTestId('host-h1-signin-submit')).props.onPress();
        await flush();
      });
      expect(api.adoptAccount).toHaveBeenCalledWith('claude-code', 'h1');
    });

    it('a settings.json changed on the machine is shown, with Keep and Discard', async () => {
      reportHost('h1', { hostName: 'laptop', platform: 'linux' });
      usePresenceStore.getState().setClaudeSettings('h1', '{"model":"sonnet"}', []);
      const r = render(<HostDetail daemonId="h1" />);
      expect(textOf(findHost(r.root, byTestId('host-h1-claude-drift-text')))).toContain('sonnet');
      await actAsync(async () => {
        findHost(r.root, byTestId('host-h1-claude-drift-keep-os')).props.onPress();
        await flush();
      });
      expect(api.adoptClaudeSettings).toHaveBeenCalledWith('h1', 'linux');
      await actAsync(() =>
        findHost(r.root, byTestId('host-h1-claude-drift-discard')).props.onPress(),
      );
      expect(wsMock.send).toHaveBeenCalledWith({
        type: 'host.claude_settings_discard',
        daemonId: 'h1',
      });
    });

    it('Sign in on an offline machine is refused, naming it', async () => {
      reportHost(
        'h1',
        {
          hostName: 'laptop',
          backends: [
            { id: 'claude-code', label: 'Claude Code', version: null, state: 'logged-out' },
          ],
        },
        false,
      );
      const r = render(<HostDetail daemonId="h1" />);
      await actAsync(() =>
        findHost(r.root, byTestId('host-h1-backend-claude-code-connect')).props.onPress(),
      );
      expect(__getLastAlert()).toMatchObject({
        title: 'Sign in failed',
        message: 'laptop is offline. Sign in once it reconnects.',
      });
      expect(queryHost(r.root, byTestId('host-h1-signin-token'))).toBeNull();
    });

    it('Sign in on a codex backend hands off to Usage’s ChatGPT form for that machine', async () => {
      reportHost('h1', {
        hostName: 'laptop',
        backends: [{ id: 'codex', label: 'Codex', version: null, state: 'absent' }],
      });
      const r = render(<HostDetail daemonId="h1" />);
      await actAsync(() =>
        findHost(r.root, byTestId('host-h1-backend-codex-connect')).props.onPress(),
      );
      expect(useUiStore.getState().codexSignInHost).toBe('h1');
      expect(routerMock.push).toHaveBeenLastCalledWith({
        pathname: '/settings/[page]',
        params: { page: 'usage' },
      });
      expect(queryHost(r.root, byTestId('host-h1-signin-token'))).toBeNull();
      useUiStore.getState().setCodexSignInHost(null);
    });
  });

  describe('Components', () => {
    const COMPONENTS = [
      { id: 'kokoro', label: 'Kokoro voice', bytes: 340 * 1024 * 1024, state: 'not-installed' },
      { id: 'whisper', label: 'Whisper', bytes: 1024, state: 'installed' },
      { id: 'piper', label: 'Piper', bytes: 10, state: 'downloading', progress: 0.42 },
      { id: 'vad', label: 'VAD', bytes: 10, state: 'failed', error: 'disk full' },
    ] as const;

    it('is absent when the host reports none', () => {
      reportHost('h1', { hostName: 'laptop' });
      const r = render(<HostDetail daemonId="h1" />);
      expect(queryHost(r.root, byTestId('host-h1-components'))).toBeNull();
    });

    it('states each component and offers the action its state allows', () => {
      reportHost('h1', { hostName: 'laptop', components: [...COMPONENTS] });
      const r = render(<HostDetail daemonId="h1" />);
      const row = (id: string): string =>
        textOf(findHost(r.root, byTestId(`host-h1-component-${id}`)));
      expect(row('kokoro')).toContain('340.0 MB');
      expect(row('whisper')).toContain('installed');
      expect(row('piper')).toContain('downloading 42%');
      expect(row('vad')).toContain('failed — disk full');
      expect(textOf(findHost(r.root, byTestId('host-h1-component-kokoro-install')))).toBe(
        'Install',
      );
      expect(textOf(findHost(r.root, byTestId('host-h1-component-vad-install')))).toBe('Retry');
      expect(findHost(r.root, byTestId('host-h1-component-whisper-remove'))).toBeTruthy();
      expect(queryHost(r.root, byTestId('host-h1-component-whisper-install'))).toBeNull();
      expect(queryHost(r.root, byTestId('host-h1-component-piper-install'))).toBeNull();
      expect(queryHost(r.root, byTestId('host-h1-component-piper-remove'))).toBeNull();
    });

    it('Install and Retry send host.component_install', async () => {
      reportHost('h1', { hostName: 'laptop', components: [...COMPONENTS] });
      const r = render(<HostDetail daemonId="h1" />);
      await actAsync(() =>
        findHost(r.root, byTestId('host-h1-component-kokoro-install')).props.onPress(),
      );
      await actAsync(() =>
        findHost(r.root, byTestId('host-h1-component-vad-install')).props.onPress(),
      );
      expect(wsMock.send.mock.calls.map((c) => c[0])).toEqual([
        { type: 'host.component_install', daemonId: 'h1', componentId: 'kokoro' },
        { type: 'host.component_install', daemonId: 'h1', componentId: 'vad' },
      ]);
    });

    it('Install on an offline machine is refused, naming it', async () => {
      reportHost('h1', { hostName: 'laptop', components: [...COMPONENTS] }, false);
      const r = render(<HostDetail daemonId="h1" />);
      await actAsync(() =>
        findHost(r.root, byTestId('host-h1-component-kokoro-install')).props.onPress(),
      );
      expect(wsMock.send).not.toHaveBeenCalled();
      expect(__getLastAlert()?.title).toBe('Install failed');
    });

    it('Remove asks first; Cancel sends nothing, Remove sends host.component_remove', async () => {
      reportHost('h1', { hostName: 'laptop', components: [...COMPONENTS] });
      const r = render(<HostDetail daemonId="h1" />);
      const remove = (): Promise<void> =>
        actAsync(() =>
          findHost(r.root, byTestId('host-h1-component-whisper-remove')).props.onPress(),
        );
      await remove();
      expect(__getLastAlert()).toMatchObject({
        title: 'Remove Whisper?',
        message: 'Delete it from laptop.',
      });
      await pressAlertButton('Cancel');
      expect(wsMock.send).not.toHaveBeenCalled();
      await remove();
      await pressAlertButton('Remove');
      expect(wsMock.send).toHaveBeenCalledWith({
        type: 'host.component_remove',
        daemonId: 'h1',
        componentId: 'whisper',
      });
    });
  });

  // spec/15 § Host files and terminal — a machine's files and a shell on it,
  // straight from its page, with no chat in between.
  describe('Tools', () => {
    it('opens that machine’s Files and Terminal', () => {
      reportHost('host-a', { hostName: 'laptop' });
      const r = render(<HostDetail daemonId="host-a" />);
      findHost(r.root, byTestId('host-host-a-files')).props.onPress();
      expect(routerMock.push).toHaveBeenLastCalledWith({
        pathname: '/hosts/[daemonId]/files',
        params: { daemonId: 'host-a' },
      });
      findHost(r.root, byTestId('host-host-a-terminal')).props.onPress();
      expect(routerMock.push).toHaveBeenLastCalledWith({
        pathname: '/hosts/[daemonId]/terminal',
        params: { daemonId: 'host-a' },
      });
    });

    it('are unpressable while the machine is offline or the link is down', () => {
      reportHost('host-a', { hostName: 'laptop' }, false);
      const offline = render(<HostDetail daemonId="host-a" />);
      expect(findHost(offline.root, byTestId('host-host-a-files')).props.onPress).toBeUndefined();
      expect(
        findHost(offline.root, byTestId('host-host-a-terminal')).props.onPress,
      ).toBeUndefined();
      usePresenceStore.getState().setHostOnline('host-a', true);
      usePresenceStore.getState().setConnection('offline');
      const linkDown = render(<HostDetail daemonId="host-a" />);
      expect(findHost(linkDown.root, byTestId('host-host-a-files')).props.onPress).toBeUndefined();
      expect(
        findHost(linkDown.root, byTestId('host-host-a-terminal')).props.onPress,
      ).toBeUndefined();
    });
  });

  describe('Remove this host', () => {
    beforeEach(() => {
      reportHost('h1', { hostName: 'laptop' });
      reportHost('h2', { hostName: 'other' });
    });

    async function askToRemove(r: ReactTestRenderer): Promise<void> {
      await actAsync(() => findHost(r.root, byTestId('host-h1-remove')).props.onPress());
    }

    it('asks first, naming the machine; Cancel does nothing', async () => {
      const r = render(<HostDetail daemonId="h1" />);
      await askToRemove(r);
      expect(__getLastAlert()).toMatchObject({
        title: 'Remove laptop?',
        message: 'laptop is signed out and has to be paired again to come back.',
      });
      await pressAlertButton('Cancel');
      expect(api.removeHost).not.toHaveBeenCalled();
      expect(usePresenceStore.getState().hosts.h1).toBeDefined();
      expect(routerMock.back).not.toHaveBeenCalled();
    });

    it('on confirm removes it from the account, drops it here and goes back', async () => {
      vi.mocked(api.removeHost).mockResolvedValue(undefined as never);
      const r = render(<HostDetail daemonId="h1" />);
      await askToRemove(r);
      await pressAlertButton('Remove');
      await flush();
      expect(api.removeHost).toHaveBeenCalledWith('h1');
      expect(usePresenceStore.getState().hosts.h1).toBeUndefined();
      // Only that host.
      expect(usePresenceStore.getState().hosts.h2).toBeDefined();
      expect(routerMock.back).toHaveBeenCalledTimes(1);
      expect(__getLastAlert()?.title).not.toBe('Remove failed');
    });

    it('shows Removing… and cannot be pressed twice while the request is out', async () => {
      let resolve!: () => void;
      vi.mocked(api.removeHost).mockReturnValue(
        new Promise<void>((r) => {
          resolve = r;
        }) as never,
      );
      const r = render(<HostDetail daemonId="h1" />);
      await askToRemove(r);
      await pressAlertButton('Remove');
      const button = findHost(r.root, byTestId('host-h1-remove'));
      expect(button.props.disabled).toBe(true);
      expect(textOf(button)).toBe('Removing…');
      await actAsync(async () => {
        resolve();
        await flush();
      });
      expect(routerMock.back).toHaveBeenCalledTimes(1);
    });

    it('a 404 says the host is not on the account any more, and keeps it', async () => {
      vi.mocked(api.removeHost).mockRejectedValue(
        new ApiError(404, 'HTTP 404', { error: 'not_found' }),
      );
      const r = render(<HostDetail daemonId="h1" />);
      await askToRemove(r);
      await pressAlertButton('Remove');
      await flush();
      expect(__getLastAlert()).toMatchObject({
        title: 'Remove failed',
        message: 'laptop is not on this account any more.',
      });
      expect(usePresenceStore.getState().hosts.h1).toBeDefined();
      expect(routerMock.back).not.toHaveBeenCalled();
      // Pressable again.
      const button = findHost(r.root, byTestId('host-h1-remove'));
      expect(button.props.disabled).toBe(false);
      expect(textOf(button)).toBe('Remove');
    });

    it('any other failure says the error itself', async () => {
      vi.mocked(api.removeHost).mockRejectedValue(new ApiError(500, 'HTTP 500: boom', null));
      const r = render(<HostDetail daemonId="h1" />);
      await askToRemove(r);
      await pressAlertButton('Remove');
      await flush();
      expect(__getLastAlert()).toMatchObject({ title: 'Remove failed', message: 'HTTP 500: boom' });
      expect(usePresenceStore.getState().hosts.h1).toBeDefined();
      expect(routerMock.back).not.toHaveBeenCalled();
      vi.mocked(api.removeHost).mockRejectedValue(new Error('Network request failed'));
      await askToRemove(r);
      await pressAlertButton('Remove');
      await flush();
      expect(__getLastAlert()?.message).toBe('Network request failed');
    });

    it('removed from elsewhere while open (host.removed): says it is gone and goes back', async () => {
      const r = render(<HostDetail daemonId="h1" />);
      await actAsync(() => usePresenceStore.getState().removeHost('h1'));
      expect(findHost(r.root, byTestId('host-detail-gone'))).toBeTruthy();
      expect(routerMock.back).toHaveBeenCalledTimes(1);
    });
  });
});
