// The Settings tab and its pages (design/settings-redesign): the tab is a
// grouped list — Agents, Setup, System — whose rows each open a page as its own
// screen at /settings/<id>; Updates carries a pip when something is behind; the
// shared `/api/settings` read is loaded on open and refreshed on web's 15s
// interval. /settings/[page] renders the page by id, and says so for an id
// that is not one.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactTestRenderer } from 'react-test-renderer';
import SettingsScreen from '../app/(tabs)/settings';
import SettingsPageScreen from '../app/settings/[page]';
import LayerEditorScreen from '../app/settings/layer';
import MemoryScreen from '../app/settings/memory';
import McpServerScreen from '../app/settings/mcp-server';
import HostScreen from '../app/hosts/[daemonId]/index';
import {
  renderRN,
  findAllHost,
  findHost,
  queryHost,
  byTestId,
  textOf,
  flush,
  actAsync,
} from './testUtils/render';
import { api } from '../src/api/rest';
import { useSettingsStore } from '../src/stores/settingsStore';
import { SETTINGS_PAGES, settingsPage } from '../src/components/settings/pages';
import { reportHost, resetHosts, settingsFixture } from './testUtils/settingsFixtures';
import { routerMock, __resetRouterMock, __setLocalSearchParams } from './stubs/expo-router';
import { __resetUseUpdates, __setUseUpdates } from './stubs/expo-updates';
import { __setSafeAreaInsets } from './stubs/safe-area-context';

vi.mock('../src/api/rest', () => ({
  api: {
    me: vi.fn(),
    healthz: vi.fn(),
    version: vi.fn(),
    settings: vi.fn(),
    setPreferences: vi.fn(),
    models: vi.fn(),
    listSecrets: vi.fn(),
    surfacePairStart: vi.fn(),
  },
  ApiError: class ApiError extends Error {},
}));
vi.mock('../src/lib/bootstrap', () => ({ teardown: vi.fn() }));
vi.mock('../src/lib/updateCheck', () => ({
  getLastCheckedAt: vi.fn(() => null),
  runUpdateCheck: vi.fn(),
  fetchPublishedApk: vi.fn(async () => null),
}));
vi.mock('../src/api/ws', () => ({ getWs: () => ({ send: vi.fn() }) }));

let mounted: ReactTestRenderer[] = [];
function render(el: React.ReactElement): ReactTestRenderer {
  const r = renderRN(el);
  mounted.push(r);
  return r;
}

beforeEach(() => {
  __resetRouterMock();
  vi.mocked(api.me)
    .mockReset()
    .mockReturnValue(new Promise(() => {}));
  vi.mocked(api.version)
    .mockReset()
    .mockReturnValue(new Promise(() => {}));
  vi.mocked(api.settings).mockReset().mockResolvedValue(settingsFixture());
  vi.mocked(api.models).mockReset().mockResolvedValue({ models: [] });
  vi.mocked(api.listSecrets).mockReset().mockResolvedValue({ secrets: [] });
  useSettingsStore.getState()._reset();
  resetHosts();
  reportHost('d1', { hostName: 'laptop', isHomeHost: true });
});

afterEach(() => {
  for (const r of mounted) r.unmount();
  mounted = [];
  __resetUseUpdates();
});

/** The list's rows, in order, as their titles. */
function rowTitles(r: ReactTestRenderer): string[] {
  return findAllHost(r.root, (i) => /^settings-row-/.test(String(i.props.testID))).map((i) =>
    String(i.props.accessibilityLabel),
  );
}

