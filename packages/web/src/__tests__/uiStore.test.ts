// uiStore toast lifecycle (I1-d7): error toasts must auto-dismiss after a
// timeout and be clearable on navigation, rather than persisting forever.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useUiStore } from '../stores/uiStore.js';
import { useLayoutStore } from '../stores/layoutStore.js';

describe('uiStore toasts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useUiStore.getState().clearToasts();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('auto-dismisses an error toast after the TTL', () => {
    useUiStore.getState().pushError('revoke failed: invalid body');
    expect(useUiStore.getState().errors).toHaveLength(1);
    expect(useUiStore.getState().errors[0]!.level).toBe('error');
    // Still present a few seconds in.
    vi.advanceTimersByTime(3000);
    expect(useUiStore.getState().errors).toHaveLength(1);
    // Gone after the TTL elapses.
    vi.advanceTimersByTime(4000);
    expect(useUiStore.getState().errors).toHaveLength(0);
  });

  it('pushNotice surfaces an auto-dismissing info toast', () => {
    useUiStore.getState().pushNotice('Device removed.');
    expect(useUiStore.getState().errors).toHaveLength(1);
    expect(useUiStore.getState().errors[0]!.level).toBe('info');
    vi.advanceTimersByTime(7000);
    expect(useUiStore.getState().errors).toHaveLength(0);
  });

  it('clearToasts removes every toast immediately (navigation clear)', () => {
    useUiStore.getState().pushError('a');
    useUiStore.getState().pushError('b');
    expect(useUiStore.getState().errors).toHaveLength(2);
    useUiStore.getState().clearToasts();
    expect(useUiStore.getState().errors).toHaveLength(0);
  });
});

describe('uiStore layout widths (spec/14 ## Layout — drag-resize persists)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('setSidebarWidth clamps and persists the width to localStorage', () => {
    useUiStore.getState().setSidebarWidth(372);
    expect(useUiStore.getState().sidebarWidth).toBe(372);
    expect(localStorage.getItem('patch.layout.sidebarWidth')).toBe('372');
    // Clamps below min (200) and above max (600).
    useUiStore.getState().setSidebarWidth(150);
    expect(useUiStore.getState().sidebarWidth).toBe(200);
    useUiStore.getState().setSidebarWidth(9999);
    expect(useUiStore.getState().sidebarWidth).toBe(600);
  });

  // Mini sidebar (Todoist, Patch Updates): dragging the divider narrower than
  // the full sidebar can go turns it into a status-dot rail; dragging back out
  // restores it. The full width is left alone so the rail expands to where it was.
  it('setSidebarWidth below the mini threshold switches to the rail and keeps the full width', () => {
    useUiStore.getState().setSidebarWidth(372);
    useUiStore.getState().setSidebarWidth(90);
    expect(useUiStore.getState().sidebarMini).toBe(true);
    expect(useUiStore.getState().sidebarWidth).toBe(372);
    expect(localStorage.getItem('patch.layout.sidebarMini')).toBe('true');
    useUiStore.getState().setSidebarWidth(260);
    expect(useUiStore.getState().sidebarMini).toBe(false);
    expect(useUiStore.getState().sidebarWidth).toBe(260);
    expect(localStorage.getItem('patch.layout.sidebarMini')).toBe('false');
  });

  // F1: the file-browser directory tree width is resizable + persisted.
  it('setBrowseTreeWidth clamps (140–560) and persists the tree width', () => {
    useUiStore.getState().setBrowseTreeWidth(320);
    expect(useUiStore.getState().browseTreeWidth).toBe(320);
    expect(localStorage.getItem('patch.layout.browseTreeWidth')).toBe('320');
    useUiStore.getState().setBrowseTreeWidth(10);
    expect(useUiStore.getState().browseTreeWidth).toBe(140);
    useUiStore.getState().setBrowseTreeWidth(9999);
    expect(useUiStore.getState().browseTreeWidth).toBe(560);
  });

  // F1: the collapsed flag is persisted so it survives a reload.
  it('setBrowseTreeCollapsed persists the collapsed flag', () => {
    useUiStore.getState().setBrowseTreeCollapsed(true);
    expect(useUiStore.getState().browseTreeCollapsed).toBe(true);
    expect(localStorage.getItem('patch.browse.treeCollapsed')).toBe('true');
    useUiStore.getState().setBrowseTreeCollapsed(false);
    expect(useUiStore.getState().browseTreeCollapsed).toBe(false);
    expect(localStorage.getItem('patch.browse.treeCollapsed')).toBe('false');
  });

  it('restores a persisted browse-tree width + collapsed flag on a fresh store (reload path)', async () => {
    localStorage.setItem('patch.layout.browseTreeWidth', '410');
    localStorage.setItem('patch.browse.treeCollapsed', 'true');
    vi.resetModules();
    const fresh = await import('../stores/uiStore.js');
    expect(fresh.useUiStore.getState().browseTreeWidth).toBe(410);
    expect(fresh.useUiStore.getState().browseTreeCollapsed).toBe(true);
  });

  it('a persisted width is restored when a fresh store initialises (reload path)', async () => {
    // Simulate a prior session having saved a custom width, then a reload.
    localStorage.setItem('patch.layout.sidebarWidth', '345');
    vi.resetModules();
    const fresh = await import('../stores/uiStore.js');
    expect(fresh.useUiStore.getState().sidebarWidth).toBe(345);
  });

  it('falls back to the default width when the stored value is not a finite number', async () => {
    localStorage.setItem('patch.layout.sidebarWidth', 'not-a-number');
    vi.resetModules();
    const fresh = await import('../stores/uiStore.js');
    expect(fresh.useUiStore.getState().sidebarWidth).toBe(280);
  });
});

