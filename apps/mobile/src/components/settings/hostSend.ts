// Sending a host-scoped edit from Settings (spec/03 § Host events).
//
// Every edit here is addressed to ONE machine, and the server BUFFERS
// surface→host frames while that machine is down, flushing them when it
// next connects — so a send to an offline host would look like nothing
// happened and then apply whenever it reappears. Refuse up front instead,
// naming which link is down, and report a send that throws. Nothing is ever
// silently dropped (NO FALLBACK).

import { Alert } from 'react-native';
import type { HostSettingsEvent, WireEvent } from '@patch/wire';
import { getWs } from '../../api/ws';
import { usePresenceStore } from '../../stores/presenceStore';
// Moved to lib/agoLabel.ts (also used by the Jobs tab's last-fired column,
// spec/15 § Jobs screen); re-exported here so this file's existing import
// path keeps working.
import { agoLabel } from '../../lib/agoLabel';

export { agoLabel };

/** The name a host goes by on screen: its reported name, else its id. */
export function hostLabel(daemonId: string): string {
  return usePresenceStore.getState().hosts[daemonId]?.host?.hostName ?? daemonId;
}

/**
 * Send `event` to `daemonId`, or say why not. `what` names the action in the
 * failure ("Rename failed"). Returns whether the frame went out.
 */
export function sendToHost(daemonId: string, event: WireEvent, what: string): boolean {
  const { connection, hosts } = usePresenceStore.getState();
  const label = hostLabel(daemonId);
  if (connection !== 'connected') {
    Alert.alert(
      `${what} failed`,
      `This phone has no link to the server (${connection}), so nothing was sent to ${label}.`,
    );
    return false;
  }
  const host = hosts[daemonId];
  if (!host?.online) {
    Alert.alert(
      `${what} failed`,
      `${label} is offline (last seen ${agoLabel(host?.lastSeenAt ?? null)}), so nothing was sent.`,
    );
    return false;
  }
  try {
    getWs().send(event);
    return true;
  } catch (e) {
    Alert.alert(`${what} failed`, (e as Error).message);
    return false;
  }
}

/** The body of a `host.settings` frame, minus its envelope. */
export type HostSettingsPatch = Omit<HostSettingsEvent, 'type' | 'daemonId'>;

/** Write one or more per-host settings (`host.settings`), as web does. */
export function sendHostSettings(
  daemonId: string,
  patch: HostSettingsPatch,
  what = 'Setting',
): boolean {
  return sendToHost(daemonId, { type: 'host.settings', daemonId, ...patch }, what);
}
