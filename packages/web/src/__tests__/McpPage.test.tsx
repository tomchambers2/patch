// Settings → MCP: the MCP servers one host wires into every chat it runs,
// beside Patch's own tools server, which is always on.
//
// Every edit sends the WHOLE list (`host.settings` with `harnessMcpServers`),
// checked against the wire's own `McpServerList` first, so a bad name or a
// duplicate is refused here — with nothing sent — rather than by the host.
// Nothing is patched locally: the list settles on the host's next report.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, fireEvent, act, within } from '@testing-library/react';
import type { McpServerConfig } from '@patch/wire';
import { useUiStore } from '../stores/uiStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import {
  envToLines,
  joinCommandLine,
  mcpListProblem,
  parseEnvLines,
  splitCommandLine,
} from '../routes/settings/McpPage.js';
import { reportHost } from './presenceHelpers.js';
import { setActiveWs } from '../api/ws.js';
import { fakeWs, makeFetch, renderSettings, resetSettingsState } from './settingsHarness.js';

const errors = (): string[] => useUiStore.getState().errors.map((e) => e.message);

const PLAYWRIGHT: McpServerConfig = {
  name: 'playwright',
  command: 'npx',
  args: ['@playwright/mcp', '--headless'],
  env: {},
  enabled: true,
};
const DEVTOOLS: McpServerConfig = {
  name: 'chrome-devtools',
  command: 'npx',
  args: ['chrome-devtools-mcp'],
  env: { DEBUG: '1' },
  enabled: false,
};

function reportServers(servers: McpServerConfig[] | undefined): void {
  reportHost('d1', {
    hostName: 'mac',
    ...(servers === undefined ? {} : { harnessMcpServers: servers }),
  });
}

async function openPage(): Promise<void> {
  renderSettings('/settings/mcp');
  await waitFor(() => expect(screen.getByTestId('settings-mcp')).toBeInTheDocument());
}

const fill = (testid: string, value: string): void => {
  fireEvent.change(screen.getByTestId(testid), { target: { value } });
};

beforeEach(() => {
  resetSettingsState();
  usePresenceStore.getState().setHostOnline('d1', true);
  vi.stubGlobal('fetch', makeFetch());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setActiveWs(null);
});

