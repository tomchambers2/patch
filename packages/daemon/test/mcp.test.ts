// MCP patch_peek round-trip:
//   1. Build a control HTTP listening on a UDS.
//   2. Seed chat_state with one chat.
//   3. Call peekViaUds → assert it returns the chat snapshot.
// We exercise the network round-trip from the MCP-child side without
// involving the full McpServer transport (that is tested upstream by the
// MCP SDK; here we own only the UDS shim).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { Daemon } from '../src/chatRunner.js';
import { buildControl } from '../src/control.js';
import { createMetaStore } from '../src/meta.js';
import { peekViaUds, udsRequest, runPatchToolsServerStdio } from '../src/mcp.js';

// The socket is gated as a whole (spec/02 § Control IPC): the MCP child
// presents the host's local key as a Bearer on every call.
const LOCAL_KEY = 'local-secret';
import { createMockSdkBackend } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });

describe('patch_peek over UDS', () => {
  it('returns chat_state snapshot for known chatId', async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-mcp-'));
    const folder = mkdtempSync(join(tmpdir(), 'patch-folder-'));
    mkdirSync(folder, { recursive: true });
    const sdk = createMockSdkBackend();
    sdk.enqueue([{ type: 'assistant', content: 'last msg', sessionId: 'S' }]);
    const daemon = new Daemon({
      daemonId: 'd1',
      metaStore: createMetaStore(home),
      sdkBackend: sdk,
      oauthAccessToken: 'tok',
      emit: () => undefined,
      logger: silent,
    });
    const chatId = await daemon.spawnChat({ folder, prompt: 'hi' });
    await new Promise((r) => setTimeout(r, 30));

    const app = await buildControl({ daemon, localKey: LOCAL_KEY });
    const socketPath = join(home, 'daemon.sock');
    await app.listen({ path: socketPath });
    try {
      const peek = await peekViaUds(socketPath, chatId, { localKey: LOCAL_KEY });
      // spec/06: { chat_state, events, truncated }
      expect(peek.chat_state.chatId).toBe(chatId);
      expect(peek.chat_state.activity).toBe('idle');
      expect(peek.chat_state.lastMessage).toBe('last msg');
      expect(Array.isArray(peek.events)).toBe(true);
      expect(typeof peek.truncated).toBe('boolean');
      // The chat produced an assistant message, so the wire stream has events.
      expect(peek.events.length).toBeGreaterThan(0);
      expect(peek.truncated).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('returns 404 when chatId unknown', async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-mcp-'));
    const sdk = createMockSdkBackend();
    const daemon = new Daemon({
      daemonId: 'd1',
      metaStore: createMetaStore(home),
      sdkBackend: sdk,
      oauthAccessToken: 'tok',
      emit: () => undefined,
      logger: silent,
    });
    const app = await buildControl({ daemon, localKey: LOCAL_KEY });
    const socketPath = join(home, 'daemon.sock');
    await app.listen({ path: socketPath });
    try {
      await expect(peekViaUds(socketPath, 'no-such-chat', { localKey: LOCAL_KEY })).rejects.toThrow(
        /404/,
      );
    } finally {
      await app.close();
    }
  });

  it('forwards opts.limit as a `?limit=` query param', async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-mcp-'));
    const folder = mkdtempSync(join(tmpdir(), 'patch-folder-'));
    mkdirSync(folder, { recursive: true });
    const sdk = createMockSdkBackend();
    const daemon = new Daemon({
      daemonId: 'd1',
      metaStore: createMetaStore(home),
      sdkBackend: sdk,
      oauthAccessToken: 'tok',
      emit: () => undefined,
      logger: silent,
    });
    const chatId = await daemon.spawnChat({ folder, prompt: 'hi' });
    await new Promise((r) => setTimeout(r, 30));
    const app = await buildControl({ daemon, localKey: LOCAL_KEY });
    const socketPath = join(home, 'daemon.sock');
    await app.listen({ path: socketPath });
    try {
      // Every other peekViaUds call in this file omits `opts` entirely,
      // covering only the `qs` empty side of the URL-building ternary.
      const peek = await peekViaUds(socketPath, chatId, { limit: 1, localKey: LOCAL_KEY });
      expect(peek.chat_state.chatId).toBe(chatId);
      expect(peek.events.length).toBeLessThanOrEqual(1);
    } finally {
      await app.close();
    }
  });
});

