// EditorRail — Monaco-backed file editing building blocks (spec/14 § File
// browser, § Diff editor). Despite the filename (kept to avoid a repo-wide
// import churn when the docked rail it used to BE retired — spec/14 §
// Panes and tabs), this file no longer mounts anything on its own: the
// docked right-rail component (`EditorRail`) and its combined tree+editor
// `BrowsePanel` are gone. What's left are the pieces `FilesPage.tsx` (the
// tree) and `FileEditorTab.tsx` (one open file, one pane tab) are built
// from: `WholeFileEditor`/`InlineDiffView`/`FileDiffPanel`/`DiffPanel`/
// `SaveConflictModal`/`BrowseSkeleton`/`FileTreeRows`/`FileSearch` and a
// handful of pure helpers (`detectSaveConflict`, `agentDiffPlan`,
// `headDiffPlan`, `buildFileTree`, `isPreviewableBinary`, `inferLanguage`, …).
//
// NO FALLBACK: if Monaco fails to mount, callers surface an error toast
// rather than silently rendering a textarea.

import type { JSX } from 'react';
import { Fragment, lazy, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentType, MouseEvent as ReactMouseEvent, ReactNode, RefObject } from 'react';
import { ChevronDown, ChevronRight, FileText, Folder, MoreHorizontal } from 'lucide-react';
import { useChatStore } from '../stores/chatStore.js';
import { MONACO_THEME } from '../lib/monacoTheme.js';
import { shortcutLabel } from '../lib/shortcuts.js';
import { isSubmitChord } from '../lib/submitChord.js';

/**
 * Pull in the self-hosted Monaco bootstrap (installs `MonacoEnvironment` and
 * hands the bundled monaco module to `@monaco-editor/loader`, so
 * `@monaco-editor/react` never reaches for the CSP-blocked CDN). This used to
 * be a static import in `main.tsx`, which parked the whole editor in the entry
 * chunk — see spec/14 § Startup cost. It is dynamic and it is awaited BEFORE
 * `@monaco-editor/react` so `loader.config({ monaco })` is always in place by
 * the time the wrapper calls `loader.init()`.
 */
async function bootMonaco(): Promise<void> {
  await import('../lib/monaco-loader.js');
}

// Explicit prop-type annotations (rather than letting `lazy()`'s return type
// infer `@monaco-editor/react`'s own prop types): callers across the
// workspace resolve those through DIFFERENT copies of `@types/react` (a pnpm
// workspace artifact), so an inferred type here is "not portable" — tsc can't
// name it from another package without a direct reference to whichever
// `@types/react` happened to resolve first. These interfaces cover every prop
// actually passed at any call site in this file/`FileEditorTab.tsx`, typed
// from OUR OWN `react` import, so the exported symbol never needs the other
// package's copy.
interface MonacoEditorLikeProps {
  value?: string;
  language?: string;
  theme?: string;
  options?: Record<string, unknown>;
  loading?: ReactNode;
  onChange?: (value: string | undefined) => void;
  onMount?: (editor: unknown) => void;
  [key: string]: unknown;
}
interface MonacoDiffEditorLikeProps extends MonacoEditorLikeProps {
  original?: string;
  modified?: string;
  originalModelPath?: string;
  modifiedModelPath?: string;
  keepCurrentOriginalModel?: boolean;
  keepCurrentModifiedModel?: boolean;
}
export const DiffEditor: ComponentType<MonacoDiffEditorLikeProps> = lazy(async () => {
  await bootMonaco();
  const m = await import('@monaco-editor/react');
  return { default: m.DiffEditor as unknown as ComponentType<MonacoDiffEditorLikeProps> };
});
export const Editor: ComponentType<MonacoEditorLikeProps> = lazy(async () => {
  await bootMonaco();
  const m = await import('@monaco-editor/react');
  return { default: m.Editor as unknown as ComponentType<MonacoEditorLikeProps> };
});

/**
 * Minimal shape of a Monaco standalone DIFF editor we depend on for the
 * clean-unmount guard (G2-d4). We read the model (original/modified TextModels)
 * so they can be disposed AFTER the widget, in the correct order.
 */
interface MonacoTextModelLike {
  dispose: () => void;
  isDisposed?: () => boolean;
}
interface MonacoDiffEditorLike {
  getModel: () => { original?: MonacoTextModelLike; modified?: MonacoTextModelLike } | null;
  setModel: (model: unknown) => void;
}

/**
 * G2-d4: returns a ref to attach (in `onMount`) to a Monaco DiffEditor, and the
 * `keepCurrentOriginalModel` / `keepCurrentModifiedModel` props that MUST be
 * spread onto that <DiffEditor>.
 *
 * The uncaught Monaco error "TextModel got disposed before DiffEditorWidget
 * model got reset" fires because `@monaco-editor/react`'s own unmount cleanup
 * disposes the original/modified TextModels and THEN disposes the diff-editor
 * widget — but the widget still references those now-disposed models, so its
 * model-change emitter throws. A parent-level cleanup can't beat it: child
 * effect cleanups run before the parent's.
 *
 * The fix orders disposal correctly by taking ownership of the models away from
 * the wrapper: `keepCurrent*Model` makes the wrapper dispose ONLY the widget
 * (cleanly, models still attached), and this hook then disposes the two
 * TextModels afterwards — widget first, models second, so nothing is referenced
 * after disposal and no error is logged.
 */
export function useDiffEditorCleanup(): {
  onMount: (editor: MonacoDiffEditorLike) => void;
  keepProps: { keepCurrentOriginalModel: true; keepCurrentModifiedModel: true };
} {
  // Hold the widget + its two TextModels captured at mount. On unmount we RESET
  // the widget's model to null FIRST (so the widget no longer references the
  // TextModels), THEN dispose the TextModels. This is the disposal order the
  // Monaco error message literally asks for ("…before DiffEditorWidget model
  // got reset"). `keepProps` stops the @monaco-editor/react wrapper from
  // disposing the models itself (in the wrong order); we own them here.
  const ref = useRef<{
    editor?: MonacoDiffEditorLike;
    original?: MonacoTextModelLike;
    modified?: MonacoTextModelLike;
  }>({});
  useEffect(() => {
    return () => {
      const { editor, original, modified } = ref.current;
      ref.current = {};
      // 1. Detach the models from the widget so disposing them can't fire the
      //    widget's model-change emitter against a disposed model.
      try {
        editor?.setModel(null);
      } catch {
        // Widget may already be disposed — fine, the models are then orphaned
        // and safe to dispose directly.
      }
      // 2. Dispose the TextModels we kept alive via keepProps.
      for (const m of [original, modified]) {
        try {
          if (m && !(m.isDisposed?.() ?? false)) m.dispose();
        } catch {
          // Best-effort: a model may already be disposed.
        }
      }
    };
  }, []);
  return {
    onMount: (editor) => {
      try {
        const model = editor.getModel();
        ref.current = { editor, original: model?.original, modified: model?.modified };
      } catch {
        ref.current = {};
      }
    },
    keepProps: { keepCurrentOriginalModel: true, keepCurrentModifiedModel: true },
  };
}

