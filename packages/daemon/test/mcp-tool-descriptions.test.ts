// Quality bar for what the model reads about each patch_* tool: the tool
// description plus every parameter's schema description. Found by the review
// of all tool descriptions — spec section pointers (meaningless to an agent,
// which cannot open spec/), and parameters whose meaning the model had to guess.

import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildPatchToolsServer } from '../src/mcp.js';

async function listTools() {
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

// Parameters whose name alone says everything.
const SELF_EXPLANATORY = new Set([
  'url',
  'path',
  'text',
  'title',
  'name',
  'prompt',
  'model',
  'message',
]);

describe('patch tool descriptions', () => {
  it('every tool has a description', async () => {
    const bad = (await listTools()).filter((t) => (t.description ?? '').trim().length < 20);
    expect(bad.map((t) => t.name)).toEqual([]);
  });

  it('never points the agent at spec/ files it cannot read', async () => {
    const tools = await listTools();
    const offenders = tools
      .filter((t) => JSON.stringify([t.description, t.inputSchema]).includes('spec/'))
      .map((t) => t.name);
    expect(offenders).toEqual([]);
  });

  it('every parameter is explained — by its own description, by name in the tool description, or by being self-evident', async () => {
    const offenders: string[] = [];
    for (const t of await listTools()) {
      const props = (t.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
      for (const [param, schema] of Object.entries(props)) {
        if (schema.description) continue;
        if (SELF_EXPLANATORY.has(param)) continue;
        if ((t.description ?? '').includes(param)) continue;
        offenders.push(`${t.name}.${param}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