describe('uiStore simple boolean/string setters', () => {
  it('toggles channels/archived/sidebar/cheatsheet/search/editor state', () => {
    const s = useUiStore.getState();
    s.setChannelsOpen(true);
    expect(useUiStore.getState().channelsOpen).toBe(true);
    s.setArchivedOpen(true);
    expect(useUiStore.getState().archivedOpen).toBe(true);
    s.setSidebarCollapsed(true);
    expect(useUiStore.getState().sidebarCollapsed).toBe(true);
    s.setCheatSheetOpen(true);
    expect(useUiStore.getState().cheatSheetOpen).toBe(true);
    s.setSearchQuery('hello');
    expect(useUiStore.getState().searchQuery).toBe('hello');
    s.setFilePickerOpen(true);
    expect(useUiStore.getState().filePickerOpen).toBe(true);
    s.setDeletedOpen(true);
    expect(useUiStore.getState().deletedOpen).toBe(true);
  });
});

// spec/14 § New windows — a window opened via one of the "open in new
// window" actions carries `?sidebar=hidden`, read ONCE at module-init time
// (not toggled post-mount, which would flash the sidebar visible for a
// frame). `loadSidebarHiddenParam` isn't exported, so this exercises it
// through the store's initial `sidebarCollapsed` value, per the
// `vi.resetModules()` + dynamic-import pattern used for the other
// module-init-time reads above.
describe('uiStore sidebarCollapsed initial state (§ New windows)', () => {
  afterEach(() => {
    window.history.pushState({}, '', '/');
  });

  it('defaults to false (visible) with no query string', async () => {
    window.history.pushState({}, '', '/app/');
    vi.resetModules();
    const fresh = await import('../stores/uiStore.js');
    expect(fresh.useUiStore.getState().sidebarCollapsed).toBe(false);
  });

  it('starts collapsed when the URL carries ?sidebar=hidden', async () => {
    window.history.pushState({}, '', '/app/chats/c1?sidebar=hidden');
    vi.resetModules();
    const fresh = await import('../stores/uiStore.js');
    expect(fresh.useUiStore.getState().sidebarCollapsed).toBe(true);
  });

  it('an unrelated query param does not collapse the sidebar', async () => {
    window.history.pushState({}, '', '/app/chats/c1?draft=abc');
    vi.resetModules();
    const fresh = await import('../stores/uiStore.js');
    expect(fresh.useUiStore.getState().sidebarCollapsed).toBe(false);
  });
});

