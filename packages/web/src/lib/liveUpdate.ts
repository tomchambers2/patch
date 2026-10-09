// Live update (spec/14 § Live updates) — PUSH, not poll.
//
// The server reports the web-bundle hash it's serving on `auth.ok` (every
// surface gets one on connect). Since every deploy restarts the server, the WS
// reconnects right after a deploy and delivers the new hash. If it differs
// from the bundle THIS surface booted from, a new version shipped.
//
// This used to call window.location.reload() right there — the SPA reloading
// under you is cheap and near-instant, so it seemed harmless to do
// automatically. In practice a reload mid-sentence loses your scroll
// position and composer draft focus, and races the chat list's own cold-start
// fetch (Sidebar.tsx flashes empty until it lands) — the exact ambush the
// desktop shell's own auto-restart was fixed for in 659ef37e, just never
// applied here. So: mirror that fix. Record that an update is staged
// (webUpdateStore) and let WebUpdateBanner ask, the same escalating
// quiet→due→overdue "no dismiss, no timer" contract as the desktop banner.
// Reloading is now ALWAYS a user action (reloadNow, wired to that banner's
// button) — Patch ships ~20 times a day, so staying a few deploys behind
// between reloads is the expected, supported state, not a failure to recover
// from.

import { getDesktopBridge } from './desktopBridge.js';
import { confirmLeaveDocument, isDocumentLeaveBlocked } from './useNavigationGuard.js';
import { useWebUpdateStore } from '../stores/webUpdateStore.js';

const BUNDLE_RE = /assets\/index-[A-Za-z0-9_-]+\.js/;

/** The content hash of the bundle THIS document booted from, or null in dev. */
export function runningBundle(): string | null {
  const scripts = Array.from(
    document.querySelectorAll('script[type="module"][src]'),
  ) as HTMLScriptElement[];
  for (const s of scripts) {
    const m = BUNDLE_RE.exec(s.src);
    if (m) return m[0];
  }
  return null;
}

/**
 * Carry the deploy through to the Electron shell, which is a separately
 * versioned binary and would otherwise stay up to an hour behind the SPA it is
 * rendering.
 *
 * This only makes the shell LOOK; it does not make it restart. Replacing the
 * shell binary costs a quit, a bundle swap and a relaunch, so — like the SPA
 * reload itself, now — it waits for the user.
 */
function updateDesktopShell(): void {
  getDesktopBridge()?.checkForUpdateNow?.();
}

/**
 * Handle the server-reported bundle version (from `auth.ok`). Stages the
 * update (WebUpdateBanner picks it up) iff it differs from the running
 * bundle. A no-op in dev (no hashed bundle) or when the versions already
 * match.
 */
export function onServerVersion(deployedBundle: string | null | undefined): void {
  if (!deployedBundle) return;
  const running = runningBundle();
  if (!running || running === deployedBundle) return;
  updateDesktopShell();
  useWebUpdateStore.getState().setAvailable(deployedBundle);
}

/** WebUpdateBanner's Reload button — the only path that ever reloads the SPA. */
export function reloadNow(deps: { reload?: () => void } = {}): void {
  const reload = deps.reload ?? ((): void => window.location.reload());
  // A page holding unsaved edits vetoes the unload with `beforeunload`, which
  // the Electron shell answers with no dialog at all — the reload just never
  // happens and the button looks dead. Ask through the app's own modal first.
  if (!isDocumentLeaveBlocked()) {
    reload();
    return;
  }
  void confirmLeaveDocument().then((ok) => {
    if (ok) reload();
  });
}

/** Test seam: clear staged-update state between cases. */
export function __resetLiveUpdateForTests(): void {
  useWebUpdateStore.getState().clear();
}
