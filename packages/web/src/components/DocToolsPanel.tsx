// Document editor — modes, suggestions, comments, history (spec/14 §
// Document editor, step 2 of 3). Three panels `EditorRail.tsx`'s
// `BrowsePanel` swaps into the editor pane via its meta-strip toggles,
// plus the mode select that always sits in the meta strip for an open `.md`
// file. All three read/write through `useDocView` (`lib/docEditor.ts`) — the
// host always answers with the updated view, so none of these keep their
// own copy of it.
import { useState } from 'react';
import type { JSX } from 'react';
import type { DocAction, DocMode, DocView } from '@patch/wire';

export function DocModeSelect({
  mode,
  onChange,
}: {
  mode: DocMode;
  onChange: (mode: DocMode) => void;
}): JSX.Element {
  return (
    <select
      className="doc-mode-select"
      data-testid="doc-mode-select"
      aria-label="Document mode"
      value={mode}
      onChange={(ev) => onChange(ev.target.value as DocMode)}
    >
      <option value="change">Change</option>
      <option value="propose">Propose</option>
      <option value="comment">Comment</option>
    </select>
  );
}

interface DocPanelProps {
  view: DocView;
  dispatch: (action: DocAction) => Promise<DocView>;
}

export function SuggestionsPanel({ view, dispatch }: DocPanelProps): JSX.Element {
  const pending = view.suggestions.filter((s) => s.status === 'pending');
  const resolved = view.suggestions.filter((s) => s.status !== 'pending');
  return (
    <div className="doc-panel" data-testid="doc-suggestions-panel">
      <div className="doc-panel-header">
        <span>
          {pending.length} pending suggestion{pending.length === 1 ? '' : 's'}
        </span>
        {pending.length > 0 ? (
          <div className="doc-panel-header-actions">
            <button
              type="button"
              data-testid="doc-suggestions-accept-all"
              onClick={() => void dispatch({ op: 'accept_all' })}
            >
              Accept all
            </button>
            <button
              type="button"
              data-testid="doc-suggestions-reject-all"
              onClick={() => void dispatch({ op: 'reject_all' })}
            >
              Reject all
            </button>
          </div>
        ) : null}
      </div>
      {view.suggestions.length === 0 ? (
        <div className="doc-panel-empty">No suggestions yet.</div>
      ) : (
        <ul className="doc-suggestions-list">
          {[...pending, ...resolved].map((s) => (
            <li
              key={s.id}
              className={`doc-suggestion doc-suggestion-${s.status}`}
              data-testid={`doc-suggestion-${s.id}`}
            >
              <div className="doc-suggestion-diff">
                <span className="doc-suggestion-find">{s.find}</span>
                <span className="doc-suggestion-arrow">→</span>
                <span className="doc-suggestion-replace">
                  {s.replace === '' ? <em>(deleted)</em> : s.replace}
                </span>
              </div>
              {s.status === 'pending' ? (
                <div className="doc-suggestion-actions">
                  <button
                    type="button"
                    data-testid={`doc-suggestion-accept-${s.id}`}
                    onClick={() => void dispatch({ op: 'accept_suggestion', id: s.id })}
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    data-testid={`doc-suggestion-reject-${s.id}`}
                    onClick={() => void dispatch({ op: 'reject_suggestion', id: s.id })}
                  >
                    Reject
                  </button>
                </div>
              ) : (
                <span className="doc-suggestion-status">{s.status}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CommentThread({
  thread,
  dispatch,
}: {
  thread: DocView['threads'][number];
  dispatch: (action: DocAction) => Promise<DocView>;
}): JSX.Element {
  const [replyText, setReplyText] = useState('');
  return (
    <li
      className={`doc-thread${thread.resolved ? ' doc-thread-resolved' : ''}`}
      data-testid={`doc-thread-${thread.id}`}
    >
      <div className="doc-thread-anchor">"{thread.anchor}"</div>
      <ul className="doc-thread-comments">
        {thread.comments.map((c) => (
          <li key={c.id} className={`doc-comment doc-comment-${c.author}`}>
            <span className="doc-comment-author">{c.author === 'agent' ? 'Agent' : 'You'}</span>
            <span className="doc-comment-text">{c.text}</span>
          </li>
        ))}
      </ul>
      <div className="doc-thread-footer">
        {!thread.resolved ? (
          <form
            className="doc-thread-reply"
            onSubmit={(ev) => {
              ev.preventDefault();
              if (replyText.trim().length === 0) return;
              void dispatch({ op: 'reply_comment', threadId: thread.id, text: replyText });
              setReplyText('');
            }}
          >
            <input
              data-testid={`doc-thread-reply-input-${thread.id}`}
              value={replyText}
              onChange={(ev) => setReplyText(ev.target.value)}
              placeholder="Reply…"
            />
            <button type="submit" data-testid={`doc-thread-reply-submit-${thread.id}`}>
              Reply
            </button>
          </form>
        ) : null}
        <button
          type="button"
          data-testid={`doc-thread-resolve-${thread.id}`}
          onClick={() =>
            void dispatch({
              op: 'resolve_comment',
              threadId: thread.id,
              resolved: !thread.resolved,
            })
          }
        >
          {thread.resolved ? 'Reopen' : 'Resolve'}
        </button>
      </div>
    </li>
  );
}

export function CommentsPanel({ view, dispatch }: DocPanelProps): JSX.Element {
  const open = view.threads.filter((t) => !t.resolved);
  const resolved = view.threads.filter((t) => t.resolved);
  return (
    <div className="doc-panel" data-testid="doc-comments-panel">
      {view.threads.length === 0 ? (
        <div className="doc-panel-empty">
          No comments yet — select a passage in the document and choose "Comment".
        </div>
      ) : (
        <ul className="doc-threads-list">
          {[...open, ...resolved].map((t) => (
            <CommentThread key={t.id} thread={t} dispatch={dispatch} />
          ))}
        </ul>
      )}
    </div>
  );
}

export function HistoryPanel({ view, dispatch }: DocPanelProps): JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const versions = [...view.versions].reverse(); // newest first
  const selected = versions.find((v) => v.id === selectedId) ?? null;
  return (
    <div className="doc-panel doc-history-panel" data-testid="doc-history-panel">
      {versions.length === 0 ? (
        <div className="doc-panel-empty">No history yet — history starts at the next save.</div>
      ) : (
        <div className="doc-history-layout">
          <ul className="doc-history-list">
            {versions.map((v) => (
              <li key={v.id}>
                <button
                  type="button"
                  className={`doc-history-row${selectedId === v.id ? ' selected' : ''}`}
                  data-testid={`doc-history-row-${v.id}`}
                  onClick={() => setSelectedId(v.id)}
                >
                  <span className="doc-history-author">
                    {v.savedBy === 'agent' ? 'Agent' : 'You'}
                  </span>
                  <span className="doc-history-time">{new Date(v.createdAt).toLocaleString()}</span>
                  {v.restoredFrom ? <span className="doc-history-restored">restored</span> : null}
                </button>
              </li>
            ))}
          </ul>
          <div className="doc-history-preview">
            {selected ? (
              <>
                <pre className="doc-history-content" data-testid="doc-history-content">
                  {selected.content}
                </pre>
                <button
                  type="button"
                  data-testid="doc-history-restore"
                  onClick={() => void dispatch({ op: 'restore_version', versionId: selected.id })}
                >
                  Restore this version
                </button>
              </>
            ) : (
              <div className="doc-panel-empty">Select a version to preview it.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
