// Browse-panel redesign (todo: "browse is a mess, needs a redesign to feel way
// more usable") — spec/14 § File browser.
//
// The tree used to be: a raw `/a/b/c` string, a `../` row that climbed exactly
// one level per click, entries in whatever order the host's readdir returned,
// no way to narrow a big directory in place, no indication of which file the
// editor was showing, and a blank pane for an empty folder. This file pins the
// redesign:
//
//   1. Deterministic ordering — directories first, then files, A→Z, case-insensitive.
//   2. A persistent filter box that narrows the tree.
//   3. The open file's row is marked active (`aria-current`).
//   4. Explicit empty states — `Empty folder` / `No matches`.
//   5. Meta strip reads basename-first with the directory muted.
//
// Editor overhaul: the breadcrumb / one-directory-at-a-time navigation this
// file used to pin is GONE — the tree is now hierarchical (expand/collapse at
// any depth), backed entirely by `api.listFilesRecursive`.
//
// spec/14 § Panes and tabs: the tree moved from the docked rail's
// `BrowsePanel` to `FilesPage` — opening a file now opens (or focuses) that
// file's own tab (`FileEditorTab`) instead of an inline editor pane beside
// the tree, so the tree itself no longer tracks "the open file" at all.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { JSX } from 'react';
import { sortEntries } from '../components/EditorRail.js';
import { FilesPage } from '../components/FilesPage.js';
import { FileEditorTab } from '../components/FileEditorTab.js';
import { useUiStore } from '../stores/uiStore.js';
import { useChatStore } from '../stores/chatStore.js';
import { useLayoutStore } from '../stores/layoutStore.js';
import { api } from '../api/rest.js';

vi.mock('../lib/monaco-loader.js', () => ({
  ensureMonacoLoaded: async () => undefined,
}));

vi.mock('@monaco-editor/react', () => {
  const DiffEditor = (): JSX.Element => <div data-testid="mock-diff-editor" />;
  const Editor = ({ value }: { value?: string }): JSX.Element => (
    <div data-testid="mock-editor">{value}</div>
  );
  return { DiffEditor, Editor };
});

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

