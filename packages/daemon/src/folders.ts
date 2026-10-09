// Host-owned folder registry (spec/04-chats-and-folders.md § Folders).
//
// Folders are DEFINED ON THE HOST — it owns the project filesystem and is the
// only party that knows which folders actually exist. This registry is the
// host's source of truth for the published folder list: a small set of
// user-designated project roots (registered via the CLI / a host control
// call) plus the folders seen in recent chats. The host publishes this list
// to the server (`folders.list` on connect, `folders.updated` on change), which
// relays it to every surface so one consistent picker is populated everywhere
// and a folder that exists on the host is one tap away.
//
// Ordering (spec § Folders — the picker offers, in order): registered project
// roots first, then folders seen in recent chats (most-recently-used first),
// deduped. Surfaces render the list in this order.
//
// NO FALLBACK: the published list is not a substitute for the spawn-time
// `folder exists` check — a stale/ad-hoc path still fails loudly with
// `folder_not_found` on send. This registry only decides what the picker shows.

import { promises as fs } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

import { isJunkFolder, isReservedSpecialThread } from '@patch/wire';
import { expandHome } from './expandHome.js';

/**
 * Thrown by `FolderRegistry.browse` when a requested directory does not exist
 * or cannot be read. Carries a stable `code` so the host's RPC handler maps
 * it to the wire `folder_not_found` error rather than a generic `internal`.
 * NO FALLBACK — an unreadable path must never degrade into a listing of
 * something else.
 */
export class FolderNotFoundError extends Error {
  readonly code = 'folder_not_found' as const;
  constructor(dir: string) {
    super(`folder not found or not readable: ${dir}`);
    this.name = 'FolderNotFoundError';
  }
}

/**
 * How long a `browse` result is served from the in-memory cache (spec/04 §
 * Browsing — "cache root listings briefly"). The picker re-opens and re-reads
 * the same dirs in quick bursts; a short TTL turns those into instant hits
 * without letting the tree go stale. Live changes to the published registry
 * still fan out over `folders.updated` independently of this cache.
 */
const BROWSE_CACHE_TTL_MS = 3_000;

/** Cache key for the roots view (can never collide with a resolved abs path). */
const ROOTS_CACHE_KEY = '\0roots';

/** A single browsable child directory (name + absolute path). */
export interface FolderBrowseEntry {
  name: string;
  path: string;
}

/** Result of `FolderRegistry.browse`: the listed dir, its parent, and children. */
export interface FolderBrowseResult {
  /** The directory listed (absolute), or `null` for the roots view. */
  dir: string | null;
  /** Parent to navigate "up" to, or `null` at a root / the roots view. */
  parent: string | null;
  /** Child directories, sorted by name. */
  entries: FolderBrowseEntry[];
}

export interface FolderRegistrySource {
  /**
   * The host's currently-known chats. Only `folder` + `lastUpdated` are read;
   * this is `Daemon.list()` in production.
   */
  listChats: () => Array<{ chatId: string; folder: string; lastUpdated: number }>;
}

export interface FolderRegistryOptions {
  source: FolderRegistrySource;
  /**
   * Called with the new complete folder list whenever `refresh()` /
   * `register()` changes the published set. The host wires this to emit a
   * `folders.updated` frame over the server link.
   */
  onChange: (registry: FolderRegistrySnapshot) => void;
  /** Optional seed of explicit project roots (registered folders). */
  registered?: string[];
}

/** The registry as the wire carries it for one host. */
export interface FolderRegistrySnapshot {
  roots: string[];
  recent: string[];
}

export class FolderRegistry {
  private readonly source: FolderRegistrySource;
  private readonly onChange: (registry: FolderRegistrySnapshot) => void;
  /** Explicit user-designated project roots, in registration order. */
  private readonly registered: string[];
  /**
   * Last snapshot handed out via `snapshot()` / `onChange` — the change
   * baseline. Held as the SPLIT, not the flattening: un-designating a root
   * that chats also use moves it from `roots` to `recent` without changing the
   * concatenation, and comparing the flat list would swallow that change and
   * leave every surface still showing it as a designated root.
   */
  private published: FolderRegistrySnapshot | null = null;
  /** Short-TTL cache of `browse` results, keyed by resolved dir (§ Browsing). */
  private readonly browseCache = new Map<
    string,
    { result: FolderBrowseResult; expiresAt: number }
  >();

  constructor(opts: FolderRegistryOptions) {
    this.source = opts.source;
    this.onChange = opts.onChange;
    this.registered = [...(opts.registered ?? [])];
  }

