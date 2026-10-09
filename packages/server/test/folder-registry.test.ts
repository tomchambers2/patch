// Server-side folder mirror (spec/04 § Folders). Observes each host's
// `folders.list` / `folders.updated` events and exposes the latest registry
// PER HOST for `GET /api/folders`.
//
// The mirror is keyed by host because two machines can publish the same path
// string meaning two different directories. A flat union would collapse them
// into one picker entry, and the chat spawned from it would land on a folder
// the chosen host does not have.

import { describe, it, expect } from 'vitest';
import type { WireEvent } from '@patch/wire';
import { FolderRegistry } from '../src/folder-registry.js';

describe('FolderRegistry (server mirror)', () => {
  it('starts empty until a host publishes', () => {
    const reg = new FolderRegistry();
    expect(reg.list()).toEqual([]);
    expect(reg.forHost('d1')).toBeNull();
  });

  it('caches a host folders.list snapshot under that host', () => {
    const reg = new FolderRegistry();
    reg.observe({
      type: 'folders.list',
      daemonId: 'd1',
      roots: ['/proj/a'],
      recent: ['/proj/b'],
    });
    expect(reg.list()).toEqual([{ daemonId: 'd1', roots: ['/proj/a'], recent: ['/proj/b'] }]);
    expect(reg.forHost('d1')).toEqual({
      daemonId: 'd1',
      roots: ['/proj/a'],
      recent: ['/proj/b'],
    });
  });

  it("replaces that host's registry wholesale on folders.updated", () => {
    const reg = new FolderRegistry();
    reg.observe({ type: 'folders.list', daemonId: 'd1', roots: ['/proj/a'], recent: [] });
    reg.observe({
      type: 'folders.updated',
      daemonId: 'd1',
      roots: ['/proj/c'],
      recent: ['/proj/a'],
    });
    expect(reg.forHost('d1')).toEqual({
      daemonId: 'd1',
      roots: ['/proj/c'],
      recent: ['/proj/a'],
    });
  });

  // The whole reason the mirror is keyed by host: two machines that share a
  // path string are two entries, and one publishing must not disturb the other.
  it('keeps two hosts separate, including when they share a path string', () => {
    const reg = new FolderRegistry();
    reg.observe({ type: 'folders.list', daemonId: 'd1', roots: ['/work/patch'], recent: [] });
    reg.observe({ type: 'folders.list', daemonId: 'd2', roots: ['/work/patch'], recent: [] });
    reg.observe({ type: 'folders.updated', daemonId: 'd2', roots: [], recent: [] });
    expect(reg.forHost('d1')).toEqual({ daemonId: 'd1', roots: ['/work/patch'], recent: [] });
    expect(reg.forHost('d2')).toEqual({ daemonId: 'd2', roots: [], recent: [] });
    expect(reg.list()).toHaveLength(2);
  });

  it('ignores unrelated events', () => {
    const reg = new FolderRegistry();
    reg.observe({ type: 'folders.list', daemonId: 'd1', roots: ['/proj/a'], recent: [] });
    reg.observe({ type: 'daemon.online', daemonId: 'd1' } as WireEvent);
    reg.observe({
      type: 'chat.spawned',
      daemonId: 'd1',
      chatId: 'c1',
      folder: '/somewhere/else',
    } as WireEvent);
    expect(reg.forHost('d1')).toEqual({ daemonId: 'd1', roots: ['/proj/a'], recent: [] });
  });

  it('returns a copy — callers cannot mutate the cache', () => {
    const reg = new FolderRegistry();
    reg.observe({ type: 'folders.list', daemonId: 'd1', roots: ['/proj/a'], recent: [] });
    reg.list()[0]?.roots.push('/injected');
    reg.forHost('d1')?.roots.push('/injected-too');
    expect(reg.forHost('d1')).toEqual({ daemonId: 'd1', roots: ['/proj/a'], recent: [] });
  });
});
