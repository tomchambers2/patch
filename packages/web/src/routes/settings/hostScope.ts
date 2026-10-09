// Which host the per-host Settings pages are about.
//
// Most settings live on a machine, not on the account, so Usage, Agent, MCP,
// Memories, Voice and Keys each show ONE host at a time, chosen in the page
// header. The choice is shared across pages — switching to the Mac on Usage and
// then opening Agent should still be looking at the Mac.
//
// The default is the home host (`defaultDaemonId`), the same rule every other
// host-scoped action in the app uses; failing that, the first host by name.

import { create } from 'zustand';
import {
  defaultDaemonId,
  usePresenceStore,
  type HostPresence,
} from '../../stores/presenceStore.js';

interface SettingsHostState {
  selected: string | null;
  select(daemonId: string | null): void;
}

export const useSettingsHostStore = create<SettingsHostState>((set) => ({
  selected: null,
  select: (daemonId) => set({ selected: daemonId }),
}));

/** A host's name, or its id until it has reported one — never an invented name. */
export function hostLabel(h: HostPresence): string {
  return h.host?.hostName ?? h.daemonId;
}

/** Hosts by name, id as the tiebreak so the order is stable. */
export function sortHosts(hosts: HostPresence[]): HostPresence[] {
  return [...hosts].sort(
    (a, b) => hostLabel(a).localeCompare(hostLabel(b)) || a.daemonId.localeCompare(b.daemonId),
  );
}

export function useSettingsHost(): {
  host: HostPresence | null;
  daemonId: string | null;
  /** Hosts the switcher offers: every one that has reported. */
  options: HostPresence[];
  select(daemonId: string): void;
} {
  const hosts = usePresenceStore((s) => s.hosts);
  const selected = useSettingsHostStore((s) => s.selected);
  const select = useSettingsHostStore((s) => s.select);
  const all = sortHosts(Object.values(hosts));
  const options = all.filter((h) => h.host !== null);
  const daemonId =
    selected !== null && hosts[selected] !== undefined
      ? selected
      : (defaultDaemonId(hosts) ?? options[0]?.daemonId ?? all[0]?.daemonId ?? null);
  return {
    host: daemonId === null ? null : (hosts[daemonId] ?? null),
    daemonId,
    options,
    select,
  };
}
