// Editor overhaul — inline "untitled" file/folder creation (spec/14 § File
// browser update).
//
// "New file" / "New folder" used to open a MODAL asking for a name before
// creating anything. Now they create immediately as "untitled" (or
// "untitled-2", … the first name not already a sibling), open it straight
// into an editable name field in the tree — no modal — and typing a real
// name replaces "untitled". Escape or an unchanged/empty name on blur leaves
// it as "untitled" (a real, valid filename — not deleted).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
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

/** A live, mutable entries list so `fileOp` + the recursive refetch agree. */
function stubMutableTree(initial: Array<{ name: string; type: 'file' | 'dir' }>): void {
  let entries = initial;
  vi.spyOn(api, 'listFilesRecursive').mockImplementation(async () => ({ entries }));
  vi.spyOn(api, 'fileOp').mockImplementation(async (_id, body) => {
    if (body.op === 'create') {
      entries = [...entries, { name: body.path, type: 'file' }];
      return { path: body.path };
    }
    if (body.op === 'create_dir') {
      entries = [...entries, { name: body.path, type: 'dir' }];
      return { path: body.path };
    }
    if (body.op === 'rename' && body.to) {
      entries = entries.map((e) => (e.name === body.path ? { ...e, name: body.to as string } : e));
      return { path: body.to };
    }
    if (body.op === 'delete') {
      entries = entries.filter((e) => e.name !== body.path);
      return { path: body.path };
    }
    throw new Error(`unhandled op ${body.op}`);
  });
  vi.spyOn(api, 'getFileContent').mockResolvedValue({ path: '', content: '', size: 0 });
}

function openRail(): void {
  useUiStore.setState({
    browseByChat: {},
    filePickerOpen: false,
    fileDiff: null,
    browseTreeCollapsed: false,
    errors: [],
  });
}

describe('FilesPage — inline "untitled" create', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    useLayoutStore.getState()._reset();
    openRail();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it('clicking "New file" creates "untitled" at the root immediately (no modal), opens it as its own tab, and focuses an editable name field', async () => {
    seedChat('c1');
    stubMutableTree([]);
    render(withQuery(<FilesPage chatId="c1" />));
    await screen.findByTestId('browse-tree-empty');

    fireEvent.click(screen.getByTestId('browse-new-file'));

    // No modal — the row appears straight away, in rename mode.
    const input = await screen.findByTestId('tree-rename-input-untitled');
    expect(input).toHaveFocus();
    expect(api.fileOp).toHaveBeenCalledWith('c1', { op: 'create', path: 'untitled' });
    // Opened straight away too — the point of creating a file is to type in
    // it — as its own tab (spec/14 § Panes and tabs).
    await waitFor(() =>
      expect(
        useLayoutStore.getState().findTab({ kind: 'file', chatId: 'c1', path: 'untitled' }),
      ).not.toBeNull(),
    );
    cleanup();
    render(withQuery(<FileEditorTab chatId="c1" path="untitled" tabId="t1" focused ws={null} />));
    expect(await screen.findByTestId('mock-editor')).toBeInTheDocument();
    expect(screen.getByTestId('browse-meta-name')).toHaveTextContent('untitled');
  });

  it('typing a name and pressing Enter commits the rename', async () => {
    seedChat('c1');
    stubMutableTree([]);
    render(withQuery(<FilesPage chatId="c1" />));
    await screen.findByTestId('browse-tree-empty');
    fireEvent.click(screen.getByTestId('browse-new-file'));
    const input = await screen.findByTestId('tree-rename-input-untitled');

    fireEvent.change(input, { target: { value: 'real-name.ts' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(api.fileOp).toHaveBeenCalledWith('c1', {
        op: 'rename',
        path: 'untitled',
        to: 'real-name.ts',
      });
    });
    expect(await screen.findByTestId('tree-row-real-name.ts')).toBeInTheDocument();
    expect(screen.queryByTestId('tree-rename-input-untitled')).toBeNull();
  });

  it('blurring with the name unchanged leaves the entry as "untitled" — not deleted, no rename call', async () => {
    seedChat('c1');
    stubMutableTree([]);
    render(withQuery(<FilesPage chatId="c1" />));
    await screen.findByTestId('browse-tree-empty');
    fireEvent.click(screen.getByTestId('browse-new-file'));
    const input = await screen.findByTestId('tree-rename-input-untitled');

    fireEvent.blur(input);

    await waitFor(() => expect(screen.queryByTestId('tree-rename-input-untitled')).toBeNull());
    expect(screen.getByTestId('tree-row-untitled')).toBeInTheDocument();
    expect(api.fileOp).toHaveBeenCalledTimes(1); // only the create, no rename
  });

  it('Escape discards whatever was typed and leaves the entry as "untitled"', async () => {
    seedChat('c1');
    stubMutableTree([]);
    render(withQuery(<FilesPage chatId="c1" />));
    await screen.findByTestId('browse-tree-empty');
    fireEvent.click(screen.getByTestId('browse-new-file'));
    const input = await screen.findByTestId('tree-rename-input-untitled');

    fireEvent.change(input, { target: { value: 'half-typed' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(screen.queryByTestId('tree-rename-input-untitled')).toBeNull();
    expect(screen.getByTestId('tree-row-untitled')).toBeInTheDocument();
    expect(api.fileOp).toHaveBeenCalledTimes(1); // only the create, no rename
  });

  it('a second "New file" click with "untitled" already present creates "untitled-2"', async () => {
    seedChat('c1');
    stubMutableTree([{ name: 'untitled', type: 'file' }]);
    render(withQuery(<FilesPage chatId="c1" />));
    await screen.findByTestId('tree-row-untitled');

    fireEvent.click(screen.getByTestId('browse-new-file'));

    await waitFor(() => {
      expect(api.fileOp).toHaveBeenCalledWith('c1', { op: 'create', path: 'untitled-2' });
    });
    expect(await screen.findByTestId('tree-rename-input-untitled-2')).toBeInTheDocument();
  });

  it('"New folder" creates a directory named "untitled" via create_dir, also renamable inline', async () => {
    seedChat('c1');
    stubMutableTree([]);
    render(withQuery(<FilesPage chatId="c1" />));
    await screen.findByTestId('browse-tree-empty');

    fireEvent.click(screen.getByTestId('browse-new-folder'));

    await waitFor(() => {
      expect(api.fileOp).toHaveBeenCalledWith('c1', { op: 'create_dir', path: 'untitled' });
    });
    const input = await screen.findByTestId('tree-rename-input-untitled');
    expect(input).toHaveFocus();
    // A folder is not opened in the editor the way a file is.
    expect(screen.queryByTestId('mock-editor')).toBeNull();
  });

  it('lands the new entry inside the last-clicked directory, not always the root', async () => {
    seedChat('c1');
    stubMutableTree([
      { name: 'src', type: 'dir' },
      { name: 'src/existing.ts', type: 'file' },
    ]);
    render(withQuery(<FilesPage chatId="c1" />));
    // Expand `src` — it becomes the "last active" directory.
    fireEvent.click(await screen.findByTestId('tree-row-src'));
    await screen.findByTestId('tree-row-src/existing.ts');

    fireEvent.click(screen.getByTestId('browse-new-file'));

    await waitFor(() => {
      expect(api.fileOp).toHaveBeenCalledWith('c1', { op: 'create', path: 'src/untitled' });
    });
    expect(await screen.findByTestId('tree-rename-input-src/untitled')).toBeInTheDocument();
  });
});
