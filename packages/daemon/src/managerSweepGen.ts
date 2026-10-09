// The Manager sweep's one decision call (spec/06 § Sweep).
//
// A cheap, tool-free, one-shot query: given the sweep's compact digest, the
// model returns exactly one action per candidate chat — nudge, wake, flag or
// leave — as JSON. No tool loop, so there is no way for it to approve a
// permission or answer a real question even by accident; those candidates
// are never offered to it as nudgeable in the first place (the digest marks
// them `permission`/`question`, and the executor refuses to nudge/wake a
// chat carrying either edge regardless of what this returns — belt and
// braces, `managerSweepRunner.ts`).
//
// NO FALLBACK: any failure — OAuth miss, SDK error, timeout, unparseable
// reply — resolves to null, and the sweep records the run as a failure
// rather than guessing at actions.

import type { SdkBackend } from './sdkBackend.js';
import type { RunOnAccountWithCredit } from './accountFailover.js';
import type { Logger } from 'pino';

/** Mid-size by default (spec/06 § Settings) — cheap enough to run often, capable enough to read intent off a handful of short transcripts. */
export const DEFAULT_SWEEP_MODEL = 'claude-sonnet-5';

const SWEEP_TIMEOUT_MS = 30_000;

export interface SweepDecision {
  chatId: string;
  action: 'nudge' | 'wake' | 'flag' | 'leave';
  message?: string;
  flagText?: string;
}

export interface SweepDecisionResult {
  decisions: SweepDecision[];
  /** Rough token count for the call (prompt + reply), for the cost log (spec/06 § Cost check). */
  tokensUsed: number;
}

export interface GenerateSweepDecisionsInput {
  /** The rendered digest text — candidates, their edge, idle time, and recent messages. */
  digest: string;
  /** The (possibly user-edited) sweep prompt — spec/06 § Settings. */
  prompt: string;
  model: string;
}

export interface MakeSweepDeciderOptions {
  sdkBackend: SdkBackend;
  runOnAccountWithCredit: RunOnAccountWithCredit;
  logger?: Logger;
}

/**
 * Parse the model's reply as `{decisions: [...]}`. Tolerates the model
 * wrapping the JSON in a fenced code block (the usual failure mode for "reply
 * with ONLY JSON" instructions). Any other shape — not an object, missing
 * `decisions`, a decision missing `chatId`/`action` — fails the whole parse
 * (NO FALLBACK: a half-understood reply is not partially trusted).
 */
export function parseSweepDecisions(raw: string): SweepDecision[] | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const body = fenced ? fenced[1]! : trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || !('decisions' in parsed)) return null;
  const raw_decisions = (parsed as { decisions: unknown }).decisions;
  if (!Array.isArray(raw_decisions)) return null;
  const out: SweepDecision[] = [];
  const VALID_ACTIONS = new Set(['nudge', 'wake', 'flag', 'leave']);
  for (const d of raw_decisions) {
    if (typeof d !== 'object' || d === null) return null;
    const { chatId, action, message, flagText } = d as Record<string, unknown>;
    if (typeof chatId !== 'string' || chatId === '') return null;
    if (typeof action !== 'string' || !VALID_ACTIONS.has(action)) return null;
    if (message !== undefined && typeof message !== 'string') return null;
    if (flagText !== undefined && typeof flagText !== 'string') return null;
    out.push({
      chatId,
      action: action as SweepDecision['action'],
      ...(typeof message === 'string' ? { message } : {}),
      ...(typeof flagText === 'string' ? { flagText } : {}),
    });
  }
  return out;
}

function estimateTokens(...texts: string[]): number {
  return Math.round(texts.reduce((n, t) => n + t.length, 0) / 4);
}

export function makeSweepDecider(
  opts: MakeSweepDeciderOptions,
): (input: GenerateSweepDecisionsInput) => Promise<SweepDecisionResult | null> {
  return async function generateSweepDecisions(
    input: GenerateSweepDecisionsInput,
  ): Promise<SweepDecisionResult | null> {
    return await opts.runOnAccountWithCredit('manager sweep', async (accessToken) => {
      const abortController = new AbortController();
      const timer = setTimeout(() => abortController.abort(), SWEEP_TIMEOUT_MS);
      const fullPrompt = `${input.prompt}\n\n${input.digest}`;
      try {
        let finalText = '';
        let deltaText = '';
        for await (const env of opts.sdkBackend.run({
          prompt: fullPrompt,
          // No real folder for a tool-free, non-chat one-shot — cwd matters
          // only to tools this call never gets.
          cwd: process.cwd(),
          resumeSessionId: undefined,
          abortController,
          oauthAccessToken: accessToken,
          model: input.model,
          permissionMode: 'bypassPermissions',
        })) {
          if (env.type === 'assistant' && env.content) finalText += env.content;
          else if (env.type === 'assistant_delta' && env.content) deltaText += env.content;
          else if (env.type === 'error') {
            throw new Error(env.errorMessage ?? 'manager sweep: SDK error envelope');
          }
        }
        const text = finalText !== '' ? finalText : deltaText;
        const decisions = parseSweepDecisions(text);
        if (decisions === null) {
          opts.logger?.warn({ reply: text.slice(0, 500) }, 'manager-sweep: unparseable reply');
          return null;
        }
        const tokensUsed = estimateTokens(fullPrompt, text);
        // spec/06 § Sweep — "Cost check: log tokens per sweep." One line per
        // run, cheap to grep/aggregate over a day once this is live.
        opts.logger?.info(
          { model: input.model, tokensUsed },
          'manager-sweep: decision call complete',
        );
        return { decisions, tokensUsed };
      } finally {
        clearTimeout(timer);
      }
    });
  };
}
