// FileEditorTab — the `{kind:'file', chatId, path}` tab's content: one file,
// editable, with its git/agent diff toggles (spec/14 § File browser, § Diff
// editor). One mounted instance per open file tab — unlike the old docked
// rail's `BrowsePanel`, which held a single (file, draft) pair for the whole
// chat, every tab here owns its own draft, so two files can be open and
// mid-edit side by side.
//
// Also doubles as the pending-permission diff viewer and the agent's-turn
// changeset diff viewer: if `uiStore`'s `pendingDiffByChat`/`fileDiff` has an
// entry for this exact (chatId, path), that takes over the pane instead of
// the plain editor — the same `DiffPanel`/`FileDiffPanel` the old rail's
// 'diff' mode rendered, just addressed by path now instead of by "whichever
// chat is globally active".

import { type JSX, Suspense, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Editor,
  InlineDiffView,
  FileDiffPanel,
  DiffPanel,
  SaveConflictModal,
  BrowseSkeleton,
  useSaveHotkey,
  detectSaveConflict,
  agentBaselineForFile,
  agentDiffPlan,
  headDiffPlan,
  isPreviewableBinary,
  isMarkdownPath,
  editorOptionsFor,
  inferLanguage,
} from './EditorRail.js';
import { isNoHeadBaseline, relativeToChatFolder } from '../lib/openDiff.js';
import { useChatStore } from '../stores/chatStore.js';
import { DocumentEditor } from './DocumentEditor.js';
import { DocModeSelect, SuggestionsPanel, CommentsPanel, HistoryPanel } from './DocToolsPanel.js';
import { useDocView } from '../lib/docEditor.js';
import { quoteSelectionIntoComposer } from '../lib/quoteSelection.js';
import { MONACO_THEME } from '../lib/monacoTheme.js';
import { shortcutLabel } from '../lib/shortcuts.js';
import { useUiStore } from '../stores/uiStore.js';
import { setTabDirty } from '../stores/layoutStore.js';
import { api } from '../api/rest.js';
import { sendFileEditorEvent } from '../lib/fileEditorSend.js';
import type { PatchWs } from '../api/ws.js';

export function FileEditorTab({
  chatId,
  path,
  tabId,
  focused,
  ws,
}: {
  chatId: string;
  path: string;
  tabId: string;
  focused: boolean;
  ws: PatchWs | null;
}): JSX.Element {
  const name = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;
  const pushError = useUiStore((s) => s.pushError);
  const pushNotice = useUiStore((s) => s.pushNotice);
  const onSendEvent = (ev: Parameters<typeof sendFileEditorEvent>[2]): void =>
    sendFileEditorEvent(ws, chatId, ev);

  const folder = useChatStore((s) => s.chats[chatId]?.folder ?? '');
  // A pending permission request on THIS exact file takes the pane over —
  // the chat's own per-chat map, not the "currently active chat" convenience
  // getter: a file tab already knows which chat it is, so there is no
  // "active chat" ambiguity to resolve across several open panes.
  const pendingDiff = useUiStore((s) => {
    const d = s.pendingDiffByChat[chatId];
    return d && relativeToChatFolder(folder, d.filePath) === path ? d : null;
  });
  // An agent-turn changeset diff ("View changes" / ⌘') on this exact file —
  // same idea, scoped by path instead of trusting a single global pointer.
  const fileDiffEntry = useUiStore((s) => {
    if (!s.fileDiff || s.fileDiff.chatId !== chatId) return null;
    return s.fileDiff.changeSet.find((f) => f.path === path) ?? null;
  });

  if (pendingDiff) {
    return (
      <Suspense fallback={<div className="editor-loading">Loading editor…</div>}>
        <DiffPanel
          diff={pendingDiff}
          onApproveEdits={(edited) =>
            onSendEvent({
              type: 'chat.permission_response',
              requestId: pendingDiff.requestId,
              approve: true,
              decision: 'approve_with_edits',
              editedNewString: edited,
            })
          }
          onApprove={() =>
            onSendEvent({
              type: 'chat.permission_response',
              requestId: pendingDiff.requestId,
              approve: true,
              decision: 'approve',
            })
          }
          onDeny={() =>
            onSendEvent({
              type: 'chat.permission_response',
              requestId: pendingDiff.requestId,
              approve: false,
              decision: 'deny',
            })
          }
        />
      </Suspense>
    );
  }

  if (fileDiffEntry) {
    return (
      <Suspense fallback={<div className="editor-loading">Loading editor…</div>}>
        <FileDiffPanel
          entry={fileDiffEntry}
          visible={focused}
          onSave={(content) =>
            onSendEvent({ type: 'file.write', chatId, path: fileDiffEntry.path, content })
          }
          onClose={() => useUiStore.getState().clearFileDiff()}
        />
      </Suspense>
    );
  }

  return (
    <PlainFileEditor
      chatId={chatId}
      path={path}
      name={name}
      tabId={tabId}
      focused={focused}
      onError={(msg) => pushError(`files: ${msg}`)}
      onNotice={(msg) => pushNotice(msg)}
      onSave={(p, content) => onSendEvent({ type: 'file.write', chatId, path: p, content })}
    />
  );
}

