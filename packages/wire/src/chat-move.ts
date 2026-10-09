// Moving a chat to another host (spec/04 § Moving a chat to another host) —
// the one piece of choosing where it goes that every surface shares.
//
// The same work usually lives at a different path on each machine
// (`/Users/tom/wpp/Unite` on the Mac, `/home/tom/Unite` on the box), so the
// folder offered first on the target is the one with the same name. If the
// target has none, the first folder it offers is selected so the user never has
// to pick one before moving; any other path can still be chosen or typed.

function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

/** The target folder to offer for a chat now in `sourceFolder`, or `null` when none matches. */
export function suggestMoveFolder(
  sourceFolder: string,
  targetFolders: readonly string[],
): string | null {
  const name = baseName(sourceFolder);
  if (name.length === 0) return null;
  const matches = targetFolders.filter((f) => baseName(f) === name);
  if (matches.length === 0) return null;
  // The shortest path is the project itself rather than a copy nested inside
  // something else (`~/Unite` over `~/worktrees/feature/Unite`).
  return [...matches].sort((a, b) => a.length - b.length || a.localeCompare(b))[0]!;
}

/** The folder to preselect on the target: the same-named one, else the first it offers, else `null`. */
export function defaultMoveFolder(
  sourceFolder: string,
  targetFolders: readonly string[],
): string | null {
  return suggestMoveFolder(sourceFolder, targetFolders) ?? targetFolders[0] ?? null;
}
