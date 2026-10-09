// Settings → MCP: the command line and KEY=VALUE environment an MCP server is
// edited as, and the whole-list validation run before anything is sent
// (src/lib/mcpServers.ts).

import { describe, it, expect } from 'vitest';
import type { McpServerConfig } from '@patch/wire';
import {
  applyMcpDraft,
  commandLine,
  envText,
  parseEnvText,
  splitCommandLine,
} from '../src/lib/mcpServers';

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

describe('command lines', () => {
  it('joins a command and its args, quoting any that need it', () => {
    expect(commandLine(playwright)).toBe('npx @playwright/mcp --headless');
    expect(commandLine({ command: 'node', args: ['my server.js', '', 'a"b'] })).toBe(
      'node "my server.js" "" "a\\"b"',
    );
  });

  it('splits on whitespace, honouring quotes and backslashes', () => {
    expect(splitCommandLine('  npx   @playwright/mcp --headless ')).toEqual([
      'npx',
      '@playwright/mcp',
      '--headless',
    ]);
    expect(splitCommandLine(`node "my server.js" 'it''s' a\\ b ""`)).toEqual([
      'node',
      'my server.js',
      'its',
      'a b',
      '',
    ]);
    expect(splitCommandLine('echo "say \\"hi\\""')).toEqual(['echo', 'say "hi"']);
    expect(splitCommandLine('')).toEqual([]);
  });

  it('round-trips what it writes', () => {
    const s = { command: 'node', args: ['my server.js', '', 'a"b', "c'd", 'e\\f'] };
    const [command, ...args] = splitCommandLine(commandLine(s));
    expect({ command, args }).toEqual(s);
  });

  it('refuses an unclosed quote rather than guessing', () => {
    expect(() => splitCommandLine('node "oops')).toThrow(/Unclosed "/);
  });
});

describe('environment lines', () => {
  it('writes and reads KEY=VALUE, skipping blank lines, keeping = in values', () => {
    expect(envText({ A: '1', B: 'x=y' })).toBe('A=1\nB=x=y');
    expect(parseEnvText('A=1\n\n  B = x=y  \n')).toEqual({ A: '1', B: 'x=y' });
    expect(parseEnvText('')).toEqual({});
  });

  it('refuses a line that is not KEY=VALUE, or a key set twice', () => {
    expect(() => parseEnvText('A=1\nnonsense')).toThrow(/line 2/);
    expect(() => parseEnvText('=1')).toThrow(/line 1/);
    expect(() => parseEnvText('1A=2')).toThrow(/line 1/);
    expect(() => parseEnvText('A=1\nA=2')).toThrow(/A is set twice/);
  });
});

describe('applyMcpDraft', () => {
  it('adds a new server, enabled, at the end of the list', () => {
    const r = applyMcpDraft([playwright], null, {
      name: ' devtools ',
      commandLine: 'npx chrome-devtools-mcp --headless',
      envText: 'DEBUG=1',
    });
    expect(r).toEqual({
      ok: true,
      list: [
        playwright,
        {
          name: 'devtools',
          command: 'npx',
          args: ['chrome-devtools-mcp', '--headless'],
          env: { DEBUG: '1' },
          enabled: true,
        },
      ],
    });
  });

  it('replaces the named server in place, keeping its enabled state', () => {
    const r = applyMcpDraft([playwright, devtools], 'chrome-devtools', {
      name: 'devtools',
      commandLine: 'npx other',
      envText: '',
    });
    expect(r.ok && r.list).toEqual([
      playwright,
      { name: 'devtools', command: 'npx', args: ['other'], env: {}, enabled: false },
    ]);
  });

  it('refuses what the wire schema refuses, in words', () => {
    const draft = { commandLine: 'npx x', envText: '' };
    expect(applyMcpDraft([playwright], null, { ...draft, name: 'playwright' })).toEqual({
      ok: false,
      message: 'MCP server names must be unique',
    });
    expect(applyMcpDraft([], null, { ...draft, name: 'patch' })).toEqual({
      ok: false,
      message: 'Name: "patch" is reserved for Patch\'s own tools',
    });
    expect(applyMcpDraft([], null, { ...draft, name: 'has space' })).toEqual({
      ok: false,
      message: 'Name: Name may use only letters, digits, - and _',
    });
    expect(applyMcpDraft([], null, { ...draft, name: '' })).toMatchObject({ ok: false });
  });

  it('refuses an empty command, a bad command line, or bad environment', () => {
    expect(applyMcpDraft([], null, { name: 'a', commandLine: '  ', envText: '' })).toEqual({
      ok: false,
      message: 'A command is required',
    });
    expect(applyMcpDraft([], null, { name: 'a', commandLine: '"x', envText: '' })).toMatchObject({
      ok: false,
      message: expect.stringMatching(/Unclosed/),
    });
    expect(applyMcpDraft([], null, { name: 'a', commandLine: 'x', envText: 'bad' })).toMatchObject(
      { ok: false, message: expect.stringMatching(/not KEY=VALUE/) },
    );
  });
});
