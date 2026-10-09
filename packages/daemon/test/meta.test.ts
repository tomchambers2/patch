// meta.json: atomic write, hydrate, monotonic seq guard.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMetaStore, type ChatMeta } from '../src/meta.js';

// F2: record the order of fsync/rename so we can prove fsync precedes rename
// in the atomic-write path. We wrap the real node:fs so writes still land.
// `mkdirControl.suppress` lets one test make `mkdirSync` a no-op so
// `ensureRoot()` silently fails to create the chats dir — the only way to
// reach list()'s ENOENT branch, since ensureRoot() otherwise always recreates
// the dir immediately before readdirSync runs.
const { fsCalls, mkdirControl } = vi.hoisted(() => ({
  fsCalls: [] as string[],
  mkdirControl: { suppress: false },
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    mkdirSync: ((path: fs.PathLike, opts?: fs.MakeDirectoryOptions) => {
      if (mkdirControl.suppress) return undefined;
      return actual.mkdirSync(path, opts);
    }) as typeof actual.mkdirSync,
    fsyncSync: (fd: number) => {
      fsCalls.push('fsync');
      return actual.fsyncSync(fd);
    },
    renameSync: (from: fs.PathLike, to: fs.PathLike) => {
      fsCalls.push('rename');
      return actual.renameSync(from, to);
    },
  };
});
import type * as fs from 'node:fs';
import { chmodSync, symlinkSync } from 'node:fs';

