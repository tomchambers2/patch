// Settings → Memories: search, the type chips and the per-project grouping
// (src/lib/memories.ts).

import { describe, it, expect } from 'vitest';
import type { ClaudeMemoryEntry } from '@patch/wire';
import {
  filterMemories,
  groupMemories,
  memoryMeta,
  memoryProjectLabel,
  memoryTitle,
  MEMORY_TYPES,
} from '../src/lib/memories';

function mem(p: Partial<ClaudeMemoryEntry> & { file: string }): ClaudeMemoryEntry {
  return { project: '-home-tom-portfolio', name: '', description: '', memoryType: 'user', ...p };
}

const nav = mem({
  file: 'nav.md',
  name: 'Android nav bar',
  description: 'never hide the system bar',
  memoryType: 'feedback',
  projectDir: '/home/tom/portfolio',
  body: 'Leave the system navigation bar alone.',
});
const deploy = mem({
  file: 'deploy.md',
  name: 'Deploy order',
  description: 'wire changes ship together',
  memoryType: 'project',
  project: '-home-tom-portfolio-projects-patch',
  projectDir: '/home/tom/portfolio/projects/patch/',
});
const phone = mem({ file: 'phone.md', name: 'Tom’s phone', projectDir: '/home/tom/portfolio' });
const orphan = mem({ file: 'x.md', project: '-gone-folder', memoryType: 'reference' });

describe('memories', () => {
  it('offers the design’s type chips in order', () => {
    expect(MEMORY_TYPES).toEqual(['all', 'user', 'feedback', 'project', 'reference']);
  });

  it('labels a project by the folder it resolved to, else by its encoded name', () => {
    expect(memoryProjectLabel(nav)).toBe('portfolio');
    expect(memoryProjectLabel(deploy)).toBe('patch');
    expect(memoryProjectLabel(orphan)).toBe('-gone-folder');
    expect(memoryProjectLabel(mem({ file: 'r', projectDir: '/', project: 'enc' }))).toBe('enc');
  });

  it('titles an entry by its name, else its file', () => {
    expect(memoryTitle(nav)).toBe('Android nav bar');
    expect(memoryTitle(orphan)).toBe('x.md');
  });

  it('searches name, description, file, body and project, case-insensitively', () => {
    const all = [nav, deploy, phone, orphan];
    expect(filterMemories(all, '', 'all')).toHaveLength(4);
    expect(filterMemories(all, 'NAVIGATION', 'all')).toEqual([nav]);
    expect(filterMemories(all, 'ship together', 'all')).toEqual([deploy]);
    expect(filterMemories(all, 'x.md', 'all')).toEqual([orphan]);
    expect(filterMemories(all, 'patch', 'all')).toEqual([deploy]);
    expect(filterMemories(all, 'zzz', 'all')).toEqual([]);
  });

  it('filters by type, together with the search', () => {
    const all = [nav, deploy, phone, orphan];
    expect(filterMemories(all, '', 'feedback')).toEqual([nav]);
    expect(filterMemories(all, '', 'user')).toEqual([phone]);
    expect(filterMemories(all, 'phone', 'feedback')).toEqual([]);
  });

  it('groups by project, biggest first, entries by title', () => {
    const groups = groupMemories([deploy, phone, nav, orphan]);
    expect(groups.map((g) => [g.label, g.entries.map(memoryTitle)])).toEqual([
      ['portfolio', ['Android nav bar', 'Tom’s phone']],
      ['-gone-folder', ['x.md']],
      ['patch', ['Deploy order']],
    ]);
  });

  it('describes an entry as type · project · date, with the year only when it is not this one', () => {
    const now = new Date(2026, 8, 27).getTime();
    expect(memoryMeta({ ...nav, updatedAt: new Date(2026, 8, 13).getTime() }, now)).toBe(
      'feedback · portfolio · 13 Sep',
    );
    expect(memoryMeta({ ...nav, updatedAt: new Date(2025, 0, 2).getTime() }, now)).toBe(
      'feedback · portfolio · 2 Jan 2025',
    );
    expect(memoryMeta(nav, now)).toBe('feedback · portfolio');
    expect(memoryMeta({ ...orphan, memoryType: '' }, now)).toBe('unknown · -gone-folder');
  });
});
