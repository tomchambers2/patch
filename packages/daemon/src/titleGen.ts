// AI chat-title summariser (spec/04 § Name).
//
// Builds the `generateTitle` dependency the host fires once per chat as soon
// as the chat's first user message is accepted — it does not wait for the
// turn to settle, so a long-running first turn never delays the title. A
// cheap, fast one-shot Claude query (Haiku) reads that message and returns a
// short Title-Case label. NO FALLBACK: any failure — OAuth miss, SDK error,
// timeout, empty reply — resolves to null, and the host leaves the chat
// unnamed (client shows folder / "New chat"), logged.

import type { SdkBackend } from './sdkBackend.js';
import type { RunOnAccountWithCredit } from './accountFailover.js';
import type { OAuthCheckResult } from './chatRunner.js';
import { isCodexModel } from './codexAccounts.js';
import type { Logger } from 'pino';

/** Cheap + fast model for the one-shot summariser (spec/04 § Name). */
export const TITLE_MODEL = 'claude-haiku-4-5-20251001';

/** Abort a hung title call so it never leaks a warm SDK query. */
const TITLE_TIMEOUT_MS = 20_000;

/** Hard cap on the returned title. */
const MAX_TITLE_LEN = 48;

export interface GenerateTitleInput {
  chatId: string;
  firstUserMessage: string;
  folder: string;
  /** The chat's own model, if it has one — a Codex chat is titled on its own model. */
  chatModel?: string;
}

export interface MakeTitleGeneratorOptions {
  sdkBackend: SdkBackend;
  /**
   * The host's AI-call gate (spec/10-auth.md § Backend credentials). Runs
   * the one-shot on whichever stored account has credit, walking to the next
   * when the provider says one is spent, and resolving to null when none can
   * answer.
   */
  runOnAccountWithCredit: RunOnAccountWithCredit;
  /**
   * How a Codex (ChatGPT) chat is titled: on ITS OWN model through the routed
   * backend and the model-aware credential gate, because a Codex-only host has
   * no Claude account for `runOnAccountWithCredit` to find.
   */
  codex?: {
    sdkBackend: SdkBackend;
    resolveOAuth: (model?: string) => OAuthCheckResult | Promise<OAuthCheckResult>;
  };
  logger?: Logger;
}

/**
 * Coerce a raw model reply into a safe, short chat title, or null when nothing
 * usable remains. Takes the first line, strips surrounding quotes/backticks,
 * collapses whitespace, drops trailing punctuation, and caps the length.
 */
export function sanitizeTitle(raw: string): string | null {
  if (raw.trim() === '') return null;
  // First line only — the model sometimes adds a second explanatory line.
  /* v8 ignore next -- String.split() always returns >=1 element, so [0] is never undefined; the `?? ''` fallback is unreachable defensive code. */
  let t = (raw.split(/\r?\n/)[0] ?? '').trim();
  // Strip surrounding quotes/backticks (straight + smart).
  t = t.replace(/^["'`“”‘’]+/, '').replace(/["'`“”‘’]+$/, '');
  // Collapse internal whitespace.
  t = t.replace(/\s+/g, ' ').trim();
  // Drop trailing punctuation.
  t = t.replace(/[.,;:!?–—-]+$/, '').trim();
  if (t === '') return null;
  if (t.length > MAX_TITLE_LEN) t = `${t.slice(0, MAX_TITLE_LEN - 1).trimEnd()}…`;
  /* v8 ignore next -- `t` is already known non-empty (checked above) and the length-cap branch can only shorten it, never blank it, so the null side of this ternary is unreachable. */
  return t === '' ? null : t;
}

function buildPrompt(input: GenerateTitleInput): string {
  return [
    'Summarise this chat as a short title.',
    '',
    `First user message: ${input.firstUserMessage}`,
    '',
    'Reply with ONLY a concise chat title of 2-6 words in Title Case. No ' +
      'surrounding quotes, no trailing punctuation, no file paths or URLs, no markdown.',
  ].join('\n');
}

/**
 * Build the host's `generateTitle` dependency from the SDK backend + OAuth
 * gate. The returned function is resilient: it wraps the whole one-shot in
 * try/catch, aborts after `TITLE_TIMEOUT_MS`, and always resolves to a
 * sanitized title or null (never throws, never hangs).
 */
async function runTitleQuery(
  sdkBackend: SdkBackend,
  accessToken: string,
  model: string,
  input: GenerateTitleInput,
): Promise<string | null> {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), TITLE_TIMEOUT_MS);
  try {
    // The real SDK streams a turn twice (deltas + a final assistant message).
    // Prefer the authoritative final message; fall back to assembled deltas
    // for a delta-only backend.
    let finalText = '';
    let deltaText = '';
    for await (const env of sdkBackend.run({
      prompt: buildPrompt(input),
      cwd: input.folder,
      resumeSessionId: undefined,
      abortController,
      oauthAccessToken: accessToken,
      model,
      permissionMode: 'bypassPermissions',
    })) {
      if (env.type === 'assistant' && env.content) finalText += env.content;
      else if (env.type === 'assistant_delta' && env.content) deltaText += env.content;
      else if (env.type === 'error') {
        // Thrown, not returned: the runner reads the provider's own words to
        // tell "this account is spent" (try the next one) from a real error.
        throw new Error(env.errorMessage ?? 'title gen: SDK error envelope');
      }
    }
    return sanitizeTitle(finalText !== '' ? finalText : deltaText);
    // No catch: a failure belongs to the caller, which decides from the
    // provider's message whether another account is worth trying. Swallowing
    // it here is what made a spent account look like an empty answer.
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the host's `generateTitle` dependency from the SDK backend + OAuth
 * gate. The returned function aborts after `TITLE_TIMEOUT_MS` and resolves to
 * a sanitized title or null; a provider failure propagates to the host, which
 * retries and logs it.
 */
export function makeTitleGenerator(
  opts: MakeTitleGeneratorOptions,
): (input: GenerateTitleInput) => Promise<string | null> {
  return async function generateTitle(input: GenerateTitleInput): Promise<string | null> {
    if (isCodexModel(input.chatModel)) {
      const model = input.chatModel!;
      if (!opts.codex) {
        opts.logger?.warn({ chatId: input.chatId }, 'title gen: no Codex backend configured');
        return null;
      }
      const auth = await opts.codex.resolveOAuth(model);
      if (!auth.ok) {
        opts.logger?.warn(
          { chatId: input.chatId, reason: auth.reason },
          'title gen: no Codex credential available',
        );
        return null;
      }
      return await runTitleQuery(opts.codex.sdkBackend, auth.accessToken, model, input);
    }
    return await opts.runOnAccountWithCredit(`title gen ${input.chatId}`, (accessToken) =>
      runTitleQuery(opts.sdkBackend, accessToken, TITLE_MODEL, input),
    );
  };
}
