// patch/todo.md § Features to add — "Current status". The host summarises a
// thread after each turn settles into a one-line "current status" + a KIND that
// distinguishes a thread paused on a user QUESTION from one that has merely
// stopped/COMPLETE. This guards the pure parser (raw model reply → {kind,
// summary} | null) and the SDK-backed generator wrapper.

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { parseStatus, makeStatusGenerator, STATUS_MODEL } from '../src/statusGen.js';
import type { RunOnAccountWithCredit } from '../src/accountFailover.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';
import type { OAuthCheckResult } from '../src/chatRunner.js';

const silent = pino({ level: 'silent' });

const baseInput = {
  chatId: 'chat-1',
  lastUserMessage: 'refactor the auth module',
  assistantReply: 'Done — the auth module is refactored and tests pass.',
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

describe('parseStatus', () => {
  it('parses a COMPLETE reply into kind=complete + summary', () => {
    const out = parseStatus('COMPLETE: Refactor finished, all tests green');
    expect(out).toEqual({ kind: 'complete', summary: 'Refactor finished, all tests green' });
  });

  it('parses a QUESTION reply into kind=question + summary', () => {
    const out = parseStatus('QUESTION: Should I also migrate the legacy tokens?');
    expect(out).toEqual({ kind: 'question', summary: 'Should I also migrate the legacy tokens?' });
  });

  it('is case-insensitive on the kind prefix', () => {
    expect(parseStatus('complete: nothing left to do')?.kind).toBe('complete');
    expect(parseStatus('Question: which branch?')?.kind).toBe('question');
  });

  it('maps waiting/blocked/needs-input synonyms to question', () => {
    expect(parseStatus('WAITING: needs your API key')?.kind).toBe('question');
    expect(parseStatus('BLOCKED: cannot proceed without the token')?.kind).toBe('question');
  });

  it('maps done/finished synonyms to complete', () => {
    expect(parseStatus('DONE: shipped the change')?.kind).toBe('complete');
    expect(parseStatus('FINISHED: nothing outstanding')?.kind).toBe('complete');
  });

  it('accepts a dash or em-dash separator', () => {
    expect(parseStatus('QUESTION - which file?')).toEqual({
      kind: 'question',
      summary: 'which file?',
    });
    expect(parseStatus('COMPLETE — all set')).toEqual({ kind: 'complete', summary: 'all set' });
  });

  it('takes only the first line and strips surrounding quotes', () => {
    const out = parseStatus('COMPLETE: "build is green"\nAnything else?');
    expect(out).toEqual({ kind: 'complete', summary: 'build is green' });
  });

  it('caps an over-long summary with an ellipsis', () => {
    const out = parseStatus(`COMPLETE: ${'a'.repeat(300)}`);
    expect(out).not.toBeNull();
    expect((out as { summary: string }).summary.length).toBeLessThanOrEqual(100);
    expect((out as { summary: string }).summary.endsWith('…')).toBe(true);
  });

  it('returns null when no recognised kind prefix is present', () => {
    expect(parseStatus('just some free text with no prefix')).toBeNull();
    expect(parseStatus('')).toBeNull();
    expect(parseStatus('   ')).toBeNull();
  });

  it('returns null when the summary body is empty after the prefix', () => {
    expect(parseStatus('COMPLETE:')).toBeNull();
    expect(parseStatus('QUESTION:   ')).toBeNull();
  });
});

describe('makeStatusGenerator', () => {
  const okOAuth = (): OAuthCheckResult => ({ ok: true, accessToken: 'tok-123' });

  it('uses the final assistant message, the status model, folder + OAuth token', async () => {
    const sdk = createMockSdkBackend();
    sdk.enqueue([
      { type: 'assistant', content: 'QUESTION: Which environment should I deploy to?' },
      { type: 'result', sessionId: 'sess-1' },
    ]);
    const gen = makeStatusGenerator({
      sdkBackend: sdk,
      runOnAccountWithCredit: runWith(okOAuth),
      logger: silent,
    });
    const out = await gen(baseInput);
    expect(out).toEqual({ kind: 'question', summary: 'Which environment should I deploy to?' });
    const opts = sdk.lastOptions();
    expect(opts?.model).toBe(STATUS_MODEL);
    expect(opts?.permissionMode).toBe('bypassPermissions');
    expect(opts?.oauthAccessToken).toBe('tok-123');
    expect(opts?.cwd).toBe(baseInput.folder);
    expect(opts?.resumeSessionId).toBeUndefined();
    expect(opts?.prompt).toContain(baseInput.assistantReply);
  });

  it('feeds the END of a long reply (where the outcome is) and forbids talking about truncation', async () => {
    const sdk = createMockSdkBackend();
    sdk.enqueue([
      { type: 'assistant', content: 'COMPLETE: Refactored auth module, tests pass' },
      { type: 'result', sessionId: 'sess-1' },
    ]);
    const gen = makeStatusGenerator({
      sdkBackend: sdk,
      runOnAccountWithCredit: runWith(okOAuth),
      logger: silent,
    });
    const long = `START-MARKER ${'filler '.repeat(800)} FINAL-OUTCOME: shipped and green`;
    await gen({ ...baseInput, assistantReply: long });
    const prompt = sdk.lastOptions()?.prompt ?? '';
    expect(prompt).toContain('FINAL-OUTCOME: shipped and green');
    expect(prompt).not.toContain('START-MARKER');
    expect(prompt).toMatch(/never\s+(mention|say)[^.]*(cut|truncat|excerpt)/i);
    expect(prompt).toMatch(/what the agent (did|said)/i);
  });

  it('falls back to assembled delta text when no final assistant message arrives', async () => {
    const sdk = createMockSdkBackend();
    sdk.enqueue([
      { type: 'assistant_delta', content: 'COMPLETE: ' },
      { type: 'assistant_delta', content: 'all set' },
      { type: 'result', sessionId: 'sess-2' },
    ]);
    const gen = makeStatusGenerator({
      sdkBackend: sdk,
      runOnAccountWithCredit: runWith(okOAuth),
      logger: silent,
    });
    expect(await gen(baseInput)).toEqual({ kind: 'complete', summary: 'all set' });
  });

  it('returns null when OAuth is unavailable (no SDK call)', async () => {
    const sdk = createMockSdkBackend();
    const runSpy = vi.spyOn(sdk, 'run');
    const gen = makeStatusGenerator({
      sdkBackend: sdk,
      runOnAccountWithCredit: runWith((): OAuthCheckResult => ({ ok: false, reason: 'no-oauth' })),
      logger: silent,
    });
    expect(await gen(baseInput)).toBeNull();
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('returns null when the model reply has no recognised prefix', async () => {
    const sdk = createMockSdkBackend();
    sdk.enqueue([
      { type: 'assistant', content: 'I have finished the task for you.' },
      { type: 'result', sessionId: 'sess-3' },
    ]);
    const gen = makeStatusGenerator({
      sdkBackend: sdk,
      runOnAccountWithCredit: runWith(okOAuth),
      logger: silent,
    });
    expect(await gen(baseInput)).toBeNull();
  });

  it('rejects with the SDK error envelope rather than reporting an empty answer', async () => {
    // Deliberately NOT null. `null` here means "the model had nothing to say",
    // and a failure wearing that costume is what let a spent account read as
    // 76 chats with no status while everything around them worked. The runner
    // needs the provider's own words to tell an out-of-credit account from a
    // real error, and the caller logs whichever it turns out to be.
    const sdk = createMockSdkBackend();
    sdk.enqueue([{ type: 'error', errorMessage: 'model overloaded' }]);
    const gen = makeStatusGenerator({
      sdkBackend: sdk,
      runOnAccountWithCredit: runWith(okOAuth),
      logger: silent,
    });
    await expect(gen(baseInput)).rejects.toThrow('model overloaded');
  });

  it('asks the host for a credential and names no account — a chat has none', async () => {
    // Regression, the other way round from the one this replaced: the summary
    // used to be handed the chat's pinned account. There is no such thing now
    // (spec/10-auth.md § Backend credentials), so it must ask for the host's
    // own resolution — the first stored key with credit — exactly as a turn
    // does.
    const sdk = createMockSdkBackend();
    sdk.enqueue([
      { type: 'assistant', content: 'COMPLETE: a status' },
      { type: 'result', sessionId: 'sess-acct' },
    ]);
    const resolveOAuth = vi.fn((): OAuthCheckResult => ({ ok: true, accessToken: 'tok' }));
    const gen = makeStatusGenerator({
      sdkBackend: sdk,
      runOnAccountWithCredit: runWith(resolveOAuth),
      logger: silent,
    });
    const out = await gen(baseInput);
    expect(out).toEqual({ kind: 'complete', summary: 'a status' });
    expect(resolveOAuth).toHaveBeenCalledWith();
  });
});
