// Settings → MCP (design/settings-redesign): the picked host's MCP servers —
// Patch built in and always on, then each of its `harnessMcpServers` with an
// enabled switch — and the edit screen (name, command line, KEY=VALUE env,
// Remove). Every change sends the WHOLE list, validated first.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactTestRenderer } from 'react-test-renderer';
import type { McpServerConfig } from '@patch/wire';
import { McpPage, McpServerEditor } from '../src/components/settings/McpSection';
import {
  renderRN,
  findHost,
  findAllHost,
  queryHost,
  byTestId,
  textOf,
  actAsync,
} from './testUtils/render';
import { __getLastAlert, __clearLastAlert } from './stubs/react-native';
import { routerMock, __resetRouterMock } from './stubs/expo-router';
import { usePresenceStore } from '../src/stores/presenceStore';
import { pickHost, reportHost, resetHosts } from './testUtils/settingsFixtures';

const send = vi.fn();
vi.mock('../src/api/ws', () => ({ getWs: () => ({ send }) }));

const playwright: McpServerConfig = {
  name: 'playwright',
  command: 'npx',
  args: ['@playwright/mcp', '--headless'],
  env: {},
  enabled: true,
};
const devtools: McpServerConfig = {
  name: 'chrome-devtools',
  command: 'npx',
  args: ['chrome-devtools-mcp'],
  env: { DEBUG: '1' },
  enabled: false,
};

let mounted: ReactTestRenderer[] = [];
function render(el: React.ReactElement): ReactTestRenderer {
  const r = renderRN(el);
  mounted.push(r);
  return r;
}

beforeEach(() => {
  send.mockReset();
  __clearLastAlert();
  __resetRouterMock();
  resetHosts();
  reportHost('d1', {
    hostName: 'laptop',
    isHomeHost: true,
    harnessMcpServers: [playwright, devtools],
  });
});
afterEach(() => {
  for (const r of mounted) r.unmount();
  mounted = [];
});

function pressAlert(text: string): void {
  __getLastAlert()!.buttons!.find((b) => b.text === text)!.onPress?.();
}

describe('MCP page', () => {
  it('lists Patch, built in and always on, then the host’s servers in order', () => {
    const r = render(<McpPage />);
    const rows = findAllHost(r.root, (i) => /^mcp-server-[^-]+(-[a-z]+)*$/.test(String(i.props.testID)))
      .map((i) => String(i.props.testID))
      .filter((id) => !id.endsWith('-enabled'));
    expect(rows).toEqual(['mcp-server-patch', 'mcp-server-playwright', 'mcp-server-chrome-devtools']);
    const patch = findHost(r.root, byTestId('mcp-server-patch'));
    expect(textOf(patch)).toContain('Built in');
    expect(textOf(patch)).toContain('Always on');
    expect(textOf(findHost(r.root, byTestId('mcp-server-playwright')))).toContain(
      'npx @playwright/mcp --headless',
    );
    expect(findHost(r.root, byTestId('mcp-server-playwright-enabled')).props.value).toBe(true);
    expect(findHost(r.root, byTestId('mcp-server-chrome-devtools-enabled')).props.value).toBe(
      false,
    );
  });

  it('a switch sends the whole list with that one server flipped', async () => {
    const r = render(<McpPage />);
    await actAsync(() =>
      findHost(r.root, byTestId('mcp-server-chrome-devtools-enabled')).props.onValueChange(true),
    );
    expect(send).toHaveBeenCalledWith({
      type: 'host.settings',
      daemonId: 'd1',
      harnessMcpServers: [playwright, { ...devtools, enabled: true }],
    });
  });

  it('switches are unpressable while the host is offline', () => {
    usePresenceStore.getState().setHostOnline('d1', false);
    const r = render(<McpPage />);
    expect(findHost(r.root, byTestId('mcp-server-playwright-enabled')).props.disabled).toBe(true);
  });

  it('tapping a server opens it; Add server opens an empty one', () => {
    const r = render(<McpPage />);
    findHost(r.root, byTestId('mcp-server-playwright')).props.onPress();
    expect(routerMock.push).toHaveBeenLastCalledWith({
      pathname: '/settings/mcp-server',
      params: { daemonId: 'd1', name: 'playwright' },
    });
    findHost(r.root, byTestId('mcp-add')).props.onPress();
    expect(routerMock.push).toHaveBeenLastCalledWith({
      pathname: '/settings/mcp-server',
      params: { daemonId: 'd1' },
    });
  });

  it('a host that predates the list says to update it, and offers no Add server', () => {
    resetHosts();
    reportHost('d1', { hostName: 'laptop' });
    const r = render(<McpPage />);
    expect(textOf(findHost(r.root, byTestId('mcp-update')))).toBe('Update laptop to manage this');
    expect(queryHost(r.root, byTestId('mcp-add'))).toBeNull();
  });

  it('shows the picked host’s servers', () => {
    reportHost('d2', { hostName: 'mac', harnessMcpServers: [] });
    pickHost('d2');
    const r = render(<McpPage />);
    expect(queryHost(r.root, byTestId('mcp-server-playwright'))).toBeNull();
    expect(findHost(r.root, byTestId('mcp-server-patch'))).toBeTruthy();
  });
});

