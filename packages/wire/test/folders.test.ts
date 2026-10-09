// Host-owned folder registry wire events (spec/04 § Folders).
//
// `folders.list` (snapshot on connect) and `folders.updated` (push on change)
// carry the host's complete folder list to every surface. These assert the
// schema round-trips through the codec and that malformed payloads are
// rejected (NO silent coercion).

import { describe, it, expect } from 'vitest';
import {
  encode,
  decode,
  FoldersListEvent,
  FoldersUpdatedEvent,
  type WireEvent,
} from '../src/index.js';

describe('folder registry wire events', () => {
  it('round-trips folders.list through encode/decode', () => {
    const ev: WireEvent = {
      type: 'folders.list',
      daemonId: 'host-a',
      roots: ['/home/tom/projects/patch'],
      recent: ['/home/tom/notes'],
    };
    const decoded = decode(encode(ev));
    expect(decoded).toEqual(ev);
  });

  it('round-trips folders.updated through encode/decode', () => {
    const ev: WireEvent = {
      type: 'folders.updated',
      daemonId: 'host-a',
      roots: ['/home/tom/projects/patch'],
      recent: [],
    };
    const decoded = decode(encode(ev));
    expect(decoded).toEqual(ev);
  });

  it('accepts an empty folder list', () => {
    const parsed = FoldersListEvent.parse({
      type: 'folders.list',
      daemonId: 'host-a',
      roots: [],
      recent: [],
    });
    expect(parsed.roots).toEqual([]);
    expect(parsed.recent).toEqual([]);
  });

  // The registry describes ONE machine's filesystem. Without the host id, two
  // machines' registries would overwrite each other in every surface's picker
  // and a chat would be spawned into a path that host does not have.
  it('rejects a folders.list that names no host', () => {
    const res = FoldersListEvent.safeParse({ type: 'folders.list', roots: [], recent: [] });
    expect(res.success).toBe(false);
    expect(JSON.stringify(res)).toContain('daemonId');
  });

  it('rejects a folders.updated that names no host', () => {
    const res = FoldersUpdatedEvent.safeParse({ type: 'folders.updated', roots: [], recent: [] });
    expect(res.success).toBe(false);
  });

  it('rejects a folders.list with a non-string entry', () => {
    expect(() =>
      FoldersListEvent.parse({
        type: 'folders.list',
        daemonId: 'host-a',
        roots: ['/ok', 42],
        recent: [],
      }),
    ).toThrow();
  });

  it('rejects an empty-string folder path (NO silent coercion)', () => {
    expect(() => FoldersUpdatedEvent.parse({ type: 'folders.updated', folders: [''] })).toThrow();
  });

  it('rejects unknown keys (strict)', () => {
    expect(() =>
      FoldersListEvent.parse({ type: 'folders.list', folders: ['/ok'], extra: true }),
    ).toThrow();
  });
});
