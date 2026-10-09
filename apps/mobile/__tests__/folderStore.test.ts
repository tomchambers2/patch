// Mobile folderStore (spec/04 § Folders): holds each host's published folder
// registry, which populates the new-chat + job-editor pickers.
//
// Keyed BY HOST. Two machines can publish the same path string meaning two
// different directories, so a flat list would collapse them into one picker
// entry and the chat spawned from it would land on a folder the chosen host
// does not have. `folders.list` and `folders.updated` each replace ONE host's
// entry and leave every other host's alone.

import { describe, it, expect, beforeEach } from 'vitest';
import { useFolderStore } from '../src/stores/folderStore';
import { folderOptions } from '../src/lib/folderOptions';

describe('folderStore', () => {
  beforeEach(() => {
    useFolderStore.getState()._reset();
  });

  it('starts empty', () => {
    expect(useFolderStore.getState().byHost).toEqual({});
    expect(useFolderStore.getState().foldersFor('d1')).toEqual([]);
  });

  it('setHostFolders records a host registry (folders.list snapshot)', () => {
    useFolderStore.getState().setHostFolders({
      daemonId: 'd1',
      roots: ['/proj/a'],
      recent: ['/proj/b'],
    });
    expect(useFolderStore.getState().foldersFor('d1')).toEqual(['/proj/a', '/proj/b']);
  });

  it("a later setHostFolders wholesale-replaces THAT host's entry (folders.updated push)", () => {
    useFolderStore.getState().setHostFolders({ daemonId: 'd1', roots: ['/proj/a'], recent: [] });
    useFolderStore
      .getState()
      .setHostFolders({ daemonId: 'd1', roots: ['/proj/c'], recent: ['/proj/a'] });
    expect(useFolderStore.getState().foldersFor('d1')).toEqual(['/proj/c', '/proj/a']);
  });

  // The reason the store is keyed by host at all.
  it('keeps two hosts separate, including when they share a path string', () => {
    useFolderStore
      .getState()
      .setHostFolders({ daemonId: 'd1', roots: ['/work/patch'], recent: [] });
    useFolderStore
      .getState()
      .setHostFolders({ daemonId: 'd2', roots: ['/work/patch'], recent: [] });
    useFolderStore.getState().setHostFolders({ daemonId: 'd2', roots: [], recent: [] });
    expect(useFolderStore.getState().foldersFor('d1')).toEqual(['/work/patch']);
    expect(useFolderStore.getState().foldersFor('d2')).toEqual([]);
  });

  it('setAllFolders replaces every host (cold-start GET /api/folders)', () => {
    useFolderStore.getState().setHostFolders({ daemonId: 'stale', roots: ['/gone'], recent: [] });
    useFolderStore.getState().setAllFolders([
      { daemonId: 'd1', roots: ['/proj/a'], recent: [] },
      { daemonId: 'd2', roots: ['/proj/b'], recent: [] },
    ]);
    expect(Object.keys(useFolderStore.getState().byHost).sort()).toEqual(['d1', 'd2']);
    expect(useFolderStore.getState().foldersFor('stale')).toEqual([]);
  });

  it("feeds the picker with the chosen host's folders first", () => {
    useFolderStore
      .getState()
      .setHostFolders({ daemonId: 'd1', roots: ['/daemon/one'], recent: ['/daemon/two'] });
    const options = folderOptions(useFolderStore.getState().foldersFor('d1'), ['/chat/x']);
    expect(options).toEqual(['/daemon/one', '/daemon/two', '/chat/x']);
  });
});
