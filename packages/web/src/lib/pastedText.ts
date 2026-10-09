// A text paste this long is attached as a document instead of filling the
// input (spec/14 § Composer). Long dictation lands well under this.
export const LONG_PASTE_CHARS = 10000;

/** `Pasted – <first words>.md`, so several pastes are told apart at a glance. */
export function pastedTextName(text: string): string {
  const words = text
    .replace(/[\\/:*?"<>|#`>\[\]]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .join(' ');
  const head = words.length > 40 ? words.slice(0, 40).trimEnd() + '…' : words;
  return head ? `Pasted – ${head}.md` : 'Pasted text.md';
}
