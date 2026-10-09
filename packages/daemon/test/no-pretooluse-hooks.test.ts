// The port-lock barrier has been removed. It was a PreToolUse hook that denied
// any port-altering Bash command unless the agent held a `ports` lock — but the
// lock was unacquirable in practice (surface JWT only, no CLI, no UI), and the
// barrier defaulted to deny, so it blocked port commands permanently and
// false-positived on unrelated commands containing a launcher's name.
//
// It was the ONLY hook the host installed, so the correct end state is that
// the SDK query is spawned with no `hooks` option at all — on BOTH spawn paths
// (one-shot and the warm persistent session). These tests pin that.

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

async function drain(gen: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of gen) void _;
}

describe('host installs no PreToolUse hooks', () => {
  beforeEach(() => {
    queryCalls.length = 0;
  });
  afterEach(() => {
    queryCalls.length = 0;
  });

  it('spawns a one-shot query with no hooks option', async () => {
    const { createRealSdkBackend } = await import('../src/sdkBackend.js');
    const backend = createRealSdkBackend();
    await drain(
      backend.run({
        prompt: 'hello',
        cwd: '/work/project-a',
        abortController: new AbortController(),
        oauthAccessToken: 'tok',
      }),
    );

    expect(queryCalls).toHaveLength(1);
    expect(queryCalls[0]!.options.hooks).toBeUndefined();
    expect(Object.keys(queryCalls[0]!.options)).not.toContain('hooks');
  });

  it('spawns a persistent-session query with no hooks option', async () => {
    const { createRealSdkBackend } = await import('../src/sdkBackend.js');
    const backend = createRealSdkBackend();
    await drain(
      backend.run({
        prompt: 'hello',
        cwd: '/work/project-persist',
        abortController: new AbortController(),
        oauthAccessToken: 'tok',
        chatId: 'chat-persist-1',
      }),
    );

    expect(queryCalls).toHaveLength(1);
    expect(queryCalls[0]!.options.hooks).toBeUndefined();
    expect(Object.keys(queryCalls[0]!.options)).not.toContain('hooks');
  });
});
