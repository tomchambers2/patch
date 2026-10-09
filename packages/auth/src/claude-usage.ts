// What a Claude account has left, read from Anthropic rather than inferred.
//
// Patch used to learn an account's limits ONLY from the SDK's in-turn
// `rate_limit_event`. That has two holes, and on 2026-09-11 both were open at
// once:
//
//   A BLOCKED ACCOUNT CANNOT REPORT. The event rides on a turn, and an account
//   with no credit cannot run one — so the last reading it ever produced is the
//   one that blocked it, and Settings shows that reading for ever. The screen
//   said "Session: blocked, — · resets Wed 17:58" on a Friday.
//
//   THE OVERAGE WINDOW WAS DISCARDED. The SDK emits `five_hour`, `seven_day`,
//   `seven_day_opus`, `seven_day_sonnet` and `overage`; the translator kept the
//   first two. `overage` is the extra-usage pool, and it is the one whose
//   refusal Claude Code renders as "You've hit your monthly spend limit" — the
//   exact sentence nobody could explain, with no structured counterpart
//   anywhere in patch.
//
// Anthropic answers both on the HTTP response itself. Every `/v1/messages`
// reply carries the whole unified rate-limit header set, and carries it on the
// 429 too — so the reading is available precisely when the account is too spent
// to produce one any other way.
//
// The cost of asking is one `max_tokens: 1` Haiku call. `/v1/models` is free
// but answers only `anthropic-organization-id`; it carries no rate-limit
// headers at all, which is why identity and usage are two different calls here
// and not one.

import { rateLimitWindowsBlocked } from '@patch/wire';

/** Anthropic REST API version header, required on every call. */
const API_VERSION = '2023-06-01';
/** Beta header that lets an OAuth bearer token (not an API key) authenticate. */
const OAUTH_BETA = 'oauth-2025-04-20';
/**
 * Presented as Claude Code, because that is what the credential is: a
 * `claude setup-token` token is scoped to the CLI, and a request that does not
 * look like the CLI is not the request whose limits we want to report.
 */
const USER_AGENT = 'claude-cli/2.0.0 (external, cli)';

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
/** The cheapest authenticated endpoint: auth-only, no inference, no model id. */
export const ANTHROPIC_IDENTITY_URL = 'https://api.anthropic.com/v1/models?limit=1';

/**
 * The model a usage probe spends. Haiku deliberately: the probe is about the
 * ACCOUNT's pooled limits, which are not per-model, so there is no reason to
 * pay Opus rates to read them.
 */
const PROBE_MODEL = 'claude-haiku-4-5-20251001';

/** The header Anthropic stamps on every response, whatever the status. */
export const ORGANIZATION_HEADER = 'anthropic-organization-id';

/**
 * One pooled limit window.
 *
 * `session` is the rolling 5-hour pool, `week` the 7-day one, `overage` the
 * extra-usage pool that the other two spill into when it is enabled. They are
 * independent: on the incident that prompted this file the week sat at 62%
 * `allowed` while the session was at 100% `rejected` and overage was
 * `rejected` with `org_level_disabled_until` — which is to say there was
 * nothing to spill into, which is the whole of what "monthly spend limit"
 * meant.
 */
export type ClaudeUsageScope = 'session' | 'week' | 'overage';

export interface ClaudeUsageWindow {
  status: 'allowed' | 'allowed_warning' | 'rejected';
  /** 0–1. Absent when Anthropic reported the status but not the figure. */
  utilization?: number;
  /** ms-epoch. Absent when Anthropic did not say when this window clears. */
  resetsAt?: number;
  /**
   * Why this window is refusing, when it says. The only value seen in the wild
   * is `org_level_disabled_until` on `overage` — extra usage not enabled on the
   * account — and it is the difference between "you have spent your budget" and
   * "you were never given one", which are not the same message to show a user.
   */
  disabledReason?: string;
}

