// Settings → Memories: how one host's Claude Code memory entries are searched,
// filtered by type and grouped by project (design/settings-redesign). Pure, so
// the page and its tests share one definition.

import type { ClaudeMemoryEntry } from '@patch/wire';

/** The type chips, in the design's order. `all` shows every type. */
export const MEMORY_TYPES = ['all', 'user', 'feedback', 'project', 'reference'] as const;
export type MemoryTypeFilter = (typeof MEMORY_TYPES)[number];

/**
 * The project an entry belongs to, as a person reads it: the last folder of
 * the directory it was resolved to on the host, else the encoded name as it is
 * (never decoded by guesswork — the encoding is lossy).
 */
export function memoryProjectLabel(m: ClaudeMemoryEntry): string {
  if (m.projectDir) {
    const parts = m.projectDir.replace(/[\\/]+$/, '').split(/[\\/]/);
    const last = parts[parts.length - 1];
    if (last) return last;
  }
  return m.project;
}

/** What an entry is called: its frontmatter name, else its file name. */
export function memoryTitle(m: ClaudeMemoryEntry): string {
  return m.name.trim() !== '' ? m.name : m.file;
}

/** Entries matching the search text (name, description, body, project) and type. */
export function filterMemories(
  entries: readonly ClaudeMemoryEntry[],
  query: string,
  type: MemoryTypeFilter,
): ClaudeMemoryEntry[] {
  const q = query.trim().toLowerCase();
  return entries.filter((m) => {
    if (type !== 'all' && m.memoryType !== type) return false;
    if (q === '') return true;
    return [m.name, m.description, m.file, m.body ?? '', memoryProjectLabel(m)].some((f) =>
      f.toLowerCase().includes(q),
    );
  });
}

export interface MemoryGroup {
  label: string;
  entries: ClaudeMemoryEntry[];
}

/** Entries grouped by project, largest first, then by name; entries by title. */
export function groupMemories(entries: readonly ClaudeMemoryEntry[]): MemoryGroup[] {
  const byLabel = new Map<string, ClaudeMemoryEntry[]>();
  for (const m of entries) {
    const label = memoryProjectLabel(m);
    const list = byLabel.get(label) ?? [];
    list.push(m);
    byLabel.set(label, list);
  }
  return [...byLabel.entries()]
    .map(([label, list]) => ({
      label,
      entries: [...list].sort((a, b) => memoryTitle(a).localeCompare(memoryTitle(b))),
    }))
    .sort((a, b) => b.entries.length - a.entries.length || a.label.localeCompare(b.label));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * `feedback · portfolio · 13 Sep` — an entry's detail line. The date is left
 * off when the host predates reporting it; the year is added when it is not
 * this year's.
 */
export function memoryMeta(m: ClaudeMemoryEntry, now: number = Date.now()): string {
  const parts = [m.memoryType || 'unknown', memoryProjectLabel(m)];
  if (m.updatedAt !== undefined) {
    const d = new Date(m.updatedAt);
    const sameYear = d.getFullYear() === new Date(now).getFullYear();
    parts.push(`${d.getDate()} ${MONTHS[d.getMonth()]}${sameYear ? '' : ` ${d.getFullYear()}`}`);
  }
  return parts.join(' · ');
}
