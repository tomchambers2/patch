// A text paste this long is attached as a document instead of filling the
// input (spec/15 § Composer). RN's TextInput has no paste event, so a paste is
// recognised as ONE change that grows the text by at least this many chars.
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

/** The block inserted by `prev` → `next`, and the text left once it is removed. */
export function extractLongPaste(
  prev: string,
  next: string,
): { inserted: string; remaining: string } | null {
  if (next.length - prev.length < LONG_PASTE_CHARS) return null;
  let start = 0;
  const max = Math.min(prev.length, next.length);
  while (start < max && prev[start] === next[start]) start++;
  let end = 0;
  while (end < prev.length - start && prev[prev.length - 1 - end] === next[next.length - 1 - end])
    end++;
  const inserted = next.slice(start, next.length - end);
  return { inserted, remaining: next.slice(0, start) + next.slice(next.length - end) };
}
