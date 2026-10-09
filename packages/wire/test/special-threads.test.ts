// Special-thread predicates (spec/06, spec/14, spec/15). `SPECIAL_THREAD_IDS`
// is the canonical id list; `isReadOnlyMirrorThread` gates the composer for
// Speakers (a read-only mirror); `isReservedSpecialThread` gates the
// "Delete chat" affordance for Manager/Speakers. Shared by server,
// host, and mobile so the rule can't diverge per surface.

import { describe, it, expect } from 'vitest';
import {
  SPECIAL_THREAD_IDS,
  READ_ONLY_MIRROR_THREAD_IDS,
  RESERVED_SPECIAL_THREAD_IDS,
  isReadOnlyMirrorThread,
  isReservedSpecialThread,
} from '../src/index.js';

describe('isReadOnlyMirrorThread', () => {
  it('is true for Speakers', () => {
    expect(isReadOnlyMirrorThread(SPECIAL_THREAD_IDS.speakers)).toBe(true);
  });

  it('is false for Manager (composer fully enabled) and a normal chat', () => {
    expect(isReadOnlyMirrorThread(SPECIAL_THREAD_IDS.manager)).toBe(false);
    expect(isReadOnlyMirrorThread('chat_abc123')).toBe(false);
  });

  it('matches the READ_ONLY_MIRROR_THREAD_IDS set contents', () => {
    expect(READ_ONLY_MIRROR_THREAD_IDS.has(SPECIAL_THREAD_IDS.speakers)).toBe(true);
    expect(READ_ONLY_MIRROR_THREAD_IDS.has(SPECIAL_THREAD_IDS.manager)).toBe(false);
  });
});

describe('isReservedSpecialThread', () => {
  it('is true for Manager and Speakers', () => {
    expect(isReservedSpecialThread(SPECIAL_THREAD_IDS.manager)).toBe(true);
    expect(isReservedSpecialThread(SPECIAL_THREAD_IDS.speakers)).toBe(true);
  });

  it('is false for a normal user-created chat', () => {
    expect(isReservedSpecialThread('chat_abc123')).toBe(false);
    expect(isReservedSpecialThread('')).toBe(false);
  });

  it('is false for the retired Telegram thread, so a leftover one can be archived', () => {
    expect(isReservedSpecialThread('thread_telegram')).toBe(false);
  });

  it('matches the RESERVED_SPECIAL_THREAD_IDS set contents', () => {
    expect(RESERVED_SPECIAL_THREAD_IDS.has(SPECIAL_THREAD_IDS.manager)).toBe(true);
    expect(RESERVED_SPECIAL_THREAD_IDS.has('chat_abc123')).toBe(false);
  });
});
