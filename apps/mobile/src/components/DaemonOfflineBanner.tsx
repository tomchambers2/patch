// App-level daemon-offline banner. A first-class, self-explaining state — not
// silent degradation (spec/12 § Daemon-offline UX; spec/15 § Offline / error
// states). Distinct from the WS `reconnecting` banner: the server can be
// reachable while the host is down. Taps through to Settings → Hosts.

import React from 'react';
import { Pressable, Text } from 'react-native';
import { useRouter } from 'expo-router';
import { usePresenceStore } from '../stores/presenceStore';
import { useUiStore } from '../stores/uiStore';
import { daemonOfflineBannerText } from '../lib/connection';
import { radii, space, textMin, typography, useTheme } from '../lib/theme';

export function DaemonOfflineBanner(): React.ReactElement | null {
  const colors = useTheme();
  const router = useRouter();
  const daemon = usePresenceStore((s) => s.daemon);
  const setDiagnosticsOpen = useUiStore((s) => s.setDiagnosticsOpen);
  const text = daemonOfflineBannerText(daemon);
  if (text === null) return null;
  return (
    <Pressable
      testID="daemon-offline-banner"
      onPress={() => router.push('/(tabs)/settings')}
      accessibilityRole="button"
      accessibilityLabel="Host offline — open Settings to see the host status"
      style={{
        backgroundColor: colors.waitingTint,
        borderColor: colors.waiting,
        borderWidth: 1,
        paddingHorizontal: space.md,
        paddingVertical: space.sm,
        borderRadius: radii.md,
        margin: space.sm,
      }}
    >
      <Text style={{ color: colors.waiting, ...typography.meta }}>{text}</Text>
      <Text style={{ color: colors.waiting, fontSize: textMin, marginTop: space.xs }}>
        Tap for Settings → Hosts.
      </Text>
      {/* Diagnose, not a dead end: opens the diagnostics screen as a dismissible
          overlay (spec/12 § Connection diagnostics screen). The app stays
          navigable — a daemon-offline surface is never blocked. */}
      <Pressable
        testID="daemon-offline-diagnose"
        accessibilityRole="button"
        accessibilityLabel="Diagnose the connection"
        onPress={() => setDiagnosticsOpen(true)}
      >
        <Text
          style={{
            color: colors.waiting,
            fontSize: textMin,
            marginTop: space.xs,
            textDecorationLine: 'underline',
          }}
        >
          Diagnose
        </Text>
      </Pressable>
    </Pressable>
  );
}