describe('udsRequest — raw UDS transport edge cases', () => {
  it('resolves undefined for a 200 with an empty body', async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-mcp-uds-'));
    const socketPath = join(home, 'raw.sock');
    const server = createServer((_req, res) => {
      res.writeHead(200);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const result = await udsRequest(socketPath, { method: 'GET', path: '/anything' });
      expect(result).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects with a clear message for a 200 with malformed JSON', async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-mcp-uds-'));
    const socketPath = join(home, 'raw.sock');
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{not valid json');
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      await expect(udsRequest(socketPath, { method: 'GET', path: '/anything' })).rejects.toThrow(
        /bad JSON from host/,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('runPatchToolsServerStdio', () => {
  const savedEnv: Record<string, string | undefined> = {
    PATCH_CHAT_ID: process.env['PATCH_CHAT_ID'],
    PATCH_DAEMON_SOCKET: process.env['PATCH_DAEMON_SOCKET'],
    PATCH_DAEMON_LOCAL_KEY: process.env['PATCH_DAEMON_LOCAL_KEY'],
  };

  beforeEach(() => {
    // The host always sets this for the children it starts; the individual
    // cases below override it to assert the missing-var failures.
    process.env['PATCH_DAEMON_LOCAL_KEY'] = LOCAL_KEY;
  });
  afterEach(() => {
    if (savedEnv['PATCH_DAEMON_LOCAL_KEY'] === undefined)
      delete process.env['PATCH_DAEMON_LOCAL_KEY'];
    else process.env['PATCH_DAEMON_LOCAL_KEY'] = savedEnv['PATCH_DAEMON_LOCAL_KEY'];
  });

  // A child with no key was not started by a host, and every call it made
  // would be refused. Failing here puts the reason where it is legible.
  it('throws when PATCH_DAEMON_LOCAL_KEY is missing (NO FALLBACK)', async () => {
    process.env['PATCH_CHAT_ID'] = 'some-chat';
    process.env['PATCH_DAEMON_SOCKET'] = '/tmp/does-not-matter.sock';
    delete process.env['PATCH_DAEMON_LOCAL_KEY'];
    await expect(runPatchToolsServerStdio()).rejects.toThrow(/PATCH_DAEMON_LOCAL_KEY/);
  });

  it('throws when PATCH_CHAT_ID is missing (NO FALLBACK)', async () => {
    delete process.env['PATCH_CHAT_ID'];
    process.env['PATCH_DAEMON_SOCKET'] = '/tmp/does-not-matter.sock';
    try {
      await expect(runPatchToolsServerStdio()).rejects.toThrow(/PATCH_CHAT_ID/);
    } finally {
      if (savedEnv['PATCH_CHAT_ID'] === undefined) delete process.env['PATCH_CHAT_ID'];
      else process.env['PATCH_CHAT_ID'] = savedEnv['PATCH_CHAT_ID'];
      if (savedEnv['PATCH_DAEMON_SOCKET'] === undefined) delete process.env['PATCH_DAEMON_SOCKET'];
      else process.env['PATCH_DAEMON_SOCKET'] = savedEnv['PATCH_DAEMON_SOCKET'];
    }
  });

  it('throws when PATCH_DAEMON_SOCKET is missing (NO FALLBACK)', async () => {
    process.env['PATCH_CHAT_ID'] = 'some-chat';
    delete process.env['PATCH_DAEMON_SOCKET'];
    try {
      await expect(runPatchToolsServerStdio()).rejects.toThrow(/PATCH_DAEMON_SOCKET/);
    } finally {
      if (savedEnv['PATCH_CHAT_ID'] === undefined) delete process.env['PATCH_CHAT_ID'];
      else process.env['PATCH_CHAT_ID'] = savedEnv['PATCH_CHAT_ID'];
      if (savedEnv['PATCH_DAEMON_SOCKET'] === undefined) delete process.env['PATCH_DAEMON_SOCKET'];
      else process.env['PATCH_DAEMON_SOCKET'] = savedEnv['PATCH_DAEMON_SOCKET'];
    }
  });

  it('builds the server and connects a stdio transport when both env vars are set', async () => {
    // Mock ONLY the stdio transport's `start`/`close`/send plumbing — real
    // stdin/stdout in a test process is not a pipe we want a live MCP server
    // parked on. `server.connect(transport)` just calls `transport.start()`
    // and wires message handlers; it does not block waiting for input, so a
    // minimal stub that resolves immediately is enough to prove the wiring
    // (env parsing -> buildPatchToolsServer -> new StdioServerTransport ->
    // server.connect) runs end-to-end without touching real process streams.
    const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
    const startSpy = vi
      .spyOn(StdioServerTransport.prototype, 'start')
      .mockImplementation(async () => undefined);
    const closeSpy = vi
      .spyOn(StdioServerTransport.prototype, 'close')
      .mockImplementation(async () => undefined);
    process.env['PATCH_CHAT_ID'] = 'chat-stdio-test';
    process.env['PATCH_DAEMON_SOCKET'] = '/tmp/patch-stdio-test.sock';
    try {
      await runPatchToolsServerStdio();
      expect(startSpy).toHaveBeenCalledTimes(1);
    } finally {
      startSpy.mockRestore();
      closeSpy.mockRestore();
      if (savedEnv['PATCH_CHAT_ID'] === undefined) delete process.env['PATCH_CHAT_ID'];
      else process.env['PATCH_CHAT_ID'] = savedEnv['PATCH_CHAT_ID'];
      if (savedEnv['PATCH_DAEMON_SOCKET'] === undefined) delete process.env['PATCH_DAEMON_SOCKET'];
      else process.env['PATCH_DAEMON_SOCKET'] = savedEnv['PATCH_DAEMON_SOCKET'];
    }
  });
});
