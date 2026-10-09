// principles.md §"No system-prompt injection": Patch must NOT inject system
// prompts into Claude Code sessions to shape behaviour ("you are the Manager",
// "be concise on voice", etc.). Prompting belongs to Claude Code and the user's
// CLAUDE.md files — invisible platform-layer prompt injection is the single
// biggest source of hard-to-debug agent behaviour.
//
// This is a REGRESSION GUARD. Earlier in development a
// `systemPrompt: { type: 'preset', preset: 'claude_code', append: … }` was
// briefly added to shape voice replies and then reverted as a principle
// violation. Nothing caught it. This test inspects the ACTUAL options object the
// host passes to the SDK query() (via the same SDK-mock seam as
// sdk-apikey-strip.test.ts) and fails if any prompt-injection key reappears.
//
// The ONLY sanctioned per-turn shaping is the `[voice • <surface>]` user-message
// prefix (metadata-as-data, like an email From: header) — that rides in the
// PROMPT, never in a systemPrompt option, so it does not show up here.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';

const queryCalls: Array<{ prompt: unknown; options: Record<string, unknown> }> = [];

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query(args: { prompt: unknown; options: Record<string, unknown> }) {
    queryCalls.push(args);
    return (async function* () {
      yield { type: 'result', subtype: 'success' };
    })();
  },
}));

describe('principles: host injects NO system prompt into the SDK query', () => {
  beforeEach(() => {
    queryCalls.length = 0;
  });
  afterEach(() => {
    queryCalls.length = 0;
  });

  it('passes no systemPrompt / appendSystemPrompt / customSystemPrompt to query()', async () => {
    const { createRealSdkBackend } = await import('../src/sdkBackend.js');
    const backend = createRealSdkBackend();

    const ac = new AbortController();
    const drained: unknown[] = [];
    for await (const msg of backend.run({
      prompt: 'hello',
      cwd: '/tmp',
      abortController: ac,
      oauthAccessToken: 'oauth-access-token-xyz',
    })) {
      drained.push(msg);
    }
    expect(drained.length).toBeGreaterThan(0);
    expect(queryCalls).toHaveLength(1);

    const options = queryCalls[0]!.options;
    // None of the SDK's prompt-shaping option keys may be present. Their mere
    // PRESENCE (even set to undefined) signals an intent to inject — fail on the
    // key, not just a truthy value.
    for (const forbidden of ['systemPrompt', 'appendSystemPrompt', 'customSystemPrompt']) {
      expect(forbidden in options, `forbidden SDK option present: ${forbidden}`).toBe(false);
    }
  });

  it('the voice prefix rides in the PROMPT, not a systemPrompt option', async () => {
    const { createRealSdkBackend } = await import('../src/sdkBackend.js');
    const backend = createRealSdkBackend();
    const ac = new AbortController();
    const drained: unknown[] = [];
    for await (const msg of backend.run({
      prompt: '[voice • web] turn the lights on',
      cwd: '/tmp',
      abortController: ac,
      oauthAccessToken: 'tok',
    })) {
      drained.push(msg);
    }
    expect(queryCalls).toHaveLength(1);
    // The prefix is data in the prompt the model reads — never a hidden directive.
    expect(String(queryCalls[0]!.prompt)).toContain('[voice • web]');
    expect('systemPrompt' in queryCalls[0]!.options).toBe(false);
  });
});
