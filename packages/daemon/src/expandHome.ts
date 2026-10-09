// Tilde expansion for workspace paths (spec/04 § Folders).
//
// Every "type a path" field (new chat, job editor, registered project roots)
// and every folder a chat is moved into accepts a raw string typed by a
// person, who types paths the way their shell accepts them — `~` for home.
// Node's fs functions never do this expansion: `statSync('~/projects/x')`
// looks for a literal directory named `~` and fails. NO FALLBACK — this is
// not a workaround, it is the same normalisation every shell already does
// before a path reaches a syscall, applied once here so every host entry
// point that accepts a raw workspace path gets it for free.

import { homedir } from 'node:os';
import { join } from 'node:path';

/** Expand a leading `~` (`~` or `~/rest`) to the current user's home directory. */
export function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}
