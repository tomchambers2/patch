// spec/04 § History — the provider-switch confirmation. Shown only when the
// model picker's new selection is a DIFFERENT harness than the chat's
// current one (packages/wire's `harnessForModel`); a same-provider model
// change never reaches this. Deliberately its own small modal rather than a
// `uiStore.confirm()` call — that dialog has no room for the "don't show
// again" checkbox, and this one's exact copy (Tom's own wording, verbatim)
// has no room for anything else: no token estimate, no other text.

import { useState, type JSX } from 'react';

export interface ProviderSwitchModalProps {
  onCancel: () => void;
  onSwitch: (dontShowAgain: boolean) => void;
}

export function ProviderSwitchModal({ onCancel, onSwitch }: ProviderSwitchModalProps): JSX.Element {
  const [dontShowAgain, setDontShowAgain] = useState(false);

  return (
    <div className="modal-overlay" data-testid="provider-switch-modal-overlay">
      <div
        className="modal-backdrop"
        data-testid="provider-switch-modal-backdrop"
        onClick={onCancel}
      />
      <div
        className="modal-card"
        data-testid="provider-switch-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Switch provider"
      >
        <p className="modal-message">
          Switching provider may cost more due to lack of a cache, are you sure?
        </p>
        <label className="provider-switch-dont-show-again">
          <input
            type="checkbox"
            checked={dontShowAgain}
            onChange={(e) => setDontShowAgain(e.target.checked)}
            data-testid="provider-switch-dont-show-again"
          />
          Don&apos;t show again
        </label>
        <div className="modal-actions">
          <button
            type="button"
            className="modal-btn"
            data-testid="provider-switch-cancel"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="modal-btn primary-btn"
            data-testid="provider-switch-switch"
            autoFocus
            onClick={() => onSwitch(dontShowAgain)}
          >
            Switch
          </button>
        </div>
      </div>
    </div>
  );
}
