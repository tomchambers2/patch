// DesktopUpdateBanner — the shell has a newer build staged, and is waiting to
// be asked. Worded identically to WebUpdateBanner ("Patch has updated" /
// "Update Patch") so Tom sees one prompt, not two kinds; only the action
// differs (restart into the new shell vs reload the bundle).
//
// This replaces the shell restarting itself the instant a download finished.
// That behaviour was defensible on paper — Patch ships ~20 times a day, so a
// prompt per download is ~20 prompts for an answer that is always yes — but in
// practice the app vanished mid-sentence and came back 75 seconds later at its
// front door. No other Squirrel app does this: Chrome, VS Code, Slack and
// Discord all download quietly and let you choose the moment.
//
// So this is Chrome's mechanism with Slack's wording. Chrome never asks and
// never interrupts; it puts a control in the corner and lets it change colour —
// quiet, then amber, then red — until you press it, which can be days. Slack
// says which version is waiting and what pressing it does. Neither ever takes
// the decision away, and neither is dismissible, because a thing you can
// dismiss is a thing you have to dismiss twenty times a day.
//
// The escalation is the whole mechanism: there is no countdown, and nothing
// here ever restarts the app on a timer. Ignoring it indefinitely is a
// supported outcome — `autoInstallOnAppQuit` means the update lands the next
// time you quit Patch anyway, so the patient path costs the user nothing.

import { useEffect, useState, type JSX } from 'react';
import { getDesktopBridge, useDesktopUpdaterState } from '../lib/desktopBridge.js';

/**
 * Mirrors `updateUrgency` in packages/desktop/src/updater.ts. Duplicated rather
 * than imported because the web bundle must not depend on the desktop package —
 * the same SPA is served to browsers and phones, which have no shell at all.
 * The thresholds are asserted against each other in the tests.
 */
const URGENCY_DUE_MS = 8 * 60 * 60 * 1000;
const URGENCY_OVERDUE_MS = 3 * 24 * 60 * 60 * 1000;

export type UpdateUrgency = 'none' | 'ready' | 'due' | 'overdue';

export function updateUrgency(staleSince: string | null, now: number): UpdateUrgency {
  if (staleSince === null) return 'none';
  const since = Date.parse(staleSince);
  // Unparseable must not read as "not stale": we know it is behind, we just
  // can't age it, so speak at the quietest volume rather than going silent.
  if (Number.isNaN(since)) return 'ready';
  const age = now - since;
  if (age >= URGENCY_OVERDUE_MS) return 'overdue';
  if (age >= URGENCY_DUE_MS) return 'due';
  return 'ready';
}

/** How long it has been waiting, in the vaguest words that are still true. */
export function waitedWords(staleSince: string, now: number): string | null {
  const age = now - Date.parse(staleSince);
  const days = Math.floor(age / (24 * 60 * 60 * 1000));
  if (days >= 1) return days === 1 ? 'since yesterday' : `for ${days} days`;
  const hours = Math.floor(age / (60 * 60 * 1000));
  if (hours >= 1) return `for ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  // Under an hour is not worth a number — it reads as pressure where there is
  // none, and this is the phase that is meant to be quiet.
  return null;
}

/**
 * The banner is driven entirely by shell state pushed over IPC. In a browser
 * there is no bridge and no shell, so it renders nothing at all — not an empty
 * strip, not a placeholder.
 */
export function DesktopUpdateBanner(): JSX.Element | null {
  const state = useDesktopUpdaterState();
  // Re-read the clock every few minutes so a shell left running overnight
  // actually escalates, rather than staying at whatever it rendered at boot.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 5 * 60_000);
    return () => window.clearInterval(id);
  }, []);

  // Nothing staged means nothing to offer. `downloaded` is the honest gate:
  // an update that is merely AVAILABLE cannot be installed by pressing a
  // button, so offering Restart would be a lie until the bytes are on disk.
  if (!state || !state.downloaded || !state.availableVersion) return null;

  const urgency = updateUrgency(state.staleSince, now);
  if (urgency === 'none') return null;

  const waited = state.staleSince === null ? null : waitedWords(state.staleSince, now);

  return (
    <div
      className={`desktop-update-banner ${urgency}`}
      data-testid="desktop-update-banner"
      data-urgency={urgency}
      // `status`, not `alert`: this is standing information a screen reader
      // should mention in its own time, not an interruption. It is on screen
      // for days — `alert` would make it shout on every re-render.
      role="status"
    >
      <span className="dot" aria-hidden />
      <span className="desktop-update-text">
        Patch has updated{waited === null ? '' : `, waiting ${waited}`}.
      </span>
      <button
        type="button"
        className="desktop-update-restart"
        data-testid="desktop-update-restart"
        data-version={state.availableVersion}
        onClick={() => getDesktopBridge()?.installUpdate?.()}
      >
        Update Patch
      </button>
    </div>
  );
}
