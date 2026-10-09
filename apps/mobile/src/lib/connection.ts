// Pure derivations for the connection / daemon-presence UI (spec/12
// § Surface connection state model, § Daemon-offline UX; spec/15 § Offline /
// error states). Kept standalone + pure so the state model is unit-testable
// without a React Native renderer; the components read from here so the two
// failure modes (WS-down vs daemon-down) never silently collapse into one.

import type { ConnectionState, DaemonPresence } from '../stores/presenceStore';
import type { ThemeColors } from './theme';

// The Chats-tab header's connection dot (spec/15 ## Chats tab § Header)
// reflects the WS link ONLY: green connected, amber reconnecting (was
// connected, dropped), red offline (a connect attempt failed, or the
// credential was refused). `null` — no dot at all — while the first connect is
// still in flight: never an offline treatment before we have ever connected.
// Takes the ACTIVE palette so the dot tracks light/dark.
export function connectionDotColor(conn: ConnectionState, colors: ThemeColors): string | null {
  switch (conn) {
    case 'connecting':
      return null;
    case 'connected':
      return colors.leaf;
    case 'reconnecting':
      return colors.amber;
    case 'offline':
    case 'unauthenticated':
      return colors.red;
  }
}

// The amber WS banner. Shown for `reconnecting` (was connected, dropped) and
// `offline` (a connect attempt has failed) ONLY — never for the initial
// `connecting` state (NO offline flash on load) and never when connected.
// And only once the outage is VISIBLE: the link has been down for the
// disconnect grace while the app was in the foreground. A socket dropped
// while the app was backgrounded, and the reconnect on opening it again, are
// the idle phone doing what phones do, not a disconnect (spec/12).
export function offlineBannerText(conn: ConnectionState, outageVisible: boolean): string | null {
  if (!outageVisible) return null;
  if (conn === 'reconnecting') return 'Reconnecting…';
  if (conn === 'offline') return 'Offline';
  return null;
}

// The app-level, self-explaining daemon-offline banner. Distinct from the WS
// banner: the server can be reachable while the host is down. Messages are
// QUEUED (not blocked) and delivered on reconnect (spec/12 § Daemon-offline UX
// + § Guaranteed input delivery); only real-time voice is paused.
export const DAEMON_OFFLINE_BANNER =
  'Agent offline. Messages are queued and sent when your Hetzner box reconnects. Voice is paused until then.';

export function daemonOfflineBannerText(daemon: DaemonPresence): string | null {
  return daemon === 'offline' ? DAEMON_OFFLINE_BANNER : null;
}

// Controls that require the host (composer send, voice note/call, new-chat
// spawn) are disabled unless the WS is connected AND the host is online.
export function daemonControlsDisabled(conn: ConnectionState, daemon: DaemonPresence): boolean {
  return conn !== 'connected' || daemon !== 'online';
}

// A self-explaining reason for why a daemon-dependent control is disabled —
// never a dead button, never a silent no-op (NO FALLBACK). Returns null when
// the control is enabled. When the WS itself is down the reason names the
// connection; when the WS is up but the host is down the reason names the
// host as the cause.
export function daemonControlDisabledReason(
  conn: ConnectionState,
  daemon: DaemonPresence,
): string | null {
  if (conn === 'connecting') return 'Connecting…';
  if (conn === 'reconnecting') return 'Reconnecting to server…';
  if (conn === 'offline') return 'Offline — no connection to the server.';
  // WS connected — the only remaining blocker is the host.
  if (daemon === 'offline') return 'Host offline — paused until your Hetzner box reconnects.';
  if (daemon === 'unknown') return 'Connecting to host…';
  return null;
}
