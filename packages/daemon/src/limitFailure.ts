// Which failures patch states itself, and what it says about them
// (spec/12 § A turn only dies for a reason someone chose).
//
// Claude Code reports a hit limit TWICE on the same message: as typed fields —
// `error: 'rate_limit'`, `apiErrorStatus: 429`, a `quotaLimits` block with the
// window and its exact `resetsAt` — and as a sentence for a person to read:
//
//   You've hit your monthly spend limit · raise it at
//   claude.ai/settings/usage?from=cc_cli_limit_message · your weekly limit
//   resets Sep 15, 4am (UTC)
//
// Patch already renders the fields: which pool ran out, on which account, how
// full it was, when it lifts, counting down, with the controls that do something
// about it. So the sentence is a SECOND report of a failure that has already
// been reported, and the two disagree — that one names a spend limit nobody
// overspent (it is what the overflow pool's refusal prints) and a weekly reset
// in a zone the reader is not in.
//
// The rule here is therefore not "hide this wording". It is: a failure the
// provider STATED is reported in patch's words, built from what it stated; a
// failure patch has no account of keeps its real message, in full.

import type { LimitFacts } from './sdkBackend.js';

/**
 * A transient 529 "overloaded" response — the server is briefly busy, not a
 * limit anyone reached. Auto-resume backs these off exponentially instead of
 * waiting for a `resetsAt`.
 */
export function isOverloadedError(message: string): boolean {
  const msg = message.toLowerCase();
  return msg.includes('overloaded_error') || msg.includes('api error: 529');
}

/**
 * A usage/rate-limit rejection read out of the error TEXT.
 *
 * The fallback half of the classification, for a provider that sends no
 * structured block — and it earns its place: a hit 5-hour or weekly limit
 * arrives as prose only often enough that matching `usage_limit_exceeded`-style
 * codes alone left the whole park path unreachable for the very case it was
 * written for, twice, in two different wordings.
 */
export function isRateLimitError(message: string): boolean {
  const msg = message.toLowerCase();
  return (
    msg.includes('usage_limit_exceeded') ||
    msg.includes('rate_limit_error') ||
    msg.includes('rate limit exceeded') ||
    msg.includes('too many requests') ||
    msg.includes('hit your limit') ||
    msg.includes('usage limit') ||
    msg.includes('spend limit') ||
    msg.includes('weekly limit') ||
    msg.includes('monthly limit') ||
    isOverloadedError(message)
  );
}

/**
 * The typed kinds that name a limit. `billing_error` is one: it is what the
 * overflow pool's refusal is reported as.
 */
const LIMIT_KINDS = new Set([
  'rate_limit',
  'rate_limit_error',
  'usage_limit_exceeded',
  'billing_error',
]);

/** A failure the provider stated as a limit, and where that reading came from. */
export interface StatedLimit {
  /** What it stated. Empty when only the sentence said so. */
  facts: LimitFacts;
  from: 'structured' | 'prose';
}

/**
 * Did the provider state this failure as a usage limit?
 *
 * Structure first, and structure WINS: a block saying the account is fine is an
 * answer, not a gap, so the prose behind it is not consulted. A 529 is
 * deliberately not a stated limit — nobody reached one, and patch has no
 * structured account of a busy server beyond the pause itself.
 */
export function statedLimitOf(
  limit: LimitFacts | undefined,
  message: string,
): StatedLimit | undefined {
  if (limit !== undefined) {
    const stated =
      limit.status === 'rejected' ||
      limit.rateLimitType !== undefined ||
      limit.resetsAt !== undefined ||
      (limit.kind !== undefined && LIMIT_KINDS.has(limit.kind));
    return stated ? { facts: limit, from: 'structured' } : undefined;
  }
  if (isOverloadedError(message) || !isRateLimitError(message)) return undefined;
  return { facts: {}, from: 'prose' };
}

/** The window a `rateLimitType` names, in words a person uses. */
function windowWords(rateLimitType: string | undefined): string | undefined {
  if (rateLimitType === undefined) return undefined;
  const t = rateLimitType.toLowerCase();
  if (t.includes('five_hour') || t.includes('session')) return 'session window';
  if (t.includes('seven_day') || t.includes('week')) return 'weekly window';
  return undefined;
}

/** An exact instant with its zone spelled out, and no millisecond noise. */
function instant(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Patch's own one-line account of a stated limit — the message every surface
 * that reports a failure as text shows: the transcript, the chat's last error,
 * the run log of a job whose chat died on it.
 *
 * It opens on "Usage limit reached" deliberately. This sentence is STORED (on
 * `chat_state` and in `meta.json`) and read back later by the sweeps that re-run
 * a failed turn once credit returns, which classify a stored failure by its
 * text — so patch's own wording has to stay recognisable to them.
 */
export function limitFailureMessage(
  stated: StatedLimit,
  opts: { accountLabel?: string; resetsAt?: number } = {},
): string {
  const on = opts.accountLabel === undefined ? '' : ` on ${opts.accountLabel}`;
  const win = windowWords(stated.facts.rateLimitType);
  const which = win === undefined ? '' : ` — the ${win}`;
  // The window's own figure where the caller has one, so this sentence and the
  // structured block it accompanies never state two different instants.
  const resetsAt = opts.resetsAt ?? stated.facts.resetsAt;
  const reset =
    resetsAt === undefined ? 'No reset time was stated.' : `It resets at ${instant(resetsAt)}.`;
  return `Usage limit reached${on}${which}. ${reset}`;
}
