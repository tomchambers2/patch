// Settings → Hosts, and the per-host pages that took over what the one long
// Hosts section used to hold (spec/02 § Host identity, spec/11 § Host
// installation, spec/14 § `/settings` details).
//
// The section did not exist once: Settings showed a single "Daemon" status
// line, so an account with several machines could see none of them, and a
// machine that was registered but had never reported rendered as a bare id on a
// permanent "Checking…". Settings is now one page per address; the host list,
// its detail and removal live on Hosts, a host's settings.json and permission
// mode on Agent, and its memory entries on Memories.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ClaudeMemoryEntry } from '@patch/wire';
import { HostsPage } from '../routes/settings/HostsPage.js';
import { AgentPage } from '../routes/settings/AgentPage.js';
import { MemoriesPage } from '../routes/settings/MemoriesPage.js';
import { useSettingsHostStore } from '../routes/settings/hostScope.js';
import { ErrorToasts } from '../components/ErrorToasts.js';
import { ConfirmModal } from '../components/ConfirmModal.js';
import { PromptModal } from '../components/PromptModal.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { api } from '../api/rest.js';
import { setActiveWs, type PatchWs } from '../api/ws.js';
import { reportHost, reportClaudeSettings, clearHosts } from './presenceHelpers.js';
import { loadShared, resetShared, sharedState } from './sharedHelpers.js';

type Page = 'hosts' | 'agent' | 'memories';

