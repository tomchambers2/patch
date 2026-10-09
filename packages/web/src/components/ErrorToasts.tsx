// ErrorToasts — surfaces queued errors from the uiStore. NO FALLBACK: any
// failed REST/WS path pushes here, so the user sees what went wrong. What it
// shows is one plain sentence; the raw code/message that produced it sits in a
// collapsed Details disclosure beneath (`lib/errorCopy.ts`) — kept, not shouted.

import type { JSX } from 'react';
import { useUiStore } from '../stores/uiStore.js';
import { ErrorDetail } from './ErrorDetail.js';

export function ErrorToasts(): JSX.Element | null {
  const errors = useUiStore((s) => s.errors);
  const dismiss = useUiStore((s) => s.dismissError);
  const hold = useUiStore((s) => s.holdError);
  if (errors.length === 0) return null;
  return (
    <div className="error-toasts" data-testid="error-toasts">
      {errors.map((e) => (
        <div
          key={e.id}
          className={`error-toast toast-${e.level}`}
          data-level={e.level}
          role={e.level === 'error' ? 'alert' : 'status'}
        >
          <div className="toast-body">
            <span className="msg">{e.message}</span>
            {e.detail === null ? null : (
              <ErrorDetail
                detail={e.detail}
                testId="error-toast-detail"
                onOpen={() => hold(e.id)}
              />
            )}
          </div>
          {e.retry ? (
            <button type="button" onClick={() => e.retry?.()}>
              Retry
            </button>
          ) : null}
          {/* "Take me there" — a notice about something happening on another
              view (the batch landing while you sit in a chat) is a dead end
              without it. Dismisses on the way, so acting on the toast clears
              it rather than leaving it hanging over the view it just opened. */}
          {e.action ? (
            <button
              type="button"
              data-testid="error-toast-action"
              onClick={() => {
                e.action?.run();
                dismiss(e.id);
              }}
            >
              {e.action.label}
            </button>
          ) : null}
          <button type="button" onClick={() => dismiss(e.id)}>
            Dismiss
          </button>
        </div>
      ))}
    </div>
  );
}
