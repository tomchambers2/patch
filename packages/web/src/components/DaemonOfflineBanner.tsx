// DaemonOfflineBanner — app-level banner (rendered once, in AppShell) shown
// when the server WS is up but every host is offline. Per spec/14 ##
// Offline / error states: "Host offline — messages queued." It is
// app-level rather than per-chat so it shows on Jobs/Settings/New chat too,
// not only inside an open chat (spec/12 § Host-offline UX).

import type { JSX } from 'react';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useUiStore } from '../stores/uiStore.js';

export function DaemonOfflineBanner(): JSX.Element | null {
  const connection = usePresenceStore((s) => s.connection);
  const daemonOnline = usePresenceStore((s) => s.daemonOnline);
  const setDiagnosticsOpen = useUiStore((s) => s.setDiagnosticsOpen);
  const hostsSeeded = usePresenceStore((s) => s.hostsSeeded);
  // Until the auth.ok greeting seeds the roster, daemonOnline is unknown, not false.
  if (connection !== 'connected' || !hostsSeeded) return null;
  if (daemonOnline) return null;
  return (
    <div className="daemon-offline-banner" data-testid="daemon-offline-banner" role="status">
      <span className="dot" aria-hidden />
      <span>Agent offline. Messages are queued and sent when it reconnects.</span>
      {/* Diagnose, not a dead end: opens the diagnostics screen as a dismissible
          overlay (spec/12 § Connection diagnostics screen). The app stays
          navigable — a daemon-offline surface is never blocked. */}
      <button
        type="button"
        className="banner-diagnose"
        data-testid="daemon-offline-diagnose"
        onClick={() => setDiagnosticsOpen(true)}
      >
        Diagnose
      </button>
    </div>
  );
}
