// File browser loading states (spec/14 § File browser — "Loading is drawn, not
// implied"; Todoist: "patch file viewer has no loading state just lookes
// empty").
//
// All three of the browser's fetches used to read only `{ data, error }` off
// their query, so while one was in flight the pane rendered the shape that
// fetch would have had if it had returned NOTHING:
//
//   - the tree drew `Empty folder` over a directory nobody had read yet,
//   - the editor drew a blank document over a file whose bytes were in flight,
//   - ⌘P stood the CURRENT directory in for the project-wide index.
//
// Each case below fails against that version and passes against the skeleton.
// The three "must not settle into a permanent skeleton" cases pin the other
// half: a loading state that swallowed an error would be worse than none.
//
// Editor overhaul: the tree and ⌘P now share ONE fetch (`listFilesRecursive`)
// instead of two separate ones (a per-directory listing plus a recursive
// index) — there is no more "current directory" to stand in for the
// project-wide index, because there is no more single current directory.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { JSX } from 'react';
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

/** A promise plus the handles to settle it, so a fetch can be held open. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: Error) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type RecursiveListing = { entries: Array<{ name: string; type: 'file' | 'dir'; dirty?: boolean }> };

describe('file browser — loading states', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    useLayoutStore.getState()._reset();
    useUiStore.getState().clearToasts();
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

  it('draws a tree skeleton while the first listing is in flight, not `Empty folder`', async () => {
    seedChat('c1');
    const d = deferred<RecursiveListing>();
    vi.spyOn(api, 'listFilesRecursive').mockReturnValue(d.promise);

    render(withQuery(<FilesPage chatId="c1" />));

    expect(await screen.findByTestId('browse-tree-loading')).toBeInTheDocument();
    // The bug: the resolved-empty fallback claimed the folder was empty.
    expect(screen.queryByTestId('browse-tree-empty')).toBeNull();

    await act(async () => {
      d.resolve({ entries: [{ name: 'foo.ts', type: 'file' }] });
    });

    await waitFor(() => {
      expect(screen.queryByTestId('browse-tree-loading')).toBeNull();
    });
    expect(screen.getByTestId('tree-row-foo.ts')).toBeInTheDocument();
  });

  it('still says `Empty folder` once a genuinely empty listing has resolved', async () => {
    seedChat('c1');
    vi.spyOn(api, 'listFilesRecursive').mockResolvedValue({ entries: [] });

    render(withQuery(<FilesPage chatId="c1" />));

    expect(await screen.findByTestId('browse-tree-empty')).toHaveTextContent('Empty folder');
    expect(screen.queryByTestId('browse-tree-loading')).toBeNull();
  });

  it('does NOT skeleton a REFETCH (e.g. after a create) — keepPreviousData holds the last rows on screen', async () => {
    seedChat('c1');
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(api, 'listFilesRecursive').mockResolvedValue({
      entries: [{ name: 'src', type: 'dir' }],
    });

    render(<QueryClientProvider client={qc}>{<FilesPage chatId="c1" />}</QueryClientProvider>);
    await screen.findByTestId('tree-row-src');

    // Force a refetch the same way an invalidated query would — the rows
    // already on screen must survive it (keepPreviousData), no skeleton.
    await act(async () => {
      void qc.invalidateQueries({ queryKey: ['files-recursive', 'c1'] });
    });
    expect(screen.getByTestId('tree-row-src')).toBeInTheDocument();
    expect(screen.queryByTestId('browse-tree-loading')).toBeNull();
  });

  it('a failed listing surfaces its error and leaves no permanent tree skeleton', async () => {
    seedChat('c1');
    vi.spyOn(api, 'listFilesRecursive').mockRejectedValue(new Error('listing failed'));

    render(withQuery(<FilesPage chatId="c1" />));

    await waitFor(() => {
      expect(useUiStore.getState().errors.some((e) => e.message.includes('listing failed'))).toBe(
        true,
      );
    });
    expect(screen.queryByTestId('browse-tree-loading')).toBeNull();
  });

  it('covers the editor while a file’s content is in flight, still naming the file', async () => {
    seedChat('c1');
    const content = deferred<{ path: string; content: string; size: number }>();
    vi.spyOn(api, 'getFileContent').mockReturnValue(content.promise);

    render(withQuery(<FileEditorTab chatId="c1" path="foo.ts" tabId="t1" focused ws={null} />));

    // The bug: `value={draft ?? fileContent?.content ?? ''}` rendered an empty
    // document here, indistinguishable from a file with nothing in it.
    expect(await screen.findByTestId('browse-content-loading')).toBeInTheDocument();
    // The meta strip is NOT covered — the file being loaded is still named.
    expect(screen.getByTestId('browse-meta-name')).toHaveTextContent('foo.ts');

    await act(async () => {
      content.resolve({ path: 'foo.ts', content: 'const a = 1;', size: 12 });
    });

    await waitFor(() => {
      expect(screen.queryByTestId('browse-content-loading')).toBeNull();
    });
    expect(screen.getByTestId('mock-editor')).toHaveTextContent('const a = 1;');
  });

  it('a failed content fetch surfaces its error and leaves no permanent editor cover', async () => {
    seedChat('c1');
    vi.spyOn(api, 'getFileContent').mockRejectedValue(new Error('content fetch failed'));

    render(withQuery(<FileEditorTab chatId="c1" path="foo.ts" tabId="t1" focused ws={null} />));

    await waitFor(() => {
      expect(
        useUiStore.getState().errors.some((e) => e.message.includes('content fetch failed')),
      ).toBe(true);
    });
    expect(screen.queryByTestId('browse-content-loading')).toBeNull();
  });

  it('⌘P shows the SAME loading state as the tree — one shared fetch, not a second recursive walk', async () => {
    seedChat('c1');
    const index = deferred<RecursiveListing>();
    vi.spyOn(api, 'listFilesRecursive').mockReturnValue(index.promise);

    render(withQuery(<FilesPage chatId="c1" />));
    // The tree itself is mid-load — same query the picker reads.
    await screen.findByTestId('browse-tree-loading');
    act(() => {
      useUiStore.getState().setFilePickerOpen(true);
    });

    const input = await screen.findByTestId('file-search-input');
    expect(screen.getByTestId('file-search-loading')).toBeInTheDocument();

    await act(async () => {
      index.resolve({
        entries: [
          { name: 'src/deep/local-thing.ts', type: 'file' },
          { name: 'src/other.ts', type: 'file' },
        ],
      });
    });

    await waitFor(() => {
      expect(screen.queryByTestId('file-search-loading')).toBeNull();
    });
    fireEvent.change(input, { target: { value: 'local' } });
    expect(screen.getByTestId('file-search-local-thing.ts')).toBeInTheDocument();
  });

  it('a failed recursive index surfaces its error and leaves no permanent picker skeleton', async () => {
    seedChat('c1');
    vi.spyOn(api, 'listFilesRecursive').mockRejectedValue(new Error('recursive index failed'));

    render(withQuery(<FilesPage chatId="c1" />));
    await screen.findByTestId('files-page');
    act(() => {
      useUiStore.getState().setFilePickerOpen(true);
    });

    await waitFor(() => {
      expect(
        useUiStore.getState().errors.some((e) => e.message.includes('recursive index failed')),
      ).toBe(true);
    });
    expect(screen.queryByTestId('file-search-loading')).toBeNull();
  });
});
