// WebUpdateBanner — a newer SPA bundle has been reported (a deploy shipped
// while this tab was open) and is waiting to be asked, mirroring
// DesktopUpdateBanner's contract exactly: same escalating dot (quiet → due →
// overdue), same "no dismiss, no timer — only a button" rule. See that
// component's header for why, and lib/liveUpdate.ts's header for why the SPA
// gets the same treatment now instead of reloading itself on the spot.
//
// Reuses DesktopUpdateBanner's CSS (`.desktop-update-banner` etc., including
// the overlay-titlebar rules that clear the traffic lights) rather than a
// parallel set: the two banners share the exact same top-of-shell slot and
// must look and behave like one family, not two.
//
// On the desktop shell, one deploy fans out into BOTH stores: liveUpdate.ts's
// `onServerVersion` stages this banner AND asks the shell to download its own
// new build. Once that download lands, DesktopUpdateBanner's "Restart now"
// relaunches the shell against the already-current server, which picks up the
// new bundle too — so it fully supersedes this banner's "Reload". Defer to it
// once it is actually ready to offer that, rather than stacking both prompts
// for the one event.

import { useEffect, useState, type JSX } from 'react';
import { useWebUpdateStore } from '../stores/webUpdateStore.js';
import { reloadNow } from '../lib/liveUpdate.js';
import { updateUrgency, waitedWords } from './DesktopUpdateBanner.js';
import { useDesktopUpdaterState } from '../lib/desktopBridge.js';

export function WebUpdateBanner(): JSX.Element | null {
  const staleSince = useWebUpdateStore((s) => s.staleSince);
  // Re-read the clock every few minutes so a tab left open all day actually
  // escalates, rather than staying at whatever urgency it first rendered.
  const [now, setNow] = useState(() => Date.now());
  const desktopState = useDesktopUpdaterState();

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 5 * 60_000);
    return () => window.clearInterval(id);
  }, []);

  if (staleSince === null) return null;
  if (desktopState?.downloaded && desktopState.availableVersion) return null;
  const urgency = updateUrgency(staleSince, now);
  if (urgency === 'none') return null;
  const waited = waitedWords(staleSince, now);

  return (
    <div
      className={`desktop-update-banner ${urgency}`}
      data-testid="web-update-banner"
      data-urgency={urgency}
      // `status`, not `alert` — see DesktopUpdateBanner: this is standing
      // information, not an interruption, and may be on screen for days.
      role="status"
    >
      <span className="dot" aria-hidden />
      <span className="desktop-update-text">
        Patch has updated{waited === null ? '' : `, waiting ${waited}`}.
      </span>
      <button
        type="button"
        className="desktop-update-restart"
        data-testid="web-update-reload"
        onClick={() => reloadNow()}
      >
        Update Patch
      </button>
    </div>
  );
}
