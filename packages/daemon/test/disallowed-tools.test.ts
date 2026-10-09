// principles.md § Tool ownership: the host must REMOVE inert native Claude
// Code tools from the model's context. The `Cron*` family is dead in the
// host's SDK runtime (no resident process to fire an in-session cron) and is a
// trap if left visible — the model would "schedule" a reminder that never fires.
// Patch owns durable scheduling via patch_wake_me / patch_job_*, and subagents
// via patch_spawn, so the native Agent/Task/Workflow tools are removed too.
//
// Inspects the actual options passed to the SDK query() (same mock seam as
// sdk-apikey-strip / no-system-prompt-injection).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const queryCalls: Array<{ prompt: unknown; options: Record<string, unknown> }> = [];

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query(args: { prompt: unknown; options: Record<string, unknown> }) {
    queryCalls.push(args);
    return (async function* () {
      yield { type: 'result', subtype: 'success' };
    })();
  },
}));

describe('host disallows inert native tools (principles § Tool ownership)', () => {
  beforeEach(() => {
    queryCalls.length = 0;
  });
  afterEach(() => {
    queryCalls.length = 0;
  });

  it('passes the inert native tools and native subagent tools as disallowedTools to query()', async () => {
    const { createRealSdkBackend } = await import('../src/sdkBackend.js');
    const backend = createRealSdkBackend();
    const ac = new AbortController();
    const drained: unknown[] = [];
    for await (const msg of backend.run({
      prompt: 'hello',
      cwd: '/tmp',
      abortController: ac,
      oauthAccessToken: 'tok',
    })) {
      drained.push(msg);
    }
    expect(drained.length).toBeGreaterThan(0);
    expect(queryCalls).toHaveLength(1);

    const disallowed = queryCalls[0]!.options.disallowedTools as string[];
    expect(Array.isArray(disallowed)).toBe(true);
    for (const t of [
      'Agent',
      'Task',
      'Workflow',
      'CronCreate',
      'CronList',
      'CronDelete',
      'SendMessage',
      'ListAgents',
      'ScheduleWakeup',
      'Monitor',
      'TaskStop',
      'PushNotification',
    ]) {
      expect(disallowed).toContain(t);
    }
    // Sanity: we did NOT nuke the coding loop, or Bash wholesale — only its
    // `run_in_background` flag is gated, separately, via canUseTool.
    expect(disallowed).not.toContain('Edit');
    expect(disallowed).not.toContain('Bash');
  });

  it('merges per-chat disabledTools into disallowedTools (todo: turn tools on/off)', async () => {
    const { createRealSdkBackend } = await import('../src/sdkBackend.js');
    const backend = createRealSdkBackend();
    const ac = new AbortController();
    for await (const _msg of backend.run({
      prompt: 'hello',
      cwd: '/tmp',
      abortController: ac,
      oauthAccessToken: 'tok',
      disabledTools: ['Bash', 'mcp__patch__patch_spawn'],
    })) {
      void _msg;
    }
    const disallowed = queryCalls[0]!.options.disallowedTools as string[];
    // The user's OFF tools are added ON TOP of the always-inert Cron family.
    expect(disallowed).toContain('Bash');
    expect(disallowed).toContain('mcp__patch__patch_spawn');
    expect(disallowed).toContain('CronCreate');
  });

  it('leaves disallowedTools untouched when no disabledTools are set', async () => {
    const { createRealSdkBackend } = await import('../src/sdkBackend.js');
    const backend = createRealSdkBackend();
    const ac = new AbortController();
    for await (const _msg of backend.run({
      prompt: 'hello',
      cwd: '/tmp',
      abortController: ac,
      oauthAccessToken: 'tok',
    })) {
      void _msg;
    }
    const disallowed = queryCalls[0]!.options.disallowedTools as string[];
    expect(disallowed).not.toContain('Bash');
    expect(disallowed).toEqual([
      'Agent',
      'Task',
      'Workflow',
      'CronCreate',
      'CronList',
      'CronDelete',
      'SendMessage',
      'ListAgents',
      'ScheduleWakeup',
      'Monitor',
      'TaskStop',
      'PushNotification',
    ]);
  });
});

describe('host denies native run_in_background in favour of patch_watch', () => {
  beforeEach(() => {
    queryCalls.length = 0;
  });
  afterEach(() => {
    queryCalls.length = 0;
  });

  async function capturedCanUseTool(): Promise<
    (toolName: string, input: Record<string, unknown>, ctx: unknown) => Promise<unknown>
  > {
    const { createRealSdkBackend } = await import('../src/sdkBackend.js');
    const backend = createRealSdkBackend();
    const ac = new AbortController();
    for await (const _msg of backend.run({
      prompt: 'hello',
      cwd: '/tmp',
      abortController: ac,
      oauthAccessToken: 'tok',
      onPermissionRequest: async () => ({ approve: true }),
    })) {
      void _msg;
    }
    const canUseTool = queryCalls[0]!.options['canUseTool'] as (
      toolName: string,
      input: Record<string, unknown>,
      ctx: unknown,
    ) => Promise<unknown>;
    expect(typeof canUseTool).toBe('function');
    return canUseTool;
  }

  it('denies Bash with run_in_background:true, pointing at patch_watch', async () => {
    const canUseTool = await capturedCanUseTool();
    const result = (await canUseTool(
      'Bash',
      { command: 'sleep 100', run_in_background: true },
      {},
    )) as {
      behavior: string;
      message: string;
    };
    expect(result.behavior).toBe('deny');
    expect(result.message).toMatch(/patch_watch/);
  });

  it('leaves an ordinary Bash call (no run_in_background) to the normal permission gate', async () => {
    const canUseTool = await capturedCanUseTool();
    const result = (await canUseTool('Bash', { command: 'echo hi' }, {})) as {
      behavior: string;
    };
    // onPermissionRequest was stubbed to always approve.
    expect(result.behavior).toBe('allow');
  });

  it('leaves Bash with run_in_background:false alone', async () => {
    const canUseTool = await capturedCanUseTool();
    const result = (await canUseTool(
      'Bash',
      { command: 'echo hi', run_in_background: false },
      {},
    )) as { behavior: string };
    expect(result.behavior).toBe('allow');
  });

  // An exact match, not just a substring check, so any future edit to the
  // message fails this test rather than passing by accident.
  it("Bash's deny message is the exact original text", async () => {
    const canUseTool = await capturedCanUseTool();
    const result = (await canUseTool(
      'Bash',
      { command: 'sleep 100', run_in_background: true },
      {},
    )) as { behavior: string; message: string };
    expect(result.behavior).toBe('deny');
    expect(result.message).toBe(
      "Bash's run_in_background is disabled. The SDK spawns that process INSIDE its own process " +
        'tree, so the host never gets a real pid for it — only an inherited output file it can ' +
        "find indirectly (via lsof) — which means it can't be killed reliably and can't survive a " +
        'host restart (backgroundTaskStats.ts). Use patch_watch(command, description) instead: the ' +
        'host spawns it directly, holds a real pid, can kill it outright, re-attaches to it across a ' +
        'restart, and delivers a message into this chat when it finishes.',
    );
  });
});
