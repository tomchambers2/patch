// ConnectionDiagnostics — the "can't reach the agent" error screen
// (spec/12 § Connection diagnostics screen, spec/14 § Offline / error states).
//
// Blocking only when this surface has NEVER got a link up and two attempts have
// failed: there is no roster and no transcript behind it, so a banner over an
// empty shell would be the bigger lie. Everything else (reconnecting after a
// good connection, or connected-with-daemon-offline) keeps the app navigable
// and opens this as a dismissible overlay from the banners' Diagnose action.
//
// Leading with it is NOT the same as trapping behind it. The blocking variant
// carries the same Close, and closing it latches for the session — a surface
// that has still never connected keeps failing attempts in the background, and
// re-taking the window each time would be an overlay the user cannot leave.
// The banners' Diagnose action is how it comes back.

import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';
import {
  runDiagnostics,
  formatReport,
  type DiagnosticsReport,
  type CheckId,
} from '../lib/diagnostics.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { getActiveWs } from '../api/ws.js';

/** Attempts a never-connected surface gets before the screen takes over. */
export const BLOCKING_ATTEMPT_THRESHOLD = 2;

/** Headline named after the FIRST failing check — the most upstream cause. */
const HEADLINES: Record<CheckId, string> = {
  credential: "This device isn't paired to your patch account",
  server: "Can't reach the patch server",
  agent: "Can't reach the agent",
  websocket: 'The live connection is down',
  protocol: 'This surface is older than the agent',
};

type CopyState = 'idle' | 'copied' | 'failed';

export function ConnectionDiagnostics({ onDismiss }: { onDismiss?: () => void }): JSX.Element {
  const [report, setReport] = useState<DiagnosticsReport | null>(null);
  const [running, setRunning] = useState(true);
  const [copied, setCopied] = useState<CopyState>('idle');

  const run = useCallback(() => {
    setRunning(true);
    void runDiagnostics().then((r) => {
      setReport(r);
      setRunning(false);
    });
  }, []);

  useEffect(run, [run]);

  const retry = (): void => {
    // Don't wait out the backoff — dial now, then re-probe.
    getActiveWs()?.reconnectNow();
    setCopied('idle');
    run();
  };

  const copy = (): void => {
    /* v8 ignore next -- defensive only: the Copy button is `disabled` until a report exists, so this guard's true branch is unreachable through the UI. */
    if (report === null) return;
    void navigator.clipboard.writeText(formatReport(report)).then(
      () => setCopied('copied'),
      () => setCopied('failed'),
    );
  };

  const failed = report?.checks.find((c) => c.status === 'fail');
  const headline =
    report === null
      ? 'Checking the connection…'
      : failed === undefined
        ? 'Everything looks reachable'
        : HEADLINES[failed.id];

  return (
    <div className="conn-diagnostics" data-testid="connection-diagnostics" role="alertdialog">
      <div className="conn-diagnostics-card">
        <h1 data-testid="diagnostics-headline">{headline}</h1>
        {running ? (
          <p className="conn-diagnostics-running" data-testid="diagnostics-running">
            Running diagnostics…
          </p>
        ) : null}
        {report !== null ? (
          <ul className="conn-diagnostics-checks">
            {report.checks.map((c) => (
              <li key={c.id} data-testid={`check-${c.id}`} data-status={c.status}>
                <span className="conn-check-label">{c.label}</span>
                <span className="conn-check-status">{c.status === 'pass' ? 'OK' : 'FAILED'}</span>
                <span className="conn-check-detail">{c.detail}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="conn-diagnostics-actions">
          <button type="button" data-testid="diagnostics-retry" onClick={retry} disabled={running}>
            Retry now
          </button>
          <button
            type="button"
            data-testid="diagnostics-copy"
            onClick={copy}
            disabled={report === null}
          >
            {copied === 'copied' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy report'}
          </button>
          {onDismiss ? (
            <button type="button" data-testid="diagnostics-dismiss" onClick={onDismiss}>
              Close
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Decides whether the diagnostics screen is showing, and in which mode.
 * Mounted once at the app root.
 */
export function ConnectionDiagnosticsGate(): JSX.Element | null {
  const connection = usePresenceStore((s) => s.connection);
  const everConnected = usePresenceStore((s) => s.everConnected);
  const failedAttempts = usePresenceStore((s) => s.failedAttempts);
  const open = useUiStore((s) => s.diagnosticsOpen);
  const setOpen = useUiStore((s) => s.setDiagnosticsOpen);
  const blockingClosed = useUiStore((s) => s.diagnosticsBlockingClosed);
  const closeBlocking = useUiStore((s) => s.closeDiagnosticsBlocking);

  // No offline flash on load: the first `connecting` attempt gets the quiet
  // indicator, never this.
  const blocking =
    connection !== 'connected' &&
    !everConnected &&
    failedAttempts >= BLOCKING_ATTEMPT_THRESHOLD &&
    !blockingClosed;

  if (!blocking && !open) return null;

  const dismiss = (): void => {
    // Closing the takeover latches; closing an overlay the user opened from a
    // banner does not, or one look at diagnostics would disarm the takeover
    // this surface has not earned yet.
    if (blocking) closeBlocking();
    setOpen(false);
  };
  return <ConnectionDiagnostics onDismiss={dismiss} />;
}