describe('Settings → MCP', () => {
  it('lists Patch, always on, then the host’s servers in its order', async () => {
    reportServers([PLAYWRIGHT, DEVTOOLS]);
    await openPage();
    const list = screen.getByTestId('mcp-servers');
    const rows = Array.from(list.querySelectorAll('[data-testid^="mcp-server-"]'))
      .map((el) => el.getAttribute('data-testid'))
      .filter((id) => !id!.endsWith('-enabled'));
    expect(rows).toEqual([
      'mcp-server-patch',
      'mcp-server-playwright',
      'mcp-server-chrome-devtools',
    ]);
    expect(screen.getByTestId('mcp-server-patch')).toHaveTextContent('Always on');
    // Patch's own server has no switch and no editor.
    expect(screen.queryByTestId('mcp-server-patch-enabled')).toBeNull();
    expect(screen.getByTestId('mcp-server-playwright')).toHaveTextContent(
      'npx @playwright/mcp --headless',
    );
    expect((screen.getByTestId('mcp-server-playwright-enabled') as HTMLInputElement).checked).toBe(
      true,
    );
    expect(
      (screen.getByTestId('mcp-server-chrome-devtools-enabled') as HTMLInputElement).checked,
    ).toBe(false);
  });

  it('a host without the setting is told to update, with nothing to edit', async () => {
    reportServers(undefined);
    await openPage();
    expect(screen.getByTestId('mcp-unsupported')).toHaveTextContent(
      'Update mac to manage its MCP servers',
    );
    expect(screen.queryByTestId('mcp-add')).toBeNull();
    expect(screen.queryByTestId('mcp-servers')).toBeNull();
  });

  it('a host that has not reported says so, with nothing to edit', async () => {
    await openPage();
    expect(screen.getByTestId('settings-host-unreported')).toBeInTheDocument();
    expect(screen.queryByTestId('mcp-add')).toBeNull();
  });

  it('toggling a server sends the whole list with just that one flipped', async () => {
    const { sent } = fakeWs();
    reportServers([PLAYWRIGHT, DEVTOOLS]);
    await openPage();
    fireEvent.click(screen.getByTestId('mcp-server-chrome-devtools-enabled'));
    expect(sent).toEqual([
      {
        type: 'host.settings',
        daemonId: 'd1',
        harnessMcpServers: [PLAYWRIGHT, { ...DEVTOOLS, enabled: true }],
      },
    ]);
    // Not patched locally: the switch shows what the host holds until it says otherwise.
    expect(
      (screen.getByTestId('mcp-server-chrome-devtools-enabled') as HTMLInputElement).checked,
    ).toBe(false);
    act(() => reportServers([PLAYWRIGHT, { ...DEVTOOLS, enabled: true }]));
    await waitFor(() =>
      expect(
        (screen.getByTestId('mcp-server-chrome-devtools-enabled') as HTMLInputElement).checked,
      ).toBe(true),
    );
  });

  it('adds a server, splitting the command line and parsing the environment', async () => {
    const { sent } = fakeWs();
    reportServers([PLAYWRIGHT]);
    await openPage();
    fireEvent.click(screen.getByTestId('mcp-add'));
    expect(screen.getByTestId('mcp-add')).toBeDisabled();
    // A new server has nothing to remove.
    expect(screen.queryByTestId('mcp-editor-remove')).toBeNull();
    fill('mcp-editor-name', ' todoist ');
    fill('mcp-editor-command', 'node "/opt/my tools/todoist.js" --port 3');
    fill('mcp-editor-env', 'TOKEN=abc=def\n\n  REGION = eu');
    fireEvent.click(screen.getByTestId('mcp-editor-save'));
    expect(sent).toEqual([
      {
        type: 'host.settings',
        daemonId: 'd1',
        harnessMcpServers: [
          PLAYWRIGHT,
          {
            name: 'todoist',
            command: 'node',
            args: ['/opt/my tools/todoist.js', '--port', '3'],
            env: { TOKEN: 'abc=def', REGION: ' eu' },
            enabled: true,
          },
        ],
      },
    ]);
    // Sent, so the editor closes; the new row appears on the host's report.
    expect(screen.queryByTestId('mcp-editor')).toBeNull();
    expect(screen.getByTestId('mcp-add')).not.toBeDisabled();
  });

  it('Cancel on a new server closes it and sends nothing', async () => {
    const { sent } = fakeWs();
    reportServers([]);
    await openPage();
    fireEvent.click(screen.getByTestId('mcp-add'));
    fill('mcp-editor-name', 'x');
    fireEvent.click(screen.getByTestId('mcp-editor-cancel'));
    expect(screen.queryByTestId('mcp-editor')).toBeNull();
    expect(sent).toEqual([]);
  });

  it.each([
    ['an invalid name', 'has space', 'Name may only use letters, digits, - and _ (at most 64)'],
    ['a duplicate name', 'playwright', 'MCP server names must be unique'],
    ['the reserved name', 'patch', '"patch" is reserved for Patch\'s own tools'],
  ])('refuses %s with the wire’s own words, and sends nothing', async (_what, name, message) => {
    const { sent } = fakeWs();
    reportServers([PLAYWRIGHT]);
    await openPage();
    fireEvent.click(screen.getByTestId('mcp-add'));
    fill('mcp-editor-name', name);
    fill('mcp-editor-command', 'npx thing');
    fireEvent.click(screen.getByTestId('mcp-editor-save'));
    expect(screen.getByTestId('mcp-editor-error')).toHaveTextContent(message);
    expect(sent).toEqual([]);
    // The editor stays open with what was typed.
    expect(screen.getByTestId('mcp-editor-name')).toHaveValue(name);
  });

  it('refuses a server with no command, and a malformed environment line', async () => {
    const { sent } = fakeWs();
    reportServers([]);
    await openPage();
    fireEvent.click(screen.getByTestId('mcp-add'));
    fill('mcp-editor-name', 'thing');
    fireEvent.click(screen.getByTestId('mcp-editor-save'));
    expect(screen.getByTestId('mcp-editor-error')).toHaveTextContent('Command is required');
    fill('mcp-editor-command', 'npx thing');
    fill('mcp-editor-env', 'JUSTAKEY');
    fireEvent.click(screen.getByTestId('mcp-editor-save'));
    expect(screen.getByTestId('mcp-editor-error')).toHaveTextContent(
      'Environment line "JUSTAKEY" is not KEY=VALUE',
    );
    expect(sent).toEqual([]);
  });

  it('clicking a server opens it for editing, and Save sends the edited list', async () => {
    const { sent } = fakeWs();
    reportServers([PLAYWRIGHT, DEVTOOLS]);
    await openPage();
    fireEvent.click(
      within(screen.getByTestId('mcp-server-chrome-devtools')).getByRole('button', {
        name: /chrome-devtools/,
      }),
    );
    expect(screen.getByTestId('mcp-editor-name')).toHaveValue('chrome-devtools');
    expect(screen.getByTestId('mcp-editor-command')).toHaveValue('npx chrome-devtools-mcp');
    expect(screen.getByTestId('mcp-editor-env')).toHaveValue('DEBUG=1');
    fill('mcp-editor-command', 'npx chrome-devtools-mcp --isolated');
    fireEvent.click(screen.getByTestId('mcp-editor-save'));
    expect(sent).toEqual([
      {
        type: 'host.settings',
        daemonId: 'd1',
        // Same place in the list, same on/off.
        harnessMcpServers: [
          PLAYWRIGHT,
          { ...DEVTOOLS, args: ['chrome-devtools-mcp', '--isolated'] },
        ],
      },
    ]);
    expect(screen.queryByTestId('mcp-editor')).toBeNull();
  });

  it('renaming one server onto another’s name is refused', async () => {
    const { sent } = fakeWs();
    reportServers([PLAYWRIGHT, DEVTOOLS]);
    await openPage();
    fireEvent.click(
      within(screen.getByTestId('mcp-server-chrome-devtools')).getByRole('button', {
        name: /chrome-devtools/,
      }),
    );
    fill('mcp-editor-name', 'playwright');
    fireEvent.click(screen.getByTestId('mcp-editor-save'));
    expect(screen.getByTestId('mcp-editor-error')).toHaveTextContent(
      'MCP server names must be unique',
    );
    expect(sent).toEqual([]);
  });

  it('Remove asks first; cancelling keeps it, confirming sends the list without it', async () => {
    const { sent } = fakeWs();
    reportServers([PLAYWRIGHT, DEVTOOLS]);
    await openPage();
    fireEvent.click(
      within(screen.getByTestId('mcp-server-playwright')).getByRole('button', {
        name: /playwright/,
      }),
    );
    fireEvent.click(screen.getByTestId('mcp-editor-remove'));
    expect(await screen.findByTestId('confirm-modal')).toHaveTextContent(
      'Remove the playwright MCP server from mac?',
    );
    fireEvent.click(screen.getByTestId('confirm-cancel'));
    await act(async () => {});
    expect(sent).toEqual([]);
    expect(screen.getByTestId('mcp-editor')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('mcp-editor-remove'));
    fireEvent.click(await screen.findByTestId('confirm-ok'));
    await waitFor(() =>
      expect(sent).toEqual([
        { type: 'host.settings', daemonId: 'd1', harnessMcpServers: [DEVTOOLS] },
      ]),
    );
    await waitFor(() => expect(screen.queryByTestId('mcp-editor')).toBeNull());
  });

  it('an edit aimed at an offline host is refused, naming it, and the editor stays open', async () => {
    const { sent } = fakeWs();
    reportServers([PLAYWRIGHT]);
    usePresenceStore.getState().setHostOnline('d1', false);
    await openPage();
    fireEvent.click(screen.getByTestId('mcp-server-playwright-enabled'));
    fireEvent.click(screen.getByTestId('mcp-add'));
    fill('mcp-editor-name', 'thing');
    fill('mcp-editor-command', 'npx thing');
    fireEvent.click(screen.getByTestId('mcp-editor-save'));
    expect(sent).toEqual([]);
    expect(screen.getByTestId('mcp-editor')).toBeInTheDocument();
    // The refusal is the toast; the form does not repeat it as its own error.
    expect(screen.queryByTestId('mcp-editor-error')).toBeNull();
    await waitFor(() =>
      expect(errors().filter((e) => /mac is offline/.test(e)).length).toBeGreaterThanOrEqual(1),
    );
  });
});

