import { describe, it, expect } from 'vitest';
import { InputDedupe } from '../src/dedupe.js';

describe('InputDedupe', () => {
  it('first observation is fresh; duplicate is not', () => {
    const d = new InputDedupe();
    expect(d.observe('acct', 'chat-1', 'local-1', 1000)).toBe(true);
    expect(d.observe('acct', 'chat-1', 'local-1', 1001)).toBe(false);
  });

  it('different chatId or localId is fresh', () => {
    const d = new InputDedupe();
    d.observe('acct', 'chat-1', 'local-1', 1000);
    expect(d.observe('acct', 'chat-2', 'local-1', 1001)).toBe(true);
    expect(d.observe('acct', 'chat-1', 'local-2', 1002)).toBe(true);
  });

  it('evicts entries older than retentionMs', () => {
    const d = new InputDedupe(10_000, 5_000);
    d.observe('a', 'c', 'a', 1000);
    expect(d.observe('a', 'c', 'a', 1500)).toBe(false);
    // Past retention window — old entry evicted, new observation is fresh.
    expect(d.observe('a', 'c', 'a', 7000)).toBe(true);
  });

  it('caps each bucket at maxPerBucket (FIFO inside the bucket)', () => {
    const d = new InputDedupe(3, 60_000);
    d.observe('a', 'c', '1', 1);
    d.observe('a', 'c', '2', 2);
    d.observe('a', 'c', '3', 3);
    d.observe('a', 'c', '4', 4);
    // The oldest (1) was dropped — re-observing it is fresh.
    expect(d.observe('a', 'c', '1', 5)).toBe(true);
    expect(d.size()).toBeLessThanOrEqual(3);
  });

  it('account A flooding bucket A does not evict account B entries', () => {
    const d = new InputDedupe(5, 60_000);
    d.observe('B', 'chat', 'b1', 1);
    // Flood account A in same chatId.
    for (let i = 0; i < 50; i++) {
      d.observe('A', 'chat', `a${i}`, i + 10);
    }
    // B's entry must still be deduped.
    expect(d.observe('B', 'chat', 'b1', 1000)).toBe(false);
  });

  it('global cap evicts the LRU bucket entirely', () => {
    const d = new InputDedupe(/*per*/ 100, /*retention*/ 60_000, /*total*/ 5);
    d.observe('A', 'c', '1', 100);
    d.observe('A', 'c', '2', 110);
    d.observe('B', 'c', '1', 120);
    d.observe('B', 'c', '2', 130);
    d.observe('B', 'c', '3', 140);
    // total now 5 — next insert exceeds cap → LRU bucket (A) evicted.
    d.observe('B', 'c', '4', 150);
    expect(d.observe('A', 'c', '1', 200)).toBe(true); // bucket A was evicted
    expect(d.observe('B', 'c', '1', 200)).toBe(false); // bucket B intact
  });

  it('global cap picks the true LRU bucket among 3+ candidates (exercises the "not older" branch)', () => {
    const d = new InputDedupe(/*per*/ 100, /*retention*/ 60_000, /*total*/ 6);
    // Touch order: C (oldest), A (middle), B (most recent before the trigger).
    d.observe('C', 'c', '1', 100);
    d.observe('A', 'c', '1', 110);
    d.observe('A', 'c', '2', 120);
    d.observe('B', 'c', '1', 130);
    d.observe('B', 'c', '2', 140);
    d.observe('B', 'c', '3', 150);
    // total now 6 (at cap) — next insert (touches B again) exceeds cap 6 → LRU is C.
    d.observe('B', 'c', '4', 160);
    // Check the SURVIVING bucket (A) first — re-observing an already-seen key
    // is a pure dedupe hit that does NOT grow totalEntries, so it can't itself
    // trigger a second eviction. Confirms A (not the true LRU) was spared.
    expect(d.observe('A', 'c', '1', 200)).toBe(false);
    // C (true LRU) was evicted — this is fresh. (Inserting it does grow
    // totalEntries again and may itself evict the next LRU, so check it last.)
    expect(d.observe('C', 'c', '1', 200)).toBe(true);
  });

  it('evictLruBucket is a no-op when the only bucket is the just-touched (exempt) one', () => {
    // maxTotalEntries smaller than a single bucket's natural size: every
    // insert into the SAME (single) bucket exceeds the cap, but there is no
    // other bucket to evict — evictLruBucket must return without throwing.
    const d = new InputDedupe(/*per*/ 100, /*retention*/ 60_000, /*total*/ 1);
    expect(() => {
      d.observe('A', 'c', '1', 100);
      d.observe('A', 'c', '2', 110);
      d.observe('A', 'c', '3', 120);
    }).not.toThrow();
    // The single bucket is never evicted (it's always the exempt/just-touched one).
    expect(d.bucketCount()).toBe(1);
  });

  it('bucketCount reports the number of live buckets', () => {
    const d = new InputDedupe();
    expect(d.bucketCount()).toBe(0);
    d.observe('A', 'c', '1', 100);
    expect(d.bucketCount()).toBe(1);
    d.observe('B', 'c', '1', 100);
    expect(d.bucketCount()).toBe(2);
  });
});
