// Natural-language → RRULE translator for the recurrence trigger's job
// editor (spec/08 § Recurrence). A cheap, fast one-shot Claude query (Haiku)
// reads a phrase like "every 3rd Sunday between May and August" and returns
// a bare RRULE value string — same one-shot pattern as `titleGen.ts` and
// `statusGen.ts` next door (SDK backend + the account-failover credit gate),
// reused here rather than inventing a second way to run a cheap Claude call.
//
// NO FALLBACK: any failure — OAuth miss, SDK error, timeout, an empty or
// unusable reply — resolves to null. This module does NOT itself validate
// RRULE syntax or confirm the result describes cleanly in English; the
// SERVER does both (`packages/server/src/jobs/routes` — `RRule.fromString`
// then `describeRecurrence`) before ever handing a translated rule back to a
// client, because a rule this module cannot confidently produce is exactly
// the case that must fail loudly rather than save something unconfirmed.

import type { SdkBackend } from './sdkBackend.js';
import type { RunOnAccountWithCredit } from './accountFailover.js';
import type { Logger } from 'pino';

/** Cheap + fast model for the one-shot translator (same as titleGen/statusGen). */
export const RECURRENCE_TRANSLATE_MODEL = 'claude-haiku-4-5-20251001';

/** Abort a hung translate call so it never leaks a warm SDK query. */
const RECURRENCE_TRANSLATE_TIMEOUT_MS = 20_000;

export interface TranslateRecurrenceInput {
  requestId: string;
  phrase: string;
  /** cwd for the one-shot SDK session — no project of its own, so the host's own home. */
  folder: string;
}

export interface MakeRecurrenceTranslatorOptions {
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

/**
 * Coerce a raw model reply into a candidate bare RRULE value string, or null
 * when nothing usable remains. Takes the first non-empty line, strips a
 * defensive leading `RRULE:` label and surrounding quotes/backticks the model
 * sometimes adds despite being told not to, and collapses whitespace.
 *
 * This is cleanup only, NOT validation — syntax/semantic checking is the
 * server's job (see this file's header). A garbage reply that survives this
 * function still fails loudly at the server's `RRule.fromString` gate.
 */
export function sanitizeRecurrenceRule(raw: string): string | null {
  if (raw.trim() === '') return null;
  const first = (raw.split(/\r?\n/).find((l) => l.trim() !== '') ?? '').trim();
  let t = first.replace(/^["'`“”‘’]+/, '').replace(/["'`“”‘’]+$/, '');
  t = t.replace(/^RRULE:\s*/i, '');
  t = t.replace(/\s+/g, '').trim();
  return t === '' ? null : t;
}

function buildPrompt(phrase: string): string {
  return [
    'Translate this schedule description into a single RRULE (RFC 5545)',
    'value string for a job scheduler.',
    '',
    `Schedule: ${phrase}`,
    '',
    'Reply with ONLY the bare RRULE value — no `RRULE:` label, no `DTSTART`',
    'line, no markdown, no explanation. Uppercase FREQ/BYDAY/etc keys.',
    'Use only these fields: FREQ (WEEKLY, MONTHLY or YEARLY), BYDAY',
    '(SU/MO/TU/WE/TH/FR/SA), BYSETPOS (1,2,3,4 or -1 for "last") for an',
    'nth-weekday pattern, BYMONTH (1-12, comma-separated) to restrict which',
    'months it fires in, BYHOUR and BYMINUTE for the time of day.',
    'If the phrase does not name a time of day, default to BYHOUR=9;BYMINUTE=0.',
    'If the phrase cannot be expressed with only those fields, reply with',
    'exactly the word UNSURE and nothing else — do not guess or approximate.',
    '',
    'Example: "every 3rd Sunday between May and August" ->',
    'FREQ=MONTHLY;BYDAY=SU;BYSETPOS=3;BYMONTH=5,6,7,8;BYHOUR=9;BYMINUTE=0',
  ].join('\n');
}

/**
 * Build the host's recurrence-translate handler from the SDK backend +
 * OAuth gate. The returned function is resilient: it wraps the whole
 * one-shot in try/catch, aborts after `RECURRENCE_TRANSLATE_TIMEOUT_MS`, and
 * always resolves to a sanitized candidate RRULE string or null (never
 * throws, never hangs) — the caller (the host's `patch.recurrence.translate.request`
 * handler) turns null into an `ok:false` response naming the reason.
 */
export function makeRecurrenceTranslator(
  opts: MakeRecurrenceTranslatorOptions,
): (input: TranslateRecurrenceInput) => Promise<string | null> {
  return async function translateRecurrence(
    input: TranslateRecurrenceInput,
  ): Promise<string | null> {
    return await opts.runOnAccountWithCredit(
      `recurrence translate ${input.requestId}`,
      async (accessToken) => {
        const abortController = new AbortController();
        const timer = setTimeout(() => abortController.abort(), RECURRENCE_TRANSLATE_TIMEOUT_MS);
        try {
          // The real SDK streams a turn twice (deltas + a final assistant
          // message). Prefer the authoritative final message; fall back to
          // assembled deltas for a delta-only backend. Same pattern as titleGen.
          let finalText = '';
          let deltaText = '';
          for await (const env of opts.sdkBackend.run({
            prompt: buildPrompt(input.phrase),
            cwd: input.folder,
            resumeSessionId: undefined,
            abortController,
            oauthAccessToken: accessToken,
            model: RECURRENCE_TRANSLATE_MODEL,
            permissionMode: 'bypassPermissions',
          })) {
            if (env.type === 'assistant' && env.content) finalText += env.content;
            else if (env.type === 'assistant_delta' && env.content) deltaText += env.content;
            else if (env.type === 'error') {
              // Thrown, not returned: the runner reads the provider's own
              // words to tell "this account is spent" (try the next one)
              // from a real error.
              throw new Error(env.errorMessage ?? 'recurrence translate: SDK error envelope');
            }
          }
          const text = finalText !== '' ? finalText : deltaText;
          // The model's own escape hatch for a phrase it can't confidently
          // express in the narrow field set — NO FALLBACK means honouring
          // its refusal, not stripping "UNSURE" down to something shorter
          // and treating that as an answer.
          if (text.trim().toUpperCase() === 'UNSURE') return null;
          return sanitizeRecurrenceRule(text);
          // No catch: a failure belongs to the runner, which decides from the
          // provider's message whether another account is worth trying.
          // Swallowing it here is what made a spent account look like an
          // empty answer (see titleGen.ts).
        } finally {
          clearTimeout(timer);
        }
      },
    );
  };
}
