// Skill autocomplete parsing (spec/15 § Composer). Typing `/` opens a list of
// the folder's skills anywhere it begins a word in the draft — see
// `activeSlashToken` below, which is cursor-aware; the menu is active only
// while the token AT THE CURSOR is still open (no closing space yet).

/** Skills whose name starts with `query` (case-insensitive). */
export function filterSkills(skills: string[], query: string): string[] {
  const q = query.toLowerCase();
  return skills.filter((s) => s.toLowerCase().startsWith(q));
}

// spec/15 § Composer — Skill autocomplete: `/` opens the menu anywhere it
// begins a word in the draft, not only when the draft is nothing else, and a
// completed token renders as a chip wherever it falls. `parseSlashQuery`
// above stays as the built-ins-only, whole-value case some callers still
// want; the functions below are cursor-aware and used by the composer itself.

/** The `/` token the cursor is currently inside/at the end of, or `null`. */
export interface ActiveSlashToken {
  /** Index of the `/` itself. */
  start: number;
  query: string;
}

/** A completed `/<name>` token recognised as a skill or built-in command. */
export interface ChipToken {
  start: number;
  /** Index right after the name (the closing whitespace is not included). */
  end: number;
  name: string;
}

const NAME_PATTERN = '[A-Za-z][\\w-]*';

/** Same rule as the web composer's `activeSlashToken` (packages/web/src/lib/skillToken.ts) — kept in sync by hand since the two apps don't share a package. */
export function activeSlashToken(text: string, cursor: number): ActiveSlashToken | null {
  const before = text.slice(0, cursor);
  const m = /(^|[\s\n])\/(\S*)$/.exec(before);
  if (!m) return null;
  const query = m[2] ?? '';
  return { start: cursor - query.length - 1, query };
}

/** Same rule as the web composer's `findChipTokens`. */
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

/** Same rule as the web composer's `chipEndingAt`. */
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

/** Same rule as the web composer's `spliceCompletion`. */
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
