// An approved `ExitPlanMode` must put the process back on the chat's requested
// mode IN the approval itself (canUseTool's `updatedPermissions`), not after
// the tool_result has travelled through the consumer — otherwise the agent's
// next tool call can race the mode switch and ask for approval a second time.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryCalls: Array<{ prompt: unknown; options: Record<string, unknown> }> = [];

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query(args: { prompt: unknown; options: Record<string, unknown> }) {
    queryCalls.push(args);
    return (async function* () {
      yield { type: 'result', subtype: 'success' };
    })();
  },
}));

type Gate = (t: string, i: Record<string, unknown>, c: unknown) => Promise<Record<string, unknown>>;

async function gateFor(
  permissionMode: 'bypassPermissions' | 'plan',
  approve: boolean,
): Promise<Gate> {
  queryCalls.length = 0;
  const { createRealSdkBackend } = await import('../src/sdkBackend.js');
  for await (const _m of createRealSdkBackend().run({
    prompt: 'hi',
    cwd: '/tmp',
    abortController: new AbortController(),
    oauthAccessToken: 'tok',
    permissionMode,
    onPermissionRequest: async () => ({ approve }),
  })) {
    void _m;
  }
  return queryCalls[0]!.options['canUseTool'] as Gate;
}

describe('ExitPlanMode approval carries the mode switch', () => {
  beforeEach(() => {
    queryCalls.length = 0;
  });

  it('approved → allow with setMode(requested mode)', async () => {
    const gate = await gateFor('bypassPermissions', true);
    const r = await gate('ExitPlanMode', {}, {});
    expect(r['behavior']).toBe('allow');
    expect(r['updatedPermissions']).toEqual([
      { type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
    ]);
  });

  it('denied → no mode change', async () => {
    const gate = await gateFor('bypassPermissions', false);
    const r = await gate('ExitPlanMode', {}, {});
    expect(r['behavior']).toBe('deny');
    expect(r['updatedPermissions']).toBeUndefined();
  });

  it('chat requested plan → stays in plan', async () => {
    const gate = await gateFor('plan', true);
    const r = await gate('ExitPlanMode', {}, {});
    expect(r['updatedPermissions']).toBeUndefined();
  });

  it('other tools are untouched', async () => {
    const gate = await gateFor('bypassPermissions', true);
    const r = await gate('Bash', { command: 'ls' }, {});
    expect(r['updatedPermissions']).toBeUndefined();
  });
});