describe('BrowsePanel redesign — tree contents', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    useLayoutStore.getState()._reset();
    useUiStore.setState({
      filePickerOpen: false,
      fileDiff: null,
      browseTreeCollapsed: false,
      browseByChat: {},
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it('sorts directories first, then files, alphabetically and case-insensitively', async () => {
    seedChat('c1');
    // Deliberately scrambled, mixed-case, files interleaved with dirs — the
    // shape a real readdir hands back.
    vi.spyOn(api, 'listFilesRecursive').mockResolvedValue({
      entries: [
        { name: 'zeta.ts', type: 'file' },
        { name: 'src', type: 'dir' },
        { name: 'Apple.md', type: 'file' },
        { name: 'Zulu', type: 'dir' },
        { name: 'banana.ts', type: 'file' },
        { name: 'assets', type: 'dir' },
      ],
    });
    render(withQuery(<FilesPage chatId="c1" />));
    await screen.findByTestId('tree-row-zeta.ts');
    const names = Array.from(
      screen.getByTestId('browse-tree-list').querySelectorAll('[data-testid^="tree-row-"]'),
    ).map((el) => el.getAttribute('data-testid'));
    expect(names).toEqual([
      'tree-row-assets',
      'tree-row-src',
      'tree-row-Zulu',
      'tree-row-Apple.md',
      'tree-row-banana.ts',
      'tree-row-zeta.ts',
    ]);
  });

  it('filters the tree in place, case-insensitively', async () => {
    seedChat('c1');
    vi.spyOn(api, 'listFilesRecursive').mockResolvedValue({
      entries: [
        { name: 'README.md', type: 'file' },
        { name: 'server.ts', type: 'file' },
        { name: 'src', type: 'dir' },
      ],
    });
    render(withQuery(<FilesPage chatId="c1" />));
    await screen.findByTestId('tree-row-README.md');
    fireEvent.change(screen.getByTestId('browse-filter'), { target: { value: 'SER' } });
    expect(screen.getByTestId('tree-row-server.ts')).toBeInTheDocument();
    expect(screen.queryByTestId('tree-row-README.md')).toBeNull();
    expect(screen.queryByTestId('tree-row-src')).toBeNull();
  });

  it('says "No matches" when the filter excludes everything', async () => {
    seedChat('c1');
    vi.spyOn(api, 'listFilesRecursive').mockResolvedValue({
      entries: [{ name: 'README.md', type: 'file' }],
    });
    render(withQuery(<FilesPage chatId="c1" />));
    await screen.findByTestId('tree-row-README.md');
    fireEvent.change(screen.getByTestId('browse-filter'), { target: { value: 'nope' } });
    expect(screen.getByTestId('browse-tree-empty')).toHaveTextContent('No matches');
  });

  it('says "Empty folder" for a chat folder with no entries', async () => {
    seedChat('c1');
    vi.spyOn(api, 'listFilesRecursive').mockResolvedValue({ entries: [] });
    render(withQuery(<FilesPage chatId="c1" />));
    expect(await screen.findByTestId('browse-tree-empty')).toHaveTextContent('Empty folder');
  });

  it('renders dotfiles the host returns (e.g. .env.local) — the tree does not re-filter what the API sends', async () => {
    seedChat('c1');
    vi.spyOn(api, 'listFilesRecursive').mockResolvedValue({
      entries: [
        { name: '.env.local', type: 'file' },
        { name: '.config', type: 'dir' },
        { name: 'src', type: 'dir' },
      ],
    });
    render(withQuery(<FilesPage chatId="c1" />));
    expect(await screen.findByTestId('tree-row-.env.local')).toBeInTheDocument();
    expect(screen.getByTestId('tree-row-.config')).toBeInTheDocument();
  });

  it('opens a clicked file as its own tab, which shows basename-first meta', async () => {
    seedChat('c1');
    vi.spyOn(api, 'listFilesRecursive').mockResolvedValue({
      entries: [
        { name: 'src', type: 'dir' },
        { name: 'src/a.ts', type: 'file' },
        { name: 'src/b.ts', type: 'file' },
      ],
    });
    vi.spyOn(api, 'getFileContent').mockResolvedValue({ path: 'src/a.ts', content: 'x', size: 1 });
    render(withQuery(<FilesPage chatId="c1" />));
    fireEvent.click(await screen.findByTestId('tree-row-src'));
    fireEvent.click(await screen.findByTestId('tree-row-src/a.ts'));

    await waitFor(() =>
      expect(
        useLayoutStore.getState().findTab({ kind: 'file', chatId: 'c1', path: 'src/a.ts' }),
      ).not.toBeNull(),
    );
    // The tree itself tracks no "open file" any more — each file is its own
    // tab now, not a single inline pane the tree highlights into.
    expect(screen.queryByTestId('tree-row-src/a.ts')).not.toHaveAttribute('aria-current');

    cleanup();
    render(withQuery(<FileEditorTab chatId="c1" path="src/a.ts" tabId="t1" focused ws={null} />));
    // Meta strip: basename is the primary label, its directory is muted.
    expect(await screen.findByTestId('browse-meta-name')).toHaveTextContent('a.ts');
    expect(screen.getByTestId('browse-meta-dir')).toHaveTextContent('src/');
  });
});

describe('sortEntries', () => {
  it('breaks a case-insensitive tie deterministically instead of leaving readdir order', () => {
    // `Readme.md` and `README.md` compare equal case-insensitively; without a
    // tiebreak their order would depend on the host's readdir, so the two
    // rows could swap between reads.
    const asGiven = sortEntries([
      { name: 'Readme.md', type: 'file' as const },
      { name: 'README.md', type: 'file' as const },
    ]).map((e) => e.name);
    const reversed = sortEntries([
      { name: 'README.md', type: 'file' as const },
      { name: 'Readme.md', type: 'file' as const },
    ]).map((e) => e.name);
    expect(asGiven).toEqual(reversed);
  });

  it('does not mutate the array it is given', () => {
    const input = [
      { name: 'b.ts', type: 'file' as const },
      { name: 'a', type: 'dir' as const },
    ];
    sortEntries(input);
    expect(input.map((e) => e.name)).toEqual(['b.ts', 'a']);
  });
});