describe('Settings tab — the list', () => {
  it('shows the title and the design’s groups, rows and order', async () => {
    const r = render(<SettingsScreen />);
    await flush();
    const headers = findAllHost(
      r.root,
      (i) => i.type === 'Text' && i.props.accessibilityRole === 'header',
    ).map((i) => textOf(i));
    expect(headers).toEqual(['Settings', 'Agents', 'Setup', 'System']);
    expect(rowTitles(r)).toEqual([
      'Usage',
      'Agent',
      'MCP',
      'Memories',
      'Manager',
      'Goals',
      'Voice',
      'Hosts',
      'Keys',
      'Devices',
      'Updates',
      'Account',
    ]);
    const inGroup = (g: string): string[] =>
      findAllHost(findHost(r.root, byTestId(`settings-group-${g}`)), (i) =>
        /^settings-row-/.test(String(i.props.testID)),
      ).map((i) => String(i.props.accessibilityLabel));
    expect(inGroup('Agents')).toEqual([
      'Usage',
      'Agent',
      'MCP',
      'Memories',
      'Manager',
      'Goals',
      'Voice',
    ]);
    expect(inGroup('Setup')).toEqual(['Hosts', 'Keys', 'Devices']);
    expect(inGroup('System')).toEqual(['Updates', 'Account']);
  });

  it('draws no page content on the list itself', async () => {
    const r = render(<SettingsScreen />);
    await flush();
    expect(queryHost(r.root, byTestId('manager-watching'))).toBeNull();
    expect(queryHost(r.root, byTestId('settings-hosts'))).toBeNull();
  });

  it('says so when the server cannot read its stored accounts and keys', async () => {
    const problem =
      "The stored accounts and keys can't be read: /data/secrets.key is missing. Put back the secrets.key that goes with it, or delete /data/secrets.json and add the accounts and keys again.";
    const fixture = settingsFixture();
    vi.mocked(api.settings).mockResolvedValue({
      ...fixture,
      shared: { ...fixture.shared!, problem },
    });
    const r = render(<SettingsScreen />);
    await flush();
    expect(textOf(findHost(r.root, byTestId('settings-secrets-problem')))).toBe(problem);
  });

  it('shows no problem while the stored accounts and keys read fine', async () => {
    const r = render(<SettingsScreen />);
    await flush();
    expect(queryHost(r.root, byTestId('settings-secrets-problem'))).toBeNull();
  });

  it('tapping a row opens that page as its own screen', async () => {
    const r = render(<SettingsScreen />);
    await flush();
    for (const p of SETTINGS_PAGES) {
      findHost(r.root, byTestId(`settings-row-${p.id}`)).props.onPress();
      expect(routerMock.push).toHaveBeenLastCalledWith({
        pathname: '/settings/[page]',
        params: { page: p.id },
      });
    }
    expect(routerMock.push).toHaveBeenCalledTimes(SETTINGS_PAGES.length);
  });

  it('puts a pip on Updates only when something is behind', async () => {
    const r = render(<SettingsScreen />);
    await flush();
    expect(queryHost(r.root, byTestId('settings-updates-pip'))).toBeNull();
    // A host with a host update is behind.
    await actAsync(() => reportHost('d1', { hostName: 'laptop', updateAvailable: true }));
    const pip = findHost(r.root, byTestId('settings-updates-pip'));
    // …and it sits on the Updates row, not another.
    const updatesRow = findHost(r.root, byTestId('settings-row-updates'));
    expect(updatesRow.findAll((i) => i === pip)).toHaveLength(1);
  });

  it('an update downloaded and waiting for a restart is behind too', async () => {
    __setUseUpdates({ isUpdatePending: true });
    const r = render(<SettingsScreen />);
    await flush();
    expect(findHost(r.root, byTestId('settings-updates-pip'))).toBeTruthy();
  });

  it('reads /api/settings on open and again every 15s, as web polls it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const r = renderRN(<SettingsScreen />);
      await flush();
      expect(api.settings).toHaveBeenCalledTimes(1);
      await actAsync(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(api.settings).toHaveBeenCalledTimes(2);
      r.unmount();
      await actAsync(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(api.settings).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('/settings/[page]', () => {
  it('renders each page by id, titled as the list names it, with a back arrow', async () => {
    for (const p of SETTINGS_PAGES) {
      __setLocalSearchParams({ page: p.id });
      const r = render(<SettingsPageScreen />);
      await flush();
      expect(textOf(findHost(r.root, byTestId('settings-page-title')))).toBe(p.title);
      findHost(r.root, byTestId('settings-back')).props.onPress();
      expect(routerMock.back).toHaveBeenCalled();
      routerMock.back.mockClear();
    }
  });

  it('says so for an id that is not a page, rather than a blank screen', async () => {
    __setLocalSearchParams({ page: 'nope' });
    const r = render(<SettingsPageScreen />);
    await flush();
    expect(findHost(r.root, byTestId('settings-page-unknown'))).toBeTruthy();
    expect(settingsPage('nope')).toBeNull();
    expect(settingsPage('usage')?.title).toBe('Usage');
  });

  // A page is pushed above the tabs, so no tab bar clears the system nav bar
  // for it: its scroll content pads past the bottom inset itself.
  it('pads its scroll content past the system navigation bar', async () => {
    __setSafeAreaInsets({ bottom: 30 });
    __setLocalSearchParams({ page: 'account' });
    const r = render(<SettingsPageScreen />);
    await flush();
    const scroll = findAllHost(r.root, (i) => i.type === 'ScrollView')[0]!;
    expect(scroll.props.contentContainerStyle.paddingBottom).toBe(30 + 24);
    __setSafeAreaInsets({ bottom: 10 });
  });

  it('the host switcher appears on per-host pages once two hosts have reported', async () => {
    // Memories is per host (its entries live on each machine).
    __setLocalSearchParams({ page: 'memories' });
    let r = render(<SettingsPageScreen />);
    await flush();
    expect(queryHost(r.root, byTestId('host-switcher'))).toBeNull();
    reportHost('d2', { hostName: 'mac' });
    r = render(<SettingsPageScreen />);
    await flush();
    expect(findHost(r.root, byTestId('host-switcher'))).toBeTruthy();
    // …and never on a page of shared settings (spec/01 § Settings).
    __setLocalSearchParams({ page: 'agent' });
    r = render(<SettingsPageScreen />);
    await flush();
    expect(queryHost(r.root, byTestId('host-switcher'))).toBeNull();
    __setLocalSearchParams({ page: 'manager' });
    r = render(<SettingsPageScreen />);
    await flush();
    expect(queryHost(r.root, byTestId('host-switcher'))).toBeNull();
  });
});

describe('the pages’ own routes', () => {
  it('layer, memory, mcp-server and a host page render their screens from params', async () => {
    reportHost('d1', { hostName: 'laptop', isHomeHost: true, harnessMcpServers: [] });
    __setLocalSearchParams({ layer: 'system' });
    let r = render(<LayerEditorScreen />);
    expect(findHost(r.root, byTestId('settings-layer-editor'))).toBeTruthy();
    __setLocalSearchParams({ daemonId: 'd1', project: 'p', file: 'f.md' });
    r = render(<MemoryScreen />);
    expect(findHost(r.root, byTestId('settings-memory-detail'))).toBeTruthy();
    __setLocalSearchParams({ daemonId: 'd1' });
    r = render(<McpServerScreen />);
    expect(textOf(findHost(r.root, byTestId('settings-page-title')))).toBe('Add server');
    __setLocalSearchParams({ daemonId: 'd1' });
    r = render(<HostScreen />);
    expect(findHost(r.root, byTestId('settings-host-detail'))).toBeTruthy();
  });

  it('each refuses to open without the params it needs', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      __setLocalSearchParams({ layer: 'bogus' });
      expect(() => renderRN(<LayerEditorScreen />)).toThrow(/unknown layer/);
      __setLocalSearchParams({ daemonId: 'd1' });
      expect(() => renderRN(<MemoryScreen />)).toThrow(/without a daemonId, project and file/);
      __setLocalSearchParams({});
      expect(() => renderRN(<McpServerScreen />)).toThrow(/without a daemonId/);
      expect(() => renderRN(<HostScreen />)).toThrow(/without a daemonId/);
    } finally {
      quiet.mockRestore();
    }
  });
});
