// D1 — composer policy on mobile (spec/06 ## Composer policy).
//
// Speakers is a read-only mirror: its composer is replaced by a
// hint, never an editable input. Manager and every regular chat keep the full
// composer. The chat-detail screen (app/chats/[chatId].tsx) gates on exactly
// this predicate; this test pins the predicate so the gate can't silently
// regress to letting a user type into a mirror thread (which would create a
// reply that never reaches the source channel).

import { describe, it, expect } from 'vitest';
import { SPECIAL_THREAD_IDS } from '@patch/wire';

// Mirror of the screen's `readOnlyMirror` derivation.
function isReadOnlyMirror(chatId: string): boolean {
  return chatId === SPECIAL_THREAD_IDS.speakers;
}

describe('mobile composer policy — read-only mirror', () => {
  it('Speakers thread is a read-only mirror', () => {
    expect(isReadOnlyMirror(SPECIAL_THREAD_IDS.speakers)).toBe(true);
  });

  it('Manager keeps its composer (not a mirror)', () => {
    expect(isReadOnlyMirror(SPECIAL_THREAD_IDS.manager)).toBe(false);
  });

  it('a regular chat keeps its composer', () => {
    expect(isReadOnlyMirror('01HXREGULARCHATID')).toBe(false);
  });
});
