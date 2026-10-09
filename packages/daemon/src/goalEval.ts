// AI goal evaluator (spec/04 § Goals).
//
// After a turn settles on a chat with an active goal, a cheap one-shot query
// reads the visible transcript so far against the goal's condition and
// returns a verdict: `not_met` (another turn follows, guided by the reason),
// `refused` (the agent declined; another turn follows, until it has declined
// too often), `met` (the goal clears, the normal done notification rings), or
// `impossible` (the goal clears, the chat needs the user). Modelled on
// `statusGen.ts`/`titleGen.ts`'s one-shot shape. One model judges every chat,
// whichever provider the chat itself runs on: the judge reads a transcript, so
// it has nothing to do with the chat's model, and it is chosen in Settings →
// Goals.
//
// NO FALLBACK: any failure — no credential, SDK error, timeout, unparseable
// reply — resolves to null and the host leaves the goal exactly as it was,
// logged; the next turn's settle tries again.

import { DEFAULT_GOAL_EVAL_PROMPT, DEFAULT_GOAL_MODEL } from '@patch/wire';
import type { SdkBackend } from './sdkBackend.js';
import type { OAuthCheckResult } from './chatRunner.js';
import type { Logger } from 'pino';

/** The judge model until Settings names another. */
export const GOAL_EVAL_MODEL = DEFAULT_GOAL_MODEL;

/** Abort a hung evaluator call so it never leaks a warm SDK query. */
const GOAL_EVAL_TIMEOUT_MS = 20_000;

/** Hard cap on the returned reason. */
const MAX_REASON_LEN = 220;

export type GoalVerdict = 'met' | 'not_met' | 'refused' | 'impossible';

export interface GoalEvalResult {
  verdict: GoalVerdict;
  reason: string;
}

export interface GoalEvalInput {
  chatId: string;
  condition: string;
  /** Rendered `role: content` transcript, oldest first, already bounded by the caller. */
  transcript: string;
  turnsEvaluated: number;
  folder: string;
}

export interface GoalJudgeSettings {
  /** The judge's instructions (Settings → Goals). */
  prompt: string;
  /** The model that judges every chat, whichever provider the chat runs on. */
  model: string;
}

export interface MakeGoalEvaluatorOptions {
  /** Read per evaluation, so an edit in Settings applies to the next turn. Absent means the defaults. */
  settings?: () => GoalJudgeSettings;
  sdkBackend: SdkBackend;
  /** The host's own model-aware OAuth gate (mirrors chatRunner's `resolveOAuth`). */
  resolveOAuth: (model?: string) => OAuthCheckResult | Promise<OAuthCheckResult>;
  logger?: Logger;
}

/**
 * Coerce a raw model reply into `{ verdict, reason }`, or null when nothing
 * usable remains. The model is asked for a JSON object (same fenced-code
 * tolerance as `hookCheck.ts`'s `parseHookOutcome`).
 */
export function parseGoalVerdict(raw: string): GoalEvalResult | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const unfenced = trimmed.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```$/, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const verdict = obj['verdict'];
  if (
    verdict !== 'met' &&
    verdict !== 'not_met' &&
    verdict !== 'refused' &&
    verdict !== 'impossible'
  )
    return null;
  const rawReason = obj['reason'];
  if (typeof rawReason !== 'string' || rawReason.trim() === '') return null;
  let reason = rawReason.trim().replace(/\s+/g, ' ');
  if (reason.length > MAX_REASON_LEN) reason = `${reason.slice(0, MAX_REASON_LEN - 1).trimEnd()}…`;
  return { verdict, reason };
}

function buildPrompt(input: GoalEvalInput, instructions: string): string {
  return [
    instructions.trim(),
    '',
    `Turns evaluated against this goal so far (including this one): ${input.turnsEvaluated}.`,
    '',
    `GOAL: ${input.condition}`,
    '',
    'CONVERSATION SO FAR (oldest first):',
    input.transcript,
    '',
    'Reply with ONLY a JSON object of the shape ' +
      '{"verdict":"met"|"not_met"|"refused"|"impossible","reason":"..."}. No prose outside the JSON.',
  ].join('\n');
}

/**
 * Build the host's `evaluateGoal` dependency from the SDK backend + OAuth
 * gate. The returned function is resilient: it wraps the whole one-shot in
 * try/catch, aborts after `GOAL_EVAL_TIMEOUT_MS`, and always resolves to a
 * parsed `{ verdict, reason }` or null (never throws, never hangs).
 */
export function makeGoalEvaluator(
  opts: MakeGoalEvaluatorOptions,
): (input: GoalEvalInput) => Promise<GoalEvalResult | null> {
  return async function evaluateGoal(input: GoalEvalInput): Promise<GoalEvalResult | null> {
    const judge = opts.settings?.() ?? {
      prompt: DEFAULT_GOAL_EVAL_PROMPT,
      model: GOAL_EVAL_MODEL,
    };
    const model = judge.model;
    const auth = await opts.resolveOAuth(model);
    if (!auth.ok) {
      opts.logger?.warn(
        { chatId: input.chatId, reason: auth.reason },
        'goal eval: no credential available',
      );
      return null;
    }
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), GOAL_EVAL_TIMEOUT_MS);
    try {
      let finalText = '';
      let deltaText = '';
      for await (const env of opts.sdkBackend.run({
        prompt: buildPrompt(input, judge.prompt),
        cwd: input.folder,
        resumeSessionId: undefined,
        abortController,
        oauthAccessToken: auth.accessToken,
        model,
        permissionMode: 'bypassPermissions',
      })) {
        if (env.type === 'assistant' && env.content) finalText += env.content;
        else if (env.type === 'assistant_delta' && env.content) deltaText += env.content;
        else if (env.type === 'error') {
          throw new Error(env.errorMessage ?? 'goal eval: SDK error envelope');
        }
      }
      return parseGoalVerdict(finalText !== '' ? finalText : deltaText);
      // No catch here for the same reason `titleGen`/`statusGen` have none: a
      // failure belongs to the outer catch below, which never guesses at what
      // a spent account vs. a real error means — it just returns null either way.
    } catch (err) {
      if (abortController.signal.aborted) {
        opts.logger?.warn(
          { chatId: input.chatId },
          `goal eval: no answer within ${GOAL_EVAL_TIMEOUT_MS}ms`,
        );
        return null;
      }
      opts.logger?.warn({ chatId: input.chatId, err: (err as Error).message }, 'goal eval failed');
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Render a bounded `role: content` transcript for the evaluator prompt. */
export function renderGoalTranscript(
  messages: ReadonlyArray<{ role: 'user' | 'assistant' | 'system'; content: string }>,
  maxChars = 6000,
): string {
  const lines = messages.map((m) => `${m.role}: ${m.content}`);
  let text = lines.join('\n\n');
  if (text.length > maxChars) text = `…\n${text.slice(text.length - maxChars)}`;
  return text;
}
