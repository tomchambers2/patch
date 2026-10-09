// Editor overhaul — binary/image/PDF preview in a file tab (spec/14 § File
// browser update, § Panes and tabs).
//
// Opening a binary file used to feed its bytes into Monaco as if they were
// UTF-8 text (mangled/garbled for anything that isn't). `isPreviewableBinary`
// decides which files get a real preview instead; this pins the rendered
// behaviour: an `<img>` for images, an `<embed>` for a PDF, no diff toggles
// or Save footer (there is nothing to diff or save), a loading state while
// the bytes are in flight, and a surfaced error — never a silent blank pane
// — if the fetch fails.
//
// spec/14 § Panes and tabs: a binary file is a `FileEditorTab`, same as any
// other file — tested directly by path/chatId rather than via a tree click,
// since opening a path is now the tree's (`FilesPage`) job and rendering it
// is `FileEditorTab`'s, two independent components.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { JSX } from 'react';
import { FileEditorTab } from '../components/FileEditorTab.js';
import { useUiStore } from '../stores/uiStore.js';
import { useChatStore } from '../stores/chatStore.js';
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

function tab(path: string): JSX.Element {
  return <FileEditorTab chatId="c1" path={path} tabId={`file:c1:${path}`} focused ws={null} />;
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

let createObjectURLSpy: ReturnType<typeof vi.fn>;
let revokeObjectURLSpy: ReturnType<typeof vi.fn>;
const hadCreateObjectURL = Object.prototype.hasOwnProperty.call(URL, 'createObjectURL');
const hadRevokeObjectURL = Object.prototype.hasOwnProperty.call(URL, 'revokeObjectURL');

describe('FileEditorTab — binary/image/PDF preview', () => {
  beforeEach(() => {
    seedChat('c1');
    useUiStore.getState().clearToasts();
    useUiStore.setState({ fileDiff: null, errors: [], pendingDiffByChat: {} });
    // jsdom does not implement object URLs — stub them directly on the REAL
    // `URL` global (not `vi.stubGlobal('URL', ...)`, which replaces the whole
    // constructor and breaks every unrelated `new URL(...)` in the app) so
    // the preview's Blob → object-URL effect (and its cleanup) is exercised.
    let nextUrl = 0;
    createObjectURLSpy = vi.fn(() => `blob:mock-${nextUrl++}`);
    revokeObjectURLSpy = vi.fn();
    URL.createObjectURL = createObjectURLSpy as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = revokeObjectURLSpy as unknown as typeof URL.revokeObjectURL;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    // Unmount FIRST — it fires the preview's cleanup effect (which calls
    // `URL.revokeObjectURL`), so the stub must still be in place for that.
    cleanup();
    useChatStore.getState()._reset();
    if (!hadCreateObjectURL) delete (URL as { createObjectURL?: unknown }).createObjectURL;
    if (!hadRevokeObjectURL) delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL;
  });

  it('renders an <img> for an image file, with no diff toggles and no Save footer', async () => {
    const blob = new Blob(['fake-png-bytes'], { type: 'image/png' });
    vi.spyOn(api, 'getFileRawBlob').mockResolvedValue(blob);
    render(withQuery(tab('photo.png')));

    const preview = await screen.findByTestId('browse-binary-preview');
    // The container renders as soon as the path is a binary type; the
    // `<img>` itself only appears once the raw-bytes query has resolved AND
    // the Blob→object-URL effect has run — wait for it explicitly rather
    // than asserting immediately after the container shows up.
    const img = await waitFor(() => {
      const el = preview.querySelector('img');
      if (!el) throw new Error('img not rendered yet');
      return el;
    });
    expect(img.getAttribute('src')).toMatch(/^blob:mock-/);
    expect(img.getAttribute('alt')).toBe('photo.png');
    expect(api.getFileRawBlob).toHaveBeenCalledWith('c1', 'photo.png');

    // No text-diff affordances for a binary file — there is no text to diff.
    expect(screen.queryByTestId('diff-toggle-git')).toBeNull();
    expect(screen.queryByTestId('diff-toggle-agent')).toBeNull();
    // No Save footer — nothing here is a draft.
    expect(screen.queryByTestId('browse-save')).toBeNull();
    expect(screen.queryByTestId('browse-actions')).toBeNull();
    // Not fed into Monaco.
    expect(screen.queryByTestId('mock-editor')).toBeNull();
  });

  it('renders an <embed type="application/pdf"> for a PDF', async () => {
    vi.spyOn(api, 'getFileRawBlob').mockResolvedValue(
      new Blob(['fake-pdf-bytes'], { type: 'application/pdf' }),
    );
    render(withQuery(tab('report.pdf')));

    const preview = await screen.findByTestId('browse-binary-preview');
    const embed = await waitFor(() => {
      const el = preview.querySelector('embed');
      if (!el) throw new Error('embed not rendered yet');
      return el;
    });
    expect(embed.getAttribute('type')).toBe('application/pdf');
    expect(embed.getAttribute('src')).toMatch(/^blob:mock-/);
  });

  it('shows a loading skeleton while the raw bytes are in flight', async () => {
    vi.spyOn(api, 'getFileRawBlob').mockReturnValue(new Promise(() => {})); // never resolves
    render(withQuery(tab('photo.png')));

    const preview = await screen.findByTestId('browse-binary-preview');
    expect(preview.querySelector('[data-testid="browse-content-loading"]')).not.toBeNull();
    expect(preview.querySelector('img')).toBeNull();
  });

  it('a failed raw-bytes fetch surfaces an error in the preview pane AND as a toast — never a silent blank pane', async () => {
    vi.spyOn(api, 'getFileRawBlob').mockRejectedValue(new Error('raw fetch failed'));
    render(withQuery(tab('photo.png')));

    const preview = await screen.findByTestId('browse-binary-preview');
    const err = await waitFor(() => {
      const el = preview.querySelector('[data-testid="browse-content-error"]');
      if (!el) throw new Error('error not rendered yet');
      return el;
    });
    expect(err.textContent).toContain('raw fetch failed');
    await waitFor(() => {
      expect(useUiStore.getState().errors.some((e) => e.message.includes('raw fetch failed'))).toBe(
        true,
      );
    });
  });

  it('revokes the previous object URL when switching to a different binary file', async () => {
    vi.spyOn(api, 'getFileRawBlob').mockImplementation(
      async () => new Blob(['x'], { type: 'image/png' }),
    );
    const { rerender } = render(withQuery(tab('a.png')));

    await screen.findByTestId('browse-binary-preview');
    await waitFor(() => expect(createObjectURLSpy).toHaveBeenCalledTimes(1));
    const firstUrl = createObjectURLSpy.mock.results[0]?.value as string;

    rerender(withQuery(tab('b.png')));
    await waitFor(() => expect(createObjectURLSpy).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(revokeObjectURLSpy).toHaveBeenCalledWith(firstUrl));
  });

  it('does NOT fetch text content (getFileContent) for a previewable binary file', async () => {
    vi.spyOn(api, 'getFileRawBlob').mockResolvedValue(new Blob(['x'], { type: 'image/png' }));
    const getFileContent = vi.spyOn(api, 'getFileContent');
    const getFileContentAtHead = vi.spyOn(api, 'getFileContentAtHead');
    render(withQuery(tab('photo.png')));

    await screen.findByTestId('browse-binary-preview');

    expect(getFileContent).not.toHaveBeenCalled();
    expect(getFileContentAtHead).not.toHaveBeenCalled();
  });
});
