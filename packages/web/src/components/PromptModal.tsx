// PromptModal — the app's own text prompt, replacing `window.prompt()`.
//
// Electron does not implement `window.prompt`: it THROWS `prompt() is not
// supported.` (verified against a real Electron renderer). So every Settings button
// that used it did nothing at all in the desktop app — the exception escaped the
// click handler with no error shown. That's why "Connect does nothing".
//
// Mirrors ConfirmModal, which exists for the same family of reason.

import { useEffect, useRef, useState, type JSX } from 'react';
import { useUiStore } from '../stores/uiStore.js';

export function PromptModal(): JSX.Element | null {
  const dialog = useUiStore((s) => s.promptDialog);
  const resolvePrompt = useUiStore((s) => s.resolvePrompt);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset + focus per dialog, keyed on id so a second prompt doesn't inherit the
  // first one's text.
  useEffect(() => {
    if (!dialog) return;
    setValue('');
    inputRef.current?.focus();
  }, [dialog?.id, dialog]);

  useEffect(() => {
    if (!dialog) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault();
        resolvePrompt(null);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog, resolvePrompt]);

  if (!dialog) return null;

  return (
    <div className="modal-overlay" data-testid="prompt-modal-overlay">
      <div
        className="modal-backdrop"
        data-testid="prompt-modal-backdrop"
        onClick={() => resolvePrompt(null)}
      />
      <div
        className="modal-card confirm-modal"
        data-testid="prompt-modal"
        role="dialog"
        aria-modal="true"
        aria-label={dialog.title}
      >
        <h2 className="modal-title">{dialog.title}</h2>
        {dialog.message !== '' && <p className="modal-message">{dialog.message}</p>}
        <input
          ref={inputRef}
          className="prompt-modal-input"
          data-testid="prompt-input"
          type="text"
          value={value}
          placeholder={dialog.placeholder}
          autoFocus
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            resolvePrompt(value);
          }}
        />
        <div className="modal-actions">
          <button
            type="button"
            className="modal-btn"
            data-testid="prompt-cancel"
            onClick={() => resolvePrompt(null)}
          >
            {dialog.cancelLabel}
          </button>
          <button
            type="button"
            className="modal-btn primary-btn"
            data-testid="prompt-ok"
            onClick={() => resolvePrompt(value)}
          >
            {dialog.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