/**
 * spec/14 § Diff editor: a file with NOTHING on the original side opens as the
 * plain single-pane editor (the file itself) rather than as a diff. A two-sided
 * diff of an empty baseline is the whole file painted green — a diff of nothing
 * against everything, which carries no information.
 *
 * The decision rests on the ORIGINAL SIDE, not on the tool name. A `Write` over
 * a file that has a committed baseline resolves that baseline in
 * `lib/openDiff.ts` and keeps rendering as a real, useful diff; only a write
 * with no baseline at all (a brand-new/untracked file, or the permission-request
 * path, which has no baseline to fetch) lands here. Each change-set entry is
 * asked independently, so one turn's rail can mix diffs and plain files.
 */
export function isWholeFileView(original: string): boolean {
  return original === '';
}

/**
 * Save-conflict check (spec/14 § File browser — save conflicts). Zed's model:
 * no merge, no OT/CRDT — a save either lands cleanly or the user is asked to
 * choose, explicitly, between the two whole-file outcomes.
 *
 * `baseline` is the on-disk content the open draft was FIRST typed against
 * (`BrowseChatState.draftBaseline`); `onDisk` is what a fresh read says is
 * there right now; `draft` is what Save is about to write. A conflict exists
 * only when the disk has genuinely moved AND that move isn't already the
 * exact bytes this save would produce anyway:
 *
 *   - `onDisk === baseline` → nothing else touched the file since this draft
 *     started. A plain, ordinary save.
 *   - `onDisk === draft` → the file already reads exactly what would be
 *     written (e.g. a duplicate save, or another surface wrote the identical
 *     content). Nothing would actually be lost by proceeding.
 *   - otherwise → the disk holds bytes neither this draft's starting point
 *     nor its ending point — someone else's edit is sitting there, and
 *     overwriting it silently would be real data loss.
 */
export function detectSaveConflict(params: {
  baseline: string;
  onDisk: string;
  draft: string;
}): boolean {
  const { baseline, onDisk, draft } = params;
  if (onDisk === baseline) return false;
  if (onDisk === draft) return false;
  return true;
}

/**
 * `⌘S` and `⌘↵` both save the file the editor pane is showing (spec/14 § Editor,
 * § Keyboard shortcuts).
 *
 * The listener is on `window`, not on the Monaco container: standalone Monaco
 * does not bind `⌘S` at all (that chord belongs to the VS Code workbench, which
 * isn't part of `monaco-editor`), so the keydown escapes the editor and reaches
 * the browser's own save-page dialogue. Nothing else in the app claims `⌘S`.
 *
 * `⌘↵` is the exception, which is what `scope` is for: it is ALSO the composer's
 * send-and-promote key, and the composer is on screen at the same time as the
 * rail. So the Enter form fires only for a keystroke that happened inside this
 * pane; a window-wide binding would silently steal every send made while the
 * editor was open.
 *
 * `enabled` gates BOTH the handler and the `preventDefault`, so the chord is
 * only ever swallowed while there is genuinely a file on screen to save —
 * outside the editor it still belongs to the browser.
 */