function makeMeta(over: Partial<ChatMeta> = {}): ChatMeta {
  return {
    chatId: 'c1',
    folder: '/work',
    name: null,
    nextSeq: 0,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

describe('meta store', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'patch-meta-'));
  });

  it('round-trips a chat meta', () => {
    const store = createMetaStore(home);
    const m = makeMeta({ chatId: 'c1', folder: home });
    store.write(m);
    const got = store.read('c1');
    expect(got).toEqual(m);
  });

  it('reads a meta written back when a chat still had an accountId', () => {
    // `ChatMeta` is `.strict()`, so a retired key makes every file written
    // before the retirement unreadable — and `accountId` was on EVERY chat on
    // the host. Dropped on read rather than refused; the chat is fine, it just
    // no longer has an account (spec/10-auth.md § Backend credentials).
    const store = createMetaStore(home);
    const m = makeMeta({ chatId: 'old', folder: home });
    store.write(m);
    const path = join(home, 'chats', 'old', 'meta.json');
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...onDisk, accountId: 'acct-b' }));
    const got = store.read('old');
    expect(got).toEqual(m);
    expect(got).not.toHaveProperty('accountId');
    // And it leaves the disk for good the next time that chat is written.
    store.write(got!);
    expect(JSON.parse(readFileSync(path, 'utf8'))).not.toHaveProperty('accountId');
  });

  it('round-trips a persisted lastError for an errored chat (G1-d6)', () => {
    const store = createMetaStore(home);
    const m = makeMeta({
      chatId: 'err1',
      folder: home,
      status: 'errored',
      lastError: { code: 'folder_missing', message: 'chat folder no longer exists', at: 42 },
    });
    store.write(m);
    const got = store.read('err1');
    // An errored chat surviving a host restart must still explain WHY —
    // lastError persists, it is not lost to memory-only state.
    expect(got?.status).toBe('errored');
    expect(got?.lastError).toEqual({
      code: 'folder_missing',
      message: 'chat folder no longer exists',
      at: 42,
    });
  });

  it('list() returns every persisted chat', () => {
    const store = createMetaStore(home);
    store.write(makeMeta({ chatId: 'a' }));
    store.write(makeMeta({ chatId: 'b', nextSeq: 7 }));
    const ids = store
      .list()
      .map((m) => m.chatId)
      .sort();
    expect(ids).toEqual(['a', 'b']);
  });

  it('list() leaves out a chat whose meta.json does not parse, and names it in unreadable()', () => {
    const store = createMetaStore(home);
    store.write(makeMeta({ chatId: 'good' }));
    store.write(makeMeta({ chatId: 'nulled' }));
    // The shape a hand edit left behind on 28 Sep 2026: null where the schema
    // takes a string or nothing.
    const p = store.pathFor('nulled');
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    writeFileSync(p, JSON.stringify({ ...raw, claudeSessionId: null }));
    store.write(makeMeta({ chatId: 'torn' }));
    writeFileSync(store.pathFor('torn'), '{"chatId": "torn",');

    expect(store.list().map((m) => m.chatId)).toEqual(['good']);
    const bad = store.unreadable().sort((a, b) => a.chatId.localeCompare(b.chatId));
    expect(bad.map((u) => u.chatId)).toEqual(['nulled', 'torn']);
    expect(bad[0]!.path).toBe(p);
    expect(bad[0]!.error).toMatch(/^claudeSessionId: Expected string, received null$/);
    expect(bad[1]!.error).toMatch(/JSON/);
  });

  it('unreadable() reflects the latest list(), so a fixed file drops off it', () => {
    const store = createMetaStore(home);
    store.write(makeMeta({ chatId: 'c1' }));
    writeFileSync(store.pathFor('c1'), '{');
    store.list();
    expect(store.unreadable()).toHaveLength(1);
    store.write(makeMeta({ chatId: 'c1' }));
    expect(store.list().map((m) => m.chatId)).toEqual(['c1']);
    expect(store.unreadable()).toEqual([]);
  });

  it('refuses to rewind nextSeq', () => {
    const store = createMetaStore(home);
    store.write(makeMeta({ chatId: 'c1', nextSeq: 5 }));
    expect(() => store.update('c1', (m) => ({ ...m, nextSeq: 4 }))).toThrow(/rewind nextSeq/);
  });

  it('update() throws when meta.json is missing for chatId', () => {
    const store = createMetaStore(home);
    expect(() => store.update('never-written', (m) => m)).toThrow(/meta\.json missing/);
  });

  it('readSeq() returns undefined when no seq file has been written', () => {
    const store = createMetaStore(home);
    expect(store.readSeq('no-such-chat')).toBeUndefined();
  });

  it('writeSeq() rejects a negative/non-integer nextSeq (NO FALLBACK)', () => {
    const store = createMetaStore(home);
    expect(() => store.writeSeq('c1', -1)).toThrow(/invalid nextSeq/);
    expect(() => store.writeSeq('c1', 1.5)).toThrow(/invalid nextSeq/);
  });

  it('readSeq() throws on a corrupt (non-numeric) seq file (NO FALLBACK)', () => {
    const store = createMetaStore(home);
    store.writeSeq('c1', 3);
    writeFileSync(join(home, 'chats', 'c1', 'seq'), 'not-a-number', 'utf8');
    expect(() => store.readSeq('c1')).toThrow(/corrupt seq file/);
  });

  it('readSeq() rethrows a non-ENOENT fs error', () => {
    const store = createMetaStore(home);
    store.writeSeq('perm1', 1);
    const seqPath = join(home, 'chats', 'perm1', 'seq');
    chmodSync(seqPath, 0o000);
    try {
      expect(() => store.readSeq('perm1')).toThrow();
    } finally {
      chmodSync(seqPath, 0o600); // restore so afterEach cleanup can remove it
    }
  });

  it('read() rethrows a non-ENOENT fs error', () => {
    const store = createMetaStore(home);
    store.write(makeMeta({ chatId: 'perm2' }));
    const metaPath = store.pathFor('perm2');
    chmodSync(metaPath, 0o000);
    try {
      expect(() => store.read('perm2')).toThrow();
    } finally {
      chmodSync(metaPath, 0o600);
    }
  });

  it('list() returns [] when the chats root cannot be created/read (ENOENT)', () => {
    // Suppress mkdirSync from BEFORE construction so ensureRoot() never
    // actually creates the chats dir — the only way readdirSync(root) inside
    // list() can throw ENOENT (ensureRoot() otherwise recreates it first).
    mkdirControl.suppress = true;
    try {
      const store = createMetaStore(home);
      expect(store.list()).toEqual([]);
    } finally {
      mkdirControl.suppress = false;
    }
  });

  it('list() rethrows a non-ENOENT readdir error (e.g. permission denied)', () => {
    const store = createMetaStore(home);
    store.write(makeMeta({ chatId: 'c1' }));
    const chatsRoot = join(home, 'chats');
    chmodSync(chatsRoot, 0o000);
    try {
      expect(() => store.list()).toThrow();
    } finally {
      chmodSync(chatsRoot, 0o700); // restore so afterEach cleanup can remove it
    }
  });

  it('list() skips a non-directory entry and a broken-symlink entry under the chats root', () => {
    const store = createMetaStore(home);
    store.write(makeMeta({ chatId: 'real' }));
    // A stray file directly under chats/ (not a chat dir) — statSync succeeds
    // but isDirectory() is false.
    writeFileSync(join(home, 'chats', 'stray.txt'), 'x', 'utf8');
    // A dangling symlink — statSync (which follows links) throws ENOENT.
    symlinkSync(join(home, 'chats', 'does-not-exist'), join(home, 'chats', 'broken-link'));
    const ids = store
      .list()
      .map((m) => m.chatId)
      .sort();
    expect(ids).toEqual(['real']);
  });

  it('writes file with mode 0600', () => {
    const store = createMetaStore(home);
    store.write(makeMeta({ chatId: 'c1' }));
    const path = store.pathFor('c1');
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
    // Sanity: file content parses as the same shape.
    JSON.parse(readFileSync(path, 'utf8'));
  });

  it('survives a "crash" mid-update via temp-rename atomicity', () => {
    const store = createMetaStore(home);
    store.write(makeMeta({ chatId: 'c1', nextSeq: 1 }));
    // Simulate the host dying after a successful update — we just confirm
    // the persisted file still parses cleanly. (We can't realistically
    // partial-fail rename on the local FS without monkey-patching renameSync,
    // so this asserts post-write integrity instead.)
    store.update('c1', (m) => ({ ...m, nextSeq: m.nextSeq + 1 }));
    expect(store.read('c1')?.nextSeq).toBe(2);
  });

  describe('F2: crash-durable fsync before rename', () => {
    beforeEach(() => {
      fsCalls.length = 0;
    });
    afterEach(() => {
      fsCalls.length = 0;
    });

    it('write() fsyncs the temp file BEFORE renaming it into place', () => {
      const store = createMetaStore(home);
      store.write(makeMeta({ chatId: 'durable', folder: home }));

      expect(fsCalls).toContain('fsync');
      expect(fsCalls).toContain('rename');
      // fsync must precede rename so bytes are durable before the swap.
      expect(fsCalls.indexOf('fsync')).toBeLessThan(fsCalls.indexOf('rename'));
      // The write still landed.
      expect(store.read('durable')?.chatId).toBe('durable');
    });

    it('writeSeq() fsyncs the temp file BEFORE renaming it into place', () => {
      const store = createMetaStore(home);
      store.writeSeq('durable-seq', 9);

      expect(fsCalls).toContain('fsync');
      expect(fsCalls.indexOf('fsync')).toBeLessThan(fsCalls.indexOf('rename'));
      expect(store.readSeq('durable-seq')).toBe(9);
    });
  });
});
