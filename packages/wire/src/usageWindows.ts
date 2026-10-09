// Which rate-limit window can actually stop work.
//
// An account reports three pooled windows — the 5-hour session, the 7-day
// week, and overage. Only the first two are spent: overage is the overflow
// that covers for them, so a rejected overage on its own refuses nothing. It
// means there is nowhere to spill to when one of the other two empties
// (spec/12 § A turn only dies for a reason someone chose).
//
// That matters because extra usage is a paid add-on. An account that has never
// turned it on reports `overage: rejected` for ever, and treating that as a
// refusal made a healthy account at 5% of its session pool render as blocked,
// permanently, with a sentence accusing its owner's organisation of switching
// something off. The rule lives HERE, once, because the host, the auth probe
// and every surface all have to agree on it — three private copies of it is
// exactly how one of them came to drift.

import type { RateLimitWindow } from './events.js';

/** The pools a person draws down. Overage is not one of them. */
export const SPENDABLE_RATE_LIMIT_SCOPES = ['session', 'week'] as const;

export type SpendableRateLimitScope = (typeof SPENDABLE_RATE_LIMIT_SCOPES)[number];

/** Every window an account reports, keyed by pool. */
export type RateLimitWindows = Partial<
  Record<SpendableRateLimitScope | 'overage', RateLimitWindow | undefined>
>;

/**
 * The spendable pool that has run out, if one has — what a refusal should be
 * blamed on, and the only thing worth naming to a person, since it is the one
 * with a reset time they can wait for.
 */
export function refusingRateLimitScope(
  windows: RateLimitWindows | undefined,
): SpendableRateLimitScope | undefined {
  if (!windows) return undefined;
  return SPENDABLE_RATE_LIMIT_SCOPES.find((scope) => windows[scope]?.status === 'rejected');
}

/** True when a spendable pool is refusing work right now. */
export function rateLimitWindowsBlocked(windows: RateLimitWindows | undefined): boolean {
  return refusingRateLimitScope(windows) !== undefined;
}

/**
 * True when this particular window refusing means work has stopped.
 *
 * The per-window form, for a renderer drawing one line at a time: the same
 * `rejected` reads as blocked on the session and as "off" on overage.
 */
export function rateLimitWindowBlocks(
  scope: SpendableRateLimitScope | 'overage',
  window: RateLimitWindow | undefined,
): boolean {
  return window?.status === 'rejected' && scope !== 'overage';
}