describe('uiStore forgotten folders (E6)', () => {
  beforeEach(() => {
    localStorage.clear();
    useUiStore.setState({ forgottenFolders: [] });
  });

  it('forgetFolder appends + persists, and is idempotent for a folder already forgotten', () => {
    useUiStore.getState().forgetFolder('/a');
    expect(useUiStore.getState().forgottenFolders).toEqual(['/a']);
    expect(JSON.parse(localStorage.getItem('patch.sidebar.forgottenFolders')!)).toEqual(['/a']);
    // Idempotent — forgetting the same folder again does not duplicate it.
    useUiStore.getState().forgetFolder('/a');
    expect(useUiStore.getState().forgottenFolders).toEqual(['/a']);
    useUiStore.getState().forgetFolder('/b');
    expect(useUiStore.getState().forgottenFolders).toEqual(['/a', '/b']);
  });

  it('restores a persisted forgotten-folders list on a fresh store (reload path)', async () => {
    localStorage.setItem('patch.sidebar.forgottenFolders', JSON.stringify(['/x', 42, '/y']));
    vi.resetModules();
    const fresh = await import('../stores/uiStore.js');
    // Non-string entries are filtered out (NO FALLBACK to a bad value).
    expect(fresh.useUiStore.getState().forgottenFolders).toEqual(['/x', '/y']);
  });

  it('falls back to an empty list when the stored value is not an array', async () => {
    localStorage.setItem('patch.sidebar.forgottenFolders', JSON.stringify({ not: 'an array' }));
    vi.resetModules();
    const fresh = await import('../stores/uiStore.js');
    expect(fresh.useUiStore.getState().forgottenFolders).toEqual([]);
  });

  it('falls back to an empty list when the stored value is unparseable JSON', async () => {
    localStorage.setItem('patch.sidebar.forgottenFolders', '{not json');
    vi.resetModules();
    const fresh = await import('../stores/uiStore.js');
    expect(fresh.useUiStore.getState().forgottenFolders).toEqual([]);
  });
});

describe('uiStore pending diffs + file diffs', () => {
  beforeEach(() => {
    useUiStore.setState({
      pendingDiffByChat: {},
      fileDiff: null,
    });
  });

  const diffA = {
    requestId: 'r1',
    chatId: 'chat-a',
    tool: 'edit',
    filePath: '/a.ts',
    original: 'a',
    modified: 'a2',
  };
  const diffB = {
    requestId: 'r2',
    chatId: 'chat-b',
    tool: 'edit',
    filePath: '/b.ts',
    original: 'b',
    modified: 'b2',
  };

  it('setPendingDiff records the diff under its own chat, independent of any other chat', () => {
    useUiStore.getState().setPendingDiff(diffA);
    useUiStore.getState().setPendingDiff(diffB);
    expect(useUiStore.getState().pendingDiffByChat['chat-a']).toEqual(diffA);
    expect(useUiStore.getState().pendingDiffByChat['chat-b']).toEqual(diffB);
  });

  it('clearPendingDiffForChat only clears the matching chat+requestId, never a different request', () => {
    useUiStore.getState().setPendingDiff(diffA);
    useUiStore.getState().setPendingDiff(diffB);
    // A stale/mismatched requestId must not clear a still-current diff.
    useUiStore.getState().clearPendingDiffForChat('chat-a', 'not-r1');
    expect(useUiStore.getState().pendingDiffByChat['chat-a']).toEqual(diffA);

    useUiStore.getState().clearPendingDiffForChat('chat-a', 'r1');
    expect(useUiStore.getState().pendingDiffByChat['chat-a']).toBeUndefined();
    expect(useUiStore.getState().pendingDiffByChat['chat-b']).toEqual(diffB);
  });

  const changeSet = [
    { path: 'a.ts', original: 'a', modified: 'a2' },
    { path: 'b.ts', original: 'b', modified: 'b2' },
  ];

  it('openFileDiff clamps the active index into range and opens a tab per file in the change set', () => {
    useLayoutStore.getState()._reset();
    useUiStore.getState().openFileDiff({ chatId: 'chat-a', changeSet, activeIndex: 99 });
    const fd = useUiStore.getState().fileDiff;
    expect(fd?.activeIndex).toBe(1);
    expect(
      useLayoutStore.getState().findTab({ kind: 'file', chatId: 'chat-a', path: 'a.ts' }),
    ).not.toBeNull();
    expect(
      useLayoutStore.getState().findTab({ kind: 'file', chatId: 'chat-a', path: 'b.ts' }),
    ).not.toBeNull();
  });

  it('openFileDiff clamps a negative index up to 0', () => {
    useUiStore.getState().openFileDiff({ chatId: 'chat-a', changeSet, activeIndex: -5 });
    expect(useUiStore.getState().fileDiff?.activeIndex).toBe(0);
  });

  it('setFileDiffIndex is a no-op when there is no current file diff', () => {
    useUiStore.getState().clearFileDiff();
    useUiStore.getState().setFileDiffIndex(1);
    expect(useUiStore.getState().fileDiff).toBeNull();
  });

  it('setFileDiffIndex clamps within the change set range', () => {
    useUiStore.getState().openFileDiff({ chatId: 'chat-a', changeSet, activeIndex: 0 });
    useUiStore.getState().setFileDiffIndex(5);
    expect(useUiStore.getState().fileDiff?.activeIndex).toBe(1);
    useUiStore.getState().setFileDiffIndex(-5);
    expect(useUiStore.getState().fileDiff?.activeIndex).toBe(0);
  });

  it('clearFileDiff clears the file diff', () => {
    useUiStore.getState().openFileDiff({ chatId: 'chat-a', changeSet, activeIndex: 0 });
    useUiStore.getState().clearFileDiff();
    expect(useUiStore.getState().fileDiff).toBeNull();
  });
});

