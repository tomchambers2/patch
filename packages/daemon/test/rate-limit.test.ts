import { describe, it, expect } from 'vitest';
import { RateLimiter, RateLimitedError } from '../src/rate-limit.js';

describe('RateLimiter', () => {
  it('allows up to max calls in the window', () => {
    let t = 0;
    const rl = new RateLimiter({ windowMs: 1000, max: 3, now: () => t });
    expect(rl.check('k')).toBe(true);
    expect(rl.check('k')).toBe(true);
    expect(rl.check('k')).toBe(true);
    expect(rl.check('k')).toBe(false);
  });

  it('expires hits older than windowMs', () => {
    let t = 0;
    const rl = new RateLimiter({ windowMs: 1000, max: 2, now: () => t });
    rl.check('k');
    rl.check('k');
    expect(rl.check('k')).toBe(false);
    t = 1500;
    expect(rl.check('k')).toBe(true);
  });

  it('defaults to the real Date.now clock when `now` is not provided', () => {
    const rl = new RateLimiter({ windowMs: 60_000, max: 2 });
    expect(rl.check('k')).toBe(true);
    expect(rl.check('k')).toBe(true);
    expect(rl.check('k')).toBe(false);
  });

  it('isolates buckets per key', () => {
    let t = 0;
    const rl = new RateLimiter({ windowMs: 1000, max: 1, now: () => t });
    expect(rl.check('a')).toBe(true);
    expect(rl.check('a')).toBe(false);
    expect(rl.check('b')).toBe(true);
  });

  it('retryAfterSeconds returns time until the oldest hit ages out (C3-d3)', () => {
    let t = 0;
    const rl = new RateLimiter({ windowMs: 60_000, max: 2, now: () => t });
    // Not over budget yet → 0.
    expect(rl.retryAfterSeconds('k')).toBe(0);
    rl.check('k'); // hit at t=0
    t = 10_000;
    rl.check('k'); // hit at t=10000 → now at budget
    // Over budget: oldest hit (t=0) frees at t=60000 → 50s from now (t=10000).
    expect(rl.retryAfterSeconds('k')).toBe(50);
    // Floors at 1s when the oldest hit is about to age out.
    t = 59_999;
    expect(rl.retryAfterSeconds('k')).toBe(1);
    // Window metadata for the X-RateLimit headers.
    expect(rl.windowSeconds).toBe(60);
    expect(rl.maxPerWindow).toBe(2);
  });
});

describe('RateLimitedError', () => {
  it('carries the offending key in its message and a distinct name', () => {
    const err = new RateLimitedError('chat-42');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('RateLimitedError');
    expect(err.message).toBe('rate-limited: chat-42');
  });
});