/**
 * The plain editor (no pending permission, no changeset diff over it) — the
 * same content the old rail's `BrowsePanel` showed in its right pane, minus
 * the tree, parameterized directly by `path` instead of `browseByChat`'s
 * per-CHAT "currently open file".
 */
function PlainFileEditor({
  chatId,
  path,
  name,
  tabId,
  focused,
  onError,
  onNotice,
  onSave,
}: {
  chatId: string;
  path: string;
  name: string;
  tabId: string;
  focused: boolean;
  onError: (msg: string) => void;
  onNotice: (msg: string) => void;
  onSave: (path: string, content: string) => void;
}): JSX.Element {
  const previewKind = isPreviewableBinary(name);
  const queryClient = useQueryClient();

  const {
    data: fileContent,
    error: fileContentError,
    isPending: contentPending,
  } = useQuery({
    queryKey: ['file-content', chatId, path],
    queryFn: async () => api.getFileContent(chatId, path),
    enabled: previewKind === null,
  });
  const { data: headContent, error: headContentError } = useQuery({
    queryKey: ['file-content-head', chatId, path],
    queryFn: async () => api.getFileContentAtHead(chatId, path),
    enabled: previewKind === null,
  });
  const { data: rawBlob, error: rawBlobError } = useQuery({
    queryKey: ['file-raw', chatId, path],
    queryFn: async () => api.getFileRawBlob(chatId, path),
    enabled: previewKind !== null,
  });

  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!rawBlob) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(rawBlob);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [rawBlob]);

  useEffect(() => {
    if (rawBlobError) onError((rawBlobError as Error).message);
  }, [rawBlobError, onError]);
  useEffect(() => {
    if (fileContentError) onError((fileContentError as Error).message);
  }, [fileContentError, onError]);
  useEffect(() => {
    if (headContentError && !isNoHeadBaseline(headContentError)) {
      onError((headContentError as Error).message);
    }
  }, [headContentError, onError]);

  // Draft is IN MEMORY ONLY, same convention the old rail's `browseByChat`
  // draft used — lost on tab close/reload, never written to
  // `localStorage`. Local `useState` gets that for free: nothing persists it.
  const [draft, setDraft] = useState<string | null>(null);
  const [draftBaseline, setDraftBaseline] = useState<string | null>(null);
  const [diffToggle, setDiffToggle] = useState<
    'git' | 'agent' | 'suggestions' | 'comments' | 'history' | null
  >(null);
  const [openAsSource, setOpenAsSource] = useState(false);
  const [saveConflict, setSaveConflict] = useState<{ onDisk: string } | null>(null);

  // Document editor (spec/14 § Document editor, step 2 of 3): mode,
  // suggestions, threads and history for this open `.md` file — gated the
  // same way the plain-vs-rich choice below is (a doc view means nothing for
  // a file that isn't `.md`).
  const docEnabled = isMarkdownPath(name) && previewKind === null;
  const { view: docView, dispatch: docDispatch } = useDocView(chatId, path, docEnabled);

  // Document editor (spec/14 § Document editor, step 3 of 3): a `.docx`'s
  // import warnings are listed on open, not silently dropped — once per file
  // open (keyed on its path), not re-announced on every background refetch
  // of the same doc view.
  const notifiedImportWarningsFor = useRef<string | null>(null);
  useEffect(() => {
    if (!docView) return;
    if (!docView.importWarnings || docView.importWarnings.length === 0) return;
    if (notifiedImportWarningsFor.current === path) return;
    notifiedImportWarningsFor.current = path;
    onNotice(`Converted from Word — could not carry over: ${docView.importWarnings.join(' ')}`);
  }, [docView, path, onNotice]);

  // Document editor (spec/14 § Document editor, step 3 of 3): Download/Save
  // as from the editor's menu. The server also writes the exported file
  // beside the `.md` on the chat's own host (so it's reachable from the file
  // browser and the agent too) — this triggers a real browser download of
  // the same bytes via a throwaway object URL, revoked right after the click
  // fires (the download itself has already read the blob by then).
  const [exporting, setExporting] = useState(false);
  async function exportAs(format: 'docx' | 'pdf' | 'md'): Promise<void> {
    setExporting(true);
    try {
      const { blob, filename, warnings } = await api.exportDoc(chatId, path, format);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      if (warnings.length > 0) {
        onNotice(`Exported with warnings: ${warnings.join(' ')}`);
      }
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setExporting(false);
    }
  }

  const dirty = draft !== null && draft !== (fileContent?.content ?? '');
  useEffect(() => {
    setTabDirty(tabId, dirty);
    return () => setTabDirty(tabId, false);
  }, [tabId, dirty]);

  function commitSave(content: string): void {
    queryClient.setQueryData(['file-content', chatId, path], {
      path,
      content,
      size: content.length,
    });
    setDraftBaseline(content);
    onSave(path, content);
  }

  async function saveDraft(): Promise<void> {
    if (draft === null || draft === (fileContent?.content ?? '')) return;
    const draftToSave = draft;
    let onDisk: string;
    try {
      const fresh = await api.getFileContent(chatId, path);
      onDisk = fresh.content;
    } catch (err) {
      onError((err as Error).message);
      return;
    }
    const baseline = draftBaseline ?? fileContent?.content ?? '';
    if (detectSaveConflict({ baseline, onDisk, draft: draftToSave })) {
      queryClient.setQueryData(['file-content', chatId, path], {
        path,
        content: onDisk,
        size: onDisk.length,
      });
      setSaveConflict({ onDisk });
      return;
    }
    commitSave(draftToSave);
  }

  function resolveConflictReload(): void {
    setDraft(null);
    setDraftBaseline(null);
    setSaveConflict(null);
  }
  function resolveConflictOverwrite(): void {
    if (draft === null) return;
    const draftToSave = draft;
    setSaveConflict(null);
    commitSave(draftToSave);
  }
  function cancelSaveConflict(): void {
    setSaveConflict(null);
  }

  function recordDraftChange(next: string): void {
    if (draft === null) {
      setDraft(next);
      setDraftBaseline(fileContent?.content ?? '');
    } else {
      setDraft(next);
    }
  }

  useSaveHotkey(focused, () => void saveDraft(), { current: null });

  // spec/14 § File browser — live updates: a push on THIS path invalidates
  // its own content/HEAD queries. Deliberately does not touch the draft —
  // see `saveDraft`'s conflict check, which exists to catch exactly this.
  const lastFileChanged = useUiStore((s) => s.lastFileChanged[chatId] ?? null);
  useEffect(() => {
    if (!lastFileChanged || lastFileChanged.path !== path) return;
    void queryClient.invalidateQueries({ queryKey: ['file-content', chatId, path] });
    void queryClient.invalidateQueries({ queryKey: ['file-content-head', chatId, path] });
  }, [chatId, path, lastFileChanged, queryClient]);

  const contentFailed = fileContentError !== null && fileContent === undefined;
  const previewFailed = rawBlobError !== null && rawBlob === undefined;
  const currentContent = fileContent?.content;
  const headValue: string | null | undefined =
    headContent !== undefined
      ? headContent.content
      : headContentError && isNoHeadBaseline(headContentError)
        ? null
        : undefined;
  const headPlan =
    headValue !== undefined && currentContent !== undefined
      ? headDiffPlan(headValue, currentContent, name)
      : null;
  const gitDiffEnabled =
    headValue !== undefined &&
    currentContent !== undefined &&
    (headValue === null || headValue !== currentContent);
  const agentBaseline =
    currentContent !== undefined ? agentBaselineForFile(chatId, path, currentContent) : null;
  const agentPlan =
    agentBaseline && currentContent !== undefined
      ? agentDiffPlan(agentBaseline, currentContent, name)
      : null;
  const agentDiffEnabled = agentPlan !== null && agentPlan.original !== null;

  function toggleGitDiff(): void {
    if (!gitDiffEnabled) return;
    if (diffToggle === 'git') {
      setDiffToggle(null);
      return;
    }
    if (headPlan?.notice) onNotice(headPlan.notice);
    setDiffToggle('git');
  }
  function toggleAgentDiff(): void {
    if (!agentDiffEnabled) return;
    if (diffToggle === 'agent') {
      setDiffToggle(null);
      return;
    }
    if (agentPlan?.notice) onNotice(agentPlan.notice);
    setDiffToggle('agent');
  }

  return (
    <div className="browse-editor file-editor-tab" data-testid="browse-editor" data-path={path}>
      <div className="browse-meta" data-testid="browse-meta">
        <span className="browse-meta-path" title={path}>
          {path.includes('/') ? (
            <span className="browse-meta-dir" data-testid="browse-meta-dir">
              {path.slice(0, path.lastIndexOf('/') + 1)}
            </span>
          ) : null}
          <span className="browse-meta-name" data-testid="browse-meta-name">
            {name}
          </span>
        </span>
        {previewKind === null ? (
          <>
            <button
              type="button"
              className="browse-meta-btn"
              title={
                gitDiffEnabled ? 'Diff against git HEAD' : 'Unchanged since HEAD — nothing to diff'
              }
              data-testid="diff-toggle-git"
              aria-pressed={diffToggle === 'git'}
              disabled={!gitDiffEnabled}
              onClick={toggleGitDiff}
            >
              Git diff
            </button>
            <button
              type="button"
              className="browse-meta-btn"
              title={
                agentDiffEnabled
                  ? "Diff against the agent's last edit"
                  : 'No agent edit to diff against in this chat'
              }
              data-testid="diff-toggle-agent"
              aria-pressed={diffToggle === 'agent'}
              disabled={!agentDiffEnabled}
              onClick={toggleAgentDiff}
            >
              Agent's edits
            </button>
            {isMarkdownPath(name) ? (
              <button
                type="button"
                className="browse-meta-btn"
                title={openAsSource ? 'Switch to rich text' : 'Open as source'}
                data-testid="document-editor-source-toggle"
                aria-pressed={openAsSource}
                onClick={() => setOpenAsSource((v) => !v)}
              >
                {openAsSource ? 'Rich text' : 'Open as source'}
              </button>
            ) : null}
            {isMarkdownPath(name) ? (
              <span className="browse-meta-export-group" data-testid="document-editor-export">
                <button
                  type="button"
                  className="browse-meta-btn"
                  data-testid="document-editor-export-docx"
                  disabled={exporting}
                  title="Download as Word document"
                  onClick={() => void exportAs('docx')}
                >
                  .docx
                </button>
                <button
                  type="button"
                  className="browse-meta-btn"
                  data-testid="document-editor-export-pdf"
                  disabled={exporting}
                  title="Download as PDF"
                  onClick={() => void exportAs('pdf')}
                >
                  .pdf
                </button>
                <button
                  type="button"
                  className="browse-meta-btn"
                  data-testid="document-editor-export-md"
                  disabled={exporting}
                  title="Download as Markdown"
                  onClick={() => void exportAs('md')}
                >
                  .md
                </button>
              </span>
            ) : null}
            {docView ? (
              <>
                <DocModeSelect
                  mode={docView.mode}
                  onChange={(mode) => void docDispatch({ op: 'set_mode', mode })}
                />
                <button
                  type="button"
                  className="browse-meta-btn"
                  data-testid="doc-toggle-suggestions"
                  aria-pressed={diffToggle === 'suggestions'}
                  onClick={() => setDiffToggle((t) => (t === 'suggestions' ? null : 'suggestions'))}
                >
                  Suggestions
                  {docView.suggestions.some((s) => s.status === 'pending')
                    ? ` (${docView.suggestions.filter((s) => s.status === 'pending').length})`
                    : ''}
                </button>
                <button
                  type="button"
                  className="browse-meta-btn"
                  data-testid="doc-toggle-comments"
                  aria-pressed={diffToggle === 'comments'}
                  onClick={() => setDiffToggle((t) => (t === 'comments' ? null : 'comments'))}
                >
                  Comments
                  {docView.threads.some((t) => !t.resolved)
                    ? ` (${docView.threads.filter((t) => !t.resolved).length})`
                    : ''}
                </button>
                <button
                  type="button"
                  className="browse-meta-btn"
                  data-testid="doc-toggle-history"
                  aria-pressed={diffToggle === 'history'}
                  onClick={() => setDiffToggle((t) => (t === 'history' ? null : 'history'))}
                >
                  History
                </button>
              </>
            ) : null}
          </>
        ) : null}
      </div>
      {previewKind !== null ? (
        <div className="browse-binary-preview" data-testid="browse-binary-preview">
          {previewFailed ? (
            <div className="browse-content-error" data-testid="browse-content-error" role="alert">
              <span className="browse-content-error-path">{path}</span>
              <span className="browse-content-error-msg">{(rawBlobError as Error).message}</span>
            </div>
          ) : previewUrl ? (
            previewKind === 'image' ? (
              <img src={previewUrl} alt={name} className="browse-preview-image" />
            ) : (
              <embed src={previewUrl} type="application/pdf" className="browse-preview-pdf" />
            )
          ) : (
            <div className="browse-content-loading" data-testid="browse-content-loading">
              <BrowseSkeleton rows={8} testId="browse-content-skeleton" />
            </div>
          )}
        </div>
      ) : (
        <>
          {/* The editor body — the box the loading and error overlays cover.
              Without it they covered the whole tab, header included, and the
              error's path printed over the header's own. */}
          <div className="browse-body">
            <Suspense fallback={<div data-testid="browse-loading">Loading…</div>}>
              {diffToggle === 'git' || diffToggle === 'agent' ? (
                <InlineDiffView
                  path={name}
                  original={(diffToggle === 'git' ? headPlan?.original : agentPlan?.original) ?? ''}
                  modified={fileContent?.content ?? ''}
                />
              ) : diffToggle === 'suggestions' && docView ? (
                <SuggestionsPanel view={docView} dispatch={docDispatch} />
              ) : diffToggle === 'comments' && docView ? (
                <CommentsPanel view={docView} dispatch={docDispatch} />
              ) : diffToggle === 'history' && docView ? (
                <HistoryPanel view={docView} dispatch={docDispatch} />
              ) : isMarkdownPath(name) && !openAsSource ? (
                <DocumentEditor
                  docKey={path}
                  value={draft ?? fileContent?.content ?? ''}
                  onChange={recordDraftChange}
                  onAsk={(text) => {
                    quoteSelectionIntoComposer(chatId, text);
                    onNotice('Added to the composer');
                  }}
                  onComment={(anchor, text) => {
                    void docDispatch({ op: 'add_comment', anchor, text });
                    onNotice('Comment added');
                  }}
                />
              ) : (
                <Editor
                  value={draft ?? fileContent?.content ?? ''}
                  language={inferLanguage(name)}
                  theme={MONACO_THEME}
                  options={{
                    minimap: { enabled: false },
                    automaticLayout: true,
                    ...editorOptionsFor(inferLanguage(name)),
                  }}
                  onChange={(v) => recordDraftChange(v ?? '')}
                  loading={<div data-testid="browse-loading">Loading…</div>}
                />
              )}
            </Suspense>
            {contentPending ? (
              <div className="browse-content-loading" data-testid="browse-content-loading">
                <BrowseSkeleton rows={8} testId="browse-content-skeleton" />
              </div>
            ) : null}
            {contentFailed ? (
              <div className="browse-content-error" data-testid="browse-content-error" role="alert">
                <span className="browse-content-error-path">{path}</span>
                <span className="browse-content-error-msg">
                  {(fileContentError as Error).message}
                </span>
              </div>
            ) : null}
          </div>
          <footer className="browse-actions" data-testid="browse-actions">
            <button
              type="button"
              data-testid="browse-save"
              disabled={contentFailed || draft === null || draft === (fileContent?.content ?? '')}
              title={shortcutLabel('⌘S')}
              onClick={() => void saveDraft()}
            >
              Save
            </button>
          </footer>
        </>
      )}
      {saveConflict ? (
        <SaveConflictModal
          path={path}
          onReload={resolveConflictReload}
          onOverwrite={resolveConflictOverwrite}
          onCancel={cancelSaveConflict}
        />
      ) : null}
    </div>
  );
}
