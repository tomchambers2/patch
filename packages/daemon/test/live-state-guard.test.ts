// A test must never create state in the machine's own Patch directory. This
// covers the guard that enforces that, so it is proven without needing the
// live Claude credential the real-SDK suite is gated on.

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertIsolatedPath,
  assertNoLiveChatsCreated,
  assertToolsServerBuilt,
  liveChatIds,
  livePatchHome,
} from './helpers/live-state.js';

/** Every temp dir this file makes, removed in teardown — the rule it enforces. */
const tempDirs: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** A stand-in for the machine's own ~/.patch, with a chats/ store inside it. */
function fakeLiveHome(): { home: string; env: NodeJS.ProcessEnv } {
  const home = tmp('live-state-guard-home-');
  mkdirSync(join(home, 'chats'), { recursive: true });
  return { home, env: { PATCH_HOME: home } };
}

function seedLiveChat(home: string, chatId: string, folder: string): void {
  const dir = join(home, 'chats', chatId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ chatId, folder, name: null }));
}

describe('livePatchHome', () => {
  it('is ~/.patch by default', () => {
    expect(livePatchHome({})).toBe(join(homedir(), '.patch'));
  });

  it('honours the PATCH_HOME override', () => {
    expect(livePatchHome({ PATCH_HOME: '/somewhere/else' })).toBe('/somewhere/else');
  });
});

describe('assertIsolatedPath', () => {
  it('rejects the live patch home itself, naming the path it was about to touch', () => {
    const { home, env } = fakeLiveHome();
    expect(() => assertIsolatedPath('socket', home, env)).toThrow(home);
  });

  it('rejects a path INSIDE the live patch home', () => {
    const { home, env } = fakeLiveHome();
    expect(() => assertIsolatedPath('socket', join(home, 'daemon.sock'), env)).toThrow(
      /live Patch state/,
    );
  });

  it('names the label so the failure says which path was wrong', () => {
    const { home, env } = fakeLiveHome();
    expect(() => assertIsolatedPath('host socket', join(home, 'daemon.sock'), env)).toThrow(
      /host socket/,
    );
  });

  it('accepts a path outside it', () => {
    const { env } = fakeLiveHome();
    expect(() => assertIsolatedPath('socket', tmp('isolated-'), env)).not.toThrow();
  });

  it('does not treat a sibling with the same prefix as inside', () => {
    const { home, env } = fakeLiveHome();
    expect(() => assertIsolatedPath('socket', `${home}-other`, env)).not.toThrow();
  });
});

// The observed leak: with no built MCP server the session had no patch_ tools,
// and the agent ran `patch chats spawn <tmpdir>` over Bash instead, which hit
// the machine's own host and created a real chat there.
describe('assertToolsServerBuilt', () => {
  it('rejects a missing server, naming the path', () => {
    const missing = join(tmp('tools-server-'), 'patch-tools-server.js');
    expect(() => assertToolsServerBuilt(missing)).toThrow(missing);
  });

  it('says how to build it, so the failure is actionable', () => {
    const missing = join(tmp('tools-server-'), 'patch-tools-server.js');
    expect(() => assertToolsServerBuilt(missing)).toThrow(/--filter @patch\/daemon build/);
  });

  it('accepts a server that exists', () => {
    const built = join(tmp('tools-server-'), 'patch-tools-server.js');
    writeFileSync(built, '');
    expect(() => assertToolsServerBuilt(built)).not.toThrow();
  });
});

describe('liveChatIds', () => {
  it('lists the chat ids in the machine store', () => {
    const { home, env } = fakeLiveHome();
    seedLiveChat(home, 'chat-a', '/tmp/a');
    seedLiveChat(home, 'chat-b', '/tmp/b');
    expect(liveChatIds(env)).toEqual(new Set(['chat-a', 'chat-b']));
  });

  it('is empty when the machine has no chat store at all', () => {
    expect(liveChatIds({ PATCH_HOME: join(tmpdir(), 'live-state-guard-absent') })).toEqual(
      new Set(),
    );
  });
});