describe('MCP helpers', () => {
  it('splits a command line on spaces, keeping quoted words whole', () => {
    expect(splitCommandLine(`npx -y "@scope/pkg name" 'a b' c`)).toEqual([
      'npx',
      '-y',
      '@scope/pkg name',
      'a b',
      'c',
    ]);
    expect(splitCommandLine('   ')).toEqual([]);
  });

  it('joins it back, quoting any word with a space or nothing in it', () => {
    expect(joinCommandLine(['node', '/opt/my tools/x.js', ''])).toBe(
      'node "/opt/my tools/x.js" ""',
    );
    expect(splitCommandLine(joinCommandLine(['a b', 'c']))).toEqual(['a b', 'c']);
  });

  it('parses KEY=VALUE lines, and round-trips them', () => {
    expect(parseEnvLines('A=1\nB = two=2\n')).toEqual({ env: { A: '1', B: ' two=2' } });
    expect(parseEnvLines('=nokey')).toEqual({
      error: 'Environment line "=nokey" is not KEY=VALUE',
    });
    expect(envToLines({ A: '1', B: '2' })).toBe('A=1\nB=2');
  });

  it('checks a list against the wire schema', () => {
    expect(mcpListProblem([PLAYWRIGHT, DEVTOOLS])).toBeNull();
    expect(mcpListProblem([{ ...PLAYWRIGHT, name: 'x'.repeat(65) }])).toBe(
      'Name may only use letters, digits, - and _ (at most 64)',
    );
  });
});
