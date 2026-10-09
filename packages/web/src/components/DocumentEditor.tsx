// Document editor (spec/14 § Document editor) — a plain text editor for a
// Markdown file, docked in the file browser's pane in place of the code editor
// (`EditorRail.tsx`'s `BrowsePanel`) whenever the open file is a `.md` and the
// user hasn't chosen "Open as source". The text is edited as-is: no HTML or
// ProseMirror conversion on open or on save, so frontmatter, wrapping and
// whitespace come back byte-identical unless the user types.
import { useRef, useState } from 'react';
import type { JSX } from 'react';

export interface DocumentEditorProps {
  /**
   * Identifies which document is open — a file switch (this changing) always
   * resets the editor's content to `value`, even where two different files
   * happen to hold byte-identical text.
   */
  docKey: string;
  /**
   * The file's current markdown (on-disk content, or the caller's own draft).
   * Content is reset to this value whenever it changes for a reason OTHER
   * than this component's own last `onChange` call (`docKey` changing, or the
   * caller's content query resolving after the editor already mounted on a
   * still-empty `value`) — never on every keystroke's own `onChange` echoing
   * back through the parent, which would fight the user's cursor position
   * and selection.
   */
  value: string;
  onChange: (markdown: string) => void;
  /** Selection-to-ask (spec/14 § Document editor — Working with the agent). */
  onAsk: (selectedText: string) => void;
  /**
   * Comments both ways (spec/14 § Document editor, step 2 of 3): opens a new
   * thread anchored to the selection. Always offered, in every mode — a
   * comment never touches the text.
   */
  onComment: (selectedText: string, commentText: string) => void;
}

interface SelectionPopoverState {
  text: string;
  top: number;
  left: number;
}

export function DocumentEditor({
  docKey,
  value,
  onChange,
  onAsk,
  onComment,
}: DocumentEditorProps): JSX.Element {
  const areaRef = useRef<HTMLTextAreaElement>(null);

  const [selection, setSelection] = useState<SelectionPopoverState | null>(null);
  // Comments both ways (spec/14 § Document editor, step 2 of 3): clicking
  // "Comment" in the selection popover swaps it for a small inline form,
  // anchored to the SAME selection — `commentDraft` holds that anchor text
  // while the user types the comment itself.
  const [commentDraft, setCommentDraft] = useState<SelectionPopoverState | null>(null);
  const [commentText, setCommentText] = useState('');
  // Controlled textarea: `value` is the text, verbatim. The caller's draft
  // echoes every keystroke straight back, so there is nothing to reconcile and
  // the cursor stays put.
  function onSelectionChange(anchor: { x: number; y: number } | null): void {
    const area = areaRef.current;
    if (!area) return;
    const { selectionStart, selectionEnd } = area;
    const text = area.value.slice(selectionStart, selectionEnd);
    if (selectionStart === selectionEnd || text.trim().length === 0) {
      setSelection(null);
      return;
    }
    const rect = area.getBoundingClientRect();
    setSelection({
      text,
      top: anchor ? anchor.y + 12 : rect.top + 24,
      left: anchor ? anchor.x : rect.left + 24,
    });
  }

  return (
    <div className="document-editor" data-testid="document-editor">
      <textarea
        ref={areaRef}
        key={docKey}
        className="document-editor-text"
        data-testid="document-editor-content"
        aria-label="Document text"
        spellCheck={false}
        wrap="soft"
        value={value}
        onChange={(ev) => onChange(ev.target.value)}
        onMouseUp={(ev) => onSelectionChange({ x: ev.clientX, y: ev.clientY })}
        onKeyUp={(ev) => {
          if (ev.key === 'Shift' || ev.key.startsWith('Arrow')) onSelectionChange(null);
        }}
      />
      {selection ? (
        <div
          className="document-editor-selection-popover"
          style={{ position: 'fixed', top: selection.top, left: selection.left }}
        >
          <button
            type="button"
            className="document-editor-ask-popover"
            data-testid="document-editor-ask"
            onClick={() => {
              onAsk(selection.text);
              setSelection(null);
            }}
          >
            Ask about this
          </button>
          <button
            type="button"
            className="document-editor-ask-popover"
            data-testid="document-editor-comment-button"
            onClick={() => {
              setCommentDraft(selection);
              setCommentText('');
              setSelection(null);
            }}
          >
            Comment
          </button>
        </div>
      ) : null}
      {commentDraft ? (
        <form
          className="document-editor-comment-form"
          data-testid="document-editor-comment-form"
          style={{ position: 'fixed', top: commentDraft.top, left: commentDraft.left }}
          onSubmit={(ev) => {
            ev.preventDefault();
            if (commentText.trim().length === 0) return;
            onComment(commentDraft.text, commentText);
            setCommentDraft(null);
            setCommentText('');
          }}
        >
          <textarea
            autoFocus
            data-testid="document-editor-comment-input"
            value={commentText}
            onChange={(ev) => setCommentText(ev.target.value)}
            placeholder="Comment on this passage…"
          />
          <div className="document-editor-comment-form-actions">
            <button type="submit" data-testid="document-editor-comment-submit">
              Comment
            </button>
            <button
              type="button"
              data-testid="document-editor-comment-cancel"
              onClick={() => setCommentDraft(null)}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
