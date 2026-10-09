// Settings → Usage on mobile (spec/10 § Backend credentials, spec/01 §
// Settings): the Claude and ChatGPT accounts every host draws from, ranked,
// with the strategy that picks among them and each account's freshest usage
// reading from any host. Every change is a server write that settles on the
// committed shared state; a ChatGPT sign-in runs on one online host.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactTestRenderer } from 'react-test-renderer';
import { act } from 'react-test-renderer';
import { DEFAULT_SHARED_SETTINGS } from '@patch/wire';
import { UsagePage } from '../src/components/settings/CreditSourcesSection';
import {
  renderRN,
  findHost,
  queryHost,
  byTestId,
  textOf,
  actAsync,
  flush,
} from './testUtils/render';
import { __getLastAlert, __clearLastAlert } from './stubs/react-native';
import { usePresenceStore } from '../src/stores/presenceStore';
import { useSettingsStore } from '../src/stores/settingsStore';
import { api } from '../src/api/rest';
import { pressMenuItem, reportHost, resetHosts, seedSettings } from './testUtils/settingsFixtures';

const send = vi.fn();
vi.mock('../src/api/ws', () => ({ getWs: vi.fn(() => ({ send })) }));
vi.mock('../src/api/rest', () => ({
  api: {
    setPreferences: vi.fn(),
    addAccount: vi.fn(),
    updateAccount: vi.fn(),
    disconnectAccount: vi.fn(),
    removeAccount: vi.fn(),
    orderAccounts: vi.fn(),
    setAccountStrategy: vi.fn(),
    adoptAccount: vi.fn(),
  },
}));

const WORK = {
  id: 'a',
  label: 'work',
  connected: true,
  email: 'work@example.com',
  organizationId: 'org-a',
};
const PERSONAL = { id: 'b', label: 'personal', connected: false };

function shared(claude = [WORK, PERSONAL], strategy: 'priority' | 'round-robin' = 'priority') {
  return {
    version: 2,
    settings: {
      ...DEFAULT_SHARED_SETTINGS,
      accountStrategy: { claude: strategy, codex: 'priority' as const },
    },
    secrets: { claude, codex: [], providerKeys: [] },
    hosts: [],
  };
}

const mounted: ReactTestRenderer[] = [];
async function render(): Promise<ReactTestRenderer> {
  const r = renderRN(<UsagePage />);
  mounted.push(r);
  await flush();
  return r;
}
const get = (r: ReactTestRenderer, id: string) => findHost(r.root, byTestId(id));
const query = (r: ReactTestRenderer, id: string) => queryHost(r.root, byTestId(id));

beforeEach(() => {
  vi.clearAllMocks();
  __clearLastAlert();
  resetHosts();
  seedSettings({
    shared: {
      version: 1,
      secrets: { claude: [WORK, PERSONAL], codex: [], providerKeys: [] },
      hosts: [],
    },
  });
});
afterEach(() => {
  act(() => {
    for (const r of mounted.splice(0)) r.unmount();
  });
});

