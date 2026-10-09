// spec/04 § Goals — the evaluator judges a chat's goal condition against the
// conversation after each turn settles. This guards the pure parser (raw
// model reply → {verdict, reason} | null) and the SDK-backed generator
// wrapper, including the Claude-vs-Codex model choice ("any provider").

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import {
  parseGoalVerdict,
  makeGoalEvaluator,
  renderGoalTranscript,
  GOAL_EVAL_MODEL,
} from '../src/goalEval.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';
import type { OAuthCheckResult } from '../src/chatRunner.js';

const silent = pino({ level: 'silent' });

const baseInput = {
  chatId: 'chat-1',
  condition: 'Ship the release by Friday',
  transcript: 'user: ship it\n\nassistant: working on it',
  turnsEvaluated: 1,
  folder: '/work/x',
};

describe('parseGoalVerdict', () => {
  it('parses a met verdict', () => {
    expect(parseGoalVerdict('{"verdict":"met","reason":"Release shipped and tagged"}')).toEqual({
      verdict: 'met',
      reason: 'Release shipped and tagged',
    });
  });

  it('parses a not_met verdict', () => {
    expect(parseGoalVerdict('{"verdict":"not_met","reason":"Tests still failing"}')).toEqual({
      verdict: 'not_met',
      reason: 'Tests still failing',
    });
  });

  it('parses an impossible verdict', () => {
    expect(
      parseGoalVerdict('{"verdict":"impossible","reason":"The repo no longer exists"}'),
    ).toEqual({ verdict: 'impossible', reason: 'The repo no longer exists' });
  });

  it('tolerates a ```json fenced reply', () => {
    expect(parseGoalVerdict('```json\n{"verdict":"met","reason":"done"}\n```')).toEqual({
      verdict: 'met',
      reason: 'done',
    });
  });

  it('caps an over-long reason with an ellipsis', () => {
    const out = parseGoalVerdict(`{"verdict":"not_met","reason":"${'a'.repeat(300)}"}`);
    expect(out).not.toBeNull();
    expect((out as { reason: string }).reason.length).toBeLessThanOrEqual(220);
    expect((out as { reason: string }).reason.endsWith('…')).toBe(true);
  });

  it('parses a refused verdict', () => {
    expect(
      parseGoalVerdict('{"verdict":"refused","reason":"It declined to run the migration"}'),
    ).toEqual({ verdict: 'refused', reason: 'It declined to run the migration' });
  });

  it('returns null for unparseable JSON', () => {
    expect(parseGoalVerdict('not json at all')).toBeNull();
    expect(parseGoalVerdict('')).toBeNull();
    expect(parseGoalVerdict('   ')).toBeNull();
  });

  it('returns null for an unrecognised verdict or missing reason', () => {
    expect(parseGoalVerdict('{"verdict":"maybe","reason":"x"}')).toBeNull();
    expect(parseGoalVerdict('{"verdict":"met"}')).toBeNull();
    expect(parseGoalVerdict('{"verdict":"met","reason":""}')).toBeNull();
  });
});

describe('renderGoalTranscript', () => {
  it('renders role: content pairs oldest first', () => {
    const out = renderGoalTranscript([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ]);
    expect(out).toBe('user: hello\n\nassistant: hi there');
  });

  it('truncates from the front when over the character cap, keeping the tail', () => {
    const long = 'x'.repeat(100);
    const out = renderGoalTranscript([{ role: 'user', content: long }], 20);
    expect(out.length).toBeLessThanOrEqual(22);
    expect(out.endsWith(long.slice(-20))).toBe(true);
  });
});