/** One Settings page at its own address, with the app's toasts and modals beside it. */
function renderPage(page: Page): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/settings/${page}`]}>
        <Routes>
          <Route path="/settings/hosts" element={<HostsPage />} />
          <Route path="/settings/agent" element={<AgentPage />} />
          <Route path="/settings/memories" element={<MemoriesPage />} />
          <Route path="/settings/usage" element={<div data-testid="usage-page" />} />
        </Routes>
      </MemoryRouter>
      <ErrorToasts />
      <ConfirmModal />
      <PromptModal />
    </QueryClientProvider>,
  );
}

/** Open a host's detail by clicking its row in the list. */
function openRow(daemonId: string): void {
  const row = screen.getByTestId(`host-${daemonId}`);
  const open = row.querySelector('button.set-row-open');
  if (!open) throw new Error(`host-${daemonId} row has no open button`);
  fireEvent.click(open);
}

const errors = (): string[] => useUiStore.getState().errors.map((e) => e.message);

let send: ReturnType<typeof vi.fn>;
/** Answers for the REST calls a test makes; anything unrouted never settles. */
let fetchRoutes: Record<string, () => Response>;
let fetchCalls: Array<{ url: string; method: string }>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  clearHosts();
  resetShared();
  vi.restoreAllMocks();
  useSettingsHostStore.setState({ selected: null });
  usePresenceStore.getState().setConnection('connected');
  send = vi.fn();
  setActiveWs({ send } as unknown as PatchWs);
  useUiStore.getState().clearToasts();
  useUiStore.getState().resolveConfirm(false);
  useUiStore.getState().resolvePrompt(null);
  useUiStore.getState().setCodexSignInHost(null);
  fetchRoutes = {};
  fetchCalls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      fetchCalls.push({ url, method });
      const route = fetchRoutes[`${method} ${url}`];
      return route ? Promise.resolve(route()) : new Promise<Response>(() => {});
    }),
  );
  // Agent's model picker reads the home host's catalogue.
  vi.spyOn(api, 'models').mockResolvedValue({ models: [] } as never);
});

afterEach(() => {
  setActiveWs(null);
  vi.unstubAllGlobals();
});

describe('Settings → Hosts', () => {
  it('lists EVERY registered machine, not just one', () => {
    reportHost('host-a', { hostName: 'laptop' });
    reportHost('host-b', { hostName: 'beta-box', isHomeHost: false });
    renderPage('hosts');
    expect(screen.getByTestId('host-host-a-label')).toHaveTextContent('laptop');
    expect(screen.getByTestId('host-host-b-label')).toHaveTextContent('beta-box');
  });

  it('says a machine is awaiting its first report rather than inventing a name for it', () => {
    // Registered and present in the greeting, but has never spoken.
    usePresenceStore.setState({
      hosts: {
        'host-quiet': {
          daemonId: 'host-quiet',
          online: false,
          lastSeenAt: null,
          host: null,
          accounts: {},
          claudeSettings: null,
          folders: null,
        },
      },
      daemonOnline: false,
    });
    renderPage('hosts');
    // Named by its id, never by a made-up label.
    expect(screen.getByTestId('host-host-quiet-id')).toHaveTextContent('host-quiet');
    expect(screen.queryByTestId('host-host-quiet-label')).toBeNull();
    expect(screen.getByTestId('host-host-quiet-status')).toHaveTextContent('awaiting first report');
    // Its detail says the same, and offers no controls it has nothing to back.
    expect(screen.getByTestId('host-host-quiet-unreported')).toHaveTextContent(
      'host-quiet hasn’t reported yet',
    );
    expect(screen.queryByTestId('host-host-quiet-name-input')).toBeNull();
  });

  it('offers an update control only on a machine that has one', () => {
    reportHost('host-a', { hostName: 'laptop' });
    renderPage('hosts');
    expect(screen.queryByTestId('host-host-a-update')).toBeNull();
  });

  it('Update on a machine that has one sends host.update to it', () => {
    reportHost('host-a', { hostName: 'laptop', updateAvailable: true });
    usePresenceStore.getState().setHostOnline('host-a', true);
    renderPage('hosts');
    fireEvent.click(screen.getByTestId('host-host-a-update'));
    expect(send).toHaveBeenCalledWith({ type: 'host.update', daemonId: 'host-a' });
  });

  it('Update on an OFFLINE machine is refused, naming it', () => {
    reportHost('host-a', { hostName: 'laptop', updateAvailable: true });
    renderPage('hosts');
    fireEvent.click(screen.getByTestId('host-host-a-update'));
    expect(send).not.toHaveBeenCalled();
    expect(errors().some((m) => m.includes('laptop') && /offline/.test(m))).toBe(true);
  });

  it('Update disables the button immediately, rather than looking unclicked', () => {
    reportHost('host-a', { hostName: 'laptop', updateAvailable: true });
    usePresenceStore.getState().setHostOnline('host-a', true);
    renderPage('hosts');
    const button = screen.getByTestId('host-host-a-update');
    fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('Updating…');
  });

  it('a refusal that arrives after the click re-enables the button', () => {
    reportHost('host-a', { hostName: 'laptop', updateAvailable: true });
    usePresenceStore.getState().setHostOnline('host-a', true);
    renderPage('hosts');
    const button = screen.getByTestId('host-host-a-update');
    fireEvent.click(button);
    expect(button).toBeDisabled();
    // What the host's async chat.error becomes once ws.ts routes it — see
    // ws.test.ts for that routing itself.
    act(() =>
      useUiStore.getState().pushError('host.update: machine host-a did not update — no update'),
    );
    expect(button).not.toBeDisabled();
    expect(button).toHaveTextContent('Update');
  });

  it('shows which machine is the home machine, and offers to move it', () => {
    reportHost('host-a', { hostName: 'laptop', isHomeHost: true });
    reportHost('host-b', { hostName: 'beta', isHomeHost: false });
    usePresenceStore.getState().setHostOnline('host-b', true);
    renderPage('hosts');
    expect(screen.getByTestId('host-host-a-home')).toBeInTheDocument();
    expect(screen.queryByTestId('host-host-b-home')).toBeNull();
    // The home machine's own detail has nothing to move.
    expect(screen.getByTestId('host-detail-host-a')).toHaveTextContent('This is home');
    expect(screen.queryByTestId('host-host-a-set-home')).toBeNull();
    openRow('host-b');
    fireEvent.click(screen.getByTestId('host-host-b-set-home'));
    expect(send).toHaveBeenCalledWith({ type: 'host.set_home', daemonId: 'host-b' });
  });

  it('opens on the home machine, and clicking another row switches the detail to it', () => {
    reportHost('host-a', { hostName: 'alpha', isHomeHost: false });
    reportHost('host-b', { hostName: 'beta', isHomeHost: true });
    renderPage('hosts');
    expect(screen.getByTestId('host-detail-host-b')).toBeInTheDocument();
    expect(screen.queryByTestId('host-detail-host-a')).toBeNull();
    openRow('host-a');
    expect(screen.getByTestId('host-detail-host-a')).toBeInTheDocument();
    expect(screen.queryByTestId('host-detail-host-b')).toBeNull();
    expect(screen.getByTestId('host-host-a')).toHaveClass('selected');
    expect(screen.getByTestId('host-host-b')).not.toHaveClass('selected');
    expect(screen.getByTestId('host-host-a-name-input')).toHaveValue('alpha');
  });

  // A backend that is logged out is the one state a person must act on. The row
  // reported it and offered nothing to click, so the only apparent fix was to
  // SSH into the machine and run `claude login` — for a credential the wire can
  // set directly.
  it('offers a sign-in on a backend that is not signed in', () => {
    reportHost('host-a', {
      hostName: 'laptop',
      backends: [{ id: 'claude-code', label: 'Claude Code', version: null, state: 'logged-out' }],
    });
    renderPage('hosts');
    expect(screen.getByTestId('host-host-a-backend-claude-code')).toBeInTheDocument();
    expect(screen.getByTestId('host-host-a-backend-claude-code-connect')).toHaveTextContent(
      'Sign in',
    );
  });

  it('offers no sign-in on a backend that is already signed in', () => {
    reportHost('host-a', {
      hostName: 'laptop',
      backends: [{ id: 'claude-code', label: 'Claude Code', version: '1', state: 'present' }],
    });
    renderPage('hosts');
    expect(screen.getByTestId('host-host-a-backend-claude-code')).toBeInTheDocument();
    expect(screen.queryByTestId('host-host-a-backend-claude-code-connect')).toBeNull();
  });

  it('Sign in on a Claude backend adds the pasted token for every host', async () => {
    reportHost('host-a', {
      hostName: 'laptop',
      backends: [{ id: 'claude-code', label: 'Claude Code', version: null, state: 'logged-out' }],
    });
    usePresenceStore.getState().setHostOnline('host-a', true);
    const add = vi.spyOn(api, 'addAccount').mockResolvedValue(sharedState({ version: 2 }));
    renderPage('hosts');
    fireEvent.click(screen.getByTestId('host-host-a-backend-claude-code-connect'));
    fireEvent.change(await screen.findByTestId('prompt-input'), {
      target: { value: '  sk-ant-oat01-xyz  ' },
    });
    fireEvent.click(screen.getByTestId('prompt-ok'));
    await waitFor(() =>
      expect(add).toHaveBeenCalledWith('claude-code', { token: 'sk-ant-oat01-xyz' }),
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('Sign in with no token adopts the login already on that machine', async () => {
    reportHost('host-a', {
      hostName: 'laptop',
      backends: [{ id: 'claude-code', label: 'Claude Code', version: null, state: 'logged-out' }],
    });
    usePresenceStore.getState().setHostOnline('host-a', true);
    const adopt = vi.spyOn(api, 'adoptAccount').mockResolvedValue(sharedState({ version: 2 }));
    renderPage('hosts');
    fireEvent.click(screen.getByTestId('host-host-a-backend-claude-code-connect'));
    await screen.findByTestId('prompt-input');
    fireEvent.click(screen.getByTestId('prompt-ok'));
    await waitFor(() => expect(adopt).toHaveBeenCalledWith('claude-code', 'host-a'));
  });

  it('shows which settings version each host runs, and a refusal by name', () => {
    reportHost('host-a', { hostName: 'laptop' });
    usePresenceStore.getState().setHostOnline('host-a', true);
    loadShared({ version: 5, hosts: [{ daemonId: 'host-a', appliedVersion: 5 }] });
    renderPage('hosts');
    expect(screen.getByTestId('host-host-a-settings-state')).toHaveTextContent('Up to date');
    act(() => {
      loadShared({
        version: 6,
        hosts: [
          {
            daemonId: 'host-a',
            appliedVersion: 5,
            error: 'provider keys: the shared settings have no Groq key',
          },
        ],
      });
    });
    expect(screen.getByTestId('host-host-a-settings-state')).toHaveTextContent(
      'Could not apply: provider keys: the shared settings have no Groq key',
    );
  });

  it('a settings.json changed on the machine is shown, and can be kept for every host or discarded', async () => {
    reportHost('host-a', { hostName: 'laptop', platform: 'linux' });
    usePresenceStore.getState().setHostOnline('host-a', true);
    reportClaudeSettings('host-a', [], '{"model":"sonnet"}');
    const adopt = vi
      .spyOn(api, 'adoptClaudeSettings')
      .mockResolvedValue(sharedState({ version: 2 }));
    renderPage('hosts');
    expect(screen.getByTestId('host-host-a-claude-drift-text')).toHaveTextContent(
      '"model":"sonnet"',
    );
    fireEvent.click(screen.getByTestId('host-host-a-claude-drift-keep-os'));
    await waitFor(() => expect(adopt).toHaveBeenCalledWith('host-a', 'linux'));
    fireEvent.click(screen.getByTestId('host-host-a-claude-drift-discard'));
    expect(send).toHaveBeenCalledWith({ type: 'host.claude_settings_discard', daemonId: 'host-a' });
  });

  it('shows no drift for a machine whose settings.json is in step', () => {
    reportHost('host-a', { hostName: 'laptop' });
    reportClaudeSettings('host-a');
    renderPage('hosts');
    expect(screen.queryByTestId('host-host-a-claude-drift')).toBeNull();
  });

  it('Sign in on a codex backend hands the host to the ChatGPT sign-in on Usage', () => {
    reportHost('host-a', {
      hostName: 'laptop',
      backends: [{ id: 'codex', label: 'Codex', version: null, state: 'logged-out' }],
    });
    usePresenceStore.getState().setHostOnline('host-a', true);
    renderPage('hosts');
    fireEvent.click(screen.getByTestId('host-host-a-backend-codex-connect'));
    expect(useUiStore.getState().codexSignInHost).toBe('host-a');
    expect(screen.getByTestId('usage-page')).toBeInTheDocument();
    expect(send).not.toHaveBeenCalled();
  });

  it('Sign in on an OFFLINE host is refused, naming it', () => {
    reportHost('host-a', {
      hostName: 'laptop',
      backends: [{ id: 'codex', label: 'Codex', version: null, state: 'logged-out' }],
    });
    renderPage('hosts');
    fireEvent.click(screen.getByTestId('host-host-a-backend-codex-connect'));
    expect(useUiStore.getState().codexSignInHost).toBeNull();
    expect(screen.queryByTestId('usage-page')).toBeNull();
    expect(errors().some((m) => m.includes('laptop') && /offline/.test(m))).toBe(true);
  });

  it('a component that is not installed offers Install, which sends host.component_install', () => {
    reportHost('host-a', {
      hostName: 'laptop',
      components: [{ id: 'kokoro', label: 'Kokoro', bytes: 340_000_000, state: 'not-installed' }],
    });
    usePresenceStore.getState().setHostOnline('host-a', true);
    renderPage('hosts');
    expect(screen.getByTestId('host-host-a-component-kokoro')).toHaveTextContent('340 MB');
    expect(screen.queryByTestId('host-host-a-component-kokoro-remove')).toBeNull();
    fireEvent.click(screen.getByTestId('host-host-a-component-kokoro-install'));
    expect(send).toHaveBeenCalledWith({
      type: 'host.component_install',
      daemonId: 'host-a',
      componentId: 'kokoro',
    });
  });

  it('an installed component offers Remove, which sends host.component_remove', () => {
    reportHost('host-a', {
      hostName: 'laptop',
      components: [{ id: 'kokoro', label: 'Kokoro', bytes: 340_000_000, state: 'installed' }],
    });
    usePresenceStore.getState().setHostOnline('host-a', true);
    renderPage('hosts');
    expect(screen.queryByTestId('host-host-a-component-kokoro-install')).toBeNull();
    fireEvent.click(screen.getByTestId('host-host-a-component-kokoro-remove'));
    expect(send).toHaveBeenCalledWith({
      type: 'host.component_remove',
      daemonId: 'host-a',
      componentId: 'kokoro',
    });
  });

  it('spec/02 § Browser — Route through: picker offers every OTHER host, not itself', () => {
    reportHost('host-a', { hostName: 'laptop' });
    reportHost('host-b', { hostName: 'beta-box', isHomeHost: false });
    usePresenceStore.getState().setHostOnline('host-a', true);
    usePresenceStore.getState().setHostOnline('host-b', true);
    renderPage('hosts');
    const select = screen.getByTestId('host-host-a-route-through') as HTMLSelectElement;
    const optionLabels = Array.from(select.options).map((o) => o.textContent);
    expect(optionLabels).toEqual(['None', 'beta-box']);
  });

  it('picking a host to route through sends host.settings, and the row says "via <host>"', () => {
    reportHost('host-a', { hostName: 'laptop' });
    reportHost('host-b', { hostName: 'beta-box', isHomeHost: false });
    usePresenceStore.getState().setHostOnline('host-a', true);
    usePresenceStore.getState().setHostOnline('host-b', true);
    renderPage('hosts');
    expect(screen.queryByTestId('host-host-a-routed-via')).toBeNull();

    fireEvent.change(screen.getByTestId('host-host-a-route-through'), {
      target: { value: 'host-b' },
    });
    expect(send).toHaveBeenCalledWith({
      type: 'host.settings',
      daemonId: 'host-a',
      browserRouteThrough: 'host-b',
    });

    // The row settles from the next report, same discipline as every other
    // host-scoped edit here — never patched locally ahead of it.
    act(() => reportHost('host-a', { hostName: 'laptop', browserRouteThrough: 'host-b' }));
    expect(screen.getByTestId('host-host-a-routed-via')).toHaveTextContent('via beta-box');
  });

  it('the routing host OFFLINE shows a plain warning that browsing will fail, no fallback implied', () => {
    reportHost('host-a', { hostName: 'laptop', browserRouteThrough: 'host-b' });
    reportHost('host-b', { hostName: 'beta-box', isHomeHost: false });
    usePresenceStore.getState().setHostOnline('host-a', true);
    usePresenceStore.getState().setHostOnline('host-b', false);
    renderPage('hosts');
    expect(screen.getByTestId('host-host-a-route-through-offline')).toHaveTextContent(
      'beta-box is offline',
    );
  });

  it('picking "None" sends browserRouteThrough: null, turning routing off', () => {
    reportHost('host-a', { hostName: 'laptop', browserRouteThrough: 'host-b' });
    reportHost('host-b', { hostName: 'beta-box', isHomeHost: false });
    usePresenceStore.getState().setHostOnline('host-a', true);
    usePresenceStore.getState().setHostOnline('host-b', true);
    renderPage('hosts');
    fireEvent.change(screen.getByTestId('host-host-a-route-through'), { target: { value: '' } });
    expect(send).toHaveBeenCalledWith({
      type: 'host.settings',
      daemonId: 'host-a',
      browserRouteThrough: null,
    });
  });

  it('states plainly when no machine is registered, and still offers to add one', () => {
    renderPage('hosts');
    // The empty state must point at the next action, not just report a void.
    expect(screen.getByTestId('hosts-empty')).toHaveTextContent('No hosts yet');
    expect(screen.getByTestId('add-host')).toHaveTextContent('Add a host');
  });

  it('Add a host opens the add-host panel, and Close closes it', async () => {
    vi.spyOn(api, 'daemonManifest').mockResolvedValue({
      version: '1.2.3',
      artifacts: [{ target: 'darwin-arm64' }, { target: 'linux-x64' }],
    });
    vi.spyOn(api, 'daemonInstallCommand').mockResolvedValue({
      os: 'macos',
      version: '1.2.3',
      targets: ['darwin-arm64'],
      command: 'curl -fsSL https://patch.example/install | sh',
    });
    renderPage('hosts');
    expect(screen.queryByTestId('add-host-panel')).toBeNull();
    fireEvent.click(screen.getByTestId('add-host'));
    expect(screen.getByTestId('add-host-panel')).toBeInTheDocument();
    expect(screen.getByTestId('add-host')).toBeDisabled();
    expect(await screen.findByTestId('add-host-command')).toHaveTextContent(
      'curl -fsSL https://patch.example/install | sh',
    );
    expect(screen.getByTestId('add-host-platforms')).toHaveTextContent('macOS, Linux');
    fireEvent.click(screen.getByTestId('add-host-close'));
    expect(screen.queryByTestId('add-host-panel')).toBeNull();
    expect(screen.getByTestId('add-host')).toBeEnabled();
  });
});

// spec/02 § Host identity — a machine always has a name, and renaming it is
// said to that machine, not patched locally.
describe('Settings → Hosts → rename', () => {
  beforeEach(() => {
    reportHost('host-a', { hostName: 'laptop' });
    usePresenceStore.getState().setHostOnline('host-a', true);
    renderPage('hosts');
  });

  const field = (): HTMLInputElement =>
    screen.getByTestId('host-host-a-name-input') as HTMLInputElement;
  const renames = (): unknown[] =>
    send.mock.calls.map((c) => c[0]).filter((e) => (e as { type: string }).type === 'host.rename');

  it('commits on ↵ via host.rename, trimmed', () => {
    fireEvent.change(field(), { target: { value: '  desk  ' } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(renames()).toEqual([{ type: 'host.rename', daemonId: 'host-a', hostName: 'desk' }]);
  });

  it('commits on blur via host.rename', () => {
    fireEvent.change(field(), { target: { value: 'desk' } });
    fireEvent.blur(field());
    expect(renames()).toEqual([{ type: 'host.rename', daemonId: 'host-a', hostName: 'desk' }]);
  });

  it('refuses an empty name, saying so, rather than leaving a nameless machine', () => {
    fireEvent.change(field(), { target: { value: '   ' } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    fireEvent.blur(field());
    expect(renames()).toEqual([]);
    expect(errors()).toContain('a machine name cannot be empty');
  });

  it('Escape restores the reported name and sends nothing', () => {
    fireEvent.change(field(), { target: { value: 'desk' } });
    fireEvent.keyDown(field(), { key: 'Escape' });
    expect(field()).toHaveValue('laptop');
    fireEvent.blur(field());
    expect(renames()).toEqual([]);
  });

  it('sends nothing when the name is unchanged', () => {
    fireEvent.keyDown(field(), { key: 'Enter' });
    fireEvent.blur(field());
    expect(renames()).toEqual([]);
  });
});

describe('Settings → Hosts → a machine that reports while its page is open', () => {
  it('fills the name field with the name it reports', () => {
    // Opened before the machine had said anything, the field had nothing to
    // show. Once it reports, the field must hold its name — not stay empty and
    // then refuse the blur as "a machine name cannot be empty".
    usePresenceStore.getState().setHostOnline('host-z', true);
    renderPage('hosts');
    expect(screen.getByTestId('host-host-z-unreported')).toBeInTheDocument();
    act(() => reportHost('host-z', { hostName: 'desk' }));
    const field = screen.getByTestId('host-host-z-name-input') as HTMLInputElement;
    expect(field).toHaveValue('desk');
    fireEvent.blur(field);
    expect(errors()).not.toContain('a machine name cannot be empty');
    expect(send).not.toHaveBeenCalled();
  });

  it('follows a rename made elsewhere rather than keeping the old name', () => {
    usePresenceStore.getState().setHostOnline('host-z', true);
    reportHost('host-z', { hostName: 'desk' });
    renderPage('hosts');
    expect(screen.getByTestId('host-host-z-name-input')).toHaveValue('desk');
    act(() => reportHost('host-z', { hostName: 'studio' }));
    expect(screen.getByTestId('host-host-z-name-input')).toHaveValue('studio');
  });
});

// Removing a machine from the account (spec/11 § Host installation). It is
// the one irreversible thing on the page, so it is confirmed first, and it is a
// server call — the machine may well be offline when someone gives up on it.
describe('Settings → Hosts → remove', () => {
  beforeEach(() => {
    reportHost('host-a', { hostName: 'laptop' });
    reportHost('host-b', { hostName: 'beta', isHomeHost: false });
  });

  const hostRemoveCalls = (): Array<{ url: string; method: string }> =>
    fetchCalls.filter((c) => c.url.startsWith('/api/hosts/'));

  it('asks first, and a cancelled confirm sends nothing', async () => {
    renderPage('hosts');
    fireEvent.click(screen.getByTestId('host-host-a-remove'));
    const modal = await screen.findByTestId('confirm-modal');
    expect(modal).toHaveTextContent('Remove laptop');
    fireEvent.click(screen.getByTestId('confirm-cancel'));
    await waitFor(() => expect(screen.queryByTestId('confirm-modal')).toBeNull());
    expect(hostRemoveCalls()).toEqual([]);
    expect(usePresenceStore.getState().hosts['host-a']).toBeDefined();
    expect(screen.getByTestId('host-host-a')).toBeInTheDocument();
  });

  it('confirmed, DELETEs /api/hosts/<id> and drops the host from the store and the page', async () => {
    fetchRoutes['DELETE /api/hosts/host-a'] = () => json(200, { ok: true, hosts: [] });
    renderPage('hosts');
    fireEvent.click(screen.getByTestId('host-host-a-remove'));
    fireEvent.click(await screen.findByTestId('confirm-ok'));
    await waitFor(() => expect(screen.queryByTestId('host-host-a')).toBeNull());
    expect(hostRemoveCalls()).toEqual([{ url: '/api/hosts/host-a', method: 'DELETE' }]);
    expect(usePresenceStore.getState().hosts['host-a']).toBeUndefined();
    expect(screen.queryByTestId('host-detail-host-a')).toBeNull();
    // The other machine is untouched.
    expect(screen.getByTestId('host-host-b')).toBeInTheDocument();
    expect(errors()).toEqual([]);
  });

  it('goes through api.removeHost naming that host', async () => {
    const remove = vi.spyOn(api, 'removeHost').mockResolvedValue({ ok: true, hosts: [] });
    renderPage('hosts');
    openRow('host-b');
    fireEvent.click(screen.getByTestId('host-host-b-remove'));
    fireEvent.click(await screen.findByTestId('confirm-ok'));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('host-b'));
    await waitFor(() => expect(usePresenceStore.getState().hosts['host-b']).toBeUndefined());
    expect(usePresenceStore.getState().hosts['host-a']).toBeDefined();
  });

  it('a 404 says the server has no such host', async () => {
    fetchRoutes['DELETE /api/hosts/host-a'] = () => json(404, { error: 'host_not_found' });
    renderPage('hosts');
    fireEvent.click(screen.getByTestId('host-host-a-remove'));
    fireEvent.click(await screen.findByTestId('confirm-ok'));
    await waitFor(() => expect(errors()).toContain('remove failed: the server has no host host-a'));
    expect(usePresenceStore.getState().hosts['host-a']).toBeDefined();
  });

  it('any other failure is said verbatim and the host stays', async () => {
    fetchRoutes['DELETE /api/hosts/host-a'] = () => json(500, { error: 'database_locked' });
    renderPage('hosts');
    fireEvent.click(screen.getByTestId('host-host-a-remove'));
    fireEvent.click(await screen.findByTestId('confirm-ok'));
    await waitFor(() => expect(errors()).toContain('remove failed: database_locked'));
    expect(usePresenceStore.getState().hosts['host-a']).toBeDefined();
    expect(screen.getByTestId('host-host-a')).toBeInTheDocument();
    expect(screen.getByTestId('host-detail-host-a')).toBeInTheDocument();
  });
});

const FEEDBACK_MEMORY: ClaudeMemoryEntry = {
  project: 'portfolio',
  file: 'feedback_tests.md',
  name: 'feedback_tests',
  description: 'write real tests',
  memoryType: 'feedback',
};

describe('Settings → Memories → Claude Code memory entries', () => {
  it('says a host has not sent its memories yet rather than showing none', () => {
    reportHost('host-a', { hostName: 'laptop' });
    renderPage('memories');
    expect(screen.getByTestId('host-host-a-memory-unreported')).toHaveTextContent('laptop');
    expect(screen.queryByTestId('host-host-a-memory-empty')).toBeNull();
  });

  it('shows every memory entry once reported', () => {
    reportHost('host-a', { hostName: 'laptop' });
    reportClaudeSettings('host-a', [FEEDBACK_MEMORY]);
    renderPage('memories');
    const item = screen.getByTestId('host-host-a-memory-portfolio-feedback_tests.md');
    expect(item).toHaveTextContent('feedback_tests');
    expect(item).toHaveTextContent('write real tests');
  });

  it('says there are no memory entries rather than showing an empty list', () => {
    reportHost('host-a', { hostName: 'laptop' });
    reportClaudeSettings('host-a', []);
    renderPage('memories');
    expect(screen.getByTestId('host-host-a-memory-empty')).toBeInTheDocument();
  });

  it('deleting an entry asks first, and a cancelled confirm sends nothing', async () => {
    reportHost('host-a', { hostName: 'laptop' });
    usePresenceStore.getState().setHostOnline('host-a', true);
    reportClaudeSettings('host-a', [FEEDBACK_MEMORY]);
    renderPage('memories');
    fireEvent.click(screen.getByTestId('host-host-a-memory-portfolio-feedback_tests.md-remove'));
    expect(await screen.findByTestId('confirm-modal')).toHaveTextContent('feedback_tests');
    fireEvent.click(screen.getByTestId('confirm-cancel'));
    await waitFor(() => expect(screen.queryByTestId('confirm-modal')).toBeNull());
    expect(send).not.toHaveBeenCalled();
  });

  it('a confirmed delete sends host.claude_memory_delete naming the entry', async () => {
    reportHost('host-a', { hostName: 'laptop' });
    usePresenceStore.getState().setHostOnline('host-a', true);
    reportClaudeSettings('host-a', [FEEDBACK_MEMORY]);
    renderPage('memories');
    fireEvent.click(screen.getByTestId('host-host-a-memory-portfolio-feedback_tests.md-remove'));
    fireEvent.click(await screen.findByTestId('confirm-ok'));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith({
        type: 'host.claude_memory_delete',
        daemonId: 'host-a',
        project: 'portfolio',
        file: 'feedback_tests.md',
      }),
    );
    // Not patched locally: the list settles on the host's own report.
    expect(
      screen.getByTestId('host-host-a-memory-portfolio-feedback_tests.md'),
    ).toBeInTheDocument();
  });

  it('refuses to delete on an offline host, naming it, rather than sending a doomed frame', async () => {
    reportHost('host-a', { hostName: 'laptop' });
    usePresenceStore.getState().setHostOnline('host-a', false);
    reportClaudeSettings('host-a', [{ ...FEEDBACK_MEMORY, description: '' }]);
    renderPage('memories');
    fireEvent.click(screen.getByTestId('host-host-a-memory-portfolio-feedback_tests.md-remove'));
    fireEvent.click(await screen.findByTestId('confirm-ok'));
    await waitFor(() =>
      expect(errors().some((m) => m.includes('laptop') && /offline/.test(m))).toBe(true),
    );
    expect(send).not.toHaveBeenCalled();
  });
});

// Settings → Hosts → Project folders used to add and remove a machine's
// designated project roots (`host.folder_add` / `host.folder_remove`). The
// reorganised Settings dropped the feature: folders are chosen where a chat is
// started. These pin that it is gone rather than half-present — a control that
// still rendered here with nothing wired behind it would be worse than none.
describe('Settings no longer manages project folders', () => {
  beforeEach(() => {
    reportHost('host-a', { hostName: 'laptop' });
    usePresenceStore.getState().setHostOnline('host-a', true);
    usePresenceStore.getState().setHostFolders('host-a', ['/srv/patch'], ['/tmp/elsewhere']);
    reportClaudeSettings('host-a');
  });

  function expectNoFolderControls(): void {
    expect(screen.queryByText(/project folders/i)).toBeNull();
    expect(document.querySelector('[data-testid^="host-host-a-folder"]')).toBeNull();
    expect(screen.queryByText('/srv/patch')).toBeNull();
  }

  it('the Hosts page offers no folder controls', () => {
    renderPage('hosts');
    expect(screen.getByTestId('host-detail-host-a')).toBeInTheDocument();
    expectNoFolderControls();
  });

  it('the Agent page offers no folder controls', () => {
    renderPage('agent');
    expect(screen.getByTestId('settings-agent')).toBeInTheDocument();
    expectNoFolderControls();
    expect(
      send.mock.calls.some((c) => /^host\.folder_/.test((c[0] as { type: string }).type)),
    ).toBe(false);
  });
});

// spec/04 § Spawn: the same folder string on two machines is two different
// directories, so a chat must say which machine it is running on. Nothing in
// the chat UI named the machine at all.
describe('chat header names its machine', () => {
  it('names the machine in the title hover, alongside the folder', async () => {
    reportHost('host-b', { hostName: 'beta-box' });
    const { ChatHeader } = await import('../components/ChatHeader.js');
    render(
      <MemoryRouter>
        <ChatHeader
          row={
            {
              chatId: '01TEST',
              daemonId: 'host-b',
              folder: '/work/proj',
              name: 'A chat',
              pinned: false,
              awaitingPermission: false,
            } as never
          }
        />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('chat-title')).toHaveAttribute('title', 'proj · beta-box');
  });

  it('falls back to the machine id while that machine has not reported a name', async () => {
    const { ChatHeader } = await import('../components/ChatHeader.js');
    render(
      <MemoryRouter>
        <ChatHeader
          row={
            {
              chatId: '01TEST2',
              daemonId: 'host-unknown',
              folder: '/work/proj',
              name: 'A chat',
              pinned: false,
              awaitingPermission: false,
            } as never
          }
        />
      </MemoryRouter>,
    );
    // Shown, not hidden — "which machine" has no safe default answer.
    expect(screen.getByTestId('chat-title')).toHaveAttribute('title', 'proj · host-unknown');
  });
});

// The new-chat screen must announce a machine that cannot run a turn, not let
// someone discover it by opening the model picker. Everything on that screen
// depends on it, so it is answered once and stated loudly.
describe('a machine that is not signed in blocks the new-chat screen', () => {
  it('states it and disables the folder and model pickers', async () => {
    reportHost('host-a', { hostName: 'laptop' });
    usePresenceStore.getState().setHostAccount({
      type: 'daemon.account',
      daemonId: 'host-a',
      backendId: 'claude-code',
      connected: false,
      accountEmail: null,
    });
    const { NewChatRoute } = await import('../routes/NewChatRoute.js');
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <NewChatRoute ws={null} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const blocked = await screen.findByTestId('new-chat-blocked');
    expect(blocked).toHaveTextContent('laptop');
    expect(blocked).toHaveTextContent(/isn.t signed in/i);
    expect(screen.getByTestId('new-chat-folder-pill')).toBeDisabled();
    expect(screen.getByTestId('new-chat-model')).toBeDisabled();
  });
});

describe('This Mac (spec/02 § Desktop app and the local host)', () => {
  function withBridge(
    status: { installed: boolean; daemonId: string | null },
    result = { ok: true, exitCode: 0, output: 'service started' },
  ) {
    const bridge = {
      status: vi.fn().mockResolvedValue(status),
      install: vi.fn().mockResolvedValue(result),
    };
    (window as unknown as { patch?: unknown }).patch = { localDaemon: bridge };
    return bridge;
  }
  afterEach(() => {
    delete (window as unknown as { patch?: unknown }).patch;
  });

  it('is absent in a browser', async () => {
    renderPage('hosts');
    await screen.findByTestId('settings-hosts');
    expect(screen.queryByTestId('this-mac')).not.toBeInTheDocument();
  });

  it('is absent once this Mac runs a host', async () => {
    const bridge = withBridge({ installed: true, daemonId: 'mac' });
    renderPage('hosts');
    await waitFor(() => expect(bridge.status).toHaveBeenCalled());
    expect(screen.queryByTestId('this-mac')).not.toBeInTheDocument();
  });

  it('installs with a freshly minted pairing code', async () => {
    const bridge = withBridge({ installed: false, daemonId: null });
    fetchRoutes['POST /api/auth/daemon/pair/start'] = () =>
      json(200, { nonce: 'fresh-code-0123456789', expiresAt: 1 });
    renderPage('hosts');
    fireEvent.click(await screen.findByTestId('this-mac-install'));
    await waitFor(() => expect(bridge.install).toHaveBeenCalledWith('fresh-code-0123456789'));
    expect(screen.queryByTestId('this-mac-error')).not.toBeInTheDocument();
  });

  it("says why an install failed, in the installer's words", async () => {
    withBridge(
      { installed: false, daemonId: null },
      { ok: false, exitCode: 75, output: 'patch install: the pairing code could not be submitted' },
    );
    fetchRoutes['POST /api/auth/daemon/pair/start'] = () =>
      json(200, { nonce: 'fresh-code-0123456789', expiresAt: 1 });
    renderPage('hosts');
    fireEvent.click(await screen.findByTestId('this-mac-install'));
    expect(await screen.findByTestId('this-mac-error')).toHaveTextContent(
      'the pairing code could not be submitted',
    );
  });
});
