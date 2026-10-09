// Word import/export (spec/14 § Document editor, step 3 of 3). Import
// (opening a `.docx`) lives in `FilesPage`'s `openPath`; export lives in
// `FileEditorTab`'s meta strip. Ported from EditorRailWordImportExport.test.tsx
// when BrowsePanel was retired (spec/14 § Panes and tabs).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { JSX } from 'react';
import type { DocView } from '@patch/wire';
import { FilesPage } from '../components/FilesPage.js';
import { FileEditorTab } from '../components/FileEditorTab.js';
import { useUiStore } from '../stores/uiStore.js';
import { useChatStore } from '../stores/chatStore.js';
import { useLayoutStore } from '../stores/layoutStore.js';
import { useComposerDraftStore } from '../stores/composerDraftStore.js';
import { api } from '../api/rest.js';
import { setActiveWs } from '../api/ws.js';

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

function docView(partial: Partial<DocView> = {}): DocView {
  return { mode: 'change', suggestions: [], threads: [], versions: [], ...partial };
}

describe('FilesPage — Word import (opening a .docx)', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    useLayoutStore.getState()._reset();
    useUiStore.setState({
      filePickerOpen: false,
      fileDiff: null,
      browseTreeCollapsed: false,
      browseByChat: {},
      errors: [],
    });
    setActiveWs(null);
    useComposerDraftStore.getState()._reset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it('converts the .docx and opens the resulting .md as a tab, never the .docx itself', async () => {
    seedChat('c1');
    vi.spyOn(api, 'listFilesRecursive').mockResolvedValue({
      entries: [{ name: 'report.docx', type: 'file' }],
    });
    const convertDocx = vi
      .spyOn(api, 'convertDocx')
      .mockResolvedValue({ mdPath: 'report.md', warnings: [], reused: false });

    render(withQuery(<FilesPage chatId="c1" />));
    fireEvent.click(await screen.findByTestId('tree-row-report.docx'));

    await waitFor(() => expect(convertDocx).toHaveBeenCalledWith('c1', 'report.docx'));
    await waitFor(() =>
      expect(
        useLayoutStore.getState().findTab({ kind: 'file', chatId: 'c1', path: 'report.md' }),
      ).not.toBeNull(),
    );
    expect(
      useLayoutStore.getState().findTab({ kind: 'file', chatId: 'c1', path: 'report.docx' }),
    ).toBeNull();
  });

  it('surfaces a conversion failure as an error rather than opening anything', async () => {
    seedChat('c1');
    vi.spyOn(api, 'listFilesRecursive').mockResolvedValue({
      entries: [{ name: 'report.docx', type: 'file' }],
    });
    vi.spyOn(api, 'convertDocx').mockRejectedValue(new Error('docx conversion failed: boom'));

    render(withQuery(<FilesPage chatId="c1" />));
    fireEvent.click(await screen.findByTestId('tree-row-report.docx'));

    await waitFor(() =>
      expect(
        useUiStore.getState().errors.some((e) => e.message.includes('docx conversion failed')),
      ).toBe(true),
    );
    expect(
      useLayoutStore.getState().findTab({ kind: 'file', chatId: 'c1', path: 'report.docx' }),
    ).toBeNull();
  });

  it('names conversion warnings on open instead of dropping them silently', async () => {
    seedChat('c1');
    vi.spyOn(api, 'listFilesRecursive').mockResolvedValue({
      entries: [{ name: 'report.docx', type: 'file' }],
    });
    vi.spyOn(api, 'convertDocx').mockResolvedValue({
      mdPath: 'report.md',
      warnings: ['Tracked changes were present — the accepted text was kept.'],
      reused: false,
    });
    vi.spyOn(api, 'getFileContent').mockResolvedValue({
      path: 'report.md',
      content: '# Report Title\n',
      size: 10,
    });
    vi.spyOn(api, 'getDoc').mockResolvedValue(
      docView({ importWarnings: ['Tracked changes were present — the accepted text was kept.'] }),
    );

    render(withQuery(<FilesPage chatId="c1" />));
    fireEvent.click(await screen.findByTestId('tree-row-report.docx'));
    await waitFor(() =>
      expect(
        useLayoutStore.getState().findTab({ kind: 'file', chatId: 'c1', path: 'report.md' }),
      ).not.toBeNull(),
    );
    cleanup();
    render(withQuery(<FileEditorTab chatId="c1" path="report.md" tabId="t1" focused ws={null} />));

    await waitFor(() =>
      expect(useUiStore.getState().errors.some((e) => e.message.includes('Tracked changes'))).toBe(
        true,
      ),
    );
  });
});

