// Guards against the trap group 10 task A found (packages/daemon/src/mcp.ts,
// patch_spawn/patch_job_create/patch_watch): a patch_* tool description, or
// the patch-tools guidance prompt, naming a native tool the host disallows
// as the thing the agent should reach for. `disallowedTools` removes those
// names from the model's context entirely (`sdkBackend.ts` `disallowedToolsFor`),
// so a description that still says "use CronCreate instead" sends the agent
// looking for a tool it will never see.

import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildPatchToolsServer } from '../src/mcp.js';
import { DISALLOWED_NATIVE_TOOLS } from '../src/sdkBackend.js';
import { getPatchToolsPrompt } from '../src/toolsPrompt.js';

// A disallowed tool's exact, case-sensitive name standing alone as a word is
// always wrong here, full stop — there's no phrasing where naming it helps,
// since the agent will never see it in its own tool list to act on the
// advice. The one legitimate false match is a hyphenated compound that
// happens to share the word ("Agent-to-agent" in patch_send_to's own
// description, describing agent-to-agent delivery, nothing to do with the
// native `Agent` tool) — excluded by requiring a non-word, non-hyphen
// boundary on both sides.
function namesDeadTool(text: string, toolName: string): boolean {
  const pattern = new RegExp(`\\b${toolName}\\b`, 'g');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const before = text.charAt(match.index - 1);
    const after = text.charAt(match.index + toolName.length);
    if (before === '-' || after === '-') continue;
    return true;
  }
  return false;
}

describe('no patch tool or guidance names a disallowed native tool as something to use', () => {
  it('holds for every patch_* tool description', async () => {
    const server = buildPatchToolsServer({
      daemonSocketPath: '/dev/null',
      chatId: 'test-chat',
      localKey: 'test-key',
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const tool of tools) {
      for (const dead of DISALLOWED_NATIVE_TOOLS) {
        if (namesDeadTool(tool.description ?? '', dead)) {
          offenders.push(`${tool.name} names ${dead}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('holds for the patch-tools guidance prompt shown and editable in Settings', () => {
    const prompt = getPatchToolsPrompt();
    const offenders = DISALLOWED_NATIVE_TOOLS.filter((dead) => namesDeadTool(prompt, dead));
    expect(offenders).toEqual([]);
  });
});