describe('MCP server editor', () => {
  it('opens an existing server as its name, command line and env lines', () => {
    const r = render(<McpServerEditor daemonId="d1" name="chrome-devtools" />);
    expect(findHost(r.root, byTestId('mcp-editor-name')).props.value).toBe('chrome-devtools');
    expect(findHost(r.root, byTestId('mcp-editor-command')).props.value).toBe(
      'npx chrome-devtools-mcp',
    );
    expect(findHost(r.root, byTestId('mcp-editor-env')).props.value).toBe('DEBUG=1');
  });

  it('Save sends the whole list with this one replaced, then goes back', async () => {
    const r = render(<McpServerEditor daemonId="d1" name="playwright" />);
    await actAsync(() =>
      findHost(r.root, byTestId('mcp-editor-command')).props.onChangeText('npx @playwright/mcp'),
    );
    await actAsync(() => findHost(r.root, byTestId('mcp-editor-env')).props.onChangeText('X=1'));
    await actAsync(() => findHost(r.root, byTestId('mcp-editor-save')).props.onPress());
    expect(send).toHaveBeenCalledWith({
      type: 'host.settings',
      daemonId: 'd1',
      harnessMcpServers: [
        { ...playwright, args: ['@playwright/mcp'], env: { X: '1' } },
        devtools,
      ],
    });
    expect(routerMock.back).toHaveBeenCalledTimes(1);
  });

  it('adds a new server at the end', async () => {
    const r = render(<McpServerEditor daemonId="d1" name={null} />);
    expect(textOf(findHost(r.root, byTestId('settings-page-title')))).toBe('Add server');
    expect(queryHost(r.root, byTestId('mcp-editor-remove'))).toBeNull();
    await actAsync(() => findHost(r.root, byTestId('mcp-editor-name')).props.onChangeText('fs'));
    await actAsync(() =>
      findHost(r.root, byTestId('mcp-editor-command')).props.onChangeText('npx fs-mcp /tmp'),
    );
    await actAsync(() => findHost(r.root, byTestId('mcp-editor-save')).props.onPress());
    expect(send.mock.calls[0]![0].harnessMcpServers).toEqual([
      playwright,
      devtools,
      { name: 'fs', command: 'npx', args: ['fs-mcp', '/tmp'], env: {}, enabled: true },
    ]);
  });

  it('an invalid server is refused in words and nothing is sent', async () => {
    const r = render(<McpServerEditor daemonId="d1" name={null} />);
    await actAsync(() =>
      findHost(r.root, byTestId('mcp-editor-name')).props.onChangeText('playwright'),
    );
    await actAsync(() => findHost(r.root, byTestId('mcp-editor-command')).props.onChangeText('x'));
    await actAsync(() => findHost(r.root, byTestId('mcp-editor-save')).props.onPress());
    expect(textOf(findHost(r.root, byTestId('mcp-editor-error')))).toBe(
      'MCP server names must be unique',
    );
    await actAsync(() => findHost(r.root, byTestId('mcp-editor-name')).props.onChangeText('patch'));
    await actAsync(() => findHost(r.root, byTestId('mcp-editor-save')).props.onPress());
    expect(textOf(findHost(r.root, byTestId('mcp-editor-error')))).toMatch(/reserved/);
    await actAsync(() => findHost(r.root, byTestId('mcp-editor-name')).props.onChangeText('ok'));
    await actAsync(() => findHost(r.root, byTestId('mcp-editor-env')).props.onChangeText('junk'));
    await actAsync(() => findHost(r.root, byTestId('mcp-editor-save')).props.onPress());
    expect(textOf(findHost(r.root, byTestId('mcp-editor-error')))).toMatch(/KEY=VALUE/);
    expect(send).not.toHaveBeenCalled();
    expect(routerMock.back).not.toHaveBeenCalled();
  });

  it('an offline host is refused up front, naming it, and the editor stays', async () => {
    usePresenceStore.getState().setHostOnline('d1', false);
    const r = render(<McpServerEditor daemonId="d1" name="playwright" />);
    await actAsync(() => findHost(r.root, byTestId('mcp-editor-save')).props.onPress());
    expect(send).not.toHaveBeenCalled();
    expect(__getLastAlert()?.title).toBe('MCP servers failed');
    expect(__getLastAlert()?.message).toMatch(/^laptop is offline/);
    expect(routerMock.back).not.toHaveBeenCalled();
  });

  it('Remove asks first; confirming sends the list without it', async () => {
    const r = render(<McpServerEditor daemonId="d1" name="playwright" />);
    await actAsync(() => findHost(r.root, byTestId('mcp-editor-remove')).props.onPress());
    expect(__getLastAlert()?.title).toBe('Remove playwright?');
    pressAlert('Cancel');
    expect(send).not.toHaveBeenCalled();
    await actAsync(() => findHost(r.root, byTestId('mcp-editor-remove')).props.onPress());
    await actAsync(() => pressAlert('Remove'));
    expect(send).toHaveBeenCalledWith({
      type: 'host.settings',
      daemonId: 'd1',
      harnessMcpServers: [devtools],
    });
    expect(routerMock.back).toHaveBeenCalledTimes(1);
  });

  it('Cancel goes back without sending', async () => {
    const r = render(<McpServerEditor daemonId="d1" name="playwright" />);
    await actAsync(() => findHost(r.root, byTestId('mcp-editor-cancel')).props.onPress());
    expect(routerMock.back).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  it('says why it cannot edit: server gone, host predating the list, host unreported', () => {
    let r = render(<McpServerEditor daemonId="d1" name="gone" />);
    expect(textOf(findHost(r.root, byTestId('mcp-editor-unavailable')))).toBe(
      'gone is no longer on laptop',
    );
    reportHost('d2', { hostName: 'mac' });
    r = render(<McpServerEditor daemonId="d2" name={null} />);
    expect(textOf(findHost(r.root, byTestId('mcp-editor-unavailable')))).toBe(
      'Update mac to manage this',
    );
    usePresenceStore.getState().setHostOnline('d3', true);
    r = render(<McpServerEditor daemonId="d3" name={null} />);
    expect(textOf(findHost(r.root, byTestId('mcp-editor-unavailable')))).toBe(
      'd3 hasn’t reported yet',
    );
  });
});