// spec/14 § Jobs view — the job editor's Edit-skill link points at one file.
// spec/14 § Panes and tabs: it opens that file as its own tab now, not a
// docked rail.
describe('uiStore browse requests', () => {
  beforeEach(() => {
    useLayoutStore.getState()._reset();
  });

  it('openFileInBrowser opens the file as its own tab', () => {
    useUiStore
      .getState()
      .openFileInBrowser({ chatId: 'chat-a', path: '.claude/skills/plant.md', name: 'plant.md' });
    expect(
      useLayoutStore
        .getState()
        .findTab({ kind: 'file', chatId: 'chat-a', path: '.claude/skills/plant.md' }),
    ).not.toBeNull();
  });
});

describe('uiStore error toast dedupe + dismiss', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useUiStore.getState().clearToasts();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('pushError dedupes an identical pending error instead of stacking a duplicate', () => {
    useUiStore.getState().pushError('same message');
    expect(useUiStore.getState().errors).toHaveLength(1);
    vi.advanceTimersByTime(4000);
    // Push the same message again — should dedupe (no second toast added), and
    // schedule an additional (idempotent) removal rather than throwing.
    useUiStore.getState().pushError('same message');
    expect(useUiStore.getState().errors).toHaveLength(1);
    vi.advanceTimersByTime(10000);
    expect(useUiStore.getState().errors).toHaveLength(0);
  });

  it('dismissError removes a specific toast by id', () => {
    useUiStore.getState().pushError('a');
    const id = useUiStore.getState().errors[0]!.id;
    useUiStore.getState().pushError('b');
    useUiStore.getState().dismissError(id);
    expect(useUiStore.getState().errors).toHaveLength(1);
    expect(useUiStore.getState().errors[0]!.message).toBe('b');
  });

  it('pushError stores the retry callback when provided', () => {
    const retry = vi.fn();
    useUiStore.getState().pushError('retryable', retry);
    expect(useUiStore.getState().errors[0]!.retry).toBe(retry);
  });
});

