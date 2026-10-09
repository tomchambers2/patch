// A chat's own shell commands need to know which chat they are in: tools like
// `pad publish` deliver Tom's edits back into that chat. PATCH_CHAT_ID used
// to reach only the patch MCP child, never the Bash tool's environment.

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

async function envFor(chatId: string | undefined): Promise<Record<string, string | undefined>> {
  queryCalls.length = 0;
  const { createRealSdkBackend } = await import('../src/sdkBackend.js');
  const backend = createRealSdkBackend();
  for await (const _ of backend.run({
    prompt: 'hello',
    cwd: '/tmp',
    abortController: new AbortController(),
    oauthAccessToken: 'tok',
    ...(chatId !== undefined ? { chatId } : {}),
  })) {
    void _;
  }
  return queryCalls[0]!.options.env as Record<string, string | undefined>;
}

describe('the chat id reaches the chat’s own tools', () => {
  it('sets PATCH_CHAT_ID in the SDK env when the run belongs to a chat', async () => {
    expect((await envFor('01CHAT')).PATCH_CHAT_ID).toBe('01CHAT');
  });

  it('does not leak a stale PATCH_CHAT_ID into a run with no chat', async () => {
    const prev = process.env.PATCH_CHAT_ID;
    process.env.PATCH_CHAT_ID = 'from-elsewhere';
    try {
      expect((await envFor(undefined)).PATCH_CHAT_ID).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.PATCH_CHAT_ID;
      else process.env.PATCH_CHAT_ID = prev;
    }
  });
});
