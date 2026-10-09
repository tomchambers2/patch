// Proven live (2026-09-18): an ordinary foreground `Bash` call — no
// `run_in_background` flag at all — ran past the SDK's own idle threshold and
// was silently auto-backgrounded by the harness, then died the same way
// `RUN_IN_BACKGROUND_TOOLS`'s explicit-flag check exists to prevent: orphaned,
// "no completion record", when this turn's process ended. That check only
// fires at the moment a tool is CALLED (sdkBackend.ts's `canUseTool`); this is
// the SDK converting an already-running foreground command to a background one
// partway through, which no `canUseTool` gate can see. Disabling the SDK's own
// auto-backgrounding via env (`buildSdkEnv`) closes that third path: a command
// either finishes in the foreground or the turn's own timeout/kill handles it
// loudly, never a silent handoff to bookkeeping the host can't track.
//
// Mirrors sdk-apikey-strip.test.ts's mock seam: query() is a spy, we drain the
// generator, and assert on the captured options.env.

import { describe, expect, it, vi } from 'vitest';

const queryCalls: Array<{ prompt: unknown; options: Record<string, unknown> }> = [];

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query(args: { prompt: unknown; options: Record<string, unknown> }) {
    queryCalls.push(args);
    return (async function* () {
      yield { type: 'result', subtype: 'success' };
    })();
  },
}));

describe('host disables the SDK auto-backgrounding (a third path into the run_in_background hole)', () => {
  it('sets CLAUDE_CODE_DISABLE_BACKGROUND_TASKS and CLAUDE_CODE_DISABLE_MCP_TASK_BACKGROUND', async () => {
    queryCalls.length = 0;
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
    const env = queryCalls[0]!.options.env as Record<string, string | undefined>;
    expect(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe('1');
    expect(env.CLAUDE_CODE_DISABLE_MCP_TASK_BACKGROUND).toBe('1');
  });
});
