// Remembered open/closed state of the Chats tab's collapsible sections
// (spec/15 ## Chats tab). Persisted in MMKV — the same store the credential and
// the last-used skill live in — so a section the user opened stays open across
// launches. One boolean key per section; no key yet means the section has never
// been toggled, and the caller's spec default applies.

import { store } from './credential';

export type CollapsibleSection =
  | 'channels'
  | 'hidden'
  | 'snoozed'
  | 'archived'
  | 'jobsExpired'
  | 'jobsArchived';

const SECTION_OPEN_PREFIX = 'patch.chats.sectionOpen:';

/** Whether `section` is expanded — the stored choice, else `initial`. */
export function getSectionOpen(section: CollapsibleSection, initial: boolean): boolean {
  const v = store().getBoolean(SECTION_OPEN_PREFIX + section);
  return v === undefined ? initial : v;
}

export function setSectionOpen(section: CollapsibleSection, open: boolean): void {
  store().set(SECTION_OPEN_PREFIX + section, open);
}
