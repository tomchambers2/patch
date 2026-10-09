// spec/04 § Name — the AI-title sanitizer. Guards that a raw model reply is
// coerced into a safe short title (or null), never surfacing quotes, newlines,
// trailing punctuation, or an over-long string.

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { sanitizeTitle, makeTitleGenerator, TITLE_MODEL } from '../src/titleGen.js';
import type { RunOnAccountWithCredit } from '../src/accountFailover.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';
import type { OAuthCheckResult } from '../src/chatRunner.js';

const silent = pino({ level: 'silent' });

const baseInput = {
  chatId: 'chat-1',
  firstUserMessage: 'help me plan a bus route',
  folder: '/work/x',
};

/**
 * Stand-in for the host's real `runOnAccountWithCredit`, which walks every
 * stored account. These tests are about the generator's own behaviour given a
 * credential, so this wraps a single resolver: no credential (or a resolver
 * that throws) yields null without running, and a failing run yields null —
 * the same two outcomes the real runner produces once it is out of accounts.
 */
const runWith =
  (oauth: () => OAuthCheckResult): RunOnAccountWithCredit =>
  async (_label, run) => {
    let resolved: OAuthCheckResult;
    try {
      resolved = oauth();
    } catch {
      return null;
    }
    if (!resolved.ok) return null;
    // Real errors propagate, exactly as the host's runner propagates
    // anything that is not an out-of-credit account.
    return await run(resolved.accessToken);
  };

describe('sanitizeTitle', () => {
  it('passes a clean title through unchanged', () => {
    expect(sanitizeTitle('Garden Plant Identification')).toBe('Garden Plant Identification');
  });

  it('strips surrounding quotes and backticks (straight + smart)', () => {
    expect(sanitizeTitle('"Bus Route Planning"')).toBe('Bus Route Planning');
    expect(sanitizeTitle("'Bus Route Planning'")).toBe('Bus Route Planning');
    expect(sanitizeTitle('`Bus Route Planning`')).toBe('Bus Route Planning');
    expect(sanitizeTitle('“Bus Route Planning”')).toBe('Bus Route Planning');
  });

  it('takes only the first line of a multi-line reply', () => {
    expect(sanitizeTitle('Layout Bug Fix\nHere is why I chose this.')).toBe('Layout Bug Fix');
  });

  it('drops trailing punctuation', () => {
    expect(sanitizeTitle('Fixing the Layout.')).toBe('Fixing the Layout');
    expect(sanitizeTitle('Deploy Pipeline!')).toBe('Deploy Pipeline');
    expect(sanitizeTitle('What Next -')).toBe('What Next');
  });

  it('collapses internal whitespace', () => {
    expect(sanitizeTitle('Dark   Mode\tToggle')).toBe('Dark Mode Toggle');
  });

  it('caps the length at ~48 chars with an ellipsis', () => {
    const out = sanitizeTitle('A'.repeat(200));
    expect(out).not.toBeNull();
    expect((out as string).length).toBeLessThanOrEqual(48);
    expect((out as string).endsWith('…')).toBe(true);
  });

  it('returns null for empty / whitespace-only / punctuation-only input', () => {
    expect(sanitizeTitle('')).toBeNull();
    expect(sanitizeTitle('   ')).toBeNull();
    expect(sanitizeTitle('""')).toBeNull();
    expect(sanitizeTitle('...')).toBeNull();
  });
});

