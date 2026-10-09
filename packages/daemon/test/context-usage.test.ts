import { describe, expect, it } from 'vitest';
import { assistantContextTokens, resultContextWindow } from '../src/contextUsage.js';

// spec/14 § Composer — context ring. The two halves of a reading come from two
// different Claude Code messages; neither is guessed when absent.

const assistant = (
  usage: Record<string, unknown> | undefined,
  extra: Record<string, unknown> = {},
) => ({
  type: 'assistant',
  parent_tool_use_id: null,
  message: { model: 'claude-opus-5-5', content: [], ...(usage ? { usage } : {}) },
  ...extra,
});

describe('assistantContextTokens', () => {
  it('counts everything the request read: fresh input, cache writes and cache reads', () => {
    expect(
      assistantContextTokens(
        assistant({
          input_tokens: 12,
          cache_creation_input_tokens: 3_000,
          cache_read_input_tokens: 40_000,
          output_tokens: 900,
        }),
      ),
    ).toEqual({ tokens: 43_012, model: 'claude-opus-5-5' });
  });

  it('ignores a subagent message — a different conversation', () => {
    expect(
      assistantContextTokens(assistant({ input_tokens: 500 }, { parent_tool_use_id: 'toolu_1' })),
    ).toBeUndefined();
  });

  it('says nothing for a message with no usage or a synthetic zero-input one', () => {
    expect(assistantContextTokens(assistant(undefined))).toBeUndefined();
    expect(assistantContextTokens(assistant({ input_tokens: 0 }))).toBeUndefined();
    expect(assistantContextTokens({ type: 'user' })).toBeUndefined();
    expect(assistantContextTokens(null)).toBeUndefined();
  });
});

describe('resultContextWindow', () => {
  const result = {
    type: 'result',
    modelUsage: {
      'claude-haiku-4-5-20251001': { contextWindow: 200_000 },
      'claude-opus-5-5': { contextWindow: 1_000_000 },
    },
  };

  it("takes the window of the chat's own model, not Claude Code's helper model", () => {
    expect(resultContextWindow(result, 'claude-opus-5-5')).toBe(1_000_000);
  });

  it('matches a model whose window tag differs, e.g. [1m]', () => {
    expect(
      resultContextWindow(
        {
          type: 'result',
          modelUsage: {
            'claude-opus-5-5[1m]': { contextWindow: 1_000_000 },
            h: { contextWindow: 1 },
          },
        },
        'claude-opus-5-5',
      ),
    ).toBe(1_000_000);
  });

  it('is unknown when several models are billed and none can be matched', () => {
    expect(resultContextWindow(result, undefined)).toBeUndefined();
    expect(resultContextWindow(result, 'claude-sonnet-5')).toBeUndefined();
  });

  it('uses the only model named when there is nothing to match', () => {
    expect(
      resultContextWindow(
        { type: 'result', modelUsage: { m: { contextWindow: 200_000 } } },
        undefined,
      ),
    ).toBe(200_000);
  });

  it('ignores anything that is not a result', () => {
    expect(resultContextWindow({ type: 'assistant' }, 'm')).toBeUndefined();
  });
});