describe('FileEditorTab — export menu (Download .docx/.pdf/.md)', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    useUiStore.setState({
      filePickerOpen: false,
      fileDiff: null,
      browseTreeCollapsed: false,
      browseByChat: {},
      errors: [],
    });
    setActiveWs(null);
    useComposerDraftStore.getState()._reset();
    vi.spyOn(api, 'getFileContent').mockResolvedValue({
      path: 'notes.md',
      content: '# Notes\n',
      size: 10,
    });
    vi.spyOn(api, 'getDoc').mockResolvedValue(docView());
    // jsdom has no object-URL plumbing or a real download — stub both so the
    // click handler's side effects are observable without a real browser.
    URL.createObjectURL = vi.fn(() => 'blob:fake');
    URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  function renderTab(): ReturnType<typeof render> {
    return render(
      withQuery(<FileEditorTab chatId="c1" path="notes.md" tabId="t1" focused ws={null} />),
    );
  }

  it('is offered only for a markdown document', async () => {
    seedChat('c1');
    renderTab();
    await screen.findByTestId('document-editor-export');
  });

  it('exports to .docx and triggers a real download of the returned bytes', async () => {
    seedChat('c1');
    const blob = new Blob(['docx-bytes']);
    const exportDoc = vi
      .spyOn(api, 'exportDoc')
      .mockResolvedValue({ blob, filename: 'notes.docx', warnings: [] });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    renderTab();
    fireEvent.click(await screen.findByTestId('document-editor-export-docx'));

    await waitFor(() => expect(exportDoc).toHaveBeenCalledWith('c1', 'notes.md', 'docx'));
    await waitFor(() => expect(clickSpy).toHaveBeenCalled());
    expect(URL.createObjectURL).toHaveBeenCalledWith(blob);
  });

  it('exports to .pdf', async () => {
    seedChat('c1');
    const exportDoc = vi
      .spyOn(api, 'exportDoc')
      .mockResolvedValue({ blob: new Blob(['pdf']), filename: 'notes.pdf', warnings: [] });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    renderTab();
    fireEvent.click(await screen.findByTestId('document-editor-export-pdf'));

    await waitFor(() => expect(exportDoc).toHaveBeenCalledWith('c1', 'notes.md', 'pdf'));
  });

  it('exports to .md', async () => {
    seedChat('c1');
    const exportDoc = vi
      .spyOn(api, 'exportDoc')
      .mockResolvedValue({ blob: new Blob(['# Notes\n']), filename: 'notes.md', warnings: [] });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    renderTab();
    fireEvent.click(await screen.findByTestId('document-editor-export-md'));

    await waitFor(() => expect(exportDoc).toHaveBeenCalledWith('c1', 'notes.md', 'md'));
  });

  it('names an export failure instead of failing silently', async () => {
    seedChat('c1');
    vi.spyOn(api, 'exportDoc').mockRejectedValue(new Error('pdf export failed: no chromium'));

    renderTab();
    fireEvent.click(await screen.findByTestId('document-editor-export-pdf'));

    await waitFor(() =>
      expect(useUiStore.getState().errors.some((e) => e.message.includes('no chromium'))).toBe(
        true,
      ),
    );
  });
});