// makeTitleGenerator: the one-shot Haiku summariser dependency the host
// fires once per chat as soon as the first user message is accepted (spec/04
// § Name). NO FALLBACK: any failure resolves to null, never throws, never
// hangs.
describe('makeTitleGenerator', () => {
  const okOAuth = (): OAuthCheckResult => ({ ok: true, accessToken: 'tok-123' });

  it('uses the final assistant message, the title model, folder, and OAuth token', async () => {
    const sdk = createMockSdkBackend();
    sdk.enqueue([
      { type: 'assistant_delta', content: 'Bus ' },
      { type: 'assistant_delta', content: 'Route Plan' },
      { type: 'assistant', content: 'Bus Route Plan' },
      { type: 'result', sessionId: 'sess-1' },
    ]);
    const generateTitle = makeTitleGenerator({
      sdkBackend: sdk,
      runOnAccountWithCredit: runWith(okOAuth),
      logger: silent,
    });
    const title = await generateTitle(baseInput);
    expect(title).toBe('Bus Route Plan');
    const opts = sdk.lastOptions();
    expect(opts?.model).toBe(TITLE_MODEL);
    expect(opts?.permissionMode).toBe('bypassPermissions');
    expect(opts?.oauthAccessToken).toBe('tok-123');
    expect(opts?.cwd).toBe(baseInput.folder);
    expect(opts?.resumeSessionId).toBeUndefined();
    expect(opts?.prompt).toContain(baseInput.firstUserMessage);
  });

  it('ignores envelopes with empty content on the assistant/delta paths', async () => {
    const sdk = createMockSdkBackend();
    sdk.enqueue([
      { type: 'assistant', content: '' },
      { type: 'assistant_delta', content: '' },
      { type: 'assistant', content: 'Real Title' },
      { type: 'result', sessionId: 'sess-2' },
    ]);
    const generateTitle = makeTitleGenerator({
      sdkBackend: sdk,
      runOnAccountWithCredit: runWith(okOAuth),
      logger: silent,
    });
    expect(await generateTitle(baseInput)).toBe('Real Title');
  });

  it('falls back to assembled delta text when no final assistant message arrives', async () => {
    const sdk = createMockSdkBackend();
    sdk.enqueue([
      { type: 'assistant_delta', content: 'Delta ' },
      { type: 'assistant_delta', content: 'Only Title' },
      { type: 'result', sessionId: 'sess-3' },
    ]);
    const generateTitle = makeTitleGenerator({
      sdkBackend: sdk,
      runOnAccountWithCredit: runWith(okOAuth),
      logger: silent,
    });
    expect(await generateTitle(baseInput)).toBe('Delta Only Title');
  });

  it('rejects with the SDK error envelope rather than reporting an empty answer', async () => {
    // See the matching status-generator test: `null` means "no usable title",
    // and a failure must not be able to say that. The runner reads the message
    // to decide whether another account is worth trying.
    const sdk = createMockSdkBackend();
    sdk.enqueue([
      { type: 'assistant_delta', content: 'partial' },
      { type: 'error', errorMessage: 'model overloaded' },
    ]);
    const generateTitle = makeTitleGenerator({
      sdkBackend: sdk,
      runOnAccountWithCredit: runWith(okOAuth),
      logger: silent,
    });
    await expect(generateTitle(baseInput)).rejects.toThrow('model overloaded');
  });

  it('resolves to null (without calling the SDK) when OAuth resolution rejects', async () => {
    const sdk = createMockSdkBackend();
    const generateTitle = makeTitleGenerator({
      sdkBackend: sdk,
      runOnAccountWithCredit: runWith(() => {
        throw new Error('token store unavailable');
      }),
      logger: silent,
    });
    expect(await generateTitle(baseInput)).toBeNull();
    expect(sdk.lastOptions()).toBeUndefined();
  });

  it('resolves to null when the OAuth gate reports not-ok', async () => {
    const sdk = createMockSdkBackend();
    const generateTitle = makeTitleGenerator({
      sdkBackend: sdk,
      runOnAccountWithCredit: runWith(() => ({ ok: false, reason: 'no-oauth-account' })),
      logger: silent,
    });
    expect(await generateTitle(baseInput)).toBeNull();
    expect(sdk.lastOptions()).toBeUndefined();
  });

  it('resolves to null with no logger configured at all (optional-chaining paths)', async () => {
    const generateTitle = makeTitleGenerator({
      sdkBackend: createMockSdkBackend(),
      runOnAccountWithCredit: runWith(() => ({ ok: false, reason: 'no-oauth-account' })),
    });
    await expect(generateTitle(baseInput)).resolves.toBeNull();
  });

  it('rejects when the SDK run throws', async () => {
    const throwingBackend = {
      async *run(): AsyncGenerator<never> {
        throw new Error('sdk exploded');
      },
    };
    const generateTitle = makeTitleGenerator({
      sdkBackend: throwingBackend,
      runOnAccountWithCredit: runWith(okOAuth),
      logger: silent,
    });
    await expect(generateTitle(baseInput)).rejects.toThrow('sdk exploded');
  });

  it('asks the host for a credential and names no account — a chat has none', async () => {
    // Regression, the other way round from the one this replaced: the summary
    // used to be handed the chat's pinned account. There is no such thing now
    // (spec/10-auth.md § Backend credentials), so it must ask for the host's
    // own resolution — the first stored key with credit — exactly as a turn
    // does. Passing an account here would be inventing one.
    const sdk = createMockSdkBackend();
    sdk.enqueue([
      { type: 'assistant', content: 'A Title' },
      { type: 'result', sessionId: 'sess-acct' },
    ]);
    const resolveOAuth = vi.fn((): OAuthCheckResult => ({ ok: true, accessToken: 'tok' }));
    const generateTitle = makeTitleGenerator({
      sdkBackend: sdk,
      runOnAccountWithCredit: runWith(resolveOAuth),
      logger: silent,
    });
    const title = await generateTitle(baseInput);
    expect(title).toBe('A Title');
    expect(resolveOAuth).toHaveBeenCalledWith();
  });

  it('aborts the in-flight SDK call once the timeout elapses', async () => {
    vi.useFakeTimers();
    try {
      const backend = {
        run(opts: { abortController: AbortController }): AsyncIterable<never> {
          return {
            [Symbol.asyncIterator]() {
              return {
                next: () =>
                  new Promise((resolve) => {
                    opts.abortController.signal.addEventListener('abort', () => {
                      resolve({ value: undefined, done: true });
                    });
                  }),
              };
            },
          };
        },
      };
      const generateTitle = makeTitleGenerator({
        sdkBackend: backend,
        runOnAccountWithCredit: runWith(okOAuth),
        logger: silent,
      });
      const promise = generateTitle(baseInput);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await promise).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('titles a Codex chat on its OWN model via the routed backend, not Haiku', async () => {
    const claude = createMockSdkBackend();
    const codex = createMockSdkBackend();
    codex.enqueue([
      { type: 'assistant', content: 'Bus Route Plan' },
      { type: 'result', sessionId: 'sess-c' },
    ]);
    const resolveOAuth = vi.fn(okOAuth);
    const runOnAccountWithCredit = vi.fn(runWith(okOAuth));
    const generateTitle = makeTitleGenerator({
      sdkBackend: claude,
      runOnAccountWithCredit,
      codex: { sdkBackend: codex, resolveOAuth },
      logger: silent,
    });
    const title = await generateTitle({ ...baseInput, chatModel: 'openai/gpt-5-codex' });
    expect(title).toBe('Bus Route Plan');
    expect(resolveOAuth).toHaveBeenCalledWith('openai/gpt-5-codex');
    expect(codex.lastOptions()?.model).toBe('openai/gpt-5-codex');
    expect(claude.lastOptions()).toBeUndefined();
    expect(runOnAccountWithCredit).not.toHaveBeenCalled();
  });

  it('resolves to null for a Codex chat when no Codex credential is available', async () => {
    const codex = createMockSdkBackend();
    const generateTitle = makeTitleGenerator({
      sdkBackend: createMockSdkBackend(),
      runOnAccountWithCredit: runWith(okOAuth),
      codex: {
        sdkBackend: codex,
        resolveOAuth: () => ({ ok: false, reason: 'no codex login' }) as OAuthCheckResult,
      },
      logger: silent,
    });
    expect(await generateTitle({ ...baseInput, chatModel: 'openai/gpt-5-codex' })).toBeNull();
    expect(codex.lastOptions()).toBeUndefined();
  });

  it('resolves to null for a Codex chat when the host wired no Codex backend', async () => {
    const generateTitle = makeTitleGenerator({
      sdkBackend: createMockSdkBackend(),
      runOnAccountWithCredit: runWith(okOAuth),
      logger: silent,
    });
    expect(await generateTitle({ ...baseInput, chatModel: 'openai/gpt-5-codex' })).toBeNull();
  });
});
