// The web Tools panel (packages/web/src/lib/toolsCatalog.ts) is hand-written
// metadata over the tools the patch-tools MCP server really registers. It
// drifted: tools were missing, and a stale signature (patch_notify) listed
// params the tool does not take. Keep it honest against the live server.

import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildPatchToolsServer } from '../src/mcp.js';
import { TOOL_CATALOG, PATCH_MCP_PREFIX } from '../../web/src/lib/toolsCatalog.js';

async function liveTools() {
  const server = buildPatchToolsServer({
    daemonSocketPath: '/dev/null',
    chatId: 'test-chat',
    localKey: 'test-key',
  });
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([client.connect(c), server.connect(s)]);
  return (await client.listTools()).tools;
}

const catalogParams = (params: string): string[] =>
  params === '(no params)' ? [] : params.split(',').map((p) => p.trim().split(/[?:]/)[0]!);

describe('Tools panel catalog matches the live patch-tools server', () => {
  it('lists every registered tool, and nothing that is not registered', async () => {
    const live = (await liveTools()).map((t) => t.name).sort();
    const catalogued = TOOL_CATALOG.filter((t) => t.name.startsWith(PATCH_MCP_PREFIX))
      .map((t) => t.name.slice(PATCH_MCP_PREFIX.length))
      .sort();
    expect(catalogued).toEqual(live);
  });

  it('lists exactly the parameters each tool takes', async () => {
    const mismatches: string[] = [];
    for (const t of await liveTools()) {
      const entry = TOOL_CATALOG.find((e) => e.name === PATCH_MCP_PREFIX + t.name);
      if (!entry) continue;
      const want = Object.keys(t.inputSchema.properties ?? {}).sort();
      const got = catalogParams(entry.params).sort();
      if (JSON.stringify(want) !== JSON.stringify(got)) {
        mismatches.push(`${t.name}: catalog [${got}] vs live [${want}]`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});
