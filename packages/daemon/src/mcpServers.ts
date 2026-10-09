// The MCP servers a host wires into every chat it runs, beside Patch's own
// tools server (spec/14 § Agent behavior — Settings → MCP).
//
// The list is per host, persisted in `host.json` (`harnessMcpServers`), and
// replaced whole by `host.settings`. Only the ENABLED entries reach a chat: the
// Claude SDK's `mcpServers` option (`sdkBackend.ts` `buildSdkEnv`) and Codex's
// `config.mcp_servers` (`codexBackend.ts`), each after `patch`, which is always
// on and is never in this list.
//
// It replaced a single "Browser tools" toggle that wired a hard-coded
// `playwright` + `chrome-devtools` pair. A host that predates the list is seeded
// with exactly that pair, enabled as the toggle was, so upgrading changes
// nothing a chat can do. The toggle itself still works for surfaces that have
// not caught up: setting it flips those two entries, and it reads true only
// when both are present and on.

import type { McpServerConfig } from '@patch/wire';

/** The two servers the retired Browser tools toggle stood for, by name. */
export const BROWSER_MCP_SERVER_NAMES = ['playwright', 'chrome-devtools'] as const;

/** The list a host gets when it has never had one: the old toggle's pair. */
export function seedMcpServers(browserToolsEnabled: boolean): McpServerConfig[] {
  return [
    {
      name: 'playwright',
      command: 'npx',
      args: ['@playwright/mcp@latest', '--headless'],
      env: {},
      enabled: browserToolsEnabled,
    },
    {
      name: 'chrome-devtools',
      command: 'npx',
      args: ['-y', 'chrome-devtools-mcp@latest', '--headless'],
      env: {},
      enabled: browserToolsEnabled,
    },
  ];
}

/** The legacy toggle's reading: true only when both browser servers exist and are on. */
export function browserToolsEnabledOf(servers: readonly McpServerConfig[]): boolean {
  return BROWSER_MCP_SERVER_NAMES.every(
    (name) => servers.find((s) => s.name === name)?.enabled === true,
  );
}

/**
 * The legacy toggle's write: flip `enabled` on whichever browser servers the
 * list still has. One the user deleted stays deleted — the toggle is not a way
 * to bring it back.
 */
export function withBrowserToolsEnabled(
  servers: readonly McpServerConfig[],
  enabled: boolean,
): McpServerConfig[] {
  return servers.map((s) =>
    (BROWSER_MCP_SERVER_NAMES as readonly string[]).includes(s.name) ? { ...s, enabled } : s,
  );
}

/** What a chat actually gets: the enabled entries, in list order. */
export function enabledMcpServers(servers: readonly McpServerConfig[]): McpServerConfig[] {
  return servers.filter((s) => s.enabled);
}
