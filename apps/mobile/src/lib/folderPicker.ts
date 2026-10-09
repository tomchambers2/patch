// The folder picker sheet's pure logic (spec/15 § Folder picker sheet): one
// search box that either filters recents or drives live path completion. Kept
// out of React so it is unit-tested directly; the mirror of web's
// `lib/folderPicker.ts` (spec/14 § New-chat setup row → folder picker).

import { folderName, isJunkFolder } from '@patch/wire';
import type { ChatRow } from '../stores/types';

/** One folder the picker can offer, on one host. */
export interface FolderRecent {
  folder: string;
  daemonId: string;
  /** 0 for a registered root, which is offered but never "recently used". */
  lastUpdated: number;
}

export interface FolderPickerRow extends FolderRecent {
  name: string;
  shortPath: string;
}

/** `/home/tom/x` or `/Users/tom/x` → `~/x`; anything else unchanged. */
export function shortHomePath(path: string): string {
  const m = /^\/(home|Users)\/[^/]+(\/|$)/.exec(path);
  if (!m) return path;
  return `~${path.slice(m[0].length - (m[2] ? 1 : 0))}`;
}

/** Path mode starts the moment the text begins with `/` or `~`. */
export function isPathQuery(query: string): boolean {
  return query.startsWith('/') || query.startsWith('~');
}

/**
 * Every (folder, host) on offer, most recently used first. Chat-derived
 * entries go through `isJunkFolder` and exclude job-spawned chats (a folder
 * only counts as user-chosen when a person picked it); a host's published
 * roots are designations, offered at `lastUpdated: 0`.
 */
export function buildRecentFolders(
  chats: Record<string, ChatRow>,
  hostFolders: Record<string, { roots: string[]; recent: string[] }>,
): FolderRecent[] {
  const byKey = new Map<string, FolderRecent>();
  const add = (folder: string, daemonId: string, lastUpdated: number): void => {
    if (!folder || !daemonId) return;
    const key = `${daemonId}\u0000${folder}`;
    const existing = byKey.get(key);
    if (!existing || existing.lastUpdated < lastUpdated) {
      byKey.set(key, { folder, daemonId, lastUpdated });
    }
  };
  for (const c of Object.values(chats)) {
    if (c.status === 'deleted' || c.jobId || !c.folder || isJunkFolder(c.folder)) continue;
    add(c.folder, c.daemonId, c.lastUpdated);
  }
  for (const [daemonId, h] of Object.entries(hostFolders)) {
    for (const f of h.recent) if (!isJunkFolder(f)) add(f, daemonId, 0);
    for (const f of h.roots) add(f, daemonId, 0);
  }
  return [...byKey.values()].sort((a, b) => b.lastUpdated - a.lastUpdated);
}

/** Rows matching `query` by name or path (case-insensitive), narrowed to a host unless `all`. */
export function filterRows(
  recents: readonly FolderRecent[],
  query: string,
  daemonId: string | 'all',
): FolderPickerRow[] {
  const q = query.trim().toLowerCase();
  const out: FolderPickerRow[] = [];
  for (const r of recents) {
    if (daemonId !== 'all' && r.daemonId !== daemonId) continue;
    const name = folderName(r.folder);
    const shortPath = shortHomePath(r.folder);
    if (q && !name.toLowerCase().includes(q) && !shortPath.toLowerCase().includes(q)) continue;
    out.push({ ...r, name, shortPath });
  }
  return out;
}

export interface PathQuery {
  /** What to pass to the browse API: `~`, `/`, or a path without a trailing `/`. */
  dir: string;
  /** The partial last segment typed after the final `/`. */
  partial: string;
}

/** `~/projects/po` → `{ dir: '~/projects', partial: 'po' }`; `~/` → `{ dir: '~', partial: '' }`. */
export function splitPathQuery(query: string): PathQuery {
  if (query === '~' || query === '/') return { dir: query, partial: '' };
  const idx = query.lastIndexOf('/');
  if (idx === -1) return { dir: query, partial: '' };
  return { dir: query.slice(0, idx) || '/', partial: query.slice(idx + 1) };
}

/** Browse entries whose name starts with the typed partial segment. */
export function filterPathEntries<T extends { name: string }>(entries: T[], partial: string): T[] {
  if (!partial) return entries;
  const p = partial.toLowerCase();
  return entries.filter((e) => e.name.toLowerCase().startsWith(p));
}

/** The text a tapped suggestion completes to: the directory joined to the entry, ready to drill on. */
export function completePath(dir: string, name: string): string {
  return `${dir.endsWith('/') ? dir : `${dir}/`}${name}/`;
}
