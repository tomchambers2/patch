// What the AGENT sees when a spawn fails (spec/03 § Cross-chat tools).
//
// The live defect ended here: `mcp__patch__patch_spawn` returned
// `{"host":"host-logged-out","created":"remote"}` for a spawn the target had
// refused. The tool result IS the agent's only view, so it has to carry the
// failure — named machine, real reason — not a success shape.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Daemon } from '../src/chatRunner.js';
import { buildControl, RemoteSpawnError } from '../src/control.js';
import { MemoryJobsStore } from '../src/jobs-interface.js';
import { createMetaStore } from '../src/meta.js';
import { buildPatchToolsServer } from '../src/mcp.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';

const LOCAL_KEY = 'test-local-key';
const silent = pino({ level: 'silent' });

interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
}

describe('patch_spawn as the agent sees it', () => {
  const home = mkdtempSync(join(tmpdir(), 'patch-mcp-spawn-err-'));
  const folder = mkdtempSync(join(tmpdir(), 'patch-mcp-spawn-folder-'));
  mkdirSync(folder, { recursive: true });
  const socketPath = join(home, 'daemon.sock');
  const daemon = new Daemon({
    daemonId: 'host-a',
    metaStore: createMetaStore(home),
    sdkBackend: createMockSdkBackend(),
    oauthAccessToken: 'tok',
    emit: () => undefined,
    logger: silent,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let client: any;

  beforeAll(async () => {
    app = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs: new MemoryJobsStore(),
      isHostOnline: () => true,
      spawnOnRemoteHost: async (req) => {
        if (req.host === 'host-logged-out') {
          throw new RemoteSpawnError(
            'no_model_catalogue',
            `patch_spawn: machine ${req.host} refused: machine ${req.host} has never read a model catalogue, so it has no last-used model`,
          );
        }
        return { chatId: 'chat-on-b' };
      },
    });
    await app.listen({ path: socketPath });
    const server = buildPatchToolsServer({
      daemonSocketPath: socketPath,
      chatId: 'caller-1',
      localKey: LOCAL_KEY,
    });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
  });

  afterAll(async () => {
    await client?.close();
    await app?.close();
  });

  it('a refused cross-machine spawn is a tool ERROR naming the machine and the reason', async () => {
    const res = (await client.callTool({
      name: 'patch_spawn',
      arguments: { folder, host: 'host-logged-out' },
    })) as ToolResult;
    expect(res.isError).toBe(true);
    const text = res.content.map((c) => c.text).join('\n');
    expect(text).toContain('host-logged-out');
    expect(text).toContain('no chat was created');
    expect(text).toContain('never read a model catalogue');
    // The old silent-success shape must be gone.
    expect(text).not.toContain('"created":"remote"');
  });

  it('a successful cross-machine spawn still returns the chat it made', async () => {
    const res = (await client.callTool({
      name: 'patch_spawn',
      arguments: { folder, host: 'host-b' },
    })) as ToolResult;
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0]!.text)).toMatchObject({
      host: 'host-b',
      created: 'remote',
      chatId: 'chat-on-b',
    });
  });

  it('a same-machine spawn returns the new chatId (short-circuit, no host named)', async () => {
    const res = (await client.callTool({
      name: 'patch_spawn',
      arguments: { folder },
    })) as ToolResult;
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.content[0]!.text) as { chatId: string; host: string };
    expect(body.host).toBe('host-a');
    expect(daemon.chatState.has(body.chatId)).toBe(true);
  });

  it('a local spawn into a folder that does not exist is an error, not a fake chat', async () => {
    const res = (await client.callTool({
      name: 'patch_spawn',
      arguments: { folder: '/no/such-folder-99' },
    })) as ToolResult;
    expect(res.isError).toBe(true);
    const text = res.content.map((c) => c.text).join('\n');
    expect(text).toContain('no chat was created');
    expect(text).toContain('/no/such-folder-99');
  });
});
