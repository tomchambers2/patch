// Host-owned folder registry (spec/04 § Folders).
//
// The host owns the folder list, publishes a `folders.list` snapshot on
// connect, and pushes `folders.updated` whenever the set changes. These tests
// exercise the FolderRegistry directly: ordering (registered roots first, then
// recent-chat folders most-recent-first), de-dup, special-thread exclusion, and
// the change-detection that gates `folders.updated`.

import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { SPECIAL_THREAD_IDS } from '@patch/wire';
import { FolderRegistry, FolderNotFoundError } from '../src/folders.js';

interface Chat {
  chatId: string;
  folder: string;
  lastUpdated: number;
}

function makeRegistry(chats: Chat[], registered?: string[]) {
  const state = { chats };
  const onChange = vi.fn<(folders: string[]) => void>();
  const reg = new FolderRegistry({
    source: { listChats: () => state.chats },
    onChange,
    ...(registered ? { registered } : {}),
  });
  return { reg, onChange, state };
}

describe('FolderRegistry', () => {
  it('lists folders seen in chats, most-recently-used first, deduped', () => {
    const { reg } = makeRegistry([
      { chatId: 'a', folder: '/proj/one', lastUpdated: 100 },
      { chatId: 'b', folder: '/proj/two', lastUpdated: 300 },
      { chatId: 'c', folder: '/proj/one', lastUpdated: 200 },
    ]);
    expect(reg.list()).toEqual(['/proj/two', '/proj/one']);
  });

  it('places registered project roots first, then recent-chat folders', () => {
    const { reg } = makeRegistry(
      [{ chatId: 'a', folder: '/proj/recent', lastUpdated: 100 }],
      ['/proj/root'],
    );
    expect(reg.list()).toEqual(['/proj/root', '/proj/recent']);
  });

  it('excludes reserved special threads (Manager / Speakers)', () => {
    const { reg } = makeRegistry([
      { chatId: SPECIAL_THREAD_IDS.manager, folder: '/daemon/cwd', lastUpdated: 999 },
      { chatId: 'a', folder: '/proj/one', lastUpdated: 100 },
    ]);
    expect(reg.list()).toEqual(['/proj/one']);
  });

  it('excludes junk recents (/tmp, .patch/threads/*, dot-dirs) — spec/04 § Folders', () => {
    const { reg } = makeRegistry([
      { chatId: 'a', folder: '/tmp', lastUpdated: 500 },
      // A NON-reserved chat that still ran in the host's thread dir must not
      // leak into "Recent" — the junk rule catches it regardless of chatId.
      { chatId: 'b', folder: '/app/.patch/threads/manager', lastUpdated: 400 },
      { chatId: 'c', folder: '/home/tom/.config/thing', lastUpdated: 300 },
      { chatId: 'd', folder: '/home/tom/projects/real', lastUpdated: 200 },
    ]);
    expect(reg.list()).toEqual(['/home/tom/projects/real']);
  });

  it('keeps a registered root even if it would look like junk (roots are deliberate)', () => {
    const { reg } = makeRegistry(
      [{ chatId: 'a', folder: '/tmp', lastUpdated: 100 }],
      ['/tmp/work'],
    );
    // The registered root passes through; the /tmp recent is dropped.
    expect(reg.list()).toEqual(['/tmp/work']);
  });

  it('snapshot() records a baseline so an unchanged refresh() does not fire onChange', () => {
    const { reg, onChange } = makeRegistry([
      { chatId: 'a', folder: '/proj/one', lastUpdated: 100 },
    ]);
    expect(reg.snapshot()).toEqual({ roots: [], recent: ['/proj/one'] });
    reg.refresh();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('refresh() fires onChange with the new list when a chat adds a folder', () => {
    const { reg, onChange, state } = makeRegistry([
      { chatId: 'a', folder: '/proj/one', lastUpdated: 100 },
    ]);
    reg.snapshot();
    state.chats = [...state.chats, { chatId: 'b', folder: '/proj/two', lastUpdated: 200 }];
    reg.refresh();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ roots: [], recent: ['/proj/two', '/proj/one'] });
  });

  it('refresh() before the first snapshot() is a no-op (pre-connect guard)', () => {
    const { reg, onChange, state } = makeRegistry([
      { chatId: 'a', folder: '/proj/one', lastUpdated: 100 },
    ]);
    // No snapshot() has run yet — the connect-time folders.list will carry the
    // list, so an early refresh must not push a spurious folders.updated.
    state.chats = [{ chatId: 'b', folder: '/proj/two', lastUpdated: 200 }];
    reg.refresh();
    expect(onChange).not.toHaveBeenCalled();
    // Once connected (snapshot taken), changes publish normally.
    expect(reg.snapshot()).toEqual({ roots: [], recent: ['/proj/two'] });
    state.chats = [...state.chats, { chatId: 'c', folder: '/proj/three', lastUpdated: 300 }];
    reg.refresh();
    expect(onChange).toHaveBeenCalledWith({ roots: [], recent: ['/proj/three', '/proj/two'] });
  });

  it('register() adds an explicit root and publishes the change', () => {
    const { reg, onChange } = makeRegistry([
      { chatId: 'a', folder: '/proj/one', lastUpdated: 100 },
    ]);
    reg.snapshot();
    reg.register('/proj/root');
    expect(onChange).toHaveBeenCalledWith({ roots: ['/proj/root'], recent: ['/proj/one'] });
    // Registering the same root again is a no-op (idempotent).
    reg.register('/proj/root');
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  // `host.folder_remove` un-designates a root. It must NOT claim the directory
  // is gone: a folder with chats in it stays visible under `recent`, which is
  // the difference between removing a designation and hiding a real folder.
  it('unregister() drops a root but leaves the folder in recent when chats use it', () => {
    const { reg, onChange } = makeRegistry(
      [{ chatId: 'a', folder: '/proj/root', lastUpdated: 100 }],
      ['/proj/root'],
    );
    reg.snapshot();
    expect(reg.unregister('/proj/root')).toBe(true);
    expect(onChange).toHaveBeenCalledWith({ roots: [], recent: ['/proj/root'] });
    // Removing one that was never registered reports so rather than silently
    // succeeding.
    expect(reg.unregister('/proj/nope')).toBe(false);
  });

  // patch doesn't recognise tilde in workspace paths — a typed `~/...` root
  // must resolve against the host's own home, not sit in the list as the
  // literal string `~/...` that `folder_not_found` on every spawn.
  it('register()/unregister() expand a leading ~ to the home directory', () => {
    const { reg, onChange } = makeRegistry([]);
    reg.snapshot();
    reg.register('~/proj/root');
    expect(onChange).toHaveBeenCalledWith({
      roots: [join(homedir(), 'proj/root')],
      recent: [],
    });
    expect(reg.unregister('~/proj/root')).toBe(true);
  });

  it('refresh() fires onChange for a same-length list whose contents differ', () => {
    const { reg, onChange, state } = makeRegistry(
      [{ chatId: 'a', folder: '/proj/one', lastUpdated: 100 }],
      ['/root'],
    );
    expect(reg.snapshot()).toEqual({ roots: ['/root'], recent: ['/proj/one'] });
    // Same chat count (1) so the published list stays the same LENGTH, but the
    // recent folder itself changes — this must still be detected as a change.
    state.chats = [{ chatId: 'a', folder: '/proj/two', lastUpdated: 200 }];
    reg.refresh();
    expect(onChange).toHaveBeenCalledWith({ roots: ['/root'], recent: ['/proj/two'] });
  });
});

// spec/04 § Browsing (directory listing) — the host lists a directory's child
// directories only, confined to its project roots. These tests use a real temp
// tree.
describe('FolderRegistry.browse', () => {
  let root: string;
  beforeAll(() => {
    // <tmp>/root/{alpha/, beta/, .hidden/, file.txt}
    root = mkdtempSync(join(tmpdir(), 'patch-browse-'));
    mkdirSync(join(root, 'alpha', 'nested'), { recursive: true });
    mkdirSync(join(root, 'beta'), { recursive: true });
    mkdirSync(join(root, '.hidden'), { recursive: true });
    writeFileSync(join(root, 'file.txt'), 'x');
    writeFileSync(join(root, 'alpha', 'note.md'), 'x');
    // `dir-link` → a directory (must be listed); `file-link` → a file (must not).
    symlinkSync(join(root, 'beta'), join(root, 'dir-link'), 'dir');
    symlinkSync(join(root, 'file.txt'), join(root, 'file-link'), 'file');
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function browseReg() {
    return new FolderRegistry({
      source: { listChats: () => [] },
      onChange: vi.fn(),
      registered: [root],
    });
  }

  it('with no dir returns the browsable roots as entries', async () => {
    const res = await browseReg().browse();
    expect(res.dir).toBeNull();
    expect(res.parent).toBeNull();
    expect(res.entries.map((e) => e.path)).toEqual([root]);
  });

  it('lists CHILD DIRECTORIES only — no files, no dotfolders — sorted', async () => {
    const res = await browseReg().browse(root);
    expect(res.dir).toBe(root);
    expect(res.parent).toBeNull(); // a root: up goes back to the roots view
    // `dir-link` (symlink → dir) is included; `file-link` (symlink → file) and
    // `file.txt` / `.hidden` are not.
    expect(res.entries.map((e) => e.name)).toEqual(['alpha', 'beta', 'dir-link']);
  });

  it('drills into a descendant and reports the parent within the root', async () => {
    const alpha = join(root, 'alpha');
    const res = await browseReg().browse(alpha);
    expect(res.dir).toBe(alpha);
    expect(res.parent).toBe(root);
    expect(res.entries.map((e) => e.name)).toEqual(['nested']);
  });

  // Browsing is NOT confined to the registered roots. The host runs with this
  // machine's user's whole authority — a chat can `cd` anywhere the moment it
  // starts — so confining the PICKER protected nothing and only stopped someone
  // opening a chat in a folder they had not registered first. Roots are the
  // shortcuts the picker OFFERS, not a boundary.
  it('browses ABOVE a root — the picker is not confined to registered roots', async () => {
    const up = await browseReg().browse(join(root, '..'));
    expect(up.dir).toBe(resolve(join(root, '..')));
    expect(Array.isArray(up.entries)).toBe(true);
  });

  it('browses an absolute path outside every root', async () => {
    const slash = await browseReg().browse('/');
    expect(slash.dir).toBe('/');
    // `/` is its own parent, which ends the upward chain rather than looping.
    expect(slash.parent).toBeNull();
  });

  it('still refuses a path that does not exist, rather than listing something else', async () => {
    await expect(browseReg().browse('/no/such/path/anywhere')).rejects.toBeInstanceOf(
      FolderNotFoundError,
    );
  });

  it('going up FROM a registered root returns to the roots view', async () => {
    const atRoot = await browseReg().browse(root);
    expect(atRoot.parent).toBeNull();
  });

  it('rejects a missing directory inside a root', async () => {
    await expect(browseReg().browse(join(root, 'does-not-exist'))).rejects.toBeInstanceOf(
      FolderNotFoundError,
    );
  });

  it('serves a repeat browse from the short-TTL cache (does not re-read the FS)', async () => {
    const reg = browseReg();
    const first = await reg.browse(root);
    // Mutate the tree AFTER the first browse. Within the TTL the cached result
    // stands, so the new dir is not seen yet — proving the second call did not
    // hit the filesystem.
    const fresh = join(root, 'gamma-fresh');
    mkdirSync(fresh);
    try {
      const second = await reg.browse(root);
      expect(second.entries.map((e) => e.name)).toEqual(first.entries.map((e) => e.name));
      expect(second.entries.map((e) => e.name)).not.toContain('gamma-fresh');
      // A DIFFERENT registry instance shares no cache and sees the new dir.
      const other = await browseReg().browse(root);
      expect(other.entries.map((e) => e.name)).toContain('gamma-fresh');
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it('serves a repeat roots-view browse (no dir) from the short-TTL cache', async () => {
    const reg = browseReg();
    const first = await reg.browse();
    // A second immediate call must hit the roots-view cache branch and return
    // the SAME cached object instance rather than recomputing it.
    const second = await reg.browse();
    expect(second).toBe(first);
  });

  it('roots view uses the root path itself when basename() is empty (e.g. "/")', async () => {
    const reg = new FolderRegistry({
      source: { listChats: () => [] },
      onChange: vi.fn(),
      registered: ['/'],
    });
    const res = await reg.browse();
    expect(res.entries).toEqual([{ name: '/', path: '/' }]);
  });

  // patch doesn't recognise tilde in workspace paths — browsing `~/<dir>`
  // must resolve against the host's own home rather than a literal `~`
  // directory next to the cwd.
  it('expands a leading ~ in the browsed dir', async () => {
    const under = mkdtempSync(join(homedir(), 'patch-tilde-browse-'));
    mkdirSync(join(under, 'child'));
    try {
      const res = await browseReg().browse(join('~', under.slice(homedir().length + 1)));
      expect(res.dir).toBe(under);
      expect(res.entries.map((e) => e.name)).toEqual(['child']);
    } finally {
      rmSync(under, { recursive: true, force: true });
    }
  });

  it('excludes a broken symlink (target does not exist) from the listing', async () => {
    const brokenTarget = join(root, 'nowhere');
    const brokenLink = join(root, 'broken-link');
    symlinkSync(brokenTarget, brokenLink, 'dir');
    try {
      const res = await browseReg().browse(root);
      expect(res.entries.map((e) => e.name)).not.toContain('broken-link');
    } finally {
      rmSync(brokenLink, { force: true });
    }
  });

  it('evicts an expired browse-cache entry once the TTL has passed', async () => {
    const reg = browseReg();
    const first = await reg.browse(root);
    const fresh = join(root, 'epsilon-fresh');
    mkdirSync(fresh);
    try {
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 3_001); // past BROWSE_CACHE_TTL_MS
      const second = await reg.browse(root);
      expect(second.entries.map((e) => e.name)).not.toEqual(first.entries.map((e) => e.name));
      expect(second.entries.map((e) => e.name)).toContain('epsilon-fresh');
    } finally {
      vi.useRealTimers();
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});
