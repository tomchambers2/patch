// Tiny per-key sliding-window rate limiter for cross-chat tools.
//
// Per spec/06 and the group 9 task brief: patch_send_to / patch_spawn /
// patch_stop are throttled to 60 calls / 60s per caller chatId. We don't
// need a Redis dependency for one user on one box — a Map of timestamps is
// sufficient and trivially testable.

export interface RateLimiterOptions {
  /** Window length in ms. */
  windowMs: number;
  /** Max calls per key per window. */
  max: number;
  /** Test hook: clock. */
  now?: () => number;
}

export class RateLimiter {
  private readonly windowMs: number;
  private readonly max: number;
  private readonly now: () => number;
  private readonly hits = new Map<string, number[]>();

  constructor(opts: RateLimiterOptions) {
    this.windowMs = opts.windowMs;
    this.max = opts.max;
    this.now = opts.now ?? ((): number => Date.now());
  }

  /** Returns true when the call is allowed; false when over budget. */
  check(key: string): boolean {
    const t = this.now();
    const cutoff = t - this.windowMs;
    const arr = this.hits.get(key) ?? [];
    // Drop stale.
    let i = 0;
    while (i < arr.length && arr[i]! <= cutoff) i++;
    const fresh = i === 0 ? arr : arr.slice(i);
    if (fresh.length >= this.max) {
      // Persist the trimmed list — no need to add the rejected call.
      this.hits.set(key, fresh);
      return false;
    }
    fresh.push(t);
    this.hits.set(key, fresh);
    return true;
  }

  /**
   * Seconds until `key` may retry, given the current window. Returns the time
   * until the OLDEST in-window hit ages out (which frees one slot), rounded up
   * to whole seconds with a floor of 1 so a `Retry-After` header is always a
   * positive integer. Returns 0 when the key is not currently over budget.
   */
  retryAfterSeconds(key: string): number {
    const t = this.now();
    const cutoff = t - this.windowMs;
    const arr = (this.hits.get(key) ?? []).filter((ts) => ts > cutoff);
    if (arr.length < this.max) return 0;
    const oldest = arr[0]!;
    const msUntilFree = oldest + this.windowMs - t;
    return Math.max(1, Math.ceil(msUntilFree / 1000));
  }

  /** Window length in seconds (for X-RateLimit headers). */
  get windowSeconds(): number {
    return Math.ceil(this.windowMs / 1000);
  }

  /** Max calls per window (for X-RateLimit headers). */
  get maxPerWindow(): number {
    return this.max;
  }
}

export class RateLimitedError extends Error {
  constructor(key: string) {
    super(`rate-limited: ${key}`);
    this.name = 'RateLimitedError';
  }
}
