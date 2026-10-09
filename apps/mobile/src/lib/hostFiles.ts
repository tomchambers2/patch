// Host files and terminal — the pure half (spec/15 § Host files and terminal).
//
// Both screens start somewhere on ONE host: its home directory, or one of the
// project folders that host has published (spec/04 § Folders). This module
// decides that list, the routes between the screens, and how an editor save's
// refusal is told apart from any other failure.

import { ApiError } from '../api/rest';

/**
 * The quick-pick list for a host: its project roots, then its recent folders,
 * each once, in that order. Home is not in it — every screen offers Home on its
 * own, first, because it is the one place that always exists.
 */
export function startFolders(roots: readonly string[], recent: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of [...roots, ...recent]) {
    if (seen.has(f)) continue;
    seen.add(f);
    out.push(f);
  }
  return out;
}

/** A save refused because the file changed on disk since it was opened. */
export function isSaveConflict(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409;
}

/** A byte count as a person reads it: `812 B`, `4.2 KB`, `1.3 MB`. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The path of `name` inside directory `dir` (both absolute, `/` included). */
export function childPath(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

export function filesRoute(daemonId: string, path?: string) {
  return {
    pathname: '/hosts/[daemonId]/files' as const,
    params: path === undefined ? { daemonId } : { daemonId, path },
  };
}

export function editRoute(daemonId: string, path: string) {
  return { pathname: '/hosts/[daemonId]/edit' as const, params: { daemonId, path } };
}

export function terminalRoute(daemonId: string, folder?: string, command?: string) {
  return {
    pathname: '/hosts/[daemonId]/terminal' as const,
    params: {
      daemonId,
      ...(folder === undefined ? {} : { folder }),
      ...(command === undefined ? {} : { command }),
    },
  };
}
