// The file browser reopens where it was left (spec/14 § File browser,
// § Panes and tabs).
//
// Reopening used to drop you back at the chat folder's root with a blank
// pane. This file pins the replacement — split across TWO surfaces now:
//
//   1. The TREE's position (`FilesPage`) lives in the ui store, keyed per
//      chat: expanded dirs, filter, lastActiveDir. Persisted (bounded).
//   2. An OPEN FILE is its own pane tab (`layoutStore`, tested in
//      layoutStore.test.ts/PaneArea.test.tsx) — the whole layout persists
//      across reload, same as any other tab.
//   3. A file's unsaved DRAFT is `FileEditorTab`'s own local state, IN
//      MEMORY ONLY (same convention the old rail's draft used) — it does
//      not survive that tab unmounting (closing it, or switching to a
//      different tab in the same pane), by design.
//
// Editor overhaul: the tree is hierarchical now (expand/collapse at any
// depth), so there is no more single "current directory" (`path`) to persist
// — `expandedDirs` (which directories are open) and `lastActiveDir` (where a
// new "untitled" entry lands) replace it.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { JSX } from 'react';
import { FilesPage } from '../components/FilesPage.js';
import { FileEditorTab } from '../components/FileEditorTab.js';
import {
  useUiStore,
  trimBrowseState,
  loadBrowseState,
  EMPTY_BROWSE_STATE,
} from '../stores/uiStore.js';
import type { BrowseChatState } from '../stores/uiStore.js';
import { useChatStore } from '../stores/chatStore.js';
import { useLayoutStore } from '../stores/layoutStore.js';
import { api } from '../api/rest.js';

vi.mock('../lib/monaco-loader.js', () => ({
  ensureMonacoLoaded: async () => undefined,
}));

// The editor mock forwards `value` so a restored draft is observable from the
// DOM, and takes `onChange` so a test can type without a real Monaco.
vi.mock('@monaco-editor/react', () => {
  const DiffEditor = (): JSX.Element => <div data-testid="mock-diff-editor" />;
  const Editor = ({
    value,
    onChange,
  }: {
    value?: string;
    onChange?: (v: string | undefined) => void;
  }): JSX.Element => (
    <textarea
      data-testid="mock-editor"
      value={value ?? ''}
      onChange={(e) => onChange?.(e.target.value)}
    />
  );
  return { DiffEditor, Editor };
});

const BROWSE_KEY = 'patch.browse.byChat.v1';

