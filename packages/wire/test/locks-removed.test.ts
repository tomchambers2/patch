// The lock system has been removed, so `locks.updated` is no longer part of the
// wire protocol. Pinning it here because the event is what fed the host-side
// barrier cache — if the event comes back, so has the barrier.

import { describe, it, expect } from 'vitest';
import { decode, isWireEvent, EVENT_SCHEMAS } from '../src/index.js';

describe('locks.updated is not a wire event', () => {
  it('is absent from the event schema registry', () => {
    expect(Object.keys(EVENT_SCHEMAS)).not.toContain('locks.updated');
  });

  it('is rejected by decode', () => {
    const frame = JSON.stringify({ type: 'locks.updated', locks: [] });
    expect(() => decode(frame)).toThrow();
  });

  it('is not recognised as a wire event', () => {
    expect(isWireEvent({ type: 'locks.updated', locks: [] })).toBe(false);
  });
});
