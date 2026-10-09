// FilesPage — the `{kind:'page', page:'files'}` tab's content: a chat's file
// tree, with create/rename/delete (spec/14 § File browser). Opening a file
// from here opens (or focuses) that file's OWN tab — the tree itself holds no
// "currently open file" state anymore; that lives in each `FileEditorTab`.
//
// Split out of the old docked `EditorRail`'s `BrowsePanel` (spec/14 § Panes
// and tabs — "the editor rail … must become ordinary tabs/panes"), which
// combined this tree with a single inline editor pane. The tree half moves
// here almost unchanged; the editor half is `FileEditorTab.tsx`.

import { type JSX, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  FilePlus,
  FolderPlus,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Search,
  Trash2,
} from 'lucide-react';
import { ContextMenu, useContextMenu, type ContextMenuItem } from './ContextMenu.js';
import {
  BrowseSkeleton,
  FileTreeRows,
  FileSearch,
  buildFileTree,
  filterFileTree,
  dirName,
  baseName,
  isDocxPath,
} from './EditorRail.js';
import { ColumnDivider } from './ColumnDivider.js';
import { useUiStore, EMPTY_BROWSE_STATE } from '../stores/uiStore.js';
import { useLayoutStore } from '../stores/layoutStore.js';
import { api, ApiError } from '../api/rest.js';