describe('makeGoalEvaluator', () => {
  const okOAuth = (): OAuthCheckResult => ({ ok: true, accessToken: 'tok-123' });

  it('judges on the default model, Sonnet 5.5, when Settings names none', async () => {
    const sdk = createMockSdkBackend();
    sdk.enqueue([
      { type: 'assistant', content: '{"verdict":"met","reason":"All good"}' },
      { type: 'result', sessionId: 'sess-1' },
    ]);
    const resolveOAuth = vi.fn(okOAuth);
    const evaluate = makeGoalEvaluator({ sdkBackend: sdk, resolveOAuth, logger: silent });
    const out = await evaluate(baseInput);
    expect(out).toEqual({ verdict: 'met', reason: 'All good' });
    expect(resolveOAuth).toHaveBeenCalledWith(GOAL_EVAL_MODEL);
    const opts = sdk.lastOptions();
    expect(opts?.model).toBe(GOAL_EVAL_MODEL);
    expect(opts?.permissionMode).toBe('bypassPermissions');
    expect(opts?.oauthAccessToken).toBe('tok-123');
    expect(opts?.cwd).toBe(baseInput.folder);
    expect(opts?.prompt).toContain(baseInput.condition);
    expect(opts?.prompt).toContain(baseInput.transcript);
  });

  it('tells the judge a goal keeps going through questions and offers, and what a refusal is', async () => {
    const sdk = createMockSdkBackend();
    sdk.enqueue([
      { type: 'assistant', content: '{"verdict":"not_met","reason":"Go ahead"}' },
      { type: 'result', sessionId: 'sess-p' },
    ]);
    const evaluate = makeGoalEvaluator({ sdkBackend: sdk, resolveOAuth: okOAuth, logger: silent });
    await evaluate(baseInput);
    const prompt = sdk.lastOptions()?.prompt ?? '';
    expect(prompt).toContain('asking whether to go ahead');
    expect(prompt).toContain('"refused"');
    expect(prompt).toContain('without asking again');
  });

  it('judges with the prompt and model Settings gives, and still ends with the reply format', async () => {
    const sdk = createMockSdkBackend();
    sdk.enqueue([
      { type: 'assistant', content: '{"verdict":"met","reason":"ok"}' },
      { type: 'result', sessionId: 'sess-s' },
    ]);
    const resolveOAuth = vi.fn(okOAuth);
    const evaluate = makeGoalEvaluator({
      sdkBackend: sdk,
      resolveOAuth,
      logger: silent,
      settings: () => ({ prompt: 'Be very strict about what counts.', model: 'claude-sonnet-5' }),
    });
    await evaluate(baseInput);
    expect(resolveOAuth).toHaveBeenCalledWith('claude-sonnet-5');
    const opts = sdk.lastOptions();
    expect(opts?.model).toBe('claude-sonnet-5');
    expect(opts?.prompt).toContain('Be very strict about what counts.');
    expect(opts?.prompt).not.toContain('standing instruction'); // the default text is replaced
    expect(opts?.prompt).toContain(baseInput.condition);
    expect(opts?.prompt).toContain(baseInput.transcript);
    expect(opts?.prompt?.trimEnd().endsWith('No prose outside the JSON.')).toBe(true);
  });

  it('judges a chat on the model Settings names, whichever provider the chat runs on', async () => {
    const sdk = createMockSdkBackend();
    sdk.enqueue([
      { type: 'assistant', content: '{"verdict":"met","reason":"ok"}' },
      { type: 'result', sessionId: 'sess-c' },
    ]);
    const resolveOAuth = vi.fn(okOAuth);
    const evaluate = makeGoalEvaluator({
      sdkBackend: sdk,
      resolveOAuth,
      logger: silent,
      settings: () => ({ prompt: 'x', model: 'openai/gpt-5-codex' }),
    });
    await evaluate(baseInput);
    expect(resolveOAuth).toHaveBeenCalledWith('openai/gpt-5-codex');
    expect(sdk.lastOptions()?.model).toBe('openai/gpt-5-codex');
  });

  it('falls back to assembled delta text when no final assistant message arrives', async () => {
    const sdk = createMockSdkBackend();
    sdk.enqueue([
      { type: 'assistant_delta', content: '{"verdict":"impossible",' },
      { type: 'assistant_delta', content: '"reason":"no longer possible"}' },
      { type: 'result', sessionId: 'sess-3' },
    ]);
    const evaluate = makeGoalEvaluator({ sdkBackend: sdk, resolveOAuth: okOAuth, logger: silent });
    expect(await evaluate(baseInput)).toEqual({
      verdict: 'impossible',
      reason: 'no longer possible',
    });
  });

  it('returns null when no credential is available (no SDK call)', async () => {
    const sdk = createMockSdkBackend();
    const runSpy = vi.spyOn(sdk, 'run');
    const evaluate = makeGoalEvaluator({
      sdkBackend: sdk,
      resolveOAuth: () => ({ ok: false, reason: 'no-oauth' }),
      logger: silent,
    });
    expect(await evaluate(baseInput)).toBeNull();
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('returns null when the model reply is not the documented JSON shape', async () => {
    const sdk = createMockSdkBackend();
    sdk.enqueue([
      { type: 'assistant', content: 'I think it is probably done.' },
      { type: 'result', sessionId: 'sess-4' },
    ]);
    const evaluate = makeGoalEvaluator({ sdkBackend: sdk, resolveOAuth: okOAuth, logger: silent });
    expect(await evaluate(baseInput)).toBeNull();
  });

  it('returns null (never throws) when the SDK reports an error envelope', async () => {
    const sdk = createMockSdkBackend();
    sdk.enqueue([{ type: 'error', errorMessage: 'model overloaded' }]);
    const evaluate = makeGoalEvaluator({ sdkBackend: sdk, resolveOAuth: okOAuth, logger: silent });
    await expect(evaluate(baseInput)).resolves.toBeNull();
  });
});