export function useSaveHotkey(
  enabled: boolean,
  onSave: () => void,
  scope: RefObject<HTMLElement | null>,
): void {
  // Keep the latest handler without re-binding the listener on every keystroke
  // (the handler closes over the editor's draft, which changes as you type).
  const handler = useRef(onSave);
  handler.current = onSave;
  useEffect(() => {
    if (!enabled) return;
    function onKey(e: KeyboardEvent): void {
      if (isSubmitChord(e)) {
        if (!scope.current?.contains(e.target as Node)) return;
        e.preventDefault();
        handler.current();
        return;
      }
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      if (e.key.toLowerCase() !== 's') return;
      e.preventDefault();
      handler.current();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, scope]);
}

export interface EditorRailProps {
  chatId: string | null;
  /**
   * Send a wire event back through the WS — wired in AppShell.
   * Surface decoupling from PatchWs keeps this testable.
   */
  onSendEvent?: (
    event:
      | {
          type: 'chat.permission_response';
          requestId: string;
          approve: boolean;
          decision: 'approve' | 'deny' | 'approve_with_edits';
          editedNewString?: string;
        }
      | {
          // G3: editor save — commits the file back to the host, which
          // validates the chat is idle before writing to disk (spec/03 +
          // spec/14 § Diff editor).
          type: 'file.write';
          chatId: string;
          path: string;
          content: string;
        },
  ) => void;
}

export interface PendingDiff {
  /** Permission request the user is approving. */
  requestId: string;
  /** Tool name (Edit, Write, NotebookEdit). */
  tool: string;
  /** File the agent wants to edit. */
  filePath: string;
  /** Original (a) side of the diff — usually the current on-disk content. */
  original: string;
  /** Modified (b) side — the agent's proposed new content. */
  modified: string;
  /** Human-readable description if the host attached one. */
  description?: string;
}

/**
 * Parse a `chat.permission_request` whose tool is a file-edit (Edit/Write/
 * NotebookEdit) into a PendingDiff. Falls through (returns null) for tools
 * we don't render in Monaco — those stay in the regular permission card.
 *
 * Source-of-truth conventions for tool args:
 *   Edit         { file_path, old_string, new_string }
 *   Write        { file_path, content }   (original empty string)
 *   NotebookEdit { notebook_path, new_source, old_source }
 */
export function pendingDiffFromPermission(args: {
  requestId: string;
  tool: string;
  toolArgs: unknown;
  description?: string;
}): PendingDiff | null {
  if (typeof args.toolArgs !== 'object' || args.toolArgs === null) return null;
  const a = args.toolArgs as Record<string, unknown>;
  if (args.tool === 'Edit' && typeof a['file_path'] === 'string') {
    const original = typeof a['old_string'] === 'string' ? (a['old_string'] as string) : '';
    const modified = typeof a['new_string'] === 'string' ? (a['new_string'] as string) : '';
    const result: PendingDiff = {
      requestId: args.requestId,
      tool: args.tool,
      filePath: a['file_path'] as string,
      original,
      modified,
    };
    if (args.description !== undefined) result.description = args.description;
    return result;
  }
  if (args.tool === 'Write' && typeof a['file_path'] === 'string') {
    const result: PendingDiff = {
      requestId: args.requestId,
      tool: args.tool,
      filePath: a['file_path'] as string,
      original: '',
      modified: typeof a['content'] === 'string' ? (a['content'] as string) : '',
    };
    if (args.description !== undefined) result.description = args.description;
    return result;
  }
  if (args.tool === 'NotebookEdit' && typeof a['notebook_path'] === 'string') {
    const result: PendingDiff = {
      requestId: args.requestId,
      tool: args.tool,
      filePath: a['notebook_path'] as string,
      original: typeof a['old_source'] === 'string' ? (a['old_source'] as string) : '',
      modified: typeof a['new_source'] === 'string' ? (a['new_source'] as string) : '',
    };
    if (args.description !== undefined) result.description = args.description;
    return result;
  }
  return null;
}

/**
 * The plain single-pane view used when a file has no original side
 * (`isWholeFileView`) — the same `<Editor>` the file browser's right pane uses,
 * showing the file itself rather than a one-sided diff, and directly editable.
 *
 * It feeds the SAME `edited` state the diff path feeds, so Save / Approve /
 * Approve-with-edits and the `file.write` save path are untouched either way.
 * Rendered as a DIRECT child of `.diff-panel`, exactly like `<DiffEditor>`, so
 * it inherits the panel's existing flex sizing with no new CSS.
 */
export function WholeFileEditor({
  path,
  value,
  onChange,
}: {
  path: string;
  value: string;
  onChange: (next: string) => void;
}): JSX.Element {
  const language = inferLanguage(path);
  return (
    <Editor
      value={value}
      language={language}
      // Follows the app palette — see the note on FileDiffPanel's DiffEditor.
      theme={MONACO_THEME}
      options={{
        minimap: { enabled: false },
        // Keep Monaco fitted to the (resizable) rail — see the DiffEditor note.
        automaticLayout: true,
        scrollBeyondLastColumn: 0,
        ...editorOptionsFor(language),
      }}
      onChange={(next) => onChange(next ?? '')}
      onMount={() => {
        (window as unknown as { __monacoMounted?: boolean }).__monacoMounted = true;
      }}
      loading={<div data-testid="diff-loading">Loading…</div>}
    />
  );
}

/**
 * Redesign (spec/14 § File browser — meta strip): the read-only inline diff
 * the "Git diff" / "Agent's edits" toggles show IN PLACE of the plain editor,
 * in the same open-file pane (tree + breadcrumb stay on screen).
 *
 * Unlike `FileDiffPanel` (opened from an agent edit or a chat tool-call, and
 * genuinely editable so the user can tweak a proposed change before Save),
 * this is VIEW ONLY — reviewing, not editing. So it deliberately does NOT
 * replicate that panel's "click a decorated line to unlock editing" wiring,
 * has no Save/Close footer of its own, and reuses the SAME options pattern
 * (`renderSideBySide: false`, `readOnly: true`, `originalEditable: false`)
 * with nothing that ever flips `readOnly` off.
 *
 * Mirrors `isWholeFileView`: an empty original side (no git HEAD baseline, or
 * a `Write` with nothing to reverse) is the whole file painted as one block of
 * additions — a diff of nothing against everything, which says nothing a
 * plain read-only view of the file doesn't already say — so that case renders
 * as a single read-only pane instead of a two-sided diff, exactly like
 * `FileDiffPanel` does for the same rule.
 */
export function InlineDiffView({
  path,
  original,
  modified,
}: {
  path: string;
  original: string;
  modified: string;
}): JSX.Element {
  const language = inferLanguage(path);
  const wholeFile = isWholeFileView(original);
  // G2-d4: the same clean-unmount guard `FileDiffPanel`/`DiffPanel` use —
  // toggling this view off unmounts the DiffEditor, and without taking
  // ownership of its TextModels first, @monaco-editor/react disposes them
  // BEFORE the widget, throwing the uncaught "TextModel got disposed before
  // DiffEditorWidget model got reset" error on every toggle-off.
  const diffCleanup = useDiffEditorCleanup();
  return (
    <div className="browse-diff-inline" data-testid="browse-diff-inline">
      {wholeFile ? (
        <Editor
          value={modified}
          language={language}
          theme={MONACO_THEME}
          options={{
            readOnly: true,
            minimap: { enabled: false },
            automaticLayout: true,
            scrollBeyondLastColumn: 0,
            ...editorOptionsFor(language),
          }}
          loading={<div data-testid="diff-loading">Loading…</div>}
        />
      ) : (
        <DiffEditor
          original={original}
          modified={modified}
          language={language}
          // Follows the app palette — see the note on FileDiffPanel's DiffEditor.
          theme={MONACO_THEME}
          {...diffCleanup.keepProps}
          options={{
            renderSideBySide: false,
            readOnly: true,
            originalEditable: false,
            minimap: { enabled: false },
            automaticLayout: true,
            scrollBeyondLastColumn: 0,
            ...editorOptionsFor(language),
          }}
          onMount={(diffEditor) => diffCleanup.onMount(diffEditor as MonacoDiffEditorLike)}
          loading={<div data-testid="diff-loading">Loading…</div>}
        />
      )}
    </div>
  );
}

/**
 * G3 diff editor (entered from an agent edit). Monaco `createDiffEditor`,
 * unified-only (renderSideBySide:false). Clicking a +/− line drops the
 * modified side out of read-only so it becomes a yellow editable box; Save
 * emits a `file.write`. Writable whatever the chat is doing.
 *
 * With nothing on the original side it renders `WholeFileEditor` instead — see
 * `isWholeFileView`. Header, path label, Save and `file.write` are unchanged.
 */
export function FileDiffPanel({
  entry,
  visible,
  onSave,
  onClose,
}: {
  entry: { path: string; original: string; modified: string };
  /** The rail is on screen — see `BrowsePanel`'s note. A hidden pane must not
   *  keep ⌘S, which then belongs to the browser again. */
  visible: boolean;
  onSave: (content: string) => void;
  onClose: () => void;
}): JSX.Element {
  const [edited, setEdited] = useState<string>(entry.modified);
  // G2-d4: same clean-unmount guard as DiffPanel — dispose the diff editor's
  // TextModels after the widget so React's unmount can't fire the Monaco
  // "TextModel got disposed before DiffEditorWidget model got reset" error.
  const diffCleanup = useDiffEditorCleanup();
  useEffect(() => {
    setEdited(entry.modified);
  }, [entry.path, entry.modified]);

  const dirty = edited !== entry.modified;

  // ⌘S commits the tweaked file, exactly as the Save button does.
  function saveEdit(): void {
    if (!dirty) return;
    onSave(edited);
  }
  const paneRef = useRef<HTMLDivElement>(null);
  useSaveHotkey(visible, saveEdit, paneRef);

  const wholeFile = isWholeFileView(entry.original);

  return (
    <div
      ref={paneRef}
      className="diff-panel"
      data-testid="file-diff-panel"
      data-path={entry.path}
      data-view={wholeFile ? 'file' : 'diff'}
    >
      <header className="diff-panel-header">
        <span className="diff-panel-path" data-testid="file-diff-path">
          {entry.path}
        </span>
      </header>
      {wholeFile ? (
        <WholeFileEditor path={entry.path} value={edited} onChange={setEdited} />
      ) : (
        <DiffEditor
          original={entry.original}
          modified={edited}
          language={inferLanguage(entry.path)}
          // spec/14 § Theming: Monaco follows the app palette. This prop is NOT
          // optional — @monaco-editor/react defaults `theme` to "light" and calls
          // `setTheme` with it at create, so leaving it off silently clobbers the
          // palette applied at boot (lib/monacoTheme.ts) back to the built-in
          // light theme. Every Monaco mount in this file passes it.
          theme={MONACO_THEME}
          {...diffCleanup.keepProps}
          options={{
            renderSideBySide: false,
            readOnly: true,
            originalEditable: false,
            minimap: { enabled: false },
            // G3-d2: re-fit to the container on every resize. Without this Monaco
            // measures once at mount and keeps a stale (often too-narrow) width,
            // overflowing/clipping line content when the rail width changes (e.g.
            // entering/leaving fullscreen, or the change-set rail appearing).
            automaticLayout: true,
            scrollBeyondLastColumn: 0,
            ...editorOptionsFor(inferLanguage(entry.path)),
          }}
          onMount={(diffEditor) => {
            (window as unknown as { __monacoMounted?: boolean }).__monacoMounted = true;
            diffCleanup.onMount(diffEditor as MonacoDiffEditorLike);
            const me = (
              diffEditor as unknown as {
                getModifiedEditor?: () => {
                  onDidChangeModelContent: (cb: () => void) => unknown;
                  getValue: () => string;
                  deltaDecorations?: (
                    oldIds: string[],
                    newDecs: Array<{
                      range: unknown;
                      options: { isWholeLine?: boolean; className?: string };
                    }>,
                  ) => string[];
                  onMouseDown?: (
                    cb: (e: { target: { position?: { lineNumber: number } } }) => void,
                  ) => unknown;
                  updateOptions?: (opts: { readOnly?: boolean }) => void;
                };
              }
            ).getModifiedEditor?.();
            if (!me) return;
            const monaco = (window as unknown as { monaco?: typeof import('monaco-editor') })
              .monaco;
            if (monaco?.Range && me.deltaDecorations) {
              const lines = (edited === '' ? [] : edited.split('\n')).length || 1;
              const decs = [];
              for (let i = 1; i <= lines; i++) {
                decs.push({
                  range: new monaco.Range(i, 1, i, 1),
                  options: { isWholeLine: true, className: 'diff-line-modified' },
                });
              }
              me.deltaDecorations([], decs);
            }
            // Click a changed line → make the modified side editable (yellow box).
            if (me.onMouseDown && me.updateOptions) {
              me.onMouseDown(() => {
                me.updateOptions?.({ readOnly: false });
              });
            }
            me.onDidChangeModelContent(() => {
              setEdited(me.getValue());
            });
          }}
          loading={<div data-testid="diff-loading">Loading…</div>}
        />
      )}
      <footer className="diff-panel-actions" data-testid="file-diff-actions">
        <button type="button" data-testid="file-diff-close" onClick={onClose}>
          Close
        </button>
        <button
          type="button"
          data-testid="file-diff-save"
          disabled={!dirty}
          title={shortcutLabel('⌘S')}
          onClick={saveEdit}
        >
          Save
        </button>
      </footer>
    </div>
  );
}

export function DiffPanel({
  diff,
  onApprove,
  onApproveEdits,
  onDeny,
}: {
  diff: PendingDiff | null;
  onApprove: () => void;
  onApproveEdits: (edited: string) => void;
  onDeny: () => void;
}): JSX.Element {
  /* v8 ignore next -- defensive only: `diff` is typed `PendingDiff | null` for reusability, but the sole call site only ever mounts `<DiffPanel diff={pendingDiff} .../>` inside a `pendingDiff ? ... : ...` branch, so `diff` is always truthy for every render of this component. */
  const [edited, setEdited] = useState<string>(diff?.modified ?? '');
  // G2-d4: take ownership of the diff editor's TextModels so they are disposed
  // AFTER the widget (the wrapper keeps them via keepProps). Resolving the
  // permission (from either the inline card or this panel) tears the DiffPanel
  // out of the tree; without this the wrapper disposed the models before the
  // widget, firing the uncaught Monaco error "TextModel got disposed before
  // DiffEditorWidget model got reset".
  const diffCleanup = useDiffEditorCleanup();

  useEffect(() => {
    /* v8 ignore next -- defensive only: see the `diff` null-check above — always truthy here. */
    setEdited(diff?.modified ?? '');
  }, [diff?.requestId, diff?.modified]);

  /* v8 ignore next 7 -- defensive only: see the top-of-component note — `diff` is always truthy given the sole call site, so this fallback UI is unreachable. */
  if (!diff) {
    return (
      <div className="editor-empty" data-testid="editor-empty">
        No pending diff. Click an Edit/Write tool call to inspect it here.
      </div>
    );
  }

  const dirty = edited !== diff.modified;
  // A permission request carries no baseline (a Write's args are the whole new
  // file), so a Write lands here with an empty original side and renders as the
  // plain file — see `isWholeFileView`.
  const wholeFile = isWholeFileView(diff.original);

  return (
    <div
      className="diff-panel"
      data-testid="diff-panel"
      data-request-id={diff.requestId}
      data-view={wholeFile ? 'file' : 'diff'}
    >
      <header className="diff-panel-header">
        <span className="diff-panel-tool" data-testid="diff-panel-tool">
          {diff.tool}
        </span>
        <span className="diff-panel-path" data-testid="diff-panel-path">
          {diff.filePath}
        </span>
      </header>
      {wholeFile ? (
        <WholeFileEditor path={diff.filePath} value={edited} onChange={setEdited} />
      ) : (
        <DiffEditor
          original={diff.original}
          modified={edited}
          language={inferLanguage(diff.filePath)}
          // Follows the app palette — see the note on FileDiffPanel's DiffEditor.
          theme={MONACO_THEME}
          {...diffCleanup.keepProps}
          options={{
            renderSideBySide: false,
            // Group 20 fix #6: modified side starts read-only; clicking a
            // decorated (yellow) line drops readOnly so the user can type.
            readOnly: true,
            originalEditable: false,
            minimap: { enabled: false },
            // G3-d2: keep Monaco fitted to its (resizable) container width.
            automaticLayout: true,
            scrollBeyondLastColumn: 0,
            ...editorOptionsFor(inferLanguage(diff.filePath)),
          }}
          onMount={(diffEditor) => {
            // Track mount for tests + plumb modified-side change events back
            // up so the DiffPanel sees user edits.
            (window as unknown as { __monacoMounted?: boolean }).__monacoMounted = true;
            // G2-d4: hand the widget to the cleanup hook so it captures the
            // TextModels and disposes them AFTER the widget (avoids the Monaco
            // TextModel-disposed error).
            diffCleanup.onMount(diffEditor as MonacoDiffEditorLike);
            const me = (
              diffEditor as unknown as {
                getModifiedEditor?: () => {
                  onDidChangeModelContent: (cb: () => void) => unknown;
                  getValue: () => string;
                  getModel?: () => unknown;
                  deltaDecorations?: (
                    oldIds: string[],
                    newDecs: Array<{
                      range: unknown;
                      options: { isWholeLine?: boolean; className?: string };
                    }>,
                  ) => string[];
                  onMouseDown?: (
                    cb: (e: { target: { position?: { lineNumber: number } } }) => void,
                  ) => unknown;
                  updateOptions?: (opts: { readOnly?: boolean }) => void;
                };
              }
            ).getModifiedEditor?.();
            if (!me) return;
            // Decorate the proposed-change lines yellow.
            const monaco = (window as unknown as { monaco?: typeof import('monaco-editor') })
              .monaco;
            if (monaco?.Range && me.deltaDecorations) {
              const lines = (edited === '' ? [] : edited.split('\n')).length || 1;
              const decs = [];
              for (let i = 1; i <= lines; i++) {
                decs.push({
                  range: new monaco.Range(i, 1, i, 1),
                  options: { isWholeLine: true, className: 'diff-line-modified' },
                });
              }
              me.deltaDecorations([], decs);
            }
            // Click a decorated line → enable editing for the whole modified
            // side and tag the row as user-edited.
            if (me.onMouseDown && me.updateOptions) {
              me.onMouseDown(() => {
                me.updateOptions?.({ readOnly: false });
              });
            }
            me.onDidChangeModelContent(() => {
              setEdited(me.getValue());
            });
          }}
          loading={<div data-testid="diff-loading">Loading…</div>}
        />
      )}
      <footer className="diff-panel-actions" data-testid="diff-actions">
        <button type="button" data-testid="diff-deny" onClick={onDeny}>
          Deny
        </button>
        {dirty ? (
          <button
            type="button"
            data-testid="diff-approve-with-edits"
            // An empty edit is sent as an empty string, not refused: clearing the
            // content is how a change that DELETES it is approved (spec/03
            // § Answering with content).
            onClick={() => onApproveEdits(edited)}
          >
            Approve with edits
          </button>
        ) : (
          <button type="button" data-testid="diff-approve" onClick={onApprove}>
            Approve
          </button>
        )}
      </footer>
    </div>
  );
}

/**
 * The file browser's loading shape (spec/14 § File browser).
 *
 * Every one of the browser's three fetches used to render its RESOLVED-EMPTY
 * fallback while in flight — an empty tree, a blank document, a picker with no
 * rows — so "still loading" and "there is nothing here" drew identically
 * (Todoist: "patch file viewer has no loading state just lookes empty"). Grey
 * bars at the height of the rows they stand in for say it is arriving without a
 * sentence explaining it.
 *
 * The widths are a fixed list, not random: a re-render must not reshuffle the
 * bars, and slicing rather than indexing keeps it total (`rows` <= WIDTHS.length).
 */
const SKELETON_WIDTHS = [72, 54, 86, 46, 66, 78, 58, 90];

export function BrowseSkeleton({ rows, testId }: { rows: number; testId: string }): JSX.Element {
  return (
    <div
      className="browse-skeleton"
      data-testid={testId}
      role="status"
      aria-busy="true"
      aria-label="loading"
    >
      {SKELETON_WIDTHS.slice(0, rows).map((w, i) => (
        <span key={i} className="browse-skeleton-line" style={{ width: `${w}%` }} />
      ))}
    </div>
  );
}

/**
 * Save-conflict prompt (spec/14 § File browser — save conflicts, Zed-style).
 * Three explicit outcomes, no silent default (portfolio CLAUDE.md "no
 * fallbacks"): Reload the on-disk version (discarding the draft), Overwrite
 * it with the draft, or back out and decide later. Esc/backdrop map to the
 * same "back out" choice as the Cancel button — none of the three ever fire
 * on their own.
 *
 * A small dedicated modal rather than `useUiStore.getState().confirm()`:
 * `confirm()` is a single message + one confirm/cancel pair, which has no
 * room for the THIRD outcome (Overwrite vs. Reload are both "confirm", just
 * different actions) without collapsing two distinct, non-reversible choices
 * into one button.
 */
export function SaveConflictModal({
  path,
  onReload,
  onOverwrite,
  onCancel,
}: {
  path: string;
  onReload: () => void;
  onOverwrite: () => void;
  onCancel: () => void;
}): JSX.Element {
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="modal-overlay" data-testid="save-conflict-overlay">
      <div className="modal-backdrop" data-testid="save-conflict-backdrop" onClick={onCancel} />
      <div
        className="modal-card save-conflict-modal"
        data-testid="save-conflict-modal"
        role="dialog"
        aria-modal="true"
        aria-label="File changed elsewhere"
      >
        <h2 className="modal-title">File changed elsewhere</h2>
        <p className="modal-message">
          {path} was changed on disk since you started editing it. Reload to discard your changes
          and see the latest version, or overwrite it with what you have here.
        </p>
        <div className="modal-actions">
          <button
            type="button"
            className="modal-btn"
            data-testid="save-conflict-cancel"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="modal-btn"
            data-testid="save-conflict-reload"
            onClick={onReload}
          >
            Reload
          </button>
          <button
            type="button"
            className="modal-btn danger-btn"
            data-testid="save-conflict-overwrite"
            autoFocus
            onClick={onOverwrite}
          >
            Overwrite
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Editor overhaul (hierarchical tree): renders one level of `buildFileTree`'s
 * output and recurses into every EXPANDED directory — a real explorer (VS
 * Code / GitHub style) instead of navigating one directory at a time.
 *
 * The whole row stays clickable for expand/collapse (matching the OLD
 * whole-row-navigates behaviour), not just the chevron — the chevron is a
 * visual indicator of state, not a separate hit target (per spec/14 § File
 * browser update: "keep the whole row clickable ... with the chevron just
 * visually indicating state").
 *
 * `data-testid`s key on the FULL PATH, not the bare name: two different
 * directories can hold a same-named file, and the tree can show both at once
 * now that it is hierarchical, so a bare-name testid would collide.
 */
export function FileTreeRows({
  nodes,
  depth,
  expandedDirs,
  forceExpand,
  openFilePath,
  openFileDirty,
  renamingPath,
  renameValue,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
  onToggleDir,
  onOpenFile,
  onContextMenu,
}: {
  nodes: TreeNode[];
  depth: number;
  expandedDirs: Set<string>;
  /** Filtering is on — every directory in the (already-filtered) result renders expanded. */
  forceExpand: boolean;
  openFilePath: string | null;
  /** Whether the OPEN file (whichever node that is) has an unsaved draft. */
  openFileDirty: boolean;
  renamingPath: string | null;
  renameValue: string;
  onRenameChange: (v: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onToggleDir: (path: string) => void;
  onOpenFile: (node: TreeNode) => void;
  onContextMenu: (
    entry: { name: string; path: string; type: 'file' | 'dir' },
    ev: ReactMouseEvent,
  ) => void;
}): JSX.Element {
  return (
    <>
      {nodes.map((n) => {
        const expanded = n.type === 'dir' && (forceExpand || expandedDirs.has(n.path));
        const active = n.type === 'file' && openFilePath === n.path;
        // G3-d3: pending = a GENUINE on-disk change only — see the original
        // note this replaces below. The server `dirty` flag (attached per
        // node by `buildFileTree`) is authoritative; the currently-open
        // file's own unsaved draft is the other real source.
        const pending = n.type === 'file' && (n.dirty === true || (active && openFileDirty));
        const renaming = renamingPath === n.path;
        const entry = { name: n.name, path: n.path, type: n.type };
        return (
          <Fragment key={n.path}>
            {/* The row stays a <button>; the actions control is a SIBLING,
                because a button inside a button is not valid markup and the
                inner one does not reliably receive the click. */}
            <div className="tree-row-wrap">
              <button
                type="button"
                className={`tree-row tree-${n.type}${pending ? ' dirty' : ''}${active ? ' active' : ''}`}
                data-testid={`tree-row-${n.path}`}
                data-type={n.type}
                data-dirty={pending ? 'true' : undefined}
                aria-current={active ? 'true' : undefined}
                title={n.name}
                style={{ paddingLeft: 8 + depth * 14 }}
                onContextMenu={(ev) => onContextMenu(entry, ev)}
                onClick={() => (n.type === 'dir' ? onToggleDir(n.path) : onOpenFile(n))}
              >
                {n.type === 'dir' ? (
                  expanded ? (
                    <ChevronDown
                      size={12}
                      className="tree-chevron"
                      data-testid={`tree-expand-${n.path}`}
                      aria-hidden
                    />
                  ) : (
                    <ChevronRight
                      size={12}
                      className="tree-chevron"
                      data-testid={`tree-expand-${n.path}`}
                      aria-hidden
                    />
                  )
                ) : (
                  // Files get no chevron (nothing to expand) — a same-width
                  // spacer keeps every row's icon+name aligned regardless of
                  // depth or type.
                  <span className="tree-chevron-spacer" aria-hidden />
                )}
                {/* Redesign: lucide glyphs, not emoji — the emoji rendered at a
                different size/baseline per platform and read as clip-art
                against the rest of the app's icon set. */}
                {n.type === 'dir' ? (
                  <Folder size={13} className="tree-icon" aria-hidden />
                ) : (
                  <FileText size={13} className="tree-icon" aria-hidden />
                )}
                {renaming ? (
                  // Editor overhaul (inline create): typing here replaces
                  // "untitled" — autofocused, pre-selected so the first
                  // keystroke clears it rather than appending to it.
                  <input
                    className="tree-name-input"
                    data-testid={`tree-rename-input-${n.path}`}
                    autoFocus
                    value={renameValue}
                    onFocus={(ev) => ev.currentTarget.select()}
                    onChange={(ev) => onRenameChange(ev.target.value)}
                    onClick={(ev) => ev.stopPropagation()}
                    onKeyDown={(ev) => {
                      if (ev.key === 'Enter') {
                        ev.preventDefault();
                        ev.stopPropagation();
                        onRenameCommit();
                      } else if (ev.key === 'Escape') {
                        ev.preventDefault();
                        // Without this, the keydown bubbles to the document-level
                        // Escape handler that closes the whole file browser —
                        // cancelling a rename should never also close the panel.
                        ev.stopPropagation();
                        onRenameCancel();
                      }
                    }}
                    onBlur={onRenameCommit}
                  />
                ) : (
                  <span className="tree-name">{n.name}</span>
                )}
                {pending ? (
                  <span
                    className="pending-dot"
                    data-testid={`pending-dot-${n.path}`}
                    aria-label="pending changes"
                  >
                    ●
                  </span>
                ) : null}
              </button>
              <button
                type="button"
                className="tree-row-actions"
                // NOT prefixed `tree-row-` — the browse tests select the rows
                // themselves with `[data-testid^="tree-row-"]`, and a second
                // element per row under that prefix silently doubles every
                // count and ordering assertion they make.
                data-testid={`row-actions-${n.path}`}
                aria-label={`actions for ${n.name}`}
                title="Actions"
                onClick={(ev) => onContextMenu(entry, ev)}
              >
                <MoreHorizontal size={13} aria-hidden />
              </button>
            </div>
            {n.type === 'dir' && expanded && n.children ? (
              <FileTreeRows
                nodes={n.children}
                depth={depth + 1}
                expandedDirs={expandedDirs}
                forceExpand={forceExpand}
                openFilePath={openFilePath}
                openFileDirty={openFileDirty}
                renamingPath={renamingPath}
                renameValue={renameValue}
                onRenameChange={onRenameChange}
                onRenameCommit={onRenameCommit}
                onRenameCancel={onRenameCancel}
                onToggleDir={onToggleDir}
                onOpenFile={onOpenFile}
                onContextMenu={onContextMenu}
              />
            ) : null}
          </Fragment>
        );
      })}
    </>
  );
}

export function FileSearch({
  entries,
  loading,
  onPick,
  onClose,
}: {
  /**
   * Group 20 fix #5: when entries come from the recursive endpoint, each
   * row's `name` is the relative path; the basename is derived. Filename
   * matches outrank path matches.
   */
  entries: Array<{ name: string; type: 'file' | 'dir' }>;
  /** The recursive index is still being fetched — there is nothing to rank yet. */
  loading: boolean;
  onPick: (name: string, fullPath?: string) => void;
  onClose: () => void;
}): JSX.Element {
  const [q, setQ] = useState('');
  const matches = useMemo(() => {
    const lower = q.toLowerCase();
    const files = entries.filter((e) => e.type === 'file');
    const ranked: Array<{ name: string; basename: string; score: number }> = [];
    for (const f of files) {
      /* v8 ignore next -- defensive only: `.split('/')` always returns a non-empty array, so `.pop()` always returns a defined string; the `?? f.name` fallback is unreachable. */
      const basename = f.name.split('/').pop() ?? f.name;
      const idxBase = basename.toLowerCase().indexOf(lower);
      const idxPath = f.name.toLowerCase().indexOf(lower);
      if (idxBase < 0 && idxPath < 0) continue;
      // Lower score = better. Filename hits beat path hits.
      const score = idxBase >= 0 ? idxBase : 1000 + idxPath;
      ranked.push({ name: f.name, basename, score });
    }
    ranked.sort((a, b) => a.score - b.score);
    return ranked;
  }, [q, entries]);
  return (
    <div className="file-search-modal" data-testid="file-search">
      {/* No `data-search-input` here: this overlay is opened by ⌘P and already
          autofocuses its input, so claiming the page search chords would only
          re-focus what is focused. */}
      <input
        autoFocus
        data-testid="file-search-input"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          if (e.key === 'Enter' && matches[0]) onPick(matches[0].basename, matches[0].name);
        }}
        placeholder="Find file…"
      />
      {loading ? <BrowseSkeleton rows={5} testId="file-search-loading" /> : null}
      <ul>
        {matches.slice(0, 30).map((m) => (
          <li key={m.name}>
            <button
              type="button"
              onClick={() => onPick(m.basename, m.name)}
              data-testid={`file-search-${m.basename}`}
            >
              <span className="fs-name">{m.basename}</span>
              <span className="fs-path">{m.name}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * G3: the agent's last-edit baseline for a file — the WHOLE file as it stood
 * immediately before the most recent Edit/Write/NotebookEdit tool call in this
 * chat targeting `path`. This is the "before" side of "view diff vs agent's
 * last edit".
 *
 * The naive version returned just the edit's `old_string` (a single hunk) and
 * let the caller diff that fragment against the entire working-tree file. That
 * mis-rendered the whole rest of the file as "added", so the diff showed masses
 * of content the agent never touched (todo: "view diff since agent last edit
 * shows stuff the agent hasn't changed."). We fix it by reconstructing the full
 * pre-edit file: take the current on-disk content and reverse the last edit's
 * hunk (swap `new_string` back to `old_string`). The reconstructed baseline
 * then differs from the working tree in ONLY the region the agent edited, so
 * the diff highlights exactly that.
 *
 * `currentContent` is the working-tree content (the "after" / modified side).
 *
 * This used to answer with a bare string, and answered `currentContent` itself
 * for BOTH "this chat never edited that file" and "the recorded `new_string` is
 * no longer in the file". Both opened the diff editor on two identical sides
 * with nothing said, which is exactly what a person reads as a dead button
 * (todo: "patch vs head and vs agent buttons dont work"). That is the silent
 * fallback this repo forbids, so the four outcomes are now distinct and the
 * caller says which one happened:
 *   - `reconstructed` — Edit / NotebookEdit whose `new_string` is still present:
 *     `original` is the pre-edit full file (last occurrence of the hunk
 *     reversed), so the diff highlights exactly the agent's region.
 *   - `whole-file` — a `Write` (no hunk): `original` is '', the agent authored
 *     everything, and the whole file is genuinely its change.
 *   - `untouched` — no Edit/Write/NotebookEdit in this chat's timeline names
 *     this file. There is NO agent baseline; there is nothing to diff.
 *   - `unreconstructable` — an edit IS recorded but its `new_string` is gone
 *     from the file (superseded, or the file changed underneath). We still
 *     refuse to emit the bare `old_string` fragment, which would falsely mark
 *     the whole file as changed — but we no longer pretend that is an empty
 *     diff either.
 */
export type AgentBaseline =
  | { kind: 'reconstructed'; original: string }
  | { kind: 'whole-file'; original: string }
  | { kind: 'untouched' }
  | { kind: 'unreconstructable' };

export function agentBaselineForFile(
  chatId: string,
  path: string,
  currentContent: string,
): AgentBaseline {
  const timeline = useChatStore.getState().timelines[chatId] ?? [];
  for (let i = timeline.length - 1; i >= 0; i--) {
    const entry = timeline[i];
    /* v8 ignore next -- defensive only: `i` is always within `[0, timeline.length)`, so `timeline[i]` is always defined; the `!entry` check only exists to satisfy noUncheckedIndexedAccess. */
    if (!entry || entry.kind !== 'tool_call' || typeof entry.tool !== 'string') continue;
    if (!/edit|write/i.test(entry.tool)) continue;
    const a = (entry.toolArgs ?? {}) as Record<string, unknown>;
    const filePath = typeof a['file_path'] === 'string' ? a['file_path'] : a['notebook_path'];
    if (typeof filePath !== 'string') continue;
    // Match on basename or full path (tool args carry absolute paths).
    if (filePath === path || filePath.endsWith(`/${path}`) || filePath.endsWith(path)) {
      const oldStr =
        typeof a['old_string'] === 'string'
          ? (a['old_string'] as string)
          : typeof a['old_source'] === 'string'
            ? (a['old_source'] as string)
            : null;
      const newStr =
        typeof a['new_string'] === 'string'
          ? (a['new_string'] as string)
          : typeof a['new_source'] === 'string'
            ? (a['new_source'] as string)
            : null;
      // A Write tool replaces the whole file — no hunk to reverse, the agent
      // wrote everything, so the baseline is empty (whole file is its change).
      if (oldStr === null || newStr === null) return { kind: 'whole-file', original: '' };
      // Reverse the LAST occurrence of the agent's new_string (its most-recent
      // edit region) back to old_string to rebuild the pre-edit full file.
      const at = currentContent.lastIndexOf(newStr);
      if (at === -1) return { kind: 'unreconstructable' };
      return {
        kind: 'reconstructed',
        original: currentContent.slice(0, at) + oldStr + currentContent.slice(at + newStr.length),
      };
    }
  }
  return { kind: 'untouched' };
}

/**
 * What the two meta-strip diff buttons should DO with a baseline, as a value.
 * `original: null` means do not open the diff editor at all; `notice` and
 * `error` are the sentence the user gets. Pure and exported so every outcome —
 * including the ones that open nothing — is unit-testable without Monaco.
 *
 * An identical pair is a real answer ("nothing has changed"), so it still opens
 * the diff; it just no longer does it wordlessly.
 */
export interface DiffPlan {
  /** The "before" side, or null when there is nothing honest to show. */
  original: string | null;
  notice: string | null;
  error: string | null;
}

export function agentDiffPlan(
  baseline: AgentBaseline,
  currentContent: string,
  fileName: string,
): DiffPlan {
  if (baseline.kind === 'untouched') {
    return {
      original: null,
      notice: `No agent edit to ${fileName} in this chat, so there is no version to diff against.`,
      error: null,
    };
  }
  if (baseline.kind === 'unreconstructable') {
    return {
      original: null,
      notice: null,
      error: `Can’t rebuild the agent’s version of ${fileName}: the file has changed since that edit.`,
    };
  }
  return {
    original: baseline.original,
    notice:
      baseline.original === currentContent
        ? `${fileName} is unchanged since the agent’s last edit.`
        : null,
    error: null,
  };
}

/**
 * The same, for `vs HEAD`. `head` is the committed content, or null when the
 * host answered `no_head_baseline` (the folder is not a git work-tree, or has
 * no commits). The empty baseline that case produces is still the truthful
 * "all of this file is new", but it USED to arrive unannounced and look like a
 * bug; now it is stated. So is the far commoner silent case — a file that is
 * simply unmodified since HEAD, which drew an empty diff and no word.
 */
export function headDiffPlan(
  head: string | null,
  currentContent: string,
  fileName: string,
): DiffPlan {
  if (head === null) {
    return {
      original: '',
      notice: `This chat’s folder has no git HEAD, so all of ${fileName} shows as new.`,
      error: null,
    };
  }
  return {
    original: head,
    notice: head === currentContent ? `${fileName} is unchanged since HEAD.` : null,
    error: null,
  };
}

/**
 * Redesign (spec/14 § File browser — _Ordering is deterministic_): directories
 * first, then files, each A→Z case-insensitively. The host hands back readdir
 * order, which is arbitrary and not stable between reads, so the same folder
 * could list differently each time and nothing stayed where the user saw it.
 * Pure + exported so the ordering rule is unit-testable on its own.
 */
export function sortEntries<T extends { name: string; type: 'file' | 'dir' }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    const byName = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    // Case-insensitive ties (`Readme.md` vs `README.md`) still need a stable,
    // deterministic order — fall back to the case-sensitive comparison.
    return byName !== 0 ? byName : a.name.localeCompare(b.name);
  });
}

/**
 * Editor overhaul: shared path-splitting helpers — `buildFileTree` and
 * `BrowsePanel` (for `lastActiveDir` / inline rename) both need "what
 * directory is this path in" / "what's the last path segment", so they live
 * once at module scope instead of being redefined in each.
 */
export function dirName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}
export function baseName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

/**
 * Editor overhaul (hierarchical tree): one node in the tree `BrowsePanel`
 * renders — a file, or a directory with its (also-sorted) children. Built
 * client-side from `api.listFilesRecursive`'s flat list, which is now the
 * tree's ONLY data source (see `buildFileTree`).
 */
export interface TreeNode {
  name: string;
  /** Full path relative to the chat folder — what every row keys and acts on. */
  path: string;
  type: 'file' | 'dir';
  dirty?: boolean;
  /** Present (possibly empty) for every `dir` node; absent for `file` nodes. */
  children?: TreeNode[];
}

/**
 * Editor overhaul (hierarchical tree): turn the flat list `listFilesRecursive`
 * returns into a nested tree, so `BrowsePanel` can render a real expand/
 * collapse explorer (VS Code / GitHub style) instead of navigating one
 * directory at a time. Pure + exported so the flat-to-tree conversion is
 * unit-testable without mounting anything.
 *
 * Tolerant of the flat list omitting some intermediate directory (an older
 * host, or a hand-built fixture in a test): a file whose parent directory
 * has no explicit entry gets one SYNTHESIZED so it still has somewhere to
 * live. When the real entry for that directory turns up later in the list
 * (order is not assumed), it fills in the synthesized placeholder's type/
 * dirty rather than creating a duplicate. `sortEntries`'s ordering rule
 * (dirs first, then A→Z case-insensitive) is applied at EVERY level, not
 * just the top, by recursing after the tree is built.
 */
export function buildFileTree(
  entries: Array<{ name: string; type: 'file' | 'dir'; dirty?: boolean }>,
): TreeNode[] {
  const nodes = new Map<string, TreeNode>();
  const childrenOf = new Map<string, TreeNode[]>();

  function attach(n: TreeNode): void {
    const parent = dirName(n.path);
    if (parent === '') {
      if (!childrenOf.has('')) childrenOf.set('', []);
      childrenOf.get('')!.push(n);
      return;
    }
    ensureDir(parent).children!.push(n);
  }
  function ensureDir(path: string): TreeNode {
    const existing = nodes.get(path);
    if (existing) {
      if (!existing.children) existing.children = [];
      return existing;
    }
    const created: TreeNode = { name: baseName(path), path, type: 'dir', children: [] };
    nodes.set(path, created);
    attach(created);
    return created;
  }

  for (const e of entries) {
    const existing = nodes.get(e.name);
    if (existing) {
      // A synthesized placeholder (from a deeper entry processed earlier) —
      // fill in the real record rather than create a duplicate row.
      existing.type = e.type;
      if (e.dirty) existing.dirty = true;
      if (e.type === 'dir' && !existing.children) existing.children = [];
      continue;
    }
    const node: TreeNode = {
      name: baseName(e.name),
      path: e.name,
      type: e.type,
      ...(e.dirty ? { dirty: true } : {}),
      ...(e.type === 'dir' ? { children: [] } : {}),
    };
    nodes.set(e.name, node);
    attach(node);
  }

  function sortTree(list: TreeNode[]): TreeNode[] {
    const sorted = sortEntries(list);
    for (const n of sorted) {
      if (n.children) n.children = sortTree(n.children);
    }
    return sorted;
  }
  return sortTree(childrenOf.get('') ?? []);
}

/**
 * Editor overhaul: the tree's filter narrows the WHOLE tree now (every
 * depth), not just one directory — there is no more "current directory" to
 * scope it to. A node survives if its own name matches, or a descendant's
 * does (so the match stays reachable through its ancestor directories); a
 * surviving directory keeps only the children that themselves survived, not
 * every sibling. Pure + exported for the same reason as `buildFileTree`.
 */
export function filterFileTree(nodes: TreeNode[], query: string): TreeNode[] {
  const q = query.trim().toLowerCase();
  if (q === '') return nodes;
  function walk(list: TreeNode[]): TreeNode[] {
    const out: TreeNode[] = [];
    for (const n of list) {
      if (n.name.toLowerCase().includes(q)) {
        // The node itself is the match — keep its WHOLE original subtree
        // (unfiltered): the user found what they searched for, and a
        // directory whose name matched showing only its OWN matching
        // descendants (dropping the rest) would be a stranger result than
        // just showing everything inside it.
        out.push(n);
        continue;
      }
      if (n.children) {
        const filteredChildren = walk(n.children);
        if (filteredChildren.length > 0) out.push({ ...n, children: filteredChildren });
      }
    }
    return out;
  }
  return walk(nodes);
}

/**
 * Editor overhaul (binary preview): does this filename get an `<img>` / PDF
 * viewer instead of Monaco? Decided purely by extension, the same shape as
 * `inferLanguage` — pure + exported so it is unit-testable on its own.
 */
export function isPreviewableBinary(filename: string): 'image' | 'pdf' | null {
  const lower = filename.toLowerCase();
  const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico'];
  if (IMAGE_EXTS.some((ext) => lower.endsWith(ext))) return 'image';
  if (lower.endsWith('.pdf')) return 'pdf';
  return null;
}

/**
 * Per-language Monaco options (spec/14 § Editor — Markdown mode). Markdown is
 * prose, not code: a paragraph is ONE logical line, so with wrapping off a rail
 * that is ~30% of the window shows a sliver of each paragraph behind a
 * horizontal scrollbar. Wrapping on, continuation lines aligned with the line
 * they belong to, and the word-based autocomplete popup off — suggesting the
 * words already in the document is help while writing code and noise while
 * writing English.
 *
 * Everything else keeps Monaco's code defaults: `.md` gets the markdown
 * tokenizer either way (`inferLanguage`), the wrapping is what makes it usable.
 */
export function editorOptionsFor(language: string): {
  wordWrap: 'on' | 'off';
  wrappingIndent: 'same';
  wordBasedSuggestions: 'off' | 'currentDocument';
  quickSuggestions: boolean;
} {
  const prose = language === 'markdown';
  return {
    wordWrap: prose ? 'on' : 'off',
    wrappingIndent: 'same',
    wordBasedSuggestions: prose ? 'off' : 'currentDocument',
    quickSuggestions: !prose,
  };
}

export function inferLanguage(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.ts') || lower.endsWith('.tsx')) return 'typescript';
  if (lower.endsWith('.js') || lower.endsWith('.jsx')) return 'javascript';
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.md')) return 'markdown';
  if (lower.endsWith('.css')) return 'css';
  if (lower.endsWith('.html')) return 'html';
  if (lower.endsWith('.py')) return 'python';
  if (lower.endsWith('.rs')) return 'rust';
  if (lower.endsWith('.go')) return 'go';
  if (lower.endsWith('.yml') || lower.endsWith('.yaml')) return 'yaml';
  if (lower.endsWith('.sh')) return 'shell';
  return 'plaintext';
}

/**
 * Document editor (spec/14 § Document editor, step 1 of 3): which files open
 * rich by default. Shares `inferLanguage`'s extension test rather than
 * duplicating it — the two must never disagree about what counts as markdown.
 */
export function isMarkdownPath(filename: string): boolean {
  return inferLanguage(filename) === 'markdown';
}

/** Document editor (spec/14 § Document editor, step 3 of 3): which files trigger the open-time .docx -> .md conversion. */
export function isDocxPath(filename: string): boolean {
  return filename.toLowerCase().endsWith('.docx');
}
