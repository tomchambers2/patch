// AI "current status" summariser (patch/todo.md § Features to add — "Current
// status").
//
// After each turn settles, a cheap one-shot Claude query (Haiku) reads the most
// recent exchange and returns a one-line status of the thread plus a KIND that
// distinguishes a thread paused on the USER (a `question` — the agent needs an
// answer to proceed) from one that has merely stopped (`complete` — nothing
// outstanding, the user can pick it up any time). The surface shows the summary
// nested under the chat row and draws the two kinds differently.
//
// NO FALLBACK: any failure — OAuth miss, SDK error, timeout, unparseable reply —
// resolves to null, and the host leaves the chat's status summary unchanged
// (the row just shows no nested summary), logged.

import type { StatusKind } from '@patch/wire';
import type { SdkBackend } from './sdkBackend.js';
import type { RunOnAccountWithCredit } from './accountFailover.js';
import type { Logger } from 'pino';

/** Cheap + fast model for the one-shot status summariser. */
export const STATUS_MODEL = 'claude-haiku-4-5-20251001';

/** Abort a hung status call so it never leaks a warm SDK query. */
const STATUS_TIMEOUT_MS = 20_000;

/** How much of the exchange to feed the summariser. */
const MSG_SNIPPET_LEN = 1500;

/** Hard cap on the returned summary line. */
const MAX_SUMMARY_LEN = 100;

export interface ChatStatusSummary {
  kind: StatusKind;
  summary: string;
}

export interface GenerateStatusInput {
  chatId: string;
  lastUserMessage: string;
  assistantReply: string;
  folder: string;
}

export interface MakeStatusGeneratorOptions {
  sdkBackend: SdkBackend;
  /**
   * The host's AI-call gate (spec/10-auth.md § Backend credentials). Runs
   * the one-shot on whichever stored account has credit, walking to the next
   * when the provider says one is spent, and resolving to null when none can
   * answer.
   */
  runOnAccountWithCredit: RunOnAccountWithCredit;
  logger?: Logger;
}

// Kind prefixes the model is asked to use, plus the synonyms it tends to reach
// for anyway — mapped to the two canonical kinds. A `question` means the agent
// is blocked on the user; `complete` means it simply stopped.
const KIND_MAP: Record<string, StatusKind> = {
  question: 'question',
  waiting: 'question',
  blocked: 'question',
  input: 'question',
  complete: 'complete',
  done: 'complete',
  finished: 'complete',
  stopped: 'complete',
};

/**
 * Coerce a raw model reply into a `{ kind, summary }`, or null when nothing
 * usable remains. The model is asked to answer `KIND: one-line summary`; we take
 * the first line, split off a recognised kind prefix, sanitise the summary body,
 * and cap the length. NO FALLBACK: a reply without a recognised prefix, or with
 * an empty body, yields null (the row shows no nested summary).
 */
export function parseStatus(raw: string): ChatStatusSummary | null {
  if (raw.trim() === '') return null;
  // First line only — the model sometimes adds a second explanatory line.
  const first = (raw.split(/\r?\n/).find((l) => l.trim() !== '') ?? '').trim();
  // `KIND<sep>body` where sep is a colon, hyphen, or (em/en) dash.
  const m = first.match(/^([A-Za-z]+)\s*[:\-–—]\s*(.*)$/);
  if (!m) return null;
  const kind = KIND_MAP[m[1]!.toLowerCase()];
  if (!kind) return null;
  let body = (m[2] ?? '').trim();
  // Strip surrounding quotes/backticks (straight + smart).
  body = body.replace(/^["'`“”‘’]+/, '').replace(/["'`“”‘’]+$/, '');
  body = body.replace(/\s+/g, ' ').trim();
  if (body === '') return null;
  if (body.length > MAX_SUMMARY_LEN) body = `${body.slice(0, MAX_SUMMARY_LEN - 1).trimEnd()}…`;
  return { kind, summary: body };
}

/**
 * The reply's END, not its start: a long reply states its outcome or asks its
 * question last, and a head-only excerpt made the model describe the cut
 * ("response cut off") instead of the agent.
 */
function tail(text: string): string {
  const t = text.trim();
  return t.length > MSG_SNIPPET_LEN ? t.slice(-MSG_SNIPPET_LEN) : t;
}

function buildPrompt(input: GenerateStatusInput): string {
  const user = input.lastUserMessage.slice(0, MSG_SNIPPET_LEN);
  const reply = tail(input.assistantReply);
  return [
    'You are summarising the CURRENT STATUS of an agent chat thread for a',
    'sidebar. Read the most recent exchange and decide whether the agent is now',
    'waiting on the user or has simply finished.',
    '',
    `Most recent user message: ${user}`,
    `Most recent assistant reply (the final part of it): ${reply}`,
    '',
    'Reply with EXACTLY ONE line in the form `KIND: summary`, where KIND is:',
    '- QUESTION if the agent asked the user something / needs a decision or',
    '  input to continue (the thread is paused on the user).',
    '- COMPLETE if the agent finished its turn and nothing is outstanding (the',
    '  user could pick it back up any time, but nothing is required).',
    'The summary is a concise phrase (max ~12 words) saying what the agent did',
    'or said and where things stand, plus any action the user must take. The',
    'text above may begin mid-sentence because only the end is shown: never',
    'mention truncation, excerpts, or the reply being cut off; describe the',
    'agent. No markdown, no quotes, no trailing punctuation.',
  ].join('\n');
}

/**
 * Build the host's `generateStatus` dependency from the SDK backend + OAuth
 * gate. The returned function is resilient: it wraps the whole one-shot in
 * try/catch, aborts after `STATUS_TIMEOUT_MS`, and always resolves to a parsed
 * `{ kind, summary }` or null (never throws, never hangs).
 */
export function makeStatusGenerator(
  opts: MakeStatusGeneratorOptions,
): (input: GenerateStatusInput) => Promise<ChatStatusSummary | null> {
  return async function generateStatus(
    input: GenerateStatusInput,
  ): Promise<ChatStatusSummary | null> {
    return await opts.runOnAccountWithCredit(`status gen ${input.chatId}`, async (accessToken) => {
      const abortController = new AbortController();
      const timer = setTimeout(() => abortController.abort(), STATUS_TIMEOUT_MS);
      try {
        // The real SDK streams a turn twice (deltas + a final assistant message).
        // Prefer the authoritative final message; fall back to assembled deltas
        // for a delta-only backend. Same pattern as `titleGen`.
        let finalText = '';
        let deltaText = '';
        for await (const env of opts.sdkBackend.run({
          prompt: buildPrompt(input),
          cwd: input.folder,
          resumeSessionId: undefined,
          abortController,
          oauthAccessToken: accessToken,
          model: STATUS_MODEL,
          permissionMode: 'bypassPermissions',
        })) {
          if (env.type === 'assistant' && env.content) finalText += env.content;
          else if (env.type === 'assistant_delta' && env.content) deltaText += env.content;
          else if (env.type === 'error') {
            // Thrown, not returned: the runner reads the provider's own words to
            // tell "this account is spent" (try the next one) from a real error.
            throw new Error(env.errorMessage ?? 'status gen: SDK error envelope');
          }
        }
        return parseStatus(finalText !== '' ? finalText : deltaText);
        // No catch: a failure belongs to the runner, which decides from the
        // provider's message whether another account is worth trying. Swallowing
        // it here is what made a spent account look like an empty answer.
      } finally {
        clearTimeout(timer);
      }
    });
  };
}
