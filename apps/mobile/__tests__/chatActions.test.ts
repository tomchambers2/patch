// The chat-detail ⋯ menu (spec/15 ## Chat detail) — desktop parity: New chat,
// Call, Tools, Pin, Snooze, Archive, Disable, Clear context, Delete last, each
// only where it applies. The raw wire event log is NOT reachable from the
// chat view.

import { describe, it, expect } from 'vitest';
import { SPECIAL_THREAD_IDS } from '@patch/wire';
import { chatKebabItems } from '../src/lib/chatActions';

const PLAIN = { pinned: false, snoozed: false, archived: false, hidden: false, disabled: false };

describe('chatKebabItems', () => {
  it('a regular chat: New chat, Call, Tools, Pin, Snooze, Archive, Delete — Delete last', () => {
    const items = chatKebabItems('01HXREGULARCHATID', PLAIN);
    expect(items).toEqual([
      'New chat',
      'Call',
      'Tools',
      'Pin chat',
      'Snooze chat',
      'Archive chat',
      'Move to…',
      'Delete chat',
    ]);
    expect(items).not.toContain('Disable');
  });

  it('a pinned / snoozed / archived chat flips each toggle to its undo', () => {
    expect(
      chatKebabItems('01HXREGULARCHATID', {
        ...PLAIN,
        pinned: true,
        snoozed: true,
        archived: true,
      }),
    ).toEqual([
      'New chat',
      'Call',
      'Tools',
      'Unpin chat',
      'Unsnooze chat',
      'Unarchive chat',
      'Move to…',
      'Delete chat',
    ]);
  });

  it('a hidden chat offers Show ahead of the lifecycle toggles (spec/04 § Hidden)', () => {
    expect(chatKebabItems('01HXREGULARCHATID', { ...PLAIN, hidden: true })).toEqual([
      'New chat',
      'Call',
      'Tools',
      'Show chat',
      'Pin chat',
      'Snooze chat',
      'Archive chat',
      'Move to…',
      'Delete chat',
    ]);
  });

  it('Manager: New chat, Call, Tools, Disable, Clear context — never Pin/Snooze/Archive/Delete', () => {
    expect(chatKebabItems(SPECIAL_THREAD_IDS.manager, { ...PLAIN, pinned: true })).toEqual([
      'New chat',
      'Call',
      'Tools',
      'Disable',
      'Clear context',
    ]);
  });

  it('a disabled special thread offers Enable instead', () => {
    expect(chatKebabItems(SPECIAL_THREAD_IDS.manager, { ...PLAIN, disabled: true })).toEqual([
      'New chat',
      'Call',
      'Tools',
      'Enable',
      'Clear context',
    ]);
  });

  it('read-only mirror (Speakers) drops Call and Tools too', () => {
    for (const id of [SPECIAL_THREAD_IDS.speakers]) {
      expect(chatKebabItems(id, PLAIN)).toEqual(['New chat', 'Disable', 'Clear context']);
    }
  });

  it('never offers a "View event log" entry for any chat', () => {
    for (const id of [
      '01HXREGULARCHATID',
      SPECIAL_THREAD_IDS.manager,
      SPECIAL_THREAD_IDS.speakers,
    ]) {
      expect(chatKebabItems(id, PLAIN)).not.toContain('View event log');
    }
  });
});
