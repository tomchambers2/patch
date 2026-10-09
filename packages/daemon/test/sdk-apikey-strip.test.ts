// H1-6 (spec/10-auth.md "Claude OAuth — non-negotiable"): the host's real
// SDK backend must NEVER let an inherited ANTHROPIC_API_KEY reach the SDK. Even
// when the host environment carries the key, the env handed to query() must
// have it stripped (belt-and-braces) and must instead carry the OAuth token.
//
// We mock @anthropic-ai/claude-agent-sdk so query() is a spy: we run the real
// backend with ANTHROPIC_API_KEY set in process.env and assert the captured
// options.env has NO ANTHROPIC_API_KEY but DOES carry CLAUDE_CODE_OAUTH_TOKEN.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const queryCalls: Array<{ prompt: unknown; options: Record<string, unknown> }> = [];

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  // The real query() returns an async iterable of SDK messages. Our spy records
  // the call and yields a single terminal message so the generator completes.
  query(args: { prompt: unknown; options: Record<string, unknown> }) {
    queryCalls.push(args);
    return (async function* () {
      yield { type: 'result', subtype: 'success' };
    })();
  },
}));

describe('H1-6: host strips ANTHROPIC_API_KEY before the SDK query', () => {
  const ORIGINAL = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    queryCalls.length = 0;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-host-inherited-should-never-reach-sdk';
  });

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = ORIGINAL;
  });

  it('removes a host-inherited ANTHROPIC_API_KEY and uses the OAuth token', async () => {
    const { createRealSdkBackend } = await import('../src/sdkBackend.js');
    const backend = createRealSdkBackend();

    const ac = new AbortController();
    const stream = backend.run({
      prompt: 'hello',
      cwd: '/tmp',
      abortController: ac,
      oauthAccessToken: 'oauth-access-token-xyz',
    });
    // Drain the generator so realRun() executes and calls query().
    const drained: unknown[] = [];
    for await (const msg of stream) {
      drained.push(msg);
    }
    expect(drained.length).toBeGreaterThan(0);

    expect(queryCalls).toHaveLength(1);
    const env = queryCalls[0]!.options.env as Record<string, string | undefined>;
    // The belt-and-braces strip: even though process.env had the key, the env
    // passed to the SDK must not.
    expect(env).toBeDefined();
    expect('ANTHROPIC_API_KEY' in env).toBe(false);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    // Auth is via OAuth, not an API key.
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-access-token-xyz');
    // process.env itself is untouched — the strip is on the copy only.
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-ant-host-inherited-should-never-reach-sdk');
  });
});
