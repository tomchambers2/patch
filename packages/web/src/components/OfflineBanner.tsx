// Amber 'Reconnecting…' banner per spec/14. Shown only when a connection that
// was established has been lost — never while the first one is still being made. Carries the Diagnose action that opens
// the connection diagnostics screen (spec/12 § Connection diagnostics screen)
// — "Reconnecting…" alone says nothing the user can act on or report.

import type { JSX } from 'react';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useUiStore } from '../stores/uiStore.js';

export function OfflineBanner(): JSX.Element | null {
  const connection = usePresenceStore((s) => s.connection);
  const setDiagnosticsOpen = useUiStore((s) => s.setDiagnosticsOpen);
  const everConnected = usePresenceStore((s) => s.everConnected);
  if (connection === 'connected' || !everConnected) return null;
  return (
    <div className="offline-banner" data-testid="offline-banner" role="status">
      <span>Reconnecting…</span>
      <button
        type="button"
        className="banner-diagnose"
        data-testid="offline-diagnose"
        onClick={() => setDiagnosticsOpen(true)}
      >
        Diagnose
      </button>
    </div>
  );
}
