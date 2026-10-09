// AI branch send-back summariser (spec/04 § Send back).
//
// When a side branch sends its conclusion back to its parent track, the quiet
// `From <branch name>:` row carries a short summary of what the branch did —
// generated the same way a tool-run row is (toolRunGen.ts): a cheap one-shot
// Claude query (Haiku) reads what the branch was asked and what it last said,
// and writes one line.
//
// NO FALLBACK: a failure — no account with credit, SDK error, timeout, empty
// reply — THROWS; the caller decides what a failed send-back means (it still
// records the attempt, with the failure as the text, rather than silently
// saying nothing — principles.md § no invisible injection applies here too).

import type { SdkBackend } from './sdkBackend.js';
import type { RunOnAccountWithCredit } from './accountFailover.js';
import type { Logger } from 'pino';

/** Cheap + fast model for the one-shot summariser (same as titleGen/toolRunGen). */
export const BRANCH_SEND_BACK_MODEL = 'claude-haiku-4-5-20251001';

const SEND_BACK_TIMEOUT_MS = 30_000;
/** The row is one line. */
const MAX_SUMMARY_LEN = 160;
const PROSE_SNIPPET_LEN = 1200;

export interface GenerateBranchSendBackInput {
  chatId: string;
  branchId: string;
  folder: string;
  /** What the side branch was asked (its first message). */
  firstMessage: string;
  /** The side branch's own last words, if any. */
  lastAssistantText: string;
}

export interface MakeBranchSendBackSummarizerOptions {
  sdkBackend: SdkBackend;
  runOnAccountWithCredit: RunOnAccountWithCredit;
  logger?: Logger;
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function buildBranchSendBackPrompt(input: GenerateBranchSendBackInput): string {
  return [
    'A side conversation ("branch") just finished and is reporting its',
    'conclusion back to the main conversation it branched from. Write the',
    'one-line summary of what it found or did — like a short status update,',
    'not a transcript.',
    '',
    `It was asked: ${clip(input.firstMessage, PROSE_SNIPPET_LEN) || '(unknown)'}`,
    `It last said: ${clip(input.lastAssistantText, PROSE_SNIPPET_LEN) || '(nothing)'}`,
    '',
    'Say what it concluded, in one sentence, past tense — e.g. "Found three',
    'candidate flights, cheapest is the Tuesday redeye", "Confirmed the bug is',
    'in the retry loop, not the parser". Reply with the summary only: no',
    'quotes, no markdown, no trailing full stop.',
  ].join('\n');
}

/** First non-empty line, stripped of quotes/markdown/trailing stop, capped. */
export function parseBranchSendBackSummary(raw: string): string | null {
  const first = (raw.split(/\r?\n/).find((l) => l.trim() !== '') ?? '').trim();
  const cleaned = first
    .replace(/^[-*#>\s]+/, '')
    .replace(/^["'“‘`]+|["'”’`]+$/g, '')
    .replace(/\*\*/g, '')
    .replace(/[.\s]+$/, '')
    .trim();
  if (cleaned === '') return null;
  return cleaned.length > MAX_SUMMARY_LEN ? `${cleaned.slice(0, MAX_SUMMARY_LEN - 1)}…` : cleaned;
}

export function makeBranchSendBackSummarizer(
  opts: MakeBranchSendBackSummarizerOptions,
): (input: GenerateBranchSendBackInput) => Promise<string> {
  return async function summarizeBranchSendBack(
    input: GenerateBranchSendBackInput,
  ): Promise<string> {
    const summary = await opts.runOnAccountWithCredit(
      `branch send-back ${input.chatId}/${input.branchId}`,
      async (accessToken) => {
        const abortController = new AbortController();
        const timer = setTimeout(() => abortController.abort(), SEND_BACK_TIMEOUT_MS);
        try {
          let finalText = '';
          let deltaText = '';
          for await (const env of opts.sdkBackend.run({
            prompt: buildBranchSendBackPrompt(input),
            cwd: input.folder,
            resumeSessionId: undefined,
            abortController,
            oauthAccessToken: accessToken,
            model: BRANCH_SEND_BACK_MODEL,
            permissionMode: 'bypassPermissions',
          })) {
            if (env.type === 'assistant' && env.content) finalText += env.content;
            else if (env.type === 'assistant_delta' && env.content) deltaText += env.content;
            else if (env.type === 'error') {
              throw new Error(env.errorMessage ?? 'branch send-back: SDK error envelope');
            }
          }
          const parsed = parseBranchSendBackSummary(finalText !== '' ? finalText : deltaText);
          if (parsed === null) throw new Error('the model returned an empty summary');
          return parsed;
        } finally {
          clearTimeout(timer);
        }
      },
    );
    if (summary === null) throw new Error('no Claude account with credit could answer');
    return summary;
  };
}
