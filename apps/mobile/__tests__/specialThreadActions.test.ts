// G6 — special-thread action policy on mobile (spec/15 ## Chats tab + ## Chat
// detail). Manager / Speakers occupy fixed slots: their Pin, Snooze,
// Archive and Delete affordances are HIDDEN (both in the chat-detail ⋯ menu and
// the row context sheet). Their menu still carries what does apply — New chat,
// Call and Tools (not on the read-only mirrors) and Disable (spec/06 §
// Disabled). The raw wire event log is NOT a chat affordance on any thread. The
// server enforces the special-thread policy regardless (wire
// RESERVED_SPECIAL_THREAD_IDS); this pins the predicate the screens gate on.

import { describe, it, expect } from 'vitest';
import { SPECIAL_THREAD_IDS, isReservedSpecialThread } from '@patch/wire';
import { chatKebabItems } from '../src/lib/chatActions';

const LIFECYCLE = [
  'Pin chat',
  'Unpin chat',
  'Snooze chat',
  'Unsnooze chat',
  'Archive chat',
  'Unarchive chat',
  'Move to…',
  'Delete chat',
];

describe('mobile special-thread action policy', () => {
  it('no special thread is ever offered Pin / Snooze / Archive / Delete, in any state', () => {
    for (const id of Object.values(SPECIAL_THREAD_IDS)) {
      if (!isReservedSpecialThread(id)) continue;
      for (const pinned of [false, true])
        for (const snoozed of [false, true])
          for (const archived of [false, true]) {
            const items = chatKebabItems(id, {
              pinned,
              snoozed,
              archived,
              hidden: true,
              disabled: false,
            });
            expect(items.filter((i) => LIFECYCLE.includes(i))).toEqual([]);
            expect(items).toContain('Disable');
          }
    }
  });

  it('a regular chat is never offered Disable / Enable', () => {
    for (const disabled of [false, true]) {
      const items = chatKebabItems('01HXREGULARCHATID', {
        pinned: false,
        snoozed: false,
        archived: false,
        hidden: false,
        disabled,
      });
      expect(items).not.toContain('Disable');
      expect(items).not.toContain('Enable');
    }
  });

  it('isReservedSpecialThread is true for both special threads', () => {
    expect(isReservedSpecialThread(SPECIAL_THREAD_IDS.manager)).toBe(true);
    expect(isReservedSpecialThread(SPECIAL_THREAD_IDS.speakers)).toBe(true);
    expect(isReservedSpecialThread('01HXREGULARCHATID')).toBe(false);
  });
});
