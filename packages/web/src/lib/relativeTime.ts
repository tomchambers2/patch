// One relative-time format, shared by the jobs list and the version panel.
//
// Extracted from JobsRoute because the version panel leans on exactly the
// same property: a column that stays RELATIVE for every row never switches to an
// absolute date partway down, so "deployed 8d ago" sitting next to "started 2h
// ago" reads as the discrepancy it is. That contrast is the whole diagnostic — an
// absolute date on one row would bury it.

export interface RelativeTimeOptions {
  /**
   * Rendered for a timestamp in the future. Jobs mean "not yet run"
   * (`scheduled`); build timestamps mean trivial clock skew (`just now`).
   */
  futureLabel?: string;
  /** Injected for deterministic tests. */
  now?: number;
}

export function relativeTime(ms: number, opts: RelativeTimeOptions = {}): string {
  const delta = (opts.now ?? Date.now()) - ms;
  if (delta < 0) return opts.futureLabel ?? 'scheduled';
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)}d ago`;
  if (delta < 30 * 86_400_000) return `${Math.floor(delta / (7 * 86_400_000))}w ago`;
  if (delta < 365 * 86_400_000) return `${Math.floor(delta / (30 * 86_400_000))}mo ago`;
  return `${Math.floor(delta / (365 * 86_400_000))}y ago`;
}

/**
 * Same, for an ISO instant. Returns the `never` sentinel for null/undefined —
 * "we have no timestamp" must never render as a plausible-looking time.
 */
export function relativeIso(
  iso: string | null | undefined,
  opts: RelativeTimeOptions & { neverLabel?: string } = {},
): string {
  if (!iso) return opts.neverLabel ?? 'never';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return 'unknown';
  return relativeTime(ms, { futureLabel: 'just now', ...opts });
}