export interface ClaudeUsageReading {
  /** Which Anthropic organisation this token actually belongs to. */
  organizationId?: string;
  windows: Partial<Record<ClaudeUsageScope, ClaudeUsageWindow>>;
  /**
   * Which window Anthropic itself blames for a refusal
   * (`anthropic-ratelimit-unified-representative-claim`), e.g. `five_hour`.
   * Kept raw: it is Anthropic's vocabulary, and mapping it into ours would
   * lose the cases we have not seen yet.
   */
  representativeClaim?: string;
  /**
   * True when the account is refusing work right now.
   *
   * A rejected `overage` alone does not count: it is the overflow, not a pool
   * anyone spends, and on an account without the extra-usage add-on it is
   * rejected permanently.
   */
  blocked: boolean;
  /** When this reading was taken, ms-epoch. */
  at: number;
}

/**
 * The three things a probe can establish — the same shape, and the same
 * discipline, as token validation.
 *
 * `rejected` is Anthropic refusing the CREDENTIAL (401/403), which is a dead
 * token, not a spent one. A 429 is NOT a rejection: it is a successful reading
 * of an account that happens to be out of credit, and the headers on it are the
 * most useful ones we ever get. `unreachable` keeps an unanswered question
 * unanswered — NO FALLBACK, because a made-up "probably fine" here is what
 * would put a blocked account back at the head of the rotation.
 */
export type ClaudeUsageResult =
  | { kind: 'ok'; reading: ClaudeUsageReading }
  | { kind: 'rejected'; message: string }
  | { kind: 'unreachable'; message: string };

export interface ClaudeUsageOptions {
  /** Injected fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Endpoint override (tests). */
  url?: string;
  /** Clock override (tests). */
  now?: () => number;
}