// spec/14 § Sidebar §4 — a project folds its rows away and stays folded across
// reloads. Keyed on the folder's FULL PATH, not its basename: two projects can
// share a name and collapsing one must not fold the other.
//
// `localStorage` is shared by every test in this file (one jsdom window) and
// `vitest.config.ts` sets `retry: 2`, so each test clears the key itself rather
// than leaning on a global afterEach.
describe('uiStore collapsed projects (spec/14 § Sidebar §4)', () => {
  const KEY = 'patch.sidebar.collapsedFolders';

  beforeEach(() => {
    window.localStorage.clear();
    useUiStore.setState({ collapsedFolders: [] });
  });

  it('toggles a folder collapsed and back open', () => {
    useUiStore.getState().toggleFolderCollapsed('/home/tom/projects/bus');
    expect(useUiStore.getState().collapsedFolders).toEqual(['/home/tom/projects/bus']);
    useUiStore.getState().toggleFolderCollapsed('/home/tom/projects/bus');
    expect(useUiStore.getState().collapsedFolders).toEqual([]);
  });

  it('collapsing one project leaves the others open', () => {
    useUiStore.getState().toggleFolderCollapsed('/home/tom/projects/bus');
    useUiStore.getState().toggleFolderCollapsed('/home/tom/projects/portfolio');
    useUiStore.getState().toggleFolderCollapsed('/home/tom/projects/bus');
    expect(useUiStore.getState().collapsedFolders).toEqual(['/home/tom/projects/portfolio']);
  });

  it('is keyed on the full path — same basename, different project', () => {
    useUiStore.getState().toggleFolderCollapsed('/home/tom/work/patch');
    expect(useUiStore.getState().collapsedFolders).toEqual(['/home/tom/work/patch']);
    expect(useUiStore.getState().collapsedFolders).not.toContain('/home/tom/projects/patch');
  });

  it('persists each change to localStorage', () => {
    useUiStore.getState().toggleFolderCollapsed('/home/tom/projects/bus');
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toEqual(['/home/tom/projects/bus']);
    useUiStore.getState().toggleFolderCollapsed('/home/tom/projects/bus');
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toEqual([]);
  });

  it('round-trips through localStorage into a freshly loaded store', async () => {
    window.localStorage.setItem(KEY, JSON.stringify(['/home/tom/projects/bus']));
    vi.resetModules();
    const fresh = await import('../stores/uiStore.js');
    expect(fresh.useUiStore.getState().collapsedFolders).toEqual(['/home/tom/projects/bus']);
  });

  it('a garbled stored value reads as nothing collapsed, not a crash', async () => {
    window.localStorage.setItem(KEY, '{not json');
    vi.resetModules();
    const fresh = await import('../stores/uiStore.js');
    expect(fresh.useUiStore.getState().collapsedFolders).toEqual([]);
  });

  it('drops non-string entries from a stored array', async () => {
    window.localStorage.setItem(KEY, JSON.stringify(['/home/tom/projects/bus', 7, null]));
    vi.resetModules();
    const fresh = await import('../stores/uiStore.js');
    expect(fresh.useUiStore.getState().collapsedFolders).toEqual(['/home/tom/projects/bus']);
  });
});

// spec/14 § Main chat panel — Background task bar. The stack of per-task bars
// folds to one counted summary line, and the fold is a per-user display
// preference: one boolean, not a per-chat set, so it survives a reload and
// applies to whichever chat is open.
describe('uiStore background-task fold (spec/14 § Background task bar)', () => {
  const KEY = 'patch.chat.backgroundTasksCollapsed';

  beforeEach(() => {
    window.localStorage.clear();
    useUiStore.setState({ backgroundTasksCollapsed: false });
  });

  it('defaults to expanded — one bar per task is the resting state', () => {
    expect(useUiStore.getState().backgroundTasksCollapsed).toBe(false);
  });

  it('persists the fold and the unfold to localStorage', () => {
    useUiStore.getState().setBackgroundTasksCollapsed(true);
    expect(useUiStore.getState().backgroundTasksCollapsed).toBe(true);
    expect(window.localStorage.getItem(KEY)).toBe('true');
    useUiStore.getState().setBackgroundTasksCollapsed(false);
    expect(useUiStore.getState().backgroundTasksCollapsed).toBe(false);
    expect(window.localStorage.getItem(KEY)).toBe('false');
  });

  it('round-trips a fold through localStorage into a freshly loaded store', async () => {
    window.localStorage.setItem(KEY, 'true');
    vi.resetModules();
    const fresh = await import('../stores/uiStore.js');
    expect(fresh.useUiStore.getState().backgroundTasksCollapsed).toBe(true);
  });

  it('a garbled stored value reads as expanded, not a crash', async () => {
    window.localStorage.setItem(KEY, 'yes please');
    vi.resetModules();
    const fresh = await import('../stores/uiStore.js');
    expect(fresh.useUiStore.getState().backgroundTasksCollapsed).toBe(false);
  });
});
