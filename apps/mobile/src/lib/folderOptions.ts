// Folder-picker option list (spec/04 § Folders, spec/15 § New chat flow /
// § Job editor). The picker offers, in order: the host-owned folder
// list FIRST (the folders the host published — a folder that exists there is
// one tap away), then folders seen in the surface's own chats, deduped. The
// user taps a known folder; a clearly-secondary custom-path field remains for a
// genuine ad-hoc path but is never the primary path.
//
// Pure so both pickers share it and the ordering is unit-tested independently
// of React Native.
//
// The `chatFolders` recents are filtered through the shared `isJunkFolder` rule
// (spec/04 § Folders) so scratch dirs (`/tmp`) and the host's internal
// `.patch/threads/*` thread dirs never surface as pickable folders. The
// host-published `daemonFolders` are already filtered at source (the host
// registry applies the SAME rule), so they pass through untouched.

import { isJunkFolder } from '@patch/wire';

/**
 * Build the ordered, de-duped folder option list: host folders first, then
 * (junk-filtered) chat folders. Empty/blank entries are dropped.
 */
export function folderOptions(daemonFolders: string[], chatFolders: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const recents = chatFolders.filter((f) => !isJunkFolder(f));
  for (const f of [...daemonFolders, ...recents]) {
    if (f && !seen.has(f)) {
      seen.add(f);
      out.push(f);
    }
  }
  return out;
}

/**
 * The picker's default selection: the most-recently-used folder (spec/15 —
 * "defaults to the most-recently-used"). `chatFolders` is expected in
 * most-recent-first order; junk recents are skipped. When there are no real
 * chat folders yet we fall back to the first host folder so a fresh install
 * still defaults to a known folder. Returns '' when nothing is known (the
 * custom-path field takes over).
 */
export function defaultFolder(daemonFolders: string[], chatFolders: string[]): string {
  const firstChat = chatFolders.find((f) => f && !isJunkFolder(f));
  if (firstChat) return firstChat;
  return daemonFolders.find((f) => f) ?? '';
}
