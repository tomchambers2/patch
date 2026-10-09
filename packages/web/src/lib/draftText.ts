// What counts as a DRAFT — the one rule, in one place (spec/14 § Composer,
// spec/14 § New chat drafts).
//
// Unsent text is only a draft while there is something in it. Empty is not a
// draft, and neither is whitespace-only: typing and then deleting again leaves
// NOTHING, so nothing is stored, nothing is restored, and nothing is listed in
// the sidebar. Without this the two halves of the feature pull apart — the
// composer remembers what you typed (right), and a chat you emptied back out
// keeps a row advertising a message that isn't there (wrong).
//
// Both draft stores and every surface that lists drafts ask THIS, so the
// question "is there a draft here?" cannot be answered two different ways.

/** True when `text` is a real draft — not empty, not whitespace-only. */
export function hasDraftText(text: string): boolean {
  return text.trim() !== '';
}