  /**
   * The current ordered folder list: registered project roots first, then
   * folders seen in recent chats (most-recent first), deduped.
   *
   * The recent-chat folders are filtered to REAL user project folders only
   * (spec/04 § Folders). Excluded:
   *   - reserved special threads by chatId (Manager / Speakers);
   *   - junk paths by `isJunkFolder` — the host's internal `.patch/threads/*`
   *     dirs, any dot-directory path, and system scratch (`/tmp`, …). This is
   *     what keeps `/tmp` and `/…/.patch/threads/manager` out of "Recent".
   * Registered roots are user-designated and pass through unfiltered.
   */
  list(): string[] {
    const { roots, recent } = this.split();
    return [...roots, ...recent];
  }

  /**
   * The two lists the wire carries separately (`folders.list` /
   * `folders.updated` → `{roots, recent}`). They are kept apart because only
   * `recent` is junk-filtered: a registered root deliberately placed under
   * `/tmp/work` is a user designation and must survive, while the same path
   * arriving from chat history is scratch (spec/04 § Folders).
   */
  split(): { roots: string[]; recent: string[] } {
    const roots: string[] = [];
    const recent: string[] = [];
    const seen = new Set<string>();
    for (const f of this.registered) {
      if (f && !seen.has(f)) {
        seen.add(f);
        roots.push(f);
      }
    }
    const chats = [...this.source.listChats()].sort((a, b) => b.lastUpdated - a.lastUpdated);
    for (const c of chats) {
      if (isReservedSpecialThread(c.chatId)) continue;
      if (c.folder && !isJunkFolder(c.folder) && !seen.has(c.folder)) {
        seen.add(c.folder);
        recent.push(c.folder);
      }
    }
    return { roots, recent };
  }

  /**
   * Snapshot for the `folders.list` emitted on host (re)connect. Records the
   * returned list as the change baseline so a subsequent identical `refresh()`
   * does not fire a redundant `folders.updated`.
   */
  snapshot(): FolderRegistrySnapshot {
    const split = this.split();
    this.published = split;
    return split;
  }

  /** The explicit project roots, in registration order (for persistence). */
  roots(): string[] {
    return [...this.registered];
  }

  /**
   * Register an explicit project root. Fires `onChange` if it changed the
   * published list. Idempotent — registering a known folder is a no-op.
   */
  register(folder: string): void {
    const expanded = expandHome(folder);
    if (!expanded || this.registered.includes(expanded)) return;
    this.registered.push(expanded);
    this.refresh();
  }

  /**
   * Drop a designated project root (`host.folder_remove`). Only the explicit
   * registration goes — the folder can still appear under `recent` if chats
   * live in it, which is correct: removing a root un-designates it, it does not
   * claim the directory is gone.
   */
  unregister(folder: string): boolean {
    const idx = this.registered.indexOf(expandHome(folder));
    if (idx < 0) return false;
    this.registered.splice(idx, 1);
    this.refresh();
    return true;
  }

  /**
   * Recompute the list and, if it differs from the last published one, publish
   * the change via `onChange`. Call after a chat is spawned (its folder may be
   * new). A no-op when the set is unchanged.
   */
  refresh(): void {
    // Nothing published yet (pre-connect): the `folders.list` emitted on connect
    // via `snapshot()` carries the current list, so there is nothing to push now
    // — and firing `onChange` here would buffer a spurious `folders.updated`
    // ahead of the first `folders.list`.
    if (this.published === null) return;
    const split = this.split();
    if (
      sameList(this.published.roots, split.roots) &&
      sameList(this.published.recent, split.recent)
    ) {
      return;
    }
    this.published = split;
    this.onChange(split);
  }

