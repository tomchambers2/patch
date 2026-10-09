// Session-handoff digest (spec/06 § Session rotation; spec/04 § History —
// "switch and compact").
//
// Two callers, the same mechanism: a scheduled rotation retires a special
// thread's underlying session and starts a fresh one (letting it run forever
// is what put Manager on ~750k cached tokens a turn with no compaction in
// sight — see spec/06 for the numbers that motivated this), and a provider
// switch's optional compact path hands the target a small context instead of
// the whole track. Starting either fresh with NOTHING carried over would lose
// every standing fact worth keeping, so both ask the OUTGOING session —
// resumed, not re-fed from scratch — to write its own handoff first. Resuming
// rides the session's existing prompt cache, which is why this is cheap even
// though the outgoing history is not: the alternative (re-injecting the
// transcript into a fresh one-shot call) pays for that whole history again
// just to summarise it.
//
// NO FALLBACK: any failure — OAuth miss, SDK error, timeout, empty reply —
// resolves to null. `rotateThread` skips the rotation for this cycle; a
// provider switch's compact path fails the SWITCH loudly instead of silently
// reconstructing in full (chatRunner.ts `buildCompactSwitchTrack`) — either
// way, nobody starts a fresh context with a guessed or empty digest.

import type { SdkBackend } from './sdkBackend.js';
import type { RunOnAccountWithCredit } from './accountFailover.js';
import type { Logger } from 'pino';

/** Abort a hung digest call so it never leaks a warm SDK query. */
const DIGEST_TIMEOUT_MS = 60_000;

/** Hard cap on the returned digest — a handoff note, not a transcript. */
const MAX_DIGEST_LEN = 2000;

export interface GenerateDigestInput {
  chatId: string;
  /** The outgoing session to resume and ask for a self-summary. */
  resumeSessionId: string;
  folder: string;
  /**
   * The session's own model, so `sdkBackend` (when it's the harness-routed
   * backend `index.ts` builds) resumes it on the RIGHT harness — a Codex
   * `resumeSessionId` needs `model` to start with `openai/` or the routed
   * backend sends it to Claude instead, which is not simply the wrong
   * answer but a resume of a session id the Claude SDK won't recognize at
   * all. Special-thread rotation (`rotateThread`) is Claude-only and omits
   * this; a provider switch's own compact path (`chatRunner.ts`
   * `buildCompactSwitchTrack`) always passes it.
   */
  model?: string | null;
}

export interface MakeDigestGeneratorOptions {
  sdkBackend: SdkBackend;
  runOnAccountWithCredit: RunOnAccountWithCredit;
  logger?: Logger;
}

const DIGEST_PROMPT = [
  'Your session is about to be rotated: a fresh session takes over right after',
  'this reply, seeded with whatever you write here and nothing else — none of',
  'this conversation carries over on its own.',
  '',
  'Write a concise handoff for your replacement: standing facts worth knowing,',
  "anything genuinely open or in progress, and preferences you've learned",
  '(not a recap of what was said). Plain prose, no markdown headers, no',
  'preamble — just the handoff itself, a few short paragraphs at most.',
].join('\n');

/**
 * Build the host's `generateDigest` dependency from the SDK backend + OAuth
 * gate. Resilient: wraps the whole one-shot in the account-failover gate,
 * aborts after `DIGEST_TIMEOUT_MS`, and always resolves to a trimmed digest
 * string or null (never throws, never hangs).
 */
export function makeDigestGenerator(
  opts: MakeDigestGeneratorOptions,
): (input: GenerateDigestInput) => Promise<string | null> {
  return async function generateDigest(input: GenerateDigestInput): Promise<string | null> {
    return await opts.runOnAccountWithCredit(
      `rotation digest ${input.chatId}`,
      async (accessToken) => {
        const abortController = new AbortController();
        const timer = setTimeout(() => abortController.abort(), DIGEST_TIMEOUT_MS);
        try {
          // Same delta/final duality statusGen and titleGen already handle: the
          // real SDK streams a turn twice (deltas + a final assistant message).
          let finalText = '';
          let deltaText = '';
          for await (const env of opts.sdkBackend.run({
            prompt: DIGEST_PROMPT,
            cwd: input.folder,
            resumeSessionId: input.resumeSessionId,
            abortController,
            oauthAccessToken: accessToken,
            permissionMode: 'bypassPermissions',
            ...(input.model ? { model: input.model } : {}),
          })) {
            if (env.type === 'assistant' && env.content) finalText += env.content;
            else if (env.type === 'assistant_delta' && env.content) deltaText += env.content;
            else if (env.type === 'error') {
              throw new Error(env.errorMessage ?? 'rotation digest: SDK error envelope');
            }
          }
          const text = (finalText !== '' ? finalText : deltaText).trim();
          if (text === '') return null;
          return text.length > MAX_DIGEST_LEN
            ? `${text.slice(0, MAX_DIGEST_LEN - 1).trimEnd()}…`
            : text;
        } finally {
          clearTimeout(timer);
        }
      },
    );
  };
}
