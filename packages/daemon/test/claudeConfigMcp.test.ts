// claudeConfigMcp.ts: the MCP servers Claude Code's own config already names
// for a chat's folder, read (never written) from the same files the `claude`
// CLI itself reads.

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverClaudeMcpServers } from '../src/claudeConfigMcp.js';

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), 'claude-config-mcp-test-'));
}

function writeSettings(home: string, mcpServers: unknown): void {
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ mcpServers }));
}

function writeClaudeJson(home: string, contents: unknown): void {
  writeFileSync(join(home, '.claude.json'), JSON.stringify(contents));
}

describe('discoverClaudeMcpServers', () => {
  it('is empty for a home with no Claude config at all', () => {
    const home = makeHome();
    expect(discoverClaudeMcpServers('/wherever', home)).toEqual([]);
  });

  it('picks up a stdio server from ~/.claude/settings.json', () => {
    const home = makeHome();
    writeSettings(home, {
      playwright: { type: 'stdio', command: 'npx', args: ['@playwright/mcp@latest', '--headless'] },
      'chrome-devtools': {
        type: 'stdio',
        command: 'npx',
        args: ['-y', 'chrome-devtools-mcp@latest'],
      },
    });
    const servers = discoverClaudeMcpServers('/wherever', home);
    expect(servers.map((s) => s.name).sort()).toEqual(['chrome-devtools', 'playwright']);
    const playwright = servers.find((s) => s.name === 'playwright')!;
    expect(playwright).toEqual({
      name: 'playwright',
      command: 'npx',
      args: ['@playwright/mcp@latest', '--headless'],
      env: {},
      enabled: true,
    });
  });

  it('picks up a global server from ~/.claude.json, overriding settings.json on a name clash', () => {
    const home = makeHome();
    writeSettings(home, { mine: { command: 'from-settings', args: [], env: {} } });
    writeClaudeJson(home, {
      mcpServers: { mine: { command: 'from-claude-json', args: [], env: {} } },
    });
    const servers = discoverClaudeMcpServers('/wherever', home);
    expect(servers).toEqual([
      { name: 'mine', command: 'from-claude-json', args: [], env: {}, enabled: true },
    ]);
  });

  it('picks up a project-local server keyed by folder, overriding the global one', () => {
    const home = makeHome();
    writeClaudeJson(home, {
      mcpServers: { mine: { command: 'global', args: [], env: {} } },
      projects: {
        '/my/project': { mcpServers: { mine: { command: 'project-local', args: [], env: {} } } },
      },
    });
    expect(discoverClaudeMcpServers('/my/project', home)).toEqual([
      { name: 'mine', command: 'project-local', args: [], env: {}, enabled: true },
    ]);
    expect(discoverClaudeMcpServers('/some/other/project', home)).toEqual([
      { name: 'mine', command: 'global', args: [], env: {}, enabled: true },
    ]);
  });

  it('picks up .mcp.json entries only when the project has already trusted them', () => {
    const home = makeHome();
    const folder = mkdtempSync(join(tmpdir(), 'claude-config-mcp-project-'));
    writeFileSync(
      join(folder, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          trusted: { command: 'trusted-cmd', args: [], env: {} },
          untrusted: { command: 'untrusted-cmd', args: [], env: {} },
        },
      }),
    );
    writeClaudeJson(home, { projects: { [folder]: { enabledMcpjsonServers: ['trusted'] } } });
    expect(discoverClaudeMcpServers(folder, home)).toEqual([
      { name: 'trusted', command: 'trusted-cmd', args: [], env: {}, enabled: true },
    ]);
  });

  it('skips .mcp.json entirely when the project has never approved any of it', () => {
    const home = makeHome();
    const folder = mkdtempSync(join(tmpdir(), 'claude-config-mcp-project-'));
    writeFileSync(
      join(folder, '.mcp.json'),
      JSON.stringify({ mcpServers: { untrusted: { command: 'x', args: [], env: {} } } }),
    );
    expect(discoverClaudeMcpServers(folder, home)).toEqual([]);
  });

  it('drops a "patch"-named entry and one shaped without a command', () => {
    const home = makeHome();
    writeSettings(home, {
      patch: { command: 'should-be-ignored', args: [], env: {} },
      remote: { url: 'https://example.com/mcp' },
    });
    expect(discoverClaudeMcpServers('/wherever', home)).toEqual([]);
  });

  it('is empty rather than throwing when a config file is malformed JSON', () => {
    const home = makeHome();
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), '{ not json');
    writeFileSync(join(home, '.claude.json'), '{ also not json');
    expect(discoverClaudeMcpServers('/wherever', home)).toEqual([]);
  });
});