function withQuery(node: JSX.Element): JSX.Element {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

function seedChat(chatId: string): void {
  useChatStore.getState().hydrate([
    {
      chatId,
      daemonId: 'd1',
      permissionMode: 'bypassPermissions' as const,
      name: chatId,
      folder: 'repo',
      activity: 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      disabled: false,
      lastUpdated: 0,
    },
  ]);
}

/** `src/` holding `index.ts` + `other.ts`, plus `zeta.ts` at the root. */
function stubTree(): void {
  vi.spyOn(api, 'listFilesRecursive').mockResolvedValue({
    entries: [
      { name: 'src', type: 'dir' },
      { name: 'zeta.ts', type: 'file' },
      { name: 'src/index.ts', type: 'file' },
      { name: 'src/other.ts', type: 'file' },
    ],
  });
  vi.spyOn(api, 'getFileContent').mockImplementation(async (_id, path) => ({
    path,
    content: `// ${path}\n`,
    size: 8,
  }));
}

describe('browse state — the store', () => {
  beforeEach(() => {
    localStorage.clear();
    useUiStore.setState({ browseByChat: {} });
  });
  afterEach(() => {
    cleanup();
  });

  it('merges a patch into the chat’s entry and leaves other chats alone', () => {
    useUiStore.getState().setBrowseState('c1', { expandedDirs: ['src'] });
    useUiStore.getState().setBrowseState('c2', { filter: 'ts' });
    useUiStore.getState().setBrowseState('c1', { openFile: { name: 'a.ts', path: 'src/a.ts' } });

    const map = useUiStore.getState().browseByChat;
    expect(map['c1']?.expandedDirs).toEqual(['src']);
    expect(map['c1']?.openFile).toEqual({ name: 'a.ts', path: 'src/a.ts' });
    expect(map['c2']).toMatchObject({ expandedDirs: [], filter: 'ts', openFile: null });
  });

  it('persists expanded dirs, open file, filter and lastActiveDir — but never the draft', () => {
    useUiStore.getState().setBrowseState('c1', {
      expandedDirs: ['src'],
      filter: 'ind',
      openFile: { name: 'index.ts', path: 'src/index.ts' },
      lastActiveDir: 'src',
      draft: 'half-written line',
    });

    const raw = JSON.parse(localStorage.getItem(BROWSE_KEY) ?? '{}') as Record<string, unknown>;
    expect(raw['c1']).toMatchObject({
      expandedDirs: ['src'],
      filter: 'ind',
      openFile: { name: 'index.ts', path: 'src/index.ts' },
      lastActiveDir: 'src',
    });
    // The draft is session-only: a file's whole content does not belong in a
    // few-megabyte store, and a draft restored after a restart would be an edit
    // against a file the host may have changed since.
    expect(raw['c1']).not.toHaveProperty('draft');
    expect(useUiStore.getState().browseByChat['c1']?.draft).toBe('half-written line');
  });

  it('bounds the map, keeping the most recently touched chats', () => {
    for (let i = 0; i < 20; i++)
      useUiStore.getState().setBrowseState(`c${i}`, { lastActiveDir: `d${i}` });
    const map = useUiStore.getState().browseByChat;
    expect(Object.keys(map)).toHaveLength(12);
    // The last twelve written survive; the first eight are evicted.
    expect(map['c19']?.lastActiveDir).toBe('d19');
    expect(map['c8']?.lastActiveDir).toBe('d8');
    expect(map['c7']).toBeUndefined();
    expect(Object.keys(JSON.parse(localStorage.getItem(BROWSE_KEY) ?? '{}'))).toHaveLength(12);
  });

  it('reads a saved map back, and treats anything it cannot read as a first run', () => {
    expect(loadBrowseState()).toEqual({});

    localStorage.setItem(BROWSE_KEY, 'not json');
    expect(loadBrowseState()).toEqual({});
    localStorage.setItem(BROWSE_KEY, '["an array"]');
    expect(loadBrowseState()).toEqual({});
    localStorage.setItem(BROWSE_KEY, 'null');
    expect(loadBrowseState()).toEqual({});

    localStorage.setItem(
      BROWSE_KEY,
      JSON.stringify({
        good: {
          expandedDirs: ['src'],
          filter: 'x',
          openFile: { name: 'a.ts', path: 'src/a.ts' },
          lastActiveDir: 'src',
          touch: 4,
        },
        // Every field the wrong type, or missing: the chat is still known, it
        // just opens at its root. There is nothing to report to the user about
        // a preference that would not parse.
        rubbish: {
          expandedDirs: 'nope',
          filter: null,
          openFile: { name: 1 },
          lastActiveDir: 7,
          touch: 'soon',
        },
        notAnObject: 'nope',
      }),
    );
    expect(loadBrowseState()).toEqual({
      good: {
        expandedDirs: ['src'],
        filter: 'x',
        openFile: { name: 'a.ts', path: 'src/a.ts' },
        draft: null,
        draftBaseline: null,
        lastActiveDir: 'src',
        renamingPath: null,
        renameValue: '',
        touch: 4,
      },
      rubbish: { ...EMPTY_BROWSE_STATE },
    });
  });

  it('applies the bound to what it loads, not just to what it writes', () => {
    const saved: Record<string, unknown> = {};
    for (let i = 0; i < 20; i++)
      saved[`c${i}`] = { expandedDirs: [], filter: '', openFile: null, touch: i };
    localStorage.setItem(BROWSE_KEY, JSON.stringify(saved));
    const loaded = loadBrowseState();
    expect(Object.keys(loaded)).toHaveLength(12);
    expect(loaded['c19']).toBeDefined();
    expect(loaded['c7']).toBeUndefined();
  });

  it('trimBrowseState is a no-op below the bound', () => {
    const map: Record<string, BrowseChatState> = {
      a: { ...EMPTY_BROWSE_STATE, touch: 1 },
      b: { ...EMPTY_BROWSE_STATE, touch: 2 },
    };
    expect(trimBrowseState(map)).toBe(map);
  });
});

describe('FilesPage — tree position restored on reopen', () => {
  beforeEach(() => {
    localStorage.clear();
    useChatStore.getState()._reset();
    useLayoutStore.getState()._reset();
    useUiStore.setState({ browseByChat: {}, filePickerOpen: false, fileDiff: null });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it('closing (unmounting) and reopening the Files tab keeps the expanded directory and the filter', async () => {
    seedChat('c1');
    stubTree();
    const { unmount } = render(withQuery(<FilesPage chatId="c1" />));

    fireEvent.click(await screen.findByTestId('tree-row-src'));
    fireEvent.change(await screen.findByTestId('browse-filter'), { target: { value: 'ind' } });
    await screen.findByTestId('tree-row-src/index.ts');

    // Close the Files tab, exactly as ⌘W / the tab bar's × would — the tree
    // position lives in `uiStore`, not this component, so it survives.
    unmount();
    cleanup();

    render(withQuery(<FilesPage chatId="c1" />));
    // Filter still narrows to 'ind' — 'src' itself no longer matches, so the
    // filtered tree only shows 'src' as an ancestor of the match.
    expect(await screen.findByTestId('tree-row-src/index.ts')).toBeInTheDocument();
    expect(screen.getByTestId('browse-filter')).toHaveValue('ind');
  });

  it('restores a place saved before this session, from localStorage', async () => {
    seedChat('c1');
    stubTree();
    // What a previous session left behind. Loaded by the store at boot; set it
    // here directly, since the store is already constructed.
    act(() => {
      useUiStore.getState().setBrowseState('c1', { expandedDirs: ['src'] });
    });

    render(withQuery(<FilesPage chatId="c1" />));

    expect(await screen.findByTestId('tree-row-src/index.ts')).toBeInTheDocument();
  });

  it('two chats keep two separate places', async () => {
    seedChat('c1');
    seedChat('c2');
    stubTree();
    act(() => {
      useUiStore.getState().setBrowseState('c1', { expandedDirs: ['src'] });
    });
    const { rerender } = render(withQuery(<FilesPage chatId="c1" />));
    await screen.findByTestId('tree-row-src/index.ts');

    // The other chat starts fresh — `src` not expanded.
    rerender(withQuery(<FilesPage chatId="c2" />));
    await waitFor(() => expect(screen.queryByTestId('tree-row-src/index.ts')).toBeNull());

    // And c1 is still where it was.
    rerender(withQuery(<FilesPage chatId="c1" />));
    expect(await screen.findByTestId('tree-row-src/index.ts')).toBeInTheDocument();
  });

  it('does not read the host’s disk once the Files tab has closed', async () => {
    seedChat('c1');
    stubTree();
    const { unmount } = render(withQuery(<FilesPage chatId="c1" />));
    await screen.findByTestId('tree-row-src');
    const callsWhileOpen = vi.mocked(api.listFilesRecursive).mock.calls.length;

    unmount();
    // An unmounted tab keeps no query alive — there is nothing left to keep
    // walking folders.
    await new Promise((r) => setTimeout(r, 10));
    expect(vi.mocked(api.listFilesRecursive).mock.calls.length).toBe(callsWhileOpen);
  });
});

describe('FileEditorTab — draft is in-memory only', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    useUiStore.setState({ pendingDiffByChat: {}, fileDiff: null });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it('keeps an unsaved draft across a re-render of the SAME mounted tab', async () => {
    seedChat('c1');
    vi.spyOn(api, 'getFileContent').mockResolvedValue({
      path: 'zeta.ts',
      content: '// zeta.ts\n',
      size: 8,
    });
    const { rerender } = render(
      withQuery(<FileEditorTab chatId="c1" path="zeta.ts" tabId="t1" focused ws={null} />),
    );
    const editor = await screen.findByTestId('mock-editor');
    await waitFor(() => expect(editor).toHaveValue('// zeta.ts\n'));
    fireEvent.change(editor, { target: { value: '// zeta.ts\nconst unsaved = 1;\n' } });
    await waitFor(() => expect(screen.getByTestId('browse-save')).toBeEnabled());

    // A re-render with the same props (e.g. the pane re-rendering for an
    // unrelated reason) must not re-create the component and lose the draft.
    rerender(withQuery(<FileEditorTab chatId="c1" path="zeta.ts" tabId="t1" focused ws={null} />));
    expect(screen.getByTestId('mock-editor')).toHaveValue('// zeta.ts\nconst unsaved = 1;\n');
    expect(screen.getByTestId('browse-save')).toBeEnabled();
  });

  it('loses the draft once its tab unmounts (closed, or switched away from in the same pane) — by design', async () => {
    seedChat('c1');
    vi.spyOn(api, 'getFileContent').mockResolvedValue({
      path: 'zeta.ts',
      content: '// zeta.ts\n',
      size: 8,
    });
    const { unmount } = render(
      withQuery(<FileEditorTab chatId="c1" path="zeta.ts" tabId="t1" focused ws={null} />),
    );
    const editor = await screen.findByTestId('mock-editor');
    await waitFor(() => expect(editor).toHaveValue('// zeta.ts\n'));
    fireEvent.change(editor, { target: { value: 'edited' } });
    await waitFor(() => expect(screen.getByTestId('browse-save')).toBeEnabled());

    unmount();
    cleanup();
    render(withQuery(<FileEditorTab chatId="c1" path="zeta.ts" tabId="t1" focused ws={null} />));
    await waitFor(() => expect(screen.getByTestId('mock-editor')).toHaveValue('// zeta.ts\n'));
    expect(screen.getByTestId('browse-save')).toBeDisabled();
  });
});

describe('FileEditorTab — a remembered file that has gone', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it('says why the file could not be read instead of drawing it as empty, and refuses to Save over it', async () => {
    seedChat('c1');
    vi.spyOn(api, 'getFileContent').mockRejectedValue(new Error('not_found: gone.ts'));

    render(withQuery(<FileEditorTab chatId="c1" path="gone.ts" tabId="t1" focused ws={null} />));

    const err = await screen.findByTestId('browse-content-error');
    expect(err).toHaveTextContent('not_found: gone.ts');
    expect(err).toHaveTextContent('gone.ts');
    expect(screen.getByTestId('browse-save')).toBeDisabled();
    // The failure is a toast as well — the app's one error surface.
    await waitFor(() => expect(useUiStore.getState().errors.length).toBeGreaterThan(0));
  });

  it('a listing that could not be read reads as the error, not as an empty folder', async () => {
    seedChat('c1');
    vi.spyOn(api, 'listFilesRecursive').mockRejectedValue(new Error('not_found: repo'));

    render(withQuery(<FilesPage chatId="c1" />));

    expect(await screen.findByTestId('browse-tree-error')).toHaveTextContent('not_found: repo');
    expect(screen.queryByTestId('browse-tree-empty')).toBeNull();
  });
});