function num(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function status(headers: Headers, name: string): ClaudeUsageWindow['status'] | undefined {
  const raw = headers.get(name);
  if (raw === 'allowed' || raw === 'allowed_warning' || raw === 'rejected') return raw;
  return undefined;
}

/**
 * Read one window out of the `anthropic-ratelimit-unified-*` header family.
 *
 * Returns undefined when the window's STATUS is absent: a window with a reset
 * time and no status is not a window we can say anything true about, and a
 * half-populated one on screen reads as fact.
 *
 * Resets arrive as unix SECONDS and are returned as ms, because every other
 * instant in patch is ms-epoch and a thousand-fold error in a date is the kind
 * that renders plausibly.
 *
 * A reset of exactly 0 is dropped rather than kept: nobody's window resets in
 * 1970, so it is never a real reading — it is `num()`'s `Number('')` treating
 * an empty header value as a finite 0. Kept, it survives every downstream
 * `!== undefined` guard as a "stated" reset and renders as a ~56-year-old
 * countdown.
 */
function readWindow(headers: Headers, prefix: string): ClaudeUsageWindow | undefined {
  const s = status(headers, `${prefix}-status`);
  if (s === undefined) return undefined;
  const utilization = num(headers, `${prefix}-utilization`);
  const resetsAtSec = num(headers, `${prefix}-reset`);
  const disabledReason = headers.get(`${prefix}-disabled-reason`);
  return {
    status: s,
    ...(utilization !== undefined ? { utilization } : {}),
    ...(resetsAtSec !== undefined && resetsAtSec > 0 ? { resetsAt: resetsAtSec * 1000 } : {}),
    ...(disabledReason !== null && disabledReason.length > 0 ? { disabledReason } : {}),
  };
}

/**
 * Turn an Anthropic response's headers into a usage reading.
 *
 * Exported so the SAME parse can be applied to a response patch did not make
 * itself — a turn's own reply, once the SDK exposes its headers — rather than
 * growing a second, drifting copy of these header names.
 */
export function readUsageHeaders(headers: Headers, at: number): ClaudeUsageReading {
  const P = 'anthropic-ratelimit-unified';
  const windows: Partial<Record<ClaudeUsageScope, ClaudeUsageWindow>> = {};
  const session = readWindow(headers, `${P}-5h`);
  const week = readWindow(headers, `${P}-7d`);
  const overage = readWindow(headers, `${P}-overage`);
  if (session) windows.session = session;
  if (week) windows.week = week;
  if (overage) windows.overage = overage;

  const organizationId = headers.get(ORGANIZATION_HEADER) ?? undefined;
  const representativeClaim = headers.get(`${P}-representative-claim`) ?? undefined;
  // The unified status is Anthropic's own verdict on the account as a whole.
  // Preferred over deriving one from the windows: it already accounts for
  // whichever pool is allowed to cover for another, which is a rule we would
  // otherwise be guessing at.
  const overall = status(headers, `${P}-status`);
  // A rejected OVERAGE is not a refusal. Extra usage is a paid add-on, so an
  // account that never turned it on reports `overage: rejected` for ever, and
  // deriving `blocked` from "any window rejected" overrode Anthropic's own
  // `allowed` verdict and logged a healthy account at 5% of its session pool
  // as blocked. Only the overall verdict, or a spendable pool that has run
  // out, blocks.
  const blocked = overall === 'rejected' || rateLimitWindowsBlocked(windows);

  return {
    ...(organizationId !== undefined ? { organizationId } : {}),
    windows,
    ...(representativeClaim !== undefined ? { representativeClaim } : {}),
    blocked,
    at,
  };
}

/**
 * Ask Anthropic what this token has left.
 *
 * Spends one `max_tokens: 1` Haiku call on a 200; a 429 — the case we most want
 * to read — costs nothing and still carries every header.
 */
export async function fetchClaudeUsage(
  accessToken: string,
  opts: ClaudeUsageOptions = {},
): Promise<ClaudeUsageResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const url = opts.url ?? MESSAGES_URL;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'anthropic-version': API_VERSION,
        'anthropic-beta': OAUTH_BETA,
        'content-type': 'application/json',
        'user-agent': USER_AGENT,
      },
      body: JSON.stringify({
        model: PROBE_MODEL,
        max_tokens: 1,
        // A setup-token credential is only honoured as Claude Code; without
        // this system line Anthropic refuses the OAuth bearer outright.
        system: "You are Claude Code, Anthropic's official CLI for Claude.",
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
  } catch (err) {
    return {
      kind: 'unreachable',
      message: `Could not reach Anthropic to read usage: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (res.status === 401 || res.status === 403) {
    const detail = await res.text().then(
      (t) => t.slice(0, 200),
      () => '',
    );
    return {
      kind: 'rejected',
      message: `Anthropic rejected this token (HTTP ${res.status})${detail ? `: ${detail}` : ''}`,
    };
  }

  // 200 and 429 are both real answers about a live account. Anything else —
  // a 500, a proxy's HTML — is not Anthropic answering the question asked.
  if (res.ok || res.status === 429) {
    const reading = readUsageHeaders(res.headers, now());
    if (Object.keys(reading.windows).length === 0 && reading.organizationId === undefined) {
      return {
        kind: 'unreachable',
        message: `Anthropic answered HTTP ${res.status} with no rate-limit headers`,
      };
    }
    return { kind: 'ok', reading };
  }

  return { kind: 'unreachable', message: `Anthropic could not report usage (HTTP ${res.status})` };
}

/**
 * Which Anthropic organisation a token belongs to, for free.
 *
 * This is the question patch could never answer, and the reason it let the same
 * account be added twice under two labels: `GET /api/oauth/profile` answers 403
 * `oauth_scope_insufficient` for a `claude setup-token` token, so identity
 * looked unknowable and nothing tried. It is not unknowable — it is stamped on
 * every response, including the 200 from the free models endpoint.
 *
 * Two accounts sharing an organisation share one pool of credit. Failing over
 * between them is not failover; it is asking the same account twice.
 */
export async function fetchClaudeOrganizationId(
  accessToken: string,
  opts: ClaudeUsageOptions = {},
): Promise<string | undefined> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = opts.url ?? ANTHROPIC_IDENTITY_URL;
  try {
    const res = await fetchImpl(url, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        'anthropic-version': API_VERSION,
        'anthropic-beta': OAUTH_BETA,
        'user-agent': USER_AGENT,
      },
    });
    return res.headers.get(ORGANIZATION_HEADER) ?? undefined;
  } catch {
    // Identity is an enrichment, not a gate: a token that validates is stored
    // whether or not we could name its organisation. Returning undefined says
    // "not known", which the duplicate check treats as "cannot rule it out"
    // rather than "not a duplicate".
    return undefined;
  }
}
