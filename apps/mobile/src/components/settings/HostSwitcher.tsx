// Which machine a Settings page is showing (design/settings-redesign: a compact
// segmented switcher under the title). Most settings are per machine — Claude
// accounts, the agent's layers, MCP servers, memories, the speaking voice,
// provider keys — so those pages show ONE host at a time.
//
// The switcher appears only once more than one host has reported. The choice
// is shared by every page, so picking the Mac on Usage still shows the Mac on
// Agent; until one is picked (or when the picked one is removed) the page shows
// the home host, else the first that has reported.

import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { create } from 'zustand';
import { fonts, radii, space, typography, useTheme } from '../../lib/theme';
import { usePresenceStore, type HostPresence } from '../../stores/presenceStore';
import { Dot, Row } from './ui';

interface HostChoice {
  daemonId: string | null;
  choose(daemonId: string | null): void;
}

export const useSettingsHostChoice = create<HostChoice>((set) => ({
  daemonId: null,
  choose(daemonId) {
    set({ daemonId });
  },
}));

/** The name a host goes by: its reported name, else its id. */
export function hostName(h: HostPresence): string {
  return h.host?.hostName ?? h.daemonId;
}

/** Hosts in a stable order: by name. */
export function sortedHosts(hosts: Record<string, HostPresence>): HostPresence[] {
  return Object.values(hosts).sort((a, b) => hostName(a).localeCompare(hostName(b)));
}

/**
 * The host a page shows: the one picked, if it is still registered; else the
 * home host; else the first that has reported; else the first registered.
 * Null only with no hosts at all.
 */
export function resolveSettingsHost(
  hosts: Record<string, HostPresence>,
  chosen: string | null,
): HostPresence | null {
  if (chosen !== null && hosts[chosen]) return hosts[chosen] as HostPresence;
  const all = sortedHosts(hosts);
  return (
    all.find((h) => h.host?.isHomeHost === true) ??
    all.find((h) => h.host !== null) ??
    all[0] ??
    null
  );
}

/** The host the current Settings page is showing. */
export function useSettingsHost(): HostPresence | null {
  const hosts = usePresenceStore((s) => s.hosts);
  const chosen = useSettingsHostChoice((s) => s.daemonId);
  return resolveSettingsHost(hosts, chosen);
}

export function HostSwitcher(): React.ReactElement | null {
  const colors = useTheme();
  const hosts = usePresenceStore((s) => s.hosts);
  const current = useSettingsHost();
  const reported = sortedHosts(hosts).filter((h) => h.host !== null);
  if (reported.length < 2) return null;
  return (
    <View
      testID="host-switcher"
      accessibilityRole="tablist"
      style={{
        flexDirection: 'row',
        alignSelf: 'flex-start',
        backgroundColor: colors.bgSoft,
        borderWidth: 1,
        borderColor: colors.lineSoft,
        borderRadius: radii.pill,
        padding: 3,
      }}
    >
      {reported.map((h) => {
        const on = h.daemonId === current?.daemonId;
        return (
          <Pressable
            key={h.daemonId}
            testID={`host-switcher-${h.daemonId}`}
            accessibilityRole="tab"
            accessibilityLabel={hostName(h)}
            accessibilityState={{ selected: on }}
            onPress={() => useSettingsHostChoice.getState().choose(h.daemonId)}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: space.xs + 2,
              paddingHorizontal: space.md + 2,
              paddingVertical: space.xs,
              borderRadius: radii.pill,
              backgroundColor: on ? colors.paperRaised : 'transparent',
            }}
          >
            <Dot on={h.online} />
            <Text
              style={{
                ...typography.secondary,
                fontFamily: fonts.bodyMedium,
                color: on ? colors.ink : colors.ink3,
              }}
            >
              {hostName(h)}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * Why a page cannot show this host's settings yet, in one short line — no host
 * at all, or one that has not reported — else null. Never invented values.
 */
export function unreportedText(host: HostPresence | null): string | null {
  if (host === null) return 'No hosts yet';
  if (host.host === null) return `${host.daemonId} hasn’t reported yet`;
  return null;
}

/** For a host whose host predates a setting: it has nothing to show. */
export function updateToManageText(host: HostPresence): string {
  return `Update ${hostName(host)} to manage this`;
}

/** That one line, as the only row of a card. */
export function NoticeRow({ text, testID }: { text: string; testID?: string }): React.ReactElement {
  const colors = useTheme();
  return <Row testID={testID} title={text} titleColor={colors.ink3} />;
}
