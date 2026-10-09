// DevErrorOverlay — dev-mode only error queue inspector.
//
// Toggled by pressing Shift+E. Shows every error captured by devErrorQueue.ts
// since harness boot (onerror, unhandledrejection, console.error).
// Never rendered in production (gated on import.meta.env.DEV).

import type { JSX } from 'react';
import { useState, useEffect, useCallback } from 'react';
import { getDevErrors, clearDevErrors, onDevErrors } from '../lib/devErrorQueue.js';
import type { DevError } from '../lib/devErrorQueue.js';

export function DevErrorOverlay(): JSX.Element | null {
  if (!import.meta.env.DEV) return null;
  return <DevErrorOverlayInner />;
}

function DevErrorOverlayInner(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [errors, setErrors] = useState<readonly DevError[]>(getDevErrors);

  // Refresh the list whenever the queue changes.
  useEffect(() => {
    return onDevErrors(() => {
      setErrors(getDevErrors());
    });
  }, []);

  // Shift+E toggles the overlay.
  const onKey = useCallback((e: KeyboardEvent) => {
    if (e.shiftKey && e.key === 'E' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      setOpen((v) => !v);
    }
  }, []);

  useEffect(() => {
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onKey]);

  if (!open) {
    if (errors.length === 0) return <></>;
    return (
      <button
        type="button"
        className="dev-error-badge"
        data-testid="dev-error-badge"
        onClick={() => setOpen(true)}
        title="Dev errors (⇧E)"
      >
        {errors.length} error{errors.length !== 1 ? 's' : ''}
      </button>
    );
  }

  return (
    <div
      className="dev-error-overlay"
      data-testid="dev-error-overlay"
      role="dialog"
      aria-label="Dev error queue"
    >
      <div className="dev-error-header">
        <span>Dev errors ({errors.length})</span>
        <button
          type="button"
          className="dev-error-clear"
          data-testid="dev-error-clear"
          onClick={clearDevErrors}
        >
          Clear
        </button>
        <button
          type="button"
          className="dev-error-close"
          data-testid="dev-error-close"
          onClick={() => setOpen(false)}
        >
          ✕
        </button>
      </div>
      {errors.length === 0 ? (
        <p className="dev-error-empty">No errors captured.</p>
      ) : (
        <ul className="dev-error-list">
          {errors.map((err, i) => (
            <li key={i} className="dev-error-entry" data-testid={`dev-error-entry-${i}`}>
              <span className="dev-error-type">{err.type}</span>
              <span className="dev-error-time">{new Date(err.at).toLocaleTimeString()}</span>
              <span className="dev-error-message">{err.message}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
