// ConfirmModal — the app's own confirmation dialog, replacing the OS-native
// `window.confirm()` (patch todo: "Use a custom modal for delete + all other
// modals. Not Mac native."). Driven by `uiStore.confirm()`, which opens this
// and resolves to the user's choice. Escape or a backdrop click cancels.

import { useEffect, type JSX } from 'react';
import { useUiStore } from '../stores/uiStore.js';

export function ConfirmModal(): JSX.Element | null {
  const dialog = useUiStore((s) => s.confirmDialog);
  const resolveConfirm = useUiStore((s) => s.resolveConfirm);

  // Escape cancels (resolves false); Enter confirms. Bound only while open.
  useEffect(() => {
    if (!dialog) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault();
        resolveConfirm(false);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        resolveConfirm(true);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog, resolveConfirm]);

  if (!dialog) return null;

  return (
    <div className="modal-overlay" data-testid="confirm-modal-overlay">
      <div
        className="modal-backdrop"
        data-testid="confirm-modal-backdrop"
        onClick={() => resolveConfirm(false)}
      />
      <div
        className="modal-card confirm-modal"
        data-testid="confirm-modal"
        role="dialog"
        aria-modal="true"
        aria-label={dialog.title}
      >
        <h2 className="modal-title">{dialog.title}</h2>
        <p className="modal-message">{dialog.message}</p>
        <div className="modal-actions">
          <button
            type="button"
            className="modal-btn"
            data-testid="confirm-cancel"
            onClick={() => resolveConfirm(false)}
          >
            {dialog.cancelLabel}
          </button>
          <button
            type="button"
            className={`modal-btn ${dialog.danger ? 'danger-btn' : 'primary-btn'}`}
            data-testid="confirm-ok"
            autoFocus
            onClick={() => resolveConfirm(true)}
          >
            {dialog.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