export function FilesPage({ chatId }: { chatId: string }): JSX.Element {
  const setBrowseState = useUiStore((s) => s.setBrowseState);
  const browse = useUiStore((s) => s.browseByChat[chatId] ?? EMPTY_BROWSE_STATE);
  const { filter, expandedDirs, lastActiveDir, renamingPath, renameValue } = browse;
  const pushError = useUiStore((s) => s.pushError);
  const pushNotice = useUiStore((s) => s.pushNotice);
  const openTab = useLayoutStore((s) => s.openTab);
  const patchBrowse = (
    next: Partial<Omit<typeof browse, 'touch' | 'openFile' | 'draft' | 'draftBaseline'>>,
  ): void => setBrowseState(chatId, next);

  const expandedSet = new Set(expandedDirs);
  const toggleDir = (dirPath: string): void => {
    const next = new Set(expandedSet);
    if (next.has(dirPath)) next.delete(dirPath);
    else next.add(dirPath);
    patchBrowse({ expandedDirs: Array.from(next), lastActiveDir: dirPath });
  };

  const filePickerOpen = useUiStore((s) => s.filePickerOpen);
  const setFilePickerOpen = useUiStore((s) => s.setFilePickerOpen);
  const treeWidth = useUiStore((s) => s.browseTreeWidth);
  const treeCollapsed = useUiStore((s) => s.browseTreeCollapsed);
  const setBrowseTreeWidth = useUiStore((s) => s.setBrowseTreeWidth);
  const setBrowseTreeCollapsed = useUiStore((s) => s.setBrowseTreeCollapsed);

  const queryClient = useQueryClient();
  const {
    data: recursiveData,
    error: recursiveError,
    isPending: treePending,
  } = useQuery({
    queryKey: ['files-recursive', chatId],
    queryFn: async () => api.listFilesRecursive(chatId),
  });

  useEffect(() => {
    if (recursiveError) pushError(`files: ${(recursiveError as Error).message}`);
  }, [recursiveError, pushError]);

  // spec/14 § File browser — live updates: a `patch.file_changed` push for
  // this chat invalidates the recursive listing, same as the old rail.
  const lastFileChanged = useUiStore((s) => s.lastFileChanged[chatId] ?? null);
  useEffect(() => {
    if (!lastFileChanged) return;
    void queryClient.invalidateQueries({ queryKey: ['files-recursive', chatId] });
  }, [chatId, lastFileChanged, queryClient]);

  // Esc closes the file picker — the pane/tab shell has no other Esc
  // handling to compete with (the old rail's "Esc closes the browser" is
  // gone: closing a tab/pane is ⌘W now, matching every other tab kind).
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape' && filePickerOpen) setFilePickerOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [filePickerOpen, setFilePickerOpen]);

  function openPath(next: { name: string; path: string }): void {
    // Document editor (spec/14 § Document editor, step 3 of 3): opening a
    // `.docx` converts it in place and opens the resulting `.md` instead —
    // the editor itself never renders a `.docx`.
    if (isDocxPath(next.name)) {
      void openDocxAsMarkdown(next);
      return;
    }
    openTab({ kind: 'file', chatId, path: next.path });
    patchBrowse({ lastActiveDir: dirName(next.path) });
  }

  async function openDocxAsMarkdown(next: { name: string; path: string }): Promise<void> {
    let converted: { mdPath: string; warnings: string[] };
    try {
      converted = await api.convertDocx(chatId, next.path);
    } catch (err) {
      pushError((err as Error).message);
      return;
    }
    openTab({ kind: 'file', chatId, path: converted.mdPath });
    patchBrowse({ lastActiveDir: dirName(converted.mdPath) });
    // The new `.md` is a real tree entry now (beside the untouched `.docx`)
    // — don't wait on the live `patch.file_changed` push to say so.
    await queryClient.invalidateQueries({ queryKey: ['files-recursive', chatId] });
    // The open-time warning banner is FileEditorTab's own importWarnings
    // effect (keyed on `docView`), which fires once the just-opened doc view
    // loads — covers this fresh conversion AND a later reopen of the same
    // `.md` from one place, rather than announcing it twice.
  }

  const menu = useContextMenu();
  const [menuTarget, setMenuTarget] = useState<{
    name: string;
    path: string;
    type: 'file' | 'dir';
  } | null>(null);

  const joinPath = (dir: string, name: string): string => (dir === '' ? name : `${dir}/${name}`);

  async function runFileOp(
    body: { op: 'create' | 'create_dir' | 'delete' | 'rename'; path: string; to?: string },
    done: (landedOn: string) => void,
  ): Promise<void> {
    try {
      const res = await api.fileOp(chatId, body);
      done(res.path);
      await queryClient.invalidateQueries({ queryKey: ['files-recursive', chatId] });
    } catch (err) {
      const body2 = err instanceof ApiError ? (err.body as { message?: unknown } | null) : null;
      pushError(
        `files: ${typeof body2?.message === 'string' ? body2.message : (err as Error).message}`,
      );
    }
  }

  async function createEntry(kind: 'file' | 'dir'): Promise<void> {
    const dir = lastActiveDir;
    const siblingNames = new Set(
      (recursiveData?.entries ?? [])
        .filter((e) => dirName(e.name) === dir)
        .map((e) => baseName(e.name)),
    );
    let name = 'untitled';
    for (let n = 2; siblingNames.has(name); n++) name = `untitled-${n}`;
    const full = joinPath(dir, name);
    await runFileOp({ op: kind === 'file' ? 'create' : 'create_dir', path: full }, (landed) => {
      pushNotice(`Created ${landed}`);
      const expanded = dir !== '' && !expandedSet.has(dir) ? [...expandedDirs, dir] : expandedDirs;
      patchBrowse({ expandedDirs: expanded, renamingPath: landed, renameValue: name });
      if (kind === 'file') {
        // Split, not replace (unlike a plain tree click): the new row's
        // inline rename has to stay visible in THIS tree for "typing a real
        // name replaces untitled" to be something the user can actually see
        // happen, and a plain open would replace this very tab with the
        // file it just opened.
        openTab({ kind: 'file', chatId, path: landed }, { placement: 'split', edge: 'right' });
        patchBrowse({ lastActiveDir: dirName(landed) });
      }
    });
  }

  async function commitRename(): Promise<void> {
    const target = renamingPath;
    if (target === null) return;
    patchBrowse({ renamingPath: null });
    const typed = renameValue.trim();
    if (typed === '' || typed === baseName(target)) return;
    const to = joinPath(dirName(target), typed);
    // Follow the "untitled" tab the create flow just opened to its new name
    // IN THE SAME PANE — not whichever pane is "active", which by now is
    // typically back to the tree's own pane (the rename input the user just
    // typed into lives there, and a real click/fill refocuses it).
    const open = useLayoutStore.getState().findTab({ kind: 'file', chatId, path: target });
    await runFileOp({ op: 'rename', path: target, to }, (landed) => {
      pushNotice(`Renamed ${target} → ${landed}`);
      if (open) {
        openTab({ kind: 'file', chatId, path: landed }, { paneId: open.pane.id });
      } else {
        openPath({ name: typed, path: landed });
      }
    });
  }

  function cancelRename(): void {
    patchBrowse({ renamingPath: null });
  }

  async function renameEntry(entry: {
    name: string;
    path: string;
    type: 'file' | 'dir';
  }): Promise<void> {
    const entered = await useUiStore.getState().prompt({
      title: entry.type === 'dir' ? 'Rename folder' : 'Rename file',
      message: `Rename "${entry.path}". Give a path relative to the chat folder; the destination folder must already exist, and an existing file is never overwritten.`,
      placeholder: entry.path,
      confirmLabel: 'Rename',
    });
    if (entered === null) return;
    const to = entered.trim();
    if (to === '' || to === entry.path) return;
    await runFileOp({ op: 'rename', path: entry.path, to }, (landed) => {
      pushNotice(`Renamed ${entry.path} → ${landed}`);
      // Follow an open tab on the moved file (or anything under a moved
      // folder) to its new path rather than leaving it pointed at a path
      // that no longer reads.
      const moved = useLayoutStore.getState().findTab({ kind: 'file', chatId, path: entry.path });
      useLayoutStore.getState().closeMatching((d) => {
        if (d.kind !== 'file' || d.chatId !== chatId) return false;
        return d.path === entry.path || d.path.startsWith(`${entry.path}/`);
      });
      if (entry.type === 'file' && moved) {
        openTab({ kind: 'file', chatId, path: landed }, { placement: 'tab' });
      }
    });
  }

  async function deleteEntry(entry: {
    name: string;
    path: string;
    type: 'file' | 'dir';
  }): Promise<void> {
    const ok = await useUiStore.getState().confirm({
      title: entry.type === 'dir' ? 'Delete folder' : 'Delete file',
      message:
        entry.type === 'dir'
          ? `Delete the folder "${entry.path}" from the host? Only an empty folder can be deleted, and this cannot be undone.`
          : `Delete "${entry.path}" from the host? This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await runFileOp({ op: 'delete', path: entry.path }, (landed) => {
      pushNotice(`Deleted ${landed}`);
      useLayoutStore.getState().closeMatching((d) => {
        if (d.kind !== 'file' || d.chatId !== chatId) return false;
        return d.path === entry.path || d.path.startsWith(`${entry.path}/`);
      });
    });
  }

  function rowMenuItems(): ContextMenuItem[] {
    const entry = menuTarget;
    if (entry === null) return [];
    return [
      {
        id: 'rename',
        label: 'Rename',
        icon: <Pencil size={14} aria-hidden />,
        run: () => void renameEntry(entry),
      },
      {
        id: 'delete',
        label: 'Delete',
        icon: <Trash2 size={14} aria-hidden />,
        danger: true,
        run: () => void deleteEntry(entry),
      },
    ];
  }

  const listingFailed = recursiveError !== null && recursiveData === undefined;
  const tree = buildFileTree(recursiveData?.entries ?? []);
  const filterQ = filter.trim();
  const visibleTree = filterQ === '' ? tree : filterFileTree(tree, filterQ);

  return (
    <div
      className={`browse-panel files-page${treeCollapsed ? ' tree-collapsed' : ''}`}
      data-testid="files-page"
    >
      {treeCollapsed ? (
        <div className="browse-tree collapsed" data-testid="browse-tree-collapsed">
          <button
            type="button"
            className="browse-tree-expand"
            data-testid="browse-tree-expand"
            aria-label="expand directory tree"
            title="Show files"
            onClick={() => setBrowseTreeCollapsed(false)}
          >
            <PanelLeftOpen size={18} aria-hidden />
          </button>
        </div>
      ) : (
        <div
          className="browse-tree"
          data-testid="browse-tree"
          style={{ width: treeWidth, flex: `0 0 ${treeWidth}px` }}
        >
          <div className="browse-tree-header">
            <button
              type="button"
              className="browse-tree-toggle"
              data-testid="browse-new-file"
              aria-label="new file"
              title="New file"
              onClick={() => void createEntry('file')}
            >
              <FilePlus size={16} aria-hidden />
            </button>
            <button
              type="button"
              className="browse-tree-toggle"
              data-testid="browse-new-folder"
              aria-label="new folder"
              title="New folder"
              onClick={() => void createEntry('dir')}
            >
              <FolderPlus size={16} aria-hidden />
            </button>
            <button
              type="button"
              className="browse-tree-toggle"
              data-testid="browse-tree-toggle"
              aria-label="collapse directory tree"
              title="Hide files"
              onClick={() => setBrowseTreeCollapsed(true)}
            >
              <PanelLeftClose size={16} aria-hidden />
            </button>
          </div>
          <div className="browse-filter-row">
            <Search size={13} aria-hidden />
            <input
              className="browse-filter"
              data-testid="browse-filter"
              data-search-input
              value={filter}
              onChange={(ev) => patchBrowse({ filter: ev.target.value })}
              placeholder="Filter…"
              aria-label="filter files in this folder"
            />
          </div>
          <div className="browse-tree-list" data-testid="browse-tree-list">
            {treePending ? <BrowseSkeleton rows={6} testId="browse-tree-loading" /> : null}
            {listingFailed ? (
              <div className="browse-tree-error" data-testid="browse-tree-error" role="alert">
                {(recursiveError as Error).message}
              </div>
            ) : null}
            {!treePending && !listingFailed && visibleTree.length === 0 ? (
              <div className="browse-tree-empty" data-testid="browse-tree-empty">
                {filterQ === '' ? 'Empty folder' : 'No matches'}
              </div>
            ) : null}
            {!treePending && !listingFailed ? (
              <FileTreeRows
                nodes={visibleTree}
                depth={0}
                expandedDirs={expandedSet}
                forceExpand={filterQ !== ''}
                openFilePath={null}
                openFileDirty={false}
                renamingPath={renamingPath}
                renameValue={renameValue}
                onRenameChange={(v) => patchBrowse({ renameValue: v })}
                onRenameCommit={() => void commitRename()}
                onRenameCancel={cancelRename}
                onToggleDir={toggleDir}
                onOpenFile={(n) => openPath({ name: n.name, path: n.path })}
                onContextMenu={(entry, ev) => {
                  setMenuTarget(entry);
                  menu.openAt(ev);
                }}
              />
            ) : null}
          </div>
        </div>
      )}
      {treeCollapsed ? null : (
        <ColumnDivider
          side="left"
          width={treeWidth}
          onResize={setBrowseTreeWidth}
          testId="browse-tree-divider"
        />
      )}
      <div className="browse-editor files-page-placeholder" data-testid="files-page-placeholder">
        Select a file from the tree — it opens in its own tab.
      </div>
      {filePickerOpen ? (
        <FileSearch
          entries={recursiveData?.entries ?? []}
          loading={treePending}
          onPick={(name, fullPath) => {
            const target = fullPath ?? name;
            openPath({ name, path: target });
            setFilePickerOpen(false);
          }}
          onClose={() => setFilePickerOpen(false)}
        />
      ) : null}
      <ContextMenu
        anchor={menu.anchor}
        items={rowMenuItems()}
        onClose={menu.close}
        label="File actions"
        testId="row-actions-menu"
      />
    </div>
  );
}