describe('assertNoLiveChatsCreated', () => {
  it('fails, naming chat id and folder, when a chat landed in the live store', () => {
    const { home, env } = fakeLiveHome();
    const owned = tmp('patch-mcp-real-spawned-');
    const before = liveChatIds(env);
    seedLiveChat(home, 'leaked-1', owned);

    expect(() => assertNoLiveChatsCreated(before, [owned], env)).toThrow(/leaked-1/);
    expect(() => assertNoLiveChatsCreated(before, [owned], env)).toThrow(owned);
  });

  it('passes when the live store did not change', () => {
    const { home, env } = fakeLiveHome();
    seedLiveChat(home, 'pre-existing', '/home/someone/project');
    const before = liveChatIds(env);
    expect(() => assertNoLiveChatsCreated(before, [tmp('owned-')], env)).not.toThrow();
  });

  // The live host keeps running while the suite does; a chat the user opens
  // mid-run must not be blamed on the test.
  it('ignores a new chat that is not in a folder this test owns', () => {
    const { home, env } = fakeLiveHome();
    const before = liveChatIds(env);
    seedLiveChat(home, 'someone-elses', '/home/someone/unrelated');
    expect(() => assertNoLiveChatsCreated(before, [tmp('owned-')], env)).not.toThrow();
  });

  it('catches a chat in a SUBDIRECTORY of an owned folder', () => {
    const { home, env } = fakeLiveHome();
    const owned = tmp('patch-mcp-real-spawned-');
    const before = liveChatIds(env);
    seedLiveChat(home, 'leaked-nested', join(owned, 'nested'));
    expect(() => assertNoLiveChatsCreated(before, [owned], env)).toThrow(/leaked-nested/);
  });

  it('still reports a leaked chat whose meta.json is unreadable', () => {
    const { home, env } = fakeLiveHome();
    const owned = tmp('patch-mcp-real-spawned-');
    const before = liveChatIds(env);
    // Owned-folder membership is unknown without meta, so an unreadable chat is
    // reported rather than assumed innocent.
    mkdirSync(join(home, 'chats', 'no-meta'), { recursive: true });
    expect(() => assertNoLiveChatsCreated(before, [owned], env)).toThrow(/no-meta/);
  });
});

// The guard only helps if the suite that leaked actually calls it, and that
// suite cannot run without a live Claude login. Lock the wiring at the source
// instead. Matched against the raw source with anchored patterns rather than a
// brace-parsing helper, which mis-pairs blocks after a nested brace.
describe('the real-SDK suite is wired to the guard', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'mcp-tools-real-sdk.integration.test.ts'),
    'utf8',
  );

  it('imports the guards from the helper', () => {
    expect(source).toMatch(
      /import \{[^}]*assertIsolatedPath[^}]*assertNoLiveChatsCreated[^}]*\} from '\.\/helpers\/live-state\.js'/s,
    );
  });

  it('asserts the host home and control socket are isolated before booting', () => {
    expect(source).toMatch(/assertIsolatedPath\('host home', home\)/);
    expect(source).toMatch(/assertIsolatedPath\('control socket', socketPath\)/);
  });

  it('asserts every chat folder it creates is isolated', () => {
    expect(source).toMatch(/for \(const folder of ownedFolders\) assertIsolatedPath\(/);
  });

  it('refuses to boot when the MCP server is not built', () => {
    expect(source).toMatch(/assertToolsServerBuilt\(mcpBin\)/);
  });

  // Ordering matters: booting first would start a host whose session has no
  // patch tools, which is the exact state that sent the agent to the CLI.
  it('checks the MCP server is built BEFORE constructing the host', () => {
    expect(source.indexOf('assertToolsServerBuilt(mcpBin)')).toBeLessThan(
      source.indexOf('daemon = new Daemon('),
    );
  });

  it('removes the shell, so a toolless session cannot reach the patch CLI', () => {
    expect(source).toMatch(/const NO_ESCAPE_HATCH = \['Bash', 'Task'\]/);
    expect(source).toMatch(/disabledTools: NO_ESCAPE_HATCH/);
  });

  it('tells the agent to stop rather than substitute the CLI', () => {
    expect(source).toMatch(/never use the `patch` command line tool/);
    expect(source).toMatch(/UNAVAILABLE/);
  });

  it('snapshots the live chat store before the agent runs', () => {
    expect(source).toMatch(/liveChatsBefore = liveChatIds\(\)/);
  });

  it('reports leaked live chats in teardown', () => {
    expect(source).toMatch(/assertNoLiveChatsCreated\(liveChatsBefore, ownedFolders\)/);
  });

  // Teardown alone is not enough: closing the real UDS control app can outrun
  // vitest's teardown timeout, which drops the report entirely.
  it('checks for leaked live chats inside the test body, before the side-effect assertions', () => {
    const body = source.slice(source.indexOf("it('a real chat agent calls"));
    const checkAt = body.indexOf('assertNoLiveChatsCreated(liveChatsBefore!, ownedFolders)');
    const firstSideEffectAt = body.indexOf('const list = daemon.list()');
    expect(checkAt).toBeGreaterThan(-1);
    expect(checkAt).toBeLessThan(firstSideEffectAt);
  });

  it('removes every temp dir it created, before reporting', () => {
    const teardown = source.slice(source.indexOf('afterAll('));
    const rmAt = teardown.indexOf('rmSync(dir');
    const reportAt = teardown.indexOf('assertNoLiveChatsCreated');
    expect(rmAt).toBeGreaterThan(-1);
    // Cleanup has to precede the throwing check or a leak strands the temp dirs.
    expect(rmAt).toBeLessThan(reportAt);
  });

  it('creates no directory at module scope, so a skipped run litters nothing', () => {
    // Every mkdtemp goes through the recorded helper, which only beforeAll calls.
    const occurrences = source.match(/mkdtempSync\(/g) ?? [];
    expect(occurrences).toHaveLength(1);
    expect(source).toMatch(
      /function makeTempDir\(prefix: string\): string \{\n\s*const dir = mkdtempSync\(/,
    );
  });
});
