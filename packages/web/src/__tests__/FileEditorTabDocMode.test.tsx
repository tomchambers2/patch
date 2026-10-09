// Document editor — modes, suggestions, comments, history (spec/14 §
// Document editor, step 2 of 3) — wired into `FileEditorTab` (spec/14 §
// Panes and tabs moved this off the old docked rail's `BrowsePanel`).
// Ported from EditorRailDocMode.test.tsx when BrowsePanel was retired.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { JSX } from 'react';
import type { DocView } from '@patch/wire';
import { FileEditorTab } from '../components/FileEditorTab.js';
import { useUiStore } from '../stores/uiStore.js';
import { useChatStore } from '../stores/chatStore.js';
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

function renderTab(chatId: string, path: string): ReturnType<typeof render> {
  return render(
    withQuery(<FileEditorTab chatId={chatId} path={path} tabId="t1" focused ws={null} />),
  );
}

describe('FileEditorTab — document editor modes/suggestions/comments/history', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    useUiStore.setState({
      filePickerOpen: false,
      fileDiff: null,
      browseTreeCollapsed: false,
      browseByChat: {},
    });
    setActiveWs(null);
    useComposerDraftStore.getState()._reset();
    vi.spyOn(api, 'getFileContent').mockResolvedValue({
      path: 'notes.md',
      content: '# Title\n\nSome body text.\n',
      size: 10,
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it('shows the mode select at change by default, and switching mode dispatches set_mode', async () => {
    seedChat('c1');
    vi.spyOn(api, 'getDoc').mockResolvedValue(docView());
    const docAction = vi.spyOn(api, 'docAction').mockResolvedValue(docView({ mode: 'propose' }));
    renderTab('c1', 'notes.md');

    const select = await screen.findByTestId('doc-mode-select');
    expect((select as HTMLSelectElement).value).toBe('change');

    fireEvent.change(select, { target: { value: 'propose' } });
    await waitFor(() =>
      expect(docAction).toHaveBeenCalledWith('c1', 'notes.md', { op: 'set_mode', mode: 'propose' }),
    );
    await waitFor(() => expect((select as HTMLSelectElement).value).toBe('propose'));
  });

  it('shows pending suggestions and accept/reject dispatch the right action', async () => {
    seedChat('c1');
    const pending = {
      id: 's1',
      find: 'body',
      replace: 'BODY',
      status: 'pending' as const,
      createdAt: 0,
    };
    vi.spyOn(api, 'getDoc').mockResolvedValue(docView({ suggestions: [pending] }));
    const docAction = vi
      .spyOn(api, 'docAction')
      .mockResolvedValue(docView({ suggestions: [{ ...pending, status: 'accepted' }] }));
    renderTab('c1', 'notes.md');

    fireEvent.click(await screen.findByText(/Suggestions/));
    await screen.findByTestId('doc-suggestions-panel');
    expect(screen.getByTestId('doc-suggestion-s1')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('doc-suggestion-accept-s1'));
    await waitFor(() =>
      expect(docAction).toHaveBeenCalledWith('c1', 'notes.md', {
        op: 'accept_suggestion',
        id: 's1',
      }),
    );
  });

  it('adding a comment from the selection popover dispatches add_comment and shows it in the Comments panel', async () => {
    seedChat('c1');
    vi.spyOn(api, 'getDoc').mockResolvedValue(docView());
    const docAction = vi.spyOn(api, 'docAction').mockResolvedValue(
      docView({
        threads: [
          {
            id: 't1',
            anchor: 'Some body text.',
            resolved: false,
            comments: [{ id: 'c1', author: 'user', text: 'tone?', createdAt: 0 }],
          },
        ],
      }),
    );
    renderTab('c1', 'notes.md');
    await waitFor(() => expect(screen.getByTestId('document-editor')).toBeInTheDocument());
    const area = (await screen.findByTestId('document-editor-content')) as HTMLTextAreaElement;
    area.focus();
    area.setSelectionRange(
      area.value.indexOf('Some body text.'),
      area.value.indexOf('Some body text.') + 15,
    );
    fireEvent.mouseUp(area, { clientX: 5, clientY: 5 });

    fireEvent.click(await screen.findByTestId('document-editor-comment-button'));
    fireEvent.change(screen.getByTestId('document-editor-comment-input'), {
      target: { value: 'tone?' },
    });
    fireEvent.click(screen.getByTestId('document-editor-comment-submit'));

    await waitFor(() =>
      expect(docAction).toHaveBeenCalledWith('c1', 'notes.md', {
        op: 'add_comment',
        anchor: expect.stringContaining('Some body text.'),
        text: 'tone?',
      }),
    );

    fireEvent.click(await screen.findByText(/Comments/));
    await screen.findByTestId('doc-comments-panel');
    expect(screen.getByText('tone?')).toBeInTheDocument();
  });

  it('shows history and restoring a version dispatches restore_version', async () => {
    seedChat('c1');
    const version = { id: 'v1', content: 'old content', savedBy: 'user' as const, createdAt: 0 };
    vi.spyOn(api, 'getDoc').mockResolvedValue(docView({ versions: [version] }));
    const docAction = vi.spyOn(api, 'docAction').mockResolvedValue(
      docView({
        versions: [version, { ...version, id: 'v2', restoredFrom: 'v1' }],
      }),
    );
    renderTab('c1', 'notes.md');

    fireEvent.click(await screen.findByText('History'));
    await screen.findByTestId('doc-history-panel');
    fireEvent.click(screen.getByTestId('doc-history-row-v1'));
    expect(screen.getByTestId('doc-history-content')).toHaveTextContent('old content');

    fireEvent.click(screen.getByTestId('doc-history-restore'));
    await waitFor(() =>
      expect(docAction).toHaveBeenCalledWith('c1', 'notes.md', {
        op: 'restore_version',
        versionId: 'v1',
      }),
    );
  });

  it('offers no mode select or doc toggles for a non-markdown file', async () => {
    seedChat('c1');
    vi.spyOn(api, 'getFileContent').mockResolvedValue({
      path: 'notes.ts',
      content: 'const x = 1;',
      size: 10,
    });
    renderTab('c1', 'notes.ts');
    await waitFor(() => expect(screen.getByTestId('mock-editor')).toBeInTheDocument());
    expect(screen.queryByTestId('doc-mode-select')).not.toBeInTheDocument();
    expect(screen.queryByTestId('doc-toggle-suggestions')).not.toBeInTheDocument();
  });
});
