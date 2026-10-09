// skillToken — locating `/<skill>` tokens anywhere in the composer text
// (spec/14 § Composer — Skill autocomplete), not just at the start.
//
// The `/` menu used to only ever look at the WHOLE value (`/^\/(\S*)$/`), so
// it opened only when the composer held nothing but the token being typed.
// `activeSlashToken` instead looks at the text up to the CURSOR, so `/` opens
// mid-message too, as long as it begins a word (start of the message, or
// right after whitespace/a newline) and nothing has closed it yet.
//
// Once a token is closed with a space (either by completing it from the menu,
// which always appends one, or by typing the exact name and then a space by
// hand), it stops being "active" and becomes a CHIP instead — `findChipTokens`
// finds every one of those in the whole text, so a chip already typed earlier
// in the message still renders as one even while the cursor is elsewhere.

/** The `/` token currently being typed, if the cursor sits at its end. */
export interface ActiveSlashToken {
  /** Index of the `/` itself. */
  start: number;
  /** Everything typed after the `/` so far (may be empty). */
  query: string;
}

/** A completed `/<name>` token recognised as a skill or built-in command. */
export interface ChipToken {
  /** Index of the `/`. */
  start: number;
  /** Index right after the name (the closing whitespace is not included). */
  end: number;
  name: string;
}

const NAME_PATTERN = '[A-Za-z][\\w-]*';

/**
 * The `/` token the cursor is currently inside/at the end of, wherever in the
 * text it falls — or `null` if the cursor isn't right after an open one.
 * "Open" means: starts at the beginning of the text or right after
 * whitespace/a newline, and runs with no whitespace of its own up to the
 * cursor (so `hey /pl` with the cursor at the end is active; `hey /pl there`
 * with the cursor at the end is not — that `/pl` was already closed).
 */
export function activeSlashToken(text: string, cursor: number): ActiveSlashToken | null {
  const before = text.slice(0, cursor);
  const m = /(^|[\s\n])\/(\S*)$/.exec(before);
  if (!m) return null;
  const query = m[2] ?? '';
  return { start: cursor - query.length - 1, query };
}

/**
 * Every `/<name>` in `text` that is a completed token (word-boundary before
 * the `/`, whitespace right after the name) AND whose name is in
 * `knownNames` — the set of chips to actually render. A name typed but not
 * (or no longer) in the folder's skill list, or not yet followed by
 * whitespace, is plain text instead.
 */
export function findChipTokens(text: string, knownNames: ReadonlySet<string>): ChipToken[] {
  const re = new RegExp(`(^|[\\s\\n])/(${NAME_PATTERN})(?=[\\s\\n])`, 'g');
  const out: ChipToken[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = m[2] ?? '';
    const start = m.index + (m[1]?.length ?? 0);
    if (knownNames.has(name)) out.push({ start, end: start + 1 + name.length, name });
  }
  return out;
}

/**
 * The chip that a Backspace right after it should remove as a single unit —
 * `/<name>` plus the one whitespace character that closed it — or `null` if
 * the cursor (a collapsed caret, not a selection) isn't immediately after
 * one.
 */
export function chipEndingAt(
  text: string,
  cursor: number,
  knownNames: ReadonlySet<string>,
): { start: number } | null {
  const before = text.slice(0, cursor);
  const re = new RegExp(`(^|[\\s\\n])/(${NAME_PATTERN})[ \\n]$`);
  const m = re.exec(before);
  if (!m) return null;
  const name = m[2] ?? '';
  if (!knownNames.has(name)) return null;
  return { start: m.index + (m[1]?.length ?? 0) };
}

/**
 * Replace the active token running from `tokenStart` to `cursor` with the
 * completed `/<name> `, and report where the cursor belongs afterwards —
 * right after the inserted trailing space, ahead of whatever followed the
 * token (spec/14 § Skill autocomplete: completing mid-message leaves the rest
 * of the message in place rather than replacing it).
 */
export function spliceCompletion(
  text: string,
  tokenStart: number,
  cursor: number,
  name: string,
): { text: string; cursor: number } {
  const before = text.slice(0, tokenStart);
  const after = text.slice(cursor);
  const insertion = `/${name} `;
  return { text: `${before}${insertion}${after}`, cursor: before.length + insertion.length };
}

/**
 * Rewrite every `/<name>` in a SENT message whose name is a known skill into a
 * markdown link `[/name](patch-skill:name)` for the transcript to render as a
 * link to its SKILL.md. Unlike `findChipTokens` the name may end the text (a
 * sent message has no trailing space), and fenced/inline code is left alone.
 */
export function linkSkillTokens(text: string, knownNames: ReadonlySet<string>): string {
  if (knownNames.size === 0) return text;
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(
            new RegExp(`(^|[\\s\\n])/(${NAME_PATTERN})(?=[\\s\\n.,;:!?]|$)`, 'g'),
            (m, pre: string, name: string) =>
              knownNames.has(name) ? `${pre}[/${name}](patch-skill:${name})` : m,
          ),
    )
    .join('');
}