describe('mobile Settings → Usage — the shared accounts', () => {
  it('lists the accounts in order, with no host switcher', async () => {
    const r = await render();
    expect(textOf(get(r, 'account-claude-code-a'))).toContain('work');
    expect(textOf(get(r, 'account-claude-code-a'))).toContain('work@example.com');
    expect(textOf(get(r, 'account-claude-code-b'))).toContain('Not connected');
    expect(query(r, 'host-switcher')).toBeNull();
  });

  it('says so while settings have not loaded, and when there are no accounts', async () => {
    useSettingsStore.getState()._reset();
    const r1 = await render();
    expect(query(r1, 'usage-loading')).not.toBeNull();
    seedSettings();
    const r2 = await render();
    expect(textOf(get(r2, 'accounts-empty-codex'))).toContain('No ChatGPT accounts yet');
  });

  it('shows the freshest usage reading any host took', async () => {
    reportHost('h1', { hostName: 'hetzner' });
    reportHost('h2', { hostName: 'mac', isHomeHost: false });
    const report = (daemonId: string, utilization: number, at: number) =>
      usePresenceStore.getState().setHostAccount({
        type: 'daemon.account',
        daemonId,
        backendId: 'claude-code',
        connected: true,
        accountEmail: null,
        accounts: [
          {
            id: 'a',
            label: 'work',
            connected: true,
            accountEmail: null,
            usage: { at, session: { status: 'allowed', utilization } },
          },
        ],
      });
    report('h1', 0.1, 1_000);
    report('h2', 0.7, 2_000);
    const r = await render();
    expect(textOf(get(r, 'account-claude-code-a'))).toContain('read on mac');
    expect(textOf(get(r, 'account-claude-code-a-usage-session'))).toContain('70%');
  });

  it('writes a new strategy to the server and shows the answer', async () => {
    vi.mocked(api.setAccountStrategy).mockResolvedValue(shared(undefined, 'round-robin'));
    const r = await render();
    expect(get(r, 'strategy-claude-code-priority').props.accessibilityState.selected).toBe(true);
    await actAsync(async () => {
      get(r, 'strategy-claude-code-round-robin').props.onPress();
      await flush();
    });
    expect(api.setAccountStrategy).toHaveBeenCalledWith('claude-code', 'round-robin');
    expect(get(r, 'strategy-claude-code-round-robin').props.accessibilityState.selected).toBe(true);
  });

  it('moves an account down, and settles on the server’s order', async () => {
    vi.mocked(api.orderAccounts).mockResolvedValue(shared([PERSONAL, WORK]));
    const r = await render();
    await pressMenuItem(r.root, 'account-claude-code-a-menu', 'account-claude-code-a-down');
    await flush();
    expect(api.orderAccounts).toHaveBeenCalledWith('claude-code', ['b', 'a']);
  });

  it('disconnect asks first; Disconnect disconnects for every host', async () => {
    vi.mocked(api.disconnectAccount).mockResolvedValue(
      shared([{ ...WORK, connected: false }, PERSONAL]),
    );
    const r = await render();
    await pressMenuItem(r.root, 'account-claude-code-a-menu', 'account-claude-code-a-disconnect');
    expect(__getLastAlert()?.message).toContain('Every host stops using it');
    expect(api.disconnectAccount).not.toHaveBeenCalled();
    await actAsync(async () => {
      __getLastAlert()!.buttons!.find((b) => b.text === 'Disconnect')!.onPress!();
      await flush();
    });
    expect(api.disconnectAccount).toHaveBeenCalledWith('claude-code', 'a');
  });

  it('adds a Claude account from a pasted token, and says a refusal in the server’s words', async () => {
    vi.mocked(api.addAccount).mockRejectedValue(
      Object.assign(new Error('HTTP 400'), {
        body: { message: 'Anthropic rejected this token (HTTP 401)' },
      }),
    );
    const r = await render();
    await actAsync(() => get(r, 'add-claude-account').props.onPress());
    await actAsync(() => get(r, 'add-claude-token').props.onChangeText(' sk-ant-oat01-x '));
    await actAsync(async () => {
      get(r, 'add-claude-submit').props.onPress();
      await flush();
    });
    expect(api.addAccount).toHaveBeenCalledWith('claude-code', { token: 'sk-ant-oat01-x' });
    expect(__getLastAlert()?.message).toBe('Anthropic rejected this token (HTTP 401)');
  });

  it('offers each online host’s own login', async () => {
    reportHost('h1', { hostName: 'hetzner' });
    vi.mocked(api.adoptAccount).mockResolvedValue(shared());
    const r = await render();
    await actAsync(async () => {
      get(r, 'adopt-claude-h1').props.onPress();
      await flush();
    });
    expect(api.adoptAccount).toHaveBeenCalledWith('claude-code', 'h1');
  });

  it('runs a ChatGPT sign-in on an online host, and says when none is online', async () => {
    const r1 = await render();
    expect(query(r1, 'chatgpt-no-host')).not.toBeNull();
    expect(get(r1, 'chatgpt-signin').props.disabled).toBe(true);
    reportHost('h1', { hostName: 'hetzner' });
    reportHost('h2', { hostName: 'mac' });
    const r2 = await render();
    expect(query(r2, 'chatgpt-signin-host')).toBeNull();
    expect(query(r2, 'adopt-codex-h1')).toBeNull();
    expect(query(r2, 'adopt-codex-h2')).toBeNull();
    await actAsync(() => get(r2, 'chatgpt-signin').props.onPress());
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'host.backend_add_account',
        daemonId: 'h1',
        backendId: 'codex',
        authMethod: 'device',
      }),
    );
  });

  it('auto-resume reads and writes the shared setting', async () => {
    vi.mocked(api.setPreferences).mockImplementation(async (patch) => ({
      preferences: { ...DEFAULT_SHARED_SETTINGS, ...patch },
    }));
    const r = await render();
    expect(get(r, 'auto-resume-rate-limit').props.value).toBe(true);
    await actAsync(async () => {
      get(r, 'auto-resume-rate-limit').props.onValueChange(false);
      await flush();
    });
    expect(api.setPreferences).toHaveBeenCalledWith({ autoResumeRateLimit: false });
  });
});
