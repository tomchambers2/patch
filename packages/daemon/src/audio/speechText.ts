// Speech-text helpers for streaming TTS (spec/07 § Voice reply).
//
// The agent's reply is markdown meant for the eye; spoken aloud, `##`, `**`,
// `---`, table pipes and decorative emoji are noise. Two pure helpers:
//   - stripMarkdownForSpeech: markdown → plain speakable text.
//   - extractSentences: pull COMPLETE sentences out of a growing stream buffer
//     so each can be synthesised the moment it's whole, while the model is still
//     generating later text (the streaming-TTS win).

/** Markdown → plain text suitable for TTS. Idempotent on already-plain text. */
export function stripMarkdownForSpeech(md: string): string {
  let t = md;
  // Fenced code blocks: don't read code aloud — drop entirely.
  t = t.replace(/```[\s\S]*?```/g, ' ');
  // Inline code: keep the words, drop the backticks.
  t = t.replace(/`([^`]+)`/g, '$1');
  // Images / links: keep the visible text only.
  t = t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
  // ATX headings: drop the leading #'s.
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  // Blockquote markers.
  t = t.replace(/^\s{0,3}>\s?/gm, '');
  // Horizontal rules (---, ***, ___) → a pause (space).
  t = t.replace(/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/gm, ' ');
  // Leading list markers (-, *, +, 1.).
  t = t.replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '');
  // Emphasis / bold / strikethrough runs.
  t = t.replace(/(\*\*|__|~~|\*|_)/g, '');
  // Table pipes.
  t = t.replace(/\|/g, ' ');
  // Emoji + dingbats + arrows + symbols (decorative in speech).
  t = t.replace(
    /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{FE00}-\u{FE0F}\u{200D}]/gu,
    '',
  );
  // Collapse whitespace.
  t = t
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
  return t;
}

/**
 * Pull complete sentences out of a growing stream buffer. A sentence is
 * complete at `.`/`!`/`?` FOLLOWED by whitespace (so "3.14" and "e.g." mid-word
 * don't split prematurely) or at a newline (lists/headings speak as units). The
 * trailing partial is returned as `rest` to carry forward until more arrives —
 * flush it explicitly at turn end.
 */
export function extractSentences(buffer: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i++) {
    const c = buffer[i];
    const next = buffer[i + 1];
    const boundary =
      c === '\n' ||
      ((c === '.' || c === '!' || c === '?') && (next === ' ' || next === '\n' || next === '\t'));
    if (boundary) {
      const s = buffer.slice(start, i + 1).trim();
      if (s) sentences.push(s);
      start = i + 1;
    }
  }
  return { sentences, rest: buffer.slice(start) };
}
