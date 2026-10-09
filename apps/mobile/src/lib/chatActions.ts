// Pure derivation of the chat-detail ⋯ menu (spec/15 § Chat detail), in
// parity with desktop's header actions (packages/web/src/components/
// ChatHeader.tsx): New chat, Call, Tools, Show (a hidden chat), Pin, Snooze,
// Archive, Disable, and Delete last. Each item appears only where it applies:
//
// - Manager / Speakers occupy fixed slots, so they cannot be pinned,
//   snoozed, archived or deleted — but they CAN be turned off (Disable, spec/06
//   § Disabled) or have their session rotated (Clear context, spec/06 §
//   Session rotation), and still start a new chat.
// - The read-only mirror (Speakers) has no call and nothing a tool
//   switch could gate, so it drops Call and Tools too.
//
// The raw wire event log is NOT reachable from the chat view — it is a
// developer surface available via the CLI (`patch history` / `patch doctor`).

import { isReadOnlyMirrorThread, isReservedSpecialThread } from '@patch/wire';

export interface ChatMenuState {
  pinned: boolean;
  /**
   * The DERIVED snooze state (spec/04 § Snooze), not a stored flag — pass
   * `isSnoozed(row)` so a lapsed wake time offers Snooze again rather than an
   * Unsnooze that would clear nothing.
   */
  snoozed: boolean;
  archived: boolean;
  /**
   * The DERIVED hidden state (spec/04 § Hidden) — pass `isHidden(row)`, so an
   * archived chat that keeps the flag is not offered Show.
   */
  hidden: boolean;
  /** A special thread turned off (spec/06 § Disabled). */
  disabled: boolean;
}

export function chatKebabItems(chatId: string, state: ChatMenuState): string[] {
  const items = ['New chat'];
  if (!isReadOnlyMirrorThread(chatId)) items.push('Call', 'Tools');
  if (isReservedSpecialThread(chatId)) {
    items.push(state.disabled ? 'Enable' : 'Disable', 'Clear context');
    return items;
  }
  if (state.hidden) items.push('Show chat');
  items.push(
    state.pinned ? 'Unpin chat' : 'Pin chat',
    state.snoozed ? 'Unsnooze chat' : 'Snooze chat',
    state.archived ? 'Unarchive chat' : 'Archive chat',
    'Move to…',
    'Delete chat',
  );
  return items;
}