  /**
   * Browse the host's project filesystem for a folder (spec/04 § Browsing).
   * Returns the CHILD DIRECTORIES of `dir` (name + absolute path); files are
   * never listed — a chat targets a folder, not a file. With no `dir`, returns
   * the browsable ROOTS (this registry's `list()`) as the entries: the top of
   * the tree, one tap into any registered/recent folder.
   *
   * CONFINEMENT (NO FALLBACK): `dir` must resolve to a root itself or a
   * descendant of a root. Any path that escapes every root — including `.`/`..`
   * traversal, since `resolve()` collapses them before the check — throws
   * `FolderNotFoundError`. The host never lists `/` or a home dir.
   *
   * Dot-directories (`.git`, `.claude`, …) are omitted: they are never valid
   * chat targets and only clutter the tree.
   */
  async browse(dir?: string): Promise<FolderBrowseResult> {
    const roots = this.list();
    // Roots view: the top of the tree. Each root is a tappable entry. No
    // filesystem work at all — but still briefly cached so a picker that
    // re-opens the roots repeatedly does not recompute `list()` each time.
    if (dir === undefined || dir === '') {
      const cached = this.readBrowseCache(ROOTS_CACHE_KEY);
      if (cached) return cached;
      // The shortcut list: the folders you actually work in — registered roots
      // if any were ever designated, plus the folders recent chats opened.
      // There is no "add a root first" step: designating a root was ceremony
      // that gated browsing behind bookkeeping, and a folder becomes a shortcut
      // simply by being opened.
      const shortcuts = this.list();
      if (shortcuts.length > 0) {
        return this.writeBrowseCache(ROOTS_CACHE_KEY, {
          dir: null,
          parent: null,
          entries: shortcuts.map((r) => ({ name: basename(r) || r, path: r })),
        });
      }
      // Nothing opened yet on a fresh machine. Start in the host user's home
      // rather than showing an empty list with no way forward — browsing has to
      // be possible before anything has been opened, or the picker is useless
      // exactly when it is most needed.
      return await this.browse(homedir());
    }

    // NOT confined to the project roots. The host runs as this machine's user
    // with that user's whole authority — its own install notice says it can
    // "read, change and delete any file you can, anywhere on this machine", and
    // a chat can `cd` anywhere the moment it starts. Restricting the PICKER to
    // registered roots therefore protected nothing; it only stopped a person
    // opening a chat in a folder they had not thought to register first, and
    // sent them to type an absolute path by hand instead.
    //
    // Roots remain what the picker OFFERS at the top level — the shortcuts to
    // the places you work — not a boundary on where you may go.
    const resolved = resolve(expandHome(dir));

    const cached = this.readBrowseCache(resolved);
    if (cached) return cached;

    // One syscall to read the directory. `readdir` throws ENOTDIR on a file and
    // ENOENT on a missing path, so the extra pre-`stat` round trip is dropped —
    // either failure is `folder_not_found` to the client anyway.
    let dirents;
    try {
      dirents = await fs.readdir(resolved, { withFileTypes: true });
    } catch {
      // Missing / unreadable path inside a root is still "not found" to the
      // client, not an internal error.
      throw new FolderNotFoundError(dir);
    }

    // Child directories only. `withFileTypes` gives the type with NO per-entry
    // stat; the only stat we ever do is to resolve a symlink's target — and
    // those run CONCURRENTLY. Serialising them was the browse-latency
    // bottleneck: a pnpm `node_modules` is a symlink farm, so a sequential
    // await-per-symlink turned one listing into hundreds of round trips.
    const candidates = dirents.filter((d) => !d.name.startsWith('.'));
    const isDirFlags = await Promise.all(
      candidates.map(async (d) => {
        if (d.isDirectory()) return true;
        if (d.isSymbolicLink()) {
          try {
            return (await fs.stat(join(resolved, d.name))).isDirectory();
          } catch {
            return false;
          }
        }
        return false;
      }),
    );
    const entries: FolderBrowseEntry[] = candidates
      .filter((_, i) => isDirFlags[i])
      .map((d) => ({ name: d.name, path: join(resolved, d.name) }));
    entries.sort((a, b) => a.name.localeCompare(b.name));

    // "Up" one level. From a registered root, going up returns to the roots
    // view (`parent: null`) — that is the shortcut list, and the natural place
    // to land. From anywhere else, up is simply the parent directory, all the
    // way to `/`, which is its own parent and so ends the chain.
    const atRoot = roots.includes(resolved);
    const up = dirname(resolved);
    const parent = atRoot || up === resolved ? null : up;
    return this.writeBrowseCache(resolved, { dir: resolved, parent, entries });
  }

  /** Return a still-fresh cached `browse` result, or null (evicting if stale). */
  private readBrowseCache(key: string): FolderBrowseResult | null {
    const hit = this.browseCache.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
      this.browseCache.delete(key);
      return null;
    }
    return hit.result;
  }

  /** Store a `browse` result with the short TTL and return it (for chaining). */
  private writeBrowseCache(key: string, result: FolderBrowseResult): FolderBrowseResult {
    this.browseCache.set(key, { result, expiresAt: Date.now() + BROWSE_CACHE_TTL_MS });
    return result;
  }
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
